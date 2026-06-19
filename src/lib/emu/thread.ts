import type { CPU } from './x86/cpu';
import type { Emulator, WinMsg } from './emulator';

/**
 * Snapshot of all mutable CPU fields for one thread.
 * Context switching saves/loads these to/from the single CPU instance.
 */
export interface ThreadState {
  // General-purpose registers
  reg: Int32Array; // 8 elements
  eip: number;

  // Lazy flags
  lazyOp: number;
  lazyResult: number;
  lazyA: number;
  lazyB: number;
  flagsCache: number;
  flagsValid: boolean;

  // FPU
  fpuStack: Float64Array; // 8 elements
  fpuTop: number;
  fpuCW: number;
  fpuSW: number;
  fpuTW: number;

  // SSE
  xmmF64: Float64Array; // 16 elements
  xmmI32: Int32Array;   // 32 elements (alias of xmmF64.buffer)

  // Segments
  use32: boolean;
  cs: number;
  ds: number;
  es: number;
  ss: number;
  fsBase: number;
  segBases: Map<number, number>;

  // Decode transient
  _segOverride: number;
  _addrSize16: boolean;
  realMode: boolean;

  // Halt state
  halted: boolean;
  haltReason: string;
  thunkHit: boolean;
}

export class Thread {
  id: number;
  state: ThreadState;

  // Per-thread message state
  messageQueue: WinMsg[] = [];
  waitingForMessage = false;
  _onMessageAvailable: (() => void) | null = null;
  // Suspend generation — incremented every time a suspended thunk completes.
  // Async resume callbacks capture this; a mismatch means the suspension they
  // belong to is gone (already resumed or superseded) and they must not fire.
  suspendSeq = 0;

  // Per-thread WndProc state
  wndProcDepth = 0;
  wndProcResult = 0;
  _wndProcFrames: Array<{
    savedEBX: number; savedEBP: number; savedESI: number; savedEDI: number;
    savedDS?: number; savedSP?: number;
    outerStackBytes: number;
    outerCompleter: (emu: Emulator, retVal: number, stackBytes: number) => void;
  }> = [];
  _wndProcSetupPending = false;
  _currentThunkStackBytes = 0;

  // Thread lifecycle
  startAddress = 0;
  parameter = 0;
  stackTop = 0;
  suspended = false;
  exited = false;
  exitCode = 0;

  constructor(id: number, state: ThreadState) {
    this.id = id;
    this.state = state;
  }

  /** Save current CPU state into this thread's snapshot */
  saveFromCPU(cpu: CPU): void {
    const s = this.state;
    s.reg.set(cpu.reg);
    s.eip = cpu.eip;

    s.lazyOp = cpu.lazyOp;
    s.lazyResult = cpu.lazyResult;
    s.lazyA = cpu.lazyA;
    s.lazyB = cpu.lazyB;
    s.flagsCache = cpu.flagsCache;
    s.flagsValid = cpu.flagsValid;

    s.fpuStack.set(cpu.fpuStack);
    s.fpuTop = cpu.fpuTop;
    s.fpuCW = cpu.fpuCW;
    s.fpuSW = cpu.fpuSW;
    s.fpuTW = cpu.fpuTW;

    s.xmmF64.set(cpu.xmmF64);
    // xmmI32 is an alias of xmmF64.buffer, no need to copy separately

    s.use32 = cpu.use32;
    s.cs = cpu.cs;
    s.ds = cpu.ds;
    s.es = cpu.es;
    s.ss = cpu.ss;
    s.fsBase = cpu.fsBase;
    s.segBases = new Map(cpu.segBases);

    s._segOverride = cpu._segOverride;
    s._addrSize16 = cpu._addrSize16;
    s.realMode = cpu.realMode;

    s.halted = cpu.halted;
    s.haltReason = cpu.haltReason;
    s.thunkHit = cpu.thunkHit;
  }

  /** Load this thread's snapshot into the CPU */
  loadToCPU(cpu: CPU): void {
    const s = this.state;
    cpu.reg.set(s.reg);
    cpu.eip = s.eip;

    cpu.lazyOp = s.lazyOp;
    cpu.lazyResult = s.lazyResult;
    cpu.lazyA = s.lazyA;
    cpu.lazyB = s.lazyB;
    cpu.flagsCache = s.flagsCache;
    cpu.flagsValid = s.flagsValid;

    cpu.fpuStack.set(s.fpuStack);
    cpu.fpuTop = s.fpuTop;
    cpu.fpuCW = s.fpuCW;
    cpu.fpuSW = s.fpuSW;
    cpu.fpuTW = s.fpuTW;

    cpu.xmmF64.set(s.xmmF64);

    cpu.use32 = s.use32;
    cpu.cs = s.cs;
    cpu.ds = s.ds;
    cpu.es = s.es;
    cpu.ss = s.ss;
    cpu.fsBase = s.fsBase;
    cpu.segBases = new Map(s.segBases);

    cpu._segOverride = s._segOverride;
    cpu._addrSize16 = s._addrSize16;
    cpu.realMode = s.realMode;

    cpu.halted = s.halted;
    cpu.haltReason = s.haltReason;
    cpu.thunkHit = s.thunkHit;
  }

  /** Create an initial ThreadState snapshot from current CPU state */
  static createInitialState(cpu: CPU): ThreadState {
    const xmmF64 = new Float64Array(16);
    xmmF64.set(cpu.xmmF64);
    return {
      reg: new Int32Array(cpu.reg),
      eip: cpu.eip,
      lazyOp: cpu.lazyOp,
      lazyResult: cpu.lazyResult,
      lazyA: cpu.lazyA,
      lazyB: cpu.lazyB,
      flagsCache: cpu.flagsCache,
      flagsValid: cpu.flagsValid,
      fpuStack: new Float64Array(cpu.fpuStack),
      fpuTop: cpu.fpuTop,
      fpuCW: cpu.fpuCW,
      fpuSW: cpu.fpuSW,
      fpuTW: cpu.fpuTW,
      xmmF64,
      xmmI32: new Int32Array(xmmF64.buffer),
      use32: cpu.use32,
      cs: cpu.cs,
      ds: cpu.ds,
      es: cpu.es,
      ss: cpu.ss,
      fsBase: cpu.fsBase,
      segBases: new Map(cpu.segBases),
      _segOverride: cpu._segOverride,
      _addrSize16: cpu._addrSize16,
      realMode: cpu.realMode,
      halted: cpu.halted,
      haltReason: cpu.haltReason,
      thunkHit: cpu.thunkHit,
    };
  }
}
