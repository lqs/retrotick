import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

const noop = () => {};
function makeCtx(c){return{fillRect:noop,clearRect:noop,strokeRect:noop,fillText:noop,strokeText:noop,measureText:()=>({width:8}),drawImage:noop,putImageData:noop,getImageData:(x,y,w,h)=>({data:new Uint8ClampedArray(Math.max(1,w|0)*Math.max(1,h|0)*4),width:w,height:h}),createImageData:(w,h)=>({data:new Uint8ClampedArray(Math.max(1,w|0)*Math.max(1,h|0)*4),width:w,height:h}),save:noop,restore:noop,translate:noop,scale:noop,rotate:noop,setTransform:noop,resetTransform:noop,transform:noop,getTransform:()=>({a:1,b:0,c:0,d:1,e:0,f:0}),beginPath:noop,closePath:noop,moveTo:noop,lineTo:noop,arc:noop,arcTo:noop,rect:noop,ellipse:noop,fill:noop,stroke:noop,clip:noop,createLinearGradient:()=>({addColorStop:noop}),createRadialGradient:()=>({addColorStop:noop}),createPattern:()=>null,font:'',textAlign:'left',textBaseline:'top',fillStyle:'',strokeStyle:'',lineWidth:1,globalAlpha:1,canvas:c};}
function makeCanvas(w,h){const c={width:w??800,height:h??600,toDataURL:()=>'',addEventListener:noop,removeEventListener:noop,style:{cursor:'default'},parentElement:{style:{cursor:'default'}}};c.getContext=()=>makeCtx(c);return c;}
const mockCanvas=makeCanvas(800,600);
globalThis.document={createElement:()=>makeCanvas(800,600),title:''};
globalThis.OffscreenCanvas=class{constructor(w,h){Object.assign(this,makeCanvas(w,h));this.width=w;this.height=h;}};
globalThis.requestAnimationFrame=(cb)=>setTimeout(cb,0);
globalThis.Image=class{set src(_){}};
globalThis.URL={createObjectURL:()=>'blob:mock',revokeObjectURL:noop};
globalThis.Blob=class{constructor(){}};

const SCREEN_W = Number(process.argv[2]) || 1024;
const SCREEN_H = Number(process.argv[3]) || 768;
const EXE='C:/Users/Olivier/Downloads/PabloDraw-2.0.8.70/PabloDraw.exe';
const fb=readFileSync(EXE);const ab=new ArrayBuffer(fb.byteLength);new Uint8Array(ab).set(fb);
const peInfo=parsePE(ab);
const emu=new Emulator();emu.screenWidth=SCREEN_W;emu.screenHeight=SCREEN_H;
emu.registryStore=new RegistryStore();emu.profileStore=new ProfileStore();
const divErrors=[];const ow=console.warn.bind(console);console.warn=(...a)=>{const s=a.join(' ');if(s.includes('[DIV ERROR]'))divErrors.push(s);ow(...a);};
const ol=console.log;console.log=()=>{};
await emu.load(ab,peInfo,mockCanvas);emu.run();
let t=0,le=0,st=0;
while(!emu.waitingForMessage&&!emu.halted&&t<2_000_000){emu.tick();t++;if(emu.cpu.eip===le)st++;else{st=0;le=emu.cpu.eip;}if(st>5000)break;}
console.log=ol;
console.log(`screen=${SCREEN_W}x${SCREEN_H}  msg loop @ ${t} ticks`);

const VIEW=0x1015;
const WM_TIMER=0x0113, WM_NULL=0x0000;
function repaintAll(h){const w=emu.handles.get(h);if(!w)return;w.needsPaint=true;w.needsErase=true;if(w.childList)for(const c of w.childList)repaintAll(c);}

// Fire the blink timer (id=1) on the view several times, waking the loop each round.
console.log=()=>{};
for (let round=0; round<20 && divErrors.length===0 && !emu.halted; round++) {
  emu.postMessage(VIEW, WM_TIMER, 1, 0);     // ID_BLINK_TIMER = 1
  emu.postMessage(emu.mainWindow, WM_NULL, 0, 0); // wake
  let p=0; while(p<60_000 && !emu.halted && divErrors.length===0){emu.tick();p++;}
  repaintAll(emu.mainWindow);
  emu.postMessage(emu.mainWindow, WM_NULL, 0, 0);
  p=0; while(p<60_000 && !emu.halted && divErrors.length===0){emu.tick();p++;}
}
console.log=ol;
console.log(`After timer rounds: halted=${emu.halted} reason=${emu.cpu.haltReason||'none'} DIV ERRORS=${divErrors.length}`);
for(const e of divErrors) console.log('  '+e.split('\n')[0]);
process.exit(0);
