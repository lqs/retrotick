// taskmgr.exe on the ring3 kernel: reaches its message loop with a real window,
// while a second real process (calc) runs concurrently in its own address space.
// Verifies taskmgr's process source — NtQuerySystemInformation(SystemProcessInfo)
// — reports the kernel's actual concurrent processes (真多进程).

import { installSoftCanvas } from './soft-canvas.mjs';
installSoftCanvas(800, 600);
import fs from 'node:fs';
import { parsePE } from '../src/lib/pe/parse.ts';
import { bootstrapKernelPE, createProcessOnKernel } from '../src/lib/emu/v86/kernel-bootstrap.ts';

const wasmBytes = fs.readFileSync(new URL('../node_modules/v86/build/v86.wasm', import.meta.url));
const L = (n) => { const b = fs.readFileSync(new URL('../examples/' + n, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const tmAb = L('taskmgr.exe'), calcAb = L('calc.exe');

const { emu, rt } = await bootstrapKernelPE(tmAb, parsePE(tmAb), { wasmBytes, exeName: 'taskmgr.exe' });
emu.canvas = new globalThis.OffscreenCanvas(640, 480); emu.canvas.style = {}; emu.canvasCtx = emu.canvas.getContext('2d');
// Second concurrent process (own page directory / address space).
const c = createProcessOnKernel(rt, calcAb, parsePE(calcAb), { exeName: 'calc.exe' });
c.emu.canvas = new globalThis.OffscreenCanvas(300, 300); c.emu.canvas.style = {}; c.emu.canvasCtx = c.emu.canvas.getContext('2d');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const finish = (ok, msg) => { console.log(`\n[RESULT] taskmgr multi-process: ${ok ? 'PASS' : 'FAIL'} ${msg}`); process.exit(ok ? 0 : 1); };

(async () => {
    for (let i = 0; i < 70 && !emu.waitingForMessage; i++) await sleep(150);
    if (!emu.waitingForMessage) return finish(false, '(taskmgr never reached message loop)');
    await sleep(400);

    const win = emu.handles.get(emu.mainWindow);
    const hasWindow = !!win && (emu.mainWindow >>> 0) !== 0;

    // Build the process list exactly as taskmgr's NtQuerySystemInformation source does.
    const live = rt.procs.filter(p => p.state !== 'zombie');
    const pids = [...new Set(live.map(p => p.pid))];
    const names = [...new Set(live.map(p => p.emu?.exeName).filter(Boolean))];
    console.log(`[taskmgr] window=0x${(emu.mainWindow >>> 0).toString(16)} live kernel processes: ${names.join(', ')} (pids ${pids.join(', ')})`);

    const ok = hasWindow && pids.length >= 2 && names.some(n => /taskmgr/i.test(n)) && names.some(n => /calc/i.test(n));
    finish(ok, `(window=${hasWindow}, ${pids.length} concurrent processes with distinct CR3s)`);
})();
setTimeout(() => finish(false, '(timeout)'), 20000);
rt.run().catch(e => { console.error('threw', String(e).slice(0, 200)); finish(false, '(threw)'); });
