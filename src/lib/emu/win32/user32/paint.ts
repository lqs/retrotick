import type { Emulator } from '../../emulator';
import type { WindowInfo } from './types';
import { getClientSize } from './_helpers';
import { dcGetImageData, dcPutImageData } from '../../emu-window';
import {
  WM_PAINT, WM_ERASEBKGND, SIZEOF_PAINTSTRUCT, SYS_COLORS,
  COLOR_BTNFACE, COLOR_BTNHIGHLIGHT, COLOR_3DLIGHT, COLOR_BTNSHADOW, COLOR_3DDKSHADOW,
} from '../types';

const WS_VSCROLL = 0x00200000;
const WS_HSCROLL = 0x00100000;
const SBW = 16; // SM_CXVSCROLL / SM_CYHSCROLL

function cssOf(c: number): string {
  return `rgb(${c & 0xFF},${(c >> 8) & 0xFF},${(c >> 16) & 0xFF})`;
}

/**
 * Draw the non-client scroll bar(s) of a window onto its DC. The OS normally
 * paints these in the window frame; the emulator's DefWindowProc doesn't, so a
 * CScrollView (e.g. PabloDraw's editor) showed no scrollbar at all. Uses the
 * scroll range/page/pos mirrored onto the WindowInfo by scroll.ts.
 */
function drawNcScrollbars(emu: Emulator, hwnd: number): void {
  const wnd = emu.handles.get<WindowInfo>(hwnd);
  if (!wnd) return;
  // A CScrollView shows its scrollbars from the scroll range it sets via
  // SetScrollInfo, not necessarily the WS_VSCROLL style bit — so trigger on a
  // real scrollable range (range > page) OR the explicit style bit.
  const sv = wnd.scrollV, sh = wnd.scrollH;
  const hasV = !!sv && (sv.nMax - sv.nMin) > (sv.nPage | 0) && ((wnd.style & WS_VSCROLL) || sv.nPage > 0);
  const hasH = !!sh && (sh.nMax - sh.nMin) > (sh.nPage | 0) && ((wnd.style & WS_HSCROLL) || sh.nPage > 0);
  if (!hasV && !hasH) return;
  const hdc = emu.getWindowDC(hwnd);
  const dc = emu.getDC(hdc);
  if (!dc) return;
  const ctx = dc.ctx;
  const cs = getClientSize(wnd.style, wnd.hMenu !== 0, wnd.width, wnd.height);
  const face = cssOf(SYS_COLORS[COLOR_BTNFACE]);
  const hi = cssOf(SYS_COLORS[COLOR_BTNHIGHLIGHT]);
  const shd = cssOf(SYS_COLORS[COLOR_BTNSHADOW]);
  const dk = cssOf(SYS_COLORS[COLOR_3DDKSHADOW]);
  const trough = '#e8e8e8';

  const raised = (x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = face; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = hi; ctx.fillRect(x, y, w, 1); ctx.fillRect(x, y, 1, h);
    ctx.fillStyle = dk; ctx.fillRect(x, y + h - 1, w, 1); ctx.fillRect(x + w - 1, y, 1, h);
    ctx.fillStyle = shd; ctx.fillRect(x + 1, y + h - 2, w - 2, 1); ctx.fillRect(x + w - 2, y + 1, 1, h - 2);
  };
  const tri = (cx: number, cy: number, dir: 'up' | 'down') => {
    ctx.fillStyle = '#000';
    for (let i = 0; i < 4; i++) {
      const w = 1 + i * 2;
      const yy = dir === 'up' ? cy + i : cy - i;
      ctx.fillRect(cx - (w >> 1) - (w % 2 === 0 ? 0 : 0), yy, w, 1);
    }
  };

  const vBottom = cs.ch - (hasH ? SBW : 0);
  if (hasV) {
    const x = cs.cw - SBW;
    ctx.fillStyle = trough; ctx.fillRect(x, 0, SBW, vBottom);
    raised(x, 0, SBW, SBW);
    raised(x, vBottom - SBW, SBW, SBW);
    tri(x + (SBW >> 1) - 1, 5, 'up');
    tri(x + (SBW >> 1) - 1, vBottom - 7, 'down');
    const trackH = vBottom - 2 * SBW;
    if (trackH > 8 && sv) {
      const range = (sv.nMax - sv.nMin) || 1;
      const page = Math.max(1, sv.nPage | 0);
      const thumbH = Math.max(8, Math.min(trackH, Math.floor(trackH * page / range)));
      const denom = Math.max(1, range - page);
      const thumbY = SBW + Math.floor((trackH - thumbH) * (sv.nPos - sv.nMin) / denom);
      raised(x, thumbY, SBW, thumbH);
    }
  }
  if (hasH) {
    const y = cs.ch - SBW;
    const wRight = cs.cw - (hasV ? SBW : 0);
    ctx.fillStyle = trough; ctx.fillRect(0, y, wRight, SBW);
    raised(0, y, SBW, SBW);
    raised(wRight - SBW, y, SBW, SBW);
    const trackW = wRight - 2 * SBW;
    if (trackW > 8 && sh) {
      const range = (sh.nMax - sh.nMin) || 1;
      const page = Math.max(1, sh.nPage | 0);
      const thumbW = Math.max(8, Math.min(trackW, Math.floor(trackW * page / range)));
      const denom = Math.max(1, range - page);
      const thumbX = SBW + Math.floor((trackW - thumbW) * (sh.nPos - sh.nMin) / denom);
      raised(thumbX, y, thumbW, SBW);
    }
  }
  emu.syncDCToCanvas(hdc);
  // Balance the save/clip armed by getWindowDC on the shared canvas — leaving
  // it armed corrupts the save-stack ordering for the next window's DC arm.
  emu.releaseChildDC(hdc);
}

// MFC dock-bar control IDs.
const AFX_IDW_DOCKBAR_LEFT = 0xE81C;
const AFX_IDW_DOCKBAR_RIGHT = 0xE81D;

/**
 * Draw the gripper caption (title strip + close X) of a CSizingControlBarG-style
 * docked pane (e.g. PabloDraw's preview pane). Detected generically: the painted
 * window's grandparent is a LEFT/RIGHT (vertical) AfxControlBar dock bar. The OS
 * paints this NC chrome; the emulator's DefWindowProc doesn't, so the pane shows
 * with no title bar. Drawn on the FRAME's DC at the inner view's EndPaint so the
 * inner content doesn't paint over it.
 */
function drawControlBarCaption(emu: Emulator, innerHwnd: number): void {
  const inner = emu.handles.get<WindowInfo>(innerHwnd);
  if (!inner || !inner.parent) return;
  const frame = emu.handles.get<WindowInfo>(inner.parent);
  if (!frame || !frame.parent) return;
  const dock = emu.handles.get<WindowInfo>(frame.parent);
  if (!dock) return;
  const cid = dock.controlId ?? 0;
  if (cid !== AFX_IDW_DOCKBAR_LEFT && cid !== AFX_IDW_DOCKBAR_RIGHT) return;
  const fcn = (frame.classInfo?.className ?? '').toUpperCase();
  if (fcn.includes('TOOLBAR') || fcn.includes('REBAR')) return;

  const hdcCap = emu.getWindowDC(inner.parent);
  const dc = emu.getDC(hdcCap);
  if (!dc) return;
  const ctx = dc.ctx;
  const cs = getClientSize(frame.style, frame.hMenu !== 0, frame.width, frame.height);
  const w = cs.cw, capH = 13;
  const face = cssOf(SYS_COLORS[COLOR_BTNFACE]);
  const hi = cssOf(SYS_COLORS[COLOR_BTNHIGHLIGHT]);
  const shd = cssOf(SYS_COLORS[COLOR_BTNSHADOW]);
  // caption background
  ctx.fillStyle = face; ctx.fillRect(0, 0, w, capH);
  // two raised gripper lines on the left
  for (let i = 0; i < 2; i++) {
    const ly = 3 + i * 4;
    ctx.fillStyle = hi; ctx.fillRect(2, ly, w - 16, 1);
    ctx.fillStyle = shd; ctx.fillRect(2, ly + 1, w - 16, 1);
  }
  // close (X) button at top-right, raised
  const bs = 11, bx = w - bs - 1, by = 1;
  ctx.fillStyle = face; ctx.fillRect(bx, by, bs, bs);
  ctx.fillStyle = hi; ctx.fillRect(bx, by, bs, 1); ctx.fillRect(bx, by, 1, bs);
  ctx.fillStyle = shd; ctx.fillRect(bx, by + bs - 1, bs, 1); ctx.fillRect(bx + bs - 1, by, 1, bs);
  ctx.fillStyle = '#000';
  for (let i = 0; i < 5; i++) {
    ctx.fillRect(bx + 3 + i, by + 3 + i, 1, 1);
    ctx.fillRect(bx + 7 - i, by + 3 + i, 1, 1);
  }
  // bottom edge of the caption
  ctx.fillStyle = shd; ctx.fillRect(0, capH - 1, w, 1);
  emu.syncDCToCanvas(hdcCap);
  // Balance the save/clip armed by getWindowDC on the shared canvas.
  emu.releaseChildDC(hdcCap);
}

export function registerPaint(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  // DC operations
  user32.register('GetDC', 1, () => {
    const hwnd = emu.readArg(0);
    const dc = emu.getWindowDC(hwnd);
    return dc;
  });

  user32.register('GetDCEx', 3, () => {
    const hwnd = emu.readArg(0);
    const flags = emu.readArg(2);
    const DCX_WINDOW = 0x00000001;
    return emu.getWindowDC(hwnd, (flags & DCX_WINDOW) !== 0);
  });

  user32.register('GetWindowDC', 1, () => {
    const hwnd = emu.readArg(0);
    return emu.getWindowDC(hwnd, true);
  });

  user32.register('ReleaseDC', 2, () => {
    const hwnd = emu.readArg(0);
    const hdc = emu.readArg(1);
    emu.releaseChildDC(hdc);
    // WS_CLIPCHILDREN: repaint child windows that may have been painted over
    const WS_CLIPCHILDREN = 0x02000000;
    if (hwnd === emu.mainWindow || hwnd === 0) {
      const wnd = emu.handles.get<WindowInfo>(hwnd || emu.mainWindow);
      if (wnd && (wnd.style & WS_CLIPCHILDREN) && wnd.childList && wnd.childList.length > 0) {
        emu.repaintChildWindows(hwnd || emu.mainWindow);
      }
    }
    return 1;
  });

  user32.register('BeginPaint', 2, () => {
    const hwnd = emu.readArg(0);
    const psPtr = emu.readArg(1);
    const hdc = emu.beginPaint(hwnd);
    // Validate the region (clear needsPaint)
    const wndBP = emu.handles.get<WindowInfo>(hwnd);
    const hadErase = wndBP?.needsErase ?? false;
    // needsPaint/painting are now cleared/set in emu.beginPaint()

    // Fill PAINTSTRUCT
    emu.memory.writeU32(psPtr, hdc);       // hdc
    emu.memory.writeU32(psPtr + 4, hadErase ? 1 : 0); // fErase
    // rcPaint — the update region (intersected with the client area), so apps
    // that honor rcPaint/GetClipBox only repaint what changed. Capture the
    // accumulated invalid rect into paintRect for GetClipBox, then clear it.
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    const cs = wnd ? getClientSize(wnd.style, wnd.hMenu !== 0, wnd.width, wnd.height) : { cw: 0, ch: 0 };
    let pl = 0, pt = 0, pr = cs.cw, pb = cs.ch;
    if (wnd?.invalidRect) {
      pl = Math.max(0, wnd.invalidRect.l);
      pt = Math.max(0, wnd.invalidRect.t);
      pr = Math.min(cs.cw, wnd.invalidRect.r);
      pb = Math.min(cs.ch, wnd.invalidRect.b);
      if (pr < pl) pr = pl;
      if (pb < pt) pb = pt;
    }
    if (wnd) { wnd.paintRect = { l: pl, t: pt, r: pr, b: pb }; wnd.invalidRect = undefined; }
    emu.memory.writeU32(psPtr + 8, pl);    // left
    emu.memory.writeU32(psPtr + 12, pt);   // top
    emu.memory.writeU32(psPtr + 16, pr);   // right
    emu.memory.writeU32(psPtr + 20, pb);   // bottom
    emu.memory.writeU32(psPtr + 24, 0);    // fRestore
    emu.memory.writeU32(psPtr + 28, 0);    // fIncUpdate
    // rgbReserved (32 bytes of zero)
    for (let i = 32; i < SIZEOF_PAINTSTRUCT; i++) emu.memory.writeU8(psPtr + i, 0);

    return hdc;
  });

  user32.register('EndPaint', 2, () => {
    const hwnd = emu.readArg(0);
    const _psPtr = emu.readArg(1);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (wnd) wnd.paintRect = undefined;
    emu.endPaint(hwnd, 0);
    drawNcScrollbars(emu, hwnd);
    drawControlBarCaption(emu, hwnd);
    return 1;
  });

  user32.register('InvalidateRect', 3, () => {
    const hwnd = emu.readArg(0);
    const rectPtr = emu.readArg(1);
    const erase = emu.readArg(2);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (wnd && !wnd.painting) {
      // A repaint already pending with no tracked rect means a FULL repaint is
      // queued (needsPaint set on create/show/resize). Don't let a later
      // partial InvalidateRect shrink it — seed the accumulator with the full
      // client so the union stays full.
      const fullPending = wnd.needsPaint && !wnd.invalidRect;
      wnd.needsPaint = true;
      if (erase) wnd.needsErase = true;
      // Accumulate the invalid region. NULL rect = whole client area.
      const cs = getClientSize(wnd.style, wnd.hMenu !== 0, wnd.width, wnd.height);
      if (!rectPtr || fullPending) {
        wnd.invalidRect = { l: 0, t: 0, r: cs.cw, b: cs.ch };
      } else {
        let l = emu.memory.readI32(rectPtr);
        let t = emu.memory.readI32(rectPtr + 4);
        let r = emu.memory.readI32(rectPtr + 8);
        let b = emu.memory.readI32(rectPtr + 12);
        if (r < l) { const tmp = l; l = r; r = tmp; }
        if (b < t) { const tmp = t; t = b; b = tmp; }
        const prev = wnd.invalidRect;
        wnd.invalidRect = prev
          ? { l: Math.min(prev.l, l), t: Math.min(prev.t, t), r: Math.max(prev.r, r), b: Math.max(prev.b, b) }
          : { l, t, r, b };
      }
    }
    return 1;
  });

  user32.register('ValidateRect', 2, () => {
    const hwnd = emu.readArg(0);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (wnd) {
      wnd.needsPaint = false;
      wnd.needsErase = false;
      wnd._paintSynthesized = false;
      wnd.invalidRect = undefined;
    }
    return 1;
  });

  // FillRect (USER32, not GDI32)
  user32.register('FillRect', 3, () => {
    const hdc = emu.readArg(0);
    const rectPtr = emu.readArg(1);
    const hBrush = emu.readArg(2);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    const left = emu.memory.readI32(rectPtr);
    const top = emu.memory.readI32(rectPtr + 4);
    const right = emu.memory.readI32(rectPtr + 8);
    const bottom = emu.memory.readI32(rectPtr + 12);

    // FillRect supports system color index + 1 as hBrush (e.g. COLOR_BTNFACE+1 = 16)
    let color: number | null = null;
    if (hBrush > 0 && hBrush <= 30) {
      color = SYS_COLORS[hBrush - 1] ?? null;
    }
    if (color === null) {
      const brush = emu.getBrush(hBrush);
      if (brush && !brush.isNull) color = brush.color;
    }
    if (color !== null) {
      const r = color & 0xFF;
      const g = (color >> 8) & 0xFF;
      const b = (color >> 16) & 0xFF;
      dc.ctx.fillStyle = `rgb(${r},${g},${b})`;
      dc.ctx.fillRect(left, top, right - left, bottom - top);
      emu.syncDCToCanvas(hdc);
    }
    return 1;
  });

  user32.register('FrameRect', 3, () => {
    const hdc = emu.readArg(0);
    const rectPtr = emu.readArg(1);
    const hBrush = emu.readArg(2);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    const left = emu.memory.readI32(rectPtr);
    const top = emu.memory.readI32(rectPtr + 4);
    const right = emu.memory.readI32(rectPtr + 8);
    const bottom = emu.memory.readI32(rectPtr + 12);

    const brush = emu.getBrush(hBrush);
    if (brush && !brush.isNull) {
      const r = brush.color & 0xFF;
      const g = (brush.color >> 8) & 0xFF;
      const b = (brush.color >> 16) & 0xFF;
      dc.ctx.strokeStyle = `rgb(${r},${g},${b})`;
      dc.ctx.lineWidth = 1;
      dc.ctx.strokeRect(left + 0.5, top + 0.5, right - left - 1, bottom - top - 1);
      emu.syncDCToCanvas(hdc);
    }
    return 1;
  });

  user32.register('InvertRect', 2, () => {
    const hdc = emu.readArg(0);
    const rectPtr = emu.readArg(1);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    const left = emu.memory.readI32(rectPtr);
    const top = emu.memory.readI32(rectPtr + 4);
    const right = emu.memory.readI32(rectPtr + 8);
    const bottom = emu.memory.readI32(rectPtr + 12);

    const w = right - left, h = bottom - top;
    if (w > 0 && h > 0) {
      // Use transform-aware read/write: child-window DCs carry a canvas
      // translate (the window's position on the shared canvas). Raw
      // getImageData/putImageData ignore it, so the inverted rect (e.g. the
      // text cursor caret) landed at the main canvas origin instead of inside
      // the child window.
      const imgData = dcGetImageData(dc, left, top, w, h);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 255 - d[i]; d[i+1] = 255 - d[i+1]; d[i+2] = 255 - d[i+2];
      }
      dcPutImageData(dc, imgData, left, top);
      emu.syncDCToCanvas(hdc);
    }
    return 1;
  });

  user32.register('DrawEdge', 4, () => {
    const hdc = emu.readArg(0);
    const rectPtr = emu.readArg(1);
    const edgeType = emu.readArg(2);
    const grfFlags = emu.readArg(3);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    let left = emu.memory.readI32(rectPtr);
    let top = emu.memory.readI32(rectPtr + 4);
    let right = emu.memory.readI32(rectPtr + 8);
    let bottom = emu.memory.readI32(rectPtr + 12);

    const ctx = dc.ctx;

    // BDR flags
    const BDR_RAISEDOUTER = 0x0001;
    const BDR_SUNKENOUTER = 0x0002;
    const BDR_RAISEDINNER = 0x0004;
    const BDR_SUNKENINNER = 0x0008;
    // BF flags
    const BF_LEFT   = 0x0001;
    const BF_TOP    = 0x0002;
    const BF_RIGHT  = 0x0004;
    const BF_BOTTOM = 0x0008;
    const BF_ADJUST = 0x2000;

    const sysColor = (idx: number) => {
      const c = SYS_COLORS[idx] ?? 0;
      return `rgb(${c & 0xFF},${(c >> 8) & 0xFF},${(c >> 16) & 0xFF})`;
    };

    // Determine outer and inner colors based on edge type
    // Outer edge
    let outerTL: string | null = null; // top-left color
    let outerBR: string | null = null; // bottom-right color
    if (edgeType & BDR_RAISEDOUTER) {
      outerTL = sysColor(COLOR_3DLIGHT);
      outerBR = sysColor(COLOR_3DDKSHADOW);
    } else if (edgeType & BDR_SUNKENOUTER) {
      outerTL = sysColor(COLOR_3DDKSHADOW);
      outerBR = sysColor(COLOR_3DLIGHT);
    }

    // Inner edge
    let innerTL: string | null = null;
    let innerBR: string | null = null;
    if (edgeType & BDR_RAISEDINNER) {
      innerTL = sysColor(COLOR_BTNHIGHLIGHT);
      innerBR = sysColor(COLOR_BTNSHADOW);
    } else if (edgeType & BDR_SUNKENINNER) {
      innerTL = sysColor(COLOR_BTNSHADOW);
      innerBR = sysColor(COLOR_BTNHIGHLIGHT);
    }

    // Draw outer edge
    if (outerTL && outerBR) {
      if (grfFlags & BF_TOP) { ctx.fillStyle = outerTL; ctx.fillRect(left, top, right - left, 1); }
      if (grfFlags & BF_LEFT) { ctx.fillStyle = outerTL; ctx.fillRect(left, top, 1, bottom - top); }
      if (grfFlags & BF_BOTTOM) { ctx.fillStyle = outerBR; ctx.fillRect(left, bottom - 1, right - left, 1); }
      if (grfFlags & BF_RIGHT) { ctx.fillStyle = outerBR; ctx.fillRect(right - 1, top, 1, bottom - top); }
      if (grfFlags & BF_TOP) top++;
      if (grfFlags & BF_LEFT) left++;
      if (grfFlags & BF_BOTTOM) bottom--;
      if (grfFlags & BF_RIGHT) right--;
    }

    // Draw inner edge
    if (innerTL && innerBR) {
      if (grfFlags & BF_TOP) { ctx.fillStyle = innerTL; ctx.fillRect(left, top, right - left, 1); }
      if (grfFlags & BF_LEFT) { ctx.fillStyle = innerTL; ctx.fillRect(left, top, 1, bottom - top); }
      if (grfFlags & BF_BOTTOM) { ctx.fillStyle = innerBR; ctx.fillRect(left, bottom - 1, right - left, 1); }
      if (grfFlags & BF_RIGHT) { ctx.fillStyle = innerBR; ctx.fillRect(right - 1, top, 1, bottom - top); }
      if (grfFlags & BF_TOP) top++;
      if (grfFlags & BF_LEFT) left++;
      if (grfFlags & BF_BOTTOM) bottom--;
      if (grfFlags & BF_RIGHT) right--;
    }

    // BF_ADJUST: write back the adjusted rect
    if (grfFlags & BF_ADJUST) {
      emu.memory.writeU32(rectPtr, left);
      emu.memory.writeU32(rectPtr + 4, top);
      emu.memory.writeU32(rectPtr + 8, right);
      emu.memory.writeU32(rectPtr + 12, bottom);
    }

    emu.syncDCToCanvas(hdc);
    return 1;
  });

  user32.register('DrawFrameControl', 4, () => 1);
  // DrawFocusRect(hdc, lprc) — draw the dotted XOR-style focus rectangle. Was
  // a no-op stub; default-button highlighting and listbox focus indicators
  // never appeared on canvas controls.
  user32.register('DrawFocusRect', 2, () => {
    const hdc = emu.readArg(0);
    const rectPtr = emu.readArg(1);
    const dc = emu.getDC(hdc);
    if (!dc || !rectPtr) return 0;
    const left = emu.memory.readI32(rectPtr);
    const top = emu.memory.readI32(rectPtr + 4);
    const right = emu.memory.readI32(rectPtr + 8);
    const bottom = emu.memory.readI32(rectPtr + 12);
    dc.ctx.save();
    dc.ctx.strokeStyle = '#000';
    dc.ctx.lineWidth = 1;
    dc.ctx.setLineDash([1, 1]);
    // strokeRect at .5 offset keeps the 1-pixel line crisp on canvas.
    dc.ctx.strokeRect(left + 0.5, top + 0.5, right - left - 1, bottom - top - 1);
    dc.ctx.restore();
    emu.syncDCToCanvas(hdc);
    return 1;
  });
  user32.register('DrawIcon', 4, () => 1);

  // DrawIconEx(hdc, xLeft, yTop, hIcon, cxWidth, cyWidth, istepIfAniCur, hbrFlickerFreeDraw, diFlags)
  user32.register('DrawIconEx', 9, () => 1);
  user32.register('DrawAnimatedRects', 4, () => 1);

  user32.register('CreateCursor', 7, () => emu.handles.alloc('cursor', {}));

  // GetUpdateRect(hWnd, lpRect, bErase) → BOOL
  user32.register('GetUpdateRect', 3, () => {
    const _hwnd = emu.readArg(0);
    const rectPtr = emu.readArg(1);
    if (rectPtr) {
      emu.memory.writeU32(rectPtr, 0);
      emu.memory.writeU32(rectPtr + 4, 0);
      emu.memory.writeU32(rectPtr + 8, 0);
      emu.memory.writeU32(rectPtr + 12, 0);
    }
    return 0; // no update region
  });

  user32.register('RedrawWindow', 4, () => {
    const hwnd = emu.readArg(0);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    // RedrawWindow without RDW_INVALIDATE-of-a-rect invalidates the whole
    // window; clear any partial region so the next paint is a full repaint.
    if (wnd) { wnd.needsPaint = true; wnd.needsErase = true; wnd.invalidRect = undefined; }
    return 1;
  });

  // ScrollWindowEx(hWnd, dx, dy, prcScroll, prcClip, hrgnUpdate, prcUpdate, flags) → int
  // Return SIMPLEREGION (1)
  user32.register('ScrollWindowEx', 8, () => 1);

  // InvalidateRgn(hWnd, hRgn, bErase) → BOOL
  user32.register('InvalidateRgn', 3, () => {
    const hwnd = emu.readArg(0);
    const _hrgnUpdate = emu.readArg(1);
    const bErase = emu.readArg(2);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (wnd && !wnd.painting) {
      wnd.needsPaint = true;
      if (bErase) wnd.needsErase = true;
    }
    return 1;
  });
}
