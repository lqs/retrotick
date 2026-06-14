// Diag: watch 0x1015's paint flags over time + log InvalidateRect calls,
// to find who eats the editor's needsPaint without delivering WM_PAINT.
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
const ol=console.log.bind(console);console.log=noop;
await emu.load(ab,peInfo,mockCanvas);emu.run();
let t=0,le=0,st=0;
while(!emu.waitingForMessage&&!emu.halted&&t<2_000_000){emu.tick();t++;if(emu.cpu.eip===le)st++;else{st=0;le=emu.cpu.eip;}if(st>5000)break;}
ol(`=== msg loop @ ${t} ===`);

const lines=[];
// Log InvalidateRect / ValidateRect / UpdateWindow with args
for(const [name,nArgs] of [['USER32.DLL:InvalidateRect',3],['USER32.DLL:ValidateRect',2],['USER32.DLL:UpdateWindow',1]]){
  const def=emu.apiDefs.get(name);
  if(!def)continue;
  const orig=def.handler;
  const short=name.split(':')[1];
  def.handler=()=>{
    const hwnd=emu.readArg(0);
    let extra='';
    if(short==='InvalidateRect'){
      const rp=emu.readArg(1),er=emu.readArg(2);
      if(rp){extra=` rect=(${emu.memory.readI32(rp)},${emu.memory.readI32(rp+4)})-(${emu.memory.readI32(rp+8)},${emu.memory.readI32(rp+12)})`;}
      extra+=` bErase=${er}`;
    }
    const r=orig();
    const w=emu.handles.get(hwnd);
    lines.push(`${short}(0x${hwnd.toString(16)})${extra} -> needsPaint=${w?w.needsPaint:'?'} needsErase=${w?w.needsErase:'?'} painting=${w?w.painting:'?'}`);
    return r;
  };
}
// Log BeginPaint/EndPaint
for(const name of ['USER32.DLL:BeginPaint','USER32.DLL:EndPaint']){
  const def=emu.apiDefs.get(name);
  const orig=def.handler;
  const short=name.split(':')[1];
  def.handler=()=>{
    const hwnd=emu.readArg(0);
    lines.push(`${short}(0x${hwnd.toString(16)})`);
    return orig();
  };
}
// Sample 0x1015 flags every 100ms
async function pump(ms){const T0=performance.now();while(performance.now()-T0<ms){await delay(5);let p=0;while(p<20_000&&!emu.halted){emu.tick();p++;}}}
for(let k=0;k<10;k++){
  await pump(100);
  const w=emu.handles.get(0x1015);
  lines.push(`-- t=${(k+1)*100}ms 0x1015: needsPaint=${w.needsPaint} needsErase=${w.needsErase} painting=${w.painting} visible=${w.visible}`);
}
console.log=ol;
for(const l of lines) ol(l);
process.exit(0);
