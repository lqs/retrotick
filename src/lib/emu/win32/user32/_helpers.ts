import type { Emulator } from '../../emulator';

import type { WinMsg } from '../../emulator';
import type { WindowInfo } from './types';
import { WS_CAPTION, WS_DLGFRAME, WS_BORDER, WS_THICKFRAME, WM_GETMINMAXINFO } from '../types';

/**
 * Called after a window's size changes. Windows invalidates the affected area;
 * for the CS_HREDRAW|CS_VREDRAW classes that MFC frames/views use, the WHOLE
 * client repaints. We invalidate the window's full new client so a stale,
 * smaller invalidRect captured at the previous size can't leave part of the
 * client unpainted (the "cut rectangle" symptom).
 */
export function invalidateForResize(emu: Emulator, wnd: WindowInfo): void {
  const cs = clientSizeOf(wnd);
  wnd.needsPaint = true;
  wnd.needsErase = true;
  wnd.invalidRect = { l: 0, t: 0, r: cs.cw, b: cs.ch };
}

/**
 * Store a window's new title and propagate the UI side effects (title bar,
 * control overlays, parent repaint). This is what DefWindowProc does for
 * WM_SETTEXT; SetWindowText itself only SENDS WM_SETTEXT, so a window that
 * handles the message (e.g. MFC's CStatusBar routing it into pane 0) keeps
 * full control over what the text means.
 */
export function applyWindowText(emu: Emulator, hwnd: number, wnd: WindowInfo, newTitle: string): void {
  if (newTitle === wnd.title) return;
  wnd.title = newTitle;
  if (hwnd === emu.mainWindow) {
    emu.onWindowChange?.(wnd);
  } else if (wnd.parent && wnd.parent === emu.mainWindow) {
    const parentWnd = emu.handles.get<WindowInfo>(wnd.parent);
    if (parentWnd) parentWnd.needsPaint = true;
  }
  emu.notifyControlOverlays?.();
}

// Helper: write a WinMsg into a MSG struct at pMsg, filling pt from lParam for mouse messages
export function writeMsgStruct(emu: Emulator, pMsg: number, msg: WinMsg): void {
  emu.memory.writeU32(pMsg, msg.hwnd);
  emu.memory.writeU32(pMsg + 4, msg.message);
  emu.memory.writeU32(pMsg + 8, msg.wParam);
  emu.memory.writeU32(pMsg + 12, msg.lParam);
  emu.memory.writeU32(pMsg + 16, (Date.now() & 0xFFFFFFFF) >>> 0); // time
  // pt: for mouse messages (0x200..0x20d), convert client coords from lParam to screen coords
  if (msg.message >= 0x200 && msg.message <= 0x20d) {
    const clientX = (msg.lParam & 0xFFFF) << 16 >> 16;   // sign-extend
    const clientY = (msg.lParam >>> 16) << 16 >> 16;
    const origin = clientToScreen(emu, msg.hwnd);
    emu.memory.writeU32(pMsg + 20, ((origin.x + clientX) | 0) >>> 0);  // pt.x (screen)
    emu.memory.writeU32(pMsg + 24, ((origin.y + clientY) | 0) >>> 0);  // pt.y (screen)
  } else {
    emu.memory.writeU32(pMsg + 20, 0);
    emu.memory.writeU32(pMsg + 24, 0);
  }
}

// Compute the screen-coordinate origin of a window's client area
function clientToScreen(emu: Emulator, hwnd: number): { x: number; y: number } {
  const wnd = hwnd ? emu.handles.get<WindowInfo>(hwnd) : null;
  if (!wnd) return { x: 0, y: 0 };
  // A custom WM_NCCALCSIZE margin insets the client origin within the window
  const il = wnd.ncInset?.l ?? 0, it = wnd.ncInset?.t ?? 0;
  const WS_CHILD = 0x40000000;
  if (wnd.style & WS_CHILD) {
    const parentOrigin = clientToScreen(emu, wnd.parent || 0);
    return { x: parentOrigin.x + wnd.x + il, y: parentOrigin.y + wnd.y + it };
  }
  // Top-level: account for border and caption
  const { cw, ch } = getClientSize(wnd.style, wnd.hMenu !== 0, wnd.width, wnd.height);
  const bw = (wnd.width - cw) / 2;
  const topH = wnd.height - ch - bw;
  return { x: wnd.x + bw, y: wnd.y + topH };
}

// Compute client area from total window dimensions
export function getNonClientMetrics(style: number, hasMenu: boolean, win16 = false) {
  let bw = 0, captionH = 0, menuH = 0;
  if (win16) {
    // Windows 3.1: thinner chrome — 1px border, 20px caption, 20px menu
    if (style & (WS_THICKFRAME | WS_DLGFRAME | WS_BORDER)) bw = 1;
    if ((style & WS_CAPTION) === WS_CAPTION) captionH = 20;
    if (hasMenu) menuH = 20;
  } else {
    // Win32: standard metrics
    if (style & WS_THICKFRAME) bw = 4;        // SM_CXSIZEFRAME
    else if (style & WS_DLGFRAME) bw = 3;     // SM_CXFIXEDFRAME
    else if (style & WS_BORDER) bw = 1;       // SM_CXBORDER
    if ((style & WS_CAPTION) === WS_CAPTION) captionH = 18; // SM_CYCAPTION
    if (hasMenu) menuH = 19; // SM_CYMENU
  }
  return { bw, captionH, menuH };
}

/**
 * Send WM_GETMINMAXINFO to query min track size, then clamp w/h.
 * Updates wnd.minTrackWidth/minTrackHeight as a side effect.
 * Returns clamped { w, h }.
 */
export function clampToMinTrackSize(emu: Emulator, hwnd: number, wnd: WindowInfo, w: number, h: number): { w: number; h: number } {
  if (wnd.wndProc) {
    // MINMAXINFO is 40 bytes: 5 POINTs (ptReserved, ptMaxSize, ptMaxPosition, ptMinTrackSize, ptMaxTrackSize)
    const pInfo = emu.allocHeap(40);
    // Zero-init
    for (let i = 0; i < 40; i += 4) emu.memory.writeU32(pInfo + i, 0);
    emu.callWndProc(wnd.wndProc, hwnd, WM_GETMINMAXINFO, 0, pInfo);
    const minW = emu.memory.readU32(pInfo + 24); // ptMinTrackSize.x
    const minH = emu.memory.readU32(pInfo + 28); // ptMinTrackSize.y
    if (minW > 0) wnd.minTrackWidth = minW;
    if (minH > 0) wnd.minTrackHeight = minH;
    // no freeHeap — 40 bytes is negligible
  }
  const aw = (wnd.minTrackWidth && w < wnd.minTrackWidth) ? wnd.minTrackWidth : w;
  const ah = (wnd.minTrackHeight && h < wnd.minTrackHeight) ? wnd.minTrackHeight : h;
  if (aw !== w || ah !== h) {
    console.log(`[MinTrackSize] hwnd=0x${hwnd.toString(16)} clamped: ${w}x${h} -> ${aw}x${ah} (min=${wnd.minTrackWidth}x${wnd.minTrackHeight})`);
  }
  return { w: aw, h: ah };
}

export function getClientSize(style: number, hasMenu: boolean, totalW: number, totalH: number, win16 = false) {
  // A child window's hMenu slot holds its control ID, not a menu handle, so
  // callers pass hMenu!==0 as hasMenu — but children never have a menu bar.
  // Without this guard every child window's client area loses a phantom menu
  // row (~19px), which e.g. leaves a grey strip under a docked palette/toolbar.
  const WS_CHILD = 0x40000000;
  const menu = hasMenu && !(style & WS_CHILD);
  const { bw, captionH, menuH } = getNonClientMetrics(style, menu, win16);
  return {
    cw: Math.max(1, totalW - 2 * bw),
    ch: Math.max(1, totalH - 2 * bw - captionH - menuH),
  };
}

/**
 * Client size of a window, honoring a custom WM_NCCALCSIZE inset (ncInset) when
 * present, otherwise the style-based getClientSize. ncInset is only set for
 * windows whose own NCCALCSIZE handler shrinks the rect (custom non-client
 * area), so for every standard window this is identical to getClientSize.
 */
export function clientSizeOf(wnd: WindowInfo, win16 = false) {
  if (wnd.ncInset) {
    return {
      cw: Math.max(1, wnd.width - wnd.ncInset.l - wnd.ncInset.r),
      ch: Math.max(1, wnd.height - wnd.ncInset.t - wnd.ncInset.b),
    };
  }
  return getClientSize(wnd.style, wnd.hMenu !== 0, wnd.width, wnd.height, win16);
}

const WM_NCCALCSIZE = 0x0083;
const WS_CHILD_F = 0x40000000;
const WS_CAPTION_F = 0x00C00000;

/**
 * Ask a window's own wndProc to compute its client rectangle via WM_NCCALCSIZE
 * (wParam=FALSE, lParam=&RECT) and store any custom inset on wnd.ncInset.
 *
 * Real Windows sends WM_NCCALCSIZE with the proposed window rect and the
 * handler shrinks it to the client rect; the reserved margin is the non-client
 * area (borders, scroll bars, and app-drawn chrome like MFC CSizingControlBar
 * grippers/edges). We previously sent it with a null rect and ignored the
 * result, so any custom non-client area was lost — a docked control bar's view
 * filled the whole bar instead of being inset.
 *
 * Gated to WS_CHILD windows without WS_CAPTION (control-bar-like): standard
 * controls don't override NCCALCSIZE (DefWindowProc leaves the rect untouched →
 * no inset → ncInset stays undefined → unchanged behavior), and top-level /
 * captioned windows keep their style-based client. Only a handler that actually
 * shrinks the rect by a sane amount sets ncInset.
 */
// Control classes the emulator lays out / paints SPECIALLY (renderToolbar,
// the MFC dock-bar docking pass, the status bar). Their on-canvas geometry is
// computed by that special code, which doesn't expect a generic NCCALCSIZE
// client inset — applying one shifts their content and exposes the bar
// background. The generic ncInset path is for plain child views (e.g. a
// CSizingControlBar's embedded view) that position themselves from
// GetClientRect.
const NCINSET_EXCLUDED_CLASSES = new Set([
  'TOOLBARWINDOW32', 'REBARWINDOW32', 'MSCTLS_STATUSBAR32',
]);
// MFC dock-bar control IDs (AFX_IDW_DOCKBAR_TOP..BOTTOM): these are containers
// laid out by the dock pass, not client-rect-driven views.
const AFX_IDW_DOCKBAR_FIRST = 0xE81B, AFX_IDW_DOCKBAR_LAST = 0xE81E;

export function computeNcInset(emu: Emulator, hwnd: number, wnd: WindowInfo): void {
  if (!wnd.wndProc) return;
  if (!(wnd.style & WS_CHILD_F) || (wnd.style & WS_CAPTION_F) === WS_CAPTION_F) return;
  const cls = (wnd.classInfo?.className ?? '').toUpperCase();
  if (NCINSET_EXCLUDED_CLASSES.has(cls)) return;
  const cid = wnd.controlId ?? 0;
  if (cid >= AFX_IDW_DOCKBAR_FIRST && cid <= AFX_IDW_DOCKBAR_LAST) return;
  if ((emu as any)._inNcCalc) return; // no re-entrancy
  const w = wnd.width | 0, h = wnd.height | 0;
  if (w <= 0 || h <= 0) return;

  let rectPtr = (emu as any)._ncCalcScratch as number | undefined;
  if (!rectPtr) { rectPtr = emu.allocHeap(16); (emu as any)._ncCalcScratch = rectPtr; }
  // NCCALCSIZE_PARAMS for wParam=FALSE is just a RECT (proposed window rect).
  emu.memory.writeI32(rectPtr, 0);
  emu.memory.writeI32(rectPtr + 4, 0);
  emu.memory.writeI32(rectPtr + 8, w);
  emu.memory.writeI32(rectPtr + 12, h);

  (emu as any)._inNcCalc = true;
  try {
    emu.callWndProc(wnd.wndProc, hwnd, WM_NCCALCSIZE, 0, rectPtr);
  } catch {
    (emu as any)._inNcCalc = false;
    return;
  }
  (emu as any)._inNcCalc = false;

  const cl = emu.memory.readI32(rectPtr);
  const ct = emu.memory.readI32(rectPtr + 4);
  const cr = emu.memory.readI32(rectPtr + 8);
  const cb = emu.memory.readI32(rectPtr + 12);
  const l = cl, t = ct, r = w - cr, b = h - cb;
  // Reject anything not a sane shrink: negative margins, a client that grew or
  // collapsed, or an absurd inset (handler ignored our rect / used screen
  // coords). Keep the inset only when the handler reserved a real, modest NC.
  const ok = l >= 0 && t >= 0 && r >= 0 && b >= 0 &&
    l + r < w && t + b < h && l < w / 2 && r < w / 2 && t < h / 2 && b < h / 2;
  if (ok && (l | t | r | b) !== 0) {
    wnd.ncInset = { l, t, r, b };
  } else {
    wnd.ncInset = undefined;
  }
}
