// Diag: does the frame keep repainting forever at idle (paint feedback loop)?
// Counts every DispatchMessageA (hwnd, message) while pumping idle after the
// message loop is reached. A healthy app converges to zero dispatches.
import { readFileSync } from 'fs';
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
console.log=()=>{};
await emu.load(ab,peInfo,mockCanvas);emu.run();
let t=0,le=0,st=0;
while(!emu.waitingForMessage&&!emu.halted&&t<2_000_000){emu.tick();t++;if(emu.cpu.eip===le)st++;else{st=0;le=emu.cpu.eip;}if(st>5000)break;}
console.log=ol;
ol(`=== msg loop @ ${t} ticks ===`);

// Wrap DispatchMessageA to count (hwnd, message)
const dispatchDef = emu.apiDefs.get('USER32.DLL:DispatchMessageA');
const origDispatch = dispatchDef.handler;
const counts = new Map();
const wndName = (h)=>{const w=emu.handles.get(h);return w?`0x${h.toString(16)}(${w.classInfo?.className||'?'})`:`0x${h.toString(16)}`;};
dispatchDef.handler = () => {
  const pMsg = emu.readArg(0);
  const hwnd = emu.memory.readU32(pMsg);
  const message = emu.memory.readU32(pMsg + 4);
  const key = `${wndName(hwnd)} msg=0x${message.toString(16)}`;
  counts.set(key, (counts.get(key)||0)+1);
  return origDispatch();
};

// Pump idle: flush rAF/setTimeout-driven PeekMessage resumes, tick a lot.
for(let i=0;i<40;i++){ await new Promise(r=>setTimeout(r,0)); let p=0; while(p<30_000 && !emu.halted){ emu.tick(); p++; } }

ol(`=== dispatches during 40 idle rounds ===`);
const sorted=[...counts.entries()].sort((a,b)=>b[1]-a[1]);
for(const [k,c] of sorted) ol(`${String(c).padStart(6)}  ${k}`);
if(sorted.length===0) ol('(none — idle converged, no loop)');

// Second window: do another 40 rounds and see if it KEEPS dispatching.
counts.clear();
for(let i=0;i<40;i++){ await new Promise(r=>setTimeout(r,0)); let p=0; while(p<30_000 && !emu.halted){ emu.tick(); p++; } }
ol(`=== dispatches during NEXT 40 idle rounds (loop if non-empty) ===`);
const sorted2=[...counts.entries()].sort((a,b)=>b[1]-a[1]);
for(const [k,c] of sorted2) ol(`${String(c).padStart(6)}  ${k}`);
if(sorted2.length===0) ol('(none — idle converged, no loop)');
process.exit(0);
