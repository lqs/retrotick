import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

const noop = () => {};
function makeCtx(c){return{fillRect:noop,clearRect:noop,strokeRect:noop,fillText:noop,strokeText:noop,measureText:()=>({width:8}),drawImage:noop,putImageData:noop,getImageData:(x,y,w,h)=>({data:new Uint8ClampedArray(Math.max(1,w|0)*Math.max(1,h|0)*4),width:w,height:h}),createImageData:(w,h)=>({data:new Uint8ClampedArray(Math.max(1,w|0)*Math.max(1,h|0)*4),width:w,height:h}),save:noop,restore:noop,translate:noop,scale:noop,rotate:noop,setTransform:noop,resetTransform:noop,transform:noop,beginPath:noop,closePath:noop,moveTo:noop,lineTo:noop,arc:noop,arcTo:noop,rect:noop,ellipse:noop,fill:noop,stroke:noop,clip:noop,createLinearGradient:()=>({addColorStop:noop}),createRadialGradient:()=>({addColorStop:noop}),createPattern:()=>null,font:'',textAlign:'left',textBaseline:'top',fillStyle:'',strokeStyle:'',lineWidth:1,globalAlpha:1,canvas:c};}
function makeCanvas(w,h){const c={width:w??800,height:h??600,toDataURL:()=>'',addEventListener:noop,removeEventListener:noop,style:{cursor:'default'},parentElement:{style:{cursor:'default'}}};c.getContext=()=>makeCtx(c);return c;}
const mockCanvas=makeCanvas(800,600);
globalThis.document={createElement:()=>makeCanvas(800,600),title:''};
globalThis.OffscreenCanvas=class{constructor(w,h){Object.assign(this,makeCanvas(w,h));this.width=w;this.height=h;}};
globalThis.requestAnimationFrame=(cb)=>setTimeout(cb,0);
globalThis.Image=class{set src(_){}};
globalThis.URL={createObjectURL:()=>'blob:mock',revokeObjectURL:noop};
globalThis.Blob=class{constructor(){}};

const EXE='C:/Users/Olivier/Downloads/PabloDraw-2.0.8.70/PabloDraw.exe';
const fb=readFileSync(EXE);const ab=new ArrayBuffer(fb.byteLength);new Uint8Array(ab).set(fb);
const peInfo=parsePE(ab);
const emu=new Emulator();emu.screenWidth=1024;emu.screenHeight=768;
emu.registryStore=new RegistryStore();emu.profileStore=new ProfileStore();
const divErrors=[];const ow=console.warn.bind(console);console.warn=(...a)=>{const s=a.join(' ');if(s.includes('[DIV ERROR]'))divErrors.push(s);ow(...a);};
const ol=console.log;console.log=()=>{};
await emu.load(ab,peInfo,mockCanvas);emu.run();
let t=0,le=0,st=0;
while(!emu.waitingForMessage&&!emu.halted&&t<2_000_000){emu.tick();t++;if(emu.cpu.eip===le)st++;else{st=0;le=emu.cpu.eip;}if(st>5000)break;}
console.log=ol;
console.log(`msg loop @ ${t} ticks`);

const VIEW=0x1015;
const WM_PAINT=0x000F;
const msgsToView={};
const origCall=emu.callWndProc.bind(emu);
emu.callWndProc=(proc,hwnd,msg,wp,lp)=>{ if(hwnd===VIEW){msgsToView[msg]=(msgsToView[msg]||0)+1;} return origCall(proc,hwnd,msg,wp,lp); };

const v=emu.handles.get(VIEW);
console.log(`view wndProc=0x${(v.wndProc||0).toString(16)} needsPaint=${v.needsPaint}`);

// 1) Mark needsPaint then WAKE the parked message loop with WM_NULL so
//    GetMessage re-runs and synthesizePaint can deliver WM_PAINT to the view.
const WM_NULL=0x0000;
console.log=()=>{};
function repaintAll(h){const w=emu.handles.get(h);if(!w)return;w.needsPaint=true;w.needsErase=true;if(w.childList)for(const c of w.childList)repaintAll(c);}
repaintAll(emu.mainWindow);
emu.postMessage(emu.mainWindow, WM_NULL, 0, 0);
emu.postMessage(VIEW, WM_NULL, 0, 0);
let p=0; while(p<300_000 && !emu.halted && divErrors.length===0){
  emu.tick();p++;
  if(p%40_000===0){ repaintAll(emu.mainWindow); emu.postMessage(emu.mainWindow, WM_NULL, 0, 0); }
}
console.log=ol;
console.log(`after needsPaint+wake pump: WM_PAINT to view = ${msgsToView[WM_PAINT]||0}, div=${divErrors.length}`);

// 2) Try emu.invalidateRect-style if available, then pump
console.log=()=>{};
if (typeof emu.invalidateWindow === 'function') emu.invalidateWindow(VIEW);
v.needsPaint=true;
// Also directly send WM_PAINT with a BeginPaint-provided DC via getWindowDC
try{ const hdc=emu.getWindowDC(VIEW); const r=origCall(v.wndProc,VIEW,WM_PAINT,hdc,0);
  let p2=0; while(p2<150_000&&!emu.halted&&divErrors.length===0){emu.tick();p2++;}
}catch(e){}
console.log=ol;
console.log(`after direct WM_PAINT: WM_PAINT to view = ${msgsToView[WM_PAINT]||0}, div=${divErrors.length}`);
console.log(`messages seen by view: ${JSON.stringify(Object.fromEntries(Object.entries(msgsToView).map(([k,vv])=>['0x'+(+k).toString(16),vv])))}`);
for(const e of divErrors) console.log('  '+e);
process.exit(0);
