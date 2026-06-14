import { readFileSync } from 'fs';
import { setTimeout as delay } from 'timers/promises';
import { createCanvas } from '@napi-rs/canvas';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';
const noop = () => {};
function wrap(c){c.addEventListener=noop;c.removeEventListener=noop;c.style={cursor:'default'};c.parentElement={style:{cursor:'default'}};c.toDataURL=()=>'';return c;}
function mkCanvas(w,h){return wrap(createCanvas(Math.max(1,w|0)||1,Math.max(1,h|0)||1));}
const SW=Number(process.argv[2])||1024, SH=Number(process.argv[3])||768;
const mainCanvas=mkCanvas(SW,SH);
globalThis.document={createElement:()=>mkCanvas(SW,SH),title:''};
globalThis.OffscreenCanvas=class{constructor(w,h){return mkCanvas(w,h);}};
globalThis.requestAnimationFrame=(cb)=>setTimeout(cb,0);
globalThis.Image=class{set src(_){}};globalThis.URL={createObjectURL:()=>'blob:mock',revokeObjectURL:noop};globalThis.Blob=class{constructor(){}};
const EXE='C:/Users/Olivier/Downloads/PabloDraw-2.0.8.70/PabloDraw.exe';
const fb=readFileSync(EXE);const ab=new ArrayBuffer(fb.byteLength);new Uint8Array(ab).set(fb);
const peInfo=parsePE(ab);
const emu=new Emulator();emu.screenWidth=SW;emu.screenHeight=SH;
emu.registryStore=new RegistryStore();emu.profileStore=new ProfileStore();
const ol=console.log.bind(console);console.log=noop;
await emu.load(ab,peInfo,mainCanvas);emu.run();
let t=0,le=0,st=0;
while(!emu.waitingForMessage&&!emu.halted&&t<2_000_000){emu.tick();t++;if(emu.cpu.eip===le)st++;else{st=0;le=emu.cpu.eip;}if(st>5000)break;}
async function pump(ms){const T0=performance.now();while(performance.now()-T0<ms){await delay(5);let p=0;while(p<20_000&&!emu.halted){emu.tick();p++;}}}
await pump(800);
console.log=ol;
function origin(h){let x=0,y=0,cur=h;while(cur&&cur!==emu.mainWindow){const w=emu.handles.get(cur);if(!w)break;x+=w.x;y+=w.y;const p=emu.handles.get(w.parent);if(p&&p.hwnd!==emu.mainWindow){if(p.ncInset){x+=p.ncInset.l;y+=p.ncInset.t;}else{}}cur=w.parent;}return{x,y};}
function dump(h,label){const w=emu.handles.get(h);if(!w){ol(`${label} 0x${h.toString(16)}: gone`);return;}ol(`${label} 0x${h.toString(16)} local@${w.x},${w.y} ${w.width}x${w.height} ncInset=${w.ncInset?JSON.stringify(w.ncInset):'none'}`);}
ol(`=== screen ${SW}x${SH} ===`);
dump(0x102b,'bottom dock ');
dump(0x104b,'CColourWindow');
dump(0x104f,'CColourView  ');
// Trap the swatch FillRects in the colour view to get canvas Y range
const fills=[];
const def=emu.apiDefs.get('USER32.DLL:FillRect');const o=def.handler;
def.handler=()=>{const hdc=emu.readArg(0),rp=emu.readArg(1);const dc=emu.handles.get(hdc);const tp=emu.memory.readI32(rp+4),b=emu.memory.readI32(rp+12);let f=0;try{f=dc.ctx.getTransform().f;}catch{}if(dc&&dc.hwnd===0x104f)fills.push({cy0:Math.round(f+tp),cy1:Math.round(f+b)});return o();};
const v=emu.handles.get(0x104f);if(v){v.needsPaint=true;v.needsErase=true;}
emu.postMessage(emu.mainWindow,0,0,0);
await pump(400);
if(fills.length){
  const cb=emu.handles.get(0x102b);
  const minCY=Math.min(...fills.map(f=>f.cy0)),maxCY=Math.max(...fills.map(f=>f.cy1));
  const dockTop=cb?cb.y:0,dockBot=cb?cb.y+cb.height:0;
  ol(`swatch canvas Y: ${minCY}..${maxCY}; bottom dock canvas Y: ${dockTop}..${dockBot}`);
  ol(`margin above swatches: ${minCY-dockTop}px; margin below: ${dockBot-maxCY}px`);
}else ol('no swatch fills captured');
process.exit(0);
