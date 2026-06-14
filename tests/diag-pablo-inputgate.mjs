// Diag: after PabloDraw reaches its message loop, are the browser-side input
// gates (emu.dialogState / emu.messageBoxes) blocking pointer events?
// Also: phase-robust pixel sampling (every 100ms) to tell "frozen" from
// "caret-phase aliasing" in earlier snapshots.
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
console.log = ol;
ol(`=== msg loop @ ${t} ===`);
ol(`dialogState = ${emu.dialogState ? JSON.stringify({ hwnd: emu.dialogState.hwnd, ended: emu.dialogState.ended }) : 'null'}`);
ol(`messageBoxes = ${emu.messageBoxes ? emu.messageBoxes.length : '?'}`);
ol(`capturedWindow = 0x${(emu.capturedWindow || 0).toString(16)}`);
ol(`mainWindow = 0x${(emu.mainWindow || 0).toString(16)}`);
console.log = noop;

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
ol(`after 800ms pump: dialogState=${emu.dialogState ? 'SET hwnd=0x' + emu.dialogState.hwnd.toString(16) : 'null'} messageBoxes=${emu.messageBoxes.length}`);
console.log = noop;

// Phase-robust sampler: snapshot every 100ms over 1.5s, count frames that
// differ from the previous one.
const out = emu.canvasCtx?.canvas || mainCanvas;
const octx = out.getContext('2d');
function snap() { return new Uint8ClampedArray(octx.getImageData(0, 0, out.width, out.height).data); }
function npx(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  return n;
}
let prev = snap(); let changes = [];
for (let k = 0; k < 15; k++) {
  await pump(100);
  const cur = snap();
  changes.push(npx(prev, cur));
  prev = cur;
}
console.log = ol;
ol(`idle 100ms-frame diffs: [${changes.join(',')}]`);
console.log = noop;

// Click in editor through the SAME gates the browser applies
const WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
const blocked = (emu.messageBoxes.length > 0) || !!emu.dialogState;
const cx = 400, cy = 300;
emu.cursorX = cx; emu.cursorY = cy;
const hit = emu.windowFromPoint(cx, cy);
emu.postMessage(hit.hwnd, WM_MOUSEMOVE, 0, (hit.y << 16) | hit.x);
emu.postMessage(hit.hwnd, WM_LBUTTONDOWN, 1, (hit.y << 16) | hit.x);
emu.postMessage(hit.hwnd, WM_LBUTTONUP, 0, (hit.y << 16) | hit.x);
prev = snap(); changes = [];
for (let k = 0; k < 15; k++) {
  await pump(100);
  const cur = snap();
  changes.push(npx(prev, cur));
  prev = cur;
}
console.log = ol;
ol(`browser gate would have BLOCKED this click: ${blocked}`);
ol(`post-click 100ms-frame diffs: [${changes.join(',')}]`);
process.exit(0);
