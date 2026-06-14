import type { Emulator } from '../../emulator';
import { WM_TIMER } from '../types';

export function registerTimer(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  user32.register('SetTimer', 4, () => {
    const hwnd = emu.readArg(0);
    const timerId = emu.readArg(1);
    const elapse = emu.readArg(2);
    const timerFunc = emu.readArg(3);

    // Coalesce identical re-arms: many MFC controls re-arm a timer with the
    // same elapse from inside their WM_TIMER handler (e.g. CCanvasView's
    // 200 ms blink). Recreating the JS interval on every WM_TIMER causes
    // console-spam if logged, plus extra clearInterval/setInterval churn.
    // If the same (hwnd, id, elapse) is already armed, just reuse it.
    const existing = emu.getWin32Timer(hwnd, timerId);
    if (existing && existing.elapse === elapse && existing.timerFunc === timerFunc) {
      return timerId;
    }
    if (!existing) {
      console.log(`[TIMER] SetTimer hwnd=0x${hwnd.toString(16)} id=${timerId} elapse=${elapse} timerFunc=0x${timerFunc.toString(16)}`);
    }

    // Clear existing timer with same ID
    emu.clearWin32Timer(hwnd, timerId);

    const jsTimer = globalThis.setInterval(() => {
      // lParam = timerFunc so DispatchMessage can call the callback
      emu.postMessage(hwnd, WM_TIMER, timerId, timerFunc);
    }, elapse);

    emu.setWin32Timer(hwnd, timerId, jsTimer, elapse, timerFunc);
    return timerId;
  });

  user32.register('KillTimer', 2, () => {
    const hwnd = emu.readArg(0);
    const timerId = emu.readArg(1);
    emu.clearWin32Timer(hwnd, timerId);
    return 1;
  });
}
