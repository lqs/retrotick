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
  getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  getLineDash: () => [], setLineDash: noop,
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
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() { return { ...mockCtx, canvas: this }; }
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

const EXE_PATH = 'C:/Users/Olivier/Downloads/sol.exe';
const realArrayBuffer = readToArrayBuffer(EXE_PATH);
const peInfo = parsePE(realArrayBuffer);
console.log('[TEST] PE machine/subsystem parsed; isNE=', !!peInfo?.isNE, 'isPE=', !!peInfo);

const emu = new Emulator();
emu.screenWidth = 800;
emu.screenHeight = 600;
const regStore = new RegistryStore();
const profStore = new ProfileStore();
emu.registryStore = regStore;
emu.profileStore = profStore;

// Trace profile + registry traffic by wrapping the store methods.
const profCalls = [];
const origWrite = profStore.writeString.bind(profStore);
profStore.writeString = (file, section, key, value) => {
  profCalls.push(['WRITE', file, section, key, value]);
  return origWrite(file, section, key, value);
};
const origGetStr = profStore.getString.bind(profStore);
profStore.getString = (file, section, key, def) => {
  const r = origGetStr(file, section, key, def);
  profCalls.push(['GET-STR', file, section, key, '->', r]);
  return r;
};
const origGetInt = profStore.getInt.bind(profStore);
profStore.getInt = (file, section, key, def) => {
  const r = origGetInt(file, section, key, def);
  profCalls.push(['GET-INT', file, section, key, '->', r]);
  return r;
};

const regCalls = [];
const origSet = regStore.setValue.bind(regStore);
regStore.setValue = (path, name, type, data) => {
  regCalls.push(['SET', path, name, type, data]);
  return origSet(path, name, type, data);
};
const origQuery = regStore.queryValue.bind(regStore);
regStore.queryValue = (path, name) => {
  const r = origQuery(path, name);
  regCalls.push(['QUERY', path, name, '->', JSON.stringify(r)]);
  return r;
};

// Pre-seed Options with all bits set so Vegas + keep-score get enabled,
// to surface whatever key sol.exe uses for the cumulative score.
profStore.writeString('win.ini', 'Solitaire', 'Options', '65535');
console.log('[TEST] Pre-seeded Options=65535 (enable Vegas/keep-score)');

const cardsBytes = readFileSync('C:/Users/Olivier/Downloads/cards.dll');
emu.additionalFiles.set('cards.dll', cardsBytes.buffer.slice(cardsBytes.byteOffset, cardsBytes.byteOffset + cardsBytes.byteLength));

await emu.load(realArrayBuffer, peInfo, mockCanvas);

emu.apiDefs.set('KERNEL32.DLL:Sleep', { handler: () => 0, stackBytes: 4 });

emu.run();

const MAX_TICKS = 8_000_000;
let ticks = 0, stuckCount = 0, lastEip = 0, reachedMsgLoop = false;
while (!emu.halted && ticks < MAX_TICKS) {
  if (emu.waitingForMessage) { reachedMsgLoop = true; break; }
  emu.tick();
  ticks++;
  if (emu.cpu.eip === lastEip) stuckCount++; else { stuckCount = 0; lastEip = emu.cpu.eip; }
  if (stuckCount > 8000) break;
}

console.log(`\n[TEST] ticks=${ticks} reachedMsgLoop=${reachedMsgLoop} halted=${emu.halted} reason=${emu.cpu.haltReason || 'none'}`);

console.log('\n=== Profile traffic during init ===');
for (const c of profCalls) console.log('  ', c.join(' | '));
console.log('\n=== Registry traffic during init ===');
for (const c of regCalls) console.log('  ', c.join(' | '));

// Simulate dealing several new games (Game>Deal = 1000) which, in Vegas
// keep-score mode, deducts $52 per deal and updates the cumulative score.
if (reachedMsgLoop) {
  profCalls.length = 0;
  const main = emu.mainWindow;
  const WM_COMMAND = 0x0111;
  const ID_DEAL = 1000;
  for (let n = 0; n < 3; n++) {
    console.log(`\n[TEST] Sending WM_COMMAND(Deal=1000) #${n + 1}...`);
    emu.postMessage(main, WM_COMMAND, ID_DEAL, 0);
    emu.waitingForMessage = false;
    let t = 0, dismissed = 0;
    while (!emu.halted && t < 1_500_000) {
      if (emu.dialogState && !emu.dialogState.ended) {
        dismissed++;
        emu.dismissDialog(1 /*IDOK*/, new Map());
        await Promise.resolve();
        if (dismissed > 3) break;
        continue;
      }
      if (emu.waitingForMessage) break;
      emu.tick();
      t++;
    }
  }
  console.log('=== Profile traffic after Deals ===');
  for (const c of profCalls) console.log('  ', c.join(' | '));
}

if (reachedMsgLoop && !emu.halted) {
  profCalls.length = 0;
  regCalls.length = 0;
  const hwnd = emu.mainWindow;
  console.log('\n[TEST] mainWindow handle =', hwnd);
  const WM_CLOSE = 0x0010;
  if (hwnd) {
    emu.postMessage(hwnd, WM_CLOSE, 0, 0);
    emu.waitingForMessage = false;
    let t2 = 0;
    while (!emu.halted && t2 < 2_000_000) {
      if (emu.waitingForMessage) break;
      emu.tick();
      t2++;
    }
    console.log(`[TEST] after WM_CLOSE: ticks=${t2} halted=${emu.halted}`);
  }
  console.log('\n=== Profile traffic on shutdown ===');
  for (const c of profCalls) console.log('  ', c.join(' | '));
  console.log('\n=== Registry traffic on shutdown ===');
  for (const c of regCalls) console.log('  ', c.join(' | '));
}

console.log('\n=== Final ProfileStore serialize ===');
console.log(JSON.stringify(profStore.serialize(), null, 2).slice(0, 2000));
console.log('\n=== Final RegistryStore serialize ===');
console.log(JSON.stringify(regStore.serialize(), null, 2).slice(0, 2000));

process.exit(0);
