// Diag: why does the toolbar WM_LBUTTONUP hit-test not deliver WM_COMMAND?
// Dumps tbButtons/tbButtonSize and traces the dispatch path of the click.
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
ol(`=== msg loop @ ${t} ===`);

function findToolbar(hwnd){const w=emu.handles.get(hwnd);if(!w)return null;if(w.classInfo?.className==='ToolbarWindow32')return{hwnd,w};if(w.childList)for(const ch of w.childList){const r=findToolbar(ch);if(r)return r;}return null;}
const tb=findToolbar(emu.mainWindow);
if(!tb){ol('NO TOOLBAR');process.exit(1);}
ol(`toolbar 0x${tb.hwnd.toString(16)} wndProc=0x${(tb.w.wndProc>>>0).toString(16)} size=${tb.w.width}x${tb.w.height}`);
ol(`tbButtonSize=${tb.w.tbButtonSize===undefined?'undefined':'0x'+tb.w.tbButtonSize.toString(16)}`);
ol(`tbButtons=${tb.w.tbButtons?JSON.stringify(tb.w.tbButtons):'undefined'}`);

// Trace what messages reach the toolbar's wndProc + what DispatchMessageA does
const WM_COMMAND=0x0111,WM_LBUTTONDOWN=0x0201,WM_LBUTTONUP=0x0202;
const events=[];
const origCall=emu.callWndProc.bind(emu);
emu.callWndProc=(proc,hwnd,msg,wParam,lParam)=>{
  if(hwnd===tb.hwnd||msg===WM_COMMAND){events.push(`callWndProc hwnd=0x${hwnd.toString(16)} msg=0x${msg.toString(16)} wParam=0x${(wParam>>>0).toString(16)}`);}
  return origCall(proc,hwnd,msg,wParam,lParam);
};
const lParam=(12<<16)|12;
emu.postMessage(tb.hwnd,WM_LBUTTONDOWN,1,lParam);
emu.postMessage(tb.hwnd,WM_LBUTTONUP,0,lParam);
let p=0;
while(p<200_000){emu.tick();p++;}
ol(`=== events (${events.length}) ===`);
for(const e of events.slice(0,40)) ol(e);
process.exit(0);
