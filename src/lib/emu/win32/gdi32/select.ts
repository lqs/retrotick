import type { Emulator } from '../../emulator';
import type { DCInfo, BitmapInfo, PenInfo, BrushInfo } from './types';
import {
  WHITE_BRUSH, LTGRAY_BRUSH, GRAY_BRUSH, DKGRAY_BRUSH, BLACK_BRUSH, NULL_BRUSH,
  WHITE_PEN, BLACK_PEN, NULL_PEN,
  OEM_FIXED_FONT, DEFAULT_GUI_FONT,
  PS_SOLID, PS_NULL,
} from '../types';
import { STOCK_BASE } from './_helpers';

export function registerSelect(emu: Emulator): void {
  const gdi32 = emu.registerDll('GDI32.DLL');

  // Pre-create stock objects
  const stockBrushes: Record<number, BrushInfo> = {
    [WHITE_BRUSH]: { color: 0xFFFFFF, isNull: false },
    [LTGRAY_BRUSH]: { color: 0xC8D0D4, isNull: false },
    [GRAY_BRUSH]: { color: 0x808080, isNull: false },
    [DKGRAY_BRUSH]: { color: 0x404040, isNull: false },
    [BLACK_BRUSH]: { color: 0x000000, isNull: false },
    [NULL_BRUSH]: { color: 0, isNull: true },
  };

  const stockPens: Record<number, PenInfo> = {
    [WHITE_PEN]: { style: PS_SOLID, width: 1, color: 0xFFFFFF },
    [BLACK_PEN]: { style: PS_SOLID, width: 1, color: 0x000000 },
    [NULL_PEN]: { style: PS_NULL, width: 0, color: 0 },
  };

  gdi32.register('SelectObject', 2, () => {
    const hdc = emu.readArg(0);
    const hObj = emu.readArg(1);
    const dc = emu.handles.get<DCInfo>(hdc);
    if (!dc) return 0;

    const objType = emu.handles.getType(hObj);
    const stockIdx = hObj >= STOCK_BASE ? hObj - STOCK_BASE : -1;

    if (objType === 'bitmap' || stockIdx === -1 && !objType) {
      const bmp = emu.handles.get<BitmapInfo>(hObj);
      if (bmp && bmp.width && bmp.height && bmp.canvas) {
        // In Windows, bitmaps can only be selected into memory (compat) DCs, not window DCs
        if (dc.canvas === emu.canvas) return 0;
        const old = dc.selectedBitmap;
        // Sync DC canvas content back to the old bitmap before deselecting
        if (old) {
          const oldBmp = emu.handles.get<BitmapInfo>(old);
          if (oldBmp && oldBmp.canvas && dc.canvas.width > 0 && dc.canvas.height > 0) {
            oldBmp.canvas.width = dc.canvas.width;
            oldBmp.canvas.height = dc.canvas.height;
            const oldCtx = oldBmp.canvas.getContext('2d')!;
            oldCtx.drawImage(dc.canvas, 0, 0);
            oldBmp.ctx = oldCtx;
          }
        }
        dc.selectedBitmap = hObj;
        dc.selectedBitmapResId = bmp.resourceId;
        dc.selectedBitmapResModule = bmp.resourceModule;
        dc.canvas.width = bmp.width;
        dc.canvas.height = bmp.height;
        // Draw the bitmap content onto the DC
        dc.ctx = (dc.canvas as OffscreenCanvas).getContext('2d')!;
        dc.ctx.imageSmoothingEnabled = false;
        dc.ctx.drawImage(bmp.canvas, 0, 0);
        return old;
      }
    }

    if (objType === 'pen' || (stockIdx >= 0 && stockPens[stockIdx])) {
      const old = dc.selectedPen;
      dc.selectedPen = hObj;
      return old;
    }

    if (objType === 'brush' || (stockIdx >= 0 && stockBrushes[stockIdx])) {
      const old = dc.selectedBrush;
      dc.selectedBrush = hObj;
      return old;
    }

    if (objType === 'font' || (stockIdx >= 0 && (stockIdx >= OEM_FIXED_FONT && stockIdx <= DEFAULT_GUI_FONT))) {
      const old = dc.selectedFont;
      dc.selectedFont = hObj;
      return old;
    }

    return 0;
  });

  gdi32.register('GetStockObject', 1, () => {
    const idx = emu.readArg(0);
    return STOCK_BASE + idx;
  });

  gdi32.register('DeleteObject', 1, () => {
    const hObj = emu.readArg(0);
    if (hObj >= STOCK_BASE) return 1; // don't delete stock objects
    emu.handles.free(hObj);
    return 1;
  });

  gdi32.register('UnrealizeObject', 1, () => 1);

  // Helper for stock object lookup
  emu.getStockBrush = (idx: number) => stockBrushes[idx] || null;
  emu.getStockPen = (idx: number) => stockPens[idx] || null;

  // OBJ_PEN=1, OBJ_BRUSH=2, OBJ_DC=3, OBJ_FONT=6, OBJ_BITMAP=7
  gdi32.register('GetCurrentObject', 2, () => {
    const hdc = emu.readArg(0);
    const objType = emu.readArg(1);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    if (objType === 1) return dc.selectedPen || 0;
    if (objType === 2) return dc.selectedBrush || 0;
    if (objType === 6) return dc.selectedFont || 0;
    if (objType === 7) return dc.selectedBitmap || 0;
    return 0;
  });
}
