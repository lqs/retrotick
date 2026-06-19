import { useRef, useEffect, useCallback, useState, useLayoutEffect } from 'preact/hooks';
import { type Emulator, isFullwidth } from '../lib/emu/emulator';
import { cp437ToChar } from '../lib/emu/cp437';
import { loadDosSettings } from '../lib/dos-settings';
import { injectDosMouseEvent, drawGfxMouseCursor, getTextModeCursorOverride, getDisplayedTextCursor } from '../lib/emu/dos/mouse';

// Default Windows console 16-color palette (fallback for Win32 programs)
const DEFAULT_CONSOLE_COLORS = [
  '#000000', '#000080', '#008000', '#008080',
  '#800000', '#800080', '#808000', '#C0C0C0',
  '#808080', '#0000FF', '#00FF00', '#00FFFF',
  '#FF0000', '#FF00FF', '#FFFF00', '#FFFFFF',
];

/** Build 16-color palette from VGA ATC registers → DAC palette */
function getVgaConsoleColors(emu: Emulator): string[] {
  const vga = emu.vga;
  const colors: string[] = [];
  for (let i = 0; i < 16; i++) {
    const dacIndex = vga.atcRegs[i] & 0xFF;
    const r = Math.round(vga.palette[dacIndex * 3 + 0] * 255 / 63);
    const g = Math.round(vga.palette[dacIndex * 3 + 1] * 255 / 63);
    const b = Math.round(vga.palette[dacIndex * 3 + 2] * 255 / 63);
    colors.push(`rgb(${r},${g},${b})`);
  }
  return colors;
}

const TEXT_FONT = '"Cascadia Mono", "Menlo", "Consolas", "Courier New", monospace';

/** Parse VGA palette into [r,g,b] tuples for ImageData rendering. */
function getVgaConsoleColorsRGB(emu: Emulator): number[][] {
  const vga = emu.vga;
  const colors: number[][] = [];
  for (let i = 0; i < 16; i++) {
    const dacIndex = vga.atcRegs[i] & 0xFF;
    colors.push([
      Math.round(vga.palette[dacIndex * 3 + 0] * 255 / 63),
      Math.round(vga.palette[dacIndex * 3 + 1] * 255 / 63),
      Math.round(vga.palette[dacIndex * 3 + 2] * 255 / 63),
    ]);
  }
  return colors;
}

const DEFAULT_CONSOLE_COLORS_RGB = [
  [0,0,0], [0,0,128], [0,128,0], [0,128,128],
  [128,0,0], [128,0,128], [128,128,0], [192,192,192],
  [128,128,128], [0,0,255], [0,255,0], [0,255,255],
  [255,0,0], [255,0,255], [255,255,0], [255,255,255],
];

/** Render DOS text mode using VGA bitmap fonts (pixel-perfect). */
function drawTextModeBitmap(canvas: HTMLCanvasElement, emu: Emulator, COLS: number, ROWS: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const charH = emu.charHeight === 8 ? 8 : 16;
  const fontRAM = emu.vga.fontRAM;
  const banks = emu.vga.getCharMapBanks();
  const COLORS = getVgaConsoleColorsRGB(emu);
  // VGA Sequencer Clocking Mode (SR01) bit 0: 0 = 9-dot text cells, 1 = 8-dot.
  // Standard 80×25 mode 03h is 9-dot → 720×400 backing surface.
  const nineDot = (emu.vga.seqRegs[1] & 0x01) === 0;
  const CHAR_W = nineDot ? 9 : 8;
  const w = COLS * CHAR_W;
  const h = ROWS * charH;

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const imgData = ctx.createImageData(w, h);
  const pixels = imgData.data;

  const mouseOverride = getTextModeCursorOverride(emu, COLS, ROWS);

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const idx = row * COLS + col;
      const cell = emu.consoleBuffer[idx];
      const isMouseCell = !!mouseOverride && mouseOverride.row === row && mouseOverride.col === col;
      const ch = isMouseCell ? (mouseOverride!.char || 0x20) : (cell ? cell.char : 0x20);
      const attr = isMouseCell ? mouseOverride!.attr : (cell ? cell.attr : 0x07);
      let fg: number;
      let bank: number;
      if (banks.fontSwitchActive) {
        fg = attr & 0x07;
        bank = (attr & 0x08) ? banks.mapA : banks.mapB;
      } else {
        fg = attr & 0x0F;
        bank = banks.mapA;
      }
      const bg = (attr >> 4) & 0x0F;
      const fgColor = COLORS[fg];
      const bgColor = COLORS[bg];
      const fontOffset = (bank & 0x07) * 256 * 32 + (ch & 0xFF) * 32;
      const px = col * CHAR_W;
      const py = row * charH;

      // 0xC0..0xDF (CP437 box / line drawing) get column 9 = column 8 so that
      // horizontal lines stay connected at 9-dot cell width. Everything else
      // gets background in column 9. This matches real VGA hardware.
      const lineDouble = nineDot && ch >= 0xC0 && ch <= 0xDF;
      for (let y = 0; y < charH; y++) {
        const bits = fontRAM[fontOffset + y];
        const rowBase = ((py + y) * w + px) * 4;
        for (let x = 0; x < 8; x++) {
          const isSet = (bits >> (7 - x)) & 1;
          const color = isSet ? fgColor : bgColor;
          const pixIdx = rowBase + x * 4;
          pixels[pixIdx] = color[0];
          pixels[pixIdx + 1] = color[1];
          pixels[pixIdx + 2] = color[2];
          pixels[pixIdx + 3] = 255;
        }
        if (CHAR_W === 9) {
          const last = bits & 0x01;
          const c9 = (lineDouble && last) ? fgColor : bgColor;
          const pixIdx = rowBase + 8 * 4;
          pixels[pixIdx] = c9[0];
          pixels[pixIdx + 1] = c9[1];
          pixels[pixIdx + 2] = c9[2];
          pixels[pixIdx + 3] = 255;
        }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);

  // Cursor (BIOS or hardware mouse cursor — they share the unique CRTC cursor)
  const cur = getDisplayedTextCursor(emu, COLS, ROWS);
  const blink = Math.floor(Date.now() / 500) % 2 === 0;
  // Clamp scanlines to current cell height (e.g. charH=8 in 80x50 mode)
  const cs = Math.min(cur.start, charH - 1);
  const ce = Math.min(cur.end, charH - 1);
  if (blink && !cur.disabled && cs <= ce) {
    const cx = cur.x * CHAR_W;
    const cy = cur.y * charH;
    const curCell = emu.consoleBuffer[cur.y * COLS + cur.x];
    const curFg = curCell ? (curCell.attr & 0x0F) : 7;
    const c = COLORS[curFg === 0 ? 7 : curFg];
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.fillRect(cx, cy + cs, CHAR_W, ce - cs + 1);
  }
}

/** Render Win32 console text mode using browser fonts. */
function drawTextMode(canvas: HTMLCanvasElement, emu: Emulator, COLS: number, ROWS: number) {
  // DOS mode: use pixel-perfect bitmap font rendering
  if (emu.isDOS) {
    drawTextModeBitmap(canvas, emu, COLS, ROWS);
    return;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const COLORS = DEFAULT_CONSOLE_COLORS;
  const lineH = 16;
  const cellW = 8;
  const font = `${lineH}px ${TEXT_FONT}`;
  ctx.font = font;
  const naturalCharW = ctx.measureText('0').width;
  // Compress the natural-width font into 8-pixel cells so the canvas backing
  // dimensions match the CSS box (640×400 for 80×25). Without this scale, the
  // canvas was sized to ceil(COLS×naturalCharW) ≈ 768 and the browser
  // downsampled 768→640 with a non-integer ratio, making some columns lose a
  // pixel and producing visibly uneven vertical strokes (e.g. on '0' or '||').
  const xScale = cellW / naturalCharW;

  // Size canvas to match its CSS box exactly — every cell column is 1 css pixel.
  const cw = COLS * cellW;
  const ch = ROWS * lineH;
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  // Re-apply state every frame: a canvas-width assignment clears it, but the
  // <canvas> element may also have been mounted by JSX at exactly (cw, ch),
  // in which case the if above never runs and the context still carries its
  // default textBaseline='alphabetic' — fillText would then draw glyphs ~12 px
  // above their intended top, hiding row 0 off-screen.
  ctx.font = font;
  ctx.textBaseline = 'top';

  // Clear (canvas coords, no scale)
  ctx.fillStyle = COLORS[0];
  ctx.fillRect(0, 0, cw, ch);

  const mouseOverride = getTextModeCursorOverride(emu, COLS, ROWS);

  ctx.save();
  ctx.scale(xScale, 1);

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const idx = row * COLS + col;
      const cell = emu.consoleBuffer[idx];
      const isMouseCell = !!mouseOverride && mouseOverride.row === row && mouseOverride.col === col;
      if (!isMouseCell && cell && cell.char === 0) continue;

      const effChar = isMouseCell ? (mouseOverride!.char || 0x20) : (cell ? cell.char : 0);
      const effAttr = isMouseCell ? mouseOverride!.attr : (cell ? cell.attr : 0x07);
      const fg = effAttr & 0x0F;
      const bg = (effAttr >> 4) & 0x0F;
      const x = col * naturalCharW;
      const y = row * lineH;
      const wide = !isMouseCell && cell && cell.char > 0x20 && isFullwidth(cell.char);

      // Background — +1px overlap (in scaled coords) to prevent fractional gaps
      ctx.fillStyle = COLORS[bg];
      ctx.fillRect(x, y, (wide ? naturalCharW * 2 : naturalCharW) + 1, lineH);

      // Character
      const c = effChar > 0x20 ? String.fromCharCode(effChar) : '';
      if (c) {
        ctx.fillStyle = COLORS[fg];
        ctx.fillText(c, x, y);
      }
    }
  }

  ctx.restore();

  // Cursor (BIOS or hardware mouse cursor) — drawn outside ctx.scale so the
  // rectangle is exactly cellW wide in canvas pixels.
  const cur = getDisplayedTextCursor(emu, COLS, ROWS);
  const blink = Math.floor(Date.now() / 500) % 2 === 0;
  const cs = Math.min(cur.start, lineH - 1);
  const ce = Math.min(cur.end, lineH - 1);
  if (blink && !cur.disabled && cs <= ce) {
    const cx = cur.x * cellW;
    const cy = cur.y * lineH;
    const curCell = emu.consoleBuffer[cur.y * COLS + cur.x];
    const curFg = curCell ? (curCell.attr & 0x0F) : 7;
    ctx.fillStyle = COLORS[curFg === 0 ? 7 : curFg];
    ctx.fillRect(cx, cy + cs, cellW, ce - cs + 1);
  }
}

// Browser e.code → AT keyboard hardware scancode (make code)
const CODE_TO_SCANCODE: Record<string, number> = {
  Escape: 0x01,
  Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0A, Digit0: 0x0B,
  Minus: 0x0C, Equal: 0x0D, Backspace: 0x0E, Tab: 0x0F,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14,
  KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1A, BracketRight: 0x1B, Enter: 0x1C,
  KeyA: 0x1E, KeyS: 0x1F, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22,
  KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
  Backslash: 0x2B,
  KeyZ: 0x2C, KeyX: 0x2D, KeyC: 0x2E, KeyV: 0x2F, KeyB: 0x30,
  KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35,
  NumpadDivide: 0x35, NumpadMultiply: 0x37, Space: 0x39, CapsLock: 0x3A,
  F1: 0x3B, F2: 0x3C, F3: 0x3D, F4: 0x3E, F5: 0x3F,
  F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  NumLock: 0x45, ScrollLock: 0x46,
  Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4A,
  Numpad4: 0x4B, Numpad5: 0x4C, Numpad6: 0x4D, NumpadAdd: 0x4E,
  Numpad1: 0x4F, Numpad2: 0x50, Numpad3: 0x51,
  Numpad0: 0x52, NumpadDecimal: 0x53,
  F11: 0x57, F12: 0x58,
  NumpadEnter: 0x1C,
  // Navigation keys (same scancodes as numpad equivalents)
  Home: 0x47, ArrowUp: 0x48, PageUp: 0x49,
  ArrowLeft: 0x4B, ArrowRight: 0x4D,
  End: 0x4F, ArrowDown: 0x50, PageDown: 0x51,
  Insert: 0x52, Delete: 0x53,
};

// Modifier key codes — these are handled separately via make/break codes
const MODIFIER_CODES = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

const EXTENDED_NAV_CODES = new Set([
  'Home', 'ArrowUp', 'PageUp',
  'ArrowLeft', 'ArrowRight',
  'End', 'ArrowDown', 'PageDown',
  'Insert', 'Delete',
  'NumpadDivide', 'NumpadEnter',
]);

// Reverse map: printable character → US-layout scancode. Used by the Android
// `beforeinput` path, where the IME emits characters but no usable `e.code`.
const CHAR_TO_SCANCODE: Record<string, number> = {
  ' ': 0x39,
  '1': 0x02, '2': 0x03, '3': 0x04, '4': 0x05, '5': 0x06,
  '6': 0x07, '7': 0x08, '8': 0x09, '9': 0x0A, '0': 0x0B,
  '-': 0x0C, '=': 0x0D, '[': 0x1A, ']': 0x1B, '\\': 0x2B,
  ';': 0x27, "'": 0x28, '`': 0x29, ',': 0x33, '.': 0x34, '/': 0x35,
  q: 0x10, w: 0x11, e: 0x12, r: 0x13, t: 0x14, y: 0x15, u: 0x16,
  i: 0x17, o: 0x18, p: 0x19,
  a: 0x1E, s: 0x1F, d: 0x20, f: 0x21, g: 0x22, h: 0x23, j: 0x24,
  k: 0x25, l: 0x26,
  z: 0x2C, x: 0x2D, c: 0x2E, v: 0x2F, b: 0x30, n: 0x31, m: 0x32,
};

// Fallback for keydown events whose `e.code` is empty (Android Bluetooth
// keyboards, some virtual keyboards). Only used when CODE_TO_SCANCODE misses.
const KEY_TO_SCANCODE: Record<string, number> = {
  ArrowUp: 0x48, ArrowDown: 0x50, ArrowLeft: 0x4B, ArrowRight: 0x4D,
  Enter: 0x1C, Backspace: 0x0E, Tab: 0x0F, Escape: 0x01,
  Home: 0x47, End: 0x4F, PageUp: 0x49, PageDown: 0x51,
  Insert: 0x52, Delete: 0x53,
};

const KEY_IS_EXTENDED = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete',
]);

function getModifierScan(code: string): number | undefined {
  if (code === 'ShiftLeft') return 0x2A;
  if (code === 'ShiftRight') return 0x36;
  if (code === 'ControlLeft' || code === 'ControlRight') return 0x1D;
  if (code === 'AltLeft' || code === 'AltRight') return 0x38;
  return undefined;
}

// Legacy mapKeyToDos for non-INT09h path (direct INT 16h programs)
function mapKeyToDos(e: KeyboardEvent): { ascii: number; scan: number } | null {
  const scan = CODE_TO_SCANCODE[e.code];
  if (scan === undefined) return null;
  // For the legacy path, approximate ascii from e.key
  if (e.key.length === 1) return { ascii: e.key.charCodeAt(0), scan };
  if (e.key === 'Enter') return { ascii: 0x0D, scan };
  if (e.key === 'Backspace') return { ascii: 0x08, scan };
  if (e.key === 'Tab') return { ascii: 0x09, scan };
  if (e.key === 'Escape') return { ascii: 0x1B, scan };
  return { ascii: 0, scan };
}

// Map browser key names to Windows virtual key codes and scan codes
const WIN_KEY_MAP: Record<string, { vk: number; scan: number }> = {
  ArrowUp:    { vk: 0x26, scan: 0x48 },
  ArrowDown:  { vk: 0x28, scan: 0x50 },
  ArrowLeft:  { vk: 0x25, scan: 0x4B },
  ArrowRight: { vk: 0x27, scan: 0x4D },
  Home:       { vk: 0x24, scan: 0x47 },
  End:        { vk: 0x23, scan: 0x4F },
  PageUp:     { vk: 0x21, scan: 0x49 },
  PageDown:   { vk: 0x22, scan: 0x51 },
  Insert:     { vk: 0x2D, scan: 0x52 },
  Delete:     { vk: 0x2E, scan: 0x53 },
  F1:  { vk: 0x70, scan: 0x3B }, F2:  { vk: 0x71, scan: 0x3C },
  F3:  { vk: 0x72, scan: 0x3D }, F4:  { vk: 0x73, scan: 0x3E },
  F5:  { vk: 0x74, scan: 0x3F }, F6:  { vk: 0x75, scan: 0x40 },
  F7:  { vk: 0x76, scan: 0x41 }, F8:  { vk: 0x77, scan: 0x42 },
  F9:  { vk: 0x78, scan: 0x43 }, F10: { vk: 0x79, scan: 0x44 },
  F11: { vk: 0x7A, scan: 0x85 }, F12: { vk: 0x7B, scan: 0x86 },
  Enter:     { vk: 0x0D, scan: 0x1C },
  Backspace: { vk: 0x08, scan: 0x0E },
  Tab:       { vk: 0x09, scan: 0x0F },
  Escape:    { vk: 0x1B, scan: 0x01 },
};

// Get VK code for a printable character (uppercase letter or the char itself)
function charToVK(ch: number): number {
  if (ch >= 0x61 && ch <= 0x7A) return ch - 0x20; // a-z -> VK_A-VK_Z
  if (ch >= 0x41 && ch <= 0x5A) return ch;         // A-Z
  if (ch >= 0x30 && ch <= 0x39) return ch;         // 0-9
  if (ch === 0x20) return 0x20;                    // Space
  return 0;
}

interface ConsoleViewProps {
  emu: Emulator;
  focused?: boolean;
  /** Display-size multiplier applied to the 640×480 logical surface. */
  zoom?: number;
  /** When true, use bilinear/`high-quality` filtering during canvas scaling.
   *  When false, use nearest-neighbor (`pixelated`). */
  smooth?: boolean;
  /** Fired when the console's display dimensions change (graphics ↔ text mode
   *  or text rows / char height change), so the parent can resize the window. */
  onScreenLayoutChange?: () => void;
}

export function ConsoleView({ emu, focused = true, zoom = 1, smooth = false, onScreenLayoutChange }: ConsoleViewProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textCanvasRef = useRef<HTMLCanvasElement>(null);
  const useCanvas = loadDosSettings().textRenderer === 'canvas';
  const [, setTick] = useState(0);

  const COLS = emu.screenCols;
  const ROWS = emu.screenRows;

  const render = useCallback(() => {
    setTick(t => t + 1);
  }, []);

  // Re-render on console output / video frame
  useEffect(() => {
    emu.onConsoleOutput = () => render();
    emu.onVideoFrame = () => {
      const canvas = canvasRef.current;
      const fb = emu.vga.framebuffer;
      if (canvas && fb) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.putImageData(fb, 0, 0);
          drawGfxMouseCursor(ctx, emu);
        }
      } else {
        // Canvas not mounted yet (mode just switched) — trigger re-render
        render();
      }
    };
    // Framebuffer reallocated (resolution change) — re-render so the JSX
    // re-applies width/height props to the canvas DOM element, and notify
    // the parent so it can resize the surrounding window.
    emu.onVideoModeChange = () => {
      render();
      onScreenLayoutChange?.();
    };
    render();
    inputRef.current?.focus();
    const blinkTimer = setInterval(render, 500);
    return () => {
      clearInterval(blinkTimer);
      emu.onConsoleOutput = undefined;
      emu.onVideoFrame = undefined;
      emu.onVideoModeChange = undefined;
    };
  }, [emu, render]);

  // Focus input when window becomes active
  useEffect(() => {
    if (focused) inputRef.current?.focus();
  }, [focused]);

  // Build palette: use VGA registers for DOS, fallback for Win32
  const COLORS = emu.isDOS ? getVgaConsoleColors(emu) : DEFAULT_CONSOLE_COLORS;

  // Cursor shape from CRTC registers
  const charH = emu.charHeight || 16;
  const displayedCursor = getDisplayedTextCursor(emu, COLS, ROWS);
  const cursorStartScanline = Math.min(displayedCursor.start, charH - 1);
  const cursorEndScanline = Math.min(displayedCursor.end, charH - 1);
  const cursorBlink = Math.floor(Date.now() / 500) % 2 === 0;
  const cursorActive = cursorBlink && !displayedCursor.disabled && cursorStartScanline <= cursorEndScanline;

  // Build DOM content from console buffer
  const lineHeight = emu.charHeight === 8 ? 8 : 16;
  const mouseOverride = getTextModeCursorOverride(emu, COLS, ROWS);
  const rows: preact.JSX.Element[] = [];
  for (let row = 0; row < ROWS; row++) {
    const spans: preact.JSX.Element[] = [];
    let runFg = -1;
    let runBg = -1;
    let runChars = '';

    const flushRun = () => {
      if (runChars.length === 0) return;
      spans.push(<span style={{ color: COLORS[runFg], backgroundColor: COLORS[runBg] }}>{runChars}</span>);
      runChars = '';
    };

    for (let col = 0; col < COLS; col++) {
      const idx = row * COLS + col;
      const cell = emu.consoleBuffer[idx];
      const isMouseCell = !!mouseOverride && mouseOverride.row === row && mouseOverride.col === col;
      if (!isMouseCell && cell && cell.char === 0) continue;
      const effAttr = isMouseCell ? mouseOverride!.attr : (cell ? cell.attr : 0x07);
      const effChar = isMouseCell ? (mouseOverride!.char || 0x20) : (cell ? cell.char : 0);
      const fg = effAttr & 0x0F;
      const bg = (effAttr >> 4) & 0x0F;
      const isCursor = row === displayedCursor.y && col === displayedCursor.x;
      const charCode = effChar;
      const ch = (charCode > 0 && charCode !== 0x20)
        ? (emu.isDOS && charCode <= 0xFF ? cp437ToChar(charCode) : String.fromCharCode(charCode))
        : '\u00A0';
      const wide = !isMouseCell && charCode > 0x20 && isFullwidth(charCode);

      if (isCursor && cursorActive) {
        flushRun();
        const cursorColor = COLORS[fg === 0 ? 7 : fg];
        const topPct = (cursorStartScanline / charH * 100).toFixed(1);
        const bottomPct = (Math.min(cursorEndScanline + 1, charH) / charH * 100).toFixed(1);
        spans.push(
          <span style={{
            color: COLORS[fg],
            background: `linear-gradient(to bottom, ${COLORS[bg]} ${topPct}%, ${cursorColor} ${topPct}%, ${cursorColor} ${bottomPct}%, ${COLORS[bg]} ${bottomPct}%)`,
          }}>{ch}</span>
        );
        runFg = -1;
        runBg = -1;
      } else if (fg === runFg && bg === runBg && !wide) {
        runChars += ch;
      } else {
        flushRun();
        if (wide) {
          spans.push(<span style={{
            color: COLORS[fg],
            backgroundColor: COLORS[bg],
            display: 'inline-block',
            width: '2ch',
          }}>{ch}</span>);
          runFg = -1;
          runBg = -1;
        } else {
          runFg = fg;
          runBg = bg;
          runChars = ch;
        }
      }
    }
    flushRun();
    // Absolutely-positioned row with 1px overlap to eliminate sub-pixel gaps from scaleY
    const firstCell = emu.consoleBuffer[row * COLS];
    const rowBg = firstCell ? ((firstCell.attr >> 4) & 0x0F) : 0;
    rows.push(<div style={{
      position: 'absolute',
      top: `${row * lineHeight}px`,
      left: 0,
      width: '100%',
      height: `${lineHeight + 1}px`,
      background: COLORS[rowBg],
    }}>{spans}</div>);
  }

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // keyCode 229 = IME composition-in-progress notification (Android virtual
    // keyboards, desktop IMEs). Cancelling these can disturb the IME pipeline
    // — let them through; the actual character will arrive via `beforeinput`.
    if (e.keyCode !== 229) {
      e.preventDefault();
      e.stopPropagation();
    }

    // Don't accept input after program has exited
    if (emu.halted) return;

    // DOS mode: inject hardware scancodes via INT 09h path.
    // The BIOS INT 09h handler converts scancodes to ASCII and pushes to dosKeyBuffer.
    if (emu.isDOS) {
      // Filter out ALL browser key repeats — the DOS subsystem implements
      // its own typematic repeat with correct timing.
      if (e.repeat) return;
      // Resume AudioContext if suspended (user gesture)
      if (emu.audioContext?.state === 'suspended') emu.audioContext.resume();
      const modScan = getModifierScan(e.code);
      if (modScan !== undefined) {
        emu.injectHwKey(modScan);
      } else {
        // Sync browser lock-key state to BDA shift flags (0x0417).
        // Programs like QBasic check these flags to decide if numpad produces
        // digits (NumLock ON) or navigation keys (NumLock OFF).
        const bdaFlags = emu.memory.readU8(0x0417);
        let newFlags = bdaFlags;
        if (e.getModifierState('NumLock')) newFlags |= 0x20; else newFlags &= ~0x20;
        if (e.getModifierState('CapsLock')) newFlags |= 0x40; else newFlags &= ~0x40;
        if (e.getModifierState('ScrollLock')) newFlags |= 0x10; else newFlags &= ~0x10;
        if (newFlags !== bdaFlags) emu.memory.writeU8(0x0417, newFlags);

        // Primary lookup by physical code; fallback to `e.key` for sources
        // that leave `e.code` empty (Android BT keyboard, some virtual KBs).
        let scan = CODE_TO_SCANCODE[e.code];
        if (scan === undefined) scan = KEY_TO_SCANCODE[e.key];
        if (scan === undefined) return;
        const browserChar = e.key.length === 1 ? e.key.charCodeAt(0) : undefined;
        const isExtended = EXTENDED_NAV_CODES.has(e.code) || KEY_IS_EXTENDED.has(e.key);
        if (isExtended) emu.injectHwKey(0xE0);
        emu.injectHwKey(scan, browserChar);
        // Start typematic repeat for non-modifier keys
        emu.startTypematic(scan, browserChar, isExtended);
      }
      emu.screenDirty = true;

      // For programs using direct INT 16h (no custom handler), wake if waiting
      if (emu._dosWaitingForKey && emu.waitingForMessage) {
        emu.deliverDosKey();
      }
      return;
    }

    let charCode = 0;
    let vk = 0;
    let scan = 0;

    const mapped = WIN_KEY_MAP[e.key];
    if (mapped) {
      vk = mapped.vk;
      scan = mapped.scan;
      // These special keys produce a char code for Enter/Backspace/Tab/Escape
      if (e.key === 'Enter') charCode = 0x0D;
      else if (e.key === 'Backspace') charCode = 0x08;
      else if (e.key === 'Tab') charCode = 0x09;
      else if (e.key === 'Escape') charCode = 0x1B;
    } else if (e.key.length === 1) {
      charCode = e.key.charCodeAt(0);
      vk = charToVK(charCode);
    }

    if (charCode === 0 && vk === 0) return;

    const ENABLE_LINE_INPUT = 0x0002;
    const ENABLE_ECHO_INPUT = 0x0004;
    const lineMode = (emu.consoleInputMode & ENABLE_LINE_INPUT) !== 0;
    const echoMode = (emu.consoleInputMode & ENABLE_ECHO_INPUT) !== 0;

    const keyEvt = { char: charCode, vk, scan };

    // If waiting for console input (ReadConsoleInputA/W, WaitForSingleObject on stdin, or _getch)
    if (emu._consoleInputResume) {
      if (emu._pendingGetch) {
        emu._pendingGetch = false;
        if (charCode === 0 && scan !== 0) {
          emu.consoleInputBuffer.push({ char: scan, vk: 0, scan: 0 });
          emu.deliverConsoleInput(0xE0);
        } else {
          emu.deliverConsoleInput(charCode & 0xFF);
        }
        return;
      }
      if (emu._pendingReadConsoleInput) {
        const pendingInput = emu._pendingReadConsoleInput;
        const KEY_EVENT = 0x0001;
        const ptr = pendingInput.bufPtr;
        for (let i = 0; i < 20; i++) emu.memory.writeU8(ptr + i, 0);
        emu.memory.writeU16(ptr, KEY_EVENT);
        emu.memory.writeU32(ptr + 4, 1);
        emu.memory.writeU16(ptr + 8, 1);
        emu.memory.writeU16(ptr + 10, vk);
        emu.memory.writeU16(ptr + 12, scan);
        if (pendingInput.isWide) {
          emu.memory.writeU16(ptr + 14, charCode);
        } else {
          emu.memory.writeU8(ptr + 14, charCode & 0xFF);
        }
        if (pendingInput.eventsReadPtr) emu.memory.writeU32(pendingInput.eventsReadPtr, 1);
        emu._pendingReadConsoleInput = null;
        emu.deliverConsoleInput(1);
        return;
      }
    }

    // Line editing mode (emulates conhost line editing for ReadConsoleW)
    if (lineMode && emu._consoleInputResume && emu._pendingReadConsole) {
      const buf = emu._lineEditBuffer;
      const VK_LEFT = 0x25, VK_RIGHT = 0x27, VK_UP = 0x26, VK_DOWN = 0x28;
      const VK_HOME = 0x24, VK_END = 0x23, VK_DELETE = 0x2E;

      // Helper: redraw line from cursor position
      const redrawFrom = (pos: number) => {
        if (!echoMode) return;
        // Move cursor to pos on screen
        emu.consoleCursorX = emu._lineEditStartX + pos;
        emu.consoleCursorY = emu._lineEditStartY;
        // Handle wrapping
        while (emu.consoleCursorX >= 80) { emu.consoleCursorX -= 80; emu.consoleCursorY++; }
        // Write chars from pos to end, then a space to clear trailing char
        for (let i = pos; i < buf.length; i++) emu.consoleWriteChar(buf[i]);
        emu.consoleWriteChar(0x20); // clear ghost char
        // Move cursor back to the actual edit position
        emu.consoleCursorX = emu._lineEditStartX + emu._lineEditCursor;
        emu.consoleCursorY = emu._lineEditStartY;
        while (emu.consoleCursorX >= 80) { emu.consoleCursorX -= 80; emu.consoleCursorY++; }
        emu.onConsoleOutput?.();
      };

      // Helper: replace entire line (for history recall)
      const replaceLine = (newBuf: number[]) => {
        if (echoMode) {
          // Move to start, clear old content
          emu.consoleCursorX = emu._lineEditStartX;
          emu.consoleCursorY = emu._lineEditStartY;
          for (let i = 0; i < buf.length; i++) emu.consoleWriteChar(0x20);
          emu.consoleCursorX = emu._lineEditStartX;
          emu.consoleCursorY = emu._lineEditStartY;
        }
        buf.length = 0;
        buf.push(...newBuf);
        emu._lineEditCursor = buf.length;
        if (echoMode) {
          for (const ch of buf) emu.consoleWriteChar(ch);
          emu.onConsoleOutput?.();
        }
      };

      if (vk === VK_LEFT) {
        if (emu._lineEditCursor > 0) {
          emu._lineEditCursor--;
          if (echoMode) {
            emu.consoleCursorX = emu._lineEditStartX + emu._lineEditCursor;
            emu.consoleCursorY = emu._lineEditStartY;
            while (emu.consoleCursorX >= 80) { emu.consoleCursorX -= 80; emu.consoleCursorY++; }
            emu.onConsoleOutput?.();
          }
        }
        return;
      }
      if (vk === VK_RIGHT) {
        if (emu._lineEditCursor < buf.length) {
          emu._lineEditCursor++;
          if (echoMode) {
            emu.consoleCursorX = emu._lineEditStartX + emu._lineEditCursor;
            emu.consoleCursorY = emu._lineEditStartY;
            while (emu.consoleCursorX >= 80) { emu.consoleCursorX -= 80; emu.consoleCursorY++; }
            emu.onConsoleOutput?.();
          }
        }
        return;
      }
      if (vk === VK_HOME) {
        emu._lineEditCursor = 0;
        if (echoMode) {
          emu.consoleCursorX = emu._lineEditStartX;
          emu.consoleCursorY = emu._lineEditStartY;
          emu.onConsoleOutput?.();
        }
        return;
      }
      if (vk === VK_END) {
        emu._lineEditCursor = buf.length;
        if (echoMode) {
          emu.consoleCursorX = emu._lineEditStartX + emu._lineEditCursor;
          emu.consoleCursorY = emu._lineEditStartY;
          while (emu.consoleCursorX >= 80) { emu.consoleCursorX -= 80; emu.consoleCursorY++; }
          emu.onConsoleOutput?.();
        }
        return;
      }
      if (vk === VK_DELETE) {
        if (emu._lineEditCursor < buf.length) {
          buf.splice(emu._lineEditCursor, 1);
          redrawFrom(emu._lineEditCursor);
        }
        return;
      }
      if (vk === VK_UP) {
        if (emu._commandHistoryIndex > 0) {
          emu._commandHistoryIndex--;
          replaceLine([...emu._commandHistory[emu._commandHistoryIndex]]);
        }
        return;
      }
      if (vk === VK_DOWN) {
        if (emu._commandHistoryIndex < emu._commandHistory.length - 1) {
          emu._commandHistoryIndex++;
          replaceLine([...emu._commandHistory[emu._commandHistoryIndex]]);
        } else if (emu._commandHistoryIndex === emu._commandHistory.length - 1) {
          emu._commandHistoryIndex = emu._commandHistory.length;
          replaceLine([]);
        }
        return;
      }
      if (charCode === 0x08) {
        // Backspace: delete char before cursor
        if (emu._lineEditCursor > 0) {
          emu._lineEditCursor--;
          buf.splice(emu._lineEditCursor, 1);
          redrawFrom(emu._lineEditCursor);
        }
        return;
      }
      if (charCode === 0x0D) {
        // Enter: submit the line
        if (echoMode) {
          // Move cursor to end of line, then echo CR+LF
          emu.consoleCursorX = emu._lineEditStartX + buf.length;
          emu.consoleCursorY = emu._lineEditStartY;
          while (emu.consoleCursorX >= 80) { emu.consoleCursorX -= 80; emu.consoleCursorY++; }
          emu.consoleWriteChar(0x0D);
          emu.consoleWriteChar(0x0A);
          emu.onConsoleOutput?.();
        }
        // Save to command history (if non-empty)
        if (buf.length > 0) {
          emu._commandHistory.push([...buf]);
        }
        emu._commandHistoryIndex = emu._commandHistory.length;
        // Build result: chars + CR + LF
        buf.push(0x0D, 0x0A);
        const pending = emu._pendingReadConsole!;
        let count = 0;
        while (count < pending.nCharsToRead && buf.length > 0) {
          const ch = buf.shift()!;
          emu.memory.writeU16(pending.bufPtr + count * 2, ch);
          count++;
          if (ch === 0x0A) break;
        }
        if (pending.charsReadPtr) emu.memory.writeU32(pending.charsReadPtr, count);
        emu._pendingReadConsole = null;
        emu._lineEditBuffer = [];
        emu._lineEditCursor = 0;
        emu.deliverConsoleInput(1);
        return;
      }
      // Regular printable character: insert at cursor
      if (charCode === 0) return;
      buf.splice(emu._lineEditCursor, 0, charCode);
      emu._lineEditCursor++;
      if (echoMode) {
        redrawFrom(emu._lineEditCursor - 1);
      }
      return;
    }

    // Non-line-mode or not waiting for ReadConsoleW
    if (emu._consoleInputResume) {
      if (!emu._pendingReadConsole) {
        // WaitForSingleObject on stdin or ReadConsoleInput
        emu.consoleInputBuffer.push(keyEvt);
        emu.deliverConsoleInput(0); // WAIT_OBJECT_0
        return;
      }
    }

    // Echo to console if echo mode is on (only for character keys)
    if (echoMode && charCode !== 0) {
      emu.consoleWriteChar(charCode);
      if (charCode === 0x0D) emu.consoleWriteChar(0x0A);
      emu.onConsoleOutput?.();
    }

    if (charCode === 0) return;

    emu.consoleInputBuffer.push(keyEvt);
    if (charCode === 0x0D) {
      emu.consoleInputBuffer.push({ char: 0x0A, vk: 0, scan: 0 });
    }

    // If emulator is waiting for ReadConsoleW (non-line mode), complete immediately
    if (emu._consoleInputResume && emu._pendingReadConsole) {
      const pending = emu._pendingReadConsole;
      let count = 0;
      while (count < pending.nCharsToRead && emu.consoleInputBuffer.length > 0) {
        const evt = emu.consoleInputBuffer.shift()!;
        emu.memory.writeU16(pending.bufPtr + count * 2, evt.char);
        count++;
      }
      if (pending.charsReadPtr) emu.memory.writeU32(pending.charsReadPtr, count);
      emu._pendingReadConsole = null;
      emu.deliverConsoleInput(1);
    }
  }, [emu]);

  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (emu.halted || !emu.isDOS) return;

    const modScan = getModifierScan(e.code);
    if (modScan !== undefined) {
      emu.injectHwKey(modScan | 0x80);
      return;
    }

    // Ignore keyup for pure meta keys in DOS mode.
    if (MODIFIER_CODES.has(e.code)) return;

    let scan = CODE_TO_SCANCODE[e.code];
    if (scan === undefined) scan = KEY_TO_SCANCODE[e.key];
    if (scan === undefined) return;
    emu.stopTypematic(scan);
    if (EXTENDED_NAV_CODES.has(e.code) || KEY_IS_EXTENDED.has(e.key)) emu.injectHwKey(0xE0);
    emu.injectHwKey(scan | 0x80);
    emu.screenDirty = true;
  }, [emu]);

  // Android virtual keyboards (Gboard, etc.) emit keydown with keyCode=229
  // and an empty `e.code`, so the keydown path can't see the typed character.
  // The actual character arrives via `beforeinput`. We synthesise both
  // make-code and break-code here because Android won't send a keyup either.
  // On desktop, `e.preventDefault()` in `handleKeyDown` cancels the would-be
  // text insertion, so this handler doesn't fire for normal physical keys.
  const handleBeforeInput = useCallback((e: InputEvent) => {
    if (emu.halted || !emu.isDOS) return;
    if (emu.audioContext?.state === 'suspended') emu.audioContext.resume();

    const inject = (scan: number, ascii?: number) => {
      emu.injectHwKey(scan, ascii);
      emu.injectHwKey(scan | 0x80);
    };

    if (e.inputType === 'insertText' && e.data) {
      e.preventDefault();
      for (const ch of e.data) {
        const scan = CHAR_TO_SCANCODE[ch.toLowerCase()];
        if (scan !== undefined) inject(scan, ch.charCodeAt(0));
      }
    } else if (e.inputType === 'deleteContentBackward') {
      e.preventDefault();
      inject(0x0E, 0x08);
    } else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      e.preventDefault();
      inject(0x1C, 0x0D);
    } else {
      return;
    }
    emu.screenDirty = true;
    if (emu._dosWaitingForKey && emu.waitingForMessage) emu.deliverDosKey();
  }, [emu]);

  const handleClick = useCallback(() => {
    // Don't steal focus if user is selecting text
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;
    inputRef.current?.focus();
  }, []);

  const handleMouseEvent = useCallback((e: PointerEvent, type: 'move' | 'down' | 'up') => {
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const px = Math.round((e.clientX - rect.left) * 640 / rect.width);
    const py = Math.round((e.clientY - rect.top) * 480 / rect.height);
    injectDosMouseEvent(emu, px, py, 640, 480, e.buttons, type);
    // In text mode, the cursor doesn't follow the framebuffer (no onVideoFrame).
    // Force a re-render so the mouse cell follows the pointer.
    if (!emu.isGraphicsMode && emu.dosMouse.installed && emu.dosMouse.cursorVisible >= 0) {
      render();
    }
  }, [emu, render]);

  // Measure actual ch width and compute scaleX to fit 80 columns into 640px.
  // useCanvas is in the deps so the measurement re-runs when the user
  // toggles between DOM and canvas renderers — when the app boots in canvas
  // mode the <pre> isn't mounted, preRef stays null, and the initial run
  // bails before measuring; without this dep, switching to DOM later would
  // keep scaleX at its default 1 and stretch the layout horizontally.
  const [scaleX, setScaleX] = useState(1);
  useEffect(() => {
    if (emu.isGraphicsMode || useCanvas) return;
    const el = preRef.current;
    if (!el) return;
    const span = document.createElement('span');
    span.style.font = el.style.font;
    span.style.position = 'absolute';
    span.style.visibility = 'hidden';
    span.textContent = '0';
    document.body.appendChild(span);
    const chWidth = span.getBoundingClientRect().width;
    document.body.removeChild(span);
    if (chWidth > 0) setScaleX(640 / (COLS * chWidth));
  }, [COLS, emu.isGraphicsMode, lineHeight, useCanvas]);

  // Canvas text mode: draw after each render
  useLayoutEffect(() => {
    if (emu.isGraphicsMode || !useCanvas) return;
    const canvas = textCanvasRef.current;
    if (canvas) drawTextMode(canvas, emu, COLS, ROWS);
  });

  const isGfx = emu.isGraphicsMode;
  const fb = emu.vga.framebuffer;
  const gfxWidth = fb ? fb.width : emu.vga.currentMode.width;
  const gfxHeight = fb ? fb.height : emu.vga.currentMode.height;
  const dosMouseVisible = emu.dosMouse.installed && emu.dosMouse.cursorVisible >= 0;
  const dosTextMouseVisible = !isGfx && dosMouseVisible;

  const dispW = 640 * zoom;
  // Standard DOS text modes have a 400-pixel natural surface (80×25 with 16-px
  // cells, 80×50 with 8-px cells). Real CRTs displayed these at 4:3 — 640×480
  // — so scale up vertically to match. Graphics modes keep the 480 client
  // area regardless of the underlying framebuffer.
  const isStdTextHeight = !isGfx && ROWS * lineHeight === 400;
  const dispH = (isGfx || isStdTextHeight ? 480 : ROWS * lineHeight) * zoom;
  // Use 'auto' (bilinear) when smoothing is on — universally supported.
  // 'high-quality' would be nicer in Chromium 119+ but silently falls back to
  // 'auto' elsewhere, so 'auto' is a safer baseline.
  const imageRendering = smooth ? 'auto' : 'pixelated';
  return (
    <div
      style={{ position: 'relative', width: `${dispW}px`, height: `${dispH}px`, background: '#000' }}
      onPointerUp={(e) => { handleMouseEvent(e, 'up'); handleClick(); }}
      onPointerDown={(e) => handleMouseEvent(e, 'down')}
      onPointerMove={(e) => handleMouseEvent(e, 'move')}
      onContextMenu={(e) => e.preventDefault()}
    >
      {isGfx ? (
        <canvas
          key="gfx"
          ref={canvasRef}
          width={gfxWidth}
          height={gfxHeight}
          style={{
            display: 'block',
            width: `${dispW}px`,
            height: `${dispH}px`,
            imageRendering,
            cursor: isGfx && dosMouseVisible ? 'none' : 'default',
          }}
        />
      ) : useCanvas ? (
        <canvas
          key="text"
          ref={textCanvasRef}
          width={640}
          height={ROWS * lineHeight}
          style={{
            display: 'block',
            width: `${dispW}px`,
            height: `${dispH}px`,
            imageRendering,
            cursor: dosTextMouseVisible ? 'none' : 'default',
          }}
        />
      ) : (
        <pre
          ref={preRef}
          style={{
            position: 'relative',
            margin: 0,
            padding: 0,
            background: '#000',
            color: '#C0C0C0',
            font: `${lineHeight}px/${lineHeight}px "Cascadia Mono", "Menlo", "Consolas", "Courier New", monospace`,
            cursor: dosTextMouseVisible ? 'none' : 'text',
            overflow: 'hidden',
            userSelect: 'text',
            width: `${COLS}ch`,
            height: `${ROWS * lineHeight}px`,
            lineHeight: `${lineHeight}px`,
            letterSpacing: '0px',
            transformOrigin: 'top left',
            transform: `scaleX(${scaleX * zoom}) scaleY(${dispH / (ROWS * lineHeight)}) translateZ(0)`,
          }}
        >
          {rows}
        </pre>
      )}
      <input
        ref={inputRef}
        type="text"
        style={{
          position: 'absolute', left: 0, top: 0,
          width: '1px', height: '1px', opacity: 0,
          overflow: 'hidden', border: 'none', padding: 0,
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onBeforeInput={handleBeforeInput}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellcheck={false}
        autoFocus
      />
    </div>
  );
}
