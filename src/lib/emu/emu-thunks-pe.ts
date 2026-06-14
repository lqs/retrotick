import type { Emulator } from './emulator';
import { extractStrings } from '../pe/extract-string';
import { dllOrdinalMap } from './dll-ordinals';

export function buildThunkTable(emu: Emulator): void {

  const ordinalMap = dllOrdinalMap;

  // DLL name aliases (map old names to canonical names used in API registration)
  const dllAliases: Record<string, string> = {
    // WSOCK32 has its own ordinal mapping above — only alias for API name resolution
    'WSOCK32.DLL': 'WS2_32.DLL',
    'API-MS-WIN-CRT-RUNTIME-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-STDIO-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-STRING-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-MATH-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-HEAP-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-LOCALE-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-CONVERT-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-ENVIRONMENT-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-TIME-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-FILESYSTEM-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-UTILITY-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-MULTIBYTE-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-CONIO-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-PROCESS-L1-1-0.DLL': 'MSVCRT.DLL',
    'UCRTBASE.DLL': 'MSVCRT.DLL',
    'VCRUNTIME140.DLL': 'MSVCRT.DLL',
  };

  // MSVCRT uses cdecl (caller cleans stack), so nArgs=0 is correct for them
  const cdeclDlls = new Set([
    'MSVCRT.DLL', 'MSVCRT20.DLL', 'MSVCRT40.DLL',
    'MSVCR70.DLL', 'MSVCR71.DLL', 'MSVCR80.DLL', 'MSVCR90.DLL',
    'MSVCR100.DLL', 'MSVCR110.DLL', 'MSVCR120.DLL',
    'UCRTBASE.DLL', 'VCRUNTIME140.DLL',
  ]);

  for (const [addr, info] of emu.pe.apiMap) {
    // Resolve ordinal imports to names BEFORE alias renaming (ordinals differ between WSOCK32 and WS2_32)
    const ordMatch = info.name.match(/^ord_(\d+)$/);
    if (ordMatch) {
      const ord = parseInt(ordMatch[1]);
      const nameFromOrd = ordinalMap[info.dll]?.[ord];
      if (nameFromOrd) info.name = nameFromOrd;
    }
    // Normalize DLL name aliases
    info.dll = dllAliases[info.dll] || info.dll;

    const key = `${info.dll}:${info.name}`;
    const def = emu.apiDefs.get(key);
    const stackBytes = def?.stackBytes ?? 0;
    // Suppress warning for DLLs provided as additional files (they'll be resolved by pre-loading)
    const dllBasename = info.dll.toLowerCase();
    const hasExternalDll = [...emu.additionalFiles.keys()].some(f => f.toLowerCase() === dllBasename);
    if (!def && !cdeclDlls.has(info.dll) && !hasExternalDll) {
      console.warn(`[THUNK] No API definition for ${info.dll}:${info.name} — defaulting to stackBytes=0`);
    }
    emu.thunkToApi.set(addr, { dll: info.dll, name: info.name, stackBytes });
  }
}

export function preloadStrings(emu: Emulator): void {
  const strings = extractStrings(emu.peInfo, emu.arrayBuffer);
  // Track which language each string came from; prefer English (0x09) or neutral (0x00)
  const langMap = new Map<number, number>(); // id → languageId
  for (const s of strings) {
    const prevLang = langMap.get(s.id);
    if (prevLang !== undefined) {
      const prevPrimary = prevLang & 0x3FF;
      const curPrimary = (s.languageId || 0) & 0x3FF;
      // Skip if we already have English and this isn't English
      if (prevPrimary === 0x09 && curPrimary !== 0x09) continue;
      // Skip if we already have neutral and this isn't English or neutral
      if (prevPrimary === 0x00 && curPrimary !== 0x09 && curPrimary !== 0x00) continue;
    }
    emu.stringCache.set(s.id, s.string);
    langMap.set(s.id, s.languageId || 0);
  }
}

export function verifyIAT(emu: Emulator): void {
  const base = emu.pe.imageBase;
  const end = base + Math.min(emu.pe.sizeOfImage, 0x2000);
  let unresolved = 0;
  for (let addr = base + 0x1000; addr < end; addr += 2) {
    if (emu.memory.readU8(addr) === 0xFF && emu.memory.readU8(addr + 1) === 0x25) {
      const iatAddr = emu.memory.readU32(addr + 2);
      // Skip false positives where iatAddr is outside the image
      if (iatAddr < base || iatAddr >= base + emu.pe.sizeOfImage) continue;
      const target = emu.memory.readU32(iatAddr);
      if (!emu.thunkToApi.has(target)) {
        console.warn(`[IAT] Unresolved import stub at 0x${addr.toString(16)}: JMP [0x${iatAddr.toString(16)}] → 0x${target.toString(16)} (not a thunk)`);
        unresolved++;
      }
    }
  }
  if (unresolved > 0) {
    console.warn(`[IAT] ${unresolved} unresolved import stubs found!`);
  }
}

/**
 * Initialize a TEB (Thread Environment Block) for a thread.
 * Returns the TEB address. For the main thread, also creates PEB and process params.
 */
export function initThreadTEB(emu: Emulator, stackTop: number, threadId: number, pebAddr?: number): number {
  const tebSize = 0x1000;
  const teb = emu.allocHeap(tebSize);
  const tlsSlots = emu.allocHeap(256 * 4);

  let peb = pebAddr || 0;
  if (!peb) {
    // Main thread: create PEB and process params
    peb = emu.allocHeap(0x100);
    const processParams = emu.allocHeap(0x80);
    const STD_INPUT_HANDLE  = 0xFFFFFFF6;
    const STD_OUTPUT_HANDLE = 0xFFFFFFF5;
    const STD_ERROR_HANDLE  = 0xFFFFFFF4;
    emu.memory.writeU32(processParams + 0x18, STD_INPUT_HANDLE);
    emu.memory.writeU32(processParams + 0x1C, STD_OUTPUT_HANDLE);
    emu.memory.writeU32(processParams + 0x20, STD_ERROR_HANDLE);
    emu.memory.writeU32(peb + 0x08, emu.pe.imageBase);
    emu.memory.writeU32(peb + 0x0C, 0);
    emu.memory.writeU32(peb + 0x10, processParams);
  }

  emu.memory.writeU32(teb + 0x00, 0xFFFFFFFF); // SEH chain head
  emu.memory.writeU32(teb + 0x04, stackTop);
  emu.memory.writeU32(teb + 0x08, (stackTop - 0x100000) >>> 0);
  emu.memory.writeU32(teb + 0x18, teb); // self pointer
  emu.memory.writeU32(teb + 0x20, threadId);
  emu.memory.writeU32(teb + 0x24, threadId + 4);
  emu.memory.writeU32(teb + 0x2C, tlsSlots);
  emu.memory.writeU32(teb + 0x30, peb);
  emu.memory.writeU32(teb + 0x34, 0);

  console.log(`[EMU] TEB at 0x${teb.toString(16)}, TLS at 0x${tlsSlots.toString(16)}, PEB at 0x${peb.toString(16)}, threadId=${threadId}`);
  return teb;
}

export function initTEB(emu: Emulator): void {
  const teb = initThreadTEB(emu, emu.pe.stackTop, 1000);
  emu.cpu.fsBase = teb;
  console.log(`[EMU] fsBase=0x${teb.toString(16)}`);
}
