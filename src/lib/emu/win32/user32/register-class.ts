import type { Emulator } from '../../emulator';
import type { WndClassInfo, WindowInfo } from './types';

export function registerRegisterClass(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  // Use window class registry from emulator (shared with other modules)
  const windowClasses = emu.windowClasses;
  const atomToClassName = emu.atomToClassName;

  // Track GetClassInfo calls to detect superclassing
  // Maps output pointer address → base class name
  const getClassInfoOutputs = new Map<number, string>();

  function registerClass(cls: WndClassInfo, inputPtr: number): number {
    // Detect superclassing: if this RegisterClass uses the same buffer
    // that GetClassInfo wrote to, the new class is a superclass of the base
    const baseClassName = getClassInfoOutputs.get(inputPtr);
    if (baseClassName && cls.className.toUpperCase() !== baseClassName.toUpperCase()) {
      cls.baseClassName = baseClassName.toUpperCase();
    }
    const atom = emu.nextClassAtom++;
    windowClasses.set(cls.className, cls);
    atomToClassName.set(atom, cls.className);
    return atom;
  }

  // Register built-in Windows control classes
  const builtinClasses = ['BUTTON', 'EDIT', 'STATIC', 'LISTBOX', 'COMBOBOX', 'SCROLLBAR', 'MDICLIENT', '#32770', 'msctls_hotkey32', 'msctls_trackbar32', 'msctls_progress32', 'msctls_statusbar32', 'msctls_updown32', 'tooltips_class32', 'SysTabControl32', 'SysListView32', 'SysTreeView32', 'SysHeader32', 'SysAnimate32', 'SysLink', 'ToolbarWindow32', 'ReBarWindow32', 'RichEdit20W', 'RICHEDIT20W', 'RichEdit20A', 'RICHEDIT'];
  for (const name of builtinClasses) {
    const COLOR_APPWORKSPACE_BRUSH = 13; // COLOR_APPWORKSPACE (12) + 1
    const cls: WndClassInfo = {
      style: 0, wndProc: 0, cbClsExtra: 0, cbWndExtra: name === '#32770' ? 30 : 0,
      hInstance: 0, hIcon: 0, hCursor: 0,
      hbrBackground: name === 'MDICLIENT' ? COLOR_APPWORKSPACE_BRUSH : 0,
      menuName: 0, className: name,
    };
    windowClasses.set(name, cls);
  }

  user32.register('RegisterClassA', 1, () => {
    const ptr = emu.readArg(0);
    // WNDCLASSA: 40 bytes
    const style = emu.memory.readU32(ptr);
    const wndProc = emu.memory.readU32(ptr + 4);
    const cbClsExtra = emu.memory.readI32(ptr + 8);
    const cbWndExtra = emu.memory.readI32(ptr + 12);
    const hInstance = emu.memory.readU32(ptr + 16);
    const hIcon = emu.memory.readU32(ptr + 20);
    const hCursor = emu.memory.readU32(ptr + 24);
    const hbrBackground = emu.memory.readU32(ptr + 28);
    const menuNamePtr = emu.memory.readU32(ptr + 32);
    const classNamePtr = emu.memory.readU32(ptr + 36);

    const className = emu.memory.readCString(classNamePtr);
    const cls: WndClassInfo = {
      style, wndProc, cbClsExtra, cbWndExtra,
      hInstance, hIcon, hCursor, hbrBackground,
      menuName: menuNamePtr, className,
    };
    return registerClass(cls, ptr);
  });

  user32.register('RegisterClassExA', 1, () => {
    const ptr = emu.readArg(0);
    // WNDCLASSEXA: 48 bytes
    const style = emu.memory.readU32(ptr + 4);
    const wndProc = emu.memory.readU32(ptr + 8);
    const cbClsExtra = emu.memory.readI32(ptr + 12);
    const cbWndExtra = emu.memory.readI32(ptr + 16);
    const hInstance = emu.memory.readU32(ptr + 20);
    const hIcon = emu.memory.readU32(ptr + 24);
    const hCursor = emu.memory.readU32(ptr + 28);
    const hbrBackground = emu.memory.readU32(ptr + 32);
    const menuNamePtr = emu.memory.readU32(ptr + 36);
    const classNamePtr = emu.memory.readU32(ptr + 40);

    const className = emu.memory.readCString(classNamePtr);
    const cls: WndClassInfo = {
      style, wndProc, cbClsExtra, cbWndExtra,
      hInstance, hIcon, hCursor, hbrBackground,
      menuName: menuNamePtr, className,
    };
    return registerClass(cls, ptr);
  });

  // RegisterClassW - reads WNDCLASSW (same layout, wide strings)
  user32.register('RegisterClassW', 1, () => {
    const ptr = emu.readArg(0);
    const style = emu.memory.readU32(ptr);
    const wndProc = emu.memory.readU32(ptr + 4);
    const cbClsExtra = emu.memory.readI32(ptr + 8);
    const cbWndExtra = emu.memory.readI32(ptr + 12);
    const hInstance = emu.memory.readU32(ptr + 16);
    const hIcon = emu.memory.readU32(ptr + 20);
    const hCursor = emu.memory.readU32(ptr + 24);
    const hbrBackground = emu.memory.readU32(ptr + 28);
    const menuNamePtr = emu.memory.readU32(ptr + 32);
    const classNamePtr = emu.memory.readU32(ptr + 36);

    const className = emu.memory.readUTF16String(classNamePtr);
    const cls: WndClassInfo = {
      style, wndProc, cbClsExtra, cbWndExtra,
      hInstance, hIcon, hCursor, hbrBackground,
      menuName: menuNamePtr, className,
    };
    return registerClass(cls, ptr);
  });

  // RegisterClassExW - reads WNDCLASSEXW (48 bytes, same layout as A but wide strings)
  user32.register('RegisterClassExW', 1, () => {
    const ptr = emu.readArg(0);
    // WNDCLASSEXW: cbSize at +0, then same offsets as WNDCLASSEXA
    const style = emu.memory.readU32(ptr + 4);
    const wndProc = emu.memory.readU32(ptr + 8);
    const cbClsExtra = emu.memory.readI32(ptr + 12);
    const cbWndExtra = emu.memory.readI32(ptr + 16);
    const hInstance = emu.memory.readU32(ptr + 20);
    const hIcon = emu.memory.readU32(ptr + 24);
    const hCursor = emu.memory.readU32(ptr + 28);
    const hbrBackground = emu.memory.readU32(ptr + 32);
    const menuNamePtr = emu.memory.readU32(ptr + 36);
    const classNamePtr = emu.memory.readU32(ptr + 40);

    const className = emu.memory.readUTF16String(classNamePtr);
    const cls: WndClassInfo = {
      style, wndProc, cbClsExtra, cbWndExtra,
      hInstance, hIcon, hCursor, hbrBackground,
      menuName: menuNamePtr, className,
    };
    return registerClass(cls, ptr);
  });

  // Helper: find the thunk address for a given API name (e.g. 'USER32.DLL:DefWindowProcA')
  function findThunkAddr(apiKey: string): number {
    for (const [addr, info] of emu.thunkToApi) {
      if (`${info.dll}:${info.name}` === apiKey) return addr;
    }
    return 0;
  }

  function getClassInfoImpl(isWide: boolean): number {
    const _hInstance = emu.readArg(0);
    const classNamePtr = emu.readArg(1);
    const outPtr = emu.readArg(2);

    // Read class name - could be an atom (low 16 bits) or a string pointer
    let className: string;
    if (classNamePtr < 0x10000) {
      className = emu.atomToClassName.get(classNamePtr) || '';
    } else {
      className = isWide ? emu.memory.readUTF16String(classNamePtr) : emu.memory.readCString(classNamePtr);
    }

    // Look up in registered classes (case-insensitive)
    let cls = windowClasses.get(className);
    if (!cls) {
      cls = windowClasses.get(className.toUpperCase());
    }
    if (!cls) return 0;

    // For built-in classes with wndProc=0, provide the BUILTIN_WNDPROC thunk
    // so a superclass's CallWindowProc reaches the built-in control behavior
    // (combo/edit/listbox messages), falling back to DefWindowProc.
    let wndProc = cls.wndProc;
    if (!wndProc) {
      wndProc = (isWide ? emu._builtinWndProcW : emu._builtinWndProcA) || 0;
      if (!wndProc) {
        const defProc = isWide ? 'USER32.DLL:DefWindowProcW' : 'USER32.DLL:DefWindowProcA';
        wndProc = findThunkAddr(defProc);
      }
    }

    // Write WNDCLASS structure (40 bytes): style, lpfnWndProc, cbClsExtra, cbWndExtra,
    // hInstance, hIcon, hCursor, hbrBackground, lpszMenuName, lpszClassName
    emu.memory.writeU32(outPtr + 0, cls.style);
    emu.memory.writeU32(outPtr + 4, wndProc);
    emu.memory.writeU32(outPtr + 8, cls.cbClsExtra);
    emu.memory.writeU32(outPtr + 12, cls.cbWndExtra);
    emu.memory.writeU32(outPtr + 16, cls.hInstance);
    emu.memory.writeU32(outPtr + 20, cls.hIcon);
    emu.memory.writeU32(outPtr + 24, cls.hCursor);
    emu.memory.writeU32(outPtr + 28, cls.hbrBackground);
    emu.memory.writeU32(outPtr + 32, cls.menuName);
    // Write class name pointer back (caller already has it)
    emu.memory.writeU32(outPtr + 36, classNamePtr);

    // Track this output for superclass detection in RegisterClass
    getClassInfoOutputs.set(outPtr, cls.className);

    return 1; // TRUE = success
  }

  user32.register('GetClassInfoA', 3, () => getClassInfoImpl(false));
  user32.register('GetClassInfoW', 3, () => getClassInfoImpl(true));
  // GetClassInfoExA/W — same as GetClassInfoA/W (WNDCLASSEX has two extra fields at the end)
  user32.register('GetClassInfoExA', 3, () => getClassInfoImpl(false));
  user32.register('GetClassInfoExW', 3, () => getClassInfoImpl(true));

  user32.register('UnregisterClassA', 2, () => 1);
  user32.register('UnregisterClassW', 2, () => 1);

  user32.register('GetClassNameA', 3, () => {
    const hwnd = emu.readArg(0);
    const bufPtr = emu.readArg(1);
    const maxCount = emu.readArg(2);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    const name = wnd?.classInfo?.className || '';
    const len = Math.min(name.length, maxCount - 1);
    for (let i = 0; i < len; i++) emu.memory.writeU8(bufPtr + i, name.charCodeAt(i));
    emu.memory.writeU8(bufPtr + len, 0);
    return len;
  });

  user32.register('GetClassNameW', 3, () => {
    const hwnd = emu.readArg(0);
    const bufPtr = emu.readArg(1);
    const maxCount = emu.readArg(2);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    const name = wnd?.classInfo?.className || '';
    const len = Math.min(name.length, maxCount - 1);
    for (let i = 0; i < len; i++) emu.memory.writeU16(bufPtr + i * 2, name.charCodeAt(i));
    emu.memory.writeU16(bufPtr + len * 2, 0);
    return len;
  });
}
