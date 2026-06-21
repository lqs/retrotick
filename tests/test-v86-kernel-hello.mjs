// M2: run the real hello.exe through the new ring3 / per-process-page-table
// kernel (KernelRuntime + kernel-bootstrap), proving the full Emulator + 1900
// Win32 handlers work over int 0x2E in a Windows-style address space.

import fs from 'node:fs';
import { parsePE } from '../src/lib/pe/parse.ts';
import { bootstrapKernelPE } from '../src/lib/emu/v86/kernel-bootstrap.ts';

const wasmBytes = fs.readFileSync(new URL('../node_modules/v86/build/v86.wasm', import.meta.url));
const peBytes = fs.readFileSync(new URL('../examples/hello.exe', import.meta.url));
const ab = peBytes.buffer.slice(peBytes.byteOffset, peBytes.byteOffset + peBytes.byteLength);
const peInfo = parsePE(ab);

let consoleOutput = '';

const { emu, rt, loaded } = await bootstrapKernelPE(ab, peInfo, { wasmBytes });
emu.consoleWriteChar = (ch) => { consoleOutput += String.fromCharCode(ch); process.stdout.write(String.fromCharCode(ch)); };
emu.isConsole = true;

console.log(`[test] imageBase=0x${loaded.imageBase.toString(16)} entry=0x${loaded.entryVA.toString(16)} imports=${loaded.imports.length}`);

const timer = setTimeout(() => {
    console.error('\n[test] timeout');
    console.error('[test] console captured:', JSON.stringify(consoleOutput));
    process.exit(1);
}, 10000);

rt.emu.add_listener('emulator-stopped', () => {
    clearTimeout(timer);
    console.log('\n[test] emulator stopped');
    console.log(`[test] console captured: ${JSON.stringify(consoleOutput)}`);
    console.log(`[test] exit code: ${emu.exitCode}`);
    const ok = consoleOutput.length > 0;
    console.log(`\n[RESULT] M2 hello.exe on kernel: ${ok ? 'PASS' : 'FAIL (no console output)'}`);
    process.exit(ok ? 0 : 1);
});

console.log('[test] running v86 kernel…');
await rt.run();
