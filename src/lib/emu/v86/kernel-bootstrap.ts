// Bootstrap a real Emulator on top of the KernelRuntime (the new ring3,
// per-process-page-table Windows kernel). Mirrors attachV86PEToEmulator but
// targets the kernel backend: per-process AddressSpace, int 0x2E API gate,
// real Windows TEB/PEB addresses.

import { Emulator } from '../emulator';
import type { Memory } from '../memory';
import type { CPU } from '../x86/cpu';
import { Thread } from '../thread';
import { preloadStrings } from '../emu-thunks-pe';
import { handleSehDispatchReturn } from '../emu-window';
import { DefaultFileManager } from '../file-manager';
import { KernelRuntime, type KProc } from './kernel-runtime';
import { KernelMemory, KernelCpu } from './kernel-adapters';
import { parsePE } from '../../pe/parse';
import { normalizeImport } from '../win32/import-maps';
import { loadPEIntoAddressSpace } from './kernel-pe';
import { scanImportDLLs } from './pe-loader';
import { extractExports } from '../../pe/extract-export';
import { TEB_VA_BASE, PEB_VA, USER_SHIM_VA, VEC_API, PAGE_SIZE, PTE_PRESENT, PTE_RW, PTE_USER } from './kconst';

// Boot stub lives in the per-process ring3 shim page, past the cb-return shim.
const USER_SHIM_VA_BOOT = USER_SHIM_VA + 0x20;
// SEH-handler-return shim (`int 0x2E`): an SEH handler RETs here to trap back
// into handleSehDispatchReturn. Sits between the cb-return shim (offset 0) and
// the DllMain boot stub (offset 0x20), all within the one mapped shim page.
const SEH_RET_SHIM_VA = USER_SHIM_VA + 0x10;
const IDOK = 1; // default result for modal dialogs that can't block in a nested callback
import type { PEInfo } from '../../pe/types';

import { registerKernel32 } from '../win32/kernel32/index';
import { registerUser32 } from '../win32/user32/index';
import { registerGdi32 } from '../win32/gdi32/index';
import { registerAdvapi32 } from '../win32/advapi32';
import { registerComctl32 } from '../win32/comctl32';
import { registerComdlg32 } from '../win32/comdlg32';
import { registerMsvcrt } from '../win32/msvcrt';
import { registerShell32 } from '../win32/shell32';
import { registerShlwapi } from '../win32/shlwapi';
import { registerVersion } from '../win32/version';
import { registerWinmm } from '../win32/winmm';
import { registerPsapi } from '../win32/psapi';
import { registerOleaut32 } from '../win32/oleaut32';
import { registerOle32 } from '../win32/ole32';
import { registerNtdll } from '../win32/ntdll';
import { registerWs2_32 } from '../win32/ws2_32';
import { registerOpengl32 } from '../win32/opengl32';
import { registerGlu32 } from '../win32/glu32';
import { registerDdraw } from '../win32/ddraw';
import { registerUxtheme } from '../win32/uxtheme';
import { registerMsacm32 } from '../win32/msacm32';
import { registerWinspool } from '../win32/winspool';
import { registerDsound } from '../win32/dsound';
import { registerIphlpapi } from '../win32/iphlpapi';
import { registerSecur32 } from '../win32/secur32';
import { registerSetupapi } from '../win32/setupapi';
import { registerMpr } from '../win32/mpr';
import { registerImm32 } from '../win32/imm32';
import { registerMsimg32 } from '../win32/msimg32';
import { registerVdmdbg } from '../win32/vdmdbg';
import { registerWinsta } from '../win32/winsta';
import { registerUtildll } from '../win32/utildll';
import { registerNetapi32 } from '../win32/netapi32';

export interface KernelBootOptions {
    wasmBytes?: ArrayBuffer | Uint8Array;
    wasmUrl?: string;
    memorySize?: number;
    heapBase?: number;
    virtualBase?: number;
    additionalFiles?: Map<string, ArrayBuffer>;
    exeName?: string;
    commandLine?: string;
}

export interface BootstrappedKernel {
    rt: KernelRuntime;
    emu: Emulator;
    proc: KProc;
    loaded: ReturnType<typeof loadPEIntoAddressSpace>;
}

function registerAllDlls(emu: Emulator): void {
    registerKernel32(emu); registerUser32(emu); registerGdi32(emu); registerAdvapi32(emu);
    registerComctl32(emu); registerComdlg32(emu); registerMsvcrt(emu); registerShell32(emu);
    registerShlwapi(emu); registerVersion(emu); registerWinmm(emu); registerPsapi(emu);
    registerOleaut32(emu); registerOle32(emu); registerNtdll(emu); registerWs2_32(emu);
    registerOpengl32(emu); registerGlu32(emu); registerDdraw(emu);
    registerUxtheme(emu); registerMsacm32(emu); registerWinspool(emu); registerDsound(emu);
    registerIphlpapi(emu); registerSecur32(emu); registerSetupapi(emu); registerMpr(emu);
    registerImm32(emu); registerMsimg32(emu); registerVdmdbg(emu); registerWinsta(emu);
    registerUtildll(emu); registerNetapi32(emu);
}

/** Set up TEB at the real 0x7FFDE000 and PEB at 0x7FFDF000 (mapped lazily on
 *  first write through the adapter). Builds a proper RTL_USER_PROCESS_PARAMETERS
 *  (command line / image path / current directory) — apps' CRTs read these from
 *  the PEB, and leaving them uninitialized makes them follow garbage pointers. */
/** Set up static (image) TLS for a module: allocate the per-thread data block
 *  from the TLS template, store the loader-assigned index at *AddressOfIndex, and
 *  link the block into TEB.ThreadLocalStoragePointer[index]. IMAGE_TLS_DIRECTORY32:
 *  Start@0, End@4, AddressOfIndex@8, AddressOfCallBacks@0xC, SizeOfZeroFill@0x10. */
function setupStaticTLS(emu: Emulator, imageBase: number, peInfo: PEInfo, tebVA: number, index: number): void {
    const dir = peInfo.optionalHeader.dataDirectories?.[9];
    if (!dir || !dir.virtualAddress || !dir.size) return;
    const tlsDir = (imageBase + dir.virtualAddress) >>> 0;
    const start = emu.memory.readU32(tlsDir + 0x00) >>> 0;
    const end = emu.memory.readU32(tlsDir + 0x04) >>> 0;
    const addrOfIndex = emu.memory.readU32(tlsDir + 0x08) >>> 0;
    const zeroFill = emu.memory.readU32(tlsDir + 0x10) >>> 0;
    const rawSize = end > start ? (end - start) >>> 0 : 0;
    const blockSize = (rawSize + zeroFill) >>> 0 || 4;
    const block = emu.allocHeap(blockSize);
    for (let i = 0; i < rawSize; i++) emu.memory.writeU8(block + i, emu.memory.readU8((start + i) >>> 0));
    for (let i = rawSize; i < blockSize; i++) emu.memory.writeU8(block + i, 0);
    if (addrOfIndex) emu.memory.writeU32(addrOfIndex, index);   // loader writes the TLS index here
    const tlsArray = emu.memory.readU32(tebVA + 0x2C) >>> 0;     // TEB.ThreadLocalStoragePointer
    if (tlsArray) emu.memory.writeU32((tlsArray + index * 4) >>> 0, block);
    console.log(`[kernel-tls] static TLS: block=0x${block.toString(16)} size=0x${blockSize.toString(16)} index=${index} *idx@0x${addrOfIndex.toString(16)}`);
}

function initKernelTEB(emu: Emulator, stackTop: number, stackSize: number, imageBase: number, pid: number, tid: number): number {
    const teb = TEB_VA_BASE, peb = PEB_VA;
    const tlsSlots = emu.allocHeap(256 * 4);
    const processParams = emu.allocHeap(0x200);
    const STD_IN = 0xFFFFFFF6, STD_OUT = 0xFFFFFFF5, STD_ERR = 0xFFFFFFF4;
    emu.memory.writeU32(processParams + 0x18, STD_IN);
    emu.memory.writeU32(processParams + 0x1C, STD_OUT);
    emu.memory.writeU32(processParams + 0x20, STD_ERR);

    // UNICODE_STRING fields the loader/CRT read: CurrentDirectory.DosPath@0x24,
    // ImagePathName@0x38, CommandLine@0x40. Each is {USHORT Length; USHORT Max; PWSTR Buffer}.
    const exePath = emu.exePath || ('C:\\' + (emu.exeName || 'PROG.EXE'));
    const cmdLine = emu.commandLine ? `"${exePath}" ${emu.commandLine}` : `"${exePath}"`;
    const cwd = 'C:\\';
    const setUnicodeStr = (off: number, s: string) => {
        const buf = emu.allocHeap((s.length + 1) * 2);
        emu.memory.writeUTF16String(buf, s);
        emu.memory.writeU16(processParams + off, s.length * 2);       // Length (bytes)
        emu.memory.writeU16(processParams + off + 2, (s.length + 1) * 2); // MaximumLength
        emu.memory.writeU32(processParams + off + 4, buf);            // Buffer
    };
    setUnicodeStr(0x24, cwd);       // CurrentDirectory.DosPath
    setUnicodeStr(0x38, exePath);   // ImagePathName
    setUnicodeStr(0x40, cmdLine);   // CommandLine

    emu.memory.writeU32(peb + 0x08, imageBase);
    emu.memory.writeU32(peb + 0x0C, 0);
    emu.memory.writeU32(peb + 0x10, processParams);

    emu.memory.writeU32(teb + 0x00, 0xFFFFFFFF);      // SEH chain head
    emu.memory.writeU32(teb + 0x04, stackTop);        // stack base
    emu.memory.writeU32(teb + 0x08, (stackTop - stackSize) >>> 0); // stack limit
    emu.memory.writeU32(teb + 0x18, teb);             // self pointer
    emu.memory.writeU32(teb + 0x20, pid);
    emu.memory.writeU32(teb + 0x24, tid);
    emu.memory.writeU32(teb + 0x2C, tlsSlots);
    emu.memory.writeU32(teb + 0x30, peb);
    emu.memory.writeU32(teb + 0x34, 0);
    return teb;
}

/** Create and fully set up one process on an existing KernelRuntime: its own
 *  Emulator view, Win32 handlers, address space + PE image, and TEB/PEB. Leaves
 *  the process in state 'new' (the scheduler launches it); the caller decides
 *  whether to also make it the first-launch process. */
export function createProcessOnKernel(
    rt: KernelRuntime,
    ab: ArrayBuffer,
    peInfo: PEInfo,
    options: KernelBootOptions = {},
    existingEmu?: Emulator,   // reuse a pre-wired Emulator (EmulatorView) instead of a fresh one
): BootstrappedKernel {
    const emu = existingEmu ?? new Emulator();
    emu.memory = new KernelMemory(rt) as unknown as Memory;
    emu.cpu = new KernelCpu(rt) as unknown as CPU;
    emu._v86Runtime = rt as unknown;
    emu.peInfo = peInfo;
    emu.arrayBuffer = ab;
    emu.heapBase = options.heapBase ?? 0x00A00000;
    emu.heapPtr = emu.heapBase;
    emu.virtualBase = options.virtualBase ?? 0x20000000;
    emu.virtualPtr = emu.virtualBase;
    if (options.exeName) emu.exeName = options.exeName;
    if (options.commandLine) emu.commandLine = options.commandLine;
    if (!emu.exeName) emu.exeName = 'PROG.EXE';
    if (!emu.exePath) emu.exePath = 'C:\\' + emu.exeName;
    if (!emu.fs) emu.fs = new DefaultFileManager();
    if (!emu.additionalFiles) emu.additionalFiles = new Map();
    if (options.additionalFiles) for (const [n, d] of options.additionalFiles) emu.additionalFiles.set(n, d);

    registerAllDlls(emu);

    // First call wires real process spawning for CreateProcess. Save/restore the
    // current process so spawning a child mid-run doesn't disturb the parent.
    if (!rt.spawnFn) {
        rt.spawnFn = (childAb, name, args, parentPid) => {
            const saved = rt.current;
            const parentFiles = saved?.emu?.additionalFiles as Map<string, ArrayBuffer> | undefined;
            const base = name.replace(/.*[\\/]/, '');
            const child = createProcessOnKernel(rt, childAb, parsePE(childAb), {
                additionalFiles: parentFiles, exeName: base, commandLine: args,
            });
            child.proc.parentPid = parentPid;
            rt.current = saved; // restore the parent as the active context
            return child.proc;
        };
    }

    const proc = rt.createProcess();
    proc.emu = emu;
    emu.pid = proc.pid;
    rt.current = proc; // so emu.memory writes during setup hit the process AS

    // MSVCRT/CRT DATA exports: imported by name but dereferenced as data, so the
    // IAT slot must hold the address of an initialized cell (a code thunk there
    // makes the CRT read the stub bytes as e.g. the command-line pointer → AV).
    const exePath = emu.exePath || ('C:\\' + (emu.exeName || 'PROG.EXE'));
    const cmdLine = emu.commandLine ? `"${exePath}" ${emu.commandLine}` : `"${exePath}"`;
    const dataCells = new Map<string, number>();
    const strCell = (s: string, wide: boolean): number => {
        const p = emu.allocHeap((s.length + 1) * (wide ? 2 : 1));
        if (wide) emu.memory.writeUTF16String(p, s); else emu.memory.writeCString(p, s);
        const c = emu.allocHeap(4); emu.memory.writeU32(c, p); return c;
    };
    const intCell = (v: number): number => { const c = emu.allocHeap(4); emu.memory.writeU32(c, v); return c; };
    const emptyEnvCell = (wide: boolean): number => {
        const arr = emu.allocHeap(wide ? 4 : 4); emu.memory.writeU32(arr, 0); // {NULL}
        const c = emu.allocHeap(4); emu.memory.writeU32(c, arr); return c;
    };
    const dataExportCell = (name: string): number | null => {
        if (dataCells.has(name)) return dataCells.get(name)!;
        let cell: number | null = null;
        switch (name) {
            case '_acmdln': cell = strCell(cmdLine, false); break;
            case '_wcmdln': cell = strCell(cmdLine, true); break;
            case '_pgmptr': cell = strCell(exePath, false); break;
            case '_wpgmptr': cell = strCell(exePath, true); break;
            case '_environ': case '__initenv': cell = emptyEnvCell(false); break;
            case '_wenviron': case '__winitenv': cell = emptyEnvCell(true); break;
            case '_commode': case '_fmode': cell = intCell(0); break;
            case '_osver': cell = intCell(0); break;
            case '_winmajor': cell = intCell(5); break;
            case '_winminor': cell = intCell(0); break;
            case '_winver': cell = intCell(0x0500); break;
            case '__argc': cell = intCell(1); break;
            default: return null;
        }
        dataCells.set(name, cell);
        return cell;
    };

    // Sibling DLLs supplied as files (e.g. cards.dll): loaded into this process's
    // address space below; their real exports resolve imports to actual code.
    const siblingByName = new Map<string, Map<string, number>>();
    const siblingByOrd = new Map<string, Map<number, number>>();
    const dllMainCalls: { entryVA: number; hModule: number }[] = [];

    // Resolve each import to a thunk id wrapping the emu.apiDefs handler, a real
    // sibling-DLL export, or a direct data cell for known CRT data exports.
    const stubLog = new Set<string>();
    // Build the kernel thunk handler for one API key. Shared by static import
    // resolution and dynamic GetProcAddress thunks.
    const makeThunkHandler = (key: string, def: { handler: (e: Emulator) => number | undefined; stackBytes: number } | undefined, stackBytes: number) => () => {
        if (!def) {
            if (!stubLog.has(key)) { stubLog.add(key); console.warn(`[kernel] no handler for ${key}`); }
            return 0;
        }
        if (emu.traceApi) console.log(`[kernel-api] ${key}`);
        emu._currentThunkStackBytes = stackBytes;
        const ret = def.handler(emu);
        if (emu.halted) { rt.requestStop(); emu.halted = false; return undefined; }
        if (ret === undefined && emu.waitingForMessage) {
            // A blocking API (GetMessage, modal MessageBox/DialogBox, Sleep,
            // WaitForSingleObject) wants to wait for an async event. We can
            // only truly park at the TOP-LEVEL message loop. Inside a nested
            // synchronous callback (wndProcDepth>0, e.g. a wndproc that pops
            // a modal MessageBox), there's no JS call stack to suspend, so we
            // cannot block — clear the wait and return IDOK so the callback
            // continues instead of spinning the CPU on HALT to exhaustion.
            if (emu.wndProcDepth > 0) {
                emu.waitingForMessage = false;
                emu._onMessageAvailable = null;
                return IDOK; // sensible default for modal dialogs (MB_OK etc.)
            }
            rt.requestPark();
            return undefined;
        }
        // number → normal return; undefined → handler redirected guest
        // EIP/ESP/regs itself (e.g. MSVCRT _EH_prolog) and the dispatcher
        // propagates that context to the ring3 resume.
        return ret;
    };
    const resolve = (rawDll: string, rawName: string): { id: number; stackBytes: number } | { dataVA: number } => {
        // Normalize DLL aliases (API-MS-WIN-CRT-* / UCRTBASE → MSVCRT) and
        // ordinal imports (e.g. COMCTL32 ord_17 → InitCommonControlsEx).
        const { dll, name } = normalizeImport(rawDll, rawName);
        // Real sibling-DLL export → IAT points straight at the DLL's code.
        const sib = siblingByName.get(dll);
        if (sib) {
            const m = /^ord_(\d+)$/.exec(name);
            const va = m ? siblingByOrd.get(dll)?.get(parseInt(m[1], 10)) : sib.get(name);
            if (va !== undefined) return { dataVA: va };
        }
        const dataCell = dataExportCell(name);
        if (dataCell !== null) return { dataVA: dataCell };
        const key = `${dll}:${name}`;
        const def = emu.apiDefs.get(key);
        const stackBytes = def ? def.stackBytes : 0;
        const id = rt.registerThunk({
            dll, name, stackBytes,
            handler: makeThunkHandler(key, def, stackBytes),
        });
        return { id, stackBytes };
    };

    // DLL loading shared by bootstrap (static, before entry) and runtime
    // (LoadLibrary). Loads one DLL into this process's address space, resolves its
    // imports, registers its exports for GetProcAddress / IAT resolution. Returns
    // its entry VA (0 if none) so the caller can run DllMain — at bootstrap via the
    // boot stub, at runtime synchronously via callRing3Callback.
    const dllDone = new Set<string>();
    let nextDllBase = 0x10000000;
    const findDllBytes = (upperName: string): ArrayBuffer | undefined => {
        for (const [fname, data] of emu.additionalFiles) {
            if (fname.replace(/.*[/\\]/, '').toUpperCase() === upperName) return data;
        }
        return undefined;
    };
    const loadKernelDLL = (upperName: string, bytes: ArrayBuffer): { base: number; entryVA: number } | null => {
        if (dllDone.has(upperName)) {
            const m = emu.loadedModules.get(upperName.toLowerCase());
            return m ? { base: m.base, entryVA: 0 } : null;
        }
        dllDone.add(upperName);
        try {
            // Load any sub-dependencies present in additionalFiles first.
            for (const sub of scanImportDLLs(bytes)) {
                if (!dllDone.has(sub)) { const sb = findDllBytes(sub); if (sb) loadKernelDLL(sub, sb); }
            }
            const dllPeInfo = parsePE(bytes);
            const exports = extractExports(dllPeInfo, bytes)?.functions ?? [];
            const dllPe = loadPEIntoAddressSpace(bytes, proc.as, resolve, { baseOverride: nextDllBase, stackSize: 0 });
            for (const im of dllPe.imports) if (im.id >= 0) rt.registerThunkSite(proc, im.thunkVA + 2, im.id);
            const byName = new Map<string, number>(), byOrd = new Map<number, number>();
            for (const fn of exports) {
                if (fn.forwardedTo) continue;
                const va = dllPe.imageBase + fn.rva;
                if (fn.name) byName.set(fn.name, va);
                byOrd.set(fn.ordinal, va);
            }
            siblingByName.set(upperName, byName);
            siblingByOrd.set(upperName, byOrd);
            emu.loadedModules.set(upperName.toLowerCase(), { base: dllPe.imageBase, imageBase: dllPe.imageBase, resourceRva: dllPeInfo.optionalHeader.dataDirectories?.[2]?.virtualAddress ?? 0, sizeOfImage: dllPe.sizeOfImage });
            emu.loadedDllExports.set(upperName.toLowerCase(), { base: dllPe.imageBase, exports });
            // Advance past EVERYTHING this load placed — the image AND its int-0x2E
            // thunk pool (which sits right after the image). Using imageBase+sizeOfImage
            // would put the next DLL on top of this DLL's thunk pool, so its IAT would
            // point at thunks overwritten by the next image → wild indirect calls.
            nextDllBase = ((dllPe.stackTop + 0xFFFF) & ~0xFFFF) >>> 0;
            console.log(`[kernel-dll] loaded ${upperName} @0x${dllPe.imageBase.toString(16)}, ${exports.length} exports`);
            return { base: dllPe.imageBase, entryVA: dllPe.entryVA !== dllPe.imageBase ? dllPe.entryVA : 0 };
        } catch (e) { console.warn(`[kernel-dll] failed to load ${upperName}:`, (e as Error).message); return null; }
    };

    // Statically load the sibling DLLs the EXE imports; DllMain runs via the boot
    // stub before the entry point.
    for (const dllName of scanImportDLLs(ab)) {
        const bytes = findDllBytes(dllName);
        if (!bytes) continue;
        const r = loadKernelDLL(dllName, bytes);
        if (r && r.entryVA) dllMainCalls.push({ entryVA: r.entryVA, hModule: r.base });
    }

    // Runtime LoadLibrary hook (own-backend's loadDll uses cpu.step, absent here).
    // Loads the DLL into this AS and runs its DllMain(DLL_PROCESS_ATTACH) now via a
    // synchronous ring3 callback. Returns the module base, or 0 if unavailable.
    emu._kernelLoadLibrary = (rawName: string): number => {
        const base0 = rawName.replace(/^.*[\\/]/, '');
        const upper = (base0.includes('.') ? base0 : base0 + '.dll').toUpperCase();
        const existing = emu.loadedModules.get(upper.toLowerCase());
        if (existing) return existing.base;
        const bytes = findDllBytes(upper);
        if (!bytes) return 0;
        const r = loadKernelDLL(upper, bytes);
        if (!r) return 0;
        if (r.entryVA) {
            try { rt.callRing3Callback(r.entryVA, [r.base, 1 /* DLL_PROCESS_ATTACH */, 0], emu); }
            catch (e) { console.warn(`[kernel-dll] ${upper} DllMain threw:`, (e as Error).message); }
        }
        return r.base;
    };

    const loaded = loadPEIntoAddressSpace(ab, proc.as, resolve);
    for (const im of loaded.imports) if (im.id >= 0) rt.registerThunkSite(proc, im.thunkVA + 2, im.id);

    // Trappable SEH-handler-return point. An access violation (or RaiseException)
    // dispatches to the guest's SEH chain; each handler RETs to this shim, whose
    // `int 0x2E` traps into handleSehDispatchReturn to walk the chain or resume.
    // (The own-backend's magic 0x00FE0004 thunk isn't reachable under v86.)
    // `int 0x2E ; jmp -2` — the jmp re-traps if an UNHANDLED exception iret's back
    // here (handleSehDispatchReturn didn't redirect), so execution can't run off
    // into uninitialized bytes after the int (same guard as the cb-return shim).
    proc.as.writeBytes(SEH_RET_SHIM_VA, new Uint8Array([0xCD, VEC_API, 0xEB, 0xFC]));
    const sehRetId = rt.registerThunk({
        dll: 'SYSTEM', name: 'SEH_RET', stackBytes: 0,
        handler: () => {
            const r = handleSehDispatchReturn(emu);
            if (emu.halted) { rt.requestStop(); emu.halted = false; return undefined; }
            return r;
        },
    });
    rt.registerThunkSite(proc, SEH_RET_SHIM_VA + 2, sehRetId);
    emu._sehReturnVA = SEH_RET_SHIM_VA;

    // Dynamic GetProcAddress support. Programs that resolve APIs at runtime via
    // GetProcAddress need a real callable address; under the kernel that must be a
    // trappable `int 0x2E` thunk with a registered thunk site (the own-backend's
    // thunkToApi/dynamicThunkPtr path doesn't trap here). Allocate a small pool and
    // mint thunks on demand for any registered apiDef, keyed by DLL:name.
    {
        const POOL_PAGES = 32;                 // 32 pages × 256 thunks/page = 8192 thunks
        const SLOT = 16;
        const poolVA = emu.allocVirtual(0, POOL_PAGES * PAGE_SIZE) >>> 0;
        proc.as.mapRange(poolVA, POOL_PAGES, PTE_PRESENT | PTE_RW | PTE_USER);
        let poolNext = poolVA;
        const poolEnd = (poolVA + POOL_PAGES * PAGE_SIZE) >>> 0;
        const gpaCache = new Map<string, number>();
        emu._kernelGetProcThunk = (dll: string, name: string): number => {
            const norm = normalizeImport(dll, name);
            // Find a registered handler for this name under the given DLL, else any DLL.
            let key = `${norm.dll}:${norm.name}`;
            let def = emu.apiDefs.get(key);
            if (!def) {
                for (const k of emu.apiDefs.keys()) {
                    if (k.slice(k.indexOf(':') + 1) === norm.name) { key = k; def = emu.apiDefs.get(k); break; }
                }
            }
            if (!def) return 0;                // unimplemented → NULL (caller falls back)
            const cached = gpaCache.get(key);
            if (cached !== undefined) return cached;
            if (poolNext + SLOT > poolEnd) return 0; // pool exhausted
            const stackBytes = def.stackBytes;
            const id = rt.registerThunk({ dll: key.slice(0, key.indexOf(':')), name: norm.name, stackBytes, handler: makeThunkHandler(key, def, stackBytes) });
            const thunkVA = poolNext; poolNext += SLOT;
            const stub = new Uint8Array(stackBytes === 0 ? [0xCD, VEC_API, 0xC3] : [0xCD, VEC_API, 0xC2, stackBytes & 0xFF, (stackBytes >>> 8) & 0xFF]);
            proc.as.writeBytes(thunkVA, stub);
            rt.registerThunkSite(proc, thunkVA + 2, id);
            gpaCache.set(key, thunkVA);
            return thunkVA;
        };
    }

    // COM vtable thunks. Synthesized COM interfaces (DirectDraw/DirectSound/…)
    // build per-method vtables of callable code pointers. The own-backend uses
    // emu.dynamicThunkPtr + thunkToApi (intercepted in cpu.step); under the
    // kernel there's no interpreter hook, so each method needs a real ring3
    // `int 0x2E ; ret N` stub with a registered thunk site. Mint them from a
    // dedicated pool, keyed by VA so setComThunkStackBytes can patch `ret N`.
    {
        const COM_POOL_PAGES = 96;             // 96 pages × 512 8-byte slots = 49152 thunks
        const SLOT = 8;
        const poolVA = emu.allocVirtual(0, COM_POOL_PAGES * PAGE_SIZE) >>> 0;
        proc.as.mapRange(poolVA, COM_POOL_PAGES, PTE_PRESENT | PTE_RW | PTE_USER);
        let next = poolVA;
        const end = (poolVA + COM_POOL_PAGES * PAGE_SIZE) >>> 0;
        emu._kernelMakeComThunk = (name: string, stackBytes: number, handler: () => number): number => {
            if (next + SLOT > end) { console.warn('[kernel] COM thunk pool exhausted'); return 0; }
            const id = rt.registerThunk({
                dll: 'COM', name, stackBytes,
                handler: () => { if (emu.traceApi) console.log(`[kernel-com] ${name}`); return handler(); },
            });
            const thunkVA = next; next += SLOT;
            // int 0x2E ; ret N   (stdcall: callee pops `stackBytes` of args)
            proc.as.writeBytes(thunkVA, new Uint8Array([0xCD, VEC_API, 0xC2, stackBytes & 0xFF, (stackBytes >>> 8) & 0xFF]));
            rt.registerThunkSite(proc, thunkVA + 2, id);
            return thunkVA;
        };
        emu._kernelSetThunkRet = (thunkVA: number, stackBytes: number): void => {
            // Rewrite the imm16 of the `ret N` (stub byte 3..4).
            proc.as.writeBytes((thunkVA + 3) >>> 0, new Uint8Array([stackBytes & 0xFF, (stackBytes >>> 8) & 0xFF]));
        };

        // BUILTIN_WNDPROC: when an app subclasses/superclasses a built-in control
        // (SysListView32, EDIT, …) it saves the original class wndProc (returned by
        // GetClassInfo / GetWindowLong) and chains unhandled messages to it via
        // CallWindowProc or a direct `call [savedProc]`. The own-backend uses fixed
        // sentinels (0x00FE0008/0x00FE000C) trapped in cpu.step; the kernel has no
        // interpreter hook, so calling a bare sentinel VA runs demand-zero memory and
        // wild-jumps. Mint real `int 0x2E` thunks routing to the built-in message
        // handler and repoint the sentinels — GetClassInfo et al. read these fields
        // dynamically, so every consumer gets a genuinely callable address.
        if (emu._handleBuiltinMessage) {
            const mkBwp = (wide: boolean) => emu._kernelMakeComThunk!(`BUILTIN_WNDPROC_${wide ? 'W' : 'A'}`, 16, () => {
                const hwnd = emu.readArg(0), message = emu.readArg(1), wParam = emu.readArg(2), lParam = emu.readArg(3);
                return emu._handleBuiltinMessage!(hwnd, message, wParam, lParam, wide) ?? 0;
            });
            emu._builtinWndProcA = mkBwp(false);
            emu._builtinWndProcW = mkBwp(true);
        }
    }

    const resourceDir = peInfo.optionalHeader.dataDirectories?.[2];
    emu.pe = {
        imageBase: loaded.imageBase, entryPoint: loaded.entryVA, stackTop: loaded.stackTop,
        thunkBase: loaded.thunkPoolVA, apiMap: new Map(), sizeOfImage: loaded.sizeOfImage,
        resourceRva: resourceDir?.virtualAddress ?? 0, resourceSize: resourceDir?.size ?? 0,
        sections: loaded.sections,
    };

    const mainThread = new Thread(emu.nextThreadId++, Thread.createInitialState(emu.cpu));
    emu.threads.push(mainThread);
    emu.currentThread = mainThread;

    preloadStrings(emu);

    const stackSize = (loaded.stackTop - loaded.stackBottom) >>> 0;
    const tebVA = initKernelTEB(emu, loaded.stackTop, stackSize, loaded.imageBase, proc.pid, mainThread.id);
    emu.cpu.fsBase = tebVA;

    // Static TLS (__declspec(thread)): allocate the per-thread data block from the
    // image's TLS template and link it into TEB.ThreadLocalStoragePointer so
    // `mov ebp, fs:[2C][index]` finds it. Without this, programs with static TLS
    // (e.g. the MSVC CRT, PuTTY) fault writing through a NULL TLS slot during init.
    setupStaticTLS(emu, loaded.imageBase, peInfo, tebVA, 0);

    // If sibling DLLs were loaded, build a ring3 bootstrap stub that calls each
    // DllMain(hModule, DLL_PROCESS_ATTACH, 0) before jumping to the real entry —
    // DLLs like cards.dll cache their hInstance in DllMain, which their exports
    // (cdtInit) then use for LoadBitmap. Placed in the user-accessible shim page.
    let entry = loaded.entryVA;
    if (dllMainCalls.length > 0) {
        const stubVA = USER_SHIM_VA_BOOT;
        const b: number[] = [];
        const d = (n: number) => b.push(n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF);
        for (const dm of dllMainCalls) {
            b.push(0x6A, 0x00);            // push 0  (lpReserved)
            b.push(0x6A, 0x01);            // push 1  (DLL_PROCESS_ATTACH)
            b.push(0x68); d(dm.hModule);   // push hModule
            b.push(0xB8); d(dm.entryVA);   // mov eax, DllMain
            b.push(0xFF, 0xD0);            // call eax (stdcall, pops 12)
        }
        b.push(0xB8); d(loaded.entryVA);   // mov eax, realEntry
        b.push(0xFF, 0xE0);                // jmp eax
        proc.as.writeBytes(stubVA, new Uint8Array(b));
        entry = stubVA;
    }

    proc.entryVA = entry;
    proc.userStackTop = (loaded.stackTop - 4) >>> 0;
    proc.tebVA = tebVA;

    rt.onProcessCreated?.(proc); // let the harness/UI attach per-process I/O before it runs
    return { rt, emu, proc, loaded };
}

/** Boot a fresh KernelRuntime and create the first process (launched via the
 *  high_init → PORT_BOOT handoff). Additional processes are added with
 *  createProcessOnKernel(rt, …) and started by the scheduler. */
export async function bootstrapKernelPE(
    ab: ArrayBuffer,
    peInfo: PEInfo,
    options: KernelBootOptions = {},
): Promise<BootstrappedKernel> {
    const rt = new KernelRuntime({ wasmBytes: options.wasmBytes, wasmUrl: options.wasmUrl, memorySize: options.memorySize });
    await rt.init();
    const result = createProcessOnKernel(rt, ab, peInfo, options);
    rt.setFirstLaunch(result.proc);
    return result;
}

/** Attach the ring3 kernel backend to an EXISTING (UI-wired) Emulator: boots a
 *  KernelRuntime, swaps the emu's memory/cpu to kernel adapters, loads the PE
 *  into a new process address space, and arms first-launch. `emu.run()` then
 *  delegates to the runtime (emulator.ts run() follows emu._v86Runtime). Mirrors
 *  attachV86PEToEmulator but targets the per-process-page-table kernel. */
export async function attachKernelPEToEmulator(
    emu: Emulator,
    ab: ArrayBuffer,
    peInfo: PEInfo,
    options: KernelBootOptions = {},
): Promise<KernelRuntime> {
    const rt = new KernelRuntime({ wasmBytes: options.wasmBytes, wasmUrl: options.wasmUrl, memorySize: options.memorySize });
    await rt.init();
    const result = createProcessOnKernel(rt, ab, peInfo, options, emu);
    rt.setFirstLaunch(result.proc);
    return rt;
}
