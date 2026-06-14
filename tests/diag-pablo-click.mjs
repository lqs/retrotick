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

const EXE='C:/Users/Olivier/Downloads/PabloDraw-2.0.8.70/PabloDraw.exe';
const fb=readFileSync(EXE);const ab=new ArrayBuffer(fb.byteLength);new Uint8Array(ab).set(fb);
const peInfo=parsePE(ab);
const emu=new Emulator();emu.screenWidth=1440;emu.screenHeight=517;
emu.registryStore=new RegistryStore();emu.profileStore=new ProfileStore();
const ol=console.log;console.log=()=>{};
await emu.load(ab,peInfo,mockCanvas);emu.run();
let t=0,le=0,st=0;
while(!emu.waitingForMessage&&!emu.halted&&t<2_000_000){emu.tick();t++;if(emu.cpu.eip===le)st++;else{st=0;le=emu.cpu.eip;}if(st>5000)break;}
console.log=ol;
console.log(`msg loop @ ${t} ticks, waiting=${emu.waitingForMessage}`);

// Count SetCapture calls
let setCaptureCount=0;
const realLog=console.log;
console.log=(...a)=>{const s=a.join(' ');if(s.includes('[SetCapture]'))setCaptureCount++;};

const VIEW=0x1015;
const WM_LBUTTONDOWN=0x0201, WM_LBUTTONUP=0x0202, WM_MOUSEMOVE=0x0200, MK_LBUTTON=0x0001;
const lp=(100<<16)|100;

// Simulate a single click on the editor view
emu.postMessage(VIEW, WM_LBUTTONDOWN, MK_LBUTTON, lp);
// Drain: does the app spin or return to GetMessage?
let p=0, becameIdle=false, idleAt=0;
while(p<400_000 && !emu.halted){
  emu.tick(); p++;
  if(emu.waitingForMessage){ becameIdle=true; idleAt=p; break; }
}
// Now send the button up (like the browser would on release)
emu.postMessage(VIEW, WM_LBUTTONUP, 0, lp);
let p2=0, idle2=false;
while(p2<400_000 && !emu.halted){
  emu.tick(); p2++;
  if(emu.waitingForMessage){ idle2=true; break; }
}
console.log=realLog;
console.log(`After WM_LBUTTONDOWN: idle=${becameIdle} (after ${idleAt} ticks), halted=${emu.halted}`);
console.log(`After WM_LBUTTONUP:   idle=${idle2} (pumped ${p2}), halted=${emu.halted}`);
console.log(`SetCapture calls during click: ${setCaptureCount}`);
console.log(`capturedWindow now = 0x${(emu.capturedWindow||0).toString(16)}`);
console.log(`SPIN? ${(!becameIdle||!idle2)?'YES — never returned to GetMessage (CPU 100% freeze reproduced)':'no'}`);
process.exit(0);
