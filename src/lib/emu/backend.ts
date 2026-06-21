// Backend interfaces. The existing Memory and CPU classes implement these
// implicitly. The v86 backend provides parallel adapters.
//
// These are the methods that win32 handlers (and Emulator-level helpers like
// readArg / allocHeap / SEH dispatch) actually use. Anything more internal
// (TLB, JIT regions, instruction decode) stays on the concrete classes and
// is only used by the corresponding execution driver, not by handlers.

export interface IMemory {
    readU8(addr: number): number;
    readU16(addr: number): number;
    readU32(addr: number): number;
    readI8(addr: number): number;
    readI16(addr: number): number;
    readI32(addr: number): number;
    writeU8(addr: number, val: number): void;
    writeU16(addr: number, val: number): void;
    writeU32(addr: number, val: number): void;
    writeI16(addr: number, val: number): void;
    writeI32(addr: number, val: number): void;
    readCString(addr: number): string;
    writeCString(addr: number, s: string): void;
    readUTF16String(addr: number): string;
    writeUTF16String(addr: number, s: string): void;
    readBytesMBCS(addr: number, count: number): string;
    copyFrom(addr: number, data: Uint8Array): void;
    copyBlock(dst: number, src: number, len: number): void;
    slice(addr: number, length: number): Uint8Array;
}

export interface ICpu {
    reg: Int32Array;                      // [EAX, ECX, EDX, EBX, ESP, EBP, ESI, EDI]
    eip: number;
    fsBase: number;
    halted: boolean;
    haltReason: string;
    getFlags(): number;

    // FPU/SSE — handlers occasionally touch these. For v86 backend we expose
    // best-effort views; full layout fidelity is deferred until needed.
    fpuStack?: Float64Array;
    fpuTop?: number;
    xmmF64?: Float64Array;

    // Real x87 stack access for CRT helpers (_ftol, _CIxxx) that consume/produce
    // operands on the FPU stack. Backend-specific: own-backend uses its JS stack,
    // v86 reads/pops its hardware FPU. Prefer these over the raw fpuStack/fpuTop
    // views, which are zero-filled stubs in v86 mode.
    fpuReadST0?(): number;       // value of ST(0) as f64
    fpuDoPop?(): void;           // pop ST(0): mark empty + advance TOP
    fpuPushVal?(v: number): void; // push f64 onto the FPU stack (becomes ST(0))

    // Real SSE2 XMM access for CRT helpers (_libm_sse2_*) that pass operands in
    // XMM0/XMM1 and return in XMM0. Backend-specific: own-backend uses xmmF64,
    // v86 reads/writes its hardware reg_xmm32s. Prefer these over the raw xmmF64
    // view, which is a zero-filled stub in v86 mode.
    readXmmF64?(reg: number): number;          // low 64 bits of XMMreg as f64
    writeXmmF64?(reg: number, v: number): void;
}
