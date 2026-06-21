// M5: run the real calc.exe (GUI) through the ring3 kernel and confirm it
// reaches its message loop. Exercises the synchronous nested-wndproc path under
// ring3 (CreateWindowEx → WM_NCCREATE/WM_CREATE/WM_PAINT dispatched to calc's
// wndproc running at ring3, which draws its buttons via GDI), then GetMessageW
// parks the CPU on the kernel HALT block.

import fs from 'node:fs';
import { parsePE } from '../src/lib/pe/parse.ts';
import { bootstrapKernelPE } from '../src/lib/emu/v86/kernel-bootstrap.ts';

const wasmBytes = fs.readFileSync(new URL('../node_modules/v86/build/v86.wasm', import.meta.url));
const peBytes = fs.readFileSync(new URL('../examples/calc.exe', import.meta.url));
const ab = peBytes.buffer.slice(peBytes.byteOffset, peBytes.byteOffset + peBytes.byteLength);
const peInfo = parsePE(ab);

const mockCtx = {
    fillRect(){}, fillText(){}, measureText(){return {width:8};}, getImageData(){return {data:new Uint8ClampedArray(4)};},
    putImageData(){}, drawImage(){}, save(){}, restore(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){}, fill(){},
    clearRect(){}, setTransform(){}, translate(){}, fillStyle:'', strokeStyle:'', font:'', createImageData(){return {data:new Uint8ClampedArray(4)};},
};
const { emu, rt, loaded } = await bootstrapKernelPE(ab, peInfo, { wasmBytes });
emu.canvas = { width: 300, height: 300, getContext: () => mockCtx };
emu.canvasCtx = mockCtx;

console.log(`[test] calc entry=0x${loaded.entryVA.toString(16)} imports=${loaded.imports.length}`);

let done = false;
const finish = (ok, msg) => { if (done) return; done = true; console.log(`\n[RESULT] M5 calc reaches message loop: ${ok ? 'PASS' : 'FAIL'} ${msg||''}`); process.exit(ok ? 0 : 1); };

const iv = setInterval(() => {
    if (emu.waitingForMessage) {
        clearInterval(iv);
        finish(true, `(windows=${emu.windows?.length ?? '?'})`);
    }
}, 300);

setTimeout(() => { clearInterval(iv); finish(false, '(timed out before message loop)'); }, 12000);
rt.emu.add_listener('emulator-stopped', () => { clearInterval(iv); finish(emu.waitingForMessage, '(stopped early, exit=' + emu.exitCode + ')'); });
rt.run().catch(e => { clearInterval(iv); console.error('[test] run threw', e); finish(false); });
