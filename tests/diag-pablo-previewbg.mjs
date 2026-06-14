// Diag: preview pane grey-background issue.
// 1) Dump WS_CLIPCHILDREN on the dock frames and preview windows.
// 2) Probe preview interior pixels over time: black (inner view erase) or
//    grey (frame erase painting over its child)?
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
const WS_CLIPCHILDREN = 0x02000000;
const WS_CLIPSIBLINGS = 0x04000000;
for (const h of [0x1010, 0x1015, 0x102a, 0x102b, 0x102c, 0x102d, 0x1037, 0x105f]) {
  const w = emu.handles.get(h);
  if (!w) { ol(`0x${h.toString(16)}: gone`); continue; }
  ol(`0x${h.toString(16)} ${(w.classInfo?.className || '?').slice(0, 16)} style=0x${(w.style >>> 0).toString(16)} CLIPCHILDREN=${!!(w.style & WS_CLIPCHILDREN)} CLIPSIBLINGS=${!!(w.style & WS_CLIPSIBLINGS)} hbrBg=0x${(w.classInfo?.hbrBackground >>> 0 || 0).toString(16)}`);
}
console.log = noop;

const out = emu.canvasCtx?.canvas || mainCanvas;
const octx = out.getContext('2d');
function px(x, y) {
  const d = octx.getImageData(x, y, 1, 1).data;
  return `#${d[0].toString(16).padStart(2, '0')}${d[1].toString(16).padStart(2, '0')}${d[2].toString(16).padStart(2, '0')}`;
}
// Preview interior probes: inner view spans roughly (935..1105, 40..570)
console.log = ol;
ol('=== preview interior probes every 200ms for 3s (expect black #000000) ===');
console.log = noop;
let prev = '';
for (let k = 0; k < 15; k++) {
  await pump(200);
  const s = `mid=${px(1000, 300)} top=${px(1000, 60)} bot=${px(1000, 550)}`;
  if (s !== prev) {
    console.log = ol; ol(`t=${k * 200}ms  ${s}`); console.log = noop;
    prev = s;
  }
}

// Force a MAIN repaint (browser scenario: overlays/toolbar set main.needsPaint
// constantly) — renderChildControls then re-arms all custom children with
// needsErase=true, making the preview FRAME erase BTNFACE over its inner view.
console.log = ol;
ol('=== forcing main repaint cycles (browser scenario) ===');
console.log = noop;
const main = emu.handles.get(emu.mainWindow);
for (let cycle = 0; cycle < 5; cycle++) {
  main.needsPaint = true; main.needsErase = true;
  await pump(300);
  const s = `mid=${px(1000, 300)} top=${px(1000, 60)} bot=${px(1000, 550)}`;
  console.log = ol; ol(`cycle ${cycle}: ${s}`); console.log = noop;
}
process.exit(0);
