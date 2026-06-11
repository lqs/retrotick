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
}
