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
  WM_TIMER, PM_REMOVE, CW_USEDEFAULT, HCBT_CREATEWND,
  TBM_GETPOS, TBM_GETRANGEMIN, TBM_GETRANGEMAX,
  TBM_SETPOS, TBM_SETRANGE, TBM_SETRANGEMIN, TBM_SETRANGEMAX,
} from '../types';

export function registerMessage(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  // Message loop
  // Synthesize WM_PAINT for windows that need repainting.
  // Throttled per tick: an app whose idle handler keeps invalidating
  // (animation busy-loop) would otherwise spin inside a single tick forever
  // — real Windows yields to the scheduler between frames; we yield via the
  // PeekMessage suspend path once the per-tick budget is used up.
  const synthesizePaint = (): { hwnd: number; message: number; wParam: number; lParam: number } | null => {
    if (emu._paintSynthBudget <= 0) return null;
    emu._paintSynthBudget--;
    // Check all windows for needsPaint flag
    for (const [handle, wnd] of emu.handles.findByType('window') as [number, WindowInfo][]) {
      if (!wnd || !wnd.needsPaint) continue;
      if (wnd.wndProc) {
        if (wnd.needsErase) {
          wnd.needsErase = false;
          return { hwnd: handle, message: WM_ERASEBKGND, wParam: emu.getWindowDC(handle), lParam: 0 };
        }
        // Clear needsPaint here to prevent infinite WM_PAINT if WndProc doesn't call BeginPaint
        wnd.needsPaint = false;
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
      } else {
        wnd.needsPaint = false;
      }
    }
    return null;
  };

  user32.register('GetMessageA', 4, () => {
    const pMsg = emu.readArg(0);
    const _hWnd = emu.readArg(1);
    const _msgFilterMin = emu.readArg(2);
    const _msgFilterMax = emu.readArg(3);

    if (emu.messageQueue.length > 0) {
      const msg = emu.messageQueue.shift()!;
      writeMsgStruct(emu, pMsg, msg);
      return msg.message === WM_QUIT ? 0 : 1;
    }

    // Synthesize WM_PAINT if any window needs repainting
    const paintMsg = synthesizePaint();
    if (paintMsg) {
      writeMsgStruct(emu, pMsg, paintMsg);
      return 1;
    }

    // Queue is empty — set up callback and wait
    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    emu._onMessageAvailable = () => {
      const msg = emu.messageQueue.shift()!;
      writeMsgStruct(emu, pMsg, msg);
      emu.waitingForMessage = false;
      emuCompleteThunk(emu, msg.message === WM_QUIT ? 0 : 1, stackBytes);
      if (emu.running && !emu.halted) {
        requestAnimationFrame(emu.tick);
      }
    };
    return undefined;
  });

  user32.register('PeekMessageA', 5, () => {
    const pMsg = emu.readArg(0);
    const hWnd = emu.readArg(1);
    const msgFilterMin = emu.readArg(2);
    const msgFilterMax = emu.readArg(3);
    const removeFlag = emu.readArg(4);

    // Find first message matching the filter
    const hasFilter = msgFilterMin !== 0 || msgFilterMax !== 0;
    let idx = -1;
    for (let i = 0; i < emu.messageQueue.length; i++) {
      const msg = emu.messageQueue[i];
      if (hWnd !== 0 && msg.hwnd !== hWnd) continue;
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
      const paintMsg = synthesizePaint();
      if (paintMsg) {
        if (!hasFilter || (paintMsg.message >= msgFilterMin && paintMsg.message <= msgFilterMax)) {
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
      const waitThread = emu.currentThread;
      const resumeWith0 = emu.captureThreadResume(() => {
        emu._onMessageAvailable = null;
        emu.waitingForMessage = false;
        emuCompleteThunk(emu, 0, stackBytes);
        if (emu.running && !emu.halted) {
          requestAnimationFrame(emu.tick);
        }
      });
      emu._onMessageAvailable = resumeWith0;
      requestAnimationFrame(() => {
        if ((waitThread ? waitThread._onMessageAvailable : emu._onMessageAvailable) === resumeWith0) resumeWith0();
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
    const waitThread = emu.currentThread;
    const resumeWith1 = emu.captureThreadResume(() => {
      emu._onMessageAvailable = null;
      emu.waitingForMessage = false;
      emuCompleteThunk(emu, 1, stackBytes);
      if (emu.running && !emu.halted) {
        requestAnimationFrame(emu.tick);
      }
    });
    emu._onMessageAvailable = resumeWith1;
    requestAnimationFrame(() => {
      if ((waitThread ? waitThread._onMessageAvailable : emu._onMessageAvailable) === resumeWith1) resumeWith1();
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
    const timerId = setTimeout(emu.captureThreadResume(() => {
      emu._onMessageAvailable = null;
      emu.waitingForMessage = false;
      emuCompleteThunk(emu, WAIT_TIMEOUT, stackBytes);
      if (emu.running && !emu.halted) {
        requestAnimationFrame(emu.tick);
      }
    }), dwMilliseconds);
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
    const timerId = setTimeout(emu.captureThreadResume(() => {
      emu._onMessageAvailable = null;
      emu.waitingForMessage = false;
      emuCompleteThunk(emu, WAIT_TIMEOUT, stackBytes);
      if (emu.running && !emu.halted) requestAnimationFrame(emu.tick);
    }), dwMilliseconds);
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

    // Call WndProc via stack frame replacement
    const ret = emu.callWndProc(wnd.wndProc, hwnd, message, wParam, lParam);
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

        // Fire CBT hooks (CBTProc is a 3-arg stdcall)
        if (emu.cbtHooks.length > 0) {
          const cbtStruct = emu.allocHeap(8);
          emu.memory.writeU32(cbtStruct, createStructAddr);
          emu.memory.writeU32(cbtStruct + 4, 0);
          for (const hook of emu.cbtHooks) {
            emu.callCallback(hook.lpfn, [HCBT_CREATEWND, childHwnd, cbtStruct]);
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
      const newTitle = wide ? emu.memory.readUTF16String(lParam) : emu.memory.readCString(lParam);
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

    // Superclassed controls (e.g. Delphi's TComboBox over COMBOBOX) carry the
    // base class in baseClassName — built-in message handling keys off it.
    const cn = (wnd.classInfo?.baseClassName || wnd.classInfo?.className || '').toUpperCase();

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
      const SB_SETTEXTW = 0x040B;
      const SB_SETPARTS = 0x0404;
      const SB_SIMPLE = 0x0409;
      // Status bars auto-resize to bottom of parent on WM_SIZE
      if (message === WM_SIZE) {
        const parentWnd = emu.handles.get<WindowInfo>(wnd.parent);
        if (parentWnd) {
          const { cw, ch } = getClientSize(parentWnd.style, parentWnd.hMenu !== 0, parentWnd.width, parentWnd.height);
          const statusH = wnd.height || 20;
          wnd.x = 0;
          wnd.y = ch - statusH;
          wnd.width = cw;
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
      if (message === SB_SETTEXTW) {
        const part = wParam & 0xFF;
        if (!wnd.statusTexts) wnd.statusTexts = [];
        wnd.statusTexts[part] = lParam ? emu.memory.readUTF16String(lParam) : '';
        return 1;
      }
      if (message === SB_SIMPLE) return 1;
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

    return null; // not handled — proceed to wndProc
  };

  // Expose for the BUILTIN_WNDPROC thunk (superclassed built-in controls
  // call the original class wndProc via CallWindowProc)
  emu._handleBuiltinMessage = handleBuiltinMessage;

  // Callable wndProc thunks for built-in control classes. GetClassInfo
  // returns these so a superclass's CallWindowProc reaches the built-in
  // behavior (COMBOBOX/EDIT/LISTBOX message handling) instead of a stub.
  const BUILTIN_WNDPROC_A = 0x00FE0008;
  const BUILTIN_WNDPROC_W = 0x00FE000C;
  for (const [addr, name, wide] of [[BUILTIN_WNDPROC_A, 'BUILTIN_WNDPROC_A', false], [BUILTIN_WNDPROC_W, 'BUILTIN_WNDPROC_W', true]] as const) {
    emu.thunkToApi.set(addr, { dll: 'SYSTEM', name, stackBytes: 16 });
    emu.thunkPages.add(addr >>> 12);
    emu.apiDefs.set(`SYSTEM:${name}`, {
      handler: () => {
        const hwnd = emu.readArg(0);
        const message = emu.readArg(1);
        const wParam = emu.readArg(2);
        const lParam = emu.readArg(3);
        const r = handleBuiltinMessage(hwnd, message, wParam, lParam, wide);
        return r ?? 0;
      },
      stackBytes: 16,
    });
  }
  emu._builtinWndProcA = BUILTIN_WNDPROC_A;
  emu._builtinWndProcW = BUILTIN_WNDPROC_W;

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

  user32.register('GetMessageTime', 0, () => (Date.now() & 0xFFFFFFFF) >>> 0);
  user32.register('GetMessagePos', 0, () => 0); // (0,0)

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
