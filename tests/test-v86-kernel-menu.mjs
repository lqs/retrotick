// Regression for the menu-click crash: when an app is parked in GetMessage and
// the UI dispatches a command via DIRECT emu.callWndProc (synchronous, the path
// MenuBar uses — distinct from postMessage which the other tests used), the
// callback must run on the process's ring3 USER stack, not the ring0 stack.
// Previously it ran on the ring0 stack → #PF kernel-range → process terminated.

import fs from 'node:fs';
import { parsePE } from '../src/lib/pe/parse.ts';
import { bootstrapKernelPE } from '../src/lib/emu/v86/kernel-bootstrap.ts';

const wasmBytes = fs.readFileSync(new URL('../node_modules/v86/build/v86.wasm', import.meta.url));
const b = fs.readFileSync(new URL('../examples/calc.exe', import.meta.url));
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const mc = new Proxy({}, { get: () => () => ({ width: 8, data: new Uint8ClampedArray(4) }) });
const { emu, rt } = await bootstrapKernelPE(ab, parsePE(ab), { wasmBytes, exeName: 'calc.exe' });
emu.canvas = { width: 300, height: 300, style: {}, getContext: () => mc }; emu.canvasCtx = mc;

let avSeen = false;
const origErr = console.error;
console.error = (...a) => { if (/kernel-AV/.test(a.join(' '))) avSeen = true; origErr(...a); };

const WM_COMMAND = 0x0111;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ID_DISPLAY = 403;
const readDisplay = () => { const m = emu.handles.get(emu.mainWindow); const c = m?.children?.get?.(ID_DISPLAY); const w = c ? emu.handles.get(c) : null; return (w?.title ?? '').trim(); };
const finish = (ok, msg) => { console.log(`\n[RESULT] menu direct-callWndProc: ${ok ? 'PASS' : 'FAIL'} ${msg}`); process.exit(ok ? 0 : 1); };

(async () => {
    for (let i = 0; i < 60 && !emu.waitingForMessage; i++) await sleep(100);
    if (!emu.waitingForMessage) return finish(false, '(never reached message loop)');
    await sleep(200);

    // Dispatch messages via DIRECT callWndProc — the synchronous path MenuBar /
    // EmulatorView use for WM_INITMENU/WM_COMMAND while the app is parked in
    // GetMessage. This previously ran the wndproc on the ring0 stack → #PF
    // kernel-range → process terminated. After the fix it must run on the ring3
    // user stack: the wndproc executes (observable via API calls), no access
    // violation fires, and the app stays alive at its message loop.
    const wnd = emu.handles.get(emu.mainWindow);
    const wndProc = wnd?.wndProc;
    if (!wndProc) return finish(false, '(no wndProc on main window)');

    let wndprocRan = false;
    for (const [, d] of emu.apiDefs) { const o = d.handler; d.handler = (e) => { wndprocRan = true; return o(e); }; }

    // The exact crashing sequence: EmulatorView's menu-open handler dispatches
    // WM_INITMENU + WM_INITMENUPOPUP synchronously via callWndProc while the app
    // is parked in GetMessage. Both are query callbacks (no worker-thread wait),
    // matching real menu interaction.
    const WM_INITMENU = 0x0116, WM_INITMENUPOPUP = 0x0117;
    emu.callWndProc(wndProc, emu.mainWindow, WM_INITMENU, 0, 0);
    emu.callWndProc(wndProc, emu.mainWindow, WM_INITMENUPOPUP, 0, 0);
    await sleep(200);

    const alive = !emu.halted && emu.waitingForMessage && (emu.mainWindow >>> 0) !== 0;
    console.log(`[menu] direct callWndProc: avSeen=${avSeen} wndprocRan=${wndprocRan} alive=${alive} display="${readDisplay()}"`);
    finish(!avSeen && alive && wndprocRan,
        `(no kernel-range access violation; wndproc ran on ring3 user stack; app still at message loop)`);
})();
setTimeout(() => finish(false, '(timeout)'), 18000);
rt.run().catch(e => { origErr('threw', String(e).slice(0, 200)); finish(false, '(threw)'); });
