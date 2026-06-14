import type { Emulator } from '../../emulator';
import { emuFindResourceEntryForModule } from '../../emu-load';

function findResourceForModule(emu: Emulator, hModule: number, typeId: number | string, nameId: number | string): { dataRva: number; dataSize: number; imageBase: number } | null {
  // Check if hModule points to a loaded DLL
  if (hModule && hModule !== emu.pe.imageBase) {
    for (const [, mod] of emu.loadedModules) {
      if (mod.base === hModule || mod.imageBase === hModule) {
        const result = emuFindResourceEntryForModule(emu, mod.imageBase, mod.resourceRva, typeId, nameId);
        if (result) return { ...result, imageBase: mod.imageBase };
        return null;
      }
    }
  }
  // Default: search main EXE
  const result = emu.findResourceEntry(typeId, nameId);
  if (result) return { ...result, imageBase: emu.pe.imageBase };
  return null;
}

export function registerResource(emu: Emulator): void {
  const kernel32 = emu.registerDll('KERNEL32.DLL');

  // FindResourceA (might be needed indirectly)
  kernel32.register('FindResourceA', 3, () => {
    const hModule = emu.readArg(0);
    const namePtr = emu.readArg(1);
    const typePtr = emu.readArg(2);
    const nameId: number | string = namePtr < 0x10000 ? namePtr : emu.memory.readCString(namePtr);
    const typeId: number | string = typePtr < 0x10000 ? typePtr : emu.memory.readCString(typePtr);
    const result = findResourceForModule(emu, hModule, typeId, nameId);
    console.log(`[RES] FindResourceA type=${typeId} name=${nameId} => ${result ? `RVA=0x${result.dataRva.toString(16)} size=${result.dataSize}` : 'NOT FOUND'}`);
    if (!result) return 0;
    return emu.handles.alloc('resource', { typeId, nameId, dataRva: result.dataRva, dataSize: result.dataSize, imageBase: result.imageBase });
  });

  // FindResourceW - finds a resource in the PE file
  kernel32.register('FindResourceW', 3, () => {
    const hModule = emu.readArg(0);
    const namePtr = emu.readArg(1);
    const typePtr = emu.readArg(2);

    // namePtr and typePtr can be MAKEINTRESOURCE (< 0x10000) or string pointers
    const nameId: number | string = namePtr < 0x10000 ? namePtr : emu.memory.readUTF16String(namePtr);
    const typeId: number | string = typePtr < 0x10000 ? typePtr : emu.memory.readUTF16String(typePtr);

    // Find the resource using PE resource directory
    const result = findResourceForModule(emu, hModule, typeId, nameId);
    if (!result) {
      console.log(`[RES] FindResourceW hModule=0x${hModule.toString(16)} type=${typeId} name=${nameId} => NOT FOUND`);
      return 0;
    }

    // Return a pseudo handle encoding type and name
    const handle = emu.handles.alloc('resource', { typeId, nameId, dataRva: result.dataRva, dataSize: result.dataSize, imageBase: result.imageBase });
    console.log(`[RES] FindResourceW hModule=0x${hModule.toString(16)} type=${typeId} name=${nameId} => handle=0x${handle.toString(16)} RVA=0x${result.dataRva.toString(16)} size=${result.dataSize}`);
    return handle;
  });

  // FindResourceExW
  kernel32.register('FindResourceExW', 4, () => {
    const hModule = emu.readArg(0);
    const typePtr = emu.readArg(1);
    const namePtr = emu.readArg(2);
    // arg3 = wLanguage (ignored)
    const nameId: number | string = namePtr < 0x10000 ? namePtr : emu.memory.readUTF16String(namePtr);
    const typeId: number | string = typePtr < 0x10000 ? typePtr : emu.memory.readUTF16String(typePtr);
    const result = findResourceForModule(emu, hModule, typeId, nameId);
    if (!result) return 0;
    return emu.handles.alloc('resource', { typeId, nameId, dataRva: result.dataRva, dataSize: result.dataSize, imageBase: result.imageBase });
  });

  // LoadResource - returns the same handle (in Win32, this is essentially a no-op)
  kernel32.register('LoadResource', 2, () => {
    const hModule = emu.readArg(0);
    const hResInfo = emu.readArg(1);
    console.log(`[RES] LoadResource hModule=0x${hModule.toString(16)} hResInfo=0x${hResInfo.toString(16)}`);
    return hResInfo; // Return the same handle
  });

  // LockResource - returns a pointer to the resource data in emulated memory
  kernel32.register('LockResource', 1, () => {
    const hResData = emu.readArg(0);
    const res = emu.handles.get<{ typeId: number; nameId: number | string; dataRva: number; dataSize: number; imageBase?: number }>(hResData);
    if (!res) return 0;
    // The resource data is in memory at imageBase + dataRva
    const base = res.imageBase || emu.pe.imageBase;
    const addr = (base + res.dataRva) >>> 0;
    console.log(`[RES] LockResource => 0x${addr.toString(16)} (type=${res.typeId} name=${res.nameId})`);
    return addr;
  });

  // SizeofResource
  kernel32.register('SizeofResource', 2, () => {
    const _hModule = emu.readArg(0);
    const hResInfo = emu.readArg(1);
    const res = emu.handles.get<{ typeId: number; nameId: number | string; dataRva: number; dataSize: number }>(hResInfo);
    return res ? res.dataSize : 0;
  });

  kernel32.register('FreeResource', 1, () => 0);

  // EnumResourceNamesW(hModule, lpType, lpEnumFunc, lParam) → BOOL
  kernel32.register('EnumResourceNamesW', 4, () => 0);
  kernel32.register('EnumResourceNamesA', 4, () => 0);
  // EnumResourceTypesA/W(hModule, lpEnumFunc, lParam) → BOOL
  kernel32.register('EnumResourceTypesA', 3, () => 0);
  kernel32.register('EnumResourceTypesW', 3, () => 0);
  // EnumResourceLanguagesA/W(hModule, lpType, lpName, lpEnumFunc, lParam) → BOOL
  kernel32.register('EnumResourceLanguagesA', 5, () => 0);
  kernel32.register('EnumResourceLanguagesW', 5, () => 0);
}
