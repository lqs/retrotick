import type { Emulator } from '../../emulator';
import type { WindowInfo } from './types';

const SIF_RANGE = 0x0001;
const SIF_PAGE = 0x0002;
const SIF_POS = 0x0004;
const SIF_TRACKPOS = 0x0010;
const SIF_ALL = SIF_RANGE | SIF_PAGE | SIF_POS | SIF_TRACKPOS;

interface ScrollState {
  nMin: number;
  nMax: number;
  nPage: number;
  nPos: number;
  nTrackPos: number;
}

function getScrollKey(hwnd: number, nBar: number): string {
  return `${hwnd}:${nBar}`;
}

export function registerScroll(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');
  const { memory } = emu;
  const scrollStates = new Map<string, ScrollState>();

  // SB_HORZ=0, SB_VERT=1, SB_CTL=2
  function getState(hwnd: number, nBar: number): ScrollState {
    const key = getScrollKey(hwnd, nBar);
    let state = scrollStates.get(key);
    if (!state) {
      state = { nMin: 0, nMax: 0, nPage: 0, nPos: 0, nTrackPos: 0 };
      scrollStates.set(key, state);
    }
    // Mirror the SAME object onto the WindowInfo so the non-client scrollbar
    // renderer sees live updates (nBar 0=horz, 1=vert).
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (wnd) {
      if (nBar === 0 && wnd.scrollH !== state) wnd.scrollH = state;
      else if (nBar === 1 && wnd.scrollV !== state) wnd.scrollV = state;
    }
    return state;
  }

  // SetScrollPos(hWnd, nBar, nPos, bRedraw) -> int oldPos
  user32.register('SetScrollPos', 4, () => {
    const hwnd = emu.readArg(0), nBar = emu.readArg(1), nPos = emu.readArg(2);
    const state = getState(hwnd, nBar);
    const old = state.nPos;
    state.nPos = nPos | 0;
    return old;
  });

  // GetScrollPos(hWnd, nBar) -> int
  user32.register('GetScrollPos', 2, () => {
    const hwnd = emu.readArg(0), nBar = emu.readArg(1);
    return getState(hwnd, nBar).nPos;
  });

  // SetScrollInfo(hWnd, nBar, lpsi, bRedraw) -> int
  user32.register('SetScrollInfo', 4, () => {
    const hwnd = emu.readArg(0), nBar = emu.readArg(1), lpsi = emu.readArg(2);
    const fMask = memory.readU32(lpsi + 4);
    const state = getState(hwnd, nBar);
    if (fMask & SIF_RANGE) {
      state.nMin = memory.readI32(lpsi + 8);
      state.nMax = memory.readI32(lpsi + 12);
    }
    if (fMask & SIF_PAGE) state.nPage = memory.readU32(lpsi + 16);
    if (fMask & SIF_POS) state.nPos = memory.readI32(lpsi + 20);
    return state.nPos;
  });

  // GetScrollInfo(hWnd, nBar, lpsi) -> BOOL
  user32.register('GetScrollInfo', 3, () => {
    const hwnd = emu.readArg(0), nBar = emu.readArg(1), lpsi = emu.readArg(2);
    const fMask = memory.readU32(lpsi + 4);
    const state = getState(hwnd, nBar);
    if (fMask & SIF_RANGE) {
      memory.writeU32(lpsi + 8, state.nMin);
      memory.writeU32(lpsi + 12, state.nMax);
    }
    if (fMask & SIF_PAGE) memory.writeU32(lpsi + 16, state.nPage);
    if (fMask & SIF_POS) memory.writeU32(lpsi + 20, state.nPos);
    if (fMask & SIF_TRACKPOS) memory.writeU32(lpsi + 24, state.nTrackPos);
    return 1;
  });

  // SetScrollRange(hWnd, nBar, nMinPos, nMaxPos, bRedraw) -> BOOL
  user32.register('SetScrollRange', 5, () => {
    const hwnd = emu.readArg(0), nBar = emu.readArg(1), nMinPos = emu.readArg(2), nMaxPos = emu.readArg(3);
    const state = getState(hwnd, nBar);
    state.nMin = nMinPos | 0;
    state.nMax = nMaxPos | 0;
    return 1;
  });

  // GetScrollRange(hWnd, nBar, lpMinPos, lpMaxPos) -> BOOL
  user32.register('GetScrollRange', 4, () => {
    const hwnd = emu.readArg(0), nBar = emu.readArg(1), lpMinPos = emu.readArg(2), lpMaxPos = emu.readArg(3);
    const state = getState(hwnd, nBar);
    memory.writeU32(lpMinPos, state.nMin);
    memory.writeU32(lpMaxPos, state.nMax);
    return 1;
  });

  user32.register('ScrollWindow', 5, () => 1);
  user32.register('ShowScrollBar', 3, () => 1);
  user32.register('EnableScrollBar', 3, () => 1);
}
