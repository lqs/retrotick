import type { Emulator } from '../../emulator';
import type { WindowInfo } from './types';
import { getClientSize, clientSizeOf, computeNcInset, clampToMinTrackSize, invalidateForResize } from './_helpers';
import { emuCompleteThunk } from '../../emu-exec';
import { launchHelpFile } from '../../help-launcher';
import {
  SM_CXSCREEN, SM_CYSCREEN, SM_CYMENU, SM_CYCAPTION, SM_CXBORDER, SM_CYBORDER,
  SM_CXFRAME, SM_CYFRAME, SM_CXEDGE, SM_CYEDGE, SM_CXFIXEDFRAME, SM_CYFIXEDFRAME,
  SM_CXSIZE, SM_CYSIZE,
  SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
  SYS_COLORS,
} from '../types';

interface DeferWindowPosEntry { hWnd: number; x: number; y: number; cx: number; cy: number; uFlags: number }
interface DeferWindowPosInfo { entries: DeferWindowPosEntry[] }

export function registerMisc(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  // GetDoubleClickTime() — returns milliseconds
  user32.register('GetDoubleClickTime', 0, () => 500);

  // DragObject(hwndParent, hwndFrom, wFmt, dwData, hcur) — 5 args
  user32.register('DragObject', 5, () => 0);

  // NotifyWinEvent(event, hwnd, idObject, idChild) — accessibility notification, no-op
  user32.register('NotifyWinEvent', 4, () => 0);

  // System metrics
  user32.register('GetSystemMetrics', 1, () => {
    const idx = emu.readArg(0);
    switch (idx) {
      case SM_CXSCREEN: return emu.screenWidth;
      case SM_CYSCREEN: return emu.screenHeight;
      case SM_CYMENU: return 19;
      case SM_CYCAPTION: return 18;
      case SM_CXBORDER: case SM_CYBORDER: return 1;
      case SM_CXEDGE: case SM_CYEDGE: return 2;
      case SM_CXFRAME: case SM_CYFRAME: return 4;
      case SM_CXFIXEDFRAME: case SM_CYFIXEDFRAME: return 3;
      case SM_CXSIZE: case SM_CYSIZE: return 18;
      case SM_XVIRTUALSCREEN: case SM_YVIRTUALSCREEN: return 0;
      case SM_CXVIRTUALSCREEN: return emu.screenWidth;
      case SM_CYVIRTUALSCREEN: return emu.screenHeight;
      default: return 0;
    }
  });

  // GetDialogBaseUnits: low word = avg char width, high word = char height
  user32.register('GetDialogBaseUnits', 0, () => (13 << 16) | 7);

  // GetSysColor
  user32.register('GetSysColor', 1, () => {
    const idx = emu.readArg(0);
    return SYS_COLORS[idx] || 0;
  });

  user32.register('GetSysColorBrush', 1, () => {
    const idx = emu.readArg(0);
    const color = SYS_COLORS[idx] ?? SYS_COLORS[15]; // COLOR_BTNFACE fallback
    return emu.handles.alloc('brush', { color, isNull: false });
  });

  // MessageBoxA
  user32.register('MessageBoxA', 4, () => {
    const _hwnd = emu.readArg(0);
    const textPtr = emu.readArg(1);
    const captionPtr = emu.readArg(2);
    const type = emu.readArg(3);

    const text = textPtr ? emu.memory.readCString(textPtr) : '';
    const caption = captionPtr ? emu.memory.readCString(captionPtr) : '';
    console.log(`[MessageBoxA] "${caption}": ${text} (type=0x${type.toString(16)})`);

    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    emu.showMessageBox(caption, text, type, result => {
      emu.waitingForMessage = false;
      emuCompleteThunk(emu, result, stackBytes);
      if (emu.running && !emu.halted) {
        requestAnimationFrame(emu.tick);
      }
    });
    return undefined;
  });

  // MessageBoxW
  user32.register('MessageBoxW', 4, () => {
    const _hwnd = emu.readArg(0);
    const textPtr = emu.readArg(1);
    const captionPtr = emu.readArg(2);
    const type = emu.readArg(3);

    const text = textPtr ? emu.memory.readUTF16String(textPtr) : '';
    const caption = captionPtr ? emu.memory.readUTF16String(captionPtr) : '';
    console.log(`[MessageBoxW] "${caption}": ${text} (type=0x${type.toString(16)})`);

    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    emu.showMessageBox(caption, text, type, result => {
      emu.waitingForMessage = false;
      emuCompleteThunk(emu, result, stackBytes);
      if (emu.running && !emu.halted) {
        requestAnimationFrame(emu.tick);
      }
    });
    return undefined;
  });

  user32.register('MessageBeep', 1, () => 1);

  // Client origin in screen coords — walks parent chain
  const WS_CHILD = 0x40000000;
  const clientOrigin = (wnd: WindowInfo | null): { x: number; y: number } => {
    if (!wnd) return { x: 0, y: 0 }; // desktop/screen
    // A custom WM_NCCALCSIZE margin insets the client origin within the window
    const il = wnd.ncInset?.l ?? 0, it = wnd.ncInset?.t ?? 0;
    if (wnd.style & WS_CHILD) {
      const parentWnd = wnd.parent ? emu.handles.get<WindowInfo>(wnd.parent) : null;
      const parentOrigin = clientOrigin(parentWnd);
      return { x: parentOrigin.x + wnd.x + il, y: parentOrigin.y + wnd.y + it };
    }
    // Top-level window: account for border and caption
    const { cw, ch } = getClientSize(wnd.style, wnd.hMenu !== 0, wnd.width, wnd.height);
    const bw = (wnd.width - cw) / 2;
    const topH = wnd.height - ch - bw;
    return { x: wnd.x + bw, y: wnd.y + topH };
  };

  user32.register('MapWindowPoints', 4, () => {
    const hwndFrom = emu.readArg(0);
    const hwndTo = emu.readArg(1);
    const pPoints = emu.readArg(2);
    const cPoints = emu.readArg(3);
    const fromWnd = hwndFrom ? emu.handles.get<WindowInfo>(hwndFrom) : null;
    const toWnd = hwndTo ? emu.handles.get<WindowInfo>(hwndTo) : null;
    const from = clientOrigin(fromWnd);
    const to = clientOrigin(toWnd);
    const dx = from.x - to.x;
    const dy = from.y - to.y;
    for (let i = 0; i < cPoints; i++) {
      const addr = pPoints + i * 8;
      emu.memory.writeU32(addr, (emu.memory.readI32(addr) + dx) | 0);
      emu.memory.writeU32(addr + 4, (emu.memory.readI32(addr + 4) + dy) | 0);
    }
    return ((dx & 0xFFFF) | ((dy & 0xFFFF) << 16)) >>> 0;
  });
  user32.register('ScreenToClient', 2, () => {
    const hwnd = emu.readArg(0);
    const pPoint = emu.readArg(1);
    const wnd = hwnd ? emu.handles.get<WindowInfo>(hwnd) : null;
    const origin = clientOrigin(wnd);
    emu.memory.writeU32(pPoint, (emu.memory.readI32(pPoint) - origin.x) | 0);
    emu.memory.writeU32(pPoint + 4, (emu.memory.readI32(pPoint + 4) - origin.y) | 0);
    return 1;
  });
  user32.register('ClientToScreen', 2, () => {
    const hwnd = emu.readArg(0);
    const pPoint = emu.readArg(1);
    const wnd = hwnd ? emu.handles.get<WindowInfo>(hwnd) : null;
    const origin = clientOrigin(wnd);
    emu.memory.writeU32(pPoint, (emu.memory.readI32(pPoint) + origin.x) | 0);
    emu.memory.writeU32(pPoint + 4, (emu.memory.readI32(pPoint + 4) + origin.y) | 0);
    return 1;
  });
  const systemParametersInfo = () => {
    const uiAction = emu.readArg(0);
    const _uiParam = emu.readArg(1);
    const pvParam = emu.readArg(2);
    const SPI_GETWORKAREA = 0x30;
    const SPI_GETNONCLIENTMETRICS = 0x29;
    if (uiAction === SPI_GETWORKAREA && pvParam) {
      // RECT { left, top, right, bottom }
      emu.memory.writeU32(pvParam, 0);      // left
      emu.memory.writeU32(pvParam + 4, 0);  // top
      emu.memory.writeU32(pvParam + 8, emu.screenWidth);   // right
      emu.memory.writeU32(pvParam + 12, emu.screenHeight); // bottom
      return 1;
    }
    return 0;
  };
  user32.register('SystemParametersInfoA', 4, systemParametersInfo);
  user32.register('SystemParametersInfoW', 4, systemParametersInfo);
  user32.register('FlashWindow', 2, () => 0);
  // WINDOWPLACEMENT: length(4) flags(4) showCmd(4) ptMinPosition(8) ptMaxPosition(8) rcNormalPosition(16) = 44 bytes
  user32.register('GetWindowPlacement', 2, () => {
    const hwnd = emu.readArg(0);
    const lpWndPl = emu.readArg(1);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (!wnd || !lpWndPl) return 0;
    const x = wnd.x || 0, y = wnd.y || 0;
    const w = wnd.width || 0, h = wnd.height || 0;
    emu.memory.writeU32(lpWndPl + 0, 44);      // length
    emu.memory.writeU32(lpWndPl + 4, 0);        // flags
    emu.memory.writeU32(lpWndPl + 8, 1);        // showCmd = SW_SHOWNORMAL
    emu.memory.writeU32(lpWndPl + 12, 0);       // ptMinPosition.x
    emu.memory.writeU32(lpWndPl + 16, 0);       // ptMinPosition.y
    emu.memory.writeU32(lpWndPl + 20, 0);       // ptMaxPosition.x
    emu.memory.writeU32(lpWndPl + 24, 0);       // ptMaxPosition.y
    emu.memory.writeU32(lpWndPl + 28, x);       // rcNormalPosition.left
    emu.memory.writeU32(lpWndPl + 32, y);       // rcNormalPosition.top
    emu.memory.writeU32(lpWndPl + 36, x + w);   // rcNormalPosition.right
    emu.memory.writeU32(lpWndPl + 40, y + h);   // rcNormalPosition.bottom
    return 1;
  });
  user32.register('SetWindowPlacement', 2, () => 1);
  // WinHelp(hWndMain, lpszHelp, uCommand, dwData) → BOOL.
  // HELP_QUIT closes any active help window — we have no hwnd-tracking tie
  // back to the emulator, so just no-op (the user can close the viewer).
  // Any other command is treated as "open this file" — the in-page help
  // viewer doesn't navigate to a context/keyword across sessions.
  const HELP_QUIT = 0x0002;
  user32.register('WinHelpA', 4, () => {
    const _hwnd = emu.readArg(0);
    const lpszHelp = emu.readArg(1);
    const uCommand = emu.readArg(2);
    const _dwData = emu.readArg(3);
    if (uCommand === HELP_QUIT) return 1;
    const fileName = lpszHelp ? emu.memory.readCString(lpszHelp) : '';
    if (fileName) launchHelpFile(emu, fileName);
    return 1;
  });
  user32.register('WinHelpW', 4, () => {
    const _hwnd = emu.readArg(0);
    const lpszHelp = emu.readArg(1);
    const uCommand = emu.readArg(2);
    const _dwData = emu.readArg(3);
    if (uCommand === HELP_QUIT) return 1;
    const fileName = lpszHelp ? emu.memory.readUTF16String(lpszHelp) : '';
    if (fileName) launchHelpFile(emu, fileName);
    return 1;
  });
  user32.register('ShowOwnedPopups', 2, () => 1);
  user32.register('GetLastActivePopup', 1, () => emu.readArg(0));
  user32.register('WaitForInputIdle', 2, () => 0);
  user32.register('SetProcessDefaultLayout', 1, () => 1);
  user32.register('GetProcessDefaultLayout', 1, () => {
    const ptr = emu.readArg(0);
    if (ptr) emu.memory.writeU32(ptr, 0); // LTR
    return 1;
  });
  user32.register('GetWindowRgn', 2, () => 0); // ERROR
  user32.register('SetWindowRgn', 3, () => 1);

  // SetMessageQueue(cMessagesMax) → BOOL — obsolete Win16 holdover, just succeed
  user32.register('SetMessageQueue', 1, () => 1);

  // GetMenuCheckMarkDimensions: low=width, high=height of checkmark bitmap (13x13 typical)
  user32.register('GetMenuCheckMarkDimensions', 0, () => (13 << 16) | 13);
  user32.register('GetTopWindow', 1, () => {
    const hwnd = emu.readArg(0);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (wnd && wnd.childList && wnd.childList.length > 0) {
      return wnd.childList[0];
    }
    return 0;
  });
  user32.register('GrayStringA', 9, () => 1);
  user32.register('TabbedTextOutA', 8, () => 0);

  // GetThreadDesktop(dwThreadId) → HDESK handle
  user32.register('GetThreadDesktop', 1, () => {
    const _threadId = emu.readArg(0);
    return emu.handles.alloc('desktop', {});
  });

  // BeginDeferWindowPos(nNumWindows) → HDWP handle
  user32.register('BeginDeferWindowPos', 1, () => {
    const _nNumWindows = emu.readArg(0);
    return emu.handles.alloc('dwp', { entries: [] as DeferWindowPosEntry[] });
  });

  // DeferWindowPos(hWinPosInfo, hWnd, hWndInsertAfter, x, y, cx, cy, uFlags) → HDWP
  user32.register('DeferWindowPos', 8, () => {
    const hWinPosInfo = emu.readArg(0);
    const hWnd = emu.readArg(1);
    const _hWndInsertAfter = emu.readArg(2);
    const x = emu.readArg(3) | 0;
    const y = emu.readArg(4) | 0;
    const cx = emu.readArg(5);
    const cy = emu.readArg(6);
    const uFlags = emu.readArg(7);
    const dwp = emu.handles.get<DeferWindowPosInfo>(hWinPosInfo);
    if (dwp && dwp.entries) {
      dwp.entries.push({ hWnd, x, y, cx, cy, uFlags });
    }
    return hWinPosInfo;
  });

  // EndDeferWindowPos(hWinPosInfo) → BOOL
  user32.register('EndDeferWindowPos', 1, () => {
    const hWinPosInfo = emu.readArg(0);
    const dwp = emu.handles.get<DeferWindowPosInfo>(hWinPosInfo);
    if (dwp && dwp.entries) {
      const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2;
      for (const e of dwp.entries) {
        const wnd = emu.handles.get<WindowInfo>(e.hWnd);
        if (!wnd) continue;
        let sizeChanged = false;
        if (!(e.uFlags & SWP_NOMOVE)) {
          wnd.x = e.x; wnd.y = e.y;
        }
        if (!(e.uFlags & SWP_NOSIZE)) {
          const clamped = clampToMinTrackSize(emu, e.hWnd, wnd, e.cx, e.cy);
          if (wnd.width !== clamped.w || wnd.height !== clamped.h) sizeChanged = true;
          wnd.width = clamped.w; wnd.height = clamped.h;
        }
        if (sizeChanged && wnd.wndProc) {
          computeNcInset(emu, e.hWnd, wnd);
          const cs = clientSizeOf(wnd);
          const lParam = ((cs.ch & 0xFFFF) << 16) | (cs.cw & 0xFFFF);
          emu.callWndProc(wnd.wndProc, e.hWnd, 0x0005, 0, lParam); // WM_SIZE
        }
        // Invalidate the full new client so a stale partial invalidRect captured
        // at the previous size can't leave part of the client unpainted.
        invalidateForResize(emu, wnd);
      }
      // Fix up MFC dock bars that have 0 size but visible children.
      // MFC's CDockBar::OnSizeParent may fail to claim space if its internal
      // m_arrBars is not properly populated, leaving dock bars with 0 height/width
      // while their child control bars have real dimensions.
      const AFX_IDW_DOCKBAR_TOP = 0xE81B;
      const AFX_IDW_DOCKBAR_LEFT = 0xE81C;
      const AFX_IDW_DOCKBAR_RIGHT = 0xE81D;
      const AFX_IDW_DOCKBAR_BOTTOM = 0xE81E;

      // Collect all entries by hwnd for easy lookup
      const entryByHwnd = new Map<number, DeferWindowPosEntry>();
      for (const e of dwp.entries) entryByHwnd.set(e.hWnd, e);

      for (const e of dwp.entries) {
        const wnd = emu.handles.get<WindowInfo>(e.hWnd);
        if (!wnd || !wnd.childList || wnd.childList.length === 0) continue;
        const ctrlId = wnd.controlId ?? 0;
        if (ctrlId < AFX_IDW_DOCKBAR_TOP || ctrlId > AFX_IDW_DOCKBAR_BOTTOM) continue;

        const isHorz = ctrlId === AFX_IDW_DOCKBAR_TOP || ctrlId === AFX_IDW_DOCKBAR_BOTTOM;
        const barDim = isHorz ? wnd.height : wnd.width;
        if (barDim > 0) continue; // already has size, skip

        // Find max child dimension
        let maxDim = 0;
        for (const childHwnd of wnd.childList) {
          const child = emu.handles.get<WindowInfo>(childHwnd);
          if (child && child.visible) {
            maxDim = Math.max(maxDim, isHorz ? child.height : child.width);
          }
        }
        if (maxDim === 0) continue;

        // Expand the dock bar and adjust sibling windows
        if (ctrlId === AFX_IDW_DOCKBAR_BOTTOM) {
          wnd.y -= maxDim;
          wnd.height = maxDim;
          // Shrink siblings that now overlap
          for (const e2 of dwp.entries) {
            const w2 = emu.handles.get<WindowInfo>(e2.hWnd);
            if (!w2 || w2 === wnd) continue;
            if (w2.y + w2.height > wnd.y && w2.y < wnd.y) {
              w2.height = wnd.y - w2.y;
            }
          }
        } else if (ctrlId === AFX_IDW_DOCKBAR_TOP) {
          wnd.height = maxDim;
          for (const e2 of dwp.entries) {
            const w2 = emu.handles.get<WindowInfo>(e2.hWnd);
            if (!w2 || w2 === wnd) continue;
            if (w2.y < maxDim) {
              const shift = maxDim - w2.y;
              w2.y += shift;
              w2.height = Math.max(0, w2.height - shift);
            }
          }
        } else if (ctrlId === AFX_IDW_DOCKBAR_LEFT) {
          wnd.width = maxDim;
          for (const e2 of dwp.entries) {
            const w2 = emu.handles.get<WindowInfo>(e2.hWnd);
            if (!w2 || w2 === wnd) continue;
            const wCtrl = w2.controlId ?? 0;
            if (wCtrl >= AFX_IDW_DOCKBAR_TOP && wCtrl <= AFX_IDW_DOCKBAR_BOTTOM) continue;
            if (w2.x < maxDim) {
              const shift = maxDim - w2.x;
              w2.x += shift;
              w2.width = Math.max(0, w2.width - shift);
            }
          }
        } else if (ctrlId === AFX_IDW_DOCKBAR_RIGHT) {
          wnd.x -= maxDim;
          wnd.width = maxDim;
          for (const e2 of dwp.entries) {
            const w2 = emu.handles.get<WindowInfo>(e2.hWnd);
            if (!w2 || w2 === wnd) continue;
            const wCtrl = w2.controlId ?? 0;
            if (wCtrl >= AFX_IDW_DOCKBAR_TOP && wCtrl <= AFX_IDW_DOCKBAR_BOTTOM) continue;
            if (w2.x + w2.width > wnd.x) {
              w2.width = wnd.x - w2.x;
            }
          }
        }
      }

      // Reserve a bottom status bar's height. MFC's RepositionBars sometimes
      // lays out the bottom dock bar and the side docks/view against the full
      // client height without subtracting a bottom status bar, so they extend
      // underneath it (the palette/F-keys end up partly hidden by the status
      // bar). Pull the bottom dock up to rest on the status bar, then clamp the
      // side docks / view to sit above it. Do this BEFORE the vertical-fill pass
      // so a filled side pane uses the corrected (shorter) dock height.
      {
        const mainW = emu.handles.get<WindowInfo>(emu.mainWindow);
        if (mainW?.childList) {
          let statusTop = Infinity, statusHwnd = 0;
          for (const ch of mainW.childList) {
            const c = emu.handles.get<WindowInfo>(ch);
            if (c?.visible && (c.classInfo?.className ?? '').toUpperCase() === 'MSCTLS_STATUSBAR32' && c.y < statusTop) {
              statusTop = c.y; statusHwnd = ch;
            }
          }
          if (statusHwnd && statusTop < Infinity) {
            let limit = statusTop;
            // Move the bottom dock up so it ends exactly at the status bar top.
            for (const ch of mainW.childList) {
              const c = emu.handles.get<WindowInfo>(ch);
              if (!c || !c.visible || (c.controlId ?? 0) !== AFX_IDW_DOCKBAR_BOTTOM) continue;
              if (c.y + c.height > statusTop) {
                c.y = statusTop - c.height;
                c.needsPaint = true; c.needsErase = true;
                for (const cc of c.childList ?? []) {
                  const w = emu.handles.get<WindowInfo>(cc);
                  if (w) { w.needsPaint = true; w.needsErase = true; }
                }
              }
              if (c.y < limit) limit = c.y;
            }
            // Clamp anything else that still reaches below the bottom dock top
            // (the view and the left/right side docks).
            for (const ch of mainW.childList) {
              if (ch === statusHwnd) continue;
              const c = emu.handles.get<WindowInfo>(ch);
              if (!c || !c.visible || (c.controlId ?? 0) === AFX_IDW_DOCKBAR_BOTTOM) continue;
              if (c.y < limit && c.y + c.height > limit) {
                c.height = limit - c.y;
                if (c.wndProc) computeNcInset(emu, ch, c);
                const cs = clientSizeOf(c);
                if (c.wndProc) {
                  emu.callWndProc(c.wndProc, ch, 0x0005, 0, ((cs.ch & 0xFFFF) << 16) | (cs.cw & 0xFFFF)); // WM_SIZE
                }
                invalidateForResize(emu, c);
              }
            }
          }
        }
      }

      // Stretch a sole "sizing" control bar to fill the HEIGHT of a left/right
      // dock bar (a docked preview/properties pane fills the whole side it's
      // docked to). Only LEFT/RIGHT (vertical) docks: a bar in a top/bottom
      // dock keeps its content width and sits side-by-side with others, so
      // stretching its width would wrongly make it span the whole edge.
      // Toolbars/status bars are excluded (they size to content). Only act when
      // the dock holds a single fillable child.
      const NON_FILL = new Set(['TOOLBARWINDOW32', 'MSCTLS_STATUSBAR32', 'REBARWINDOW32']);
      for (const e of dwp.entries) {
        const dock = emu.handles.get<WindowInfo>(e.hWnd);
        if (!dock || !dock.childList) continue;
        const ctrlId = dock.controlId ?? 0;
        if (ctrlId !== AFX_IDW_DOCKBAR_LEFT && ctrlId !== AFX_IDW_DOCKBAR_RIGHT) continue;
        const fillable = dock.childList
          .map((h) => [h, emu.handles.get<WindowInfo>(h)] as const)
          .filter(([, c]) => !!c && c.visible && !NON_FILL.has((c.classInfo?.className ?? '').toUpperCase()));
        if (fillable.length !== 1) continue;
        const [chwnd, child] = fillable[0];
        if (!child || dock.height <= child.height) continue; // already fills
        child.height = dock.height;
        if (child.wndProc) computeNcInset(emu, chwnd, child);
        const cs = clientSizeOf(child);
        if (child.wndProc) {
          emu.callWndProc(child.wndProc, chwnd, 0x0005, 0, ((cs.ch & 0xFFFF) << 16) | (cs.cw & 0xFFFF)); // WM_SIZE
        }
        invalidateForResize(emu, child);
      }

      // Also mark main window for repaint
      const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow);
      if (mainWnd) {
        mainWnd.needsPaint = true;
      }
    }
    emu.handles.free(hWinPosInfo);
    return 1;
  });

  // ChangeDisplaySettings[A/W](lpDevMode, dwFlags) → DISP_CHANGE_SUCCESSFUL
  user32.register('ChangeDisplaySettingsA', 2, () => 0); // DISP_CHANGE_SUCCESSFUL
  user32.register('ChangeDisplaySettingsW', 2, () => 0); // DISP_CHANGE_SUCCESSFUL

  // SetSysColors(cElements, lpaElements, lpaRgbValues) → BOOL
  user32.register('SetSysColors', 3, () => 1);

  user32.register('GetProcessWindowStation', 0, () => 0x1234);

  user32.register('GetUserObjectInformationW', 5, () => {
    const _hObj = emu.readArg(0);
    const nIndex = emu.readArg(1);
    const pvInfo = emu.readArg(2);
    const nLength = emu.readArg(3);
    const lpnLengthNeeded = emu.readArg(4);
    const UOI_FLAGS = 1;
    if (nIndex === UOI_FLAGS) {
      // USEROBJECTFLAGS { fInherit: BOOL, fReserved: BOOL, dwFlags: DWORD }
      if (pvInfo && nLength >= 12) {
        emu.memory.writeU32(pvInfo, 0);     // fInherit
        emu.memory.writeU32(pvInfo + 4, 0); // fReserved
        emu.memory.writeU32(pvInfo + 8, 1); // dwFlags = WSF_VISIBLE
      }
      if (lpnLengthNeeded) emu.memory.writeU32(lpnLengthNeeded, 12);
      return 1;
    }
    return 0;
  });

  // FindWindow(class, title) → HWND of top-level window matching both names
  // (NULL on either means "any"). Single-instance apps call this on startup
  // to detect a running peer; if we always return 0 they can't reuse that
  // peer's window (mostly harmless), but apps that talk to the shell taskbar
  // or system tray via FindWindow get a stub-0 and silently skip the call.
  const findWindowImpl = (wide: boolean) => (): number => {
    const classPtr = emu.readArg(0);
    const titlePtr = emu.readArg(1);
    const wantClass = !classPtr ? null
      : classPtr < 0x10000 ? `#${classPtr}` // atom
      : (wide ? emu.memory.readUTF16String(classPtr) : emu.memory.readCString(classPtr));
    const wantTitle = !titlePtr ? null
      : (wide ? emu.memory.readUTF16String(titlePtr) : emu.memory.readCString(titlePtr));
    for (const [hwnd, w] of emu.handles.findByType<WindowInfo>('window')) {
      if (w.parent) continue; // top-level only
      if (wantClass !== null && w.classInfo?.className !== wantClass) continue;
      if (wantTitle !== null && (w.title ?? '') !== wantTitle) continue;
      return hwnd;
    }
    return 0;
  };
  user32.register('FindWindowA', 2, findWindowImpl(false));
  user32.register('FindWindowW', 2, findWindowImpl(true));

  // FindWindowEx(parent, after, class, title) — same as FindWindow but scoped
  // to children of `parent` (or desktop if NULL), starting search after `after`.
  const findWindowExImpl = (wide: boolean) => (): number => {
    const parent = emu.readArg(0);
    const after = emu.readArg(1);
    const classPtr = emu.readArg(2);
    const titlePtr = emu.readArg(3);
    const wantClass = !classPtr ? null
      : classPtr < 0x10000 ? `#${classPtr}`
      : (wide ? emu.memory.readUTF16String(classPtr) : emu.memory.readCString(classPtr));
    const wantTitle = !titlePtr ? null
      : (wide ? emu.memory.readUTF16String(titlePtr) : emu.memory.readCString(titlePtr));
    let started = !after;
    for (const [hwnd, w] of emu.handles.findByType<WindowInfo>('window')) {
      if (!started) { if (hwnd === after) started = true; continue; }
      if (parent ? w.parent !== parent : !!w.parent) continue;
      if (wantClass !== null && w.classInfo?.className !== wantClass) continue;
      if (wantTitle !== null && (w.title ?? '') !== wantTitle) continue;
      return hwnd;
    }
    return 0;
  };
  user32.register('FindWindowExA', 4, findWindowExImpl(false));
  user32.register('FindWindowExW', 4, findWindowExImpl(true));
  // Common resolutions reported at 16bpp and 32bpp, 60Hz. Windows reports
  // many modes; the demo's config dialog filters to >8bpp and picks 640x480.
  const COMMON_MODES: [number, number][] = [
    [640, 480], [800, 600], [1024, 768], [1152, 864],
    [1280, 720], [1280, 800], [1280, 960], [1280, 1024],
    [1366, 768], [1440, 900], [1600, 900], [1600, 1200],
    [1680, 1050], [1920, 1080], [1920, 1200],
  ];
  const BPPS = [16, 32];
  function fillDevmode(lpDevMode: number, w: number, h: number, bpp: number): void {
    if (!lpDevMode) return;
    for (let i = 0; i < 156; i += 4) emu.memory.writeU32(lpDevMode + i, 0);
    emu.memory.writeU16(lpDevMode + 36, 156); // dmSize
    // dmFields: DM_BITSPERPEL | DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY
    emu.memory.writeU32(lpDevMode + 40, 0x00040000 | 0x00080000 | 0x00100000 | 0x00400000);
    emu.memory.writeU32(lpDevMode + 104, bpp);
    emu.memory.writeU32(lpDevMode + 108, w);
    emu.memory.writeU32(lpDevMode + 112, h);
    emu.memory.writeU32(lpDevMode + 120, 60);
  }
  function pickMode(iModeNum: number): { w: number; h: number; bpp: number } | null {
    if (iModeNum === -1) return { w: emu.screenWidth, h: emu.screenHeight, bpp: 32 };
    // Build a mode list: each (w, h) paired with each BPP, ending with the native resolution.
    const modes: { w: number; h: number; bpp: number }[] = [];
    for (const [w, h] of COMMON_MODES) {
      if (w > emu.screenWidth || h > emu.screenHeight) continue;
      for (const bpp of BPPS) modes.push({ w, h, bpp });
    }
    // Append the native resolution at 32bpp if not already listed.
    const hasNative = modes.some(m => m.w === emu.screenWidth && m.h === emu.screenHeight);
    if (!hasNative) modes.push({ w: emu.screenWidth, h: emu.screenHeight, bpp: 32 });
    if (iModeNum < 0 || iModeNum >= modes.length) return null;
    return modes[iModeNum];
  }
  const enumDisplay = () => {
    const iModeNum = emu.readArg(1) | 0;
    const lpDevMode = emu.readArg(2);
    const m = pickMode(iModeNum);
    if (!m) return 0;
    fillDevmode(lpDevMode, m.w, m.h, m.bpp);
    return 1;
  };
  user32.register('EnumDisplaySettingsA', 3, enumDisplay);
  user32.register('EnumDisplaySettingsW', 3, enumDisplay);

  // EnumDisplayDevicesA(lpDevice, iDevNum, lpDisplayDevice, dwFlags) → BOOL
  user32.register('EnumDisplayDevicesA', 4, () => {
    const _lpDevice = emu.readArg(0);
    const iDevNum = emu.readArg(1);
    const lpDD = emu.readArg(2);
    if (iDevNum !== 0 || !lpDD) return 0; // only one display
    // DISPLAY_DEVICEA: cb(4) + DeviceName(32) + DeviceString(128) + StateFlags(4) + DeviceID(128) + DeviceKey(128)
    const DISPLAY_DEVICE_ACTIVE = 0x00000001;
    const DISPLAY_DEVICE_PRIMARY_DEVICE = 0x00000004;
    const devName = '\\\\.\\DISPLAY1';
    const devString = 'Emulated Display';
    for (let i = 0; i < 32; i++) emu.memory.writeU8(lpDD + 4 + i, i < devName.length ? devName.charCodeAt(i) : 0);
    for (let i = 0; i < 128; i++) emu.memory.writeU8(lpDD + 36 + i, i < devString.length ? devString.charCodeAt(i) : 0);
    emu.memory.writeU32(lpDD + 164, DISPLAY_DEVICE_ACTIVE | DISPLAY_DEVICE_PRIMARY_DEVICE);
    return 1;
  });

  // EnumDisplayDevicesW(lpDevice, iDevNum, lpDisplayDevice, dwFlags) → BOOL
  user32.register('EnumDisplayDevicesW', 4, () => {
    const _lpDevice = emu.readArg(0);
    const iDevNum = emu.readArg(1);
    const lpDD = emu.readArg(2);
    if (iDevNum !== 0 || !lpDD) return 0; // only one display
    // DISPLAY_DEVICEW: cb(4) + DeviceName(32 WCHAR=64) + DeviceString(128 WCHAR=256) + StateFlags(4) + DeviceID(128 WCHAR=256) + DeviceKey(128 WCHAR=256)
    const DISPLAY_DEVICE_ACTIVE = 0x00000001;
    const DISPLAY_DEVICE_PRIMARY_DEVICE = 0x00000004;
    const devName = '\\\\.\\DISPLAY1';
    const devString = 'Emulated Display';
    const nameOff = lpDD + 4;
    for (let i = 0; i < 32; i++) emu.memory.writeU16(nameOff + i * 2, i < devName.length ? devName.charCodeAt(i) : 0);
    const strOff = lpDD + 4 + 64;
    for (let i = 0; i < 128; i++) emu.memory.writeU16(strOff + i * 2, i < devString.length ? devString.charCodeAt(i) : 0);
    emu.memory.writeU32(lpDD + 4 + 64 + 256, DISPLAY_DEVICE_ACTIVE | DISPLAY_DEVICE_PRIMARY_DEVICE);
    return 1;
  });
  // GetGuiResources: return non-zero count of GDI/USER objects
  user32.register('GetGuiResources', 2, () => {
    const GR_GDIOBJECTS = 0;
    const uiFlags = emu.readArg(1);
    return uiFlags === GR_GDIOBJECTS ? 30 : 20;
  });

  user32.register('LockWindowUpdate', 1, () => 1);
  // SetCursorPos(x, y) — we can't actually move the host OS cursor from inside
  // a browser, but we cache the position so subsequent GetCursorPos calls see
  // the requested coordinates (matches how DOOM-style games warp the mouse).
  user32.register('SetCursorPos', 2, () => {
    emu.cursorX = emu.readArg(0) | 0;
    emu.cursorY = emu.readArg(1) | 0;
    return 1;
  });
  user32.register('ClipCursor', 1, () => 1);
  // WindowFromDC(hdc) → HWND owning the device context (or 0 for memory DCs).
  // DCInfo carries hwnd already; the stub-0 made some MFC code reach a custom
  // wndProc with a NULL hwnd and skip the paint.
  user32.register('WindowFromDC', 1, () => {
    const hdc = emu.readArg(0);
    const dc = emu.getDC(hdc);
    return dc?.hwnd ?? 0;
  });
  user32.register('CountClipboardFormats', 0, () => 0);
  user32.register('SetWindowContextHelpId', 2, () => 1);
  // EnumChildWindows(hWndParent, lpEnumFunc, lParam) — call lpEnumFunc(child,
  // lParam) for each immediate child of hWndParent (or every top-level window
  // if hWndParent is NULL). Stop if the callback returns FALSE. Apps use this
  // to iterate dialog controls, gather toolbar children, etc.
  user32.register('EnumChildWindows', 3, () => {
    const hParent = emu.readArg(0);
    const callback = emu.readArg(1);
    const lParam = emu.readArg(2);
    if (!callback) return 0;
    // Build the list before invoking the callback so wndProcs that modify the
    // window tree (rare but legal) don't trip the iteration.
    const targets: number[] = [];
    if (hParent) {
      const parent = emu.handles.get<WindowInfo>(hParent);
      if (parent?.childList) targets.push(...parent.childList);
    } else {
      for (const [hwnd, w] of emu.handles.findByType<WindowInfo>('window')) {
        if (!w.parent) targets.push(hwnd);
      }
    }
    for (const hwnd of targets) {
      const ret = emu.callWndProc(callback, hwnd, lParam, 0, 0);
      if (ret === 0) break;
    }
    return 1;
  });

  user32.register('SendMessageTimeoutA', 6, () => {
    // Simplified: just call SendMessageA logic — return 1 (success)
    const _hwnd = emu.readArg(0);
    const _msg = emu.readArg(1);
    const _wParam = emu.readArg(2);
    const _lParam = emu.readArg(3);
    const _fuFlags = emu.readArg(4);
    const _uTimeout = emu.readArg(5);
    return 1; // LRESULT nonzero = success
  });

  // CharUpperBuffA(lpsz, cchLength) → DWORD
  user32.register('CharUpperBuffA', 2, () => {
    const lpsz = emu.readArg(0);
    const cchLength = emu.readArg(1);
    for (let i = 0; i < cchLength; i++) {
      const ch = emu.memory.readU8(lpsz + i);
      if (ch >= 0x61 && ch <= 0x7A) emu.memory.writeU8(lpsz + i, ch - 0x20);
    }
    return cchLength;
  });

  // CharLowerBuffA(lpsz, cchLength) → DWORD
  user32.register('CharLowerBuffA', 2, () => {
    const lpsz = emu.readArg(0);
    const cchLength = emu.readArg(1);
    for (let i = 0; i < cchLength; i++) {
      const ch = emu.memory.readU8(lpsz + i);
      if (ch >= 0x41 && ch <= 0x5A) emu.memory.writeU8(lpsz + i, ch + 0x20);
    }
    return cchLength;
  });

  // CharLowerBuffW(lpsz, cchLength) → DWORD (number of chars processed)
  user32.register('CharLowerBuffW', 2, () => {
    const lpsz = emu.readArg(0);
    const cchLength = emu.readArg(1);
    for (let i = 0; i < cchLength; i++) {
      const ch = emu.memory.readU16(lpsz + i * 2);
      if (ch >= 0x41 && ch <= 0x5A) emu.memory.writeU16(lpsz + i * 2, ch + 0x20);
    }
    return cchLength;
  });

  // SetMenuDefaultItem — moved to menu.ts

  // EnumWindowStationsW(lpEnumFunc, lParam) → BOOL
  user32.register('EnumWindowStationsW', 2, () => 1);

  // IsHungAppWindow(hwnd) → BOOL
  user32.register('IsHungAppWindow', 1, () => 0); // not hung

  // EnumDesktopsW(hwinsta, lpEnumFunc, lParam) → BOOL
  user32.register('EnumDesktopsW', 3, () => 1);

  // EnumDesktopWindows(hDesktop, lpfn, lParam) — enumerate top-level windows on desktop
  // hDesktop is ignored; behaves like EnumWindows
  user32.register('EnumDesktopWindows', 3, () => {
    const _hDesktop = emu.readArg(0);
    const callback  = emu.readArg(1);
    const lParam    = emu.readArg(2);
    const ownHwnd = emu.mainWindow;
    if (ownHwnd) {
      emu.callWndProc(callback, ownHwnd, lParam, 0, 0);
    }
    return 1;
  });

  // CloseWindowStation(hWinSta) → BOOL
  user32.register('CloseWindowStation', 1, () => 1);

  // SetProcessWindowStation(hWinSta) → BOOL
  user32.register('SetProcessWindowStation', 1, () => 1);

  // OpenWindowStationW(lpszWinSta, fInherit, dwDesiredAccess) → HWINSTA
  user32.register('OpenWindowStationW', 3, () => 0x1235);

  // CloseDesktop(hDesktop) → BOOL
  user32.register('CloseDesktop', 1, () => 1);

  // SetThreadDesktop(hDesktop) → BOOL
  user32.register('SetThreadDesktop', 1, () => 1);

  // OpenDesktopW(lpszDesktop, dwFlags, fInherit, dwDesiredAccess) → HDESK
  user32.register('OpenDesktopW', 4, () => emu.handles.alloc('desktop', {}));

  // InternalGetWindowText(hwnd, pString, cchMaxCount) → int
  user32.register('InternalGetWindowText', 3, () => {
    const hwnd = emu.readArg(0);
    const pString = emu.readArg(1);
    const cchMaxCount = emu.readArg(2);
    const wnd = hwnd ? emu.handles.get<WindowInfo>(hwnd) : null;
    const text = wnd?.title || '';
    const len = Math.min(text.length, cchMaxCount - 1);
    for (let i = 0; i < len; i++) emu.memory.writeU16(pString + i * 2, text.charCodeAt(i));
    emu.memory.writeU16(pString + len * 2, 0);
    return len;
  });

  // EndTask(hwnd, fShutDown, fForce) → BOOL
  user32.register('EndTask', 3, () => 1);

  // ShowWindowAsync(hwnd, nCmdShow) → BOOL
  user32.register('ShowWindowAsync', 2, () => 1);

  // CascadeWindows(hwndParent, wHow, lpRect, cKids, lpKids) → WORD
  user32.register('CascadeWindows', 5, () => 0);

  // TileWindows(hwndParent, wHow, lpRect, cKids, lpKids) → WORD
  user32.register('TileWindows', 5, () => 0);

  // SwitchToThisWindow(hwnd, fAltTab) → void
  user32.register('SwitchToThisWindow', 2, () => 0);

  // OpenIcon(hwnd) → BOOL
  user32.register('OpenIcon', 1, () => 1);

  // GetShellWindow() → HWND
  user32.register('GetShellWindow', 0, () => 0);

  // GetMenuItemInfoW — moved to menu.ts

  // GetUpdateRgn(hwnd, hRgn, bErase) → int
  user32.register('GetUpdateRgn', 3, () => 1); // NULLREGION

  // SendMessageTimeoutW(hwnd, Msg, wParam, lParam, fuFlags, uTimeout) → LRESULT
  user32.register('SendMessageTimeoutW', 6, () => 1);

  // AllowSetForegroundWindow(dwProcessId) → BOOL
  user32.register('AllowSetForegroundWindow', 1, () => 1);

  // RegisterHotKey: return TRUE (success)
  user32.register('RegisterHotKey', 4, () => 1);

  // MonitorFromWindow: return a fake monitor handle
  const MONITOR_DEFAULTTOPRIMARY = 1;
  user32.register('MonitorFromWindow', 2, () => 0xD0000001);
  user32.register('MonitorFromPoint', 3, () => 0xD0000001);
  user32.register('MonitorFromRect', 2, () => 0xD0000001);

  // GetMonitorInfoA/W: fill MONITORINFO struct with screen dimensions
  const getMonitorInfo = () => {
    const _hMonitor = emu.readArg(0);
    const lpmi = emu.readArg(1);
    if (!lpmi) return 0;
    const cbSize = emu.memory.readU32(lpmi);
    // MONITORINFO: cbSize, rcMonitor (16 bytes), rcWork (16 bytes), dwFlags
    // rcMonitor = {0, 0, screenW, screenH}
    const w = 1024, h = 768;
    emu.memory.writeU32(lpmi + 4, 0);   // rcMonitor.left
    emu.memory.writeU32(lpmi + 8, 0);   // rcMonitor.top
    emu.memory.writeU32(lpmi + 12, w);  // rcMonitor.right
    emu.memory.writeU32(lpmi + 16, h);  // rcMonitor.bottom
    emu.memory.writeU32(lpmi + 20, 0);  // rcWork.left
    emu.memory.writeU32(lpmi + 24, 0);  // rcWork.top
    emu.memory.writeU32(lpmi + 28, w);  // rcWork.right
    emu.memory.writeU32(lpmi + 32, h);  // rcWork.bottom
    emu.memory.writeU32(lpmi + 36, 1);  // dwFlags = MONITORINFOF_PRIMARY
    return 1;
  };
  user32.register('GetMonitorInfoA', 2, getMonitorInfo);
  user32.register('GetMonitorInfoW', 2, getMonitorInfo);

  // EnumDisplayMonitors(hdc, lprcClip, lpfnEnum, dwData) → BOOL
  user32.register('EnumDisplayMonitors', 4, () => {
    const _hdc = emu.readArg(0);
    const _lprcClip = emu.readArg(1);
    const lpfnEnum = emu.readArg(2);
    const dwData = emu.readArg(3);
    if (!lpfnEnum) return 0;
    // Allocate a temporary RECT for the monitor bounds
    const rcPtr = emu.allocHeap(16);
    const w = 1024, h = 768;
    emu.memory.writeU32(rcPtr + 0, 0); // left
    emu.memory.writeU32(rcPtr + 4, 0); // top
    emu.memory.writeU32(rcPtr + 8, w); // right
    emu.memory.writeU32(rcPtr + 12, h); // bottom
    // MonitorEnumProc(hMonitor, hdcMonitor, lprcMonitor, dwData)
    emu.callWndProc(lpfnEnum, 0xD0000001, 0, rcPtr, dwData);
    return 1;
  });

  // Caret functions
  user32.register('CreateCaret', 4, () => 1);
  user32.register('DestroyCaret', 0, () => 1);
  user32.register('ShowCaret', 1, () => 1);
  user32.register('HideCaret', 1, () => 1);
  user32.register('SetCaretPos', 2, () => 1);
  user32.register('GetCaretPos', 1, () => {
    const lpPoint = emu.readArg(0);
    emu.memory.writeU32(lpPoint, 0);
    emu.memory.writeU32(lpPoint + 4, 0);
    return 1;
  });

  // RegisterTasklist(hWnd) → BOOL — undocumented Shell hook, always succeed
  user32.register('RegisterTasklist', 1, () => 1);

  // IsWindowUnicode(hWnd) — return FALSE (we treat everything as ANSI)
  user32.register('IsWindowUnicode', 1, () => 0);

  // ExitWindowsEx(uFlags, dwReserved) → BOOL
  user32.register('ExitWindowsEx', 2, () => 1);

  // ToAscii(uVirtKey, uScanCode, lpKeyState, lpChar, uFlags) → int
  user32.register('ToAscii', 5, () => 0);

  // DDEML stubs
  user32.register('DdeInitializeA', 3, () => {
    // Return DMLERR_SYS_ERROR (0x400F) — DDE not available
    const pidInstPtr = emu.readArg(0);
    if (pidInstPtr) emu.memory.writeU32(pidInstPtr, 0);
    return 0x400F;
  });
  user32.register('DdeUninitialize', 1, () => 1);
  user32.register('DdeConnect', 4, () => 0); // NULL = failure
  // CopyIcon(hIcon) → HICON — just return the same handle
  user32.register('CopyIcon', 1, () => emu.readArg(0));

  user32.register('DdeDisconnect', 1, () => 1);
  user32.register('DdeCreateStringHandleA', 3, () => 0);
  user32.register('DdeNameService', 4, () => 0);
  user32.register('DdeClientTransaction', 8, () => 0);
  user32.register('DdeAccessData', 2, () => 0);
  user32.register('DdeUnaccessData', 1, () => 1);
  user32.register('DdeQueryStringA', 5, () => 0);

  // SetWinEventHook(eventMin, eventMax, hmodWinEventProc, pfnWinEventProc, idProcess, idThread, dwFlags) → HWINEVENTHOOK
  user32.register('SetWinEventHook', 7, () => emu.handles.alloc('wineventhook', {}));

  // UnhookWinEvent(hWinEventHook) → BOOL
  user32.register('UnhookWinEvent', 1, () => 1);
}
