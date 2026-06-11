// IMemory + ICpu adapters that route to a V86Runtime. With these wired up,
// existing win32 handlers — which access state through emu.memory.* and
// emu.cpu.* — can run unchanged under the v86 backend.

import type { IMemory, ICpu } from '../backend';
import type { Memory } from '../memory';
import type { CPU } from '../x86/cpu';
import { encodeMBCS, decodeMBCS } from '../memory';
import type { V86Runtime } from './runtime';

// Identity-mapped range: the first 16 MB of VA = PA. Used as a fast path so
// most reads/writes hit v86's wasm mem8 directly without PTE walk or
// per-access Uint8Array allocation (which was a heavy GC pressure source —
// ssstars.scr and other GL-heavy apps got progressively slower from churn).
const IDENTITY_LIMIT = 16 * 1024 * 1024;

export class V86Memory implements IMemory {
    private mem8!: Uint8Array;
    private memDv!: DataView;
    // mem8's offset/length within the wasm memory buffer, captured at first
    // init while the buffer is still valid. After a wasm memory.grow the
    // previous buffer detaches and cpu.mem8.byteOffset/byteLength read as 0,
    // so we can't recover them from the detached view — hence the cache.
    private byteOffset = 0;
    private byteLength = 0;

    constructor(private rt: V86Runtime) {
        const cpu = this.rt.cpu as unknown as { mem8: Uint8Array };
        this.byteOffset = cpu.mem8.byteOffset;
        this.byteLength = cpu.mem8.byteLength;
        this.refreshViews();
    }

    /** Re-derive mem8 / DataView against the live wasm buffer using the
     *  cached offset/length. */
    private refreshViews(): void {
        const cpu = this.rt.cpu as unknown as { wasm_memory: WebAssembly.Memory };
        const liveBuf = cpu.wasm_memory.buffer;
        this.mem8 = new Uint8Array(liveBuf, this.byteOffset, this.byteLength);
        this.memDv = new DataView(liveBuf, this.byteOffset, this.byteLength);
    }

    /** Check the cached views still address the live wasm buffer. v86's wasm
     *  may internally `memory.grow`, detaching the previous ArrayBuffer. */
    private ensureFresh(): void {
        const cpu = this.rt.cpu as unknown as { wasm_memory: WebAssembly.Memory };
        if (this.mem8.buffer !== cpu.wasm_memory.buffer) {
            this.refreshViews();
        }
    }

    /** Translate VA → PA. Returns PA for identity range; null if PTE walk
     *  needed (caller falls back to vmRead/vmCopy). */
    private phys(va: number): number {
        if (va < IDENTITY_LIMIT) return va;
        // Slow path: PTE walk
        const pte = this.rt.vm.readPTE(va);
        if ((pte & 1) === 0) return -1;
        return (pte & ~0xFFF) | (va & 0xFFF);
    }

    readU8(addr: number): number {
        this.ensureFresh();
        const va = addr >>> 0;
        if (va < IDENTITY_LIMIT) return this.mem8[va];
        const pa = this.phys(va);
        return pa < 0 ? 0 : this.mem8[pa];
    }
    readU16(addr: number): number {
        this.ensureFresh();
        const va = addr >>> 0;
        if (va < IDENTITY_LIMIT - 1) return this.memDv.getUint16(va, true);
        const pa = this.phys(va);
        return pa < 0 ? 0 : this.memDv.getUint16(pa, true);
    }
    readU32(addr: number): number {
        this.ensureFresh();
        const va = addr >>> 0;
        if (va < IDENTITY_LIMIT - 3) return this.memDv.getUint32(va, true);
        const pa = this.phys(va);
        return pa < 0 ? 0 : this.memDv.getUint32(pa, true);
    }
    readI8(addr: number): number {
        this.ensureFresh();
        const va = addr >>> 0;
        if (va < IDENTITY_LIMIT) return this.memDv.getInt8(va);
        const pa = this.phys(va);
        return pa < 0 ? 0 : this.memDv.getInt8(pa);
    }
    readI16(addr: number): number {
        this.ensureFresh();
        const va = addr >>> 0;
        if (va < IDENTITY_LIMIT - 1) return this.memDv.getInt16(va, true);
        const pa = this.phys(va);
        return pa < 0 ? 0 : this.memDv.getInt16(pa, true);
    }
    readI32(addr: number): number {
        this.ensureFresh();
        const va = addr >>> 0;
        if (va < IDENTITY_LIMIT - 3) return this.memDv.getInt32(va, true);
        const pa = this.phys(va);
        return pa < 0 ? 0 : this.memDv.getInt32(pa, true);
    }

    writeU8(addr: number, val: number): void {
        this.ensureFresh();
        const va = addr >>> 0;
        if (va < IDENTITY_LIMIT) { this.mem8[va] = val; return; }
        const pa = this.phys(va);
        if (pa >= 0) this.mem8[pa] = val;
    }
    writeU16(addr: number, val: number): void {
        this.ensureFresh();
        const va = addr >>> 0;
        if (va < IDENTITY_LIMIT - 1) { this.memDv.setUint16(va, val, true); return; }
        const pa = this.phys(va);
        if (pa >= 0) this.memDv.setUint16(pa, val, true);
    }
    writeU32(addr: number, val: number): void {
        this.ensureFresh();
        const va = addr >>> 0;
        if (va < IDENTITY_LIMIT - 3) { this.memDv.setUint32(va, val, true); return; }
        const pa = this.phys(va);
        if (pa >= 0) this.memDv.setUint32(pa, val, true);
    }
    writeI16(addr: number, val: number): void { this.writeU16(addr, val); }
    writeI32(addr: number, val: number): void { this.writeU32(addr, val); }

    readCString(addr: number): string {
        this.ensureFresh();
        const start = addr >>> 0;
        if (start < IDENTITY_LIMIT) {
            // Fast path: scan mem8 directly.
            let end = start;
            const max = Math.min(start + 0x10000, IDENTITY_LIMIT);
            while (end < max && this.mem8[end] !== 0) end++;
            return decodeMBCS(this.mem8.subarray(start, end));
        }
        const bytes: number[] = [];
        for (let i = 0; ; i++) {
            const ch = this.readU8(addr + i);
            if (ch === 0) break;
            bytes.push(ch);
        }
        return decodeMBCS(new Uint8Array(bytes));
    }
    readBytesMBCS(addr: number, count: number): string {
        this.ensureFresh();
        const va = addr >>> 0;
        if (va + count <= IDENTITY_LIMIT) {
            return decodeMBCS(this.mem8.subarray(va, va + count));
        }
        return decodeMBCS(this.rt.vm.vmRead(va, count));
    }
    writeCString(addr: number, s: string): void {
        this.ensureFresh();
        const bytes = encodeMBCS(s);
        const va = addr >>> 0;
        if (va + bytes.length + 1 <= IDENTITY_LIMIT) {
            this.mem8.set(bytes, va);
            this.mem8[va + bytes.length] = 0;
            return;
        }
        const full = new Uint8Array(bytes.length + 1);
        full.set(bytes);
        full[bytes.length] = 0;
        this.rt.vm.vmCopy(va, full);
    }
    readUTF16String(addr: number): string {
        let s = '';
        for (let i = 0; ; i += 2) {
            const ch = this.readU16(addr + i);
            if (ch === 0) break;
            s += String.fromCharCode(ch);
        }
        return s;
    }
    writeUTF16String(addr: number, s: string): void {
        this.ensureFresh();
        const va = addr >>> 0;
        const byteLen = (s.length + 1) * 2;
        if (va + byteLen <= IDENTITY_LIMIT) {
            for (let i = 0; i < s.length; i++) {
                const ch = s.charCodeAt(i);
                this.mem8[va + i * 2] = ch & 0xFF;
                this.mem8[va + i * 2 + 1] = (ch >>> 8) & 0xFF;
            }
            this.mem8[va + s.length * 2] = 0;
            this.mem8[va + s.length * 2 + 1] = 0;
            return;
        }
        const buf = new Uint8Array(byteLen);
        for (let i = 0; i < s.length; i++) {
            const ch = s.charCodeAt(i);
            buf[i * 2] = ch & 0xFF;
            buf[i * 2 + 1] = (ch >>> 8) & 0xFF;
        }
        this.rt.vm.vmCopy(va, buf);
    }
    copyFrom(addr: number, data: Uint8Array): void {
        this.ensureFresh();
        const va = addr >>> 0;
        if (va + data.length <= IDENTITY_LIMIT) {
            this.mem8.set(data, va);
            return;
        }
        this.rt.vm.vmCopy(va, data);
    }
    copyBlock(dst: number, src: number, len: number): void {
        this.ensureFresh();
        const srcVA = src >>> 0;
        const dstVA = dst >>> 0;
        if (srcVA + len <= IDENTITY_LIMIT && dstVA + len <= IDENTITY_LIMIT) {
            this.mem8.copyWithin(dstVA, srcVA, srcVA + len);
            return;
        }
        const bytes = this.rt.vm.vmRead(srcVA, len);
        this.rt.vm.vmCopy(dstVA, bytes);
    }
    slice(addr: number, length: number): Uint8Array {
        this.ensureFresh();
        const va = addr >>> 0;
        if (va + length <= IDENTITY_LIMIT) {
            return this.mem8.subarray(va, va + length);
        }
        return this.rt.vm.vmRead(va, length);
    }
}

export class V86Cpu implements ICpu {
    // The Int32Array views from v86 use the same EAX..EDI ordering as our CPU.
    // We expose reg32 directly — handlers write/read through this view, and v86
    // sees the updates in the next instruction.
    readonly reg: Int32Array;

    constructor(private rt: V86Runtime) {
        this.reg = rt.cpu.reg32;
    }

    get eip(): number { return this.rt.cpu.instruction_pointer[0] >>> 0; }
    set eip(val: number) { this.rt.cpu.instruction_pointer[0] = val | 0; }

    // FS base lives in v86's segment_offsets[4]. The GDT descriptor at
    // selector 0x18 is patched separately when the loader calls setFsBase().
    get fsBase(): number { return this.rt.cpu.segment_offsets[4] >>> 0; }
    set fsBase(val: number) { this.rt.cpu.segment_offsets[4] = val | 0; }

    halted = false;
    haltReason = '';

    // Stubs for handlers that read FPU/XMM/segment state. v86 manages these
    // internally; exposing zero-filled views is enough to make code that
    // *creates* a snapshot not crash. Code that reads stale snapshots will
    // see zero — acceptable for v86 mode where threads can't be context-
    // switched cooperatively anyway.
    readonly fpuStack = new Float64Array(8);
    readonly fpuTop = 0;
    readonly xmmF64 = new Float64Array(16);
    readonly xmmI32 = new Int32Array(32);
    readonly lazyOp = 0;
    readonly lazyResult = 0;
    readonly lazyA = 0;
    readonly lazyB = 0;
    readonly flagsCache = 0;
    readonly flagsValid = true;
    readonly fpuCW = 0x37F;
    readonly fpuSW = 0;
    readonly fpuTW = 0xFFFF;
    readonly use32 = true;
    readonly thunkHit = false;
    readonly _addrSize16 = false;
    readonly realMode = false;

    get cs(): number { return this.rt.cpu.sreg[1]; }
    get ds(): number { return this.rt.cpu.sreg[3]; }
    get es(): number { return this.rt.cpu.sreg[0]; }
    get ss(): number { return this.rt.cpu.sreg[2]; }
    get gs(): number { return this.rt.cpu.sreg[5]; }

    getFlags(): number {
        return this.rt.cpu.flags[0] >>> 0;
    }

    /** Push a 32-bit value: ESP -= 4; mem[ESP] = val. */
    push32(val: number): void {
        const esp = (this.rt.cpu.reg32[4] - 4) >>> 0;
        this.rt.cpu.reg32[4] = esp | 0;
        const b = new Uint8Array(4);
        b[0] = val & 0xFF;
        b[1] = (val >>> 8) & 0xFF;
        b[2] = (val >>> 16) & 0xFF;
        b[3] = (val >>> 24) & 0xFF;
        this.rt.vm.vmCopy(esp, b);
    }

    /** Pop a 32-bit value: val = mem[ESP]; ESP += 4. */
    pop32(): number {
        const esp = this.rt.cpu.reg32[4] >>> 0;
        const val = this.rt.vm.vmReadU32(esp);
        this.rt.cpu.reg32[4] = (esp + 4) | 0;
        return val;
    }

    push16(val: number): void {
        const esp = (this.rt.cpu.reg32[4] - 2) >>> 0;
        this.rt.cpu.reg32[4] = esp | 0;
        const b = new Uint8Array(2);
        b[0] = val & 0xFF;
        b[1] = (val >>> 8) & 0xFF;
        this.rt.vm.vmCopy(esp, b);
    }

    pop16(): number {
        const esp = this.rt.cpu.reg32[4] >>> 0;
        const b = this.rt.vm.vmRead(esp, 2);
        this.rt.cpu.reg32[4] = (esp + 2) | 0;
        return b[0] | (b[1] << 8);
    }

    segBase(_sel: number): number {
        // Flat segments in v86 PE mode — everything maps to base 0 except FS,
        // which is updated via fsBase setter directly.
        return 0;
    }
}

// Build the backend override pair. Cast through unknown because v86's adapters
// don't implement Memory/CPU's own-backend-only internals (TLB, FPU state,
// DOS A20 gate, etc); those internals are never touched in v86 PE mode.
export function makeV86BackendOverrides(rt: V86Runtime): {
    memory: Memory;
    cpu: CPU;
} {
    return {
        memory: new V86Memory(rt) as unknown as Memory,
        cpu: new V86Cpu(rt) as unknown as CPU,
    };
}
