import type { Emulator } from '../emulator';
import type { WindowInfo } from './user32/types';
import { emuCompleteThunk } from '../emu-exec';

export function registerComdlg32(emu: Emulator): void {
  const comdlg32 = emu.registerDll('COMDLG32.DLL');

  // OPENFILENAME struct offsets (32-bit)
  const OFN_lpstrFilter = 0x0C;
  const OFN_lpstrFile = 0x1C;
  const OFN_nMaxFile = 0x20;
  const OFN_lpstrTitle = 0x30;
  const OFN_nFileOffset = 0x38;
  const OFN_nFileExtension = 0x3A;

  function parseFilter(filterPtr: number, isWide: boolean): string {
    if (!filterPtr) return '';
    // Filter is pairs of null-terminated strings (description\0pattern\0...\0\0)
    const parts: string[] = [];
    let ptr = filterPtr;
    for (let i = 0; i < 20; i++) { // safety limit
      const s = isWide ? emu.memory.readUTF16String(ptr) : emu.memory.readCString(ptr);
      if (!s) break;
      parts.push(s);
      ptr += isWide ? (s.length + 1) * 2 : s.length + 1;
    }
    return parts.join('|');
  }

  function writePathToBuffer(path: string, filePtr: number, nMaxFile: number, isWide: boolean): void {
    if (!filePtr || nMaxFile <= 0) return;
    const toWrite = path.substring(0, nMaxFile - 1);
    if (isWide) {
      for (let i = 0; i < toWrite.length; i++) emu.memory.writeU16(filePtr + i * 2, toWrite.charCodeAt(i));
      emu.memory.writeU16(filePtr + toWrite.length * 2, 0);
    } else {
      for (let i = 0; i < toWrite.length; i++) emu.memory.writeU8(filePtr + i, toWrite.charCodeAt(i) & 0xFF);
      emu.memory.writeU8(filePtr + toWrite.length, 0);
    }
  }

  function setOfnOffsets(lpOfn: number, path: string): void {
    const lastSlash = path.lastIndexOf('\\');
    emu.memory.writeU16(lpOfn + OFN_nFileOffset, lastSlash + 1);
    const lastDot = path.lastIndexOf('.');
    emu.memory.writeU16(lpOfn + OFN_nFileExtension, lastDot >= 0 ? lastDot + 1 : 0);
  }

  function doGetOpenFileName(isWide: boolean): number | undefined {
    const lpOfn = emu.readArg(0);
    if (!lpOfn) return 0;

    const filterPtr = emu.memory.readU32(lpOfn + OFN_lpstrFilter);
    const filePtr = emu.memory.readU32(lpOfn + OFN_lpstrFile);
    const nMaxFile = emu.memory.readU32(lpOfn + OFN_nMaxFile);
    const titlePtr = emu.memory.readU32(lpOfn + OFN_lpstrTitle);

    const filter = parseFilter(filterPtr, isWide);
    const title = titlePtr ? (isWide ? emu.memory.readUTF16String(titlePtr) : emu.memory.readCString(titlePtr)) : '';

    if (!emu.onShowCommonDialog) return 0;

    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    emu.onShowCommonDialog({
      type: 'file-open',
      filter: filter || undefined,
      onResult: (result) => {
        let retVal = 0;
        if (result) {
          // Store file data so CreateFile can find it later
          if (result.data) {
            const upperPath = result.path.toUpperCase();
            if (upperPath.startsWith('Z:\\')) {
              const data = new Uint8Array(result.data);
              emu.fs.externalFiles.set(upperPath, {
                data, name: result.path.substring(3),
              });
            } else if (upperPath.startsWith('D:\\')) {
              // Cache key is the store name (relative path), not the full D:\ path
              const storeName = result.path.substring(3).replace(/\\/g, '/');
              emu.fs.virtualFileCache?.set(storeName.toUpperCase(), result.data);
            }
          }
          writePathToBuffer(result.path, filePtr, nMaxFile, isWide);
          setOfnOffsets(lpOfn, result.path);
          retVal = 1;
        }
        emu.waitingForMessage = false;
        emuCompleteThunk(emu, retVal, stackBytes);
        if (emu.running && !emu.halted) requestAnimationFrame(emu.tick);
      },
    });
    return undefined;
  }

  function doGetSaveFileName(isWide: boolean): number | undefined {
    const lpOfn = emu.readArg(0);
    if (!lpOfn) return 0;

    const filterPtr = emu.memory.readU32(lpOfn + OFN_lpstrFilter);
    const filePtr = emu.memory.readU32(lpOfn + OFN_lpstrFile);
    const nMaxFile = emu.memory.readU32(lpOfn + OFN_nMaxFile);
    const titlePtr = emu.memory.readU32(lpOfn + OFN_lpstrTitle);

    const filter = parseFilter(filterPtr, isWide);
    const title = titlePtr ? (isWide ? emu.memory.readUTF16String(titlePtr) : emu.memory.readCString(titlePtr)) : '';

    let defaultName = '';
    if (filePtr) {
      defaultName = isWide ? emu.memory.readUTF16String(filePtr) : emu.memory.readCString(filePtr);
    }

    if (!emu.onShowCommonDialog) return 0;

    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    emu.onShowCommonDialog({
      type: 'file-save',
      filter: filter || undefined,
      defaultName: defaultName || undefined,
      onResult: (result) => {
        let retVal = 0;
        if (result) {
          // For save on D:\, the file will be written via WriteFile/CloseHandle
          // For Z:\ paths, pre-create an empty entry so CreateFile can find it
          if (result.path.toUpperCase().startsWith('Z:\\')) {
            const name = result.path.substring(3);
            if (!emu.fs.externalFiles.has(result.path.toUpperCase())) {
              emu.fs.externalFiles.set(result.path.toUpperCase(), { data: new Uint8Array(0), name });
            }
          }
          writePathToBuffer(result.path, filePtr, nMaxFile, isWide);
          setOfnOffsets(lpOfn, result.path);
          retVal = 1;
        }
        emu.waitingForMessage = false;
        emuCompleteThunk(emu, retVal, stackBytes);
        if (emu.running && !emu.halted) requestAnimationFrame(emu.tick);
      },
    });
    return undefined;
  }

  comdlg32.register('GetOpenFileNameA', 1, () => doGetOpenFileName(false));
  comdlg32.register('GetSaveFileNameA', 1, () => doGetSaveFileName(false));
  comdlg32.register('GetOpenFileNameW', 1, () => doGetOpenFileName(true));
  comdlg32.register('GetSaveFileNameW', 1, () => doGetSaveFileName(true));
  comdlg32.register('ChooseFontW', 1, () => 0);
  // FINDREPLACEW struct offsets (Win32)
  const FR_lStructSize      = 0x00; // DWORD
  const FR_hwndOwner        = 0x04; // HWND
  const FR_hInstance        = 0x08; // HINSTANCE
  const FR_Flags            = 0x0C; // DWORD
  const FR_lpstrFindWhat    = 0x10; // LPWSTR
  const FR_lpstrReplaceWith = 0x14; // LPWSTR
  const FR_wFindWhatLen     = 0x18; // WORD
  const FR_wReplaceWithLen  = 0x1A; // WORD

  // FINDREPLACE flags
  const FR_DOWN      = 0x00000001;
  const FR_MATCHCASE = 0x00000004;
  const FR_FINDNEXT  = 0x00000008;
  const FR_DIALOGTERM = 0x00000040;

  const FINDMSGSTRING = 'commdlg_FindReplace';

  function findEditChild(hwndOwner: number): number {
    const owner = emu.handles.get<WindowInfo>(hwndOwner);
    if (!owner?.childList) return 0;
    for (const childHwnd of owner.childList) {
      const child = emu.handles.get<WindowInfo>(childHwnd);
      if (child?.classInfo?.className?.toUpperCase() === 'EDIT') return childHwnd;
    }
    return 0;
  }

  comdlg32.register('FindTextW', 1, () => {
    const lpFr = emu.readArg(0);
    console.log(`[FIND] FindTextW lpFr=0x${lpFr.toString(16)}`);
    if (!lpFr) return 0;

    const hwndOwner = emu.memory.readU32(lpFr + FR_hwndOwner);
    const editHwnd = findEditChild(hwndOwner);

    // Store the FINDREPLACEW pointer for later use
    emu.findReplacePtr = lpFr;

    // Create a fake dialog window handle for the Find dialog
    const findDlgHwnd = emu.handles.alloc('window', {
      classInfo: { className: '#32770' }, // standard dialog class
      title: 'Find', visible: true, style: 0,
      x: 0, y: 0, width: 0, height: 0,
    } as WindowInfo);

    // Show the HTML Find dialog
    emu.onShowCommonDialog?.({
      type: 'find',
      editHwnd,
      onClose: () => {
        // Set FR_DIALOGTERM flag and notify owner
        if (emu.findReplacePtr) {
          const flags = emu.memory.readU32(emu.findReplacePtr + FR_Flags);
          emu.memory.writeU32(emu.findReplacePtr + FR_Flags, (flags & ~FR_FINDNEXT) | FR_DIALOGTERM);
          if (emu.registerWindowMessage) {
            const msgId = emu.registerWindowMessage(FINDMSGSTRING);
            emu.postMessage(hwndOwner, msgId, 0, emu.findReplacePtr);
          }
          emu.findReplacePtr = 0;
        }
        emu.handles.free(findDlgHwnd);
      },
    });

    return findDlgHwnd;
  });

  comdlg32.register('FindTextA', 1, () => {
    // Notepad uses FindTextW, but register A variant as stub
    return 0;
  });

  comdlg32.register('ReplaceTextW', 1, () => {
    const lpFr = emu.readArg(0);
    if (!lpFr) return 0;

    const hwndOwner = emu.memory.readU32(lpFr + FR_hwndOwner);
    const editHwnd = findEditChild(hwndOwner);

    emu.findReplacePtr = lpFr;

    const findDlgHwnd = emu.handles.alloc('window', {
      classInfo: { className: '#32770' },
      title: 'Replace', visible: true, style: 0,
      x: 0, y: 0, width: 0, height: 0,
    } as WindowInfo);

    emu.onShowCommonDialog?.({
      type: 'find-replace',
      editHwnd,
      onClose: () => {
        if (emu.findReplacePtr) {
          const flags = emu.memory.readU32(emu.findReplacePtr + FR_Flags);
          emu.memory.writeU32(emu.findReplacePtr + FR_Flags, (flags & ~FR_FINDNEXT) | FR_DIALOGTERM);
          if (emu.registerWindowMessage) {
            const msgId = emu.registerWindowMessage(FINDMSGSTRING);
            emu.postMessage(hwndOwner, msgId, 0, emu.findReplacePtr);
          }
          emu.findReplacePtr = 0;
        }
        emu.handles.free(findDlgHwnd);
      },
    });

    return findDlgHwnd;
  });
  comdlg32.register('PrintDlgExW', 1, () => 1); // E_FAIL
  // BOOL PrintDlgA(LPPRINTDLGA lppd) — return FALSE (user cancelled)
  comdlg32.register('PrintDlgA', 1, () => 0);
  comdlg32.register('PrintDlgW', 1, () => 0);
  comdlg32.register('GetFileTitleA', 3, () => {
    const lpszFile = emu.readArg(0);
    const lpszTitle = emu.readArg(1);
    const cchSize = emu.readArg(2);
    if (!lpszFile) return -1;
    const fullPath = emu.memory.readCString(lpszFile);
    const lastSep = Math.max(fullPath.lastIndexOf('\\'), fullPath.lastIndexOf('/'));
    const title = lastSep >= 0 ? fullPath.substring(lastSep + 1) : fullPath;
    if (!lpszTitle || cchSize === 0) return title.length + 1;
    const toWrite = title.substring(0, cchSize - 1);
    for (let i = 0; i < toWrite.length; i++) {
      emu.memory.writeU8(lpszTitle + i, toWrite.charCodeAt(i) & 0xFF);
    }
    emu.memory.writeU8(lpszTitle + toWrite.length, 0);
    return 0;
  });
  comdlg32.register('GetFileTitleW', 3, () => {
    const lpszFile = emu.readArg(0);
    const lpszTitle = emu.readArg(1);
    const cchSize = emu.readArg(2);
    if (!lpszFile) return -1;
    const fullPath = emu.memory.readUTF16String(lpszFile);
    // Extract filename from path (after last \ or /)
    const lastSep = Math.max(fullPath.lastIndexOf('\\'), fullPath.lastIndexOf('/'));
    const title = lastSep >= 0 ? fullPath.substring(lastSep + 1) : fullPath;
    if (!lpszTitle || cchSize === 0) return title.length + 1;
    const toWrite = title.substring(0, cchSize - 1);
    for (let i = 0; i < toWrite.length; i++) {
      emu.memory.writeU16(lpszTitle + i * 2, toWrite.charCodeAt(i));
    }
    emu.memory.writeU16(lpszTitle + toWrite.length * 2, 0);
    return 0;
  });
  comdlg32.register('PageSetupDlgW', 1, () => 0);
  comdlg32.register('CommDlgExtendedError', 0, () => 0);
}
