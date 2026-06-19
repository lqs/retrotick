import type { Emulator, Win16Module } from '../../emulator';
import type { WindowInfo } from '../../win32/user32/types';
import { getClientSize, getNonClientMetrics } from '../../win32/user32/_helpers';
import type { Win16UserHelpers } from './index';

// Win16 USER module — Painting & DC

export function registerWin16UserPaint(emu: Emulator, user: Win16Module, h: Win16UserHelpers): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 32: GetWindowRect(hWnd, lpRect_ptr) — 6 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetWindowRect', 6, () => {
    const [hWnd, lpRect] = emu.readPascalArgs16([2, 4]);
    if (lpRect) {
      const targetHwnd = hWnd || emu.mainWindow;
      const wnd = emu.handles.get<WindowInfo>(targetHwnd);
      if (wnd) {
        // Convert to screen coordinates by walking parent chain.
        // Use wnd.parent (not WS_CHILD flag) because some controls
        // like ToolbarWindow are children but lack WS_CHILD style.
        let sx = wnd.x || 0, sy = wnd.y || 0;
        let cur = wnd.parent ? emu.handles.get<WindowInfo>(wnd.parent) : null;
        while (cur) {
          if (cur.parent) {
            // Intermediate parent: add its client-relative position
            sx += cur.x || 0;
            sy += cur.y || 0;
          } else {
            // Top-level parent: add screen position + client area offset
            const { bw, captionH, menuH } = getNonClientMetrics(cur.style, cur.hMenu !== 0, true);
            sx += (cur.x || 0) + bw;
            sy += (cur.y || 0) + bw + captionH + menuH;
            break;
          }
          cur = cur.parent ? emu.handles.get<WindowInfo>(cur.parent) : null;
        }
        h.writeRect(lpRect, sx, sy, sx + wnd.width, sy + wnd.height);
      } else {
        h.writeRect(lpRect, 0, 0, 640, 480);
      }
    }
    return 1;
  }, 32);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 33: GetClientRect(hWnd, lpRect_ptr) — 6 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetClientRect', 6, () => {
    const [hWnd, lpRect] = emu.readPascalArgs16([2, 4]);
    if (lpRect) {
      const targetHwnd = hWnd || emu.mainWindow;
      if (targetHwnd === emu.mainWindow && emu.canvas) {
        h.writeRect(lpRect, 0, 0, emu.canvas.width, emu.canvas.height);
      } else {
        const wnd = emu.handles.get<WindowInfo>(targetHwnd);
        if (wnd) {
          const { cw, ch } = getClientSize(wnd.style, !!wnd.hMenu, wnd.width, wnd.height, true);
          h.writeRect(lpRect, 0, 0, cw, ch);
        } else {
          h.writeRect(lpRect, 0, 0, 640, 480);
        }
      }
    }
    return 1;
  }, 33);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 34: EnableWindow(hWnd, bEnable) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('EnableWindow', 4, () => 0, 34);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 38: GetWindowTextLength(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetWindowTextLength', 2, () => {
    const hWnd = emu.readArg16(0);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    return wnd?.title?.length || 0;
  }, 38);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 39: BeginPaint(hWnd, lpPaint_ptr) — 6 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('BeginPaint', 6, () => {
    const [hWnd, lpPaint] = emu.readPascalArgs16([2, 4]);
    const targetHwnd = hWnd || emu.mainWindow;
    const wndBP = emu.handles.get<WindowInfo>(targetHwnd);
    const hdc = emu.beginPaint(targetHwnd);
    if (wndBP) { wndBP.needsPaint = false; wndBP.needsErase = false; }
    if (lpPaint) {
      emu.memory.writeU16(lpPaint, hdc);
      emu.memory.writeU16(lpPaint + 2, 0);
      let cw = 640, ch = 480;
      if (targetHwnd === emu.mainWindow && emu.canvas) {
        cw = emu.canvas.width; ch = emu.canvas.height;
      } else {
        const wnd = emu.handles.get<WindowInfo>(targetHwnd);
        if (wnd) { cw = wnd.width; ch = wnd.height; }
      }
      h.writeRect(lpPaint + 4, 0, 0, cw, ch);
      emu.memory.writeU16(lpPaint + 12, 0);
      emu.memory.writeU16(lpPaint + 14, 0);
    }
    return hdc;
  }, 39);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 40: EndPaint(hWnd, lpPaint_ptr) — 6 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('EndPaint', 6, () => {
    const [hWnd] = emu.readPascalArgs16([2, 4]);
    emu.endPaint(hWnd || emu.mainWindow, 0);
    emu.notifyControlOverlays();
    return 0;
  }, 40);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 66: GetDC(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetDC', 2, () => {
    const hWnd = emu.readArg16(0);
    const dc = emu.getWindowDC(hWnd || emu.mainWindow);
    // console.log(`[WIN16] GetDC hwnd=0x${(hWnd || emu.mainWindow).toString(16)} → dc=${dc}`);
    return dc;
  }, 66);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 68: ReleaseDC(hWnd, hDC) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ReleaseDC', 4, () => {
    const [_hWnd, hDC] = emu.readPascalArgs16([2, 2]);
    emu.releaseChildDC(hDC);
    return 1;
  }, 68);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 124: UpdateWindow(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('UpdateWindow', 2, () => {
    const hWnd = emu.readArg16(0);
    if (hWnd) {
      const wnd = emu.handles.get<WindowInfo>(hWnd);
      if (wnd && wnd.needsPaint && wnd.wndProc) {
        // UpdateWindow sends WM_PAINT synchronously (bypasses queue)
        wnd.needsPaint = false;
        wnd.needsErase = false;
        return emu.callWndProc16(wnd.wndProc, hWnd, 0x000F, 0, 0);
      }
    }
    return 0;
  }, 124);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 125: InvalidateRect(hWnd, lpRect_ptr, bErase) — 8 bytes (2+4+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('InvalidateRect', 8, () => {
    const [hWnd, _lpRect, bErase] = emu.readPascalArgs16([2, 4, 2]);
    if (hWnd) {
      const wnd = emu.handles.get<WindowInfo>(hWnd);
      if (wnd) {
        wnd.needsPaint = true;
        if (bErase) wnd.needsErase = true;
      }
    }
    return 1;
  }, 125);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 127: ValidateRect(hWnd, lpRect) — 6 bytes (2+4)
  // ───────────────────────────────────────────────────────────────────────────
  // Clear the pending paint/erase flags (mirrors win32 ValidateRect). The stub
  // `() => 1` left needsPaint set, so an app that validated its own region kept
  // getting WM_PAINT re-synthesized. lpRect is ignored — we track a whole-window
  // invalid flag, not a region, same as InvalidateRect here.
  user.register('ValidateRect', 6, () => {
    const [hWnd] = emu.readPascalArgs16([2, 4]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (wnd) {
      wnd.needsPaint = false;
      wnd.needsErase = false;
    }
    return 1;
  }, 127);
}
