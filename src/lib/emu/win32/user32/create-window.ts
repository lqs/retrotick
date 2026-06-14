import { type Emulator, getNextCascadePos } from '../../emulator';
import type { WindowInfo } from './types';
import { getClientSize, clientSizeOf, computeNcInset, clampToMinTrackSize, invalidateForResize } from './_helpers';
import { buildMenuHandleTree } from './menu';
import {
  WM_CREATE, WM_NCCREATE, WM_NCCALCSIZE, WM_SHOWWINDOW,
  WM_SIZE, WM_ACTIVATE, WM_ACTIVATEAPP, WM_ERASEBKGND, WM_PAINT, WM_DESTROY,
  WM_NCDESTROY, WM_WINDOWPOSCHANGED,
  CW_USEDEFAULT,
} from '../types';

// A top-level window of a built-in CONTROL class is never an app's main
// window on real Windows — it's a utility/message-pump window (e.g. calc.exe
// creates a top-level WS_VISIBLE EDIT named "CalcMsgPumpWnd" before its real
// Calculator dialog). Promoting it steals the main-window slot from the real
// frame/dialog that follows. (#32770 dialogs stay promotable — dialog-based
// apps are legitimate.)
const NEVER_MAIN_CLASSES = new Set([
  'BUTTON', 'EDIT', 'STATIC', 'LISTBOX', 'COMBOBOX', 'SCROLLBAR',
  'TOOLTIPS_CLASS32', 'MSCTLS_HOTKEY32', 'MSCTLS_TRACKBAR32',
  'MSCTLS_PROGRESS32', 'MSCTLS_STATUSBAR32', 'MSCTLS_UPDOWN32',
  'SYSTABCONTROL32', 'SYSLISTVIEW32', 'SYSTREEVIEW32', 'SYSHEADER32',
  'SYSANIMATE32', 'SYSLINK', 'TOOLBARWINDOW32', 'REBARWINDOW32',
  'RICHEDIT20W', 'RICHEDIT20A', 'RICHEDIT',
]);
export function isUtilityWindowClass(wnd: WindowInfo): boolean {
  return NEVER_MAIN_CLASSES.has((wnd.classInfo?.className ?? '').toUpperCase());
}

export function registerCreateWindow(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');
  const windowClasses = emu.windowClasses;
  const atomToClassName = emu.atomToClassName;

  // Resolve className from either a string pointer or an ATOM
  function resolveClassName(classNamePtr: number): string {
    if (classNamePtr < 0x10000) {
      // It's an ATOM, look up the class name
      return atomToClassName.get(classNamePtr) || `#${classNamePtr}`;
    }
    return emu.memory.readCString(classNamePtr);
  }

  function resolveClassNameW(classNamePtr: number): string {
    if (classNamePtr < 0x10000) {
      return atomToClassName.get(classNamePtr) || `#${classNamePtr}`;
    }
    return emu.memory.readUTF16String(classNamePtr);
  }

  user32.register('CreateWindowExA', 12, () => {
    const exStyle = emu.readArg(0);
    const classNamePtr = emu.readArg(1);
    const titlePtr = emu.readArg(2);
    const style = emu.readArg(3);
    let x = emu.readArg(4) | 0;
    let y = emu.readArg(5) | 0;
    let width = emu.readArg(6) | 0;
    let height = emu.readArg(7) | 0;
    const hParent = emu.readArg(8);
    const hMenu = emu.readArg(9);
    const hInstance = emu.readArg(10);
    const lpParam = emu.readArg(11);

    const className = resolveClassName(classNamePtr);
    const title = titlePtr ? emu.memory.readCString(titlePtr) : '';

    const cls = windowClasses.get(className) || windowClasses.get(className.toUpperCase());
    if (!cls) {
      console.warn(`Window class not found: ${className} (classNamePtr=0x${classNamePtr.toString(16)}, registered: [${[...windowClasses.keys()].join(', ')}])`);
      return 0;
    }

    // Handle CW_USEDEFAULT — when x is CW_USEDEFAULT for an overlapped window,
    // Windows uses defaults for all of x, y, width, height. The size default
    // is ~75% of the work area (Win32 docs: "system default size"), not a
    // hardcoded 320x240; small apps look right at small sizes, but framed MFC
    // apps with docked toolbars + a canvas (PabloDraw) need a real default.
    // Open framed apps wide enough that a typical document view (CScrollView)
    // fits without a horizontal scrollbar: a too-small default makes the editor
    // narrower than its content, forcing a scrollbar and clipping margin guides.
    // Capped to the available desktop so it never exceeds the screen.
    const sw0 = emu.screenWidth || 1024, sh0 = emu.screenHeight || 768;
    const defaultW = Math.min(sw0, Math.max(1024, Math.floor(sw0 * 0.85)));
    const defaultH = Math.min(sh0, Math.max(640, Math.floor(sh0 * 0.85)));
    if (x === (CW_USEDEFAULT | 0) && !(style & 0x40000000)) {
      const pos = cls.wndProc ? getNextCascadePos(emu.screenWidth, emu.screenHeight) : { x: 0, y: 0 };
      x = pos.x;
      y = y === (CW_USEDEFAULT | 0) ? pos.y : y;
      if ((width | 0) === (CW_USEDEFAULT | 0) || width === 0) width = defaultW;
      if ((height | 0) === (CW_USEDEFAULT | 0) || height === 0) height = defaultH;
    } else {
      if ((width | 0) === (CW_USEDEFAULT | 0)) width = defaultW;
      if ((height | 0) === (CW_USEDEFAULT | 0)) height = defaultH;
      if (y === (CW_USEDEFAULT | 0)) y = 0;
    }


    const wnd: WindowInfo = {
      hwnd: 0,
      classInfo: cls,
      wndProc: cls.wndProc,
      parent: hParent,
      x, y, width, height,
      style, exStyle,
      title,
      visible: !!(style & 0x10000000), // WS_VISIBLE
      hMenu,
      extraBytes: new Uint8Array(Math.max(0, cls.cbWndExtra)),
      userData: 0,
      ownerThreadId: emu.currentThread?.id,
    };

    // Auto-load menu from class menuName if hMenu=0 for non-child windows
    const WS_CHILD = 0x40000000;
    if (!hMenu && !(style & WS_CHILD) && cls.menuName && emu.menuItems) {
      wnd.hMenu = buildMenuHandleTree(emu, emu.menuItems);
    }

    const hwnd = emu.handles.alloc('window', wnd);
    wnd.hwnd = hwnd;

    console.log(`[WND] CreateWindowExA class="${className}" title="${title}" hwnd=0x${hwnd.toString(16)} pos=${x},${y} size=${width}x${height} parent=0x${hParent.toString(16)} style=0x${style.toString(16)}`);

    // Register as child of parent window
    const WS_POPUP = 0x80000000;
    if (hParent && (style & WS_CHILD)) {
      const parentWnd = emu.handles.get<WindowInfo>(hParent);
      if (parentWnd) {
        if (!parentWnd.children) parentWnd.children = new Map();
        if (!parentWnd.childList) parentWnd.childList = [];
        const controlId = hMenu; // for child windows, hMenu is the control ID
        wnd.controlId = controlId;
        parentWnd.children.set(controlId, hwnd);
        parentWnd.childList.push(hwnd);
      }
    }

    // Set as main window for parentless windows with actual size
    if ((!hParent || hParent === 0) && width > 0 && height > 0 && emu.mainWindow === 0
      && !isUtilityWindowClass(wnd)) {
      emu.promoteToMainWindow(hwnd, wnd);
    }
    // If current mainWindow is an invisible/zero-size WS_POPUP (e.g. Delphi TApplication),
    // replace it with the first non-popup overlapped window (the actual visible form).
    // Don't replace a visible popup (e.g. splash screen) — wait for ShowWindow instead.
    if (emu.mainWindow !== 0 && !(style & WS_CHILD) && !(style & WS_POPUP) && width > 0 && height > 0) {
      const curMain = emu.handles.get<WindowInfo>(emu.mainWindow);
      if (curMain && (curMain.style & WS_POPUP) && (!curMain.visible || curMain.width === 0 || curMain.height === 0)) {
        console.log(`[WND] Replacing popup mainWindow 0x${emu.mainWindow.toString(16)} with overlapped 0x${hwnd.toString(16)}`);
        emu.promoteToMainWindow(hwnd, wnd);
      }
    }

    // Allocate CREATESTRUCTA on the stack for WM_CREATE
    // struct is 48 bytes: lpCreateParams, hInstance, hMenu, hwndParent, cy, cx, y, x, style, lpszName, lpszClass, dwExStyle
    const createStructAddr = emu.allocHeap(48);
    emu.memory.writeU32(createStructAddr, lpParam);
    emu.memory.writeU32(createStructAddr + 4, hInstance);
    emu.memory.writeU32(createStructAddr + 8, hMenu);
    emu.memory.writeU32(createStructAddr + 12, hParent);
    emu.memory.writeU32(createStructAddr + 16, height);
    emu.memory.writeU32(createStructAddr + 20, width);
    emu.memory.writeU32(createStructAddr + 24, y);
    emu.memory.writeU32(createStructAddr + 28, x);
    emu.memory.writeU32(createStructAddr + 32, style);
    emu.memory.writeU32(createStructAddr + 36, titlePtr);
    emu.memory.writeU32(createStructAddr + 40, classNamePtr);
    emu.memory.writeU32(createStructAddr + 44, exStyle);

    // Fire CBT hooks (HCBT_CREATEWND = 3) before WM_NCCREATE
    // CBT_CREATEWND: { CREATESTRUCT* lpcs; HWND hwndInsertAfter; }
    // CBTProc takes 3 args (nCode, wParam, lParam) → callCallback (NOT callWndProc,
    // which expects a 4-arg WndProc and would leave a 4-byte stack imbalance after
    // the hook's `ret 0xC` runs against our 4-arg push, corrupting the caller's
    // retAddr slot).
    if (emu.cbtHooks.length > 0) {
      const cbtStruct = emu.allocHeap(8);
      emu.memory.writeU32(cbtStruct, createStructAddr);
      emu.memory.writeU32(cbtStruct + 4, 0); // hwndInsertAfter
      for (const hook of emu.cbtHooks) {
        emu.callCallback(hook.lpfn, [3, hwnd, cbtStruct]);
      }
    }

    // Send WM_NCCREATE, WM_NCCALCSIZE, WM_CREATE synchronously
    // Use wnd.wndProc (not cls.wndProc) since WM_NCCREATE handler may subclass the window
    if (wnd.wndProc) {
      emu.callWndProc(wnd.wndProc, hwnd, WM_NCCREATE, 0, createStructAddr);
      // Real WM_NCCALCSIZE: pass the window rect, capture any custom client
      // inset (control-bar grippers/edges) the handler reserves.
      computeNcInset(emu, hwnd, wnd);
    } else if (emu.dispatchBuiltinMessage) {
      // Built-in controls (msctls_statusbar32, toolbarwindow32, …) have
      // wndProc=0; callStdcall(0,…) returns 0 without dispatching, so their
      // class-specific NCCREATE/NCCALCSIZE setup never ran. Route through the
      // built-in handler so a status bar can seed its default height, a
      // toolbar can reset its button list, etc.
      emu.dispatchBuiltinMessage(hwnd, WM_NCCREATE, 0, createStructAddr, false);
      emu.dispatchBuiltinMessage(hwnd, WM_NCCALCSIZE, 0, 0, false);
    }
    const createResult = wnd.wndProc
      ? emu.callWndProc(wnd.wndProc, hwnd, WM_CREATE, 0, createStructAddr)
      : (emu.dispatchBuiltinMessage?.(hwnd, WM_CREATE, 0, createStructAddr, false) ?? 0);
    console.log(`[WND] WM_CREATE result=${createResult} for hwnd=0x${hwnd.toString(16)} class="${className}"`);

    if (createResult === -1) {
      emu.handles.free(hwnd);
      return 0;
    }

    if (!hParent || hParent === 0) emu.onWindowChange?.(wnd);
    return hwnd;
  });

  // CreateWindowExW
  user32.register('CreateWindowExW', 12, () => {
    const exStyle = emu.readArg(0);
    const classNamePtr = emu.readArg(1);
    const titlePtr = emu.readArg(2);
    const style = emu.readArg(3);
    let x = emu.readArg(4) | 0;
    let y = emu.readArg(5) | 0;
    let width = emu.readArg(6) | 0;
    let height = emu.readArg(7) | 0;
    const hParent = emu.readArg(8);
    const hMenu = emu.readArg(9);
    const hInstance = emu.readArg(10);
    const lpParam = emu.readArg(11);

    const className = classNamePtr < 0x10000
      ? (atomToClassName.get(classNamePtr) || `#${classNamePtr}`)
      : emu.memory.readUTF16String(classNamePtr);
    const title = titlePtr ? emu.memory.readUTF16String(titlePtr) : '';

    const cls = windowClasses.get(className) || windowClasses.get(className.toUpperCase());
    if (!cls) {
      console.warn(`Window class not found: ${className}`);
      return 0;
    }

    // Handle CW_USEDEFAULT — when x is CW_USEDEFAULT for an overlapped window,
    // Windows uses defaults for all of x, y, width, height. The size default
    // is ~75% of the work area (Win32 docs: "system default size"), not a
    // hardcoded 320x240; framed MFC apps need a real default.
    const WS_CHILD = 0x40000000;
    // Open framed apps wide enough that a typical document view (CScrollView)
    // fits without a horizontal scrollbar: a too-small default makes the editor
    // narrower than its content, forcing a scrollbar and clipping margin guides.
    // Capped to the available desktop so it never exceeds the screen.
    const sw0 = emu.screenWidth || 1024, sh0 = emu.screenHeight || 768;
    const defaultW = Math.min(sw0, Math.max(1024, Math.floor(sw0 * 0.85)));
    const defaultH = Math.min(sh0, Math.max(640, Math.floor(sh0 * 0.85)));
    if (x === (CW_USEDEFAULT | 0) && !(style & WS_CHILD)) {
      const pos = cls.wndProc ? getNextCascadePos(emu.screenWidth, emu.screenHeight) : { x: 0, y: 0 };
      x = pos.x;
      y = y === (CW_USEDEFAULT | 0) ? pos.y : y;
      if ((width | 0) === (CW_USEDEFAULT | 0) || width === 0) width = defaultW;
      if ((height | 0) === (CW_USEDEFAULT | 0) || height === 0) height = defaultH;
    } else {
      if ((width | 0) === (CW_USEDEFAULT | 0)) width = defaultW;
      if ((height | 0) === (CW_USEDEFAULT | 0)) height = defaultH;
      if (y === (CW_USEDEFAULT | 0)) y = 0;
    }
    // Clamp absurd sizes (e.g. from corrupted registry data)
    const maxDim = Math.max(emu.screenWidth, emu.screenHeight, 1024) * 2;
    if (width > maxDim) width = 320;
    if (height > maxDim) height = 240;

    const WS_CHILD_W = 0x40000000;

    const wnd: WindowInfo = {
      hwnd: 0, classInfo: cls,
      wndProc: cls.wndProc,
      parent: hParent,
      x, y, width, height,
      style, exStyle, title,
      visible: !!(style & 0x10000000), hMenu, // WS_VISIBLE
      extraBytes: new Uint8Array(Math.max(0, cls.cbWndExtra)),
      userData: 0,
      ownerThreadId: emu.currentThread?.id,
    };

    // Auto-load menu from class menuName if hMenu=0 for non-child windows
    if (!hMenu && !(style & WS_CHILD_W) && cls.menuName && emu.menuItems) {
      wnd.hMenu = buildMenuHandleTree(emu, emu.menuItems);
    }

    const hwnd = emu.handles.alloc('window', wnd);
    wnd.hwnd = hwnd;

    console.log(`[WND] CreateWindowExW class="${className}" title="${title}" hwnd=0x${hwnd.toString(16)} size=${width}x${height} parent=0x${hParent.toString(16)} style=0x${style.toString(16)}`);

    // Register as child of parent window
    if (hParent && (style & WS_CHILD_W)) {
      const parentWnd = emu.handles.get<WindowInfo>(hParent);
      if (parentWnd) {
        if (!parentWnd.children) parentWnd.children = new Map();
        if (!parentWnd.childList) parentWnd.childList = [];
        const controlId = hMenu;
        wnd.controlId = controlId;
        parentWnd.children.set(controlId, hwnd);
        parentWnd.childList.push(hwnd);
      }
    }

    if ((!hParent || hParent === 0) && width > 0 && height > 0 && emu.mainWindow === 0
      && !isUtilityWindowClass(wnd)) {
      emu.promoteToMainWindow(hwnd, wnd);
    }
    const WS_POPUP_CW = 0x80000000;
    const WS_CHILD_CW = 0x40000000;
    if (emu.mainWindow !== 0 && !(style & WS_CHILD_CW) && !(style & WS_POPUP_CW) && width > 0 && height > 0) {
      const curMain = emu.handles.get<WindowInfo>(emu.mainWindow);
      if (curMain && (curMain.style & WS_POPUP_CW) && (!curMain.visible || curMain.width === 0 || curMain.height === 0)) {
        console.log(`[WND] Replacing popup mainWindow 0x${emu.mainWindow.toString(16)} with overlapped 0x${hwnd.toString(16)}`);
        emu.promoteToMainWindow(hwnd, wnd);
      }
    }

    const createStructAddr = emu.allocHeap(48);
    emu.memory.writeU32(createStructAddr, lpParam);
    emu.memory.writeU32(createStructAddr + 4, hInstance);
    emu.memory.writeU32(createStructAddr + 8, hMenu);
    emu.memory.writeU32(createStructAddr + 12, hParent);
    emu.memory.writeU32(createStructAddr + 16, height);
    emu.memory.writeU32(createStructAddr + 20, width);
    emu.memory.writeU32(createStructAddr + 24, y);
    emu.memory.writeU32(createStructAddr + 28, x);
    emu.memory.writeU32(createStructAddr + 32, style);
    emu.memory.writeU32(createStructAddr + 36, titlePtr);
    emu.memory.writeU32(createStructAddr + 40, classNamePtr);
    emu.memory.writeU32(createStructAddr + 44, exStyle);

    // Fire CBT hooks (HCBT_CREATEWND = 3) before WM_NCCREATE — see comment in
    // CreateWindowExA above; CBTProc is 3-arg, must use callCallback.
    if (emu.cbtHooks.length > 0) {
      const cbtStruct = emu.allocHeap(8);
      emu.memory.writeU32(cbtStruct, createStructAddr);
      emu.memory.writeU32(cbtStruct + 4, 0);
      for (const hook of emu.cbtHooks) {
        emu.callCallback(hook.lpfn, [3, hwnd, cbtStruct]);
      }
    }

    if (wnd.wndProc) {
      emu.callWndProc(wnd.wndProc, hwnd, WM_NCCREATE, 0, createStructAddr);
      // Real WM_NCCALCSIZE: pass the window rect, capture any custom client
      // inset (control-bar grippers/edges) the handler reserves.
      computeNcInset(emu, hwnd, wnd);
    } else if (emu.dispatchBuiltinMessage) {
      emu.dispatchBuiltinMessage(hwnd, WM_NCCREATE, 0, createStructAddr, true);
      emu.dispatchBuiltinMessage(hwnd, WM_NCCALCSIZE, 0, 0, true);
    }
    const createResult = wnd.wndProc
      ? emu.callWndProc(wnd.wndProc, hwnd, WM_CREATE, 0, createStructAddr)
      : (emu.dispatchBuiltinMessage?.(hwnd, WM_CREATE, 0, createStructAddr, true) ?? 0);
    console.log(`[WND] WM_CREATE result=${createResult} for hwnd=0x${hwnd.toString(16)} class="${className}"`);
    if (createResult === -1) {
      emu.handles.free(hwnd);
      return 0;
    }

    if (!hParent || hParent === 0) emu.onWindowChange?.(wnd);
    return hwnd;
  });

  user32.register('DestroyWindow', 1, () => {
    const hwnd = emu.readArg(0);
    // Send WM_DESTROY synchronously
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (wnd && wnd.wndProc) {
      emu.callWndProc(wnd.wndProc, hwnd, WM_DESTROY, 0, 0);
      emu.callWndProc(wnd.wndProc, hwnd, WM_NCDESTROY, 0, 0);
    }
    // Remove from parent's child list
    if (wnd && wnd.parent) {
      const parentWnd = emu.handles.get<WindowInfo>(wnd.parent);
      if (parentWnd) {
        if (parentWnd.childList) {
          const idx = parentWnd.childList.indexOf(hwnd);
          if (idx >= 0) parentWnd.childList.splice(idx, 1);
        }
        if (parentWnd.children && wnd.controlId !== undefined) {
          parentWnd.children.delete(wnd.controlId);
        }
      }
    }
    // If this was the main window, clear it so the next shown window can be promoted
    if (hwnd === emu.mainWindow) {
      console.log(`[WND] mainWindow 0x${hwnd.toString(16)} destroyed, clearing`);
      emu.mainWindow = 0;
    }
    emu.handles.free(hwnd);
    return 1;
  });

  user32.register('ShowWindow', 2, () => {
    const hwnd = emu.readArg(0);
    const nCmdShow = emu.readArg(1);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (!wnd) return 0;

    const wasVisible = wnd.visible;
    const SW_HIDE = 0, SW_SHOWNORMAL = 1, SW_SHOWMINIMIZED = 2, SW_MAXIMIZE = 3;
    const SW_SHOW = 5, SW_MINIMIZE = 6, SW_RESTORE = 9;
    wnd.visible = nCmdShow !== SW_HIDE;
    // Keep the WS_VISIBLE style bit in sync. Code that queries visibility via
    // GetWindowLong(GWL_STYLE)/GetStyle (e.g. MFC's CControlBar::IsVisible used
    // by CDockBar layout) reads this bit, not our boolean — leaving it set after
    // SW_HIDE makes a hidden window still reserve its layout slot.
    const WS_VISIBLE = 0x10000000;
    if (wnd.visible) wnd.style |= WS_VISIBLE; else wnd.style &= ~WS_VISIBLE;

    // Update minimized/maximized state
    if (nCmdShow === SW_MINIMIZE || nCmdShow === SW_SHOWMINIMIZED) {
      wnd.minimized = true; wnd.maximized = false;
    } else if (nCmdShow === SW_MAXIMIZE) {
      wnd.maximized = true; wnd.minimized = false;
    } else if (nCmdShow === SW_RESTORE || nCmdShow === SW_SHOWNORMAL || nCmdShow === SW_SHOW) {
      wnd.minimized = false; wnd.maximized = false;
    }

    // If no mainWindow yet, promote the first visible top-level window with actual size
    const WS_CHILD = 0x40000000;
    const WS_POPUP_SW = 0x80000000;
    if (wnd.visible && wnd.width > 0 && wnd.height > 0 && !(wnd.style & WS_CHILD)) {
      if (emu.mainWindow === 0 && !isUtilityWindowClass(wnd)) {
        console.log(`[WND] ShowWindow promoting 0x${hwnd.toString(16)} to mainWindow`);
        emu.promoteToMainWindow(hwnd, wnd);
      } else if (!(wnd.style & WS_POPUP_SW) && hwnd !== emu.mainWindow) {
        // Replace a popup mainWindow with an overlapped window being shown,
        // but only if the popup is hidden/zero-size (don't steal from a visible splash)
        const curMain = emu.handles.get<WindowInfo>(emu.mainWindow);
        if (curMain && (curMain.style & WS_POPUP_SW) && (!curMain.visible || curMain.width === 0 || curMain.height === 0)) {
          console.log(`[WND] ShowWindow replacing popup mainWindow 0x${emu.mainWindow.toString(16)} with 0x${hwnd.toString(16)}`);
          emu.promoteToMainWindow(hwnd, wnd);
        }
      }
    }

    // When the mainWindow (popup/splash) is hidden, find the next overlapped window to promote
    if (!wnd.visible && hwnd === emu.mainWindow && (wnd.style & WS_POPUP_SW)) {
      console.log(`[WND] mainWindow 0x${hwnd.toString(16)} hidden, looking for next overlapped window`);
      emu.mainWindow = 0;
      // Find the best overlapped visible window to promote
      for (const [h, candidate] of emu.handles.findByType('window') as [number, WindowInfo][]) {
        if (candidate && candidate.visible && candidate.width > 0 && candidate.height > 0
            && !(candidate.style & WS_CHILD) && !(candidate.style & WS_POPUP_SW)
            && candidate.wndProc) {
          console.log(`[WND] Promoting overlapped 0x${h.toString(16)} class="${candidate.classInfo?.className}" as new mainWindow`);
          emu.promoteToMainWindow(h, candidate);
          break;
        }
      }
    }

    // Update canvas size when main window is shown
    if (wnd.visible && wnd.width > 0 && wnd.height > 0 && hwnd === emu.mainWindow) {
      const { cw, ch } = getClientSize(wnd.style, wnd.hMenu !== 0, wnd.width, wnd.height);
      emu.setupCanvasSize(cw, ch);
      emu.onWindowChange?.(wnd);
    }

    // Send WM_SHOWWINDOW, WM_SIZE (with client area dims), WM_ACTIVATE
    emu.callWndProc(wnd.wndProc, hwnd, WM_SHOWWINDOW, wnd.visible ? 1 : 0, 0);
    const { cw, ch } = clientSizeOf(wnd);
    emu.callWndProc(wnd.wndProc, hwnd, WM_SIZE, 0,
      ((ch & 0xFFFF) << 16) | (cw & 0xFFFF));
    if (wnd.visible) {
      emu.callWndProc(wnd.wndProc, hwnd, WM_ACTIVATEAPP, 1, 0);
      emu.callWndProc(wnd.wndProc, hwnd, WM_ACTIVATE, 1, 0);
      // Mark window as needing paint (WM_PAINT synthesized by GetMessage)
      wnd.needsPaint = true;
      wnd.needsErase = true;
    }

    // Refresh control overlays when child window visibility changes
    if (wnd.visible !== wasVisible && (wnd.style & WS_CHILD)) {
      emu.notifyControlOverlays();
    }

    return wasVisible ? 1 : 0;
  });

  user32.register('UpdateWindow', 1, () => {
    const hwnd = emu.readArg(0);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (!wnd) return 0;

    // Real UpdateWindow sends only WM_PAINT (synchronously, bypassing the
    // queue) when the update region is non-empty. The erase belongs to
    // BeginPaint, which dispatches WM_ERASEBKGND with the paint DC and
    // releases it at EndPaint — leave needsErase set for it. Dispatching
    // WM_ERASEBKGND here with a getWindowDC-armed wParam leaked the arm
    // (save+clip on the shared canvas that nothing ever released).
    if (wnd.needsPaint && wnd.wndProc) {
      emu.callWndProc(wnd.wndProc, hwnd, WM_PAINT, 0, 0);
    }
    return 1;
  });

  // MoveWindow
  user32.register('MoveWindow', 6, () => {
    const hwnd = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const w = emu.readArg(3);
    const h = emu.readArg(4);
    const repaint = emu.readArg(5);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (wnd) {
      const clamped = clampToMinTrackSize(emu, hwnd, wnd, w, h);
      const sizeChanged = wnd.width !== clamped.w || wnd.height !== clamped.h;
      wnd.x = x; wnd.y = y; wnd.width = clamped.w; wnd.height = clamped.h;
      if (sizeChanged) computeNcInset(emu, hwnd, wnd);
      const { cw, ch } = clientSizeOf(wnd);
      if (hwnd === emu.mainWindow) {
        emu.setupCanvasSize(cw, ch);
      }
      if (hwnd === emu.mainWindow) emu.onWindowChange?.(wnd);
      // Send WM_SIZE with client area dimensions
      const lParam = ((ch & 0xFFFF) << 16) | (cw & 0xFFFF);
      emu.callWndProc(wnd.wndProc, hwnd, WM_SIZE, 0, lParam);
      // MoveWindow with bRepaint invalidates the full (new) client; clearing
      // any stale partial invalidRect captured at the previous size.
      if (repaint && sizeChanged) {
        invalidateForResize(emu, wnd);
      } else if (repaint) {
        wnd.needsPaint = true;
        wnd.needsErase = true;
      }
    }
    return 1;
  });

  user32.register('SetWindowPos', 7, () => {
    const hwnd = emu.readArg(0);
    const _hInsertAfter = emu.readArg(1);
    const x = emu.readArg(2) | 0;
    const y = emu.readArg(3) | 0;
    const cx = emu.readArg(4);
    const cy = emu.readArg(5);
    const uFlags = emu.readArg(6);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (!wnd) return 0;
    const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOREDRAW = 0x8, SWP_FRAMECHANGED = 0x20;
    const SWP_SHOWWINDOW = 0x40, SWP_HIDEWINDOW = 0x80;
    let sizeChanged = false;

    // Don't let SetWindowPos shrink/reposition the mainWindow to near-zero
    // (e.g. dialog-based apps where WM_INITDIALOG tries to position a tab page)
    const isMainShrink = hwnd === emu.mainWindow && !(uFlags & SWP_NOSIZE) && (cx < 2 || cy < 2);
    if (isMainShrink) return 1;

    if (!(uFlags & SWP_NOMOVE)) {
      wnd.x = x; wnd.y = y;
    }
    if (!(uFlags & SWP_NOSIZE)) {
      const clamped = clampToMinTrackSize(emu, hwnd, wnd, cx, cy);
      if (wnd.width !== clamped.w || wnd.height !== clamped.h) sizeChanged = true;
      wnd.width = clamped.w; wnd.height = clamped.h;
    }

    if (uFlags & SWP_SHOWWINDOW) wnd.visible = true;
    if (uFlags & SWP_HIDEWINDOW) wnd.visible = false;

    // Send WM_WINDOWPOSCHANGED so VCL can update internal bounds via UpdateBounds
    if (wnd.wndProc && sizeChanged) {
      // WINDOWPOS struct: hwnd, hInsertAfter, x, y, cx, cy, flags (28 bytes)
      const wpPtr = emu.allocHeap(28);
      emu.memory.writeU32(wpPtr, hwnd);
      emu.memory.writeU32(wpPtr + 4, 0); // hInsertAfter
      emu.memory.writeU32(wpPtr + 8, wnd.x || 0);
      emu.memory.writeU32(wpPtr + 12, wnd.y || 0);
      emu.memory.writeU32(wpPtr + 16, wnd.width);
      emu.memory.writeU32(wpPtr + 20, wnd.height);
      emu.memory.writeU32(wpPtr + 24, uFlags);
      emu.callWndProc(wnd.wndProc, hwnd, WM_WINDOWPOSCHANGED, 0, wpPtr);
    }

    if ((uFlags & SWP_FRAMECHANGED) || sizeChanged) {
      // A frame/size change can change the custom non-client inset; recompute.
      if (((uFlags & SWP_FRAMECHANGED) || sizeChanged)) computeNcInset(emu, hwnd, wnd);
      const { cw, ch } = clientSizeOf(wnd);
      if (hwnd === emu.mainWindow) {
        emu.setupCanvasSize(cw, ch);
        emu.onWindowChange?.(wnd);
      }
      // WM_SIZE is typically sent by DefWindowProc's WM_WINDOWPOSCHANGED handler,
      // but send it explicitly in case the app doesn't call DefWindowProc
      if (sizeChanged && wnd.wndProc) {
        emu.callWndProc(wnd.wndProc, hwnd, WM_SIZE, 0,
          ((ch & 0xFFFF) << 16) | (cw & 0xFFFF));
      }
    }

    // A resize without SWP_NOREDRAW invalidates the (new) client area in full.
    if (sizeChanged && !(uFlags & SWP_NOREDRAW)) {
      invalidateForResize(emu, wnd);
    }

    // Invalidate cached popup DC so it picks up the new position
    if (hwnd !== emu.mainWindow && !(uFlags & SWP_NOMOVE)) {
      const dcHandle = emu.windowDCs.get(hwnd);
      if (dcHandle) {
        emu.releaseChildDC(dcHandle);
        emu.handles.free(dcHandle);
        emu.windowDCs.delete(hwnd);
      }
    }
    return 1;
  });
  user32.register('BringWindowToTop', 1, () => 1);
  user32.register('GetDesktopWindow', 0, () => 0);
  // IsWindow(hwnd) → TRUE if the handle is a valid window. Apps cache hwnds
  // and check IsWindow before SendMessage to avoid touching destroyed windows
  // (e.g. MFC's CFrameWnd::OnContextMenu uses this); a blanket 1 makes apps
  // send to dangling handles, which we then silently ignore — but better to
  // tell them upfront that the window is gone.
  user32.register('IsWindow', 1, () => {
    const hwnd = emu.readArg(0);
    if (!hwnd) return 0;
    return emu.handles.getType(hwnd) === 'window' ? 1 : 0;
  });
  user32.register('IsWindowVisible', 1, () => {
    const hwnd = emu.readArg(0);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    return wnd && wnd.visible ? 1 : 0;
  });
  user32.register('IsWindowEnabled', 1, () => {
    const hwnd = emu.readArg(0);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    return wnd ? ((wnd.style & 0x08000000) ? 0 : 1) : 0; // WS_DISABLED
  });
  user32.register('IsIconic', 1, () => {
    const hwnd = emu.readArg(0);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    return (wnd && wnd.minimized) ? 1 : 0;
  });
  user32.register('IsZoomed', 1, () => {
    const hwnd = emu.readArg(0);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    return (wnd && wnd.maximized) ? 1 : 0;
  });
  user32.register('IsChild', 2, () => {
    // IsChild(hwndParent, hwnd) — check if hwnd is a child of hwndParent
    const _hParent = emu.readArg(0);
    const hwnd = emu.readArg(1);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    return (wnd && wnd.parent === _hParent) ? 1 : 0;
  });
  user32.register('GetParent', 1, () => {
    const hwnd = emu.readArg(0);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    return wnd ? (wnd.parent || 0) : 0;
  });
  user32.register('GetWindow', 2, () => {
    const hwnd = emu.readArg(0);
    const uCmd = emu.readArg(1);
    const GW_CHILD = 5, GW_HWNDNEXT = 2, GW_HWNDPREV = 3, GW_OWNER = 4, GW_HWNDFIRST = 0, GW_HWNDLAST = 1;
    if (uCmd === GW_CHILD) {
      const wnd = emu.handles.get<WindowInfo>(hwnd);
      if (wnd && wnd.childList && wnd.childList.length > 0) return wnd.childList[0];
      return 0;
    }
    if (uCmd === GW_HWNDNEXT) {
      const wnd = emu.handles.get<WindowInfo>(hwnd);
      if (!wnd || !wnd.parent) return 0;
      const parent = emu.handles.get<WindowInfo>(wnd.parent);
      if (!parent || !parent.childList) return 0;
      const idx = parent.childList.indexOf(hwnd);
      if (idx >= 0 && idx + 1 < parent.childList.length) return parent.childList[idx + 1];
      return 0;
    }
    if (uCmd === GW_HWNDPREV) {
      const wnd = emu.handles.get<WindowInfo>(hwnd);
      if (!wnd || !wnd.parent) return 0;
      const parent = emu.handles.get<WindowInfo>(wnd.parent);
      if (!parent || !parent.childList) return 0;
      const idx = parent.childList.indexOf(hwnd);
      if (idx > 0) return parent.childList[idx - 1];
      return 0;
    }
    return 0;
  });
  user32.register('SetParent', 2, () => {
    const hwndChild = emu.readArg(0);
    const hwndNewParent = emu.readArg(1);
    const child = emu.handles.get<WindowInfo>(hwndChild);
    if (!child) return 0;
    const oldParent = child.parent || 0;
    // Remove from old parent's childList
    if (oldParent) {
      const oldPW = emu.handles.get<WindowInfo>(oldParent);
      if (oldPW?.childList) {
        const idx = oldPW.childList.indexOf(hwndChild);
        if (idx >= 0) oldPW.childList.splice(idx, 1);
      }
    }
    // Add to new parent's childList
    child.parent = hwndNewParent;
    if (hwndNewParent) {
      const newPW = emu.handles.get<WindowInfo>(hwndNewParent);
      if (newPW) {
        if (!newPW.childList) newPW.childList = [];
        newPW.childList.push(hwndChild);
        if (!newPW.children) newPW.children = new Map();
        if (child.controlId !== undefined) newPW.children.set(child.controlId, hwndChild);
      }
    }
    return oldParent;
  });

  user32.register('EnableWindow', 2, () => {
    const hwnd = emu.readArg(0);
    const bEnable = emu.readArg(1);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (!wnd) return 0;
    const wasDisabled = (wnd.style & 0x08000000) !== 0;
    if (bEnable) {
      wnd.style &= ~0x08000000; // clear WS_DISABLED
    } else {
      wnd.style |= 0x08000000;  // set WS_DISABLED
    }
    // Notify overlay update so DOM buttons reflect disabled state
    emu.notifyControlOverlays();
    return wasDisabled ? 1 : 0;
  });
  user32.register('EnumWindows', 2, () => {
    const callback = emu.readArg(0);
    const lParam = emu.readArg(1);
    // Enumerate visible top-level windows
    const windows = emu.processRegistry ? emu.processRegistry.getWindowList() : [];
    // Also include current emulator's own main window if not already in the list
    const ownHwnd = emu.mainWindow;
    const hwnds = new Set(windows.filter(w => w.visible).map(w => w.hwnd));
    if (ownHwnd && !hwnds.has(ownHwnd)) {
      const wnd = emu.handles.get<WindowInfo>(ownHwnd);
      if (wnd && wnd.visible) hwnds.add(ownHwnd);
    }
    for (const hwnd of hwnds) {
      // EnumWindowsProc(HWND, LPARAM) — 2-arg callback, pass lParam as 2nd stack arg
      const ret = emu.callWndProc(callback, hwnd, lParam, 0, 0);
      if (ret === 0) break;
    }
    return 1;
  });
  user32.register('EnumThreadWindows', 3, () => 1);
  user32.register('WindowFromPoint', 2, () => 0);
  // FindWindowW/FindWindowExW are registered in misc.ts with real implementations.
  user32.register('ChildWindowFromPoint', 3, () => {
    const hwnd = emu.readArg(0);
    const x = emu.readArg(1);
    const y = emu.readArg(2);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (wnd?.children) {
      for (const [, childHwnd] of wnd.children) {
        const child = emu.handles.get<WindowInfo>(childHwnd);
        if (!child || (child.style & 0x10000000) === 0) continue; // WS_VISIBLE
        if (x >= child.x && x < child.x + child.width && y >= child.y && y < child.y + child.height) {
          return childHwnd;
        }
      }
    }
    return hwnd; // no child at point, return parent
  });
  user32.register('GetWindowThreadProcessId', 2, () => {
    const hwnd = emu.readArg(0);
    const pidPtr = emu.readArg(1);
    // Look up PID from process registry for cross-emulator windows
    let pid = emu.pid || 1;
    if (emu.processRegistry) {
      const entry = emu.processRegistry.getWindowList().find(w => w.hwnd === hwnd);
      if (entry) pid = entry.pid;
    }
    if (pidPtr) emu.memory.writeU32(pidPtr, pid);
    return pid; // thread id (use pid as a stand-in)
  });
}
