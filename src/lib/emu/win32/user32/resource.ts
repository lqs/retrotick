import type { Emulator } from '../../emulator';
import type { AccelEntry } from '../../../pe/types';
import { rvaToFileOffset } from '../../../pe/read';
import { WM_KEYDOWN, WM_SYSKEYDOWN, WM_COMMAND, WM_SYSCOMMAND } from '../types';

export function registerResource(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  user32.register('LoadBitmapA', 2, () => {
    const hInstance = emu.readArg(0);
    const namePtr = emu.readArg(1);

    let resourceId: number;
    if (namePtr < 0x10000) {
      resourceId = namePtr;
    } else {
      const name = emu.memory.readCString(namePtr);
      resourceId = parseInt(name) || 0;
    }

    // Check if hInstance is a loaded DLL
    if (hInstance !== 0 && hInstance !== emu.pe.imageBase) {
      const result = emu.loadBitmapResourceFromModule(hInstance, resourceId);
      if (result) return result;
    }
    return emu.loadBitmapResource(resourceId);
  });

  user32.register('LoadImageA', 6, () => {
    const hInst = emu.readArg(0);
    const namePtr = emu.readArg(1);
    const type = emu.readArg(2);
    const _cx = emu.readArg(3);
    const _cy = emu.readArg(4);
    const _flags = emu.readArg(5);

    if (type === 0) { // IMAGE_BITMAP
      let resourceId: number;
      if (namePtr < 0x10000) {
        resourceId = namePtr;
      } else {
        const name = emu.memory.readCString(namePtr);
        resourceId = parseInt(name) || 0;
      }
      return emu.loadBitmapResource(resourceId);
    }

    return 0;
  });

  user32.register('LoadBitmapW', 2, () => {
    const hInstance = emu.readArg(0);
    const namePtr = emu.readArg(1);
    let resourceId: number | string;
    if (namePtr < 0x10000) {
      resourceId = namePtr;
    } else {
      const name = emu.memory.readUTF16String(namePtr);
      const parsed = parseInt(name);
      resourceId = isNaN(parsed) ? name : parsed;
    }

    // Check if hInstance is a loaded DLL
    if (typeof resourceId === 'number' && hInstance !== 0 && hInstance !== emu.pe.imageBase) {
      const result = emu.loadBitmapResourceFromModule(hInstance, resourceId);
      if (result) return result;
    }

    // String-named resources: look up in PE resource directory from file
    if (typeof resourceId === 'string') {
      return emu.loadBitmapResourceByName(resourceId);
    }
    return emu.loadBitmapResource(resourceId);
  });

  user32.register('LoadImageW', 6, () => {
    const hInst = emu.readArg(0);
    const namePtr = emu.readArg(1);
    const type = emu.readArg(2);
    const _cx = emu.readArg(3);
    const _cy = emu.readArg(4);
    const _flags = emu.readArg(5);
    const IMAGE_BITMAP = 0;
    const IMAGE_ICON = 1;
    const IMAGE_CURSOR = 2;
    if (type === IMAGE_BITMAP) {
      let result: number;
      if (namePtr < 0x10000) {
        result = emu.loadBitmapResource(namePtr);
      } else {
        const name = emu.memory.readUTF16String(namePtr);
        const parsed = parseInt(name);
        if (!isNaN(parsed)) {
          result = emu.loadBitmapResource(parsed);
        } else {
          result = emu.loadBitmapResourceByName(name);
        }
      }
      return result;
    }
    if (type === IMAGE_ICON) {
      const resourceId = namePtr < 0x10000 ? namePtr : 0;
      // Try to extract actual icon image data
      let dataUrl: string | undefined;
      if (resourceId && emu.peInfo && emu.arrayBuffer) {
        try {
          // Find the group icon resource containing this icon ID
          const RT_GROUP_ICON = 14, RT_ICON = 3;
          const groupType = emu.peInfo.resources?.find(r => r.typeId === RT_GROUP_ICON);
          const iconType = emu.peInfo.resources?.find(r => r.typeId === RT_ICON);
          if (groupType && iconType) {
            for (const ge of groupType.entries) {
              if (ge.id !== resourceId) continue;
              for (const lang of ge.languages) {
                const fileOff = rvaToFileOffset(lang.dataRva, emu.peInfo!.sections);
                const dv = new DataView(emu.arrayBuffer, fileOff, lang.dataSize);
                const idCount = dv.getUint16(4, true);
                // Build .ico file
                const iconEntries: { nID: number; grpOff: number; dataSize: number }[] = [];
                for (let i = 0; i < idCount; i++) {
                  const off = 6 + i * 14;
                  const dwBytes = dv.getUint32(off + 8, true);
                  const nID = dv.getUint16(off + 12, true);
                  iconEntries.push({ nID, grpOff: off, dataSize: dwBytes });
                }
                // Pick smallest icon (16x16 preferred)
                const headerSize = 6 + 16; // single-entry ico
                let bestIdx = 0;
                let bestSize = 999;
                for (let i = 0; i < idCount; i++) {
                  const w = dv.getUint8(6 + i * 14) || 256;
                  if (w <= bestSize && w >= 16) { bestSize = w; bestIdx = i; }
                }
                const chosen = iconEntries[bestIdx];
                const iconData = iconType.entries.find(e => e.id === chosen.nID);
                if (iconData) {
                  const iconLang = iconData.languages[0];
                  const iconOff = rvaToFileOffset(iconLang.dataRva, emu.peInfo!.sections);
                  const icoSize = headerSize + iconLang.dataSize;
                  const ico = new Uint8Array(icoSize);
                  const icoDv = new DataView(ico.buffer);
                  icoDv.setUint16(0, 0, true);
                  icoDv.setUint16(2, 1, true); // type = icon
                  icoDv.setUint16(4, 1, true); // count = 1
                  // Copy GRPICONDIRENTRY (first 12 bytes)
                  for (let j = 0; j < 12; j++) ico[6 + j] = dv.getUint8(chosen.grpOff + j);
                  icoDv.setUint32(18, headerSize, true); // data offset
                  ico.set(new Uint8Array(emu.arrayBuffer, iconOff, iconLang.dataSize), headerSize);
                  // Convert to data URL
                  let binary = '';
                  for (let i = 0; i < ico.length; i++) binary += String.fromCharCode(ico[i]);
                  dataUrl = 'data:image/x-icon;base64,' + btoa(binary);
                }
                break;
              }
              break;
            }
          }
        } catch (_e) { /* ignore extraction failures */ }
      }
      return emu.handles.alloc('icon', { resourceId, dataUrl });
    }
    if (type === IMAGE_CURSOR) {
      return emu.handles.alloc('cursor', { resourceId: namePtr < 0x10000 ? namePtr : 0 });
    }
    return 0;
  });

  user32.register('LoadIconA', 2, () => {
    const _hInstance = emu.readArg(0);
    const _namePtr = emu.readArg(1);
    // Return a pseudo icon handle
    return emu.handles.alloc('icon', {});
  });

  user32.register('LoadIconW', 2, () => {
    return emu.handles.alloc('icon', {});
  });

  // IDC_ constants → CSS cursor names
  const idcToCss: Record<number, string> = {
    32512: 'default',     // IDC_ARROW
    32513: 'text',        // IDC_IBEAM
    32514: 'wait',        // IDC_WAIT
    32515: 'crosshair',   // IDC_CROSS
    32516: 'n-resize',    // IDC_UPARROW
    32642: 'nwse-resize',  // IDC_SIZENWSE
    32643: 'nesw-resize',  // IDC_SIZENESW
    32644: 'ew-resize',   // IDC_SIZEWE
    32645: 'ns-resize',   // IDC_SIZENS
    32646: 'move',        // IDC_SIZEALL
    32648: 'not-allowed', // IDC_NO
    32649: 'pointer',     // IDC_HAND
    32650: 'progress',    // IDC_APPSTARTING
    32651: 'help',        // IDC_HELP
  };

  function loadCursorImpl(hInstance: number, nameOrId: number): number {
    let css = 'default';
    if (hInstance === 0 && nameOrId < 0x10000) {
      css = idcToCss[nameOrId] || 'default';
    }
    return emu.handles.alloc('cursor', { css });
  }

  user32.register('LoadCursorA', 2, () => {
    const hInstance = emu.readArg(0);
    const namePtr = emu.readArg(1);
    return loadCursorImpl(hInstance, namePtr);
  });

  user32.register('LoadCursorW', 2, () => {
    const hInstance = emu.readArg(0);
    const namePtr = emu.readArg(1);
    if (hInstance !== 0 && namePtr >= 0x10000) {
      const name = emu.memory.readUTF16String(namePtr);
      const result = emu.loadCursorResourceByName(name);
      if (result) return result;
    }
    return loadCursorImpl(hInstance, namePtr);
  });

  user32.register('LoadStringA', 4, () => {
    const _hInstance = emu.readArg(0);
    const id = emu.readArg(1);
    const bufPtr = emu.readArg(2);
    const bufSize = emu.readArg(3);

    const str = emu.loadStringResource(id);
    if (!str || bufSize === 0) return 0;

    const maxChars = Math.min(str.length, bufSize - 1);
    for (let i = 0; i < maxChars; i++) {
      emu.memory.writeU8(bufPtr + i, str.charCodeAt(i) & 0xFF);
    }
    emu.memory.writeU8(bufPtr + maxChars, 0);
    return maxChars;
  });

  // LoadStringW - writes wide chars to buffer
  user32.register('LoadStringW', 4, () => {
    const _hInstance = emu.readArg(0);
    const id = emu.readArg(1);
    const bufPtr = emu.readArg(2);
    const bufSize = emu.readArg(3);

    const str = emu.loadStringResource(id);
    if (!str || bufSize === 0) return 0;

    const maxChars = Math.min(str.length, bufSize - 1);
    for (let i = 0; i < maxChars; i++) {
      emu.memory.writeU16(bufPtr + i * 2, str.charCodeAt(i));
    }
    emu.memory.writeU16(bufPtr + maxChars * 2, 0);
    return maxChars;
  });

  const RT_ACCELERATOR = 9;
  const FVIRTKEY = 0x01;
  const FSHIFT = 0x04;
  const FCONTROL = 0x08;
  const FALT = 0x10;

  function loadAccelTable(hInstance: number, resourceId: number | string): number {
    // Find the accelerator resource
    const entry = emu.findResourceEntry(RT_ACCELERATOR, resourceId);
    if (!entry) return emu.handles.alloc('accel', { entries: [] as AccelEntry[] });

    let fileOffset: number;
    try {
      fileOffset = rvaToFileOffset(entry.dataRva, emu.peInfo.sections);
    } catch {
      fileOffset = entry.dataRva;
    }

    const dv = new DataView(emu.arrayBuffer, fileOffset, entry.dataSize);
    const entries: AccelEntry[] = [];
    const count = Math.floor(entry.dataSize / 8);
    for (let i = 0; i < count; i++) {
      const off = i * 8;
      const fVirt = dv.getUint16(off, true);
      const key = dv.getUint16(off + 2, true);
      const cmd = dv.getUint16(off + 4, true);
      entries.push({ fVirt, key, cmd, keyName: '' });
      if (fVirt & 0x80) break; // last entry
    }

    return emu.handles.alloc('accel', { entries });
  }

  user32.register('LoadAcceleratorsA', 2, () => {
    const hInstance = emu.readArg(0);
    const namePtr = emu.readArg(1);
    const resourceId = namePtr < 0x10000 ? namePtr : emu.memory.readCString(namePtr);
    return loadAccelTable(hInstance, resourceId);
  });

  user32.register('LoadAcceleratorsW', 2, () => {
    const hInstance = emu.readArg(0);
    const namePtr = emu.readArg(1);
    const resourceId = namePtr < 0x10000 ? namePtr : emu.memory.readUTF16String(namePtr);
    return loadAccelTable(hInstance, resourceId);
  });

  function translateAccelImpl(): number {
    const hWnd = emu.readArg(0);
    const hAccTable = emu.readArg(1);
    const pMsg = emu.readArg(2);

    const accelData = emu.handles.get<{ entries: AccelEntry[] }>(hAccTable);
    if (!accelData || !accelData.entries.length) return 0;

    // Read MSG struct: hwnd(+0), message(+4), wParam(+8), lParam(+12)
    const msgType = emu.memory.readU32(pMsg + 4);
    const vKey = emu.memory.readU32(pMsg + 8);

    // TranslateAccelerator only processes key-down messages
    if (msgType !== WM_KEYDOWN && msgType !== WM_SYSKEYDOWN) return 0;

    for (const accel of accelData.entries) {
      if (accel.fVirt & FVIRTKEY) {
        // Virtual key match
        if (vKey !== accel.key) continue;

        // Check modifier state
        const shiftDown = emu.keyStates.has(0x10);
        const ctrlDown = emu.keyStates.has(0x11);
        const altDown = emu.keyStates.has(0x12);

        if (!!(accel.fVirt & FSHIFT) !== shiftDown) continue;
        if (!!(accel.fVirt & FCONTROL) !== ctrlDown) continue;
        if (!!(accel.fVirt & FALT) !== altDown) continue;
      } else {
        // ASCII character match — only match WM_KEYDOWN with the character value
        if (vKey !== accel.key) continue;
      }

      // Match found — send WM_COMMAND (or WM_SYSCOMMAND for Alt accelerators)
      const msg = (accel.fVirt & FALT) ? WM_SYSCOMMAND : WM_COMMAND;
      // wParam: HIWORD=1 (accelerator), LOWORD=cmd
      const wParam = (1 << 16) | accel.cmd;
      emu.postMessage(hWnd, msg, wParam, 0);
      return 1;
    }

    return 0;
  }

  user32.register('TranslateAcceleratorA', 3, translateAccelImpl);
  user32.register('TranslateAcceleratorW', 3, translateAccelImpl);

  // HACCEL CreateAcceleratorTableA(LPACCEL paccel, int cAccel) — build a table from the array
  function createAccelImpl(): number {
    const paccel = emu.readArg(0);
    const cAccel = emu.readArg(1);
    const entries: { fVirt: number; key: number; cmd: number }[] = [];
    if (paccel) {
      for (let i = 0; i < cAccel; i++) {
        const off = paccel + i * 6; // ACCEL: BYTE fVirt, WORD key, WORD cmd (+ 1 byte pad)
        entries.push({
          fVirt: emu.memory.readU8(off),
          key: emu.memory.readU16(off + 2),
          cmd: emu.memory.readU16(off + 4),
        });
      }
    }
    return emu.handles.alloc('accel', { entries });
  }
  user32.register('CreateAcceleratorTableA', 2, createAccelImpl);
  user32.register('CreateAcceleratorTableW', 2, createAccelImpl);
  user32.register('DestroyAcceleratorTable', 1, () => {
    const h = emu.readArg(0);
    if (h) emu.handles.free(h);
    return 1;
  });
  user32.register('CopyAcceleratorTableA', 3, () => 0);

  user32.register('CreateIcon', 7, () => emu.handles.alloc('icon', {}));
  user32.register('DestroyIcon', 1, () => 1);
  user32.register('DestroyCursor', 1, () => 1);
  user32.register('GetIconInfo', 2, () => 0);

  // CopyImage(h, type, cx, cy, flags) → HANDLE — return same handle
  user32.register('CopyImage', 5, () => emu.readArg(0));
}
