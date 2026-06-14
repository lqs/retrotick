import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

const noop = () => {};
function makeCtx(c){return{fillRect:noop,clearRect:noop,strokeRect:noop,fillText:noop,strokeText:noop,measureText:()=>({width:8}),drawImage:noop,putImageData:noop,getImageData:(x,y,w,h)=>({data:new Uint8ClampedArray(Math.max(1,w|0)*Math.max(1,h|0)*4),width:w,height:h}),createImageData:(w,h)=>({data:new Uint8ClampedArray(Math.max(1,w|0)*Math.max(1,h|0)*4),width:w,height:h}),save:noop,restore:noop,translate:noop,scale:noop,rotate:noop,setTransform:noop,resetTransform:noop,transform:noop,getTransform:()=>({a:1,b:0,c:0,d:1,e:0,f:0}),beginPath:noop,closePath:noop,moveTo:noop,lineTo:noop,arc:noop,arcTo:noop,rect:noop,ellipse:noop,fill:noop,stroke:noop,clip:noop,createLinearGradient:()=>({addColorStop:noop}),createRadialGradient:()=>({addColorStop:noop}),createPattern:()=>null,font:'',textAlign:'left',textBaseline:'top',fillStyle:'',strokeStyle:'',lineWidth:1,globalAlpha:1,canvas:c};}
function makeCanvas(w,h){const c={width:w??800,height:h??600,toDataURL:()=>'',addEventListener:noop,removeEventListener:noop,style:{cursor:'default'},parentElement:{style:{cursor:'default'}}};c.getContext=()=>makeCtx(c);return c;}
const mockCanvas=makeCanvas(854,528);
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

// Capture only [PAINTDIAG] lines; suppress everything else.
const diag=[];
const ol=console.log.bind(console);
console.log=(...a)=>{const s=a.join(' ');if(s.includes('[PAINTDIAG]')||s.includes('[PD]'))diag.push(s);};

await emu.load(ab,peInfo,mockCanvas);emu.run();
let t=0,le=0,st=0;
while(!emu.waitingForMessage&&!emu.halted&&t<2_000_000){emu.tick();t++;if(emu.cpu.eip===le)st++;else{st=0;le=emu.cpu.eip;}if(st>5000)break;}

// Pump the natural message loop a bit (no forced full repaints) so any
// app-driven invalidations / layout paints flow through.
let p=0; while(p<400_000 && !emu.halted){emu.tick();p++;}

console.log=ol;
console.log(`=== msg loop @ ${t} ticks, pumped ${p} ===`);
console.log(`[PAINTDIAG] lines: ${diag.length}`);
for(const l of diag) console.log(l.replace('[PAINTDIAG] ',''));

// Dump window tree sizes for context
function dump(h,d){const w=emu.handles.get(h);if(!w)return;console.log(`${' '.repeat(d*2)}0x${h.toString(16)} cls=${w.classInfo?.className??w.className} ${w.width}x${w.height}@(${w.x},${w.y}) vis=${w.visible} ctrlId=0x${(w.controlId??0).toString(16)} wndProc=0x${(w.wndProc||0).toString(16)}`);if(w.childList)for(const c of w.childList)dump(c,d+1);}
console.log('--- tree ---');
dump(emu.mainWindow,0);

// Probe WM_NCCALCSIZE inset for the colour bar (cid 5) and charset (cid 6).
const WM_NCCALCSIZE=0x0083;
function probeNc(cid){
  let target=0,tw;
  for(const [h,w] of emu.handles.findByType('window')){ if((w.controlId??0)===cid){target=h;tw=w;break;} }
  if(!target){console.log(`NCprobe cid=${cid}: not found`);return;}
  const p=emu.allocHeap(52); for(let i=0;i<52;i+=4) emu.memory.writeU32(p+i,0);
  emu.memory.writeI32(p,0); emu.memory.writeI32(p+4,0); emu.memory.writeI32(p+8,tw.width); emu.memory.writeI32(p+12,tw.height);
  try{ emu.callWndProc(tw.wndProc,target,WM_NCCALCSIZE,1,p); }catch(e){console.log('NCprobe err',e.message);}
  const l=emu.memory.readI32(p),t=emu.memory.readI32(p+4),r=emu.memory.readI32(p+8),b=emu.memory.readI32(p+12);
  console.log(`NCprobe cid=${cid} 0x${target.toString(16)} win=${tw.width}x${tw.height} -> clientRect=(${l},${t},${r},${b}) inset=(l${l},t${t},r${tw.width-r},b${tw.height-b})`);
}
console.log('--- ncprobe ---');
probeNc(5); probeNc(6);
console.log('--- scroll ---');
for(const [h,w] of emu.handles.findByType('window')){
  if((w.style&0x00200000)||(w.style&0x00100000)||w.scrollV||w.scrollH){
    console.log(`0x${h.toString(16)} cls=${w.classInfo?.className} style=0x${w.style.toString(16)} VSCROLL=${!!(w.style&0x00200000)} HSCROLL=${!!(w.style&0x00100000)} scrollV=${JSON.stringify(w.scrollV)} scrollH=${JSON.stringify(w.scrollH)}`);
  }
}
process.exit(0);
