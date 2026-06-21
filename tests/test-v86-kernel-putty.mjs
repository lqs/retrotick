// Kernel test: PuTTY reaches its message loop.
//
// PuTTY exercises two kernel features that earlier crashed every program that
// used them during CRT/Winsock init:
//   * GetProcAddress — PuTTY resolves Winsock + newer KERNEL32 APIs at runtime;
//     under the kernel GetProcAddress must hand back a trappable `int 0x2E` thunk
//     for registered APIs (and 0 for unimplemented ones so its fallback runs),
//     not the own-backend thunkToApi address (which faults when called).
//   * Static TLS (__declspec(thread)) — the loader must allocate the per-thread
//     TLS data block from the image's TLS directory and link it into
//     TEB.ThreadLocalStoragePointer, or `mov ebp, fs:[2C][idx]; mov [ebp+4],…`
//     faults through a NULL slot during init.
// Reaching the message loop confirms both are in place.

import fs from 'node:fs';
import { parsePE } from '../src/lib/pe/parse.ts';
import { bootstrapKernelPE } from '../src/lib/emu/v86/kernel-bootstrap.ts';

globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const wasmBytes = fs.readFileSync(new URL('../node_modules/v86/build/v86.wasm', import.meta.url));
const peBytes = fs.readFileSync(new URL('../examples/putty.exe', import.meta.url));
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

const { emu, rt } = await bootstrapKernelPE(ab, parsePE(ab), { wasmBytes, exeName: 'putty.exe' });
emu.canvas = { width: 800, height: 600, style: {}, getContext: () => mc }; emu.canvasCtx = mc;

let crashed = false, crashReason = '';
emu.onCrash = (addr, reason) => { crashed = true; crashReason = `${reason} @${addr}`; };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const finish = (ok, msg) => { console.log(`\n[RESULT] kernel putty: ${ok ? 'PASS' : 'FAIL'} ${msg}`); process.exit(ok ? 0 : 1); };

rt.run().catch(() => {});
(async () => {
    for (let i = 0; i < 100 && !emu.waitingForMessage && !crashed; i++) await sleep(50);
    if (crashed) return finish(false, `(crashed: ${crashReason})`);
    if (!emu.waitingForMessage) return finish(false, '(never reached message loop)');
    console.log(`[putty] reached message loop; mainWindow=0x${(emu.mainWindow >>> 0).toString(16)}`);
    finish(!emu.halted && (emu.mainWindow >>> 0) !== 0,
        '(GetProcAddress thunks + static TLS in place; alive at message loop)');
})();
setTimeout(() => finish(false, '(timeout)'), 20000);
