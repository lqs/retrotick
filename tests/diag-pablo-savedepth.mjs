// Diag: track ctx.save()/restore() balance on the SHARED main canvas across
// paint cycles. If depth drifts, dump the call stacks of unmatched saves —
// they name the leaking call site directly.
import { readFileSync } from 'fs';
import { setTimeout as delay } from 'timers/promises';
import { createCanvas } from '@napi-rs/canvas';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

const noop = () => {};
function wrap(c) {
  c.addEventListener = noop; c.removeEventListener = noop;
  c.style = { cursor: 'default' };
  c.parentElement = { style: { cursor: 'default' } };
  c.toDataURL = () => '';
  return c;
}
function mkCanvas(w, h) { return wrap(createCanvas(Math.max(1, w | 0) || 1, Math.max(1, h | 0) || 1)); }

const mainCanvas = mkCanvas(1024, 768);
globalThis.document = { createElement: () => mkCanvas(1024, 768), title: '' };
globalThis.OffscreenCanvas = class { constructor(w, h) { return mkCanvas(w, h); } };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.Image = class { set src(_) {} };
globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: noop };
globalThis.Blob = class { constructor() {} };

const EXE = 'C:/Users/Olivier/Downloads/PabloDraw-2.0.8.70/PabloDraw.exe';
const fb = readFileSync(EXE); const ab = new ArrayBuffer(fb.byteLength); new Uint8Array(ab).set(fb);
const peInfo = parsePE(ab);
const emu = new Emulator(); emu.screenWidth = 1024; emu.screenHeight = 768;
emu.registryStore = new RegistryStore(); emu.profileStore = new ProfileStore();

const ol = console.log.bind(console); console.log = noop;
await emu.load(ab, peInfo, mainCanvas); emu.run();
let t = 0, le = 0, st = 0;
while (!emu.waitingForMessage && !emu.halted && t < 2_000_000) {
  emu.tick(); t++;
  if (emu.cpu.eip === le) st++; else { st = 0; le = emu.cpu.eip; }
  if (st > 5000) break;
}
ol(`=== msg loop @ ${t} ===`);

// Wrap save/restore on the emulator's main ctx
const ctx = emu.canvasCtx;
const saves = []; // stack of {site}
let underflow = 0;
const osave = ctx.save.bind(ctx), orestore = ctx.restore.bind(ctx);
function site() {
  const s = (new Error().stack || '').split('\n');
  const useful = s.slice(1).filter(l => !l.includes('savedepth') && !l.includes('Error'));
  return useful.slice(0, 3).map(l => l.trim().replace(/\(.*[\\/](.*?:\d+):\d+\)/, '($1)').replace(/at /, '')).join(' < ');
}
ctx.save = () => { saves.push(site()); osave(); };
ctx.restore = () => { if (saves.length === 0) underflow++; else saves.pop(); orestore(); };

async function pump(ms) {
  const T0 = performance.now();
  while (performance.now() - T0 < ms) {
    await delay(5);
    let p = 0;
    while (p < 20_000 && !emu.halted) { emu.tick(); p++; }
  }
}

// Log depth at each BeginPaint
const bp = emu.apiDefs.get('USER32.DLL:BeginPaint');
const obp = bp.handler;
const depthLog = [];
bp.handler = () => {
  const hwnd = emu.readArg(0);
  depthLog.push(`BeginPaint(0x${hwnd.toString(16)}) depth=${saves.length} underflow=${underflow}`);
  if (depthLog.length === 8 || depthLog.length === 12) {
    for (const s of saves) depthLog.push(`   STALE SAVE: ${s}`);
  }
  return obp();
};

await pump(1500);
console.log = ol;
ol(`=== after 1.5s: depth=${saves.length}, underflow=${underflow} ===`);
for (const l of depthLog.slice(0, 25)) ol(l);
ol(`=== unmatched saves (${saves.length}) ===`);
const siteCounts = new Map();
for (const s of saves) siteCounts.set(s, (siteCounts.get(s) || 0) + 1);
for (const [k, c] of siteCounts) ol(`${String(c).padStart(5)}  ${k}`);
process.exit(0);
