// Diag: what does PabloDraw DO when it receives a click in the editor?
// Hooks DispatchMessageA to log every dispatched message around the click,
// and enables traceApi during the WM_LBUTTONDOWN dispatch to see the app's
// API calls in response.
import { readFileSync } from 'fs';
import { setTimeout as delay } from 'timers/promises';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

const noop = () => {};
function makeCtx(c){return{fillRect:noop,clearRect:noop,strokeRect:noop,fillText:noop,strokeText:noop,measureText:()=>({width:8}),drawImage:noop,putImageData:noop,getImageData:(x,y,w,h)=>({data:new Uint8ClampedArray(Math.max(1,w|0)*Math.max(1,h|0)*4),width:w,height:h}),createImageData:(w,h)=>({data:new Uint8ClampedArray(Math.max(1,w|0)*Math.max(1,h|0)*4),width:w,height:h}),save:noop,restore:noop,translate:noop,scale:noop,rotate:noop,setTransform:noop,resetTransform:noop,transform:noop,getTransform:()=>({a:1,b:0,c:0,d:1,e:0,f:0}),beginPath:noop,closePath:noop,moveTo:noop,lineTo:noop,arc:noop,arcTo:noop,rect:noop,ellipse:noop,fill:noop,stroke:noop,clip:noop,setLineDash:noop,getLineDash:()=>[],createLinearGradient:()=>({addColorStop:noop}),createRadialGradient:()=>({addColorStop:noop}),createPattern:()=>null,font:'',textAlign:'left',textBaseline:'top',fillStyle:'',strokeStyle:'',lineWidth:1,globalAlpha:1,canvas:c};}
function makeCanvas(w,h){const c={width:w??800,height:h??600,toDataURL:()=>'',addEventListener:noop,removeEventListener:noop,style:{cursor:'default'},parentElement:{style:{cursor:'default'}}};c.getContext=()=>makeCtx(c);return c;}
const mockCanvas=makeCanvas(1024,768);
globalThis.document={createElement:()=>makeCanvas(1024,768),title:''};
globalThis.OffscreenCanvas=class{constructor(w,h){Object.assign(this,makeCanvas(w,h));this.width=w;this.height=h;}};
globalThis.requestAnimationFrame=(cb)=>setTimeout(cb,0);
globalThis.Image=class{set src(_){}};globalThis.URL={createObjectURL:()=>'blob:mock',revokeObjectURL:noop};globalThis.Blob=class{constructor(){}};

const EXE='C:/Users/Olivier/Downloads/PabloDraw-2.0.8.70/PabloDraw.exe';
const fb=readFileSync(EXE);const ab=new ArrayBuffer(fb.byteLength);new Uint8Array(ab).set(fb);
const peInfo=parsePE(ab);
const emu=new Emulator();emu.screenWidth=1024;emu.screenHeight=768;
emu.registryStore=new RegistryStore();emu.profileStore=new ProfileStore();
const ol=console.log.bind(console);
let capture=null; // when set, push API trace lines
console.log=(...a)=>{const s=a.join(' ');if(capture&&s.startsWith('[API]'))capture.push(s);};
await emu.load(ab,peInfo,mockCanvas);emu.run();
let t=0,le=0,st=0;
while(!emu.waitingForMessage&&!emu.halted&&t<2_000_000){emu.tick();t++;if(emu.cpu.eip===le)st++;else{st=0;le=emu.cpu.eip;}if(st>5000)break;}
ol(`=== msg loop @ ${t} ===`);

async function pump(ms){const T0=performance.now();while(performance.now()-T0<ms){await delay(5);let p=0;while(p<20_000&&!emu.halted){emu.tick();p++;}}}
await pump(800); // settle

// Hook dispatch: log messages, and traceApi during the click dispatch
const dispatchDef=emu.apiDefs.get('USER32.DLL:DispatchMessageA');
const orig=dispatchDef.handler;
const msgLog=[];
dispatchDef.handler=()=>{
  const pMsg=emu.readArg(0);
  const hwnd=emu.memory.readU32(pMsg);
  const message=emu.memory.readU32(pMsg+4);
  msgLog.push(`0x${hwnd.toString(16)} msg=0x${message.toString(16)}`);
  return orig();
};

// 1) IDLE traffic for 2s — are the caret/toolbar timers still firing at all?
msgLog.length=0;
await pump(2000);
const idleCounts=new Map();
for(const l of msgLog)idleCounts.set(l,(idleCounts.get(l)||0)+1);
ol(`=== idle 2s: ${msgLog.length} dispatches ===`);
for(const [k,c] of [...idleCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12)) ol(`${String(c).padStart(5)}  ${k}`);
ol(`activeTimers=${emu.timers?emu.timers.size:'?'}`);

// 2) Click with full API trace across the whole post-click window
const WM_MOUSEMOVE=0x0200,WM_LBUTTONDOWN=0x0201,WM_LBUTTONUP=0x0202;
const cx=400,cy=300;
emu.cursorX=cx;emu.cursorY=cy;
const hit=emu.windowFromPoint(cx,cy);
ol(`hit: 0x${hit.hwnd.toString(16)} (${hit.x},${hit.y})`);
msgLog.length=0;
const traceLines=[];capture=traceLines;emu.traceApi=true;
emu.postMessage(hit.hwnd,WM_MOUSEMOVE,0,(hit.y<<16)|hit.x);
emu.postMessage(hit.hwnd,WM_LBUTTONDOWN,1,(hit.y<<16)|hit.x);
emu.postMessage(hit.hwnd,WM_LBUTTONUP,0,(hit.y<<16)|hit.x);
await pump(600);
emu.traceApi=false;capture=null;
ol(`=== dispatched after click (${msgLog.length}) ===`);
for(const l of msgLog.slice(0,30)) ol(l);
ol(`=== API calls in 600ms post-click (${traceLines.length}) ===`);
const apiCounts=new Map();
for(const l of traceLines)apiCounts.set(l,(apiCounts.get(l)||0)+1);
for(const [k,c] of [...apiCounts.entries()].slice(0,150)) ol(`${String(c).padStart(5)}  ${k}`);
process.exit(0);
