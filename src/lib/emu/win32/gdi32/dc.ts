import type { Emulator } from '../../emulator';
import type { DCInfo } from './types';
import type { WindowInfo } from '../user32/types';
import { OPAQUE, RGN_ERROR, SIMPLEREGION, COMPLEXREGION } from '../types';
import { disableSmoothing } from './_helpers';
import { getClientSize } from '../user32/_helpers';

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

  // SetMapMode(hdc, mode) → previous mode. Stub used to return MM_TEXT and
  // discard the requested mode, so apps that switched to MM_ISOTROPIC /
  // MM_TWIPS / etc. didn't see the change take effect (LPtoDP returned
  // identity even when they expected scaling).
  gdi32.register('SetMapMode', 2, () => {
    const hdc = emu.readArg(0);
    const mode = emu.readArg(1);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const old = dc.mapMode ?? MM_TEXT;
    dc.mapMode = mode;
    return old;
  });
  gdi32.register('GetMapMode', 1, () => {
    const hdc = emu.readArg(0);
    const dc = emu.getDC(hdc);
    return dc?.mapMode ?? MM_TEXT;
  });
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
  // Viewport / window origin setters used to be no-ops returning 1, and the
  // getters always returned (0,0). That made any app changing the transform
  // see "OK" but get garbage back from the read-back POINT — common in chart
  // and CAD code that pans by adjusting the viewport origin.
  gdi32.register('SetViewportOrgEx', 4, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const ptr = emu.readArg(3);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const oldX = dc.viewportOrgX ?? 0;
    const oldY = dc.viewportOrgY ?? 0;
    if (ptr) { emu.memory.writeI32(ptr, oldX); emu.memory.writeI32(ptr + 4, oldY); }
    dc.viewportOrgX = x; dc.viewportOrgY = y;
    return 1;
  });
  gdi32.register('SetWindowOrgEx', 4, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const ptr = emu.readArg(3);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const oldX = dc.windowOrgX ?? 0;
    const oldY = dc.windowOrgY ?? 0;
    if (ptr) { emu.memory.writeI32(ptr, oldX); emu.memory.writeI32(ptr + 4, oldY); }
    dc.windowOrgX = x; dc.windowOrgY = y;
    return 1;
  });
  gdi32.register('OffsetViewportOrgEx', 4, () => {
    const hdc = emu.readArg(0);
    const dx = emu.readArg(1) | 0;
    const dy = emu.readArg(2) | 0;
    const ptr = emu.readArg(3);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const oldX = dc.viewportOrgX ?? 0;
    const oldY = dc.viewportOrgY ?? 0;
    if (ptr) { emu.memory.writeI32(ptr, oldX); emu.memory.writeI32(ptr + 4, oldY); }
    dc.viewportOrgX = oldX + dx; dc.viewportOrgY = oldY + dy;
    return 1;
  });
  gdi32.register('OffsetWindowOrgEx', 4, () => {
    const hdc = emu.readArg(0);
    const dx = emu.readArg(1) | 0;
    const dy = emu.readArg(2) | 0;
    const ptr = emu.readArg(3);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const oldX = dc.windowOrgX ?? 0;
    const oldY = dc.windowOrgY ?? 0;
    if (ptr) { emu.memory.writeI32(ptr, oldX); emu.memory.writeI32(ptr + 4, oldY); }
    dc.windowOrgX = oldX + dx; dc.windowOrgY = oldY + dy;
    return 1;
  });

  gdi32.register('GetWindowOrgEx', 2, () => {
    const hdc = emu.readArg(0);
    const ptr = emu.readArg(1);
    const dc = emu.getDC(hdc);
    if (ptr) {
      emu.memory.writeI32(ptr,     dc?.windowOrgX ?? 0);
      emu.memory.writeI32(ptr + 4, dc?.windowOrgY ?? 0);
    }
    return 1;
  });

  gdi32.register('GetDCOrgEx', 2, () => {
    const ptr = emu.readArg(1);
    if (ptr) { emu.memory.writeU32(ptr, 0); emu.memory.writeU32(ptr + 4, 0); }
    return 1;
  });

  gdi32.register('GetCurrentPositionEx', 2, () => {
    const hdc = emu.readArg(0);
    const ptr = emu.readArg(1);
    const dc = emu.getDC(hdc);
    if (ptr) {
      emu.memory.writeI32(ptr,     dc?.penPosX ?? 0);
      emu.memory.writeI32(ptr + 4, dc?.penPosY ?? 0);
    }
    return 1;
  });

  gdi32.register('GetViewportOrgEx', 2, () => {
    const hdc = emu.readArg(0);
    const ptr = emu.readArg(1);
    const dc = emu.getDC(hdc);
    if (ptr) {
      emu.memory.writeI32(ptr,     dc?.viewportOrgX ?? 0);
      emu.memory.writeI32(ptr + 4, dc?.viewportOrgY ?? 0);
    }
    return 1;
  });

  gdi32.register('GetWindowExtEx', 2, () => {
    const hdc = emu.readArg(0);
    const ptr = emu.readArg(1);
    const dc = emu.getDC(hdc);
    if (ptr) {
      emu.memory.writeI32(ptr,     dc?.windowExtX ?? 1);
      emu.memory.writeI32(ptr + 4, dc?.windowExtY ?? 1);
    }
    return 1;
  });

  gdi32.register('GetViewportExtEx', 2, () => {
    const hdc = emu.readArg(0);
    const ptr = emu.readArg(1);
    const dc = emu.getDC(hdc);
    if (ptr) {
      emu.memory.writeI32(ptr,     dc?.viewportExtX ?? 1);
      emu.memory.writeI32(ptr + 4, dc?.viewportExtY ?? 1);
    }
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

  // ExcludeClipRect(hdc, l, t, r, b) — remove a rectangle from the clip
  // region. Canvas equivalent: intersect with (everything minus the rect) via
  // an evenodd clip. Apps rely on this to protect an area from subsequent
  // painting — e.g. MFC control bars exclude their client rect in OnNcPaint
  // before filling the whole window rect, so only the NC margin is painted;
  // as a no-op stub, that fill covered the embedded view (grey preview pane).
  gdi32.register('ExcludeClipRect', 5, () => {
    const hdc = emu.readArg(0);
    const left = emu.readArg(1) | 0;
    const top = emu.readArg(2) | 0;
    const right = emu.readArg(3) | 0;
    const bottom = emu.readArg(4) | 0;
    const dc = emu.getDC(hdc);
    if (!dc) return RGN_ERROR;
    if (right <= left || bottom <= top) return SIMPLEREGION; // empty rect: no change
    dc.ctx.beginPath();
    dc.ctx.rect(-1e7, -1e7, 2e7, 2e7);
    dc.ctx.rect(left, top, right - left, bottom - top);
    dc.ctx.clip('evenodd');
    return COMPLEXREGION;
  });
  gdi32.register('SelectClipPath', 2, () => 1);
  gdi32.register('OffsetClipRgn', 3, () => 1); // SIMPLEREGION
  gdi32.register('RectVisible', 2, () => 1); // visible
  gdi32.register('GetClipRgn', 2, () => 0);

  // Metafile stubs
  gdi32.register('CreateMetaFileW', 1, () => 0);
  gdi32.register('CloseMetaFile', 1, () => 0);
  gdi32.register('DeleteMetaFile', 1, () => 1);
  gdi32.register('SetWindowExtEx', 4, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const ptr = emu.readArg(3);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const oldX = dc.windowExtX ?? 1;
    const oldY = dc.windowExtY ?? 1;
    if (ptr) { emu.memory.writeI32(ptr, oldX); emu.memory.writeI32(ptr + 4, oldY); }
    dc.windowExtX = x; dc.windowExtY = y;
    return 1;
  });
  gdi32.register('SetViewportExtEx', 4, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const ptr = emu.readArg(3);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const oldX = dc.viewportExtX ?? 1;
    const oldY = dc.viewportExtY ?? 1;
    if (ptr) { emu.memory.writeI32(ptr, oldX); emu.memory.writeI32(ptr + 4, oldY); }
    dc.viewportExtX = x; dc.viewportExtY = y;
    return 1;
  });
  gdi32.register('ScaleViewportExtEx', 6, () => 1);
  gdi32.register('ScaleWindowExtEx', 6, () => 1);
  gdi32.register('SetColorAdjustment', 2, () => 1);

  // GetClipBox returns the tightest bounding rect of the DC's clip region, in
  // LOGICAL coords. We report the window's current update region (paintRect,
  // captured by BeginPaint) intersected with the client area, falling back to
  // the full client rect — NOT the whole screen. Returning the screen made apps
  // that size their painting from GetClipBox (MFC CScrollView views) repaint
  // the entire surface on every tiny invalidation, saturating the CPU.
  gdi32.register('GetClipBox', 2, () => {
    const hdc = emu.readArg(0);
    const rectPtr = emu.readArg(1);
    if (!rectPtr) return 1;
    const dc = emu.getDC(hdc);
    // Device-space clip rect: prefer the window's update region.
    let dl = 0, dt = 0, dr = emu.screenWidth, db = emu.screenHeight;
    const wnd = dc?.hwnd ? emu.handles.get<WindowInfo>(dc.hwnd) : null;
    if (wnd) {
      const cs = getClientSize(wnd.style, wnd.hMenu !== 0, wnd.width, wnd.height);
      dl = 0; dt = 0; dr = cs.cw; db = cs.ch;
      if (wnd.paintRect) {
        dl = wnd.paintRect.l; dt = wnd.paintRect.t;
        dr = wnd.paintRect.r; db = wnd.paintRect.b;
      }
    } else if (dc?.canvas) {
      dl = 0; dt = 0; dr = dc.canvas.width; db = dc.canvas.height;
    }
    // Device → logical via the DC's map-mode transform (inverse of LPtoDP):
    //   logical = (device - viewportOrg) * windowExt / viewportExt + windowOrg
    const vOx = dc?.viewportOrgX ?? 0, vOy = dc?.viewportOrgY ?? 0;
    const wOx = dc?.windowOrgX ?? 0, wOy = dc?.windowOrgY ?? 0;
    const wEx = dc?.windowExtX || 1, wEy = dc?.windowExtY || 1;
    const vEx = dc?.viewportExtX || 1, vEy = dc?.viewportExtY || 1;
    const toLogX = (x: number) => Math.round(((x - vOx) * wEx) / vEx + wOx);
    const toLogY = (y: number) => Math.round(((y - vOy) * wEy) / vEy + wOy);
    emu.memory.writeI32(rectPtr,      toLogX(dl));
    emu.memory.writeI32(rectPtr + 4,  toLogY(dt));
    emu.memory.writeI32(rectPtr + 8,  toLogX(dr));
    emu.memory.writeI32(rectPtr + 12, toLogY(db));
    return 1; // SIMPLEREGION
  });

  gdi32.register('PtVisible', 3, () => 1); // point is visible
  gdi32.register('Escape', 5, () => 0);    // not supported
}
