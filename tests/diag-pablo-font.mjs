import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

const noop = () => {};
const mockCtx = {
  fillRect: noop, clearRect: noop, strokeRect: noop, fillText: noop, strokeText: noop,
  measureText: () => ({ width: 8 }), drawImage: noop, putImageData: noop,
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  save: noop, restore: noop, translate: noop, scale: noop, rotate: noop, setTransform: noop,
  resetTransform: noop, transform: noop, beginPath: noop, closePath: noop, moveTo: noop,
  lineTo: noop, arc: noop, arcTo: noop, rect: noop, ellipse: noop, fill: noop, stroke: noop, clip: noop,
  createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }),
  createPattern: () => null, font: '', textAlign: 'left', textBaseline: 'top',
  fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, canvas: null,
};
const mockCanvas = { width: 800, height: 600, getContext: () => mockCtx, toDataURL: () => '',
  addEventListener: noop, removeEventListener: noop, style: { cursor: 'default' }, parentElement: { style: { cursor: 'default' } } };
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
emu.screenWidth = 1024; emu.screenHeight = 768;
emu.registryStore = new RegistryStore();
emu.profileStore = new ProfileStore();
const origLog = console.log;
console.log = () => {};
await emu.load(ab, peInfo, mockCanvas);
console.log = origLog;

// Find RasterFont resources by name. IDR_FONT8x16 etc. Try each name we saw.
for (const name of [124, 146, 147]) {
  const r = emu.findResourceEntry('RasterFont', name);
  if (!r) { console.log(`RasterFont/${name}: NOT FOUND`); continue; }
  const base = emu.pe.imageBase;
  const addr = (base + r.dataRva) >>> 0;
  const bytes = [];
  for (let i = 0; i < 12; i++) bytes.push(emu.memory.readU8((addr + i) >>> 0).toString(16).padStart(2, '0'));
  const cx = emu.memory.readU16(addr);
  const cy = emu.memory.readU16(addr + 2);
  const nch = emu.memory.readU16(addr + 4);
  console.log(`RasterFont/${name}: RVA=0x${r.dataRva.toString(16)} size=${r.dataSize} addr=0x${addr.toString(16)}`);
  console.log(`   header bytes: ${bytes.join(' ')}`);
  console.log(`   => cx=${cx} cy=${cy} numChars=${nch}  ${(cx===0||cy===0)?'*** ZERO SIZE (div-by-zero source) ***':'OK'}`);
}
process.exit(0);
