// IMemory / ICpu adapters for the v86 Windows kernel backend.
//
// Unlike the legacy adapters.ts (which assumed a single global VM with the low
// 16 MB identity-mapped), these translate every access through the CURRENTLY
// running process's AddressSpace, and lazily commit unmapped user pages so JS
// handlers and ring3 guest code share one consistent address space. A 1-entry
// page-translation cache (invalidated on CR3 switch / TLB flush) recovers most
// of the lost identity fast-path performance.

import type { IMemory, ICpu } from '../backend';
import { encodeMBCS, decodeMBCS } from '../memory';
import type { V86Instance, V86Cpu as V86CpuRaw } from './types';
import type { AddressSpace } from './addrspace';
import { PAGE_SIZE, PAGE_MASK } from './kconst';

/** Host the adapters talk to: the live v86 instance/cpu and a thunk returning
 *  the currently scheduled process's address space. */
export interface KernelMemHost {
    emu: V86Instance;
    cpu: V86CpuRaw;
    readonly currentAS: AddressSpace;
}

export class KernelMemory implements IMemory {
    private mem8!: Uint8Array;
    private memDv!: DataView;
    private byteOffset = 0;
    private byteLength = 0;

    // 1-entry translation cache.
    private cacheVPage = -1;
    private cachePhysBase = 0;
    private cacheAS: AddressSpace | null = null;

    constructor(private host: KernelMemHost) {
        const cpu = host.cpu as unknown as { mem8: Uint8Array };
        this.byteOffset = cpu.mem8.byteOffset;
        this.byteLength = cpu.mem8.byteLength;
        this.refreshViews();
    }

    private refreshViews(): void {
        const cpu = this.host.cpu as unknown as { wasm_memory: WebAssembly.Memory };
        const buf = cpu.wasm_memory.buffer;
        this.mem8 = new Uint8Array(buf, this.byteOffset, this.byteLength);
        this.memDv = new DataView(buf, this.byteOffset, this.byteLength);
    }
    private ensureFresh(): void {
        const cpu = this.host.cpu as unknown as { wasm_memory: WebAssembly.Memory };
        if (this.mem8.buffer !== cpu.wasm_memory.buffer) this.refreshViews();
    }

    /** Invalidate the page cache (call on CR3 switch / TLB flush / unmap). */
    invalidate(): void { this.cacheVPage = -1; this.cacheAS = null; }

    /** VA → physical offset into mem8, lazily committing user pages. */
    private phys(va: number): number {
        const vpage = va & ~PAGE_MASK;
        const as = this.host.currentAS;
        if (vpage === this.cacheVPage && as === this.cacheAS) {
            return this.cachePhysBase + (va & PAGE_MASK);
        }
        let pa = as.translate(va);
        if (pa < 0) pa = as.ensureMapped(va); // M2: commit-on-touch
        const base = pa & ~PAGE_MASK;
        this.cacheVPage = vpage; this.cachePhysBase = base; this.cacheAS = as;
        return base + (va & PAGE_MASK);
    }

    readU8(a: number): number { this.ensureFresh(); return this.mem8[this.phys(a >>> 0)]; }
    readU16(a: number): number { this.ensureFresh(); return this.memDv.getUint16(this.phys(a >>> 0), true); }
    readU32(a: number): number { this.ensureFresh(); return this.memDv.getUint32(this.phys(a >>> 0), true); }
    readI8(a: number): number { this.ensureFresh(); return this.memDv.getInt8(this.phys(a >>> 0)); }
    readI16(a: number): number { this.ensureFresh(); return this.memDv.getInt16(this.phys(a >>> 0), true); }
    readI32(a: number): number { this.ensureFresh(); return this.memDv.getInt32(this.phys(a >>> 0), true); }

    writeU8(a: number, v: number): void { this.ensureFresh(); this.mem8[this.phys(a >>> 0)] = v; }
    writeU16(a: number, v: number): void { this.ensureFresh(); this.memDv.setUint16(this.phys(a >>> 0), v, true); }
    writeU32(a: number, v: number): void { this.ensureFresh(); this.memDv.setUint32(this.phys(a >>> 0), v, true); }
    writeI16(a: number, v: number): void { this.writeU16(a, v); }
    writeI32(a: number, v: number): void { this.writeU32(a, v); }

    /** Walk a VA range page by page (committing each), invoking `fn(physBase, vaPage, inPage, chunk)`. */
    private walk(va: number, len: number, fn: (pa: number, n: number, off: number) => void): void {
        this.ensureFresh();
        let off = 0;
        while (off < len) {
            const inPage = (va + off) & PAGE_MASK;
            const chunk = Math.min(PAGE_SIZE - inPage, len - off);
            fn(this.phys(va + off), chunk, off);
            off += chunk;
        }
    }

    readCString(addr: number): string {
        this.ensureFresh();
        const bytes: number[] = [];
        for (let i = 0; ; i++) {
            const ch = this.mem8[this.phys((addr + i) >>> 0)];
            if (ch === 0) break;
            bytes.push(ch);
            if (bytes.length > 0x10000) break;
        }
        return decodeMBCS(new Uint8Array(bytes));
    }
    readBytesMBCS(addr: number, count: number): string {
        const out = new Uint8Array(count);
        this.walk(addr >>> 0, count, (pa, n, off) => out.set(this.mem8.subarray(pa, pa + n), off));
        return decodeMBCS(out);
    }
    writeCString(addr: number, s: string): void {
        const bytes = encodeMBCS(s);
        const full = new Uint8Array(bytes.length + 1);
        full.set(bytes);
        this.copyFrom(addr, full);
    }
    readUTF16String(addr: number): string {
        let s = '';
        for (let i = 0; ; i += 2) {
            const ch = this.readU16((addr + i) >>> 0);
            if (ch === 0) break;
            s += String.fromCharCode(ch);
            if (s.length > 0x10000) break;
        }
        return s;
    }
    writeUTF16String(addr: number, s: string): void {
        const buf = new Uint8Array((s.length + 1) * 2);
        for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); buf[i*2] = c & 0xFF; buf[i*2+1] = (c >>> 8) & 0xFF; }
        this.copyFrom(addr, buf);
    }
    copyFrom(addr: number, data: Uint8Array): void {
        this.walk(addr >>> 0, data.length, (pa, n, off) => this.mem8.set(data.subarray(off, off + n), pa));
    }
    copyBlock(dst: number, src: number, len: number): void {
        // Stage through a buffer to stay correct even when src/dst overlap or
        // map to discontiguous physical pages.
        const buf = this.slice(src, len);
        this.copyFrom(dst, buf);
    }
    slice(addr: number, length: number): Uint8Array {
        const out = new Uint8Array(length);
        this.walk(addr >>> 0, length, (pa, n, off) => out.set(this.mem8.subarray(pa, pa + n), off));
        return out;
    }
}

export class KernelCpu implements ICpu {
    readonly reg: Int32Array;
    constructor(private host: KernelMemHost) { this.reg = host.cpu.reg32; }

    get eip(): number { return this.host.cpu.instruction_pointer[0] >>> 0; }
    set eip(v: number) { this.host.cpu.instruction_pointer[0] = v | 0; }
    get fsBase(): number { return this.host.cpu.segment_offsets[4] >>> 0; }
    set fsBase(v: number) { this.host.cpu.segment_offsets[4] = v | 0; }

    halted = false;
    haltReason = '';

    // Best-effort stubs (v86 owns real FPU/flag state internally).
    readonly fpuStack = new Float64Array(8);
    readonly fpuTop = 0;
    readonly xmmF64 = new Float64Array(16);
    readonly xmmI32 = new Int32Array(32);
    readonly lazyOp = 0; readonly lazyResult = 0; readonly lazyA = 0; readonly lazyB = 0;
    readonly flagsCache = 0; readonly flagsValid = true;
    readonly fpuCW = 0x37F; readonly fpuSW = 0; readonly fpuTW = 0xFFFF;
    readonly use32 = true; readonly thunkHit = false; readonly _addrSize16 = false; readonly realMode = false;

    get cs(): number { return this.host.cpu.sreg[1]; }
    get ds(): number { return this.host.cpu.sreg[3]; }
    get es(): number { return this.host.cpu.sreg[0]; }
    get ss(): number { return this.host.cpu.sreg[2]; }
    get gs(): number { return this.host.cpu.sreg[5]; }

    getFlags(): number { return this.host.cpu.flags[0] >>> 0; }

    push32(val: number): void {
        const esp = (this.host.cpu.reg32[4] - 4) >>> 0;
        this.host.cpu.reg32[4] = esp | 0;
        this.host.currentAS.writeU32(esp, val >>> 0);
    }
    pop32(): number {
        const esp = this.host.cpu.reg32[4] >>> 0;
        const v = this.host.currentAS.readU32(esp);
        this.host.cpu.reg32[4] = (esp + 4) | 0;
        return v;
    }
    push16(val: number): void {
        const esp = (this.host.cpu.reg32[4] - 2) >>> 0;
        this.host.cpu.reg32[4] = esp | 0;
        this.host.currentAS.writeBytes(esp, new Uint8Array([val & 0xFF, (val >>> 8) & 0xFF]));
    }
    pop16(): number {
        const esp = this.host.cpu.reg32[4] >>> 0;
        const b = this.host.currentAS.readBytes(esp, 2);
        this.host.cpu.reg32[4] = (esp + 2) | 0;
        return b[0] | (b[1] << 8);
    }
    segBase(_sel: number): number { return 0; } // flat in PE mode; FS handled via fsBase
}
