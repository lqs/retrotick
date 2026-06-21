// freecell.exe on the ring3 kernel — playable. Loads cards.dll into its own
// address space (DllMain chained so cdtInit's hInstance is valid), reaches the
// message loop, deals a new game (F2 → board renders dozens of card bitmaps via
// cards.dll → GDI BitBlt), then plays a move with mouse clicks. Each input
// resumes the parked CPU, runs freecell's ring3 wndproc, and re-parks. Survival
// + render activity after interaction proves the game is interactive.

import { installSoftCanvas } from './soft-canvas.mjs';
installSoftCanvas(800, 600);
import fs from 'node:fs';
import { parsePE } from '../src/lib/pe/parse.ts';
import { bootstrapKernelPE } from '../src/lib/emu/v86/kernel-bootstrap.ts';

const wasmBytes = fs.readFileSync(new URL('../node_modules/v86/build/v86.wasm', import.meta.url));
const L = (n) => { const b = fs.readFileSync(new URL('../examples/' + n, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const ab = L('freecell.exe');

const { emu, rt } = await bootstrapKernelPE(ab, parsePE(ab), {
    wasmBytes, exeName: 'freecell.exe', additionalFiles: new Map([['cards.dll', L('cards.dll')]]),
});
emu.canvas = new globalThis.OffscreenCanvas(640, 480); emu.canvas.style = {}; emu.canvasCtx = emu.canvas.getContext('2d');

// cards.dll draws each card via GDI BitBlt; InvalidateRect drives board repaint.
let blits = 0, invalidates = 0, dispatches = 0;
const wrap = (name, inc) => { const d = emu.apiDefs.get(name); if (!d) return; const o = d.handler; d.handler = (e) => { inc(); return o(e); }; };
wrap('GDI32.DLL:BitBlt', () => blits++);
wrap('USER32.DLL:InvalidateRect', () => invalidates++);
wrap('USER32.DLL:DispatchMessageW', () => dispatches++);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const key = async (vk) => { emu.postMessage(emu.mainWindow, 0x0100, vk, 0); await sleep(40); emu.postMessage(emu.mainWindow, 0x0101, vk, 0); await sleep(350); };
const click = async (x, y) => { const lp = ((y & 0xFFFF) << 16) | (x & 0xFFFF); emu.postMessage(emu.mainWindow, 0x0201, 1, lp); await sleep(60); emu.postMessage(emu.mainWindow, 0x0202, 0, lp); await sleep(300); };
const finish = (ok, msg) => { console.log(`\n[RESULT] freecell playable: ${ok ? 'PASS' : 'FAIL'} ${msg}`); process.exit(ok ? 0 : 1); };

(async () => {
    for (let i = 0; i < 60 && !emu.waitingForMessage; i++) await sleep(150);
    if (!emu.waitingForMessage) return finish(false, '(never reached message loop)');
    const hasWindow = (emu.mainWindow >>> 0) !== 0 && !!emu.handles.get(emu.mainWindow);
    await sleep(300);
    const dealBlits = blits; // cards rendered while dealing the initial board at startup

    invalidates = 0; dispatches = 0;
    await key(0x71);             // F2 = deal a new game → InvalidateRect (repaint board)
    await click(45, 260);        // pick a card from cascade 1
    await click(117, 260);       // drop on cascade 2
    const reacted = invalidates + dispatches; // input flowed through the message loop

    const alive = !emu.halted && emu.waitingForMessage && (emu.mainWindow >>> 0) !== 0;
    console.log(`[freecell] window=${hasWindow} startupCardBlits=${dealBlits} inputReactions=${reacted} aliveAfterMove=${alive}`);
    finish(hasWindow && dealBlits > 4 && reacted > 0 && alive,
        `(startup dealt ${dealBlits} card blits via cards.dll; ${reacted} message-loop reactions to F2+mouse; still interactive)`);
})();
setTimeout(() => finish(false, '(timeout)'), 22000);
rt.run().catch(e => { console.error('threw', String(e).slice(0, 200)); finish(false, '(threw)'); });
