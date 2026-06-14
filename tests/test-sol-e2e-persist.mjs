// Definitive end-to-end test: two real "sessions" of sol.exe with a real
// (faked) IndexedDB and the EXACT EmulatorView onChange->saveProfiles wiring
// and unmount cleanup. Session 1 enables Vegas + Cumulative via the Options
// dialog; session 2 must read those settings back.

import 'fake-indexeddb/auto';
import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { loadProfiles, saveProfiles } from '../src/lib/profile-db.ts';

const noop = () => {};
const mockCtx = {
  fillRect: noop, clearRect: noop, strokeRect: noop, fillText: noop, strokeText: noop,
  measureText: () => ({ width: 8 }), drawImage: noop, putImageData: noop,
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  save: noop, restore: noop, translate: noop, scale: noop, rotate: noop, setTransform: noop,
  resetTransform: noop, transform: noop, beginPath: noop, closePath: noop, moveTo: noop,
  lineTo: noop, arc: noop, arcTo: noop, rect: noop, ellipse: noop, fill: noop, stroke: noop,
  clip: noop, createLinearGradient: () => ({ addColorStop: noop }),
  createRadialGradient: () => ({ addColorStop: noop }), createPattern: () => null,
  getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), getLineDash: () => [], setLineDash: noop,
  font: '', textAlign: 'left', textBaseline: 'top', fillStyle: '', strokeStyle: '', lineWidth: 1,
  lineCap: 'butt', lineJoin: 'miter', globalAlpha: 1, globalCompositeOperation: 'source-over',
  imageSmoothingEnabled: true, shadowBlur: 0, shadowColor: 'transparent', canvas: null,
};
const mockCanvas = {
  width: 800, height: 600, getContext: () => mockCtx, toDataURL: () => 'data:image/png;base64,',
  addEventListener: noop, removeEventListener: noop, style: { cursor: 'default' },
  parentElement: { style: { cursor: 'default' } },
};
mockCtx.canvas = mockCanvas;
globalThis.document = { createElement: () => mockCanvas, title: '' };
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { ...mockCtx, canvas: this }; } };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.Image = class { set src(_) {} };
const realURL = globalThis.URL;
globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: noop };
globalThis.Blob = class { constructor() {} };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function toAB(p) { const b = readFileSync(p); const a = new ArrayBuffer(b.byteLength); new Uint8Array(a).set(b); return a; }
const exeAB = toAB('C:/Users/Olivier/Downloads/sol.exe');
const cardsBytes = readFileSync('C:/Users/Olivier/Downloads/cards.dll');
const cardsAB = cardsBytes.buffer.slice(cardsBytes.byteOffset, cardsBytes.byteOffset + cardsBytes.byteLength);

async function runSession(label, configureOptions) {
  console.log(`\n########## ${label} ##########`);
  // --- mount: load profiles from IDB, wire onChange exactly like EmulatorView ---
  const profData = await loadProfiles().catch(() => null);
  const profStore = new ProfileStore();
  if (profData) profStore.deserialize(profData);
  let profFlushTimer = null;
  profStore.onChange = () => {
    if (profFlushTimer !== null) clearTimeout(profFlushTimer);
    profFlushTimer = setTimeout(() => { saveProfiles(profStore.serialize()).catch(() => {}); }, 500);
  };

  const emu = new Emulator();
  emu.screenWidth = 800; emu.screenHeight = 600;
  emu.registryStore = new RegistryStore();
  emu.profileStore = profStore;
  emu.additionalFiles.set('cards.dll', cardsAB);

  const peInfo = parsePE(exeAB);
  await emu.load(exeAB, peInfo, mockCanvas);
  emu.apiDefs.set('KERNEL32.DLL:Sleep', { handler: () => 0, stackBytes: 4 });
  emu.run();

  let ticks = 0, stuck = 0, lastEip = 0, reached = false;
  while (!emu.halted && ticks < 8_000_000) {
    if (emu.waitingForMessage) { reached = true; break; }
    emu.tick(); ticks++;
    if (emu.cpu.eip === lastEip) stuck++; else { stuck = 0; lastEip = emu.cpu.eip; }
    if (stuck > 8000) break;
  }
  console.log(`  reached msg loop=${reached} (ticks=${ticks})`);
  const readOptions = profStore.getString('win.ini', 'Solitaire', 'Options', '<none>');
  console.log(`  sol.exe sees Options = "${readOptions}" at startup`);

  if (reached && configureOptions) {
    const main = emu.mainWindow;
    const WM_COMMAND = 0x0111, ID_OPTIONS = 1003;
    emu.postMessage(main, WM_COMMAND, ID_OPTIONS, 0);
    emu.waitingForMessage = false;
    let t = 0, done = false;
    while (!emu.halted && t < 3_000_000 && !done) {
      if (emu.dialogState && !emu.dialogState.ended) {
        const dlgWnd = emu.handles.get(emu.dialogState.hwnd);
        const setCheck = (id, v) => {
          const h = dlgWnd?.children?.get(id);
          if (h) { const c = emu.handles.get(h); if (c) c.checked = v; }
        };
        // Vegas scoring + Cumulative ON, Standard OFF, Draw Three
        setCheck(300, 0); setCheck(301, 1);       // Draw Three
        setCheck(302, 0); setCheck(303, 1); setCheck(304, 0); // Vegas
        setCheck(308, 1);                          // Cumulative
        console.log('  [session] checked Vegas(303)+Cumulative(308)+DrawThree(301), dismiss OK');
        emu.dismissDialog(1 /*IDOK*/, new Map());
        await Promise.resolve();
        done = true;
        continue;
      }
      if (emu.waitingForMessage) break;
      emu.tick(); t++;
    }
    const written = profStore.getString('win.ini', 'Solitaire', 'Options', '<none>');
    console.log(`  After OK, Options in store = "${written}"`);
  }

  // --- wait past the 500ms debounce so the flush hits IDB, then "unmount" ---
  await sleep(700);
  // EmulatorView cleanup does NOT clear profFlushTimer, but flush already ran.
  emu.stop?.();
  return readOptions;
}

// SESSION 1: fresh store, user enables Vegas+Cumulative
await runSession('SESSION 1 — configure Vegas + Cumulative', true);

// Confirm what is now persisted in IDB
const persisted = await loadProfiles();
console.log('\n[IDB] persisted profiles =', JSON.stringify(persisted));

// SESSION 2: reopen — sol.exe should read back the Vegas settings
const startupOptions = await runSession('SESSION 2 — reopen, read settings', false);

const session1Persisted = persisted?.['win.ini']?.['solitaire']?.['options'];
console.log('\n================ VERDICT ================');
console.log(`  Session 1 persisted Options = ${session1Persisted}`);
console.log(`  Session 2 startup    Options = ${startupOptions}`);
if (session1Persisted && String(startupOptions) === String(session1Persisted)) {
  console.log('  ✅ Options round-trip across sessions WORKS');
} else {
  console.log('  ❌ Options NOT persisted across sessions');
}
process.exit(0);
