import type { Emulator } from '../../emulator';
import type { WindowInfo, TreeViewItem, ListViewColumn, ListViewItem } from './types';
import { writeMsgStruct, getClientSize } from './_helpers';
import { encodeMBCS } from '../../memory';
import { emuCompleteThunk } from '../../emu-exec';
import { getNextCascadePos } from '../../emulator';
import {
  WM_QUIT, WM_PAINT, WM_ERASEBKGND,
  WM_SETTEXT, WM_GETTEXT, WM_GETTEXTLENGTH,
  WM_CREATE, WM_NCCREATE, WM_NCCALCSIZE,
  WM_TIMER, WM_LBUTTONUP, WM_COMMAND, PM_REMOVE, CW_USEDEFAULT,
  TBM_GETPOS, TBM_GETRANGEMIN, TBM_GETRANGEMAX,
  TBM_SETPOS, TBM_SETRANGE, TBM_SETRANGEMIN, TBM_SETRANGEMAX,
} from '../types';

/** Hit-test a click against the toolbar's button layout. Mirrors the layout
 *  computed by renderToolbar (emu-render.ts) : tbButtonSize cells laid out
 *  horizontally with TBSTYLE_SEP buttons used as spacers. Returns the clicked
 *  button's idCommand, or 0 if none / hidden / separator. */
/** Client rect of toolbar button `index`, from the same layout walk as
 *  toolbarHitTest/renderToolbar. Separators occupy their iBitmap width
 *  (default 6), hidden buttons occupy nothing. Returns null if out of range. */
function toolbarItemRect(tb: WindowInfo, index: number): { l: number; t: number; r: number; b: number } | null {
  const buttons = tb.tbButtons;
  if (!buttons || index < 0 || index >= buttons.length) return null;
  const TBSTATE_HIDDEN = 0x08;
  const TBSTYLE_SEP    = 0x01;
  let btnW = 22, btnH = 22;
  if (tb.tbButtonSize !== undefined) {
    btnW = tb.tbButtonSize & 0xFFFF;
    btnH = (tb.tbButtonSize >>> 16) & 0xFFFF;
  }
  let x = 2;
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i];
    const w = (b.fsState & TBSTATE_HIDDEN) ? 0
      : (b.fsStyle & TBSTYLE_SEP) ? (b.iBitmap > 0 ? b.iBitmap : 6)
      : btnW;
    if (i === index) return { l: x, t: 2, r: x + w, b: 2 + btnH };
    x += w;
  }
  return null;
}

function toolbarHitTest(tb: WindowInfo, x: number, y: number): number {
  const buttons = tb.tbButtons;
  if (!buttons || buttons.length === 0) return 0;
  const TBSTATE_HIDDEN = 0x08;
  const TBSTYLE_SEP    = 0x01;
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i];
    if (b.fsState & TBSTATE_HIDDEN) continue;
    if (b.fsStyle & TBSTYLE_SEP) continue;
    const r = toolbarItemRect(tb, i);
    if (r && x >= r.l && x < r.r && y >= r.t && y < r.b) {
      return b.idCommand >>> 0;
    }
  }
  return 0;
}

export function registerMessage(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  // A window paints only if it AND every ancestor up to the main window is
  // visible. A hidden window (or one under a hidden parent) must never erase or
  // paint — on the shared canvas its background fill would blank whatever now
  // occupies its slot (e.g. a hidden CSizingControlBar greying out the pane
  // that took its place after RecalcLayout).
  const isEffectivelyVisible = (h: number): boolean => {
    let cur = h, guard = 0;
    while (cur && guard++ < 64) {
      const w = emu.handles.get<WindowInfo>(cur);
      if (!w || !w.visible) return false;
      if (cur === emu.mainWindow) break;
      cur = w.parent || 0;
    }
    return true;
  };

  // hWnd filter matching, real-Windows semantics: 0 = any window of the
  // thread; -1 = thread messages only (hwnd 0); otherwise the window itself
  // or any of its descendants (GetMessage/PeekMessage retrieve messages for
  // hWnd "or any of its children, as specified by IsChild").
  const HWND_THREAD_ONLY = 0xFFFFFFFF;
  const matchesHwndFilter = (filterHwnd: number, msgHwnd: number): boolean => {
    if (filterHwnd === 0) return true;
    if (filterHwnd === HWND_THREAD_ONLY) return msgHwnd === 0;
    let cur = msgHwnd, guard = 0;
    while (cur && guard++ < 64) {
      if (cur === filterHwnd) return true;
      cur = emu.handles.get<WindowInfo>(cur)?.parent || 0;
    }
    return false;
  };

  // Find the first queued message matching the filters. WM_QUIT bypasses
  // them: real GetMessage returns it regardless of the hWnd/range filters
  // (otherwise a modal loop pumping a specific hwnd would hang after
  // PostQuitMessage), but only once no other matching message precedes it.
  const findQueuedMessage = (filterHwnd: number, msgFilterMin: number, msgFilterMax: number): number => {
    const hasFilter = msgFilterMin !== 0 || msgFilterMax !== 0;
    let quitIdx = -1;
    for (let i = 0; i < emu.messageQueue.length; i++) {
      const msg = emu.messageQueue[i];
      if (msg.message === WM_QUIT) { if (quitIdx < 0) quitIdx = i; continue; }
      if (!matchesHwndFilter(filterHwnd, msg.hwnd)) continue;
      if (hasFilter && (msg.message < msgFilterMin || msg.message > msgFilterMax)) continue;
      return i;
    }
    return quitIdx;
  };

  // Message loop
  // Synthesize WM_PAINT for windows that need repainting.
  // `consume` is true for calls that hand the message to the app for
  // processing (GetMessage, PeekMessage PM_REMOVE) and false for non-removing
  // peeks (PM_NOREMOVE), which must not affect pending-paint state.
  // `filterHwnd` restricts synthesis to that window and its descendants, so a
  // filtered pump can't steal (and mark consumed) another window's paint.
  const synthesizePaint = (consume: boolean, filterHwnd = 0): { hwnd: number; message: number; wParam: number; lParam: number } | null => {
    // Check all windows for needsPaint flag
    for (const [handle, wnd] of emu.handles.findByType('window') as [number, WindowInfo][]) {
      if (!wnd || !wnd.needsPaint) continue;
      if (!matchesHwndFilter(filterHwnd, handle)) continue;
      if (!isEffectivelyVisible(handle)) { wnd.needsPaint = false; wnd.needsErase = false; continue; }
      if (wnd.wndProc) {
        // Real Windows never queue-delivers WM_ERASEBKGND: BeginPaint sends it
        // with the paint DC when the region was invalidated with bErase=TRUE,
        // and EndPaint releases that DC. Synthesizing it here armed a child DC
        // (getWindowDC save+clip on the shared canvas) that nothing released —
        // the stale clip then intersected every later window's clip until
        // painting was fully suppressed. Leave needsErase for beginPaint.
        // Like real Windows, WM_PAINT stays pending until BeginPaint /
        // ValidateRect validates the region — clearing needsPaint on synthesis
        // lost the paint when the app peeked with PM_NOREMOVE first (MFC's
        // CWinThread::Run idle loop) and only then called GetMessage. But if
        // the app already consumed a WM_PAINT for this invalidation and never
        // validated, validate now instead of re-delivering forever.
        if (consume) {
          if (wnd._paintSynthesized) {
            wnd.needsPaint = false;
            wnd.needsErase = false;
            wnd._paintSynthesized = false;
            continue;
          }
          wnd._paintSynthesized = true;
        }
        return { hwnd: handle, message: WM_PAINT, wParam: 0, lParam: 0 };
      }
      // Built-in windows (no wndProc) with a class brush: erase background directly
      if (wnd.needsErase && wnd.classInfo.hbrBackground) {
        wnd.needsErase = false;
        wnd.needsPaint = false;
        const hdc = emu.getWindowDC(handle);
        const dc = emu.getDC(hdc);
        if (dc) {
          const brush = emu.getBrush(wnd.classInfo.hbrBackground);
          if (brush && !brush.isNull) {
            const r = brush.color & 0xFF, g = (brush.color >> 8) & 0xFF, b = (brush.color >> 16) & 0xFF;
            dc.ctx.fillStyle = `rgb(${r},${g},${b})`;
            dc.ctx.fillRect(0, 0, wnd.width, wnd.height);
            emu.syncDCToCanvas(hdc);
          }
        }
        // Balance the save/clip armed by getWindowDC on the shared canvas
        emu.releaseChildDC(hdc);
      } else {
        wnd.needsPaint = false;
      }
    }
    return null;
  };

  user32.register('GetMessageA', 4, () => {
    const pMsg = emu.readArg(0);
    const hWnd = emu.readArg(1);
    const msgFilterMin = emu.readArg(2);
    const msgFilterMax = emu.readArg(3);
    const hasFilter = msgFilterMin !== 0 || msgFilterMax !== 0;
    const wantsPaint = !hasFilter || (WM_PAINT >= msgFilterMin && WM_PAINT <= msgFilterMax);

    const tryRetrieve = (): { hwnd: number; message: number; wParam: number; lParam: number } | null => {
      const idx = findQueuedMessage(hWnd, msgFilterMin, msgFilterMax);
      if (idx >= 0) return emu.messageQueue.splice(idx, 1)[0];
      // Synthesize WM_PAINT if a matching window needs repainting
      if (wantsPaint) return synthesizePaint(true, hWnd);
      return null;
    };

    const first = tryRetrieve();
    if (first) {
      writeMsgStruct(emu, pMsg, first);
      return first.message === WM_QUIT ? 0 : 1;
    }

    // No matching message — set up callback and wait. A posted message that
    // does NOT match the filters must not wake the caller (real GetMessage
    // keeps blocking), so re-arm until a matching one arrives.
    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    const onAvailable = (): void => {
      const msg = tryRetrieve();
      if (!msg) {
        emu._onMessageAvailable = onAvailable;
        return;
      }
      writeMsgStruct(emu, pMsg, msg);
      emu.waitingForMessage = false;
      emuCompleteThunk(emu, msg.message === WM_QUIT ? 0 : 1, stackBytes);
      if (emu.running && !emu.halted) {
        requestAnimationFrame(emu.tick);
      }
    };
    emu._onMessageAvailable = onAvailable;
    return undefined;
  });

  user32.register('PeekMessageA', 5, () => {
    const pMsg = emu.readArg(0);
    const hWnd = emu.readArg(1);
    const msgFilterMin = emu.readArg(2);
    const msgFilterMax = emu.readArg(3);
    const removeFlag = emu.readArg(4);

    // Find first message matching the filter (hWnd matches the window or any
    // of its descendants, like real PeekMessage)
    const hasFilter = msgFilterMin !== 0 || msgFilterMax !== 0;
    let idx = -1;
    for (let i = 0; i < emu.messageQueue.length; i++) {
      const msg = emu.messageQueue[i];
      if (!matchesHwndFilter(hWnd, msg.hwnd)) continue;
      if (hasFilter && (msg.message < msgFilterMin || msg.message > msgFilterMax)) continue;
      idx = i;
      break;
    }

    if (idx >= 0) {
      const msg = (removeFlag & PM_REMOVE) ? emu.messageQueue.splice(idx, 1)[0] : emu.messageQueue[idx];
      writeMsgStruct(emu, pMsg, msg);
      return 1;
    }

    // No matching message found — try synthesizing WM_PAINT.
    // Only at the top-level message loop (depth 0) to avoid consuming WM_PAINT
    // prematurely during init or nested WndProc calls.
    if (emu.wndProcDepth === 0) {
      // synthesizePaint only ever returns WM_PAINT — check the filter BEFORE
      // synthesizing so a consuming call can't mark a paint as delivered and
      // then drop it on a filter mismatch. The hWnd filter is passed through
      // so a window-specific peek can't steal another window's paint.
      if (!hasFilter || (WM_PAINT >= msgFilterMin && WM_PAINT <= msgFilterMax)) {
        const paintMsg = synthesizePaint((removeFlag & PM_REMOVE) !== 0, hWnd);
        if (paintMsg) {
          writeMsgStruct(emu, pMsg, paintMsg);
          return 1;
        }
      }
    }

    // PeekMessage is non-blocking: return 0 (no message).
    // Yield to the browser to deliver events and render frames.
    if (emu.wndProcDepth <= 1) {
      const stackBytes = emu._currentThunkStackBytes;
      emu.waitingForMessage = true;
      const resumeWith0 = () => {
        emu._onMessageAvailable = null;
        emu.waitingForMessage = false;
        emuCompleteThunk(emu, 0, stackBytes);
        if (emu.running && !emu.halted) {
          requestAnimationFrame(emu.tick);
        }
      };
      emu._onMessageAvailable = resumeWith0;
      requestAnimationFrame(() => {
        if (emu._onMessageAvailable === resumeWith0) resumeWith0();
      });
      return undefined;
    }
    return 0;
  });

  user32.register('WaitMessage', 0, () => {
    // WaitMessage blocks until a message is available.
    if (emu.messageQueue.length > 0) return 1;
    // If any window needs repainting, return immediately so PeekMessage can synthesize WM_PAINT
    for (const [, wnd] of emu.handles.findByType('window') as [number, WindowInfo][]) {
      if (wnd && wnd.needsPaint && wnd.wndProc) return 1;
    }
    // Queue is empty — wait for a message or next frame
    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    const resumeWith1 = () => {
      emu._onMessageAvailable = null;
      emu.waitingForMessage = false;
      emuCompleteThunk(emu, 1, stackBytes);
      if (emu.running && !emu.halted) {
        requestAnimationFrame(emu.tick);
      }
    };
    emu._onMessageAvailable = resumeWith1;
    requestAnimationFrame(() => {
      if (emu._onMessageAvailable === resumeWith1) resumeWith1();
    });
    return undefined;
  });

  // MsgWaitForMultipleObjects: yield with timeout to let JS timers fire
  const WAIT_TIMEOUT = 0x00000102;
  user32.register('MsgWaitForMultipleObjects', 5, () => {
    const nCount = emu.readArg(0);
    // args 1-2: pHandles, fWaitAll (ignored for single-threaded)
    const dwMilliseconds = emu.readArg(3);
    // arg 4: dwWakeMask

    // If messages already queued, return immediately
    if (emu.messageQueue.length > 0) {
      return nCount; // WAIT_OBJECT_0 + nCount = input available
    }

    // Check if any window needs repainting (synthesizable WM_PAINT)
    for (const [, wnd] of emu.handles.findByType('window') as [number, WindowInfo][]) {
      if (wnd && wnd.needsPaint && (wnd.wndProc || (wnd.needsErase && wnd.classInfo.hbrBackground))) {
        return nCount;
      }
    }

    if (dwMilliseconds === 0) {
      return WAIT_TIMEOUT;
    }

    // Wait for message or timeout
    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    const timerId = setTimeout(() => {
      emu._onMessageAvailable = null;
      emu.waitingForMessage = false;
      emuCompleteThunk(emu, WAIT_TIMEOUT, stackBytes);
      if (emu.running && !emu.halted) {
        requestAnimationFrame(emu.tick);
      }
    }, dwMilliseconds);
    emu._onMessageAvailable = () => {
      clearTimeout(timerId);
      emu.waitingForMessage = false;
      emuCompleteThunk(emu, nCount, stackBytes);
      if (emu.running && !emu.halted) {
        requestAnimationFrame(emu.tick);
      }
    };
    return undefined;
  });

  // MsgWaitForMultipleObjectsEx(nCount, pHandles, dwMilliseconds, dwWakeMask, dwFlags) → DWORD
  user32.register('MsgWaitForMultipleObjectsEx', 5, () => {
    const nCount = emu.readArg(0);
    const dwMilliseconds = emu.readArg(2);

    if (emu.messageQueue.length > 0) return nCount;
    for (const [, wnd] of emu.handles.findByType('window') as [number, WindowInfo][]) {
      if (wnd && wnd.needsPaint && (wnd.wndProc || (wnd.needsErase && wnd.classInfo.hbrBackground))) {
        return nCount;
      }
    }
    if (dwMilliseconds === 0) return WAIT_TIMEOUT;

    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    const timerId = setTimeout(() => {
      emu._onMessageAvailable = null;
      emu.waitingForMessage = false;
      emuCompleteThunk(emu, WAIT_TIMEOUT, stackBytes);
      if (emu.running && !emu.halted) requestAnimationFrame(emu.tick);
    }, dwMilliseconds);
    emu._onMessageAvailable = () => {
      clearTimeout(timerId);
      emu.waitingForMessage = false;
      emuCompleteThunk(emu, nCount, stackBytes);
      if (emu.running && !emu.halted) requestAnimationFrame(emu.tick);
    };
    return undefined;
  });

  // GetMessageExtraInfo() → LPARAM
  user32.register('GetMessageExtraInfo', 0, () => 0);

  user32.register('TranslateMessage', 1, () => {
    // No-op (keyboard translation not emulated)
    return 0;
  });

  user32.register('DispatchMessageA', 1, () => {
    const pMsg = emu.readArg(0);
    const hwnd = emu.memory.readU32(pMsg);
    const message = emu.memory.readU32(pMsg + 4);
    const wParam = emu.memory.readU32(pMsg + 8);
    const lParam = emu.memory.readU32(pMsg + 12);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (!wnd) return 0;

    // WM_TIMER with non-zero lParam: call the timer callback directly
    // lpTimerFunc signature: void CALLBACK TimerProc(HWND, UINT, UINT_PTR, DWORD)
    if (message === WM_TIMER && lParam !== 0) {
      const r = emu.callWndProc(lParam, hwnd, message, wParam, Date.now() & 0xFFFFFFFF);
      // WS_CLIPCHILDREN: repaint visible child windows that may have been drawn over
      const WS_CLIPCHILDREN = 0x02000000;
      if (hwnd === emu.mainWindow && (wnd.style & WS_CLIPCHILDREN) && wnd.childList) {
        for (const childHwnd of wnd.childList) {
          const child = emu.handles.get<WindowInfo>(childHwnd);
          if (child && child.visible && child.wndProc && child.width > 0 && child.height > 0) {
            child.needsPaint = true;
            child.needsErase = true;
            emu.callWndProc(child.wndProc, childHwnd, WM_PAINT, 0, 0);
          }
        }
      }
      return r;
    }

    // Track whether endPaint was called during WM_PAINT
    const trackPaint = message === WM_PAINT && hwnd === emu.mainWindow;
    if (trackPaint) { emu._dispatchPaintUsedBeginPaint = false; }

    // For built-in controls (wndProc=0), handle the message internally
    if (!wnd.wndProc) {
      const builtin = handleBuiltinMessage(hwnd, message, wParam, lParam);
      return builtin ?? 0;
    }

    // Toolbar click hit-test : MFC's CToolBar subclass wndProc can't reliably
    // find the clicked button because COMCTL32's internal layout state isn't
    // tracked in the emulator. So we hit-test against tb.tbButtons (the same
    // layout used by renderToolbar) and synthesize WM_COMMAND on the parent.
    const tbClassName = wnd.classInfo?.className?.toUpperCase();
    if (tbClassName === 'TOOLBARWINDOW32' && message === WM_LBUTTONUP) {
      const cmd = toolbarHitTest(wnd, lParam & 0xFFFF, (lParam >> 16) & 0xFFFF);
      if (cmd > 0 && wnd.parent) {
        const parent = emu.handles.get<WindowInfo>(wnd.parent);
        if (parent?.wndProc) {
          // WM_COMMAND : wParam = HIWORD(notification)|LOWORD(id),
          //              lParam = control hwnd (0 for menu/accelerator).
          // Toolbar uses notification code 0 (button click).
          emu.callWndProc(parent.wndProc, wnd.parent, WM_COMMAND, cmd & 0xFFFF, hwnd);
          return 0; // skip MFC's own click handling
        }
      }
    }

    // Call WndProc via stack frame replacement.
    // DispatchMessage propagates `undefined` correctly, so it's safe to let
    // callStdcall yield mid-wndProc when this dispatch takes too long.
    const prevAllow = emu._allowWndProcYield;
    emu._allowWndProcYield = true;
    const ret = emu.callWndProc(wnd.wndProc, hwnd, message, wParam, lParam);
    emu._allowWndProcYield = prevAllow;
    if (ret === undefined) return undefined; // deferred — post-processing skipped

    // WM_GETMINMAXINFO caching is now handled by clampToMinTrackSize() in _helpers.ts

    // After WM_TIMER: populate Applications tab ListView from processRegistry
    // (taskmgr's worker thread can't run in our single-threaded emulator)
    if (message === WM_TIMER && emu.processRegistry) {
      updateTaskListView(emu, hwnd);
    }

    // After WM_PAINT dispatch, notify overlays if BeginPaint/EndPaint wasn't called
    // (e.g. Delphi apps). Apps that do call BeginPaint already get overlays via endPaint.
    if (trackPaint && !emu._dispatchPaintUsedBeginPaint) {
      emu.notifyControlOverlays();
    }

    // WM_PAINT stays pending until validated (synthesizePaint no longer clears
    // it). If the wndProc handled WM_PAINT without BeginPaint/ValidateRect the
    // flag is still set here — validate now, like the system does, so the same
    // WM_PAINT isn't re-synthesized forever.
    if (message === WM_PAINT && wnd.needsPaint) {
      wnd.needsPaint = false;
      wnd.needsErase = false;
      wnd._paintSynthesized = false;
    }

    return ret;
  });

  user32.register('PostMessageA', 4, () => {
    const hwnd = emu.readArg(0);
    const message = emu.readArg(1);
    const wParam = emu.readArg(2);
    const lParam = emu.readArg(3);
    emu.postMessage(hwnd, message, wParam, lParam);
    return 1;
  });

  const WM_MDICREATE = 0x0220;
  const WM_MDIDESTROY = 0x0221;
  const WM_MDIACTIVATE = 0x0222;
  const WM_MDIGETACTIVE = 0x0229;
  const WM_MDISETMENU = 0x0230;
  const WM_MDITILE = 0x0226;
  const WM_MDICASCADE = 0x0227;
  const WM_MDIICONARRANGE = 0x0228;

  const handleBuiltinMessage = (hwnd: number, message: number, wParam: number, lParam: number, wide = false): number | null => {
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (!wnd) return null;

    // MDIClient message handling
    const cls = (wnd.classInfo?.baseClassName || wnd.classInfo?.className || '').toUpperCase();
    if (cls === 'MDICLIENT') {
      if (message === WM_MDICREATE && lParam) {
        // MDICREATESTRUCT: szClass(4), szTitle(4), hOwner(4), x(4), y(4), cx(4), cy(4), style(4), lParam(4)
        const szClassPtr = emu.memory.readU32(lParam);
        const szTitlePtr = emu.memory.readU32(lParam + 4);
        const hOwner = emu.memory.readU32(lParam + 8);
        let x = emu.memory.readI32(lParam + 12);
        let y = emu.memory.readI32(lParam + 16);
        let cx = emu.memory.readI32(lParam + 20);
        let cy = emu.memory.readI32(lParam + 24);
        let childStyle = emu.memory.readU32(lParam + 28);
        const childLParam = emu.memory.readU32(lParam + 32);

        const className = szClassPtr < 0x10000
          ? (emu.atomToClassName.get(szClassPtr) || `#${szClassPtr}`)
          : emu.memory.readUTF16String(szClassPtr);
        const title = szTitlePtr ? emu.memory.readUTF16String(szTitlePtr) : '';

        const childCls = emu.windowClasses.get(className) || emu.windowClasses.get(className.toUpperCase());
        if (!childCls) {
          console.warn(`[MDI] WM_MDICREATE: class not found: ${className}`);
          return 0;
        }

        // MDI children are always WS_CHILD of the MDIClient
        const WS_CHILD = 0x40000000;
        const WS_CLIPSIBLINGS = 0x04000000;
        const WS_VISIBLE = 0x10000000;
        const WS_OVERLAPPEDWINDOW = 0x00CF0000;
        childStyle |= WS_CHILD | WS_CLIPSIBLINGS | WS_VISIBLE | WS_OVERLAPPEDWINDOW;

        // MDI children use parent (MDIClient) client area for default sizing
        const mdiClientW = wnd.width || 320;
        const mdiClientH = wnd.height || 240;
        if (x === (CW_USEDEFAULT | 0)) {
          const pos = getNextCascadePos(mdiClientW, mdiClientH);
          x = pos.x; y = pos.y;
          if ((cx | 0) === (CW_USEDEFAULT | 0) || cx === 0) cx = Math.max(200, mdiClientW - 40);
          if ((cy | 0) === (CW_USEDEFAULT | 0) || cy === 0) cy = Math.max(150, mdiClientH - 40);
        } else {
          if ((cx | 0) === (CW_USEDEFAULT | 0)) cx = 320;
          if ((cy | 0) === (CW_USEDEFAULT | 0)) cy = 240;
        }

        const childWnd: WindowInfo = {
          hwnd: 0, classInfo: childCls,
          wndProc: childCls.wndProc,
          parent: hwnd, // parent is MDIClient
          x, y, width: cx, height: cy,
          style: childStyle, exStyle: 0, title,
          visible: true, hMenu: 0,
          extraBytes: new Uint8Array(Math.max(0, childCls.cbWndExtra)),
          userData: 0,
          ownerThreadId: emu.currentThread?.id,
        };

        const childHwnd = emu.handles.alloc('window', childWnd);
        childWnd.hwnd = childHwnd;

        // Register as child of MDIClient
        if (!wnd.children) wnd.children = new Map();
        if (!wnd.childList) wnd.childList = [];
        wnd.childList.push(childHwnd);

        // Track active MDI child
        if (!(wnd as any).mdiActiveChild) (wnd as any).mdiActiveChild = 0;
        (wnd as any).mdiActiveChild = childHwnd;

        console.log(`[MDI] WM_MDICREATE class="${className}" title="${title}" hwnd=0x${childHwnd.toString(16)} size=${cx}x${cy}`);

        // Build CREATESTRUCT and send WM_NCCREATE / WM_CREATE
        const createStructAddr = emu.allocHeap(48);
        emu.memory.writeU32(createStructAddr, lParam); // lpCreateParams = pointer to MDICREATESTRUCT
        emu.memory.writeU32(createStructAddr + 4, hOwner);
        emu.memory.writeU32(createStructAddr + 8, 0); // hMenu
        emu.memory.writeU32(createStructAddr + 12, hwnd); // hwndParent = MDIClient
        emu.memory.writeU32(createStructAddr + 16, cy);
        emu.memory.writeU32(createStructAddr + 20, cx);
        emu.memory.writeU32(createStructAddr + 24, y);
        emu.memory.writeU32(createStructAddr + 28, x);
        emu.memory.writeU32(createStructAddr + 32, childStyle);
        emu.memory.writeU32(createStructAddr + 36, szTitlePtr);
        emu.memory.writeU32(createStructAddr + 40, szClassPtr);
        emu.memory.writeU32(createStructAddr + 44, 0); // exStyle

        // Fire CBT hooks
        if (emu.cbtHooks.length > 0) {
          const cbtStruct = emu.allocHeap(8);
          emu.memory.writeU32(cbtStruct, createStructAddr);
          emu.memory.writeU32(cbtStruct + 4, 0);
          for (const hook of emu.cbtHooks) {
            emu.callWndProc(hook.lpfn, 3, childHwnd, cbtStruct, 0);
          }
        }

        emu.callWndProc(childWnd.wndProc, childHwnd, WM_NCCREATE, 0, createStructAddr);
        emu.callWndProc(childWnd.wndProc, childHwnd, WM_NCCALCSIZE, 0, 0);
        const createResult = emu.callWndProc(childWnd.wndProc, childHwnd, WM_CREATE, 0, createStructAddr);
        console.log(`[MDI] WM_CREATE result=${createResult} for hwnd=0x${childHwnd.toString(16)} class="${className}"`);

        if (createResult === -1) {
          emu.handles.free(childHwnd);
          if (wnd.childList) {
            const idx = wnd.childList.indexOf(childHwnd);
            if (idx >= 0) wnd.childList.splice(idx, 1);
          }
          (wnd as any).mdiActiveChild = 0;
          return 0;
        }

        return childHwnd;
      }

      if (message === WM_MDIGETACTIVE) {
        // Return active MDI child HWND; if lParam points to a BOOL, write maximized state
        const activeChild = (wnd as any).mdiActiveChild || 0;
        if (lParam) {
          emu.memory.writeU32(lParam, 0); // not maximized
        }
        return activeChild;
      }

      if (message === WM_MDIACTIVATE) {
        (wnd as any).mdiActiveChild = wParam;
        // Move to end of childList for z-ordering
        if (wnd.childList) {
          const idx = wnd.childList.indexOf(wParam);
          if (idx >= 0) {
            wnd.childList.splice(idx, 1);
            wnd.childList.push(wParam);
          }
        }
        emu.notifyControlOverlays();
        return 0;
      }

      if (message === WM_MDIDESTROY || message === WM_MDITILE ||
          message === WM_MDICASCADE || message === WM_MDIICONARRANGE ||
          message === WM_MDISETMENU) {
        return 0; // stub
      }
    }

    if (message === WM_SETTEXT && lParam) {
      // SetWindowTextA/W routes here via DefWindowProc/DefDlgProc, but the shared
      // dialog wndProc can't tell A from W, so `wide` defaults to false. Prefer
      // the _setTextUnicode flag set by SetWindowTextA/W for the duration of the
      // send; otherwise honour `wide`, then fall back to a UTF-16 byte sniff.
      const uni = (emu as any)._setTextUnicode ??
        (wide || (emu.memory.readU8(lParam) !== 0 && emu.memory.readU8(lParam + 1) === 0));
      const newTitle = uni ? emu.memory.readUTF16String(lParam) : emu.memory.readCString(lParam);
      const cls = (wnd.classInfo?.baseClassName || wnd.classInfo?.className || '').toUpperCase();
      if (cls === 'EDIT') {
        console.log(`[EDIT] WM_SETTEXT hwnd=0x${hwnd.toString(16)} text="${newTitle}"`);
      }
      if (newTitle !== wnd.title) {
        wnd.title = newTitle;
        if (wnd.domInput) wnd.domInput.value = newTitle;
        if (wnd.parent && wnd.parent === emu.mainWindow) {
          const parentWnd = emu.handles.get<WindowInfo>(wnd.parent);
          if (parentWnd) { parentWnd.needsPaint = true; }
        }
        emu.notifyControlOverlays();
      }
      return 1;
    }

    if (message === WM_GETTEXT && lParam && wParam > 0) {
      const text = wnd.title || '';
      const cls = (wnd.classInfo?.baseClassName || wnd.classInfo?.className || '').toUpperCase();
      if (cls === 'EDIT') {
        console.log(`[EDIT] WM_GETTEXT hwnd=0x${hwnd.toString(16)} text="${text}" maxChars=${wParam}`);
      }
      if (wide) {
        const maxChars = Math.min(text.length, (wParam >>> 0) - 1);
        for (let i = 0; i < maxChars; i++) {
          emu.memory.writeU16(lParam + i * 2, text.charCodeAt(i));
        }
        emu.memory.writeU16(lParam + maxChars * 2, 0);
        return maxChars;
      } else {
        const encoded = encodeMBCS(text);
        const maxBytes = Math.min(encoded.length, (wParam >>> 0) - 1);
        for (let i = 0; i < maxBytes; i++) {
          emu.memory.writeU8(lParam + i, encoded[i]);
        }
        emu.memory.writeU8(lParam + maxBytes, 0);
        return maxBytes;
      }
    }

    if (message === WM_GETTEXTLENGTH) {
      const text = wnd.title || '';
      // For EDIT controls, return length with \r\n line endings (matching EM_GETHANDLE buffer)
      const cls = (wnd.classInfo?.baseClassName || wnd.classInfo?.className || '').toUpperCase();
      if (cls === 'EDIT') {
        return text.replace(/\r?\n/g, '\r\n').length;
      }
      return text.length;
    }

    // BM_SETCHECK (0x00F1)
    if (message === 0x00F1) {
      wnd.checked = wParam & 0x3;
      return 0;
    }

    // BM_GETCHECK (0x00F0)
    if (message === 0x00F0) {
      return wnd.checked ?? 0;
    }

    // STM_SETIMAGE (0x0172)
    if (message === 0x0172) {
      const old = wnd.hImage ?? 0;
      wnd.hImage = lParam;
      // Mark parent for repaint
      if (wnd.parent) {
        const parentWnd = emu.handles.get<WindowInfo>(wnd.parent);
        if (parentWnd) parentWnd.needsPaint = true;
      }
      return old;
    }

    // STM_GETIMAGE (0x0173)
    if (message === 0x0173) {
      return wnd.hImage ?? 0;
    }

    // WM_SETFONT (0x0030)
    if (message === 0x0030) {
      wnd.hFont = wParam;
      return 0;
    }

    // WM_GETFONT (0x0031)
    if (message === 0x0031) {
      return wnd.hFont ?? 0;
    }

    // Trackbar messages (TBM_*) — only handle for trackbar controls
    if (message >= TBM_GETPOS && message <= TBM_SETRANGEMAX && wnd.classInfo.className.toUpperCase() === 'MSCTLS_TRACKBAR32') {
      if (message === TBM_GETPOS) return wnd.trackPos ?? 0;
      if (message === TBM_GETRANGEMIN) return wnd.trackMin ?? 0;
      if (message === TBM_GETRANGEMAX) return wnd.trackMax ?? 100;
      if (message === TBM_SETPOS) {
        wnd.trackPos = lParam | 0;
        if (wParam) emu.notifyControlOverlays();
        return 0;
      }
      if (message === TBM_SETRANGE) {
        wnd.trackMin = lParam & 0xFFFF;
        wnd.trackMax = (lParam >> 16) & 0xFFFF;
        if (wParam) emu.notifyControlOverlays();
        return 0;
      }
      if (message === TBM_SETRANGEMIN) {
        wnd.trackMin = lParam | 0;
        if (wParam) emu.notifyControlOverlays();
        return 0;
      }
      if (message === TBM_SETRANGEMAX) {
        wnd.trackMax = lParam | 0;
        if (wParam) emu.notifyControlOverlays();
        return 0;
      }
    }

    const cn = wnd.classInfo?.className?.toUpperCase() || '';

    // Edit control messages (EM_*)
    if (cn === 'EDIT') {
      const EM_GETSEL    = 0x00B0;
      const EM_SETSEL    = 0x00B1;
      const EM_GETRECT   = 0x00B2;
      const EM_GETLINE   = 0x00C4;
      const EM_REPLACESEL = 0x00C2;
      const EM_GETLINECOUNT = 0x00BA;
      const EM_LINEINDEX = 0x00BB;
      const EM_LINELENGTH = 0x00C1;
      const EM_LINEFROMCHAR = 0x00C9;
      const EM_LIMITTEXT = 0x00C5;
      const EM_GETLIMITTEXT = 0x00D5;
      const EM_SETMODIFY = 0x00B9;
      const EM_GETMODIFY = 0x00B8;
      const EM_SETREADONLY = 0x00CF;
      const EM_SETPASSWORDCHAR = 0x00CC;
      const EM_GETPASSWORDCHAR = 0x00D2;
      const EM_EMPTYUNDOBUFFER = 0x00CD;
      const EM_CANUNDO = 0x00C6;
      const EM_UNDO = 0x00C7;
      const EM_GETFIRSTVISIBLELINE = 0x00CE;
      const EM_SCROLL = 0x00B5;
      const EM_SCROLLCARET = 0x00B7;
      const EM_SETMARGINS = 0x00D3;
      const EM_GETMARGINS = 0x00D4;
      const ES_PASSWORD = 0x0020;
      const ES_READONLY = 0x0800;

      const text = wnd.title || '';

      if (message === EM_GETSEL) {
        const start = wnd.editSelStart ?? text.length;
        const end = wnd.editSelEnd ?? text.length;
        if (wParam) emu.memory.writeU32(wParam, start);
        if (lParam) emu.memory.writeU32(lParam, end);
        return (start & 0xFFFF) | ((end & 0xFFFF) << 16);
      }
      if (message === EM_SETSEL) {
        let start = wParam | 0;
        let end = lParam | 0;
        if (start === -1) { start = 0; end = 0; } // deselect
        if (end === -1) end = text.length; // select to end
        if (start < 0) start = 0;
        if (end > text.length) end = text.length;
        wnd.editSelStart = start;
        wnd.editSelEnd = end;
        // Sync selection to DOM textarea
        if (wnd.domInput) {
          wnd.domInput.selectionStart = start;
          wnd.domInput.selectionEnd = end;
        }
        return 0;
      }
      if (message === EM_REPLACESEL) {
        const replacement = lParam
          ? (wide ? emu.memory.readUTF16String(lParam) : emu.memory.readCString(lParam))
          : '';
        const start = wnd.editSelStart ?? text.length;
        const end = wnd.editSelEnd ?? text.length;
        const s = Math.min(start, end);
        const e = Math.max(start, end);
        wnd.title = text.substring(0, s) + replacement + text.substring(e);
        const newPos = s + replacement.length;
        wnd.editSelStart = newPos;
        wnd.editSelEnd = newPos;
        wnd.editModified = true;
        emu.notifyControlOverlays();
        return 0;
      }
      if (message === EM_GETLINECOUNT) {
        if (!text) return 1;
        return text.split('\n').length;
      }
      if (message === EM_GETLINE) {
        const lineIdx = wParam;
        const lines = text.split('\n');
        const line = lines[lineIdx] || '';
        if (lParam) {
          // First word at lParam is the buffer size (pre-filled by caller)
          const bufSize = emu.memory.readU16(lParam);
          const maxChars = Math.min(line.length, bufSize > 0 ? bufSize - 1 : line.length);
          if (wide) {
            for (let i = 0; i < maxChars; i++) emu.memory.writeU16(lParam + i * 2, line.charCodeAt(i));
            emu.memory.writeU16(lParam + maxChars * 2, 0);
          } else {
            const enc = encodeMBCS(line);
            const mb = Math.min(enc.length, bufSize > 0 ? bufSize - 1 : enc.length);
            for (let i = 0; i < mb; i++) emu.memory.writeU8(lParam + i, enc[i]);
            emu.memory.writeU8(lParam + maxChars, 0);
          }
          return maxChars;
        }
        return line.length;
      }
      if (message === EM_LINEINDEX) {
        const lineIdx = wParam === -1 ? 0 : wParam; // -1 = current line
        const lines = text.split('\n');
        let charIdx = 0;
        for (let i = 0; i < lineIdx && i < lines.length; i++) charIdx += lines[i].length + 1;
        return charIdx;
      }
      if (message === EM_LINELENGTH) {
        const charIdx = wParam === -1 ? 0 : wParam;
        const lines = text.split('\n');
        let pos = 0;
        for (const line of lines) {
          if (charIdx <= pos + line.length) return line.length;
          pos += line.length + 1;
        }
        return 0;
      }
      if (message === EM_LINEFROMCHAR) {
        const charIdx = wParam === -1 ? (wnd.editSelStart ?? 0) : wParam;
        const lines = text.split('\n');
        let pos = 0;
        for (let i = 0; i < lines.length; i++) {
          if (charIdx <= pos + lines[i].length) return i;
          pos += lines[i].length + 1;
        }
        return lines.length - 1;
      }
      if (message === EM_LIMITTEXT) {
        wnd.editLimit = wParam || 0;
        return 0;
      }
      if (message === EM_GETLIMITTEXT) {
        return wnd.editLimit || 30000;
      }
      if (message === EM_SETMODIFY) {
        wnd.editModified = !!wParam;
        return 0;
      }
      if (message === EM_GETMODIFY) {
        return wnd.editModified ? 1 : 0;
      }
      if (message === EM_SETREADONLY) {
        if (wParam) wnd.style |= ES_READONLY;
        else wnd.style &= ~ES_READONLY;
        return 1;
      }
      if (message === EM_SETPASSWORDCHAR) {
        if (wParam) wnd.style |= ES_PASSWORD;
        else wnd.style &= ~ES_PASSWORD;
        return 0;
      }
      if (message === EM_GETPASSWORDCHAR) {
        return (wnd.style & ES_PASSWORD) ? 0x2A : 0; // '*' or 0
      }
      if (message === EM_GETRECT) {
        if (lParam) {
          emu.memory.writeU32(lParam, 2);      // left margin
          emu.memory.writeU32(lParam + 4, 0);  // top
          emu.memory.writeU32(lParam + 8, wnd.width - 2);
          emu.memory.writeU32(lParam + 12, wnd.height);
        }
        return 0;
      }
      // EM_SETHANDLE: set the edit control's text buffer (used by Notepad)
      const EM_SETHANDLE = 0x00BC;
      const EM_GETHANDLE = 0x00BD;
      if (message === EM_SETHANDLE) {
        const handle = wParam;
        if (handle) {
          // wParam is a local memory handle — in our emulator it's a direct pointer
          // Read UTF-16 string from the buffer
          const newText = emu.memory.readUTF16String(handle);
          wnd.title = newText;
          if (wnd.domInput) wnd.domInput.value = newText;
          wnd.editBufferHandle = handle;
          emu.notifyControlOverlays();
        }
        return 0;
      }
      if (message === EM_GETHANDLE) {
        // Sync current text (possibly edited via DOM) back to x86 memory buffer
        let handle = wnd.editBufferHandle;
        if (handle && wnd.title !== undefined) {
          // DOM textarea uses \n, but Win32 Edit buffer expects \r\n
          const text = wnd.title.replace(/\r?\n/g, '\r\n');
          const neededBytes = (text.length + 1) * 2; // UTF-16 + null
          // Reallocate if buffer is too small
          const currentSize = emu.heapSize(handle);
          if (currentSize < neededBytes) {
            handle = emu.reallocHeap(handle, neededBytes);
            wnd.editBufferHandle = handle;
          }
          // Write UTF-16 text to buffer
          for (let i = 0; i < text.length; i++) {
            emu.memory.writeU16(handle + i * 2, text.charCodeAt(i));
          }
          emu.memory.writeU16(handle + text.length * 2, 0);
        }
        return handle || 0;
      }
      // Clipboard messages for EDIT controls
      const WM_CUT = 0x0300, WM_COPY = 0x0301, WM_PASTE = 0x0302, WM_CLEAR = 0x0303;
      if (message === WM_COPY || message === WM_CUT) {
        const start = wnd.editSelStart ?? 0;
        const end = wnd.editSelEnd ?? 0;
        const s = Math.min(start, end), e = Math.max(start, end);
        if (s !== e) {
          emu._clipboardText = text.substring(s, e);
          if (message === WM_CUT) {
            wnd.title = text.substring(0, s) + text.substring(e);
            wnd.editSelStart = s;
            wnd.editSelEnd = s;
            wnd.editModified = true;
            if (wnd.domInput) { wnd.domInput.value = wnd.title; wnd.domInput.selectionStart = wnd.domInput.selectionEnd = s; }
            emu.notifyControlOverlays();
          }
        }
        return 0;
      }
      if (message === WM_PASTE) {
        if (emu._clipboardText) {
          const start = wnd.editSelStart ?? text.length;
          const end = wnd.editSelEnd ?? text.length;
          const s = Math.min(start, end), e = Math.max(start, end);
          const newText = text.substring(0, s) + emu._clipboardText + text.substring(e);
          wnd.title = newText;
          const newPos = s + emu._clipboardText.length;
          wnd.editSelStart = newPos;
          wnd.editSelEnd = newPos;
          wnd.editModified = true;
          if (wnd.domInput) { wnd.domInput.value = wnd.title; wnd.domInput.selectionStart = wnd.domInput.selectionEnd = newPos; }
          emu.notifyControlOverlays();
        }
        return 0;
      }
      if (message === WM_CLEAR) {
        const start = wnd.editSelStart ?? 0;
        const end = wnd.editSelEnd ?? 0;
        const s = Math.min(start, end), e = Math.max(start, end);
        if (s !== e) {
          wnd.title = text.substring(0, s) + text.substring(e);
          wnd.editSelStart = s;
          wnd.editSelEnd = s;
          wnd.editModified = true;
          if (wnd.domInput) { wnd.domInput.value = wnd.title; wnd.domInput.selectionStart = wnd.domInput.selectionEnd = s; }
          emu.notifyControlOverlays();
        }
        return 0;
      }

      if (message === EM_EMPTYUNDOBUFFER) return 0;
      if (message === EM_CANUNDO) return 0; // no undo support
      if (message === EM_UNDO) return 0;
      if (message === EM_GETFIRSTVISIBLELINE) return 0;
      if (message === EM_SCROLL) return 0;
      if (message === EM_SCROLLCARET) {
        if (wnd.domInput) {
          // Focus + setSelectionRange scrolls the textarea to show the caret
          wnd.domInput.focus();
          const pos = wnd.editSelStart ?? 0;
          wnd.domInput.setSelectionRange(pos, wnd.editSelEnd ?? pos);
        }
        return 0;
      }
      if (message === EM_SETMARGINS) return 0;
      if (message === EM_GETMARGINS) return 0;
    }

    // ListBox messages
    if (cn === 'LISTBOX') {
      const LB_ADDSTRING     = 0x0180;
      const LB_INSERTSTRING  = 0x0181;
      const LB_DELETESTRING  = 0x0182;
      const LB_SELITEMRANGEEX = 0x0183;
      const LB_RESETCONTENT  = 0x0184;
      const LB_SETSEL        = 0x0185;
      const LB_SETCURSEL     = 0x0186;
      const LB_GETSEL        = 0x0187;
      const LB_GETCURSEL     = 0x0188;
      const LB_GETTEXT       = 0x0189;
      const LB_GETTEXTLEN    = 0x018A;
      const LB_GETCOUNT      = 0x018B;
      const LB_SELECTSTRING  = 0x018C;
      const LB_GETSELCOUNT   = 0x0190;
      const LB_GETSELITEMS   = 0x0191;
      const LB_SETTOPINDEX   = 0x0197;
      const LB_GETITEMRECT   = 0x0198;
      const LB_GETITEMDATA   = 0x0199;
      const LB_SETITEMDATA   = 0x019A;
      const LB_SETITEMHEIGHT = 0x01A0;
      const LB_GETITEMHEIGHT = 0x01A1;
      const LB_FINDSTRING    = 0x018F;
      const LB_FINDSTRINGEXACT = 0x01A2;
      const LB_GETTOPINDEX   = 0x018E;
      const LB_SETCOLUMNWIDTH = 0x0195;
      const LB_SETHORIZONTALEXTENT = 0x0194;
      const LB_GETHORIZONTALEXTENT = 0x0193;
      const LB_SETCOUNT      = 0x01A7;
      const LB_INITSTORAGE   = 0x01A8;
      const LBS_MULTIPLESEL  = 0x0008;
      const LBS_OWNERDRAWFIXED32 = 0x0010;
      const LBS_OWNERDRAWVARIABLE32 = 0x0020;
      const LBS_HASSTRINGS32 = 0x0040;
      const LBS_EXTENDEDSEL  = 0x0800;
      const LB_ERR = -1;

      if (!wnd.lbItems) { wnd.lbItems = []; wnd.lbItemData = []; }
      const isMultiSel = !!(wnd.style & (LBS_MULTIPLESEL | LBS_EXTENDEDSEL));
      if (isMultiSel && !wnd.lbSelectedIndices) wnd.lbSelectedIndices = new Set();
      const isOwnerDrawNoStrings32 = ((wnd.style & (LBS_OWNERDRAWFIXED32 | LBS_OWNERDRAWVARIABLE32)) !== 0)
        && ((wnd.style & LBS_HASSTRINGS32) === 0);

      if (message === LB_ADDSTRING) {
        if (isOwnerDrawNoStrings32) {
          wnd.lbItems!.push('');
          wnd.lbItemData!.push(lParam);
        } else {
          const text = lParam ? emu.memory.readCString(lParam) : '';
          wnd.lbItems!.push(text);
          wnd.lbItemData!.push(0);
        }
        return wnd.lbItems!.length - 1;
      }
      if (message === LB_INSERTSTRING) {
        const idx = wParam === -1 || wParam >= wnd.lbItems!.length ? wnd.lbItems!.length : wParam;
        if (isOwnerDrawNoStrings32) {
          wnd.lbItems!.splice(idx, 0, '');
          wnd.lbItemData!.splice(idx, 0, lParam);
        } else {
          const text = lParam ? emu.memory.readCString(lParam) : '';
          wnd.lbItems!.splice(idx, 0, text);
          wnd.lbItemData!.splice(idx, 0, 0);
        }
        return idx;
      }
      if (message === LB_DELETESTRING) {
        if (wParam >= wnd.lbItems!.length) return LB_ERR;
        wnd.lbItems!.splice(wParam, 1);
        wnd.lbItemData!.splice(wParam, 1);
        if (isMultiSel) wnd.lbSelectedIndices!.delete(wParam);
        else if (wnd.lbSelectedIndex === wParam) wnd.lbSelectedIndex = -1;
        return wnd.lbItems!.length;
      }
      if (message === LB_RESETCONTENT) {
        wnd.lbItems!.length = 0;
        wnd.lbItemData!.length = 0;
        wnd.lbSelectedIndex = -1;
        if (isMultiSel) wnd.lbSelectedIndices!.clear();
        return 0;
      }
      if (message === LB_GETCOUNT) return wnd.lbItems!.length;
      if (message === LB_GETTEXT) {
        if (wParam >= wnd.lbItems!.length) return LB_ERR;
        if (isOwnerDrawNoStrings32) {
          if (lParam) emu.memory.writeU32(lParam, wnd.lbItemData![wParam] ?? 0);
          return 4;
        }
        const text = wnd.lbItems![wParam];
        if (lParam) emu.memory.writeCString(lParam, text);
        return text.length;
      }
      if (message === LB_GETTEXTLEN) {
        if (wParam >= wnd.lbItems!.length) return LB_ERR;
        if (isOwnerDrawNoStrings32) return 4;
        return wnd.lbItems![wParam].length;
      }
      if (message === LB_SETCURSEL) {
        if (!isMultiSel) {
          wnd.lbSelectedIndex = (wParam === 0xFFFFFFFF || wParam === -1) ? -1 : wParam;
          return wnd.lbSelectedIndex === -1 ? LB_ERR : wnd.lbSelectedIndex;
        }
        return LB_ERR;
      }
      if (message === LB_GETCURSEL) {
        if (!isMultiSel) return wnd.lbSelectedIndex ?? -1;
        return LB_ERR;
      }
      if (message === LB_SETSEL) {
        // wParam = TRUE/FALSE, lParam = index (-1 = all)
        if (!isMultiSel) return LB_ERR;
        if ((lParam & 0xFFFFFFFF) === 0xFFFFFFFF) {
          if (wParam) for (let i = 0; i < wnd.lbItems!.length; i++) wnd.lbSelectedIndices!.add(i);
          else wnd.lbSelectedIndices!.clear();
        } else {
          if (wParam) wnd.lbSelectedIndices!.add(lParam); else wnd.lbSelectedIndices!.delete(lParam);
        }
        return 0;
      }
      if (message === LB_GETSEL) {
        if (isMultiSel) return wnd.lbSelectedIndices!.has(wParam) ? 1 : 0;
        return wParam === (wnd.lbSelectedIndex ?? -1) ? 1 : 0;
      }
      if (message === LB_GETSELCOUNT) {
        if (!isMultiSel) return LB_ERR;
        return wnd.lbSelectedIndices!.size;
      }
      if (message === LB_GETSELITEMS) {
        if (!isMultiSel) return LB_ERR;
        const maxItems = wParam;
        const buf = lParam;
        let written = 0;
        for (const idx of wnd.lbSelectedIndices!) {
          if (written >= maxItems) break;
          emu.memory.writeU32(buf + written * 4, idx);
          written++;
        }
        return written;
      }
      if (message === LB_SELITEMRANGEEX) {
        // wParam = first, lParam = last — select if first <= last, deselect if first > last
        if (!isMultiSel) return LB_ERR;
        const first = wParam, last = lParam;
        if (first <= last) {
          for (let i = first; i <= last; i++) wnd.lbSelectedIndices!.add(i);
        } else {
          for (let i = last; i <= first; i++) wnd.lbSelectedIndices!.delete(i);
        }
        return 0;
      }
      if (message === LB_GETITEMDATA) {
        if (wParam >= wnd.lbItems!.length) return LB_ERR;
        return wnd.lbItemData![wParam] || 0;
      }
      if (message === LB_SETITEMDATA) {
        if (wParam >= wnd.lbItems!.length) return LB_ERR;
        wnd.lbItemData![wParam] = lParam;
        return 0;
      }
      if (message === LB_FINDSTRING || message === LB_FINDSTRINGEXACT) {
        const search = lParam ? emu.memory.readCString(lParam).toLowerCase() : '';
        const start = wParam === -1 ? 0 : (wParam + 1) % wnd.lbItems!.length;
        const exact = message === LB_FINDSTRINGEXACT;
        for (let n = 0; n < wnd.lbItems!.length; n++) {
          const i = (start + n) % wnd.lbItems!.length;
          const text = wnd.lbItems![i].toLowerCase();
          if (exact ? text === search : text.startsWith(search)) return i;
        }
        return LB_ERR;
      }
      if (message === LB_SELECTSTRING) {
        const search = lParam ? emu.memory.readCString(lParam).toLowerCase() : '';
        const start = wParam === -1 ? 0 : (wParam + 1) % wnd.lbItems!.length;
        for (let n = 0; n < wnd.lbItems!.length; n++) {
          const i = (start + n) % wnd.lbItems!.length;
          if (wnd.lbItems![i].toLowerCase().startsWith(search)) {
            wnd.lbSelectedIndex = i;
            return i;
          }
        }
        return LB_ERR;
      }
      if (message === LB_GETITEMRECT) {
        // Write a basic RECT — approximate 16px item height
        if (lParam) {
          const itemH = 16;
          emu.memory.writeU32(lParam, 0);                    // left
          emu.memory.writeU32(lParam + 4, wParam * itemH);   // top
          emu.memory.writeU32(lParam + 8, wnd.width);        // right
          emu.memory.writeU32(lParam + 12, (wParam + 1) * itemH); // bottom
        }
        return 1;
      }
      if (message === LB_SETTOPINDEX) return 0;
      if (message === LB_GETTOPINDEX) return 0;
      if (message === LB_SETITEMHEIGHT) return 0;
      if (message === LB_GETITEMHEIGHT) return 16;
      if (message === LB_SETCOLUMNWIDTH) return 0;
      if (message === LB_SETHORIZONTALEXTENT) return 0;
      if (message === LB_GETHORIZONTALEXTENT) return 0;
      if (message === LB_SETCOUNT) {
        // Owner-data: pre-set count
        wnd.lbItems!.length = wParam;
        wnd.lbItemData!.length = wParam;
        return 0;
      }
      if (message === LB_INITSTORAGE) return 0; // hint, no-op

      // W (Unicode) variants — same message IDs work since we store strings natively
      // LB_ADDSTRINGW = 0x01A2 is actually LB_FINDSTRINGEXACT, the real W variants
      // share the same message IDs (0x0180-0x01A8) with A versions in the listbox case.
      // The system routes A vs W based on which SendMessage variant was called.
      // Our handler reads A strings by default; for W calls the caller should use
      // SendMessageW which arrives through the W dispatch path. Handle them here:
      const LB_ADDSTRINGW     = 0x01A3; // not standard — some apps use 0x0180 for both
      const LB_GETITEXT       = 0x01A9; // not standard
      const LB_GETCARETINDEX  = 0x019F;
      const LB_SETCARETINDEX  = 0x019E;
      const LB_GETANCHORINDEX = 0x019D;
      const LB_SETANCHORINDEX = 0x019C;
      const LB_ITEMFROMPOINT  = 0x01A9;
      if (message === LB_GETCARETINDEX) return wnd.lbSelectedIndex ?? 0;
      if (message === LB_SETCARETINDEX) { wnd.lbSelectedIndex = wParam; return 0; }
      if (message === LB_GETANCHORINDEX) return wnd.lbSelectedIndex ?? 0;
      if (message === LB_SETANCHORINDEX) return 0;
      if (message === LB_ITEMFROMPOINT) {
        // lParam = MAKELPARAM(x, y) — return item index from point
        const y = (lParam >> 16) & 0xFFFF;
        const itemH = 16;
        const idx = Math.floor(y / itemH);
        if (idx >= 0 && idx < wnd.lbItems!.length) return idx;
        return 0x10000 | idx; // high word non-zero = outside client area
      }
    }

    // ComboBox messages
    if (cn === 'COMBOBOX') {
      const CB_ADDSTRING    = 0x0143;
      const CB_DELETESTRING = 0x0144;
      const CB_GETCOUNT     = 0x0146;
      const CB_GETCURSEL    = 0x0147;
      const CB_GETLBTEXT    = 0x0148;
      const CB_GETLBTEXTLEN = 0x0149;
      const CB_INSERTSTRING = 0x014A;
      const CB_RESETCONTENT = 0x014B;
      const CB_FINDSTRING   = 0x014C;
      const CB_SELECTSTRING = 0x014D;
      const CB_SETCURSEL    = 0x014E;
      const CB_GETITEMDATA  = 0x0150;
      const CB_SETITEMDATA  = 0x0151;
      const CB_FINDSTRINGEXACT = 0x0158;
      const CB_SETITEMHEIGHT = 0x0153;
      const CB_GETITEMHEIGHT = 0x0154;
      const CB_INITSTORAGE  = 0x0161;
      const CB_ERR = -1;

      if (!wnd.cbItems) { wnd.cbItems = []; wnd.cbItemData = []; wnd.cbSelectedIndex = -1; }

      if (message === CB_ADDSTRING) {
        const text = lParam ? emu.memory.readCString(lParam) : '';
        wnd.cbItems!.push(text);
        wnd.cbItemData!.push(0);
        return wnd.cbItems!.length - 1;
      }
      if (message === CB_INSERTSTRING) {
        const idx = wParam === -1 || wParam >= wnd.cbItems!.length ? wnd.cbItems!.length : wParam;
        const text = lParam ? emu.memory.readCString(lParam) : '';
        wnd.cbItems!.splice(idx, 0, text);
        wnd.cbItemData!.splice(idx, 0, 0);
        return idx;
      }
      if (message === CB_DELETESTRING) {
        if (wParam >= 0 && wParam < wnd.cbItems!.length) {
          wnd.cbItems!.splice(wParam, 1);
          wnd.cbItemData!.splice(wParam, 1);
          if (wnd.cbSelectedIndex === wParam) wnd.cbSelectedIndex = -1;
          else if (wnd.cbSelectedIndex! > wParam) wnd.cbSelectedIndex!--;
          return wnd.cbItems!.length;
        }
        return CB_ERR;
      }
      if (message === CB_RESETCONTENT) {
        wnd.cbItems = []; wnd.cbItemData = []; wnd.cbSelectedIndex = -1;
        return 0;
      }
      if (message === CB_GETCOUNT) return wnd.cbItems!.length;
      if (message === CB_GETCURSEL) return wnd.cbSelectedIndex!;
      if (message === CB_SETCURSEL) {
        const idx = wParam | 0;
        if (idx === -1) { wnd.cbSelectedIndex = -1; }
        else if (idx >= 0 && idx < wnd.cbItems!.length) { wnd.cbSelectedIndex = idx; }
        else return CB_ERR;
        return wnd.cbSelectedIndex!;
      }
      if (message === CB_GETLBTEXT) {
        if (wParam >= 0 && wParam < wnd.cbItems!.length) {
          const text = wnd.cbItems![wParam];
          if (lParam) emu.memory.writeCString(lParam, text);
          return text.length;
        }
        return CB_ERR;
      }
      if (message === CB_GETLBTEXTLEN) {
        if (wParam >= 0 && wParam < wnd.cbItems!.length) return wnd.cbItems![wParam].length;
        return CB_ERR;
      }
      if (message === CB_FINDSTRING || message === CB_FINDSTRINGEXACT) {
        const search = lParam ? emu.memory.readCString(lParam).toLowerCase() : '';
        const start = wParam === -1 ? 0 : (wParam + 1) % wnd.cbItems!.length;
        const exact = message === CB_FINDSTRINGEXACT;
        for (let n = 0; n < wnd.cbItems!.length; n++) {
          const i = (start + n) % wnd.cbItems!.length;
          const text = wnd.cbItems![i].toLowerCase();
          if (exact ? text === search : text.startsWith(search)) return i;
        }
        return CB_ERR;
      }
      if (message === CB_SELECTSTRING) {
        const search = lParam ? emu.memory.readCString(lParam).toLowerCase() : '';
        const start = wParam === -1 ? 0 : (wParam + 1) % wnd.cbItems!.length;
        for (let n = 0; n < wnd.cbItems!.length; n++) {
          const i = (start + n) % wnd.cbItems!.length;
          if (wnd.cbItems![i].toLowerCase().startsWith(search)) {
            wnd.cbSelectedIndex = i;
            return i;
          }
        }
        return CB_ERR;
      }
      if (message === CB_GETITEMDATA) {
        if (wParam >= 0 && wParam < wnd.cbItemData!.length) return wnd.cbItemData![wParam];
        return CB_ERR;
      }
      if (message === CB_SETITEMDATA) {
        if (wParam >= 0 && wParam < wnd.cbItemData!.length) { wnd.cbItemData![wParam] = lParam; return 0; }
        return CB_ERR;
      }
      if (message === CB_SETITEMHEIGHT || message === CB_GETITEMHEIGHT) return 16;
      if (message === CB_INITSTORAGE) return 0;
    }

    // TreeView messages
    if (cn === 'SYSTREEVIEW32') {
      const TVM_INSERTITEMA = 0x1100;
      const TVM_INSERTITEMW = 0x1132;
      const TVM_SETIMAGELIST = 0x1109;
      const TVM_SETBKCOLOR = 0x111D;
      const TVM_SETTEXTCOLOR = 0x111E;
      const TVM_EXPAND = 0x1102;
      const TVM_SELECTITEM = 0x110B;
      const TVM_DELETEITEM = 0x1101;
      const TVM_GETITEMA = 0x110C;
      const TVM_GETITEMW = 0x113E;
      const TVM_SETITEMA = 0x110D;
      const TVM_SETITEMW = 0x113F;
      const TVM_GETNEXTITEM = 0x110A;
      const TVM_GETCOUNT = 0x1105;
      const TVI_ROOT = 0xFFFF0000 >>> 0;
      const TVI_FIRST = 0xFFFF0001 >>> 0;
      const TVI_LAST = 0xFFFF0002 >>> 0;

      if (!wnd.treeItems) { wnd.treeItems = new Map(); wnd.treeNextId = 1; }

      if (message === TVM_SETIMAGELIST) {
        // wParam = TVSIL_NORMAL(0) or TVSIL_STATE(2), lParam = HIMAGELIST
        const prev = wnd.treeImageList ?? 0;
        if (wParam === 0) wnd.treeImageList = lParam;
        return prev;
      }
      if (message === TVM_INSERTITEMA || message === TVM_INSERTITEMW) {
        // lParam points to TVINSERTSTRUCT: hParent(4) hInsertAfter(4) then TVITEM
        const hParent = emu.memory.readU32(lParam) >>> 0;
        const _hInsertAfter = emu.memory.readU32(lParam + 4) >>> 0;
        // TVITEM: mask(4) hItem(4) state(4) stateMask(4) pszText(4) cchTextMax(4) iImage(4) iSelectedImage(4) cChildren(4) lParam(4)
        const mask = emu.memory.readU32(lParam + 8);
        const pszText = emu.memory.readU32(lParam + 24);   // offset 8+16
        const TVIF_TEXT = 0x0001;
        const TVIF_IMAGE = 0x0002;
        const TVIF_PARAM = 0x0004;
        const TVIF_SELECTEDIMAGE = 0x0020;
        const iImage = (mask & TVIF_IMAGE) ? emu.memory.readU32(lParam + 32) : -1;
        const iSelImage = (mask & TVIF_SELECTEDIMAGE) ? emu.memory.readU32(lParam + 36) : -1;
        const itemLParam = (mask & TVIF_PARAM) ? emu.memory.readU32(lParam + 44) : 0;
        let text = '';
        if ((mask & TVIF_TEXT) && pszText && pszText !== 0xFFFFFFFF) {
          text = message === TVM_INSERTITEMA
            ? emu.memory.readCString(pszText)
            : emu.memory.readUTF16String(pszText);
        }
        const id = wnd.treeNextId!++;
        const parentId = (hParent === TVI_ROOT || hParent === 0) ? 0 : hParent;
        const item: TreeViewItem = { id, parent: parentId, text, children: [], imageIndex: iImage, selectedImageIndex: iSelImage, lParam: itemLParam };
        wnd.treeItems!.set(id, item);
        if (parentId !== 0) {
          const parentItem = wnd.treeItems!.get(parentId);
          if (parentItem) parentItem.children.push(id);
        }
        // console.log(`[TV] InsertItem id=${id} parent=${parentId} text="${text}"`);
        return id;
      }
      if (message === TVM_SETIMAGELIST) return 0;
      if (message === TVM_SETBKCOLOR) return 0;
      if (message === TVM_SETTEXTCOLOR) return 0;
      if (message === TVM_EXPAND) {
        const item = wnd.treeItems!.get(lParam);
        if (item) item.expanded = !!(wParam & 2); // TVE_EXPAND=2
        return 1;
      }
      if (message === TVM_SELECTITEM) {
        wnd.treeSelectedItem = lParam;
        return 1;
      }
      if (message === TVM_DELETEITEM) {
        if (lParam === (TVI_ROOT >>> 0) || lParam === 0) {
          wnd.treeItems!.clear();
        } else {
          wnd.treeItems!.delete(lParam);
        }
        return 1;
      }
      if (message === TVM_GETCOUNT) {
        return wnd.treeItems!.size;
      }
      if (message === TVM_GETNEXTITEM) {
        // wParam = flag, lParam = hItem
        const TVGN_ROOT = 0x0000;
        const TVGN_CHILD = 0x0004;
        const TVGN_CARET = 0x0009;
        if (wParam === TVGN_ROOT) {
          for (const [id, item] of wnd.treeItems!) {
            if (item.parent === 0) return id;
          }
          return 0;
        }
        if (wParam === TVGN_CHILD) {
          const parent = wnd.treeItems!.get(lParam);
          return parent && parent.children.length > 0 ? parent.children[0] : 0;
        }
        if (wParam === TVGN_CARET) return wnd.treeSelectedItem ?? 0;
        return 0;
      }
      // Default: return 0 for unhandled TreeView messages
      if (message >= 0x1100 && message < 0x1200) return 0;
    }

    // ListView messages
    if (cn === 'SYSLISTVIEW32') {
      const LVM_INSERTCOLUMNW = 0x1061;
      const LVM_SETIMAGELIST = 0x1003;
      const LVM_SETEXTENDEDLISTVIEWSTYLE = 0x1036;
      const LVM_GETEXTENDEDLISTVIEWSTYLE = 0x1037;
      const LVM_DELETEITEM = 0x1008;
      const LVM_DELETEALLITEMS = 0x1009;
      const LVM_GETITEMW = 0x104B;
      const LVM_INSERTITEMW = 0x104D;
      const LVM_SETITEMW = 0x104C;
      const LVM_FINDITEMW = 0x1053;
      const LVM_SETCOLUMNW = 0x1060;
      const LVM_GETITEMCOUNT = 0x1004;
      const LVM_SETBKCOLOR = 0x1001;
      const LVM_GETNEXTITEM = 0x100C;
      const LVM_GETITEMSTATE = 0x102C;
      const LVM_SETITEMSTATE = 0x102B;
      const LVM_SETTEXTCOLOR = 0x1024;
      const LVM_SETTEXTBKCOLOR = 0x1026;
      const LVIS_SELECTED = 0x2;
      const LVIS_FOCUSED = 0x1;
      const LVM_SETITEMCOUNT = 0x102F;
      const LVS_OWNERDATA = 0x1000;
      const isOwnerData = !!(wnd.style & LVS_OWNERDATA);

      if (!wnd.listColumns) wnd.listColumns = [];
      if (!wnd.listItems) wnd.listItems = [];

      if (message === LVM_INSERTCOLUMNW) {
        // lParam -> LVCOLUMNW: mask(4) fmt(4) cx(4) pszText(4) ...
        const mask = emu.memory.readU32(lParam);
        const fmt = emu.memory.readU32(lParam + 4);
        const cx = emu.memory.readU32(lParam + 8);
        const pszText = emu.memory.readU32(lParam + 12);
        const LVCF_TEXT = 0x4;
        let text = '';
        if ((mask & LVCF_TEXT) && pszText) {
          text = emu.memory.readUTF16String(pszText);
        }
        const col: ListViewColumn = { text, width: cx, fmt };
        const idx = wParam | 0;
        wnd.listColumns!.splice(idx, 0, col);
        return idx;
      }
      if (message === LVM_SETIMAGELIST) return 0;
      if (message === LVM_SETEXTENDEDLISTVIEWSTYLE) return 0;
      if (message === LVM_GETEXTENDEDLISTVIEWSTYLE) return 0;
      if (message === LVM_SETBKCOLOR || message === LVM_SETTEXTCOLOR || message === LVM_SETTEXTBKCOLOR) return 1;
      if (message === LVM_DELETEITEM) {
        const idx = wParam | 0;
        if (idx >= 0 && idx < wnd.listItems!.length) {
          wnd.listItems!.splice(idx, 1);
          return 1;
        }
        return 0;
      }
      if (message === LVM_DELETEALLITEMS) { wnd.listItems = []; return 1; }
      if (message === LVM_GETITEMCOUNT) return wnd.listItems!.length;
      if (message === LVM_SETITEMCOUNT) {
        const count = wParam | 0;
        // Resize the items array, preserving existing items where possible
        const oldLen = wnd.listItems!.length;
        if (count < oldLen) {
          wnd.listItems!.length = count;
        } else {
          for (let i = oldLen; i < count; i++) {
            wnd.listItems!.push({ text: '' });
          }
        }
        // For owner-data lists, query display info for all items
        if (isOwnerData && wnd.parent) {
          const WM_NOTIFY = 0x004E;
          const LVN_GETDISPINFOW = -177;
          // NMLVDISPINFOW: NMHDR(12) + LVITEMW(60+)
          const nmSize = 12 + 48; // NMHDR + enough LVITEMW fields
          const nm = emu.allocHeap(nmSize);
          emu.memory.writeU32(nm, hwnd);                // hwndFrom
          emu.memory.writeU32(nm + 4, wnd.controlId || 0); // idFrom
          emu.memory.writeU32(nm + 8, LVN_GETDISPINFOW & 0xFFFFFFFF); // code
          const numCols = Math.max(1, wnd.listColumns!.length);
          // Allocate a text buffer for the callback to write into
          const textBuf = emu.allocHeap(512);
          for (let i = 0; i < count; i++) {
            for (let sub = 0; sub < numCols; sub++) {
              // Fill LVITEMW at nm+12
              const lvi = nm + 12;
              const LVIF_TEXT = 0x1;
              emu.memory.writeU32(lvi + 0, LVIF_TEXT);      // mask
              emu.memory.writeU32(lvi + 4, i);              // iItem
              emu.memory.writeU32(lvi + 8, sub);            // iSubItem
              emu.memory.writeU32(lvi + 12, 0);             // state
              emu.memory.writeU32(lvi + 16, 0);             // stateMask
              emu.memory.writeU32(lvi + 20, textBuf);       // pszText
              emu.memory.writeU32(lvi + 24, 256);           // cchTextMax
              // Zero the text buffer
              emu.memory.writeU16(textBuf, 0);
              // Send WM_NOTIFY to parent
              emu.callWndProc(
                emu.handles.get<WindowInfo>(wnd.parent)?.wndProc || 0,
                wnd.parent, WM_NOTIFY, wnd.controlId || 0, nm
              );
              // Read back text from buffer (callback may have set pszText to a different pointer)
              const actualTextPtr = emu.memory.readU32(lvi + 20);
              const text = actualTextPtr ? emu.memory.readUTF16String(actualTextPtr) : '';
              if (sub === 0) {
                wnd.listItems![i].text = text;
              } else {
                if (!wnd.listItems![i].subItems) wnd.listItems![i].subItems = [];
                wnd.listItems![i].subItems![sub - 1] = text;
              }
            }
          }
        }
        return 1;
      }
      if (message === LVM_GETITEMW || message === 0x1005) { // LVM_GETITEMW or LVM_GETITEMA
        // LVITEMW: mask(4) iItem(4) iSubItem(4) state(4) stateMask(4) pszText(4) cchTextMax(4) iImage(4) lParam(4)
        const mask = emu.memory.readU32(lParam);
        const iItem = emu.memory.readU32(lParam + 4);
        const iSubItem = emu.memory.readU32(lParam + 8);
        const LVIF_TEXT = 0x1;
        const LVIF_PARAM = 0x4;
        if (iItem >= wnd.listItems!.length) return 0;
        const item = wnd.listItems![iItem];
        if ((mask & LVIF_TEXT)) {
          const bufPtr = emu.memory.readU32(lParam + 20);
          const bufMax = emu.memory.readU32(lParam + 24);
          if (bufPtr && bufMax > 0) {
            let text = '';
            if (iSubItem === 0) {
              text = item.text;
            } else if (item.subItems && item.subItems[iSubItem - 1] != null) {
              text = item.subItems[iSubItem - 1];
            }
            const maxChars = Math.min(text.length, bufMax - 1);
            for (let i = 0; i < maxChars; i++) emu.memory.writeU16(bufPtr + i * 2, text.charCodeAt(i));
            emu.memory.writeU16(bufPtr + maxChars * 2, 0);
          }
        }
        if ((mask & LVIF_PARAM)) {
          emu.memory.writeU32(lParam + 32, item.lParam || 0);
        }
        const LVIF_STATE = 0x8;
        if ((mask & LVIF_STATE)) {
          const stateMask = emu.memory.readU32(lParam + 16);
          emu.memory.writeU32(lParam + 12, (item.state || 0) & stateMask);
        }
        return 1;
      }
      if (message === LVM_INSERTITEMW || message === LVM_SETITEMW) {
        // LVITEMW: mask(4) iItem(4) iSubItem(4) state(4) stateMask(4) pszText(4) cchTextMax(4) iImage(4) lParam(4)
        const mask = emu.memory.readU32(lParam);
        const iItem = emu.memory.readU32(lParam + 4);
        const iSubItem = emu.memory.readU32(lParam + 8);
        const pszText = emu.memory.readU32(lParam + 20);
        const itemLParam = emu.memory.readU32(lParam + 32);
        const LVIF_TEXT = 0x1;
        const LVIF_PARAM = 0x4;
        let text = '';
        if ((mask & LVIF_TEXT) && pszText && pszText !== 0xFFFFFFFF) {
          text = emu.memory.readUTF16String(pszText);
        }
        if (message === LVM_INSERTITEMW) {
          const item: ListViewItem = { text };
          if (mask & LVIF_PARAM) item.lParam = itemLParam;
          wnd.listItems!.splice(iItem, 0, item);
          return iItem;
        } else {
          // SetItem - update subitem text
          if (iItem < wnd.listItems!.length) {
            if (iSubItem === 0) {
              if (mask & LVIF_TEXT) wnd.listItems![iItem].text = text;
              if (mask & LVIF_PARAM) wnd.listItems![iItem].lParam = itemLParam;
            } else {
              if (!wnd.listItems![iItem].subItems) wnd.listItems![iItem].subItems = [];
              if (mask & LVIF_TEXT) wnd.listItems![iItem].subItems![iSubItem - 1] = text;
            }
          }
          return 1;
        }
      }
      if (message === LVM_SETCOLUMNW) {
        const mask = emu.memory.readU32(lParam);
        const fmt = emu.memory.readU32(lParam + 4);
        const cx = emu.memory.readU32(lParam + 8);
        const pszText = emu.memory.readU32(lParam + 12);
        const idx = wParam | 0;
        if (idx < wnd.listColumns!.length) {
          if (mask & 0x4) wnd.listColumns![idx].text = pszText ? emu.memory.readUTF16String(pszText) : '';
          if (mask & 0x2) wnd.listColumns![idx].width = cx;
          if (mask & 0x1) wnd.listColumns![idx].fmt = fmt;
        }
        return 1;
      }
      if (message === 0x1032) { // LVM_GETSELECTEDCOUNT
        let count = 0;
        for (const item of wnd.listItems!) if ((item.state || 0) & LVIS_SELECTED) count++;
        return count;
      }
      if (message === 0x1030 || message === 0x1081) { // LVM_SORTITEMS / LVM_SORTITEMSEX
        // Sorting requires calling a user callback — just return TRUE (no-op sort)
        return 1;
      }
      if (message === LVM_GETNEXTITEM) {
        // wParam = start index (-1 = beginning), lParam = flags (LVNI_SELECTED etc.)
        const start = (wParam | 0);
        const flags = lParam & 0xFFFF;
        const LVNI_SELECTED = 0x2;
        if (flags & LVNI_SELECTED) {
          for (let i = start + 1; i < wnd.listItems!.length; i++) {
            if ((wnd.listItems![i].state || 0) & LVIS_SELECTED) return i;
          }
          return -1;
        }
        // LVNI_ALL: just return next index
        const next = start + 1;
        return next < wnd.listItems!.length ? next : -1;
      }
      if (message === LVM_GETITEMSTATE) {
        const idx = wParam | 0;
        if (idx >= 0 && idx < wnd.listItems!.length) {
          return (wnd.listItems![idx].state || 0) & (lParam & 0xFFFF);
        }
        return 0;
      }
      if (message === LVM_SETITEMSTATE) {
        // lParam points to LVITEMW; we read state and stateMask from it
        const state = emu.memory.readU32(lParam + 12);
        const stateMask = emu.memory.readU32(lParam + 16);
        const idx = wParam | 0;
        if (idx === -1 || idx === 0xFFFFFFFF) {
          // Apply to all items
          for (const item of wnd.listItems!) {
            item.state = ((item.state || 0) & ~stateMask) | (state & stateMask);
          }
        } else if (idx >= 0 && idx < wnd.listItems!.length) {
          const item = wnd.listItems![idx];
          item.state = ((item.state || 0) & ~stateMask) | (state & stateMask);
        }
        return 1;
      }
      if (message === LVM_FINDITEMW) {
        // LVFINDINFOW: flags(4) psz(4) lParam(4) ...
        const LVFI_PARAM = 0x1;
        const LVFI_STRING = 0x2;
        const flags = emu.memory.readU32(lParam);
        const startIdx = (wParam | 0) + 1; // search starts after wParam index
        if (flags & LVFI_PARAM) {
          const searchParam = emu.memory.readU32(lParam + 8);
          for (let i = 0; i < wnd.listItems!.length; i++) {
            const idx = (startIdx + i) % wnd.listItems!.length;
            if (wnd.listItems![idx].lParam === searchParam) return idx;
          }
        }
        if (flags & LVFI_STRING) {
          const psz = emu.memory.readU32(lParam + 4);
          const searchStr = psz ? emu.memory.readUTF16String(psz) : '';
          for (let i = 0; i < wnd.listItems!.length; i++) {
            const idx = (startIdx + i) % wnd.listItems!.length;
            if (wnd.listItems![idx].text === searchStr) return idx;
          }
        }
        return -1; // not found
      }
      if (message === 0x1013) { // LVM_ENSUREVISIBLE
        return 1;
      }
      if (message === 0x1015) { // LVM_REDRAWITEMS
        // Re-query display info for items via LVN_GETDISPINFO
        if (wnd.parent && wnd.listColumns && wnd.listColumns.length > 1) {
          const parentWnd = emu.handles.get<WindowInfo>(wnd.parent);
          if (parentWnd?.wndProc) {
            const WM_NOTIFY = 0x004E;
            const LVN_GETDISPINFOW = -177;
            // Reuse cached buffers to avoid heap growth on each timer
            if (!wnd._redrawNm) {
              wnd._redrawNm = emu.allocHeap(60);
              wnd._redrawTextBuf = emu.allocHeap(512);
            }
            const nm = wnd._redrawNm!;
            const textBuf = wnd._redrawTextBuf!;
            emu.memory.writeU32(nm, hwnd);                    // hwndFrom
            emu.memory.writeU32(nm + 4, wnd.controlId || 0);  // idFrom
            emu.memory.writeU32(nm + 8, LVN_GETDISPINFOW & 0xFFFFFFFF); // code
            const lvi = nm + 12; // LVITEMW starts here
            const numCols = wnd.listColumns.length;
            for (let i = 0; i < wnd.listItems!.length; i++) {
              const item = wnd.listItems![i];
              // Re-query subitems (skip column 0 — its text was set directly via LVM_INSERTITEMW)
              for (let sub = 1; sub < numCols; sub++) {
                emu.memory.writeU32(lvi + 0, 0x1);          // mask = LVIF_TEXT
                emu.memory.writeU32(lvi + 4, i);            // iItem
                emu.memory.writeU32(lvi + 8, sub);          // iSubItem
                emu.memory.writeU32(lvi + 20, textBuf);     // pszText
                emu.memory.writeU32(lvi + 24, 256);         // cchTextMax
                emu.memory.writeU32(lvi + 32, item.lParam || 0); // lParam
                emu.memory.writeU16(textBuf, 0);
                emu.callWndProc(parentWnd.wndProc, wnd.parent, WM_NOTIFY, wnd.controlId || 0, nm);
                const actualPtr = emu.memory.readU32(lvi + 20);
                const text = actualPtr ? emu.memory.readUTF16String(actualPtr) : '';
                if (!item.subItems) item.subItems = [];
                item.subItems[sub - 1] = text;
              }
            }
          }
        }
        emu.notifyControlOverlays();
        return 1;
      }
      // Default: return 0 for unhandled ListView messages
      if (message >= 0x1000 && message < 0x1100) return 0;
    }

    // TabControl messages
    if (cn === 'SYSTABCONTROL32') {
      const TCM_GETIMAGELIST = 0x1302;
      const TCM_SETIMAGELIST = 0x1303;
      const TCM_GETITEMCOUNT = 0x1304;
      const TCM_GETITEMA = 0x1305;
      const TCM_SETITEMA = 0x1306;
      const TCM_INSERTITEMA = 0x1307;
      const TCM_DELETEITEM = 0x1308;
      const TCM_DELETEALLITEMS = 0x1309;
      const TCM_GETITEMRECT = 0x130A;
      const TCM_GETCURSEL = 0x130B;
      const TCM_SETCURSEL = 0x130C;
      const TCM_HITTEST = 0x130D;
      const TCM_ADJUSTRECT = 0x1328;
      const TCM_SETPADDING = 0x132B;
      const TCM_GETROWCOUNT = 0x132C;
      const TCM_GETCURFOCUS = 0x132F;
      const TCM_SETCURFOCUS = 0x1330;
      const TCM_SETMINTABWIDTH = 0x1331;
      const TCM_DESELECTALL = 0x1332;
      const TCM_SETITEMW = 0x133D;
      const TCM_INSERTITEMW = 0x133E;
      const TCM_GETITEMW = 0x133F;
      const TCIF_TEXT = 0x0001;
      // Helper: read text from TCITEM at lParam (A or W variant)
      const tcitemReadText = (wide: boolean): string => {
        const mask = emu.memory.readU32(lParam);
        if (!(mask & TCIF_TEXT)) return '';
        const pszText = emu.memory.readU32(lParam + 12);
        if (!pszText) return '';
        return wide ? emu.memory.readUTF16String(pszText) : emu.memory.readCString(pszText);
      };
      // Helper: write text into TCITEM at lParam (A or W variant)
      const tcitemWriteText = (text: string, wide: boolean): void => {
        const mask = emu.memory.readU32(lParam);
        if (!(mask & TCIF_TEXT)) return;
        const pszText = emu.memory.readU32(lParam + 12);
        const cchMax = emu.memory.readU32(lParam + 16);
        if (!pszText || !cchMax) return;
        const n = Math.min(text.length, cchMax - 1);
        if (wide) {
          for (let i = 0; i < n; i++) emu.memory.writeU16(pszText + i * 2, text.charCodeAt(i));
          emu.memory.writeU16(pszText + n * 2, 0);
        } else {
          for (let i = 0; i < n; i++) emu.memory.writeU8(pszText + i, text.charCodeAt(i) & 0xFF);
          emu.memory.writeU8(pszText + n, 0);
        }
      };

      if (message === TCM_INSERTITEMW || message === TCM_INSERTITEMA) {
        if (!wnd.tabItems) wnd.tabItems = [];
        const idx = wParam;
        const text = tcitemReadText(message === TCM_INSERTITEMW);
        const item = { text };
        if (idx >= wnd.tabItems.length) wnd.tabItems.push(item);
        else wnd.tabItems.splice(idx, 0, item);
        if (wnd.tabSelectedIndex === undefined) wnd.tabSelectedIndex = 0;
        return idx;
      }
      if (message === TCM_SETITEMA || message === TCM_SETITEMW) {
        const idx = wParam;
        if (!wnd.tabItems || idx >= wnd.tabItems.length) return 0;
        const mask = emu.memory.readU32(lParam);
        if (mask & TCIF_TEXT) wnd.tabItems[idx].text = tcitemReadText(message === TCM_SETITEMW);
        return 1;
      }
      if (message === TCM_GETITEMA || message === TCM_GETITEMW) {
        const idx = wParam;
        if (!wnd.tabItems || idx >= wnd.tabItems.length) return 0;
        tcitemWriteText(wnd.tabItems[idx].text, message === TCM_GETITEMW);
        return 1;
      }
      if (message === TCM_SETCURSEL) {
        const prev = wnd.tabSelectedIndex ?? -1;
        wnd.tabSelectedIndex = wParam;
        return prev;
      }
      if (message === TCM_GETCURSEL) {
        return wnd.tabSelectedIndex ?? -1;
      }
      if (message === TCM_GETITEMCOUNT) {
        return wnd.tabItems?.length ?? 0;
      }
      if (message === TCM_DELETEITEM) {
        const idx = wParam;
        if (wnd.tabItems && idx < wnd.tabItems.length) {
          wnd.tabItems.splice(idx, 1);
          if (wnd.tabSelectedIndex !== undefined && wnd.tabSelectedIndex >= wnd.tabItems.length) {
            wnd.tabSelectedIndex = Math.max(0, wnd.tabItems.length - 1);
          }
          return 1;
        }
        return 0;
      }
      if (message === TCM_DELETEALLITEMS) {
        wnd.tabItems = [];
        wnd.tabSelectedIndex = 0;
        return 1;
      }
      if (message === TCM_GETITEMRECT) {
        // Approximate: each tab ~80px wide, 22px tall
        const idx = wParam;
        if (lParam) {
          emu.memory.writeU32(lParam + 0, idx * 80);  // left
          emu.memory.writeU32(lParam + 4, 0);          // top
          emu.memory.writeU32(lParam + 8, (idx + 1) * 80); // right
          emu.memory.writeU32(lParam + 12, 22);        // bottom
        }
        return 1;
      }
      if (message === TCM_HITTEST) {
        // TCHITTESTINFO: POINT(8) + flags(4). Return tab index or -1
        const x = emu.memory.readI32(lParam);
        const y = emu.memory.readI32(lParam + 4);
        if (y < 0 || y >= 22 || !wnd.tabItems) return -1;
        const idx = Math.floor(x / 80);
        if (idx < 0 || idx >= wnd.tabItems.length) return -1;
        emu.memory.writeU32(lParam + 8, 0x01); // TCHT_ONITEM
        return idx;
      }
      if (message === TCM_ADJUSTRECT) {
        if (!wParam) {
          const top = emu.memory.readI32(lParam + 4);
          emu.memory.writeU32(lParam + 0, emu.memory.readI32(lParam + 0) + 2);
          emu.memory.writeU32(lParam + 4, top + 22);
          emu.memory.writeU32(lParam + 8, emu.memory.readI32(lParam + 8) - 2);
          emu.memory.writeU32(lParam + 12, emu.memory.readI32(lParam + 12) - 2);
        }
        return 0;
      }
      if (message === TCM_SETIMAGELIST) {
        const old = wnd.tabImageList ?? 0;
        wnd.tabImageList = lParam;
        return old;
      }
      if (message === TCM_GETIMAGELIST) return wnd.tabImageList ?? 0;
      if (message === TCM_GETCURFOCUS) return wnd.tabSelectedIndex ?? 0;
      if (message === TCM_SETCURFOCUS) { wnd.tabSelectedIndex = wParam; return 0; }
      if (message === TCM_GETROWCOUNT) return 1;
      if (message === TCM_SETMINTABWIDTH) return 0;
      if (message === TCM_SETPADDING) return 0;
      if (message === TCM_DESELECTALL) return 0;
      // Default for unhandled tab messages
      if (message >= 0x1300 && message < 0x1400) return 0;
    }

    // StatusBar messages
    if (cn === 'MSCTLS_STATUSBAR32') {
      const WM_SIZE = 0x0005;
      const WM_NCCREATE = 0x0081;
      const WM_SETTEXT_SB = 0x000C;
      const SB_SETTEXTW = 0x040B;
      const SB_SETTEXTA = 0x0401;
      const SB_GETTEXTLENGTHA = 0x0403;
      const SB_GETTEXTA = 0x0402;
      const SB_GETPARTS = 0x0406;
      const SB_SETPARTS = 0x0404;
      const SB_SIMPLE = 0x0409;
      const SB_GETBORDERS = 0x0407;
      const SB_GETRECT = 0x040A;
      // CStatusBar::Create passes CW_USEDEFAULT for height; MFC then waits for
      // the bar to "self-size" before docking. If we leave wnd.height at 0,
      // CFrameWnd::CalcDynamicLayout reserves 0 px and the status bar never
      // shows. Seed a reasonable default at NCCREATE so the initial layout
      // pass already gives the bar some thickness.
      if (message === WM_NCCREATE) {
        if (!wnd.height) wnd.height = 22;
        return 1;
      }
      // Status bars auto-resize to bottom of parent on WM_SIZE. Real CStatusBar
      // measures the font height + padding; we use a flat ~22 px default which
      // matches Win2k Tahoma. Without assigning the height the bar stays 0 px
      // tall and CFrameWnd::CalcWindowRect subtracts 0 from the client area —
      // collapsing the status bar entirely (PabloDraw's "where is my status
      // bar" bug).
      if (message === WM_SIZE) {
        const parentWnd = emu.handles.get<WindowInfo>(wnd.parent);
        if (parentWnd) {
          const { cw, ch } = getClientSize(parentWnd.style, parentWnd.hMenu !== 0, parentWnd.width, parentWnd.height);
          const statusH = wnd.height || 22;
          wnd.x = 0;
          wnd.y = ch - statusH;
          wnd.width = cw;
          wnd.height = statusH;
        }
        return 0;
      }
      if (message === SB_SETPARTS) {
        wnd.statusParts = [];
        for (let i = 0; i < wParam; i++) {
          wnd.statusParts.push(emu.memory.readI32(lParam + i * 4));
        }
        if (!wnd.statusTexts) wnd.statusTexts = [];
        return 1;
      }
      // SB_GETBORDERS writes int[3]: horizontal border, vertical border, gap
      // between parts. MFC's CStatusBar::UpdateAllPanes reads these into a
      // stack array and bases every pane position on them — leaving the array
      // unwritten fed stack garbage into SB_SETPARTS (broken pane layout).
      if (message === SB_GETBORDERS) {
        if (lParam) {
          emu.memory.writeI32(lParam, 0);     // SM_CXBORDER-ish horizontal
          emu.memory.writeI32(lParam + 4, 2); // vertical
          emu.memory.writeI32(lParam + 8, 2); // gap between parts
        }
        return 1;
      }
      if (message === SB_GETPARTS) {
        const parts = wnd.statusParts ?? [];
        if (lParam) {
          const n = Math.min(wParam, parts.length);
          for (let i = 0; i < n; i++) emu.memory.writeI32(lParam + i * 4, parts[i]);
        }
        return parts.length;
      }
      if (message === SB_GETRECT) {
        const parts = wnd.statusParts ?? [];
        if (wParam >= parts.length || !lParam) return 0;
        const left = wParam === 0 ? 0 : parts[wParam - 1];
        const right = parts[wParam] === -1 ? wnd.width : parts[wParam];
        emu.memory.writeI32(lParam, left);
        emu.memory.writeI32(lParam + 4, 2);
        emu.memory.writeI32(lParam + 8, right);
        emu.memory.writeI32(lParam + 12, Math.max(2, wnd.height - 2));
        return 1;
      }
      if (message === SB_SETTEXTW) {
        const part = wParam & 0xFF;
        if (!wnd.statusTexts) wnd.statusTexts = [];
        wnd.statusTexts[part] = lParam ? emu.memory.readUTF16String(lParam) : '';
        if (emu.notifyControlOverlays) emu.notifyControlOverlays();
        return 1;
      }
      // The real control treats WM_SETTEXT as "set part 0 text" (non-simple
      // mode) — SetWindowText(statusBar, ...) is the documented way to set the
      // message pane for apps that don't subclass the control.
      if (message === WM_SETTEXT_SB) {
        if (!wnd.statusTexts) wnd.statusTexts = [];
        const uni = (emu as any)._setTextUnicode ??
          (lParam !== 0 && emu.memory.readU8(lParam) !== 0 && emu.memory.readU8(lParam + 1) === 0);
        wnd.statusTexts[0] = lParam ? (uni ? emu.memory.readUTF16String(lParam) : emu.memory.readCString(lParam)) : '';
        if (emu.notifyControlOverlays) emu.notifyControlOverlays();
        return 1;
      }
      if (message === SB_SETTEXTA) {
        const part = wParam & 0xFF;
        if (!wnd.statusTexts) wnd.statusTexts = [];
        wnd.statusTexts[part] = lParam ? emu.memory.readCString(lParam) : '';
        if (emu.notifyControlOverlays) emu.notifyControlOverlays();
        return 1;
      }
      if (message === SB_SIMPLE) return 1;
      const SB_GETTEXTW = 0x040D;
      const SB_GETTEXTLENGTHW = 0x040C;
      if (message === SB_GETTEXTLENGTHA || message === SB_GETTEXTLENGTHW) {
        const t = wnd.statusTexts?.[wParam & 0xFF] ?? '';
        return t.length; // LOWORD=length, HIWORD=uType(0)
      }
      if (message === SB_GETTEXTA || message === SB_GETTEXTW) {
        const t = wnd.statusTexts?.[wParam & 0xFF] ?? '';
        if (lParam) {
          if (message === SB_GETTEXTW) emu.memory.writeUTF16String(lParam, t);
          else emu.memory.writeCString(lParam, t);
        }
        return t.length;
      }
      if (message >= 0x0400 && message < 0x0500) return 0;
    }

    // RichEdit messages (EM_* for RichEdit20W)
    if (cn === 'RICHEDIT20W' || cn === 'RICHEDIT20A' || cn === 'RICHEDIT') {
      const EM_STREAMIN = 0x0449;
      const EM_STREAMOUT = 0x044A;
      const EM_SETEVENTMASK = 0x0445;
      const EM_SETBKGNDCOLOR = 0x0443;
      const EM_SETCHARFORMAT = 0x0444;
      const EM_SETPARAFORMAT = 0x0447;
      const EM_SETTYPOGRAPHYOPTIONS = 0x04CA;
      const EM_SETLANGOPTIONS = 0x0478;
      const EM_GETLANGOPTIONS = 0x0479;
      const EM_SETUNDOLIMIT = 0x0446;
      const EM_GETMODIFY = 0x00B8;
      const EM_SETMODIFY = 0x00B9;
      const EM_GETSEL = 0x00B0;
      const EM_SETSEL = 0x00B1;
      const EM_GETOPTIONS = 0x044E;
      const EM_SETOPTIONS = 0x044D;
      const EM_LIMITTEXT = 0x00C5;
      const EM_EXLIMITTEXT = 0x0435;
      const EM_HIDESELECTION = 0x043F;
      const EM_GETTEXTLENGTHEX = 0x045F;

      if (message === EM_STREAMIN) {
        // EDITSTREAM at lParam: dwCookie, dwError, pfnCallback
        // Set dwError = 0 (success)
        if (lParam) emu.memory.writeU32(lParam + 4, 0);
        return 0;
      }
      if (message === EM_STREAMOUT) {
        if (lParam) emu.memory.writeU32(lParam + 4, 0);
        return 0;
      }
      if (message === EM_SETEVENTMASK) return 0;
      if (message === EM_SETBKGNDCOLOR) return 0;
      if (message === EM_SETCHARFORMAT) return 1; // TRUE = success
      if (message === EM_SETPARAFORMAT) return 1;
      if (message === EM_SETTYPOGRAPHYOPTIONS) return 1;
      if (message === EM_SETLANGOPTIONS) return 1;
      if (message === EM_GETLANGOPTIONS) return 0;
      if (message === EM_SETUNDOLIMIT) return 100;
      if (message === EM_GETMODIFY) return 0; // not modified
      if (message === EM_SETMODIFY) return 0;
      if (message === EM_GETSEL) return 0;
      if (message === EM_SETSEL) return 0;
      if (message === EM_GETOPTIONS) return 0;
      if (message === EM_SETOPTIONS) return 0;
      if (message === EM_LIMITTEXT) return 0;
      if (message === EM_EXLIMITTEXT) return 0;
      if (message === EM_HIDESELECTION) return 0;
      if (message === EM_GETTEXTLENGTHEX) return 0;
    }

    // ToolbarWindow32 (TB_*) — minimum stubs so MFC's CToolBar setup succeeds.
    // Real Windows toolbar tracks button arrays internally and renders them;
    // we don't need to do that for headless tests but we must return TRUE
    // for TB_ADDBUTTONS or MFC's CToolBar::SetButtons fails → LoadToolBar
    // returns FALSE → CMainFrame::OnCreate returns -1.
    if (cn === 'TOOLBARWINDOW32') {
      // When MFC dispatches WM_PAINT directly to the toolbar (via
      // UpdateWindow on a child or via the message pump after
      // InvalidateRect), our DispatchMessage routes here. Built-in
      // class with wndProc=0 would otherwise return 0 and paint nothing.
      // Flag the main window for repaint so renderChildControls runs
      // its renderToolbar() pass.
      const WM_PAINT_LOC = 0x000F;
      const WM_ERASEBKGND_LOC = 0x0014;
      if (message === WM_PAINT_LOC || message === WM_ERASEBKGND_LOC) {
        if (emu.mainWindow) {
          const main = emu.handles.get<WindowInfo>(emu.mainWindow);
          if (main) main.needsPaint = true;
        }
        // Validate so the toolbar doesn't keep re-firing WM_PAINT
        wnd.needsPaint = false;
        return message === WM_ERASEBKGND_LOC ? 1 : 0;
      }
      const TB_ENABLEBUTTON       = 0x0401;
      const TB_CHECKBUTTON        = 0x0402;
      const TB_PRESSBUTTON        = 0x0403;
      const TB_HIDEBUTTON         = 0x0404;
      const TB_INDETERMINATE      = 0x0405;
      const TB_ISBUTTONENABLED    = 0x0409;
      const TB_ISBUTTONCHECKED    = 0x040A;
      const TB_ISBUTTONPRESSED    = 0x040B;
      const TB_ISBUTTONHIDDEN     = 0x040C;
      const TB_ISBUTTONINDETERMINATE = 0x040D;
      const TB_SETSTATE           = 0x0411;
      const TB_GETSTATE           = 0x0412;
      const TB_ADDBITMAP          = 0x0413;
      const TB_ADDBUTTONS         = 0x0414;
      const TB_INSERTBUTTON       = 0x0415;
      const TB_DELETEBUTTON       = 0x0416;
      const TB_GETBUTTON          = 0x0417;
      const TB_BUTTONCOUNT        = 0x0418;
      const TB_COMMANDTOINDEX     = 0x0419;
      const TB_GETITEMRECT        = 0x041D;
      const TB_BUTTONSTRUCTSIZE   = 0x041E;
      const TB_SETBUTTONSIZE      = 0x041F;
      const TB_SETBITMAPSIZE      = 0x0420;
      const TB_AUTOSIZE           = 0x0421;
      const TB_GETROWS            = 0x0428;
      const TB_GETBITMAPFLAGS     = 0x0429;
      const TB_SETCMDID           = 0x042A;
      const TB_CHANGEBITMAP       = 0x042B;
      const TB_GETBITMAP          = 0x042C;
      const TB_SETINDENT          = 0x042F;
      const TB_SETIMAGELIST       = 0x0430;
      const TB_GETIMAGELIST       = 0x0431;
      const TB_LOADIMAGES         = 0x0432;
      const TB_GETRECT            = 0x0433;
      const TB_SETHOTIMAGELIST    = 0x0434;
      const TB_GETHOTIMAGELIST    = 0x0435;
      const TB_SETDISABLEDIMAGELIST = 0x0436;
      const TB_GETDISABLEDIMAGELIST = 0x0437;
      const TB_SETSTYLE           = 0x0438;
      const TB_GETSTYLE           = 0x0439;
      const TB_GETBUTTONSIZE      = 0x043A;
      const TB_SETBUTTONWIDTH     = 0x043B;
      const TB_GETMAXSIZE         = 0x0453;
      const TB_HITTEST            = 0x0445;
      const TB_SETEXTENDEDSTYLE   = 0x0454;
      const TB_GETEXTENDEDSTYLE   = 0x0455;

      // Allocate per-toolbar state if needed
      if (!wnd.tbButtons) wnd.tbButtons = [];

      if (message === TB_BUTTONSTRUCTSIZE) { wnd.tbButtonStructSize = wParam; return 0; }
      if (message === TB_ADDBUTTONS) {
        const count = wParam | 0;
        const size = wnd.tbButtonStructSize || 20;
        for (let i = 0; i < count; i++) {
          const base = lParam + i * size;
          wnd.tbButtons.push({
            iBitmap: emu.memory.readI32(base),
            idCommand: emu.memory.readI32(base + 4),
            fsState: emu.memory.readU8(base + 8),
            fsStyle: emu.memory.readU8(base + 9),
          });
        }
        return 1; // TRUE = success
      }
      if (message === TB_INSERTBUTTON) return 1;
      if (message === TB_DELETEBUTTON) { wnd.tbButtons.splice(wParam, 1); return 1; }
      if (message === TB_BUTTONCOUNT) return wnd.tbButtons.length;
      if (message === TB_ADDBITMAP) {
        // TBADDBITMAP at lParam: { HINSTANCE hInst; UINT_PTR nID; }
        // When hInst is NULL or HINST_COMMCTRL (-1), nID is an HBITMAP we
        // can render. Otherwise nID is a resource ID inside hInst — skip
        // for now (most MFC apps pass NULL+HBITMAP).
        if (lParam) {
          const hInst = emu.memory.readU32(lParam);
          const nID = emu.memory.readU32(lParam + 4);
          if (!hInst && nID && !wnd.tbBitmapHandle) wnd.tbBitmapHandle = nID;
        }
        return 0; // bitmap index 0 (we currently render from a single sheet)
      }
      if (message === TB_LOADIMAGES) return 0;
      if (message === TB_AUTOSIZE) return 0;
      if (message === TB_SETBUTTONSIZE) { wnd.tbButtonSize = lParam; return 1; }
      if (message === TB_SETBITMAPSIZE) { wnd.tbBitmapSize = lParam; return 1; }
      if (message === TB_GETBUTTONSIZE) return wnd.tbButtonSize ?? ((22 << 16) | 24);
      if (message === TB_GETROWS) return 1;
      if (message === TB_GETSTYLE) return wnd.style >>> 0;
      if (message === TB_SETSTYLE) { wnd.style = lParam >>> 0; return 0; }
      if (message === TB_GETEXTENDEDSTYLE) return 0;
      if (message === TB_SETEXTENDEDSTYLE) return 0;
      if (message === TB_SETIMAGELIST) return 0;
      if (message === TB_GETIMAGELIST) return 0;
      if (message === TB_SETHOTIMAGELIST) return 0;
      if (message === TB_GETHOTIMAGELIST) return 0;
      if (message === TB_SETDISABLEDIMAGELIST) return 0;
      if (message === TB_GETDISABLEDIMAGELIST) return 0;
      if (message === TB_SETCMDID) return 1;
      if (message === TB_SETINDENT) return 1;
      if (message === TB_SETBUTTONWIDTH) return 1;
      if (message === TB_GETBITMAP) return 0;
      if (message === TB_GETBITMAPFLAGS) return 0;
      if (message === TB_CHANGEBITMAP) return 1;
      if (message === TB_HITTEST) {
        // lParam -> POINT in client coords; returns the button index, or a
        // negative value when the point is not on a button.
        if (!lParam) return -1;
        const px = emu.memory.readI32(lParam);
        const py = emu.memory.readI32(lParam + 4);
        const TBSTYLE_SEP_HT = 0x01;
        for (let i = 0; i < wnd.tbButtons.length; i++) {
          const r = toolbarItemRect(wnd, i);
          if (r && px >= r.l && px < r.r && py >= r.t && py < r.b) {
            return (wnd.tbButtons[i].fsStyle & TBSTYLE_SEP_HT) ? -1 : i;
          }
        }
        return -1;
      }
      if (message === TB_COMMANDTOINDEX) {
        const idx = wnd.tbButtons.findIndex(b => b.idCommand === wParam);
        return idx;
      }
      if (message === TB_GETBUTTON) {
        const btn = wnd.tbButtons[wParam];
        if (!btn || !lParam) return 0;
        emu.memory.writeI32(lParam, btn.iBitmap);
        emu.memory.writeI32(lParam + 4, btn.idCommand);
        emu.memory.writeU8(lParam + 8, btn.fsState);
        emu.memory.writeU8(lParam + 9, btn.fsStyle);
        return 1;
      }
      if (message === TB_GETSTATE) {
        const idx = wnd.tbButtons.findIndex(b => b.idCommand === wParam);
        return idx >= 0 ? wnd.tbButtons[idx].fsState : -1;
      }
      if (message === TB_SETSTATE) {
        const idx = wnd.tbButtons.findIndex(b => b.idCommand === wParam);
        if (idx >= 0) wnd.tbButtons[idx].fsState = lParam & 0xFF;
        return 1;
      }
      if (message === TB_ENABLEBUTTON || message === TB_CHECKBUTTON || message === TB_PRESSBUTTON ||
          message === TB_HIDEBUTTON || message === TB_INDETERMINATE) return 1;
      if (message === TB_ISBUTTONENABLED || message === TB_ISBUTTONCHECKED || message === TB_ISBUTTONPRESSED ||
          message === TB_ISBUTTONHIDDEN || message === TB_ISBUTTONINDETERMINATE) return 0;
      if (message === TB_GETITEMRECT || message === TB_GETRECT) {
        // TB_GETITEMRECT takes a button INDEX, TB_GETRECT a command ID. The
        // rect must be the button's REAL position: MFC's CToolBar::OnToolHitTest
        // walks every button with TB_GETITEMRECT + PtInRect to decide whether a
        // click hit a button — a fixed (0,0,22,22) answer made every click past
        // the first button look like toolbar-void, which starts a CDockContext
        // toolbar DRAG (modal tracking loop that swallows the WM_LBUTTONUP).
        const idx = message === TB_GETRECT
          ? wnd.tbButtons.findIndex(b => b.idCommand === wParam)
          : wParam;
        const r = toolbarItemRect(wnd, idx);
        if (!r || !lParam) return 0;
        emu.memory.writeI32(lParam, r.l);
        emu.memory.writeI32(lParam + 4, r.t);
        emu.memory.writeI32(lParam + 8, r.r);
        emu.memory.writeI32(lParam + 12, r.b);
        return 1;
      }
      if (message === TB_GETMAXSIZE) {
        if (lParam) {
          emu.memory.writeI32(lParam, wnd.tbButtons.length * 22);
          emu.memory.writeI32(lParam + 4, 22);
        }
        return 1;
      }
      // Catch-all for other TB_* messages — return 0 (most are queries that
      // accept 0 as "don't know"; SET-style ops have already been handled above).
      if (message >= 0x0400 && message < 0x0500) return 0;
    }

    return null; // not handled — proceed to wndProc
  };

  // Expose for DefWindowProcA: MFC's CToolBar::SetButtons (and similar control
  // helpers) call DefWindowProc(TB_*, ...) directly instead of SendMessage,
  // because they're already inside the control's wndProc and want to fall
  // through to the original built-in behaviour. Our DefWindowProcA must
  // therefore consult this dispatcher.
  emu.dispatchBuiltinMessage = handleBuiltinMessage;

  user32.register('SendMessageA', 4, () => {
    const hwnd = emu.readArg(0);
    const message = emu.readArg(1);
    const wParam = emu.readArg(2);
    const lParam = emu.readArg(3);
    // Handle built-in messages for controls with wndProc: 0
    let wnd = emu.handles.get<WindowInfo>(hwnd);
    // Resolve pseudo-handles from GetDlgItem: high word = parent hwnd, low word = control ID
    let resolvedHwnd = hwnd;
    if (!wnd && hwnd > 0xFFFF) {
      const parentHwnd = (hwnd >>> 16) & 0xFFFF;
      const ctrlId = hwnd & 0xFFFF;
      for (const [h, data] of emu.handles.findByType('window')) {
        const w = data as WindowInfo;
        if (w.parent === parentHwnd && w.controlId === ctrlId) {
          wnd = w;
          resolvedHwnd = h;
          break;
        }
      }
    }
    if (!wnd) return 0;

    if (!wnd.wndProc) {
      const result = handleBuiltinMessage(resolvedHwnd, message, wParam, lParam);
      if (result !== null) return result;
      return 0; // no wndProc to call
    }

    // Try built-in handling first for messages we intercept (but not WM_SETTEXT — forward that to wndProc)
    const builtin = handleBuiltinMessage(resolvedHwnd, message, wParam, lParam);
    if (builtin !== null && (message === WM_GETTEXT || message === WM_GETTEXTLENGTH
        || message === 0x00F0 || message === 0x00F1 || message === 0x0030 || message === 0x0031
        || message === 0x0172 || message === 0x0173 // STM_SETIMAGE / STM_GETIMAGE
        || (message >= 0x00B0 && message <= 0x00D5) // EM_* Edit control messages
        || (message >= 0x0180 && message <= 0x01B3) // LB_* ListBox messages
        || (message >= 0x0140 && message <= 0x0163) // CB_* ComboBox messages
        || (message >= 0x0300 && message <= 0x0303) // WM_CUT/WM_COPY/WM_PASTE/WM_CLEAR
        || message >= 0x1000)) { // Common control messages
      return builtin;
    }

    return emu.callWndProc(wnd.wndProc, resolvedHwnd, message, wParam, lParam);
  });

  user32.register('PostQuitMessage', 1, () => {
    const exitCode = emu.readArg(0);
    console.log(`[MSG] PostQuitMessage(${exitCode})`);
    emu.postMessage(0, WM_QUIT, exitCode, 0);
    return 0;
  });

  user32.register('SendMessageW', 4, () => {
    const hwnd = emu.readArg(0);
    const message = emu.readArg(1);
    const wParam = emu.readArg(2);
    const lParam = emu.readArg(3);
    let wnd = emu.handles.get<WindowInfo>(hwnd);
    let resolvedHwnd = hwnd;
    if (!wnd && hwnd > 0xFFFF) {
      const parentHwnd = (hwnd >>> 16) & 0xFFFF;
      const ctrlId = hwnd & 0xFFFF;
      for (const [h, data] of emu.handles.findByType('window')) {
        const w = data as WindowInfo;
        if (w.parent === parentHwnd && w.controlId === ctrlId) {
          wnd = w;
          resolvedHwnd = h;
          break;
        }
      }
    }
    if (!wnd) return 0;

    // Handle WM_SETTEXT with UTF-16
    if (message === WM_SETTEXT && lParam) {
      const newTitle = emu.memory.readUTF16String(lParam);
      if (newTitle !== wnd.title) {
        wnd.title = newTitle;
        if (wnd.domInput) wnd.domInput.value = newTitle;
        if (wnd.parent && wnd.parent === emu.mainWindow) {
          const parentWnd = emu.handles.get<WindowInfo>(wnd.parent);
          if (parentWnd) { parentWnd.needsPaint = true; }
        }
        emu.notifyControlOverlays();
      }
      // Forward WM_SETTEXT to custom controls so they update their internal state
      if (wnd.wndProc) {
        return emu.callWndProc(wnd.wndProc, resolvedHwnd, message, wParam, lParam);
      }
      return 1;
    }

    // Handle WM_GETTEXT with UTF-16
    if (message === WM_GETTEXT && lParam && wParam > 0) {
      const text = wnd.title || '';
      const maxChars = Math.min(text.length, (wParam >>> 0) - 1);
      for (let i = 0; i < maxChars; i++) {
        emu.memory.writeU16(lParam + i * 2, text.charCodeAt(i));
      }
      emu.memory.writeU16(lParam + maxChars * 2, 0);
      return maxChars;
    }

    if (message === WM_GETTEXTLENGTH) {
      const text = wnd.title || '';
      // For EDIT controls, return length with \r\n line endings (matching EM_GETHANDLE buffer)
      const cls = (wnd.classInfo?.baseClassName || wnd.classInfo?.className || '').toUpperCase();
      if (cls === 'EDIT') {
        return text.replace(/\r?\n/g, '\r\n').length;
      }
      return text.length;
    }

    if (!wnd.wndProc) {
      const result = handleBuiltinMessage(resolvedHwnd, message, wParam, lParam, true);
      if (result !== null) return result;
      return 0; // no wndProc to call
    }

    // Try built-in handling first for messages we intercept (but not WM_SETTEXT — forward that to wndProc)
    const builtin = handleBuiltinMessage(resolvedHwnd, message, wParam, lParam, true);
    if (builtin !== null && (message === WM_GETTEXT || message === WM_GETTEXTLENGTH
        || message === 0x00F0 || message === 0x00F1 || message === 0x0030 || message === 0x0031
        || message === 0x0172 || message === 0x0173 // STM_SETIMAGE / STM_GETIMAGE
        || (message >= 0x00B0 && message <= 0x00D5) // EM_* Edit control messages
        || (message >= 0x0180 && message <= 0x01B3) // LB_* ListBox messages
        || (message >= 0x0140 && message <= 0x0163) // CB_* ComboBox messages
        || (message >= 0x0300 && message <= 0x0303) // WM_CUT/WM_COPY/WM_PASTE/WM_CLEAR
        || message >= 0x1000)) { // Common control messages (ListView, TabControl, TreeView, etc.)
      return builtin;
    }

    return emu.callWndProc(wnd.wndProc, resolvedHwnd, message, wParam, lParam);
  });

  // W versions are functionally identical to their A counterparts
  user32.register('GetMessageW', 4, emu.apiDefs.get('USER32.DLL:GetMessageA')?.handler!);
  user32.register('PeekMessageW', 5, emu.apiDefs.get('USER32.DLL:PeekMessageA')?.handler!);
  user32.register('DispatchMessageW', 1, emu.apiDefs.get('USER32.DLL:DispatchMessageA')?.handler!);
  user32.register('PostMessageW', 4, emu.apiDefs.get('USER32.DLL:PostMessageA')?.handler!);

  user32.register('PostThreadMessageW', 4, () => 1); // pretend success
  user32.register('PostThreadMessageA', 4, () => 1);

  user32.register('GetMessageTime', 0, () => (Date.now() & 0xFFFFFFFF) >>> 0);
  // GetMessagePos returns the screen-coords cursor position packed as
  // LOWORD=x, HIWORD=y. Reuses emu.cursorX/Y maintained by mouse events
  // and SetCursorPos.
  user32.register('GetMessagePos', 0, () => {
    return ((emu.cursorY & 0xFFFF) << 16) | (emu.cursorX & 0xFFFF);
  });

  // DDE message functions
  user32.register('ReuseDDElParam', 5, () => {
    const lParam = emu.readArg(0);
    return lParam; // just pass through
  });

  user32.register('UnpackDDElParam', 4, () => 1);

  user32.register('InSendMessage', 0, () => 0); // FALSE - not processing SendMessage

  // SendNotifyMessageA — like SendMessage but returns immediately for other-thread windows
  // In our single-threaded emulator, behaves identically to SendMessageA
  user32.register('SendNotifyMessageA', 4, () => {
    const hwnd = emu.readArg(0);
    const message = emu.readArg(1);
    const wParam = emu.readArg(2);
    const lParam = emu.readArg(3);
    if (hwnd === 0xFFFF || hwnd === 0) return 1; // HWND_BROADCAST or NULL — just succeed
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (!wnd?.wndProc) return 1;
    return emu.callWndProc(wnd.wndProc, hwnd, message, wParam, lParam);
  });
}

/** Populate task/application ListView from processRegistry (for taskmgr's Applications tab) */
function updateTaskListView(emu: Emulator, mainHwnd: number): void {
  if (!emu.processRegistry) return;
  const mainWnd = emu.handles.get<WindowInfo>(mainHwnd);
  if (!mainWnd?.childList) return;

  // Find a SysListView32 whose initial text was "任务" (task list) — id=1053 in taskmgr
  let taskListHwnd = 0;
  let taskListWnd: WindowInfo | null = null;
  for (const childHwnd of mainWnd.childList) {
    const child = emu.handles.get<WindowInfo>(childHwnd);
    if (!child?.childList) continue;
    for (const grandChildHwnd of child.childList) {
      const gc = emu.handles.get<WindowInfo>(grandChildHwnd);
      if (gc && gc.classInfo?.className?.toUpperCase() === 'SYSLISTVIEW32' && gc.controlId === 1053) {
        taskListHwnd = grandChildHwnd;
        taskListWnd = gc;
        break;
      }
    }
    if (taskListHwnd) break;
  }
  if (!taskListWnd) return;

  // Get window list from registry
  const windows = emu.processRegistry.getWindowList().filter(w => w.visible && w.title);

  // Build items from windows (skip our own emulator's main window if it's taskmgr)
  if (!taskListWnd.listItems) taskListWnd.listItems = [];

  // Sync: update existing items, add new ones, remove stale ones
  const currentTitles = new Set(taskListWnd.listItems.map(i => i.text));
  const newTitles = new Set(windows.map(w => w.title));

  // Remove items no longer present
  taskListWnd.listItems = taskListWnd.listItems.filter(i => newTitles.has(i.text));

  // Add new items
  for (const w of windows) {
    if (!currentTitles.has(w.title)) {
      taskListWnd.listItems.push({
        text: w.title,
      });
    }
  }

  emu.notifyControlOverlays();
}
