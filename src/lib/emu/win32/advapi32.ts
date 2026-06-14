import type { Emulator } from '../emulator';
import { ERROR_SUCCESS, ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_NO_MORE_ITEMS } from './types';

export function registerAdvapi32(emu: Emulator): void {
  const advapi32 = emu.registerDll('ADVAPI32.DLL');

  const hkeyName = (h: number): string => {
    switch (h >>> 0) {
      case 0x80000000: return 'HKEY_CLASSES_ROOT';
      case 0x80000001: return 'HKEY_CURRENT_USER';
      case 0x80000002: return 'HKEY_LOCAL_MACHINE';
      case 0x80000003: return 'HKEY_USERS';
      case 0x80000005: return 'HKEY_CURRENT_CONFIG';
      case 0x80000006: return 'HKEY_DYN_DATA';
      default: return `0x${h.toString(16)}`;
    }
  };

  const store = () => emu.registryStore;

  const REG_TYPE_NAMES: Record<number, string> = { 0: 'REG_NONE', 1: 'REG_SZ', 2: 'REG_EXPAND_SZ', 3: 'REG_BINARY', 4: 'REG_DWORD', 7: 'REG_MULTI_SZ' };
  const fmtType = (t: number) => REG_TYPE_NAMES[t] || `type=${t}`;
  const fmtData = (type: number, data: Uint8Array): string => {
    if (type === 4 && data.length >= 4) return `0x${(data[0] | (data[1] << 8) | (data[2] << 16) | ((data[3] << 24) >>> 0)).toString(16)}`;
    if ((type === 1 || type === 2) && data.length > 0) {
      let s = '';
      for (let i = 0; i < data.length - 1; i++) s += String.fromCharCode(data[i]);
      return `"${s}"`;
    }
    if (data.length <= 16) return `[${Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ')}]`;
    return `[${data.length} bytes]`;
  };

  // --- RegCreateKeyExA ---
  advapi32.register('RegCreateKeyExA', 9, () => {
    const hKey = emu.readArg(0);
    const subKeyPtr = emu.readArg(1);
    const subKey = subKeyPtr ? emu.memory.readCString(subKeyPtr) : '';
    const resultPtr = emu.readArg(7);
    const dispositionPtr = emu.readArg(8);
    const s = store();
    if (s) {
      const r = s.createKey(hKey, subKey);
      if (r) {
        if (resultPtr) emu.memory.writeU32(resultPtr, r.handle);
        if (dispositionPtr) emu.memory.writeU32(dispositionPtr, r.disposition);
        console.log(`[REG] RegCreateKeyExA(${hkeyName(hKey)}, "${subKey}") => 0x${r.handle.toString(16)}`);
        return ERROR_SUCCESS;
      }
    }
    if (resultPtr) emu.memory.writeU32(resultPtr, 0x2000);
    console.log(`[REG] RegCreateKeyExA(${hkeyName(hKey)}, "${subKey}") => stub 0x2000`);
    return ERROR_SUCCESS;
  });

  advapi32.register('RegCreateKeyA', 3, () => {
    const hKey = emu.readArg(0);
    const subKeyPtr = emu.readArg(1);
    const subKey = subKeyPtr ? emu.memory.readCString(subKeyPtr) : '';
    const resultPtr = emu.readArg(2);
    const s = store();
    if (s) {
      const r = s.createKey(hKey, subKey);
      if (r) {
        if (resultPtr) emu.memory.writeU32(resultPtr, r.handle);
        return ERROR_SUCCESS;
      }
    }
    if (resultPtr) emu.memory.writeU32(resultPtr, 0x2000);
    return ERROR_SUCCESS;
  });

  advapi32.register('RegOpenKeyExA', 5, () => {
    const hKey = emu.readArg(0);
    const subKeyPtr = emu.readArg(1);
    const subKey = subKeyPtr ? emu.memory.readCString(subKeyPtr) : '';
    const resultPtr = emu.readArg(4);
    const s = store();
    if (s) {
      let h = s.openKey(hKey, subKey);
      if (h === null) {
        // Auto-create missing keys so programs that probe the registry don't abort
        const r = s.createKey(hKey, subKey);
        h = r ? r.handle : null;
      }
      if (h !== null) {
        if (resultPtr) emu.memory.writeU32(resultPtr, h);
        return ERROR_SUCCESS;
      }
      return ERROR_FILE_NOT_FOUND;
    }
    if (resultPtr) emu.memory.writeU32(resultPtr, 0x2000);
    return ERROR_SUCCESS;
  });

  advapi32.register('RegOpenKeyA', 3, () => {
    const hKey = emu.readArg(0);
    const subKeyPtr = emu.readArg(1);
    const subKey = subKeyPtr ? emu.memory.readCString(subKeyPtr) : '';
    const resultPtr = emu.readArg(2);
    const s = store();
    if (s) {
      let h = s.openKey(hKey, subKey);
      if (h === null) {
        const r = s.createKey(hKey, subKey);
        h = r ? r.handle : null;
      }
      if (h !== null) {
        if (resultPtr) emu.memory.writeU32(resultPtr, h);
        return ERROR_SUCCESS;
      }
      return ERROR_FILE_NOT_FOUND;
    }
    if (resultPtr) emu.memory.writeU32(resultPtr, 0x2000);
    return ERROR_SUCCESS;
  });

  // Default DWORD values returned when no registry store is available
  const REG_DWORD = 4;
  const DEFAULT_DWORD_VALUES: Record<string, number> = {
    'enableextensions': 1,
    'delayedexpansion': 0,
    // Jazz Jackrabbit 2 defaults
    'last videomode': 0,       // first mode (640x480x8)
    'free scale': 0,
    'music active': 1,
    'music volume': 100,
    'sound fx active': 1,
    'sound fx volume': 100,
    'sound mixing rate': 22050,
    'sound mixing options': 0,
    'spy': 0,
  };

  function queryRegDefault(valueName: string, typePtr: number, dataPtr: number, cbDataPtr: number): number {
    const key = valueName.toLowerCase();
    if (key in DEFAULT_DWORD_VALUES) {
      if (typePtr) emu.memory.writeU32(typePtr, REG_DWORD);
      if (cbDataPtr) {
        const bufSize = emu.memory.readU32(cbDataPtr);
        emu.memory.writeU32(cbDataPtr, 4);
        if (dataPtr && bufSize >= 4) {
          emu.memory.writeU32(dataPtr, DEFAULT_DWORD_VALUES[key]);
        } else if (dataPtr) {
          return ERROR_MORE_DATA;
        }
      }
      return ERROR_SUCCESS;
    }
    return ERROR_FILE_NOT_FOUND;
  }

  // --- RegQueryValueExA ---
  advapi32.register('RegQueryValueExA', 6, () => {
    const hKey = emu.readArg(0);
    const valueNamePtr = emu.readArg(1);
    const valueName = valueNamePtr ? emu.memory.readCString(valueNamePtr) : '';
    const typePtr = emu.readArg(3);
    const dataPtr = emu.readArg(4);
    const cbDataPtr = emu.readArg(5);
    const s = store();
    if (s) {
      const val = s.queryValue(hKey, valueName);
      if (!val) {
        console.log(`[REG] RegQueryValueExA(${hkeyName(hKey)}, "${valueName}") => NOT_FOUND`);
        return ERROR_FILE_NOT_FOUND;
      }
      if (typePtr) emu.memory.writeU32(typePtr, val.type);
      const needed = val.data.length;
      if (cbDataPtr) {
        const bufSize = emu.memory.readU32(cbDataPtr);
        emu.memory.writeU32(cbDataPtr, needed);
        if (dataPtr) {
          if (bufSize < needed) {
            console.log(`[REG] RegQueryValueExA(${hkeyName(hKey)}, "${valueName}") => MORE_DATA (need ${needed}, have ${bufSize})`);
            return ERROR_MORE_DATA;
          }
          for (let i = 0; i < needed; i++) emu.memory.writeU8(dataPtr + i, val.data[i]);
        }
      }
      console.log(`[REG] RegQueryValueExA(${hkeyName(hKey)}, "${valueName}") => ${fmtType(val.type)} ${fmtData(val.type, val.data)}`);
      return ERROR_SUCCESS;
    }
    const result = queryRegDefault(valueName, typePtr, dataPtr, cbDataPtr);
    if (result !== ERROR_SUCCESS) {
      console.log(`[REG] RegQueryValueExA(0x${hKey.toString(16)}, "${valueName}") => NOT_FOUND (no store)`);
    }
    return result;
  });

  advapi32.register('RegQueryValueA', 4, () => {
    const hKey = emu.readArg(0);
    const subKeyPtr = emu.readArg(1);
    const subKey = subKeyPtr ? emu.memory.readCString(subKeyPtr) : '';
    const dataPtr = emu.readArg(2);
    const cbDataPtr = emu.readArg(3);
    const s = store();
    if (s) {
      // RegQueryValueA opens subkey then queries default value
      let queryHandle = hKey;
      if (subKey) {
        const h = s.openKey(hKey, subKey);
        if (h === null) return ERROR_FILE_NOT_FOUND;
        queryHandle = h;
      }
      const val = s.queryValue(queryHandle, '');
      if (subKey && queryHandle !== hKey) s.closeKey(queryHandle);
      if (!val) {
        console.log(`[REG] RegQueryValueA(${hkeyName(hKey)}, "${subKey}") => NOT_FOUND`);
        return ERROR_FILE_NOT_FOUND;
      }
      const needed = val.data.length;
      if (cbDataPtr) {
        const bufSize = emu.memory.readU32(cbDataPtr);
        emu.memory.writeU32(cbDataPtr, needed);
        if (dataPtr) {
          if (bufSize < needed) return ERROR_MORE_DATA;
          for (let i = 0; i < needed; i++) emu.memory.writeU8(dataPtr + i, val.data[i]);
        }
      }
      console.log(`[REG] RegQueryValueA(${hkeyName(hKey)}, "${subKey}") => ${fmtType(val.type)} ${fmtData(val.type, val.data)}`);
      return ERROR_SUCCESS;
    }
    return ERROR_FILE_NOT_FOUND;
  });

  advapi32.register('RegQueryValueW', 4, () => {
    const hKey = emu.readArg(0);
    const subKeyPtr = emu.readArg(1);
    const subKey = subKeyPtr ? emu.memory.readUTF16String(subKeyPtr) : '';
    const dataPtr = emu.readArg(2);
    const cbDataPtr = emu.readArg(3);
    const s = store();
    if (s) {
      let queryHandle = hKey;
      if (subKey) {
        const h = s.openKey(hKey, subKey);
        if (h === null) return ERROR_FILE_NOT_FOUND;
        queryHandle = h;
      }
      const val = s.queryValue(queryHandle, '');
      if (subKey && queryHandle !== hKey) s.closeKey(queryHandle);
      if (!val) {
        console.log(`[REG] RegQueryValueW(${hkeyName(hKey)}, "${subKey}") => NOT_FOUND`);
        return ERROR_FILE_NOT_FOUND;
      }
      const needed = val.data.length;
      if (cbDataPtr) {
        const bufSize = emu.memory.readU32(cbDataPtr);
        emu.memory.writeU32(cbDataPtr, needed);
        if (dataPtr) {
          if (bufSize < needed) return ERROR_MORE_DATA;
          for (let i = 0; i < needed; i++) emu.memory.writeU8(dataPtr + i, val.data[i]);
        }
      }
      console.log(`[REG] RegQueryValueW(${hkeyName(hKey)}, "${subKey}") => ${fmtType(val.type)} ${fmtData(val.type, val.data)}`);
      return ERROR_SUCCESS;
    }
    return ERROR_FILE_NOT_FOUND;
  });

  advapi32.register('RegQueryValueExW', 6, () => {
    const hKey = emu.readArg(0);
    const valueNamePtr = emu.readArg(1);
    const valueName = valueNamePtr ? emu.memory.readUTF16String(valueNamePtr) : '';
    const typePtr = emu.readArg(3);
    const dataPtr = emu.readArg(4);
    const cbDataPtr = emu.readArg(5);
    const s = store();
    if (s) {
      const val = s.queryValue(hKey, valueName);
      if (!val) {
        console.log(`[REG] RegQueryValueExW(${hkeyName(hKey)}, "${valueName}") => NOT_FOUND`);
        return ERROR_FILE_NOT_FOUND;
      }
      if (typePtr) emu.memory.writeU32(typePtr, val.type);
      const needed = val.data.length;
      if (cbDataPtr) {
        const bufSize = emu.memory.readU32(cbDataPtr);
        emu.memory.writeU32(cbDataPtr, needed);
        if (dataPtr) {
          if (bufSize < needed) {
            console.log(`[REG] RegQueryValueExW(${hkeyName(hKey)}, "${valueName}") => MORE_DATA (need ${needed}, have ${bufSize})`);
            return ERROR_MORE_DATA;
          }
          for (let i = 0; i < needed; i++) emu.memory.writeU8(dataPtr + i, val.data[i]);
        }
      }
      console.log(`[REG] RegQueryValueExW(${hkeyName(hKey)}, "${valueName}") => ${fmtType(val.type)} ${fmtData(val.type, val.data)}`);
      return ERROR_SUCCESS;
    }
    return queryRegDefault(valueName, typePtr, dataPtr, cbDataPtr);
  });

  // --- RegOpenKey W variants ---
  advapi32.register('RegOpenKeyW', 3, () => {
    const hKey = emu.readArg(0);
    const subKeyPtr = emu.readArg(1);
    const subKey = subKeyPtr ? emu.memory.readUTF16String(subKeyPtr) : '';
    const resultPtr = emu.readArg(2);
    const s = store();
    if (s) {
      let h = s.openKey(hKey, subKey);
      if (h === null) {
        const r = s.createKey(hKey, subKey);
        h = r ? r.handle : null;
      }
      if (h !== null) {
        if (resultPtr) emu.memory.writeU32(resultPtr, h);
        return ERROR_SUCCESS;
      }
      return ERROR_FILE_NOT_FOUND;
    }
    if (resultPtr) emu.memory.writeU32(resultPtr, 0x2000);
    return ERROR_SUCCESS;
  });

  advapi32.register('RegOpenKeyExW', 5, () => {
    const hKey = emu.readArg(0);
    const subKeyPtr = emu.readArg(1);
    const subKey = subKeyPtr ? emu.memory.readUTF16String(subKeyPtr) : '';
    const resultPtr = emu.readArg(4);
    const s = store();
    if (s) {
      let h = s.openKey(hKey, subKey);
      if (h === null) {
        const r = s.createKey(hKey, subKey);
        h = r ? r.handle : null;
      }
      if (h !== null) {
        if (resultPtr) emu.memory.writeU32(resultPtr, h);
        return ERROR_SUCCESS;
      }
      return ERROR_FILE_NOT_FOUND;
    }
    if (resultPtr) emu.memory.writeU32(resultPtr, 0x2000);
    return ERROR_SUCCESS;
  });

  // --- RegSetValue ---
  advapi32.register('RegSetValueExA', 6, () => {
    const hKey = emu.readArg(0);
    const valueNamePtr = emu.readArg(1);
    const valueName = valueNamePtr ? emu.memory.readCString(valueNamePtr) : '';
    const type = emu.readArg(3);
    const dataPtr = emu.readArg(4);
    const cbData = emu.readArg(5);
    const s = store();
    if (s && dataPtr) {
      const data = new Uint8Array(cbData);
      for (let i = 0; i < cbData; i++) data[i] = emu.memory.readU8(dataPtr + i);
      s.setValue(hKey, valueName, type, data);
      console.log(`[REG] RegSetValueExA(${hkeyName(hKey)}, "${valueName}", ${fmtType(type)}, ${fmtData(type, data)})`);
    }
    return ERROR_SUCCESS;
  });

  advapi32.register('RegSetValueA', 5, () => {
    const hKey = emu.readArg(0);
    const subKeyPtr = emu.readArg(1);
    const subKey = subKeyPtr ? emu.memory.readCString(subKeyPtr) : '';
    const type = emu.readArg(2);
    const dataPtr = emu.readArg(3);
    const cbData = emu.readArg(4);
    const s = store();
    if (s) {
      // RegSetValueA creates/opens subkey, then sets default value
      const r = s.createKey(hKey, subKey);
      if (r && dataPtr) {
        const data = new Uint8Array(cbData);
        for (let i = 0; i < cbData; i++) data[i] = emu.memory.readU8(dataPtr + i);
        s.setValue(r.handle, '', type, data);
        s.closeKey(r.handle);
        console.log(`[REG] RegSetValueA(${hkeyName(hKey)}, "${subKey}", ${fmtType(type)}, ${fmtData(type, data)})`);
      }
    }
    return ERROR_SUCCESS;
  });

  advapi32.register('RegSetValueW', 5, () => {
    const hKey = emu.readArg(0);
    const subKeyPtr = emu.readArg(1);
    const subKey = subKeyPtr ? emu.memory.readUTF16String(subKeyPtr) : '';
    const type = emu.readArg(2);
    const dataPtr = emu.readArg(3);
    const cbData = emu.readArg(4);
    const s = store();
    if (s) {
      const r = s.createKey(hKey, subKey);
      if (r && dataPtr) {
        const data = new Uint8Array(cbData);
        for (let i = 0; i < cbData; i++) data[i] = emu.memory.readU8(dataPtr + i);
        s.setValue(r.handle, '', type, data);
        s.closeKey(r.handle);
        console.log(`[REG] RegSetValueW(${hkeyName(hKey)}, "${subKey}", ${fmtType(type)}, ${fmtData(type, data)})`);
      }
    }
    return ERROR_SUCCESS;
  });

  advapi32.register('RegSetValueExW', 6, () => {
    const hKey = emu.readArg(0);
    const valueNamePtr = emu.readArg(1);
    const valueName = valueNamePtr ? emu.memory.readUTF16String(valueNamePtr) : '';
    const type = emu.readArg(3);
    const dataPtr = emu.readArg(4);
    const cbData = emu.readArg(5);
    const s = store();
    if (s && dataPtr) {
      const data = new Uint8Array(cbData);
      for (let i = 0; i < cbData; i++) data[i] = emu.memory.readU8(dataPtr + i);
      s.setValue(hKey, valueName, type, data);
      console.log(`[REG] RegSetValueExW(${hkeyName(hKey)}, "${valueName}", ${fmtType(type)}, ${fmtData(type, data)})`);
    }
    return ERROR_SUCCESS;
  });

  // --- RegQueryInfoKeyA ---
  advapi32.register('RegQueryInfoKeyA', 12, () => {
    // Just report "0 subkeys, 0 values" — enough for programs that enumerate
    const lpcSubKeys = emu.readArg(3);
    const lpcMaxSubKeyLen = emu.readArg(4);
    const lpcMaxClassLen = emu.readArg(5);
    const lpcValues = emu.readArg(6);
    const lpcMaxValueNameLen = emu.readArg(7);
    const lpcMaxValueLen = emu.readArg(8);
    if (lpcSubKeys) emu.memory.writeU32(lpcSubKeys, 0);
    if (lpcMaxSubKeyLen) emu.memory.writeU32(lpcMaxSubKeyLen, 0);
    if (lpcMaxClassLen) emu.memory.writeU32(lpcMaxClassLen, 0);
    if (lpcValues) emu.memory.writeU32(lpcValues, 0);
    if (lpcMaxValueNameLen) emu.memory.writeU32(lpcMaxValueNameLen, 0);
    if (lpcMaxValueLen) emu.memory.writeU32(lpcMaxValueLen, 0);
    return ERROR_SUCCESS;
  });

  // --- RegCloseKey ---
  advapi32.register('RegCloseKey', 1, () => {
    const hKey = emu.readArg(0);
    store()?.closeKey(hKey);
    return ERROR_SUCCESS;
  });

  // --- RegDeleteValue ---
  advapi32.register('RegDeleteValueA', 2, () => {
    const hKey = emu.readArg(0);
    const valueNamePtr = emu.readArg(1);
    const valueName = valueNamePtr ? emu.memory.readCString(valueNamePtr) : '';
    const s = store();
    if (s) return s.deleteValue(hKey, valueName) ? ERROR_SUCCESS : ERROR_FILE_NOT_FOUND;
    return ERROR_SUCCESS;
  });

  advapi32.register('RegDeleteValueW', 2, () => {
    const hKey = emu.readArg(0);
    const valueNamePtr = emu.readArg(1);
    const valueName = valueNamePtr ? emu.memory.readUTF16String(valueNamePtr) : '';
    const s = store();
    if (s) return s.deleteValue(hKey, valueName) ? ERROR_SUCCESS : ERROR_FILE_NOT_FOUND;
    return ERROR_SUCCESS;
  });

  // --- RegDeleteKey ---
  advapi32.register('RegDeleteKeyA', 2, () => {
    const hKey = emu.readArg(0);
    const subKeyPtr = emu.readArg(1);
    const subKey = subKeyPtr ? emu.memory.readCString(subKeyPtr) : '';
    const s = store();
    if (s) return s.deleteKey(hKey, subKey) ? ERROR_SUCCESS : ERROR_FILE_NOT_FOUND;
    return ERROR_FILE_NOT_FOUND;
  });

  advapi32.register('RegDeleteKeyW', 2, () => {
    const hKey = emu.readArg(0);
    const subKeyPtr = emu.readArg(1);
    const subKey = subKeyPtr ? emu.memory.readUTF16String(subKeyPtr) : '';
    const s = store();
    if (s) return s.deleteKey(hKey, subKey) ? ERROR_SUCCESS : ERROR_FILE_NOT_FOUND;
    return ERROR_SUCCESS;
  });

  // --- RegEnumKey ---
  advapi32.register('RegEnumKeyA', 4, () => {
    const hKey = emu.readArg(0);
    const index = emu.readArg(1);
    const namePtr = emu.readArg(2);
    const cchName = emu.readArg(3);
    const s = store();
    if (s) {
      const name = s.enumKey(hKey, index);
      if (name === null) {
        console.log(`[REG] RegEnumKeyA(${hkeyName(hKey)}, index=${index}) => NO_MORE_ITEMS`);
        return ERROR_NO_MORE_ITEMS;
      }
      if (namePtr && cchName > name.length) {
        emu.memory.writeCString(namePtr, name);
      }
      console.log(`[REG] RegEnumKeyA(${hkeyName(hKey)}, index=${index}) => "${name}"`);
      return ERROR_SUCCESS;
    }
    return ERROR_NO_MORE_ITEMS;
  });

  advapi32.register('RegEnumKeyExA', 8, () => {
    const hKey = emu.readArg(0);
    const index = emu.readArg(1);
    const namePtr = emu.readArg(2);
    const cchNamePtr = emu.readArg(3);
    const s = store();
    if (s) {
      const name = s.enumKey(hKey, index);
      if (name === null) {
        console.log(`[REG] RegEnumKeyExA(${hkeyName(hKey)}, index=${index}) => NO_MORE_ITEMS`);
        return ERROR_NO_MORE_ITEMS;
      }
      if (namePtr && cchNamePtr) {
        const cch = emu.memory.readU32(cchNamePtr);
        if (cch > name.length) {
          emu.memory.writeCString(namePtr, name);
        }
        emu.memory.writeU32(cchNamePtr, name.length);
      }
      console.log(`[REG] RegEnumKeyExA(${hkeyName(hKey)}, index=${index}) => "${name}"`);
      return ERROR_SUCCESS;
    }
    return ERROR_NO_MORE_ITEMS;
  });

  advapi32.register('RegEnumKeyExW', 8, () => {
    const hKey = emu.readArg(0);
    const index = emu.readArg(1);
    const namePtr = emu.readArg(2);
    const cchNamePtr = emu.readArg(3);
    const s = store();
    if (s) {
      const name = s.enumKey(hKey, index);
      if (name === null) {
        console.log(`[REG] RegEnumKeyExW(${hkeyName(hKey)}, index=${index}) => NO_MORE_ITEMS`);
        return ERROR_NO_MORE_ITEMS;
      }
      if (namePtr && cchNamePtr) {
        const cch = emu.memory.readU32(cchNamePtr);
        if (cch > name.length) {
          for (let i = 0; i < name.length; i++) emu.memory.writeU16(namePtr + i * 2, name.charCodeAt(i));
          emu.memory.writeU16(namePtr + name.length * 2, 0);
        }
        emu.memory.writeU32(cchNamePtr, name.length);
      }
      console.log(`[REG] RegEnumKeyExW(${hkeyName(hKey)}, index=${index}) => "${name}"`);
      return ERROR_SUCCESS;
    }
    return ERROR_NO_MORE_ITEMS;
  });

  advapi32.register('RegEnumKeyW', 4, () => {
    const hKey = emu.readArg(0);
    const index = emu.readArg(1);
    const namePtr = emu.readArg(2);
    const cchName = emu.readArg(3);
    const s = store();
    if (s) {
      const name = s.enumKey(hKey, index);
      if (name === null) {
        console.log(`[REG] RegEnumKeyW(${hkeyName(hKey)}, index=${index}) => NO_MORE_ITEMS`);
        return ERROR_NO_MORE_ITEMS;
      }
      if (namePtr && cchName > name.length) {
        for (let i = 0; i < name.length; i++) emu.memory.writeU16(namePtr + i * 2, name.charCodeAt(i));
        emu.memory.writeU16(namePtr + name.length * 2, 0);
      }
      console.log(`[REG] RegEnumKeyW(${hkeyName(hKey)}, index=${index}) => "${name}"`);
      return ERROR_SUCCESS;
    }
    return ERROR_NO_MORE_ITEMS;
  });

  // --- RegEnumValue ---
  advapi32.register('RegEnumValueA', 8, () => {
    const hKey = emu.readArg(0);
    const index = emu.readArg(1);
    const namePtr = emu.readArg(2);
    const cchNamePtr = emu.readArg(3);
    const typePtr = emu.readArg(5);
    const dataPtr = emu.readArg(6);
    const cbDataPtr = emu.readArg(7);
    const s = store();
    if (s) {
      const entry = s.enumValue(hKey, index);
      if (!entry) {
        console.log(`[REG] RegEnumValueA(${hkeyName(hKey)}, index=${index}) => NO_MORE_ITEMS`);
        return ERROR_NO_MORE_ITEMS;
      }
      if (namePtr && cchNamePtr) {
        const cch = emu.memory.readU32(cchNamePtr);
        if (cch > entry.name.length) {
          emu.memory.writeCString(namePtr, entry.name);
        }
        emu.memory.writeU32(cchNamePtr, entry.name.length);
      }
      if (typePtr) emu.memory.writeU32(typePtr, entry.type);
      if (cbDataPtr) {
        const bufSize = dataPtr ? emu.memory.readU32(cbDataPtr) : 0;
        emu.memory.writeU32(cbDataPtr, entry.data.length);
        if (dataPtr && bufSize >= entry.data.length) {
          for (let i = 0; i < entry.data.length; i++) emu.memory.writeU8(dataPtr + i, entry.data[i]);
        }
      }
      console.log(`[REG] RegEnumValueA(${hkeyName(hKey)}, index=${index}) => "${entry.name}" ${fmtType(entry.type)} ${fmtData(entry.type, entry.data)}`);
      return ERROR_SUCCESS;
    }
    return ERROR_NO_MORE_ITEMS;
  });

  advapi32.register('RegEnumValueW', 8, () => {
    const hKey = emu.readArg(0);
    const index = emu.readArg(1);
    const namePtr = emu.readArg(2);
    const cchNamePtr = emu.readArg(3);
    const typePtr = emu.readArg(5);
    const dataPtr = emu.readArg(6);
    const cbDataPtr = emu.readArg(7);
    const s = store();
    if (s) {
      const entry = s.enumValue(hKey, index);
      if (!entry) {
        console.log(`[REG] RegEnumValueW(${hkeyName(hKey)}, index=${index}) => NO_MORE_ITEMS`);
        return ERROR_NO_MORE_ITEMS;
      }
      if (namePtr && cchNamePtr) {
        const cch = emu.memory.readU32(cchNamePtr);
        if (cch > entry.name.length) {
          for (let i = 0; i < entry.name.length; i++) emu.memory.writeU16(namePtr + i * 2, entry.name.charCodeAt(i));
          emu.memory.writeU16(namePtr + entry.name.length * 2, 0);
        }
        emu.memory.writeU32(cchNamePtr, entry.name.length);
      }
      if (typePtr) emu.memory.writeU32(typePtr, entry.type);
      if (cbDataPtr) {
        const bufSize = dataPtr ? emu.memory.readU32(cbDataPtr) : 0;
        emu.memory.writeU32(cbDataPtr, entry.data.length);
        if (dataPtr && bufSize >= entry.data.length) {
          for (let i = 0; i < entry.data.length; i++) emu.memory.writeU8(dataPtr + i, entry.data[i]);
        }
      }
      console.log(`[REG] RegEnumValueW(${hkeyName(hKey)}, index=${index}) => "${entry.name}" ${fmtType(entry.type)} ${fmtData(entry.type, entry.data)}`);
      return ERROR_SUCCESS;
    }
    return ERROR_NO_MORE_ITEMS;
  });

  advapi32.register('RegFlushKey', 1, () => {
    return ERROR_SUCCESS;
  });

  // RegQueryInfoKeyW(hKey, lpClass, lpcClass, lpReserved, lpcSubKeys, lpcMaxSubKeyLen,
  //   lpcMaxClassLen, lpcValues, lpcMaxValueNameLen, lpcMaxValueLen, lpcbSecurityDescriptor, lpftLastWriteTime)
  advapi32.register('RegQueryInfoKeyW', 12, () => {
    const hKey = emu.readArg(0);
    const lpcSubKeys = emu.readArg(4);
    const lpcValues = emu.readArg(7);
    const s = store();
    let nSubKeys = 0;
    let nValues = 0;
    if (s) {
      while (s.enumKey(hKey, nSubKeys) !== null) nSubKeys++;
      while (s.enumValue(hKey, nValues) !== null) nValues++;
    }
    if (lpcSubKeys) emu.memory.writeU32(lpcSubKeys, nSubKeys);
    if (lpcValues) emu.memory.writeU32(lpcValues, nValues);
    return ERROR_SUCCESS;
  });

  // W (Unicode) create variants
  advapi32.register('RegCreateKeyW', 3, () => {
    const hKey = emu.readArg(0);
    const subKeyPtr = emu.readArg(1);
    const subKey = subKeyPtr ? emu.memory.readUTF16String(subKeyPtr) : '';
    const resultPtr = emu.readArg(2);
    const s = store();
    if (s) {
      const r = s.createKey(hKey, subKey);
      if (r) {
        if (resultPtr) emu.memory.writeU32(resultPtr, r.handle);
        return ERROR_SUCCESS;
      }
    }
    if (resultPtr) emu.memory.writeU32(resultPtr, 0x2000);
    return ERROR_SUCCESS;
  });

  advapi32.register('RegCreateKeyExW', 9, () => {
    const hKey = emu.readArg(0);
    const subKeyPtr = emu.readArg(1);
    const subKey = subKeyPtr ? emu.memory.readUTF16String(subKeyPtr) : '';
    const resultPtr = emu.readArg(7);
    const dispositionPtr = emu.readArg(8);
    const s = store();
    if (s) {
      const r = s.createKey(hKey, subKey);
      if (r) {
        if (resultPtr) emu.memory.writeU32(resultPtr, r.handle);
        if (dispositionPtr) emu.memory.writeU32(dispositionPtr, r.disposition);
        return ERROR_SUCCESS;
      }
    }
    if (resultPtr) emu.memory.writeU32(resultPtr, 0x2000);
    return ERROR_SUCCESS;
  });

  // --- Non-registry advapi32 APIs ---
  advapi32.register('GetUserNameA', 2, () => {
    const bufPtr = emu.readArg(0);
    const sizePtr = emu.readArg(1);
    const name = 'User';
    if (sizePtr) {
      const bufSize = emu.memory.readU32(sizePtr);
      if (bufPtr && bufSize > name.length) {
        emu.memory.writeCString(bufPtr, name);
        emu.memory.writeU32(sizePtr, name.length + 1);
        return 1;
      }
      emu.memory.writeU32(sizePtr, name.length + 1);
    }
    return 0;
  });

  advapi32.register('CopySid', 3, () => 1);
  advapi32.register('EqualSid', 2, () => 0);
  // IsTextUnicode(lpBuffer, iSize, lpiResult) — heuristic detection. Apps
  // like Notepad call this with lpiResult = NULL (test everything, return
  // combined result) when opening a file. The stub→0 meant every file looked
  // like ANSI, so UTF-16-LE files opened as garbage. We honor the two cheap
  // signature tests : FF FE BOM and statistics-by-null-byte pattern. Caller-
  // requested test mask is preserved through lpiResult on output.
  advapi32.register('IsTextUnicode', 3, () => {
    const lpBuffer = emu.readArg(0);
    const iSize = emu.readArg(1) | 0;
    const lpiResult = emu.readArg(2);
    const IS_TEXT_UNICODE_SIGNATURE          = 0x0008;
    const IS_TEXT_UNICODE_REVERSE_SIGNATURE  = 0x0010;
    const IS_TEXT_UNICODE_STATISTICS         = 0x0002;
    const ALL_TESTS = 0xFFFF;
    const requested = lpiResult ? (emu.memory.readU32(lpiResult) || ALL_TESTS) : ALL_TESTS;
    let passed = 0;
    if (lpBuffer && iSize >= 2) {
      const b0 = emu.memory.readU8(lpBuffer);
      const b1 = emu.memory.readU8(lpBuffer + 1);
      if ((requested & IS_TEXT_UNICODE_SIGNATURE) && b0 === 0xFF && b1 === 0xFE) {
        passed |= IS_TEXT_UNICODE_SIGNATURE;
      }
      if ((requested & IS_TEXT_UNICODE_REVERSE_SIGNATURE) && b0 === 0xFE && b1 === 0xFF) {
        passed |= IS_TEXT_UNICODE_REVERSE_SIGNATURE;
      }
      if (requested & IS_TEXT_UNICODE_STATISTICS) {
        // Cheap heuristic : even-indexed bytes look ASCII, odd-indexed bytes
        // are mostly zero → likely UTF-16-LE plain ASCII content.
        const sample = Math.min(iSize, 256);
        let nullsOnOdd = 0;
        for (let i = 1; i < sample; i += 2) if (emu.memory.readU8(lpBuffer + i) === 0) nullsOnOdd++;
        if (sample >= 8 && nullsOnOdd > (sample / 2) * 0.7) {
          passed |= IS_TEXT_UNICODE_STATISTICS;
        }
      }
    }
    if (lpiResult) emu.memory.writeU32(lpiResult, passed);
    return passed !== 0 ? 1 : 0;
  });

  // Security stubs
  advapi32.register('OpenProcessToken', 3, () => {
    const tokenPtr = emu.readArg(2);
    if (tokenPtr) emu.memory.writeU32(tokenPtr, 0x3000);
    return 1;
  });

  advapi32.register('OpenThreadToken', 4, () => {
    const tokenPtr = emu.readArg(3);
    if (tokenPtr) emu.memory.writeU32(tokenPtr, 0x3001);
    return 1;
  });

  advapi32.register('ImpersonateSelf', 1, () => 1);
  advapi32.register('RevertToSelf', 0, () => 1);
  advapi32.register('SetThreadToken', 2, () => 1); // no-op, always succeed

  advapi32.register('AllocateAndInitializeSid', 11, () => {
    const sidPtr = emu.readArg(10);
    if (sidPtr) {
      const fakeSid = emu.allocHeap(28);
      emu.memory.writeU32(fakeSid, 0x01010000);
      emu.memory.writeU32(sidPtr, fakeSid);
    }
    return 1;
  });

  advapi32.register('FreeSid', 1, () => 0);
  advapi32.register('GetLengthSid', 1, () => 28);

  advapi32.register('InitializeSecurityDescriptor', 2, () => 1);
  advapi32.register('SetSecurityDescriptorDacl', 4, () => 1);
  advapi32.register('SetSecurityDescriptorOwner', 3, () => 1);
  advapi32.register('SetSecurityDescriptorGroup', 3, () => 1);
  advapi32.register('IsValidSecurityDescriptor', 1, () => 1);

  advapi32.register('InitializeAcl', 3, () => 1);
  advapi32.register('AddAccessAllowedAce', 4, () => 1);

  advapi32.register('AccessCheck', 8, () => {
    const grantedPtr = emu.readArg(6);
    const statusPtr = emu.readArg(7);
    if (grantedPtr) emu.memory.writeU32(grantedPtr, 0x1F01FF);
    if (statusPtr) emu.memory.writeU32(statusPtr, 1);
    return 1;
  });

  advapi32.register('LookupPrivilegeValueA', 3, () => {
    const luidPtr = emu.readArg(2);
    if (luidPtr) {
      emu.memory.writeU32(luidPtr, 20);
      emu.memory.writeU32(luidPtr + 4, 0);
    }
    return 1;
  });

  advapi32.register('AdjustTokenPrivileges', 6, () => 1);

  // BOOL SetFileSecurityA(LPCSTR lpFileName, SECURITY_INFORMATION, PSECURITY_DESCRIPTOR) — succeed
  advapi32.register('SetFileSecurityA', 3, () => 1);
  advapi32.register('SetFileSecurityW', 3, () => 1);
  // BOOL GetFileSecurityA(LPCSTR, SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, DWORD, LPDWORD) — fail
  advapi32.register('GetFileSecurityA', 5, () => {
    const lengthNeeded = emu.readArg(4);
    if (lengthNeeded) emu.memory.writeU32(lengthNeeded, 0);
    return 0;
  });
  advapi32.register('GetFileSecurityW', 5, () => {
    const lengthNeeded = emu.readArg(4);
    if (lengthNeeded) emu.memory.writeU32(lengthNeeded, 0);
    return 0;
  });

  // Service Control Manager stubs
  advapi32.register('OpenSCManagerA', 3, () => 0x4000);
  advapi32.register('OpenServiceA', 3, () => 0x4001);
  advapi32.register('CreateServiceW', 13, () => 0x4002);
  advapi32.register('StartServiceA', 3, () => 1);
  advapi32.register('ControlService', 3, () => 1);
  advapi32.register('DeleteService', 1, () => 1);
  advapi32.register('CloseServiceHandle', 1, () => 1);
  advapi32.register('GetSecurityInfoExW', 8, () => 0);
  advapi32.register('GetSiteSidFromToken', 2, () => 1);
  advapi32.register('IsValidSid', 1, () => 1);
  advapi32.register('IsTokenRestricted', 1, () => 0);

  advapi32.register('LookupAccountSidW', 7, () => {
    const namePtr = emu.readArg(2);
    const cchNamePtr = emu.readArg(3);
    const domainPtr = emu.readArg(4);
    const cchDomainPtr = emu.readArg(5);
    const peUse = emu.readArg(6);
    const name = 'User';
    if (cchNamePtr) {
      const cch = emu.memory.readU32(cchNamePtr);
      if (namePtr && cch > name.length) {
        for (let i = 0; i < name.length; i++) emu.memory.writeU16(namePtr + i * 2, name.charCodeAt(i));
        emu.memory.writeU16(namePtr + name.length * 2, 0);
      }
      emu.memory.writeU32(cchNamePtr, name.length + 1);
    }
    const domain = 'DESKTOP';
    if (cchDomainPtr) {
      const cch = emu.memory.readU32(cchDomainPtr);
      if (domainPtr && cch > domain.length) {
        for (let i = 0; i < domain.length; i++) emu.memory.writeU16(domainPtr + i * 2, domain.charCodeAt(i));
        emu.memory.writeU16(domainPtr + domain.length * 2, 0);
      }
      emu.memory.writeU32(cchDomainPtr, domain.length + 1);
    }
    const SidTypeUser = 1;
    if (peUse) emu.memory.writeU32(peUse, SidTypeUser);
    return 1;
  });

  // Registry stubs for remote/backup operations
  advapi32.register('RegConnectRegistryW', 3, () => ERROR_FILE_NOT_FOUND);
  advapi32.register('RegLoadKeyW', 3, () => ERROR_FILE_NOT_FOUND);
  advapi32.register('RegUnLoadKeyW', 2, () => ERROR_SUCCESS);
  advapi32.register('RegSaveKeyW', 3, () => ERROR_SUCCESS);
  advapi32.register('RegReplaceKeyW', 4, () => ERROR_SUCCESS);
  advapi32.register('RegRestoreKeyW', 3, () => ERROR_SUCCESS);
}
