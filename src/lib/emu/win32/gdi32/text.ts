import type { Emulator } from '../../emulator';
import { fillTextBitmap } from '../../emu-render';
import { OPAQUE } from '../types';
import { colorToCSS, getDCFont } from './_helpers';
import { applyFont, fontPixelSize, getTextMetrics, measureTextWidth } from '../../../gdi';

export function registerText(emu: Emulator): void {
  const gdi32 = emu.registerDll('GDI32.DLL');

  // tmHeight (cell height) — `font.height` is GDI's lfHeight: when negative
  // it's the character height (cell minus internal leading), positive is
  // the cell height itself. We approximate by upscaling negative values
  // 20 % so calls like GetTextMetrics report a plausible tmHeight.
  const getFontSize = (hdc: number): number => {
    const f = getDCFont(emu, hdc);
    const px = fontPixelSize(f);
    return f.height < 0 ? Math.round(px * 1.2) : px;
  };

  gdi32.register('TextOutA', 5, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const strPtr = emu.readArg(3);
    const count = emu.readArg(4);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    const text = emu.memory.readBytesMBCS(strPtr, count);

    const font = getDCFont(emu, hdc);
    const fontSize = getFontSize(hdc);
    applyFont(dc.ctx, font);
    if (dc.bkMode === OPAQUE) {
      dc.ctx.fillStyle = colorToCSS(dc.bkColor);
      const m = dc.ctx.measureText(text);
      dc.ctx.fillRect(x, y, m.width, fontSize);
    }
    dc.ctx.fillStyle = colorToCSS(dc.textColor);
    dc.ctx.textBaseline = 'top';
    fillTextBitmap(dc.ctx, text, x, y);

    emu.syncDCToCanvas(hdc);
    return 1;
  });

  gdi32.register('ExtTextOutA', 8, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const options = emu.readArg(3);
    const rectPtr = emu.readArg(4);
    const strPtr = emu.readArg(5);
    const count = emu.readArg(6);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    // If ETO_OPAQUE (0x2), fill background rect
    if ((options & 0x2) && rectPtr) {
      const left = emu.memory.readI32(rectPtr);
      const top = emu.memory.readI32(rectPtr + 4);
      const right = emu.memory.readI32(rectPtr + 8);
      const bottom = emu.memory.readI32(rectPtr + 12);
      dc.ctx.fillStyle = colorToCSS(dc.bkColor);
      dc.ctx.fillRect(left, top, right - left, bottom - top);
    }

    if (strPtr && count > 0) {
      const text = emu.memory.readBytesMBCS(strPtr, count);
      applyFont(dc.ctx, getDCFont(emu, hdc));
      dc.ctx.fillStyle = colorToCSS(dc.textColor);
      dc.ctx.textBaseline = 'top';
      fillTextBitmap(dc.ctx, text, x, y);
    }

    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // DrawTextA is a USER32 function — the full implementation with word-wrap
  // is in user32/text.ts. Only register under GDI32 as a simple fallback.
  gdi32.register('DrawTextA', 5, () => {
    const hdc = emu.readArg(0);
    const strPtr = emu.readArg(1);
    let count = emu.readArg(2) | 0;
    const rectPtr = emu.readArg(3);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    const text = count === -1
      ? emu.memory.readCString(strPtr)
      : emu.memory.readBytesMBCS(strPtr, count);

    const left = emu.memory.readI32(rectPtr);
    const top = emu.memory.readI32(rectPtr + 4);

    applyFont(dc.ctx, getDCFont(emu, hdc));
    dc.ctx.fillStyle = colorToCSS(dc.textColor);
    dc.ctx.textBaseline = 'top';
    fillTextBitmap(dc.ctx, text, left, top);

    emu.syncDCToCanvas(hdc);
    return getFontSize(hdc);
  });

  gdi32.register('GetTextExtentPoint32A', 4, () => {
    const hdc = emu.readArg(0);
    const strPtr = emu.readArg(1);
    const count = emu.readArg(2);
    const sizePtr = emu.readArg(3);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    const text = emu.memory.readBytesMBCS(strPtr, count);

    const font = getDCFont(emu, hdc);
    const w = measureTextWidth(dc.ctx, font, text);
    emu.memory.writeU32(sizePtr, w);
    emu.memory.writeU32(sizePtr + 4, getFontSize(hdc));
    return 1;
  });

  gdi32.register('GetTextExtentPointA', 4, () => {
    const hdc = emu.readArg(0);
    const strPtr = emu.readArg(1);
    const count = emu.readArg(2);
    const sizePtr = emu.readArg(3);
    if (sizePtr) {
      const fontSize = getFontSize(hdc);
      const dc = emu.getDC(hdc);
      if (dc) {
        const font = getDCFont(emu, hdc);
        let text = '';
        for (let i = 0; i < count; i++) text += String.fromCharCode(emu.memory.readU8(strPtr + i));
        emu.memory.writeU32(sizePtr, measureTextWidth(dc.ctx, font, text));
      } else {
        emu.memory.writeU32(sizePtr, count * 7);
      }
      emu.memory.writeU32(sizePtr + 4, fontSize);
    }
    return 1;
  });

  gdi32.register('GetTextMetricsA', 2, () => {
    const hdc = emu.readArg(0);
    const ptr = emu.readArg(1);
    const fontSize = getFontSize(hdc);
    const dc = emu.getDC(hdc);
    let aveCharWidth = Math.round(fontSize * 0.45);
    let maxCharWidth = fontSize;
    // Derive ascent/descent from the reported tmHeight so the sum matches
    // what GDI guarantees (tmHeight = tmAscent + tmDescent). Pull just the
    // character-width metrics from the shared library — those depend on
    // the live font selection, not on our cell-height assumption.
    const ascent = Math.round(fontSize * 0.8);
    const descent = fontSize - ascent;
    if (dc) {
      const tm = getTextMetrics(dc.ctx, getDCFont(emu, hdc));
      aveCharWidth = tm.aveCharWidth;
      maxCharWidth = tm.maxCharWidth;
    }
    emu.memory.writeU32(ptr, fontSize);      // tmHeight
    emu.memory.writeU32(ptr + 4, ascent);    // tmAscent
    emu.memory.writeU32(ptr + 8, descent);   // tmDescent
    emu.memory.writeU32(ptr + 12, 0); // tmInternalLeading
    emu.memory.writeU32(ptr + 16, 0); // tmExternalLeading
    emu.memory.writeU32(ptr + 20, aveCharWidth); // tmAveCharWidth
    emu.memory.writeU32(ptr + 24, maxCharWidth); // tmMaxCharWidth
    return 1;
  });

  // CreateFontA(nHeight, nWidth, nEsc, nOrient, fnWeight, fdwItalic,
  //             fdwUnderline, fdwStrikeOut, fdwCharSet, fdwOutputPrecision,
  //             fdwClipPrecision, fdwQuality, fdwPitchAndFamily, lpszFace)
  gdi32.register('CreateFontA', 14, () => {
    const height = emu.readArg(0) | 0;
    const weight = emu.readArg(4) | 0;
    const italic = !!emu.readArg(5);
    const underline = !!emu.readArg(6);
    const strikeout = !!emu.readArg(7);
    const facePtr = emu.readArg(13);
    const faceName = facePtr ? emu.memory.readCString(facePtr) : 'Tahoma';
    return emu.handles.alloc('font', { height, weight, italic, underline, strikeout, faceName });
  });

  gdi32.register('CreateFontW', 14, () => {
    const height = emu.readArg(0) | 0;
    const weight = emu.readArg(4) | 0;
    const italic = !!emu.readArg(5);
    const underline = !!emu.readArg(6);
    const strikeout = !!emu.readArg(7);
    const facePtr = emu.readArg(13);
    const faceName = facePtr ? emu.memory.readUTF16String(facePtr) : 'Tahoma';
    return emu.handles.alloc('font', { height, weight, italic, underline, strikeout, faceName });
  });

  // LOGFONTA: lfHeight LONG @0, lfWidth @4, lfEscapement @8, lfOrientation @12,
  // lfWeight LONG @16, lfItalic BYTE @20, lfUnderline @21, lfStrikeOut @22,
  // lfCharSet @23, ... lfFaceName[32] @28.
  gdi32.register('CreateFontIndirectA', 1, () => {
    const ptr = emu.readArg(0);
    const height = emu.memory.readI32(ptr);
    const weight = emu.memory.readI32(ptr + 16);
    const italic = emu.memory.readU8(ptr + 20) !== 0;
    const underline = emu.memory.readU8(ptr + 21) !== 0;
    const strikeout = emu.memory.readU8(ptr + 22) !== 0;
    const faceName = emu.memory.readCString(ptr + 28);
    return emu.handles.alloc('font', { height, weight, italic, underline, strikeout, faceName });
  });

  gdi32.register('CreateFontIndirectW', 1, () => {
    const ptr = emu.readArg(0);
    const height = emu.memory.readI32(ptr);
    const weight = emu.memory.readI32(ptr + 16);
    const italic = emu.memory.readU8(ptr + 20) !== 0;
    const underline = emu.memory.readU8(ptr + 21) !== 0;
    const strikeout = emu.memory.readU8(ptr + 22) !== 0;
    const faceName = emu.memory.readUTF16String(ptr + 28);
    return emu.handles.alloc('font', { height, weight, italic, underline, strikeout, faceName });
  });

  gdi32.register('GetTextExtentPointW', 4, () => {
    const hdc = emu.readArg(0);
    const strPtr = emu.readArg(1);
    const count = emu.readArg(2);
    const sizePtr = emu.readArg(3);
    if (sizePtr) {
      const dc = emu.getDC(hdc);
      const fontSize = getFontSize(hdc);
      if (dc) {
        let text = '';
        for (let i = 0; i < count; i++) text += String.fromCharCode(emu.memory.readU16(strPtr + i * 2));
        emu.memory.writeU32(sizePtr, measureTextWidth(dc.ctx, getDCFont(emu, hdc), text));
        emu.memory.writeU32(sizePtr + 4, fontSize);
      } else {
        emu.memory.writeU32(sizePtr, count * Math.ceil(fontSize * 0.6));
        emu.memory.writeU32(sizePtr + 4, fontSize);
      }
    }
    return 1;
  });

  gdi32.register('GetTextExtentExPointA', 7, () => {
    const hdc = emu.readArg(0);
    const strPtr = emu.readArg(1);
    const count = emu.readArg(2);
    const maxExtent = emu.readArg(3);
    const fitPtr = emu.readArg(4);
    const dxPtr = emu.readArg(5);
    const sizePtr = emu.readArg(6);
    const dc = emu.getDC(hdc);
    const fontSize = getFontSize(hdc);
    let totalW = 0;
    let fit = 0;
    if (dc) {
      applyFont(dc.ctx, getDCFont(emu, hdc));
      for (let i = 0; i < count; i++) {
        let s = '';
        for (let j = 0; j <= i; j++) s += String.fromCharCode(emu.memory.readU8(strPtr + j));
        totalW = Math.ceil(dc.ctx.measureText(s).width);
        if (dxPtr) emu.memory.writeU32(dxPtr + i * 4, totalW);
        if (maxExtent === 0 || totalW <= maxExtent) fit = i + 1;
      }
    } else {
      const charW = Math.ceil(fontSize * 0.6);
      for (let i = 0; i < count; i++) {
        totalW = (i + 1) * charW;
        if (dxPtr) emu.memory.writeU32(dxPtr + i * 4, totalW);
        if (maxExtent === 0 || totalW <= maxExtent) fit = i + 1;
      }
    }
    if (fitPtr) emu.memory.writeU32(fitPtr, fit);
    if (sizePtr) {
      emu.memory.writeU32(sizePtr, totalW);
      emu.memory.writeU32(sizePtr + 4, fontSize);
    }
    return 1;
  });

  gdi32.register('GetTextExtentExPointW', 7, () => {
    const hdc = emu.readArg(0);
    const strPtr = emu.readArg(1);
    const count = emu.readArg(2);
    const maxExtent = emu.readArg(3);
    const fitPtr = emu.readArg(4);
    const dxPtr = emu.readArg(5);
    const sizePtr = emu.readArg(6);
    const dc = emu.getDC(hdc);
    const fontSize = getFontSize(hdc);
    let totalW = 0;
    let fit = 0;
    if (dc) {
      applyFont(dc.ctx, getDCFont(emu, hdc));
      for (let i = 0; i < count; i++) {
        let s = '';
        for (let j = 0; j <= i; j++) s += String.fromCharCode(emu.memory.readU16(strPtr + j * 2));
        totalW = Math.ceil(dc.ctx.measureText(s).width);
        if (dxPtr) emu.memory.writeU32(dxPtr + i * 4, totalW);
        if (maxExtent === 0 || totalW <= maxExtent) fit = i + 1;
      }
    } else {
      const charW = Math.ceil(fontSize * 0.6);
      for (let i = 0; i < count; i++) {
        totalW = (i + 1) * charW;
        if (dxPtr) emu.memory.writeU32(dxPtr + i * 4, totalW);
        if (maxExtent === 0 || totalW <= maxExtent) fit = i + 1;
      }
    }
    if (fitPtr) emu.memory.writeU32(fitPtr, fit);
    if (sizePtr) {
      emu.memory.writeU32(sizePtr, totalW);
      emu.memory.writeU32(sizePtr + 4, fontSize);
    }
    return 1;
  });

  gdi32.register('ExtTextOutW', 8, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const options = emu.readArg(3);
    const rectPtr = emu.readArg(4);
    const strPtr = emu.readArg(5);
    const count = emu.readArg(6);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    let text = '';
    if (strPtr && count > 0) {
      for (let i = 0; i < count; i++) text += String.fromCharCode(emu.memory.readU16(strPtr + i * 2));
    }
    if ((options & 0x2) && rectPtr) {
      const left = emu.memory.readI32(rectPtr);
      const top = emu.memory.readI32(rectPtr + 4);
      const right = emu.memory.readI32(rectPtr + 8);
      const bottom = emu.memory.readI32(rectPtr + 12);
      dc.ctx.fillStyle = colorToCSS(dc.bkColor);
      dc.ctx.fillRect(left, top, right - left, bottom - top);
    }

    if (text) {
      applyFont(dc.ctx, getDCFont(emu, hdc));
      dc.ctx.fillStyle = colorToCSS(dc.textColor);
      dc.ctx.textBaseline = 'top';
      fillTextBitmap(dc.ctx, text, x, y);
    }

    emu.syncDCToCanvas(hdc);
    return 1;
  });

  gdi32.register('SetTextAlign', 2, () => 0); // return previous alignment
  gdi32.register('GetTextAlign', 1, () => 0); // TA_LEFT|TA_TOP
  gdi32.register('SetTextCharacterExtra', 2, () => 0); // return previous spacing
  gdi32.register('SetTextJustification', 3, () => 1);
  gdi32.register('GetNearestColor', 2, () => emu.readArg(1)); // return the color as-is
  gdi32.register('TranslateCharsetInfo', 3, () => 0); // fail
  gdi32.register('GetFontAssocStatus', 1, () => 0); // no font association

  gdi32.register('EnumFontsA', 4, () => 0); // return 0 = no fonts enumerated
  gdi32.register('EnumFontsW', 4, () => 0);
  gdi32.register('EnumFontFamiliesW', 4, () => 1);
  gdi32.register('EnumFontFamiliesExW', 5, () => 1);
  gdi32.register('AddFontResourceA', 1, () => 0);
  gdi32.register('AddFontResourceW', 1, () => 0);
  gdi32.register('RemoveFontResourceA', 1, () => 0);
  gdi32.register('RemoveFontResourceW', 1, () => 0);

  gdi32.register('GetTextFaceW', 3, () => {
    const _hdc = emu.readArg(0);
    const nCount = emu.readArg(1);
    const bufPtr = emu.readArg(2);
    const faceName = 'Tahoma';
    if (bufPtr && nCount > 0) {
      const len = Math.min(faceName.length, nCount - 1);
      for (let i = 0; i < len; i++) emu.memory.writeU16(bufPtr + i * 2, faceName.charCodeAt(i));
      emu.memory.writeU16(bufPtr + len * 2, 0);
      return len;
    }
    return faceName.length;
  });

  gdi32.register('GetTextMetricsW', 2, () => {
    const _hdc = emu.readArg(0);
    const ptr = emu.readArg(1);
    if (ptr) {
      // Fill TEXTMETRICW (60 bytes) with reasonable defaults
      emu.memory.writeU32(ptr + 0, 16);  // tmHeight
      emu.memory.writeU32(ptr + 4, 13);  // tmAscent
      emu.memory.writeU32(ptr + 8, 3);   // tmDescent
      emu.memory.writeU32(ptr + 12, 0);  // tmInternalLeading
      emu.memory.writeU32(ptr + 16, 0);  // tmExternalLeading
      emu.memory.writeU32(ptr + 20, 7);  // tmAveCharWidth
      emu.memory.writeU32(ptr + 24, 14); // tmMaxCharWidth
      emu.memory.writeU32(ptr + 28, 400);// tmWeight
      emu.memory.writeU32(ptr + 32, 0);  // tmOverhang
      emu.memory.writeU32(ptr + 36, 96); // tmDigitizedAspectX
      emu.memory.writeU32(ptr + 40, 96); // tmDigitizedAspectY
      emu.memory.writeU16(ptr + 44, 0x20); // tmFirstChar
      emu.memory.writeU16(ptr + 46, 0xFF); // tmLastChar
      emu.memory.writeU16(ptr + 48, 0x3F); // tmDefaultChar
      emu.memory.writeU16(ptr + 50, 0x20); // tmBreakChar
      emu.memory.writeU8(ptr + 52, 0);   // tmItalic
      emu.memory.writeU8(ptr + 53, 0);   // tmUnderlined
      emu.memory.writeU8(ptr + 54, 0);   // tmStruckOut
      emu.memory.writeU8(ptr + 55, 0);   // tmPitchAndFamily
      emu.memory.writeU8(ptr + 56, 0);   // tmCharSet (ANSI)
    }
    return 1;
  });

  // TextOutW : the Unicode twin of TextOutA. Was a stub that "succeeded" but
  // never drew, so any Unicode-built app calling TextOutW (Notepad on Win2k+,
  // localised MFC views, etc.) had blank text on canvas controls.
  gdi32.register('TextOutW', 5, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const strPtr = emu.readArg(3);
    const count = emu.readArg(4);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    let text = '';
    for (let i = 0; i < count; i++) {
      text += String.fromCharCode(emu.memory.readU16(strPtr + i * 2));
    }
    const fontSize = getFontSize(hdc);
    applyFont(dc.ctx, getDCFont(emu, hdc));
    if (dc.bkMode === OPAQUE) {
      dc.ctx.fillStyle = colorToCSS(dc.bkColor);
      const m = dc.ctx.measureText(text);
      dc.ctx.fillRect(x, y, m.width, fontSize);
    }
    dc.ctx.fillStyle = colorToCSS(dc.textColor);
    dc.ctx.textBaseline = 'top';
    fillTextBitmap(dc.ctx, text, x, y);

    emu.syncDCToCanvas(hdc);
    return 1;
  });

  gdi32.register('GetTextExtentPoint32W', 4, () => {
    const _hdc = emu.readArg(0);
    const _str = emu.readArg(1);
    const count = emu.readArg(2);
    const sizePtr = emu.readArg(3);
    if (sizePtr) {
      emu.memory.writeU32(sizePtr, count * 7); // cx
      emu.memory.writeU32(sizePtr + 4, 16);    // cy
    }
    return 1;
  });

  // GetCharWidthW(hdc, iFirstChar, iLastChar, lpBuffer)
  gdi32.register('GetCharWidthW', 4, () => {
    const _hdc = emu.readArg(0);
    const first = emu.readArg(1);
    const last = emu.readArg(2);
    const buf = emu.readArg(3);
    if (buf) {
      for (let i = 0; i <= last - first; i++) {
        emu.memory.writeU32(buf + i * 4, 7); // average char width
      }
    }
    return 1;
  });

  // GetCharWidth32W — same as GetCharWidthW (newer name)
  gdi32.register('GetCharWidth32W', 4, () => {
    const _hdc = emu.readArg(0);
    const first = emu.readArg(1);
    const last = emu.readArg(2);
    const buf = emu.readArg(3);
    if (buf) {
      for (let i = 0; i <= last - first; i++) {
        emu.memory.writeU32(buf + i * 4, 7);
      }
    }
    return 1;
  });

  // GetOutlineTextMetricsW(hdc, cbData, lpotm) — returns size of OUTLINETEXTMETRICW
  const OUTLINETEXTMETRICW_SIZE = 212;
  gdi32.register('GetOutlineTextMetricsW', 3, () => {
    const _hdc = emu.readArg(0);
    const cbData = emu.readArg(1);
    const lpotm = emu.readArg(2);
    if (cbData === 0 || !lpotm) return OUTLINETEXTMETRICW_SIZE;
    // Zero-fill and populate key fields
    for (let i = 0; i < Math.min(cbData, OUTLINETEXTMETRICW_SIZE); i++) emu.memory.writeU8(lpotm + i, 0);
    emu.memory.writeU32(lpotm, OUTLINETEXTMETRICW_SIZE); // otmSize
    // Embedded TEXTMETRICW at offset 4 (56 bytes)
    const tm = lpotm + 4;
    emu.memory.writeU32(tm + 0, 16);   // tmHeight
    emu.memory.writeU32(tm + 4, 13);   // tmAscent
    emu.memory.writeU32(tm + 8, 3);    // tmDescent
    emu.memory.writeU32(tm + 20, 7);   // tmAveCharWidth
    emu.memory.writeU32(tm + 24, 14);  // tmMaxCharWidth
    emu.memory.writeU32(tm + 28, 400); // tmWeight
    return OUTLINETEXTMETRICW_SIZE;
  });

  gdi32.register('CreateDCA', 4, () => 0); // printer/display device, no DC available
  gdi32.register('CreateDCW', 4, () => 0);
  // LPtoDP(hdc, lpPoints, nCount) — convert N POINTs from logical to device
  // coordinates IN-PLACE. The stub-1 made callers read whatever was already
  // in the buffer (often zeros); a no-op identity transform under MM_TEXT
  // matches what most MFC paint code expects.
  gdi32.register('LPtoDP', 3, () => {
    const hdc = emu.readArg(0);
    const lpPoints = emu.readArg(1);
    const nCount = emu.readArg(2) | 0;
    const dc = emu.getDC(hdc);
    if (!dc || !lpPoints || nCount <= 0) return 0;
    const mode = dc.mapMode ?? 1; // MM_TEXT
    if (mode === 1) return 1; // identity — caller's buffer already correct
    // Compute scale from window/viewport extents
    const wEx = dc.windowExtX || 1, wEy = dc.windowExtY || 1;
    const vEx = dc.viewportExtX || 1, vEy = dc.viewportExtY || 1;
    const wOx = dc.windowOrgX || 0, wOy = dc.windowOrgY || 0;
    const vOx = dc.viewportOrgX || 0, vOy = dc.viewportOrgY || 0;
    for (let i = 0; i < nCount; i++) {
      const px = lpPoints + i * 8;
      const lx = emu.memory.readI32(px);
      const ly = emu.memory.readI32(px + 4);
      const dx = ((lx - wOx) * vEx) / wEx + vOx;
      const dy = ((ly - wOy) * vEy) / wEy + vOy;
      emu.memory.writeI32(px,     Math.round(dx));
      emu.memory.writeI32(px + 4, Math.round(dy));
    }
    return 1;
  });
  gdi32.register('StartDocW', 2, () => 1);
  gdi32.register('StartDocA', 2, () => 1);
  gdi32.register('GetTextFaceA', 3, () => {
    const _hdc = emu.readArg(0);
    const nCount = emu.readArg(1);
    const bufPtr = emu.readArg(2);
    const faceName = 'Tahoma';
    if (bufPtr && nCount > 0) {
      const len = Math.min(faceName.length, nCount - 1);
      for (let i = 0; i < len; i++) emu.memory.writeU8(bufPtr + i, faceName.charCodeAt(i) & 0xFF);
      emu.memory.writeU8(bufPtr + len, 0);
      return len;
    }
    return faceName.length;
  });
  gdi32.register('GetCharWidthA', 4, () => {
    const _hdc = emu.readArg(0);
    const first = emu.readArg(1);
    const last = emu.readArg(2);
    const buf = emu.readArg(3);
    if (buf) {
      for (let i = 0; i <= last - first; i++) emu.memory.writeU32(buf + i * 4, 7);
    }
    return 1;
  });
  gdi32.register('GetCharWidth32A', 4, () => {
    const _hdc = emu.readArg(0);
    const first = emu.readArg(1);
    const last = emu.readArg(2);
    const buf = emu.readArg(3);
    if (buf) {
      for (let i = 0; i <= last - first; i++) emu.memory.writeU32(buf + i * 4, 7);
    }
    return 1;
  });
  gdi32.register('SetAbortProc', 2, () => 1);
  gdi32.register('StartPage', 1, () => 1);
  gdi32.register('EndPage', 1, () => 1);
  gdi32.register('EndDoc', 1, () => 1);
}
