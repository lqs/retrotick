import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { extractMenus } from '../src/lib/pe/extract-menu.ts';

// Mocks for headless
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
console.log('isUpxPacked=' + peInfo.isUpxPacked);
console.log('Before load: peInfo.resources=' + (peInfo.resources?.length ?? 0));

const emu = new Emulator();
emu.screenWidth = 800;
emu.screenHeight = 600;

const origLog = console.log.bind(console);
let upxLog = '';
console.log = (...args) => { const s = args.join(' '); if (s.includes('[UPX]')) upxLog += s + '\n'; origLog(...args); };

await emu.load(ab, peInfo, mockCanvas);

console.log = origLog;
console.log('\n=== After load ===');
console.log(upxLog);
console.log('peInfo.resources types:');
for (const t of (peInfo.resources ?? [])) {
  console.log(`  typeId=${t.typeId} typeName=${t.typeName} entries=${t.entries.length}`);
  for (const e of t.entries) {
    console.log(`    id=${e.id} name=${e.name} langs=${e.languages.length} firstDataRva=0x${e.languages[0]?.dataRva.toString(16)} size=${e.languages[0]?.dataSize}`);
  }
}

console.log('\n=== Calling extractMenus(peInfo, emu.arrayBuffer) ===');
const menus = extractMenus(peInfo, emu.arrayBuffer);
console.log(`Found ${menus.length} menu(s)`);
for (const m of menus) {
  console.log(`Menu name=${m.name} id=${m.id} items=${m.menu.items.length}`);
  for (const item of m.menu.items.slice(0, 5)) {
    console.log(`  - "${item.text}"`);
  }
}
process.exit(0);
