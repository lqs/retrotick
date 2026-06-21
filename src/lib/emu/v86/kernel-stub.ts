// Kernel stub blob: GDT, IDT, TSS, ring0 trap stubs, high_init, ring3 launcher.
//
// All of this is written into PHYS_KERNEL_IMAGE and aliased at KVBASE in every
// process page directory (shared top half). The IDT gate offsets, the GDT
// pointer base, and the TSS descriptor base are all KVBASE-linear addresses so
// the structures resolve correctly under any CR3 (after high_init reloads
// GDTR/IDTR to their KVBASE-linear bases).
//
// Boot flow:
//   reset → BIOS real-mode (lgdt boot pointer; enter PM) → BIOS 32-bit
//   (set CR3=boot PD; enable paging; far-jmp KVBASE high_init) → high_init
//   (reload GDTR/IDTR to KVBASE bases; ltr; HLT) → JS launches first process.

import {
    PHYS_KERNEL_IMAGE, PHYS_BOOT_PD,
    KOFF_GDT, KOFF_GDT_PTR, KOFF_IDT_PTR, KOFF_HIGH_INIT, KOFF_API_ENTRY,
    KOFF_PF_ENTRY, KOFF_EXC_ENTRY, KOFF_CBRET, KOFF_HALT, KOFF_LAUNCHER,
    KOFF_IDT, KOFF_TSS, KERNEL_IMAGE_SIZE,
    GDT_VA, GDT_PTR_VA, IDT_VA, IDT_PTR_VA, HIGH_INIT_VA, LAUNCHER_VA,
    API_ENTRY_VA, KERNEL_STACK_REGION,
    SEL_KCODE, SEL_KDATA, SEL_UCODE, SEL_UDATA, SEL_TSS, SEL_FS, GDT_FS_INDEX,
    VEC_PF, VEC_API, VEC_CBRET,
    PORT_API, PORT_PF, PORT_EXC, PORT_CBRET, PORT_BOOT,
} from './kconst';
import type { V86Instance } from './types';

const BOOT_GDT_PTR_PHYS = 0x00000800;  // boot GDT pointer (physical base, real mode)
const BOOT_ESP          = 0x00070000;  // boot stack top (low identity)
const INIT_ESP          = KERNEL_STACK_REGION + 0x10000; // high_init / launcher kernel stack top

const lo = (n: number, i: number) => (n >>> (8 * i)) & 0xFF;
const dword = (n: number) => [lo(n, 0), lo(n, 1), lo(n, 2), lo(n, 3)];

// ---------------------------------------------------------------------------
// GDT: null, kcode(DPL0), kdata(DPL0), ucode(DPL3), udata(DPL3), TSS, FS/TEB
// ---------------------------------------------------------------------------
export function buildGDT(tssBaseVA: number): Uint8Array {
    const g = new Uint8Array(7 * 8);
    g.set([0,0,0,0,0,0,0,0], 0);                              // 0x00 null
    g.set([0xFF,0xFF,0,0,0,0x9A,0xCF,0], 8);                  // 0x08 kcode DPL0
    g.set([0xFF,0xFF,0,0,0,0x92,0xCF,0], 16);                 // 0x10 kdata DPL0
    g.set([0xFF,0xFF,0,0,0,0xFA,0xCF,0], 24);                 // 0x18 ucode DPL3
    g.set([0xFF,0xFF,0,0,0,0xF2,0xCF,0], 32);                 // 0x20 udata DPL3
    // 0x28 TSS: limit 0x67, base=tssBaseVA, access 0x89 (32-bit TSS available)
    g.set([0x67, 0x00, lo(tssBaseVA,0), lo(tssBaseVA,1), lo(tssBaseVA,2), 0x89, 0x00, lo(tssBaseVA,3)], 40);
    // 0x30 FS/TEB: DPL3 data, base patched per-thread (0 initially), limit 0xFFF, byte-gran, D/B=1
    g.set([0xFF, 0x0F, 0, 0, 0, 0xF2, 0x40, 0], 48);
    return g;
}

/** Patch the GDT FS/TEB descriptor base (called on every thread switch). */
export function patchFsBase(emu: V86Instance, tebVA: number): void {
    const off = PHYS_KERNEL_IMAGE + KOFF_GDT + GDT_FS_INDEX * 8;
    const d = emu.read_memory(off, 8);
    d[2] = lo(tebVA, 0); d[3] = lo(tebVA, 1); d[4] = lo(tebVA, 2); d[7] = lo(tebVA, 3);
    emu.write_memory(d, off);
}

function ptr6(base: number, limit: number): Uint8Array {
    return new Uint8Array([limit & 0xFF, (limit >>> 8) & 0xFF, ...dword(base)]);
}

// ---------------------------------------------------------------------------
// IDT: all 0..31 → generic stub; #PF → pf_entry; API/CBRET → DPL3 gates.
// ---------------------------------------------------------------------------
function buildIDT(): Uint8Array {
    const idt = new Uint8Array(256 * 8);
    const gate = (vec: number, offVA: number, access: number) => {
        const b = vec * 8;
        idt[b+0] = offVA & 0xFF; idt[b+1] = (offVA >>> 8) & 0xFF;
        idt[b+2] = SEL_KCODE & 0xFF; idt[b+3] = (SEL_KCODE >>> 8) & 0xFF;
        idt[b+4] = 0; idt[b+5] = access;
        idt[b+6] = (offVA >>> 16) & 0xFF; idt[b+7] = (offVA >>> 24) & 0xFF;
    };
    const EXC_VA = KVOFF(KOFF_EXC_ENTRY);
    for (let v = 0; v < 32; v++) gate(v, EXC_VA, 0x8E);          // DPL0 catch-all (v86 panics on empty gates)
    gate(VEC_PF, KVOFF(KOFF_PF_ENTRY), 0x8E);                   // #PF, DPL0
    gate(VEC_API, API_ENTRY_VA, 0xEE);                          // API dispatch, DPL3
    gate(VEC_CBRET, KVOFF(KOFF_CBRET), 0xEE);                   // callback-return, DPL3
    return idt;
}

function KVOFF(koff: number): number { return 0xC0000000 + koff; }

// ---------------------------------------------------------------------------
// TSS (104 B): SS0 = kernel data; ESP0 patched per thread; no I/O bitmap.
// ---------------------------------------------------------------------------
function buildTSS(): Uint8Array {
    const tss = new Uint8Array(104);
    tss.set(dword(SEL_KDATA), 8);   // SS0
    tss[102] = 0x68; tss[103] = 0x00; // I/O map base beyond limit (no bitmap)
    return tss;
}

/** Patch TSS.ESP0 (the ring0 stack the CPU switches to on a ring3→ring0 trap). */
export function patchTssEsp0(emu: V86Instance, esp0: number): void {
    emu.write_memory(new Uint8Array(dword(esp0)), PHYS_KERNEL_IMAGE + KOFF_TSS + 4);
}

// ---------------------------------------------------------------------------
// Ring0 trap stubs
// ---------------------------------------------------------------------------
// API dispatch: pushal; OUT (JS reads thunk id from EAX, writes return EAX into
// the pushal slot at [esp+28]); popal; iret → ring3, thunk's RET pops args.
const API_ENTRY = new Uint8Array([0x60, 0xE6, PORT_API, 0x61, 0xCF]);
// #PF: pushal; OUT (JS maps page / sets up AV); popal; add esp,4 (drop errcode); iret.
const PF_ENTRY  = new Uint8Array([0x60, 0xE6, PORT_PF, 0x61, 0x83, 0xC4, 0x04, 0xCF]);
// Generic exception catch-all: pushal; OUT; cli; hlt; jmp $-1 (M3 replaces with real handlers).
const EXC_ENTRY = new Uint8Array([0x60, 0xE6, PORT_EXC, 0xFA, 0xF4, 0xEB, 0xFD]);
// Callback-return entry (ring0; reached via int 0x2F from the ring3 shim when a
// synchronously-invoked wndproc returns). EAX still holds the wndproc result;
// OUT lets JS capture it + drop a nesting level, then HLT bleeds main_loop out.
// No pushal — we never resume this stub, and EAX must stay intact for the OUT.
const CBRET     = new Uint8Array([0xE6, PORT_CBRET, 0xFA, 0xF4, 0xEB, 0xFD]);
// Park block: cli; hlt; jmp $-1.
const HALT      = new Uint8Array([0xFA, 0xF4, 0xEB, 0xFD]);

// high_init: reload GDTR/IDTR to KVBASE bases, ltr TSS, then OUT PORT_BOOT so
// JS switches CR3 to the first process PD (and sets ECX=entryVA, EDX=userESP),
// then far-jmp into the ring3 launcher.
function buildHighInit(): Uint8Array {
    return new Uint8Array([
        0xBC, ...dword(INIT_ESP),               // mov esp, INIT_ESP
        0x66, 0xB8, SEL_KDATA, 0x00,            // mov ax, 0x10
        0x8E, 0xD8, 0x8E, 0xC0, 0x8E, 0xD0,     // mov ds/es/ss, ax
        0x0F, 0x01, 0x15, ...dword(GDT_PTR_VA), // lgdt [GDT_PTR_VA]
        0x0F, 0x01, 0x1D, ...dword(IDT_PTR_VA), // lidt [IDT_PTR_VA]
        0x66, 0xB8, SEL_TSS, 0x00,              // mov ax, 0x28
        0x0F, 0x00, 0xD8,                       // ltr ax
        0xE6, PORT_BOOT,                        // out PORT_BOOT, al  (JS: CR3 + ECX/EDX)
        0xEA, ...dword(LAUNCHER_VA), 0x08, 0x00,// jmp far 0x08:LAUNCHER_VA
    ]);
}

// ring3 launcher (invoked by JS at LAUNCHER_VA with ECX=entryVA, EDX=userESP):
// load ring3 data segs (incl. FS=TEB selector), build iret frame, iret → ring3.
// NB: `mov ax,imm` clobbers EAX, so entry/stack live in ECX/EDX, not EAX.
const LAUNCHER = new Uint8Array([
    0x66, 0xB8, SEL_UDATA, 0x00,            // mov ax, 0x23
    0x8E, 0xD8, 0x8E, 0xC0, 0x8E, 0xE8,     // mov ds/es/gs, ax
    0x66, 0xB8, SEL_FS, 0x00,               // mov ax, 0x33
    0x8E, 0xE0,                             // mov fs, ax
    0x68, ...dword(SEL_UDATA),              // push 0x23   (user SS)
    0x52,                                   // push edx    (user ESP)
    0x68, ...dword(0x202),                  // push 0x202  (EFLAGS, IF=1)
    0x68, ...dword(SEL_UCODE),              // push 0x1B   (user CS)
    0x51,                                   // push ecx    (entry EIP)
    0xCF,                                   // iret → ring3
]);

// ---------------------------------------------------------------------------
// Install everything into PHYS_KERNEL_IMAGE.
// ---------------------------------------------------------------------------
export function installKernelImage(emu: V86Instance): void {
    const img = new Uint8Array(KERNEL_IMAGE_SIZE);
    img.set(buildGDT(KVOFF(KOFF_TSS)), KOFF_GDT);
    img.set(ptr6(GDT_VA, 7 * 8 - 1), KOFF_GDT_PTR);
    img.set(ptr6(IDT_VA, 256 * 8 - 1), KOFF_IDT_PTR);
    img.set(buildHighInit(), KOFF_HIGH_INIT);
    img.set(API_ENTRY, KOFF_API_ENTRY);
    img.set(PF_ENTRY, KOFF_PF_ENTRY);
    img.set(EXC_ENTRY, KOFF_EXC_ENTRY);
    img.set(CBRET, KOFF_CBRET);
    img.set(HALT, KOFF_HALT);
    img.set(LAUNCHER, KOFF_LAUNCHER);
    img.set(buildIDT(), KOFF_IDT);
    img.set(buildTSS(), KOFF_TSS);
    emu.write_memory(img, PHYS_KERNEL_IMAGE);
}

// ---------------------------------------------------------------------------
// Boot BIOS: real-mode → PM → set CR3=boot PD → enable paging → jmp high_init.
// ---------------------------------------------------------------------------
export function buildBootBios(): Uint8Array {
    const bios = new Uint8Array(65536);
    bios.set([
        0xFA,                                   // cli
        0x31, 0xC0, 0x8E, 0xD8,                 // xor ax,ax; mov ds,ax
        0x66, 0x0F, 0x01, 0x16, ...[BOOT_GDT_PTR_PHYS & 0xFF, (BOOT_GDT_PTR_PHYS >>> 8) & 0xFF], // lgdt [0x800]
        0x0F, 0x20, 0xC0, 0x66, 0x83, 0xC8, 0x01, 0x0F, 0x22, 0xC0,   // mov eax,cr0; or eax,1; mov cr0,eax
        0x66, 0xEA, 0x50, 0x00, 0x0F, 0x00, 0x08, 0x00,              // jmp far 0x08:0x000F0050
    ], 0x0030);
    bios.set([
        0x66, 0xB8, SEL_KDATA, 0x00,            // mov ax, 0x10
        0x8E, 0xD8, 0x8E, 0xC0, 0x8E, 0xD0,     // mov ds/es/ss, ax
        0xBC, ...dword(BOOT_ESP),               // mov esp, BOOT_ESP
        0xB8, ...dword(PHYS_BOOT_PD),           // mov eax, PHYS_BOOT_PD
        0x0F, 0x22, 0xD8,                       // mov cr3, eax
        0x0F, 0x20, 0xC0,                       // mov eax, cr0
        0x0D, 0x00, 0x00, 0x00, 0x80,           // or eax, 0x80000000 (PG)
        0x0F, 0x22, 0xC0,                       // mov cr0, eax
        0xEA, ...dword(HIGH_INIT_VA), 0x08, 0x00, // jmp far 0x08:HIGH_INIT_VA
    ], 0x0050);
    bios.set([0xEA, 0x30, 0x00, 0x00, 0xF0], 0xFFF0); // reset vector
    return bios;
}

/** Write the boot GDT pointer (physical base) where the real-mode lgdt reads it. */
export function installBootGdtPtr(emu: V86Instance): void {
    emu.write_memory(ptr6(PHYS_KERNEL_IMAGE + KOFF_GDT, 7 * 8 - 1), BOOT_GDT_PTR_PHYS);
}

export { INIT_ESP, BOOT_GDT_PTR_PHYS };
