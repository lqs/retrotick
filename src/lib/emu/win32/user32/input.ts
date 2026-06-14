import type { Emulator } from '../../emulator';
import { loadSettings, getKeyboardLayout } from '../../../regional-settings';

export function registerInput(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  // Mouse capture
  user32.register('SetCapture', 1, () => {
    const hwnd = emu.readArg(0);
    emu.capturedWindow = hwnd;
    return 0;
  });

  user32.register('ReleaseCapture', 0, () => {
    emu.capturedWindow = 0;
    return 1;
  });

  user32.register('GetCapture', 0, () => {
    return emu.capturedWindow;
  });

  user32.register('GetCursorPos', 1, () => {
    const ptr = emu.readArg(0);
    if (!ptr) return 0;
    emu.memory.writeI32(ptr,     emu.cursorX | 0);
    emu.memory.writeI32(ptr + 4, emu.cursorY | 0);
    return 1;
  });

  user32.register('SetCursor', 1, () => {
    const hCursor = emu.readArg(0);
    const prev = emu.currentCursor;
    const cursorInfo2 = emu.handles.get<{ css?: string }>(hCursor);
    console.log(`[SetCursor] hCursor=0x${hCursor.toString(16)} css=${cursorInfo2?.css}`);
    emu.currentCursor = hCursor;
    const cursorInfo = emu.handles.get<{ css?: string }>(hCursor);
    if (emu.canvas) {
      const css = cursorInfo?.css || 'default';
      emu.canvas.style.cursor = css;
      if (emu.canvas.parentElement) {
        emu.canvas.parentElement.style.cursor = css;
      }
    }
    return prev;
  });
  user32.register('GetCursor', 0, () => emu.currentCursor);
  user32.register('ShowCursor', 1, () => 1);
  user32.register('GetKeyState', 1, () => {
    const vk = emu.readArg(0) & 0xFF;
    // Bit 15: key down; bit 0: toggle state (CAPS/NUM/SCROLL lock)
    return (emu.keyStates.has(vk) ? 0x8000 : 0) | (emu.keyToggles.has(vk) ? 1 : 0);
  });
  user32.register('GetAsyncKeyState', 1, () => {
    const vk = emu.readArg(0) & 0xFF;
    return emu.keyStates.has(vk) ? 0x8000 : 0;
  });
  // GetKeyboardState(lpKeyState) — fills 256-byte array with key states
  user32.register('GetKeyboardState', 1, () => {
    const ptr = emu.readArg(0);
    for (let i = 0; i < 256; i++) {
      emu.memory.writeU8(ptr + i, (emu.keyStates.has(i) ? 0x80 : 0) | (emu.keyToggles.has(i) ? 1 : 0));
    }
    return 1;
  });

  // MapVirtualKeyA(uCode, uMapType)
  const MAPVK_VK_TO_VSC = 0;
  const MAPVK_VSC_TO_VK = 1;
  const MAPVK_VK_TO_CHAR = 2;
  user32.register('MapVirtualKeyA', 2, () => {
    const uCode = emu.readArg(0);
    const uMapType = emu.readArg(1);
    const layout = getKeyboardLayout(loadSettings().keyboardLayout);
    if (uMapType === MAPVK_VK_TO_CHAR) {
      // Find the char produced by this VK (unshifted)
      for (const [ch, info] of layout.charToVK) {
        if (info.vk === uCode && !info.shift) return ch.charCodeAt(0);
      }
      return 0;
    }
    if (uMapType === MAPVK_VK_TO_VSC) {
      // Simplified VK to scan code mapping
      if (uCode >= 0x41 && uCode <= 0x5A) return uCode - 0x41 + 0x1E; // approx
      if (uCode >= 0x30 && uCode <= 0x39) return uCode - 0x30 + 0x02; // digits
      return 0;
    }
    if (uMapType === MAPVK_VSC_TO_VK) {
      // Simplified scan code to VK
      if (uCode >= 0x1E && uCode <= 0x37) return uCode - 0x1E + 0x41;
      if (uCode >= 0x02 && uCode <= 0x0B) return uCode - 0x02 + 0x30;
      return 0;
    }
    return 0;
  });
  user32.register('GetKeyNameTextA', 3, () => 0);
  user32.register('GetKeyNameTextW', 3, () => 0);

  // MapVirtualKeyW — same as A version
  user32.register('MapVirtualKeyW', 2, () => {
    const uCode = emu.readArg(0);
    const uMapType = emu.readArg(1);
    if (uMapType === MAPVK_VK_TO_VSC) {
      if (uCode >= 0x41 && uCode <= 0x5A) return uCode - 0x41 + 0x1E;
      if (uCode >= 0x30 && uCode <= 0x39) return uCode - 0x30 + 0x02;
      return 0;
    }
    if (uMapType === MAPVK_VSC_TO_VK) {
      if (uCode >= 0x1E && uCode <= 0x37) return uCode - 0x1E + 0x41;
      if (uCode >= 0x02 && uCode <= 0x0B) return uCode - 0x02 + 0x30;
      return 0;
    }
    return 0;
  });

  // VkKeyScanA(ch) → low byte = VK code, high byte = shift state; -1 if not found
  user32.register('VkKeyScanA', 1, () => {
    const ch = emu.readArg(0) & 0xFF;
    // Map ASCII characters to virtual key codes
    if (ch >= 0x61 && ch <= 0x7A) return ch - 0x20; // a-z → VK_A-VK_Z (0x41-0x5A)
    if (ch >= 0x41 && ch <= 0x5A) return 0x0100 | ch; // A-Z → shift + VK_A-VK_Z
    if (ch >= 0x30 && ch <= 0x39) return ch; // 0-9
    if (ch === 0x20) return 0x20; // space
    if (ch === 0x0D) return 0x0D; // enter
    if (ch === 0x1B) return 0x1B; // escape
    if (ch === 0x09) return 0x09; // tab
    if (ch === 0x08) return 0x08; // backspace
    return -1;
  });

  // GetKeyboardLayout(idThread) — return HKL for configured layout
  user32.register('GetKeyboardLayout', 1, () => {
    const layout = getKeyboardLayout(loadSettings().keyboardLayout);
    return layout.hkl;
  });

  // LoadKeyboardLayoutA/W(pwszKLID, Flags) — return current HKL
  user32.register('LoadKeyboardLayoutW', 2, () => {
    const layout = getKeyboardLayout(loadSettings().keyboardLayout);
    return layout.hkl;
  });
  user32.register('LoadKeyboardLayoutA', 2, () => {
    const layout = getKeyboardLayout(loadSettings().keyboardLayout);
    return layout.hkl;
  });

  // ActivateKeyboardLayout(HKL, Flags) — return previous HKL
  user32.register('ActivateKeyboardLayout', 2, () => {
    const layout = getKeyboardLayout(loadSettings().keyboardLayout);
    return layout.hkl;
  });

  // GetKeyboardLayoutList(nBuff, lpList) - returns count of keyboard layouts
  user32.register('GetKeyboardLayoutList', 2, () => {
    const nBuff = emu.readArg(0);
    const lpList = emu.readArg(1);
    const layout = getKeyboardLayout(loadSettings().keyboardLayout);
    if (nBuff > 0 && lpList) {
      emu.memory.writeU32(lpList, layout.hkl);
    }
    return 1; // one layout
  });

  // GetKeyboardType(nTypeFlag): 0=type(4=enhanced), 1=subtype(0), 2=numFuncKeys(12)
  user32.register('GetKeyboardType', 1, () => {
    const nTypeFlag = emu.readArg(0);
    if (nTypeFlag === 0) return 4;   // IBM enhanced (101/102-key)
    if (nTypeFlag === 1) return 0;   // subtype (OEM dependent)
    if (nTypeFlag === 2) return 12;  // number of function keys
    return 0;
  });

  // GetKeyboardLayoutNameW(pwszKLID) → BOOL — writes "00000409" etc
  user32.register('GetKeyboardLayoutNameW', 1, () => {
    const pwszKLID = emu.readArg(0);
    if (pwszKLID) {
      const layout = getKeyboardLayout(loadSettings().keyboardLayout);
      const name = layout.hkl.toString(16).padStart(8, '0');
      for (let i = 0; i < name.length; i++) emu.memory.writeU16(pwszKLID + i * 2, name.charCodeAt(i));
      emu.memory.writeU16(pwszKLID + name.length * 2, 0);
    }
    return 1;
  });
}
