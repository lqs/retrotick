import { Memory } from '../memory';
import { materializeFlags } from './flags';
import { decodeModRM as _decodeModRM, decodeSIB as _decodeSIB, getSegOverrideSel as _getSegOverrideSel, decodeModRM16 as _decodeModRM16, writeModRM as _writeModRM, decodeFPUModRM as _decodeFPUModRM } from './decode';
import { cpuStep } from './dispatch';
import { LazyOp } from './lazy-op';
import type { Emulator } from '../emulator';
import type { ICpu } from '../backend';

// Register indices
const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;

// Flag bits
const CF = 0x001;
const PF = 0x004;
const ZF = 0x040;
const SF = 0x080;
const TF = 0x100;
const DF = 0x400;
const OF = 0x800;

export class CPU implements ICpu {
  mem: Memory;
  reg = new Int32Array(8);
  eip = 0;
  /** EIP at the start of the current instruction. Updated by cpuStep before
   *  dispatch. Used by the #PF catch in emu-exec.ts to rewind after a
   *  mid-instruction throw so the faulting instruction retries on IRET. */
  _lastInstrEip = 0;
  /** Width of the last successful dispatchException. Updated whenever the
   *  function pushes an interrupt frame, so callers (e.g. the #PF catch in
   *  emu-exec.ts) know whether to push the error code as 16- or 32-bit on top
   *  of that frame. Defaults to 32-bit. */
  _lastDispatchIs32 = true;

  // Lazy flag evaluation state
  lazyOp = LazyOp.NONE;
  lazyResult = 0;
  lazyA = 0;
  lazyB = 0;
  lazyCF = 0; // carry-in for ADC/SBB (0 or 1); kept separate so AF uses original b
  flagsCache = 0x0202; // bit 1 always set, IF=1 (interrupts enabled)
  flagsValid = true;

  // SSE/SSE2 XMM registers (8 x 128-bit, stored as pairs of Float64)
  xmmF64 = new Float64Array(16);  // xmm0..xmm7 as 2 doubles each
  xmmI32 = new Int32Array(this.xmmF64.buffer); // alias as 32 int32s (4 per xmm)

  // x87 FPU state (public for cpu-fpu.ts extraction)
  fpuStack = new Float64Array(8);
  fpuTop = 0;     // stack top pointer (0-7)
  fpuCW = 0x037F; // control word: all exceptions masked, double precision, round to nearest
  fpuSW = 0;      // status word
  fpuTW = 0xFFFF; // tag word: all empty
  // Raw 64-bit integer storage for FILD/FISTP QWORD precision preservation.
  // JS doubles only have 53-bit mantissa; 64-bit integers >2^53 lose precision.
  // When FILD QWORD loads a value, the exact BigInt is stored here.
  // FISTP QWORD uses this if available, bypassing double conversion.
  // Cleared by any arithmetic FPU operation that modifies the slot.
  fpuI64: (bigint | undefined)[] = [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined];
  // Raw 64-bit double storage for FLD/FSTP QWORD NaN bit pattern preservation.
  // JS Float64Array canonicalizes NaN payloads (all NaN → 0x7FF8000000000000).
  // For memory copy via FPU (FLD m64/FSTP m64), store raw lo/hi U32 pair.
  fpuRaw64: ([number, number] | undefined)[] = [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined];
  // Raw 80-bit (10-byte) storage for FLD/FSTP TBYTE (m80real) precision preservation.
  // 80-bit extended has 64-bit mantissa; JS double has only 53. Round-trip loses 11 bits.
  fpuRaw80: ([number, number, number] | undefined)[] = [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined];

  // Halt / thunk state
  halted = false;
  haltReason = '';
  thunkHit = false; // set when EIP is in thunk range
  _tfActive = false; // true only when TF (trap flag) is set in flagsCache

  // Segment base for FS register (points to TEB)
  fsBase = 0;
  // Per-instruction segment override flag (set during prefix parsing, cleared after instruction)
  _segOverride = 0; // 0 = none, 0x64 = FS, 0x26=ES, 0x2E=CS, 0x36=SS, 0x3E=DS

  // Back-reference to emulator (set during load, used for DOS INT handling)
  emu: Emulator | null = null;

  // Real mode: segment * 16 = linear (no lookup table needed).
  // Exposed via getter/setter so every transition recomputes `_ssB32` — the
  // PM→RM→PM path (DPMI AX=0300 simulate-RM-int, INT 31h AX=0x0301/0302, etc.)
  // changes the stack-addressing rules, and a stale `_ssB32` makes pop32 mask
  // ESP to 16 bits once back in PM, which derails any subsequent RET.
  private _realMode = false;
  get realMode(): boolean { return this._realMode; }
  set realMode(v: boolean) {
    if (this._realMode !== v) {
      this._realMode = v;
      this._recomputeSsB32();
    }
  }

  // 16-bit (NE) mode support
  use32 = true; // false for NE executables
  cs = 0; // code segment selector
  // DS/ES/FS/GS are exposed via getter/setter so every MOV/POP that reloads a
  // segment register invalidates the hidden descriptor-base cache for that
  // selector. Intel semantics: the hidden descriptor cache is refreshed from
  // the GDT on EVERY segment-register load — even when the selector value is
  // unchanged. Programs that rewrite a descriptor and then do `mov ds, sel`
  // expecting the new base to take effect (e.g. TESTEXT's extended-memory
  // tester bumping the EXT descriptor bank-by-bank) rely on this.
  private _dsVal = 0;
  private _esVal = 0;
  private _fsVal = 0;
  private _gsVal = 0;
  get ds(): number { return this._dsVal; }
  set ds(val: number) { this._dsVal = val; if (this.emu?._gdtBase) this.segBases.delete(val); }
  get es(): number { return this._esVal; }
  set es(val: number) { this._esVal = val; if (this.emu?._gdtBase) this.segBases.delete(val); }
  get fs(): number { return this._fsVal; }
  set fs(val: number) { this._fsVal = val; if (this.emu?._gdtBase) this.segBases.delete(val); }
  get gs(): number { return this._gsVal; }
  set gs(val: number) { this._gsVal = val; if (this.emu?._gdtBase) this.segBases.delete(val); }
  // SS is exposed via getter/setter so every assignment updates `_ssB32` —
  // Intel determines stack addressing size from the CURRENT SS descriptor's
  // B/D bit (loaded at MOV SS time), not from CS.D. When DOS extenders run
  // 32-bit code (CS.D=1) on a 16-bit shadow stack (SS.B=0), push/pop must
  // still use SP (16-bit) + SS base; keying off `use32` would write to the
  // wrong linear address and corrupt the stack.
  private _ssVal = 0;
  /** True when the currently-loaded SS descriptor has B=1 (32-bit stack).
   *  Default `true` matches Win32/PE where cpu.ss is never explicitly set.
   *  In DPMI mode this is recomputed on every read from the LIVE descriptor
   *  (DOS4GW updates SS.B via DPMI AX=0009 after cpu.ss is loaded, and the
   *  SS setter's snapshot would otherwise stay stale, making pop32 mask ESP
   *  to 16 bits and derail the stack). */
  private _ssB32Cache = true;
  get ss(): number { return this._ssVal; }
  set ss(val: number) {
    this._ssVal = val;
    // In Win16/NE mode (no GDT) segBases IS the source of truth, so dropping
    // the entry would cause segBase() to return 0 forever.
    if (this.emu?._gdtBase) this.segBases.delete(val);
    this._recomputeSsB32();
  }
  get _ssB32(): boolean { return this._ssB32Cache; }
  set _ssB32(v: boolean) { this._ssB32Cache = v; }
  /** Drop cached base for a selector. Call after directly modifying a GDT/LDT
   *  descriptor without going through the segment-register reload path, so the
   *  next segBase() picks up the new base from the descriptor. The caller is
   *  responsible for repopulating segBases.set(sel, newBase) immediately when
   *  the new base is already known. */
  dropSegBaseCache(sel: number): void {
    this.segBases.delete(sel);
  }
  /** Recompute _ssB32 from the current SS descriptor — call after AX=0009
   *  (Set Access Rights) on the SS selector, since the D/B bit may have
   *  changed under us. */
  refreshSsB32(): void {
    this._recomputeSsB32();
  }
  private _recomputeSsB32(): void {
    if (this.realMode) {
      this._ssB32Cache = false;
    } else if (this.emu && this.emu._gdtBase && this._ssVal >= 8) {
      this._ssB32Cache = this.loadGdtDescriptorIs32(this._ssVal);
    } else {
      this._ssB32Cache = this.use32;
    }
  }
  segBases: Map<number, number> = new Map<number, number>(); // selector → linear base address
  segLimits: Map<number, number> = new Map<number, number>(); // selector → segment limit
  _addrSize16 = false; // true when current instruction uses 16-bit addressing
  _inhibitTF = false;  // true after INT/IRET/MOV SS/POP SS (suppresses TF trap)
  _inhibitIRQ = false; // true after MOV SS/POP SS (suppresses HW IRQ for 1 instruction)
  _unrealMode = false; // true after PM→RM transition with flat segments (data base=0)
  /** Pseudo-V86 mode for DOS programs: realMode stays true (segment = sel*16),
   *  but PUSHF/PUSHFD reports VM=1 and SMSW/MOV r,CR0 reports PE=1. This lets
   *  DOS/4GW and DOS/4GW Pro detect a V86-under-monitor environment and use
   *  their VCPI client path instead of raw PM switching. Guest POPF writes to
   *  the VM bit are ignored (VM bit is kept constant for the session). */
  _vm86 = false;

  constructor(mem: Memory) {
    this.mem = mem;
    // Memory needs a CPU reference to check realMode for PM-protected writes
    // (e.g. DPMI IVT protection). Keep the reference as a minimal subset
    // interface to avoid circular type dependencies.
    mem._pmCpu = this;
  }

  /** Load CS and update use32/_addrSize16 from GDT descriptor in protected mode,
   *  or force 16-bit mode in real mode */
  loadCS(selector: number): void {
    // Invalidate the cached base so segBase(CS) re-reads the descriptor (the
    // program may have rewritten the GDT slot since we last cached it).
    // In Win16/NE mode (no GDT) the segBases map IS the source of truth, so
    // dropping the entry here would cause segBase() to return 0 forever.
    if (this.emu?._gdtBase) this.segBases.delete(selector);
    this.cs = selector;
    if (!this.realMode) {
      const is32 = this.loadGdtDescriptorIs32(selector);
      this.use32 = is32;
      this._addrSize16 = !is32;
    } else {
      this.use32 = false;
      this._addrSize16 = true;
    }
  }

  /** Load FS and refresh cached fsBase. In real mode fsBase = sel*16;
   *  in protected mode it comes from the GDT descriptor. */
  loadFS(selector: number): void {
    this.fs = selector & 0xFFFF;
    if (this.realMode) this.fsBase = (this.fs * 16) >>> 0;
    else this.fsBase = this.segBase(this.fs);
  }

  /** Get linear base address for a segment selector */
  segBase(sel: number): number {
    if (this.realMode) {
      // "Unreal mode": after PM→V86 transition, data accesses use flat base (0).
      // Instruction fetch uses cpu.eip directly (not segBase), so returning 0
      // for all segments is safe. CS:override data accesses also get flat base.
      if (this._unrealMode) return 0;
      return (sel * 16) >>> 0;
    }
    // Protected mode with a real GDT: prefer the cached base (segBases Map)
    // populated at segment-register load and at DPMI descriptor-modify time.
    // Reading the GDT on every push/pop is millions of U32 reads per second
    // and dominates emulator runtime. The cache is invalidated by the SS/CS/DS/
    // ES/FS/GS setters and by the AX=0007/0008/0009 DPMI handlers, which is
    // sufficient because programs that reprogram a descriptor without reloading
    // the segment register (e.g. memory testers using AX=0007) hit the cache
    // invalidation in the DPMI service handler itself.
    if (this.emu?._gdtBase) {
      const cached = this.segBases.get(sel);
      if (cached !== undefined) return cached;
      const base = this.loadGdtDescriptorBase(sel);
      if (base !== undefined) {
        // Fallback for descriptor slots that are base=0, limit=0 — effectively
        // uninitialized from a "where does this point" perspective even if the
        // access byte got touched. DOS/4GW's 16-bit PM bootstrap loads segment
        // registers with literal real-mode segment values (`mov ds, rmSeg`)
        // expecting the PM selector to map linearly to `rmSeg << 4`.
        if (base === 0 && sel >= 8) {
          const descAddr = this.emu._gdtBase + ((sel & 0xFFF8) >>> 3) * 8;
          const lo = this.mem.readU32(descAddr);
          const hi = this.mem.readU32(descAddr + 4);
          const limitLo = lo & 0xFFFF;
          const limitHi = (hi >>> 16) & 0x0F;
          const limit = (limitHi << 16) | limitLo;
          if (limit === 0) {
            this.ensureShadowDescriptor(sel);
            const shadowBase = (sel * 16) >>> 0;
            this.segBases.set(sel, shadowBase);
            return shadowBase;
          }
        }
        this.segBases.set(sel, base);
        return base;
      }
      // Descriptor slot is past the GDT limit — ensure a shadow exists so
      // GDT-mem readers (LODSW walking a descriptor table, DPMI GetDescriptor)
      // see real-mode-shadow bytes.
      if (sel >= 8) {
        this.ensureShadowDescriptor(sel);
        return (sel * 16) >>> 0;
      }
    }
    // No GDT (Win16): use the pre-populated selector→base map.
    const cached = this.segBases.get(sel);
    if (cached !== undefined) return cached;
    // LDT-style selector: strip RPL/TI bits (low 3 bits = __AHSHIFT)
    // to find the canonical selector assigned by the NE loader
    const canonical = sel >>> 3;
    if (canonical > 0) {
      const cbase = this.segBases.get(canonical);
      if (cbase !== undefined) return cbase;
    }
    return 0;
  }

  /** Get the descriptor table base for a selector (GDT or LDT based on TI bit) */
  private _descTableAddr(sel: number): number {
    if (!this.emu || !this.emu._gdtBase) return -1;
    const index = (sel & 0xFFF8) >>> 3;
    if (index === 0) return -1; // null selector
    const isLDT = (sel & 0x04) !== 0; // TI bit
    if (isLDT) {
      // LDT: look up LDT descriptor in GDT to find LDT base
      const ldtr = this.emu._ldtr ?? 0;
      if (!ldtr) {
        // No LDTR set. Our DPMI allocator stores all descriptors in the GDT
        // (using the index from the selector with TI bit masked). Fall through
        // to the GDT path so that selectors with TI=1 (as DPMI specs require)
        // still resolve to the correct GDT slot.
      } else {
        const ldtIdx = (ldtr & 0xFFF8) >>> 3;
        const ldtDescAddr = this.emu._gdtBase + ldtIdx * 8;
        if (ldtIdx * 8 + 7 > this.emu._gdtLimit) return -1;
        const ldtLo = this.mem.readU32(ldtDescAddr);
        const ldtHi = this.mem.readU32(ldtDescAddr + 4);
        const ldtBase = ((ldtHi >>> 24) << 24) | ((ldtHi & 0xFF) << 16) | ((ldtLo >>> 16) & 0xFFFF);
        const ldtLimit = (ldtLo & 0xFFFF) | (((ldtHi >>> 16) & 0xF) << 16);
        if (index * 8 + 7 > ldtLimit) return -1;
        return ldtBase + index * 8;
      }
    }
    // GDT
    const descAddr = this.emu._gdtBase + index * 8;
    if (index * 8 + 7 > this.emu._gdtLimit) return -1;
    return descAddr;
  }

  /** Read a GDT/LDT descriptor and return the base address */
  loadGdtDescriptorBase(sel: number): number | undefined {
    const descAddr = this._descTableAddr(sel);
    if (descAddr < 0) return (sel & 0xFFF8) === 0 ? 0 : undefined;
    const lo = this.mem.readU32(descAddr);
    const hi = this.mem.readU32(descAddr + 4);
    const baseLo = (lo >>> 16) & 0xFFFF;
    const baseMid = hi & 0xFF;
    const baseHi = (hi >>> 24) & 0xFF;
    return (baseHi << 24) | (baseMid << 16) | baseLo;
  }

  /** Read a GDT/LDT descriptor and return whether it's a 32-bit segment */
  loadGdtDescriptorIs32(sel: number): boolean {
    const descAddr = this._descTableAddr(sel);
    if (descAddr < 0) return false;
    const hi = this.mem.readU32(descAddr + 4);
    return (hi & (1 << 22)) !== 0;
  }

  /** Read a GDT/LDT descriptor and return the byte limit (accounting for G bit) */
  loadGdtDescriptorLimit(sel: number): number | undefined {
    const descAddr = this._descTableAddr(sel);
    if (descAddr < 0) return undefined;
    const lo = this.mem.readU32(descAddr);
    const hi = this.mem.readU32(descAddr + 4);
    const limitLo = lo & 0xFFFF;
    const limitHi = (hi >>> 16) & 0x0F;
    let limit = ((limitHi << 16) | limitLo) >>> 0;
    // G bit (bit 23 of hi): when set, limit is in 4KB pages
    if ((hi & (1 << 23)) !== 0) limit = (((limit + 1) << 12) - 1) >>> 0;
    return limit;
  }

  /** Write a real-mode-shadow descriptor to the GDT slot for `sel` if the slot
   *  is currently unpopulated. Used for DOS extender clients (DOS/4GW) that
   *  load RM segment values directly into PM segment registers and expect the
   *  host to transparently shadow-map them. */
  ensureShadowDescriptor(sel: number): void {
    if (!this.emu || !this.emu._gdtBase || sel < 8) return;
    // Write the shadow into the GDT slot at (sel >> 3) regardless of the TI
    // bit: DOS/4GW uses real-mode segment values directly as selectors and
    // reads the matching GDT linear address via a flat data selector, so the
    // GDT memory needs valid bytes for any selector it ever touches.
    const idx = (sel & 0xFFF8) >>> 3;
    if (idx === 0 || idx * 8 + 7 > this.emu._gdtLimit) return;
    const descAddr = this.emu._gdtBase + idx * 8;
    // Only write if the slot is currently all-zero (never populated).
    const lo = this.mem.readU32(descAddr);
    const hi = this.mem.readU32(descAddr + 4);
    if (lo !== 0 || hi !== 0) return;
    // Shadow descriptor: base = sel*16, limit = 0xFFFF (64KB), access = 0xF2
    // (present, DPL=3, data R/W, expand-up), flags = 0 (16-bit, byte granular).
    // We always use D=0 even for 32-bit DPMI clients: DOS/4GW 1.95's PM code
    // is compiled as 16-bit code with explicit 0x66/0x67 operand/address prefixes
    // for 32-bit operations. Flipping D=1 would invert the semantics of those
    // prefixes and corrupt every IRETD/MOVZX etc. in its PM handlers.
    const base = (sel * 16) >>> 0;
    const newLo = ((base & 0xFFFF) << 16) | 0xFFFF; // base_lo<<16 | limit_lo
    const newHi = ((base >>> 24) << 24) | 0x00F200 | ((base >>> 16) & 0xFF);
    this.mem.writeU32(descAddr, newLo >>> 0);
    this.mem.writeU32(descAddr + 4, newHi >>> 0);
  }

  /** Read a GDT/LDT descriptor and return the access rights word as LAR would expose it.
   *  LAR result format: low byte = 0, bits 8..15 = access byte, bits 20..23 = flags nibble. */
  loadGdtDescriptorAccessRights(sel: number): number | undefined {
    const descAddr = this._descTableAddr(sel);
    if (descAddr < 0) return undefined;
    const hi = this.mem.readU32(descAddr + 4);
    // Mask out base/limit fields, keep the access byte (bits 8..15) and flags (bits 20..23)
    return (hi & 0x00F0FF00) >>> 0;
  }

  // Register accessors for 8/16 bit subregisters
  getReg8(idx: number): number {
    // idx 0-3: AL,CL,DL,BL; 4-7: AH,CH,DH,BH
    if (idx < 4) return this.reg[idx] & 0xFF;
    return (this.reg[idx - 4] >> 8) & 0xFF;
  }

  setReg8(idx: number, val: number): void {
    val &= 0xFF;
    if (idx < 4) {
      this.reg[idx] = (this.reg[idx] & ~0xFF) | val;
    } else {
      const r = idx - 4;
      this.reg[r] = (this.reg[r] & ~0xFF00) | (val << 8);
    }
  }

  getReg16(idx: number): number {
    return this.reg[idx] & 0xFFFF;
  }

  setReg16(idx: number, val: number): void {
    this.reg[idx] = (this.reg[idx] & ~0xFFFF) | (val & 0xFFFF);
  }

  // EFLAGS
  materializeFlags(): void {
    materializeFlags(this);
  }

  getFlags(): number {
    if (!this.flagsValid) materializeFlags(this);
    // Expose VM bit (17) when pseudo-V86 is active so guest PUSHF/PUSHFD
    // and IRETD consumers see EFLAGS.VM=1 (DOS/4GW detection gate).
    // flagsCache itself never stores VM — we OR it in on every read.
    return this._vm86 ? (this.flagsCache | 0x00020000) >>> 0 : this.flagsCache;
  }

  setFlags(f: number): void {
    // Strip VM bit from incoming flags (guest POPF/IRETD cannot flip VM in
    // pseudo-V86 mode — we keep the session-wide _vm86 flag authoritative).
    this.flagsCache = ((f | 0x0002) & ~0x00020000) >>> 0;
    this.flagsValid = true;
    this.lazyOp = LazyOp.NONE;
    this._tfActive = !!(f & TF);
  }

  getFlag(bit: number): boolean {
    if (bit === DF) return !!(this.flagsCache & DF);
    if (!this.flagsValid) materializeFlags(this);
    return !!(this.flagsCache & bit);
  }

  setFlag(bit: number, val: boolean): void {
    if (!this.flagsValid) materializeFlags(this);
    if (val) this.flagsCache |= bit;
    else this.flagsCache &= ~bit;
    if (bit === TF) this._tfActive = val;
  }

  setLazy(op: number, result: number, a: number, b: number): void {
    this.lazyOp = op;
    this.lazyResult = result;
    this.lazyA = a;
    this.lazyB = b;
    this.lazyCF = 0;
    this.flagsValid = false;
  }

  // Push / Pop — stack addressing is determined by SS.B (_ssB32), not CS.D.
  // In real mode and 16-bit PM (SS.B=0), use SP (16-bit wrap) + SS base.
  // In 32-bit PM (SS.B=1), use ESP (32-bit flat) + SS base (usually 0 for flat).
  push32(val: number): void {
    const stack32 = this._ssB32 && !this.realMode;
    if (!stack32) {
      const base = this.realMode ? (this.ss * 16) >>> 0 : this.segBase(this.ss);
      let sp = (this.reg[ESP] - 4) & 0xFFFF;
      this.reg[ESP] = (this.reg[ESP] & ~0xFFFF) | sp;
      this.mem.writeU32((base + sp) >>> 0, val >>> 0);
    } else {
      this.reg[ESP] = (this.reg[ESP] - 4) | 0;
      const base = this.segBase(this.ss);
      this.mem.writeU32(((base + this.reg[ESP]) >>> 0), val >>> 0);
    }
  }

  pop32(): number {
    const stack32 = this._ssB32 && !this.realMode;
    if (!stack32) {
      const base = this.realMode ? (this.ss * 16) >>> 0 : this.segBase(this.ss);
      const sp = this.reg[ESP] & 0xFFFF;
      const val = this.mem.readU32((base + sp) >>> 0);
      this.reg[ESP] = (this.reg[ESP] & ~0xFFFF) | ((sp + 4) & 0xFFFF);
      return val;
    } else {
      const base = this.segBase(this.ss);
      const val = this.mem.readU32(((base + this.reg[ESP]) >>> 0));
      this.reg[ESP] = (this.reg[ESP] + 4) | 0;
      return val;
    }
  }

  push16(val: number): void {
    const stack32 = this._ssB32 && !this.realMode;
    if (!stack32) {
      const base = this.realMode ? (this.ss * 16) >>> 0 : this.segBase(this.ss);
      let sp = (this.reg[ESP] - 2) & 0xFFFF;
      this.reg[ESP] = (this.reg[ESP] & ~0xFFFF) | sp;
      this.mem.writeU16((base + sp) >>> 0, val & 0xFFFF);
    } else {
      this.reg[ESP] = (this.reg[ESP] - 2) | 0;
      const base = this.segBase(this.ss);
      this.mem.writeU16(((base + this.reg[ESP]) >>> 0), val & 0xFFFF);
    }
  }

  pop16(): number {
    const stack32 = this._ssB32 && !this.realMode;
    if (!stack32) {
      const base = this.realMode ? (this.ss * 16) >>> 0 : this.segBase(this.ss);
      const sp = this.reg[ESP] & 0xFFFF;
      const val = this.mem.readU16((base + sp) >>> 0);
      this.reg[ESP] = (this.reg[ESP] & ~0xFFFF) | ((sp + 2) & 0xFFFF);
      return val;
    } else {
      const base = this.segBase(this.ss);
      const val = this.mem.readU16(((base + this.reg[ESP]) >>> 0));
      this.reg[ESP] = (this.reg[ESP] + 2) | 0;
      return val;
    }
  }

  // Fetch instruction byte
  fetch8(): number {
    const v = this.mem.readU8(this.eip >>> 0);
    this.eip = (this.eip + 1) | 0;
    return v;
  }

  fetch16(): number {
    const v = this.mem.readU16(this.eip >>> 0);
    this.eip = (this.eip + 2) | 0;
    return v;
  }

  fetch32(): number {
    const v = this.mem.readU32(this.eip >>> 0);
    this.eip = (this.eip + 4) | 0;
    return v;
  }

  fetchI8(): number {
    const v = this.mem.readI8(this.eip >>> 0);
    this.eip = (this.eip + 1) | 0;
    return v;
  }

  fetchI32(): number {
    const v = this.mem.readI32(this.eip >>> 0);
    this.eip = (this.eip + 4) | 0;
    return v;
  }

  // ModRM/SIB decoding — delegated to cpu-decode.ts
  decodeModRM(sizeBits: number): { isReg: boolean; regField: number; val: number; addr: number } {
    return _decodeModRM(this, sizeBits);
  }

  decodeSIB(mod: number): { addr: number; bpBase: boolean } {
    return _decodeSIB(this, mod);
  }

  getSegOverrideSel(): number {
    return _getSegOverrideSel(this);
  }

  decodeModRM16(sizeBits: number): { isReg: boolean; regField: number; val: number; addr: number } {
    return _decodeModRM16(this, sizeBits);
  }

  writeModRM(decoded: { isReg: boolean; addr: number }, val: number, sizeBits: number): void {
    _writeModRM(this, decoded, val, sizeBits);
  }

  decodeFPUModRM(): { mod: number; regField: number; rm: number; addr: number } {
    return _decodeFPUModRM(this);
  }

  // ALU helpers
  alu(op: number, a: number, b: number, size: 8 | 16 | 32): number {
    let result: number;
    const addOp = size === 8 ? LazyOp.ADD8 : size === 16 ? LazyOp.ADD16 : LazyOp.ADD32;
    const subOp = size === 8 ? LazyOp.SUB8 : size === 16 ? LazyOp.SUB16 : LazyOp.SUB32;

    switch (op) {
      case 0: // ADD
        result = (a + b) | 0;
        this.setLazy(addOp, result, a, b);
        return result;
      case 1: // OR
        result = a | b;
        this.setLazy(size === 8 ? LazyOp.OR8 : size === 16 ? LazyOp.OR16 : LazyOp.OR32, result, a, b);
        return result;
      case 2: { // ADC
        const cf = this.getFlag(CF) ? 1 : 0;
        result = (a + b + cf) | 0;
        // Store original b (not b+cf) so AF formula (a^b^res)&0x10 uses correct b.
        // lazyCF stores the carry-in separately for CF computation.
        this.setLazy(addOp, result, a, b);
        this.lazyCF = cf;
        return result;
      }
      case 3: { // SBB
        const cf = this.getFlag(CF) ? 1 : 0;
        result = (a - b - cf) | 0;
        // Store original b (not b+cf) so AF formula uses correct b.
        // lazyCF stores the borrow-in separately for CF computation.
        this.setLazy(subOp, result, a, b);
        this.lazyCF = cf;
        return result;
      }
      case 4: // AND
        result = a & b;
        this.setLazy(size === 8 ? LazyOp.AND8 : size === 16 ? LazyOp.AND16 : LazyOp.AND32, result, a, b);
        return result;
      case 5: // SUB
        result = (a - b) | 0;
        this.setLazy(subOp, result, a, b);
        return result;
      case 6: // XOR
        result = a ^ b;
        this.setLazy(size === 8 ? LazyOp.XOR8 : size === 16 ? LazyOp.XOR16 : LazyOp.XOR32, result, a, b);
        return result;
      case 7: // CMP
        result = (a - b) | 0;
        this.setLazy(subOp, result, a, b);
        return a; // CMP doesn't store result
      default:
        return a;
    }
  }

  // Condition code evaluation — materialize once, then test bits directly
  testCC(cc: number): boolean {
    if (!this.flagsValid) materializeFlags(this);
    const f = this.flagsCache;
    switch (cc) {
      case 0x0: return !!(f & OF);
      case 0x1: return !(f & OF);
      case 0x2: return !!(f & CF);
      case 0x3: return !(f & CF);
      case 0x4: return !!(f & ZF);
      case 0x5: return !(f & ZF);
      case 0x6: return !!((f & CF) | (f & ZF));
      case 0x7: return !((f & CF) | (f & ZF));
      case 0x8: return !!(f & SF);
      case 0x9: return !(f & SF);
      case 0xA: return !!(f & PF);
      case 0xB: return !(f & PF);
      case 0xC: return !!(f & SF) !== !!(f & OF);
      case 0xD: return !!(f & SF) === !!(f & OF);
      case 0xE: return !!(f & ZF) || (!!(f & SF) !== !!(f & OF));
      case 0xF: return !(f & ZF) && (!!(f & SF) === !!(f & OF));
      default: return false;
    }
  }

  // Execute one instruction — delegated to cpu-step.ts
  step(): void {
    this._inhibitIRQ = false; // Clear MOV SS interrupt inhibit from previous instruction
    // Fast path: TF is almost never set — skip the entire TF machinery
    if (!this._tfActive) {
      cpuStep(this);
      return;
    }
    // Slow path: TF is set — check for single-step trap
    const tfBefore = this.getFlags() & TF;
    this._inhibitTF = false;
    cpuStep(this);
    // If TF was set before the instruction, fire INT 1 (single-step exception)
    // Intel: no trap after INT/IRET/MOV SS/POP SS instructions
    if (tfBefore && !this._inhibitTF && !this.halted && this.emu) {
      // Clear TF before firing INT 1 (processor clears it on interrupt entry)
      const flags = this.getFlags();
      this.setFlags(flags & ~TF);
      // Push flags (with TF still set, as saved), CS, IP — then jump to INT 1 handler
      if (!this.use32) {
        this.push16(flags);
        this.push16(this.cs);
        this.push16((this.eip - this.segBase(this.cs)) & 0xFFFF);
        // Look up INT 1 vector from IVT
        const vec = this.mem.readU32(1 * 4);
        const newIP = vec & 0xFFFF;
        const newCS = (vec >>> 16) & 0xFFFF;
        this.cs = newCS;
        this.eip = this.segBase(newCS) + newIP;
      }
    }
  }
}
