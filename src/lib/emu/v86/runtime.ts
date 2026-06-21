// V86Runtime: owns a v86 instance and wires up our boot environment.
//
// Lifecycle:
//   const rt = new V86Runtime(opts);
//   await rt.init();              // construct v86, wait for emulator-loaded, install BIOS/GDT/IDT/PT/traps
//   rt.placeLauncher(cfg);        // PE loader builds the launcher at PHYS_LAUNCHER
//   rt.registerThunk(handler);    // PE loader registers each Win32 import
//   rt.placeThunkStub(id, sb, va) // PE loader writes a stub for thunk id at VA in IAT thunk pool
//   await rt.run();               // start the CPU; resolves when stop() is called

import { buildBios, GDT_BYTES, buildGdtPointer, buildIdtPointer, buildIDT, PF_STUB, encodeGdtDataDescriptor } from './bios';
import { buildLauncher, type LauncherConfig } from './launcher';
import { V86VirtualMemory } from './vm';
import { TrapDispatcher, type ThunkHandler, buildThunkStub, THUNK_STUB_SIZE } from './trap';
import {
    PHYS_GDT, PHYS_GDT_PTR, PHYS_IDT, PHYS_IDT_PTR, PHYS_PF_STUB,
    PHYS_LAUNCHER, PHYS_HALT, PHYS_CB_RETURN, PORT_CB_RETURN,
    type V86Instance, type V86Cpu,
} from './types';

export interface V86RuntimeOptions {
    memorySize?: number;                // bytes, default 64 MB
    wasmUrl?: string;                   // URL or path to v86.wasm
    wasmBytes?: ArrayBuffer | Uint8Array;
}

export class V86Runtime {
    emu!: V86Instance;
    cpu!: V86Cpu;
    vm!: V86VirtualMemory;
    traps!: TrapDispatcher;

    private nextThunkSlotPhys = 0;     // running offset within the thunk pool
    private thunkPoolBasePhys = 0;     // set in init()

    constructor(private opts: V86RuntimeOptions = {}) {}

    async init(): Promise<void> {
        // Resolve wasm bytes
        let wasmBytes: Uint8Array | undefined;
        if (this.opts.wasmBytes) {
            wasmBytes = this.opts.wasmBytes instanceof Uint8Array
                ? this.opts.wasmBytes
                : new Uint8Array(this.opts.wasmBytes);
        } else if (this.opts.wasmUrl) {
            const resp = await fetch(this.opts.wasmUrl);
            wasmBytes = new Uint8Array(await resp.arrayBuffer());
        } else {
            throw new Error('V86Runtime: must provide wasmBytes or wasmUrl');
        }

        // Dynamic import so the bundler doesn't try to evaluate v86 in non-browser contexts.
        const { V86 } = await import('v86');

        const memorySize = this.opts.memorySize ?? 64 * 1024 * 1024;
        const wasmBuf = wasmBytes;

        this.emu = new (V86 as unknown as new (opts: unknown) => V86Instance)({
            bios: { buffer: buildBios().buffer },
            memory_size: memorySize,
            vga_memory_size: 1 * 1024 * 1024,
            autostart: false,
            log_level: 0,
            disable_keyboard: true,
            disable_mouse: true,
            disable_speaker: true,
            wasm_fn: async (env: WebAssembly.Imports) => {
                const result = await WebAssembly.instantiate(wasmBuf as BufferSource, env) as WebAssembly.WebAssemblyInstantiatedSource;
                return result.instance.exports;
            },
        });

        await new Promise<void>((resolve) => {
            this.emu.add_listener('emulator-loaded', () => resolve());
        });

        this.cpu = this.emu.v86.cpu;

        // Install static structures
        this.emu.write_memory(GDT_BYTES, PHYS_GDT);
        this.emu.write_memory(buildGdtPointer(PHYS_GDT, GDT_BYTES.length - 1), PHYS_GDT_PTR);
        this.emu.write_memory(buildIDT(PHYS_PF_STUB), PHYS_IDT);
        this.emu.write_memory(buildIdtPointer(PHYS_IDT, 256 * 8 - 1), PHYS_IDT_PTR);
        this.emu.write_memory(PF_STUB, PHYS_PF_STUB);

        // Page tables
        this.vm = new V86VirtualMemory(this.emu);
        this.vm.initialize();

        // Trap dispatcher
        this.traps = new TrapDispatcher(this.emu, this.cpu, this.vm);
        this.traps.install();

        // Park block at PHYS_HALT: HLT then JMP $-1 (spin in case HLT
        // somehow falls through). HLT lets v86's scheduler drop into its
        // halted mode, returning a long next-tick delay so the JS event
        // loop isn't saturated by worker round-trips. This is critical for
        // frame rate of apps that drive their loop with Sleep / WaitMessage
        // (e.g. ssstars.scr) — otherwise setTimeout-based completers get
        // pushed back farther on every frame.
        this.emu.write_memory(new Uint8Array([0xF4, 0xEB, 0xFD]), PHYS_HALT);

        // Callback-return trampoline at PHYS_CB_RETURN: OUT 0xE9, AL ; HLT.
        // The OUT fires JS to decrement depth; HLT then causes v86's
        // main_loop to return immediately (rather than burning the rest of
        // its cycle budget on a spin), so nested unwind is fast.
        this.emu.write_memory(new Uint8Array([0xE6, PORT_CB_RETURN, 0xF4]), PHYS_CB_RETURN);

        // Direct reference to v86's in_hlt flag so we can clear it before each
        // nested main_loop iteration. cpu.in_hlt[0] is set to 1 by the HLT
        // instruction; main_loop short-circuits when it's set.
        const cpuAny0 = this.cpu as unknown as { in_hlt: Uint8Array };
        this._inHlt = cpuAny0.in_hlt;

        // Register the callback-return trap. Decrements the nesting depth so
        // the matching nestedRunUntilReturn frame can exit. Multiple levels
        // of nested calls (wndproc → API → SendMessage → wndproc) each push
        // their own trampoline and pop via this handler.
        this.cpu.io.register_write(PORT_CB_RETURN, { name: 'cb-return' }, () => {
            this._nestedDepth--;
        });

        // Stub screen adapter so emulator-started/stopped callbacks don't NPE.
        this.emu.screen_adapter = { pause: () => {}, continue: () => {} };

        // Default thunk pool location: directly after PF stub.
        // PE loader can override this if it wants thunks in user VA space.
        this.thunkPoolBasePhys = 0x06000;

        // Cache the wasm main_loop export for nested execution.
        const cpuAny = this.cpu as unknown as { main_loop: () => void };
        this._mainLoop = cpuAny.main_loop;
    }

    private _mainLoop!: () => void;
    private _inHlt!: Uint8Array;
    private _nestedDepth = 0;

    /** Synchronously run guest code starting at the EIP/ESP the caller already
     *  set up. Caller must have pushed args, pushed PHYS_CB_RETURN as the
     *  fake return EIP, and set cpu.eip to the call target. Returns when the
     *  guest's RET lands on PHYS_CB_RETURN (which trips PORT_CB_RETURN and
     *  pops one level of nesting).
     *
     *  Supports nesting: if the called code itself triggers another
     *  callStdcall (via a thunk handler that calls callWndProc, e.g.
     *  SendMessage → wndproc), the inner frame pushes another return-trampoline
     *  and the depth counter tracks each level. The outer frame's loop only
     *  exits once depth drops back to its own entry value.
     *
     *  Used by emu-exec's callStdcall to perform synchronous wndproc / dialog
     *  proc / timer proc invocations from within JS trap handlers under v86. */
    nestedRunUntilReturn(maxIterations = 1000): void {
        // If the CPU is currently parked (PE waiting for async message), the
        // caller (e.g. handleMenuOpen sending WM_INITMENU) just set EIP to a
        // wndproc. We must NOT unwind the outer park — we'd overwrite the new
        // EIP and crash. Save and restore the park state across the nested
        // execution so the outer wait can resume cleanly afterwards.
        const outerParkedEIP = this._parkedEIP;
        this._parkedEIP = null;

        const targetDepth = this._nestedDepth;
        this._nestedDepth = targetDepth + 1;
        let iters = 0;
        while (this._nestedDepth > targetDepth && iters < maxIterations) {
            // Process-exit requested mid-callback (ExitProcess/exit) — bail
            // immediately rather than spinning the halt block.
            if (this._stopRequested) break;
            // If an inner API parks (e.g. MessageBoxW inside a wndproc), we
            // can't truly suspend the JS call stack here — unwind that inner
            // park and let the call continue with whatever EAX is currently
            // set. The OUTER park is held in outerParkedEIP and restored at
            // the end of this function.
            if (this._parkedEIP !== null) {
                this.cpu.instruction_pointer[0] = this._parkedEIP;
                this._parkedEIP = null;
            }
            this._inHlt[0] = 0;
            this._mainLoop();
            iters++;
        }
        // Clear HLT before continuing.
        this._inHlt[0] = 0;
        if (this._nestedDepth > targetDepth) {
            const eip = this.cpu.get_real_eip() >>> 0;
            console.warn(`[v86] nestedRunUntilReturn: exhausted ${maxIterations} iterations (depth=${this._nestedDepth}, target=${targetDepth}, EIP=0x${eip.toString(16)})`);
            this._nestedDepth = targetDepth;
        }

        // Restore the outer park so the GetMessage / WaitMessage that was
        // already waiting stays waiting. callStdcall caller (after this
        // returns) restores cpu.eip to its savedEIP (= PHYS_HALT), and that
        // matches the park state we're restoring here.
        if (outerParkedEIP !== null) {
            this._parkedEIP = outerParkedEIP;
        }
    }

    get cbReturnVA(): number { return PHYS_CB_RETURN; }

    private _parkedEIP: number | null = null;

    /** Called by the trap dispatcher when a Win32 handler returns `undefined`
     *  (meaning "wait for an async event"). Saves the would-be resume EIP
     *  (the thunk's RET imm16), points CPU at PHYS_HALT, and sets in_hlt so
     *  v86's main_loop short-circuits until the matching async completer
     *  fires emuCompleteThunk → resumeParkedThunk(). */
    parkForAsyncResume(): void {
        if (this._parkedEIP !== null) {
            console.warn('[v86] parkForAsyncResume: already parked, overwriting');
        }
        this._parkedEIP = this.cpu.instruction_pointer[0];
        this.cpu.instruction_pointer[0] = PHYS_HALT;
        this._inHlt[0] = 1;
    }

    /** Counterpart to parkForAsyncResume. emuCompleteThunk calls this after
     *  writing the return value into EAX; we restore EIP to the thunk's RET
     *  and clear in_hlt so v86's main_loop picks up execution again. The
     *  thunk's RET imm16 then pops the caller's retAddr and stdcall args
     *  naturally. */
    resumeParkedThunk(_emu?: unknown, retVal?: number): void {
        if (this._parkedEIP === null) return;
        if (retVal !== undefined) this.cpu.reg32[0] = retVal | 0; // emuCompleteThunk no longer pre-sets EAX
        this.cpu.instruction_pointer[0] = this._parkedEIP;
        this._parkedEIP = null;
        this._inHlt[0] = 0;
        // Kick the scheduler so it stops sleeping in halted mode and picks
        // up the restored EIP on its next tick. stop_idling is a wasm-side
        // hint v86 already exposes for this purpose.
        const stopIdle = (this.emu as unknown as { v86?: { cpu?: { stop_idling?: () => void } } }).v86?.cpu?.stop_idling;
        if (stopIdle) stopIdle();
        if (!(this.emu as unknown as { is_running?: () => boolean }).is_running?.()) {
            void this.emu.run();
        }
    }

    /** Whether a thunk is currently parked waiting for async resume. */
    isParked(): boolean { return this._parkedEIP !== null; }

    // VA of the park block. Handlers that want the CPU to stop running can
    // overwrite the return address on the stack with this value, so the
    // current thunk's RET lands on a HLT loop.
    get haltVA(): number { return PHYS_HALT; }

    // Convenience: schedule emulator stop and parking the CPU. ExitProcess et
    // al. should call this. Overwrites the return EIP at [ESP] so the thunk's
    // RET goes to the park block.
    _stopRequested = false;

    requestStop(): void {
        const esp = this.cpu.reg32[4] >>> 0;
        this.vm.vmWriteU32(esp, PHYS_HALT);
        // Signal any in-flight nested callback loop to bail immediately
        // instead of spinning out its iteration budget on the halt block.
        this._stopRequested = true;
        // Fire-and-forget the actual stop; CPU will halt in the park block until then.
        void this.emu.stop();
    }

    // Update the GDT's FS descriptor to point at the TEB.
    setFsBase(tebVA: number, tebLimit: number = 0x1000): void {
        // FS descriptor is GDT entry 3 (selector 0x18).
        const gdt = new Uint8Array(GDT_BYTES);
        encodeGdtDataDescriptor(gdt, 24, tebVA, tebLimit - 1, false);
        this.emu.write_memory(gdt, PHYS_GDT);
        // Reload GDTR (or rely on next selector load to re-fetch — v86 reads on
        // segment load so writing the GDT bytes is enough as long as caller
        // does a `mov fs, ax` afterwards).
    }

    placeLauncher(cfg: LauncherConfig): void {
        this.emu.write_memory(buildLauncher(cfg), PHYS_LAUNCHER);
    }

    registerThunk(h: ThunkHandler): number {
        return this.traps.register(h);
    }

    // Allocate space in the thunk pool, write a stub for `id`, return the VA.
    // Thunk pool is in identity-mapped low memory, so VA == PA.
    allocAndPlaceThunkStub(id: number, stackBytes: number): number {
        const va = this.thunkPoolBasePhys + this.nextThunkSlotPhys;
        this.nextThunkSlotPhys += THUNK_STUB_SIZE;
        this.emu.write_memory(buildThunkStub(id, stackBytes), va);
        return va;
    }

    async run(): Promise<void> {
        await this.emu.run();
    }

    async stop(): Promise<void> {
        await this.emu.stop();
    }
}
