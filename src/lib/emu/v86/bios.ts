// Fake BIOS + boot stub. Total ~80 bytes of code inside a 64 KB image.
// On reset, jumps to a 16-bit stub that loads GDT, switches to PM, then a
// 32-bit stub that loads IDT, sets CR3 to the page directory, enables paging,
// and far-jumps into the user-supplied 32-bit entry point at PHYS_ENTRY.

import { PHYS_PDE, PHYS_LAUNCHER } from './types';

export function buildBios(): Uint8Array {
    const entryVA = PHYS_LAUNCHER;
    const bios = new Uint8Array(65536);

    // 16-bit boot @ 0xF0030
    bios.set([
        0xFA,                                       // cli
        0x31, 0xC0,                                 // xor ax, ax
        0x8E, 0xD8,                                 // mov ds, ax
        0x66, 0x0F, 0x01, 0x16, 0x00, 0x20,         // lgdt [0x2000]
        0x0F, 0x20, 0xC0,                           // mov eax, cr0
        0x66, 0x83, 0xC8, 0x01,                     // or eax, 1
        0x0F, 0x22, 0xC0,                           // mov cr0, eax
        0x66, 0xEA, 0x50, 0x00, 0x0F, 0x00,         // jmp far 0x08:0x000F0050
            0x08, 0x00,
    ], 0x0030);

    // 32-bit transition @ 0xF0050: segs, ESP, LIDT, CR3, enable PG, far jmp
    const pde32 = PHYS_PDE >>> 0;
    bios.set([
        0x66, 0xB8, 0x10, 0x00,                     // mov ax, 0x10
        0x8E, 0xD8,                                 // mov ds, ax
        0x8E, 0xC0,                                 // mov es, ax
        0x8E, 0xD0,                                 // mov ss, ax
        0xBC, 0x00, 0x00, 0x09, 0x00,               // mov esp, 0x90000 (boot stack; user code resets ESP)
        0x0F, 0x01, 0x1D, 0x00, 0x40, 0x00, 0x00,   // lidt [0x4000]
        0xB8,                                       // mov eax, imm32 (CR3)
            pde32 & 0xFF, (pde32 >>> 8) & 0xFF, (pde32 >>> 16) & 0xFF, (pde32 >>> 24) & 0xFF,
        0x0F, 0x22, 0xD8,                           // mov cr3, eax
        0x0F, 0x20, 0xC0,                           // mov eax, cr0
        0x0D, 0x00, 0x00, 0x00, 0x80,               // or eax, 0x80000000 (PG)
        0x0F, 0x22, 0xC0,                           // mov cr0, eax
        0xEA,                                       // jmp far 0x08:entryVA
            entryVA & 0xFF, (entryVA >>> 8) & 0xFF, (entryVA >>> 16) & 0xFF, (entryVA >>> 24) & 0xFF,
            0x08, 0x00,
    ], 0x0050);

    // Reset vector @ 0xFFF0
    bios.set([0xEA, 0x30, 0x00, 0x00, 0xF0], 0xFFF0);

    return bios;
}

// GDT (3 entries: null, code32 flat, data32 flat). FS descriptor is patched
// in later by setFsBase() once the TEB has been allocated.
export const GDT_BYTES = new Uint8Array([
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xFF, 0xFF, 0x00, 0x00, 0x00, 0x9A, 0xCF, 0x00,   // 0x08 code32
    0xFF, 0xFF, 0x00, 0x00, 0x00, 0x92, 0xCF, 0x00,   // 0x10 data32
    0xFF, 0xFF, 0x00, 0x00, 0x00, 0x92, 0xCF, 0x00,   // 0x18 FS (base patched later)
]);

// Encode a GDT data descriptor (base, limit, byte-granular by default).
export function encodeGdtDataDescriptor(out: Uint8Array, offset: number, base: number, limit: number, pageGranular: boolean): void {
    const g = pageGranular ? 0x80 : 0x00;
    out[offset + 0] = limit & 0xFF;
    out[offset + 1] = (limit >>> 8) & 0xFF;
    out[offset + 2] = base & 0xFF;
    out[offset + 3] = (base >>> 8) & 0xFF;
    out[offset + 4] = (base >>> 16) & 0xFF;
    out[offset + 5] = 0x92;                          // P=1 DPL=0 S=1 type=data RW
    out[offset + 6] = g | 0x40 | ((limit >>> 16) & 0x0F);  // G | D/B=1 | limit[19:16]
    out[offset + 7] = (base >>> 24) & 0xFF;
}

// GDT pointer (limit + base, 6 bytes).
export function buildGdtPointer(base: number, limit: number): Uint8Array {
    const b = new Uint8Array(6);
    b[0] = limit & 0xFF;
    b[1] = (limit >>> 8) & 0xFF;
    b[2] = base & 0xFF;
    b[3] = (base >>> 8) & 0xFF;
    b[4] = (base >>> 16) & 0xFF;
    b[5] = (base >>> 24) & 0xFF;
    return b;
}

// IDT pointer (limit + base, 6 bytes).
export function buildIdtPointer(base: number, limit: number): Uint8Array {
    return buildGdtPointer(base, limit);
}

// IDT: 256 entries, 8 bytes each, all empty except IDT[14] (#PF) which
// dispatches to the supplied physical address via interrupt gate.
export function buildIDT(pfHandlerPhys: number): Uint8Array {
    const idt = new Uint8Array(256 * 8);
    const idx = 14;
    const off = pfHandlerPhys;
    const sel = 0x0008;
    const base = idx * 8;
    idt[base + 0] = off & 0xFF;
    idt[base + 1] = (off >>> 8) & 0xFF;
    idt[base + 2] = sel & 0xFF;
    idt[base + 3] = (sel >>> 8) & 0xFF;
    idt[base + 4] = 0x00;
    idt[base + 5] = 0x8E;                            // P=1 DPL=0 type=0xE (32-bit interrupt gate)
    idt[base + 6] = (off >>> 16) & 0xFF;
    idt[base + 7] = (off >>> 24) & 0xFF;
    return idt;
}

// #PF handler stub: OUT 0xE2,AL; ADD ESP,4; IRETD.
export const PF_STUB = new Uint8Array([
    0xE6, 0xE2,
    0x83, 0xC4, 0x04,
    0xCF,
]);
