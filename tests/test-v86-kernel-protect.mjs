// M3: hardware-enforced memory protection. A ring3 program first reads its
// (committed, demand-paged) stack — must succeed — then dereferences NULL,
// which must raise an access violation and terminate the process (the legacy
// identity-mapped backend silently allowed near-NULL/NULL access).

import fs from 'node:fs';
import { KernelRuntime } from '../src/lib/emu/v86/kernel-runtime.ts';
import { patchFsBase } from '../src/lib/emu/v86/kernel-stub.ts';
import { TEB_VA_BASE, DEFAULT_IMAGE_BASE, PTE_PRESENT, PTE_RW, PTE_USER } from '../src/lib/emu/v86/kconst.ts';

const wasmBytes = fs.readFileSync(new URL('../node_modules/v86/build/v86.wasm', import.meta.url));
const ENTRY = DEFAULT_IMAGE_BASE + 0x1000, STACK_TOP = 0x00130000, F = PTE_PRESENT | PTE_RW | PTE_USER;

// mov ebx,[esp-4] (committed stack read, OK); mov eax,[0] (NULL → AV); jmp $
const PROG = new Uint8Array([0x8B, 0x5C, 0x24, 0xFC, 0xA1, 0x00, 0x00, 0x00, 0x00, 0xEB, 0xFE]);

const rt = new KernelRuntime({ wasmBytes });
await rt.init();
const proc = rt.createProcess();
proc.as.mapRange(ENTRY, 1, F);
proc.as.mapRange(STACK_TOP - 0x1000, 1, F);
proc.as.mapRange(TEB_VA_BASE, 1, F);
proc.as.writeBytes(ENTRY, PROG);
proc.as.writeU32(TEB_VA_BASE + 0x18, TEB_VA_BASE);
proc.entryVA = ENTRY; proc.userStackTop = STACK_TOP - 4; proc.tebVA = TEB_VA_BASE;
patchFsBase(rt.emu, TEB_VA_BASE);
rt.setFirstLaunch(proc);

let avAtNull = false;
const origErr = console.error;
console.error = (...a) => { const s = a.join(' '); if (/null-guard.*VA=0x0\b/.test(s)) avAtNull = true; origErr(...a); };

rt.emu.add_listener('emulator-stopped', () => {
    console.log(`\n[RESULT] M3 memory protection: ${avAtNull ? 'PASS (committed stack read OK; NULL deref → AV → terminate)' : 'FAIL (no NULL access violation)'}`);
    process.exit(avAtNull ? 0 : 1);
});
setTimeout(() => { console.log('[RESULT] M3 memory protection: FAIL (timeout)'); process.exit(1); }, 8000);
rt.run().catch(e => { origErr('run threw', String(e).slice(0,150)); process.exit(1); });
