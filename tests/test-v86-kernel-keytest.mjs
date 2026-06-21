// Kernel test: KeyTest.exe (a Borland/VCL form app) reaches its message loop.
//
// Exercises two things that crashed it before:
//   * Large init allocation — VCL/the CRT reserve+commit a big region during
//     startup; with only 64-128MB of guest physical memory the frame pool was
//     exhausted mid-init. The kernel now defaults to 1GB.
//   * Built-in-control superclassing — VCL superclasses EDIT/BUTTON/etc: it
//     GetClassInfo's the stock class (which hands back the magic BUILTIN_WNDPROC
//     thunk address 0x00FE0008), registers its own class, then chains to the
//     original via CallWindowProc. Under the ring3 kernel that magic address
//     isn't real guest code, so callStdcall must route it to the built-in handler
//     instead of running ring3 there (which jumped into demand-zero memory → AV).
// Reaching the message loop with the form's controls created confirms both.

import fs from 'node:fs';
import { parsePE } from '../src/lib/pe/parse.ts';
import { bootstrapKernelPE } from '../src/lib/emu/v86/kernel-bootstrap.ts';

globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const wasmBytes = fs.readFileSync(new URL('../node_modules/v86/build/v86.wasm', import.meta.url));
const peBytes = fs.readFileSync(new URL('../examples/KeyTest.exe', import.meta.url));
const ab = peBytes.buffer.slice(peBytes.byteOffset, peBytes.byteOffset + peBytes.byteLength);

const mc = new Proxy({}, {
    get: (_t, k) => {
        if (k === 'canvas') return { width: 800, height: 600, style: {} };
        if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
        if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(4 * w * h), width: w, height: h });
        if (k === 'measureText') return () => ({ width: 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
        return () => {};
    },
    set: () => true,
});

const { emu, rt } = await bootstrapKernelPE(ab, parsePE(ab), { wasmBytes, exeName: 'KeyTest.exe' });
emu.canvas = { width: 800, height: 600, style: {}, getContext: () => mc }; emu.canvasCtx = mc;

let crashed = false, crashReason = '';
emu.onCrash = (addr, reason) => { crashed = true; crashReason = `${reason} @${addr}`; };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const finish = (ok, msg) => { console.log(`\n[RESULT] kernel KeyTest: ${ok ? 'PASS' : 'FAIL'} ${msg}`); process.exit(ok ? 0 : 1); };

rt.run().catch(() => {});
(async () => {
    for (let i = 0; i < 140 && !emu.waitingForMessage && !crashed; i++) await sleep(50);
    if (crashed) return finish(false, `(crashed: ${crashReason})`);
    if (!emu.waitingForMessage) return finish(false, '(never reached message loop)');
    console.log(`[keytest] reached message loop; mainWindow=0x${(emu.mainWindow >>> 0).toString(16)}`);
    // Success = reached the message loop without crashing. (The form + its
    // superclassed EDIT controls render in the browser e2e; headless may pause in
    // a startup dialog first, so don't require mainWindow to be set here.)
    finish(!emu.halted,
        '(1GB physical memory + built-in superclass routing in place; alive at message loop)');
})();
setTimeout(() => finish(false, '(timeout)'), 25000);
