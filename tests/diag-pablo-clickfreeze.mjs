// Diag: does the screen still UPDATE after the z-order clipping fix?
// Real @napi-rs/canvas + realtime pump. Measures pixel diffs:
//   A vs A2 : pure idle 1s apart (caret blink should change pixels)
//   A2 vs B : after a real-path click (windowFromPoint) in the editor
//   B vs C  : after typing a char
import { readFileSync, writeFileSync } from 'fs';
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
console.log = ol;
ol(`=== msg loop @ ${t} ticks ===`);
console.log = noop;

async function pump(ms) {
  const T0 = performance.now();
  while (performance.now() - T0 < ms) {
    await delay(5);
    let p = 0;
    while (p < 20_000 && !emu.halted) { emu.tick(); p++; }
  }
}
const out = emu.canvasCtx?.canvas || mainCanvas;
function snap() {
  const d = out.getContext('2d').getImageData(0, 0, out.width, out.height).data;
  return new Uint8ClampedArray(d); // copy
}
function diff(a, b, label) {
  let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  const W = out.width;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
      n++;
      const px = (i >> 2) % W, py = ((i >> 2) / W) | 0;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
  }
  ol(`${label}: ${n} px differ${n ? ` in (${minX},${minY})-(${maxX},${maxY})` : ''}`);
  return n;
}

await pump(1200);
const A = snap();
await pump(1200);
const A2 = snap();
console.log = ol;
diff(A, A2, 'IDLE 1.2s apart (expect caret blink)');
console.log = noop;

// Real input path, like the browser: cursor cache + windowFromPoint + post.
const WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
const WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102;
const MK_LBUTTON = 0x0001;
const cx = 400, cy = 300; // inside the editor view
emu.cursorX = cx; emu.cursorY = cy;
let hit = emu.windowFromPoint(cx, cy);
console.log = ol;
ol(`windowFromPoint(${cx},${cy}) -> hwnd=0x${hit.hwnd.toString(16)} local=(${hit.x},${hit.y})  capture=0x${(emu.capturedWindow || 0).toString(16)}`);
console.log = noop;
emu.postMessage(hit.hwnd, WM_MOUSEMOVE, 0, (hit.y << 16) | hit.x);
emu.postMessage(hit.hwnd, WM_LBUTTONDOWN, MK_LBUTTON, (hit.y << 16) | hit.x);
await pump(300);
hit = emu.capturedWindow ? hit : emu.windowFromPoint(cx, cy);
emu.postMessage(emu.capturedWindow || hit.hwnd, WM_LBUTTONUP, 0, (hit.y << 16) | hit.x);
await pump(1200);
const B = snap();
console.log = ol;
diff(A2, B, 'after CLICK in editor (400,300)');
ol(`focusWindow=0x${(emu.focusWindow || 0).toString(16)} capture=0x${(emu.capturedWindow || 0).toString(16)}`);
console.log = noop;

// Type a char into the focused window (or the editor if no focus).
const target = emu.focusWindow || 0x1015;
emu.postMessage(target, WM_KEYDOWN, 0x41, 0x001E0001);
emu.postMessage(target, WM_CHAR, 0x41, 0x001E0001);
emu.postMessage(target, WM_KEYUP, 0x41, 0xC01E0001);
await pump(1200);
const C = snap();
console.log = ol;
diff(B, C, `after typing 'A' to 0x${target.toString(16)}`);

writeFileSync('tests/_freeze_A.png', out.toBuffer('image/png'));
ol('=== done ===');
process.exit(0);
