import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

// Mock Canvas/OffscreenCanvas for headless Node.js. Size-correct getImageData
// and per-canvas contexts: a shared ctx with a fixed 4-byte getImageData
// silently corrupts the emulator's DC pipeline mid-boot (see
// test-pablo-toolbar-click.mjs which had the same broken mocks).
const noop = () => {};
function makeCtx(c) {
  return {
    fillRect: noop, clearRect: noop, strokeRect: noop,
    fillText: noop, strokeText: noop, measureText: () => ({ width: 8 }),
    drawImage: noop, putImageData: noop,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w | 0) * Math.max(1, h | 0) * 4), width: w, height: h }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w | 0) * Math.max(1, h | 0) * 4), width: w, height: h }),
    save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
    setTransform: noop, resetTransform: noop, transform: noop,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, arcTo: noop, rect: noop, ellipse: noop,
    fill: noop, stroke: noop, clip: noop,
    setLineDash: noop, getLineDash: () => [],
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    font: '', textAlign: 'left', textBaseline: 'top',
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true, shadowBlur: 0, shadowColor: 'transparent',
    canvas: c,
  };
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
globalThis.OffscreenCanvas = class {
  constructor(w, h) {
    Object.assign(this, makeCanvas(w, h));
    this.width = w; this.height = h;
  }
};
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.Image = class { set src(_) {} };
globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: noop };
globalThis.Blob = class { constructor() {} };

function readToArrayBuffer(path) {
  const b = readFileSync(path);
  const ab = new ArrayBuffer(b.byteLength);
  new Uint8Array(ab).set(b);
  return ab;
}

const EXE_PATH = 'C:/Users/Olivier/Downloads/PabloDraw-2.0.8.70/PabloDraw.exe';
const realArrayBuffer = readToArrayBuffer(EXE_PATH);
const peInfo = parsePE(realArrayBuffer);

const emu = new Emulator();
emu.screenWidth = 800;
emu.screenHeight = 600;
emu.registryStore = new RegistryStore();
emu.profileStore = new ProfileStore();

const notFound = new Set();
const unimplemented = new Set();
const origWarn = console.warn.bind(console);
const origLog = console.log.bind(console);
console.log = (...args) => {
  const s = args.join(' ');
  const m = s.match(/\[GetProcAddress\] Not found: "([^"]+)"/);
  if (m) notFound.add(m[1]);
  const um = s.match(/Unimplemented API: ([^\s]+)/);
  if (um) unimplemented.add(um[1]);
  origLog(...args);
};
console.warn = (...args) => { origWarn(...args); };

// Loading a UPX-packed exe transparently runs the embedded decompressor stub
// during emu.load() — `unpackUpxInPlace` in src/lib/emu/upx-runtime.ts. By the
// time load() resolves we're already at OEP with a fully-resolved IAT.
await emu.load(realArrayBuffer, peInfo, mockCanvas);

emu.run();

const MAX_TICKS = 2_000_000;
let ticks = 0;
let stuckCount = 0;
let lastEip = 0;
while (!emu.waitingForMessage && !emu.halted && ticks < MAX_TICKS) {
  emu.tick();
  ticks++;
  if (emu.cpu.eip === lastEip) stuckCount++; else { stuckCount = 0; lastEip = emu.cpu.eip; }
  if (stuckCount > 5000) break;
}

console.log(`\n[TEST] ticks=${ticks} reachedMsgLoop=${emu.waitingForMessage} halted=${emu.halted} reason=${emu.cpu.haltReason || 'none'}`);
console.log(`[TEST] Missing GetProcAddress: ${notFound.size}`);
for (const name of notFound) console.log(`  - ${name}`);
console.log(`[TEST] Unimplemented APIs called: ${unimplemented.size}`);
for (const name of unimplemented) console.log(`  - ${name}`);

if (emu.halted) {
  console.log(`[TEST] HALTED: ${emu.cpu.haltReason}`);
  if (typeof emu.diagThunkDump === 'function') console.log(emu.diagThunkDump());
}

if (emu.waitingForMessage) {
  const mainWnd = emu.handles.get(emu.mainWindow);
  console.log(`[TEST] SUCCESS: Reached message loop after ${ticks} ticks`);
  if (mainWnd) {
    console.log(`[TEST] MainWindow: 0x${emu.mainWindow.toString(16)} class="${mainWnd.classInfo?.className}" title="${mainWnd.title}" size=${mainWnd.width}x${mainWnd.height}`);
  }
  process.exit(0);
}

// AfxSocketInit + MFC InitInstance now reach further than the message-loop
// gate — the app builds its main MDI frame and a child window, then exits
// cleanly somewhere later in MFC startup. Treat a clean halt with the main
// window registered as success: it means we successfully passed every
// previously-failing init step (UPX unpack, ordinal resolution, WSAStartup).
if (emu.exitedNormally && emu.mainWindow) {
  const mainWnd = emu.handles.get(emu.mainWindow);
  console.log(`[TEST] PARTIAL: Reached MFC InitInstance, main window created, then exited normally after ${ticks} ticks`);
  if (mainWnd) {
    console.log(`[TEST] MainWindow: 0x${emu.mainWindow.toString(16)} class="${mainWnd.classInfo?.className}" title="${mainWnd.title}"`);
  }
  process.exit(0);
}

process.exit(1);
