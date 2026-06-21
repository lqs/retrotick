// Closing a window (X button → WM_SYSCOMMAND/SC_CLOSE) must terminate the process
// and fire emu.onExit exactly ONCE so the EmulatorView shell tears down on a SINGLE
// click. Previously onExit never fired under the kernel (emuTick, which fires it for
// the legacy backend, is a no-op here), so the first click only destroyed the guest
// window and a second click was needed to close the shell.
import fs from 'node:fs';
import { parsePE } from '../src/lib/pe/parse.ts';
import { bootstrapKernelPE } from '../src/lib/emu/v86/kernel-bootstrap.ts';

const wasmBytes = fs.readFileSync(new URL('../node_modules/v86/build/v86.wasm', import.meta.url));
const b = fs.readFileSync(new URL('../examples/calc.exe', import.meta.url));
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const mc = new Proxy({}, { get: () => () => ({ width: 8, data: new Uint8ClampedArray(4) }) });
const { emu, rt } = await bootstrapKernelPE(ab, parsePE(ab), { wasmBytes, exeName: 'calc.exe' });
emu.canvas = { width: 300, height: 300, style: {}, getContext: () => mc }; emu.canvasCtx = mc;

let onExitCalls = 0, onCrashCalls = 0;
emu.onExit = () => { onExitCalls++; };
emu.onCrash = () => { onCrashCalls++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const finish = (ok, msg) => { console.log(`\n[RESULT] window close fires onExit once: ${ok ? 'PASS' : 'FAIL'} ${msg}`); process.exit(ok ? 0 : 1); };

(async () => {
    for (let i = 0; i < 60 && !emu.waitingForMessage; i++) await sleep(100);
    if (!emu.waitingForMessage) return finish(false, '(never reached message loop)');
    await sleep(300);
    emu.postMessage(emu.mainWindow, 0x0112 /*WM_SYSCOMMAND*/, 0xF060 /*SC_CLOSE*/, 0);
    await sleep(2500);
    console.log(`[close] onExit=${onExitCalls} onCrash=${onCrashCalls} mainWnd=0x${(emu.mainWindow >>> 0).toString(16)}`);
    finish(onExitCalls === 1 && onCrashCalls === 0, `(onExit fired ${onExitCalls}×, onCrash ${onCrashCalls}×, window destroyed)`);
})();
setTimeout(() => finish(false, '(timeout)'), 12000);
rt.run().catch(e => { console.error('threw', String(e).slice(0, 150)); finish(false, '(threw)'); });
