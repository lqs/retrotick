// KernelRuntime: owns the single v86 instance and the Windows kernel built on
// top of it — frame allocator, shared higher-half kernel, per-process address
// spaces, the int 0x2E API gate dispatcher, and ring3 process launch.
//
// M2 drives a single process; the structure (procs[]/current) extends to the
// concurrent multi-process scheduler in M6 without reshaping.

import { FrameAllocator } from './frame';
import { AddressSpace, buildSharedKernelTables, type SharedKernel, kernelStackTop } from './addrspace';
import {
    installKernelImage, buildBootBios, installBootGdtPtr, patchFsBase, patchTssEsp0, INIT_ESP,
} from './kernel-stub';
import {
    PHYS_BOOT_PD, HALT_VA, CBRET_VA, LAUNCHER_VA, USER_SHIM_VA, TEB_VA_BASE, PEB_VA,
    PORT_API, PORT_PF, PORT_EXC, PORT_BOOT, PORT_CBRET, VEC_CBRET,
    PTE_PRESENT, PTE_RW, PTE_USER, PTE_FRAME_MASK, PAGE_SIZE, PAGE_MASK, USER_MIN,
    pteFlagsFromProtect, PAGE_READWRITE, PAGE_NOACCESS,
} from './kconst';
import type { V86Instance, V86Cpu } from './types';
import { KernelMemory, type KernelMemHost } from './kernel-adapters';

export interface KThunkHandler {
    dll: string;
    name: string;
    stackBytes: number;
    handler: (cpu: V86Cpu) => number | undefined; // undefined ⇒ wrapper arranged park/stop
}

export type KProcState = 'new' | 'ready' | 'running' | 'blocked' | 'zombie';

export interface KCpuSnapshot {
    reg: Int32Array;   // 8 GPRs
    eip: number;
    eflags: number;
    fsBase: number;
}

export interface KProc {
    pid: number;
    tid: number;        // thread id (each schedulable entity; main thread tid = pid+1)
    as: AddressSpace;
    entryVA: number;
    userStackTop: number;
    tebVA: number;
    ring0StackTop: number;
    cbReturnVA: number;  // ring3 shim (`int 0x2F`) a synchronous wndproc RETs to
    state: KProcState;
    snap: KCpuSnapshot | null;   // saved CPU state while not running
    parkedR0esp: number;         // ring0 ESP where the blocked API's frame sits
    pendingRet: number | undefined; // API return value to deliver on resume
    protect: Map<number, number>;   // pageVA → Win32 PAGE_* (VirtualProtect overrides)
    reserved: Map<number, number>;  // pageVA → size-marker for MEM_RESERVE-only ranges (AV until committed)
    parentPid: number;
    exitCode: number;
    waiters: KProc[];               // processes blocked in WaitForSingleObject on this one
    thunkSites: Map<number, number>; // int-0x2E return EIP → handler id (per-process: thunks share VAs across address spaces)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emu?: any; // attached Emulator (set by kernel-bootstrap)
}

// Max wall-clock a synchronous ring3 callback may spin the main thread before
// it's treated as a hung process and killed (keeps the tab responsive).
const CB_BUDGET_MS = 1500;
const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Ring3 callback-return shim: `int 0x2F ; jmp back-to-int`. A synchronous
// callback (wndproc) RETs here to trap into the cbret handler. The jmp targets
// the int (not self): a wndproc that returns one slot off (e.g. calc's window
// being DestroyWindow'd mid-wndproc lands execution at +2) would otherwise spin
// forever on `jmp $`, freezing the tab — here +2 jumps back to +0 and re-traps.
const USER_SHIM_BYTES = new Uint8Array([0xCD, VEC_CBRET, 0xEB, 0xFC]);

export interface KernelRuntimeOptions {
    memorySize?: number;
    wasmBytes?: ArrayBuffer | Uint8Array;
    wasmUrl?: string;
}

export class KernelRuntime implements KernelMemHost {
    emu!: V86Instance;
    cpu!: V86Cpu;
    frames!: FrameAllocator;
    shared!: SharedKernel;
    bootAS!: AddressSpace;
    memory!: KernelMemory;

    procs: KProc[] = [];
    current: KProc | null = null;
    private nextPid = 0x100;

    private thunkHandlers: (KThunkHandler | undefined)[] = [];
    private pendingLaunch: KProc | null = null;
    private memEnd = 0;

    private _inHlt!: Uint8Array;
    private _mainLoop!: () => void;
    private _idle = false;          // CPU parked on HALT block, no process running
    private _stopRequested = false;
    private _pendingPark = false;

    // Nested-callback (synchronous ring3 wndproc) state.
    private _apiR0esp = 0;       // outer api_entry ring0 frame base
    private _cbDepth = 0;        // nesting depth of in-flight callbacks
    private _cbReturnEax = 0;    // last wndproc return value captured at cbret
    private _handlerActive = false;  // true only while synchronously inside h.handler()
    private _handlerUserESP = 0;     // the live user ESP at the current handler's entry
    private _cbBusy = false;         // true while synchronously running a callback's _mainLoop
    private _tssEsp0 = 0;            // mirror of TSS.ESP0 — current ring0 trap stack top

    constructor(private opts: KernelRuntimeOptions = {}) {}

    get currentAS(): AddressSpace { return this.current?.as ?? this.bootAS; }

    async init(): Promise<void> {
        let wasmBytes: Uint8Array;
        if (this.opts.wasmBytes) wasmBytes = this.opts.wasmBytes instanceof Uint8Array ? this.opts.wasmBytes : new Uint8Array(this.opts.wasmBytes);
        else if (this.opts.wasmUrl) wasmBytes = new Uint8Array(await (await fetch(this.opts.wasmUrl)).arrayBuffer());
        else throw new Error('KernelRuntime: provide wasmBytes or wasmUrl');

        const { V86 } = await import('v86');
        // One shared guest physical memory backs ALL processes (the kernel is a
        // single v86 instance). 64MB is tight for real XP-era apps; 1GB matches a
        // well-specced XP machine and leaves ample headroom for memory-hungry apps.
        // (Demand-paged, so unmapped VA costs no physical frames.)
        this.memEnd = this.opts.memorySize ?? 1024 * 1024 * 1024;
        const wasmBuf = wasmBytes;
        this.emu = new (V86 as unknown as new (o: unknown) => V86Instance)({
            bios: { buffer: buildBootBios().buffer },
            memory_size: this.memEnd,
            vga_memory_size: 1 * 1024 * 1024,
            autostart: false, log_level: 0,
            disable_keyboard: true, disable_mouse: true, disable_speaker: true,
            wasm_fn: async (env: WebAssembly.Imports) => (await WebAssembly.instantiate(wasmBuf as BufferSource, env) as WebAssembly.WebAssemblyInstantiatedSource).instance.exports,
        });
        await new Promise<void>((resolve) => this.emu.add_listener('emulator-loaded', () => resolve()));
        this.cpu = this.emu.v86.cpu;
        this._inHlt = (this.cpu as unknown as { in_hlt: Uint8Array }).in_hlt;
        this._mainLoop = (this.cpu as unknown as { main_loop: () => void }).main_loop;

        // Kernel image + boot GDT pointer + page tables.
        installKernelImage(this.emu);
        installBootGdtPtr(this.emu);
        this.frames = new FrameAllocator(this.emu, this.memEnd);
        this.shared = buildSharedKernelTables(this.emu, this.frames);
        this.bootAS = new AddressSpace(this.emu, this.frames, this.shared, PHYS_BOOT_PD);
        this.bootAS.addBootIdentity(16);

        this.memory = new KernelMemory(this);
        this.emu.screen_adapter = { pause: () => {}, continue: () => {} };
        this.installTraps();
    }

    // -- Process management ---------------------------------------------------
    createProcess(): KProc {
        const as = new AddressSpace(this.emu, this.frames, this.shared);
        // If this AS is the one the CPU is currently running on, a PTE change must
        // flush the WASM TLB (e.g. CreateThread / VirtualAlloc adding pages to a live
        // process — the CPU would otherwise read a stale frame for the changed page).
        as.onMutate = () => { if (this.current?.as === as) { this.cpu.full_clear_tlb(); this.memory.invalidate(); } };
        // Map the per-process ring3 callback-return shim page.
        as.mapRange(USER_SHIM_VA, 1, PTE_PRESENT | PTE_RW | PTE_USER);
        as.writeBytes(USER_SHIM_VA, USER_SHIM_BYTES);
        const proc: KProc = {
            pid: this.nextPid, tid: this.nextPid + 1, as,
            entryVA: 0, userStackTop: 0, tebVA: 0,
            ring0StackTop: kernelStackTop(this.procs.length),
            cbReturnVA: USER_SHIM_VA,
            state: 'new', snap: null, parkedR0esp: 0, pendingRet: undefined,
            protect: new Map(), reserved: new Map(),
            parentPid: 0, exitCode: 0, waiters: [], thunkSites: new Map(),
        };
        this.nextPid += 4;
        this.procs.push(proc);
        return proc;
    }

    /** Mark the process to launch when high_init hands off via PORT_BOOT. */
    setFirstLaunch(proc: KProc): void { this.pendingLaunch = proc; }

    // Set by kernel-bootstrap: builds a full child process (emu + DLLs + PE) on
    // this runtime. Used by CreateProcess for real process spawning.
    spawnFn: ((ab: ArrayBuffer, name: string, args: string, parentPid: number) => KProc) | null = null;
    /** Fired synchronously when a process is fully set up (before it runs). The
     *  UI / test harness uses it to attach per-process I/O (console, canvas). */
    onProcessCreated: ((proc: KProc) => void) | null = null;
    spawn(ab: ArrayBuffer, name: string, args: string, parentPid: number): KProc | null {
        return this.spawnFn ? this.spawnFn(ab, name, args, parentPid) : null;
    }

    /** WaitForSingleObject on a process handle: returns false if the child has
     *  already exited (caller returns WAIT_OBJECT_0 immediately), else records
     *  the current process as a waiter and parks it until the child exits. */
    waitForProcess(child: KProc): boolean {
        if (child.state === 'zombie') return false;
        if (this.current && !child.waiters.includes(this.current)) child.waiters.push(this.current);
        this.requestPark();
        return true;
    }
    procByPid(pid: number): KProc | undefined { return this.procs.find(p => p.pid === pid); }

    private nextTebIndex = 1; // index 0 = a process's main-thread TEB at TEB_VA_BASE
    private nextTid = 0x400;
    private _pendingThreadExit = false;
    requestThreadExit(): void { this._pendingThreadExit = true; }

    /** CreateThread: a thread is a schedulable entity sharing its process's
     *  address space + Emulator view, with its own ring0/ring3 stack, TEB, and
     *  CPU snapshot. Enqueued 'new'; the scheduler launches it via the ring3
     *  launcher (ECX=entry, EDX=stack-with-param). */
    createThread(parent: KProc, entry: number, param: number, stackSize = 0x100000): KProc {
        const as = parent.as;
        const t: KProc = {
            pid: parent.pid, tid: this.nextTid++, as, emu: parent.emu,
            protect: parent.protect, reserved: parent.reserved,
            parentPid: parent.parentPid, exitCode: 0, waiters: [], thunkSites: parent.thunkSites,
            cbReturnVA: parent.cbReturnVA,
            ring0StackTop: kernelStackTop(this.procs.length),
            tebVA: (TEB_VA_BASE - this.nextTebIndex * PAGE_SIZE) >>> 0,
            entryVA: entry, userStackTop: 0,
            state: 'new', snap: null, parkedR0esp: 0, pendingRet: undefined,
        };
        this.nextTebIndex++;
        // Ring3 stack (top page mapped now; rest demand-paged). Initial frame:
        // [esp] = thread-exit shim (cbReturnVA), [esp+4] = param.
        const stackBase = parent.emu.allocVirtual(0, stackSize) >>> 0;
        const stackTop = (stackBase + stackSize) >>> 0;
        as.mapRange(stackTop - PAGE_SIZE, 1, PTE_PRESENT | PTE_RW | PTE_USER);
        as.writeU32(stackTop - 8, parent.cbReturnVA); // ThreadProc return → exit shim
        as.writeU32(stackTop - 4, param);
        t.userStackTop = (stackTop - 8) >>> 0;
        // Minimal TEB for the thread.
        as.mapRange(t.tebVA, 1, PTE_PRESENT | PTE_RW | PTE_USER);
        as.writeU32(t.tebVA + 0x00, 0xFFFFFFFF);  // SEH chain head
        as.writeU32(t.tebVA + 0x04, stackTop);     // stack base
        as.writeU32(t.tebVA + 0x08, stackBase);    // stack limit
        as.writeU32(t.tebVA + 0x18, t.tebVA);      // self
        as.writeU32(t.tebVA + 0x30, PEB_VA);       // PEB
        this.procs.push(t);
        return t;
    }

    /** ExitThread: terminate one thread; the process lives on while other
     *  threads remain. If it was the last thread, the process exits. */
    exitThread(t: KProc): void {
        t.state = 'zombie';
        const siblings = this.procs.filter(p => p.pid === t.pid && p.state !== 'zombie');
        if (siblings.length === 0) { this.exitCurrent(); return; }
        const next = this.pickNext();
        if (next) this.runProc(next, false); else this.goIdle();
    }

    registerThunk(h: KThunkHandler): number {
        const id = this.thunkHandlers.length;
        this.thunkHandlers.push(h);
        return id;
    }

    // Map a thunk's int-0x2E return EIP (thunkVA+2) → handler id, PER PROCESS:
    // processes share thunk VAs across separate address spaces, so a global map
    // would collide. The dispatcher identifies the API by this EIP instead of a
    // register, so the thunk needn't clobber any guest register (EH helpers read
    // EAX/ECX as inputs).
    registerThunkSite(proc: KProc, retEip: number, id: number): void { proc.thunkSites.set(retEip >>> 0, id); }

    // -- Traps ----------------------------------------------------------------
    private installTraps(): void {
        const cpu = this.cpu;
        const dev = { name: 'kernel' };

        // high_init → switch CR3 to first process PD, hand launcher its args.
        cpu.io.register_write(PORT_BOOT, dev, () => {
            const proc = this.pendingLaunch;
            if (!proc) { console.error('[kernel] PORT_BOOT with no pending launch'); return; }
            this.switchTo(proc);
            proc.state = 'running';
            cpu.reg32[1] = proc.entryVA | 0;       // ECX = entry
            cpu.reg32[2] = proc.userStackTop | 0;  // EDX = user ESP
        });

        // int 0x2E API dispatch. The handler runs in ring0 (kernel stack), but
        // Win32 handlers read stdcall args relative to the *user* ESP. The
        // ring3 trap frame on the kernel stack holds the user context: EIP@+32,
        // CS@+36, EFLAGS@+40, ESP@+44, SS@+48 (above the 32-byte pushal frame).
        // Present userESP/userEIP to the handler, then restore the ring0
        // context so api_entry's popal/iret return to ring3 correctly.
        cpu.io.register_write(PORT_API, dev, () => {
            const r0esp = cpu.reg32[4] >>> 0;
            const userESP = this.currentAS.readU32(r0esp + 44);
            const userEIP = this.currentAS.readU32(r0esp + 32);
            // Identify the API by the trap return EIP (thunkVA+2), not a register,
            // so guest registers (EAX/ECX read as inputs by EH helpers) are intact.
            const id = this.current?.thunkSites.get(userEIP >>> 0) ?? -1;
            const h = id >= 0 ? this.thunkHandlers[id] : undefined;
            if (!h) { console.error(`[kernel] no thunk handler for retEIP=0x${(userEIP>>>0).toString(16)}`); this.writeRetEaxAt(r0esp, 0); return; }
            const ring0EIP = cpu.instruction_pointer[0];
            cpu.reg32[4] = userESP | 0;
            cpu.instruction_pointer[0] = userEIP | 0;
            // Mark that we're synchronously inside a live API handler with a known
            // user ESP + ring0 frame. A synchronous callback (callWndProc) invoked
            // from here is genuine SendMessage-style nesting and runs on a ring0
            // sub-stack below this frame. Save/restore all three so a sibling
            // callback after this handler returns sees the OUTER live frame, not a
            // stale deeper one (which would push the sub-stack out of bounds).
            const prevHandlerActive = this._handlerActive, prevHandlerUserESP = this._handlerUserESP, prevApiR0esp = this._apiR0esp;
            this._handlerActive = true; this._handlerUserESP = userESP >>> 0; this._apiR0esp = r0esp;
            let ret: number | undefined;
            try { ret = h.handler(cpu); }
            catch (e) { console.error(`[kernel] ${h.dll}:${h.name} threw:`, e); ret = 0; }
            this._handlerActive = prevHandlerActive; this._handlerUserESP = prevHandlerUserESP; this._apiR0esp = prevApiR0esp;
            // Capture the handler's resulting guest context: a "redirect" handler
            // (e.g. MSVCRT _EH_prolog) returns undefined after rewriting the guest
            // EIP/ESP/regs to divert control flow rather than RET normally.
            const gEip = cpu.instruction_pointer[0] >>> 0;
            const gEsp = cpu.reg32[4] >>> 0;
            const gReg = [cpu.reg32[0], cpu.reg32[1], cpu.reg32[2], cpu.reg32[3], cpu.reg32[5], cpu.reg32[6], cpu.reg32[7]];
            // Restore ring0 context so api_entry's popal/iret run on the kernel frame.
            cpu.reg32[4] = r0esp | 0;
            cpu.instruction_pointer[0] = ring0EIP | 0;

            if (this._stopRequested) { this._stopRequested = false; this.exitCurrent(); return; } // ExitProcess
            if (this._pendingThreadExit) { this._pendingThreadExit = false; if (this.current) this.exitThread(this.current); return; } // ExitThread
            if (ret !== undefined) { this.writeRetEaxAt(r0esp, ret); return; } // normal
            if (this._pendingPark) { this._pendingPark = false; this.blockCurrent(); return; } // async wait
            // Redirect: resume ring3 at the handler-set EIP/ESP with its register
            // state. Propagate into the outer iret frame + pushal slots so the
            // popal/iret lands there.
            const as = this.currentAS;
            as.writeU32(r0esp + 32, gEip);   // return EIP
            as.writeU32(r0esp + 44, gEsp);   // user ESP
            as.writeU32(r0esp + 28, gReg[0]); // EAX
            as.writeU32(r0esp + 24, gReg[1]); // ECX
            as.writeU32(r0esp + 20, gReg[2]); // EDX
            as.writeU32(r0esp + 16, gReg[3]); // EBX
            as.writeU32(r0esp + 8,  gReg[4]); // EBP
            as.writeU32(r0esp + 4,  gReg[5]); // ESI
            as.writeU32(r0esp + 0,  gReg[6]); // EDI
        });

        // #PF — M2 policy: lazily commit any user-space page RW. (M3 adds VAD.)
        // Wrapped so a fault-handler error (e.g. frame-pool exhaustion from a
        // runaway commit) halts cleanly instead of throwing across main_loop
        // and corrupting the WASM stack.
        cpu.io.register_write(PORT_PF, dev, () => {
            const va = cpu.cr[2] >>> 0;
            // #PF error code sits below the pushal frame: [r0esp+32].
            const r0esp = cpu.reg32[4] >>> 0;
            let err = 0;
            try { err = this.currentAS.readU32(r0esp + 32); } catch { /* ignore */ }
            const present = (err & 1) !== 0, write = (err & 2) !== 0;
            const proc = this.current;
            try {
                if (va < USER_MIN) {
                    return this.accessViolation(va, write, 'null-guard'); // NULL/near-NULL deref
                }
                if (va >= 0x80000000) {
                    return this.accessViolation(va, write, 'kernel-range');
                }
                if (present && write) {
                    // Write to a present, read-only page (VirtualProtect READONLY).
                    return this.accessViolation(va, write, 'write-to-readonly');
                }
                const pageVA = va & ~PAGE_MASK;
                if (proc && proc.reserved.has(pageVA) && !proc.protect.has(pageVA)) {
                    // Reserved (MEM_RESERVE) but not committed → AV.
                    return this.accessViolation(va, write, 'reserved-uncommitted');
                }
                // Demand-commit, honoring any VirtualProtect/VirtualAlloc protection.
                const win32 = proc?.protect.get(pageVA);
                const flags = win32 !== undefined ? pteFlagsFromProtect(win32) : (PTE_PRESENT | PTE_RW | PTE_USER);
                if (flags === 0) return this.accessViolation(va, write, 'no-access');
                this.currentAS.ensureMapped(va, flags);
                cpu.full_clear_tlb();
                this.memory.invalidate();
            } catch (e) {
                console.error(`[kernel-#PF] fault handler error at VA=0x${va.toString(16)}:`, (e as Error).message);
                this.exitCurrent();
            }
        });

        cpu.io.register_write(PORT_EXC, dev, () => {
            const eip = cpu.get_real_eip() >>> 0;
            console.error(`[kernel-exc] CS:EIP=${cpu.sreg[1].toString(16)}:${eip.toString(16)} CR2=0x${(cpu.cr[2] >>> 0).toString(16)}`);
        });
        // Callback-return: a synchronously-invoked ring3 wndproc returned to its
        // shim, which did `int 0x2F`. EAX holds the wndproc result; capture it
        // and drop a nesting level (the cbret stub then HLTs, ending main_loop).
        cpu.io.register_write(PORT_CBRET, dev, () => {
            if (this._cbDepth > 0) {
                // Nested wndproc/callback returned.
                this._cbReturnEax = cpu.reg32[0] >>> 0;
                this._cbDepth--;
            } else if (this.current) {
                // A ThreadProc returned to its exit shim → terminate the thread.
                this.exitThread(this.current);
            }
        });
    }

    /** Switch the active process (CR3 + FS base + ring0 stack + caches). */
    switchTo(proc: KProc): void {
        this.current = proc;
        this.cpu.cr[3] = proc.as.pdPhys | 0;
        this.cpu.full_clear_tlb();
        this.memory.invalidate();
        patchFsBase(this.emu, proc.tebVA);
        if (this.cpu.segment_offsets) this.cpu.segment_offsets[4] = proc.tebVA | 0;
        this._tssEsp0 = (proc.ring0StackTop || INIT_ESP) >>> 0;
        patchTssEsp0(this.emu, this._tssEsp0);
    }

    private writeRetEaxAt(r0esp: number, val: number): void {
        // Return value lands in the pushal EAX slot ([ring0 esp + 28]); popal
        // in api_entry then restores it before iret to ring3.
        this.currentAS.writeU32(r0esp + 28, val >>> 0);
    }

    // -- Memory protection (M3) ----------------------------------------------

    /** Raise a Win32 access violation (STATUS_ACCESS_VIOLATION 0xC0000005). If the
     *  faulting thread has an SEH handler chain, dispatch the exception to it (as
     *  NT's KiUserExceptionDispatcher does) — many programs deliberately fault
     *  near-NULL inside __try/__except and expect to catch it. Only when no handler
     *  exists (or dispatch can't be set up) is the process terminated. */
    private accessViolation(va: number, write: boolean, reason: string): void {
        const as = this.currentAS;
        const r0esp = this.cpu.reg32[4] >>> 0;
        // #PF iret frame: faulting EIP@+36, EFLAGS@+44, user ESP@+48.
        let faultEip = 0, faultFlags = 0x202, faultEsp = 0;
        try { faultEip = as.readU32(r0esp + 36); faultFlags = as.readU32(r0esp + 44); faultEsp = as.readU32(r0esp + 48); } catch { /* */ }
        const proc = this.current;
        let head = 0xFFFFFFFF, headHandler = 0;
        if (proc) {
            try {
                head = as.readU32(proc.tebVA);
                // A valid registration's handler ([head+4]) is a code address. If it
                // points into the NULL guard (0 / near-NULL), the chain is bogus or
                // was corrupted by the very fault we're handling — don't dispatch to
                // it (that would jump to ~0 and fault again forever); terminate.
                if (head !== 0xFFFFFFFF && head !== 0) headHandler = as.readU32((head + 4) >>> 0) >>> 0;
            } catch { /* */ }
        }
        const hasSeh = head !== 0xFFFFFFFF && head !== 0 && headHandler >= USER_MIN;
        const emu = proc?.emu;
        if (hasSeh && emu?.raiseSehException && this.dispatchAVToSeh(proc!, va, write, faultEip, faultEsp, faultFlags, r0esp)) {
            return; // dispatched to the guest's SEH handler — the faulting instruction does not resume
        }
        console.error(`[kernel-AV] ${reason}: ${write ? 'write' : 'read'} VA=0x${va.toString(16)} EIP=0x${faultEip.toString(16)} pid=${proc?.pid} (SEH ${hasSeh ? 'present but dispatch failed' : 'absent'}) — terminating`);
        this.exitCurrent();
    }

    /** Set the live CPU to the faulting USER context, build the exception via the
     *  emu's SEH machinery (which pushes the first handler's call onto the user
     *  stack + sets EIP=handler), then propagate that into the #PF iret frame so
     *  pf_entry's popal/iret lands at the handler in ring3. Returns false if no
     *  handler was actually dispatched (caller then terminates). */
    private dispatchAVToSeh(proc: KProc, va: number, write: boolean, faultEip: number, faultEsp: number, faultFlags: number, r0esp: number): boolean {
        const cpu = this.cpu, as = this.currentAS;
        const emu = proc.emu;
        const ring0EIP = cpu.instruction_pointer[0] >>> 0;
        // Live CPU ← faulting user context (pushal slots EDI@+0..EAX@+28).
        cpu.reg32[7] = as.readU32(r0esp + 0) | 0;   // EDI
        cpu.reg32[6] = as.readU32(r0esp + 4) | 0;   // ESI
        cpu.reg32[5] = as.readU32(r0esp + 8) | 0;   // EBP
        cpu.reg32[3] = as.readU32(r0esp + 16) | 0;  // EBX
        cpu.reg32[2] = as.readU32(r0esp + 20) | 0;  // EDX
        cpu.reg32[1] = as.readU32(r0esp + 24) | 0;  // ECX
        cpu.reg32[0] = as.readU32(r0esp + 28) | 0;  // EAX
        cpu.reg32[4] = faultEsp | 0;
        cpu.instruction_pointer[0] = faultEip | 0;
        try { cpu.flags[0] = faultFlags | 0; } catch { /* */ }

        const STATUS_ACCESS_VIOLATION = 0xC0000005;
        try {
            // params[0] = access type (0 read, 1 write, 8 DEP), params[1] = faulting VA.
            emu.raiseSehException(STATUS_ACCESS_VIOLATION, 0, [write ? 1 : 0, va >>> 0], faultEip >>> 0);
        } catch (e) {
            console.error('[kernel-AV] SEH dispatch threw:', e);
            cpu.instruction_pointer[0] = ring0EIP | 0; cpu.reg32[4] = r0esp | 0;
            return false;
        }
        if (emu.halted) { emu.halted = false; cpu.instruction_pointer[0] = ring0EIP | 0; cpu.reg32[4] = r0esp | 0; return false; }

        // Capture the handler-call context the emu set up, then restore ring0 so
        // pf_entry's popal/iret runs on the kernel frame.
        const gEip = cpu.instruction_pointer[0] >>> 0, gEsp = cpu.reg32[4] >>> 0;
        const gReg = [cpu.reg32[0], cpu.reg32[1], cpu.reg32[2], cpu.reg32[3], cpu.reg32[5], cpu.reg32[6], cpu.reg32[7]];
        cpu.reg32[4] = r0esp | 0; cpu.instruction_pointer[0] = ring0EIP | 0;
        // Propagate into the #PF iret frame (EIP@+36, ESP@+48) + pushal slots.
        as.writeU32(r0esp + 36, gEip);
        as.writeU32(r0esp + 48, gEsp);
        as.writeU32(r0esp + 28, gReg[0]); // EAX
        as.writeU32(r0esp + 24, gReg[1]); // ECX
        as.writeU32(r0esp + 20, gReg[2]); // EDX
        as.writeU32(r0esp + 16, gReg[3]); // EBX
        as.writeU32(r0esp + 8, gReg[4]);  // EBP
        as.writeU32(r0esp + 4, gReg[5]);  // ESI
        as.writeU32(r0esp + 0, gReg[6]);  // EDI
        return true;
    }

    /** VirtualProtect: set protection for a committed range; returns the
     *  previous protection of the first page. */
    kSetProtect(va: number, size: number, win32: number): number {
        const proc = this.current; if (!proc) return PAGE_READWRITE;
        const first = va & ~PAGE_MASK;
        const old = proc.protect.get(first) ?? PAGE_READWRITE;
        const flags = pteFlagsFromProtect(win32);
        for (let p = first; p < va + size; p += PAGE_SIZE) {
            proc.protect.set(p, win32);
            const pte = proc.as.getPTE(p);
            if (pte & PTE_PRESENT) proc.as.setPTE(p, flags === 0 ? 0 : (pte & PTE_FRAME_MASK) | flags);
        }
        this.cpu.full_clear_tlb(); this.memory.invalidate();
        return old;
    }

    /** VirtualAlloc MEM_RESERVE: mark a range reserved (AV until committed). */
    kReserve(va: number, size: number): void {
        const proc = this.current; if (!proc) return;
        for (let p = va & ~PAGE_MASK; p < va + size; p += PAGE_SIZE) proc.reserved.set(p, 1);
    }

    /** VirtualAlloc MEM_COMMIT: mark a range committed with the given protection
     *  (pages demand-map on first access with that protection). */
    kCommit(va: number, size: number, win32: number): void {
        const proc = this.current; if (!proc) return;
        for (let p = va & ~PAGE_MASK; p < va + size; p += PAGE_SIZE) { proc.protect.set(p, win32); proc.reserved.delete(p); }
    }

    /** VirtualFree: decommit (unmap) or release a range. */
    kFree(va: number, size: number, type: number): void {
        const proc = this.current; if (!proc || size <= 0) return;
        const MEM_RELEASE = 0x8000;
        for (let p = va & ~PAGE_MASK; p < va + size; p += PAGE_SIZE) {
            proc.protect.delete(p);
            if (type & MEM_RELEASE) proc.reserved.delete(p);
            const pte = proc.as.getPTE(p);
            if (pte & PTE_PRESENT) proc.as.setPTE(p, 0);
        }
        this.cpu.full_clear_tlb(); this.memory.invalidate();
    }

    /** VirtualQuery: classify an address → MEM_COMMIT / MEM_RESERVE / MEM_FREE. */
    kQuery(va: number): { state: number; protect: number } {
        const proc = this.current;
        const page = va & ~PAGE_MASK;
        const MEM_COMMIT = 0x1000, MEM_RESERVE = 0x2000, MEM_FREE = 0x10000;
        if (proc) {
            const pte = proc.as.getPTE(page);
            if ((pte & PTE_PRESENT) || proc.protect.has(page)) return { state: MEM_COMMIT, protect: proc.protect.get(page) ?? PAGE_READWRITE };
            if (proc.reserved.has(page)) return { state: MEM_RESERVE, protect: 0 };
        }
        return { state: MEM_FREE, protect: PAGE_NOACCESS };
    }

    // -- Async park / resume --------------------------------------------------
    /** The ring3 shim address a synchronously-invoked wndproc returns to.
     *  emu-exec's callStdcall pushes this as the callback's return EIP. */
    get cbReturnVA(): number { return this.current?.cbReturnVA ?? CBRET_VA; }

    /** Called by a handler wrapper to request an async wait (GetMessage, etc.). */
    requestPark(): void { this._pendingPark = true; }
    isParked(): boolean { return this._idle; }

    // -- Cooperative scheduler (one logical CPU; switch at blocking points) ----

    private captureSnap(): KCpuSnapshot {
        return {
            reg: Int32Array.from(this.cpu.reg32.subarray(0, 8)),
            eip: this.cpu.instruction_pointer[0] >>> 0,
            eflags: this.cpu.flags[0],
            fsBase: this.cpu.segment_offsets ? (this.cpu.segment_offsets[4] >>> 0) : 0,
        };
    }
    private restoreSnap(s: KCpuSnapshot): void {
        this.cpu.reg32.set(s.reg);
        this.cpu.instruction_pointer[0] = s.eip | 0;
        this.cpu.flags[0] = s.eflags | 0;
        if (this.cpu.segment_offsets) this.cpu.segment_offsets[4] = s.fsBase | 0;
    }
    private procByEmu(emu: unknown): KProc | undefined { return this.procs.find(p => p.emu === emu); }

    /** Next runnable process, round-robin from after `current`. */
    private pickNext(): KProc | null {
        const n = this.procs.length;
        if (n === 0) return null;
        const start = this.current ? this.procs.indexOf(this.current) : -1;
        for (let i = 1; i <= n; i++) {
            const p = this.procs[(start + i) % n];
            if (p.state === 'ready' || p.state === 'new') return p;
        }
        return null;
    }

    /** Block the running process at its ring0 resume point and hand the CPU to
     *  another runnable process (or idle). */
    private blockCurrent(): void {
        const proc = this.current;
        if (!proc) { this.goIdle(); return; }
        proc.state = 'blocked';
        proc.parkedR0esp = this.cpu.reg32[4] >>> 0;
        proc.snap = this.captureSnap();
        const next = this.pickNext();
        if (next) this.runProc(next, false); else this.goIdle();
    }

    /** Terminate the running process; wake any processes waiting on it, then run
     *  the next one, idle (if others may yet wake), or stop the whole machine. */
    private exitCurrent(): void {
        const dead = this.current;
        if (dead) {
            dead.state = 'zombie';
            for (const w of dead.waiters) { w.pendingRet = 0 /* WAIT_OBJECT_0 */; if (w.state === 'blocked') w.state = 'ready'; }
            dead.waiters = [];
            // Notify the UI the process ended. emuTick (which fires onExit/onCrash
            // for the legacy backend) never runs under the kernel, so do it here —
            // otherwise the EmulatorView never closes (X had to be clicked twice:
            // once to destroy the guest window, again to tear down the shell).
            const e = dead.emu;
            if (e && !e._kExitNotified) {
                e._kExitNotified = true;
                try {
                    if (e.exitedNormally) e.onExit?.();
                    else { e._crashFired = true; e.onCrash?.('0x' + (this.cpu.get_real_eip() >>> 0).toString(16), e.haltReason || 'process terminated'); }
                } catch (err) { console.error('[kernel] exit notify threw:', err); }
            }
        }
        const next = this.pickNext();
        if (next) { this.runProc(next, false); return; }
        if (this.procs.some(p => p.state === 'blocked')) this.goIdle();
        else { this.haltCpu(); void this.emu.stop(); } // park on HALT so the dispatch's iret doesn't run into garbage
    }

    private goIdle(): void { this._idle = true; this.haltCpu(); this.startFramePump(); }

    // Continuous-repaint frame pump. The own-backend resets _paintSynthBudget and
    // re-runs the message loop every rAF (emuTick), so an app that animates by
    // painting in WM_PAINT and re-invalidating (e.g. an OpenGL screensaver, which
    // uses no timer) keeps getting WM_PAINT. The kernel parks the CPU when its
    // message loop blocks, so without this it would paint until the per-schedule
    // budget runs out and then stall (black screen). Each frame: refill the budget
    // for blocked procs and deliver WM_PAINT to any window still needing one.
    private _framePumpId: number | null = null;
    private startFramePump(): void {
        if (this._framePumpId !== null || typeof requestAnimationFrame !== 'function') return;
        const tick = (): void => {
            this._framePumpId = null;
            if (this._stopRequested) return;
            let posted = false;
            for (const p of this.procs) {
                if (p.state !== 'blocked' || !p.emu) continue;
                const emu = p.emu;
                emu._paintSynthBudget = 8;
                if (emu.messageQueue && emu.messageQueue.length > 0) continue; // don't pile up
                try {
                    for (const [h, w] of emu.handles.findByType('window')) {
                        if (w && w.needsPaint && w.visible) {
                            // Clear like synthesizePaint does: deliver one WM_PAINT per
                            // invalidation. An animating app re-invalidates in its handler
                            // (needsPaint→true again) and keeps getting frames; a static
                            // app paints once and the pump goes quiet for it.
                            w.needsPaint = false;
                            emu.postMessage(h, 0x000F /* WM_PAINT */, 0, 0);
                            posted = true;
                            break;
                        }
                    }
                } catch { /* */ }
            }
            // Keep pumping only while something is actually animating (a parked window
            // still needed painting). Otherwise stop — goIdle restarts the pump the
            // next time a process parks, so a re-invalidating app resumes frames.
            if (posted && !this._stopRequested) this._framePumpId = requestAnimationFrame(tick) as unknown as number;
        };
        this._framePumpId = requestAnimationFrame(tick) as unknown as number;
    }

    /** Make `proc` the running process: switch CR3/FS/TSS, then launch it
     *  (state 'new' → ring3 launcher) or restore its saved CPU state. */
    private runProc(proc: KProc, kick: boolean): void {
        this._idle = false;
        this.switchTo(proc);
        // Fresh per-schedule WM_PAINT synthesis budget. The own-backend resets
        // this each rAF tick (emuTick); the kernel has no tick, so without this
        // the budget stays 0 and GetMessage never synthesizes WM_PAINT → owner-
        // draw controls (e.g. calc's digit buttons) never repaint. Parking on an
        // empty queue is the kernel's natural per-frame throttle.
        if (proc.emu) proc.emu._paintSynthBudget = 8;
        if (proc.state === 'new') {
            this.cpu.reg32[4] = proc.ring0StackTop | 0; // launcher iret-frame stack
            this.cpu.reg32[1] = proc.entryVA | 0;        // ECX = entry
            this.cpu.reg32[2] = proc.userStackTop | 0;   // EDX = user ESP
            this.cpu.instruction_pointer[0] = LAUNCHER_VA | 0;
        } else {
            this.restoreSnap(proc.snap!);
            if (proc.pendingRet !== undefined) {
                this.writeRetEaxAt(proc.parkedR0esp, proc.pendingRet);
                proc.pendingRet = undefined;
            }
            if (proc.emu) proc.emu.waitingForMessage = false; // the blocking API is completing
        }
        proc.state = 'running';
        this._inHlt[0] = 0;
        if (kick) {
            const stopIdle = (this.emu as unknown as { v86?: { cpu?: { stop_idling?: () => void } } }).v86?.cpu?.stop_idling;
            if (stopIdle) stopIdle();
            if (!(this.emu as unknown as { is_running?: () => boolean }).is_running?.()) void this.emu.run();
        }
    }

    /** Resume a process blocked in an async API (GetMessage, Sleep…). The target
     *  emu + return value come from emuCompleteThunk; if the CPU is idle we run
     *  the process now, else it runs cooperatively when the current one blocks. */
    resumeParkedThunk(emu?: unknown, retVal = 0): void {
        const proc = emu ? this.procByEmu(emu) : this.current;
        if (!proc || proc.state === 'zombie') return;
        proc.pendingRet = retVal;
        if (proc.state === 'blocked') proc.state = 'ready';
        // If we're synchronously inside a callback's _mainLoop, don't re-enter the
        // CPU now — the readied proc is drained after the callback returns.
        if (this._cbBusy) return;
        // If we're synchronously inside ANOTHER thread's API handler (e.g. a
        // worker thread's PostMessage waking the GUI thread parked in GetMessage),
        // we can't switch the live CPU now — that would abandon the running
        // thread mid-handler. Leave the target ready; the cooperative scheduler
        // runs it when the current thread next blocks. (Single-threaded processes
        // never hit this: proc === this.current there.)
        if (this._handlerActive && proc !== this.current) return;
        // Otherwise we're in the browser event loop with no proc actively running
        // (the wasm loop only executes synchronously inside our runProc/_mainLoop).
        // Run the readied proc — gating only on _idle would wedge it whenever the
        // idle flag was left stale by an earlier drain race.
        if (proc.state === 'ready' || proc.state === 'new') this.runProc(proc, true);
    }

    /** Redirect a GUEST-INITIATED API call to tail-call a ring3 callback INLINE
     *  at the top level, instead of running it in a nested synchronous _mainLoop.
     *
     *  Real Windows DispatchMessage/SendMessage simply CALL the wndproc in user
     *  mode; the wndproc runs as ordinary ring3 code. Our nested callRing3Callback
     *  drives a blocking sub-_mainLoop that can't yield — fatal for a wndproc that
     *  runs its OWN message loop (modal press/drag tracking, e.g. winmine's smiley
     *  button), which would spin the main thread until the hang guard kills it.
     *
     *  This builds the stdcall frame on the user stack with the callback's return
     *  address pointing at the API thunk's `ret N` (the dispatcher already set
     *  EIP=that and ESP=userESP for the live handler), then points the CPU at the
     *  callback and returns true. The handler must then return undefined so the
     *  PORT_API redirect path propagates EIP/ESP into the iret frame. The callback
     *  then runs at ring3 in the SAME top-level loop (wndProcDepth stays 0), so its
     *  internal GetMessage/PeekMessage/WaitMessage parks and yields like the main
     *  loop, and returns to the thunk's `ret N` with its result in EAX — exactly
     *  the user-mode tail-call semantics. Returns false when there is no live guest
     *  handler context (caller falls back to a nested callRing3Callback). */
    redirectToCallback(addr: number, args: number[], targetEmu?: unknown): boolean {
        if (!addr || !this._handlerActive) return false;
        const proc = (targetEmu ? this.procByEmu(targetEmu) : null) ?? this.current;
        if (!proc || proc !== this.current || proc.state === 'zombie') return false;
        const cpu = this.cpu;
        // The dispatcher set EIP=userEIP (the thunk's `ret N`) and ESP=userESP for
        // this live handler; capture them as the callback's continuation + stack.
        const cont = cpu.instruction_pointer[0] >>> 0;
        let sp = cpu.reg32[4] >>> 0;
        const push = (v: number) => { sp = (sp - 4) >>> 0; this.currentAS.writeU32(sp, v >>> 0); };
        for (let i = args.length - 1; i >= 0; i--) push(args[i]);
        push(cont);                            // callback RETs here → the thunk's `ret N` returns to the guest
        cpu.reg32[4] = sp | 0;
        cpu.instruction_pointer[0] = addr | 0; // dispatcher's redirect path propagates EIP/ESP to the iret frame
        return true;
    }

    /** Synchronously invoke a ring3 stdcall callback (wndproc / dialog proc /
     *  timer proc) for process `targetEmu` and return its result. Owns the FULL
     *  ring3 setup — the legacy callStdcall pushed args onto cpu ESP, which is
     *  wrong here: the callback can be invoked while the process is PARKED in
     *  ring0 at GetMessage (e.g. a UI menu click dispatching WM_COMMAND), where
     *  cpu.reg32[4] is the ring0 stack pointer, not a user stack. Running a
     *  wndproc on the ring0 stack faults (#PF kernel-range) the moment it pushes.
     *
     *  Steps: recover the real ring3 user ESP (from the parked api_entry iret
     *  frame when idle, else the live ESP set by the active API dispatch); build
     *  the stdcall frame (args + cbReturnVA shim) on the USER stack; iret to
     *  ring3 via the launcher trampoline; spin main_loop until the shim's
     *  `int 0x2F` drops the nesting level; then restore the saved ring0 frame +
     *  CPU regs (and re-park if we were idle) so the suspended GetMessage stays
     *  exactly where it was. */
    callRing3Callback(addr: number, args: number[], targetEmu?: unknown, maxIterations = 500_000): number {
        const cpu = this.cpu;
        const proc = (targetEmu ? this.procByEmu(targetEmu) : null) ?? this.current;
        if (!proc || proc.state === 'zombie') return 0;

        // Determine a SAFE source for the ring3 user ESP. Only two states are safe:
        //   (a) activeHandler — we're synchronously inside a live API handler whose
        //       user ESP we recorded (genuine SendMessage-style nesting); or
        //   (b) parked — the target process is cleanly suspended at GetMessage, so
        //       its user ESP lives in the parked api_entry iret frame.
        // Any other state (e.g. an async Preact render firing a render callback
        // while the CPU sits mid-api_entry) has NO valid user context — running a
        // ring3 callback then would put the wndproc on the ring0 stack → #PF. In
        // that case decline: return 0 (default brush/result), harmless for the
        // query callbacks (WM_CTLCOLOR*/WM_INITMENU) that fire from render.
        const activeHandler = this._handlerActive && proc === this.current;
        const parked = proc.state === 'blocked' && proc.parkedR0esp !== 0;
        if (!activeHandler && !parked) return 0;

        const prev = this.current;
        const switched = proc !== prev;
        if (switched) this.switchTo(proc); // CR3 / FS to the target process
        // Even without a switch, the parked CPU's segment state may be stale
        // (snapshot not restored while idle). Re-establish this process's FS=TEB
        // so nested API handlers (e.g. _EH_prolog reading fs:[0]) read the right TEB.
        patchFsBase(this.emu, proc.tebVA);
        if (this.cpu.segment_offsets) this.cpu.segment_offsets[4] = proc.tebVA | 0;

        const userESP = activeHandler
            ? (this._handlerUserESP >>> 0)                           // recorded user ESP of the live handler
            : (this.currentAS.readU32(proc.parkedR0esp + 44) >>> 0); // saved ESP in the parked iret frame

        // Run this callback on a ring0 sub-stack slice that starts BELOW the
        // currently-live ring0 frame (the active API handler's pushal frame, or the
        // parked thread's iret frame), so the callback's launcher iret-frame AND any
        // nested int 0x2E traps DURING the callback stack downward, never overlapping
        // the outer frame. Anchoring at ring0StackTop instead would collide: the live
        // top-level handler frame sits at ring0StackTop-0x34 (it trapped from ring3
        // with TSS.ESP0=ring0StackTop), so a depth-0 callback anchored at ring0StackTop
        // lands a nested value-returning API (e.g. CreateDialogParam inside
        // WM_INITDIALOG) on the SAME bytes as the outer frame, corrupting its return
        // value / continuation. frameBase tracks the descent across nesting levels,
        // so one RING0_SLICE below it is always disjoint from every outer frame.
        const RING0_SLICE = 0x400;
        const frameBase = (activeHandler ? this._apiR0esp : proc.parkedR0esp) >>> 0;
        const esp0 = (frameBase - RING0_SLICE) >>> 0;
        const prevEsp0 = this._tssEsp0;   // outer level's trap stack — restored on return
        this._tssEsp0 = esp0;
        patchTssEsp0(this.emu, esp0);

        // esp0 is strictly below frameBase, so the callback never overlaps the outer
        // frame and there is nothing to preserve/restore at the boundary.
        const s = {
            eip: cpu.instruction_pointer[0], esp: cpu.reg32[4],
            ebx: cpu.reg32[3], ebp: cpu.reg32[5], esi: cpu.reg32[6], edi: cpu.reg32[7],
            ecx: cpu.reg32[1], edx: cpu.reg32[2],
        };

        // Build the stdcall frame on the USER stack: args (right-to-left) + shim.
        let sp = userESP;
        const push = (v: number) => { sp = (sp - 4) >>> 0; this.currentAS.writeU32(sp, v >>> 0); };
        for (let i = args.length - 1; i >= 0; i--) push(args[i]);
        push(proc.cbReturnVA);

        // Launch at ring3 via the trampoline; launcher iret-frame on the sub-stack.
        cpu.reg32[1] = addr | 0;   // ECX = callback entry
        cpu.reg32[2] = sp | 0;     // EDX = user ESP (args + shim pushed)
        cpu.reg32[4] = esp0 | 0;
        cpu.instruction_pointer[0] = LAUNCHER_VA | 0;

        const targetDepth = this._cbDepth;
        this._cbDepth = targetDepth + 1;
        this._idle = false;
        const prevCbBusy = this._cbBusy;
        this._cbBusy = true;
        // Bound the synchronous spin by WALL-CLOCK time, not just iteration count.
        // A healthy callback returns in a single _mainLoop slice; a runaway guest
        // loop (each slice is tiny, so a fixed iter cap would still block for tens
        // of seconds) is cut off after CB_BUDGET_MS so the tab can never freeze.
        const startMs = nowMs();
        let iters = 0, timedOut = false;
        while (this._cbDepth > targetDepth && iters < maxIterations) {
            if (this._stopRequested || proc.state === 'zombie') break; // wndproc exited the process
            this._inHlt[0] = 0;
            this._mainLoop();
            iters++;
            // Check the wall clock EVERY iteration. A busy message-pump loop (e.g.
            // winmine's smiley press-tracking PeekMessage loop) runs many iterations
            // inside ONE _mainLoop slice, so `iters` climbs slowly — gating the clock
            // check on an iteration count would let it block for tens of seconds. One
            // performance.now() per _mainLoop slice is negligible; a healthy callback
            // returns in a single slice anyway.
            if (nowMs() - startMs > CB_BUDGET_MS) { timedOut = true; break; }
        }
        this._cbBusy = prevCbBusy;
        this._inHlt[0] = 0;
        if (this._cbDepth > targetDepth) {
            // The callback didn't return normally. Two cases:
            //  (a) the process was already terminated inside the callback (an
            //      unhandled exception / ExitProcess); the loop broke on zombie/stop
            //      and there's nothing left to run — just unwind quietly.
            //  (b) a genuine runaway guest loop / app hang hit the iter or wall-clock
            //      cap; terminate the process so the tab can't freeze.
            this._cbDepth = targetDepth;
            const terminated = proc.state === 'zombie' || this._stopRequested;
            if (!terminated) {
                console.warn(`[kernel] callRing3Callback runaway (${timedOut ? `${CB_BUDGET_MS}ms wall-clock` : `${maxIterations} iters`}, eip=0x${(cpu.get_real_eip() >>> 0).toString(16)}) — terminating process`);
                this.exitCurrent();
            }
            return 0;
        }
        const ret = this._cbReturnEax | 0;

        // Restore TSS.ESP0 to the OUTER level's trap stack. If this was the outermost
        // callback, prevEsp0 == ring0StackTop (top-level trap stack); if nested, it's
        // the enclosing callback's slice, so the outer callback's continued execution
        // keeps trapping onto its own region (not back at the global top → collision).
        this._tssEsp0 = prevEsp0;
        patchTssEsp0(this.emu, prevEsp0 || proc.ring0StackTop || INIT_ESP);

        // If the callback terminated the process, don't touch its (dead) state.
        if (proc.state === 'zombie') { return ret; }

        // Restore the live CPU registers captured at callback entry.
        cpu.instruction_pointer[0] = s.eip; cpu.reg32[4] = s.esp;
        cpu.reg32[3] = s.ebx; cpu.reg32[5] = s.ebp; cpu.reg32[6] = s.esi; cpu.reg32[7] = s.edi;
        cpu.reg32[1] = s.ecx; cpu.reg32[2] = s.edx;
        cpu.reg32[0] = ret; // callStdcall reads emu.cpu.reg[0]

        if (switched && prev && prev.state !== 'zombie') this.switchTo(prev);
        if (!activeHandler) {
            // Synchronous callback fired against a parked process (render
            // WM_CTLCOLOR*/WM_DRAWITEM, menu WM_INITMENU). It MUST be transparent:
            // restore exactly to the parked-idle state. Inline scheduling here
            // would set _idle=false and break the NEXT synchronous callback (it
            // would read a ring0 ESP as userESP → wndproc on ring0 stack → #PF).
            // If the callback readied a worker thread, drain it on a separate
            // macrotask, never inline.
            this._idle = true;
            this.haltCpu();
            if (this.pickNext()) this.scheduleDrain();
        }
        return ret;
    }

    private _drainScheduled = false;
    /** Run any ready/new thread soon, outside the synchronous callback chain, so
     *  a worker readied during a callback (e.g. calc's compute thread) gets to
     *  run without disturbing in-flight synchronous render/menu callbacks. */
    private scheduleDrain(): void {
        if (this._drainScheduled) return;
        this._drainScheduled = true;
        setTimeout(() => {
            this._drainScheduled = false;
            if (this._idle) { const next = this.pickNext(); if (next) this.runProc(next, true); }
        }, 0);
    }

    /** Redirect the CPU into the ring0 HALT block so it idles cleanly rather
     *  than running off into garbage (used on ExitProcess / fatal fault). */
    private haltCpu(): void {
        this.cpu.instruction_pointer[0] = HALT_VA;
        this._inHlt[0] = 1;
    }

    /** Flag the running process for termination (ExitProcess). The dispatcher
     *  acts on it via exitCurrent(), which decides whether to run another
     *  process or stop the whole machine. */
    requestStop(): void { this._stopRequested = true; }

    async run(): Promise<void> { await this.emu.run(); }
    async stop(): Promise<void> {
        if (this._framePumpId !== null && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(this._framePumpId); this._framePumpId = null; }
        await this.emu.stop();
    }
}
