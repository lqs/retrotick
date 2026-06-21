// Kernel test: a screensaver (.scr) launched with "/s" enters RUN mode (creates
// its fullscreen WindowsScreenSaverClass window), not config mode.
//
// Regression for an empty GetCommandLine under the kernel: env.ts built the
// command-line string eagerly at DLL-registration time, when the process's
// address space isn't active yet, so the write landed in the wrong AS and the
// guest read "". A screensaver then missed its "/s" run flag, fell into config
// mode, and crashed. GetCommandLine is now built lazily on first call.
import fs from 'node:fs';
import { parsePE } from '../src/lib/pe/parse.ts';
import { bootstrapKernelPE } from '../src/lib/emu/v86/kernel-bootstrap.ts';

globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const wasmBytes = fs.readFileSync(new URL('../node_modules/v86/build/v86.wasm', import.meta.url));
const b = fs.readFileSync(new URL('../examples/ssmaze.scr', import.meta.url));
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

const { emu, rt } = await bootstrapKernelPE(ab, parsePE(ab), { wasmBytes, exeName: 'ssmaze.scr', commandLine: '/s' });
const mc = new Proxy({}, { get: (_t, k) => { if (k === 'getContext') return () => null; if (k === 'measureText') return () => ({ width: 8 }); return () => {}; }, set: () => true });
emu.canvas = { width: 800, height: 600, style: {}, getContext: () => null }; emu.canvasCtx = mc;

let crashed = false, saverWindow = false;
emu.onCrash = (a, r) => { crashed = true; console.log(`[scr] crash: ${r} @${a}`); };
const origLog = console.log;
console.log = (...a) => { if (/WindowsScreenSaverClass/.test(a.join(' '))) saverWindow = true; origLog(...a); };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const finish = (ok, msg) => { console.log = origLog; console.log(`\n[RESULT] kernel screensaver: ${ok ? 'PASS' : 'FAIL'} ${msg}`); process.exit(ok ? 0 : 1); };
rt.run().catch(() => {});
(async () => {
    for (let i = 0; i < 100 && !crashed && !saverWindow; i++) await sleep(50);
    await sleep(200);
    const cmd = emu.commandLine;
    finish(!crashed && saverWindow && cmd === '/s',
        `(GetCommandLine="/s", created WindowsScreenSaverClass run-mode window, no crash)`);
})();
setTimeout(() => finish(false, '(timeout)'), 15000);
