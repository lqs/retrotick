// M1 kernel-skeleton boot test (isolated; does not use the legacy V86Runtime).
//
// Proves the new higher-half kernel boots a process to ring3 with its own page
// directory and a Windows-style address space, and that the int 0x2E API gate
// dispatches to a JS handler and returns a value.
//
// Flow: reset → BIOS → boot PD (low identity + shared kernel) → high_init
// (lgdt/lidt/ltr at KVBASE; OUT PORT_BOOT) → JS switches CR3 to the process PD
// and sets ECX=entry, EDX=userESP → launcher irets to ring3 user code at
// 0x401000. User code reads its TEB via FS:[0x18], calls API id=1 (returns
// 0xABCD1234), then calls API id=0 (exit) and JS verifies ESI/EDI.

import fs from 'node:fs';
import { V86 } from '../node_modules/v86/build/libv86.mjs';
import { FrameAllocator } from '../src/lib/emu/v86/frame.ts';
import { AddressSpace, buildSharedKernelTables } from '../src/lib/emu/v86/addrspace.ts';
import {
    installKernelImage, buildBootBios, installBootGdtPtr, patchFsBase, patchTssEsp0, INIT_ESP,
} from '../src/lib/emu/v86/kernel-stub.ts';
import {
    PHYS_BOOT_PD, LAUNCHER_VA, TEB_VA_BASE, DEFAULT_IMAGE_BASE,
    PTE_PRESENT, PTE_RW, PTE_USER, PORT_API, PORT_PF, PORT_EXC, PORT_BOOT,
} from '../src/lib/emu/v86/kconst.ts';

const wasmBytes = fs.readFileSync(new URL('../node_modules/v86/build/v86.wasm', import.meta.url));
const hex = (n, w = 8) => (n >>> 0).toString(16).padStart(w, '0');

const ENTRY_VA   = DEFAULT_IMAGE_BASE + 0x1000;  // 0x401000
const USER_STACK = 0x00130000;
const USER_FLAGS = PTE_PRESENT | PTE_RW | PTE_USER;
const API_RET    = 0xABCD1234;

// Ring3 user program.
const USER_CODE = new Uint8Array([
    0x64, 0x8B, 0x1D, 0x18, 0x00, 0x00, 0x00,  // mov ebx, fs:[0x18]   (TEB self-ptr)
    0xB8, 0x01, 0x00, 0x00, 0x00,              // mov eax, 1           (API id 1)
    0xCD, 0x2E,                                // int 0x2E             → eax = API_RET
    0x89, 0xC6,                                // mov esi, eax         (stash return)
    0x89, 0xDF,                                // mov edi, ebx         (stash TEB)
    0xB8, 0x00, 0x00, 0x00, 0x00,              // mov eax, 0           (API id 0 = exit)
    0xCD, 0x2E,                                // int 0x2E
    0xEB, 0xFE,                                // jmp $ (should not reach)
]);

const emu = new V86({
    bios: { buffer: buildBootBios().buffer },
    memory_size: 64 * 1024 * 1024, vga_memory_size: 1024 * 1024,
    autostart: false, log_level: 0,
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    wasm_fn: async (env) => (await WebAssembly.instantiate(wasmBytes, env)).instance.exports,
});

let pass = false;

emu.add_listener('emulator-loaded', () => {
    const cpu = emu.v86.cpu;
    const memEnd = 64 * 1024 * 1024;

    // Kernel image + boot GDT pointer.
    installKernelImage(emu);
    installBootGdtPtr(emu);

    // Frame allocator + shared kernel page tables.
    const frames = new FrameAllocator(emu, memEnd);
    const shared = buildSharedKernelTables(emu, frames);

    // Boot PD (fixed at PHYS_BOOT_PD): low identity for the boot transition.
    const bootAS = new AddressSpace(emu, frames, shared, PHYS_BOOT_PD);
    bootAS.addBootIdentity(16);

    // First process address space.
    const proc = new AddressSpace(emu, frames, shared);
    proc.mapRange(ENTRY_VA, 1, USER_FLAGS);            // code page
    proc.mapRange(USER_STACK - 0x1000, 1, USER_FLAGS); // stack page (top = USER_STACK)
    proc.mapRange(TEB_VA_BASE, 1, USER_FLAGS);         // TEB page
    proc.writeBytes(ENTRY_VA, USER_CODE);
    proc.writeU32(TEB_VA_BASE + 0x18, TEB_VA_BASE);    // TEB self-pointer

    // First-thread FS base + ring0 stack.
    patchFsBase(emu, TEB_VA_BASE);
    patchTssEsp0(emu, INIT_ESP);

    const rdU32 = (pa) => { const b = emu.read_memory(pa, 4); return (b[0]|(b[1]<<8)|(b[2]<<16)|(b[3]<<24))>>>0; };
    const wrU32 = (pa, v) => emu.write_memory(new Uint8Array([v&0xFF,(v>>>8)&0xFF,(v>>>16)&0xFF,(v>>>24)&0xFF]), pa);

    // Boot handoff: switch CR3 to the process PD, hand the launcher its args.
    cpu.io.register_write(PORT_BOOT, { name: 'boot' }, () => {
        cpu.cr[3] = proc.pdPhys | 0;
        cpu.full_clear_tlb();
        cpu.reg32[1] = ENTRY_VA | 0;     // ECX = entry
        cpu.reg32[2] = USER_STACK | 0;   // EDX = user ESP
        console.log(`[boot] CR3 → process PD 0x${hex(proc.pdPhys)}; launching ring3 @ 0x${hex(ENTRY_VA)}`);
    });

    // API dispatch (int 0x2E → ring0 api_entry → OUT).
    cpu.io.register_write(PORT_API, { name: 'api' }, () => {
        const id = cpu.reg32[0] >>> 0;
        const r0esp = cpu.reg32[4] >>> 0;
        if (id === 1) {
            // Return a sentinel via the pushal EAX slot (popal restores it). The
            // ring0 ESP is a KVBASE-region VA → translate to physical first.
            const pa = proc.translate(r0esp + 28);
            wrU32(pa, API_RET);
            console.log(`[api id=1] returning 0x${hex(API_RET)} via [r0esp+28] (r0esp=0x${hex(r0esp)} pa=0x${hex(pa)})`);
        } else if (id === 0) {
            const esi = cpu.reg32[6] >>> 0; // saved API return
            const edi = cpu.reg32[7] >>> 0; // saved TEB
            const fsBase = cpu.segment_offsets ? (cpu.segment_offsets[4] >>> 0) : -1;
            console.log(`[api id=0 exit] ESI=0x${hex(esi)} (expect 0x${hex(API_RET)}) EDI=0x${hex(edi)} (expect 0x${hex(TEB_VA_BASE)}) fsBase=0x${hex(fsBase)}`);
            pass = (esi === API_RET) && (edi === TEB_VA_BASE);
            console.log(`\n[RESULT] M1 boot: ${pass ? 'PASS — ring3 + per-process PD + TEB/FS + int 0x2E API all work' : 'FAIL'}`);
            process.exit(pass ? 0 : 1);
        }
    });

    cpu.io.register_write(PORT_PF, { name: 'pf' }, () => {
        console.error(`[#PF] CR2=0x${hex(cpu.cr[2])} — unexpected in M1`);
        process.exit(2);
    });
    cpu.io.register_write(PORT_EXC, { name: 'exc' }, () => {
        console.error(`[exc] CS:EIP=${hex(cpu.sreg[1],4)}:${hex(cpu.get_real_eip())}`);
        process.exit(3);
    });

    emu.cpu_exception_hook = (n) => {
        if (n === 14) return false;
        console.error(`[unexpected exception ${n}] CS:EIP=${hex(cpu.sreg[1],4)}:${hex(cpu.get_real_eip())} CR2=0x${hex(cpu.cr[2])}`);
        return false;
    };
    emu.screen_adapter = { pause: () => {}, continue: () => {} };
    emu.run();
});

setTimeout(() => { console.error('[kernel-boot] timeout'); process.exit(1); }, 10000);
