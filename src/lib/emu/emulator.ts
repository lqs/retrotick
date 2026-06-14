import { Memory } from './memory';
import { CPU } from './x86/cpu';
import { FlatMemory, OFF_ENTRY } from './x86/flat-memory';
import { compileWasmRegion, type WasmCompiledRegion } from './x86/wasm-module';
import { ArmCPU, SP as ARM_SP, LR as ARM_LR, PC as ARM_PC } from './arm/cpu';
import type { LoadedPE } from './pe-loader';
import type { LoadedNE, NEResourceEntry } from './ne-loader';
import { HandleTable } from './win32/handles';
import type { DCInfo, BitmapInfo, PenInfo, BrushInfo } from './win32/gdi32/index';
import type { WindowInfo, WndClassInfo } from './win32/user32/index';
import type { TreeViewItem, ListViewColumn, ListViewItem } from './win32/user32/types';
import type { PEInfo, MenuItem } from '../pe/types';
import type { GL1Context } from './win32/gl-context';
import type { RegistryStore } from '../registry-store';
import type { ProfileStore } from '../profile-store';
import { loadGeneralSettings } from '../general-settings';
import { DefaultFileManager } from './file-manager';
import { VGAState, isVGAPort, syncGraphics } from './dos/vga';
import { DosAudio } from './dos/audio';
import { createDosMouseState } from './dos/mouse';
import type { FileManager } from './file-manager';
import { renderChildControls as _renderChildControls, notifyControlOverlays as _notifyControlOverlays } from './emu-render';
import { getDC as _getDC, getWindowDC as _getWindowDC, promoteToMainWindow as _promoteToMainWindow, setupCanvasSize as _setupCanvasSize, beginPaint as _beginPaint, endPaint as _endPaint, syncDCToCanvas as _syncDCToCanvas, releaseChildDC as _releaseChildDC, dispatchToSehHandler as _dispatchToSehHandler, getBrush as _getBrush, getPen as _getPen, loadBitmapResource as _loadBitmapResource, loadBitmapResourceFromModule as _loadBitmapResourceFromModule, loadBitmapResourceByName as _loadBitmapResourceByName, loadCursorResourceByName as _loadCursorResourceByName, loadStringResource as _loadStringResource, loadIconResource as _loadIconResource } from './emu-window';
import { emuLoad, emuFindResourceEntry } from './emu-load';
import { emuTick, emuCallWndProc, emuCallWndProc16, emuCallNative, emuCallCallback } from './emu-exec';
import { emuTickARM, emuCallWndProcARM } from './emu-exec-arm';
import { Thread } from './thread';

export { fillTextBitmap } from './emu-render';
export { Thread } from './thread';
export type { FileManager } from './file-manager';
export { DefaultFileManager } from './file-manager';

export interface WinMsg {
  hwnd: number;
  message: number;
  wParam: number;
  lParam: number;
}

export interface DialogControlInfo {
  id: number;
  className: string;
  text: string;
  style: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CommonDialogRequest =
  | { type: 'about'; caption: string; extraInfo: string; otherText: string; onDismiss: () => void }
  | { type: 'file-open'; filter?: string; initialDir?: string; onResult: (result: { path: string; data?: ArrayBuffer } | null) => void }
  | { type: 'file-save'; filter?: string; initialDir?: string; defaultName?: string; onResult: (result: { path: string } | null) => void }
  | { type: 'find'; editHwnd: number; onClose: () => void }
  | { type: 'find-replace'; editHwnd: number; onClose: () => void };

export interface DialogInfo {
  title: string;
  style: number;
  width: number;
  height: number;
  hwnd: number;
  controls: DialogControlInfo[];
  overlays: ControlOverlay[];
  controlValues: Map<number, string>;
}

export interface ControlOverlay {
  controlId: number;
  childHwnd: number;
  className: string;
  /** For superclassed controls: the base built-in class (e.g. "EDIT" for Delphi's "TEDIT") */
  baseClassName?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  style: number;
  exStyle: number;
  title: string;
  checked: number;
  fontHeight: number;
  trackPos: number;
  trackMin: number;
  trackMax: number;
  treeItems?: TreeViewItem[];
  treeSelectedItem?: number;
  treeImageUrls?: (string | undefined)[];
  lbItems?: string[];
  lbSelectedIndex?: number;
  lbSelectedIndices?: number[];
  cbItems?: string[];
  cbSelectedIndex?: number;
  listColumns?: ListViewColumn[];
  listItems?: ListViewItem[];
  statusTexts?: string[];
  statusParts?: number[];
  tabItems?: { text: string }[];
  tabSelectedIndex?: number;
  bgColor?: string;
  /** True if this is an MDI child window (should render with title bar/frame) */
  isMdiChild?: boolean;
  /** True if this MDI child is the active (focused) one */
  isMdiActive?: boolean;
  /** True if this MDI child is maximized */
  isMdiMaximized?: boolean;
  /** True if this MDI child is minimized */
  isMdiMinimized?: boolean;
  /** Children overlays nested inside this MDI child window */
  mdiChildren?: ControlOverlay[];
  /** MDICLIENT clip rect for MDI children (absolute canvas coords) */
  mdiClientRect?: { x: number; y: number; w: number; h: number };
}

// Detect fullwidth characters (CJK, fullwidth forms, etc.) that occupy 2 console columns
export function isFullwidth(cp: number): boolean {
  // CJK Radicals Supplement..Enclosed CJK Letters
  if (cp >= 0x2E80 && cp <= 0x33FF) return true;
  // CJK Compatibility..CJK Unified Ideographs Extension A
  if (cp >= 0x3400 && cp <= 0x4DBF) return true;
  // CJK Unified Ideographs
  if (cp >= 0x4E00 && cp <= 0x9FFF) return true;
  // Hangul Syllables
  if (cp >= 0xAC00 && cp <= 0xD7AF) return true;
  // CJK Compatibility Ideographs
  if (cp >= 0xF900 && cp <= 0xFAFF) return true;
  // Fullwidth Forms (Fullwidth ASCII, Halfwidth Katakana excluded)
  if (cp >= 0xFF01 && cp <= 0xFF60) return true;
  if (cp >= 0xFFE0 && cp <= 0xFFE6) return true;
  // CJK extensions B-F, Compatibility Supplement
  if (cp >= 0x20000 && cp <= 0x2FA1F) return true;
  return false;
}

// Global cascading default position for CW_USEDEFAULT (shared across all instances)
// Offset matches Windows classic theme: caption height (19) + frame (4) ≈ 23px
const CASCADE_OFFSET = 23;
const CASCADE_START_X = 23;
const CASCADE_START_Y = 23;
const cascadePos = { x: CASCADE_START_X, y: CASCADE_START_Y };

/** Get next cascading position and advance. Resets when too close to bottom-right. */
export function getNextCascadePos(screenWidth: number, screenHeight: number): { x: number; y: number } {
  const { x, y } = cascadePos;
  // Reset if too close to bottom-right (leave room for at least 200x200 visible area)
  if (x + 200 > screenWidth || y + 200 > screenHeight) {
    cascadePos.x = CASCADE_START_X;
    cascadePos.y = CASCADE_START_Y;
  } else {
    cascadePos.x += CASCADE_OFFSET;
    cascadePos.y += CASCADE_OFFSET;
  }
  return { x, y };
}

export interface ProcessEntry {
  pid: number;
  name: string;
  threadCount: number;
  basePriority: number;
  handleCount: number;
  workingSetSize: number;   // bytes
  cpuTime: number;          // ms
}

export interface WindowEntry {
  hwnd: number;
  title: string;
  pid: number;
  visible: boolean;
}

export class ProcessRegistry {
  private nextPid = 100;
  private entries = new Map<number, ProcessEntry>();
  private emulators = new Map<number, Emulator>();

  register(emu: Emulator, exeName: string): number {
    const pid = this.nextPid;
    this.nextPid += 4; // Windows PIDs are multiples of 4
    emu.pid = pid;
    emu.exeName = exeName;
    if (!emu.exePath) {
      const name = exeName.replaceAll('/', '\\');
      if (name.includes('\\')) {
        emu.exePath = /^[A-Za-z]:/.test(name) ? name : 'D:\\' + name;
      } else {
        const cwd = emu.currentDirs.get('D') || 'D:\\';
        emu.exePath = cwd.endsWith('\\') ? cwd + name : cwd + '\\' + name;
      }
    }
    this.entries.set(pid, {
      pid,
      name: exeName,
      threadCount: 1,
      basePriority: 8,
      handleCount: 0,
      workingSetSize: 0,
      cpuTime: 0,
    });
    this.emulators.set(pid, emu);
    return pid;
  }

  unregister(pid: number): void {
    this.entries.delete(pid);
    this.emulators.delete(pid);
  }

  /** Get all processes (entries + live stats from emulators) */
  getProcessList(): ProcessEntry[] {
    const result: ProcessEntry[] = [];
    for (const [pid, entry] of this.entries) {
      const emu = this.emulators.get(pid);
      if (emu) {
        entry.handleCount = emu.handles.size();
        entry.workingSetSize = (emu.heapPtr - emu.heapBase + emu.virtualPtr - emu.virtualBase) || 0;
        entry.cpuTime = emu.cpuTimeMs;
      }
      result.push(entry);
    }
    return result;
  }

  /** Get all visible top-level windows across all emulators */
  getWindowList(): WindowEntry[] {
    const result: WindowEntry[] = [];
    for (const [pid, emu] of this.emulators) {
      if (emu.mainWindow) {
        const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
        if (wnd && wnd.title) {
          result.push({ hwnd: emu.mainWindow, title: wnd.title, pid, visible: wnd.visible !== false });
        }
      }
    }
    return result;
  }
}

export interface WindowsVersion {
  major: number;
  minor: number;
  build: number;
  platformId: number; // VER_PLATFORM_WIN32_NT = 2
}

export const WINDOWS_2000: WindowsVersion = { major: 5, minor: 0, build: 2195, platformId: 2 };
export const WINDOWS_XP: WindowsVersion = { major: 5, minor: 1, build: 2600, platformId: 2 };

export interface ApiDef {
  handler: (emu: Emulator) => number | undefined;
  stackBytes: number;    // callee pops this many bytes (0 for cdecl/x64)
}

export class Win32Dll {
  constructor(private emu: Emulator, private dll: string) {}

  register(name: string, nArgs: number, handler: (emu: Emulator) => number | undefined): void {
    const key = `${this.dll}:${name}`;
    if (this.emu.apiDefs.has(key)) {
      throw new Error(`Win32Dll.register: duplicate API definition for ${key}`);
    }
    const wrapped = (emu: Emulator) => {
      return handler(emu);
    };
    this.emu.apiDefs.set(key, { handler: wrapped, stackBytes: nArgs * 4 });
  }
}

export class Win16Module {
  constructor(private emu: Emulator, private module: string) {}

  register(name: string, stackBytes: number, handler: (emu: Emulator) => number | undefined, ordinal?: number): void {
    const ordKey = ordinal !== undefined ? `${this.module}:ord_${ordinal}` : `${this.module}:${name}`;
    // If a binary DLL already registered a FAR JMP handler for this ordinal, keep it
    if (this.emu.apiDefs.has(ordKey)) return;
    const wrapped = (emu: Emulator) => {
      return handler(emu);
    };
    this.emu.apiDefs.set(ordKey, { handler: wrapped, stackBytes });
    if (ordinal !== undefined) {
      this.emu.ordinalNames.set(`${this.module}:${ordinal}`, name);
    }
  }
}

export class Emulator {
  memory = new Memory();
  cpu: CPU;
  handles = new HandleTable();
  canvas: HTMLCanvasElement | null = null;
  canvasCtx: CanvasRenderingContext2D | null = null;
  // Transparent overlay canvas over the DOM menu bar: receives window-relative
  // GetWindowDC drawing that lands in the main window's non-client band
  // (e.g. FreeCell paints "Cards Left" into its menu bar). Optional — without
  // it, NC-band drawing is clipped out instead of polluting the client.
  ncCanvas: HTMLCanvasElement | null = null;
  currentCursor = 0; // handle of current cursor
  glContext: GL1Context | null = null;

  windowsVersion: WindowsVersion = WINDOWS_2000;
  registryStore?: RegistryStore;
  profileStore?: ProfileStore;

  /** Internal clipboard text for WM_COPY/WM_PASTE between EDIT controls */
  _clipboardText: string | null = null;

  pe!: LoadedPE;
  peInfo!: PEInfo;
  arrayBuffer!: ArrayBuffer;

  // Console (CUI) mode
  isConsole = false;
  consoleBuffer: { char: number; attr: number }[] = [];
  consoleCursorX = 0;
  consoleCursorY = 0;
  consoleAttr = 0x07; // light gray on black
  consoleCursorSize = 25;
  consoleCursorVisible = true;
  consoleTitle = '';
  consoleMode = 0x0003; // ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT
  consoleInputMode = 0x0003;
  consoleInputBuffer: { char: number; vk: number; scan: number }[] = [];
  onConsoleOutput?: () => void;
  onConsoleTitleChange?: () => void;
  _pendingReadConsole: { bufPtr: number; nCharsToRead: number; charsReadPtr: number } | null = null;
  _pendingReadConsoleInput: { bufPtr: number; nLength: number; eventsReadPtr: number; isWide: boolean } | null = null;
  _dispatchPaintUsedBeginPaint = false;
  // Reentrancy guard: set while beginPaint is dispatching WM_ERASEBKGND so a
  // handler that paints can't recurse into another erase dispatch.
  _inEraseBkgnd = false;
  _pendingGetch = false;
  _consoleInputResume: { stackBytes: number; completer: (emu: Emulator, retVal: number, stackBytes: number) => void } | null = null;
  // Line editing state (emulates conhost line editing for ReadConsoleW with ENABLE_LINE_INPUT)
  _lineEditBuffer: number[] = [];
  _lineEditCursor = 0;
  _lineEditStartX = 0;
  _lineEditStartY = 0;
  _commandHistory: number[][] = [];
  _commandHistoryIndex = -1;

  // NE (16-bit) mode
  isNE = false;
  ne?: LoadedNE;
  _arrayBuffer?: ArrayBuffer;

  // ARM (WinCE) mode
  isARM = false;
  armCpu: ArmCPU | null = null;

  // DOS (MZ) mode
  isDOS = false;
  dosMouse = createDosMouseState();
  _mouseCallbackSavedSP = -1;
  dosKeyBuffer: { ascii: number; scan: number }[] = [];
  _dosWaitingForKey: false | 'read' | 'peek' = false;
  _dosExtKeyPending?: number; // scan code pending for second getch() call on extended keys
  _injectE0Pending = false;  // E0 prefix pending in injectHwKey fast path
  // EMS state
  _emsHandles?: Map<number, { pages: number; baseAddr: number }>;
  _emsNextHandle = 1;
  _emsNextAddr = 0x1200000; // 18MB start (above XMS max of ~17MB)
  _emsMapping?: number[];  // 4 physical page mappings
  _emsSavedMaps?: Map<number, number[]>;  // saved page map states (AH=47/48)
  _emsHandleNames?: Map<number, string>; // EMS 4.0 handle names (AH=53)
  _vcpiNextPage?: number;  // VCPI page allocator (page frame number)
  _vcpiPrivateArea?: number;   // VCPI host private area base address
  _vcpiSavedIVT?: Uint16Array; // V86 IVT segment values saved before first PM entry
  _vcpiPmGdtBase?: number; // Saved PM GDT/IDT for VCPI V86→PM restore
  _vcpiPmGdtLimit?: number;
  _vcpiPmIdtBase?: number;
  _vcpiPmIdtLimit?: number;
  _vcpiLastClientGdtBase?: number;  // Last non-empty client GDT seen on DE0C
  _vcpiLastClientGdtLimit?: number;
  _vcpiDebugRegs?: number[]; // VCPI DR0-3, DR6, DR7, reserved×2 (set/read via INT 67h DE08/DE09)
  _dosPendingSoftwareIret = 0;
  _dosKeyConsumedThisTick = false;
  _dosHwKeyReadThisTick = false;
  _dosDTA = 0;
  _dosDtaSeg?: number;
  /** Win16 local heap relocation tracking (set by kernel/memory.ts) */
  _localRelocations?: Map<number, number>;
  _dosDtaOfs?: number;
  _dosPSP = 0;
  _dosLoadSegment = 0;
  _cr0 = 0x12;        // CR0 — MP (bit 1) + ET (bit 4): Pentium post-BIOS state with FPU present
  _cr2 = 0;           // CR2 — last #PF faulting linear address (read by guest #PF handler)
  _cr3 = 0;           // Control Register 3 (page directory base) — stored for read-back, paging not actually performed
  _gdtBase = 0;       // GDT linear base address
  _gdtLimit = 0;      // GDT limit
  _idtBase = 0;       // IDT linear base address
  _idtLimit = 0;      // IDT limit
  _ldtr = 0;          // Local Descriptor Table Register (selector)
  _tr = 0;            // Task Register (selector)
  _dpmiState?: import('./dos/dpmi').DpmiState;  // DPMI host state (set on PM entry)
  _dosFiles = new Map<number, { data: Uint8Array; pos: number; name: string; isDevice?: boolean }>();
  _dosNextHandle = 5; // 0-4 are stdin/stdout/stderr/stdaux/stdprn
  _dosFreedHandles: number[] = []; // recycled handle pool
  _dosIntVectors = new Map<number, number>();
  _dosBiosDefaultVectors = new Map<number, number>();
  _dosLoLAddr = 0;
  _dosImageSize = 0;
  _dosMcbFirstSeg = 0;
  _dosFindState: { entries: { name: string; size: number; isDir: boolean }[]; index: number; pattern: string } | null = null;
  _dosFileOpenPending = false;
  _dosLastTimerTick = 0;
  /** When set, skip the wall-clock gate on PIT IRQ0 — used by cycle-only
   *  pacing mode where the dispatcher fires the timer purely off cpuSteps. */
  _pitCycleOnly = false;
  /** Ring buffer of recent EIPs, used for "wild EIP" post-mortems. */
  _eipHistory?: Uint32Array;
  _eipHistIdx = 0;
  _dosHalted = false;
  _dosVerifyFlag = false;
  _dosInDOSAddr = 0;
  /** Saved parent state for DOS EXEC (INT 21h AH=4Bh) — supports nesting */
  _dosExecStack: {
    regs: Int32Array; cs: number; ds: number; es: number; ss: number;
    eip: number; flags: number; psp: number; dta: number;
    currentDrive: string; currentDirs: Map<string, string>;
  }[] = [];
  /** Saved drive/dir state for custom PSP child processes (AH=55h + AH=4Ch/INT 20h) */
  _dosPspDriveState = new Map<number, { drive: string; dirs: Map<string, string> }>();
  /** Saved IVT + _dosIntVectors for custom PSP children — PMODEW modifies IVT hooks that
   *  must be restored when the child exits, since we bypass _pm_cleanup. */
  _dosPspSavedIVT = new Map<number, { ivt: Uint8Array; intVectors: Map<number, number> }>();
  _dosExitCode = 0;
  /** Segment of fake UCDOS TSR stub (0 = not set up) */
  _dosUcdosStubSeg = 0;
  /** I/O port data (for IN/OUT instructions) */
  _ioPorts = new Map<number, number>();
  /** Pending hardware interrupts to fire at next tick */
  _pendingHwInts: number[] = [];

  // PIC (Programmable Interrupt Controller) state
  _picMasterMask = 0x00;  // IMR: 0 = enabled, 1 = masked
  _picSlaveMask = 0x00;
  _picMasterICW = 0;      // ICW sequence counter (0 = ready for OCW)
  _picSlaveICW = 0;
  _picMasterBase = 0x08;  // IRQ0-7 interrupt vector base (ICW2, default=0x08)
  _picSlaveBase = 0x70;   // IRQ8-15 interrupt vector base (ICW2, default=0x70)
  _picMasterISR = 0x00;   // In-Service Register (bits set for IRQs being handled)
  _picSlaveISR = 0x00;
  _picMasterIRR = 0x00;   // Interrupt Request Register
  _picSlaveIRR = 0x00;
  _picMasterReadISR = false; // true = read ISR on port 0x20, false = read IRR
  _picSlaveReadISR = false;

  // PIT (Programmable Interval Timer) state
  _pitCounters = [0xFFFF, 0x0012, 0xFFFF]; // Counter 0/1/2 reload values
  _pitLatched = [false, false, false];
  _pitLatchValues = [0, 0, 0];
  _pitReadHigh = [false, false, false];     // Byte toggle for 16-bit reads
  _pitModes = [3, 2, 3];                   // Counter modes (default: mode 3 for 0/2, mode 2 for 1)
  _pitAccessModes = [3, 3, 3];             // 1=LSB, 2=MSB, 3=LSB then MSB
  _pitWriteHigh = [false, false, false];    // Byte toggle for 16-bit writes
  _pitStartTime = [0, 0, 0];               // performance.now() when each counter was last programmed
  _pitInsnCount = 0;                        // instruction counter for PIT timing in DOS mode
  _pitLastTotalTicks = [0, 0, 0];          // last total PIT ticks seen (ensures monotonic advance)

  // WASM JIT (DOS programs only)
  wasmJitEnabled = false; // set to true to enable WASM JIT for DOS programs

  // DOS feature flags (from DosSettings, applied at load time)
  dosEnableDpmi = true;
  /** Start DOS MZ programs in pseudo-V86 (PE=1, VM=1) so DOS/4GW and
   *  DOS/4GW Pro detect a V86-under-monitor environment and take their
   *  VCPI client path. Keeps realMode=true so segment addressing stays
   *  sel*16 — the CPU is "V86-flavored real mode" like EMM386. */
  dosEnableV86 = true;
  dosEnableXms = true;
  dosEnableEms = true;
  dosEnableSoundBlaster = true;
  dosEnableAdlib = true;
  dosEnableGus = true;
  dosSpeedFactor = 1; // 1 = full speed, 0.5 = half, 0.25 = quarter
  flatMemory: FlatMemory | null = null;  // created lazily for DOS programs
  wasmRegions = new Map<number, WasmCompiledRegion>();  // EIP-base → compiled region
  _wasmPending = new Set<number>();  // addresses with pending compilations
  _wasmHotness = new Map<number, number>();  // address → hit count
  _wasmBlacklist = new Set<number>();  // regions that consistently fail — never recompile
  _wasmFlatSynced = false;  // true after initial flat memory sync

  // VGA state
  vga = new VGAState();
  videoMode = 0x03;
  screenCols = 80;
  screenRows = 25;
  charHeight = 16;
  isGraphicsMode = false;
  onVideoFrame?: () => void;
  /** Fired when the framebuffer is reallocated (video mode resolution change). */
  onVideoModeChange?: () => void;

  /** Initialize VGA Mode X detection callback (call once after memory is ready) */
  initVgaModeXHook(): void {
    this.vga.onUnchainedChange = (unchained: boolean) => {
      if (unchained) {
        // Mode X: activate planar memory hook and clear planes
        this.cpu.mem.setVgaPlanar(this.vga);
        this.vga.clearPlanes();
      } else {
        // Back to Chain-4 linear mode 13h
        this.cpu.mem.setVgaPlanar(null);
      }
    };
    this.vga.onFramebufferResize = () => this.onVideoModeChange?.();
  }

  // API dispatch
  apiDefs = new Map<string, ApiDef>();
  ordinalNames = new Map<string, string>(); // "MODULE:ordinal" → human name
  thunkToApi = new Map<number, { dll: string; name: string; stackBytes: number; displayName?: string }>();
  // Fast page-level filter: set of (addr >>> 12) for all thunk addresses.
  // If the page isn't in this set, we skip the Map lookup entirely.
  thunkPages = new Set<number>();

  registerDll(dll: string): Win32Dll { return new Win32Dll(this, dll); }
  registerModule16(module: string): Win16Module { return new Win16Module(this, module); }

  // Screen dimensions (set by UI to browser viewport size)
  screenWidth = 800;
  screenHeight = 600;


  // Command line arguments (e.g. "/s" for screensavers)
  commandLine = '';

  // Additional DLL files available for LoadLibrary (name → ArrayBuffer)
  additionalFiles = new Map<string, ArrayBuffer>();
  /** Pluggable virtual file system (D:\, Z:\) */
  fs: FileManager = new DefaultFileManager();
  /** Per-process current drive (uppercase letter). Win32 + DOS both use this. */
  currentDrive = 'D';
  /** Per-process current directory per drive. Win32 + DOS both use this. */
  currentDirs = new Map<string, string>([['C', 'C:\\WINDOWS\\SYSTEM32'], ['D', 'D:\\']]);
  /** Resolve a path using per-process current drive/directory, then delegate to fs. */
  resolvePath(input: string): string {
    // Temporarily sync emu→fs so fs.resolvePath uses our per-process state
    const savedDrive = this.fs.currentDrive;
    const savedDirs = new Map(this.fs.currentDirs);
    this.fs.currentDrive = this.currentDrive;
    this.fs.currentDirs = this.currentDirs;
    try {
      return this.fs.resolvePath(input);
    } finally {
      this.fs.currentDrive = savedDrive;
      this.fs.currentDirs = savedDirs;
    }
  }
  /** Size of the loaded exe file (for dir listing) */
  exeFileSize = 0;
  /** Environment variable store (uppercase key → value), shared by kernel32 and msvcrt */
  envVars = new Map<string, string>([
    ['COMSPEC',                  'C:\\WINDOWS\\SYSTEM32\\CMD.EXE'],
    ['PATH',                     loadGeneralSettings().path],
    ['PATHEXT',                  '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'],
    ['SYSTEMROOT',               'C:\\WINDOWS'],
    ['SYSTEMDRIVE',              'C:'],
    ['WINDIR',                   'C:\\WINDOWS'],
    ['TEMP',                     'C:\\WINDOWS\\TEMP'],
    ['TMP',                      'C:\\WINDOWS\\TEMP'],
    ['HOMEDRIVE',                'C:'],
    ['HOMEPATH',                 '\\'],
    ['USERPROFILE',              'C:\\'],
    ['USERNAME',                 'User'],
    ['USERDOMAIN',               'WORKGROUP'],
    ['COMPUTERNAME',             'MYCOMPUTER'],
    ['OS',                       'Windows_NT'],
    ['NUMBER_OF_PROCESSORS',     '1'],
    ['PROCESSOR_ARCHITECTURE',   'x86'],
    ['PROCESSOR_IDENTIFIER',     'x86 Family 6 Model 8 Stepping 3, GenuineIntel'],
    ['PROCESSOR_LEVEL',          '6'],
    ['PROCESSOR_REVISION',       '0803'],
    ['PROGRAMFILES',             'C:\\Program Files'],
    ['COMMONPROGRAMFILES',       'C:\\Program Files\\Common Files'],
    ['PROMPT',                   '$P$G'],
  ]);
  // Loaded DLL modules: dllName → module info
  loadedModules = new Map<string, { base: number; resourceRva: number; imageBase: number; sizeOfImage?: number }>();
  // Stub-only system DLLs (no real PE) get unique pseudo-handles so GetProcAddress
  // by ordinal can disambiguate the target DLL. base ↔ dllName (UPPERCASE)
  stubDllByBase = new Map<number, string>();
  stubDllHandles = new Map<string, number>();
  nextStubDllHandle = 0x6FFE0000 >>> 0;
  // Built-in message dispatcher (set by registerMessage in user32). DefWindowProcA
  // delegates here for control-class messages like TB_*, EM_*, LB_*, CB_*, etc.,
  // which MFC calls via DefWindowProc instead of SendMessage when subclassing.
  dispatchBuiltinMessage: ((hwnd: number, message: number, wParam: number, lParam: number, wide?: boolean) => number | null) | null = null;
  // True when we're inside a context (e.g. DispatchMessageA) that knows how to
  // propagate `undefined` from emu.callWndProc to defer wndProc completion.
  // Init-time JS handlers like CreateWindowExA are NOT async-aware, so they
  // must run their callWndProc synchronously to completion (yields disabled).
  _allowWndProcYield = false;
  // Loaded DLL exports: dllName (lowercase) → { base, exports[] }
  // Shared between startup pre-loading (emu-load.ts) and runtime LoadLibrary (kernel32/module.ts)
  loadedDllExports = new Map<string, { base: number; exports: { ordinal: number; name: string | null; rva: number; forwardedTo: string | null }[] }>();
  // Dynamic thunk allocator (for GetProcAddress on loaded DLLs)
  dynamicThunkPtr = 0;

  // State
  running = false;
  halted = false;
  traceApi = false;
  traceDosInt = false; // gate heavy DOS/DPMI per-INT trace logs
  _crashFired = false;
  _wpEscapeLogged = false;
  haltReason = '';
  // Diagnostic: ring buffer of last N thunk calls for crash debugging
  _diagThunkRing: string[] = [];
  _diagThunkIdx = 0;
  _diagThunkSize = 64;
  diagThunk(name: string) {
    const sp = this.cpu.reg[4] >>> 0;
    let retAddr = 0;
    try { retAddr = this.memory.readU32(sp) >>> 0; } catch { /* ignore */ }
    this._diagThunkRing[this._diagThunkIdx % this._diagThunkSize] = `retEIP=${retAddr.toString(16)} SP=${(sp & 0xFFFF).toString(16)} ${name}`;
    this._diagThunkIdx++;
  }
  diagThunkDump(): string {
    const n = Math.min(this._diagThunkIdx, this._diagThunkSize);
    const start = this._diagThunkIdx - n;
    const lines: string[] = [];
    for (let i = start; i < this._diagThunkIdx; i++) {
      lines.push(`  [${i - start}] ${this._diagThunkRing[i % this._diagThunkSize]}`);
    }
    return lines.join('\n');
  }
  exitedNormally = false;
  exitCode = 0;
  stopped = false;
  _sysmsgTablesAddr = 0;
  _perfCounter = 0;

  // XMS (Extended Memory Specification) state
  _xmsHandles = new Map<number, { base: number; size: number; lockCount: number }>();
  _xmsNextHandle = 1;
  _xmsBaseAddr = 0x110000; // linear address for XMS pool (above HMA)
  _xmsNextAddr = 0x110000;
  _xmsTotalKB = 16384;     // 16MB total XMS
  _xmsFreeBlocks: { base: number; size: number }[] = [];
  /** Maps PSP segment → set of XMS handles allocated while that PSP was active */
  _xmsPspHandles = new Map<number, Set<number>>();

  // Threading
  threads: Thread[] = [];
  currentThread: Thread | null = null;
  nextThreadId = 1;
  // Compatibility getters/setters that delegate to currentThread
  private _fallbackWaitingForMessage = false;
  get waitingForMessage(): boolean {
    return this.currentThread ? this.currentThread.waitingForMessage : this._fallbackWaitingForMessage;
  }
  set waitingForMessage(v: boolean) {
    if (this.currentThread) this.currentThread.waitingForMessage = v;
    else this._fallbackWaitingForMessage = v;
  }

  get messageQueue(): WinMsg[] {
    return this.currentThread ? this.currentThread.messageQueue : this._fallbackMessageQueue;
  }
  set messageQueue(v: WinMsg[]) {
    if (this.currentThread) this.currentThread.messageQueue = v;
    else this._fallbackMessageQueue = v;
  }
  private _fallbackMessageQueue: WinMsg[] = [];

  private _fallbackOnMessageAvailable: (() => void) | null = null;
  get _onMessageAvailable(): (() => void) | null {
    return this.currentThread ? this.currentThread._onMessageAvailable : this._fallbackOnMessageAvailable;
  }
  set _onMessageAvailable(v: (() => void) | null) {
    if (this.currentThread) this.currentThread._onMessageAvailable = v;
    else this._fallbackOnMessageAvailable = v;
  }

  get wndProcDepth(): number {
    return this.currentThread ? this.currentThread.wndProcDepth : 0;
  }
  set wndProcDepth(v: number) {
    if (this.currentThread) this.currentThread.wndProcDepth = v;
  }

  get wndProcResult(): number {
    return this.currentThread ? this.currentThread.wndProcResult : 0;
  }
  set wndProcResult(v: number) {
    if (this.currentThread) this.currentThread.wndProcResult = v;
  }

  get _currentThunkStackBytes(): number {
    return this.currentThread ? this.currentThread._currentThunkStackBytes : 0;
  }
  set _currentThunkStackBytes(v: number) {
    if (this.currentThread) this.currentThread._currentThunkStackBytes = v;
  }

  get _wndProcSetupPending(): boolean {
    return this.currentThread ? this.currentThread._wndProcSetupPending : false;
  }
  set _wndProcSetupPending(v: boolean) {
    if (this.currentThread) this.currentThread._wndProcSetupPending = v;
  }

  get _wndProcFrames(): Array<{
    savedEBX: number; savedEBP: number; savedESI: number; savedEDI: number;
    savedDS?: number; savedSP?: number;
    outerStackBytes: number;
    outerCompleter: (emu: Emulator, retVal: number, stackBytes: number) => void;
  }> {
    return this.currentThread ? this.currentThread._wndProcFrames : [];
  }
  set _wndProcFrames(v: Array<{
    savedEBX: number; savedEBP: number; savedESI: number; savedEDI: number;
    savedDS?: number; savedSP?: number;
    outerStackBytes: number;
    outerCompleter: (emu: Emulator, retVal: number, stackBytes: number) => void;
  }>) {
    if (this.currentThread) this.currentThread._wndProcFrames = v;
  }

  // Window system
  mainWindow = 0;
  capturedWindow = 0;
  focusedWindow = 0;
  // Mouse cursor position in screen coordinates. Updated by mouse events on
  // the canvas and by SetCursorPos; read by GetCursorPos and GetMessagePos.
  cursorX = 0;
  cursorY = 0;
  findState?: { term: string; lastIndex: number };
  // Exposed from wndproc.ts for RegisterWindowMessage dedup
  registerWindowMessage?: (name: string) => number;
  // Active FINDREPLACEW struct pointer for FindTextW/ReplaceTextW
  findReplacePtr = 0;
  // GL sync-yield guard: avoid double-yield when apps call both glFinish and SwapBuffers per frame.
  glSyncYieldedThisFrame = false;
  glSyncAwaitingSwap = false;
  keyStates = new Set<number>(); // Currently pressed virtual key codes
  // Toggle-key state (GetKeyState bit 0): VK_CAPITAL / VK_NUMLOCK / VK_SCROLL.
  // NumLock starts on, matching a Windows desktop boot; synced to the host
  // keyboard state on each key event when the browser exposes it.
  keyToggles = new Set<number>([0x90 /* VK_NUMLOCK */]);
  configuredLcid = 0x0409; // Set from regional settings at load time
  windowDCs = new Map<number, number>();
  private timers = new Map<string, { jsTimer: number; elapse: number; timerFunc: number }>();
  /** Multimedia timers (timeSetEvent) — callback invoked during tick */
  _mmTimers = new Map<number, { callback: number; dwUser: number; delay: number; periodic: boolean; nextFire: number }>();

  // CBT hooks (WH_CBT = 5)
  cbtHooks: { lpfn: number; hMod: number }[] = [];

  // Window class registry
  windowClasses = new Map<string, WndClassInfo>();
  atomToClassName = new Map<number, string>();
  nextClassAtom = 0xC001;

  // GDI helpers set by registerGdi32
  getStockBrush!: (idx: number) => BrushInfo | null;
  getStockPen!: (idx: number) => PenInfo | null;

  // Dedup set for GetProcAddress "Not found" warnings
  _gpaNotFound?: Set<string>;

  // Heap allocator
  heapBase = 0;
  heapPtr = 0;
  heapAllocSizes = new Map<number, number>();

  // NE local heap (within data segment)
  localHeapBase = 0;  // linear address of local heap start
  localHeapPtr = 0;   // current allocation pointer
  localHeapEnd = 0;   // linear address of local heap end

  // Per-segment local heaps (selector → {ptr, end})
  segLocalHeaps = new Map<number, { ptr: number; end: number }>();

  // Per-segment static data end offsets (selector → end of initialized data)
  segStaticEnd = new Map<number, number>();

  // NE DLL resources (for LoadBitmap etc. to search across DLLs)
  neDllResources: Array<{ resources: NEResourceEntry[]; arrayBuffer: ArrayBuffer }> = [];

  // NE DLL data segment selectors (for correct DS when calling DLL wndProcs)
  neDllDataSegs = new Set<number>();

  // Virtual allocator
  virtualBase = 0;
  virtualPtr = 0;

  // WndProc call stack (wndProcResult, wndProcDepth, _currentThunkStackBytes,
  // _wndProcSetupPending, _wndProcFrames are now getter/setters delegating to currentThread)
  _tickCount = 0;
  _lastThunkTick = 0;
  /** Cumulative x86 instruction count (thunks weighted ~1000 each) */
  cpuSteps = 0;
  /** Cumulative CPU time in ms (derived from cpuSteps assuming ~500MHz effective clock) */
  get cpuTimeMs(): number { return this.cpuSteps * 0.000002 * 1000; }

  // SEH dispatch state
  _sehState: {
    excRecAddr: number;
    ctxAddr: number;
    currentReg: number;
    dispCtxAddr: number;
  } | null = null;

  drawItemStructAddr = 0;

  /** Pending resize lParam for the main window (set by applyCanvasToEmu, consumed by GetMessage).
   *  This avoids WM_SIZE queue flooding during rapid resize drags and guarantees
   *  WM_SIZE + WM_PAINT are delivered in the same tick. */
  _pendingResizeLParam: number | null = null;


  // Screen dirty flag — set by GDI draw ops that write to screen DC,
  // checked by tick() to yield to browser for rendering intermediate frames
  screenDirty = false;

  // Resource caches
  stringCache = new Map<number, string>();
  bitmapCache = new Map<number, number>();
  bitmapNameCache?: Map<string, number>;

  // Audio
  audioContext?: AudioContext;
  dosAudio = new DosAudio();

  /** Stop all playing audio and release audio resources. */
  destroyAudio(): void {
    // DOS audio: OPL2 worklet + PC speaker + SB DMA
    this.dosAudio.destroy();
    // Win32 waveOut: stop all active AudioBufferSourceNodes
    for (const [, device] of this.handles.findByType<{ nodes?: AudioBufferSourceNode[] }>('waveout')) {
      if (device.nodes) {
        for (const node of device.nodes) {
          try { node.stop(); } catch { /* already stopped */ }
          node.disconnect();
        }
        device.nodes.length = 0;
      }
    }
  }

  // Generic common dialog request — UI renders the appropriate dialog
  onShowCommonDialog?: (req: CommonDialogRequest) => void;

  // Callbacks for UI
  onMenu?: (menuId: number) => void;
  onWindowChange?: (wnd: WindowInfo) => void;
  onShowDialog?: (info: DialogInfo) => void;
  onCloseDialog?: () => void;
  onControlsChanged?: (controls: ControlOverlay[]) => void;
  onMenuChanged?: () => void;
  onSetMenu?: (hwnd: number, hMenu: number) => void;
  onCrash?: (eip: string, description: string) => void;
  onExit?: () => void;
  onReboot?: () => void;
  /** DLL modules requested by the executable but not found during loading */
  missingDlls: string[] = [];
  /** Callback when a DLL is discovered missing at runtime (LoadLibrary) */
  onMissingDll?: (dllName: string) => void;
  onCreateProcess?: (exeName: string, commandLine: string) => void;
  onCreateChildConsole?: (exeName: string, commandLine: string, hProcess: number) => void;
  /** Callback to open a Windows Help (.hlp) file in the built-in viewer */
  onOpenHelp?: (fileBytes: ArrayBuffer, fileName: string) => void;

  _childProcessWaiting = false;
  _childProcessResume: { stackBytes: number; retVal: number; completer: (emu: Emulator, stackBytes: number, retVal: number) => void } | null = null;
  /** Callback to show browser file picker (open/save). Returns file info or null if cancelled. */
  onFileDialog?: (type: 'open' | 'save', filter?: string, title?: string) => Promise<{ name: string; data: ArrayBuffer } | null>;
  menuItems?: MenuItem[];

  // Shared process registry (set by host to share across emulator instances)
  processRegistry?: ProcessRegistry;
  /** PID assigned to this emulator instance */
  pid = 0;
  /** EXE name for this instance (e.g. "taskmgr.exe") */
  exeName = '';
  /** Full path of the loaded EXE (e.g. "D:\\subdir\\some.exe"), set at load time */
  exePath = '';

  // Dialog state — stack supports nested dialogs
  dialogState: {
    hwnd: number;
    dlgProc: number;
    info: DialogInfo;
    result: number;
    ended: boolean;
  } | null = null;
  _dialogResolve: ((result: number) => void) | null = null;
  _dialogPumpTimer: ReturnType<typeof setInterval> | null = null;
  _dialogStack: Array<{
    dialogState: NonNullable<Emulator['dialogState']>;
    resolve: ((result: number) => void) | null;
    pumpTimer: ReturnType<typeof setInterval> | null;
  }> = [];

  // MessageBox state — supports multiple simultaneous message boxes
  messageBoxes: { id: number; caption: string; text: string; type: number; onDismiss: (result: number) => void }[] = [];
  _nextMessageBoxId = 1;
  onShowMessageBox?: (id: number, caption: string, text: string, type: number) => void;

  _endDialog(result: number): void {
    if (this._dialogPumpTimer !== null) { clearInterval(this._dialogPumpTimer); this._dialogPumpTimer = null; }
    const resolve = this._dialogResolve;
    this._dialogResolve = null;
    const wnd = this.dialogState ? this.handles.get(this.dialogState.hwnd) : null;
    if (wnd) this.handles.free(this.dialogState!.hwnd);
    // Pop outer dialog from stack (if any)
    const outer = this._dialogStack.pop();
    if (outer) {
      this.dialogState = outer.dialogState;
      this._dialogResolve = outer.resolve;
      this._dialogPumpTimer = outer.pumpTimer;
      // Re-show outer dialog in UI
      this.onShowDialog?.(outer.dialogState.info);
    } else {
      this.dialogState = null;
      this.onCloseDialog?.();
    }
    // Defer resolve so that if EndDialog is called from inside the dialog pump's
    // callWndProc (where ESP is in a nested frame), the pump can restore EIP/ESP
    // to the original DialogBoxParam stack frame before emuCompleteThunk runs.
    if (resolve) queueMicrotask(() => resolve(result));
  }

  dismissDialog(action: number, updatedValues: Map<number, string>): void {
    if (!this.dialogState) return;
    // Merge user-edited values into both controlValues and child window titles
    for (const [id, val] of updatedValues) {
      this.dialogState.info.controlValues.set(id, val);
      const dlgWnd = this.handles.get<WindowInfo>(this.dialogState.hwnd);
      if (dlgWnd?.children) {
        const childHwnd = dlgWnd.children.get(id);
        if (childHwnd) {
          const child = this.handles.get<WindowInfo>(childHwnd);
          if (child) child.title = val;
        }
      }
    }

    // Send WM_COMMAND to the dialog so the app can read values and call EndDialog.
    // This is what Windows does when the user clicks a button — the dialog proc
    // handles WM_COMMAND/IDOK, calls GetDlgItemInt/GetDlgItemText, then EndDialog.
    const ds = this.dialogState;
    if (!ds.ended) {
      const dlgWnd = this.handles.get<WindowInfo>(ds.hwnd);
      const wndProc = dlgWnd?.wndProc || ds.dlgProc;
      if (wndProc) {
        const WM_COMMAND = 0x0111;
        const savedEIP = this.cpu.eip;
        const savedESP = this.cpu.reg[4];
        const savedWaiting = this.waitingForMessage;
        this.waitingForMessage = false;
        const buttonHwnd = dlgWnd?.children?.get(action) ?? 0;
        if (this.ne) {
          // Win16: wParam = controlId, lParam = MAKELONG(hwndCtl, BN_CLICKED=0)
          this.callWndProc16(wndProc, ds.hwnd, WM_COMMAND, action, buttonHwnd & 0xFFFF);
        } else {
          // Win32: wParam = MAKEWPARAM(controlId, BN_CLICKED=0); lParam = button hwnd
          this.callWndProc(wndProc, ds.hwnd, WM_COMMAND, action, buttonHwnd);
        }
        this.cpu.eip = savedEIP;
        this.cpu.reg[4] = savedESP;
        this.waitingForMessage = savedWaiting;
      }
    }

    // If the app's dlgProc called EndDialog during WM_COMMAND, ds.ended is true
    // but _endDialog hasn't been called yet (EndDialog only sets the flag).
    // If the dlgProc didn't call EndDialog, force it ourselves.
    if (!ds.ended) {
      ds.result = action;
      ds.ended = true;
    }
    this._endDialog(ds.result);
  }

  /** Show a MessageBox — onDismiss is called synchronously when user dismisses it. */
  showMessageBox(caption: string, text: string, type: number, onDismiss: (result: number) => void): void {
    const id = this._nextMessageBoxId++;
    this.messageBoxes.push({ id, caption, text, type, onDismiss });
    this.onShowMessageBox?.(id, caption, text, type);
  }

  dismissMessageBox(id: number, result: number): void {
    const idx = this.messageBoxes.findIndex(mb => mb.id === id);
    if (idx < 0) return;
    const mb = this.messageBoxes[idx];
    this.messageBoxes.splice(idx, 1);
    mb.onDismiss(result);
  }

  constructor() {
    this.cpu = new CPU(this.memory);
    // Pre-allocate a default IDC_ARROW cursor so currentCursor is never 0
    this.currentCursor = this.handles.alloc('cursor', { css: 'default' });
  }

  initConsoleBuffer(): void {
    const size = this.screenCols * this.screenRows;
    this.consoleBuffer = new Array(size);
    for (let i = 0; i < size; i++) {
      this.consoleBuffer[i] = { char: 0x20, attr: 0x07 };
    }
    this.consoleCursorX = 0;
    this.consoleCursorY = 0;
  }

  consoleWriteChar(ch: number): void {
    if (ch === 0x0D) { // \r
      this.consoleCursorX = 0;
      return;
    }
    if (ch === 0x0A) { // \n
      this.consoleCursorX = 0;
      this.consoleCursorY++;
      if (this.consoleCursorY >= 25) this.consoleScrollUp();
      return;
    }
    if (ch === 0x08) { // backspace
      if (this.consoleCursorX > 0) this.consoleCursorX--;
      return;
    }
    if (ch === 0x07) return; // bell
    if (ch === 0x09) { // tab
      const next = (this.consoleCursorX + 8) & ~7;
      this.consoleCursorX = Math.min(next, 79);
      return;
    }
    const wide = isFullwidth(ch);
    // Fullwidth char needs 2 columns; if only 1 left, wrap to next line
    if (wide && this.consoleCursorX >= 79) {
      this.consoleCursorX = 0;
      this.consoleCursorY++;
      if (this.consoleCursorY >= 25) this.consoleScrollUp();
    }
    const idx = this.consoleCursorY * 80 + this.consoleCursorX;
    if (idx >= 0 && idx < this.consoleBuffer.length) {
      this.consoleBuffer[idx] = { char: ch, attr: this.consoleAttr };
    }
    this.consoleCursorX++;
    if (wide) {
      // Write trailing cell marker (char=0 signals "continuation of fullwidth char")
      const idx2 = this.consoleCursorY * 80 + this.consoleCursorX;
      if (idx2 >= 0 && idx2 < this.consoleBuffer.length) {
        this.consoleBuffer[idx2] = { char: 0, attr: this.consoleAttr };
      }
      this.consoleCursorX++;
    }
    if (this.consoleCursorX >= 80) {
      this.consoleCursorX = 0;
      this.consoleCursorY++;
      if (this.consoleCursorY >= 25) this.consoleScrollUp();
    }
  }

  consoleScrollUp(): void {
    for (let i = 0; i < 80 * 24; i++) {
      this.consoleBuffer[i] = this.consoleBuffer[i + 80];
    }
    for (let i = 80 * 24; i < 80 * 25; i++) {
      this.consoleBuffer[i] = { char: 0x20, attr: this.consoleAttr };
    }
    this.consoleCursorY = 24;
  }

  // Delegated to emu-load.ts
  async load(arrayBuffer: ArrayBuffer, peInfo: PEInfo, canvas: HTMLCanvasElement): Promise<void> {
    this._arrayBuffer = arrayBuffer;
    await emuLoad(this, arrayBuffer, peInfo, canvas);
  }

  findResourceEntry(typeId: number | string, nameId: number | string): { dataRva: number; dataSize: number } | null {
    return emuFindResourceEntry(this, typeId, nameId);
  }

  // NE local heap allocation (returns offset within data segment)
  allocLocal(size: number): number {
    if (size === 0) size = 1;
    const aligned = (size + 3) & ~3;

    // Check if current DS has a per-segment local heap
    const ds = this.cpu.ds;
    const segHeap = this.segLocalHeaps.get(ds);
    if (segHeap) {
      let addr = segHeap.ptr;
      if (addr + aligned > segHeap.end) {
        // Expand heap end within the 64KB segment space
        const segBase = this.cpu.segBases.get(ds) ?? 0;
        if ((addr + aligned - segBase) > 0x10000) return 0;
        segHeap.end = addr + aligned;
      }
      segHeap.ptr += aligned;
      for (let i = 0; i < aligned; i++) this.memory.writeU8(addr + i, 0);
      // Return offset within segment (not low 16 bits of linear address)
      const segBase = this.cpu.segBases.get(ds) ?? 0;
      return (addr - segBase) & 0xFFFF;
    }

    // Fall back to default DGROUP local heap
    const addr = this.localHeapPtr;
    if (addr + aligned > this.localHeapEnd) {
      // Auto-grow heap within the 64KB segment, like Windows 3.x
      // If SS == DS, heap must not collide with stack (grows down from top)
      const dsBase = this.ne ? (this.cpu.segBases.get(this.cpu.ds) ?? 0) : 0;
      let maxEnd = dsBase + 0x10000;
      if (this.ne) {
        const ssBase = this.cpu.segBases.get(this.cpu.ss) ?? 0;
        if (ssBase === dsBase && this.ne.stackSize > 0) {
          // Stack bottom = stackTop - stackSize; leave 256-byte guard
          const stackBottom = this.ne.stackTop - this.ne.stackSize;
          maxEnd = Math.min(maxEnd, stackBottom - 256);
        }
      }
      if (addr + aligned > maxEnd) return 0; // truly out of memory
      this.localHeapEnd = addr + aligned;
    }
    this.localHeapPtr += aligned;
    for (let i = 0; i < aligned; i++) this.memory.writeU8(addr + i, 0);
    return addr & 0xFFFF; // return offset within segment
  }

  // Public API for kernel32 heap
  allocHeap(size: number): number {
    if (size === 0) size = 1;
    const aligned = (size + 7) & ~7;
    const addr = this.heapPtr;
    this.heapPtr += aligned;
    for (let i = 0; i < aligned; i++) this.memory.writeU8(addr + i, 0);
    this.heapAllocSizes.set(addr, size);
    // NE mode: register selectors so x86 code can use linear addr as far pointer (DX:AX)
    if (this.isNE) {
      const startSel = addr >>> 16;
      const endSel = (addr + aligned - 1) >>> 16;
      for (let sel = startSel; sel <= endSel; sel++) {
        if (!this.cpu.segBases.has(sel)) {
          this.cpu.segBases.set(sel, sel * 0x10000);
        }
      }
    }
    return addr;
  }

  /** Allocate on a 64KB-aligned boundary so the full 64KB segment is usable for local heap */
  allocHeap64K(size: number): number {
    if (size === 0) size = 1;
    // Align heapPtr up to 64KB boundary
    const aligned64K = (this.heapPtr + 0xFFFF) & ~0xFFFF;
    this.heapPtr = aligned64K + Math.max(size, 0x10000);
    for (let i = 0; i < size; i++) this.memory.writeU8(aligned64K + i, 0);
    this.heapAllocSizes.set(aligned64K, size);
    return aligned64K;
  }

  reallocHeap(oldAddr: number, newSize: number): number {
    if (oldAddr === 0) return this.allocHeap(newSize);
    const oldSize = this.heapAllocSizes.get(oldAddr) || 0;
    const newAddr = this.allocHeap(newSize);
    if (oldSize > 0) {
      const copyLen = Math.min(oldSize, newSize);
      for (let i = 0; i < copyLen; i++) {
        this.memory.writeU8(newAddr + i, this.memory.readU8(oldAddr + i));
      }
    }
    return newAddr;
  }

  heapSize(addr: number): number {
    return this.heapAllocSizes.get(addr) || 0;
  }

  allocVirtual(requestedAddr: number, size: number): number {
    if (size === 0) size = 0x1000;
    const alignedSize = (size + 0xFFF) & ~0xFFF;
    let addr: number;
    if (requestedAddr !== 0) {
      addr = (requestedAddr + 0xFFF) & ~0xFFF;
    } else {
      addr = this.virtualPtr;
      this.virtualPtr = (this.virtualPtr + alignedSize + 0xFFF) & ~0xFFF;
    }
    for (let i = 0; i < alignedSize; i++) this.memory.writeU8(addr + i, 0);
    this.heapAllocSizes.set(addr, alignedSize);
    return addr >>> 0;
  }

  // Read stdcall argument from stack (x86) or registers/stack (ARM)
  readArg(index: number): number {
    if (this.isARM && this.armCpu) {
      // ARM calling convention: R0-R3 for first 4 args, then stack
      if (index < 4) return this.armCpu.reg[index] >>> 0;
      return this.memory.readU32((this.armCpu.reg[ARM_SP] + (index - 4) * 4) >>> 0);
    }
    return this.memory.readU32((this.cpu.reg[4] + 4 + index * 4) >>> 0);
  }

  // NE (16-bit) support methods
  readArg16(byteOffset: number): number {
    const base = this.cpu.segBase(this.cpu.ss);
    const sp = this.cpu.reg[4] & 0xFFFF;
    return this.memory.readU16((base + sp + 4 + byteOffset) >>> 0);
  }

  readArg16DWord(byteOffset: number): number {
    const base = this.cpu.segBase(this.cpu.ss);
    const sp = this.cpu.reg[4] & 0xFFFF;
    return this.memory.readU32((base + sp + 4 + byteOffset) >>> 0);
  }

  /** Resolve a raw far pointer (offset:segment packed as U32) to a linear address */
  resolveFarPtr(raw: number): number {
    const off = raw & 0xFFFF;
    const seg = (raw >>> 16) & 0xFFFF;
    if (!seg) return off;
    // Use cpu.segBase which handles LDT-style selectors (AHSHIFT)
    return this.cpu.segBase(seg) + off;
  }

  /** Read a far pointer arg from the 16-bit stack and resolve to linear address */
  readArg16FarPtr(byteOffset: number): number {
    return this.resolveFarPtr(this.readArg16DWord(byteOffset));
  }

  readPascalArgs16(sizes: number[]): number[] {
    const result: number[] = new Array(sizes.length);
    let offset = 0;
    for (let i = sizes.length - 1; i >= 0; i--) {
      if (sizes[i] === 4) {
        result[i] = this.readArg16DWord(offset);
      } else {
        result[i] = this.readArg16(offset);
      }
      offset += sizes[i];
    }
    return result;
  }

  loadNEString(uID: number): string {
    if (!this.ne) return '';
    const blockID = Math.floor(uID / 16) + 1;
    const indexInBlock = uID % 16;
    const entry = this.ne.resources.find(r => r.typeID === 6 && r.id === blockID);
    if (!entry) return '';
    const data = new Uint8Array(this.arrayBuffer, entry.fileOffset, entry.length);
    let off = 0;
    for (let i = 0; i < indexInBlock; i++) {
      if (off >= data.length) return '';
      off += 1 + data[off];
    }
    if (off >= data.length) return '';
    const len = data[off];
    let str = '';
    for (let j = 0; j < len && off + 1 + j < data.length; j++) {
      str += String.fromCharCode(data[off + 1 + j]);
    }
    return str;
  }

  postMessage(hwnd: number, message: number, wParam: number, lParam: number): void {
    // Route to the thread that owns the target window
    let targetThread = this.currentThread;
    if (hwnd && this.threads.length > 1) {
      const wnd = this.handles.get<WindowInfo>(hwnd);
      if (wnd?.ownerThreadId) {
        const ownerThread = this.threads.find(t => t.id === wnd.ownerThreadId);
        if (ownerThread) targetThread = ownerThread;
      }
    }

    const queue = targetThread ? targetThread.messageQueue : this.messageQueue;
    const onAvail = targetThread ? targetThread._onMessageAvailable : this._onMessageAvailable;

    if (message === 0x0113) { // WM_TIMER
      if (queue.some(m => m.message === 0x0113 && m.hwnd === hwnd && m.wParam === wParam)) {
        return;
      }
    }
    if (message === 0x0200) { // WM_MOUSEMOVE
      // Coalesce: Windows never queues multiple mouse moves — the queue holds
      // only the latest position. Without this, a fast pointermove stream
      // floods the queue faster than the emulated wndProc drains it, and
      // clicks queued behind hundreds of moves respond seconds late. Only the
      // TRAILING entry is replaced so ordering vs button events is preserved.
      const last = queue.length > 0 ? queue[queue.length - 1] : null;
      if (last && last.message === 0x0200 && last.hwnd === hwnd) {
        last.wParam = wParam;
        last.lParam = lParam;
        return;
      }
    }
    queue.push({ hwnd, message, wParam, lParam });
    if (onAvail) {
      if (targetThread) targetThread._onMessageAvailable = null;
      else this._onMessageAvailable = null;
      onAvail();
    }
  }

  // Timer management
  setWin32Timer(hwnd: number, id: number, jsTimer: number, elapse = 0, timerFunc = 0): void {
    this.timers.set(`${hwnd}:${id}`, { jsTimer, elapse, timerFunc });
  }

  getWin32Timer(hwnd: number, id: number): { jsTimer: number; elapse: number; timerFunc: number } | undefined {
    return this.timers.get(`${hwnd}:${id}`);
  }

  clearWin32Timer(hwnd: number, id: number): void {
    const key = `${hwnd}:${id}`;
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearInterval(timer.jsTimer);
      this.timers.delete(key);
    }
  }

  // Thread management
  switchToThread(target: Thread): void {
    if (this.currentThread && this.currentThread !== target) {
      this.currentThread.saveFromCPU(this.cpu);
    }
    target.loadToCPU(this.cpu);
    this.currentThread = target;
  }

  getNextRunnableThread(): Thread | null {
    if (this.threads.length === 0) return null;
    const currentIdx = this.currentThread ? this.threads.indexOf(this.currentThread) : -1;
    for (let i = 1; i <= this.threads.length; i++) {
      const idx = (currentIdx + i) % this.threads.length;
      const t = this.threads[idx];
      if (!t.exited && !t.suspended && !t.waitingForMessage) return t;
    }
    return null;
  }

  allThreadsWaiting(): boolean {
    return this.threads.every(t => t.exited || t.suspended || t.waitingForMessage);
  }

  createThread(startAddr: number, param: number, stackSize: number): Thread {
    const actualStackSize = stackSize || 0x100000; // default 1MB
    const stackBase = this.allocVirtual(0, actualStackSize);
    const stackTop = (stackBase + actualStackSize) >>> 0;

    // Create initial state from current CPU (inherits segments, mode, etc.)
    const state = Thread.createInitialState(this.cpu);
    state.eip = startAddr;
    state.reg = new Int32Array(8); // fresh registers
    state.reg[4] = stackTop; // ESP

    const thread = new Thread(this.nextThreadId++, state);
    thread.startAddress = startAddr;
    thread.parameter = param;
    thread.stackTop = stackTop;

    // Push parameter and a halt-sentinel return address onto the new thread's stack
    const THREAD_EXIT_THUNK = 0x00FD0004;
    // Ensure the thunk exists
    if (!this.thunkToApi.has(THREAD_EXIT_THUNK)) {
      this.thunkToApi.set(THREAD_EXIT_THUNK, { dll: 'SYSTEM', name: 'THREAD_EXIT', stackBytes: 0 });
      this.thunkPages.add(THREAD_EXIT_THUNK >>> 12);
      this.apiDefs.set('SYSTEM:THREAD_EXIT', {
        handler: () => {
          if (this.currentThread) {
            this.currentThread.exited = true;
            this.currentThread.exitCode = this.cpu.reg[0]; // EAX
          }
          // Switch to next runnable thread
          const next = this.getNextRunnableThread();
          if (next) {
            this.switchToThread(next);
          } else {
            // All threads done
            this.exitedNormally = true;
            this.halted = true;
          }
          return undefined;
        },
        stackBytes: 0,
      });
    }

    // Set up stack: push param, then return address (THREAD_EXIT_THUNK)
    state.reg[4] -= 4;
    this.memory.writeU32(state.reg[4] >>> 0, param);
    state.reg[4] -= 4;
    this.memory.writeU32(state.reg[4] >>> 0, THREAD_EXIT_THUNK);

    this.threads.push(thread);
    return thread;
  }

  // Delegated to extracted modules
  getDC(hdc: number): DCInfo | null { return _getDC(this, hdc); }
  promoteToMainWindow(hwnd: number, wnd: WindowInfo): void { _promoteToMainWindow(this, hwnd, wnd); }
  setupCanvasSize(cw: number, ch: number): void { _setupCanvasSize(this, cw, ch); }
  getWindowDC(hwnd: number, windowRelative = false): number { return _getWindowDC(this, hwnd, windowRelative); }
  beginPaint(hwnd: number): number { return _beginPaint(this, hwnd); }
  endPaint(hwnd: number, hdc: number): void { _endPaint(this, hwnd, hdc); }
  renderChildControls(hwnd: number): void { _renderChildControls(this, hwnd); }
  private _repaintingChildren = false;
  repaintChildWindows(hwnd: number): void {
    if (this._repaintingChildren) return;
    this._repaintingChildren = true;
    try {
    const wnd = this.handles.get<WindowInfo>(hwnd);
    if (!wnd?.childList) return;
    const WM_PAINT = 0x000F;
    for (const childHwnd of wnd.childList) {
      const child = this.handles.get<WindowInfo>(childHwnd);
      if (!child || !child.visible || !child.wndProc) continue;
      child.needsPaint = true;
      if (this.isNE) {
        this.callWndProc16(child.wndProc, childHwnd, WM_PAINT, 0, 0);
      } else {
        this.callWndProc(child.wndProc, childHwnd, WM_PAINT, 0, 0);
      }
      child.needsPaint = false;
    }
    } finally { this._repaintingChildren = false; }
  }
  /** Hit-test: find the deepest visible child window at (x,y) in the main window's client area.
   *  Returns { hwnd, x, y } with coordinates relative to the found window's client area. */
  windowFromPoint(px: number, py: number): { hwnd: number; x: number; y: number } {
    const main = this.mainWindow;
    if (!main) return { hwnd: 0, x: px, y: py };

    const findChild = (parentHwnd: number, cx: number, cy: number): { hwnd: number; x: number; y: number } => {
      const parent = this.handles.get<WindowInfo>(parentHwnd);
      if (!parent?.childList) return { hwnd: parentHwnd, x: cx, y: cy };
      // Walk children in reverse (last = topmost in z-order)
      for (let i = parent.childList.length - 1; i >= 0; i--) {
        const childHwnd = parent.childList[i];
        const child = this.handles.get<WindowInfo>(childHwnd);
        if (!child || !child.visible) continue;
        // CBS_DROPDOWN/CBS_DROPDOWNLIST combobox: when closed, only the edit
        // portion (~20px) is visible; the full height includes the dropdown list.
        let hitH = child.height;
        const CBS_DROPDOWN = 0x0002, CBS_DROPDOWNLIST = 0x0003;
        if (child.classInfo?.className?.toUpperCase() === 'COMBOBOX' &&
            (child.style & 0xF) >= CBS_DROPDOWN) {
          hitH = Math.min(hitH, 24); // edit portion height
        }
        if (cx >= child.x && cy >= child.y &&
            cx < child.x + child.width && cy < child.y + hitH) {
          return findChild(childHwnd, cx - child.x, cy - child.y);
        }
      }
      return { hwnd: parentHwnd, x: cx, y: cy };
    };

    return findChild(main, px, py);
  }
  notifyControlOverlays(): void { _notifyControlOverlays(this); }
  syncDCToCanvas(hdc: number): void { _syncDCToCanvas(this, hdc); }
  releaseChildDC(hdc: number): void { _releaseChildDC(this, hdc); }
  dispatchToSehHandler(frameAddr: number): void { _dispatchToSehHandler(this, frameAddr); }
  getBrush(handle: number): BrushInfo | null { return _getBrush(this, handle); }
  getPen(handle: number): PenInfo | null { return _getPen(this, handle); }
  loadBitmapResource(resourceId: number): number { return _loadBitmapResource(this, resourceId); }
  loadBitmapResourceFromModule(hInstance: number, resourceId: number): number { return _loadBitmapResourceFromModule(this, hInstance, resourceId); }
  loadBitmapResourceByName(name: string): number { return _loadBitmapResourceByName(this, name); }
  loadCursorResourceByName(name: string): number { return _loadCursorResourceByName(this, name); }
  loadStringResource(id: number): string | null { return _loadStringResource(this, id); }
  loadIconResource(resourceId: number): number { return _loadIconResource(this, resourceId); }

  // Delegated to emu-exec.ts
  callWndProc(wndProc: number, hwnd: number, message: number, wParam: number, lParam: number): number | undefined {
    if (this.isARM) return emuCallWndProcARM(this, wndProc, hwnd, message, wParam, lParam);
    return emuCallWndProc(this, wndProc, hwnd, message, wParam, lParam);
  }

  callWndProc16(wndProc: number, hwnd: number, message: number, wParam: number, lParam: number): number | undefined {
    return emuCallWndProc16(this, wndProc, hwnd, message, wParam, lParam);
  }

  callNative(addr: number): number | undefined {
    return emuCallNative(this, addr);
  }

  callCallback(addr: number, args: number[]): number | undefined {
    return emuCallCallback(this, addr, args);
  }

  /** Resolve a pending console input wait (ReadConsoleW, ReadConsoleInput, _getch, WaitForSingleObject stdin) */
  deliverConsoleInput(retVal: number): void {
    if (this._consoleInputResume) {
      const { stackBytes, completer } = this._consoleInputResume;
      this._consoleInputResume = null;
      this.waitingForMessage = false;
      completer(this, retVal, stackBytes);
      if (this.running && !this.halted) {
        requestAnimationFrame(this.tick);
      }
    }
  }

  /** Compute current PIT counter value based on wall-clock time.
   *  The real PIT decrements at exactly 1.193182 MHz from a hardware crystal,
   *  independent of CPU speed. Programs poll the counter in tight loops and
   *  detect cycle completion when count stops decreasing (wraps to reload).
   *  With limited performance.now() resolution (~5μs browser, ~1μs Node),
   *  consecutive reads may return the same value, causing premature wrap
   *  detection. Fix: busy-wait until at least 1 PIT tick elapses, ensuring
   *  the counter always shows real-time progress. Average rate matches the
   *  real 1.193MHz regardless of timer resolution. */
  _pitRunningCount(ch: number): number {
    const reload = this._pitCounters[ch] || 0x10000;
    const startTime = this._pitStartTime[ch];
    // Busy-wait until wall clock advances enough for at least 1 new PIT tick.
    // Typically resolves in < 1μs (Node) or < 5μs (browser). Safety cap at 2ms.
    let totalTicks: number;
    const deadline = startTime + (this._pitLastTotalTicks[ch] + reload) / 1193.182;
    for (;;) {
      const now = performance.now();
      totalTicks = Math.floor((now - startTime) * 1193.182);
      if (totalTicks > this._pitLastTotalTicks[ch]) break;
      if (now > deadline) { totalTicks = this._pitLastTotalTicks[ch] + 1; break; }
    }
    this._pitLastTotalTicks[ch] = totalTicks;
    const phase = totalTicks % reload;
    return ((reload - phase) & 0xFFFF) || reload;
  }

  /** Read an I/O port value */
  portIn(port: number): number {
    if (isVGAPort(port)) {
      const val = this.vga.portRead(port);
      // When VBlank is first detected on 0x3DA, sync immediately — VRAM still
      // holds the complete previous frame (game hasn't started its copy yet).
      if (port === 0x3DA && this.vga.pendingSync && this.isGraphicsMode) {
        this.vga.pendingSync = false;
        this.vga.lastSyncTime = performance.now();
        syncGraphics(this);
      }
      return val;
    }
    // Audio ports (AdLib, Sound Blaster)
    const audioVal = this.dosAudio.portIn(port);
    if (audioVal >= 0) return audioVal;
    switch (port) {
      case 0x20: // PIC master — ISR/IRR
        return this._picMasterReadISR ? this._picMasterISR : this._picMasterIRR;
      case 0x21: // PIC master IMR
        return this._picMasterMask;
      case 0xA0: // PIC slave — ISR/IRR
        return this._picSlaveReadISR ? this._picSlaveISR : this._picSlaveIRR;
      case 0xA1: // PIC slave IMR
        return this._picSlaveMask;
      case 0x40: case 0x41: case 0x42: { // PIT counter read
        const ch = port - 0x40;
        if (this._pitLatched[ch]) {
          // Return latched value
          const val = this._pitLatchValues[ch];
          const accessMode = this._pitAccessModes[ch];
          if (accessMode === 3) { // LSB then MSB
            if (!this._pitReadHigh[ch]) {
              this._pitReadHigh[ch] = true;
              return val & 0xFF;
            } else {
              this._pitReadHigh[ch] = false;
              this._pitLatched[ch] = false;
              return (val >> 8) & 0xFF;
            }
          } else if (accessMode === 1) { // LSB only
            this._pitLatched[ch] = false;
            return val & 0xFF;
          } else { // MSB only
            this._pitLatched[ch] = false;
            return (val >> 8) & 0xFF;
          }
        }
        // Not latched: return running counter estimate
        const count = this._pitRunningCount(ch);
        const accessMode = this._pitAccessModes[ch];
        if (accessMode === 1) return count & 0xFF;
        if (accessMode === 2) return (count >> 8) & 0xFF;
        if (!this._pitReadHigh[ch]) {
          this._pitReadHigh[ch] = true;
          return count & 0xFF;
        } else {
          this._pitReadHigh[ch] = false;
          return (count >> 8) & 0xFF;
        }
      }
      case 0x60: {
        const status = this._ioPorts.get(0x64) ?? 0;
        if ((status & 0x01) !== 0) {
          // Real 8042 behavior: first read consumes output buffer.
          const value = this._ioPorts.get(0x60) ?? 0xFF;
          this._ioPorts.set(0x64, status & ~0x01);
          // Compatibility replay for chained BIOS INT 09h handler.
          this._kbdReplayValue = value;
          this._kbdReplayPending = true;
          this._kbdDataReadsLeft = 1;
          if (this.isDOS) this._dosHwKeyReadThisTick = true;
          return value;
        }
        // Allow one extra read while IRQ1 handler is in-flight for chained
        // handlers that both read port 0x60 (hook + BIOS).
        if (this._kbdReplayPending && this._int09ReturnCS >= 0 && this._kbdDataReadsLeft > 0) {
          this._kbdDataReadsLeft--;
          if (this.isDOS) this._dosHwKeyReadThisTick = true;
          return this._kbdReplayValue;
        }
        return 0xFF;
      }
      case 0x61: { // System control port B
        const val = this._ioPorts.get(0x61) ?? 0;
        // Bit 4: toggles at ~66.287 kHz (every 15.085μs) — RAM refresh timer.
        // Programs read this in tight loops for microsecond-level delays
        // (e.g. PC speaker music note durations). Must use wall-clock time.
        const usec = performance.now() * 1000; // microseconds
        const refreshBit = (Math.floor(usec / 15.085) & 1) ? 0x10 : 0;
        // Bit 5: timer 2 output — reflects PIT channel 2 square wave
        return (val & ~0x30) | refreshBit;
      }
      case 0x64: // Keyboard controller status
        return this._ioPorts.get(0x64) ?? 0;
      case 0x71: { // CMOS data register — read selected register
        const reg = this._cmosAddr;
        // CMOS 0x17/0x18 (and compat 0x30/0x31): extended memory in KB above 1MB.
        // Cap at 0x3C00 (15 MB) — max addressable via these 16-bit registers in AT BIOS.
        const extKB = Math.min(this._xmsTotalKB, 0x3C00);
        if (reg === 0x17 || reg === 0x30) return extKB & 0xFF;
        if (reg === 0x18 || reg === 0x31) return (extKB >> 8) & 0xFF;
        // CMOS 0x15/0x16: base memory size in KB (typically 640 KB = 0x280)
        if (reg === 0x15) return 640 & 0xFF;
        if (reg === 0x16) return (640 >> 8) & 0xFF;
        return this._cmosRegs[reg] ?? 0;
      }
      case 0x92: // System Control Port A — bit 1 = A20 state
        return this.memory.a20Mask === 0xFFFFFFFF ? 0x02 : 0x00;
      default:
        return this._ioPorts.get(port) ?? 0xFF;
    }
  }

  /** Atomic 16-bit port write (OUT DX,AX / OUTSW / OUT imm8,AX).
   *  Some devices (e.g. the GUS register-data port 0x304) have word-specific
   *  semantics that differ from two consecutive byte writes — route those
   *  through their device handlers first, then fall back to the byte path. */
  portOutWord(port: number, value: number): void {
    if (this.dosAudio.portOutWord(port, value)) return;
    this.portOut(port, value & 0xFF);
    this.portOut((port + 1) & 0xFFFF, (value >>> 8) & 0xFF);
  }

  /** Atomic 16-bit port read (IN AX,DX / INSW / IN AX,imm8). Mirrors
   *  portOutWord's dispatch. */
  portInWord(port: number): number {
    const audioVal = this.dosAudio.portInWord(port);
    if (audioVal >= 0) return audioVal & 0xFFFF;
    const lo = this.portIn(port) & 0xFF;
    const hi = this.portIn((port + 1) & 0xFFFF) & 0xFF;
    return ((hi << 8) | lo) & 0xFFFF;
  }

  /** Write to an I/O port */
  portOut(port: number, value: number): void {
    if (isVGAPort(port)) {
      this.vga.portWrite(port, value);
      return;
    }
    // Audio ports (AdLib, Sound Blaster)
    if (this.dosAudio.portOut(port, value)) return;
    switch (port) {
      case 0x20: // PIC master command
        if (value === 0x20) { // Non-specific EOI: clear highest-priority ISR bit
          if (this._picMasterISR) {
            this._picMasterISR &= this._picMasterISR - 1; // clear lowest set bit
          }
          break;
        }
        if (value & 0x10) { // ICW1 starts init sequence
          this._picMasterICW = 1;
          this._picMasterISR = 0;
          this._picMasterIRR = 0;
          this._picMasterReadISR = false;
          break;
        }
        if ((value & 0x18) === 0x08) { // OCW3: bit 3 set, bit 4 clear
          if (value & 0x02) {
            this._picMasterReadISR = !!(value & 0x01); // bit 0: 1=ISR, 0=IRR
          }
        }
        break;
      case 0x21: // PIC master data (IMR or ICW2-4)
        if (this._picMasterICW > 0) {
          if (this._picMasterICW === 1) {
            this._picMasterBase = value & 0xF8; // ICW2: interrupt vector base (aligned to 8)
          }
          this._picMasterICW++; // Consume ICW2, ICW3, ICW4
          if (this._picMasterICW > 4) this._picMasterICW = 0;
        } else {
          this._picMasterMask = value;
        }
        break;
      case 0xA0: // PIC slave command
        if (value === 0x20) {
          if (this._picSlaveISR) {
            this._picSlaveISR &= this._picSlaveISR - 1;
          }
          break;
        }
        if (value & 0x10) {
          this._picSlaveICW = 1;
          this._picSlaveISR = 0;
          this._picSlaveIRR = 0;
          this._picSlaveReadISR = false;
          break;
        }
        if ((value & 0x18) === 0x08) {
          if (value & 0x02) {
            this._picSlaveReadISR = !!(value & 0x01);
          }
        }
        break;
      case 0xA1: // PIC slave data (IMR or ICW2-4)
        if (this._picSlaveICW > 0) {
          if (this._picSlaveICW === 1) {
            this._picSlaveBase = value & 0xF8; // ICW2: interrupt vector base (aligned to 8)
          }
          this._picSlaveICW++;
          if (this._picSlaveICW > 4) this._picSlaveICW = 0;
        } else {
          this._picSlaveMask = value;
        }
        break;
      case 0x40: case 0x41: case 0x42: { // PIT counter write
        const ch = port - 0x40;
        const accessMode = this._pitAccessModes[ch];
        let pitWriteComplete = false;
        if (accessMode === 1) { // LSB only
          this._pitCounters[ch] = (this._pitCounters[ch] & 0xFF00) | value;
          this._pitStartTime[ch] = performance.now();
          this._pitLastTotalTicks[ch] = 0;
          pitWriteComplete = true;
        } else if (accessMode === 2) { // MSB only
          this._pitCounters[ch] = (this._pitCounters[ch] & 0x00FF) | (value << 8);
          this._pitStartTime[ch] = performance.now();
          this._pitLastTotalTicks[ch] = 0;
          pitWriteComplete = true;
        } else { // LSB then MSB
          if (!this._pitWriteHigh[ch]) {
            this._pitCounters[ch] = (this._pitCounters[ch] & 0xFF00) | value;
            this._pitWriteHigh[ch] = true;
          } else {
            this._pitCounters[ch] = (this._pitCounters[ch] & 0x00FF) | (value << 8);
            this._pitWriteHigh[ch] = false;
            this._pitStartTime[ch] = performance.now(); // reset on MSB write (complete)
            this._pitLastTotalTicks[ch] = 0;
            pitWriteComplete = true;
          }
        }
        // When PIT channel 0 is fully reprogrammed, resync the timer delivery baseline.
        // Without this, the copper system's scanline-based PIT reprogramming causes
        // INT 08h to fire at wrong times (palette glitches, timing drift).
        if (pitWriteComplete && ch === 0 && this.isDOS) {
          this._dosLastTimerTick = performance.now();
        }
        // Update PC speaker when PIT channel 2 changes
        if (ch === 2 && this.isDOS) {
          this.dosAudio.updateSpeaker(this._ioPorts.get(0x61) ?? 0, this._pitCounters[2] || 0x10000);
        }
        break;
      }
      case 0x43: { // PIT control word
        const ch = (value >> 6) & 3;
        if (ch === 3) {
          // Read-back command (just latch all requested counters)
          for (let i = 0; i < 3; i++) {
            if (!(value & (2 << i))) continue; // Counter not selected
            if (!(value & 0x20)) { // Latch count
              this._pitLatched[i] = true;
              this._pitLatchValues[i] = this._pitRunningCount(i);
            }
          }
          break;
        }
        const accessMode = (value >> 4) & 3;
        if (accessMode === 0) {
          // Latch command
          this._pitLatched[ch] = true;
          this._pitLatchValues[ch] = this._pitRunningCount(ch);
        } else {
          this._pitAccessModes[ch] = accessMode;
          this._pitModes[ch] = (value >> 1) & 7;
          this._pitWriteHigh[ch] = false;
          this._pitReadHigh[ch] = false;
          this._pitLatched[ch] = false;
        }
        break;
      }
      case 0x60: // Keyboard controller data port
        // Check if 8042 is expecting data for a "write output port" command (0xD1)
        if (this._kbdCmd === 0xD1) {
          // Bit 1 of the 8042 output port controls A20
          this.memory.a20Mask = (value & 0x02) ? 0xFFFFFFFF : 0xFFFFF;
          this._kbdCmd = 0;
          break;
        }
        this._ioPorts.set(port, value);
        break;
      case 0x64: // Keyboard controller command port (write = command, read = status)
        // Do NOT store the command in _ioPorts — port 0x64 read returns STATUS, not command
        if (value === 0xD1) {
          // "Write Output Port" — next byte to port 0x60 sets A20
          this._kbdCmd = 0xD1;
        } else if (value === 0xDF) {
          // Enable A20 (shortcut used by some programs)
          this.memory.a20Mask = 0xFFFFFFFF;
        } else if (value === 0xDD) {
          // Disable A20 (shortcut)
          this.memory.a20Mask = 0xFFFFF;
        }
        break;
      case 0x70: // CMOS address register
        this._cmosAddr = value & 0x7F; // Bit 7 = NMI mask (ignore)
        break;
      case 0x71: // CMOS data register — write selected register
        this._cmosRegs[this._cmosAddr] = value;
        break;
      case 0x92: // System Control Port A (Fast A20 gate)
        if (value & 0x02) this.memory.a20Mask = 0xFFFFFFFF;
        else this.memory.a20Mask = 0xFFFFF;
        this._ioPorts.set(port, value & ~0x01); // Bit 0 is "fast reset" — ignore it
        break;
      default:
        this._ioPorts.set(port, value);
        // Update PC speaker when port 0x61 changes
        if (port === 0x61 && this.isDOS) {
          this.dosAudio.updateSpeaker(value, this._pitCounters[2] || 0x10000);
        }
        break;
    }
  }

  // Extended scancodes that need 0xE0 prefix (arrows, Home/End/PgUp/PgDn, Ins/Del)
  static readonly E0_SCANCODES = new Set([
    0x47, 0x48, 0x49, // Home, Up, PgUp
    0x4B, 0x4D,       // Left, Right
    0x4F, 0x50, 0x51, // End, Down, PgDn
    0x52, 0x53,       // Ins, Del
  ]);

  /** Inject a hardware keyboard event: write scancode to port 0x60 and trigger INT 09h */
  injectHwKey(scancode: number, browserChar?: number): void {
    if ((this as Emulator & { traceKey?: boolean }).traceKey) {
      console.log(`[KEY] inject 0x${scancode.toString(16)} char=${browserChar} wait=${this._dosWaitingForKey} waitMsg=${this.waitingForMessage} halt=${this._dosHalted} e0p=${this._injectE0Pending} pend=[${this._pendingHwKeys.map(x=>x.toString(16)).join(',')}] buf=${this.dosKeyBuffer.length}`);
    }
    // Queue scancodes for sequential delivery — writing directly to port 0x60
    // would lose earlier scancodes when multiple keys are injected in the same JS event.
    // On break code: flush queued repeat make codes so repeat stops immediately.
    if ((scancode & 0x80) && scancode !== 0xE0) {
      const makeCode = scancode & 0x7F;
      let kept = false;
      const filtered: number[] = [];
      for (let i = 0; i < this._pendingHwKeys.length; i++) {
        const k = this._pendingHwKeys[i];
        if (k === makeCode) {
          if (!kept) {
            kept = true;
            filtered.push(k);
          } else {
            if (filtered.length > 0 && filtered[filtered.length - 1] === 0xE0) filtered.pop();
          }
          continue;
        }
        filtered.push(k);
      }
      this._pendingHwKeys = filtered;
    }
    const MAX_HW_KEY_QUEUE = 8;
    if (this._pendingHwKeys.length >= MAX_HW_KEY_QUEUE) return;
    this._pendingHwKeys.push(scancode);
    if (browserChar !== undefined) this._pendingHwKeyChars.set(scancode, browserChar);
    // Fast path: DOS program blocked at INT 21h AH=01/07/08 — deliver straight
    // to dosKeyBuffer so deliverDosKey can set AL on the next tick. Bypasses
    // the INT 09h → BDA pipeline, which would require the CPU to run (it's
    // halted) for the scancode to become readable.
    // 0xE0 has bit 7 set but is NOT a break code — it's the extended-key
    // prefix. Treat it as a make code for the purposes of this fast path.
    const isBreakCode = (scancode & 0x80) !== 0 && scancode !== 0xE0;
    // Clear the stale E0-pending flag when a break code arrives — it usually
    // means we just saw an E0-prefixed keyup (e.g. arrow release), and the
    // pair has no make code to deliver. Leaving it set would make the next
    // non-extended keypress look extended.
    if (isBreakCode) this._injectE0Pending = false;
    if (this._dosWaitingForKey && !isBreakCode) {
      if (scancode === 0xE0) {
        // E0 prefix: record for the following make code, leave the program
        // blocked. Waking the CPU now would let it run past the INT 21h stub
        // with AL unset — the make code hasn't arrived yet.
        this._injectE0Pending = true;
        const e0Idx = this._pendingHwKeys.lastIndexOf(0xE0);
        if (e0Idx >= 0) this._pendingHwKeys.splice(e0Idx, 1);
        return;
      }
      const SCAN_TO_ASCII: (number|undefined)[] = [
        undefined,0x1B,0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x38,0x39,0x30,0x2D,0x3D,0x08,0x09,
        0x71,0x77,0x65,0x72,0x74,0x79,0x75,0x69,0x6F,0x70,0x5B,0x5D,0x0D,undefined,0x61,0x73,
        0x64,0x66,0x67,0x68,0x6A,0x6B,0x6C,0x3B,0x27,0x60,undefined,0x5C,0x7A,0x78,0x63,0x76,
        0x62,0x6E,0x6D,0x2C,0x2E,0x2F,undefined,0x2A,undefined,0x20,
      ];
      const isExtended = this._injectE0Pending || scancode >= 0x3B;
      const ascii = isExtended ? 0 : (browserChar ?? SCAN_TO_ASCII[scancode] ?? 0);
      if (this.dosKeyBuffer.length < 16) {
        this.dosKeyBuffer.push({ ascii, scan: scancode });
      }
      // Remove this scancode (and E0 prefix if present) from _pendingHwKeys
      // so that INT 09h does not fire and write a duplicate to BDA.
      if (this._injectE0Pending) {
        const e0Idx = this._pendingHwKeys.lastIndexOf(0xE0);
        if (e0Idx >= 0) this._pendingHwKeys.splice(e0Idx, 1);
      }
      const scIdx = this._pendingHwKeys.lastIndexOf(scancode);
      if (scIdx >= 0) this._pendingHwKeys.splice(scIdx, 1);
      this._pendingHwKeyChars.delete(scancode);
      this._injectE0Pending = false;
    }

    // Wake promptly on keyboard input from INT 16h waits or DOS HLT idle.
    if ((this.waitingForMessage || this._dosHalted) && this.running && !this.halted) {
      this.waitingForMessage = false;
      this._dosHalted = false;
      requestAnimationFrame(this.tick);
    }
  }
  _pendingHwKeys: number[] = [];
  _pendingHwKeyChars = new Map<number, number>();
  _currentHwKeyChar: number | undefined;
  _kbdE0Prefix = false;
  _hwKeyDelay = 0;
  _lastHwKeyDeliverTime = 0; // performance.now() of last non-E0 scancode delivery
  _tickRunning = false; // reentrancy guard for tick()
  _hwIntSavedSP = -1; // SP level saved before HW interrupt dispatch; -1 = no active handler
  _hwIntSavedSS = -1; // SS selector saved alongside SP — PM ISRs switch stacks mid-handler
  _dosLastTimerTickSteps = 0; // cpuSteps at last PIT IRQ0 dispatch, for cycle-gated timing
  _hwIntPMActive = false; // true while a PM IDT-dispatched handler is running
  /** Saved PM state when HW INT handler runs in RM (restored after IRET) */
  _hwIntPMState: { cr0: number; cs: number; ss: number; ds: number; es: number; use32: boolean; segBases: Map<number, number> } | undefined;
  _kbdDataReadsLeft = 0;
  _kbdReplayPending = false;
  _kbdReplayValue = 0xFF;
  _kbdCmd = 0; // pending 8042 command (0xD1 = write output port for A20 control)
  _cmosAddr = 0;                  // CMOS selected register (written via port 0x70)
  _cmosRegs: number[] = new Array(128).fill(0); // CMOS RAM (128 registers)
  _int09ReturnCS = -1; // CS of return address for active INT 09h; -1 = not active
  _int09ReturnIP = 0;

  // --- Typematic repeat (DOS subsystem implements its own key repeat) ---
  _typematicScan = -1;        // scancode of currently held key, -1 = none
  _typematicChar: number | undefined; // browser char for the held key
  _typematicExtended = false;  // whether the held key needs E0 prefix
  _typematicTimer: ReturnType<typeof setTimeout> | null = null;

  /** Start typematic repeat for a key press (non-modifier only) */
  startTypematic(scan: number, browserChar: number | undefined, isExtended: boolean): void {
    this.stopTypematic();
    this._typematicScan = scan;
    this._typematicChar = browserChar;
    this._typematicExtended = isExtended;
    // Initial delay before repeat starts (500ms, matching typical BIOS default)
    this._typematicTimer = setTimeout(() => {
      // Repeat at ~30 Hz (33ms interval)
      this._typematicTimer = setInterval(() => {
        if (this._typematicScan < 0) return;
        if (this._typematicExtended) this.injectHwKey(0xE0);
        this.injectHwKey(this._typematicScan, this._typematicChar);
      }, 33);
    }, 500);
  }

  /** Stop typematic repeat (called on keyup or when a different key is pressed) */
  stopTypematic(scan?: number): void {
    // If scan is specified, only stop if it matches the currently repeating key
    if (scan !== undefined && this._typematicScan !== scan) return;
    if (this._typematicTimer !== null) {
      clearTimeout(this._typematicTimer);
      clearInterval(this._typematicTimer);
      this._typematicTimer = null;
    }
    this._typematicScan = -1;
  }

  /** Deliver a DOS key for INT 16h blocking wait */
  /** Write a key into the BDA keyboard buffer (for programs that read it directly) */
  writeBdaKey(ascii: number, scan: number): void {
    const BDA = 0x400;
    const bufStart = this.memory.readU16(BDA + 0x80) || 0x1E;
    const bufEnd = this.memory.readU16(BDA + 0x82) || 0x3E;
    const tail = this.memory.readU16(BDA + 0x1C);
    let newTail = tail + 2;
    if (newTail >= bufEnd) newTail = bufStart;
    const head = this.memory.readU16(BDA + 0x1A);
    if (newTail === head) return; // buffer full
    this.memory.writeU16(BDA + tail, (scan << 8) | ascii);
    this.memory.writeU16(BDA + 0x1C, newTail);
  }

  deliverDosKey(): void {
    // Handle pending extended key scan code (second getch() call)
    if (this._dosWaitingForKey && this._dosExtKeyPending !== undefined) {
      this._dosWaitingForKey = false;
      this.cpu.setReg8(0, this._dosExtKeyPending);
      this._dosExtKeyPending = undefined;
      this.waitingForMessage = false;
      if (this.running && !this.halted) {
        requestAnimationFrame(this.tick);
      }
      return;
    }
    if (this._dosWaitingForKey && this.dosKeyBuffer.length > 0) {
      const mode = this._dosWaitingForKey;
      this._dosWaitingForKey = false;
      if (mode === 'peek') {
        // AH=01/11: peek — don't consume, set ZF=false, put key in AX
        const key = this.dosKeyBuffer[0];
        this.cpu.setReg16(0, (key.scan << 8) | key.ascii);
        this.cpu.setFlags(this.cpu.getFlags() & ~0x40); // clear ZF
      } else {
        // AH=00/10: read — consume key, put in AX
        const key = this.dosKeyBuffer.shift()!;
        // For INT 21h AH=07/08 path: only set AL (not full AX)
        // and handle extended keys (ascii=0) by queueing scan for next call
        if (this._dosWaitingForKey === false) {
          // Already cleared above — this is the INT 21h path
        }
        let ascii = key.ascii === 0xE0 ? 0 : key.ascii;
        this.cpu.setReg8(0, ascii); // Set AL only
        if (ascii === 0) {
          // Extended key: save scan code for the next INT 21h AH=07/08 call
          this._dosExtKeyPending = key.scan;
        }
      }
      this.waitingForMessage = false;
      while (this._dosPendingSoftwareIret > 0) {
        const ip = this.cpu.pop16();
        const cs = this.cpu.pop16();
        const savedFlags = this.cpu.pop16();
        const curFlags = this.cpu.getFlags() & 0xFFFF;
        const flags = (curFlags & ~0x0300) | (savedFlags & 0x0300);
        this.cpu.cs = cs;
        this.cpu.eip = this.cpu.segBase(cs) + ip;
        this.cpu.setFlags((this.cpu.getFlags() & 0xFFFF0000) | (flags & 0xFFFF));
        this._dosPendingSoftwareIret--;
      }
      if (this.running && !this.halted) {
        requestAnimationFrame(this.tick);
      }
    }
  }

  run(): void {
    console.log('[EMU] run() called');
    this.running = true;
    this.halted = false;
    this._crashFired = false;
    this.haltReason = '';
    this.tick();
  }

  stop(): void {
    this.running = false;
    this.halted = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  tick = (): void => {
    if (this.isARM) {
      emuTickARM(this);
    } else {
      emuTick(this);
    }
  };
}
