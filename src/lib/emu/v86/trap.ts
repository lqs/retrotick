// Trap dispatch for the v86 backend.
//
// Two kinds of traps:
//   - #PF (IDT[14] stub) → OUT 0xE2, AL → JS reads CR2, populates PTE, returns.
//   - IAT thunk          → OUT 0xE3, AL → JS routes to a handler by thunk ID.
//
// A thunk's binary layout (16 bytes, padded for alignment):
//     B0 <id>      ; mov al, id        2 B
//     E6 E3        ; out 0xE3, al      2 B
//     C2 <bytes>   ; ret stackBytes    3 B (16-bit immediate)
//     ... padding to 16 B
//
// The handler reads/writes registers via cpu.reg32 and returns EAX; on RET
// the CPU pops stackBytes worth of args (stdcall). To preserve AL across
// the OUT (since handlers can return EAX values whose low byte matters),
// the *handler* writes EAX into cpu.reg32[0] directly — by the time RET
// executes, the stub no longer cares.

import type { V86Instance, V86Cpu } from './types';
import { PORT_THUNK, PORT_PF, PTE_PRESENT, PTE_RW } from './types';
import type { V86VirtualMemory } from './vm';

export interface ThunkHandler {
    name: string;
    dll: string;
    stackBytes: number;
    handler: (cpu: V86Cpu) => number;   // return value goes into EAX
}

export class TrapDispatcher {
    private handlers: (ThunkHandler | undefined)[] = [];

    constructor(
        private emu: V86Instance,
        private cpu: V86Cpu,
        private vm: V86VirtualMemory,
    ) {}

    install(): void {
        const dev = { name: 'v86-traps' };

        this.cpu.io.register_write(PORT_THUNK, dev, (_alByte: number) => {
            // Thunk ID is in EAX (full 32-bit) — stubs use `mov eax, id` to
            // load it before OUT. We ignore the OUT's AL byte and read the
            // wider register so thunk-count isn't capped at 256.
            const id = this.cpu.reg32[0] >>> 0;
            const h = this.handlers[id];
            if (!h) {
                console.error(`[v86-thunk] no handler for id=${id}`);
                this.cpu.reg32[0] = 0;
                return;
            }
            try {
                const retVal = h.handler(this.cpu) | 0;
                this.cpu.reg32[0] = retVal;
            } catch (err) {
                console.error(`[v86-thunk] ${h.dll}:${h.name} threw:`, err);
                this.cpu.reg32[0] = 0;
            }
        });

        this.cpu.io.register_write(PORT_PF, dev, () => {
            const va = this.cpu.cr[2] >>> 0;
            // For now: lazy-allocate any faulting page R/W. Real impl will
            // distinguish committed/reserved/guard pages.
            const physPage = this.vm.allocPhysPage();
            this.emu.write_memory(new Uint8Array(0x1000), physPage);
            this.vm.mapPage(va & ~0xFFF, physPage, PTE_PRESENT | PTE_RW);
            this.cpu.full_clear_tlb();
            console.warn(`[v86-pf] lazy-mapped VA 0x${va.toString(16)} -> PA 0x${physPage.toString(16)}`);
        });
    }

    register(h: ThunkHandler): number {
        const id = this.handlers.length;
        this.handlers.push(h);
        return id;
    }

    getHandler(id: number): ThunkHandler | undefined {
        return this.handlers[id];
    }
}

// Build a thunk stub for a single import.
// Layout (10 bytes, padded to 16):
//   B8 id32         mov eax, id           (5 B)
//   E6 E3           out 0xE3, al          (2 B)  — fires the JS trap; AL byte is ignored
//   C2 imm16 / C3   ret imm16 / ret       (1-3 B)
export function buildThunkStub(id: number, stackBytes: number): Uint8Array {
    const stub = new Uint8Array(16);
    stub[0] = 0xB8;                                  // mov eax, id (imm32)
    stub[1] = id & 0xFF;
    stub[2] = (id >>> 8) & 0xFF;
    stub[3] = (id >>> 16) & 0xFF;
    stub[4] = (id >>> 24) & 0xFF;
    stub[5] = 0xE6;                                  // out 0xE3, al
    stub[6] = PORT_THUNK;
    if (stackBytes === 0) {
        stub[7] = 0xC3;                              // ret
    } else {
        stub[7] = 0xC2;                              // ret imm16
        stub[8] = stackBytes & 0xFF;
        stub[9] = (stackBytes >>> 8) & 0xFF;
    }
    return stub;
}

export const THUNK_STUB_SIZE = 16;
