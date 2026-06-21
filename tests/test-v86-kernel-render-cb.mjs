// Regression for the render-path crash: buildOverlays() makes MANY synchronous
// callWndProc calls (WM_CTLCOLORSTATIC / WM_CTLCOLORBTN / WM_DRAWITEM, one per
// control) while the app is parked in GetMessage. Each MUST run transparently on
// the ring3 user stack and leave the parked state untouched, so the next one
// also runs cleanly. A scheduling side-effect in one callback previously left
// _idle=false, making the next callback run the wndproc on the ring0 stack →
// #PF kernel-range → terminate. This drives the exact callWndProc storm.

import fs from 'node:fs';
import { parsePE } from '../src/lib/pe/parse.ts';
import { bootstrapKernelPE } from '../src/lib/emu/v86/kernel-bootstrap.ts';

const wasmBytes = fs.readFileSync(new URL('../node_modules/v86/build/v86.wasm', import.meta.url));
const b = fs.readFileSync(new URL('../examples/calc.exe', import.meta.url));
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const mc = new Proxy({}, { get: () => () => ({ width: 8, data: new Uint8ClampedArray(4) }) });
const { emu, rt } = await bootstrapKernelPE(ab, parsePE(ab), { wasmBytes, exeName: 'calc.exe' });
emu.canvas = { width: 300, height: 300, style: {}, getContext: () => mc }; emu.canvasCtx = mc;

let avSeen = false, exhausted = false;
const origErr = console.error, origWarn = console.warn;
console.error = (...a) => { if (/kernel-AV/.test(a.join(' '))) avSeen = true; origErr(...a); };
console.warn = (...a) => { if (/exhausted/.test(a.join(' '))) exhausted = true; origWarn(...a); };

const WM_CTLCOLORSTATIC = 0x0138, WM_CTLCOLORBTN = 0x0135;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const finish = (ok, msg) => { console.log(`\n[RESULT] render-path callWndProc storm: ${ok ? 'PASS' : 'FAIL'} ${msg}`); process.exit(ok ? 0 : 1); };

(async () => {
    for (let i = 0; i < 60 && !emu.waitingForMessage; i++) await sleep(100);
    if (!emu.waitingForMessage) return finish(false, '(never reached message loop)');
    await sleep(200);

    const main = emu.handles.get(emu.mainWindow);
    const wndProc = main?.wndProc;
    const children = main?.children ? [...main.children.values()] : [];
    if (!wndProc || children.length === 0) return finish(false, '(no wndProc/children)');

    // Simulate several full render passes (buildOverlays) — a storm of synchronous
    // color/owner-draw callbacks across all controls, exactly like the UI does.
    let ran = 0;
    for (let pass = 0; pass < 3; pass++) {
        for (const childHwnd of children) {
            emu.callWndProc(wndProc, emu.mainWindow, WM_CTLCOLORSTATIC, 0, childHwnd);
            emu.callWndProc(wndProc, emu.mainWindow, WM_CTLCOLORBTN, 0, childHwnd);
            ran += 2;
            if (avSeen || emu.halted) break;
        }
        await sleep(30);
        if (avSeen || emu.halted) break;
    }

    const alive = !emu.halted && emu.waitingForMessage && (emu.mainWindow >>> 0) !== 0;
    console.log(`[render] ${ran} synchronous callWndProc across ${children.length} controls × 3 passes: avSeen=${avSeen} exhausted=${exhausted} alive=${alive}`);
    finish(!avSeen && !exhausted && alive, `(no kernel-range AV, no exhaustion, app alive after ${ran} render callbacks)`);
})();
setTimeout(() => finish(false, '(timeout)'), 20000);
rt.run().catch(e => { origErr('threw', String(e).slice(0, 200)); finish(false, '(threw)'); });
