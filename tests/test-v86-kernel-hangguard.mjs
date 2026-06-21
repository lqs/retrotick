// Safety: a guest callback that enters an infinite loop must NOT hang forever.
// callRing3Callback bounds the synchronous main-thread spin by wall-clock time
// (CB_BUDGET_MS) and terminates the process, so the browser tab stays usable.
// Here a "wndproc" at a user page is just `jmp $` (infinite loop); invoking it
// as a ring3 callback must return (timed out) within a few seconds, not hang.

import fs from 'node:fs';
import { KernelRuntime } from '../src/lib/emu/v86/kernel-runtime.ts';
import { patchFsBase } from '../src/lib/emu/v86/kernel-stub.ts';
import { TEB_VA_BASE, DEFAULT_IMAGE_BASE, PTE_PRESENT, PTE_RW, PTE_USER } from '../src/lib/emu/v86/kconst.ts';

const wasmBytes = fs.readFileSync(new URL('../node_modules/v86/build/v86.wasm', import.meta.url));
const F = PTE_PRESENT | PTE_RW | PTE_USER;
const ENTRY = DEFAULT_IMAGE_BASE + 0x1000;       // tiny ring3 program: just spin
const HANGPROC = DEFAULT_IMAGE_BASE + 0x2000;    // the "callback" that infinite-loops
const STACK_TOP = 0x00130000;

const rt = new KernelRuntime({ wasmBytes });
await rt.init();
const proc = rt.createProcess();
proc.as.mapRange(ENTRY, 1, F);
proc.as.mapRange(HANGPROC, 1, F);
proc.as.mapRange(STACK_TOP - 0x1000, 1, F);
proc.as.mapRange(TEB_VA_BASE, 1, F);
proc.as.writeBytes(ENTRY, new Uint8Array([0xEB, 0xFE]));     // entry: jmp $ (park the main thread; we invoke the callback from JS)
proc.as.writeBytes(HANGPROC, new Uint8Array([0xEB, 0xFE]));  // callback: jmp $ (infinite loop)
proc.as.writeU32(TEB_VA_BASE + 0x18, TEB_VA_BASE);
proc.entryVA = ENTRY; proc.userStackTop = STACK_TOP - 4; proc.tebVA = TEB_VA_BASE;
patchFsBase(rt.emu, TEB_VA_BASE);
rt.setFirstLaunch(proc);
rt.run().catch(() => {});

// Let the process launch (it spins at ENTRY). Then invoke the hanging callback
// synchronously and time how long callRing3Callback takes to give up.
await new Promise(r => setTimeout(r, 500));
// Mark the process parked so callRing3Callback treats it as a valid target.
proc.state = 'blocked';
proc.parkedR0esp = proc.ring0StackTop - 0x40;
// Write a plausible parked iret frame so userESP is readable (offset +44).
proc.as.writeU32(proc.parkedR0esp + 44, STACK_TOP - 0x40);

const t0 = Date.now();
const ret = rt.callRing3Callback(HANGPROC, [], proc.emu);
const elapsed = Date.now() - t0;

const ok = elapsed < 5000; // must have given up (≈CB_BUDGET_MS), not hung
console.log(`[hangguard] callRing3Callback on infinite-loop returned ${ret} after ${elapsed}ms; proc.state=${proc.state}`);
console.log(`\n[RESULT] hang guard: ${ok ? 'PASS' : 'FAIL'} (infinite-loop callback bounded to ${elapsed}ms, tab not frozen)`);
process.exit(ok ? 0 : 1);
