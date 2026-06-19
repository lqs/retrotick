import type { Emulator } from '../../emulator';
import { fillTextBitmap } from '../../emu-render';
import { decodeMBCS, encodeMBCS } from '../../memory';
import { formatString, stackArgReader, vaListArgReader } from '../../format';
import type { WindowInfo } from './types';
import { OPAQUE } from '../types';

/** Process '&' prefix: strip '&' before accelerator char, '&&' becomes '&'.
 *  Returns { display, underlineIndex } where underlineIndex is the char to underline (-1 if none). */
function processPrefix(text: string): { display: string; underlineIndex: number } {
  let display = '';
  let underlineIndex = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '&' && i + 1 < text.length) {
      if (text[i + 1] === '&') {
        display += '&';
        i++;
      } else {
        if (underlineIndex === -1) underlineIndex = display.length;
        display += text[i + 1];
        i++;
      }
    } else {
      display += text[i];
    }
  }
  return { display, underlineIndex };
}

/** Draw a single line with optional underline for the accelerator character */
function fillTextWithPrefix(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string, x: number, y: number, maxWidth: number | undefined,
  hasPrefix: boolean, fontSize: number,
): void {
  if (!hasPrefix) {
    fillTextBitmap(ctx, text, x, y, maxWidth);
    return;
  }
  const { display, underlineIndex } = processPrefix(text);
  fillTextBitmap(ctx, display, x, y, maxWidth);
  if (underlineIndex >= 0) {
    const before = display.slice(0, underlineIndex);
    const ch = display[underlineIndex];
    const align = ctx.textAlign;
    // Compute underline position relative to the draw origin
    let ux: number;
    const beforeW = ctx.measureText(before).width;
    const chW = ctx.measureText(ch).width;
    if (align === 'center') {
      const fullW = ctx.measureText(display).width;
      ux = x - fullW / 2 + beforeW;
    } else if (align === 'right') {
      const fullW = ctx.measureText(display).width;
      ux = x - fullW + beforeW;
    } else {
      ux = x + beforeW;
    }
    const uy = y + fontSize;
    ctx.beginPath();
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 1;
    ctx.moveTo(ux, uy);
    ctx.lineTo(ux + chW, uy);
    ctx.stroke();
  }
}

/** Split text into rendered lines, handling \n and optional word-wrapping */
function drawTextWrapLines(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string, maxWidth: number, format: number,
  DT_WORDBREAK: number, DT_SINGLELINE: number,
): string[] {
  if (format & DT_SINGLELINE) {
    return [text.replace(/[\r\n]/g, ' ')];
  }
  const paragraphs = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (!(format & DT_WORDBREAK) || maxWidth <= 0) return paragraphs;
  const lines: string[] = [];
  for (const para of paragraphs) {
    if (para.length === 0) { lines.push(''); continue; }
    // Split into tokens: whitespace runs and individual CJK chars get their own tokens
    const tokens = para.match(/\s+|[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]|[^\s\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]+/g) || [para];
    let cur = '';
    for (const token of tokens) {
      const test = cur + token;
      if (cur.length > 0 && ctx.measureText(test).width > maxWidth) {
        lines.push(cur);
        cur = token.trimStart();
      } else {
        cur = test;
      }
    }
    if (cur.length > 0) lines.push(cur);
  }
  return lines.length > 0 ? lines : [''];
}

export function registerText(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  // SetWindowTextA
  user32.register('SetWindowTextA', 2, () => {
    const hwnd = emu.readArg(0);
    const textPtr = emu.readArg(1);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (wnd && textPtr) {
      const newTitle = emu.memory.readCString(textPtr);
      if (newTitle !== wnd.title) {
        wnd.title = newTitle;
        if (hwnd === emu.mainWindow) {
          emu.onWindowChange?.(wnd);
        } else if (wnd.parent && wnd.parent === emu.mainWindow) {
          const parentWnd = emu.handles.get<WindowInfo>(wnd.parent);
          if (parentWnd) { parentWnd.needsPaint = true; }
        }
        emu.notifyControlOverlays();
      }
    }
    return 1;
  });

  // SetWindowTextW
  user32.register('SetWindowTextW', 2, () => {
    const hwnd = emu.readArg(0);
    const textPtr = emu.readArg(1);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (wnd && textPtr) {
      const newTitle = emu.memory.readUTF16String(textPtr);
      if (newTitle !== wnd.title) {
        wnd.title = newTitle;
        if (hwnd === emu.mainWindow) {
          emu.onWindowChange?.(wnd);
        } else if (wnd.parent && wnd.parent === emu.mainWindow) {
          const parentWnd = emu.handles.get<WindowInfo>(wnd.parent);
          if (parentWnd) { parentWnd.needsPaint = true; }
        }
        emu.notifyControlOverlays();
      }
    }
    return 1;
  });

  // Helper: look up window title, falling back to process registry for cross-emulator hwnds
  function getWindowTitle(hwnd: number): string | undefined {
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (wnd?.title) return wnd.title;
    if (emu.processRegistry) {
      const entry = emu.processRegistry.getWindowList().find(w => w.hwnd === hwnd);
      if (entry) return entry.title;
    }
    return undefined;
  }

  user32.register('GetWindowTextA', 3, () => {
    const hwnd = emu.readArg(0);
    const bufPtr = emu.readArg(1);
    const bufSize = emu.readArg(2);
    const title = getWindowTitle(hwnd);
    if (!title || bufSize === 0) {
      if (bufSize > 0) emu.memory.writeU8(bufPtr, 0);
      return 0;
    }
    const encoded = encodeMBCS(title);
    const maxBytes = Math.min(encoded.length, bufSize - 1);
    for (let i = 0; i < maxBytes; i++) {
      emu.memory.writeU8(bufPtr + i, encoded[i]);
    }
    emu.memory.writeU8(bufPtr + maxBytes, 0);
    return maxBytes;
  });

  user32.register('GetWindowTextW', 3, () => {
    const hwnd = emu.readArg(0);
    const bufPtr = emu.readArg(1);
    const bufSize = emu.readArg(2);
    const title = getWindowTitle(hwnd);
    if (!title || bufSize === 0) {
      if (bufSize > 0) emu.memory.writeU16(bufPtr, 0);
      return 0;
    }
    const maxChars = Math.min(title.length, bufSize - 1);
    for (let i = 0; i < maxChars; i++) {
      emu.memory.writeU16(bufPtr + i * 2, title.charCodeAt(i));
    }
    emu.memory.writeU16(bufPtr + maxChars * 2, 0);
    return maxChars;
  });

  user32.register('GetWindowTextLengthA', 1, () => {
    const hwnd = emu.readArg(0);
    const title = getWindowTitle(hwnd);
    return title?.length || 0;
  });

  user32.register('GetWindowTextLengthW', 1, () => {
    const hwnd = emu.readArg(0);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    return wnd?.title?.length || 0;
  });

  user32.register('wsprintfA', 0, () => {
    const bufPtr = emu.readArg(0);
    const fmtPtr = emu.readArg(1);
    const fmt = emu.memory.readCString(fmtPtr);
    const result = formatString(fmt, stackArgReader(i => emu.readArg(i), 2), emu.memory, false);
    if (bufPtr) {
      emu.memory.writeCString(bufPtr, result);
    }
    return result.length;
  });

  // wvsprintfA — va_list version
  user32.register('wvsprintfA', 0, () => {
    const bufPtr = emu.readArg(0);
    const fmtPtr = emu.readArg(1);
    const vaList = emu.readArg(2);
    const fmt = emu.memory.readCString(fmtPtr);
    const result = formatString(fmt, vaListArgReader(emu.memory, vaList), emu.memory, false);
    if (bufPtr) {
      emu.memory.writeCString(bufPtr, result);
    }
    return result.length;
  });

  // wsprintfW - varargs implementation with width/precision/padding
  user32.register('wsprintfW', 0, () => {
    const bufPtr = emu.readArg(0);
    const fmtPtr = emu.readArg(1);
    const fmt = emu.memory.readUTF16String(fmtPtr);
    const result = formatString(fmt, stackArgReader(i => emu.readArg(i), 2), emu.memory, true);
    emu.memory.writeUTF16String(bufPtr, result);
    return result.length;
  });

  user32.register('wvsprintfW', 3, () => {
    const bufPtr = emu.readArg(0);
    const fmtPtr = emu.readArg(1);
    const vaList = emu.readArg(2);
    const fmt = emu.memory.readUTF16String(fmtPtr);
    const result = formatString(fmt, vaListArgReader(emu.memory, vaList), emu.memory, true);
    emu.memory.writeUTF16String(bufPtr, result);
    return result.length;
  });

  // DrawTextA — USER32 version only
  user32.register('DrawTextA', 5, () => {
    const hdc = emu.readArg(0);
    const textPtr = emu.readArg(1);
    const count = emu.readArg(2) | 0;
    const rectPtr = emu.readArg(3);
    const format = emu.readArg(4);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    let text: string;
    if (count === -1) {
      text = emu.memory.readCString(textPtr);
    } else {
      text = emu.memory.readBytesMBCS(textPtr, count);
    }

    const left = emu.memory.readI32(rectPtr);
    const top = emu.memory.readI32(rectPtr + 4);
    const right = emu.memory.readI32(rectPtr + 8);
    const bottom = emu.memory.readI32(rectPtr + 12);
    const DT_CALCRECT = 0x0400;
    const DT_CENTER = 0x01;
    const DT_RIGHT = 0x02;
    const DT_VCENTER = 0x04;
    const DT_SINGLELINE = 0x20;
    const DT_WORDBREAK = 0x10;
    const DT_NOPREFIX = 0x0800;

    const font = emu.handles.get<{ height: number }>(dc.selectedFont);
    const fontSize = (font && font.height) ? Math.abs(font.height) : 13;
    const lineH = Math.max(fontSize, 1);
    const fontCSS = `${fontSize}px Tahoma, sans-serif`;
    const hasPrefix = !(format & DT_NOPREFIX);

    if (!(format & DT_CALCRECT)) {
      // OPAQUE fills only each text line's character cell, never the whole rect
      const opaque = dc.bkMode === OPAQUE;
      const bkCSS = `rgb(${dc.bkColor & 0xFF},${(dc.bkColor >> 8) & 0xFF},${(dc.bkColor >> 16) & 0xFF})`;

      const r = dc.textColor & 0xFF;
      const g = (dc.textColor >> 8) & 0xFF;
      const b = (dc.textColor >> 16) & 0xFF;
      const textCSS = `rgb(${r},${g},${b})`;
      dc.ctx.fillStyle = textCSS;
      dc.ctx.font = fontCSS;
      dc.ctx.textBaseline = 'top';

      let x = left;
      if (format & DT_CENTER) {
        dc.ctx.textAlign = 'center';
        x = (left + right) / 2;
      } else if (format & DT_RIGHT) {
        dc.ctx.textAlign = 'right';
        x = right;
      } else {
        dc.ctx.textAlign = 'left';
      }

      const lines = drawTextWrapLines(dc.ctx, text, right - left, format, DT_WORDBREAK, DT_SINGLELINE);
      let y = top;
      if ((format & DT_VCENTER) && (format & DT_SINGLELINE)) {
        y = (top + bottom - lineH) / 2;
      }
      for (const line of lines) {
        if (y + lineH > bottom && !(format & DT_SINGLELINE)) break;
        if (opaque) {
          const w = dc.ctx.measureText(line).width;
          const lx = (format & DT_CENTER) ? x - w / 2 : (format & DT_RIGHT) ? x - w : x;
          dc.ctx.fillStyle = bkCSS;
          dc.ctx.fillRect(lx, y, w, lineH);
          dc.ctx.fillStyle = textCSS;
        }
        fillTextWithPrefix(dc.ctx, line, x, y, right - left, hasPrefix, fontSize);
        y += lineH;
      }
    }

    return bottom - top;
  });

  // DrawTextW
  user32.register('DrawTextW', 5, () => {
    const hdc = emu.readArg(0);
    const textPtr = emu.readArg(1);
    const count = emu.readArg(2) | 0;
    const rectPtr = emu.readArg(3);
    const format = emu.readArg(4);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    let text: string;
    if (count === -1) {
      text = emu.memory.readUTF16String(textPtr);
    } else {
      text = '';
      for (let i = 0; i < count; i++) {
        const ch = emu.memory.readU16(textPtr + i * 2);
        if (ch === 0) break;
        text += String.fromCharCode(ch);
      }
    }

    const left = emu.memory.readI32(rectPtr);
    const top = emu.memory.readI32(rectPtr + 4);
    const right = emu.memory.readI32(rectPtr + 8);
    const bottom = emu.memory.readI32(rectPtr + 12);

    const DT_CALCRECT = 0x0400;
    const DT_CENTER = 0x01;
    const DT_RIGHT = 0x02;
    const DT_VCENTER = 0x04;
    const DT_SINGLELINE = 0x20;
    const DT_WORDBREAK = 0x10;
    const DT_NOPREFIX = 0x0800;

    const font = emu.handles.get<{ height: number }>(dc.selectedFont);
    const fontSize = (font && font.height) ? Math.abs(font.height) : 13;
    const lineH = Math.max(fontSize, 1);
    const fontCSS = `${fontSize}px Tahoma, sans-serif`;
    const hasPrefix = !(format & DT_NOPREFIX);

    if (format & DT_CALCRECT) {
      const rectW = Math.max(1, right - left);
      dc.ctx.font = fontCSS;
      let charW = Math.max(Math.round(fontSize * 0.5), 1);
      const measured = dc.ctx.measureText('x').width;
      if (measured > 0) charW = Math.round(measured);
      let calcLines = 1;
      if ((format & DT_WORDBREAK) && rectW > 0) {
        const textLines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        calcLines = 0;
        for (const tl of textLines) {
          const lineChars = Math.max(1, Math.floor(rectW / charW));
          calcLines += Math.max(1, Math.ceil((tl.length || 1) / lineChars));
        }
      } else if (format & DT_SINGLELINE) {
        calcLines = 1;
      } else {
        calcLines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').length;
      }
      const totalH = calcLines * lineH;
      emu.memory.writeU32(rectPtr + 12, (top + totalH) | 0);
      return totalH;
    }

    // OPAQUE background mode fills only each text line's character cell
    // (like TextOut), never the whole rect — DrawText has no rect-fill behavior.
    const opaque = dc.bkMode === OPAQUE;
    const bkCSS = `rgb(${dc.bkColor & 0xFF},${(dc.bkColor >> 8) & 0xFF},${(dc.bkColor >> 16) & 0xFF})`;

    const r = dc.textColor & 0xFF;
    const g = (dc.textColor >> 8) & 0xFF;
    const b = (dc.textColor >> 16) & 0xFF;
    const textCSS = `rgb(${r},${g},${b})`;
    dc.ctx.fillStyle = textCSS;
    dc.ctx.font = fontCSS;
    dc.ctx.textBaseline = 'top';

    let x = left;
    if (format & DT_CENTER) {
      dc.ctx.textAlign = 'center';
      x = (left + right) / 2;
    } else if (format & DT_RIGHT) {
      dc.ctx.textAlign = 'right';
      x = right;
    } else {
      dc.ctx.textAlign = 'left';
    }

    const lines = drawTextWrapLines(dc.ctx, text, right - left, format, DT_WORDBREAK, DT_SINGLELINE);
    let y = top;
    if ((format & DT_VCENTER) && ((format & DT_SINGLELINE) || lines.length === 1)) {
      y = (top + bottom - lineH) / 2;
    }
    for (let li = 0; li < lines.length; li++) {
      // Skip lines that start below the rect — but always draw the first line
      // (Windows draws oversized text and clips visually, never skips it entirely)
      if (li > 0 && y >= bottom && !(format & DT_SINGLELINE)) break;
      if (opaque) {
        const w = dc.ctx.measureText(lines[li]).width;
        const lx = (format & DT_CENTER) ? x - w / 2 : (format & DT_RIGHT) ? x - w : x;
        dc.ctx.fillStyle = bkCSS;
        dc.ctx.fillRect(lx, y, w, lineH);
        dc.ctx.fillStyle = textCSS;
      }
      fillTextWithPrefix(dc.ctx, lines[li], x, y, right - left, hasPrefix, fontSize);
      y += lineH;
    }

    return bottom - top;
  });

  // DrawTextExW — same as DrawTextW but with extra params (DRAWTEXTPARAMS at arg 5)
  user32.register('DrawTextExW', 6, () => {
    const hdc = emu.readArg(0);
    const textPtr = emu.readArg(1);
    const count = emu.readArg(2) | 0;
    const rectPtr = emu.readArg(3);
    const format = emu.readArg(4);
    // arg 5 = DRAWTEXTPARAMS*, ignored

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    let text: string;
    if (count === -1) {
      text = emu.memory.readUTF16String(textPtr);
    } else {
      text = '';
      for (let i = 0; i < count; i++) {
        const ch = emu.memory.readU16(textPtr + i * 2);
        if (ch === 0) break;
        text += String.fromCharCode(ch);
      }
    }

    if (!rectPtr) return 0;
    const left = emu.memory.readI32(rectPtr);
    const top = emu.memory.readI32(rectPtr + 4);
    const right = emu.memory.readI32(rectPtr + 8);
    const bottom = emu.memory.readI32(rectPtr + 12);

    const DT_CALCRECT = 0x0400;
    const DT_WORDBREAK = 0x10;
    const DT_SINGLELINE = 0x20;
    const DT_NOPREFIX = 0x0800;
    const hasPrefix = !(format & DT_NOPREFIX);

    // Get font metrics from DC
    const font = emu.handles.get<{ height: number }>(dc.selectedFont);
    const fontSize = (font && font.height) ? Math.abs(font.height) : 13;
    const lineH = Math.max(fontSize, 1);
    const fontCSS = `${fontSize}px Tahoma, sans-serif`;
    let charW = Math.max(Math.round(fontSize * 0.5), 1);
    if (dc.ctx) {
      dc.ctx.font = fontCSS;
      const measured = dc.ctx.measureText('x').width;
      if (measured > 0) charW = Math.round(measured);
    }

    const rectW = Math.max(1, right - left);
    let lines = 1;
    if ((format & DT_WORDBREAK) && rectW > 0) {
      const textLines = text.split('\n');
      lines = 0;
      for (const tl of textLines) {
        const lineChars = Math.max(1, Math.floor(rectW / charW));
        lines += Math.max(1, Math.ceil((tl.length || 1) / lineChars));
      }
    } else if (format & DT_SINGLELINE) {
      lines = 1;
    } else {
      lines = Math.max(1, text.split('\n').length);
    }
    const totalH = lines * lineH;

    if (format & DT_CALCRECT) {
      emu.memory.writeU32(rectPtr + 12, (top + totalH) | 0);
      return totalH;
    }

    // Drawing (non-CALCRECT)
    if (dc.ctx) {
      const r = dc.textColor & 0xFF, g = (dc.textColor >> 8) & 0xFF, b = (dc.textColor >> 16) & 0xFF;
      dc.ctx.fillStyle = `rgb(${r},${g},${b})`;
      dc.ctx.font = fontCSS;
      dc.ctx.textBaseline = 'top';
      dc.ctx.textAlign = 'left';
      const drawLines = drawTextWrapLines(dc.ctx, text, rectW, format, DT_WORDBREAK, DT_SINGLELINE);
      let dy = top;
      for (let li = 0; li < drawLines.length; li++) {
        if (li > 0 && dy >= bottom && !(format & DT_SINGLELINE)) break;
        fillTextWithPrefix(dc.ctx, drawLines[li], left, dy, rectW, hasPrefix, fontSize);
        dy += lineH;
      }
    }
    return totalH;
  });

  user32.register('CharLowerA', 1, () => {
    const p = emu.readArg(0);
    // If high word is 0, it's a character, not a pointer
    if ((p >>> 16) === 0) {
      const ch = p & 0xFF;
      return (ch >= 0x41 && ch <= 0x5A) ? ch + 0x20 : ch;
    }
    // It's a pointer to a string
    let i = 0;
    while (true) {
      const ch = emu.memory.readU8(p + i);
      if (ch === 0) break;
      if (ch >= 0x41 && ch <= 0x5A) emu.memory.writeU8(p + i, ch + 0x20);
      i++;
    }
    return p;
  });

  user32.register('CharNextA', 1, () => {
    const ptr = emu.readArg(0);
    return emu.memory.readU8(ptr) !== 0 ? ptr + 1 : ptr;
  });

  user32.register('CharNextW', 1, () => {
    const ptr = emu.readArg(0);
    return emu.memory.readU16(ptr) !== 0 ? ptr + 2 : ptr;
  });

  user32.register('CharPrevW', 2, () => {
    const lpszStart = emu.readArg(0);
    const lpszCurrent = emu.readArg(1);
    return lpszCurrent > lpszStart ? lpszCurrent - 2 : lpszStart;
  });

  user32.register('CharPrevA', 2, () => {
    const lpszStart = emu.readArg(0);
    const lpszCurrent = emu.readArg(1);
    return lpszCurrent > lpszStart ? lpszCurrent - 1 : lpszStart;
  });

  user32.register('OemToCharA', 2, () => 1);

  // CharToOemA(LPCSTR, LPSTR) — copy src to dest (identity for ASCII)
  user32.register('CharToOemA', 2, () => {
    const src = emu.readArg(0);
    const dst = emu.readArg(1);
    if (src && dst) {
      let i = 0;
      while (true) {
        const ch = emu.memory.readU8(src + i);
        emu.memory.writeU8(dst + i, ch);
        if (ch === 0) break;
        i++;
      }
    }
    return 1;
  });

  user32.register('CharUpperA', 1, () => {
    const p = emu.readArg(0);
    // If high word is 0, it's a single char; otherwise pointer to string
    if (p < 0x10000) return (p >= 0x61 && p <= 0x7A) ? p - 0x20 : p;
    // Pointer to string: uppercase in-place
    for (let i = 0; ; i++) {
      const ch = emu.memory.readU8(p + i);
      if (ch === 0) break;
      if (ch >= 0x61 && ch <= 0x7A) emu.memory.writeU8(p + i, ch - 0x20);
    }
    return p;
  });

  user32.register('CharUpperW', 1, () => {
    const p = emu.readArg(0);
    if (p < 0x10000) {
      // Single character: convert to uppercase
      return String.fromCharCode(p).toUpperCase().charCodeAt(0);
    }
    // Pointer to string: uppercase in-place
    for (let i = 0; ; i += 2) {
      const ch = emu.memory.readU16(p + i);
      if (ch === 0) break;
      emu.memory.writeU16(p + i, String.fromCharCode(ch).toUpperCase().charCodeAt(0));
    }
    return p;
  });

  user32.register('CharLowerW', 1, () => {
    const p = emu.readArg(0);
    if (p < 0x10000) {
      return String.fromCharCode(p).toLowerCase().charCodeAt(0);
    }
    for (let i = 0; ; i += 2) {
      const ch = emu.memory.readU16(p + i);
      if (ch === 0) break;
      emu.memory.writeU16(p + i, String.fromCharCode(ch).toLowerCase().charCodeAt(0));
    }
    return p;
  });

  // GetKeyboardLayout is registered in input.ts

  // GetTabbedTextExtentA(hDC, lpString, chCount, nTabPositions, lpnTabStopPositions) → DWORD
  // Return MAKELONG(width, height), stub as 8x8
  user32.register('GetTabbedTextExtentA', 5, () => (8 << 16) | 8);
  user32.register('GetTabbedTextExtentW', 5, () => (8 << 16) | 8);

  // TabbedTextOutW(hDC, x, y, lpString, chCount, nTabPositions, lpnTabStopPositions, nTabOrigin) → LONG
  // Return height, stub as 8
  user32.register('TabbedTextOutW', 8, () => (8 << 16) | 8);

  user32.register('GrayStringW', 9, () => 1);

  // CharUpperBuffW(lpsz, cchLength) → DWORD (number of chars processed)
  user32.register('CharUpperBuffW', 2, () => {
    const lpsz = emu.readArg(0);
    const cchLength = emu.readArg(1);
    for (let i = 0; i < cchLength; i++) {
      const ch = emu.memory.readU16(lpsz + i * 2);
      if (ch >= 0x61 && ch <= 0x7A) emu.memory.writeU16(lpsz + i * 2, ch - 0x20);
    }
    return cchLength;
  });
}
