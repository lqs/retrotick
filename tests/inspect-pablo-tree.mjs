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

// keep handles.alloc/BitBlt-prop logs but filter rest
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
console.log(`Reached msg loop after ${ticks} ticks`);

function dumpTree(hwnd, depth = 0) {
  const w = emu.handles.get(hwnd);
  if (!w) return;
  const indent = '  '.repeat(depth);
  const cn = w.classInfo?.className || '?';
  console.log(`${indent}0x${hwnd.toString(16)} ${cn.padEnd(36)} vis=${w.visible} pos=(${w.x},${w.y}) size=${w.width}x${w.height} ctrlId=${w.controlId ?? '-'} style=0x${(w.style >>> 0).toString(16)}`);
  if (w.childList) {
    for (const ch of w.childList) dumpTree(ch, depth + 1);
  }
}

console.log(`\n=== Main window 0x${emu.mainWindow.toString(16)} tree ===`);
dumpTree(emu.mainWindow);

// Find the toolbar and dump its state
function findToolbar(hwnd) {
  const w = emu.handles.get(hwnd);
  if (!w) return null;
  if (w.classInfo?.className === 'ToolbarWindow32') return w;
  if (w.childList) {
    for (const ch of w.childList) {
      const t = findToolbar(ch);
      if (t) return t;
    }
  }
  return null;
}
const tb = findToolbar(emu.mainWindow);
if (tb) {
  console.log(`\n=== Toolbar state ===`);
  console.log(`wndProc: 0x${(tb.wndProc ?? 0).toString(16)} (0 = built-in, !0 = subclassed)`);
  console.log(`buttonStructSize: ${tb.tbButtonStructSize}`);
  console.log(`buttonSize: cx=${tb.tbButtonSize & 0xFFFF} cy=${(tb.tbButtonSize >>> 16) & 0xFFFF}`);
  console.log(`bitmapSize: cx=${tb.tbBitmapSize & 0xFFFF} cy=${(tb.tbBitmapSize >>> 16) & 0xFFFF}`);
  console.log(`bitmapHandle: 0x${(tb.tbBitmapHandle ?? 0).toString(16)}`);
  if (tb.tbBitmapHandle) {
    const bmp = emu.handles.get(tb.tbBitmapHandle);
    if (bmp) {
      console.log(`  bitmap is ${bmp.width}x${bmp.height}`);
      console.log(`  bitmap object keys: ${Object.keys(bmp).join(', ')}`);
      console.log(`  bitmap.canvas type: ${bmp.canvas?.constructor?.name}`);
      console.log(`  bitmap.dibBitsPtr=0x${(bmp.dibBitsPtr ?? 0).toString(16)}`);
      console.log(`  bitmap.dibBpp=${bmp.dibBpp}`);
      console.log(`  bitmap.monochrome=${bmp.monochrome}`);
    }
    else console.log(`  bitmap handle invalid (released?)`);
  }

  // Try loading resource 127 directly via loadBitmapResource — does THAT have imageData?
  console.log(`\n--- Direct loadBitmapResource(127) ---`);
  const directHandle = emu.loadBitmapResource(127);
  console.log(`  handle=0x${directHandle.toString(16)}`);
  const directBmp = emu.handles.get(directHandle);
  if (directBmp) {
    console.log(`  keys: ${Object.keys(directBmp).join(', ')}`);
    console.log(`  ${directBmp.width}x${directBmp.height}`);
    if (directBmp.imageData) {
      const d = directBmp.imageData.data;
      console.log(`  imageData.length=${d.length}`);
      // First few pixels
      const px = [];
      for (let i = 0; i < 32; i += 4) px.push(`(${d[i]},${d[i+1]},${d[i+2]})`);
      console.log(`  first 8 px: ${px.join(' ')}`);
    }
  }
  console.log(`buttons: ${tb.tbButtons?.length ?? 0}`);
  for (const b of (tb.tbButtons ?? [])) {
    console.log(`  iBitmap=${b.iBitmap} idCmd=${b.idCommand} fsState=0x${b.fsState.toString(16)} fsStyle=0x${b.fsStyle.toString(16)}`);
  }
}

// Try renderChildControls to see if toolbar render fires
console.log('\n=== Simulating renderChildControls ===');
let mockDrawImageCount = 0;
let mockFillRectCount = 0;
emu.canvasCtx = {
  save: () => {}, restore: () => {},
  fillRect: () => { mockFillRectCount++; },
  drawImage: () => { mockDrawImageCount++; },
  clearRect: () => {}, strokeRect: () => {},
  fillStyle: '', strokeStyle: '',
  globalAlpha: 1,
  beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {},
  translate: () => {}, scale: () => {},
};
emu.renderChildControls(emu.mainWindow);
console.log(`renderChildControls: ${mockFillRectCount} fillRect, ${mockDrawImageCount} drawImage calls`);

// Now simulate the overlay collection (same logic as emu-render.ts collectChildren)
console.log('\n=== Overlays emitted by collectChildren ===');
function collect(wnd, ox, oy, out) {
  if (!wnd.childList) return;
  for (const childHwnd of wnd.childList) {
    const child = emu.handles.get(childHwnd);
    if (!child) continue;
    const cn = child.classInfo?.className?.toUpperCase();
    if (cn === 'MDICLIENT') {
      if (child.childList) {
        for (const mch of child.childList) {
          const mc = emu.handles.get(mch);
          if (!mc) continue;
          if (!mc.visible && !mc.minimized) continue;
          out.push({ hwnd: mch, info: mc, ox: ox + child.x, oy: oy + child.y, isMdi: true });
          if (!mc.minimized && mc.childList) {
            collect(mc, ox + child.x + mc.x, oy + child.y + mc.y, out);
          }
        }
      }
      continue;
    }
    if (!child.visible) continue;
    out.push({ hwnd: childHwnd, info: child, ox, oy });
    if (child.childList) collect(child, ox + child.x, oy + child.y, out);
  }
}
const out = [];
const main = emu.handles.get(emu.mainWindow);
collect(main, 0, 0, out);
for (const { hwnd, info, ox, oy } of out) {
  const cn = info.classInfo?.className || '?';
  console.log(`  0x${hwnd.toString(16)} ${cn.padEnd(30)} world=(${info.x+ox},${info.y+oy}) size=${info.width}x${info.height}`);
}
process.exit(0);
