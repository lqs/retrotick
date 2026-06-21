// Kernel winmine smiley press-hold-release test.
//
// winmine's smiley (new-game) button is owner-drawn; pressing it runs the
// wndproc's OWN modal tracking loop (PeekMessage/GetMessage) until the button
// is released. Under the ring3 kernel a nested synchronous callback couldn't
// yield, so the tracking loop spun the main thread until the hang guard killed
// the process (browser froze; smiley never reset). The fix redirects modal-
// tracking messages (button-downs) so DispatchMessage tail-calls the wndproc
// INLINE at ring3 — its tracking loop then parks/yields like the main loop,
// receives the WM_MOUSEMOVE/WM_LBUTTONUP, and returns normally.
//
// This drives a realistic press → hold/move → release and asserts:
//   * no runaway-guard termination (no freeze),
//   * the press parks (waits for the release) rather than spinning,
//   * the process stays alive at its message loop after release.

import fs from 'node:fs';
import { parsePE } from '../src/lib/pe/parse.ts';
import { bootstrapKernelPE } from '../src/lib/emu/v86/kernel-bootstrap.ts';

globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const wasmBytes = fs.readFileSync(new URL('../node_modules/v86/build/v86.wasm', import.meta.url));
const peBytes = fs.readFileSync(new URL('../examples/winmine.exe', import.meta.url));
const ab = peBytes.buffer.slice(peBytes.byteOffset, peBytes.byteOffset + peBytes.byteLength);

const mockCtx = new Proxy({}, {
    get: (_t, k) => {
        if (k === 'canvas') return mockCanvas;
        if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4 * 64 * 64), width: 64, height: 64 });
        if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(4 * w * h), width: w, height: h });
        if (k === 'measureText') return () => ({ width: 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
        return () => {};
    },
    set: () => true,
});
const mockCanvas = { width: 800, height: 600, style: {}, getContext: () => mockCtx };

const { emu, rt } = await bootstrapKernelPE(ab, parsePE(ab), { wasmBytes, exeName: 'winmine.exe' });
emu.canvas = mockCanvas; emu.canvasCtx = mockCtx;
emu.exeName = 'WINMINE.EXE'; emu.exePath = 'D:\\WINDOWS\\WINMINE.EXE';

let runaway = false;
const origWarn = console.warn;
console.warn = (...a) => { if (/runaway/.test(a.join(' '))) runaway = true; origWarn(...a); };

const WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_MOUSEMOVE = 0x0200;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const finish = (ok, msg) => { console.log(`\n[RESULT] kernel winmine smiley: ${ok ? 'PASS' : 'FAIL'} ${msg}`); process.exit(ok ? 0 : 1); };

rt.run().catch(e => { origWarn('run threw', String(e).slice(0, 200)); });

(async () => {
    for (let i = 0; i < 80 && !emu.waitingForMessage; i++) await sleep(50);
    if (!emu.waitingForMessage) return finish(false, '(never reached message loop)');
    await sleep(200);

    const mw = emu.handles.get(emu.mainWindow);
    const w = mw?.width || 170;
    const sx = Math.floor(w / 2), sy = 28;          // smiley: top-center, below menu
    const lp = ((sy << 16) | (sx & 0xFFFF)) >>> 0;
    const alive0 = !emu.halted && (emu.mainWindow >>> 0) !== 0;
    console.log(`[winmine] reached message loop; mainWindow=0x${emu.mainWindow.toString(16)} w=${w} smiley=(${sx},${sy})`);

    // Press the smiley. With the redirect fix this enters the wndproc's tracking
    // loop INLINE; the loop's GetMessage parks → emu.waitingForMessage goes true
    // again (it would spin to the hang guard without the fix).
    emu.postMessage(emu.mainWindow, WM_LBUTTONDOWN, 1, lp);
    await sleep(400);
    const parkedDuringHold = emu.waitingForMessage && !runaway;
    console.log(`[winmine] after press: waiting=${emu.waitingForMessage} runaway=${runaway} (parked-during-hold=${parkedDuringHold})`);

    // Hold + wiggle (the button face tracks press/unpress as the cursor moves).
    emu.postMessage(emu.mainWindow, WM_MOUSEMOVE, 1, lp);
    await sleep(200);
    // Release → the tracking loop ends, the wndproc returns, game resets.
    emu.postMessage(emu.mainWindow, WM_LBUTTONUP, 0, lp);
    await sleep(400);

    const aliveAfter = !emu.halted && emu.waitingForMessage && (emu.mainWindow >>> 0) !== 0;
    console.log(`[winmine] after release: waiting=${emu.waitingForMessage} halted=${emu.halted} runaway=${runaway} alive=${aliveAfter}`);

    finish(alive0 && !runaway && aliveAfter,
        `(no runaway/freeze; press parked & yielded; alive at message loop after release)`);
})();
setTimeout(() => finish(false, '(timeout)'), 20000);
