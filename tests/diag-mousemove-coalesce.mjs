// Unit check: WM_MOUSEMOVE coalescing in Emulator.postMessage.
import { Emulator } from '../src/lib/emu/emulator.ts';
const WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
const emu = new Emulator();
// 100 raw moves to the same hwnd -> 1 queued entry holding the LAST coords
for (let i = 0; i < 100; i++) emu.postMessage(0x1015, WM_MOUSEMOVE, 0, (i << 16) | i);
console.log('after 100 moves: queue =', emu.messageQueue.length, 'lParam =', emu.messageQueue[0].lParam.toString(16));
// A click between moves must keep ordering: move, down, move(coalesced), up
emu.postMessage(0x1015, WM_LBUTTONDOWN, 1, 0x50005);
for (let i = 0; i < 50; i++) emu.postMessage(0x1015, WM_MOUSEMOVE, 1, 0x60006 + i);
emu.postMessage(0x1015, WM_LBUTTONUP, 0, 0x70007);
console.log('sequence:', emu.messageQueue.map(m => '0x' + m.message.toString(16)).join(','));
const ok = emu.messageQueue.length === 4 &&
  emu.messageQueue[0].message === WM_MOUSEMOVE && emu.messageQueue[0].lParam === ((99 << 16) | 99) &&
  emu.messageQueue[1].message === WM_LBUTTONDOWN &&
  emu.messageQueue[2].message === WM_MOUSEMOVE && emu.messageQueue[2].lParam === 0x60006 + 49 &&
  emu.messageQueue[3].message === WM_LBUTTONUP;
console.log(ok ? '[TEST] SUCCESS: coalescing + ordering correct' : '[TEST] FAIL');
process.exit(ok ? 0 : 1);
