// Diag: does opening the View menu (WM_INITMENU + WM_INITMENUPOPUP, like the
// React MenuBar does) make MFC check "Preview Window" (ID 114)?
import { readFileSync } from 'fs';
import { setTimeout as delay } from 'timers/promises';
import { createCanvas } from '@napi-rs/canvas';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

const noop = () => {};
function wrap(c) { c.addEventListener = noop; c.removeEventListener = noop; c.style = { cursor: 'default' }; c.parentElement = { style: { cursor: 'default' } }; c.toDataURL = () => ''; return c; }
function mkCanvas(w, h) { return wrap(createCanvas(Math.max(1, w | 0) || 1, Math.max(1, h | 0) || 1)); }
const mainCanvas = mkCanvas(1310, 814);
globalThis.document = { createElement: () => mkCanvas(1310, 814), title: '' };
globalThis.OffscreenCanvas = class { constructor(w, h) { return mkCanvas(w, h); } };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.Image = class { set src(_) {} };
globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: noop };
globalThis.Blob = class { constructor() {} };

const EXE = 'C:/Users/Olivier/Downloads/PabloDraw-2.0.8.70/PabloDraw.exe';
const fb = readFileSync(EXE); const ab = new ArrayBuffer(fb.byteLength); new Uint8Array(ab).set(fb);
const peInfo = parsePE(ab);
const emu = new Emulator(); emu.screenWidth = 1310; emu.screenHeight = 814;
emu.registryStore = new RegistryStore(); emu.profileStore = new ProfileStore();

const ol = console.log.bind(console); console.log = noop;
let menuChanges = 0;
emu.onMenuChanged = () => { menuChanges++; };
let setMenuItems = null;
emu.onSetMenu = (hwnd, hMenu) => {
  if (hwnd !== emu.mainWindow || !hMenu) return;
  // mirror EmulatorView's conversion minimally
  const seen = new Set();
  const conv = (it) => {
    const isChecked = !!(it.flags & 0x08);
    let children = null;
    if (it.hSubMenu && !seen.has(it.hSubMenu)) { seen.add(it.hSubMenu); const sub = emu.handles.get(it.hSubMenu); if (sub?.items) children = sub.items.map(conv); }
    return { id: it.id, text: it.text || '', isChecked, children };
  };
  const root = emu.handles.get(hMenu);
  if (root?.items?.length) { seen.add(hMenu); setMenuItems = root.items.map(conv); emu.menuItems = setMenuItems; }
};

await emu.load(ab, peInfo, mainCanvas); emu.run();
let t = 0, le = 0, st = 0;
while (!emu.waitingForMessage && !emu.halted && t < 2_000_000) { emu.tick(); t++; if (emu.cpu.eip === le) st++; else { st = 0; le = emu.cpu.eip; } if (st > 5000) break; }
async function pump(ms) { const T0 = performance.now(); while (performance.now() - T0 < ms) { await delay(5); let p = 0; while (p < 20_000 && !emu.halted) { emu.tick(); p++; } } }
await pump(800);
console.log = ol;
ol(`=== msg loop @ ${t}; menuChanges so far=${menuChanges}`);

const wnd = emu.handles.get(emu.mainWindow);
const hMenu = wnd.hMenu || 0;
ol(`mainWindow=0x${emu.mainWindow.toString(16)} hMenu=0x${hMenu.toString(16)} wndProc=0x${(wnd.wndProc||0).toString(16)}`);
const menuData = emu.handles.get(hMenu);
ol('top-level menu items:');
(menuData?.items || []).forEach((it, i) => ol(`  [${i}] id=${it.id} "${it.text}" hSub=0x${(it.hSubMenu||0).toString(16)}`));

// Find the View submenu (contains id 114). Walk top-level subs.
const WM_INITMENU = 0x0116, WM_INITMENUPOPUP = 0x0117;
function findItem(items, id) { for (const it of items || []) { if (it.id === id) return it; if (it.hSubMenu) { const sub = emu.handles.get(it.hSubMenu); const f = findItem(sub?.items, id); if (f) return f; } } return null; }

const before = findItem(menuData?.items, 114);
ol(`Preview item BEFORE open: flags=0x${(before?.flags||0).toString(16)} checked=${!!(before?.flags & 0x08)}`);
ol(`legacy isChecked BEFORE: ${setMenuItems ? JSON.stringify(findLegacy(setMenuItems, 114)?.isChecked) : 'n/a'}`);

function findLegacy(items, id) { for (const it of items || []) { if (it.id === id) return it; if (it.children) { const f = findLegacy(it.children, id); if (f) return f; } } return null; }

// Which top-level index holds the View submenu?
let viewIdx = -1;
(menuData?.items || []).forEach((it, i) => { if (it.hSubMenu) { const sub = emu.handles.get(it.hSubMenu); if (findItem(sub?.items, 114)) viewIdx = i; } });
ol(`View submenu is top-level index ${viewIdx}`);

// Simulate handleMenuOpen EXACTLY (save/restore ESP/EIP/waiting)
const hSubMenu = menuData?.items?.[viewIdx]?.hSubMenu || 0;
const before2 = menuChanges;
// Trace CheckMenuItem / update-cmd-ui activity
let checkCalls = 0;
const cmiDef = emu.apiDefs.get('USER32.DLL:CheckMenuItem');
const origCmi = cmiDef.handler;
cmiDef.handler = () => { checkCalls++; ol(`  [CheckMenuItem] hMenu=0x${emu.readArg(0).toString(16)} id=${emu.readArg(1)} check=0x${emu.readArg(2).toString(16)}`); return origCmi(); };

const savedESP = emu.cpu.reg[4];
const savedEIP = emu.cpu.eip;
const savedWaiting = emu.waitingForMessage;
emu.waitingForMessage = false;
emu.callWndProc(wnd.wndProc, emu.mainWindow, WM_INITMENU, hMenu, 0);
emu.callWndProc(wnd.wndProc, emu.mainWindow, WM_INITMENUPOPUP, hSubMenu, viewIdx);
emu.cpu.reg[4] = savedESP;
emu.cpu.eip = savedEIP;
emu.waitingForMessage = savedWaiting;
ol(`CheckMenuItem calls during open: ${checkCalls}`);
await pump(100);

const after = findItem(menuData?.items, 114);
ol(`Preview item AFTER WM_INITMENUPOPUP: flags=0x${(after?.flags||0).toString(16)} checked=${!!(after?.flags & 0x08)}`);
ol(`legacy isChecked AFTER: ${setMenuItems ? JSON.stringify(findLegacy(setMenuItems, 114)?.isChecked) : 'n/a'}`);
ol(`menuChanges fired during open: ${menuChanges - before2} (total ${menuChanges})`);
process.exit(0);
