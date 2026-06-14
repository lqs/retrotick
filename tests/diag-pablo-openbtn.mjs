// Diag: reproduce the toolbar OPEN button crash (white window).
// Menu File>Open (posted WM_COMMAND) works; the toolbar button (synchronous
// callWndProc WM_COMMAND from inside WM_LBUTTONUP dispatch) crashes.
// Mock onShowCommonDialog like the browser; click the toolbar Open button
// through the real input path; watch for halt / wild EIP / frozen pixels.
import { readFileSync } from 'fs';
import { setTimeout as delay } from 'timers/promises';
import { createCanvas } from '@napi-rs/canvas';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

if (process.argv.includes('--nofilter')) globalThis.__noHwndFilter = true;
const noop = () => {};
function wrap(c) {
  c.addEventListener = noop; c.removeEventListener = noop;
  c.style = { cursor: 'default' };
  c.parentElement = { style: { cursor: 'default' } };
  c.toDataURL = () => '';
  return c;
}
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
await emu.load(ab, peInfo, mainCanvas); emu.run();
let t = 0, le = 0, st = 0;
while (!emu.waitingForMessage && !emu.halted && t < 2_000_000) {
  emu.tick(); t++;
  if (emu.cpu.eip === le) st++; else { st = 0; le = emu.cpu.eip; }
  if (st > 5000) break;
}
async function pump(ms) {
  const T0 = performance.now();
  while (performance.now() - T0 < ms) {
    await delay(5);
    let p = 0;
    while (p < 20_000 && !emu.halted) { emu.tick(); p++; }
  }
}
await pump(800);
console.log = ol;
ol(`=== msg loop @ ${t}; halted=${emu.halted}`);

// Mock the file-open dialog like the browser does: deliver a small .ans file
// after a short "user picks a file" delay.
const ansData = new TextEncoder().encode('hello\x1b[31mworld\r\n').buffer;
// Register the file like a previous Save As would have (virtualFiles entry +
// cached data) so CreateFile(OPEN_EXISTING) finds it.
emu.fs.virtualFiles.push({ name: 'test.ans', size: ansData.byteLength });
emu.fs.virtualFileCache?.set('TEST.ANS', ansData);
let dialogShown = null;
emu.onShowCommonDialog = (req) => {
  dialogShown = req.type;
  ol(`[DIAG] onShowCommonDialog type=${req.type} filter=${(req.filter || '').slice(0, 60)}`);
  setTimeout(() => {
    ol('[DIAG] delivering D:\\test.ans to onResult');
    req.onResult({ path: 'D:\\test.ans', data: ansData });
  }, 150);
};

// Locate the toolbar and its buttons
const tb = emu.handles.get(0x102f);
ol(`toolbar 0x102f: ${tb ? `${tb.width}x${tb.height} buttons=${tb.tbButtons?.length}` : 'gone'}`);
if (tb?.tbButtons) {
  ol('buttons: ' + tb.tbButtons.map(b => `id=${b.idCommand} bmp=${b.iBitmap} style=${b.fsStyle}`).join(' | '));
}

// Click the OPEN toolbar button through the real input path. Toolbar is at
// dock 0x102a(0,0)+child(-2,-2); buttons ~23px wide starting x=2-ish; Open is
// the 2nd button. Canvas coords: (~32, 8).
const WM_MOUSEACTIVATE = 0x0021, HTCLIENT = 1;
const WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
const cx = 32, cy = 8;
emu.cursorX = cx; emu.cursorY = cy;
const hit = emu.windowFromPoint(cx, cy);
ol(`windowFromPoint(${cx},${cy}) -> 0x${hit.hwnd.toString(16)} local=(${hit.x},${hit.y})`);
const apiTrace = [];
const WANT = /CreateFile|ReadFile|WriteFile|CloseHandle|GetFileSize|SetFilePointer|GetOpenFileName|GetSaveFileName|MessageBox/;
const NOISE = /EnterCriticalSection|LeaveCriticalSection|TlsGetValue|HeapFree|HeapAlloc|HeapSize|HeapReAlloc|InterlockedDecrement|InterlockedIncrement|GetTickCount|WaitForSingleObject|ReleaseMutex|GetParent|GetTopWindow|GetWindow$|GetWindowLongA/;
console.log = (...a) => {
  const s = a.join(' ');
  if (s.startsWith('[API]')) { if (WANT.test(s) && !NOISE.test(s)) { apiTrace.push(s); ol(s); } return; }
  if (/WILD|HALT|ERROR|error|\[DIAG\]|\[DLG\]|\[WND\]|CreateFile|ReadFile|CloseHandle|GetFileSize|MessageBox/.test(s)) { apiTrace.push(s); ol(s); }
};
// Wrap key APIs to log their arguments
const msgName = (m) => ({ 0x111: 'WM_COMMAND', 0x113: 'WM_TIMER', 0xf: 'WM_PAINT', 0x200: 'WM_MOUSEMOVE', 0x201: 'WM_LBUTTONDOWN', 0x202: 'WM_LBUTTONUP', 0x84: 'WM_NCHITTEST', 0x20: 'WM_SETCURSOR', 0x21: 'WM_MOUSEACTIVATE' }[m] || '0x' + m.toString(16));
{
  const dd = emu.apiDefs.get('USER32.DLL:DispatchMessageA');
  const od = dd.handler;
  dd.handler = () => {
    const p = emu.readArg(0);
    apiTrace.push(`  [DISP] hwnd=0x${emu.memory.readU32(p).toString(16)} msg=${msgName(emu.memory.readU32(p + 4))} wp=0x${emu.memory.readU32(p + 8).toString(16)}`);
    return od();
  };
  for (const name of ['EnableWindow', 'SetCapture', 'ReleaseCapture', 'TrackPopupMenu', 'TrackPopupMenuEx', 'SetWindowsHookExA', 'IsWindowEnabled', 'IsDialogMessageA']) {
    const def = emu.apiDefs.get('USER32.DLL:' + name);
    if (!def) continue;
    const orig = def.handler;
    def.handler = () => {
      apiTrace.push(`  [CALL] ${name}(0x${emu.readArg(0).toString(16)}, 0x${emu.readArg(1).toString(16)})`);
      return orig();
    };
  }
  const gm = emu.apiDefs.get('USER32.DLL:GetMessageA');
  const og = gm.handler;
  gm.handler = () => {
    apiTrace.push(`  [GETMSG] hWnd=0x${emu.readArg(1).toString(16)} min=0x${emu.readArg(2).toString(16)} max=0x${emu.readArg(3).toString(16)} queue=[${emu.messageQueue.map(m => msgName(m.message)).join(',')}]`);
    return og();
  };
  const pm = emu.apiDefs.get('USER32.DLL:PeekMessageA');
  const op = pm.handler;
  pm.handler = () => {
    apiTrace.push(`  [PEEK] hWnd=0x${emu.readArg(1).toString(16)} min=0x${emu.readArg(2).toString(16)} max=0x${emu.readArg(3).toString(16)} rm=${emu.readArg(4)} q=${emu.messageQueue.length}`);
    return op();
  };
}
emu.traceApi = true;
emu.postMessage(hit.hwnd, WM_MOUSEACTIVATE, emu.mainWindow, (WM_LBUTTONDOWN << 16) | HTCLIENT);
emu.postMessage(hit.hwnd, WM_MOUSEMOVE, 0, (hit.y << 16) | hit.x);
emu.postMessage(hit.hwnd, WM_LBUTTONDOWN, 1, (hit.y << 16) | hit.x);
emu.postMessage(hit.hwnd, WM_LBUTTONUP, 0, (hit.y << 16) | hit.x);
await pump(2000);
emu.traceApi = false;
console.log = ol;
ol(`after click+dialog: halted=${emu.halted} reason=${emu.cpu.haltReason || 'none'} waiting=${emu.waitingForMessage} dialogShown=${dialogShown}`);

// Is the app still alive? caret blink = pixels changing
const out = emu.canvasCtx?.canvas || mainCanvas;
const octx = out.getContext('2d');
function snap() { return new Uint8ClampedArray(octx.getImageData(0, 0, out.width, out.height).data); }
function npx(a, b) { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++; return n; }
let prev = snap(); const diffs = [];
console.log = noop;
for (let k = 0; k < 4; k++) {
  await pump(100);
  const cur = snap();
  diffs.push(npx(prev, cur));
  prev = cur;
}
console.log = ol;
ol(`post-dialog 100ms diffs (alive = caret blinking): [${diffs.join(',')}]`);
ol(`title="${emu.handles.get(emu.mainWindow)?.title}"`);
ol(`messageBoxes=${emu.messageBoxes.length}${emu.messageBoxes.length ? ' text="' + emu.messageBoxes[0].text + '"' : ''}`);
process.exit(0);
