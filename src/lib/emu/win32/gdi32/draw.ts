import type { Emulator } from '../../emulator';
import type { PaletteInfo, BitmapInfo, DCInfo } from './types';
import { PS_NULL, OPAQUE } from '../types';
import { colorToCSS, isPaletteIndex, getPaletteIdx, resolveColor, ensurePalIndexBuf } from './_helpers';

function bresenhamLine(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    ctx.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

/** Stroke a dashed/dotted line (PS_DASH..PS_DASHDOTDOT) via setLineDash. */
function dashedLine(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x0: number, y0: number, x1: number, y1: number, css: string, style: number,
): void {
  ctx.save();
  ctx.strokeStyle = css;
  ctx.lineWidth = 1;
  // PS_DASH=1, PS_DOT=2, PS_DASHDOT=3, PS_DASHDOTDOT=4
  const dash = style === 2 ? [1, 1]
    : style === 1 ? [3, 1]
    : style === 3 ? [3, 1, 1, 1]
    : [3, 1, 1, 1, 1, 1];
  ctx.setLineDash(dash);
  ctx.beginPath();
  // +0.5 keeps a 1px axis-aligned line crisp on the canvas grid.
  ctx.moveTo(x0 + 0.5, y0 + 0.5);
  ctx.lineTo(x1 + 0.5, y1 + 0.5);
  ctx.stroke();
  ctx.restore();
}

/** Bresenham line that also writes to the palette index buffer */
function bresenhamLinePal(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x0: number, y0: number, x1: number, y1: number,
  palIdxBuf: Uint8Array, cw: number, ch: number, palIdxPlusOne: number,
): void {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    ctx.fillRect(x0, y0, 1, 1);
    if (x0 >= 0 && x0 < cw && y0 >= 0 && y0 < ch) {
      palIdxBuf[y0 * cw + x0] = palIdxPlusOne;
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

export function registerDraw(emu: Emulator): void {
  const gdi32 = emu.registerDll('GDI32.DLL');

  gdi32.register('MoveToEx', 4, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const prevPtr = emu.readArg(3);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    if (prevPtr) {
      emu.memory.writeU32(prevPtr, dc.penPosX);
      emu.memory.writeU32(prevPtr + 4, dc.penPosY);
    }
    dc.penPosX = x;
    dc.penPosY = y;
    return 1;
  });

  gdi32.register('LineTo', 3, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    const pen = emu.getPen(dc.selectedPen);
    const rop2 = dc.rop2;
    // R2_NOP (11) = no drawing; R2_COPYPEN (13) = normal; PS_NULL = invisible pen
    const R2_NOP = 11, R2_COPYPEN = 13, R2_WHITE = 16, R2_BLACK = 1;
    if (rop2 === R2_NOP) {
      // do nothing
    } else if (rop2 === R2_WHITE) {
      dc.ctx.fillStyle = '#ffffff';
      bresenhamLine(dc.ctx, dc.penPosX, dc.penPosY, x, y);
    } else if (rop2 === R2_BLACK) {
      dc.ctx.fillStyle = '#000000';
      bresenhamLine(dc.ctx, dc.penPosX, dc.penPosY, x, y);
    } else if (rop2 === R2_COPYPEN) {
      // Normal pen drawing
      if (pen && pen.style !== PS_NULL) {
        if (isPaletteIndex(pen.color)) {
          const pal = emu.handles.get<PaletteInfo>(dc.selectedPalette);
          const [r, g, b] = resolveColor(pen.color, pal ?? undefined);
          dc.ctx.fillStyle = `rgb(${r},${g},${b})`;
          const cw = dc.canvas.width || 1;
          const ch = dc.canvas.height || 1;
          const palBuf = ensurePalIndexBuf(dc);
          const palIdx = getPaletteIdx(pen.color);
          bresenhamLinePal(dc.ctx, dc.penPosX, dc.penPosY, x, y, palBuf, cw, ch, palIdx + 1);
        } else if (pen.style >= 1 && pen.style <= 4) {
          dashedLine(dc.ctx, dc.penPosX, dc.penPosY, x, y, colorToCSS(pen.color), pen.style);
        } else {
          dc.ctx.fillStyle = colorToCSS(pen.color);
          bresenhamLine(dc.ctx, dc.penPosX, dc.penPosY, x, y);
        }
      }
    } else {
      // All other ROP2 modes need per-pixel dst read
      let pr = 0, pg = 0, pb = 0;
      if (pen) { pr = pen.color & 0xFF; pg = (pen.color >> 8) & 0xFF; pb = (pen.color >> 16) & 0xFF; }
      const cw = dc.canvas.width || 1, ch = dc.canvas.height || 1;
      // getImageData ignores canvas transforms — apply offset manually
      const tf = dc.ctx.getTransform();
      const oX = Math.round(tf.e), oY = Math.round(tf.f);
      const imgData = dc.ctx.getImageData(0, 0, cw, ch);
      const d = imgData.data;
      let x0 = dc.penPosX, y0 = dc.penPosY, x1 = x, y1 = y;
      const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx - dy;
      while (true) {
        const cx = x0 + oX, cy = y0 + oY;
        if (cx >= 0 && cx < cw && cy >= 0 && cy < ch) {
          const off = (cy * cw + cx) * 4;
          const dr = d[off], dg = d[off+1], db = d[off+2];
          let rr: number, rg: number, rb: number;
          switch (rop2) {
            case 2:  rr = ~(dr|pr)&0xFF; rg = ~(dg|pg)&0xFF; rb = ~(db|pb)&0xFF; break; // R2_NOTMERGEPEN
            case 3:  rr = dr&(~pr&0xFF); rg = dg&(~pg&0xFF); rb = db&(~pb&0xFF); break; // R2_MASKNOTPEN
            case 4:  rr = ~pr&0xFF;      rg = ~pg&0xFF;      rb = ~pb&0xFF;      break; // R2_NOTCOPYPEN
            case 5:  rr = pr&(~dr&0xFF); rg = pg&(~dg&0xFF); rb = pb&(~db&0xFF); break; // R2_MASKPENNOT
            case 6:  rr = ~dr&0xFF;      rg = ~dg&0xFF;      rb = ~db&0xFF;      break; // R2_NOT
            case 7:  rr = dr^pr;         rg = dg^pg;         rb = db^pb;         break; // R2_XORPEN
            case 8:  rr = ~(dr&pr)&0xFF; rg = ~(dg&pg)&0xFF; rb = ~(db&pb)&0xFF; break; // R2_NOTMASKPEN
            case 9:  rr = dr&pr;         rg = dg&pg;         rb = db&pb;         break; // R2_MASKPEN
            case 10: rr = ~(dr^pr)&0xFF; rg = ~(dg^pg)&0xFF; rb = ~(db^pb)&0xFF; break; // R2_NOTXORPEN
            case 12: rr = dr|(~pr&0xFF); rg = dg|(~pg&0xFF); rb = db|(~pb&0xFF); break; // R2_MERGENOTPEN
            case 14: rr = pr|(~dr&0xFF); rg = pg|(~dg&0xFF); rb = pb|(~db&0xFF); break; // R2_MERGEPENNOT
            case 15: rr = dr|pr;         rg = dg|pg;         rb = db|pb;         break; // R2_MERGEPEN
            default: rr = pr; rg = pg; rb = pb; break;
          }
          d[off] = rr; d[off+1] = rg; d[off+2] = rb;
        }
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x0 += sx; }
        if (e2 < dx) { err += dx; y0 += sy; }
      }
      dc.ctx.putImageData(imgData, 0, 0);
    }
    dc.penPosX = x;
    dc.penPosY = y;

    emu.syncDCToCanvas(hdc);
    return 1;
  });

  gdi32.register('Rectangle', 5, () => {
    const hdc = emu.readArg(0);
    const left = emu.readArg(1) | 0;
    const top = emu.readArg(2) | 0;
    const right = emu.readArg(3) | 0;
    const bottom = emu.readArg(4) | 0;

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    const brush = emu.getBrush(dc.selectedBrush);
    if (brush && !brush.isNull) {
      dc.ctx.fillStyle = colorToCSS(brush.color);
      dc.ctx.fillRect(left, top, right - left, bottom - top);
    }

    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      // Pixel-perfect rectangle border (no anti-aliasing)
      dc.ctx.fillStyle = colorToCSS(pen.color);
      dc.ctx.fillRect(left, top, right - left, 1);           // top
      dc.ctx.fillRect(left, bottom - 1, right - left, 1);    // bottom
      dc.ctx.fillRect(left, top, 1, bottom - top);           // left
      dc.ctx.fillRect(right - 1, top, 1, bottom - top);      // right
    }

    emu.syncDCToCanvas(hdc);
    return 1;
  });

  gdi32.register('SetPixel', 4, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const color = emu.readArg(3);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    dc.ctx.fillStyle = colorToCSS(color);
    dc.ctx.fillRect(x, y, 1, 1);
    emu.syncDCToCanvas(hdc);
    return color;
  });

  gdi32.register('GetPixel', 3, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;

    const dc = emu.getDC(hdc);
    if (!dc) return 0xFFFFFFFF; // CLR_INVALID

    // If the DC has a selected bitmap, check bounds and read from DIB bits if available
    if (dc.selectedBitmap) {
      const bmp = emu.handles.get<BitmapInfo>(dc.selectedBitmap);
      if (bmp) {
        if (x < 0 || x >= bmp.width || y < 0 || y >= bmp.height) return 0xFFFFFFFF;
        if (bmp.dibBitsPtr && bmp.dibBpp) {
          const stride = Math.floor((bmp.width * bmp.dibBpp + 31) / 32) * 4;
          // DIB is bottom-up by default
          const row = bmp.height - 1 - y;
          if (bmp.dibBpp === 24) {
            const off = bmp.dibBitsPtr + row * stride + x * 3;
            const b = emu.memory.readU8(off);
            const g = emu.memory.readU8(off + 1);
            const r = emu.memory.readU8(off + 2);
            return r | (g << 8) | (b << 16);
          } else if (bmp.dibBpp === 32) {
            const off = bmp.dibBitsPtr + row * stride + x * 4;
            const b = emu.memory.readU8(off);
            const g = emu.memory.readU8(off + 1);
            const r = emu.memory.readU8(off + 2);
            return r | (g << 8) | (b << 16);
          }
        }
      }
    }

    // getImageData ignores canvas transforms — apply offset manually
    const tf = dc.ctx.getTransform();
    const cx = Math.round(tf.e + x * tf.a);
    const cy = Math.round(tf.f + y * tf.d);
    // Bounds check to avoid OOM from getImageData with large/negative coordinates
    if (cx < 0 || cy < 0) return 0xFFFFFFFF;
    const canvas = dc.ctx.canvas;
    if (canvas && (cx >= canvas.width || cy >= canvas.height)) return 0xFFFFFFFF;

    try {
      const imgData = dc.ctx.getImageData(cx, cy, 1, 1);
      const [r, g, b] = imgData.data;
      return r | (g << 8) | (b << 16);
    } catch {
      return 0xFFFFFFFF;
    }
  });

  gdi32.register('Polyline', 3, () => {
    const hdc = emu.readArg(0);
    const ptsPtr = emu.readArg(1);
    const count = emu.readArg(2);
    const dc = emu.getDC(hdc);
    if (!dc || count < 2) return 0;
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.fillStyle = colorToCSS(pen.color);
      let prevX = emu.memory.readI32(ptsPtr);
      let prevY = emu.memory.readI32(ptsPtr + 4);
      for (let i = 1; i < count; i++) {
        const nx = emu.memory.readI32(ptsPtr + i * 8);
        const ny = emu.memory.readI32(ptsPtr + i * 8 + 4);
        bresenhamLine(dc.ctx, prevX, prevY, nx, ny);
        prevX = nx; prevY = ny;
      }
    }
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  gdi32.register('PolyBezier', 3, () => {
    const hdc = emu.readArg(0);
    const ptsPtr = emu.readArg(1);
    const count = emu.readArg(2);
    const dc = emu.getDC(hdc);
    // PolyBezier requires 1 + 3*n points (start + n cubic segments)
    if (!dc || count < 4 || (count - 1) % 3 !== 0) return 0;
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      // Flatten bezier into line segments and draw without anti-aliasing
      const penColor = pen.color;
      const r = penColor & 0xFF, g = (penColor >> 8) & 0xFF, b = (penColor >> 16) & 0xFF;
      const cw = (dc.canvas as OffscreenCanvas).width || 640;
      const ch = (dc.canvas as OffscreenCanvas).height || 480;
      // getImageData ignores canvas transforms — apply offset manually
      const tf = dc.ctx.getTransform();
      const oX = Math.round(tf.e), oY = Math.round(tf.f);
      const imgData = dc.ctx.getImageData(0, 0, cw, ch);
      const data = imgData.data;
      const setPixel = (x: number, y: number) => {
        x = Math.round(x) + oX; y = Math.round(y) + oY;
        if (x < 0 || x >= cw || y < 0 || y >= ch) return;
        const idx = (y * cw + x) * 4;
        data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
      };
      // Bresenham line
      const drawLine = (x0: number, y0: number, x1: number, y1: number) => {
        x0 = Math.round(x0); y0 = Math.round(y0);
        x1 = Math.round(x1); y1 = Math.round(y1);
        let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        while (true) {
          setPixel(x0, y0);
          if (x0 === x1 && y0 === y1) break;
          const e2 = 2 * err;
          if (e2 > -dy) { err -= dy; x0 += sx; }
          if (e2 < dx) { err += dx; y0 += sy; }
        }
      };
      // Flatten cubic bezier by subdivision
      const flattenBezier = (ax: number, ay: number, bx: number, by: number,
                             cx: number, cy: number, dx: number, dy: number) => {
        const steps = Math.max(20, Math.ceil(Math.hypot(dx - ax, dy - ay) / 2));
        let px = ax, py = ay;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps, u = 1 - t;
          const nx = u*u*u*ax + 3*u*u*t*bx + 3*u*t*t*cx + t*t*t*dx;
          const ny = u*u*u*ay + 3*u*u*t*by + 3*u*t*t*cy + t*t*t*dy;
          drawLine(px, py, Math.round(nx), Math.round(ny));
          px = Math.round(nx); py = Math.round(ny);
        }
      };
      let curX = emu.memory.readI32(ptsPtr);
      let curY = emu.memory.readI32(ptsPtr + 4);
      for (let i = 1; i < count; i += 3) {
        const cx1 = emu.memory.readI32(ptsPtr + i * 8);
        const cy1 = emu.memory.readI32(ptsPtr + i * 8 + 4);
        const cx2 = emu.memory.readI32(ptsPtr + (i + 1) * 8);
        const cy2 = emu.memory.readI32(ptsPtr + (i + 1) * 8 + 4);
        const ex = emu.memory.readI32(ptsPtr + (i + 2) * 8);
        const ey = emu.memory.readI32(ptsPtr + (i + 2) * 8 + 4);
        flattenBezier(curX, curY, cx1, cy1, cx2, cy2, ex, ey);
        curX = ex; curY = ey;
      }
      dc.ctx.putImageData(imgData, 0, 0);
    }
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  gdi32.register('Polygon', 3, () => {
    const hdc = emu.readArg(0);
    const ptsPtr = emu.readArg(1);
    const count = emu.readArg(2);
    const dc = emu.getDC(hdc);
    if (!dc || count < 2) return 0;
    dc.ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const x = emu.memory.readI32(ptsPtr + i * 8);
      const y = emu.memory.readI32(ptsPtr + i * 8 + 4);
      if (i === 0) dc.ctx.moveTo(x, y);
      else dc.ctx.lineTo(x, y);
    }
    dc.ctx.closePath();
    const brush = emu.getBrush(dc.selectedBrush);
    if (brush && !brush.isNull) {
      dc.ctx.fillStyle = colorToCSS(brush.color);
      dc.ctx.fill();
    }
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.fillStyle = colorToCSS(pen.color);
      let prevX = emu.memory.readI32(ptsPtr);
      let prevY = emu.memory.readI32(ptsPtr + 4);
      for (let i = 1; i < count; i++) {
        const nx = emu.memory.readI32(ptsPtr + i * 8);
        const ny = emu.memory.readI32(ptsPtr + i * 8 + 4);
        bresenhamLine(dc.ctx, prevX, prevY, nx, ny);
        prevX = nx; prevY = ny;
      }
      // Close polygon
      bresenhamLine(dc.ctx, prevX, prevY, emu.memory.readI32(ptsPtr), emu.memory.readI32(ptsPtr + 4));
    }
    emu.syncDCToCanvas(hdc);
    return 1;
  });
  gdi32.register('SetStretchBltMode', 2, () => 1);

  const ALTERNATE = 1;
  const AD_COUNTERCLOCKWISE = 1;

  gdi32.register('SetPolyFillMode', 2, () => ALTERNATE);
  gdi32.register('GetPolyFillMode', 1, () => ALTERNATE);
  gdi32.register('SetArcDirection', 2, () => AD_COUNTERCLOCKWISE);

  gdi32.register('GetStretchBltMode', 1, () => 1); // BLACKONWHITE
  gdi32.register('GetTextColor', 1, () => {
    const hdc = emu.readArg(0);
    const dc = emu.getDC(hdc);
    return dc ? dc.textColor : 0;
  });
  gdi32.register('GetBkColor', 1, () => {
    const hdc = emu.readArg(0);
    const dc = emu.getDC(hdc);
    return dc ? dc.bkColor : 0x00FFFFFF;
  });

  gdi32.register('SetBkColor', 2, () => {
    const hdc = emu.readArg(0);
    const color = emu.readArg(1);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const old = dc.bkColor;
    dc.bkColor = color;
    return old;
  });

  gdi32.register('SetTextColor', 2, () => {
    const hdc = emu.readArg(0);
    const color = emu.readArg(1);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const old = dc.textColor;
    dc.textColor = color;
    return old;
  });

  gdi32.register('SetBkMode', 2, () => {
    const hdc = emu.readArg(0);
    const mode = emu.readArg(1);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const old = dc.bkMode;
    dc.bkMode = mode;
    return old;
  });

  gdi32.register('GetBkMode', 1, () => {
    const hdc = emu.readArg(0);
    const dc = emu.getDC(hdc);
    return dc ? dc.bkMode : OPAQUE;
  });

  // LineDDA: enumerate points on a line and call callback for each
  // BOOL LineDDA(int x1, int y1, int x2, int y2, LINEDDAPROC lpProc, LPARAM data)
  gdi32.register('LineDDA', 6, () => {
    const x1 = emu.readArg(0) | 0;
    const y1 = emu.readArg(1) | 0;
    const x2 = emu.readArg(2) | 0;
    const y2 = emu.readArg(3) | 0;
    const lpProc = emu.readArg(4);
    const data = emu.readArg(5);

    // Bresenham's line algorithm
    let dx = Math.abs(x2 - x1);
    let dy = -Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx + dy;
    let cx = x1, cy = y1;

    for (let i = 0; i < 10000; i++) {
      // Call lpProc(x, y, data) — CALLBACK (stdcall, 3 args)
      const savedEsp = emu.cpu.reg[4];
      emu.callWndProc(lpProc, cx, cy, data, 0);
      emu.cpu.reg[4] = savedEsp;
      if (emu.halted) break;
      if (cx === x2 && cy === y2) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; cx += sx; }
      if (e2 <= dx) { err += dx; cy += sy; }
    }
    return 1;
  });

  gdi32.register('PolyPolyline', 4, () => {
    const hdc = emu.readArg(0);
    const ptsPtr = emu.readArg(1);
    const countsPtr = emu.readArg(2);
    const nPolys = emu.readArg(3);
    const dc = emu.getDC(hdc);
    if (!dc || nPolys === 0) return 0;
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.fillStyle = colorToCSS(pen.color);
      let ptOff = 0;
      for (let p = 0; p < nPolys; p++) {
        const cnt = emu.memory.readU32(countsPtr + p * 4);
        if (cnt < 2) { ptOff += cnt; continue; }
        let prevX = emu.memory.readI32(ptsPtr + ptOff * 8);
        let prevY = emu.memory.readI32(ptsPtr + ptOff * 8 + 4);
        for (let i = 1; i < cnt; i++) {
          const nx = emu.memory.readI32(ptsPtr + (ptOff + i) * 8);
          const ny = emu.memory.readI32(ptsPtr + (ptOff + i) * 8 + 4);
          bresenhamLine(dc.ctx, prevX, prevY, nx, ny);
          prevX = nx; prevY = ny;
        }
        ptOff += cnt;
      }
    }
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // DPtoLP(hdc, lpPoints, nCount) — device→logical, in place.
  gdi32.register('DPtoLP', 3, () => {
    const hdc = emu.readArg(0);
    const lpPoints = emu.readArg(1);
    const nCount = emu.readArg(2) | 0;
    const dc = emu.getDC(hdc);
    if (!dc || !lpPoints || nCount <= 0) return 0;
    const mode = dc.mapMode ?? 1; // MM_TEXT
    if (mode === 1) return 1;
    const wEx = dc.windowExtX || 1, wEy = dc.windowExtY || 1;
    const vEx = dc.viewportExtX || 1, vEy = dc.viewportExtY || 1;
    const wOx = dc.windowOrgX || 0, wOy = dc.windowOrgY || 0;
    const vOx = dc.viewportOrgX || 0, vOy = dc.viewportOrgY || 0;
    for (let i = 0; i < nCount; i++) {
      const px = lpPoints + i * 8;
      const dx = emu.memory.readI32(px);
      const dy = emu.memory.readI32(px + 4);
      const lx = ((dx - vOx) * wEx) / vEx + wOx;
      const ly = ((dy - vOy) * wEy) / vEy + wOy;
      emu.memory.writeI32(px,     Math.round(lx));
      emu.memory.writeI32(px + 4, Math.round(ly));
    }
    return 1;
  });
  gdi32.register('SetMapperFlags', 2, () => 0);
  gdi32.register('AbortDoc', 1, () => 0);

  gdi32.register('PolyPolygon', 4, () => {
    const hdc = emu.readArg(0);
    const ptsPtr = emu.readArg(1);
    const countsPtr = emu.readArg(2);
    const nPolys = emu.readArg(3);
    const dc = emu.getDC(hdc);
    if (!dc || nPolys === 0) return 0;
    const brush = emu.getBrush(dc.selectedBrush);
    const pen = emu.getPen(dc.selectedPen);
    let ptOff = 0;
    for (let p = 0; p < nPolys; p++) {
      const cnt = emu.memory.readU32(countsPtr + p * 4);
      if (cnt < 2) { ptOff += cnt; continue; }
      dc.ctx.beginPath();
      for (let i = 0; i < cnt; i++) {
        const x = emu.memory.readI32(ptsPtr + (ptOff + i) * 8);
        const y = emu.memory.readI32(ptsPtr + (ptOff + i) * 8 + 4);
        if (i === 0) dc.ctx.moveTo(x, y); else dc.ctx.lineTo(x, y);
      }
      dc.ctx.closePath();
      if (brush && !brush.isNull) {
        dc.ctx.fillStyle = colorToCSS(brush.color);
        dc.ctx.fill();
      }
      if (pen && pen.style !== PS_NULL) {
        dc.ctx.fillStyle = colorToCSS(pen.color);
        let prevX = emu.memory.readI32(ptsPtr + ptOff * 8);
        let prevY = emu.memory.readI32(ptsPtr + ptOff * 8 + 4);
        for (let i = 1; i < cnt; i++) {
          const nx = emu.memory.readI32(ptsPtr + (ptOff + i) * 8);
          const ny = emu.memory.readI32(ptsPtr + (ptOff + i) * 8 + 4);
          bresenhamLine(dc.ctx, prevX, prevY, nx, ny);
          prevX = nx; prevY = ny;
        }
        bresenhamLine(dc.ctx, prevX, prevY,
          emu.memory.readI32(ptsPtr + ptOff * 8),
          emu.memory.readI32(ptsPtr + ptOff * 8 + 4));
      }
      ptOff += cnt;
    }
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // Ellipse(hdc, left, top, right, bottom)
  gdi32.register('Ellipse', 5, () => {
    const hdc = emu.readArg(0);
    const left = emu.readArg(1) | 0;
    const top = emu.readArg(2) | 0;
    const right = emu.readArg(3) | 0;
    const bottom = emu.readArg(4) | 0;
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    const rx = (right - left) / 2, ry = (bottom - top) / 2;
    dc.ctx.beginPath();
    dc.ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, 2 * Math.PI);
    const brush = emu.getBrush(dc.selectedBrush);
    if (brush && !brush.isNull) {
      dc.ctx.fillStyle = colorToCSS(brush.color);
      dc.ctx.fill();
    }
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.strokeStyle = colorToCSS(pen.color);
      dc.ctx.lineWidth = Math.max(1, pen.width);
      dc.ctx.stroke();
    }
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // RoundRect(hdc, left, top, right, bottom, width, height)
  gdi32.register('RoundRect', 7, () => {
    const hdc = emu.readArg(0);
    const left = emu.readArg(1) | 0;
    const top = emu.readArg(2) | 0;
    const right = emu.readArg(3) | 0;
    const bottom = emu.readArg(4) | 0;
    const ew = emu.readArg(5) | 0;
    const eh = emu.readArg(6) | 0;
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const rx = ew / 2, ry = eh / 2;
    const ctx = dc.ctx;
    ctx.beginPath();
    ctx.moveTo(left + rx, top);
    ctx.lineTo(right - rx, top);
    ctx.ellipse(right - rx, top + ry, rx, ry, 0, -Math.PI / 2, 0);
    ctx.lineTo(right, bottom - ry);
    ctx.ellipse(right - rx, bottom - ry, rx, ry, 0, 0, Math.PI / 2);
    ctx.lineTo(left + rx, bottom);
    ctx.ellipse(left + rx, bottom - ry, rx, ry, 0, Math.PI / 2, Math.PI);
    ctx.lineTo(left, top + ry);
    ctx.ellipse(left + rx, top + ry, rx, ry, 0, Math.PI, 3 * Math.PI / 2);
    ctx.closePath();
    const brush = emu.getBrush(dc.selectedBrush);
    if (brush && !brush.isNull) {
      ctx.fillStyle = colorToCSS(brush.color);
      ctx.fill();
    }
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      ctx.strokeStyle = colorToCSS(pen.color);
      ctx.lineWidth = Math.max(1, pen.width);
      ctx.stroke();
    }
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // Helper to compute arc angle from reference point
  function arcAngle(cx: number, cy: number, x: number, y: number): number {
    return Math.atan2(y - cy, x - cx);
  }

  // Arc(hdc, left, top, right, bottom, xStart, yStart, xEnd, yEnd)
  gdi32.register('Arc', 9, () => {
    const hdc = emu.readArg(0);
    const left = emu.readArg(1) | 0, top = emu.readArg(2) | 0;
    const right = emu.readArg(3) | 0, bottom = emu.readArg(4) | 0;
    const xStart = emu.readArg(5) | 0, yStart = emu.readArg(6) | 0;
    const xEnd = emu.readArg(7) | 0, yEnd = emu.readArg(8) | 0;
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    const rx = (right - left) / 2, ry = (bottom - top) / 2;
    const startAngle = arcAngle(cx, cy, xStart, yStart);
    const endAngle = arcAngle(cx, cy, xEnd, yEnd);
    dc.ctx.beginPath();
    dc.ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, startAngle, endAngle, true);
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.strokeStyle = colorToCSS(pen.color);
      dc.ctx.lineWidth = Math.max(1, pen.width);
      dc.ctx.stroke();
    }
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // ArcTo(hdc, left, top, right, bottom, xStart, yStart, xEnd, yEnd)
  gdi32.register('ArcTo', 9, () => {
    const hdc = emu.readArg(0);
    const left = emu.readArg(1) | 0, top = emu.readArg(2) | 0;
    const right = emu.readArg(3) | 0, bottom = emu.readArg(4) | 0;
    const xStart = emu.readArg(5) | 0, yStart = emu.readArg(6) | 0;
    const xEnd = emu.readArg(7) | 0, yEnd = emu.readArg(8) | 0;
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    const rx = (right - left) / 2, ry = (bottom - top) / 2;
    const startAngle = arcAngle(cx, cy, xStart, yStart);
    const endAngle = arcAngle(cx, cy, xEnd, yEnd);
    // Draw line from current position to arc start
    const arcStartX = cx + rx * Math.cos(startAngle);
    const arcStartY = cy + ry * Math.sin(startAngle);
    dc.ctx.fillStyle = colorToCSS(emu.getPen(dc.selectedPen)?.color ?? 0);
    bresenhamLine(dc.ctx, dc.penPosX, dc.penPosY, Math.round(arcStartX), Math.round(arcStartY));
    dc.ctx.beginPath();
    dc.ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, startAngle, endAngle, true);
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.strokeStyle = colorToCSS(pen.color);
      dc.ctx.lineWidth = Math.max(1, pen.width);
      dc.ctx.stroke();
    }
    // Update pen position to arc end
    dc.penPosX = Math.round(cx + rx * Math.cos(endAngle));
    dc.penPosY = Math.round(cy + ry * Math.sin(endAngle));
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // Pie(hdc, left, top, right, bottom, xStart, yStart, xEnd, yEnd)
  gdi32.register('Pie', 9, () => {
    const hdc = emu.readArg(0);
    const left = emu.readArg(1) | 0, top = emu.readArg(2) | 0;
    const right = emu.readArg(3) | 0, bottom = emu.readArg(4) | 0;
    const xStart = emu.readArg(5) | 0, yStart = emu.readArg(6) | 0;
    const xEnd = emu.readArg(7) | 0, yEnd = emu.readArg(8) | 0;
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    const rx = (right - left) / 2, ry = (bottom - top) / 2;
    const startAngle = arcAngle(cx, cy, xStart, yStart);
    const endAngle = arcAngle(cx, cy, xEnd, yEnd);
    dc.ctx.beginPath();
    dc.ctx.moveTo(cx, cy);
    dc.ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, startAngle, endAngle, true);
    dc.ctx.closePath();
    const brush = emu.getBrush(dc.selectedBrush);
    if (brush && !brush.isNull) {
      dc.ctx.fillStyle = colorToCSS(brush.color);
      dc.ctx.fill();
    }
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.strokeStyle = colorToCSS(pen.color);
      dc.ctx.lineWidth = Math.max(1, pen.width);
      dc.ctx.stroke();
    }
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // Chord(hdc, left, top, right, bottom, xStart, yStart, xEnd, yEnd)
  gdi32.register('Chord', 9, () => {
    const hdc = emu.readArg(0);
    const left = emu.readArg(1) | 0, top = emu.readArg(2) | 0;
    const right = emu.readArg(3) | 0, bottom = emu.readArg(4) | 0;
    const xStart = emu.readArg(5) | 0, yStart = emu.readArg(6) | 0;
    const xEnd = emu.readArg(7) | 0, yEnd = emu.readArg(8) | 0;
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    const rx = (right - left) / 2, ry = (bottom - top) / 2;
    const startAngle = arcAngle(cx, cy, xStart, yStart);
    const endAngle = arcAngle(cx, cy, xEnd, yEnd);
    dc.ctx.beginPath();
    dc.ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, startAngle, endAngle, true);
    dc.ctx.closePath();
    const brush = emu.getBrush(dc.selectedBrush);
    if (brush && !brush.isNull) {
      dc.ctx.fillStyle = colorToCSS(brush.color);
      dc.ctx.fill();
    }
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.strokeStyle = colorToCSS(pen.color);
      dc.ctx.lineWidth = Math.max(1, pen.width);
      dc.ctx.stroke();
    }
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // SetPixelV(hdc, x, y, color) — same as SetPixel but returns BOOL
  gdi32.register('SetPixelV', 4, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const color = emu.readArg(3);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    dc.ctx.fillStyle = colorToCSS(color);
    dc.ctx.fillRect(x, y, 1, 1);
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // PolyBezierTo(hdc, lppt, cCount)
  gdi32.register('PolyBezierTo', 3, () => {
    const hdc = emu.readArg(0);
    const ptsPtr = emu.readArg(1);
    const count = emu.readArg(2);
    const dc = emu.getDC(hdc);
    if (!dc || count < 3 || count % 3 !== 0) return 0;
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.strokeStyle = colorToCSS(pen.color);
      dc.ctx.lineWidth = Math.max(1, pen.width);
      dc.ctx.beginPath();
      dc.ctx.moveTo(dc.penPosX, dc.penPosY);
      for (let i = 0; i < count; i += 3) {
        const cx1 = emu.memory.readI32(ptsPtr + i * 8);
        const cy1 = emu.memory.readI32(ptsPtr + i * 8 + 4);
        const cx2 = emu.memory.readI32(ptsPtr + (i + 1) * 8);
        const cy2 = emu.memory.readI32(ptsPtr + (i + 1) * 8 + 4);
        const ex = emu.memory.readI32(ptsPtr + (i + 2) * 8);
        const ey = emu.memory.readI32(ptsPtr + (i + 2) * 8 + 4);
        dc.ctx.bezierCurveTo(cx1, cy1, cx2, cy2, ex, ey);
      }
      dc.ctx.stroke();
    }
    // Update pen position to last point
    dc.penPosX = emu.memory.readI32(ptsPtr + (count - 1) * 8);
    dc.penPosY = emu.memory.readI32(ptsPtr + (count - 1) * 8 + 4);
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // PolylineTo(hdc, lppt, cCount)
  gdi32.register('PolylineTo', 3, () => {
    const hdc = emu.readArg(0);
    const ptsPtr = emu.readArg(1);
    const count = emu.readArg(2);
    const dc = emu.getDC(hdc);
    if (!dc || count === 0) return 0;
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.fillStyle = colorToCSS(pen.color);
      let prevX = dc.penPosX, prevY = dc.penPosY;
      for (let i = 0; i < count; i++) {
        const nx = emu.memory.readI32(ptsPtr + i * 8);
        const ny = emu.memory.readI32(ptsPtr + i * 8 + 4);
        bresenhamLine(dc.ctx, prevX, prevY, nx, ny);
        prevX = nx; prevY = ny;
      }
    }
    dc.penPosX = emu.memory.readI32(ptsPtr + (count - 1) * 8);
    dc.penPosY = emu.memory.readI32(ptsPtr + (count - 1) * 8 + 4);
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // PolyDraw(hdc, lppt, lpbTypes, cCount)
  const PT_CLOSEFIGURE = 0x01;
  const PT_LINETO = 0x02;
  const PT_BEZIERTO = 0x04;
  gdi32.register('PolyDraw', 4, () => {
    const hdc = emu.readArg(0);
    const ptsPtr = emu.readArg(1);
    const typesPtr = emu.readArg(2);
    const count = emu.readArg(3);
    const dc = emu.getDC(hdc);
    if (!dc || count === 0) return 0;
    const pen = emu.getPen(dc.selectedPen);
    dc.ctx.beginPath();
    dc.ctx.moveTo(dc.penPosX, dc.penPosY);
    for (let i = 0; i < count;) {
      const t = emu.memory.readU8(typesPtr + i);
      const base = t & 0x06;
      if (base === PT_LINETO) {
        const x = emu.memory.readI32(ptsPtr + i * 8);
        const y = emu.memory.readI32(ptsPtr + i * 8 + 4);
        dc.ctx.lineTo(x, y);
        if (t & PT_CLOSEFIGURE) dc.ctx.closePath();
        i++;
      } else if (base === PT_BEZIERTO && i + 2 < count) {
        const cx1 = emu.memory.readI32(ptsPtr + i * 8);
        const cy1 = emu.memory.readI32(ptsPtr + i * 8 + 4);
        const cx2 = emu.memory.readI32(ptsPtr + (i + 1) * 8);
        const cy2 = emu.memory.readI32(ptsPtr + (i + 1) * 8 + 4);
        const ex = emu.memory.readI32(ptsPtr + (i + 2) * 8);
        const ey = emu.memory.readI32(ptsPtr + (i + 2) * 8 + 4);
        dc.ctx.bezierCurveTo(cx1, cy1, cx2, cy2, ex, ey);
        if (emu.memory.readU8(typesPtr + i + 2) & PT_CLOSEFIGURE) dc.ctx.closePath();
        i += 3;
      } else {
        // PT_MOVETO or unknown — treat as moveTo
        const x = emu.memory.readI32(ptsPtr + i * 8);
        const y = emu.memory.readI32(ptsPtr + i * 8 + 4);
        dc.ctx.moveTo(x, y);
        i++;
      }
    }
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.strokeStyle = colorToCSS(pen.color);
      dc.ctx.lineWidth = Math.max(1, pen.width);
      dc.ctx.stroke();
    }
    if (count > 0) {
      dc.penPosX = emu.memory.readI32(ptsPtr + (count - 1) * 8);
      dc.penPosY = emu.memory.readI32(ptsPtr + (count - 1) * 8 + 4);
    }
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // FloodFill(hdc, x, y, color) — fill boundary
  gdi32.register('FloodFill', 4, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const color = emu.readArg(3);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const FLOODFILLBORDER = 0;
    floodFillImpl(dc, emu, x, y, color, FLOODFILLBORDER);
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // ExtFloodFill(hdc, x, y, color, fuFillType)
  const FLOODFILLBORDER = 0;
  // const FLOODFILLSURFACE = 1;
  gdi32.register('ExtFloodFill', 5, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const color = emu.readArg(3);
    const fuFillType = emu.readArg(4);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    floodFillImpl(dc, emu, x, y, color, fuFillType);
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // AngleArc(hdc, x, y, radius, startAngle, sweepAngle)
  gdi32.register('AngleArc', 6, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const radius = emu.readArg(3);
    // startAngle and sweepAngle are floats passed as 32-bit values on stack
    const f32buf = new Float32Array(new Uint32Array([emu.readArg(4), emu.readArg(5)]).buffer);
    const startDeg = f32buf[0];
    const sweepDeg = f32buf[1];
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const startRad = startDeg * Math.PI / 180;
    const sweepRad = sweepDeg * Math.PI / 180;
    // Line from current position to arc start
    const arcStartX = Math.round(x + radius * Math.cos(startRad));
    const arcStartY = Math.round(y - radius * Math.sin(startRad));
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.fillStyle = colorToCSS(pen.color);
      bresenhamLine(dc.ctx, dc.penPosX, dc.penPosY, arcStartX, arcStartY);
    }
    dc.ctx.beginPath();
    // Canvas arc is clockwise, GDI angle is counter-clockwise
    dc.ctx.arc(x, y, radius, -startRad, -(startRad + sweepRad), sweepDeg > 0);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.strokeStyle = colorToCSS(pen.color);
      dc.ctx.lineWidth = Math.max(1, pen.width);
      dc.ctx.stroke();
    }
    dc.penPosX = Math.round(x + radius * Math.cos(startRad + sweepRad));
    dc.penPosY = Math.round(y - radius * Math.sin(startRad + sweepRad));
    emu.syncDCToCanvas(hdc);
    return 1;
  });
}

/** Scanline-based flood fill implementation */
function floodFillImpl(
  dc: DCInfo, emu: Emulator,
  x: number, y: number, color: number, fuFillType: number,
): void {
  const canvas = dc.ctx.canvas || dc.canvas;
  if (!canvas) return;
  const w = canvas.width, h = canvas.height;
  // getImageData ignores canvas transforms — apply offset manually
  const tf = dc.ctx.getTransform();
  const oX = Math.round(tf.e), oY = Math.round(tf.f);
  const sx = x + oX, sy = y + oY;
  if (w <= 0 || h <= 0 || sx < 0 || sx >= w || sy < 0 || sy >= h) return;

  const imgData = dc.ctx.getImageData(0, 0, w, h);
  const px = imgData.data;

  const FLOODFILLBORDER = 0;
  // Target color from the reference COLORREF
  const tR = color & 0xFF, tG = (color >> 8) & 0xFF, tB = (color >> 16) & 0xFF;
  // Fill color from the DC's current brush
  const brush = emu.getBrush(dc.selectedBrush);
  if (!brush || brush.isNull) return;
  const fR = brush.color & 0xFF, fG = (brush.color >> 8) & 0xFF, fB = (brush.color >> 16) & 0xFF;

  const pixelAt = (px_: number, py: number) => {
    const off = (py * w + px_) * 4;
    return [px[off], px[off + 1], px[off + 2]] as const;
  };

  // Check if a pixel should be filled
  const shouldFill = (px_: number, py: number): boolean => {
    if (px_ < 0 || px_ >= w || py < 0 || py >= h) return false;
    const [r, g, b] = pixelAt(px_, py);
    if (fuFillType === FLOODFILLBORDER) {
      // Fill until we hit the border color
      if (r === tR && g === tG && b === tB) return false;
      // Don't re-fill already filled pixels
      if (r === fR && g === fG && b === fB) return false;
      return true;
    } else {
      // FLOODFILLSURFACE: fill while pixel matches the target color
      return r === tR && g === tG && b === tB;
    }
  };

  if (!shouldFill(sx, sy)) return;

  // Scanline flood fill with stack
  const stack: number[] = [sx, sy];
  const MAX_PIXELS = w * h;
  let filled = 0;

  while (stack.length > 0 && filled < MAX_PIXELS) {
    const cy = stack.pop()!;
    let cx = stack.pop()!;

    // Scan left
    while (cx > 0 && shouldFill(cx - 1, cy)) cx--;

    let spanAbove = false, spanBelow = false;

    // Scan right, filling pixels
    while (cx < w && shouldFill(cx, cy)) {
      const off = (cy * w + cx) * 4;
      px[off] = fR; px[off + 1] = fG; px[off + 2] = fB; px[off + 3] = 255;
      filled++;

      if (cy > 0) {
        if (shouldFill(cx, cy - 1)) {
          if (!spanAbove) { stack.push(cx, cy - 1); spanAbove = true; }
        } else { spanAbove = false; }
      }
      if (cy < h - 1) {
        if (shouldFill(cx, cy + 1)) {
          if (!spanBelow) { stack.push(cx, cy + 1); spanBelow = true; }
        } else { spanBelow = false; }
      }
      cx++;
    }
  }

  dc.ctx.putImageData(imgData, 0, 0);
}
