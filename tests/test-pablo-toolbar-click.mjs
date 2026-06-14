import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

const noop = () => {};
// Size-correct mocks (same shape as the diag-pablo-*.mjs harnesses): the old
// getImageData returned a fixed 4-byte buffer, which faults canvas-preserving
// resize paths mid-boot and silently halts the emulator before the click.
function makeCtx(c){return{fillRect:noop,clearRect:noop,strokeRect:noop,fillText:noop,strokeText:noop,measureText:()=>({width:8}),drawImage:noop,putImageData:noop,getImageData:(x,y,w,h)=>({data:new Uint8ClampedArray(Math.max(1,w|0)*Math.max(1,h|0)*4),width:w,height:h}),createImageData:(w,h)=>({data:new Uint8ClampedArray(Math.max(1,w|0)*Math.max(1,h|0)*4),width:w,height:h}),save:noop,restore:noop,translate:noop,scale:noop,rotate:noop,setTransform:noop,resetTransform:noop,transform:noop,getTransform:()=>({a:1,b:0,c:0,d:1,e:0,f:0}),beginPath:noop,closePath:noop,moveTo:noop,lineTo:noop,arc:noop,arcTo:noop,rect:noop,ellipse:noop,fill:noop,stroke:noop,clip:noop,setLineDash:noop,getLineDash:()=>[],createLinearGradient:()=>({addColorStop:noop}),createRadialGradient:()=>({addColorStop:noop}),createPattern:()=>null,font:'',textAlign:'left',textBaseline:'top',fillStyle:'',strokeStyle:'',lineWidth:1,globalAlpha:1,canvas:c};}
function makeCanvas(w,h){const c={width:w??800,height:h??600,toDataURL:()=>'',addEventListener:noop,removeEventListener:noop,style:{cursor:'default'},parentElement:{style:{cursor:'default'}}};c.getContext=()=>makeCtx(c);return c;}
const mockCanvas = makeCanvas(800, 600);
globalThis.document = { createElement: () => makeCanvas(800, 600), title: '' };
globalThis.OffscreenCanvas = class { constructor(w, h) { Object.assign(this, makeCanvas(w, h)); this.width = w; this.height = h; } };
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
emu.profileStore = new ProfileStore();

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
console.log(`Reached msg loop after ${ticks} ticks (waiting=${emu.waitingForMessage})`);

// Locate toolbar
function findToolbar(hwnd) {
  const w = emu.handles.get(hwnd);
  if (!w) return null;
  if (w.classInfo?.className === 'ToolbarWindow32') return { hwnd, w };
  if (w.childList) for (const ch of w.childList) { const t = findToolbar(ch); if (t) return t; }
  return null;
}
const tb = findToolbar(emu.mainWindow);
if (!tb) { console.log('NO TOOLBAR'); process.exit(1); }
console.log(`Toolbar 0x${tb.hwnd.toString(16)} parent=0x${tb.w.parent.toString(16)} buttons=${tb.w.tbButtons?.length}`);

// Instrument callWndProc to see who receives WM_COMMAND
const WM_COMMAND = 0x0111;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const received = [];
const origCall = emu.callWndProc.bind(emu);
emu.callWndProc = (proc, hwnd, msg, wParam, lParam) => {
  if (msg === WM_COMMAND) {
    received.push({ hwnd, wParam: wParam >>> 0, lParam: lParam >>> 0 });
  }
  return origCall(proc, hwnd, msg, wParam, lParam);
};

// Verify the real browser path: windowFromPoint must resolve a click in the
// toolbar's screen area to the toolbar window (not the parent dock bar).
// Toolbar world pos is (-2,-2); button 0 "New" center sits ~ (10,10) in
// main-window-client space.
if (typeof emu.windowFromPoint === 'function') {
  for (const [sx, sy] of [[10, 10], [12, 12], [30, 10]]) {
    const hit = emu.windowFromPoint(sx, sy);
    const hw = emu.handles.get(hit.hwnd);
    console.log(`windowFromPoint(${sx},${sy}) => 0x${hit.hwnd.toString(16)} (${hw?.classInfo?.className}) rel=(${hit.x},${hit.y})`);
  }
}

// Button 0 "New" (idCmd 57600) is at x in [2, 2+23). Click at (12, 12) relative to toolbar.
// Post WM_LBUTTONUP directly to toolbar; our DispatchMessageA intercept does the hit-test.
const lParam = (12 << 16) | 12;
console.log('\n-- Posting WM_LBUTTONDOWN+UP to toolbar at (12,12) --');
emu.postMessage(tb.hwnd, WM_LBUTTONDOWN, 1, lParam);
emu.postMessage(tb.hwnd, WM_LBUTTONUP, 0, lParam);

// Pump the message loop so the app drains GetMessage/DispatchMessage
console.log = () => {};
let pump = 0;
while (pump < 500_000) {
  emu.tick();
  pump++;
  if (received.length > 0 && pump > 50_000) break;
}
console.log = origLog;

console.log(`\nWM_COMMAND deliveries: ${received.length}`);
for (const r of received) {
  const w = emu.handles.get(r.hwnd);
  console.log(`  hwnd=0x${r.hwnd.toString(16)} (${w?.classInfo?.className}) id=${r.wParam & 0xFFFF} notify=${(r.wParam>>16)&0xFFFF} lParam=0x${r.lParam.toString(16)}`);
}
const gotNew = received.some(r => (r.wParam & 0xFFFF) === 57600);
console.log(`\n${gotNew ? 'PASS' : 'FAIL'}: ID_FILE_NEW (57600) ${gotNew ? 'delivered' : 'NOT delivered'}`);
const frame = received.some(r => r.hwnd === emu.mainWindow);
console.log(`Frame (0x${emu.mainWindow.toString(16)}) received a WM_COMMAND: ${frame}`);
process.exit(0);
