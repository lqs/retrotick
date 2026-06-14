import type { Emulator } from '../emulator';

export function registerOle32(emu: Emulator): void {
  const ole32 = emu.registerDll('OLE32.DLL');

  ole32.register('OleInitialize', 1, () => 0);     // S_OK
  ole32.register('OleUninitialize', 0, () => 0);
  ole32.register('OleBuildVersion', 0, () => 0);
  ole32.register('CoCreateInstance', 5, () => {
    const rclsid = emu.readArg(0);
    const ppv = emu.readArg(4);
    // Check CLSID for DirectSound: {47D4D946-62E8-11CF-93BC-444553540000}
    if (rclsid) {
      const d1 = emu.memory.readU32(rclsid);
      const d2 = emu.memory.readU16(rclsid + 4);
      const d3 = emu.memory.readU16(rclsid + 6);
      if (d1 === 0x47D4D946 && d2 === 0x62E8 && d3 === 0x11CF) {
        // Create DirectSound via DirectSoundCreate
        const dsCreate = emu.apiDefs.get('DSOUND.DLL:DirectSoundCreate');
        if (dsCreate) {
          // Push args for DirectSoundCreate(NULL, ppv, NULL)
          const saved0 = emu.memory.readU32(emu.cpu.reg[4] + 4);
          const saved1 = emu.memory.readU32(emu.cpu.reg[4] + 8);
          const saved2 = emu.memory.readU32(emu.cpu.reg[4] + 12);
          emu.memory.writeU32(emu.cpu.reg[4] + 4, 0);     // lpGuid = NULL
          emu.memory.writeU32(emu.cpu.reg[4] + 8, ppv);   // ppDS
          emu.memory.writeU32(emu.cpu.reg[4] + 12, 0);    // pUnkOuter = NULL
          const result = dsCreate.handler(emu);
          emu.memory.writeU32(emu.cpu.reg[4] + 4, saved0);
          emu.memory.writeU32(emu.cpu.reg[4] + 8, saved1);
          emu.memory.writeU32(emu.cpu.reg[4] + 12, saved2);
          return result;
        }
      }
    }
    return 0x80004002; // E_NOINTERFACE
  });
  ole32.register('CoRegisterClassObject', 5, () => 0);
  ole32.register('CoRevokeClassObject', 1, () => 0);
  ole32.register('CoLockObjectExternal', 3, () => 0);
  ole32.register('CoGetMalloc', 2, () => 0x80004001); // E_NOTIMPL
  ole32.register('OleSetClipboard', 1, () => 0);
  ole32.register('OleIsCurrentClipboard', 1, () => 1); // S_FALSE
  ole32.register('OleFlushClipboard', 0, () => 0);
  ole32.register('OleNoteObjectVisible', 2, () => 0);
  ole32.register('OleSave', 3, () => 0);
  ole32.register('OleDraw', 4, () => 0);
  ole32.register('OleCreateMenuDescriptor', 2, () => 0);
  ole32.register('OleDestroyMenuDescriptor', 1, () => 0);
  ole32.register('CLSIDFromString', 2, () => 0);
  ole32.register('CreateFileMoniker', 2, () => 0x80004001);
  ole32.register('CreateStreamOnHGlobal', 3, () => 0x80004001);
  ole32.register('CreateDataAdviseHolder', 1, () => 0x80004001);
  ole32.register('CreateOleAdviseHolder', 1, () => 0x80004001);
  ole32.register('CreateBindCtx', 2, () => 0x80004001);
  ole32.register('CreateILockBytesOnHGlobal', 3, () => 0x80004001);
  ole32.register('GetRunningObjectTable', 2, () => 0x80004001);
  ole32.register('ReleaseStgMedium', 1, () => 0);
  ole32.register('WriteClassStg', 2, () => 0);
  ole32.register('WriteClassStm', 2, () => 0);
  ole32.register('WriteFmtUserTypeStg', 3, () => 0);
  ole32.register('StgCreateDocfile', 4, () => 0x80004001);
  ole32.register('StgOpenStorage', 6, () => 0x80004001);
  ole32.register('StgCreateDocfileOnILockBytes', 4, () => 0x80004001);

  ole32.register('CoRegisterMessageFilter', 2, () => {
    const _lpMessageFilter = emu.readArg(0);
    const lplpMessageFilter = emu.readArg(1);
    if (lplpMessageFilter) emu.memory.writeU32(lplpMessageFilter, 0);
    return 0; // S_OK
  });

  ole32.register('StringFromCLSID', 2, () => {
    const rclsid = emu.readArg(0);
    const lplpsz = emu.readArg(1);
    if (rclsid && lplpsz) {
      // Format GUID as {xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}
      const d1 = emu.memory.readU32(rclsid);
      const d2 = emu.memory.readU16(rclsid + 4);
      const d3 = emu.memory.readU16(rclsid + 6);
      const hex = (v: number, n: number) => v.toString(16).padStart(n, '0');
      let d4 = '';
      for (let i = 0; i < 8; i++) d4 += hex(emu.memory.readU8(rclsid + 8 + i), 2);
      const str = `{${hex(d1,8)}-${hex(d2,4)}-${hex(d3,4)}-${d4.slice(0,4)}-${d4.slice(4)}}`;
      const buf = emu.allocHeap((str.length + 1) * 2);
      for (let i = 0; i < str.length; i++) emu.memory.writeU16(buf + i * 2, str.charCodeAt(i));
      emu.memory.writeU16(buf + str.length * 2, 0);
      emu.memory.writeU32(lplpsz, buf);
    }
    return 0; // S_OK
  });

  ole32.register('CoTaskMemFree', 1, () => 0);

  ole32.register('CoTaskMemAlloc', 1, () => {
    const size = emu.readArg(0);
    return size ? emu.allocHeap(size) : 0;
  });

  ole32.register('CoTaskMemRealloc', 2, () => {
    const ptr = emu.readArg(0);
    const size = emu.readArg(1);
    return emu.reallocHeap(ptr, size);
  });

  // CoReleaseMarshalData(pStm) — no-op for single-process emulator
  ole32.register('CoReleaseMarshalData', 1, () => 0); // S_OK

  // CoMarshalInterface(pStm, riid, pUnk, dwDestContext, pvDestContext, mshlflags) — E_NOTIMPL
  ole32.register('CoMarshalInterface', 6, () => 0x80004001);

  // CoUnmarshalInterface(pStm, riid, ppv) — E_NOTIMPL
  ole32.register('CoUnmarshalInterface', 3, () => 0x80004001);

  ole32.register('CoCreateGuid', 1, () => {
    const guidPtr = emu.readArg(0);
    if (guidPtr) {
      // Write a pseudo-random GUID
      for (let i = 0; i < 16; i++) emu.memory.writeU8(guidPtr + i, (Math.random() * 256) | 0);
    }
    return 0; // S_OK
  });
  ole32.register('RevokeDragDrop', 1, () => 0); // S_OK
  ole32.register('RegisterDragDrop', 2, () => 0); // S_OK
  // BOOL IsAccelerator(HACCEL, int, LPMSG, WORD*) — return FALSE (no accel match)
  ole32.register('IsAccelerator', 4, () => 0);
  // HRESULT OleTranslateAccelerator(IOleInPlaceFrame*, LPOLEINPLACEFRAMEINFO, LPMSG)
  ole32.register('OleTranslateAccelerator', 3, () => 0x00040002); // S_FALSE
  // void CoFreeUnusedLibraries(void)
  ole32.register('CoFreeUnusedLibraries', 0, () => 0);
  // HRESULT CLSIDFromProgID(LPCOLESTR lpszProgID, LPCLSID pclsid)
  ole32.register('CLSIDFromProgID', 2, () => 0x800401F3); // CO_E_CLASSSTRING
  // HRESULT CoGetClassObject(REFCLSID, DWORD, COSERVERINFO*, REFIID, LPVOID*)
  ole32.register('CoGetClassObject', 5, () => 0x80040154); // REGDB_E_CLASSNOTREG
  // HRESULT StgOpenStorageOnILockBytes(ILockBytes*, IStorage*, DWORD, SNB, DWORD, IStorage**)
  ole32.register('StgOpenStorageOnILockBytes', 6, () => 0x80004001); // E_NOTIMPL

  ole32.register('CoInitialize', 1, () => 0); // S_OK
  ole32.register('CoUninitialize', 0, () => 0);
  ole32.register('StringFromGUID2', 3, () => {
    const guidPtr = emu.readArg(0);
    const bufPtr = emu.readArg(1);
    const cchMax = emu.readArg(2);
    // Format GUID as {xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}
    if (guidPtr && bufPtr && cchMax >= 39) {
      const d1 = emu.memory.readU32(guidPtr);
      const d2 = emu.memory.readU16(guidPtr + 4);
      const d3 = emu.memory.readU16(guidPtr + 6);
      const hex = (v: number, n: number) => v.toString(16).padStart(n, '0');
      let d4 = '';
      for (let i = 0; i < 8; i++) d4 += hex(emu.memory.readU8(guidPtr + 8 + i), 2);
      const str = `{${hex(d1,8)}-${hex(d2,4)}-${hex(d3,4)}-${d4.slice(0,4)}-${d4.slice(4)}}`;
      for (let i = 0; i < str.length; i++) emu.memory.writeU16(bufPtr + i * 2, str.charCodeAt(i));
      emu.memory.writeU16(bufPtr + str.length * 2, 0);
      return str.length + 1;
    }
    return 0;
  });

  // IsEqualGUID(rguid1, rguid2) → BOOL — compare two 16-byte GUIDs
  ole32.register('IsEqualGUID', 2, () => {
    const rguid1 = emu.readArg(0);
    const rguid2 = emu.readArg(1);
    for (let i = 0; i < 16; i++) {
      if (emu.memory.readU8(rguid1 + i) !== emu.memory.readU8(rguid2 + i)) return 0;
    }
    return 1;
  });

  // OleGetClipboard(ppDataObj) — 1 arg
  ole32.register('OleGetClipboard', 1, () => {
    const ppDataObj = emu.readArg(0);
    if (ppDataObj) emu.memory.writeU32(ppDataObj, 0);
    return 0x80004005; // E_FAIL
  });
}
