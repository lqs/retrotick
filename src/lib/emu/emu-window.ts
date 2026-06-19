import type { Emulator } from './emulator';
import type { DCInfo, BitmapInfo, BrushInfo, PenInfo } from './win32/gdi32/index';
import type { WindowInfo } from './win32/user32/index';
import { OPAQUE, SYS_COLORS, COLOR_BTNFACE } from './win32/types';
import { decodeDib } from '../pe/decode-dib';
import { rvaToFileOffset } from '../pe/read';
import { renderChildControls } from './emu-render';
import { getClientSize, getNonClientMetrics } from './win32/user32/_helpers';
import { emuFindResourceEntryForModule } from './emu-load';

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
      const { bw, captionH } = getNonClientMetrics(parent.style, !!parent.hMenu, emu.isNE);
      x += bw;
      y += bw + captionH;
    }
    cur = parent;
  }
  return { x, y };
}

export function getWindowDC(emu: Emulator, hwnd: number): number {
  const wnd = emu.handles.get<WindowInfo>(hwnd);
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
      dc.ctx.save();
      dc.ctx.setTransform(1, 0, 0, 1, origin.x, origin.y + ccsYOffset);
      dc.ctx.beginPath();
      dc.ctx.rect(0, -ccsYOffset, wnd.width, wnd.height);
      dc.ctx.clip();
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
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, origin.x, origin.y + ccsYOffset);
    ctx.beginPath();
    ctx.rect(0, -ccsYOffset, wnd.width, wnd.height);
    ctx.clip();
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
  if (!wnd || !(wnd.style & WS_CLIPCHILDREN) || !wnd.childList || hwnd !== emu.mainWindow) return;
  const dc = getDC(emu, hdc);
  if (!dc) return;

  // Collect visible child rects
  const childRects: { x: number; y: number; w: number; h: number }[] = [];
  for (const childHwnd of wnd.childList) {
    const child = emu.handles.get<WindowInfo>(childHwnd);
    if (!child || !child.visible) continue;
    childRects.push({ x: child.x, y: child.y, w: child.width, h: child.height });
  }
  if (childRects.length === 0) return;

  dc.ctx.save();
  clipChildrenDCSet.add(hdc);

  // Create a clip path that is the canvas rect minus child rects
  // Using evenodd: outer rect CW + child rects CW will clip out the children
  const cw = dc.canvas.width;
  const ch = dc.canvas.height;
  dc.ctx.beginPath();
  dc.ctx.rect(0, 0, cw, ch);
  for (const r of childRects) {
    // Draw child rect in reverse winding (CCW) for evenodd clipping
    dc.ctx.moveTo(r.x, r.y);
    dc.ctx.lineTo(r.x, r.y + r.h);
    dc.ctx.lineTo(r.x + r.w, r.y + r.h);
    dc.ctx.lineTo(r.x + r.w, r.y);
    dc.ctx.closePath();
  }
  dc.ctx.clip('evenodd');
}

export function beginPaint(emu: Emulator, hwnd: number): number {
  const hdc = getWindowDC(emu, hwnd);
  // Validate the region — clear needsPaint to prevent infinite WM_PAINT loop
  const wnd = emu.handles.get<WindowInfo>(hwnd);
  if (wnd) { wnd.needsPaint = false; wnd.needsErase = false; wnd.painting = true; }
  // Signal to DispatchMessage that BeginPaint was called (so it doesn't duplicate overlay notifications)
  emu._dispatchPaintUsedBeginPaint = true;

  // Apply WS_CLIPCHILDREN: clip out visible child windows on main window DC
  // Must be applied before erase so child areas are protected
  applyClipChildren(emu, hwnd, wnd, hdc);

  // Erase background: for dialogs, use COLOR_BTNFACE (WM_CTLCOLORDLG default);
  // for regular windows, use the class brush
  if (wnd) {
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
        dc.ctx.fillStyle = `rgb(${r},${g},${b})`;
        dc.ctx.fillRect(0, 0, wnd.width, wnd.height);
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

export function syncDCToCanvas(emu: Emulator, hdc: number): void {
  // Window DCs draw directly to the main canvas — nothing to sync
  // Memory DCs are OffscreenCanvas which need explicit BitBlt
  // Mark screen as dirty so tick() can yield for browser rendering
  emu.screenDirty = true;
  // DIB sections share pixel storage with the app: GDI drawing must be
  // reflected back into the guest-visible pixel buffer.
  const dc = emu.handles.get<DCInfo>(hdc);
  if (dc) syncCanvasToDib(emu, dc);
}

/** Decode a DIB section's guest pixel buffer into the DC's working canvas.
 *  Call before using a memory DC with a DIB section as a blt source —
 *  the app may have written the pixels directly (shared-storage semantics). */
export function syncDibToCanvas(emu: Emulator, dc: DCInfo): void {
  const bmp = dc.selectedBitmap ? emu.handles.get<BitmapInfo>(dc.selectedBitmap) : null;
  if (!bmp?.dibBitsPtr || !bmp.dibBpp) return;
  const w = bmp.width, h = bmp.height, bpp = bmp.dibBpp;
  if (dc.canvas.width !== w || dc.canvas.height !== h) return;
  const stride = Math.floor((w * bpp + 31) / 32) * 4;
  const raw = emu.memory.slice(bmp.dibBitsPtr, stride * h);
  const img = dc.ctx.createImageData(w, h);
  const px = img.data;
  for (let y = 0; y < h; y++) {
    const srcRow = (bmp.dibTopDown ? y : h - 1 - y) * stride;
    let di = y * w * 4;
    if (bpp === 32) {
      for (let x = 0; x < w; x++) {
        const si = srcRow + x * 4;
        px[di] = raw[si + 2]; px[di + 1] = raw[si + 1]; px[di + 2] = raw[si]; px[di + 3] = 255;
        di += 4;
      }
    } else if (bpp === 24) {
      for (let x = 0; x < w; x++) {
        const si = srcRow + x * 3;
        px[di] = raw[si + 2]; px[di + 1] = raw[si + 1]; px[di + 2] = raw[si]; px[di + 3] = 255;
        di += 4;
      }
    } else if (bpp === 8) {
      const pal = bmp.dibColorTable || [];
      for (let x = 0; x < w; x++) {
        const c = pal[raw[srcRow + x]] || 0;
        px[di] = (c >> 16) & 0xFF; px[di + 1] = (c >> 8) & 0xFF; px[di + 2] = c & 0xFF; px[di + 3] = 255;
        di += 4;
      }
    } else {
      return; // 1/4/16bpp DIB sections not handled yet
    }
  }
  dc.ctx.putImageData(img, 0, 0);
}

/** Encode the DC's working canvas back into the DIB section's guest buffer. */
export function syncCanvasToDib(emu: Emulator, dc: DCInfo): void {
  const bmp = dc.selectedBitmap ? emu.handles.get<BitmapInfo>(dc.selectedBitmap) : null;
  if (!bmp?.dibBitsPtr || !bmp.dibBpp) return;
  const w = bmp.width, h = bmp.height, bpp = bmp.dibBpp;
  if (bpp !== 24 && bpp !== 32) return;
  if (dc.canvas.width !== w || dc.canvas.height !== h) return;
  const stride = Math.floor((w * bpp + 31) / 32) * 4;
  const img = dc.ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const dstRow = (bmp.dibTopDown ? y : h - 1 - y) * stride;
    let si = y * w * 4;
    if (bpp === 32) {
      for (let x = 0; x < w; x++) {
        const di = dstRow + x * 4;
        out[di] = px[si + 2]; out[di + 1] = px[si + 1]; out[di + 2] = px[si]; out[di + 3] = 255;
        si += 4;
      }
    } else {
      for (let x = 0; x < w; x++) {
        const di = dstRow + x * 3;
        out[di] = px[si + 2]; out[di + 1] = px[si + 1]; out[di + 2] = px[si];
        si += 4;
      }
    }
  }
  emu.memory.copyFrom(bmp.dibBitsPtr, out);
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
      const bmp: BitmapInfo = { width, height, canvas, ctx, imageData };
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

    const bmp: BitmapInfo = { width, height, canvas, ctx, imageData };
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
      const bmp: BitmapInfo = { width, height, canvas, ctx, imageData };
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

export function loadStringResource(emu: Emulator, id: number): string | null {
  return emu.stringCache.get(id) || null;
}
