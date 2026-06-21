// Public types for the v86 backend.

export interface V86Cpu {
    reg32: Int32Array;            // [EAX, ECX, EDX, EBX, ESP, EBP, ESI, EDI]
    sreg: Uint16Array;            // [ES, CS, SS, DS, FS, GS]
    cr: Int32Array;               // [CR0..CR4]
    flags: Int32Array;
    instruction_pointer: Int32Array;
    get_real_eip(): number;
    full_clear_tlb(): void;
    io: V86IO;
    segment_offsets: Int32Array;  // hidden segment bases
    gdtr_offset: Int32Array;
    gdtr_size: Int32Array;
    protected_mode: Uint8Array;
    // x87 FPU state (exposed by v86 for CRT helpers like _ftol).
    fpu_st: Int32Array;           // 8 slots × 4 i32 (F80: mantissa lo/hi, sign_exponent)
    fpu_stack_ptr: Uint8Array;    // TOP pointer (0-7)
    fpu_stack_empty: Uint8Array;  // per-slot empty bitmask
    fpu_control_word: Uint16Array;
    fpu_status_word: Uint16Array;
    fpu_get_sti_f64(i: number): number; // value of ST(i) as f64
    reg_xmm32s: Int32Array;             // SSE XMM registers, 8 regs × 4 i32
}

export interface V86IO {
    register_write(port: number, device: object, w8?: (val: number) => void, w16?: (val: number) => void, w32?: (val: number) => void): void;
    register_read(port: number, device: object, r8?: () => number, r16?: () => number, r32?: () => number): void;
}

export interface V86Instance {
    v86: { cpu: V86Cpu };
    read_memory(offset: number, length: number): Uint8Array;
    write_memory(blob: Uint8Array | number[], offset: number): void;
    run(): Promise<void>;
    stop(): Promise<void>;
    add_listener(event: string, fn: (...args: unknown[]) => void): void;
    cpu_exception_hook?: (vec: number) => boolean;
    screen_adapter?: unknown;
}

// Physical memory layout (kernel area):
//   0x00000  IVT (unused, kept clear for safety)
//   0x01000  GDT
//   0x02000  GDT pointer
//   0x03000  IDT
//   0x04000  IDT pointer
//   0x05000  #PF handler stub
//   0x06000  IAT thunk pool (grows up; 16B per thunk → up to ~250 thunks/page)
//   0x10000  PDE (page directory)
//   0x11000-0x14000  PTE tables for identity-mapped first 16 MB
//   0x20000  initial stack
//   0xF0000  BIOS (loaded by v86)
//   0x100000 paged-VA mapped 1:1 (still identity in first 16 MB)
//
// Physical page pool starts at PHYS_POOL_BASE.

export const PHYS_GDT       = 0x01000;
export const PHYS_GDT_PTR   = 0x02000;
export const PHYS_IDT       = 0x03000;
export const PHYS_IDT_PTR   = 0x04000;
export const PHYS_PF_STUB   = 0x05000;
export const PHYS_THUNK_POOL = 0x06000;
export const PHYS_PDE       = 0x10000;
export const PHYS_PTE_BASE  = 0x11000;
export const PHYS_POOL_BASE = 0x01000000;   // 16 MB

export const PTE_PRESENT = 0x01;
export const PTE_RW      = 0x02;
export const PTE_USER    = 0x04;

// Trap IO ports.
export const PORT_THUNK = 0xE3;             // IAT thunk dispatch
export const PORT_PF    = 0xE2;             // #PF handler stub uses this

// Fixed VA where BIOS hands off to a generated launcher (32-bit, identity-mapped).
// The launcher resets ESP, loads FS=TEB, then far-jumps to the PE entry point.
export const PHYS_LAUNCHER = 0x100000;

// A small parking block. Contains `HLT; JMP $-1`. Handlers that want to
// terminate the CPU (e.g. ExitProcess) overwrite the caller's return address
// on the stack with PHYS_HALT, so the thunk's RET lands here.
export const PHYS_HALT = 0x100040;

// Callback-return trampoline. When a JS handler synchronously invokes guest
// code (e.g. a wndproc) via nested main_loop, it pushes this address as the
// fake return EIP. The guest's RET lands here; the OUT below trips a JS trap
// that flips a flag, and the following jmp-self keeps the CPU busy until
// main_loop's cycle budget expires.
//
// Stub bytes: E6 E9 EB FE   (out 0xE9, al ; jmp $)
export const PHYS_CB_RETURN = 0x100050;

export const PORT_CB_RETURN = 0xE9;
