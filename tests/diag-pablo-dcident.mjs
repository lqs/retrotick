// Diag: at paint time, which canvas does each window DC actually target?
// Wraps SetDIBitsToDevice/InvertRect/BitBlt handlers to dump the DC identity
// (main canvas vs detached OffscreenCanvas), current transform and hwnd.
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
ol(`=== msg loop @ ${t} ===`);

async function pump(ms) {
  const T0 = performance.now();
  while (performance.now() - T0 < ms) {
    await delay(5);
    let p = 0;
    while (p < 20_000 && !emu.halted) { emu.tick(); p++; }
  }
}

const lines = [];
function dumpDC(api) {
  const hdc = emu.readArg(0);
  const dc = emu.handles.get(hdc);
  if (!dc) { lines.push(`${api} hdc=0x${hdc.toString(16)} NO DC`); return; }
  const cv = dc.canvas;
  const isMain = cv === (emu.canvasCtx ? emu.canvasCtx.canvas : null) || cv === mainCanvas;
  let tf = '?', e = 0, f = 0;
  try { const m = dc.ctx.getTransform(); tf = `${m.a},${m.b},${m.c},${m.d},${m.e},${m.f}`; e = m.e; f = m.f; } catch {}
  // Clip probe: fill a test pixel THROUGH the current state, read it back in
  // device coords (getImageData ignores clip), check it landed.
  let probe = 'n/a';
  if (cv && dc.ctx.getImageData) {
    try {
      const lx = 10, ly = 10; // local coords inside the window
      const px = Math.round(e + lx), py = Math.round(f + ly);
      const before = dc.ctx.getImageData(px, py, 1, 1).data.slice(0, 3).join(',');
      const oldFill = dc.ctx.fillStyle;
      dc.ctx.fillStyle = '#ff00fe';
      dc.ctx.fillRect(lx, ly, 1, 1);
      const after = dc.ctx.getImageData(px, py, 1, 1).data;
      dc.ctx.fillStyle = oldFill;
      probe = (after[0] === 255 && after[1] === 0 && after[2] === 254) ? 'CLIP-OK' : `CLIP-BLOCKED(was ${before}, now ${after[0]},${after[1]},${after[2]})`;
    } catch (err) { probe = `err:${err.message}`; }
  }
  lines.push(`${api} hdc=0x${hdc.toString(16)} hwnd=0x${(dc.hwnd || 0).toString(16)} canvas=${isMain ? 'MAIN' : (cv ? `OFF(${cv.width}x${cv.height})` : 'NONE')} tf=[${tf}] ${probe}`);
}
// Special: measure InvertRect's REAL pixel effect on the output canvas
{
  const def = emu.apiDefs.get('USER32.DLL:InvertRect');
  const orig = def.handler;
  def.handler = () => {
    const hdc = emu.readArg(0);
    const rectPtr = emu.readArg(1);
    const dc = emu.handles.get(hdc);
    const l = emu.memory.readI32(rectPtr), tp = emu.memory.readI32(rectPtr + 4);
    const rr = emu.memory.readI32(rectPtr + 8), bb = emu.memory.readI32(rectPtr + 12);
    let e = 0, f = 0;
    try { const m = dc.ctx.getTransform(); e = m.e; f = m.f; } catch {}
    const octx = ((emu.canvasCtx && emu.canvasCtx.canvas) || mainCanvas).getContext('2d');
    const px = Math.max(0, Math.round(e + l)), py = Math.max(0, Math.round(f + tp));
    const w = Math.max(1, rr - l), h = Math.max(1, bb - tp);
    const before = octx.getImageData(px, py, w, h).data;
    const r = orig();
    const after = octx.getImageData(px, py, w, h).data;
    let n = 0;
    for (let i = 0; i < before.length; i += 4) if (before[i] !== after[i] || before[i + 1] !== after[i + 1] || before[i + 2] !== after[i + 2]) n++;
    lines.push(`InvertRect rect=(${l},${tp})-(${rr},${bb}) dev=(${px},${py}) ${w}x${h} -> ${n}px changed on MAIN`);
    return r;
  };
}
for (const name of ['GDI32.DLL:SetDIBitsToDevice', 'GDI32.DLL:BitBlt', 'GDI32.DLL:StretchDIBits', 'USER32.DLL:BeginPaint', 'USER32.DLL:EndPaint', 'USER32.DLL:GetDC', 'USER32.DLL:GetWindowDC', 'USER32.DLL:ReleaseDC']) {
  const def = emu.apiDefs.get(name);
  if (!def) { ol(`no def: ${name}`); continue; }
  const orig = def.handler;
  const short = name.split(':')[1];
  if (short === 'BeginPaint' || short === 'GetDC' || short === 'GetWindowDC') {
    def.handler = () => {
      const hwnd = emu.readArg(0);
      const r = orig();
      lines.push(`${short}(hwnd=0x${hwnd.toString(16)}) -> hdc=0x${(r >>> 0).toString(16)}`);
      return r;
    };
  } else {
    def.handler = () => { dumpDC(short); return orig(); };
  }
}

// Capture one full timer-paint cycle at idle
lines.length = 0;
await pump(450);
ol(`=== idle 450ms DC activity (${lines.length}) ===`);
for (const l of lines.slice(0, 60)) ol(l);

// Now a click
const WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
const cx = 400, cy = 300;
emu.cursorX = cx; emu.cursorY = cy;
const hit = emu.windowFromPoint(cx, cy);
lines.length = 0;
emu.postMessage(hit.hwnd, WM_MOUSEMOVE, 0, (hit.y << 16) | hit.x);
emu.postMessage(hit.hwnd, WM_LBUTTONDOWN, 1, (hit.y << 16) | hit.x);
emu.postMessage(hit.hwnd, WM_LBUTTONUP, 0, (hit.y << 16) | hit.x);
await pump(450);
ol(`=== post-click 450ms DC activity (${lines.length}) ===`);
for (const l of lines.slice(0, 60)) ol(l);
process.exit(0);
