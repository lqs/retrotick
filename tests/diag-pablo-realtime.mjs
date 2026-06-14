// Diag: pump the message loop in REAL TIME for ~6s so the app's real
// setInterval timers (caret blink 200ms, toolbar timers 200/300ms) fire like
// in the browser. Captures dispatch traffic, queue depth, big paints, and
// end-to-end latency of a posted click.
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
const pdLines=[];
console.log=(...a)=>{const s=a.join(' ');if(s.startsWith('[PD]'))pdLines.push(s);};
await emu.load(ab,peInfo,mockCanvas);emu.run();
let t=0,le=0,st=0;
while(!emu.waitingForMessage&&!emu.halted&&t<2_000_000){emu.tick();t++;if(emu.cpu.eip===le)st++;else{st=0;le=emu.cpu.eip;}if(st>5000)break;}
ol(`=== msg loop @ ${t} ===`);

// Track dispatches + wall time
const dispatchDef=emu.apiDefs.get('USER32.DLL:DispatchMessageA');
const origDispatch=dispatchDef.handler;
const counts=new Map();let dispBusyMs=0;
const wndName=(h)=>{const w=emu.handles.get(h);if(!w)return`0x${h.toString(16)}`;const cn=w.classInfo?.className||'?';return`0x${h.toString(16)}(${cn.startsWith('Afx')?(h===0x1015?'EDITOR':h===0x105f?'PREVIEW':h===0x1010?'FRAME':cn.slice(0,10)):cn.slice(0,18)})`;};
dispatchDef.handler=()=>{
  const pMsg=emu.readArg(0);
  const hwnd=emu.memory.readU32(pMsg);
  const message=emu.memory.readU32(pMsg+4);
  const k=`${wndName(hwnd)} 0x${message.toString(16)}`;
  counts.set(k,(counts.get(k)||0)+1);
  const t0=performance.now();
  const r=origDispatch();
  dispBusyMs+=performance.now()-t0;
  return r;
};

// REAL-TIME pump for 6s: small sleeps let setInterval timers fire like in the browser.
const T0=performance.now();
let maxQ=0;
while(performance.now()-T0<6000){
  await delay(5);
  let p=0;
  while(p<20_000&&!emu.halted){emu.tick();p++;}
  if(emu.messageQueue.length>maxQ)maxQ=emu.messageQueue.length;
}
ol(`=== 6s realtime pump done. dispatch busy=${dispBusyMs.toFixed(0)}ms (${(dispBusyMs/60).toFixed(0)}% duty), maxQueue=${maxQ} ===`);
for(const [k,c] of [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15)) ol(`${String(c).padStart(6)}  ${k}`);
ol(`=== [PD] instrumentation lines (${pdLines.length}) ===`);
for(const l of pdLines.slice(-25)) ol(l);

// CLICK LATENCY: post a click into the editor and measure time until its
// WM_LBUTTONDOWN is dispatched, while timers keep firing.
const WM_LBUTTONDOWN=0x0201,WM_LBUTTONUP=0x0202;
let clickDispatchedAt=0;
const prevHandler=dispatchDef.handler;
dispatchDef.handler=()=>{
  const pMsg=emu.readArg(0);
  const message=emu.memory.readU32(pMsg+4);
  if(message===WM_LBUTTONDOWN&&!clickDispatchedAt)clickDispatchedAt=performance.now();
  return prevHandler();
};
const clickPostedAt=performance.now();
emu.postMessage(0x1015,WM_LBUTTONDOWN,1,(50<<16)|50);
emu.postMessage(0x1015,WM_LBUTTONUP,0,(50<<16)|50);
while(performance.now()-clickPostedAt<3000&&!clickDispatchedAt){
  await delay(5);
  let p=0;
  while(p<20_000&&!emu.halted){emu.tick();p++;}
}
ol(`=== click latency: ${clickDispatchedAt?`${(clickDispatchedAt-clickPostedAt).toFixed(0)}ms`:'NOT DISPATCHED within 3s'} ===`);
process.exit(0);
