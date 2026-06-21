// M7: real CreateProcess. A hand-built parent PE calls CreateProcessA("hello.exe"),
// then WaitForSingleObject(hProcess, INFINITE), then ExitProcess. The kernel
// must spawn hello as a real concurrent process (own address space), run it when
// the parent blocks in WaitForSingleObject, and wake the parent when it exits.

import fs from 'node:fs';
import { parsePE } from '../src/lib/pe/parse.ts';
import { bootstrapKernelPE } from '../src/lib/emu/v86/kernel-bootstrap.ts';

const wasmBytes = fs.readFileSync(new URL('../node_modules/v86/build/v86.wasm', import.meta.url));
const helloBytes = fs.readFileSync(new URL('../examples/hello.exe', import.meta.url));
const helloAb = helloBytes.buffer.slice(helloBytes.byteOffset, helloBytes.byteOffset + helloBytes.byteLength);

// ---- Build a minimal parent PE32 -------------------------------------------
function buildParentPE() {
    const buf = new Uint8Array(0xA00);
    const dv = new DataView(buf.buffer);
    const u8 = (o, ...b) => buf.set(b, o);
    const u16 = (o, v) => dv.setUint16(o, v, true);
    const u32 = (o, v) => dv.setUint32(o, v, true);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
    // DOS header
    str(0, 'MZ'); u32(0x3C, 0x80);
    // PE sig + COFF
    str(0x80, 'PE\0\0');
    u16(0x84, 0x14c);        // machine i386
    u16(0x86, 1);            // numSections
    u16(0x94, 0xE0);         // sizeOfOptionalHeader
    u16(0x96, 0x102);        // characteristics: executable, 32-bit
    // Optional header @ 0x98
    const opt = 0x98;
    u16(opt, 0x10b);                 // magic PE32
    u32(opt + 16, 0x1000);           // AddressOfEntryPoint
    u32(opt + 28, 0x00400000);       // ImageBase
    u32(opt + 32, 0x1000);           // SectionAlignment
    u32(opt + 36, 0x200);            // FileAlignment
    u16(opt + 64, 3);                // Subsystem: console
    u32(opt + 56, 0x2000);           // SizeOfImage
    u32(opt + 60, 0x200);            // SizeOfHeaders
    u32(opt + 92, 16);               // NumberOfRvaAndSizes
    // DataDirectory[1] = Import
    u32(opt + 96 + 1 * 8, 0x1280);   // import dir RVA
    u32(opt + 96 + 1 * 8 + 4, 40);   // size
    // Section header @ 0x178
    const sec = 0x178;
    str(sec, '.text');
    u32(sec + 8, 0x800);             // VirtualSize
    u32(sec + 12, 0x1000);           // VirtualAddress
    u32(sec + 16, 0x800);            // SizeOfRawData
    u32(sec + 20, 0x200);            // PointerToRawData
    u32(sec + 36, 0xE0000020);       // code, exec, read, write
    // Section raw data: file 0x200 = RVA 0x1000 = VA 0x401000
    const F = 0x200, V = 0x401000;
    // code @ RVA 0x1000
    let p = F;
    const emit = (...b) => { buf.set(b, p); p += b.length; };
    emit(0x68, 0x40, 0x14, 0x40, 0x00);  // push 0x401440 (&pi)
    emit(0x68, 0x00, 0x14, 0x40, 0x00);  // push 0x401400 (&si)
    for (let i = 0; i < 6; i++) emit(0x6A, 0x00); // 6 zero args
    emit(0x68, 0x60, 0x14, 0x40, 0x00);  // push 0x401460 (lpCommandLine)
    emit(0x6A, 0x00);                    // push 0 (lpApplicationName)
    emit(0xFF, 0x15, 0xC0, 0x12, 0x40, 0x00); // call [0x4012C0] CreateProcessA
    emit(0x68, 0xFF, 0xFF, 0xFF, 0xFF);  // push INFINITE
    emit(0xFF, 0x35, 0x40, 0x14, 0x40, 0x00); // push [0x401440] (pi.hProcess)
    emit(0xFF, 0x15, 0xC4, 0x12, 0x40, 0x00); // call [0x4012C4] WaitForSingleObject
    emit(0x6A, 0x00);                    // push 0
    emit(0xFF, 0x15, 0xC8, 0x12, 0x40, 0x00); // call [0x4012C8] ExitProcess
    emit(0xF4);                          // hlt
    // Import descriptor @ RVA 0x1280 (file F+0x280)
    const impF = F + 0x280;
    u32(impF + 0, 0x12A0);   // OriginalFirstThunk (ILT)
    u32(impF + 12, 0x1380);  // Name (KERNEL32.DLL)
    u32(impF + 16, 0x12C0);  // FirstThunk (IAT)
    // null descriptor follows (already zero)
    // ILT @ 0x12A0 and IAT @ 0x12C0 → name RVAs
    u32(F + 0x2A0, 0x12E0); u32(F + 0x2A0 + 4, 0x1300); u32(F + 0x2A0 + 8, 0x1320); // ILT
    u32(F + 0x2C0, 0x12E0); u32(F + 0x2C0 + 4, 0x1300); u32(F + 0x2C0 + 8, 0x1320); // IAT
    // hint/name entries (2-byte hint + name)
    str(F + 0x2E0 + 2, 'CreateProcessA\0');
    str(F + 0x300 + 2, 'WaitForSingleObject\0');
    str(F + 0x320 + 2, 'ExitProcess\0');
    str(F + 0x380, 'KERNEL32.DLL\0');
    // data: si.cb @ 0x1400, pi @ 0x1440, cmdline @ 0x1460
    u32(F + 0x400, 0x2C);    // STARTUPINFO.cb = 44
    str(F + 0x460, 'hello.exe\0');
    void V; void u8;
    return buf.buffer;
}

const parentAb = buildParentPE();
const additionalFiles = new Map([['hello.exe', helloAb]]);

const { emu, rt } = await bootstrapKernelPE(parentAb, parsePE(parentAb), { wasmBytes, exeName: 'parent.exe', additionalFiles });
emu.isConsole = true;

let helloOut = '', childPid = 0, parentExited = false;
// Attach child console capture synchronously when the child process is created.
rt.onProcessCreated = (proc) => {
    if (proc.emu === emu) return; // skip the parent
    childPid = proc.pid;
    proc.emu.isConsole = true;
    proc.emu.consoleWriteChar = (ch) => { helloOut += String.fromCharCode(ch); };
};

const finish = (ok, msg) => { console.log(`\n[RESULT] M7 CreateProcess: ${ok ? 'PASS' : 'FAIL'} ${msg}`); process.exit(ok ? 0 : 1); };
rt.emu.add_listener('emulator-stopped', () => {
    parentExited = true;
    setTimeout(() => finish(helloOut.includes('Hello'), `(child pid=${childPid} printed ${JSON.stringify(helloOut.trim())}, parent waited+exited=${parentExited})`), 100);
});
setTimeout(() => finish(helloOut.includes('Hello'), `(timeout; childPid=${childPid} helloOut=${JSON.stringify(helloOut)})`), 14000);
rt.run().catch(e => { console.error('run threw', String(e).slice(0, 200)); finish(false, '(threw)'); });
