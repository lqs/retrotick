// Diag: click in the editor (with WM_MOUSEACTIVATE like the browser now sends)
// must give focus to the view (emu.focusedWindow), and a WM_CHAR routed to the
// focused window must paint the typed character (pixel diff >> caret blink).
import { readFileSync } from 'fs';
import { setTimeout as delay } from 'timers/promises';
import { createCanvas } from '@napi-rs/canvas';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

const noop = () => {};
function wrap(c) {
  c.addEventListener = noop; c.removeEventListener = noop;
  c.style = { cursor: 'default' };
  c.parentElement = { style: { cursor: 'default' } };
  c.toDataURL = () => '';
  return c;
}
function mkCanvas(w, h) { return wrap(createCanvas(Math.max(1, w | 0) || 1, Math.max(1, h | 0) || 1)); }

const mainCanvas = mkCanvas(1024, 768);
globalThis.document = { createElement: () => mkCanvas(1024, 768), title: '' };
globalThis.OffscreenCanvas = class { constructor(w, h) { return mkCanvas(w, h); } };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.Image = class { set src(_) {} };
globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: noop };
globalThis.Blob = class { constructor() {} };

const EXE = 'C:/Users/Olivier/Downloads/PabloDraw-2.0.8.70/PabloDraw.exe';
const fb = readFileSync(EXE); const ab = new ArrayBuffer(fb.byteLength); new Uint8Array(ab).set(fb);
const peInfo = parsePE(ab);
const emu = new Emulator(); emu.screenWidth = 1024; emu.screenHeight = 768;
emu.registryStore = new RegistryStore(); emu.profileStore = new ProfileStore();

const ol = console.log.bind(console); console.log = noop;
await emu.load(ab, peInfo, mainCanvas); emu.run();
let t = 0, le = 0, st = 0;
while (!emu.waitingForMessage && !emu.halted && t < 2_000_000) {
  emu.tick(); t++;
  if (emu.cpu.eip === le) st++; else { st = 0; le = emu.cpu.eip; }
  if (st > 5000) break;
}
async function pump(ms) {
  const T0 = performance.now();
  while (performance.now() - T0 < ms) {
    await delay(5);
    let p = 0;
    while (p < 20_000 && !emu.halted) { emu.tick(); p++; }
  }
}
await pump(800);
console.log = ol;
ol(`=== msg loop @ ${t}; focusedWindow before click = 0x${(emu.focusedWindow || 0).toString(16)} ===`);
console.log = noop;

const out = emu.canvasCtx?.canvas || mainCanvas;
const octx = out.getContext('2d');
function snap() { return new Uint8ClampedArray(octx.getImageData(0, 0, out.width, out.height).data); }
function npx(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  return n;
}

// Click like the browser now does: WM_MOUSEACTIVATE then the button pair.
const WM_MOUSEACTIVATE = 0x0021, HTCLIENT = 1;
const WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
const WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102;
const cx = 200, cy = 200;
emu.cursorX = cx; emu.cursorY = cy;
const hit = emu.windowFromPoint(cx, cy);
emu.postMessage(hit.hwnd, WM_MOUSEACTIVATE, emu.mainWindow, (WM_LBUTTONDOWN << 16) | HTCLIENT);
emu.postMessage(hit.hwnd, WM_MOUSEMOVE, 0, (hit.y << 16) | hit.x);
emu.postMessage(hit.hwnd, WM_LBUTTONDOWN, 1, (hit.y << 16) | hit.x);
emu.postMessage(hit.hwnd, WM_LBUTTONUP, 0, (hit.y << 16) | hit.x);
await pump(600);
console.log = ol;
ol(`clicked 0x${hit.hwnd.toString(16)} at (${cx},${cy}); focusedWindow = 0x${(emu.focusedWindow || 0).toString(16)}`);
console.log = noop;

// Type 'A' like EmulatorView: target = focusedWindow || mainWindow
const target = emu.focusedWindow || emu.mainWindow;
const before = snap();
emu.postMessage(target, WM_KEYDOWN, 0x41, 1 | (0x1E << 16));
emu.postMessage(target, WM_CHAR, 0x41, 1 | (0x1E << 16));
emu.postMessage(target, WM_KEYUP, 0x41, 1 | (0x1E << 16) | (3 << 30));
await pump(600);
const after = snap();
console.log = ol;
ol(`typed 'A' to 0x${target.toString(16)} -> ${npx(before, after)} px changed (caret blink alone = ~16)`);
process.exit(0);
