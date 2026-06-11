// Virtual memory manager for the v86 backend.
//
// Identity-maps physical 0..16 MB on init so kernel structures + page tables
// + initial code can run before paging is enabled and stay accessible after.
// Beyond 16 MB virtual, pages are allocated on demand from a bump-allocator
// physical pool starting at PHYS_POOL_BASE.

import {
    PHYS_PDE, PHYS_PTE_BASE, PHYS_POOL_BASE,
    PTE_PRESENT, PTE_RW,
    type V86Instance,
} from './types';

const PAGE_SIZE = 0x1000;
const IDENTITY_BYTES = 16 * 1024 * 1024;

export class V86VirtualMemory {
    nextPhysPage = PHYS_POOL_BASE;

    constructor(private emu: V86Instance) {}

    // Build initial PDE + PTE tables and write to v86 physical memory.
    initialize(): void {
        const pde = new Uint32Array(1024);
        const identityPDEs = IDENTITY_BYTES / 0x400000;
        for (let i = 0; i < identityPDEs; i++) {
            const pteAddr = PHYS_PTE_BASE + i * PAGE_SIZE;
            pde[i] = pteAddr | PTE_PRESENT | PTE_RW;
        }
        this.emu.write_memory(new Uint8Array(pde.buffer), PHYS_PDE);

        for (let i = 0; i < identityPDEs; i++) {
            const pte = new Uint32Array(1024);
            const baseVA = i * 0x400000;
            for (let j = 0; j < 1024; j++) {
                pte[j] = (baseVA + j * PAGE_SIZE) | PTE_PRESENT | PTE_RW;
            }
            this.emu.write_memory(new Uint8Array(pte.buffer), PHYS_PTE_BASE + i * PAGE_SIZE);
        }
    }

    allocPhysPage(): number {
        const page = this.nextPhysPage;
        this.nextPhysPage += PAGE_SIZE;
        return page;
    }

    // Read a 32-bit value from physical memory.
    readPhysU32(phys: number): number {
        const b = this.emu.read_memory(phys, 4);
        return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    }

    writePhysU32(phys: number, val: number): void {
        const b = new Uint8Array(4);
        b[0] = val & 0xFF;
        b[1] = (val >>> 8) & 0xFF;
        b[2] = (val >>> 16) & 0xFF;
        b[3] = (val >>> 24) & 0xFF;
        this.emu.write_memory(b, phys);
    }

    // Look up the PTE for a virtual address. Returns the PTE value (or 0 if no PDE).
    readPTE(va: number): number {
        const pdeIdx = (va >>> 22) & 0x3FF;
        const pteIdx = (va >>> 12) & 0x3FF;
        const pdeVal = this.readPhysU32(PHYS_PDE + pdeIdx * 4);
        if ((pdeVal & PTE_PRESENT) === 0) return 0;
        const pteTable = pdeVal & ~0xFFF;
        return this.readPhysU32(pteTable + pteIdx * 4);
    }

    // Map a 4 KB virtual page to a physical page with the given flags.
    // Allocates a PTE table on demand if the PDE slot is empty.
    mapPage(va: number, physPage: number, flags: number): void {
        const pdeIdx = (va >>> 22) & 0x3FF;
        const pteIdx = (va >>> 12) & 0x3FF;
        let pdeVal = this.readPhysU32(PHYS_PDE + pdeIdx * 4);
        let pteTable: number;
        if ((pdeVal & PTE_PRESENT) === 0) {
            pteTable = this.allocPhysPage();
            this.emu.write_memory(new Uint8Array(PAGE_SIZE), pteTable);
            pdeVal = pteTable | PTE_PRESENT | PTE_RW;
            this.writePhysU32(PHYS_PDE + pdeIdx * 4, pdeVal);
        } else {
            pteTable = pdeVal & ~0xFFF;
        }
        this.writePhysU32(pteTable + pteIdx * 4, (physPage & ~0xFFF) | flags);
    }

    // Allocate `nPages` 4 KB pages starting at VA, mapping each to a fresh
    // physical page. The first allocation in a previously-unmapped PDE will
    // allocate a PTE table as a side effect. Caller should flush TLB.
    vmAlloc(va: number, nPages: number, flags: number = PTE_PRESENT | PTE_RW): number[] {
        if ((va & 0xFFF) !== 0) throw new Error(`vmAlloc: VA 0x${va.toString(16)} not page-aligned`);
        const physPages: number[] = [];
        for (let i = 0; i < nPages; i++) {
            // If already mapped (e.g. identity-mapped first 16 MB), record existing PA.
            const existing = this.readPTE(va + i * PAGE_SIZE);
            if ((existing & PTE_PRESENT) !== 0) {
                physPages.push(existing & ~0xFFF);
                continue;
            }
            const phys = this.allocPhysPage();
            this.emu.write_memory(new Uint8Array(PAGE_SIZE), phys);
            this.mapPage(va + i * PAGE_SIZE, phys, flags);
            physPages.push(phys);
        }
        return physPages;
    }

    // Write bytes into virtual memory by walking the page table.
    // Assumes the VA range is already mapped (call vmAlloc first if needed).
    vmCopy(va: number, data: Uint8Array): void {
        let offset = 0;
        while (offset < data.length) {
            const pageVA = (va + offset) & ~0xFFF;
            const inPage = (va + offset) & 0xFFF;
            const chunk = Math.min(PAGE_SIZE - inPage, data.length - offset);
            const pte = this.readPTE(pageVA);
            if ((pte & PTE_PRESENT) === 0) {
                throw new Error(`vmCopy: VA 0x${(va + offset).toString(16)} not mapped`);
            }
            const phys = (pte & ~0xFFF) + inPage;
            this.emu.write_memory(data.subarray(offset, offset + chunk), phys);
            offset += chunk;
        }
    }

    // Read bytes from virtual memory.
    vmRead(va: number, length: number): Uint8Array {
        const out = new Uint8Array(length);
        let offset = 0;
        while (offset < length) {
            const pageVA = (va + offset) & ~0xFFF;
            const inPage = (va + offset) & 0xFFF;
            const chunk = Math.min(PAGE_SIZE - inPage, length - offset);
            const pte = this.readPTE(pageVA);
            if ((pte & PTE_PRESENT) === 0) {
                throw new Error(`vmRead: VA 0x${(va + offset).toString(16)} not mapped`);
            }
            const phys = (pte & ~0xFFF) + inPage;
            const slice = this.emu.read_memory(phys, chunk);
            out.set(slice, offset);
            offset += chunk;
        }
        return out;
    }

    vmReadU32(va: number): number {
        const b = this.vmRead(va, 4);
        return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    }

    vmWriteU32(va: number, val: number): void {
        const b = new Uint8Array(4);
        b[0] = val & 0xFF;
        b[1] = (val >>> 8) & 0xFF;
        b[2] = (val >>> 16) & 0xFF;
        b[3] = (val >>> 24) & 0xFF;
        this.vmCopy(va, b);
    }
}
