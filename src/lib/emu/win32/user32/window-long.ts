import type { Emulator } from '../../emulator';
import type { WindowInfo } from './types';
import { getClientSize } from './_helpers';

export function registerWindowLong(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  user32.register('GetWindowLongA', 2, () => {
    const hwnd = emu.readArg(0);
    const index = emu.readArg(1) | 0;
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (!wnd) return 0;

    if (index === -16) return wnd.style; // GWL_STYLE
    if (index === -20) return wnd.exStyle; // GWL_EXSTYLE
    if (index === -21) return wnd.userData; // GWL_USERDATA
    if (index === -4) return wnd.wndProc; // GWL_WNDPROC
    if (index === -12) return wnd.controlId ?? 0; // GWL_ID
    if (index === -6) return wnd.classInfo?.hInstance ?? emu.pe?.imageBase ?? 0; // GWL_HINSTANCE

    // Positive index: extra bytes
    if (index >= 0 && index + 4 <= wnd.extraBytes.length) {
      return (wnd.extraBytes[index] | (wnd.extraBytes[index + 1] << 8) |
        (wnd.extraBytes[index + 2] << 16) | (wnd.extraBytes[index + 3] << 24)) >>> 0;
    }
    return 0;
  });

  user32.register('SetWindowLongA', 3, () => {
    const hwnd = emu.readArg(0);
    const index = emu.readArg(1) | 0;
    const value = emu.readArg(2);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (!wnd) return 0;

    let old = 0;
    if (index === -4) { old = wnd.wndProc; wnd.wndProc = value; } // GWL_WNDPROC
    else if (index === -16) {
      old = wnd.style; wnd.style = value;
      if (hwnd === emu.mainWindow) {
        const { cw, ch } = getClientSize(wnd.style, wnd.hMenu !== 0, wnd.width, wnd.height);
        emu.setupCanvasSize(cw, ch);
        emu.onWindowChange?.(wnd);
      }
    }
    else if (index === -12) { old = wnd.controlId ?? 0; wnd.controlId = value; } // GWL_ID
    else if (index === -20) { old = wnd.exStyle; wnd.exStyle = value; }
    else if (index === -21) { old = wnd.userData; wnd.userData = value; }
    else if (index >= 0 && index + 4 <= wnd.extraBytes.length) {
      old = (wnd.extraBytes[index] | (wnd.extraBytes[index + 1] << 8) |
        (wnd.extraBytes[index + 2] << 16) | (wnd.extraBytes[index + 3] << 24)) >>> 0;
      wnd.extraBytes[index] = value & 0xFF;
      wnd.extraBytes[index + 1] = (value >> 8) & 0xFF;
      wnd.extraBytes[index + 2] = (value >> 16) & 0xFF;
      wnd.extraBytes[index + 3] = (value >> 24) & 0xFF;
    }
    return old;
  });

  // W versions are identical to A
  user32.register('GetWindowLongW', 2, emu.apiDefs.get('USER32.DLL:GetWindowLongA')?.handler!);
  user32.register('SetWindowLongW', 3, emu.apiDefs.get('USER32.DLL:SetWindowLongA')?.handler!);

  const getPropKey = (namePtr: number, wide: boolean): string => {
    if (namePtr < 0x10000) return `#ATOM:${namePtr}`;
    return wide ? emu.memory.readUTF16String(namePtr) : emu.memory.readCString(namePtr);
  };

  user32.register('SetPropA', 3, () => {
    const hwnd = emu.readArg(0);
    const namePtr = emu.readArg(1);
    const value = emu.readArg(2);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (!wnd) return 0;
    if (!wnd.props) wnd.props = new Map();
    wnd.props.set(getPropKey(namePtr, false), value);
    return 1;
  });

  user32.register('GetPropA', 2, () => {
    const hwnd = emu.readArg(0);
    const namePtr = emu.readArg(1);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    return wnd?.props?.get(getPropKey(namePtr, false)) ?? 0;
  });

  user32.register('RemovePropA', 2, () => {
    const hwnd = emu.readArg(0);
    const namePtr = emu.readArg(1);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    const key = getPropKey(namePtr, false);
    const val = wnd?.props?.get(key) ?? 0;
    wnd?.props?.delete(key);
    return val;
  });

  user32.register('SetPropW', 3, () => {
    const hwnd = emu.readArg(0);
    const namePtr = emu.readArg(1);
    const value = emu.readArg(2);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (!wnd) return 0;
    if (!wnd.props) wnd.props = new Map();
    wnd.props.set(getPropKey(namePtr, true), value);
    return 1;
  });

  user32.register('GetPropW', 2, () => {
    const hwnd = emu.readArg(0);
    const namePtr = emu.readArg(1);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    return wnd?.props?.get(getPropKey(namePtr, true)) ?? 0;
  });

  user32.register('RemovePropW', 2, () => {
    const hwnd = emu.readArg(0);
    const namePtr = emu.readArg(1);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    const key = getPropKey(namePtr, true);
    const val = wnd?.props?.get(key) ?? 0;
    wnd?.props?.delete(key);
    return val;
  });

  // GCL_* indices (negative) — selectors for class-level attributes.
  // MFC's CWnd::GetIcon / CMainFrame::GetClassLong queries these; a 0 return
  // makes the small-icon area in the title bar fall back to a default, and
  // confuses scripts that read class style or wnd-extra size.
  const getClassLong = (): number => {
    const hwnd = emu.readArg(0);
    const index = emu.readArg(1) | 0;
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    const cls = wnd?.classInfo;
    if (!cls) return 0;
    if (index === -10) return cls.hbrBackground; // GCL_HBRBACKGROUND
    if (index === -12) return cls.hCursor;       // GCL_HCURSOR
    if (index === -14) return cls.hIcon;         // GCL_HICON
    if (index === -34) return cls.hIcon;         // GCL_HICONSM — same icon
    if (index === -16) return cls.hInstance;     // GCL_HMODULE
    if (index === -18) return cls.cbWndExtra;    // GCL_CBWNDEXTRA
    if (index === -20) return cls.cbClsExtra;    // GCL_CBCLSEXTRA
    if (index === -24) return cls.wndProc;       // GCL_WNDPROC
    if (index === -26) return cls.style;         // GCL_STYLE
    if (index === -8)  return cls.menuName;      // GCL_MENUNAME
    return 0;
  };
  user32.register('GetClassLongA', 2, getClassLong);
  user32.register('GetClassLongW', 2, getClassLong);

  const setClassLong = (): number => {
    const hwnd = emu.readArg(0);
    const index = emu.readArg(1) | 0;
    const value = emu.readArg(2);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    const cls = wnd?.classInfo;
    if (!cls) return 0;
    let old = 0;
    if (index === -10) { old = cls.hbrBackground; cls.hbrBackground = value; }
    else if (index === -12) { old = cls.hCursor; cls.hCursor = value; }
    else if (index === -14) { old = cls.hIcon; cls.hIcon = value; }
    else if (index === -34) { old = cls.hIcon; cls.hIcon = value; }
    else if (index === -16) { old = cls.hInstance; cls.hInstance = value; }
    else if (index === -24) { old = cls.wndProc; cls.wndProc = value; }
    else if (index === -26) { old = cls.style; cls.style = value; }
    return old;
  };
  user32.register('SetClassLongA', 3, setClassLong);
  user32.register('SetClassLongW', 3, setClassLong);
}
