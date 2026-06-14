// Diag: replicate the BROWSER layout (editor 936x553, preview frame at x=934)
// headless: screen 1310x814 -> CW_USEDEFAULT 85% = 1114x692 frame.
// Watch the boundary columns 934-935 for changes, dump the clipUpperSiblings
// exclusion list (__clipLog) for the editor, and probe whether scrollbar
// pixels land at (934,25)/(934,562).
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

const mainCanvas = mkCanvas(1310, 814);
globalThis.document = { createElement: () => mkCanvas(1310, 814), title: '' };
globalThis.OffscreenCanvas = class { constructor(w, h) { return mkCanvas(w, h); } };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.Image = class { set src(_) {} };
globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: noop };
globalThis.Blob = class { constructor() {} };

const EXE = 'C:/Users/Olivier/Downloads/PabloDraw-2.0.8.70/PabloDraw.exe';
const fb = readFileSync(EXE); const ab = new ArrayBuffer(fb.byteLength); new Uint8Array(ab).set(fb);
const peInfo = parsePE(ab);
const emu = new Emulator(); emu.screenWidth = 1310; emu.screenHeight = 814;
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
await pump(1000);

console.log = ol;
const ed = emu.handles.get(0x1015);
ol(`editor 0x1015: @${ed.x},${ed.y} ${ed.width}x${ed.height}`);
const main = emu.handles.get(emu.mainWindow);
for (const c of main.childList) {
  const w = emu.handles.get(c);
  ol(`  child 0x${c.toString(16)} ${(w.classInfo?.className || '?').slice(0, 16)} v=${w.visible} @${w.x},${w.y} ${w.width}x${w.height}`);
}
console.log = noop;

const out = emu.canvasCtx?.canvas || mainCanvas;
const octx = out.getContext('2d');
function px(x, y) {
  const d = octx.getImageData(x, y, 1, 1).data;
  return `#${d[0].toString(16).padStart(2, '0')}${d[1].toString(16).padStart(2, '0')}${d[2].toString(16).padStart(2, '0')}`;
}

// Watch the boundary for 3s: log probe colors every 100ms when they change
console.log = ol;
ol('=== probe (934,25) & (934,562) every 100ms for 3s ===');
console.log = noop;
let p1 = '', p2 = '';
for (let k = 0; k < 30; k++) {
  await pump(100);
  const n1 = px(934, 25), n2 = px(934, 562);
  if (n1 !== p1 || n2 !== p2) {
    console.log = ol;
    ol(`t=${k * 100}ms  top=${n1}  bottom=${n2}`);
    console.log = noop;
    p1 = n1; p2 = n2;
  }
}
console.log = ol;
const clipLog = globalThis.__clipLog || {};
ol(`__clipLog[1015] = ${clipLog['1015'] || 'NEVER SET'}`);
ol(`__clipLog keys = ${Object.keys(clipLog).join(',')}`);
process.exit(0);
