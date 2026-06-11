import type { IMemory } from './backend';

// ANSI code page encoding name for TextDecoder
let _ansiEncoding = 'windows-1252';
let _ansiDecoder: TextDecoder | null = null;

/** Set the ANSI code page directly from a Windows codepage number (e.g. 936, 1252) */
export function setAnsiCodePageFromCP(codePage: number): void {
  const encoding = CP_TO_ENCODING[codePage];
  if (encoding && encoding !== _ansiEncoding) {
    _ansiEncoding = encoding;
    _ansiDecoder = null;
  }
}

// Windows codepage number → TextDecoder encoding name
const CP_TO_ENCODING: Record<number, string> = {
  936: 'gbk', 950: 'big5', 932: 'shift-jis', 949: 'euc-kr',
  1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252',
  1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255',
  1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258',
  874: 'windows-874', 1361: 'euc-kr',
};

/** Set the ANSI encoding directly by TextDecoder name */
export function setAnsiEncoding(encoding: string): void {
  if (encoding !== _ansiEncoding) {
    _ansiEncoding = encoding;
    _ansiDecoder = null;
  }
}

/**
 * Guess MBCS encoding from raw bytes by looking at lead/trail byte patterns.
 * Returns a TextDecoder encoding name, or null if no CJK encoding detected.
 */
export function guessEncodingFromBytes(data: Uint8Array): string | null {
  let sjisScore = 0;
  let gbkScore = 0;
  for (let i = 0; i < data.length - 1; i++) {
    const b = data[i];
    if (b < 0x80) continue;
    const b2 = data[i + 1];
    // Shift-JIS lead byte ranges: 0x81-0x9F, 0xE0-0xEF
    // trail byte: 0x40-0x7E, 0x80-0xFC
    if ((b >= 0x81 && b <= 0x9F) || (b >= 0xE0 && b <= 0xEF)) {
      if ((b2 >= 0x40 && b2 <= 0x7E) || (b2 >= 0x80 && b2 <= 0xFC)) {
        sjisScore++;
        i++; // skip trail byte
        continue;
      }
    }
    // GBK lead byte: 0x81-0xFE, trail: 0x40-0xFE
    if (b >= 0x81 && b <= 0xFE && b2 >= 0x40 && b2 <= 0xFE) {
      gbkScore++;
      i++;
      continue;
    }
  }
  // Shift-JIS is more restrictive, so if sjisScore > 0 and accounts for most hits, pick it
  if (sjisScore > 0 && sjisScore >= gbkScore) return 'shift-jis';
  if (gbkScore > 0) return 'gbk';
  return null;
}

/** Set the ANSI code page based on PE resource language ID */
export function setAnsiCodePage(languageId: number): void {
  const primary = languageId & 0x3FF;
  const encoding = LANG_TO_ENCODING[primary] || 'windows-1252';
  if (encoding !== _ansiEncoding) {
    _ansiEncoding = encoding;
    _ansiDecoder = null; // reset cached decoder
  }
}

// Primary language ID → TextDecoder encoding name
const LANG_TO_ENCODING: Record<number, string> = {
  0x04: /* Chinese */   'gbk',
  0x11: /* Japanese */  'shift-jis',
  0x12: /* Korean */    'euc-kr',
  0x19: /* Russian */   'windows-1251',
  0x22: /* Ukrainian */ 'windows-1251',
  0x15: /* Polish */    'windows-1250',
  0x0E: /* Hungarian */ 'windows-1250',
  0x05: /* Czech */     'windows-1250',
  0x1F: /* Turkish */   'windows-1254',
  0x08: /* Greek */     'windows-1253',
  0x0D: /* Hebrew */    'windows-1255',
  0x01: /* Arabic */    'windows-1256',
  0x1E: /* Thai */      'windows-874',
  0x2A: /* Vietnamese */'windows-1258',
};

// Reverse lookup table: Unicode codepoint → MBCS byte(s)
let _reverseTable: Map<number, number[]> | null = null;
let _reverseEncoding = '';

function getReverseTable(): Map<number, number[]> {
  if (_reverseTable && _reverseEncoding === _ansiEncoding) return _reverseTable;
  _reverseTable = new Map();
  _reverseEncoding = _ansiEncoding;
  const decoder = new TextDecoder(_ansiEncoding);
  // Single-byte 0x80-0xFF
  for (let b = 0x80; b <= 0xFF; b++) {
    const ch = decoder.decode(new Uint8Array([b]));
    if (ch.length === 1 && ch !== '\uFFFD') {
      _reverseTable.set(ch.charCodeAt(0), [b]);
    }
  }
  // Double-byte for CJK encodings
  const isMBCS = ['shift-jis', 'gbk', 'big5', 'euc-kr'].includes(_ansiEncoding);
  if (isMBCS) {
    const leadMin = _ansiEncoding === 'euc-kr' ? 0xA1 : 0x81;
    const leadMax = _ansiEncoding === 'shift-jis' ? 0xEF : 0xFE;
    for (let b1 = leadMin; b1 <= leadMax; b1++) {
      // Skip Shift-JIS gap (0xA0-0xDF are single-byte katakana)
      if (_ansiEncoding === 'shift-jis' && b1 >= 0xA0 && b1 <= 0xDF) continue;
      for (let b2 = 0x40; b2 <= 0xFE; b2++) {
        const ch = decoder.decode(new Uint8Array([b1, b2]));
        if (ch.length === 1 && ch !== '\uFFFD') {
          _reverseTable.set(ch.charCodeAt(0), [b1, b2]);
        }
      }
    }
  }
  return _reverseTable;
}

/** Encode a Unicode string back to MBCS bytes using the active code page */
export function encodeMBCS(s: string): Uint8Array {
  const out: number[] = [];
  const rev = getReverseTable();
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (cp < 0x80) {
      out.push(cp);
    } else {
      const bytes = rev.get(cp);
      if (bytes) {
        for (const b of bytes) out.push(b);
      } else {
        out.push(0x3F); // '?'
      }
    }
  }
  return new Uint8Array(out);
}

/** Decode MBCS bytes using the detected ANSI code page */
export function decodeMBCS(bytes: Uint8Array): string {
  // Fast path: all ASCII
  let allAscii = true;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] > 0x7F) { allAscii = false; break; }
  }
  if (allAscii) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  try {
    if (!_ansiDecoder) _ansiDecoder = new TextDecoder(_ansiEncoding);
    return _ansiDecoder.decode(bytes);
  } catch (_) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
}

/** Thrown when a write targets a read-only page (like .text section). */
export class AccessViolationError extends Error {
  constructor(public addr: number) { super(`Access violation writing 0x${addr.toString(16)}`); }
}

/** Thrown when paging is enabled and a virtual address resolves to no PTE.
 *  Caught by emu-exec.ts to dispatch INT 0Eh through the client's IDT so a
 *  guest #PF handler (e.g. EOS's demand-mapper) can populate the PDE/PTE and
 *  IRET back to retry the faulting instruction. */
export class PageFaultError extends Error {
  constructor(public vaddr: number, public isWrite: boolean) {
    super(`#PF at 0x${vaddr.toString(16)} write=${isWrite}`);
  }
}

// Sparse 32-bit memory using 64KB segments, lazily allocated
const SEG_BITS = 16;
const SEG_SIZE = 1 << SEG_BITS; // 65536
const SEG_MASK = SEG_SIZE - 1;

export class Memory implements IMemory {
  private segments = new Map<number, Uint8Array>();
  private dataViews = new Map<number, DataView>();

  // Hot segment cache (2-entry LRU) — avoids Map lookup for alternating code/data segments
  private _cKey0 = -1;
  private _cSeg0: Uint8Array = null!;
  private _cDV0: DataView = null!;
  private _cKey1 = -1;
  private _cSeg1: Uint8Array = null!;
  private _cDV1: DataView = null!;

  // Flat memory mode: when set, all reads/writes go directly to this buffer (no Map lookup)
  // Used for DOS mode to share the same ArrayBuffer with WASM JIT.
  private _flat: Uint8Array | null = null;
  private _flatDV: DataView | null = null;
  private _flatMax = 0; // max address accessible in flat mode

  // 32-bit PM paging (CR0.PG=1). When enabled, readU*/writeU* translate the
  // given linear virtual address to a physical address via a 2-level walk of
  // the page directory at _pagingPdBase. Translation results are cached in
  // _tlb (one entry per 4KB page). _tlb is invalidated on CR3 change or when
  // paging is disabled.
  _pagingEnabled = false;
  _pagingPdBase = 0;
  private _tlb = new Map<number, number>(); // virtPage → physPage

  /** When true, unmapped reads/writes throw `PageFaultError` instead of
   *  silently returning 0 / dropping. The catch in emu-exec.ts then routes the
   *  fault through the client's IDT vector 0x0E. Mirrored from `_pagingEnabled`
   *  by setPaging — a non-paging client sees no behavior change. */
  _pfDispatchEnabled = false;

  /** Returns true if the guest has installed a PM #PF handler (IDT[0x0E]
   *  present + non-zero selector). Used to gate PageFaultError throws so PM
   *  clients without a handler (e.g., DOS/4GW + EMUL5 that hasn't mapped the
   *  IDT/GDT region in CR3) keep the legacy silent-return-0 behavior instead
   *  of halting on every IDT/GDT read. IDT is read via `_readU32Physical`
   *  because the IDT region itself may not be mapped through paging. */
  hasGuestPfHandler(): boolean {
    if (!this._pmCpu || this._pmCpu.realMode) return false;
    const emu = this._pmCpu.emu;
    if (!emu) return false;
    const idtBase = (emu as any)._idtBase;
    if (!idtBase) return false;
    const entryAddr = (idtBase + 0x0E * 8) >>> 0;
    const lo = this._readU32Physical(entryAddr);
    const hi = this._readU32Physical(entryAddr + 4);
    const present = ((hi >>> 8) & 0x80) !== 0;
    const selector = (lo >>> 16) & 0xFFFF;
    return present && selector !== 0;
  }

  /** Enable/disable PM paging with a 4KB-aligned page-directory base. */
  setPaging(enabled: boolean, pdBase: number): void {
    const newBase = pdBase & ~0xFFF;
    if (this._pagingEnabled !== enabled || this._pagingPdBase !== newBase) {
      this._tlb.clear();
    }
    this._pagingEnabled = enabled;
    this._pagingPdBase = newBase;
    this._pfDispatchEnabled = enabled;
  }

  /** Invalidate the full TLB (call on CR3 write, LTR, etc.). */
  invalidateTLB(): void { this._tlb.clear(); }

  /** Invalidate a single virtual page from the TLB (INVLPG). */
  invalidatePage(vaddr: number): void { this._tlb.delete(vaddr >>> 12); }

  /**
   * Walk PD/PT and return the physical address for `vaddr`, or -1 if the
   * mapping is not present. Cached per-page in _tlb. Caller is responsible
   * for calling this only when `_pagingEnabled`.
   */
  translate(vaddr: number): number {
    const vpage = vaddr >>> 12;
    const cached = this._tlb.get(vpage);
    if (cached !== undefined) {
      return cached === -1 ? -1 : ((cached << 12) | (vaddr & 0xFFF));
    }
    // Walk page directory at _pagingPdBase; PDE[i] = PD base + i*4.
    const pdIdx = (vaddr >>> 22) & 0x3FF;
    const ptIdx = (vaddr >>> 12) & 0x3FF;
    // Read raw physical memory for the walk — always no-paging access.
    const pdeAddr = (this._pagingPdBase + pdIdx * 4) >>> 0;
    const pde = this._readU32Physical(pdeAddr);
    if (!(pde & 1)) {
      this._tlb.set(vpage, -1);
      return -1;
    }
    // 4MB-page support (CR4.PSE + PDE.PS). Most VCPI clients use 4KB pages,
    // but emit the right translation just in case.
    if (pde & 0x80) {
      const pbase = pde & 0xFFC00000;
      const paddr = pbase | (vaddr & 0x3FFFFF);
      this._tlb.set(vpage, paddr >>> 12);
      return paddr;
    }
    const ptBase = pde & ~0xFFF;
    const pteAddr = (ptBase + ptIdx * 4) >>> 0;
    const pte = this._readU32Physical(pteAddr);
    if (!(pte & 1)) {
      this._tlb.set(vpage, -1);
      return -1;
    }
    const ppage = pte >>> 12;
    this._tlb.set(vpage, ppage);
    return ((ppage << 12) | (vaddr & 0xFFF)) >>> 0;
  }

  /** Read a u32 from physical memory (bypasses paging; used by the walker). */
  private _readU32Physical(addr: number): number {
    addr = (addr & this.a20Mask) >>> 0;
    if (this._flatDV && addr + 3 < this._flatMax) return this._flatDV.getUint32(addr, true);
    const off = addr & SEG_MASK;
    if (off < SEG_SIZE - 3) return this.dv(addr).getUint32(off, true);
    return (this._readU8Physical(addr) | (this._readU8Physical(addr + 1) << 8) |
      (this._readU8Physical(addr + 2) << 16) | (this._readU8Physical(addr + 3) << 24)) >>> 0;
  }
  private _readU8Physical(addr: number): number {
    addr = (addr & this.a20Mask) >>> 0;
    if (this._flat && addr < this._flatMax) return this._flat[addr];
    return this.seg(addr)[addr & SEG_MASK];
  }

  /** Read a byte from physical memory, bypassing paging/MMU translation.
   *  Use this from hardware that reads raw physical addresses (DMA
   *  controller, bus-mastering devices). A normal CPU access should use
   *  readU8, which honors the active page tables. */
  readPhysicalU8(addr: number): number {
    return this._readU8Physical(addr);
  }

  /** Enable flat memory mode backed by a WebAssembly.Memory's buffer */
  enableFlatMode(buffer: ArrayBuffer, maxAddr: number): void {
    this._flat = new Uint8Array(buffer);
    this._flatDV = new DataView(buffer);
    this._flatMax = maxAddr;
    // Copy any existing sparse segments into the flat buffer
    for (const [key, seg] of this.segments) {
      const offset = key * SEG_SIZE;
      if (offset + SEG_SIZE <= maxAddr) {
        this._flat.set(seg, offset);
      }
    }
  }

  /** Check if flat mode is active */
  get isFlat(): boolean { return this._flat !== null; }

  // A20 gate: when disabled (default for DOS), addresses wrap at 1MB.
  // EXEPACK and other 8086-era programs rely on this wrap behavior.
  a20Mask = 0xFFFFFFFF; // 0xFFFFF = A20 off (20-bit wrap), 0xFFFFFFFF = A20 on

  // VGA planar memory hook: when set, intercepts reads/writes to A0000-AFFFF
  vgaPlanar: { planarWrite(offset: number, val: number): void; planarRead(offset: number): number } | null = null;
  _hasVga = false;

  /** Set VGA planar hook and update fast boolean flag */
  setVgaPlanar(v: { planarWrite(offset: number, val: number): void; planarRead(offset: number): number } | null): void {
    this.vgaPlanar = v;
    this._hasVga = v !== null;
  }

  // IVT protection for DPMI clients. When enabled, writes to linear 0-0x3FF
  // (the real-mode IVT) are silently dropped while the CPU is in PM. On a real
  // DPMI host with paging, PM linear 0 is mapped to a different physical page
  // than the RM IVT, so PM writes never clobber the RM IVT. We emulate this
  // by checking `_pmCpu.realMode` at write time — if false (PM), writes to the
  // IVT region are ignored.
  _pmCpu: { realMode: boolean; emu?: { _gdtBase?: number; _gdtLimit?: number } | null; ss?: number; dropSegBaseCache?: (sel: number) => void; refreshSsB32?: () => void } | null = null;
  _ivtProtect = false;

  // DOS/4GW pre-populates its PM interrupt-handler table via two anchor writes
  // (entries [0] and [32] get val 0x00050100 = type=0, next=1, sig=0x0005) each
  // followed by a 4-byte signature write at offset +4 (val 0x0000fdbd for [0]
  // and 0x0000fdad for [32]). On a real DPMI host the 30 intermediate slots
  // [1..31] start as type=1 "default terminator" entries that the scan loop at
  // cs=1569:0x1016 terminates on. Our DPMI allocator returns zero-filled memory
  // so without this fix entries [1..31] stay type=0 and the scan loops forever.
  // When we see the two-write pattern in PM, populate the intermediate slots'
  // type byte so the scan terminates.
  _dos4gwTableAnchored = false;
  _dos4gwPendingAnchorAddr = -1;
  /** Base address of DOS/4GW's handler table, set once the anchor pattern is
   *  identified. Used later by the lazy handler-field population triggered
   *  when DOS/4GW first links a chain head to one of the default slots. */
  _dos4gwTableBase = -1;
  _dos4gwTableFieldsPopulated = false;
  /** DPMI default-terminator stub location (set by handleDpmiEntry). Used to
   *  fill the selector/offset fields of type=1 entries. */
  _dpmiTerminatorSel = 0x38;
  _dpmiTerminatorOff = 0x700;
  /** Set of linear addresses where DOS/4GW's stack-guard initial value
   *  `0x6810` has been captured. DOS/4GW keeps multiple such guard cells for
   *  different contexts (exception stack at cs=1569:0x5AD, transfer stack at
   *  cs=98:0xD4A, etc.). Every subsequent writeU16/U32 to any of these cells
   *  that would drop below `_dos4gwStackGuardMin` is clamped up, preventing
   *  `exit(2002)` "transfer stack overflow" drift during long-running sessions
   *  (e.g. DOOM's M_LoadDefaults / PIT IRQ storms). */
  _dos4gwStackGuards = new Set<number>();
  readonly _dos4gwStackGuardMin = 0x5000;

  // Read-only page ranges (4KB granularity, matching Windows page size): writes throw AccessViolationError
  private _readOnlyPages = new Set<number>();

  markReadOnly(startAddr: number, size: number): void {
    const startPage = startAddr >>> 12;
    const endPage = (startAddr + size - 1) >>> 12;
    for (let p = startPage; p <= endPage; p++) this._readOnlyPages.add(p);
  }

  private _isReadOnly(addr: number): boolean {
    return this._readOnlyPages.has(addr >>> 12);
  }

  private seg(addr: number): Uint8Array {
    const key = addr >>> SEG_BITS;
    if (key === this._cKey0) return this._cSeg0;
    if (key === this._cKey1) return this._cSeg1;
    // Miss: evict entry 1, shift entry 0 → entry 1, insert new as entry 0
    let s = this.segments.get(key);
    if (!s) {
      s = new Uint8Array(SEG_SIZE);
      this.segments.set(key, s);
      this.dataViews.set(key, new DataView(s.buffer));
    }
    this._cKey1 = this._cKey0; this._cSeg1 = this._cSeg0; this._cDV1 = this._cDV0;
    this._cKey0 = key; this._cSeg0 = s; this._cDV0 = this.dataViews.get(key)!;
    return s;
  }

  private dv(addr: number): DataView {
    const key = addr >>> SEG_BITS;
    if (key === this._cKey0) return this._cDV0;
    if (key === this._cKey1) return this._cDV1;
    this.seg(addr);
    return this._cDV0;
  }

  /** Upper bound for address-range loops. Returns the flat buffer size
   *  in DOS mode (where memory is a single block), otherwise the standard
   *  1 MB real-mode address space. Lets callers safely cap `addr < length`. */
  get length(): number {
    return this._flat ? this._flat.byteLength : 0x100000;
  }

  readU8(addr: number): number {
    addr = (addr & this.a20Mask) >>> 0;
    if (this._pagingEnabled) {
      const p = this.translate(addr);
      if (p < 0) {
        // Only throw #PF in PM AND only when the guest has installed a PF
        // handler in IDT[0x0E]. PM-without-handler stays on the legacy
        // "return 0" path so DOS/4GW + EMUL5 (which run with paging on but
        // never map the IDT/GDT region in CR3) don't halt every IDT read.
        if (this._pfDispatchEnabled && this._pmCpu && !this._pmCpu.realMode
            && this.hasGuestPfHandler()) {
          throw new PageFaultError(addr, false);
        }
        // V86 fallback: DPMI hosts identity-map low memory for V86 access.
        // When the guest's CR3 doesn't map a V86 page, treat the linear
        // address as physical instead of returning 0 — this lets V86 code
        // hit VGA/BIOS/low-mem regions that the host would normally cover.
        if (!(this._pmCpu && this._pmCpu.realMode)) return 0;
      } else {
        addr = p >>> 0;
      }
    }
    if (this._hasVga && (addr >>> 16) === 0xA) return this.vgaPlanar!.planarRead(addr & 0xFFFF);
    if (this._flat && addr < this._flatMax) return this._flat[addr];
    return this.seg(addr)[addr & SEG_MASK];
  }

  readU16(addr: number): number {
    addr = (addr & this.a20Mask) >>> 0;
    if (this._pagingEnabled) {
      // Page boundary crossing: translate each byte. Otherwise single translate.
      if ((addr & 0xFFF) >= 0xFFF) {
        return this.readU8(addr) | (this.readU8(addr + 1) << 8);
      }
      const p = this.translate(addr);
      if (p < 0) {
        if (this._pfDispatchEnabled && this._pmCpu && !this._pmCpu.realMode
            && this.hasGuestPfHandler()) {
          throw new PageFaultError(addr, false);
        }
        // V86 fallback: identity-translate. See readU8 for rationale.
        if (!(this._pmCpu && this._pmCpu.realMode)) return 0;
      } else {
        addr = p >>> 0;
      }
    }
    if (this._hasVga && (addr >>> 16) === 0xA) {
      return this.readU8(addr) | (this.readU8(addr + 1) << 8);
    }
    if (this._flatDV && addr + 1 < this._flatMax) return this._flatDV.getUint16(addr, true);
    const off = addr & SEG_MASK;
    if (off < SEG_SIZE - 1) {
      return this.dv(addr).getUint16(off, true);
    }
    return this.readU8(addr) | (this.readU8(addr + 1) << 8);
  }

  readU32(addr: number): number {
    addr = (addr & this.a20Mask) >>> 0;
    if (this._pagingEnabled) {
      if ((addr & 0xFFF) >= 0xFFD) {
        return (this.readU8(addr) | (this.readU8(addr + 1) << 8) |
          (this.readU8(addr + 2) << 16) | (this.readU8(addr + 3) << 24)) >>> 0;
      }
      const p = this.translate(addr);
      if (p < 0) {
        if (this._pfDispatchEnabled && this._pmCpu && !this._pmCpu.realMode
            && this.hasGuestPfHandler()) {
          throw new PageFaultError(addr, false);
        }
        // V86 fallback: identity-translate. See readU8 for rationale.
        if (!(this._pmCpu && this._pmCpu.realMode)) return 0;
      } else {
        addr = p >>> 0;
      }
    }
    if (this._hasVga && (addr >>> 16) === 0xA) {
      return (this.readU8(addr) | (this.readU8(addr + 1) << 8) |
        (this.readU8(addr + 2) << 16) | (this.readU8(addr + 3) << 24)) >>> 0;
    }
    if (this._flatDV && addr + 3 < this._flatMax) return this._flatDV.getUint32(addr, true);
    const off = addr & SEG_MASK;
    if (off < SEG_SIZE - 3) {
      return this.dv(addr).getUint32(off, true);
    }
    return (this.readU8(addr) | (this.readU8(addr + 1) << 8) |
      (this.readU8(addr + 2) << 16) | (this.readU8(addr + 3) << 24)) >>> 0;
  }

  readI8(addr: number): number {
    const v = this.readU8(addr);
    return v > 127 ? v - 256 : v;
  }

  readI16(addr: number): number {
    const v = this.readU16(addr);
    return v > 32767 ? v - 65536 : v;
  }

  readI32(addr: number): number {
    return this.readU32(addr) | 0;
  }

  /** Iterate over all allocated segment keys (for flat memory sync) */
  getSegmentKeys(): IterableIterator<number> { return this.segments.keys(); }
  /** Get raw segment data (for flat memory sync) */
  getSegment(key: number): Uint8Array | undefined { return this.segments.get(key); }
  /** Ensure a segment exists and return it */
  ensureSegment(key: number): Uint8Array {
    let s = this.segments.get(key);
    if (!s) { s = new Uint8Array(SEG_SIZE); this.segments.set(key, s); this.dataViews.set(key, new DataView(s.buffer)); }
    return s;
  }

  writeU8(addr: number, val: number): void {
    addr = (addr & this.a20Mask) >>> 0;
    if (this._ivtProtect && addr >= 0x80 && addr < 0xA0 && this._pmCpu && !this._pmCpu.realMode && val === 0) return;
    if (this._pagingEnabled) {
      const p = this.translate(addr);
      if (p < 0) {
        if (this._pfDispatchEnabled && this._pmCpu && !this._pmCpu.realMode
            && this.hasGuestPfHandler()) {
          throw new PageFaultError(addr, true);
        }
        // V86 fallback: identity-translate. See readU8 for rationale.
        if (!(this._pmCpu && this._pmCpu.realMode)) return;
      } else {
        addr = p >>> 0;
      }
    }
    if (this._hasVga && (addr >>> 16) === 0xA) { this.vgaPlanar!.planarWrite(addr & 0xFFFF, val & 0xFF); return; }
    if (this._readOnlyPages.size > 0 && this._isReadOnly(addr)) throw new AccessViolationError(addr);
    if (this._flat && addr < this._flatMax) { this._flat[addr] = val & 0xFF; return; }
    this.seg(addr)[addr & SEG_MASK] = val & 0xFF;
  }

  writeU16(addr: number, val: number): void {
    addr = (addr & this.a20Mask) >>> 0;
    if (this._ivtProtect && addr >= 0x80 && addr < 0xA0 && this._pmCpu && !this._pmCpu.realMode && val === 0) return;
    // Discover the DOS/4GW stack-guard address by watching for the initial
    // 0x6810 write on a 2-byte boundary in PM — that value is the canonical
    // initial [DS:0xa42] set by DOS/4GW's init. Only consider addresses below
    // the handler table base (DOS/4GW's DS lives below the table region).
    // Subsequent writes that would drop it below the guard floor get clamped.
    if (this._pmCpu && !this._pmCpu.realMode && (addr & 1) === 0) {
      if (this._dos4gwStackGuards.has(addr) && val < this._dos4gwStackGuardMin) {
        val = this._dos4gwStackGuardMin;
      }
    }
    if (this._pagingEnabled) {
      if ((addr & 0xFFF) >= 0xFFF) {
        this.writeU8(addr, val & 0xFF);
        this.writeU8(addr + 1, (val >> 8) & 0xFF);
        return;
      }
      const p = this.translate(addr);
      if (p < 0) {
        if (this._pfDispatchEnabled && this._pmCpu && !this._pmCpu.realMode
            && this.hasGuestPfHandler()) {
          throw new PageFaultError(addr, true);
        }
        // V86 fallback: identity-translate. See readU8 for rationale.
        if (!(this._pmCpu && this._pmCpu.realMode)) return;
      } else {
        addr = p >>> 0;
      }
    }
    if (this._hasVga && (addr >>> 16) === 0xA) { this.writeU8(addr, val & 0xFF); this.writeU8(addr + 1, (val >> 8) & 0xFF); return; }
    if (this._readOnlyPages.size > 0 && this._isReadOnly(addr)) throw new AccessViolationError(addr);
    if (this._flatDV && addr + 1 < this._flatMax) { this._flatDV.setUint16(addr, val, true); return; }
    const off = addr & SEG_MASK;
    if (off < SEG_SIZE - 1) {
      this.dv(addr).setUint16(off, val, true);
    } else {
      this.writeU8(addr, val & 0xFF);
      this.writeU8(addr + 1, (val >> 8) & 0xFF);
    }
  }

  writeU32(addr: number, val: number): void {
    addr = (addr & this.a20Mask) >>> 0;
    if (this._ivtProtect && addr >= 0x80 && addr < 0xA0 && this._pmCpu && !this._pmCpu.realMode && val === 0) return;
    // GDT-region write: invalidate the cached base for the affected selector
    // so the next segBase() picks up the new descriptor. Memory testers /
    // shadow descriptor populators that write GDT entries directly need this.
    // If the write touches the descriptor for the current SS, also refresh
    // _ssB32 since the D/B bit may have flipped (DPMI AX=0009 / direct flags
    // patch).
    if (this._pmCpu && this._pmCpu.emu && this._pmCpu.emu._gdtBase && this._pmCpu.dropSegBaseCache) {
      const gdtBase = this._pmCpu.emu._gdtBase;
      const gdtLimit = this._pmCpu.emu._gdtLimit ?? 0xFFFF;
      if (addr >= gdtBase && addr < gdtBase + gdtLimit + 1) {
        const sel = ((addr - gdtBase) >>> 3) << 3;
        this._pmCpu.dropSegBaseCache(sel);
        if (this._pmCpu.ss === sel && this._pmCpu.refreshSsB32) this._pmCpu.refreshSsB32();
      }
    }
    // See writeU16 above — same DOS/4GW stack-guard clamp, but for 32-bit
    // writes. [DS:0xa42] is a 16-bit cell, but DOS/4GW's cs=1569:0x5BA does
    // `mov [0xa42], esi` (a 32-bit store whose low word is the guard value).
    // Capture DOS/4GW's exception-stack guard by the first PM writeU32 whose
    // low word is the canonical 0x6810 and whose target is a paragraph-aligned
    // address inside DOS/4GW's LE data region (below the handler table and
    // within a plausible LE-shadow DS base). The high word of the 32-bit
    // store is typically 0 (DOS/4GW uses `mov dword [0xa42], 0x6810`).
    if (this._pmCpu && !this._pmCpu.realMode && (addr & 1) === 0) {
      const lo = val & 0xFFFF;
      // Catch EVERY canonical 0x00006810 write in PM (below the handler table
      // and above low memory) as a potential DOS/4GW stack-guard init. DOS/4GW
      // maintains several guard cells — the exception-stack cell at [0xa42]
      // and the transfer-stack-frame (TSF32) cell on a separate memory region
      // that's consulted at cs=98:0xD4A. Missing one causes exit(2002) once
      // its counter drifts below 0x4840 during heavy IRQ traffic.
      if (this._dos4gwTableAnchored && lo === 0x6810 && (val >>> 16) === 0
          && addr < this._dos4gwTableBase && addr >= 0x10000) {
        this._dos4gwStackGuards.add(addr);
      } else if (this._dos4gwStackGuards.has(addr) && lo < this._dos4gwStackGuardMin) {
        val = (val & 0xFFFF0000) | this._dos4gwStackGuardMin;
      }
    }
    if (this._pagingEnabled) {
      if ((addr & 0xFFF) >= 0xFFD) {
        this.writeU8(addr, val & 0xFF);
        this.writeU8(addr + 1, (val >> 8) & 0xFF);
        this.writeU8(addr + 2, (val >> 16) & 0xFF);
        this.writeU8(addr + 3, (val >> 24) & 0xFF);
        return;
      }
      const p = this.translate(addr);
      if (p < 0) {
        if (this._pfDispatchEnabled && this._pmCpu && !this._pmCpu.realMode
            && this.hasGuestPfHandler()) {
          throw new PageFaultError(addr, true);
        }
        // V86 fallback: identity-translate. See readU8 for rationale.
        if (!(this._pmCpu && this._pmCpu.realMode)) return;
      } else {
        addr = p >>> 0;
      }
    }
    if (this._hasVga && (addr >>> 16) === 0xA) { this.writeU8(addr, val & 0xFF); this.writeU8(addr + 1, (val >> 8) & 0xFF); this.writeU8(addr + 2, (val >> 16) & 0xFF); this.writeU8(addr + 3, (val >> 24) & 0xFF); return; }
    // DOS/4GW handler-table anchor write: see _dos4gwTableAnchored field
    // comment. DOS/4GW initializes entries [0] and [32] of the PM interrupt-
    // handler table with the value 0x00050100 (type=0, next=1, sig=0x0005);
    // the two writes target addresses 0x100 (= 32*8) apart and belong to the
    // same table. When we see two such writes matching that distance, we
    // identify the table base and populate intermediate slots with type=1
    // "default terminator" entries so the scan loop at cs=1569:0x1016
    // terminates and the subsequent dispatch at cs=1569:0xbf4 calls a
    // do-nothing RETF stub instead of jumping to 0:0.
    if (!this._dos4gwTableAnchored && this._pmCpu && !this._pmCpu.realMode
        && val === 0x00050100 && (addr & 7) === 0 && addr >= 0x100000) {
      if (this._dos4gwPendingAnchorAddr < 0) {
        this._dos4gwPendingAnchorAddr = addr;
      } else {
        const prev = this._dos4gwPendingAnchorAddr;
        const delta = addr - prev;
        const base = delta === 0x100 ? prev : delta === -0x100 ? addr : -1;
        if (base >= 0) {
          this._dos4gwTableAnchored = true;
          this._dos4gwTableBase = base;
          // Populate entries [1..31] as type=1 "default terminator" slots.
          // Each entry's `next` field must NOT point back into the existing
          // chain (entry[0].next=1 on a real host), otherwise DOS/4GW's
          // integrity check at cs=1569 walks [0]→[1]→[0]→… forever, detects
          // the loop and exits with fatal error 1001 "error in interrupt
          // chain". Using the entry's own index as .next makes it a proper
          // self-terminating node. Offset/selector fields are populated
          // lazily (see _dos4gwTableFieldsPopulated) because DOS/4GW uses the
          // 0x402a38..0x402b2F region for scratch during init and
          // overwriting it too early corrupts LE-load state.
          for (let i = 1; i <= 31; i++) {
            this.writeU8(base + i * 8 + 0, 1); // type = 1 (terminator)
            this.writeU8(base + i * 8 + 1, i); // next = self (no loop)
          }
        }
        this._dos4gwPendingAnchorAddr = addr;
      }
    }
    if (this._readOnlyPages.size > 0 && this._isReadOnly(addr)) throw new AccessViolationError(addr);
    if (this._flatDV && addr + 3 < this._flatMax) { this._flatDV.setUint32(addr, val, true); return; }
    const off = addr & SEG_MASK;
    if (off < SEG_SIZE - 3) {
      this.dv(addr).setUint32(off, val, true);
    } else {
      this.writeU8(addr, val & 0xFF);
      this.writeU8(addr + 1, (val >> 8) & 0xFF);
      this.writeU8(addr + 2, (val >> 16) & 0xFF);
      this.writeU8(addr + 3, (val >> 24) & 0xFF);
    }
  }

  // Signed write aliases — identical bit pattern to unsigned writes
  writeI16(addr: number, val: number): void { this.writeU16(addr, val); }
  writeI32(addr: number, val: number): void { this.writeU32(addr, val); }

  fill(addr: number, len: number, val: number): void {
    if (this._flat && addr + len <= this._flatMax) {
      this._flat.fill(val, addr, addr + len);
      return;
    }
    let remaining = len;
    let cur = addr;
    while (remaining > 0) {
      const seg = this.seg(cur);
      const off = cur & SEG_MASK;
      const chunk = Math.min(remaining, SEG_SIZE - off);
      seg.fill(val, off, off + chunk);
      cur += chunk;
      remaining -= chunk;
    }
  }

  copyFrom(addr: number, data: Uint8Array): void {
    if (this._flat && addr + data.length <= this._flatMax) {
      this._flat.set(data, addr);
      return;
    }
    let remaining = data.length;
    let cur = addr;
    let srcOff = 0;
    while (remaining > 0) {
      const seg = this.seg(cur);
      const off = cur & SEG_MASK;
      const chunk = Math.min(remaining, SEG_SIZE - off);
      seg.set(data.subarray(srcOff, srcOff + chunk), off);
      cur += chunk;
      srcOff += chunk;
      remaining -= chunk;
    }
  }

  slice(addr: number, len: number): Uint8Array {
    if (this._flat && addr + len <= this._flatMax) {
      return this._flat.slice(addr, addr + len);
    }
    const result = new Uint8Array(len);
    let remaining = len;
    let cur = addr;
    let dstOff = 0;
    while (remaining > 0) {
      const seg = this.seg(cur);
      const off = cur & SEG_MASK;
      const chunk = Math.min(remaining, SEG_SIZE - off);
      result.set(seg.subarray(off, off + chunk), dstOff);
      cur += chunk;
      dstOff += chunk;
      remaining -= chunk;
    }
    return result;
  }

  /** Bulk copy within memory — segment-level optimization */
  copyBlock(dst: number, src: number, len: number): void {
    if (this._flat && src + len <= this._flatMax && dst + len <= this._flatMax) {
      // Flat mode fast path — use copyWithin for overlapping-safe bulk copy
      this._flat.copyWithin(dst, src, src + len);
      return;
    }
    let remaining = len;
    let s = src;
    let d = dst;
    while (remaining > 0) {
      const srcSeg = this.seg(s);
      const srcOff = s & SEG_MASK;
      const dstSeg = this.seg(d);
      const dstOff = d & SEG_MASK;
      const chunk = Math.min(remaining, SEG_SIZE - srcOff, SEG_SIZE - dstOff);
      if (srcSeg === dstSeg && srcOff < dstOff && srcOff + chunk > dstOff) {
        // Overlapping within same segment, copy backwards
        for (let i = chunk - 1; i >= 0; i--) dstSeg[dstOff + i] = srcSeg[srcOff + i];
      } else {
        dstSeg.set(srcSeg.subarray(srcOff, srcOff + chunk), dstOff);
      }
      s += chunk;
      d += chunk;
      remaining -= chunk;
    }
  }

  readCString(addr: number): string {
    const bytes: number[] = [];
    for (let i = 0; ; i++) {
      const ch = this.readU8(addr + i);
      if (ch === 0) break;
      bytes.push(ch);
    }
    return decodeMBCS(new Uint8Array(bytes));
  }

  /** Read `count` bytes as an MBCS string */
  readBytesMBCS(addr: number, count: number): string {
    const bytes = new Uint8Array(count);
    for (let i = 0; i < count; i++) bytes[i] = this.readU8(addr + i);
    return decodeMBCS(bytes);
  }

  writeCString(addr: number, s: string): void {
    const bytes = encodeMBCS(s);
    for (let i = 0; i < bytes.length; i++) {
      this.writeU8(addr + i, bytes[i]);
    }
    this.writeU8(addr + bytes.length, 0);
  }

  readUTF16String(addr: number): string {
    let s = '';
    for (let i = 0; ; i += 2) {
      const ch = this.readU16(addr + i);
      if (ch === 0) break;
      s += String.fromCharCode(ch);
    }
    return s;
  }

  writeUTF16String(addr: number, s: string): void {
    for (let i = 0; i < s.length; i++) {
      this.writeU16(addr + i * 2, s.charCodeAt(i));
    }
    this.writeU16(addr + s.length * 2, 0);
  }
}
