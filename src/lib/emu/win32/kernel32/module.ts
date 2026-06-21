import type { Emulator } from '../../emulator';
import { loadPE, parsePEHeader } from '../../pe-loader';
import type { LoadedPE } from '../../pe-loader';
import { parsePE, extractExports } from '../../../pe';

import { buildThunkTable } from '../../emu-thunks-pe';
import { rebuildThunkPages } from '../../emu-load';
import { emuCallDllMain, emuCompleteThunk } from '../../emu-exec';
import type { FileInfo } from '../../file-manager';

// Module-level type no longer needed — exports are stored on emu.loadedDllExports

/**
 * After loading a DLL, check if it imports from other DLLs available in additionalFiles.
 * If so, load those DLLs and patch the parent DLL's IAT to point to real code.
 */
function resolveSubDllImports(emu: Emulator, parentPe: LoadedPE): void {
  // Collect DLLs imported by the parent DLL that we have in additionalFiles
  const importedDlls = new Set<string>();
  for (const info of parentPe.apiMap.values()) {
    importedDlls.add(info.dll);
  }

  for (const dllName of importedDlls) {
    const subLower = dllName.toLowerCase();
    if (emu.loadedModules.has(subLower)) continue;

    let subAb: ArrayBuffer | undefined;
    for (const [fname, data] of emu.additionalFiles) {
      if (fname.toLowerCase() === subLower) { subAb = data; break; }
    }
    if (!subAb) continue;

    try {
      // Detect address conflicts
      const { imageBase: preferred, sizeOfImage: dllSize } = parsePEHeader(subAb);
      const occupiedRanges: { base: number; size: number }[] = [];
      occupiedRanges.push({ base: emu.pe.imageBase, size: emu.pe.sizeOfImage });
      for (const [, mod] of emu.loadedModules) {
        occupiedRanges.push({ base: mod.base, size: mod.sizeOfImage ?? 0x100000 });
      }
      let actualBase = preferred;
      for (const r of occupiedRanges) {
        if (actualBase < r.base + r.size && actualBase + dllSize > r.base) {
          actualBase = ((r.base + r.size + 0xFFFF) & ~0xFFFF) >>> 0;
        }
      }
      const baseOverride = actualBase !== preferred ? actualBase : undefined;

      const subPe = loadPE(subAb, emu.memory, baseOverride);
      const subPeInfo = parsePE(subAb);
      const subExportResult = extractExports(subPeInfo, subAb);
      const subExportFuncs = subExportResult?.functions ?? [];

      // Build thunks for the sub-DLL's own imports
      const savedPe = emu.pe;
      emu.pe = subPe;
      buildThunkTable(emu);
      emu.pe = savedPe;
      rebuildThunkPages(emu);

      const exportByName = new Map<string, number>();
      const exportByOrd = new Map<number, number>();
      for (const fn of subExportFuncs) {
        if (fn.forwardedTo) continue;
        if (fn.name) exportByName.set(fn.name, subPe.imageBase + fn.rva);
        exportByOrd.set(fn.ordinal, subPe.imageBase + fn.rva);
      }

      emu.loadedDllExports.set(subLower, { base: subPe.imageBase, exports: subExportFuncs });
      emu.loadedModules.set(subLower, { base: subPe.imageBase, resourceRva: subPe.resourceRva, imageBase: subPe.imageBase, sizeOfImage: subPe.sizeOfImage });

      // Patch parent DLL's IAT: resolve thunks for this sub-DLL
      const parentBase = parentPe.imageBase;
      const parentEnd = parentBase + Math.min(parentPe.sizeOfImage, 0x100000);
      for (const [thunkAddr, info] of emu.thunkToApi) {
        if (info.dll !== dllName) continue;
        let realAddr = exportByName.get(info.name);
        if (!realAddr) {
          const ordMatch = info.name.match(/^ord_(\d+)$/);
          if (ordMatch) realAddr = exportByOrd.get(parseInt(ordMatch[1]));
        }
        if (realAddr) {
          for (let addr = parentBase; addr < parentEnd; addr += 4) {
            if (emu.memory.readU32(addr) === thunkAddr) {
              emu.memory.writeU32(addr, realAddr);
            }
          }
          emu.thunkToApi.delete(thunkAddr);
          console.log(`[DLL] Resolved ${dllName}:${info.name} → 0x${realAddr.toString(16)}`);
        }
      }

      console.log(`[DLL] Sub-loaded ${dllName} at 0x${subPe.imageBase.toString(16)}, ${subExportFuncs.length} exports`);

      // Recurse for the sub-DLL's own dependencies
      resolveSubDllImports(emu, subPe);

      // Call DllMain(DLL_PROCESS_ATTACH) for the sub-DLL
      if (subPe.entryPoint && subPe.entryPoint !== subPe.imageBase) {
        emuCallDllMain(emu, subPe.entryPoint, subPe.imageBase);
      }
    } catch (e: unknown) {
      console.warn(`[DLL] Failed to sub-load ${dllName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// DLLs that provide built-in window classes and need no real binary
const builtinDlls = new Set(['riched20.dll', 'riched32.dll', 'msftedit.dll']);

function hasRegisteredApis(emu: Emulator, dllName: string): boolean {
  if (builtinDlls.has(dllName.toLowerCase())) return true;
  const prefix = dllName.toUpperCase() + ':';
  for (const key of emu.apiDefs.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/** Result of PATH search: either sync data or a pending async fetch. */
interface PathSearchPending {
  pending: true;
  fileInfo: FileInfo;
  fullPath: string;
  dir: string;
}
type PathSearchResult = ArrayBuffer | PathSearchPending | undefined;

/**
 * Search for a DLL in PATH directories via the FileManager.
 * Returns ArrayBuffer (sync), PathSearchPending (needs async fetch), or undefined (not found).
 */
function findDllInPath(emu: Emulator, basename: string): PathSearchResult {
  const pathEnv = emu.envVars.get('PATH') ?? '';
  if (!pathEnv) return undefined;
  const fs = emu.fs;
  const dirs = pathEnv.split(';');
  for (const dir of dirs) {
    if (!dir) continue;
    const sep = dir.endsWith('\\') ? '' : '\\';
    const fullPath = dir + sep + basename;
    const fileInfo = fs.findFile(fullPath, emu.additionalFiles);
    if (!fileInfo) continue;
    // Try to get data synchronously
    if (fileInfo.source === 'additional') {
      const data = emu.additionalFiles.get(fileInfo.name);
      if (data) {
        console.log(`[LoadLibrary] Found "${basename}" in PATH dir ${dir}`);
        return data;
      }
    } else if (fileInfo.source === 'external') {
      const ext = fs.externalFiles.get(fullPath.toUpperCase());
      if (ext) {
        console.log(`[LoadLibrary] Found "${basename}" in PATH dir ${dir}`);
        return ext.data.buffer.slice(ext.data.byteOffset, ext.data.byteOffset + ext.data.byteLength) as ArrayBuffer;
      }
    } else if (fileInfo.source === 'virtual') {
      // Check in-memory cache first
      const dfm = fs as { virtualFileCache?: Map<string, ArrayBuffer> };
      if (dfm.virtualFileCache) {
        const cached = dfm.virtualFileCache.get(fileInfo.name.toUpperCase());
        if (cached) {
          console.log(`[LoadLibrary] Found "${basename}" in PATH dir ${dir} (cached)`);
          return cached;
        }
      }
      // Not cached — return pending so caller can fetch async from IndexedDB
      console.log(`[LoadLibrary] Found "${basename}" in PATH dir ${dir} (async fetch needed)`);
      return { pending: true, fileInfo, fullPath, dir };
    }
  }
  return undefined;
}

/** Load a DLL PE buffer into the emulator. Returns the base address. */
function loadDllFromBuffer(emu: Emulator, ab: ArrayBuffer, rawName: string, basename: string): number {
  // Detect address conflicts before loading
  const { imageBase: preferred, sizeOfImage: dllSize } = parsePEHeader(ab);
  const occupiedRanges: { base: number; size: number }[] = [];
  occupiedRanges.push({ base: emu.pe.imageBase, size: emu.pe.sizeOfImage });
  for (const [, mod] of emu.loadedModules) {
    occupiedRanges.push({ base: mod.base, size: mod.sizeOfImage ?? 0x100000 });
  }
  let actualBase = preferred;
  for (const r of occupiedRanges) {
    if (actualBase < r.base + r.size && actualBase + dllSize > r.base) {
      actualBase = ((r.base + r.size + 0xFFFF) & ~0xFFFF) >>> 0;
    }
  }
  const baseOverride = actualBase !== preferred ? actualBase : undefined;

  // Load DLL PE into emulator memory
  const pe = loadPE(ab, emu.memory, baseOverride);

  // Build thunks for the DLL's own imports (it imports from kernel32, user32, etc.)
  const savedPe = emu.pe;
  emu.pe = pe;
  buildThunkTable(emu);
  emu.pe = savedPe;
  rebuildThunkPages(emu);

  // Extract export table
  const peInfo = parsePE(ab);
  const exportResult = extractExports(peInfo, ab);
  const exportFuncs = exportResult?.functions ?? [];

  emu.loadedDllExports.set(basename, { base: pe.imageBase, exports: exportFuncs });
  emu.loadedModules.set(basename, { base: pe.imageBase, resourceRva: pe.resourceRva, imageBase: pe.imageBase, sizeOfImage: pe.sizeOfImage });

  console.log(`[LoadLibrary] Loaded "${rawName}" at 0x${pe.imageBase.toString(16)}, ${exportFuncs.length} exports`);

  // Resolve transitive dependencies
  if (emu.additionalFiles.size > 0) {
    resolveSubDllImports(emu, pe);
  }

  // Call DllMain(DLL_PROCESS_ATTACH)
  if (pe.entryPoint && pe.entryPoint !== pe.imageBase) {
    emuCallDllMain(emu, pe.entryPoint, pe.imageBase);
  }

  return pe.imageBase;
}

function loadDll(emu: Emulator, rawName: string): number | undefined {
  // Normalize: strip path, lowercase, ensure .dll extension
  let basename = rawName.replace(/^.*[\\/]/, '').toLowerCase();
  if (!basename.includes('.')) basename += '.dll';
  const existing = emu.loadedModules.get(basename);
  if (existing) return existing.base;

  // Ring3 kernel: load real DLLs (from additionalFiles) into the process address
  // space and run DllMain via the kernel, not the own-backend loadDllFromBuffer
  // (which steps cpu.step — absent here). System DLLs we only stub get a non-zero
  // handle so GetProcAddress (which mints int 0x2E thunks) still works.
  if (emu._kernelLoadLibrary) {
    const base = emu._kernelLoadLibrary(rawName);
    if (base) return base;
    if (hasRegisteredApis(emu, basename)) return emu.pe.imageBase;
    if (!emu.missingDlls.includes(basename)) {
      emu.missingDlls.push(basename);
      console.warn(`[LoadLibrary] Missing DLL: ${basename}`);
      emu.onMissingDll?.(basename);
    }
    return 0;
  }

  // Find in additionalFiles (case-insensitive, strip path prefixes from keys)
  let ab: ArrayBuffer | undefined;
  for (const [fname, data] of emu.additionalFiles) {
    const key = fname.replace(/.*[/\\]/, '').toLowerCase();
    if (key === basename) { ab = data; break; }
  }

  // If not in additionalFiles, search PATH directories via FileManager
  if (!ab) {
    const pathResult = findDllInPath(emu, basename);
    if (pathResult && 'pending' in (pathResult as object)) {
      // Async path: file is in IndexedDB, needs async fetch
      const info = pathResult as PathSearchPending;
      const stackBytes = emu._currentThunkStackBytes;
      emu.waitingForMessage = true;
      const capturedRawName = rawName;
      const capturedBasename = basename;
      emu.fs.fetchFileData(info.fileInfo, emu.additionalFiles, info.fullPath).then(buf => {
        emu.waitingForMessage = false;
        if (buf) {
          // Cache for future lookups
          const dfm = emu.fs as { virtualFileCache?: Map<string, ArrayBuffer> };
          dfm.virtualFileCache?.set(info.fileInfo.name.toUpperCase(), buf);
          try {
            const base = loadDllFromBuffer(emu, buf, capturedRawName, capturedBasename);
            emuCompleteThunk(emu, base, stackBytes);
          } catch (e: unknown) {
            console.log(`[LoadLibrary] Failed to load "${capturedRawName}": ${e instanceof Error ? e.message : String(e)}`);
            emuCompleteThunk(emu, 0, stackBytes);
          }
        } else {
          emuCompleteThunk(emu, 0, stackBytes);
        }
        if (emu.running && !emu.halted) {
          requestAnimationFrame(emu.tick);
        }
      });
      return undefined; // signals async in progress
    }
    ab = pathResult as ArrayBuffer | undefined;
  }

  if (!ab) {
    if (!hasRegisteredApis(emu, basename)) {
      // Truly missing DLL — notify user
      if (!emu.missingDlls.includes(basename)) {
        emu.missingDlls.push(basename);
        console.warn(`[LoadLibrary] Missing DLL: ${basename}`);
        emu.onMissingDll?.(basename);
      }
      return 0;
    }
    // Known system DLL with JS stubs — return imageBase so GetProcAddress works
    return emu.pe.imageBase;
  }

  try {
    return loadDllFromBuffer(emu, ab, rawName, basename);
  } catch (e: unknown) {
    console.log(`[LoadLibrary] Failed to load "${rawName}": ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

function findExport(emu: Emulator, hModule: number, funcName: string, ordinal: number): number {
  for (const [, m] of emu.loadedDllExports) {
    if (m.base !== hModule) continue;
    for (const fn of m.exports) {
      if (fn.forwardedTo) continue;
      if (ordinal >= 0 && fn.ordinal === ordinal) return m.base + fn.rva;
      if (fn.name === funcName) return m.base + fn.rva;
    }
    break;
  }
  return 0;
}

export function registerModule(emu: Emulator): void {
  const kernel32 = emu.registerDll('KERNEL32.DLL');

  kernel32.register('GetModuleHandleA', 1, () => {
    const namePtr = emu.readArg(0);
    if (namePtr === 0) return emu.pe.imageBase;
    const name = emu.memory.readCString(namePtr).replace(/^.*[\\/]/, '').toLowerCase();
    const mod = emu.loadedModules.get(name);
    return mod ? mod.base : emu.pe.imageBase;
  });

  kernel32.register('GetModuleHandleW', 1, () => {
    const namePtr = emu.readArg(0);
    if (namePtr === 0) return emu.pe.imageBase;
    const name = emu.memory.readUTF16String(namePtr).replace(/^.*[\\/]/, '').toLowerCase();
    const mod = emu.loadedModules.get(name);
    return mod ? mod.base : emu.pe.imageBase;
  });

  function getModuleFileName(hModule: number): string {
    // hModule 0 or matching imageBase = this exe
    if (hModule === 0 || hModule === emu.pe.imageBase) {
      return emu.exePath;
    }
    // Loaded DLL module — find by base address
    for (const [dllName, mod] of emu.loadedModules) {
      if (mod.base === hModule) {
        return 'C:\\WINDOWS\\SYSTEM32\\' + dllName.toUpperCase();
      }
    }
    return 'C:\\WINDOWS\\SYSTEM32\\UNKNOWN.DLL';
  }

  kernel32.register('GetModuleFileNameA', 3, () => {
    const hModule = emu.readArg(0);
    const buf = emu.readArg(1);
    const size = emu.readArg(2);
    const name = getModuleFileName(hModule);
    if (buf && size > 0) emu.memory.writeCString(buf, name.substring(0, size - 1));
    return name.length;
  });

  kernel32.register('GetModuleFileNameW', 3, () => {
    const hModule = emu.readArg(0);
    const buf = emu.readArg(1);
    const size = emu.readArg(2);
    const name = getModuleFileName(hModule);
    if (buf && size > 0) emu.memory.writeUTF16String(buf, name.substring(0, size - 1));
    return name.length;
  });

  kernel32.register('GetProcAddress', 2, () => {
    const hModule = emu.readArg(0);
    const nameOrOrd = emu.readArg(1);

    let funcName: string;
    let ordinal = -1;
    if (nameOrOrd < 0x10000) {
      ordinal = nameOrOrd;
      funcName = `ord_${nameOrOrd}`;
    } else {
      funcName = emu.memory.readCString(nameOrOrd);
    }

    // Check loaded DLL exports first — returns real code address
    const exportAddr = findExport(emu, hModule, funcName, ordinal);
    if (exportAddr) {
      console.log(`[GetProcAddress] ${funcName} → 0x${exportAddr.toString(16)} (DLL code)`);
      return exportAddr;
    }

    // Ring3 kernel: mint a trappable `int 0x2E` thunk for any registered apiDef.
    // (The own-backend thunkToApi/dynamicThunkPtr path below doesn't trap under
    // v86, so it would hand back an address that faults when called.) Returns 0
    // for unimplemented APIs so the caller's GetProcAddress-fallback path runs.
    if (emu._kernelGetProcThunk) {
      // Best-effort DLL name from the module handle (its base address); '' lets
      // the hook match the function name across any registered DLL.
      let dllName = '';
      for (const [n, m] of emu.loadedModules) {
        if (m.base === hModule || m.imageBase === hModule) { dllName = n; break; }
      }
      return emu._kernelGetProcThunk(dllName, funcName);
    }

    // Check if the function is already known in the thunk table
    for (const [addr, info] of emu.thunkToApi) {
      if (info.name === funcName) return addr;
    }

    // Check if there's an API handler registered for any DLL
    for (const key of emu.apiDefs.keys()) {
      const colonIdx = key.indexOf(':');
      if (colonIdx >= 0 && key.slice(colonIdx + 1) === funcName) {
        const dll = key.slice(0, colonIdx);
        // Try existing thunk first
        for (const [addr, info] of emu.thunkToApi) {
          if (info.dll === dll && info.name === funcName) return addr;
        }
        // Create a dynamic thunk for this API
        if (emu.dynamicThunkPtr) {
          const thunkAddr = emu.dynamicThunkPtr;
          emu.dynamicThunkPtr += 4;
          const def = emu.apiDefs.get(key);
          const stackBytes = def?.stackBytes ?? 0;
          emu.thunkToApi.set(thunkAddr, { dll, name: funcName, stackBytes });
          emu.thunkPages.add(thunkAddr >>> 12);
          console.log(`[GetProcAddress] Created dynamic thunk for ${dll}:${funcName} at 0x${thunkAddr.toString(16)} stackBytes=${stackBytes}`);
          return thunkAddr;
        }
      }
    }

    if (!emu._gpaNotFound) emu._gpaNotFound = new Set();
    if (!emu._gpaNotFound.has(funcName)) {
      emu._gpaNotFound.add(funcName);
      console.log(`[GetProcAddress] Not found: "${funcName}"`);
    }
    return 0;
  });

  kernel32.register('LoadLibraryA', 1, () => {
    const namePtr = emu.readArg(0);
    const name = namePtr ? emu.memory.readCString(namePtr) : '';
    if (!name) return emu.pe.imageBase;
    return loadDll(emu, name);
  });

  kernel32.register('LoadLibraryW', 1, () => {
    const namePtr = emu.readArg(0);
    const name = namePtr ? emu.memory.readUTF16String(namePtr) : '';
    if (!name) return emu.pe.imageBase;
    return loadDll(emu, name);
  });

  kernel32.register('LoadLibraryExA', 3, () => {
    const namePtr = emu.readArg(0);
    const name = namePtr ? emu.memory.readCString(namePtr) : '';
    if (!name) return emu.pe.imageBase;
    return loadDll(emu, name);
  });

  kernel32.register('LoadLibraryExW', 3, () => {
    const namePtr = emu.readArg(0);
    // arg1 = reserved, arg2 = dwFlags
    const name = namePtr ? emu.memory.readUTF16String(namePtr) : '';
    if (!name) return emu.pe.imageBase;
    return loadDll(emu, name);
  });

  kernel32.register('GetModuleHandleExW', 3, () => {
    const dwFlags = emu.readArg(0);
    const namePtr = emu.readArg(1);
    const phModule = emu.readArg(2);
    let hModule: number;
    if (namePtr === 0 || (dwFlags & 4)) {
      // GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS or NULL name
      hModule = emu.pe.imageBase;
    } else {
      const name = emu.memory.readUTF16String(namePtr).replace(/^.*[\\/]/, '').toLowerCase();
      const mod = emu.loadedModules.get(name);
      hModule = mod ? mod.base : emu.pe.imageBase;
    }
    if (phModule) emu.memory.writeU32(phModule, hModule);
    return 1;
  });

  kernel32.register('FreeLibrary', 1, () => 1);

  kernel32.register('InitializeSListHead', 1, () => {
    const listHead = emu.readArg(0);
    if (listHead) {
      emu.memory.writeU32(listHead, 0);
      emu.memory.writeU32(listHead + 4, 0);
    }
    return 0;
  });
}
