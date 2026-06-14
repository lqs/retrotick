import type { Emulator } from '../../emulator';
import type { WindowInfo } from './types';
import { getClientSize, clientSizeOf } from './_helpers';
import { WS_CAPTION, WS_DLGFRAME, WS_BORDER, WS_THICKFRAME } from '../types';

export function registerRect(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  // Client rect
  user32.register('GetClientRect', 2, () => {
    const hwnd = emu.readArg(0);
    const rectPtr = emu.readArg(1);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (!wnd) return 0;
    const { cw, ch } = clientSizeOf(wnd);
    emu.memory.writeU32(rectPtr, 0);
    emu.memory.writeU32(rectPtr + 4, 0);
    emu.memory.writeU32(rectPtr + 8, cw);
    emu.memory.writeU32(rectPtr + 12, ch);
    return 1;
  });

  user32.register('GetWindowRect', 2, () => {
    const hwnd = emu.readArg(0);
    const rectPtr = emu.readArg(1);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (!wnd) return 0;
    // Accumulate screen-space origin by walking parent chain
    // Child windows (WS_CHILD): x,y is relative to parent's client area
    // Top-level windows: x,y is in screen coordinates, stop walking
    let sx = wnd.x || 0, sy = wnd.y || 0;
    const WS_CHILD = 0x40000000;
    if (wnd.style & WS_CHILD) {
      let cur = wnd.parent ? emu.handles.get<WindowInfo>(wnd.parent) : null;
      while (cur) {
        if (cur.style & WS_CHILD) {
          // Child parent: add its position (relative to its parent's client area)
          sx += cur.x || 0;
          sy += cur.y || 0;
        } else {
          // Non-child (top-level) parent: add its screen position + client area offset
          const { cw, ch } = getClientSize(cur.style, cur.hMenu !== 0, cur.width, cur.height);
          const bw = (cur.width - cw) / 2;
          const topH = cur.height - ch - bw;
          sx += (cur.x || 0) + bw;
          sy += (cur.y || 0) + topH;
          break; // top-level parent is in screen coords, stop here
        }
        cur = cur.parent ? emu.handles.get<WindowInfo>(cur.parent) : null;
      }
    }
    emu.memory.writeU32(rectPtr, sx | 0);
    emu.memory.writeU32(rectPtr + 4, sy | 0);
    emu.memory.writeU32(rectPtr + 8, (sx + wnd.width) | 0);
    emu.memory.writeU32(rectPtr + 12, (sy + wnd.height) | 0);
    return 1;
  });

  function adjustWindowRect(rectPtr: number, style: number, hasMenu: number): void {
    let bw = 0, captionH = 0, menuH = 0;
    if (style & WS_THICKFRAME) bw = 4;
    else if (style & WS_DLGFRAME) bw = 3;
    else if (style & WS_BORDER) bw = 1;
    if ((style & WS_CAPTION) === WS_CAPTION) captionH = 18;
    if (hasMenu) menuH = 19;
    emu.memory.writeU32(rectPtr, emu.memory.readI32(rectPtr) - bw);
    emu.memory.writeU32(rectPtr + 4, emu.memory.readI32(rectPtr + 4) - bw - captionH - menuH);
    emu.memory.writeU32(rectPtr + 8, emu.memory.readI32(rectPtr + 8) + bw);
    emu.memory.writeU32(rectPtr + 12, emu.memory.readI32(rectPtr + 12) + bw);
  }

  user32.register('AdjustWindowRectEx', 4, () => {
    const rectPtr = emu.readArg(0);
    adjustWindowRect(rectPtr, emu.readArg(1), emu.readArg(2));
    return 1;
  });

  user32.register('AdjustWindowRect', 3, () => {
    const rectPtr = emu.readArg(0);
    adjustWindowRect(rectPtr, emu.readArg(1), emu.readArg(2));
    return 1;
  });

  user32.register('SetRectEmpty', 1, () => {
    const ptr = emu.readArg(0);
    emu.memory.writeU32(ptr, 0);
    emu.memory.writeU32(ptr + 4, 0);
    emu.memory.writeU32(ptr + 8, 0);
    emu.memory.writeU32(ptr + 12, 0);
    return 1;
  });

  user32.register('SetRect', 5, () => {
    const ptr = emu.readArg(0);
    emu.memory.writeU32(ptr, emu.readArg(1));
    emu.memory.writeU32(ptr + 4, emu.readArg(2));
    emu.memory.writeU32(ptr + 8, emu.readArg(3));
    emu.memory.writeU32(ptr + 12, emu.readArg(4));
    return 1;
  });

  user32.register('OffsetRect', 3, () => {
    const ptr = emu.readArg(0);
    const dx = emu.readArg(1) | 0;
    const dy = emu.readArg(2) | 0;
    emu.memory.writeU32(ptr, (emu.memory.readI32(ptr) + dx) | 0);
    emu.memory.writeU32(ptr + 4, (emu.memory.readI32(ptr + 4) + dy) | 0);
    emu.memory.writeU32(ptr + 8, (emu.memory.readI32(ptr + 8) + dx) | 0);
    emu.memory.writeU32(ptr + 12, (emu.memory.readI32(ptr + 12) + dy) | 0);
    return 1;
  });

  user32.register('InflateRect', 3, () => {
    const ptr = emu.readArg(0);
    const dx = emu.readArg(1) | 0;
    const dy = emu.readArg(2) | 0;
    emu.memory.writeU32(ptr, (emu.memory.readI32(ptr) - dx) | 0);
    emu.memory.writeU32(ptr + 4, (emu.memory.readI32(ptr + 4) - dy) | 0);
    emu.memory.writeU32(ptr + 8, (emu.memory.readI32(ptr + 8) + dx) | 0);
    emu.memory.writeU32(ptr + 12, (emu.memory.readI32(ptr + 12) + dy) | 0);
    return 1;
  });

  user32.register('IntersectRect', 3, () => {
    const dstPtr = emu.readArg(0);
    const src1Ptr = emu.readArg(1);
    const src2Ptr = emu.readArg(2);
    const l = Math.max(emu.memory.readI32(src1Ptr), emu.memory.readI32(src2Ptr));
    const t = Math.max(emu.memory.readI32(src1Ptr + 4), emu.memory.readI32(src2Ptr + 4));
    const r = Math.min(emu.memory.readI32(src1Ptr + 8), emu.memory.readI32(src2Ptr + 8));
    const b = Math.min(emu.memory.readI32(src1Ptr + 12), emu.memory.readI32(src2Ptr + 12));
    if (l < r && t < b) {
      emu.memory.writeU32(dstPtr, l);
      emu.memory.writeU32(dstPtr + 4, t);
      emu.memory.writeU32(dstPtr + 8, r);
      emu.memory.writeU32(dstPtr + 12, b);
      return 1;
    }
    for (let i = 0; i < 16; i++) emu.memory.writeU8(dstPtr + i, 0);
    return 0;
  });

  user32.register('PtInRect', 3, () => {
    const rectPtr = emu.readArg(0);
    // POINT is passed as two DWORDs (x, y) — but on the stack it's pushed as two values
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const left = emu.memory.readI32(rectPtr);
    const top = emu.memory.readI32(rectPtr + 4);
    const right = emu.memory.readI32(rectPtr + 8);
    const bottom = emu.memory.readI32(rectPtr + 12);
    return (x >= left && x < right && y >= top && y < bottom) ? 1 : 0;
  });

  user32.register('CopyRect', 2, () => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    for (let i = 0; i < 16; i++) emu.memory.writeU8(dst + i, emu.memory.readU8(src + i));
    return 1;
  });

  user32.register('EqualRect', 2, () => {
    const r1 = emu.readArg(0);
    const r2 = emu.readArg(1);
    for (let i = 0; i < 16; i += 4) {
      if (emu.memory.readU32(r1 + i) !== emu.memory.readU32(r2 + i)) return 0;
    }
    return 1;
  });

  user32.register('IsRectEmpty', 1, () => {
    const ptr = emu.readArg(0);
    const left = emu.memory.readI32(ptr);
    const top = emu.memory.readI32(ptr + 4);
    const right = emu.memory.readI32(ptr + 8);
    const bottom = emu.memory.readI32(ptr + 12);
    return (right <= left || bottom <= top) ? 1 : 0;
  });

  // UnionRect(lprcDst, lprcSrc1, lprcSrc2) → BOOL
  // Compute union of two rectangles and write to destination
  user32.register('UnionRect', 3, () => {
    const dstPtr = emu.readArg(0);
    const src1Ptr = emu.readArg(1);
    const src2Ptr = emu.readArg(2);
    const l1 = emu.memory.readI32(src1Ptr);
    const t1 = emu.memory.readI32(src1Ptr + 4);
    const r1 = emu.memory.readI32(src1Ptr + 8);
    const b1 = emu.memory.readI32(src1Ptr + 12);
    const l2 = emu.memory.readI32(src2Ptr);
    const t2 = emu.memory.readI32(src2Ptr + 4);
    const r2 = emu.memory.readI32(src2Ptr + 8);
    const b2 = emu.memory.readI32(src2Ptr + 12);
    // Union is the bounding box of both rectangles
    emu.memory.writeU32(dstPtr, Math.min(l1, l2));
    emu.memory.writeU32(dstPtr + 4, Math.min(t1, t2));
    emu.memory.writeU32(dstPtr + 8, Math.max(r1, r2));
    emu.memory.writeU32(dstPtr + 12, Math.max(b1, b2));
    return 1;
  });
}
