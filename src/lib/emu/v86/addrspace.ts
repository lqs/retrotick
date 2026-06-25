// Per-process address space (page directory) for the v86 Windows kernel.
//
// Every process owns one page directory. The bottom half (PDE 0..511, VA
// 0x00000000..0x7FFFFFFF) is private. The top half (PDE 512..1023, VA
// 0x80000000..0xFFFFFFFF) points at the same shared kernel page tables in every
// PD, so the GDT/IDT/TSS/ISR stubs at KVBASE are reachable under any CR3 — that
// is what makes a CR3 switch a cheap, safe process switch.

import {
    PAGE_SIZE, PAGE_MASK, PTE_FRAME_MASK,
    PTE_PRESENT, PTE_RW, PTE_USER,
    KERNEL_PDE_INDEX, KVBASE, KERNEL_IMAGE_SIZE, KERNEL_STACK_REGION,
    PHYS_KERNEL_IMAGE, PHYS_KERNEL_STACKS, KERNEL_STACK_SIZE,
} from './kconst';
import type { FrameAllocator } from './frame';
import type { V86Instance } from './types';

function rd32(emu: V86Instance, pa: number): number {
    const b = emu.read_memory(pa, 4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}
function wr32(emu: V86Instance, pa: number, val: number): void {
    const b = new Uint8Array(4);
    b[0] = val & 0xFF; b[1] = (val >>> 8) & 0xFF; b[2] = (val >>> 16) & 0xFF; b[3] = (val >>> 24) & 0xFF;
    emu.write_memory(b, pa);
}

/** Shared higher-half kernel mappings: a map of PDE index → PDE value, spliced
 *  into the top half of every process page directory. Built once at boot. */
export interface SharedKernel {
    pdes: Map<number, number>;
}

/** Build the shared kernel page table(s). PDE 768 (0xC0000000..0xC0400000) maps
 *  the kernel image + a pool of ring0 stacks, supervisor-only (no USER bit, so
 *  ring3 cannot read kernel memory — hardware-enforced, see poc-ring3). */
export function buildSharedKernelTables(emu: V86Instance, frames: FrameAllocator): SharedKernel {
    const pt = frames.alloc();   // page table for PDE 768

    const mapKernel = (va: number, pa: number) => {
        const pteIdx = (va >>> 12) & 0x3FF;
        wr32(emu, pt + pteIdx * 4, (pa & PTE_FRAME_MASK) | PTE_PRESENT | PTE_RW); // supervisor
    };

    // Kernel image (GDT/IDT/TSS/stubs/launcher) at KVBASE.
    for (let off = 0; off < KERNEL_IMAGE_SIZE; off += PAGE_SIZE) {
        mapKernel(KVBASE + off, PHYS_KERNEL_IMAGE + off);
    }
    // Ring0 kernel stacks at KERNEL_STACK_REGION (0x20000 = 256 KB → 16 threads
    // × 8 KB; stays below PHYS_KERNEL_PT at physical 0x80000).
    const STACK_BYTES = 0x20000;
    for (let off = 0; off < STACK_BYTES; off += PAGE_SIZE) {
        mapKernel(KERNEL_STACK_REGION + off, PHYS_KERNEL_STACKS + off);
    }

    const pdes = new Map<number, number>();
    pdes.set(KERNEL_PDE_INDEX, (pt & PTE_FRAME_MASK) | PTE_PRESENT | PTE_RW); // supervisor PDE
    return { pdes };
}

/** Allocate a per-thread ring0 stack from the kernel stack region. Returns the
 *  stack top VA (stacks grow down). Index 0 → highest stack. */
export function kernelStackTop(index: number): number {
    return KERNEL_STACK_REGION + (index + 1) * KERNEL_STACK_SIZE;
}

export class AddressSpace {
    pdPhys: number;

    /** Set by the runtime: invoked after any PTE mutation so a live (current) AS
     *  can flush the WASM CPU's TLB — otherwise the CPU may serve a stale cached
     *  translation for a page whose mapping just changed (e.g. a thread's TEB/stack
     *  added to a running process), reading the wrong physical frame. */
    onMutate?: () => void;
    private _suppressMutate = false;

    constructor(
        private emu: V86Instance,
        private frames: FrameAllocator,
        shared: SharedKernel,
        pdPhys?: number,    // fixed PD address (boot PD must live at PHYS_BOOT_PD); else allocate
    ) {
        if (pdPhys !== undefined) {
            this.pdPhys = pdPhys;
            emu.write_memory(new Uint8Array(PAGE_SIZE), pdPhys); // zero it
        } else {
            this.pdPhys = frames.alloc(); // zeroed page directory
        }
        for (const [idx, val] of shared.pdes) wr32(emu, this.pdPhys + idx * 4, val);
    }

    /** Identity-map the low `mb` megabytes (boot PD only: lets the real-mode→PM
     *  transition code keep executing once paging turns on, before we jump to
     *  the higher-half kernel). */
    addBootIdentity(mb: number): void {
        const pages = (mb * 0x100000) / PAGE_SIZE;
        for (let i = 0; i < pages; i++) {
            this.mapPage(i * PAGE_SIZE, i * PAGE_SIZE, PTE_PRESENT | PTE_RW | PTE_USER);
        }
    }

    /** Map a single 4 KB page; allocates a (user) page table on demand. */
    mapPage(va: number, physFrame: number, flags: number): void {
        const pdeIdx = (va >>> 22) & 0x3FF;
        let pde = rd32(this.emu, this.pdPhys + pdeIdx * 4);
        let pt: number;
        if ((pde & PTE_PRESENT) === 0) {
            pt = this.frames.alloc();
            pde = (pt & PTE_FRAME_MASK) | PTE_PRESENT | PTE_RW | PTE_USER;
            wr32(this.emu, this.pdPhys + pdeIdx * 4, pde);
        } else {
            pt = pde & PTE_FRAME_MASK;
        }
        const pteIdx = (va >>> 12) & 0x3FF;
        wr32(this.emu, pt + pteIdx * 4, (physFrame & PTE_FRAME_MASK) | flags);
        if (!this._suppressMutate) this.onMutate?.();
    }

    /** Allocate `nPages` fresh frames and map them contiguously at `va`. */
    mapRange(va: number, nPages: number, flags: number): void {
        this._suppressMutate = true;
        try {
            for (let i = 0; i < nPages; i++) {
                const frame = this.frames.alloc();
                this.mapPage(va + i * PAGE_SIZE, frame, flags);
            }
        } finally { this._suppressMutate = false; }
        this.onMutate?.();
    }

    getPTE(va: number): number {
        const pde = rd32(this.emu, this.pdPhys + ((va >>> 22) & 0x3FF) * 4);
        if ((pde & PTE_PRESENT) === 0) return 0;
        return rd32(this.emu, (pde & PTE_FRAME_MASK) + ((va >>> 12) & 0x3FF) * 4);
    }

    setPTE(va: number, val: number): void {
        const pdeIdx = (va >>> 22) & 0x3FF;
        let pde = rd32(this.emu, this.pdPhys + pdeIdx * 4);
        if ((pde & PTE_PRESENT) === 0) {
            const pt = this.frames.alloc();
            pde = (pt & PTE_FRAME_MASK) | PTE_PRESENT | PTE_RW | PTE_USER;
            wr32(this.emu, this.pdPhys + pdeIdx * 4, pde);
        }
        wr32(this.emu, (pde & PTE_FRAME_MASK) + ((va >>> 12) & 0x3FF) * 4, val);
        if (!this._suppressMutate) this.onMutate?.();
    }

    /** Ensure `va`'s page is backed by a frame; returns the page's physical
     *  base. Used by both the #PF handler and the JS memory adapters so guest
     *  and host see a consistent address space. (M2 policy: lazily commit any
     *  user page RW. M3 replaces this with VAD-aware reserve/commit/protect.) */
    ensureMapped(va: number, flags: number = PTE_PRESENT | PTE_RW | PTE_USER): number {
        const pa = this.translate(va);
        if (pa >= 0) return pa & PTE_FRAME_MASK;
        const frame = this.frames.alloc();
        this.mapPage(va, frame, flags);
        return frame;
    }

    /** VA → PA, or -1 if not present. */
    translate(va: number): number {
        const pde = rd32(this.emu, this.pdPhys + ((va >>> 22) & 0x3FF) * 4);
        if ((pde & PTE_PRESENT) === 0) return -1;
        const pte = rd32(this.emu, (pde & PTE_FRAME_MASK) + ((va >>> 12) & 0x3FF) * 4);
        if ((pte & PTE_PRESENT) === 0) return -1;
        return (pte & PTE_FRAME_MASK) | (va & PAGE_MASK);
    }

    /** Write bytes into already-mapped VA, walking the page table per page. */
    writeBytes(va: number, data: Uint8Array): void {
        let off = 0;
        while (off < data.length) {
            const inPage = (va + off) & PAGE_MASK;
            const chunk = Math.min(PAGE_SIZE - inPage, data.length - off);
            const pa = this.translate(va + off);
            if (pa < 0) throw new Error(`writeBytes: VA 0x${(va + off).toString(16)} not mapped`);
            this.emu.write_memory(data.subarray(off, off + chunk), pa);
            off += chunk;
        }
    }

    readBytes(va: number, len: number): Uint8Array {
        const out = new Uint8Array(len);
        let off = 0;
        while (off < len) {
            const inPage = (va + off) & PAGE_MASK;
            const chunk = Math.min(PAGE_SIZE - inPage, len - off);
            const pa = this.translate(va + off);
            if (pa < 0) throw new Error(`readBytes: VA 0x${(va + off).toString(16)} not mapped`);
            out.set(this.emu.read_memory(pa, chunk), off);
            off += chunk;
        }
        return out;
    }

    writeU32(va: number, val: number): void {
        const b = new Uint8Array(4);
        b[0] = val & 0xFF; b[1] = (val >>> 8) & 0xFF; b[2] = (val >>> 16) & 0xFF; b[3] = (val >>> 24) & 0xFF;
        this.writeBytes(va, b);
    }
    readU32(va: number): number {
        const b = this.readBytes(va, 4);
        return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    }
}
