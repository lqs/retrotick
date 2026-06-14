import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

const noop = () => {};
const mockCtx = {
  fillRect: noop, clearRect: noop, strokeRect: noop,
  fillText: noop, strokeText: noop, measureText: () => ({ width: 8 }),
  drawImage: noop, putImageData: noop, getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
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
  canvas: null,
};
const mockCanvas = {
  width: 800, height: 600,
  getContext: () => mockCtx,
  toDataURL: () => 'data:image/png;base64,',
  addEventListener: noop, removeEventListener: noop,
  style: { cursor: 'default' },
  parentElement: { style: { cursor: 'default' } },
};
mockCtx.canvas = mockCanvas;
globalThis.document = { createElement: () => mockCanvas, title: '' };
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { ...mockCtx, canvas: this }; } };
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

// Capture DIV ERROR warnings
const divErrors = [];
const origWarn = console.warn.bind(console);
console.warn = (...args) => {
  const s = args.join(' ');
  if (s.includes('[DIV ERROR]')) divErrors.push(s);
  origWarn(...args);
};

const origLog = console.log;
console.log = () => {};
await emu.load(ab, peInfo, mockCanvas);
emu.run();

const MAX = 2_000_000;
let ticks = 0, lastEip = 0, stuck = 0;
while (!emu.waitingForMessage && !emu.halted && ticks < MAX) {
  emu.tick();
  ticks++;
  if (emu.cpu.eip === lastEip) stuck++; else { stuck = 0; lastEip = emu.cpu.eip; }
  if (stuck > 5000) break;
}
console.log = origLog;
console.log(`Reached msg loop after ${ticks} ticks (waiting=${emu.waitingForMessage} halted=${emu.halted})`);

// Mark all windows for repaint, then pump so WM_PAINT is dispatched to each wndProc
function markPaint(hwnd) {
  const w = emu.handles.get(hwnd);
  if (!w) return;
  w.needsPaint = true;
  w.needsErase = true;
  if (w.childList) for (const ch of w.childList) markPaint(ch);
}
markPaint(emu.mainWindow);

console.log('\n-- Pumping with paint/size to trigger view render --');
console.log = () => {};
let pump = 0;
const WM_SIZE = 0x0005, WM_PAINT = 0x000F, WM_TIMER = 0x0113;
// Post a WM_SIZE to the main frame & view to force layout recompute
emu.postMessage(emu.mainWindow, WM_SIZE, 0, (576 << 16) | 768);
while (pump < 1_000_000 && !emu.halted && divErrors.length === 0) {
  emu.tick();
  pump++;
  // Periodically re-mark paint to keep the render loop active
  if (pump % 100_000 === 0) markPaint(emu.mainWindow);
}
console.log = origLog;
console.log(`Pumped ${pump} ticks. halted=${emu.halted} reason=${emu.cpu.haltReason || 'none'}`);
console.log(`DIV ERRORS captured: ${divErrors.length}`);
for (const e of divErrors) console.log('  ' + e);
process.exit(0);
