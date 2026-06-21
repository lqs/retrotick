// Reference-counted physical frame allocator for the v86 Windows kernel.
//
// Hands out 4 KB physical frames from a bump pool starting at PHYS_FRAME_POOL,
// recycling freed frames via a free list. Reference counting exists because the
// shared higher-half kernel page-table frames are referenced by every process
// page directory, and future copy-on-write shared sections need it too.

import { PAGE_SIZE, PHYS_FRAME_POOL } from './kconst';
import type { V86Instance } from './types';

const ZERO_PAGE = new Uint8Array(PAGE_SIZE);

export class FrameAllocator {
    private nextBump: number;
    private freeList: number[] = [];
    private refcount = new Map<number, number>();

    constructor(private emu: V86Instance, private physEnd: number, poolBase = PHYS_FRAME_POOL) {
        this.nextBump = poolBase;
    }

    /** Allocate a frame (refcount = 1). Zeroes it unless `zero` is false. */
    alloc(zero = true): number {
        let frame: number;
        if (this.freeList.length > 0) {
            frame = this.freeList.pop()!;
        } else {
            if (this.nextBump + PAGE_SIZE > this.physEnd) {
                throw new Error(`FrameAllocator: out of physical memory (pool exhausted at 0x${this.nextBump.toString(16)})`);
            }
            frame = this.nextBump;
            this.nextBump += PAGE_SIZE;
        }
        this.refcount.set(frame, 1);
        if (zero) this.emu.write_memory(ZERO_PAGE, frame);
        return frame;
    }

    incref(frame: number): void {
        this.refcount.set(frame, (this.refcount.get(frame) ?? 0) + 1);
    }

    /** Drop a reference; frees the frame back to the pool at count 0. */
    decref(frame: number): void {
        const c = (this.refcount.get(frame) ?? 0) - 1;
        if (c <= 0) {
            this.refcount.delete(frame);
            this.freeList.push(frame);
        } else {
            this.refcount.set(frame, c);
        }
    }

    refcountOf(frame: number): number {
        return this.refcount.get(frame) ?? 0;
    }

    /** Frames currently handed out (for diagnostics). */
    get allocatedCount(): number {
        return this.refcount.size;
    }
}
