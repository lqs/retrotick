import type { Emulator, ControlOverlay } from './emulator';
import type { WindowInfo } from './win32/user32/index';
import type { BrushInfo } from './win32/gdi32/types';
import { renderButton, renderStatic, renderEdit } from './emu-render-controls';
import { getNonClientMetrics } from './win32/user32/_helpers';
import {
  WM_CTLCOLORSTATIC, WM_CTLCOLORBTN, SYS_COLORS, COLOR_BTNFACE, COLOR_BTNTEXT,
  ODT_BUTTON, ODA_DRAWENTIRE, ODS_SELECTED, ODS_DISABLED,
} from './win32/types';

/** Send WM_CTLCOLORSTATIC to parent and return CSS color string if a valid brush is returned */
function getCtlColorStatic(emu: Emulator, child: WindowInfo, childHwnd: number): string | undefined {
  const parentWnd = emu.handles.get<WindowInfo>(child.parent);
  if (!parentWnd?.wndProc) return undefined;
  // Win16 (NE) wndProcs are 16-bit segmented addresses — can't call via callWndProc (32-bit)
  if (emu.isNE) return undefined;
  // wParam = HDC (use 0 as placeholder), lParam = child window handle
  const result = emu.callWndProc(parentWnd.wndProc, child.parent, WM_CTLCOLORSTATIC, 0, childHwnd);
  if (!result) return undefined;
  // For dialog procs: return value is TRUE, actual brush is in DWL_MSGRESULT (extraBytes[0..3])
  let hBrush = result;
  if (result === 1 && parentWnd.extraBytes && parentWnd.extraBytes.length >= 4) {
    const msgResult = parentWnd.extraBytes[0] | (parentWnd.extraBytes[1] << 8) |
      (parentWnd.extraBytes[2] << 16) | (parentWnd.extraBytes[3] << 24);
    if (msgResult) hBrush = msgResult >>> 0;
  }
  const brush = emu.getBrush(hBrush);
  if (brush && !brush.isNull) {
    const r = brush.color & 0xFF, g = (brush.color >> 8) & 0xFF, b = (brush.color >> 16) & 0xFF;
    return `rgb(${r},${g},${b})`;
  }
  return undefined;
}

/**
 * Draw text with anti-aliasing using the browser's native text rendering.
 */
export function fillTextBitmap(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string, x: number, y: number, maxWidth?: number,
): void {
  if (!text) return;
  if (maxWidth !== undefined) {
    ctx.fillText(text, x, y, maxWidth);
  } else {
    ctx.fillText(text, x, y);
  }
}

/** Lightweight overlay-only update: sends control overlay data to Preact without triggering WM_PAINT */
export function notifyControlOverlays(emu: Emulator): void {
  const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
  if (!wnd?.childList || !emu.onControlsChanged) return;
  const allChildren: CollectedChild[] = [];
  collectChildren(emu, wnd, 0, 0, allChildren);
  const overlays = buildOverlays(emu, allChildren);
  emu.onControlsChanged(overlays);
}

const DOM_CLASSES = ['BUTTON', 'EDIT', 'STATIC', 'LISTBOX', 'COMBOBOX', 'SCROLLBAR', 'MSCTLS_TRACKBAR32', 'MSCTLS_PROGRESS32', 'MSCTLS_HOTKEY32', 'RICHEDIT20W', 'RICHEDIT20A', 'RICHEDIT', 'SYSTABCONTROL32', 'SYSLISTVIEW32', 'MSCTLS_STATUSBAR32', 'MSCTLS_STATUSBAR', 'SYSTREEVIEW32'];

function buildOverlays(emu: Emulator, allChildren: CollectedChild[]): ControlOverlay[] {
  const overlays: ControlOverlay[] = [];
  const mdiChildMap = new Map<number, ControlOverlay>();

  for (const { hwnd: childHwnd, info: child, ox, oy, isMdiChild, mdiParentHwnd } of allChildren) {
    const controlId = child.controlId ?? 0;
    const cn = child.classInfo.className.toUpperCase();
    if (cn === '#32770') continue;
    // MDI children bypass the custom-wndProc filter (they need a DOM overlay for title bar/frame)
    if (!isMdiChild) {
      if (child.wndProc && !DOM_CLASSES.includes(cn) && !child.classInfo.baseClassName) continue;
    }
    const overlay: ControlOverlay = {
      controlId, childHwnd,
      className: cn,
      baseClassName: child.classInfo.baseClassName,
      x: child.x + ox, y: child.y + oy, width: child.width, height: child.height,
      style: child.style, exStyle: child.exStyle, title: child.title,
      checked: child.checked ?? 0,
      fontHeight: child.hFont ? (emu.handles.get<{ height: number }>(child.hFont)?.height ?? 0) : 0,
      trackPos: child.trackPos ?? 0,
      trackMin: child.trackMin ?? 0,
      trackMax: child.trackMax ?? 100,
    };
    if (cn === 'STATIC') {
      const bg = getCtlColorStatic(emu, child, childHwnd);
      if (bg) overlay.bgColor = bg;
    }
    if (child.treeItems) overlay.treeItems = Array.from(child.treeItems.values());
    if (child.treeSelectedItem !== undefined) overlay.treeSelectedItem = child.treeSelectedItem;
    if (child.treeImageList) {
      const il = emu.handles.get<{ images: (string | undefined)[] }>(child.treeImageList);
      if (il?.images) overlay.treeImageUrls = il.images;
    }
    if (child.lbItems) overlay.lbItems = child.lbItems;
    if (child.lbSelectedIndex !== undefined) overlay.lbSelectedIndex = child.lbSelectedIndex;
    if (child.lbSelectedIndices) overlay.lbSelectedIndices = Array.from(child.lbSelectedIndices);
    if (child.cbItems) overlay.cbItems = child.cbItems;
    if (child.cbSelectedIndex !== undefined) overlay.cbSelectedIndex = child.cbSelectedIndex;
    if (child.listColumns) overlay.listColumns = child.listColumns;
    if (child.listItems) overlay.listItems = child.listItems;
    if (child.statusTexts) overlay.statusTexts = child.statusTexts;
    if (child.statusParts) overlay.statusParts = child.statusParts;
    if (child.tabItems) overlay.tabItems = child.tabItems;
    if (child.tabSelectedIndex !== undefined) overlay.tabSelectedIndex = child.tabSelectedIndex;

    if (isMdiChild) {
      overlay.isMdiChild = true;
      overlay.mdiChildren = [];
      // Check if this MDI child is the active one
      const mdiClient = emu.handles.get<WindowInfo>(child.parent);
      if (mdiClient && (mdiClient as any).mdiActiveChild === childHwnd) {
        overlay.isMdiActive = true;
      }
      if (child.maximized) overlay.isMdiMaximized = true;
      if (child.minimized) overlay.isMdiMinimized = true;
      // Pass MDICLIENT clip rect so MDI children don't overlap toolbar/statusbar
      // ox/oy already include mdiClient.x/y (set at collectChildren line 166)
      if (mdiClient) {
        overlay.mdiClientRect = { x: ox, y: oy, w: mdiClient.width, h: mdiClient.height };
      }
      mdiChildMap.set(childHwnd, overlay);
      overlays.push(overlay);
    } else if (mdiParentHwnd) {
      // Nest inside MDI parent with position relative to the client area
      const parentOverlay = mdiChildMap.get(mdiParentHwnd);
      if (parentOverlay) {
        const { bw, captionH } = getNonClientMetrics(parentOverlay.style, false, emu.isNE);
        overlay.x = overlay.x - parentOverlay.x - bw;
        overlay.y = overlay.y - parentOverlay.y - bw - captionH;
        parentOverlay.mdiChildren!.push(overlay);
      } else {
        overlays.push(overlay);
      }
    } else {
      overlays.push(overlay);
    }
  }
  return overlays;
}

interface CollectedChild {
  hwnd: number;
  info: WindowInfo;
  ox: number;
  oy: number;
  isMdiChild?: boolean;
  mdiParentHwnd?: number;
}

/** Recursively collect all visible children from a window and its child dialogs */
function collectChildren(emu: Emulator, wnd: WindowInfo, offsetX: number, offsetY: number, out: CollectedChild[], mdiParentHwnd?: number): void {
  if (!wnd.childList) return;
  for (const childHwnd of wnd.childList) {
    const child = emu.handles.get<WindowInfo>(childHwnd);
    if (!child) continue;
    // MDICLIENT: always recurse into it (structural container for MDI children)
    const cn = child.classInfo?.className?.toUpperCase();
    if (cn === 'MDICLIENT') {
      if (child.childList && child.childList.length > 0) {
        // MDICLIENT's direct children are MDI child windows
        for (const mdiChildHwnd of child.childList) {
          const mdiChild = emu.handles.get<WindowInfo>(mdiChildHwnd);
          if (!mdiChild) continue;
          // Include minimized MDI children (they render as small title bars)
          if (!mdiChild.visible && !mdiChild.minimized) continue;
          out.push({ hwnd: mdiChildHwnd, info: mdiChild, ox: offsetX + child.x, oy: offsetY + child.y, isMdiChild: true });
          // Recurse into MDI child's children (skip if minimized — no client area visible)
          if (!mdiChild.minimized && mdiChild.childList && mdiChild.childList.length > 0) {
            const { bw, captionH } = getNonClientMetrics(mdiChild.style, !!mdiChild.hMenu, emu.isNE);
            collectChildren(emu, mdiChild,
              offsetX + child.x + mdiChild.x + bw,
              offsetY + child.y + mdiChild.y + bw + captionH,
              out, mdiChildHwnd);
          }
        }
      }
      continue;
    }
    if (!child.visible) continue;
    out.push({ hwnd: childHwnd, info: child, ox: offsetX, oy: offsetY, mdiParentHwnd });
    // Recurse into child's children (e.g. tab pages, toolbar controls)
    if (child.childList && child.childList.length > 0) {
      let childOffY = offsetY + child.y;
      // CCS toolbar: the x86 COMMCTRL computes an internal height larger than
      // the displayed height (e.g. 49px vs 27px). Child windows (like combobox)
      // are positioned by MoveWindow using the internal height, while canvas-
      // painted buttons use the DC ccsYOffset. Overlay children need a partial
      // offset to align with DC-shifted button painting.
      const internalH = (child as any)._ccsInternalHeight;
      if (internalH && internalH > child.height) {
        childOffY += Math.round((internalH - child.height) / 5);
      }
      collectChildren(emu, child, offsetX + child.x, childOffY, out, mdiParentHwnd);
    }
  }
}

export function renderChildControls(emu: Emulator, hwnd: number): void {
  const wnd = emu.handles.get<WindowInfo>(hwnd);
  if (!wnd?.childList || hwnd !== emu.mainWindow) return;
  const ctx = emu.canvasCtx;
  if (!ctx) return;

  const allChildren: CollectedChild[] = [];
  collectChildren(emu, wnd, 0, 0, allChildren);

  if (false) { // DIAG: enable for debugging render cycles
  }

  // Notify overlays synchronously BEFORE custom draw so Preact renders
  // CompanionCanvas elements and sets wnd.domCanvas via ref callbacks.
  // This ensures sendDrawItem can draw directly to the companion canvas.
  if (emu.onControlsChanged) {
    const overlays = buildOverlays(emu, allChildren);
    if (overlays.length > 0) {
      emu.onControlsChanged(overlays);
    }
  }

  for (const { hwnd: childHwnd, info: child } of allChildren) {
    const controlId = child.controlId ?? 0;
    const className = child.classInfo.className.toUpperCase();
    const bsType = child.style & 0xF;
    // Only canvas-render BS_OWNERDRAW buttons; all others rendered as DOM
    if (className === 'BUTTON' && bsType === 0xB) {
      if (child.domCanvas) {
        // Companion canvas: clear to transparent; the DOM Button component provides the base visual
        const cctx = child.domCanvas.getContext('2d');
        if (cctx) cctx.clearRect(0, 0, child.width, child.height);
      } else {
        renderControl(emu, ctx, child);
      }
      if (wnd.wndProc) {
        sendDrawItem(emu, hwnd, wnd, child, childHwnd, controlId);
      }
    }
    // Custom-class child controls with their own wndProc: send WM_PAINT
    if (child.wndProc && !['BUTTON', 'EDIT', 'STATIC', 'LISTBOX', 'COMBOBOX', 'SCROLLBAR', 'RICHEDIT20W', 'RICHEDIT20A', 'RICHEDIT'].includes(className)) {
      child.needsPaint = true;
      // Safety net: pop any leaked ctx.save() from previous child paints.
      // releaseChildDC uses dc.saveLevel to pop x86 SaveDC saves, but some
      // saves may slip through (e.g. StretchBlt internal save/restore on the
      // shared canvas). Popping stale saves prevents clip accumulation.
      if (emu.canvasCtx) {
        for (let i = 0; i < 20; i++) emu.canvasCtx.restore();
      }
      if (emu.isNE) {
        emu.callWndProc16(child.wndProc, childHwnd, 0x000F, 0, 0); // WM_PAINT (Win16 PASCAL)
      } else {
        emu.callWndProc(child.wndProc, childHwnd, 0x000F, 0, 0); // WM_PAINT (Win32 stdcall)
      }
      child.needsPaint = false;
    }
  }
}

function sendDrawItem(emu: Emulator, parentHwnd: number, parentWnd: WindowInfo, child: WindowInfo, childHwnd: number, controlId: number): void {
  if (!emu.drawItemStructAddr) {
    emu.drawItemStructAddr = emu.allocHeap(48);
  }
  const addr = emu.drawItemStructAddr;

  // If the child has a companion canvas, draw directly to it (no translate needed).
  // Otherwise fall back to parent's DC with translate.
  const useDomCanvas = !!child.domCanvas;
  const hdc = useDomCanvas ? emu.getWindowDC(childHwnd) : emu.getWindowDC(parentHwnd);

  const dc = emu.getDC(hdc);
  if (dc && !useDomCanvas) {
    // Apply translate so drawing at (0,0) maps to (child.x, child.y) on canvas
    dc.ctx.save();
    dc.ctx.translate(child.x, child.y);
  }

  // Windows prepares the DC via WM_CTLCOLORBTN before WM_DRAWITEM:
  // the default (DefWindowProc) sets bk=COLOR_BTNFACE, text=COLOR_BTNTEXT,
  // then the parent may override with its own SetBkColor/SetTextColor.
  if (dc) {
    dc.bkColor = SYS_COLORS[COLOR_BTNFACE];
    dc.textColor = SYS_COLORS[COLOR_BTNTEXT];
    if (!emu.isNE && parentWnd.wndProc) {
      emu.callWndProc(parentWnd.wndProc, parentHwnd, WM_CTLCOLORBTN, hdc, childHwnd);
    }
  }

  let itemState = 0;
  if (child.style & 0x08000000) itemState |= ODS_DISABLED; // WS_DISABLED
  if (child._odsSelected) itemState |= ODS_SELECTED;       // pressed state

  emu.memory.writeU32(addr + 0,  ODT_BUTTON);  // CtlType
  emu.memory.writeU32(addr + 4,  controlId);   // CtlID
  emu.memory.writeU32(addr + 8,  0);           // itemID
  emu.memory.writeU32(addr + 12, ODA_DRAWENTIRE); // itemAction
  emu.memory.writeU32(addr + 16, itemState);   // itemState
  emu.memory.writeU32(addr + 20, childHwnd);   // hwndItem
  emu.memory.writeU32(addr + 24, hdc);         // hDC
  emu.memory.writeU32(addr + 28, 0);           // rcItem.left
  emu.memory.writeU32(addr + 32, 0);           // rcItem.top
  emu.memory.writeU32(addr + 36, child.width); // rcItem.right
  emu.memory.writeU32(addr + 40, child.height);// rcItem.bottom
  emu.memory.writeU32(addr + 44, 0);           // itemData

  if (emu.isNE) {
    // Win16 DRAWITEMSTRUCT uses 16-bit fields; build a 16-bit version
    // Layout: CtlType(2) CtlID(2) itemID(2) itemAction(2) itemState(2) hwndItem(2) hDC(2) rcItem(8=4x2) itemData(4)
    const addr16 = emu.drawItemStructAddr;
    emu.memory.writeU16(addr16 + 0,  ODT_BUTTON);  // CtlType
    emu.memory.writeU16(addr16 + 2,  controlId);   // CtlID
    emu.memory.writeU16(addr16 + 4,  0);           // itemID
    emu.memory.writeU16(addr16 + 6,  ODA_DRAWENTIRE); // itemAction
    emu.memory.writeU16(addr16 + 8,  itemState);   // itemState
    emu.memory.writeU16(addr16 + 10, childHwnd);   // hwndItem
    emu.memory.writeU16(addr16 + 12, hdc);         // hDC
    emu.memory.writeU16(addr16 + 14, 0);           // rcItem.left
    emu.memory.writeU16(addr16 + 16, 0);           // rcItem.top
    emu.memory.writeU16(addr16 + 18, child.width); // rcItem.right
    emu.memory.writeU16(addr16 + 20, child.height);// rcItem.bottom
    emu.memory.writeU32(addr16 + 22, 0);           // itemData
    emu.callWndProc16(parentWnd.wndProc, parentHwnd, 0x002B, controlId, addr16);
  } else {
    emu.callWndProc(parentWnd.wndProc, parentHwnd, 0x002B, controlId, addr);
  }

  // Restore DC transform
  if (dc && !useDomCanvas) {
    dc.ctx.restore();
  }
}

function renderControl(emu: Emulator, ctx: CanvasRenderingContext2D, child: WindowInfo): void {
  const className = child.classInfo.className.toUpperCase();
  switch (className) {
    case 'BUTTON':
      renderButton(ctx, child);
      break;
    case 'STATIC':
      renderStatic(ctx, child, emu);
      break;
    case 'EDIT':
      renderEdit(ctx, child);
      break;
  }
}
