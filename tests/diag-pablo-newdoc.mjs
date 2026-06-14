import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

const noop = () => {};
function makeCtx(canvas) {
  return {
    fillRect: noop, clearRect: noop, strokeRect: noop, fillText: noop, strokeText: noop,
    measureText: () => ({ width: 8 }), drawImage: noop, putImageData: noop,
    getImageData: (x,y,w,h) => ({ data: new Uint8ClampedArray(Math.max(1,w|0) * Math.max(1,h|0) * 4), width: w, height: h }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(1,w|0) * Math.max(1,h|0) * 4), width: w, height: h }),
    save: noop, restore: noop, translate: noop, scale: noop, rotate: noop, setTransform: noop,
    resetTransform: noop, transform: noop, beginPath: noop, closePath: noop, moveTo: noop,
    lineTo: noop, arc: noop, arcTo: noop, rect: noop, ellipse: noop, fill: noop, stroke: noop, clip: noop,
    createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null, font: '', textAlign: 'left', textBaseline: 'top',
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, canvas,
  };
}
function makeCanvas(w, h) {
  const c = { width: w ?? 800, height: h ?? 600, toDataURL: () => '', addEventListener: noop,
    removeEventListener: noop, style: { cursor: 'default' }, parentElement: { style: { cursor: 'default' } } };
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
const fbuf = readFileSync(EXE_PATH);
const ab = new ArrayBuffer(fbuf.byteLength);
new Uint8Array(ab).set(fbuf);
const peInfo = parsePE(ab);
const emu = new Emulator();
emu.screenWidth = 1024; emu.screenHeight = 768;
emu.registryStore = new RegistryStore();
emu.profileStore = new ProfileStore();

const divErrors = [];
const origWarn = console.warn.bind(console);
console.warn = (...a) => { const s = a.join(' '); if (s.includes('[DIV ERROR]')) divErrors.push(s); origWarn(...a); };

const origLog = console.log;
console.log = () => {};
await emu.load(ab, peInfo, mockCanvas);
emu.run();
let ticks = 0, lastEip = 0, stuck = 0;
while (!emu.waitingForMessage && !emu.halted && ticks < 2_000_000) {
  emu.tick(); ticks++;
  if (emu.cpu.eip === lastEip) stuck++; else { stuck = 0; lastEip = emu.cpu.eip; }
  if (stuck > 5000) break;
}
console.log = origLog;
console.log(`Reached msg loop after ${ticks} ticks`);

function countWindows() {
  let n = 0;
  for (const _ of emu.handles.findByType('window')) n++;
  return n;
}
function dumpTree(hwnd, depth = 0, out = []) {
  const w = emu.handles.get(hwnd); if (!w) return out;
  out.push(`${'  '.repeat(depth)}0x${hwnd.toString(16)} ${(w.classInfo?.className||'?').padEnd(34)} vis=${w.visible} ${w.width}x${w.height}`);
  if (w.childList) for (const ch of w.childList) dumpTree(ch, depth+1, out);
  return out;
}
console.log(`Windows before New: ${countWindows()}`);

const WM_COMMAND = 0x0111;
const WM_PAINT = 0x000F;
const ID_FILE_NEW = 57600;

// The editor view is the AFX pane child of the frame (ctrlId 59648).
const view = emu.handles.get(0x1015);
console.log(`View 0x1015: class=${view?.classInfo?.className} wndProc=0x${(view?.wndProc||0).toString(16)} ctrlId=${view?.controlId} size=${view?.width}x${view?.height}`);

console.log('\n-- Forcing WM_PAINT on the editor view + pumping (API trace) --');
// Capture which GDI APIs OnDraw calls. SetDIBitsToDevice => OnDraw reached its
// blit (m_cursorSize valid). Only GetClipBox/FillRect => early-out (pPage NULL).
const apiCalls = new Map();
const origTraceLog = console.log;
console.log = (...a) => {
  const s = a.join(' ');
  const m = s.match(/\[API\]\s+\S+:(\w+)/);
  if (m) apiCalls.set(m[1], (apiCalls.get(m[1]) || 0) + 1);
};
emu.traceApi = true;
view.needsPaint = true; view.needsErase = true;
const frame = emu.handles.get(emu.mainWindow);
frame.needsPaint = true;
let pump = 0;
while (pump < 400_000 && !emu.halted && divErrors.length === 0) {
  emu.tick(); pump++;
  if (pump % 50_000 === 0) { view.needsPaint = true; }
}
if (divErrors.length === 0 && view?.wndProc) {
  try {
    const hdc = emu.getWindowDC(0x1015);
    emu.callWndProc(view.wndProc, 0x1015, WM_PAINT, hdc, 0);
    let p2 = 0; while (p2 < 200_000 && !emu.halted && divErrors.length === 0) { emu.tick(); p2++; }
  } catch (e) { /* */ }
}
emu.traceApi = false;
console.log = origLog;

const interesting = ['GetClipBox','SetDIBitsToDevice','StretchDIBits','FillRect','BitBlt','CreateCompatibleDC','GetTotalSize','BeginPaint','EndPaint','SetScrollSizes'];
console.log('GDI calls during paint:');
for (const k of interesting) if (apiCalls.has(k)) console.log(`   ${k}: ${apiCalls.get(k)}`);
console.log(`   (total distinct APIs traced: ${apiCalls.size})`);

console.log(`Pumped ${pump}. halted=${emu.halted} reason=${emu.cpu.haltReason||'none'}`);
console.log(`Windows after New: ${countWindows()}`);
console.log(`DIV ERRORS: ${divErrors.length}`);
for (const e of divErrors) console.log('  ' + e);
console.log('\n=== Tree after New ===');
for (const line of dumpTree(emu.mainWindow)) console.log(line);
process.exit(0);
