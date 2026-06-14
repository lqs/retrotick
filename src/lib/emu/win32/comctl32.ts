import type { Emulator } from '../emulator';
import { decodeDib } from '../../pe/decode-dib';
import { rvaToFileOffset } from '../../pe/read';
import { getClientSize } from './user32/_helpers';
import type { BitmapInfo } from './gdi32/types';
import type { WindowInfo } from './user32/types';

export function registerComctl32(emu: Emulator): void {
  const comctl32 = emu.registerDll('COMCTL32.DLL');

  comctl32.register('InitCommonControlsEx', 1, () => 1);
  comctl32.register('InitCommonControls', 0, () => 0);

  // DllGetVersion(DLLVERSIONINFO* pdvi) — fills version info, returns S_OK.
  // MFC and many apps call this to detect which COMCTL32 features are available.
  // We report 6.0 (matching Windows XP+ visual styles era), which enables modern
  // common control APIs without requiring a manifest.
  comctl32.register('DllGetVersion', 1, () => {
    const pdvi = emu.readArg(0);
    if (!pdvi) return 0x80004003; // E_POINTER
    // DLLVERSIONINFO size at [0] tells us which version of the struct caller passed.
    // Both v1 (size=20) and v2 (size=32) start with cbSize, dwMajorVersion, dwMinorVersion,
    // dwBuildNumber, dwPlatformID; v2 adds dwFlags + szTimeStamp[16].
    emu.memory.writeU32(pdvi + 4, 6);    // dwMajorVersion = 6
    emu.memory.writeU32(pdvi + 8, 0);    // dwMinorVersion = 0
    emu.memory.writeU32(pdvi + 12, 6000); // dwBuildNumber
    emu.memory.writeU32(pdvi + 16, 1);   // dwPlatformID = DLLVER_PLATFORM_WINDOWS
    return 0; // S_OK
  });

  // ImageList_LoadImageW(hI, lpbmp, cx, cGrow, crMask, uType, uFlags) — return NULL (not supported)
  comctl32.register('ImageList_LoadImageW', 7, () => 0);

  // GetEffectiveClientRect(hWnd, lprc, lpInfo) - adjusts client rect for toolbar/status bar
  // Returns client rect minus space taken by toolbars/status bars listed in lpInfo
  comctl32.register('GetEffectiveClientRect', 3, () => {
    const hWnd = emu.readArg(0);
    const lprc = emu.readArg(1);
    const _lpInfo = emu.readArg(2);
    if (lprc) {
      const wnd = emu.handles.get<WindowInfo>(hWnd);
      if (wnd) {
        const { cw, ch } = getClientSize(wnd.style, wnd.hMenu !== 0, wnd.width, wnd.height);
        // Subtract space for status bar (child windows at bottom)
        let statusBarH = 0;
        for (const [, child] of emu.handles.findByType<WindowInfo>('window')) {
          if (child && child.parent === hWnd && child.classInfo?.className?.toUpperCase() === 'MSCTLS_STATUSBAR32') {
            statusBarH = child.height || 20;
          }
        }
        emu.memory.writeU32(lprc, 0);
        emu.memory.writeU32(lprc + 4, 0);
        emu.memory.writeU32(lprc + 8, cw);
        emu.memory.writeU32(lprc + 12, ch - statusBarH);
      } else {
        emu.memory.writeU32(lprc, 0);
        emu.memory.writeU32(lprc + 4, 0);
        emu.memory.writeU32(lprc + 8, 0);
        emu.memory.writeU32(lprc + 12, 0);
      }
    }
    return 0;
  });

  // CreateMappedBitmap(hInstance, idBitmap, wFlags, lpColorMap, iNumMaps)
  // Loads a bitmap resource and optionally remaps colors
  comctl32.register('CreateMappedBitmap', 5, () => {
    const _hInstance = emu.readArg(0);
    const idBitmap = emu.readArg(1);
    const _wFlags = emu.readArg(2);
    const _lpColorMap = emu.readArg(3);
    const _iNumMaps = emu.readArg(4);

    // Find the bitmap resource
    const entry = emu.findResourceEntry(2, idBitmap); // RT_BITMAP = 2
    if (!entry) {
      console.warn(`[COMCTL32] CreateMappedBitmap: resource ${idBitmap} not found`);
      return 0;
    }

    try {
      let fileOffset: number;
      try {
        fileOffset = rvaToFileOffset(entry.dataRva, emu.peInfo.sections);
      } catch {
        fileOffset = entry.dataRva;
      }
      const dibData = new Uint8Array(emu.arrayBuffer, fileOffset, entry.dataSize);
      const decoded = decodeDib(dibData);
      // Remap standard Windows control colors to current system colors
      // Default COLORMAP table used by CreateMappedBitmap:
      //   #000000 (btntext)      → COLOR_BTNTEXT      = #000000
      //   #808080 (btnshadow)    → COLOR_BTNSHADOW    = #808080
      //   #C0C0C0 (btnface)      → COLOR_BTNFACE      = #D4D0C8
      //   #FFFFFF (btnhighlight) → COLOR_BTNHIGHLIGHT  = #FFFFFF
      //   #000080 (highlight)    → COLOR_HIGHLIGHT     = #0A246A
      //   #00FFFF (window)       → COLOR_WINDOW        = #FFFFFF
      const colorMap: [number, number, number, number, number, number][] = [
        [0xC0, 0xC0, 0xC0, 0xD4, 0xD0, 0xC8], // btnface
        [0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF], // window (cyan → white)
        [0x00, 0x00, 0x80, 0x0A, 0x24, 0x6A], // highlight
      ];
      const imgData = decoded.ctx.getImageData(0, 0, decoded.width, decoded.height);
      const px = imgData.data;
      for (let i = 0; i < px.length; i += 4) {
        for (const [fR, fG, fB, tR, tG, tB] of colorMap) {
          if (px[i] === fR && px[i + 1] === fG && px[i + 2] === fB) {
            px[i] = tR; px[i + 1] = tG; px[i + 2] = tB;
            break;
          }
        }
      }
      decoded.ctx.putImageData(imgData, 0, 0);
      const bmp: BitmapInfo = { width: decoded.width, height: decoded.height, canvas: decoded.canvas, ctx: decoded.ctx };
      const handle = emu.handles.alloc('bitmap', bmp);
      console.log(`[COMCTL32] CreateMappedBitmap: id=${idBitmap} ${decoded.width}x${decoded.height} → handle 0x${handle.toString(16)}`);
      return handle;
    } catch (e: unknown) {
      console.warn(`[COMCTL32] CreateMappedBitmap failed: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    }
  });

  // ImageList stubs
  comctl32.register('ImageList_Create', 5, () => {
    const _cx = emu.readArg(0);
    const _cy = emu.readArg(1);
    return emu.handles.alloc('imagelist', { images: [] as (string | undefined)[] });
  });
  comctl32.register('ImageList_Destroy', 1, () => 1);
  comctl32.register('ImageList_GetImageCount', 1, () => {
    const himl = emu.readArg(0);
    const il = emu.handles.get<{ images: (string | undefined)[] }>(himl);
    return il?.images?.length ?? 0;
  });
  comctl32.register('ImageList_Add', 3, () => 0);
  comctl32.register('ImageList_ReplaceIcon', 3, () => {
    const himl = emu.readArg(0);
    const i = emu.readArg(1) | 0; // -1 = append
    const hIcon = emu.readArg(2);
    const il = emu.handles.get<{ images: (string | undefined)[] }>(himl);
    const icon = emu.handles.get<{ dataUrl?: string }>(hIcon);
    const dataUrl = icon?.dataUrl;
    if (il?.images) {
      if (i === -1) {
        il.images.push(dataUrl);
        return il.images.length - 1;
      }
      il.images[i] = dataUrl;
      return i;
    }
    return i === -1 ? 0 : i;
  });
  comctl32.register('ImageList_Replace', 4, () => 1);
  comctl32.register('ImageList_SetBkColor', 2, () => 0);
  comctl32.register('ImageList_GetBkColor', 1, () => 0);
  comctl32.register('ImageList_Draw', 6, () => 1);
  comctl32.register('ImageList_DrawEx', 10, () => 1);
  comctl32.register('ImageList_AddMasked', 3, () => 0);
  comctl32.register('ImageList_Remove', 2, () => 1);
  comctl32.register('ImageList_BeginDrag', 4, () => 1);
  comctl32.register('ImageList_EndDrag', 0, () => 0);
  comctl32.register('ImageList_DragEnter', 3, () => 1);
  comctl32.register('ImageList_DragLeave', 1, () => 1);
  comctl32.register('ImageList_DragMove', 2, () => 1);
  comctl32.register('ImageList_SetDragCursorImage', 4, () => 1);
  comctl32.register('ImageList_DragShowNolock', 1, () => 1);
  comctl32.register('ImageList_GetDragImage', 2, () => 0);
  comctl32.register('ImageList_GetIconSize', 3, () => {
    const cxPtr = emu.readArg(1);
    const cyPtr = emu.readArg(2);
    if (cxPtr) emu.memory.writeU32(cxPtr, 16);
    if (cyPtr) emu.memory.writeU32(cyPtr, 16);
    return 1;
  });
  comctl32.register('ImageList_SetIconSize', 3, () => 1);
  comctl32.register('ImageList_GetImageInfo', 3, () => 0);
  comctl32.register('ImageList_Write', 2, () => 0);
  comctl32.register('ImageList_Read', 1, () => 0);

  // PropertySheetA/W — stub: return 0 (user cancelled)
  comctl32.register('PropertySheetA', 1, () => 0);
  comctl32.register('PropertySheetW', 1, () => 0);

  // CreateToolbarEx(hwnd, ws, wID, nBitmaps, hBMInst, wBMID, lpButtons, iNumButtons,
  //                 dxButton, dyButton, dxBitmap, dyBitmap, uStructSize) → HWND
  // Creates a toolbar window and adds buttons to it
  comctl32.register('CreateToolbarEx', 13, () => {
    const hwndParent = emu.readArg(0);
    const ws = emu.readArg(1);
    const wID = emu.readArg(2);
    const nBitmaps = emu.readArg(3);
    const hBMInst = emu.readArg(4);
    const wBMID = emu.readArg(5);
    const lpButtons = emu.readArg(6);
    const iNumButtons = emu.readArg(7);
    const dxButton = emu.readArg(8);
    const dyButton = emu.readArg(9);
    const dxBitmap = emu.readArg(10);
    const dyBitmap = emu.readArg(11);
    const uStructSize = emu.readArg(12);

    const parentWnd = emu.handles.get<WindowInfo>(hwndParent);
    const parentWidth = parentWnd?.width || 320;
    const btnW = dxButton || 24;
    const btnH = dyButton || 22;
    const toolbarH = btnH + 6; // button height + padding

    // Read TBBUTTON array (each struct is uStructSize bytes, minimum 20)
    const structSize = uStructSize || 20;
    const buttons: { iBitmap: number; idCommand: number; fsState: number; fsStyle: number }[] = [];
    if (lpButtons && iNumButtons > 0) {
      for (let i = 0; i < iNumButtons; i++) {
        const base = lpButtons + i * structSize;
        const iBitmap = emu.memory.readU32(base) | 0;
        const idCommand = emu.memory.readU32(base + 4) | 0;
        const fsState = emu.memory.readU8(base + 8);
        const fsStyle = emu.memory.readU8(base + 9);
        buttons.push({ iBitmap, idCommand, fsState, fsStyle });
      }
    }

    // Load toolbar bitmap from resource if hBMInst is not HINST_COMMCTRL (-1)
    const HINST_COMMCTRL = 0xFFFFFFFF;
    let toolbarBitmap: BitmapInfo | null = null;
    if (hBMInst !== HINST_COMMCTRL && wBMID) {
      const entry = emu.findResourceEntry(2, wBMID); // RT_BITMAP = 2
      if (entry) {
        try {
          let fileOffset: number;
          try {
            fileOffset = rvaToFileOffset(entry.dataRva, emu.peInfo.sections);
          } catch {
            fileOffset = entry.dataRva;
          }
          const dibData = new Uint8Array(emu.arrayBuffer, fileOffset, entry.dataSize);
          const decoded = decodeDib(dibData);
          toolbarBitmap = { width: decoded.width, height: decoded.height, canvas: decoded.canvas, ctx: decoded.ctx };
        } catch (e: unknown) {
          console.warn(`[COMCTL32] CreateToolbarEx: failed to load bitmap ${wBMID}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    const WS_VISIBLE = 0x10000000;
    const wnd: WindowInfo = {
      hwnd: 0,
      classInfo: { className: 'ToolbarWindow32', style: 0, wndProc: 0, cbClsExtra: 0, cbWndExtra: 0, hInstance: 0, hIcon: 0, hCursor: 0, hbrBackground: 0, menuName: 0 },
      wndProc: 0, parent: hwndParent,
      x: 0, y: 0, width: parentWidth, height: toolbarH,
      style: ws | 0x40000000, exStyle: 0, title: '', visible: !!(ws & WS_VISIBLE),
      hMenu: 0, extraBytes: new Uint8Array(8), userData: 0, controlId: wID,
    };
    const hwnd = emu.handles.alloc('window', wnd);
    wnd.hwnd = hwnd;
    if (parentWnd) {
      if (!parentWnd.children) parentWnd.children = new Map();
      parentWnd.children.set(wID, hwnd);
      if (!parentWnd.childList) parentWnd.childList = [];
      parentWnd.childList.push(hwnd);
    }
    console.log(`[COMCTL32] CreateToolbarEx: ${iNumButtons} buttons, ${btnW}x${btnH}, bitmap=${wBMID} → handle 0x${hwnd.toString(16)}`);
    return hwnd;
  });

  // CreateStatusWindowW(style, lpszText, hwndParent, wID) → HWND
  comctl32.register('CreateStatusWindowW', 4, () => {
    const style = emu.readArg(0);
    const lpszText = emu.readArg(1);
    const hwndParent = emu.readArg(2);
    const wID = emu.readArg(3);
    const text = lpszText ? emu.memory.readUTF16String(lpszText) : '';
    const parentWnd = emu.handles.get<WindowInfo>(hwndParent);
    const parentCh = parentWnd ? getClientSize(parentWnd.style, parentWnd.hMenu !== 0, parentWnd.width, parentWnd.height).ch : 240;
    const statusH = 20;
    const wnd: WindowInfo = {
      hwnd: 0,
      classInfo: { className: 'msctls_statusbar32', style: 0, wndProc: 0, cbClsExtra: 0, cbWndExtra: 0, hInstance: 0, hIcon: 0, hCursor: 0, hbrBackground: 0, menuName: 0 },
      wndProc: 0, parent: hwndParent,
      x: 0, y: parentCh - statusH, width: parentWnd?.width || 320, height: statusH,
      style: style | 0x40000000, exStyle: 0, title: text, visible: !!(style & 0x10000000),
      hMenu: 0, extraBytes: new Uint8Array(0), userData: 0, controlId: wID,
      statusTexts: text ? [text] : [],
    };
    const hwnd = emu.handles.alloc('window', wnd);
    wnd.hwnd = hwnd;
    if (parentWnd) {
      if (!parentWnd.children) parentWnd.children = new Map();
      parentWnd.children.set(wID, hwnd);
      if (!parentWnd.childList) parentWnd.childList = [];
      parentWnd.childList.push(hwnd);
    }
    return hwnd;
  });

  // MenuHelp(uMsg, wParam, lParam, hMainMenu, hInst, hwndStatus, lpwIDs) — 7 args
  comctl32.register('MenuHelp', 7, () => {});

  // FlatSB stubs
  comctl32.register('InitializeFlatSB', 1, () => 0); // S_OK
  comctl32.register('FlatSB_SetScrollInfo', 4, () => 0);
  comctl32.register('FlatSB_GetScrollInfo', 3, () => 0);
  comctl32.register('FlatSB_SetScrollProp', 4, () => 1);
  comctl32.register('FlatSB_SetScrollPos', 4, () => 0);
  comctl32.register('FlatSB_GetScrollPos', 2, () => 0);

  // _TrackMouseEvent(lpEventTrack) → BOOL
  comctl32.register('_TrackMouseEvent', 1, () => 1);

  // Additional ImageList stubs
  comctl32.register('ImageList_SetImageCount', 2, () => 1);
  comctl32.register('ImageList_Copy', 5, () => 1);
  comctl32.register('ImageList_GetIcon', 3, () => 0); // return NULL icon
  comctl32.register('ImageList_SetOverlayImage', 3, () => 1);
}
