import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

// Strict mock: throw on invalid args like a real browser canvas, so we can
// catch GDI calls passing zero/negative dimensions (silently OK in noop mock).
const noop = () => {};
let lastThrow = null;
function makeCtx(canvas) {
  const ctx = {
    fillRect: noop, clearRect: noop, strokeRect: noop,
    fillText: noop, strokeText: noop, measureText: () => ({ width: 8 }),
    drawImage(img, ...rest) {
      // Real canvas throws InvalidStateError if source image has 0 w/h,
      // or IndexSizeError if sw/sh is 0.
      const iw = img?.width, ih = img?.height;
      if (iw === 0 || ih === 0) throw new Error(`drawImage: source ${iw}x${ih} (InvalidStateError)`);
      // signatures: drawImage(img, dx,dy) | (img,dx,dy,dw,dh) | (img,sx,sy,sw,sh,dx,dy,dw,dh)
      if (rest.length === 8) {
        const [sx, sy, sw, sh] = rest;
        if (sw === 0 || sh === 0) throw new Error(`drawImage: source rect sw=${sw} sh=${sh} (IndexSizeError)`);
      }
    },
    putImageData: noop,
    getImageData(x, y, w, h) {
      if (w <= 0 || h <= 0) throw new Error(`getImageData: w=${w} h=${h} (IndexSizeError)`);
      return { data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h };
    },
    createImageData(w, h) {
      if (w <= 0 || h <= 0 || !Number.isFinite(w) || !Number.isFinite(h)) throw new Error(`createImageData: w=${w} h=${h} (IndexSizeError)`);
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
    },
    save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
    setTransform: noop, resetTransform: noop, transform: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, arcTo: noop, rect: noop, ellipse: noop,
    fill: noop, stroke: noop, clip: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    font: '', textAlign: 'left', textBaseline: 'top',
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true, shadowBlur: 0, shadowColor: 'transparent',
    canvas,
  };
  return ctx;
}
function makeCanvas(w, h) {
  const c = {
    width: w ?? 800, height: h ?? 600,
    toDataURL: () => 'data:image/png;base64,',
    addEventListener: noop, removeEventListener: noop,
    style: { cursor: 'default' },
    parentElement: { style: { cursor: 'default' } },
  };
  c.getContext = () => makeCtx(c);
  return c;
}
const mockCanvas = makeCanvas(800, 600);
globalThis.document = { createElement: () => makeCanvas(800, 600), title: '' };
globalThis.OffscreenCanvas = class { constructor(w, h) { Object.assign(this, makeCanvas(w, h)); this.width = w; this.height = h; } };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.Image = class { set src(_) {} };
globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: noop };
globalThis.Blob = class { constructor() {} };

const EXE_PATH = 'C:/Users/Olivier/Downloads/PabloDraw-2.0.8.70/PabloDraw.exe';
const buf = readFileSync(EXE_PATH);
const ab = new ArrayBuffer(buf.byteLength);
new Uint8Array(ab).set(buf);
const peInfo = parsePE(ab);

const emu = new Emulator();
emu.screenWidth = 1024;
emu.screenHeight = 768;
emu.registryStore = new RegistryStore();
emu.profileStore = new ProfileStore();

const caught = [];
const origLog = console.log;
console.log = () => {};
await emu.load(ab, peInfo, mockCanvas);
emu.run();

const MAX = 2_000_000;
let ticks = 0, lastEip = 0, stuck = 0;
while (!emu.waitingForMessage && !emu.halted && ticks < MAX) {
  try { emu.tick(); } catch (e) { caught.push(`load-tick ${ticks}: ${e.message}`); break; }
  ticks++;
  if (emu.cpu.eip === lastEip) stuck++; else { stuck = 0; lastEip = emu.cpu.eip; }
  if (stuck > 5000) break;
}
console.log = origLog;
console.log(`Reached msg loop after ${ticks} ticks (waiting=${emu.waitingForMessage})`);

function markPaint(hwnd) {
  const w = emu.handles.get(hwnd);
  if (!w) return;
  w.needsPaint = true; w.needsErase = true;
  if (w.childList) for (const ch of w.childList) markPaint(ch);
}
markPaint(emu.mainWindow);

console.log = () => {};
let pump = 0;
const WM_SIZE = 0x0005;
emu.postMessage(emu.mainWindow, WM_SIZE, 0, (576 << 16) | 768);
while (pump < 600_000 && !emu.halted && caught.length === 0) {
  try { emu.tick(); } catch (e) {
    caught.push(`pump-tick ${pump} eip=0x${emu.cpu.eip.toString(16)}: ${e.message}`);
    break;
  }
  pump++;
  if (pump % 80_000 === 0) markPaint(emu.mainWindow);
}
console.log = origLog;
console.log(`Pumped ${pump}. halted=${emu.halted} reason=${emu.cpu.haltReason || 'none'}`);
console.log(`Exceptions caught: ${caught.length}`);
for (const c of caught) console.log('  ' + c);

// Also directly exercise renderChildControls / the per-window render with strict ctx
console.log('\n-- Direct renderChildControls with strict ctx --');
try {
  emu.renderChildControls?.(emu.mainWindow);
  console.log('  renderChildControls OK');
} catch (e) {
  console.log('  THREW: ' + e.message + '\n' + (e.stack||'').split('\n').slice(0,6).join('\n'));
}
process.exit(0);
