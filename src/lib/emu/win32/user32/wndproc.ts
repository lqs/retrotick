import type { Emulator } from '../../emulator';
import type { WindowInfo } from './types';
import {
  WM_CLOSE, WM_DESTROY, WM_PAINT, WM_ERASEBKGND, WM_SYSCOMMAND,
  WM_NCCREATE, WM_NCDESTROY, WM_NCCALCSIZE, WM_NCPAINT, WM_NCACTIVATE,
  WM_GETMINMAXINFO, WM_SHOWWINDOW, WM_ACTIVATE, WM_SETCURSOR, WM_NCHITTEST,
  WM_WINDOWPOSCHANGING, WM_WINDOWPOSCHANGED, WM_ACTIVATEAPP, WM_SIZE,
  SC_CLOSE, SC_MINIMIZE, SC_MAXIMIZE, SC_RESTORE,
  HTCLIENT, SYS_COLORS, COLOR_BTNFACE, IDCANCEL,
} from '../types';

export function registerWndProc(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  // Module-level atom counter and dedup map for RegisterWindowMessage
  let nextMsgAtom = 0;
  const registeredMessages = new Map<string, number>();

  function registerMessage(name: string): number {
    let atom = registeredMessages.get(name);
    if (atom === undefined) {
      atom = 0xC000 + (nextMsgAtom++ & 0x3FFF);
      registeredMessages.set(name, atom);
    }
    return atom;
  }

  // Expose for use by other modules (e.g. comdlg32 FindTextW)
  emu.registerWindowMessage = registerMessage;

  user32.register('DefWindowProcA', 4, () => {
    const hwnd = emu.readArg(0);
    const message = emu.readArg(1);
    const wParam = emu.readArg(2);
    const lParam = emu.readArg(3);

    switch (message) {
      case WM_SYSCOMMAND: {
        const scCmd = wParam & 0xFFF0;
        const scWnd = emu.handles.get<WindowInfo>(hwnd);
        if (scCmd === SC_CLOSE) {
          if (scWnd?.wndProc) {
            emu.callWndProc(scWnd.wndProc, hwnd, WM_CLOSE, 0, 0);
          }
        } else if (scCmd === SC_MINIMIZE) {
          if (scWnd) {
            scWnd.minimized = true;
            scWnd.maximized = false;
          }
        } else if (scCmd === SC_MAXIMIZE) {
          if (scWnd) {
            scWnd.maximized = true;
            scWnd.minimized = false;
          }
        } else if (scCmd === SC_RESTORE) {
          if (scWnd) {
            scWnd.minimized = false;
            scWnd.maximized = false;
          }
        }
        return 0;
      }
      case WM_CLOSE: {
        // Real Windows: DefWindowProc calls DestroyWindow(hwnd) synchronously
        const closeWnd = emu.handles.get<WindowInfo>(hwnd);
        if (closeWnd && closeWnd.wndProc) {
          emu.callWndProc(closeWnd.wndProc, hwnd, WM_DESTROY, 0, 0);
          emu.callWndProc(closeWnd.wndProc, hwnd, WM_NCDESTROY, 0, 0);
        }
        // Remove from parent's child list
        if (closeWnd && closeWnd.parent) {
          const parentWnd = emu.handles.get<WindowInfo>(closeWnd.parent);
          if (parentWnd?.childList) {
            const idx = parentWnd.childList.indexOf(hwnd);
            if (idx >= 0) parentWnd.childList.splice(idx, 1);
          }
        }
        if (hwnd === emu.mainWindow) {
          console.log(`[WND] mainWindow 0x${hwnd.toString(16)} destroyed via DefWindowProc(WM_CLOSE)`);
          emu.mainWindow = 0;
        }
        emu.handles.free(hwnd);
        return 0;
      }
      case WM_NCCREATE:
        return 1;
      case WM_NCDESTROY:
        return 0;
      case WM_NCCALCSIZE:
        return 0;
      case WM_NCACTIVATE:
        return 1;
      case WM_NCPAINT:
        return 0;
      case WM_NCHITTEST:
        return HTCLIENT;
      case WM_GETMINMAXINFO:
        return 0;
      case WM_ERASEBKGND: {
        const wnd = emu.handles.get<WindowInfo>(hwnd);
        if (wnd) {
          // NULL class background brush: the window manages its own background.
          // DefWindowProc must not erase and must return 0 (per MSDN).
          const hBrush = wnd.classInfo.hbrBackground;
          if (!hBrush) return 0;
          const brush = emu.getBrush(hBrush);
          if (brush?.isNull) return 0;
          const hdc = wParam;
          const dc = emu.getDC(hdc);
          if (dc) {
            const bgColor = brush ? brush.color : SYS_COLORS[COLOR_BTNFACE];
            const r = bgColor & 0xFF;
            const g = (bgColor >> 8) & 0xFF;
            const b = (bgColor >> 16) & 0xFF;
            dc.ctx.fillStyle = `rgb(${r},${g},${b})`;
            dc.ctx.fillRect(0, 0, dc.canvas.width, dc.canvas.height);
            emu.syncDCToCanvas(hdc);
          }
        }
        return 1;
      }
      case WM_PAINT: {
        // Default WM_PAINT: just validate the region
        const hdc = emu.beginPaint(hwnd);
        if (hdc) emu.endPaint(hwnd, hdc);
        return 0;
      }
      case WM_SETCURSOR:
        return 1;
      case WM_ACTIVATE:
      case WM_ACTIVATEAPP:
      case WM_SHOWWINDOW:
      case WM_SIZE:
      case WM_WINDOWPOSCHANGING:
      case WM_WINDOWPOSCHANGED:
        return 0;
      default:
        return 0;
    }
  });

  user32.register('DefWindowProcW', 4, emu.apiDefs.get('USER32.DLL:DefWindowProcA')?.handler!);

  user32.register('CallWindowProcA', 5, () => {
    const lpPrevWndFunc = emu.readArg(0);
    const hwnd = emu.readArg(1);
    const msg = emu.readArg(2);
    const wParam = emu.readArg(3);
    const lParam = emu.readArg(4);
    if (lpPrevWndFunc) {
      return emu.callWndProc(lpPrevWndFunc, hwnd, msg, wParam, lParam);
    }
    return 0;
  });

  user32.register('CallWindowProcW', 5, emu.apiDefs.get('USER32.DLL:CallWindowProcA')?.handler!);

  // DefDlgProcA/W: default dialog procedure
  // Forwards messages to the dialog's dlgProc, then falls back to DefWindowProc
  const defDlgProc = () => {
    const hwnd = emu.readArg(0);
    const message = emu.readArg(1);
    const wParam = emu.readArg(2);
    const lParam = emu.readArg(3);


    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (wnd) {
      // Read dlgProc from DWL_DLGPROC (extraBytes offset 4) — may have been updated via SetWindowLong
      let dlgProc = 0;
      if (wnd.extraBytes && wnd.extraBytes.length >= 8) {
        dlgProc = (wnd.extraBytes[4] | (wnd.extraBytes[5] << 8) |
          (wnd.extraBytes[6] << 16) | (wnd.extraBytes[7] << 24)) >>> 0;
      }
      if (!dlgProc) dlgProc = wnd.dlgProc || 0;
      if (dlgProc) {
        const handled = emu.callWndProc(dlgProc, hwnd, message, wParam, lParam);
        if (handled) {
          // dlgProc returned TRUE — return DWL_MSGRESULT (extraBytes[0..3])
          if (wnd.extraBytes && wnd.extraBytes.length >= 4) {
            return (wnd.extraBytes[0] | (wnd.extraBytes[1] << 8) |
              (wnd.extraBytes[2] << 16) | (wnd.extraBytes[3] << 24)) >>> 0;
          }
          return 0;
        }
      }
    }

    // DefDlgProc handles WM_CLOSE by calling EndDialog(hwnd, IDCANCEL)
    if (message === WM_CLOSE) {
      if (emu.dialogState && emu.dialogState.hwnd === hwnd) {
        emu.dialogState.result = IDCANCEL;
        emu.dialogState.ended = true;
        emu._endDialog(IDCANCEL);
      }
      return 0;
    }

    // For dialogs, WM_ERASEBKGND uses COLOR_BTNFACE (via WM_CTLCOLORDLG default)
    if (message === WM_ERASEBKGND && wnd) {
      const hdc = wParam;
      const dc = emu.getDC(hdc);
      if (dc) {
        const bgColor = SYS_COLORS[COLOR_BTNFACE];
        const r = bgColor & 0xFF, g = (bgColor >> 8) & 0xFF, b = (bgColor >> 16) & 0xFF;
        dc.ctx.fillStyle = `rgb(${r},${g},${b})`;
        dc.ctx.fillRect(0, 0, dc.canvas.width, dc.canvas.height);
        emu.syncDCToCanvas(hdc);
      }
      return 1;
    }

    // dlgProc didn't handle it — use DefWindowProc behavior
    const defWndProc = emu.apiDefs.get('USER32.DLL:DefWindowProcA')?.handler!;
    return defWndProc(emu);
  };
  user32.register('DefDlgProcA', 4, defDlgProc);
  user32.register('DefDlgProcW', 4, defDlgProc);

  user32.register('DefFrameProcA', 5, () => 0);
  user32.register('DefFrameProcW', 5, () => 0);
  user32.register('DefMDIChildProcA', 4, () => 0);
  user32.register('DefMDIChildProcW', 4, () => 0); // MDI child proc, return 0
  user32.register('CallNextHookEx', 4, () => 0);

  const setWindowsHookEx = () => {
    const idHook = emu.readArg(0);
    const lpfn = emu.readArg(1);
    const hMod = emu.readArg(2);
    const _dwThreadId = emu.readArg(3);
    const WH_CBT = 5;
    const hookData = { idHook, lpfn, hMod };
    if (idHook === WH_CBT && lpfn) {
      emu.cbtHooks.push({ lpfn, hMod });
      console.log(`[HOOK] Registered WH_CBT hook lpfn=0x${lpfn.toString(16)}`);
    }
    return emu.handles.alloc('hook', hookData);
  };
  user32.register('SetWindowsHookExA', 4, setWindowsHookEx);
  user32.register('SetWindowsHookExW', 4, setWindowsHookEx);

  // SetWindowsHookW(idHook, lpfn) — old deprecated API, 2 args
  user32.register('SetWindowsHookW', 2, () => {
    const idHook = emu.readArg(0);
    const lpfn = emu.readArg(1);
    const hookData = { idHook, lpfn, hMod: 0 };
    if (idHook === 5) {
      emu.cbtHooks.push({ lpfn, hMod: 0 });
      console.log(`[HOOK] Registered WH_CBT hook (old API) lpfn=0x${lpfn.toString(16)}`);
    }
    return emu.handles.alloc('hook', hookData);
  });

  user32.register('UnhookWindowsHookEx', 1, () => {
    const hHook = emu.readArg(0);
    const hookData = emu.handles.get<{ idHook: number; lpfn: number; hMod: number }>(hHook);
    if (hookData && hookData.idHook === 5) {
      const idx = emu.cbtHooks.findIndex(h => h.lpfn === hookData.lpfn);
      if (idx >= 0) emu.cbtHooks.splice(idx, 1);
    }
    emu.handles.free(hHook);
    return 1;
  });
  user32.register('RegisterWindowMessageA', 1, () => {
    const lpString = emu.readArg(0);
    const name = emu.memory.readCString(lpString);
    return registerMessage(name);
  });
  user32.register('RegisterWindowMessageW', 1, () => {
    const lpString = emu.readArg(0);
    const name = emu.memory.readUTF16String(lpString);
    return registerMessage(name);
  });
  user32.register('RegisterClipboardFormatA', 1, () => {
    const lpString = emu.readArg(0);
    const name = emu.memory.readCString(lpString);
    return registerMessage(name);
  });
  user32.register('RegisterClipboardFormatW', 1, () => {
    const lpString = emu.readArg(0);
    const name = emu.memory.readUTF16String(lpString);
    return registerMessage(name);
  });
  user32.register('TranslateMDISysAccel', 2, () => 0);
}
