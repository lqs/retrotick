// M6: two processes concurrently on one kernel. Process 1 (calc, GUI) blocks at
// GetMessage; the scheduler then runs Process 2 (hello, console) to completion.
// Proves per-process page directories, CR3 switching on schedule, isolated
// Emulator state, and cooperative multi-process scheduling.

import fs from 'node:fs';
import { parsePE } from '../src/lib/pe/parse.ts';
import { bootstrapKernelPE, createProcessOnKernel } from '../src/lib/emu/v86/kernel-bootstrap.ts';

const wasmBytes = fs.readFileSync(new URL('../node_modules/v86/build/v86.wasm', import.meta.url));
const load = (name) => { const b = fs.readFileSync(new URL('../examples/' + name, import.meta.url)); const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); return { ab, pe: parsePE(ab) }; };
const calc = load('calc.exe');
const hello = load('hello.exe');
const mockCtx = { fillRect(){},fillText(){},measureText(){return{width:8}},getImageData(){return{data:new Uint8ClampedArray(4)}},putImageData(){},drawImage(){},save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},fill(){},clearRect(){},setTransform(){},translate(){},fillStyle:'',strokeStyle:'',font:'',createImageData(){return{data:new Uint8ClampedArray(4)}} };

// Process 1: calc (first-launch).
const { rt, emu: calcEmu } = await bootstrapKernelPE(calc.ab, calc.pe, { wasmBytes });
calcEmu.canvas = { width:300, height:300, getContext: () => mockCtx }; calcEmu.canvasCtx = mockCtx;

// Process 2: hello (added to the same kernel; scheduler launches it).
const { emu: helloEmu, proc: helloProc } = createProcessOnKernel(rt, hello.ab, hello.pe, {});
let helloOut = '';
helloEmu.consoleWriteChar = (ch) => { helloOut += String.fromCharCode(ch); };
helloEmu.isConsole = true;

console.log(`[test] calc pid=${rt.procs[0].pid} cr3=0x${rt.procs[0].as.pdPhys.toString(16)}; hello pid=${helloProc.pid} cr3=0x${helloProc.as.pdPhys.toString(16)}`);

let done = false;
const finish = (ok, msg) => { if (done) return; done = true; console.log(`\n[RESULT] M6 multi-process: ${ok ? 'PASS' : 'FAIL'} ${msg}`); process.exit(ok ? 0 : 1); };

const iv = setInterval(() => {
    const calcAtLoop = calcEmu.waitingForMessage;
    const helloDone = helloOut.includes('Hello');
    if (calcAtLoop && helloDone) {
        clearInterval(iv);
        finish(true, `(calc reached msg loop; hello printed ${JSON.stringify(helloOut.trim())}; distinct CR3s)`);
    }
}, 300);
setTimeout(() => { clearInterval(iv); finish(false, `(calc.waiting=${calcEmu.waitingForMessage} helloOut=${JSON.stringify(helloOut)})`); }, 14000);
rt.run().catch(e => { clearInterval(iv); console.error('[test] run threw', String(e).slice(0,200)); finish(false, '(run threw)'); });
