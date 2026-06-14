import type { Emulator } from './emulator';
import type { DCInfo, BitmapInfo, BrushInfo, PenInfo } from './win32/gdi32/index';
import type { WindowInfo } from './win32/user32/index';
import { OPAQUE, SYS_COLORS, COLOR_BTNFACE, WM_NCPAINT } from './win32/types';
import { decodeDib } from '../pe/decode-dib';
import { rvaToFileOffset } from '../pe/read';
import { renderChildControls } from './emu-render';
import { getClientSize, clientSizeOf, getNonClientMetrics } from './win32/user32/_helpers';
import { emuFindResourceEntryForModule } from './emu-load';

// WM_ERASEBKGND — dispatched from beginPaint so apps that override OnEraseBkgnd run.
const WM_ERASEBKGND = 0x0014;
// WM_SETFOCUS — delivered on main-window promotion (activation gives focus).
const WM_SETFOCUS = 0x0007;

// Track DCs that have canvas state saved (child window translate)
const childDCSet = new Set<number>();
// Track DCs that have WS_CLIPCHILDREN state saved
const clipChildrenDCSet = new Set<number>();

// A special thunk for SEH handler dispatch return
const SEH_DISPATCH_RETURN_THUNK = 0x00FE0004;

export function getDC(emu: Emulator, hdc: number): DCInfo | null {
  return emu.handles.get<DCInfo>(hdc);
}

export function promoteToMainWindow(emu: Emulator, hwnd: number, wnd: WindowInfo): void {
  const prevMain = emu.mainWindow;
  emu.mainWindow = hwnd;
  console.log(`[WND] Main window promoted to 0x${hwnd.toString(16)} class="${wnd.classInfo.className}" title="${wnd.title}" (prev=0x${prevMain.toString(16)})`);

  // Clear the old cached DC for this hwnd so getWindowDC will create a new one with the real canvas
  const oldDC = emu.windowDCs.get(hwnd);
  if (oldDC) {
    emu.handles.free(oldDC);
    emu.windowDCs.delete(hwnd);
  }

  // Resize canvas
  if (emu.canvas && wnd.width > 0 && wnd.height > 0) {
    // Use client area dimensions
    const { cw, ch } = getClientSize(wnd.style, !!wnd.hMenu, wnd.width, wnd.height, emu.isNE);
    setupCanvasSize(emu, cw, ch);

    // Fill canvas with background color: dialogs use COLOR_BTNFACE, others use class brush
    if (emu.canvasCtx) {
      const isDialog = wnd.classInfo.className === '#32770' || !!wnd.dlgProc;
      let bgColor: number | null = null;
      if (isDialog) {
        bgColor = SYS_COLORS[COLOR_BTNFACE];
      } else if (wnd.classInfo.hbrBackground) {
        const brush = getBrush(emu, wnd.classInfo.hbrBackground);
        if (brush && !brush.isNull) bgColor = brush.color;
      }
      if (bgColor !== null) {
        const r = bgColor & 0xFF, g = (bgColor >> 8) & 0xFF, b = (bgColor >> 16) & 0xFF;
        emu.canvasCtx.fillStyle = `rgb(${r},${g},${b})`;
        emu.canvasCtx.fillRect(0, 0, cw, ch);
      }
    }
  }

  // Activation gives the new top-level window keyboard focus (real Windows
  // sends WM_SETFOCUS as part of activating it). Deliver via the queue so the
  // app handles it in its message loop — MFC's CFrameWnd::OnSetFocus then
  // forwards focus to its active view via SetFocus, which records the real
  // focus target (emu.focusedWindow) used to route keyboard input.
  if (emu.focusedWindow !== hwnd) {
    emu.focusedWindow = hwnd;
    if (wnd.wndProc) emu.postMessage(hwnd, WM_SETFOCUS, 0, 0);
  }

  emu.onWindowChange?.(wnd);
}

export function setupCanvasSize(emu: Emulator, cw: number, ch: number): void {
  if (!emu.canvas) return;
  // Preserve existing content across resize (canvas.width= clears it)
  const oldW = emu.canvas.width;
  const oldH = emu.canvas.height;
  let saved: ImageData | null = null;
  if (oldW > 0 && oldH > 0 && emu.canvasCtx) {
    try { saved = emu.canvasCtx.getImageData(0, 0, oldW, oldH); } catch {}
  }
  emu.canvas.width = cw;
  emu.canvas.height = ch;
  if (emu.canvas.style) {
    emu.canvas.style.width = `${cw}px`;
    emu.canvas.style.height = `${ch}px`;
  }
  emu.canvasCtx = emu.canvas.getContext('2d')!;
  emu.canvasCtx.imageSmoothingEnabled = false;
  // Restore preserved content (new area stays transparent → DOM background shows through)
  if (saved) {
    emu.canvasCtx.putImageData(saved, 0, 0);
  }
  // Update existing cached DC to use the new context (don't free — programs may cache the handle)
  const oldDC = emu.windowDCs.get(emu.mainWindow);
  if (oldDC) {
    const dc = emu.handles.get<DCInfo>(oldDC);
    if (dc) {
      dc.canvas = emu.canvas;
      dc.ctx = emu.canvasCtx;
    }
  }
}

// Check if hwnd is a descendant of the main window
function isDescendantOfMain(emu: Emulator, hwnd: number): boolean {
  let cur = emu.handles.get<WindowInfo>(hwnd);
  while (cur && cur.parent) {
    if (cur.parent === emu.mainWindow) return true;
    cur = emu.handles.get<WindowInfo>(cur.parent);
  }
  return false;
}

// Calculate screen-space origin relative to main window's client area
function getWindowOrigin(emu: Emulator, hwnd: number): { x: number; y: number } {
  let x = 0, y = 0;
  let cur = emu.handles.get<WindowInfo>(hwnd);
  while (cur && cur.hwnd !== emu.mainWindow) {
    x += cur.x || 0;
    y += cur.y || 0;
    if (!cur.parent) break;
    const parent = emu.handles.get<WindowInfo>(cur.parent);
    // Add non-client offset for parents with caption/frame (e.g. MDI children)
    // Child windows are positioned relative to the parent's client area, so we need
    // to offset by the parent's non-client area (border + caption)
    if (parent && parent.hwnd !== emu.mainWindow) {
      if (parent.ncInset) {
        // The parent reserved a custom non-client area via WM_NCCALCSIZE
        // (e.g. a control bar's gripper/edges); its client origin is inset by it.
        x += parent.ncInset.l;
        y += parent.ncInset.t;
      } else {
        const { bw, captionH } = getNonClientMetrics(parent.style, !!parent.hMenu, emu.isNE);
        x += bw;
        y += bw + captionH;
      }
    }
    cur = parent;
  }
  return { x, y };
}

/**
 * Clip out the canvas rects of visible windows ABOVE this one in z-order
 * (later siblings in each ancestor's childList) — the shared-canvas
 * equivalent of Windows compositing. Without this, two overlapping sibling
 * windows each repaint their full rect at independent times (caret blinks,
 * partial invalidations) and the overlap pixels alternate between the two
 * painters, which shows up as flicker along the boundary.
 * Coordinates are local to the window: the caller has already set the DC
 * transform so local (0,0) maps to canvas (origin.x, origin.y + ccsYOffset).
 */
function clipUpperSiblings(
  emu: Emulator,
  hwnd: number,
  wnd: WindowInfo,
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  origin: { x: number; y: number },
  ccsYOffset: number,
): void {
  const excl: { x: number; y: number; w: number; h: number }[] = [];
  // A sibling's children may stick out of the sibling's own rect (e.g. MFC
  // sizing control bars created at (-2,-2) inside their dock bar), so exclude
  // the visible DESCENDANT rects too, not just the sibling rect itself.
  const pushWithDescendants = (h: number, depth: number): void => {
    const w = emu.handles.get<WindowInfo>(h);
    if (!w || !w.visible || depth > 8) return;
    if (w.width > 0 && w.height > 0) {
      const o = getWindowOrigin(emu, h);
      excl.push({ x: o.x, y: o.y, w: w.width, h: w.height });
    }
    if (w.childList) {
      for (const ch of w.childList) pushWithDescendants(ch, depth + 1);
    }
  };
  let cur = hwnd;
  let guard = 0;
  while (cur && cur !== emu.mainWindow && guard++ < 32) {
    const w = emu.handles.get<WindowInfo>(cur);
    if (!w || !w.parent) break;
    const p = emu.handles.get<WindowInfo>(w.parent);
    if (p?.childList) {
      const idx = p.childList.indexOf(cur);
      if (idx >= 0) {
        for (let i = idx + 1; i < p.childList.length; i++) {
          pushWithDescendants(p.childList[i], 0);
        }
      }
    }
    cur = w.parent;
  }
  if (excl.length === 0) return;
  // Subtract each upper-window rect with its OWN evenodd clip (intersection of
  // successive clips = window minus the UNION of the rects). A single evenodd
  // path breaks when exclusion rects overlap each other — e.g. a dock pane and
  // its same-sized inner view both excluded: the doubly-covered region flips
  // even→odd→even and becomes paintable again, letting a lower window's
  // scrollbar bleed through (the editor/preview boundary flicker).
  const seen = new Set<string>();
  for (const r of excl) {
    const key = `${r.x},${r.y},${r.w},${r.h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lx = r.x - origin.x;
    const ly = r.y - origin.y - ccsYOffset;
    ctx.beginPath();
    ctx.rect(-1e7, -1e7, 2e7, 2e7);
    ctx.rect(lx, ly, r.w, r.h);
    ctx.clip('evenodd');
  }
}

/**
 * DC drawing area for a window: client-relative DCs of a window with a custom
 * NC margin (ncInset) are offset to the client origin and sized to the client;
 * everything else uses the window origin/size (client == window for plain
 * children, and window-relative DCs always cover the full window).
 */
function dcArea(emu: Emulator, wnd: WindowInfo, origin: { x: number; y: number }, windowRelative: boolean) {
  if (!windowRelative && wnd.ncInset) {
    const { cw, ch } = clientSizeOf(wnd);
    return { x: origin.x + wnd.ncInset.l, y: origin.y + wnd.ncInset.t, w: cw, h: ch };
  }
  return { x: origin.x, y: origin.y, w: wnd.width, h: wnd.height };
}

/**
 * On real Windows, GetDC/BeginPaint DCs are CLIENT-relative; only GetWindowDC
 * is window-relative. The two origins coincide except for windows whose own
 * WM_NCCALCSIZE reserves a custom NC margin (wnd.ncInset) — for those, the
 * client DC must be offset by the inset and clipped to the client area, or the
 * app's client painting lands on (and erases) its own NC margin.
 * `windowRelative` selects GetWindowDC semantics (origin at the window
 * top-left, clip to the full window rect).
 */
export function getWindowDC(emu: Emulator, hwnd: number, windowRelative = false): number {
  const wnd = emu.handles.get<WindowInfo>(hwnd);

  // Window-relative DC on the MAIN window. Its non-client band (caption +
  // menu) is rendered by the DOM shell, not the canvas — the canvas covers
  // the client area only. Real GetWindowDC has its origin at the WINDOW
  // corner, so app drawing aimed at the NC band (e.g. FreeCell's
  // "Cards Left" counter painted next to its menu) must NOT land on the
  // client canvas shifted down by the NC height. When the UI provides an NC
  // overlay canvas (positioned over the menu bar), draw there; otherwise use
  // the main canvas with the window origin so NC-band coordinates clip out.
  if (windowRelative && wnd && hwnd === emu.mainWindow && emu.canvasCtx) {
    // The menu can come from the window (hMenu) or from the class
    // (lpszMenuName) — both reserve an SM_CYMENU band in the NC area.
    const hasMenu = !!wnd.hMenu || !!wnd.classInfo?.menuName;
    const { bw, captionH, menuH } = getNonClientMetrics(wnd.style, hasMenu, emu.isNE);
    let hdcNc = (emu as any)._ncWindowDC as number | undefined;
    let dc = hdcNc ? emu.handles.get<DCInfo>(hdcNc) : null;
    if (!dc) {
      dc = {
        canvas: emu.canvas!, ctx: emu.canvasCtx, hwnd,
        selectedBitmap: 0,
        selectedPen: emu.isNE ? 0x8007 : 0x80000007,    // BLACK_PEN
        selectedBrush: emu.isNE ? 0x8000 : 0x80000000,  // WHITE_BRUSH
        selectedFont: 0, selectedPalette: 0,
        textColor: 0, bkColor: 0xFFFFFF, bkMode: OPAQUE,
        penPosX: 0, penPosY: 0, rop2: 13,
      };
      hdcNc = emu.handles.alloc('dc', dc);
      (emu as any)._ncWindowDC = hdcNc;
    }
    if (emu.ncCanvas) {
      // Dedicated overlay canvas over the menu bar; its top-left is the
      // window's (bw, bw+captionH). Own context → a plain transform, no
      // save/clip arming needed (ReleaseDC's releaseChildDC is a no-op).
      if (emu.ncCanvas.width !== wnd.width) emu.ncCanvas.width = wnd.width;
      dc.canvas = emu.ncCanvas;
      dc.ctx = emu.ncCanvas.getContext('2d')!;
      dc.ctx.imageSmoothingEnabled = false;
      dc.ctx.setTransform(1, 0, 0, 1, -bw, -(bw + captionH));
    } else {
      // Shared client canvas: arm save+transform (window origin) so client-
      // area drawing through a window DC still lands correctly and NC-band
      // drawing clips out; balanced by ReleaseDC → releaseChildDC.
      if (childDCSet.has(hdcNc!)) releaseChildDC(emu, hdcNc!);
      dc.canvas = emu.canvas!;
      dc.ctx = emu.canvasCtx;
      dc.ctx.save();
      dc.ctx.setTransform(1, 0, 0, 1, -bw, -(bw + captionH + menuH));
      childDCSet.add(hdcNc!);
    }
    return hdcNc!;
  }
  const isDescendant = wnd && hwnd !== emu.mainWindow && isDescendantOfMain(emu, hwnd);
  // Visible popup windows (not main, not descendant) also draw on the main canvas
  const isPopup = wnd && hwnd !== emu.mainWindow && !isDescendant && wnd.visible && emu.canvas && emu.canvasCtx;
  // If the child has a per-control DOM canvas (companion canvas), draw directly to it (no translate)
  const hasDomCanvas = wnd?.domCanvas != null;
  const needsTranslate = !hasDomCanvas && (isDescendant || isPopup);

  const existing = emu.windowDCs.get(hwnd);
  if (existing && !needsTranslate && !hasDomCanvas) return existing;

  // For child windows sharing the main canvas, reuse existing DC (preserving
  // app-set attributes like textColor, selectedBrush) but refresh the canvas
  // state (save/transform/clip) which must be balanced per GetDC/ReleaseDC.
  if (existing && needsTranslate && wnd) {
    if (childDCSet.has(existing)) {
      releaseChildDC(emu, existing);
    }
    const dc = getDC(emu, existing);
    if (dc) {
      const origin = isPopup ? { x: wnd.x || 0, y: wnd.y || 0 } : getWindowOrigin(emu, hwnd);
      let ccsYOffset = 0;
      const internalH = (wnd as any)._ccsInternalHeight;
      if (internalH && internalH > wnd.height) {
        ccsYOffset = Math.round((internalH - wnd.height) / 2);
      }
      const a = dcArea(emu, wnd, origin, windowRelative);
      dc.ctx.save();
      dc.ctx.setTransform(1, 0, 0, 1, a.x, a.y + ccsYOffset);
      dc.ctx.beginPath();
      dc.ctx.rect(0, -ccsYOffset, a.w, a.h);
      dc.ctx.clip();
      if (!isPopup) clipUpperSiblings(emu, hwnd, wnd, dc.ctx, a, ccsYOffset);
      childDCSet.add(existing);
      return existing;
    }
  }

  // Free old DC for domCanvas windows
  if (existing && hasDomCanvas) {
    if (childDCSet.has(existing)) {
      releaseChildDC(emu, existing);
    }
    emu.handles.free(existing);
    emu.windowDCs.delete(hwnd);
  }

  if (!wnd && hwnd !== 0) return 0;

  let canvas: HTMLCanvasElement | OffscreenCanvas;
  let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

  // Main window, descendants, and visible popups draw on the real canvas
  if (hwnd === emu.mainWindow || hwnd === 0) {
    canvas = emu.canvas!;
    ctx = emu.canvasCtx!;
  } else if (hasDomCanvas) {
    // Per-control companion canvas — draw directly (no translate needed)
    canvas = wnd!.domCanvas!;
    ctx = wnd!.domCanvas!.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
  } else if (needsTranslate) {
    canvas = emu.canvas!;
    ctx = emu.canvasCtx!;
  } else {
    const w = wnd ? Math.max(1, wnd.width | 0) : 1;
    const h = wnd ? Math.max(1, wnd.height | 0) : 1;
    const oc = new OffscreenCanvas(w, h);
    canvas = oc;
    ctx = oc.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
  }

  const dc: DCInfo = {
    canvas, ctx, hwnd,
    selectedBitmap: 0,
    selectedPen: emu.isNE ? 0x8007 : 0x80000007,    // BLACK_PEN
    selectedBrush: emu.isNE ? 0x8000 : 0x80000000,  // WHITE_BRUSH
    selectedFont: 0, selectedPalette: 0,
    textColor: 0, bkColor: 0xFFFFFF, bkMode: OPAQUE,
    penPosX: 0, penPosY: 0, rop2: 13,
  };
  const hdc = emu.handles.alloc('dc', dc);
  emu.windowDCs.set(hwnd, hdc);
  // For windows sharing the main canvas, apply coordinate offset and clip
  if (needsTranslate && wnd) {
    const origin = isPopup ? { x: wnd.x || 0, y: wnd.y || 0 } : getWindowOrigin(emu, hwnd);
    let ccsYOffset = 0;
    const internalH = (wnd as any)._ccsInternalHeight;
    if (internalH && internalH > wnd.height) {
      ccsYOffset = Math.round((internalH - wnd.height) / 2);
    }
    const a = dcArea(emu, wnd, origin, windowRelative);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, a.x, a.y + ccsYOffset);
    ctx.beginPath();
    ctx.rect(0, -ccsYOffset, a.w, a.h);
    ctx.clip();
    if (!isPopup) clipUpperSiblings(emu, hwnd, wnd, ctx, a, ccsYOffset);
    // Fill CCS toolbar background — the DC is shifted down so the top strip
    // would otherwise show the canvas background color instead of BTNFACE.
    if (ccsYOffset > 0) {
      const bf = SYS_COLORS[COLOR_BTNFACE];
      ctx.fillStyle = `rgb(${bf & 0xFF},${(bf >> 8) & 0xFF},${(bf >> 16) & 0xFF})`;
      ctx.fillRect(0, -ccsYOffset, wnd.width, wnd.height);
    }
    childDCSet.add(hdc);
  }
  return hdc;
}

const WS_CLIPCHILDREN = 0x02000000;

function applyClipChildren(emu: Emulator, hwnd: number, wnd: WindowInfo | null, hdc: number): void {
  // Any window with WS_CLIPCHILDREN (not just the main window): a parent must
  // never erase/paint over its children's rects — e.g. an MFC sizing control
  // bar's BTNFACE erase would grey out the docked view inside it.
  if (!wnd || !(wnd.style & WS_CLIPCHILDREN) || !wnd.childList) return;
  const dc = getDC(emu, hdc);
  if (!dc) return;

  // Collect visible child rects (coords are parent-client-relative — the same
  // local space the DC transform maps for both the main window and children).
  const childRects: { x: number; y: number; w: number; h: number }[] = [];
  for (const childHwnd of wnd.childList) {
    const child = emu.handles.get<WindowInfo>(childHwnd);
    if (!child || !child.visible || child.width <= 0 || child.height <= 0) continue;
    childRects.push({ x: child.x, y: child.y, w: child.width, h: child.height });
  }
  if (childRects.length === 0) return;

  dc.ctx.save();
  clipChildrenDCSet.add(hdc);

  // Subtract each child rect with its OWN evenodd clip (successive clips
  // intersect = full area minus the UNION of child rects). One combined
  // evenodd path breaks when child rects overlap each other: the doubly
  // covered region flips back to paintable.
  const seen = new Set<string>();
  for (const r of childRects) {
    const key = `${r.x},${r.y},${r.w},${r.h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dc.ctx.beginPath();
    dc.ctx.rect(-1e7, -1e7, 2e7, 2e7);
    dc.ctx.rect(r.x, r.y, r.w, r.h);
    dc.ctx.clip('evenodd');
  }
}

/**
 * Paint the custom NC margin (ncInset) of a window: fill it with the class
 * background (BTNFACE fallback) on a window-relative DC, then send WM_NCPAINT
 * so the app draws its own NC chrome (e.g. CSizingControlBar edges/gripper).
 * Real BeginPaint sends WM_NCPAINT when the update region includes the frame;
 * without this the margin reserved by WM_NCCALCSIZE keeps stale pixels.
 */
function paintNcMargin(emu: Emulator, hwnd: number, wnd: WindowInfo): void {
  const inset = wnd.ncInset!;
  const hdc = getWindowDC(emu, hwnd, true);
  const dc = getDC(emu, hdc);
  if (dc) {
    let bg = SYS_COLORS[COLOR_BTNFACE];
    const brush = wnd.classInfo.hbrBackground ? getBrush(emu, wnd.classInfo.hbrBackground) : null;
    if (brush && !brush.isNull) bg = brush.color;
    dc.ctx.fillStyle = `rgb(${bg & 0xFF},${(bg >> 8) & 0xFF},${(bg >> 16) & 0xFF})`;
    const w = wnd.width, h = wnd.height;
    if (inset.t > 0) dc.ctx.fillRect(0, 0, w, inset.t);
    if (inset.b > 0) dc.ctx.fillRect(0, h - inset.b, w, inset.b);
    if (inset.l > 0) dc.ctx.fillRect(0, 0, inset.l, h);
    if (inset.r > 0) dc.ctx.fillRect(w - inset.r, 0, inset.r, h);
  }
  releaseChildDC(emu, hdc);
  if (wnd.wndProc && !(emu as any)._inNcPaint) {
    (emu as any)._inNcPaint = true;
    try {
      emu.callWndProc(wnd.wndProc, hwnd, WM_NCPAINT, 1, 0);
    } catch {
      // An NC paint handler fault must not abort the paint cycle.
    } finally {
      (emu as any)._inNcPaint = false;
    }
  }
}

export function beginPaint(emu: Emulator, hwnd: number): number {
  // A custom NC margin repaints with the window (sent before the client paint
  // DC is armed, so the app's WM_NCPAINT GetWindowDC/ReleaseDC stays balanced).
  const wndNc = emu.handles.get<WindowInfo>(hwnd);
  if (wndNc?.ncInset && wndNc.needsErase) paintNcMargin(emu, hwnd, wndNc);
  const hdc = getWindowDC(emu, hwnd);
  // Validate the region — clear needsPaint to prevent infinite WM_PAINT loop
  const wnd = emu.handles.get<WindowInfo>(hwnd);
  // Capture the erase request before clearing it: real BeginPaint sends
  // WM_ERASEBKGND only when the update region was invalidated with bErase=TRUE.
  const hadErase = wnd?.needsErase ?? false;
  if (wnd) { wnd.needsPaint = false; wnd.needsErase = false; wnd._paintSynthesized = false; wnd.painting = true; }
  // Signal to DispatchMessage that BeginPaint was called (so it doesn't duplicate overlay notifications)
  emu._dispatchPaintUsedBeginPaint = true;

  // Apply WS_CLIPCHILDREN: clip out visible child windows on main window DC
  // Must be applied before erase so child areas are protected
  applyClipChildren(emu, hwnd, wnd, hdc);

  // Erase background: for dialogs, use COLOR_BTNFACE (WM_CTLCOLORDLG default);
  // for regular windows, use the class brush. Real BeginPaint erases ONLY when
  // the update region was invalidated with bErase=TRUE, and only the update
  // region itself — a partial bErase=FALSE invalidation (e.g. a caret-blink
  // cell) must NOT wipe the rest of the window, or content drawn during
  // WM_ERASEBKGND (custom guides, grids) flickers at every blink tick.
  if (wnd && hadErase) {
    const dc = getDC(emu, hdc);
    if (dc) {
      const isDialog = wnd.classInfo.className === '#32770' || !!wnd.dlgProc;
      let bgColor: number | null = null;
      if (isDialog) {
        bgColor = SYS_COLORS[COLOR_BTNFACE];
      } else if (wnd.classInfo.hbrBackground) {
        const brush = getBrush(emu, wnd.classInfo.hbrBackground);
        if (brush && !brush.isNull) bgColor = brush.color;
      }
      if (bgColor !== null) {
        const r = bgColor & 0xFF, g = (bgColor >> 8) & 0xFF, b = (bgColor >> 16) & 0xFF;
        // Clip the erase to the accumulated invalid rect (still intact here —
        // the BeginPaint API handler consumes it into paintRect afterwards).
        let el = 0, et = 0, er = wnd.width, eb = wnd.height;
        const ir = wnd.invalidRect;
        if (ir) {
          el = Math.max(0, ir.l); et = Math.max(0, ir.t);
          er = Math.min(wnd.width, ir.r); eb = Math.min(wnd.height, ir.b);
          if (er < el) er = el;
          if (eb < et) eb = et;
        }
        dc.ctx.fillStyle = `rgb(${r},${g},${b})`;
        dc.ctx.fillRect(el, et, er - el, eb - et);
      }
    }

    // Dispatch WM_ERASEBKGND to the window procedure, exactly as the real
    // BeginPaint does when the update region needs erasing. This lets apps that
    // OVERRIDE OnEraseBkgnd run their custom code (custom backgrounds, grid /
    // column-guide overlays drawn with a PS_DOT pen, etc.). Windows that don't
    // override fall through to DefWindowProc, which fills the class brush — so
    // the direct fill above is redundant-but-harmless for them and a safe
    // fallback for built-in (wndProc-less) and dialog windows. Guarded by
    // _inEraseBkgnd so a handler that itself paints can't recurse here, and
    // gated on hadErase so the cursor-blink partial repaints (invalidated with
    // bErase=FALSE) don't re-run a full erase every tick.
    const isDialog = wnd.classInfo.className === '#32770' || !!wnd.dlgProc;
    if (hadErase && wnd.wndProc && !isDialog && !emu._inEraseBkgnd) {
      emu._inEraseBkgnd = true;
      try {
        emu.callWndProc(wnd.wndProc, hwnd, WM_ERASEBKGND, hdc, 0);
      } catch {
        // An erase handler fault must not abort the paint cycle.
      } finally {
        emu._inEraseBkgnd = false;
      }
    }
  }

  return hdc;
}

export function endPaint(emu: Emulator, hwnd: number, _hdc: number): void {
  const wnd = emu.handles.get<WindowInfo>(hwnd);

  // Restore WS_CLIPCHILDREN clip before rendering children
  const hdc = emu.windowDCs.get(hwnd);
  if (hdc && clipChildrenDCSet.has(hdc)) {
    const dc = getDC(emu, hdc);
    if (dc) dc.ctx.restore();
    clipChildrenDCSet.delete(hdc);
  }
  // Restore canvas state for child windows
  if (hdc) releaseChildDC(emu, hdc);

  // After paint completes, render child controls on top
  renderChildControls(emu, hwnd);
  // Clear painting flag
  if (wnd) wnd.painting = false;

  // After the main window paints, mark all visible popup windows for repaint
  // so they draw on top of the main window's content
  if (hwnd === emu.mainWindow) {
    for (const [h, w] of emu.handles.findByType('window') as [number, WindowInfo][]) {
      if (w && w.visible && h !== emu.mainWindow && !isDescendantOfMain(emu, h) && w.wndProc) {
        w.needsPaint = true;
      }
    }
  }
}

export function releaseChildDC(emu: Emulator, hdc: number): void {
  if (childDCSet.has(hdc)) {
    const dc = getDC(emu, hdc);
    if (dc) {
      // Like Wine's reset_dc_state: pop ALL saves made via SaveDC on this DC,
      // then pop the one from getWindowDC (translate+clip).
      // The x86 code may call SaveDC without matching RestoreDC — Windows
      // automatically discards all saved states when the DC is released.
      const extraSaves = dc.saveLevel || 0;
      for (let i = 0; i < extraSaves; i++) dc.ctx.restore();
      dc.saveLevel = 0;
      // Pop the getWindowDC's own save (translate + clip)
      dc.ctx.restore();
    }
    childDCSet.delete(hdc);
  }
}

/**
 * Read destination pixels at transform-aware canvas coordinates.
 * getImageData ignores canvas transforms, so we manually apply the offset.
 */
export function dcGetImageData(dc: DCInfo, x: number, y: number, w: number, h: number): ImageData {
  const tf = dc.ctx.getTransform();
  const cx = Math.round(tf.e + x * tf.a);
  const cy = Math.round(tf.f + y * tf.d);
  return dc.ctx.getImageData(cx, cy, w, h);
}

/**
 * Write pixels via temp canvas + drawImage to respect transform + clip.
 * putImageData ignores both canvas transform and clip region;
 * drawImage respects both.
 */
export function dcPutImageData(dc: DCInfo, imgData: ImageData, x: number, y: number): void {
  const tmp = new OffscreenCanvas(imgData.width, imgData.height);
  tmp.getContext('2d')!.putImageData(imgData, 0, 0);
  dc.ctx.drawImage(tmp, x, y);
}

export function syncDCToCanvas(emu: Emulator, _hdc: number): void {
  // Window DCs draw directly to the main canvas — nothing to sync
  // Memory DCs are OffscreenCanvas which need explicit BitBlt
  // Mark screen as dirty so tick() can yield for browser rendering
  emu.screenDirty = true;
}

// Dispatch to the next SEH handler in the chain
export function dispatchToSehHandler(emu: Emulator, frameAddr: number): void {
  const handler = emu.memory.readU32((frameAddr + 4) >>> 0);
  const state = emu._sehState!;
  state.currentReg = frameAddr;

  console.log(`[SEH] Dispatching to handler at 0x${handler.toString(16)} frame=0x${frameAddr.toString(16)}`);

  // Set up cdecl call: push args right-to-left, then return address
  emu.cpu.push32(state.dispCtxAddr);   // arg3: DispatcherContext
  emu.cpu.push32(state.ctxAddr);       // arg2: ContextRecord
  emu.cpu.push32(frameAddr);           // arg1: EstablisherFrame
  emu.cpu.push32(state.excRecAddr);    // arg0: ExceptionRecord
  emu.cpu.push32(SEH_DISPATCH_RETURN_THUNK); // return address
  emu.cpu.eip = handler;
}

// Handle the return from an SEH exception handler
export function handleSehDispatchReturn(emu: Emulator): number | undefined {
  const disposition = emu.cpu.reg[0] >>> 0; // EAX = EXCEPTION_DISPOSITION

  // Clean up the 4 cdecl args left on the stack (handler did `ret`, popping only return address)
  emu.cpu.reg[4] = (emu.cpu.reg[4] + 16) | 0;

  console.log(`[SEH] Handler returned disposition=${disposition} (0=ContinueExecution, 1=ContinueSearch)`);

  if (disposition === 0) {
    // ExceptionContinueExecution — restore context and resume
    if (emu._sehState) {
      const ctx = emu._sehState.ctxAddr;
      emu.cpu.reg[7] = emu.memory.readU32(ctx + 0x9C);  // EDI
      emu.cpu.reg[6] = emu.memory.readU32(ctx + 0xA0);  // ESI
      emu.cpu.reg[3] = emu.memory.readU32(ctx + 0xA4);  // EBX
      emu.cpu.reg[2] = emu.memory.readU32(ctx + 0xA8);  // EDX
      emu.cpu.reg[1] = emu.memory.readU32(ctx + 0xAC);  // ECX
      emu.cpu.reg[0] = emu.memory.readU32(ctx + 0xB0);  // EAX
      emu.cpu.reg[5] = emu.memory.readU32(ctx + 0xB4);  // EBP
      emu.cpu.eip = emu.memory.readU32(ctx + 0xB8);      // EIP
      emu.cpu.reg[4] = emu.memory.readU32(ctx + 0xC4);  // ESP
      emu.cpu.setFlags(emu.memory.readU32(ctx + 0xC0));  // EFLAGS
      console.log(`[SEH] ContinueExecution: resuming at EIP=0x${(emu.cpu.eip >>> 0).toString(16)}`);
    }
    emu._sehState = null;
    return undefined;
  }

  if (disposition === 1) {
    // ExceptionContinueSearch — try the next handler in the chain
    if (emu._sehState) {
      const currentFrame = emu._sehState.currentReg;
      const prevFrame = emu.memory.readU32(currentFrame >>> 0);

      if (prevFrame === 0xFFFFFFFF || prevFrame === 0) {
        console.error('[SEH] Unhandled exception — no more handlers in chain');
        emu.haltReason = emu.haltReason || 'unhandled exception';
        emu.halted = true;
        emu._sehState = null;
        return undefined;
      }

      // Dispatch to next handler
      dispatchToSehHandler(emu, prevFrame);
      return undefined;
    }
  }

  // Unknown disposition or no SEH state
  console.error(`[SEH] Unexpected disposition: ${disposition}`);
  emu.haltReason = emu.haltReason || 'unhandled exception';
  emu.halted = true;
  emu._sehState = null;
  return undefined;
}

export function getBrush(emu: Emulator, handle: number): BrushInfo | null {
  if (handle >= 0x80000000) {
    return emu.getStockBrush(handle - 0x80000000);
  }
  // Win16 stock objects use 0x8000+idx
  if (emu.isNE && handle >= 0x8000 && handle < 0x8100) {
    return emu.getStockBrush(handle - 0x8000);
  }
  // System color index + 1 (used by hbrBackground in WNDCLASS, values 1-30)
  if (handle > 0 && handle <= 30) {
    const color = SYS_COLORS[handle - 1] ?? SYS_COLORS[COLOR_BTNFACE];
    return { color, style: 0, isNull: false };
  }
  return emu.handles.get<BrushInfo>(handle);
}

export function getPen(emu: Emulator, handle: number): PenInfo | null {
  if (handle >= 0x80000000) {
    return emu.getStockPen(handle - 0x80000000);
  }
  // Win16 stock objects use 0x8000+idx
  if (emu.isNE && handle >= 0x8000 && handle < 0x8100) {
    return emu.getStockPen(handle - 0x8000);
  }
  return emu.handles.get<PenInfo>(handle);
}

export function loadBitmapResource(emu: Emulator, resourceId: number): number {
  // Check cache (verify handle still valid — app may have called DeleteObject)
  const cached = emu.bitmapCache.get(resourceId);
  if (cached) {
    if (emu.handles.get(cached)) return cached;
    emu.bitmapCache.delete(resourceId);
  }

  // NE (16-bit) path: look up in NE resource table (exe first, then DLLs)
  if (emu.isNE && emu.ne) {
    // Search exe resources
    let entry = emu.ne.resources.find(r => r.typeID === 2 && r.id === resourceId);
    let srcBuf = emu.arrayBuffer;
    // If not found in exe, search loaded NE DLLs
    if (!entry) {
      for (const dllInfo of emu.neDllResources) {
        entry = dllInfo.resources.find(r => r.typeID === 2 && r.id === resourceId);
        if (entry) { srcBuf = dllInfo.arrayBuffer; break; }
      }
    }
    if (!entry) return 0;
    try {
      const dibData = new Uint8Array(srcBuf, entry.fileOffset, entry.length);
      const { canvas, ctx, imageData, width, height } = decodeDib(dibData);
      const bmp: BitmapInfo = { width, height, canvas, ctx, imageData, resourceId };
      const hBitmap = emu.handles.alloc('bitmap', bmp);
      emu.bitmapCache.set(resourceId, hBitmap);
      // console.log(`[NE] Loaded bitmap resource ${resourceId}: ${width}x${height} → handle ${hBitmap}`);
      return hBitmap;
    } catch (e: unknown) {
      console.warn(`Failed to load NE bitmap resource ${resourceId}: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    }
  }

  if (!emu.peInfo.resources) return 0;
  const bitmapType = emu.peInfo.resources.find(r => r.typeId === 2);
  if (!bitmapType) return 0;

  const entry = bitmapType.entries.find(e => e.id === resourceId);
  if (!entry || entry.languages.length === 0) return 0;

  const lang = entry.languages[0];
  try {
    let fileOffset: number;
    try {
      fileOffset = rvaToFileOffset(lang.dataRva, emu.peInfo.sections);
    } catch {
      fileOffset = lang.dataRva;
    }
    const dibData = new Uint8Array(emu.arrayBuffer, fileOffset, lang.dataSize);
    const { canvas, ctx, imageData, width, height } = decodeDib(dibData);

    const bmp: BitmapInfo = { width, height, canvas, ctx, imageData, resourceId };
    const hBitmap = emu.handles.alloc('bitmap', bmp);
    emu.bitmapCache.set(resourceId, hBitmap);
    return hBitmap;
  } catch (e: unknown) {
    console.warn(`Failed to load bitmap resource ${resourceId}: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

export function loadIconResource(emu: Emulator, resourceId: number): number {
  const ab = emu.arrayBuffer ?? emu._arrayBuffer;
  if (!emu.peInfo?.resources || !ab) return 0;
  const isNE = emu.peInfo.isNE;
  const RT_GROUP_ICON = 14, RT_ICON = 3;
  const groupType = emu.peInfo.resources.find(r => r.typeId === RT_GROUP_ICON);
  const iconType = emu.peInfo.resources.find(r => r.typeId === RT_ICON);
  if (!groupType || !iconType) return 0;

  const ge = groupType.entries.find(e => e.id === resourceId);
  if (!ge || ge.languages.length === 0) return 0;

  let dataUrl: string | undefined;
  let iconW = 32, iconH = 32;
  try {
    const lang = ge.languages[0];
    const fileOff = isNE ? lang.dataRva : rvaToFileOffset(lang.dataRva, emu.peInfo.sections);
    const dv = new DataView(ab, fileOff, lang.dataSize);
    const idCount = dv.getUint16(4, true);
    const iconEntries: { nID: number; grpOff: number; dataSize: number }[] = [];
    for (let i = 0; i < idCount; i++) {
      const off = 6 + i * 14;
      const dwBytes = dv.getUint32(off + 8, true);
      const nID = dv.getUint16(off + 12, true);
      iconEntries.push({ nID, grpOff: off, dataSize: dwBytes });
    }
    // Pick best icon (prefer 32x32)
    let bestIdx = 0, bestDist = 999;
    for (let i = 0; i < idCount; i++) {
      const w = dv.getUint8(6 + i * 14) || 256;
      if (Math.abs(w - 32) < bestDist) { bestDist = Math.abs(w - 32); bestIdx = i; }
    }
    iconW = dv.getUint8(6 + bestIdx * 14) || 256;
    iconH = dv.getUint8(6 + bestIdx * 14 + 1) || 256;
    const chosen = iconEntries[bestIdx];
    const iconData = iconType.entries.find(e => e.id === chosen.nID);
    if (iconData) {
      const iconLang = iconData.languages[0];
      const iconOff = isNE ? iconLang.dataRva : rvaToFileOffset(iconLang.dataRva, emu.peInfo.sections);
      const headerSize = 6 + 16; // single-entry ico
      const icoSize = headerSize + iconLang.dataSize;
      const ico = new Uint8Array(icoSize);
      const icoDv = new DataView(ico.buffer);
      icoDv.setUint16(0, 0, true);
      icoDv.setUint16(2, 1, true); // type = icon
      icoDv.setUint16(4, 1, true); // count = 1
      for (let j = 0; j < 12; j++) ico[6 + j] = dv.getUint8(chosen.grpOff + j);
      icoDv.setUint32(18, headerSize, true); // data offset
      ico.set(new Uint8Array(ab, iconOff, iconLang.dataSize), headerSize);
      let binary = '';
      for (let i = 0; i < ico.length; i++) binary += String.fromCharCode(ico[i]);
      dataUrl = 'data:image/x-icon;base64,' + btoa(binary);
    }
  } catch (_e) { /* ignore extraction failures */ }

  return emu.handles.alloc('icon', { resourceId, dataUrl, width: iconW, height: iconH });
}

export function loadBitmapResourceFromModule(emu: Emulator, hInstance: number, resourceId: number): number {
  // Find which loaded DLL this hInstance belongs to
  for (const [, mod] of emu.loadedModules) {
    if (mod.base !== hInstance || !mod.resourceRva) continue;

    // Use cache key that includes hInstance to avoid collisions
    const cacheKey = (hInstance ^ (resourceId << 16)) >>> 0;
    const cached = emu.bitmapCache.get(cacheKey);
    if (cached) {
      // Verify handle is still valid (app may have called DeleteObject)
      if (emu.handles.get(cached)) return cached;
      emu.bitmapCache.delete(cacheKey);
    }

    const entry = emuFindResourceEntryForModule(emu, mod.imageBase, mod.resourceRva, 2, resourceId);
    if (!entry) return 0;

    try {
      // Read DIB data from emulator memory (DLL is loaded in memory)
      const dataAddr = mod.imageBase + entry.dataRva;
      const dibBytes = new Uint8Array(entry.dataSize);
      for (let i = 0; i < entry.dataSize; i++) {
        dibBytes[i] = emu.memory.readU8(dataAddr + i);
      }
      const { canvas, ctx, imageData, width, height } = decodeDib(dibBytes);
      const bmp: BitmapInfo = { width, height, canvas, ctx, imageData, resourceId, resourceModule: hInstance };
      const hBitmap = emu.handles.alloc('bitmap', bmp);
      emu.bitmapCache.set(cacheKey, hBitmap);
      console.log(`[DLL] Loaded bitmap resource ${resourceId} from module 0x${hInstance.toString(16)}: ${width}x${height}`);
      return hBitmap;
    } catch (e: unknown) {
      console.warn(`Failed to load DLL bitmap resource ${resourceId}: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    }
  }
  return 0;
}

export function loadBitmapResourceByName(emu: Emulator, name: string): number {
  const nameUpper = name.toUpperCase();

  // Check cache first
  const cached = emu.bitmapNameCache?.get(nameUpper);
  if (cached) {
    if (emu.handles.get(cached)) return cached;
    emu.bitmapNameCache!.delete(nameUpper);
  }

  // NE (16-bit) path: search NE resource table by name
  if (emu.isNE && emu.ne) {
    let entry = emu.ne.resources.find(r => r.typeID === 2 && r.name && r.name.toUpperCase() === nameUpper);
    let srcBuf = emu.arrayBuffer;
    if (!entry) {
      for (const dllInfo of emu.neDllResources) {
        entry = dllInfo.resources.find(r => r.typeID === 2 && r.name && r.name.toUpperCase() === nameUpper);
        if (entry) { srcBuf = dllInfo.arrayBuffer; break; }
      }
    }
    if (!entry) return 0;
    try {
      const dibData = new Uint8Array(srcBuf, entry.fileOffset, entry.length);
      const { canvas, ctx, imageData, width, height } = decodeDib(dibData);
      const bmp: BitmapInfo = { width, height, canvas, ctx, imageData };
      const hBitmap = emu.handles.alloc('bitmap', bmp);
      if (!emu.bitmapNameCache) emu.bitmapNameCache = new Map();
      emu.bitmapNameCache.set(nameUpper, hBitmap);
      console.log(`[NE] Loaded bitmap resource "${name}": ${width}x${height} → handle ${hBitmap}`);
      return hBitmap;
    } catch (e: unknown) {
      console.warn(`Failed to load NE bitmap resource "${name}": ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    }
  }

  if (!emu.peInfo.resources) return 0;
  const bitmapType = emu.peInfo.resources.find(r => r.typeId === 2);
  if (!bitmapType) return 0;

  const entry = bitmapType.entries.find(e => e.name && e.name.toUpperCase() === nameUpper);
  if (!entry || entry.languages.length === 0) return 0;

  const lang = entry.languages[0];
  try {
    let fileOffset: number;
    try {
      fileOffset = rvaToFileOffset(lang.dataRva, emu.peInfo.sections);
    } catch {
      fileOffset = lang.dataRva;
    }
    const dibData = new Uint8Array(emu.arrayBuffer, fileOffset, lang.dataSize);
    const { canvas, ctx, imageData, width, height } = decodeDib(dibData);

    const bmp: BitmapInfo = { width, height, canvas, ctx, imageData };
    const hBitmap = emu.handles.alloc('bitmap', bmp);
    if (!emu.bitmapNameCache) emu.bitmapNameCache = new Map();
    emu.bitmapNameCache.set(nameUpper, hBitmap);
    console.log(`[PE] Loaded bitmap resource "${name}": ${width}x${height}`);
    return hBitmap;
  } catch (e: unknown) {
    console.warn(`Failed to load bitmap resource "${name}": ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

export function loadCursorResourceByName(emu: Emulator, name: string): number {
  if (!emu.peInfo.resources) return 0;

  const nameUpper = name.toUpperCase();

  // Check cache
  const cacheKey = `cur:${nameUpper}`;
  const cached = emu.bitmapNameCache?.get(cacheKey);
  if (cached && emu.handles.get(cached)) return cached;

  // Find GROUP_CURSOR (type 12) by name
  const groupType = emu.peInfo.resources.find(r => r.typeId === 12);
  if (!groupType) return 0;
  const groupEntry = groupType.entries.find(e => e.name && e.name.toUpperCase() === nameUpper);
  if (!groupEntry || groupEntry.languages.length === 0) return 0;

  // Build cursor data map (RT_CURSOR = type 1)
  const cursorType = emu.peInfo.resources.find(r => r.typeId === 1);
  const cursorDataMap = new Map<number, { fileOffset: number; dataSize: number }>();
  if (cursorType) {
    for (const entry of cursorType.entries) {
      for (const lang of entry.languages) {
        try {
          const fileOffset = rvaToFileOffset(lang.dataRva, emu.peInfo.sections);
          cursorDataMap.set(entry.id!, { fileOffset, dataSize: lang.dataSize });
        } catch { /* skip */ }
      }
    }
  }

  const lang = groupEntry.languages[0];
  try {
    const fileOffset = rvaToFileOffset(lang.dataRva, emu.peInfo.sections);
    const dv = new DataView(emu.arrayBuffer, fileOffset, lang.dataSize);
    const idCount = dv.getUint16(4, true);

    // Parse group cursor entries
    const entries: { wWidth: number; wHeight: number; wPlanes: number; wBitCount: number; dwBytesInRes: number; nID: number }[] = [];
    for (let i = 0; i < idCount; i++) {
      const off = 6 + i * 14;
      entries.push({
        wWidth: dv.getUint16(off, true), wHeight: dv.getUint16(off + 2, true),
        wPlanes: dv.getUint16(off + 4, true), wBitCount: dv.getUint16(off + 6, true),
        dwBytesInRes: dv.getUint32(off + 8, true), nID: dv.getUint16(off + 12, true),
      });
    }

    // Build .CUR file
    const headerSize = 6 + idCount * 16;
    let totalDataSize = 0;
    const chunks: ({ fileOffset: number; dataSize: number } | null)[] = [];
    for (const e of entries) {
      const chunk = cursorDataMap.get(e.nID);
      chunks.push(chunk || null);
      if (chunk) totalDataSize += chunk.dataSize - 4;
    }

    const cur = new ArrayBuffer(headerSize + totalDataSize);
    const curDv = new DataView(cur);
    const curBytes = new Uint8Array(cur);
    curDv.setUint16(0, 0, true);
    curDv.setUint16(2, 2, true); // type = cursor
    curDv.setUint16(4, idCount, true);

    let hotspotX = 0, hotspotY = 0;
    let dataOff = headerSize;
    for (let i = 0; i < idCount; i++) {
      const entryOff = 6 + i * 16;
      const chunk = chunks[i];
      const ce = entries[i];
      let dibSize = 0;

      if (chunk) {
        const localDv = new DataView(emu.arrayBuffer, chunk.fileOffset, chunk.dataSize);
        hotspotX = localDv.getUint16(0, true);
        hotspotY = localDv.getUint16(2, true);
        dibSize = chunk.dataSize - 4;
      }

      const width = ce.wWidth;
      const height = ce.wHeight / 2;
      curBytes[entryOff] = width >= 256 ? 0 : width;
      curBytes[entryOff + 1] = height >= 256 ? 0 : height;
      curBytes[entryOff + 2] = 0;
      curBytes[entryOff + 3] = 0;
      curDv.setUint16(entryOff + 4, hotspotX, true);
      curDv.setUint16(entryOff + 6, hotspotY, true);
      curDv.setUint32(entryOff + 8, dibSize, true);
      curDv.setUint32(entryOff + 12, dataOff, true);

      if (chunk) {
        curBytes.set(new Uint8Array(emu.arrayBuffer, chunk.fileOffset + 4, dibSize), dataOff);
        dataOff += dibSize;
      }
    }

    // Convert to data URL for CSS cursor
    const blob = new Blob([cur], { type: 'image/x-icon' });
    const url = URL.createObjectURL(blob);
    const css = `url(${url}) ${hotspotX} ${hotspotY}, auto`;

    const handle = emu.handles.alloc('cursor', { css });
    if (!emu.bitmapNameCache) emu.bitmapNameCache = new Map();
    emu.bitmapNameCache.set(cacheKey, handle);
    console.log(`[PE] Loaded cursor resource "${name}": hotspot=(${hotspotX},${hotspotY})`);
    return handle;
  } catch (e: unknown) {
    console.warn(`Failed to load cursor resource "${name}": ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

// Standard MFC framework strings (afxres.h). MFC apps that link the shared
// MFC42.DLL load these by ID from MFC's own string table — which our MFC42 stub
// does not carry. CFrameWnd::SetMessageText(AFX_IDS_IDLEMESSAGE) puts "Ready" in
// status-bar pane 0 during idle; without it the pane stays blank. These IDs live
// in the reserved AFX range (0xE000+) so they never collide with an app's own
// string resources, and the app's table takes precedence when it defines one.
const AFX_STD_STRINGS: Record<number, string> = {
  0xE001: 'Ready',                                          // AFX_IDS_IDLEMESSAGE
  0xE002: 'Select an object on which to get Help',          // AFX_IDS_HELPMODEMESSAGE
};

export function loadStringResource(emu: Emulator, id: number): string | null {
  const cached = emu.stringCache.get(id);
  if (cached !== undefined) return cached;
  if (id in AFX_STD_STRINGS) return AFX_STD_STRINGS[id];
  return null;
}
