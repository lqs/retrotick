// Load a real PE32 binary into the v86 backend's virtual address space.
//
// Steps:
//   1. Parse PE/COFF headers, sections, data directories.
//   2. vmAlloc the entire image footprint at the preferred (or override) base.
//   3. vmCopy PE headers + each section's raw data into VA space.
//   4. Apply IMAGE_REL_BASED_HIGHLOW relocations if loaded off preferred base.
//   5. Walk the import descriptor table; for each imported function, register
//      a thunk handler, write the thunk stub, and patch the IAT slot.
//   6. Allocate stack VA.
//
// Caller supplies an api-lookup callback (dll, name) -> ThunkHandler so this
// module doesn't need to know about Win32 specifics.

import type { V86Runtime } from './runtime';
import type { ThunkHandler } from './trap';
import { PTE_PRESENT, PTE_RW } from './types';

export interface LoadedPE {
    imageBase: number;
    entryVA: number;
    sizeOfImage: number;
    stackTop: number;
    stackBottom: number;
    imports: Array<{ dll: string; name: string; iatVA: number; thunkVA: number; thunkId: number }>;
    sections: Array<{ name: string; virtualAddress: number; virtualSize: number; characteristics: number }>;
}

/** Resolution for an import: either route through a JS handler (thunk), or
 *  bind directly to a real address in v86 memory (e.g. a sibling-DLL export). */
export type ApiResolution =
    | { kind: 'thunk'; handler: ThunkHandler }
    | { kind: 'real'; va: number };

export interface ApiLookup {
    (dll: string, name: string): ApiResolution;
}

const IMAGE_REL_BASED_ABSOLUTE = 0;
const IMAGE_REL_BASED_HIGHLOW = 3;

/** Inspect a PE's import descriptor table and return the (uppercase) names of
 *  every DLL it links against. Used by bootstrap to discover sibling DLLs
 *  that need pre-loading before walkImports patches the IAT. */
export function scanImportDLLs(arrayBuffer: ArrayBuffer): string[] {
    const dv = new DataView(arrayBuffer);
    if (dv.getUint16(0, true) !== 0x5A4D) return [];
    const e_lfanew = dv.getUint32(0x3C, true);
    if (dv.getUint32(e_lfanew, true) !== 0x00004550) return [];
    const coffOff = e_lfanew + 4;
    const sizeOfOptionalHeader = dv.getUint16(coffOff + 16, true);
    const numberOfSections = dv.getUint16(coffOff + 2, true);
    const optOff = coffOff + 20;
    if (dv.getUint16(optOff, true) !== 0x010B) return [];
    const dataDirOff = optOff + 96;
    const importRva = dv.getUint32(dataDirOff + 1 * 8, true);
    if (importRva === 0) return [];
    const sizeOfHeaders = dv.getUint32(optOff + 60, true);
    const sectionOff = optOff + sizeOfOptionalHeader;
    const sections: { va: number; vs: number }[] = [];
    const sectionRaw: { ptr: number; size: number }[] = [];
    for (let i = 0; i < numberOfSections; i++) {
        const off = sectionOff + i * 40;
        sections.push({
            va: dv.getUint32(off + 12, true),
            vs: dv.getUint32(off + 8, true),
        });
        sectionRaw.push({
            ptr: dv.getUint32(off + 20, true),
            size: dv.getUint32(off + 16, true),
        });
    }
    const toFile = (rva: number): number => {
        for (let i = 0; i < sections.length; i++) {
            const s = sections[i], r = sectionRaw[i];
            if (rva >= s.va && rva < s.va + Math.max(s.vs, r.size)) {
                return rva - s.va + r.ptr;
            }
        }
        if (rva < sizeOfHeaders) return rva;
        return -1;
    };
    const descOffset = toFile(importRva);
    if (descOffset < 0) return [];
    const readNullStr = (offset: number): string => {
        let s = '';
        for (let i = 0; offset + i < arrayBuffer.byteLength; i++) {
            const ch = dv.getUint8(offset + i);
            if (ch === 0) break;
            s += String.fromCharCode(ch);
        }
        return s;
    };
    const dlls: string[] = [];
    for (let i = 0; ; i++) {
        const off = descOffset + i * 20;
        if (off + 20 > arrayBuffer.byteLength) break;
        const iltRva = dv.getUint32(off, true);
        const nameRva = dv.getUint32(off + 12, true);
        const iatRva = dv.getUint32(off + 16, true);
        if (iltRva === 0 && nameRva === 0 && iatRva === 0) break;
        const nameOff = toFile(nameRva);
        if (nameOff < 0) continue;
        const name = readNullStr(nameOff).toUpperCase();
        if (!dlls.includes(name)) dlls.push(name);
    }
    return dlls;
}

export function loadPEIntoV86(
    arrayBuffer: ArrayBuffer,
    runtime: V86Runtime,
    apiLookup: ApiLookup,
    options: { baseOverride?: number; stackSize?: number } = {},
): LoadedPE {
    const dv = new DataView(arrayBuffer);

    if (dv.getUint16(0, true) !== 0x5A4D) throw new Error('Not a PE file');
    const e_lfanew = dv.getUint32(0x3C, true);
    if (dv.getUint32(e_lfanew, true) !== 0x00004550) throw new Error('Invalid PE signature');

    const coffOff = e_lfanew + 4;
    const numberOfSections = dv.getUint16(coffOff + 2, true);
    const sizeOfOptionalHeader = dv.getUint16(coffOff + 16, true);
    const optOff = coffOff + 20;

    const magic = dv.getUint16(optOff, true);
    if (magic !== 0x010B) throw new Error('Only PE32 (32-bit) is supported');

    const entryPointRva = dv.getUint32(optOff + 16, true);
    const preferredBase = dv.getUint32(optOff + 28, true);
    const imageBase = options.baseOverride ?? preferredBase;
    const sizeOfImage = dv.getUint32(optOff + 56, true);
    const sizeOfHeaders = dv.getUint32(optOff + 60, true);

    const dataDirOff = optOff + 96;
    const numDataDirs = dv.getUint32(dataDirOff - 4, true);
    const dataDirectories: { virtualAddress: number; size: number }[] = [];
    for (let i = 0; i < numDataDirs; i++) {
        dataDirectories.push({
            virtualAddress: dv.getUint32(dataDirOff + i * 8, true),
            size: dv.getUint32(dataDirOff + i * 8 + 4, true),
        });
    }

    const sectionOff = optOff + sizeOfOptionalHeader;
    const sections: LoadedPE['sections'] = [];
    const sectionRaw: Array<{ pointerToRawData: number; sizeOfRawData: number }> = [];
    for (let i = 0; i < numberOfSections; i++) {
        const off = sectionOff + i * 40;
        let name = '';
        for (let j = 0; j < 8; j++) {
            const ch = dv.getUint8(off + j);
            if (ch === 0) break;
            name += String.fromCharCode(ch);
        }
        sections.push({
            name,
            virtualAddress: dv.getUint32(off + 12, true),
            virtualSize: dv.getUint32(off + 8, true),
            characteristics: dv.getUint32(off + 36, true),
        });
        sectionRaw.push({
            pointerToRawData: dv.getUint32(off + 20, true),
            sizeOfRawData: dv.getUint32(off + 16, true),
        });
    }

    // Allocate VA for the entire image footprint.
    const PAGE = 0x1000;
    const imagePages = Math.ceil(sizeOfImage / PAGE);
    runtime.vm.vmAlloc(imageBase, imagePages, PTE_PRESENT | PTE_RW);

    // Copy headers + sections into VA.
    const headerBytes = new Uint8Array(arrayBuffer, 0, Math.min(sizeOfHeaders, arrayBuffer.byteLength));
    runtime.vm.vmCopy(imageBase, headerBytes);

    for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        const r = sectionRaw[i];
        if (r.sizeOfRawData > 0 && r.pointerToRawData > 0) {
            const rawSize = Math.min(r.sizeOfRawData, arrayBuffer.byteLength - r.pointerToRawData);
            if (rawSize > 0) {
                const data = new Uint8Array(arrayBuffer, r.pointerToRawData, rawSize);
                runtime.vm.vmCopy(imageBase + s.virtualAddress, data);
            }
        }
    }

    // Apply base relocations.
    const delta = (imageBase - preferredBase) | 0;
    if (delta !== 0 && dataDirectories.length > 5 && dataDirectories[5].virtualAddress !== 0) {
        applyRelocations(runtime, arrayBuffer, dataDirectories[5], imageBase, delta, sectionRaw, sections, sizeOfHeaders);
    }

    // Process imports — walk import descriptor table.
    const imports: LoadedPE['imports'] = [];
    if (dataDirectories.length > 1 && dataDirectories[1].virtualAddress !== 0) {
        const importRva = dataDirectories[1].virtualAddress;
        const descOffset = rvaToFileOffset(importRva, sectionRaw, sections, sizeOfHeaders);
        if (descOffset >= 0) {
            walkImports(arrayBuffer, descOffset, sectionRaw, sections, sizeOfHeaders, imageBase, runtime, apiLookup, imports);
        }
    }

    // Allocate stack — place it well above image footprint.
    const stackSize = options.stackSize ?? 0x100000;
    const stackBottom = ((imageBase + sizeOfImage + 0x10000 + 0xFFFF) & ~0xFFFF) >>> 0;
    const stackTop = (stackBottom + stackSize) >>> 0;
    runtime.vm.vmAlloc(stackBottom, stackSize / PAGE, PTE_PRESENT | PTE_RW);

    return {
        imageBase,
        entryVA: imageBase + entryPointRva,
        sizeOfImage,
        stackTop,
        stackBottom,
        imports,
        sections,
    };
}

function rvaToFileOffset(
    rva: number,
    sectionRaw: Array<{ pointerToRawData: number; sizeOfRawData: number }>,
    sections: Array<{ virtualAddress: number; virtualSize: number }>,
    sizeOfHeaders: number,
): number {
    for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        const r = sectionRaw[i];
        if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, r.sizeOfRawData)) {
            return rva - s.virtualAddress + r.pointerToRawData;
        }
    }
    if (rva < sizeOfHeaders) return rva;
    return -1;
}

function applyRelocations(
    runtime: V86Runtime,
    arrayBuffer: ArrayBuffer,
    relocDir: { virtualAddress: number; size: number },
    imageBase: number,
    delta: number,
    sectionRaw: Array<{ pointerToRawData: number; sizeOfRawData: number }>,
    sections: Array<{ virtualAddress: number; virtualSize: number }>,
    sizeOfHeaders: number,
): void {
    const fileOff = rvaToFileOffset(relocDir.virtualAddress, sectionRaw, sections, sizeOfHeaders);
    if (fileOff < 0) return;
    const dv = new DataView(arrayBuffer);
    let pos = fileOff;
    const end = fileOff + relocDir.size;
    let count = 0;

    while (pos + 8 <= end && pos + 8 <= arrayBuffer.byteLength) {
        const pageRva = dv.getUint32(pos, true);
        const blockSize = dv.getUint32(pos + 4, true);
        if (blockSize < 8) break;
        const numEntries = (blockSize - 8) / 2;
        for (let i = 0; i < numEntries; i++) {
            const entry = dv.getUint16(pos + 8 + i * 2, true);
            const type = entry >> 12;
            const off = entry & 0xFFF;
            if (type === IMAGE_REL_BASED_ABSOLUTE) continue;
            if (type === IMAGE_REL_BASED_HIGHLOW) {
                const va = imageBase + pageRva + off;
                const oldVal = runtime.vm.vmReadU32(va);
                runtime.vm.vmWriteU32(va, (oldVal + delta) >>> 0);
                count++;
            }
        }
        pos += blockSize;
    }
    if (count > 0) console.log(`[v86-pe] Applied ${count} base relocations (delta=0x${delta.toString(16)})`);
}

function walkImports(
    arrayBuffer: ArrayBuffer,
    descOffset: number,
    sectionRaw: Array<{ pointerToRawData: number; sizeOfRawData: number }>,
    sections: Array<{ virtualAddress: number; virtualSize: number }>,
    sizeOfHeaders: number,
    imageBase: number,
    runtime: V86Runtime,
    apiLookup: ApiLookup,
    imports: LoadedPE['imports'],
): void {
    const dv = new DataView(arrayBuffer);

    const readNullStr = (offset: number): string => {
        let s = '';
        for (let i = 0; offset + i < arrayBuffer.byteLength; i++) {
            const ch = dv.getUint8(offset + i);
            if (ch === 0) break;
            s += String.fromCharCode(ch);
        }
        return s;
    };

    for (let i = 0; ; i++) {
        const off = descOffset + i * 20;
        if (off + 20 > arrayBuffer.byteLength) break;
        const iltRva = dv.getUint32(off, true);
        const nameRva = dv.getUint32(off + 12, true);
        const iatRva = dv.getUint32(off + 16, true);
        if (iltRva === 0 && nameRva === 0 && iatRva === 0) break;

        let dllName: string;
        try {
            dllName = readNullStr(rvaToFileOffset(nameRva, sectionRaw, sections, sizeOfHeaders));
        } catch { continue; }

        const lookupRva = iltRva !== 0 ? iltRva : iatRva;
        if (lookupRva === 0) continue;

        const lookupOffset = rvaToFileOffset(lookupRva, sectionRaw, sections, sizeOfHeaders);
        if (lookupOffset < 0) continue;

        for (let j = 0; ; j++) {
            const entryOff = lookupOffset + j * 4;
            if (entryOff + 4 > arrayBuffer.byteLength) break;
            const entry = dv.getUint32(entryOff, true);
            if (entry === 0) break;

            let funcName: string;
            if (entry & 0x80000000) {
                funcName = `ord_${entry & 0xFFFF}`;
            } else {
                const hintNameOffset = rvaToFileOffset(entry & 0x7FFFFFFF, sectionRaw, sections, sizeOfHeaders);
                if (hintNameOffset < 0) { funcName = `unknown_${j}`; }
                else { funcName = readNullStr(hintNameOffset + 2); }
            }

            const dllUpper = dllName.toUpperCase();
            const resolution = apiLookup(dllUpper, funcName);
            let iatTarget: number;
            let thunkId = -1;
            if (resolution.kind === 'real') {
                iatTarget = resolution.va;
            } else {
                thunkId = runtime.registerThunk(resolution.handler);
                iatTarget = runtime.allocAndPlaceThunkStub(thunkId, resolution.handler.stackBytes);
            }
            const iatVA = imageBase + iatRva + j * 4;
            runtime.vm.vmWriteU32(iatVA, iatTarget);
            imports.push({ dll: dllUpper, name: funcName, iatVA, thunkVA: iatTarget, thunkId });
        }
    }
}
