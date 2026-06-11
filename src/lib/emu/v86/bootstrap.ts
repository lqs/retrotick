// One-call helper that builds a fully-wired Emulator on top of v86.
// Replaces the open-coded setup that used to live in test drivers.
//
// Usage:
//     const { emu, rt } = await bootstrapV86PE(arrayBuffer, peInfo, canvas, { wasmUrl });
//     await rt.run();
//
// What this does:
//   1. Build a V86Runtime (loads wasm, configures BIOS/GDT/IDT/page tables).
//   2. Build an Emulator with V86Memory/V86Cpu adapters.
//   3. Set heap/virtual allocator into a safe identity-mapped region.
//   4. Register every Win32 DLL stub (kernel32/user32/gdi32/...) so emu.apiDefs
//      is fully populated before the loader walks imports.
//   5. Load the PE into v86 VA space; thunks are auto-generated to dispatch to
//      handlers via emu.apiDefs.
//   6. Initialize TEB (SEH chain head, self, PEB) and patch GDT's FS
//      descriptor to point at the TEB.
//   7. Generate the launcher (32-bit stub that sets ESP, FS, then jumps to PE
//      entry).

import { Emulator } from '../emulator';
import { V86Runtime } from './runtime';
import { makeV86BackendOverrides } from './adapters';
import { loadPEIntoV86, scanImportDLLs, type LoadedPE as V86LoadedPE, type ApiResolution } from './pe-loader';
import { parsePE } from '../../pe/parse';
import { extractExports } from '../../pe/extract-export';
import { DefaultFileManager } from '../file-manager';
import { initThreadTEB, preloadStrings } from '../emu-thunks-pe';
import { Thread } from '../thread';
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
import { registerMsacm32 } from '../win32/msacm32';
import { registerIphlpapi } from '../win32/iphlpapi';
import { registerOpengl32 } from '../win32/opengl32';
import { registerGlu32 } from '../win32/glu32';
import { registerDdraw } from '../win32/ddraw';
import { registerDsound } from '../win32/dsound';
import { registerWinspool } from '../win32/winspool';
import { registerSecur32 } from '../win32/secur32';
import { registerSetupapi } from '../win32/setupapi';
import { registerMpr } from '../win32/mpr';
import { registerImm32 } from '../win32/imm32';
import { registerMsimg32 } from '../win32/msimg32';
import { registerVdmdbg } from '../win32/vdmdbg';
import { registerWinsta } from '../win32/winsta';
import { registerUtildll } from '../win32/utildll';
import { registerNetapi32 } from '../win32/netapi32';
import { registerUxtheme } from '../win32/uxtheme';
import type { ThunkHandler } from './trap';
import type { PEInfo } from '../../pe/types';
import { encodeGdtDataDescriptor, GDT_BYTES } from './bios';
import { PHYS_GDT } from './types';

export interface V86BootstrapOptions {
    wasmUrl?: string;
    wasmBytes?: ArrayBuffer | Uint8Array;
    memorySize?: number;
    /** Identity-mapped heap base. Must be > 0x10000 (kernel area) and <
     *  imageBase. Defaults to 0x200000. */
    heapBase?: number;
    /** Identity-mapped VirtualAlloc base. Defaults to 0x300000. */
    virtualBase?: number;
    /** Sibling files (DLLs, data) keyed by filename — used by the DLL loader
     *  to discover and pre-load static dependencies (e.g. cards.dll). */
    additionalFiles?: Map<string, ArrayBuffer>;
}

export interface BootstrappedV86 {
    emu: Emulator;
    rt: V86Runtime;
    loaded: V86LoadedPE;
}

export async function bootstrapV86PE(
    arrayBuffer: ArrayBuffer,
    peInfo: PEInfo,
    canvas: HTMLCanvasElement | null,
    options: V86BootstrapOptions = {},
): Promise<BootstrappedV86> {
    const emu = new Emulator();
    const rt = await attachV86PEToEmulator(emu, arrayBuffer, peInfo, options);
    if (canvas) {
        emu.canvas = canvas;
        emu.canvasCtx = canvas.getContext('2d');
    }
    return { emu, rt, loaded: emu._v86Loaded as V86LoadedPE };
}

/** Mutate an existing Emulator instance in place: swap its memory/cpu to v86
 *  adapters, register all Win32 stubs, load the PE into v86 VA space,
 *  initialize TEB and FS descriptor, and place the launcher. Returns the
 *  V86Runtime so the caller can drive run()/stop(). */
export async function attachV86PEToEmulator(
    emu: Emulator,
    arrayBuffer: ArrayBuffer,
    peInfo: PEInfo,
    options: V86BootstrapOptions = {},
): Promise<V86Runtime> {
    const rt = new V86Runtime({
        wasmUrl: options.wasmUrl,
        wasmBytes: options.wasmBytes,
        memorySize: options.memorySize,
    });
    await rt.init();

    // Swap CPU/memory to v86 adapters
    const overrides = makeV86BackendOverrides(rt);
    emu.memory = overrides.memory;
    emu.cpu = overrides.cpu;
    emu._v86Runtime = rt;
    emu.peInfo = peInfo;
    emu.arrayBuffer = arrayBuffer;

    // Heap and virtual allocator must live above v86 kernel structures
    // (page tables top out at 0x14000) and below the PE imageBase. Identity
    // mapped, so VA = PA.
    emu.heapBase = options.heapBase ?? 0x200000;
    emu.heapPtr = emu.heapBase;
    emu.virtualBase = options.virtualBase ?? 0x300000;
    emu.virtualPtr = emu.virtualBase;

    // Default exe name / path so module.ts handlers don't crash
    if (!emu.exeName) emu.exeName = 'PROG.EXE';
    if (!emu.exePath) emu.exePath = 'D:\\' + emu.exeName;

    // File system
    if (!emu.fs) emu.fs = new DefaultFileManager();
    if (!emu.additionalFiles) emu.additionalFiles = new Map();
    if (options.additionalFiles) {
        for (const [n, d] of options.additionalFiles) emu.additionalFiles.set(n, d);
    }

    // Register every Win32 DLL so emu.apiDefs is fully populated. Order
    // matters only if a later module overrides an earlier definition, which
    // shouldn't happen.
    registerKernel32(emu);
    registerUser32(emu);
    registerGdi32(emu);
    registerAdvapi32(emu);
    registerComctl32(emu);
    registerComdlg32(emu);
    registerMsvcrt(emu);
    registerShell32(emu);
    registerShlwapi(emu);
    registerVersion(emu);
    registerWinmm(emu);
    registerPsapi(emu);
    registerOleaut32(emu);
    registerOle32(emu);
    registerNtdll(emu);
    registerWs2_32(emu);
    registerMsacm32(emu);
    registerIphlpapi(emu);
    registerOpengl32(emu);
    registerGlu32(emu);
    registerDdraw(emu);
    registerDsound(emu);
    registerWinspool(emu);
    registerSecur32(emu);
    registerSetupapi(emu);
    registerMpr(emu);
    registerImm32(emu);
    registerMsimg32(emu);
    registerVdmdbg(emu);
    registerWinsta(emu);
    registerUtildll(emu);
    registerNetapi32(emu);
    registerUxtheme(emu);

    // Sibling-DLL setup: we have to load DLLs and the main PE in a way that
    // each one's imports can resolve to (a) Win32 standard handlers via
    // emu.apiDefs, or (b) other sibling DLLs' real exports. So apiLookup is
    // defined first as a closure over siblingExports (populated as DLLs load),
    // and used uniformly for every loadPEIntoV86 call.
    const siblingExports = new Map<string, Map<string, number>>();
    const siblingExportsByOrd = new Map<string, Map<number, number>>();
    const dllMainCalls: { entryVA: number; hModule: number }[] = [];

    // API lookup: prefer real DLL exports → emu.apiDefs handlers → log stub.
    // ExitProcess gets special treatment: ask the runtime to halt the CPU
    // after the call returns.
    const stubLog = new Set<string>();
    const apiLookup = (dll: string, name: string): ApiResolution => {
        // First: sibling-DLL real export?
        const dllExports = siblingExports.get(dll);
        if (dllExports) {
            if (name.startsWith('ord_')) {
                const ord = parseInt(name.slice(4), 10);
                const va = siblingExportsByOrd.get(dll)?.get(ord);
                if (va !== undefined) return { kind: 'real', va };
            } else {
                const va = dllExports.get(name);
                if (va !== undefined) return { kind: 'real', va };
            }
        }
        // Second: a Win32 handler — fall through to the original wrapping logic.
        return resolveAsThunk(dll, name);
    };
    const resolveAsThunk = (dll: string, name: string): ApiResolution => {
        const key = `${dll}:${name}`;
        const def = emu.apiDefs.get(key);
        if (def) {
            return { kind: 'thunk', handler: {
                dll, name,
                stackBytes: def.stackBytes,
                handler: () => {
                    if (emu.traceApi) console.log(`[v86-api] ${dll}:${name}`);
                    // Track stackBytes so emuCompleteThunk (called by async
                    // resume paths) has access to it under v86.
                    emu._currentThunkStackBytes = def.stackBytes;
                    const ret = def.handler(emu);
                    // Real ExitProcess sets emu.halted; bridge that to v86 stop.
                    if (emu.halted) {
                        console.log(`[v86] ${name} halted emulator (exitCode=${emu.exitCode})`);
                        rt.requestStop();
                        emu.halted = false; // reset for any future runs
                        return 0;
                    }
                    if (ret === undefined) {
                        if (emu.waitingForMessage) {
                            if (emu.wndProcDepth > 0) {
                                // Inside a nested wndproc, we can't truly
                                // suspend the JS call stack to wait for an
                                // async event. Return 0 (no message / no
                                // result) and let the caller's polling loop
                                // continue. Clears waitingForMessage so the
                                // outer scheduler doesn't think we're parked.
                                emu.waitingForMessage = false;
                                emu._onMessageAvailable = null;
                                return 0;
                            }
                            // Top-level async wait (GetMessage, ReadConsole,
                            // WaitForSingleObject). Park CPU until matching
                            // completer fires emuCompleteThunk → resumeParkedThunk.
                            rt.parkForAsyncResume();
                        }
                        // Else: handler set EIP/ESP/EAX itself (e.g. _EH_prolog
                        // jumps directly to caller's retAddr, skipping the
                        // thunk's RET). cpu.eip is already what wasm should
                        // fetch next, so we just return current EAX so the
                        // trap dispatcher doesn't clobber it.
                        return rt.cpu.reg32[0] >>> 0;
                    }
                    return ret;
                },
            } };
        }
        // Unknown import — log once
        if (!stubLog.has(key)) {
            stubLog.add(key);
            console.warn(`[v86] no handler for ${key}`);
        }
        return { kind: 'thunk', handler: {
            dll, name, stackBytes: 0,
            handler: () => 0,
        } };
    };

    // Discover and pre-load sibling DLLs. We do this AFTER apiLookup is
    // defined so each DLL's own imports (USER32/GDI32/KERNEL32/etc.) resolve
    // through the same apiLookup that returns real Win32 handlers and
    // already-loaded sibling exports. siblingExports gets populated below;
    // any sibling-to-sibling reference is satisfied because we walk deps
    // first via dllLoadQueue.
    {
        const dllLoadQueue: string[] = scanImportDLLs(arrayBuffer);
        const loadedDLLs = new Set<string>();
        let nextDllBase = 0x10000000;
        while (dllLoadQueue.length > 0) {
            const dllName = dllLoadQueue.shift()!;
            if (loadedDLLs.has(dllName)) continue;
            let dllBytes: ArrayBuffer | undefined;
            for (const [fname, data] of emu.additionalFiles) {
                if (fname.replace(/.*[/\\]/, '').toUpperCase() === dllName) { dllBytes = data; break; }
            }
            if (!dllBytes) continue;
            loadedDLLs.add(dllName);
            try {
                const dllPeInfo = parsePE(dllBytes);
                const exports = extractExports(dllPeInfo, dllBytes);
                const exportFuncs = exports?.functions ?? [];
                for (const subDll of scanImportDLLs(dllBytes)) {
                    if (!loadedDLLs.has(subDll)) dllLoadQueue.push(subDll);
                }
                const dllPe = loadPEIntoV86(dllBytes, rt, apiLookup, { baseOverride: nextDllBase });
                const nameMap = new Map<string, number>();
                const ordMap = new Map<number, number>();
                for (const fn of exportFuncs) {
                    if (fn.forwardedTo) continue;
                    const va = dllPe.imageBase + fn.rva;
                    if (fn.name) nameMap.set(fn.name, va);
                    ordMap.set(fn.ordinal, va);
                }
                siblingExports.set(dllName, nameMap);
                siblingExportsByOrd.set(dllName, ordMap);
                if (dllPe.entryVA !== dllPe.imageBase) {
                    dllMainCalls.push({ entryVA: dllPe.entryVA, hModule: dllPe.imageBase });
                }
                const dllLower = dllName.toLowerCase();
                const resourceDir = dllPeInfo.optionalHeader.dataDirectories?.[2];
                emu.loadedModules.set(dllLower, {
                    base: dllPe.imageBase,
                    imageBase: dllPe.imageBase,
                    resourceRva: resourceDir?.virtualAddress ?? 0,
                    sizeOfImage: dllPe.sizeOfImage,
                });
                emu.loadedDllExports.set(dllLower, { base: dllPe.imageBase, exports: exportFuncs });
                nextDllBase = ((dllPe.imageBase + dllPe.sizeOfImage + 0xFFFF) & ~0xFFFF) >>> 0;
                console.log(`[v86-dll] loaded ${dllName} at 0x${dllPe.imageBase.toString(16)}, ${exportFuncs.length} exports, DllMain=0x${dllPe.entryVA.toString(16)}`);
            } catch (e) {
                console.warn(`[v86-dll] failed to load ${dllName}:`, e);
            }
        }
    }

    // Always-on exception trace so a panic from wasm shows EIP/CS first.
    rt.emu.cpu_exception_hook = (vec) => {
        const eip = rt.cpu.get_real_eip() >>> 0;
        const cs = rt.cpu.sreg[1];
        const cr2 = rt.cpu.cr[2] >>> 0;
        const code = rt.emu.read_memory(eip, 16);
        const codeHex = Array.from(code).map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.error(`[v86-exc] vec=${vec} CS:EIP=${cs.toString(16)}:${eip.toString(16)} CR2=0x${cr2.toString(16)} bytes=${codeHex}`);
        return false;
    };

    // Load PE into v86 VA space.
    const loaded = loadPEIntoV86(arrayBuffer, rt, apiLookup);

    // Mirror minimal PE info onto emu.pe so existing handlers that touch
    // emu.pe.imageBase / stackTop / resource RVAs work.
    const resourceDataDir = peInfo.optionalHeader.dataDirectories?.[2];
    emu.pe = {
        imageBase: loaded.imageBase,
        entryPoint: loaded.entryVA,
        stackTop: loaded.stackTop,
        thunkBase: 0,
        apiMap: new Map(),
        sizeOfImage: loaded.sizeOfImage,
        resourceRva: resourceDataDir?.virtualAddress ?? 0,
        resourceSize: resourceDataDir?.size ?? 0,
        sections: loaded.sections,
    };

    // Create a main thread so the wndProcDepth getter/setter on Emulator
    // (which delegates to currentThread) actually works. Without this,
    // emu.wndProcDepth++ is a silent no-op and APIs that branch on nesting
    // depth (PeekMessage, WaitMessage) misbehave.
    const mainThread = new Thread(emu.nextThreadId++, Thread.createInitialState(emu.cpu));
    emu.threads.push(mainThread);
    emu.currentThread = mainThread;

    // Preload string resources from the PE so LoadStringW can look them up
    // (own backend does this inside emuLoad; we replicate the same call here).
    preloadStrings(emu);

    // Initialize TEB + PEB and patch GDT's FS descriptor to point at it.
    const tebVA = initThreadTEB(emu, loaded.stackTop, 1000);
    emu.cpu.fsBase = tebVA;

    const FS_SELECTOR = 0x18;
    const gdt = new Uint8Array(GDT_BYTES);
    encodeGdtDataDescriptor(gdt, FS_SELECTOR, tebVA, 0x1000, false);
    rt.emu.write_memory(gdt, PHYS_GDT);

    // Place the launcher with FS loaded and DllMain chain.
    rt.placeLauncher({
        entryVA: loaded.entryVA,
        stackTop: loaded.stackTop - 4,
        fsSelector: FS_SELECTOR,
        dllMains: dllMainCalls,
    });

    emu._v86Loaded = loaded;
    return rt;
}
