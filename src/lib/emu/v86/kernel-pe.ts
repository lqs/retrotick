// Load a PE32 binary into a per-process AddressSpace for the v86 Windows kernel.
//
// Differs from the legacy pe-loader.ts in two ways:
//   - Writes into an AddressSpace (per-process page directory, user pages) via
//     the page tables, instead of a single global identity-mapped VM.
//   - IAT thunks trap via `int 0x2E` (ring3-safe DPL3 gate) instead of the
//     ring0-only `OUT 0xE3`.

import { AddressSpace } from './addrspace';
import { PAGE_SIZE, PTE_PRESENT, PTE_RW, PTE_USER, VEC_API } from './kconst';

const USER_RW = PTE_PRESENT | PTE_RW | PTE_USER;

const IMAGE_REL_BASED_ABSOLUTE = 0;
const IMAGE_REL_BASED_HIGHLOW = 3;

/** Resolve an import. Most imports are functions → a thunk id (+ stdcall
 *  cleanup bytes); a few are DATA exports (e.g. MSVCRT `_acmdln`, `_environ`)
 *  whose IAT slot must hold the address of an initialized data cell, not a code
 *  thunk. The caller keeps the id → handler mapping for the int 0x2E dispatcher. */
export type ThunkResolution = { id: number; stackBytes: number } | { dataVA: number };
export type ThunkResolver = (dll: string, name: string) => ThunkResolution;

export interface LoadedKernelPE {
    imageBase: number;
    entryVA: number;
    sizeOfImage: number;
    stackTop: number;
    stackBottom: number;
    thunkPoolVA: number;
    imports: Array<{ dll: string; name: string; iatVA: number; thunkVA: number; id: number }>;
    sections: Array<{ name: string; virtualAddress: number; virtualSize: number; characteristics: number }>;
}

/** Build a 16-byte IAT thunk: `int 0x2E; ret <stackBytes>`.
 *  The thunk id is NOT encoded in a register — the dispatcher derives it from
 *  the trap return EIP (thunkVA+2). Encoding it via `mov eax, id` would clobber
 *  EAX, which MSVC EH helpers (_EH_prolog, __ehhandler) read as an INPUT (the
 *  handler address), corrupting the SEH frame → wild jump on a C++ throw. */
function buildThunkStub(stackBytes: number): Uint8Array {
    const s = new Uint8Array(16);
    s[0] = 0xCD; s[1] = VEC_API;          // int 0x2E
    if (stackBytes === 0) { s[2] = 0xC3; } // ret
    else { s[2] = 0xC2; s[3] = stackBytes & 0xFF; s[4] = (stackBytes >>> 8) & 0xFF; } // ret imm16
    return s;
}

function rvaToFile(rva: number, sections: { va: number; vs: number }[], raw: { ptr: number; size: number }[], sizeOfHeaders: number): number {
    for (let i = 0; i < sections.length; i++) {
        const s = sections[i], r = raw[i];
        if (rva >= s.va && rva < s.va + Math.max(s.vs, r.size)) return rva - s.va + r.ptr;
    }
    return rva < sizeOfHeaders ? rva : -1;
}

export function loadPEIntoAddressSpace(
    ab: ArrayBuffer,
    as: AddressSpace,
    resolve: ThunkResolver,
    opts: { baseOverride?: number; stackSize?: number } = {},
): LoadedKernelPE {
    const dv = new DataView(ab);
    if (dv.getUint16(0, true) !== 0x5A4D) throw new Error('Not a PE file');
    const peOff = dv.getUint32(0x3C, true);
    if (dv.getUint32(peOff, true) !== 0x00004550) throw new Error('Invalid PE signature');

    const coffOff = peOff + 4;
    const numSections = dv.getUint16(coffOff + 2, true);
    const sizeOfOptional = dv.getUint16(coffOff + 16, true);
    const optOff = coffOff + 20;
    if (dv.getUint16(optOff, true) !== 0x010B) throw new Error('Only PE32 supported');

    const entryRva = dv.getUint32(optOff + 16, true);
    const preferredBase = dv.getUint32(optOff + 28, true);
    const imageBase = opts.baseOverride ?? preferredBase;
    const sizeOfImage = dv.getUint32(optOff + 56, true);
    const sizeOfHeaders = dv.getUint32(optOff + 60, true);

    const dataDirOff = optOff + 96;
    const numDirs = dv.getUint32(dataDirOff - 4, true);
    const dirs: { va: number; size: number }[] = [];
    for (let i = 0; i < numDirs; i++) dirs.push({ va: dv.getUint32(dataDirOff + i * 8, true), size: dv.getUint32(dataDirOff + i * 8 + 4, true) });

    const secOff = optOff + sizeOfOptional;
    const sections: LoadedKernelPE['sections'] = [];
    const secVa: { va: number; vs: number }[] = [];
    const secRaw: { ptr: number; size: number }[] = [];
    for (let i = 0; i < numSections; i++) {
        const o = secOff + i * 40;
        let name = '';
        for (let j = 0; j < 8; j++) { const c = dv.getUint8(o + j); if (c === 0) break; name += String.fromCharCode(c); }
        const va = dv.getUint32(o + 12, true), vs = dv.getUint32(o + 8, true);
        sections.push({ name, virtualAddress: va, virtualSize: vs, characteristics: dv.getUint32(o + 36, true) });
        secVa.push({ va, vs });
        secRaw.push({ ptr: dv.getUint32(o + 20, true), size: dv.getUint32(o + 16, true) });
    }

    // Map the whole image footprint (user RW; per-section protection refined in M3).
    const imagePages = Math.ceil(sizeOfImage / PAGE_SIZE);
    as.mapRange(imageBase, imagePages, USER_RW);
    as.writeBytes(imageBase, new Uint8Array(ab, 0, Math.min(sizeOfHeaders, ab.byteLength)));
    for (let i = 0; i < sections.length; i++) {
        const r = secRaw[i];
        if (r.size > 0 && r.ptr > 0) {
            const n = Math.min(r.size, ab.byteLength - r.ptr);
            if (n > 0) as.writeBytes(imageBase + secVa[i].va, new Uint8Array(ab, r.ptr, n));
        }
    }

    // Base relocations.
    const delta = (imageBase - preferredBase) | 0;
    if (delta !== 0 && dirs.length > 5 && dirs[5].va !== 0) {
        const fo = rvaToFile(dirs[5].va, secVa, secRaw, sizeOfHeaders);
        if (fo >= 0) {
            let pos = fo; const end = fo + dirs[5].size;
            while (pos + 8 <= end && pos + 8 <= ab.byteLength) {
                const pageRva = dv.getUint32(pos, true), blockSize = dv.getUint32(pos + 4, true);
                if (blockSize < 8) break;
                const n = (blockSize - 8) / 2;
                for (let i = 0; i < n; i++) {
                    const e = dv.getUint16(pos + 8 + i * 2, true), type = e >> 12, off = e & 0xFFF;
                    if (type === IMAGE_REL_BASED_ABSOLUTE) continue;
                    if (type === IMAGE_REL_BASED_HIGHLOW) {
                        const va = imageBase + pageRva + off;
                        as.writeU32(va, (as.readU32(va) + delta) >>> 0);
                    }
                }
                pos += blockSize;
            }
        }
    }

    // Imports: collect (dll, name, iatVA), then emit thunk stubs into a user pool.
    const imports: LoadedKernelPE['imports'] = [];
    const pending: { dll: string; name: string; iatVA: number }[] = [];
    if (dirs.length > 1 && dirs[1].va !== 0) {
        const descOff = rvaToFile(dirs[1].va, secVa, secRaw, sizeOfHeaders);
        if (descOff >= 0) {
            const readStr = (o: number) => { if (o < 0) return ''; let s = ''; for (let i = 0; o + i < ab.byteLength; i++) { const c = dv.getUint8(o + i); if (c === 0) break; s += String.fromCharCode(c); } return s; };
            for (let i = 0; ; i++) {
                const o = descOff + i * 20;
                if (o + 20 > ab.byteLength) break;
                const iltRva = dv.getUint32(o, true), nameRva = dv.getUint32(o + 12, true), iatRva = dv.getUint32(o + 16, true);
                if (iltRva === 0 && nameRva === 0 && iatRva === 0) break;
                const dll = readStr(rvaToFile(nameRva, secVa, secRaw, sizeOfHeaders)).toUpperCase();
                const lookupRva = iltRva !== 0 ? iltRva : iatRva;
                if (lookupRva === 0) continue;
                const lookupOff = rvaToFile(lookupRva, secVa, secRaw, sizeOfHeaders);
                if (lookupOff < 0) continue;
                for (let j = 0; ; j++) {
                    const e = dv.getUint32(lookupOff + j * 4, true);
                    if (e === 0) break;
                    let fn: string;
                    if (e & 0x80000000) fn = `ord_${e & 0xFFFF}`;
                    else { const hno = rvaToFile(e & 0x7FFFFFFF, secVa, secRaw, sizeOfHeaders); fn = hno < 0 ? `unknown_${j}` : readStr(hno + 2); }
                    pending.push({ dll, name: fn, iatVA: imageBase + iatRva + j * 4 });
                }
            }
        }
    }

    // Thunk pool: user-executable pages right after the image.
    const thunkPoolVA = ((imageBase + sizeOfImage + 0xFFFF) & ~0xFFFF) >>> 0;
    const poolBytes = Math.max(PAGE_SIZE, pending.length * 16);
    as.mapRange(thunkPoolVA, Math.ceil(poolBytes / PAGE_SIZE), USER_RW);
    let slot = 0;
    for (const imp of pending) {
        const r = resolve(imp.dll, imp.name);
        if ('dataVA' in r) {
            // Data import: IAT slot points directly at the initialized data cell.
            as.writeU32(imp.iatVA, r.dataVA);
            imports.push({ dll: imp.dll, name: imp.name, iatVA: imp.iatVA, thunkVA: r.dataVA, id: -1 });
            continue;
        }
        const thunkVA = thunkPoolVA + slot * 16;
        slot++;
        as.writeBytes(thunkVA, buildThunkStub(r.stackBytes));
        as.writeU32(imp.iatVA, thunkVA);
        imports.push({ dll: imp.dll, name: imp.name, iatVA: imp.iatVA, thunkVA, id: r.id });
    }

    // User stack after the thunk pool.
    const stackSize = opts.stackSize ?? 0x100000;
    const stackBottom = ((thunkPoolVA + poolBytes + 0x10000 + 0xFFFF) & ~0xFFFF) >>> 0;
    const stackTop = (stackBottom + stackSize) >>> 0;
    as.mapRange(stackBottom, stackSize / PAGE_SIZE, USER_RW);

    return {
        imageBase, entryVA: imageBase + entryRva, sizeOfImage,
        stackTop, stackBottom, thunkPoolVA, imports, sections,
    };
}
