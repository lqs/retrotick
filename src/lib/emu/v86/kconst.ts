// Kernel constants for the v86 Windows-kernel backend.
//
// Single source of truth for the physical memory layout, the Windows 2000/XP
// virtual address layout, GDT selectors, IDT vectors, and PTE flags. The legacy
// flat-ring0 backend (types.ts) is kept intact during the migration; this file
// backs the new higher-half / per-process-page-table kernel.

export const PAGE_SIZE = 0x1000;
export const PAGE_MASK = 0xFFF;

// ---------------------------------------------------------------------------
// Physical memory layout
//
//   0x00000000  real-mode IVT / scratch (boot only)
//   0x00001000  PHYS_KERNEL_IMAGE  kernel stub blob (GDT/IDT/TSS/stubs/launcher)
//   0x00010000  PHYS_KERNEL_STACKS ring0 kernel stacks (one per thread)
//   0x00080000  PHYS_KERNEL_PT     shared kernel page-table frame(s), built once
//   0x00090000  PHYS_BOOT_PD       boot page directory (low identity + kernel)
//   0x000F0000  BIOS (v86 maps it here)
//   0x00200000  PHYS_FRAME_POOL    ref-counted physical frame pool
// ---------------------------------------------------------------------------
export const PHYS_KERNEL_IMAGE  = 0x00001000;
export const PHYS_KERNEL_STACKS = 0x00010000;   // 0x10000..0x80000 → up to 112 × 4 KB stacks
export const PHYS_KERNEL_PT     = 0x00080000;
export const PHYS_BOOT_PD       = 0x00090000;
export const PHYS_FRAME_POOL    = 0x00200000;

// Offsets within the kernel image (relative to PHYS_KERNEL_IMAGE, and equally
// to KVBASE since the image is aliased there).
export const KOFF_GDT        = 0x0000;   // 7 descriptors × 8 = 56 B
export const KOFF_GDT_PTR    = 0x0040;
export const KOFF_IDT_PTR    = 0x0048;
export const KOFF_HIGH_INIT  = 0x0100;   // high_init code
export const KOFF_API_ENTRY  = 0x0200;   // ring0 API dispatch stub
export const KOFF_PF_ENTRY   = 0x0280;   // ring0 #PF stub
export const KOFF_EXC_ENTRY  = 0x0300;   // ring0 generic-exception stub
export const KOFF_CBRET      = 0x0380;   // ring0 callback-return stub
export const KOFF_HALT       = 0x0400;   // park block (cli; hlt; jmp $-1)
export const KOFF_LAUNCHER   = 0x0500;   // ring3 launcher template (ring0 → ring3)
export const KOFF_IDT        = 0x0800;   // 256 × 8 = 2 KB → ends 0x1000
export const KOFF_TSS        = 0x1800;   // 104 B TSS
export const KERNEL_IMAGE_SIZE = 0x2000; // 8 KB total

// ---------------------------------------------------------------------------
// Virtual address layout (Windows 2000/XP, 2 GB user / 2 GB kernel)
// ---------------------------------------------------------------------------
export const USER_MIN        = 0x00010000;   // first 64 KB = NULL guard
export const USER_MAX        = 0x7FFEFFFF;
export const DEFAULT_IMAGE_BASE = 0x00400000;
export const PEB_VA          = 0x7FFDF000;
export const TEB_VA_BASE     = 0x7FFDE000;    // first thread; subsequent go down by a page
export const KUSER_SHARED_DATA_VA = 0x7FFE0000;
export const USER_NOACCESS_TOP = 0x7FFF0000;  // 0x7FFF0000..0x7FFFFFFF reserved
// Per-process ring3 shim page (kernel-provided): holds the callback-return
// trampoline (`int 0x2F`) that a synchronously-invoked wndproc RETs to. Sits
// below the TEB region where apps never allocate.
export const USER_SHIM_VA    = 0x7FFDC000;

// Kernel half (shared across every process page directory).
export const KVBASE          = 0xC0000000;    // kernel image alias base (PDE 768)
export const KERNEL_STACK_REGION = 0xC0010000; // KVBASE + 0x10000; stacks grow down from REGION+size
export const KERNEL_STACK_SIZE   = 0x2000;     // 8 KB per ring0 stack (room for nested callback sub-stacks)
export const KERNEL_PDE_INDEX = (KVBASE >>> 22) & 0x3FF; // 768

// Kernel image / structures, as virtual addresses (what lgdt/lidt/ltr use).
export const GDT_VA     = KVBASE + KOFF_GDT;
export const GDT_PTR_VA = KVBASE + KOFF_GDT_PTR;
export const IDT_VA     = KVBASE + KOFF_IDT;
export const IDT_PTR_VA = KVBASE + KOFF_IDT_PTR;
export const TSS_VA     = KVBASE + KOFF_TSS;
export const HIGH_INIT_VA = KVBASE + KOFF_HIGH_INIT;
export const LAUNCHER_VA   = KVBASE + KOFF_LAUNCHER;
export const HALT_VA       = KVBASE + KOFF_HALT;
export const API_ENTRY_VA  = KVBASE + KOFF_API_ENTRY;
export const CBRET_VA      = KVBASE + KOFF_CBRET;

// ---------------------------------------------------------------------------
// GDT selectors
// ---------------------------------------------------------------------------
export const SEL_KCODE = 0x08;          // ring0 code, DPL0
export const SEL_KDATA = 0x10;          // ring0 data, DPL0
export const SEL_UCODE = 0x1B;          // 0x18 | RPL3  ring3 code
export const SEL_UDATA = 0x23;          // 0x20 | RPL3  ring3 data
export const SEL_TSS   = 0x28;          // TSS
export const SEL_FS    = 0x33;          // 0x30 | RPL3  FS/TEB (base patched per thread)
export const GDT_FS_INDEX = 6;          // descriptor index of the FS/TEB entry

// ---------------------------------------------------------------------------
// IDT vectors
// ---------------------------------------------------------------------------
export const VEC_PF    = 14;            // #PF
export const VEC_API   = 0x2E;          // Win32 API dispatch gate (DPL3) — NT syscall vector
export const VEC_CBRET = 0x2F;          // callback-return gate (DPL3)

// I/O ports the ring0 stubs OUT to (legal at ring0; ignored by v86 devices).
export const PORT_API   = 0xE3;
export const PORT_PF    = 0xE2;
export const PORT_EXC   = 0xE1;
export const PORT_CBRET = 0xE9;
export const PORT_BOOT  = 0xE4;   // high_init → JS: switch CR3 to first process PD, then launch

// ---------------------------------------------------------------------------
// PTE flags (hardware bits + software-defined bits in the ignored field)
// ---------------------------------------------------------------------------
export const PTE_PRESENT  = 0x001;
export const PTE_RW       = 0x002;
export const PTE_USER     = 0x004;
export const PTE_ACCESSED = 0x020;
export const PTE_DIRTY    = 0x040;
// Software bits (CPU ignores bits 9-11): track VirtualAlloc/VAD paging state.
export const PTE_SW_COMMITTED = 0x200;  // committed, lazy zero-fill on first fault
export const PTE_SW_GUARD     = 0x400;  // guard page (STATUS_GUARD_PAGE_VIOLATION on touch)
export const PTE_SW_RESERVED  = 0x800;  // reserved only (access → AV)
export const PTE_FRAME_MASK   = 0xFFFFF000;

// ---------------------------------------------------------------------------
// Win32 memory protection constants (for VirtualAlloc/Protect/Query)
// ---------------------------------------------------------------------------
export const PAGE_NOACCESS          = 0x01;
export const PAGE_READONLY          = 0x02;
export const PAGE_READWRITE         = 0x04;
export const PAGE_WRITECOPY         = 0x08;
export const PAGE_EXECUTE           = 0x10;
export const PAGE_EXECUTE_READ      = 0x20;
export const PAGE_EXECUTE_READWRITE = 0x40;
export const PAGE_EXECUTE_WRITECOPY = 0x80;
export const PAGE_GUARD             = 0x100;

/** Win32 PAGE_* protection → PTE hardware flags (present user page). Returns 0
 *  for PAGE_NOACCESS (caller should leave the page unmapped). */
export function pteFlagsFromProtect(protect: number): number {
    const base = protect & 0xFF;
    if (base === PAGE_NOACCESS) return 0;
    const writable = (base & (PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)) !== 0;
    return PTE_PRESENT | PTE_USER | (writable ? PTE_RW : 0);
}
