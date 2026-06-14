import type { Emulator } from '../../emulator';
import type { WindowInfo } from './types';

const WM_SETFOCUS = 0x0007;
const WM_KILLFOCUS = 0x0008;
const WS_CHILD = 0x40000000;

export function registerFocus(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  user32.register('GetFocus', 0, () => {
    // If focus is on a child window, return it directly
    const focusedHwnd = emu.focusedWindow;
    if (focusedHwnd) {
      const wnd = emu.handles.get<WindowInfo>(focusedHwnd);
      if (wnd && (wnd.style & WS_CHILD)) return focusedHwnd;
    }
    // If focus is on a top-level window or not set, return the first visible
    // child (in real Windows, SetFocus on a parent propagates to a child)
    const parentHwnd = focusedHwnd || emu.mainWindow;
    const parentWnd = emu.handles.get<WindowInfo>(parentHwnd);
    if (parentWnd?.childList) {
      for (const childHwnd of parentWnd.childList) {
        const child = emu.handles.get<WindowInfo>(childHwnd);
        if (child?.visible) return childHwnd;
      }
    }
    return focusedHwnd;
  });

  // SetFocus stores the focus on the EMULATOR (emu.focusedWindow — the field
  // the UI layer reads to route WM_KEYDOWN/WM_CHAR) and notifies both windows
  // like real Windows: WM_KILLFOCUS to the loser, WM_SETFOCUS to the gainer
  // (apps create/show their caret there).
  user32.register('SetFocus', 1, () => {
    const hwnd = emu.readArg(0);
    const prev = emu.focusedWindow;
    if (hwnd === prev) return prev;
    emu.focusedWindow = hwnd;
    const send = (target: number, message: number, wParam: number): void => {
      const wnd = emu.handles.get<WindowInfo>(target);
      if (!wnd?.wndProc) return;
      if (emu.wndProcDepth < 3) {
        emu.callWndProc(wnd.wndProc, target, message, wParam, 0);
      } else {
        emu.postMessage(target, message, wParam, 0);
      }
    };
    if (prev) send(prev, WM_KILLFOCUS, hwnd);
    if (hwnd) send(hwnd, WM_SETFOCUS, prev);
    return prev;
  });

  user32.register('GetActiveWindow', 0, () => emu.mainWindow || 0);
  user32.register('SetActiveWindow', 1, () => emu.readArg(0));
  user32.register('GetForegroundWindow', 0, () => emu.mainWindow || 0);
  user32.register('SetForegroundWindow', 1, () => 1);
}
