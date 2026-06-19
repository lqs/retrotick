import type { Emulator } from '../../emulator';
import type { DCInfo } from './types';
import type { BitmapInfo } from './types';
import { OPAQUE } from '../types';
import { disableSmoothing } from './_helpers';

export function registerDC(emu: Emulator): void {
  const gdi32 = emu.registerDll('GDI32.DLL');

  gdi32.register('CreateCompatibleDC', 1, () => {
    const _hdcRef = emu.readArg(0);
    // Create an OffscreenCanvas with initial 1x1 size
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d')!;
    disableSmoothing(ctx);
    // Allocate a default 1x1 monochrome bitmap (Windows compat DCs always have one)
    const defBmpCanvas = new OffscreenCanvas(1, 1);
    const defBmp = emu.handles.alloc('bitmap', {
      width: 1, height: 1, canvas: defBmpCanvas,
      ctx: defBmpCanvas.getContext('2d')!, monochrome: true,
    });
    const dc: DCInfo = {
      canvas, ctx, hwnd: 0,
      selectedBitmap: defBmp, selectedPen: 0, selectedBrush: 0, selectedFont: 0, selectedPalette: 0,
      textColor: 0, bkColor: 0xFFFFFF, bkMode: OPAQUE,
      penPosX: 0, penPosY: 0, rop2: 13,
    };
    return emu.handles.alloc('dc', dc);
  });

  gdi32.register('DeleteDC', 1, () => {
    const hdc = emu.readArg(0);
    // In Windows, drawing into a memory DC writes directly into the selected
    // bitmap (shared storage). Our DC keeps a working copy, so flush it back
    // to the bitmap before destroying the DC — the app may re-select the
    // bitmap into another DC later and expects the drawn content to persist.
    const dc = emu.handles.get<DCInfo>(hdc);
    if (dc && dc.selectedBitmap && dc.canvas !== emu.canvas) {
      const bmp = emu.handles.get<BitmapInfo>(dc.selectedBitmap);
      if (bmp && bmp.canvas && bmp.width === dc.canvas.width && bmp.height === dc.canvas.height) {
        bmp.ctx.drawImage(dc.canvas, 0, 0);
      }
    }
    emu.handles.free(hdc);
    return 1;
  });

  gdi32.register('SaveDC', 1, () => {
    const hdc = emu.readArg(0);
    const dc = emu.getDC(hdc);
    if (dc) dc.ctx.save();
    return 1;
  });

  gdi32.register('RestoreDC', 2, () => {
    const hdc = emu.readArg(0);
    const dc = emu.getDC(hdc);
    if (dc) dc.ctx.restore();
    return 1;
  });

  // CreateIC — information context (like CreateDC but read-only)
  gdi32.register('CreateICW', 4, () => {
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d')!;
    disableSmoothing(ctx);
    const dc: DCInfo = {
      canvas, ctx, hwnd: 0,
      selectedBitmap: 0, selectedPen: 0, selectedBrush: 0, selectedFont: 0, selectedPalette: 0,
      textColor: 0, bkColor: 0xFFFFFF, bkMode: OPAQUE,
      penPosX: 0, penPosY: 0, rop2: 13,
    };
    return emu.handles.alloc('dc', dc);
  });
  gdi32.register('CreateICA', 4, () => {
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d')!;
    disableSmoothing(ctx);
    const dc: DCInfo = {
      canvas, ctx, hwnd: 0,
      selectedBitmap: 0, selectedPen: 0, selectedBrush: 0, selectedFont: 0, selectedPalette: 0,
      textColor: 0, bkColor: 0xFFFFFF, bkMode: OPAQUE,
      penPosX: 0, penPosY: 0, rop2: 13,
    };
    return emu.handles.alloc('dc', dc);
  });

  gdi32.register('GetDeviceCaps', 2, () => {
    const _hdc = emu.readArg(0);
    const index = emu.readArg(1);
    // TECHNOLOGY=2, HORZSIZE=4, VERTSIZE=6, HORZRES=8, VERTRES=10
    // BITSPIXEL=12, PLANES=14, NUMCOLORS=24, RASTERCAPS=38
    // LOGPIXELSX=88, LOGPIXELSY=90, SIZEPALETTE=104, COLORRES=108
    if (index === 2) return 1;    // DT_RASDISPLAY
    if (index === 4) return 320;  // HORZSIZE (mm)
    if (index === 6) return 240;  // VERTSIZE (mm)
    if (index === 8) return emu.screenWidth;  // HORZRES
    if (index === 10) return emu.screenHeight; // VERTRES
    if (index === 12) return 32;  // BITSPIXEL
    if (index === 14) return 1;   // PLANES
    if (index === 24) return -1;  // NUMCOLORS (true color)
    if (index === 38) return 0x7E99; // RASTERCAPS (RC_BITBLT|RC_STRETCHBLT|RC_DI_BITMAP|etc)
    if (index === 88 || index === 90) return 96; // LOGPIXELSX/Y
    if (index === 104) return 0;  // SIZEPALETTE
    if (index === 108) return 24; // COLORRES
    return 0;
  });

  const MM_TEXT = 1;
  const R2_COPYPEN = 13;

  gdi32.register('SetMapMode', 2, () => MM_TEXT);
  gdi32.register('GetMapMode', 1, () => MM_TEXT);
  gdi32.register('GetROP2', 1, () => R2_COPYPEN);
  gdi32.register('SetROP2', 2, () => {
    const hdc = emu.readArg(0);
    const mode = emu.readArg(1);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const old = dc.rop2;
    dc.rop2 = mode;
    return old;
  });
  gdi32.register('GetLayout', 1, () => 0); // LTR layout
  gdi32.register('SetLayout', 2, () => 0);
  gdi32.register('SetViewportOrgEx', 4, () => 1);
  gdi32.register('SetWindowOrgEx', 4, () => 1);
  gdi32.register('OffsetViewportOrgEx', 4, () => 1);
  gdi32.register('OffsetWindowOrgEx', 4, () => 1);

  gdi32.register('GetWindowOrgEx', 2, () => {
    const ptr = emu.readArg(1);
    if (ptr) { emu.memory.writeU32(ptr, 0); emu.memory.writeU32(ptr + 4, 0); }
    return 1;
  });

  gdi32.register('GetDCOrgEx', 2, () => {
    const ptr = emu.readArg(1);
    if (ptr) { emu.memory.writeU32(ptr, 0); emu.memory.writeU32(ptr + 4, 0); }
    return 1;
  });

  gdi32.register('GetCurrentPositionEx', 2, () => {
    const ptr = emu.readArg(1);
    if (ptr) { emu.memory.writeU32(ptr, 0); emu.memory.writeU32(ptr + 4, 0); }
    return 1;
  });

  gdi32.register('GetViewportOrgEx', 2, () => {
    const ptr = emu.readArg(1);
    if (ptr) { emu.memory.writeU32(ptr, 0); emu.memory.writeU32(ptr + 4, 0); }
    return 1;
  });

  gdi32.register('GetWindowExtEx', 2, () => {
    const ptr = emu.readArg(1);
    if (ptr) { emu.memory.writeU32(ptr, 1); emu.memory.writeU32(ptr + 4, 1); }
    return 1;
  });

  gdi32.register('GetViewportExtEx', 2, () => {
    const ptr = emu.readArg(1);
    if (ptr) { emu.memory.writeU32(ptr, 1); emu.memory.writeU32(ptr + 4, 1); }
    return 1;
  });

  gdi32.register('IntersectClipRect', 5, () => {
    const hdc = emu.readArg(0);
    const left = emu.readArg(1) | 0;
    const top = emu.readArg(2) | 0;
    const right = emu.readArg(3) | 0;
    const bottom = emu.readArg(4) | 0;
    const dc = emu.getDC(hdc);
    if (dc) {
      dc.ctx.beginPath();
      dc.ctx.rect(left, top, right - left, bottom - top);
      dc.ctx.clip();
    }
    return 1; // SIMPLEREGION
  });

  gdi32.register('SelectClipRgn', 2, () => 1);
  gdi32.register('ExtSelectClipRgn', 3, () => 1); // SIMPLEREGION
  gdi32.register('ExcludeClipRect', 5, () => 1); // SIMPLEREGION
  gdi32.register('SelectClipPath', 2, () => 1);
  gdi32.register('OffsetClipRgn', 3, () => 1); // SIMPLEREGION
  gdi32.register('RectVisible', 2, () => 1); // visible
  gdi32.register('GetClipRgn', 2, () => 0);

  // Metafile stubs
  gdi32.register('CreateMetaFileW', 1, () => 0);
  gdi32.register('CloseMetaFile', 1, () => 0);
  gdi32.register('DeleteMetaFile', 1, () => 1);
  gdi32.register('SetWindowExtEx', 4, () => 1);
  gdi32.register('SetViewportExtEx', 4, () => 1);
  gdi32.register('ScaleViewportExtEx', 6, () => 1);
  gdi32.register('ScaleWindowExtEx', 6, () => 1);
  gdi32.register('SetColorAdjustment', 2, () => 1);

  gdi32.register('GetClipBox', 2, () => {
    const _hdc = emu.readArg(0);
    const rectPtr = emu.readArg(1);
    if (rectPtr) {
      emu.memory.writeU32(rectPtr, 0);     // left
      emu.memory.writeU32(rectPtr + 4, 0); // top
      emu.memory.writeU32(rectPtr + 8, emu.screenWidth);  // right
      emu.memory.writeU32(rectPtr + 12, emu.screenHeight); // bottom
    }
    return 1; // SIMPLEREGION
  });

  gdi32.register('PtVisible', 3, () => 1); // point is visible
  gdi32.register('Escape', 5, () => 0);    // not supported
}
