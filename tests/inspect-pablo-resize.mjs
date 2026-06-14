import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';

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

const origLog = console.log;
console.log = () => {};
await emu.load(ab, peInfo, mockCanvas);
emu.run();

let ticks = 0, lastEip = 0, stuck = 0;
while (!emu.waitingForMessage && !emu.halted && ticks < 2_000_000) {
  emu.tick();
  ticks++;
  if (emu.cpu.eip === lastEip) stuck++; else { stuck = 0; lastEip = emu.cpu.eip; }
  if (stuck > 5000) break;
}
console.log = origLog;
console.log(`Reached msg loop after ${ticks} ticks`);

function dumpSizes(label) {
  console.log(`\n=== ${label} ===`);
  const main = emu.handles.get(emu.mainWindow);
  console.log(`MainFrame: ${main.width}x${main.height}`);
  function rec(hwnd, depth) {
    const w = emu.handles.get(hwnd);
    if (!w) return;
    const indent = '  '.repeat(depth);
    const cn = w.classInfo?.className?.substring(0, 30) || '?';
    console.log(`${indent}0x${hwnd.toString(16)} ${cn.padEnd(34)} vis=${w.visible ? 'Y' : 'N'} pos=(${w.x},${w.y}) size=${w.width}x${w.height}`);
    if (w.childList) for (const ch of w.childList) rec(ch, depth + 1);
  }
  if (main.childList) for (const ch of main.childList) rec(ch, 1);
}

dumpSizes('BEFORE RESIZE (initial)');

// Simulate user resize: enlarge MainFrame from 768x576 to 1000x700
const main = emu.handles.get(emu.mainWindow);
main.width = 1000;
main.height = 700;
const cw = 1000 - 8;  // approximate client width
const ch = 700 - 8 - 19 - 19;  // - border - caption - menu
const WM_SIZE = 0x0005;
console.log(`\n[TEST] Sending WM_SIZE to MainFrame, client=${cw}x${ch}`);

// Process WM_SIZE synchronously via callWndProc
const wnd = main;
const lParam = ((ch & 0xFFFF) << 16) | (cw & 0xFFFF);
// Send WM_SIZE via postMessage and pump message loop
emu.postMessage(emu.mainWindow, WM_SIZE, 0, lParam);

// Pump the emulator until message queue is empty or we run out of ticks
let pumpTicks = 0;
console.log = () => {};
while (pumpTicks < 200_000) {
  if (emu.waitingForMessage && emu.messageQueue.length === 0) break;
  emu.tick();
  pumpTicks++;
}
console.log = origLog;
console.log(`Pumped ${pumpTicks} ticks after resize. waitingForMessage=${emu.waitingForMessage} queueLen=${emu.messageQueue.length}`);

dumpSizes('AFTER RESIZE');
process.exit(0);
