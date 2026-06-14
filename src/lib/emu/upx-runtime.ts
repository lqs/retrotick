import type { Emulator } from './emulator';
import type { PEInfo } from '../pe/types';
import { parsePE } from '../pe';
import { ordinalToName } from './dll-ordinals';

/** Run the UPX decompression stub synchronously until execution leaves the
 *  UPX1 section (i.e. the stub has jumped to the original entry point in the
 *  now-populated UPX0 region). After this returns, EIP holds OEP and the
 *  unpacked image is fully resident in emulator memory.
 *
 *  The CPU was set up with EIP = entryPoint by `loadPE`, which for a
 *  UPX-packed file lives inside UPX1 — exactly where the stub starts. We
 *  reuse our existing instruction decoder + Win32 API thunks; no separate
 *  NRV2B/D/E/LZMA decompressor is needed.
 */
export function runUpxStub(emu: Emulator, peInfo: PEInfo): boolean {
  const upx0 = peInfo.sections.find(s => /UPX0/i.test(s.name));
  const upx1 = peInfo.sections.find(s => /UPX1/i.test(s.name));
  if (!upx1) return false;
  const upx1Start = (emu.pe.imageBase + upx1.virtualAddress) >>> 0;
  const upx1End = (upx1Start + upx1.virtualSize) >>> 0;
  // OEP detection: EIP enters UPX0 (the originally-empty section that the
  // stub fills with the decompressed image). Mid-stub the EIP frequently
  // visits thunk pages (GetProcAddress, VirtualAlloc, ...) and then returns
  // to UPX1; only a transition into UPX0 means decompression is done.
  const upx0Start = upx0 ? (emu.pe.imageBase + upx0.virtualAddress) >>> 0 : 0;
  const upx0End = upx0 ? (upx0Start + upx0.virtualSize) >>> 0 : 0;

  // Sanity check: the entry point should be inside UPX1 for a packed PE.
  const entry = emu.cpu.eip >>> 0;
  if (entry < upx1Start || entry >= upx1End) {
    return true;
  }

  // While the stub runs, GetProcAddress is hammered by both the unpacker and
  // the C runtime init that follows OEP. Real Windows returns NULL for missing
  // names and the caller falls back; our emulator usually has the *behaviour*
  // (e.g. PathFindExtensionA) but not the registered *symbol*. Wrap GPA for
  // the duration so an unknown name auto-creates a () => 0 thunk — this lets
  // the unpacker + CRT init complete without aborting via ExitProcess. The
  // production GPA outside this hook stays strict so missing implementations
  // still surface.
  const origGpaDef = emu.apiDefs.get('KERNEL32.DLL:GetProcAddress');
  const origGpa = origGpaDef?.handler;
  if (origGpa) {
    emu.apiDefs.set('KERNEL32.DLL:GetProcAddress', {
      handler: () => {
        const r = origGpa(emu);
        if (r !== 0) return r;
        // Auto-create a noop stub for the resolved (dll, name) pair so the
        // unpacker + CRT init can complete. This must register under the SAME
        // dll/name the production GPA looks up, otherwise the second-pass
        // origGpa call won't see it. We resolve the same way GetProcAddress
        // does: stub-DLL hModule → DLL name; ordinal → real export name.
        const hModule = emu.readArg(0);
        const nameOrOrd = emu.readArg(1);
        let dll = emu.stubDllByBase.get(hModule) ?? 'KERNEL32.DLL';
        let name: string;
        if (nameOrOrd < 0x10000 && nameOrOrd > 0) {
          const resolved = ordinalToName(dll, nameOrOrd);
          name = resolved ?? `ord_${nameOrOrd}`;
        } else if (nameOrOrd) {
          name = emu.memory.readCString(nameOrOrd);
        } else {
          return 0;
        }
        if (!name) return 0;
        const fallbackKey = `${dll}:${name}`;
        if (!emu.apiDefs.has(fallbackKey)) {
          emu.apiDefs.set(fallbackKey, { handler: () => 0, stackBytes: 0 });
        }
        return origGpa(emu);
      },
      stackBytes: origGpaDef.stackBytes,
    });
  }

  emu.running = true;
  emu.halted = false;
  const MAX_WARMUP_TICKS = 500;
  let result = false;
  try {
    let lastEip = entry;
    let stuck = 0;
    for (let i = 0; i < MAX_WARMUP_TICKS; i++) {
      if (emu.halted) {
        console.warn(`[UPX] Stub halted at EIP=0x${(emu.cpu.eip >>> 0).toString(16)} reason=${emu.haltReason || 'none'}`);
        break;
      }
      const eip = emu.cpu.eip >>> 0;
      if (upx0 && eip >= upx0Start && eip < upx0End) {
        console.log(`[UPX] Decompressor stub finished after ${i} warmup ticks, OEP=0x${eip.toString(16)}`);
        result = true;
        break;
      }
      if (eip === lastEip) stuck++; else { stuck = 0; lastEip = eip; }
      if (stuck > 50) {
        console.warn(`[UPX] EIP stuck at 0x${eip.toString(16)} after ${i} ticks — bailing`);
        break;
      }
      emu.tick();
    }
    if (!result && !emu.halted) {
      console.warn(`[UPX] Stub did not reach OEP after ${MAX_WARMUP_TICKS} ticks (still at 0x${(emu.cpu.eip >>> 0).toString(16)})`);
    }
  } finally {
    emu.running = false;
    // Restore the original GetProcAddress so production behaviour is unchanged.
    if (origGpaDef) emu.apiDefs.set('KERNEL32.DLL:GetProcAddress', origGpaDef);
  }
  return result;
}

/** Snapshot the in-memory unpacked image into a synthetic PE buffer where
 *  every section's `PointerToRawData` equals its `VirtualAddress` (so
 *  `rvaToFileOffset(rva, sections) === rva`). Re-parsing this buffer recovers
 *  the resource tree, imports, etc. that weren't visible on disk before
 *  the stub ran. */
export function snapshotUnpackedPE(emu: Emulator, peInfo: PEInfo, originalBuffer: ArrayBuffer): ArrayBuffer {
  // Determine total size: max(virtualAddress + virtualSize) across sections
  let imageSize = 0;
  for (const s of peInfo.sections) {
    const end = s.virtualAddress + s.virtualSize;
    if (end > imageSize) imageSize = end;
  }
  // Round up to 0x1000 alignment (page-size)
  imageSize = (imageSize + 0xFFF) & ~0xFFF;

  const buf = new Uint8Array(imageSize);

  // Copy headers: from offset 0 up to the first section's pointerToRawData.
  // For UPX, headers are usually < 0x400 bytes and the first section starts
  // at vaddr=0x1000, so we copy up to min(file headerEnd, vaddr).
  let headerEnd = 0x1000;
  let minVaddr = 0x7FFFFFFF;
  for (const s of peInfo.sections) {
    if (s.virtualAddress > 0 && s.virtualAddress < minVaddr) minVaddr = s.virtualAddress;
  }
  if (minVaddr < headerEnd) headerEnd = minVaddr;
  const origView = new Uint8Array(originalBuffer, 0, Math.min(headerEnd, originalBuffer.byteLength));
  buf.set(origView, 0);

  // Copy each section's data from emulator memory at imageBase + virtualAddress
  for (const s of peInfo.sections) {
    if (s.virtualSize === 0) continue;
    const srcAddr = (emu.pe.imageBase + s.virtualAddress) >>> 0;
    for (let i = 0; i < s.virtualSize; i++) {
      buf[s.virtualAddress + i] = emu.memory.readU8(srcAddr + i);
    }
  }

  // Patch each section header in the snapshot so PointerToRawData == VirtualAddress
  // and SizeOfRawData == VirtualSize. This makes rvaToFileOffset trivial.
  const dv = new DataView(buf.buffer);
  const e_lfanew = peInfo.dosHeader.e_lfanew;
  const sectionTableOffset = e_lfanew + 4 /*PE sig*/ + 20 /*COFF*/ + peInfo.coffHeader.sizeOfOptionalHeader;
  for (let i = 0; i < peInfo.sections.length; i++) {
    const so = sectionTableOffset + i * 40;
    const s = peInfo.sections[i];
    dv.setUint32(so + 16, s.virtualSize, true);     // SizeOfRawData
    dv.setUint32(so + 20, s.virtualAddress, true);  // PointerToRawData
  }

  return buf.buffer;
}

/** End-to-end: run UPX stub then re-parse to discover imports and resources
 *  that are only visible after decompression. Returns the new PEInfo (with
 *  populated `resources`) and the synthetic unpacked buffer. The caller is
 *  responsible for plugging these into the rest of the load pipeline. */
export function unpackUpxInPlace(
  emu: Emulator,
  peInfo: PEInfo,
  originalBuffer: ArrayBuffer,
): { unpackedBuffer: ArrayBuffer; unpackedInfo: PEInfo } | null {
  if (!runUpxStub(emu, peInfo)) return null;
  const unpackedBuffer = snapshotUnpackedPE(emu, peInfo, originalBuffer);
  const unpackedInfo = parsePE(unpackedBuffer);
  return { unpackedBuffer, unpackedInfo };
}
