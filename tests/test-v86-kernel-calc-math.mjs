// M5/key-interaction: calc.exe performs real arithmetic on the ring3 kernel.
// Reaches the message loop, then posts WM_COMMAND button clicks (2 + 3 =) and
// reads back the SciCalc display control (id 403). Each post resumes the parked
// CPU, dispatches to calc's ring3 wndproc, and re-parks — exercising the full
// interactive loop end to end.

import fs from 'node:fs';
import { parsePE } from '../src/lib/pe/parse.ts';
import { bootstrapKernelPE } from '../src/lib/emu/v86/kernel-bootstrap.ts';

const wasmBytes = fs.readFileSync(new URL('../node_modules/v86/build/v86.wasm', import.meta.url));
const b = fs.readFileSync(new URL('../examples/calc.exe', import.meta.url));
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const mc = new Proxy({}, { get: () => () => ({ width: 8, data: new Uint8ClampedArray(4) }) });
const { emu, rt } = await bootstrapKernelPE(ab, parsePE(ab), { wasmBytes, exeName: 'calc.exe' });
emu.canvas = { width: 300, height: 300, style: {}, getContext: () => mc }; emu.canvasCtx = mc;

const WM_COMMAND = 0x0111;
const DIGIT = (n) => 124 + n;   // SciCalc digit button IDs: 0→124 … 9→133
const ID_PLUS = 92, ID_EQUALS = 112, ID_DISPLAY = 403; // verified against SciCalc

const readDisplay = () => {
    const main = emu.handles.get(emu.mainWindow);
    const childHwnd = main?.children?.get?.(ID_DISPLAY);
    const child = childHwnd ? emu.handles.get(childHwnd) : null;
    return (child?.title ?? '').trim();
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const click = async (id) => { emu.postMessage(emu.mainWindow, WM_COMMAND, id, 0); await sleep(120); };

const finish = (ok, msg) => { console.log(`\n[RESULT] calc arithmetic: ${ok ? 'PASS' : 'FAIL'} ${msg}`); process.exit(ok ? 0 : 1); };

(async () => {
    // wait for message loop
    for (let i = 0; i < 60 && !emu.waitingForMessage; i++) await sleep(100);
    if (!emu.waitingForMessage) return finish(false, '(never reached message loop)');
    await sleep(200);
    const before = readDisplay();
    await click(DIGIT(2));
    await click(ID_PLUS);
    await click(DIGIT(3));
    await click(ID_EQUALS);
    await sleep(200);
    const after = readDisplay();
    console.log(`[calc] display before="${before}" after 2+3==> "${after}"`);
    finish(after.replace(/\.$/, '') === '5', `(display="${after}", expected 5)`);
})();
setTimeout(() => finish(false, '(timeout)'), 20000);
rt.run().catch(e => { console.error('threw', String(e).slice(0, 200)); finish(false, '(threw)'); });
