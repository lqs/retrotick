import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'preact/hooks';
import type { PEInfo, MenuResult } from '../lib/pe/types';
import { parsePE, parseCOM, extractMenus, extractIcons } from '../lib/pe';
import { Emulator } from '../lib/emu/emulator';
import type { DialogInfo, ControlOverlay, ProcessRegistry, CommonDialogRequest } from '../lib/emu/emulator';
import type { WindowInfo } from '../lib/emu/win32/user32/index';
import { WM_LBUTTONDOWN, WM_LBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_MOUSEMOVE, WM_LBUTTONDBLCLK, WM_RBUTTONDBLCLK, WM_COMMAND, WM_SYSCOMMAND, WM_SIZE, WM_GETMINMAXINFO, WM_KEYDOWN, WM_KEYUP, WM_CHAR, WM_INITMENU, WM_INITMENUPOPUP, WM_MOUSEACTIVATE, MK_LBUTTON, MK_RBUTTON, HTCLIENT, SC_MINIMIZE, SC_MAXIMIZE, SC_RESTORE, SC_CLOSE } from '../lib/emu/win32/types';
import { MessageBox, MsgBoxIcon, MB_ICONERROR } from './win2k/MessageBox';
import { MenuBar } from './win2k/MenuBar';
import { Window, WS_DLGFRAME, WS_CAPTION, WS_SYSMENU, WS_THICKFRAME, WS_MINIMIZEBOX, WS_MAXIMIZEBOX, getBorderWidth } from './win2k/Window';
import { getClientSize, getNonClientMetrics } from '../lib/emu/win32/user32/_helpers';
import { AboutDialog } from './win2k/AboutDialog';
import { ConsoleView } from './ConsoleView';
import { renderControlOverlay, effectiveClass } from './ControlOverlay';
import { EmulatorDialog } from './EmulatorDialog';
import { EXE_ICON_16 } from './DesktopIcon';
import { FindDialog, FindReplaceDialog } from './FindDialog';
import { FileDialog } from './win2k/FileDialog';
import { listFileMetadata, getFile, addFile, deleteFile, dispatchDesktopFilesChanged, type DesktopFilesChangedDetail } from '../lib/file-store';
import { RegistryStore } from '../lib/registry-store';
import { loadRegistry, saveRegistry } from '../lib/registry-db';
import { ProfileStore } from '../lib/profile-store';
import { loadProfiles, saveProfiles } from '../lib/profile-db';
import { detectPELanguageId, langToHtmlLang } from '../lib/lang';
import { loadSettings, getKeyboardLayout, t } from '../lib/regional-settings';
import { loadDosSettings } from '../lib/dos-settings';

interface EmulatorViewProps {
  arrayBuffer: ArrayBuffer;
  peInfo: PEInfo;
  additionalFiles?: Map<string, ArrayBuffer>;
  exeName: string;
  commandLine?: string;
  onStop: () => void;
  onFocus?: () => void;
  onReady?: () => void;
  onRunExe?: (arrayBuffer: ArrayBuffer, peInfo: PEInfo, additionalFiles?: Map<string, ArrayBuffer>, exeName?: string, commandLine?: string, onSetupEmulator?: (emu: Emulator) => void) => void;
  onOpenHelp?: (arrayBuffer: ArrayBuffer, fileName: string) => void;
  onSetupEmulator?: (emu: Emulator) => void;
  audioContext?: AudioContext | null;
  onTitleChange?: (title: string) => void;
  onIconChange?: (iconUrl: string | null) => void;
  onMinimize?: () => void;
  onRegisterCloseHandler?: (handler: () => void) => void;
  processRegistry?: ProcessRegistry;
  zIndex?: number;
  focused?: boolean;
  minimized?: boolean;
}

function buildMKFlags(e: PointerEvent): number {
  let flags = 0;
  if (e.buttons & 1) flags |= MK_LBUTTON;
  if (e.buttons & 2) flags |= MK_RBUTTON;
  return flags;
}

function makeLParam(x: number, y: number): number {
  return ((y & 0xFFFF) << 16) | (x & 0xFFFF);
}

// Map DOM key codes to Windows virtual key codes (dynamic, based on regional settings)
function getKeyToVK(): Record<string, number> {
  const settings = loadSettings();
  return getKeyboardLayout(settings.keyboardLayout).codeToVK;
}



// --- Win2K Dialog ---

function Dialog({ info, emuRef, onDismiss, focused = true, flashTrigger, parentRef, lang }: {
  info: DialogInfo;
  emuRef: { current: Emulator | null };
  onDismiss: (action: number, values: Map<number, string>) => void;
  focused?: boolean;
  flashTrigger?: number;
  parentRef?: { current: HTMLDivElement | null };
  lang?: string;
}) {
  const [pressedControl, setPressedControl] = useState<number | null>(null);
  const [overlays, setOverlays] = useState<ControlOverlay[]>(info.overlays);
  const [initialPos, setInitialPos] = useState<{ x: number; y: number } | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  const measureRef = useRef<HTMLDivElement>(null);

  const handleCancel = () => onDismiss(2, info.controlValues);

  // Redirect mainWindow to dialog hwnd so renderControlOverlay sends WM_COMMAND to the dialog.
  // Also intercept onControlsChanged so notifyControlOverlays updates the dialog's own overlays
  // instead of contaminating the parent window's controlOverlays state.
  const dialogEmuRef = useRef<{ current: Emulator | null }>({ current: null });
  const emu = emuRef?.current ?? null;
  if (emu) {
    dialogEmuRef.current.current = new Proxy(emu, {
      get(target, prop) {
        if (prop === 'mainWindow') return info.hwnd;
        if (prop === 'onControlsChanged') return (controls: ControlOverlay[]) => setOverlays(controls);
        return target[prop as keyof Emulator];
      },
    });
  } else {
    dialogEmuRef.current.current = null;
  }

  useLayoutEffect(() => {
    if (!measureRef.current) return;
    const dlgRect = measureRef.current.getBoundingClientRect();
    const parentRect = parentRef?.current?.getBoundingClientRect();
    const cx = parentRect ? parentRect.left + parentRect.width / 2 : window.innerWidth / 2;
    const cy = parentRect ? parentRect.top + parentRect.height / 2 : window.innerHeight / 2;
    setInitialPos({ x: cx - dlgRect.width / 2, y: cy - dlgRect.height / 2 });
  }, []);

  // Show only after Window has applied the position (one render cycle after initialPos is set)
  useEffect(() => {
    if (initialPos) setVisible(true);
  }, [initialPos]);



  return (
    <div ref={measureRef} onClick={(e) => e.stopPropagation()} style={{ visibility: visible ? 'visible' : 'hidden', position: 'absolute', font: '12px/1 "Tahoma",sans-serif' }}>
      <Window
        title={info.title}
        style={info.style | WS_DLGFRAME}
        clientW={info.width}
        clientH={info.height}
        focused={focused}
        draggable
        initialPos={initialPos}
        flashTrigger={flashTrigger}
        lang={lang}
        onClose={handleCancel}
      >
          <div style={{ width: '100%', height: '100%', background: '#D4D0C8' }}>
            {overlays.map((ctrl) => {
              const rendered = renderControlOverlay(ctrl, dialogEmuRef.current, setPressedControl, pressedControl);
              // Wrap OK (id=1) and Cancel (id=2) buttons to also dismiss the dialog
              if (effectiveClass(ctrl) === 'BUTTON' && (ctrl.controlId === 1 || ctrl.controlId === 2)) {
                const action = ctrl.controlId;
                return <div key={ctrl.childHwnd} onClick={() => onDismiss(action, info.controlValues)}>{rendered}</div>;
              }
              return rendered;
            })}
          </div>
        </Window>
    </div>
  );
}

// --- MDI Child Window Rendering ---

function renderMdiChildOverlay(
  ctrl: ControlOverlay,
  emuRef: { current: Emulator | null },
  setPressedControl: (id: number | null) => void,
  pressedControl: number | null,
  _onResizeStart: ((edge: string, e: PointerEvent) => void) | undefined,
  mdiDrag?: { current: { hwnd: number; startX: number; startY: number; startWndX: number; startWndY: number } | null },
  mdiResize?: { current: { hwnd: number; edge: string; startX: number; startY: number; startWndX: number; startWndY: number; startW: number; startH: number } | null },
  zIndex?: number,
) {
  const emu = emuRef.current;
  const isWin16 = !!emu?.isNE;
  const { bw, captionH } = getNonClientMetrics(ctrl.style, false, isWin16);
  const isMaximized = !!ctrl.isMdiMaximized;
  const isMinimized = !!ctrl.isMdiMinimized;
  const MINIMIZED_WIDTH = 160;
  const clientW = isMinimized ? MINIMIZED_WIDTH - 2 * bw : Math.max(0, ctrl.width - 2 * bw);
  const clientH = isMinimized ? 0 : Math.max(0, ctrl.height - 2 * bw - captionH);

  const activateMdiChild = () => {
    const emu = emuRef.current;
    if (!emu) return;
    const childWnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
    if (!childWnd) return;
    const mdiClient = emu.handles.get<WindowInfo>(childWnd.parent);
    if (!mdiClient) return;
    // Already active? skip
    if ((mdiClient as any).mdiActiveChild === ctrl.childHwnd) return;
    // Set active child
    (mdiClient as any).mdiActiveChild = ctrl.childHwnd;
    // Move to end of childList for z-ordering
    if (mdiClient.childList) {
      const idx = mdiClient.childList.indexOf(ctrl.childHwnd);
      if (idx >= 0) {
        mdiClient.childList.splice(idx, 1);
        mdiClient.childList.push(ctrl.childHwnd);
      }
    }
    emu.notifyControlOverlays();
  };

  const handleRestore = () => {
    const emu = emuRef.current;
    if (!emu) return;
    const childWnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
    if (!childWnd) return;
    const mdiClient = emu.handles.get<WindowInfo>(childWnd.parent);
    // Restore from minimized state
    const saved = childWnd._preMinRect ?? { x: 0, y: 0, w: 300, h: 200 };
    childWnd.x = saved.x;
    childWnd.y = saved.y;
    childWnd.width = saved.w;
    childWnd.height = saved.h;
    childWnd._preMinRect = undefined;
    childWnd.minimized = false;
    childWnd.visible = true;
    childWnd.needsPaint = true;
    // MDICLIENT background needs repaint after child layout change
    if (mdiClient) { mdiClient.needsPaint = true; mdiClient.needsErase = true; }
    const { cw, ch } = getClientSize(childWnd.style, false, childWnd.width, childWnd.height, !!emu.isNE);
    emu.postMessage(ctrl.childHwnd, 0x0005, 0, makeLParam(cw, ch)); // WM_SIZE SIZE_RESTORED
    emu.notifyControlOverlays();
  };

  const handleMaximize = () => {
    const emu = emuRef.current;
    if (!emu) return;
    const childWnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
    if (!childWnd) return;
    const mdiClient = emu.handles.get<WindowInfo>(childWnd.parent);
    if (!mdiClient) return;
    // If minimized, restore first then maximize
    if (childWnd.minimized) {
      const saved = childWnd._preMinRect ?? { x: 0, y: 0, w: 300, h: 200 };
      childWnd.x = saved.x;
      childWnd.y = saved.y;
      childWnd.width = saved.w;
      childWnd.height = saved.h;
      childWnd._preMinRect = undefined;
      childWnd.minimized = false;
      childWnd.visible = true;
    }
    if (childWnd.maximized) {
      // Restore from maximized
      const saved = childWnd._preMaxRect ?? { x: 0, y: 0, w: 300, h: 200 };
      childWnd.x = saved.x;
      childWnd.y = saved.y;
      childWnd.width = saved.w;
      childWnd.height = saved.h;
      childWnd._preMaxRect = undefined;
      childWnd.maximized = false;
      // MDICLIENT background was hidden by maximized child — needs repaint
      mdiClient.needsPaint = true;
      mdiClient.needsErase = true;
    } else {
      // Save pre-maximize state
      childWnd._preMaxRect = { x: childWnd.x, y: childWnd.y, w: childWnd.width, h: childWnd.height };
      // Maximize to fill MDICLIENT area
      childWnd.x = 0;
      childWnd.y = 0;
      childWnd.width = mdiClient.width || (emu.canvas?.width ?? 640);
      childWnd.height = mdiClient.height || (emu.canvas?.height ?? 480);
      childWnd.maximized = true;
    }
    childWnd.needsPaint = true;
    const { cw, ch } = getClientSize(childWnd.style, false, childWnd.width, childWnd.height, !!emu.isNE);
    emu.postMessage(ctrl.childHwnd, 0x0005, childWnd.maximized ? 2 : 0, makeLParam(cw, ch)); // WM_SIZE
    emu.notifyControlOverlays();
  };

  const handleMinimize = () => {
    const emu = emuRef.current;
    if (!emu) return;
    const childWnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
    if (!childWnd) return;
    const mdiClient = emu.handles.get<WindowInfo>(childWnd.parent);
    if (!mdiClient) return;
    // If maximized, save max rect and unmaximize first
    if (childWnd.maximized) {
      // _preMaxRect already saved, just clear maximized
      childWnd.maximized = false;
      // MDICLIENT background was hidden by maximized child — needs repaint
      mdiClient.needsPaint = true;
      mdiClient.needsErase = true;
    }
    // Save pre-minimize rect (use current or _preMaxRect if was maximized)
    if (!childWnd._preMinRect) {
      childWnd._preMinRect = childWnd._preMaxRect
        ? { ...childWnd._preMaxRect }
        : { x: childWnd.x, y: childWnd.y, w: childWnd.width, h: childWnd.height };
    }
    // Count existing minimized children to compute slot position
    let minSlot = 0;
    if (mdiClient.childList) {
      for (const sibHwnd of mdiClient.childList) {
        if (sibHwnd === ctrl.childHwnd) continue;
        const sib = emu.handles.get<WindowInfo>(sibHwnd);
        if (sib?.minimized) minSlot++;
      }
    }
    const mdiH = mdiClient.height || (emu.canvas?.height ?? 480);
    const minH = captionH + 2 * bw;
    childWnd.minimized = true;
    childWnd.x = minSlot * (MINIMIZED_WIDTH + 2);
    childWnd.y = mdiH - minH;
    childWnd.width = MINIMIZED_WIDTH;
    childWnd.height = minH;
    childWnd.needsPaint = true;
    emu.notifyControlOverlays();
  };

  // Clip MDI child to MDICLIENT bounds so it doesn't overlap toolbar/statusbar/drivebar
  const clipStyle: Record<string, string | number | undefined> = {
    position: 'absolute',
    left: `${ctrl.x}px`,
    top: `${ctrl.y}px`,
    zIndex: zIndex ?? 15,
  };
  if (ctrl.mdiClientRect) {
    const cr = ctrl.mdiClientRect;
    // Compute inset values: distance from each edge of the MDI child to the MDICLIENT boundary
    const clipTop = Math.max(0, cr.y - ctrl.y);
    const clipLeft = Math.max(0, cr.x - ctrl.x);
    const clipBottom = Math.max(0, (ctrl.y + ctrl.height) - (cr.y + cr.h));
    const clipRight = Math.max(0, (ctrl.x + ctrl.width) - (cr.x + cr.w));
    if (clipTop > 0 || clipLeft > 0 || clipBottom > 0 || clipRight > 0) {
      clipStyle.clipPath = `inset(${clipTop}px ${clipRight}px ${clipBottom}px ${clipLeft}px)`;
    }
  }

  return (
    <div key={ctrl.childHwnd} style={clipStyle}
    onPointerDown={activateMdiChild}
    >
      <Window
        title={ctrl.title || ''}
        style={ctrl.style}
        clientW={clientW}
        clientH={clientH}
        clientBg="transparent"
        focused={!!ctrl.isMdiActive}
        maximized={isMaximized}
        minimized={isMinimized}
        onTitleBarMouseDown={(e: PointerEvent) => {
          if ((e.target as HTMLElement).closest('span[style*="border"]')) return;
          if (isMaximized) return;
          e.preventDefault();
          activateMdiChild();
          const childWnd = emuRef.current?.handles.get<WindowInfo>(ctrl.childHwnd);
          if (childWnd && mdiDrag) {
            mdiDrag.current = {
              hwnd: ctrl.childHwnd,
              startX: e.clientX, startY: e.clientY,
              startWndX: childWnd.x, startWndY: childWnd.y,
            };
          }
        }}
        onTitleBarDblClick={isMinimized ? handleRestore : handleMaximize}
        onResizeStart={(!isMaximized && !isMinimized) ? (edge: string, e: PointerEvent) => {
          e.preventDefault();
          activateMdiChild();
          const childWnd = emuRef.current?.handles.get<WindowInfo>(ctrl.childHwnd);
          if (childWnd && mdiResize) {
            mdiResize.current = {
              hwnd: ctrl.childHwnd, edge,
              startX: e.clientX, startY: e.clientY,
              startWndX: childWnd.x, startWndY: childWnd.y,
              startW: childWnd.width, startH: childWnd.height,
            };
          }
        } : undefined}
        onClose={() => {
          emuRef.current?.postMessage(ctrl.childHwnd, WM_SYSCOMMAND, SC_CLOSE, 0);
        }}
        onMaximize={isMinimized ? handleRestore : handleMaximize}
        onMinimize={isMinimized ? undefined : handleMinimize}
      >
        {!isMinimized && ctrl.mdiChildren?.map(childCtrl =>
          renderControlOverlay(childCtrl, emuRef, setPressedControl, pressedControl, _onResizeStart)
        )}
      </Window>
    </div>
  );
}


// --- Main EmulatorView ---

export function EmulatorView({ arrayBuffer, peInfo, additionalFiles, exeName, commandLine, onStop, onFocus, onReady, onRunExe, onOpenHelp, onSetupEmulator, audioContext: sharedAudioContext, onTitleChange, onIconChange, onMinimize, onRegisterCloseHandler, processRegistry, zIndex = 100, focused = true, minimized: minimizedProp }: EmulatorViewProps) {
  const exeBaseName = exeName.split(/[/\\]/).pop() || exeName;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Transparent overlay over the menu bar for window-relative NC drawing
  // (GetWindowDC on the main window — e.g. FreeCell's "Cards Left" counter).
  const ncCanvasRef = useRef<HTMLCanvasElement>(null);
  const emuRef = useRef<Emulator | null>(null);
  const [menus, setMenus] = useState<MenuResult[]>([]);
  const detectedLang = langToHtmlLang(detectPELanguageId(peInfo.resources)) || undefined;
  const [windowTitle, setWindowTitle] = useState('');
  const [windowStyle, setWindowStyle] = useState(0x00CF0000); // WS_OVERLAPPEDWINDOW
  const [canvasSize, setCanvasSize] = useState({ w: 320, h: 240 });
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [dialogInfo, setDialogInfo] = useState<DialogInfo | null>(null);
  const [controlOverlays, setControlOverlays] = useState<ControlOverlay[]>([]);
  const [pressedControl, setPressedControl] = useState<number | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [windowPos, setWindowPos] = useState({ x: 40, y: 10 });
  const resizeDrag = useRef<{ edge: string; startX: number; startY: number; startW: number; startH: number; startPosX: number; startPosY: number } | null>(null);
  const moveDrag = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const mdiDrag = useRef<{ hwnd: number; startX: number; startY: number; startWndX: number; startWndY: number } | null>(null);
  const mdiResize = useRef<{ hwnd: number; edge: string; startX: number; startY: number; startWndX: number; startWndY: number; startW: number; startH: number } | null>(null);
  const windowPosInitialized = useRef(false);
  const preMaxState = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const mouseIsDown = useRef(false);
  const desktopRef = useRef<HTMLDivElement>(null);
  const [resetCount, setResetCount] = useState(0);
  const [windowReady, setWindowReady] = useState(false);
  const [hasMainWindow, setHasMainWindow] = useState(false);
  const [isConsole, setIsConsole] = useState(false);
  const [consoleZoom, setConsoleZoom] = useState<1 | 2>(1);
  const [consoleSmooth, setConsoleSmooth] = useState(true);
  // Bumped whenever the DOS console's screen layout (graphics ↔ text mode,
  // text rows × charH) changes — triggers a re-render so consoleClientH
  // re-reads the up-to-date emu state.
  const [consoleLayoutBump, setConsoleLayoutBump] = useState(0);
  const handleScreenLayoutChange = useCallback(() => {
    setConsoleLayoutBump(b => b + 1);
  }, []);
  const fsWrapperRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fsScale, setFsScale] = useState(1);
  const [crashInfo, setCrashInfo] = useState<{ eip: string; description: string } | null>(null);
  const [messageBoxes, setMessageBoxes] = useState<{ id: number; caption: string; text: string; type: number; isExit?: boolean }[]>([]);
  const [commonDialog, setCommonDialog] = useState<CommonDialogRequest | null>(null);
  const [findTerm, setFindTerm] = useState('');
  const [replaceTerm, setReplaceTerm] = useState('');
  const [modalFlashTrigger, setModalFlashTrigger] = useState(0);
  const flashModal = useCallback(() => setModalFlashTrigger(c => c + 1), []);

  const handleFullscreenToggle = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      fsWrapperRef.current?.requestFullscreen?.().catch(() => { /* user gesture missing or blocked */ });
    }
  }, []);

  useEffect(() => {
    const onChange = () => {
      const active = document.fullscreenElement === fsWrapperRef.current;
      setIsFullscreen(active);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    if (!isFullscreen) { setFsScale(1); return; }
    const recompute = () => {
      const baseW = 640 * consoleZoom;
      const baseH = 480 * consoleZoom;
      setFsScale(Math.min(window.innerWidth / baseW, window.innerHeight / baseH));
    };
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [isFullscreen, consoleZoom]);

  // When restored from taskbar, send SC_RESTORE to the emulator
  const prevMinimized = useRef(minimizedProp);
  useEffect(() => {
    if (prevMinimized.current && !minimizedProp) {
      const emu = emuRef.current;
      if (emu?.mainWindow) {
        emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_RESTORE, 0);
      }
    }
    prevMinimized.current = minimizedProp;
  }, [minimizedProp]);

  useEffect(() => {
    if (!canvasRef.current) return;

    // Reset all UI state on restart
    setMenus([]);
    setControlOverlays([]);
    setDialogInfo(null);
    setWindowTitle('');
    setWindowPos({ x: 40, y: 10 });
    setMinimized(false);
    setMaximized(false);
    setWindowReady(false);
    setHasMainWindow(false);
    setCrashInfo(null);
    setMessageBoxes([]);
    setConsoleZoom(1);
    preMaxState.current = null;

    const canvas = canvasRef.current;
    const emu = new Emulator();
    emu.configuredLcid = loadSettings().localeId;

    // Populate the emulator's virtualFiles metadata list from IndexedDB.
    // Only names + sizes are read — the data cache fills lazily via
    // FileManager.fetchFileData on first access, so launching an EXE no longer
    // pays the structured-clone cost of every other stored binary.
    const syncVirtualFiles = async (e: Emulator) => {
      const metas = await listFileMetadata();
      e.fs.virtualFiles = metas.map(m => ({ name: m.name, size: m.size }));
    };
    // Targeted update of virtualFiles + virtualFileCache from a
    // `desktop-files-changed` event. Guest-originated saves have already
    // refreshed both structures synchronously inside saveVirtualFile, so we
    // must not invalidate those cache entries. UI-originated adds may replace
    // the content of an existing cached entry, so their cache slots are
    // invalidated and will be lazily refetched on the next access.
    const applyChange = async (detail: DesktopFilesChangedDetail | null) => {
      if (!detail) {
        await syncVirtualFiles(emu);
        return;
      }
      const fs = emu.fs as typeof emu.fs & { virtualFileCache?: Map<string, ArrayBuffer> };
      const cache = fs.virtualFileCache;
      for (const name of detail.deleted ?? []) {
        fs.virtualFiles = fs.virtualFiles.filter(f => f.name !== name);
        cache?.delete(name.toUpperCase());
      }
      if ((detail.added?.length ?? 0) > 0) {
        const metas = await listFileMetadata();
        const byName = new Map(metas.map(m => [m.name, m]));
        for (const name of detail.added ?? []) {
          const m = byName.get(name);
          if (!m) continue;
          const existing = fs.virtualFiles.find(f => f.name === name);
          if (existing) existing.size = m.size;
          else fs.virtualFiles.push({ name: m.name, size: m.size });
          if (detail.source === 'ui') cache?.delete(name.toUpperCase());
        }
      }
    };
    const onDesktopChanged = (ev: Event) => {
      const detail = (ev as CustomEvent<DesktopFilesChangedDetail>).detail ?? null;
      applyChange(detail);
    };
    window.addEventListener('desktop-files-changed', onDesktopChanged);

    // Async init for registry + profiles, then start emulator
    let regFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let profFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let regStoreRef: RegistryStore | null = null;
    let profStoreRef: ProfileStore | null = null;
    // Force any pending debounced writes out to IndexedDB immediately. Called
    // on unmount and on page hide: apps that persist their settings while
    // closing (e.g. in WM_DESTROY) write within the 500ms debounce window, so
    // cancelling the timer instead of flushing would silently drop those writes.
    const flushPendingPersistence = () => {
      if (regFlushTimer !== null) { clearTimeout(regFlushTimer); regFlushTimer = null; }
      if (regStoreRef) {
        saveRegistry(regStoreRef.serialize()).catch(e =>
          console.warn('[REG] Failed to save registry:', e)
        );
      }
      if (profFlushTimer !== null) { clearTimeout(profFlushTimer); profFlushTimer = null; }
      if (profStoreRef) {
        saveProfiles(profStoreRef.serialize()).catch(e =>
          console.warn('[PROF] Failed to save profiles:', e)
        );
      }
    };
    // The browser may close/refresh the tab without unmounting React first;
    // flush on pagehide so a tab close right after a settings change isn't lost.
    const onPageHide = () => flushPendingPersistence();
    window.addEventListener('pagehide', onPageHide);
    const initAndRun = async () => {
      // Load registry, profiles, and virtual filesystem in parallel (independent IndexedDB reads)
      const [regData, profData] = await Promise.all([
        loadRegistry().catch(e => { console.warn('[REG] Failed to load registry from IndexedDB:', e); return null; }),
        loadProfiles().catch(e => { console.warn('[PROF] Failed to load profiles from IndexedDB:', e); return null; }),
        syncVirtualFiles(emu),
      ]);

      // Set up registry store with IndexedDB persistence
      const regStore = new RegistryStore();
      regStoreRef = regStore;
      if (regData) regStore.deserialize(regData);
      regStore.onChange = () => {
        if (regFlushTimer !== null) clearTimeout(regFlushTimer);
        regFlushTimer = setTimeout(() => {
          saveRegistry(regStore.serialize()).catch(e =>
            console.warn('[REG] Failed to save registry:', e)
          );
        }, 500);
      };
      emu.registryStore = regStore;

      // Set up profile store with IndexedDB persistence
      const profStore = new ProfileStore();
      profStoreRef = profStore;
      if (profData) profStore.deserialize(profData);
      profStore.onChange = () => {
        if (profFlushTimer !== null) clearTimeout(profFlushTimer);
        profFlushTimer = setTimeout(() => {
          saveProfiles(profStore.serialize()).catch(e =>
            console.warn('[PROF] Failed to save profiles:', e)
          );
        }, 500);
      };
      emu.profileStore = profStore;

      // Apply DOS settings BEFORE load() so setupDosEnvironment sees the correct flags
      // (EMS device header, XMS/DPMI stubs, etc. are set up during load for MZ files).
      const dsPre = loadDosSettings();
      emu.wasmJitEnabled = dsPre.jitEnabled;
      emu.dosEnableDpmi = dsPre.dpmi;
      emu.dosEnableV86 = dsPre.v86;
      emu.dosEnableXms = dsPre.xms;
      emu.dosEnableEms = dsPre.ems;
      emu.dosEnableSoundBlaster = dsPre.soundBlaster;
      emu.dosEnableAdlib = dsPre.adlib;
      emu.dosEnableGus = dsPre.gus;
      emu.dosSpeedFactor = dsPre.speed;
      emu.traceApi = dsPre.traceApi;

      await emu.load(arrayBuffer, peInfo, canvas);

      // UPX-packed PEs hide their resources until the decompression stub has
      // run, which happens inside emu.load(). emu-load.ts repopulates
      // peInfo.resources / peInfo.sections and stores the unpacked image in
      // emu.arrayBuffer. Re-extract menus + icons from that view so the UI
      // gets the real menu bar and app icon for UPX exes (PabloDraw, etc.).
      if (peInfo.isUpxPacked && emu.arrayBuffer) {
        const postMenus = extractMenus(peInfo, emu.arrayBuffer);
        if (postMenus.length > 0) {
          setMenus(postMenus);
          emu.menuItems = postMenus[0].menu.items;
        }
        const postIcons = extractIcons(peInfo, emu.arrayBuffer);
        if (postIcons.length > 0) {
          const url = URL.createObjectURL(postIcons[0].blob);
          setIconUrl(url);
          onIconChange?.(url);
        }
      }
    };

    try {
      const extractedMenus = extractMenus(peInfo, arrayBuffer);
      setMenus(extractedMenus);
      // Expose menu items to emulator for CheckMenuItem/EnableMenuItem
      if (extractedMenus.length > 0) {
        emu.menuItems = extractedMenus[0].menu.items;
      }

      // Extract the first app icon for the title bar
      const icons = extractIcons(peInfo, arrayBuffer);
      if (icons.length > 0) {
        const url = URL.createObjectURL(icons[0].blob);
        setIconUrl(url);
        onIconChange?.(url);
      }

      if (additionalFiles) {
        for (const [name, data] of additionalFiles) {
          emu.additionalFiles.set(name, data);
        }
      }

      if (commandLine) emu.commandLine = commandLine;
      emu.exeName = exeName;
      if (processRegistry) {
        emu.processRegistry = processRegistry;
        processRegistry.register(emu, exeName);
      }
      emu.screenWidth = window.innerWidth;
      emu.screenHeight = window.innerHeight;

      // Wire up async file I/O to IndexedDB via FileManager (before load() so
      // NE DLL loading can fetch DLLs from PATH directories in IndexedDB)
      emu.fs.onFileRequest = (fileName: string) => getFile(fileName);
      emu.fs.onFileSave = (fileName: string, data: ArrayBuffer) => {
        addFile(fileName, data).then(() =>
          dispatchDesktopFilesChanged({ source: 'guest', added: [fileName] })
        );
      };
      emu.fs.onFileDelete = (fileName: string) => {
        deleteFile(fileName).then(() =>
          dispatchDesktopFilesChanged({ source: 'guest', deleted: [fileName] })
        );
      };

      // Wire up browser download for Z:\ file save
      emu.fs.onFileSaveExternal = (name, data) => {
        const blob = new Blob([data]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };

      onSetupEmulator?.(emu);

      emu.ncCanvas = ncCanvasRef.current;
      emuRef.current = emu;
      (globalThis as typeof globalThis & { __emu?: unknown }).__emu = emu;
      onRegisterCloseHandler?.(() => {
        if (emu.mainWindow) {
          emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_CLOSE, 0);
        } else {
          onStop();
        }
      });

      emu.onConsoleTitleChange = () => {
        setWindowTitle(emu.consoleTitle);
        onTitleChange?.(emu.consoleTitle);
      };

      // Listen for window changes from emulator
      emu.onWindowChange = (wnd: WindowInfo) => {
        setWindowReady(prev => { if (!prev) onReady?.(); return true; });
        setHasMainWindow(true);
        setWindowTitle(wnd.title);
        onTitleChange?.(wnd.title);
        setWindowStyle(wnd.style);
        setMinimized(!!wnd.minimized);
        setMaximized(!!wnd.maximized);
        // Use emulated window position only for initial mainWindow placement (cascade),
        // not for runtime MoveWindow/SetWindowPos or non-main windows
        if (!windowPosInitialized.current && emu.mainWindow && wnd.hwnd === emu.mainWindow) {
          windowPosInitialized.current = true;
          const x = Math.max(0, Math.min(wnd.x, window.innerWidth - wnd.width));
          const y = Math.max(0, Math.min(wnd.y, window.innerHeight - wnd.height));
          setWindowPos({ x, y });
        }
        if (canvas && !wnd.minimized) {
          setCanvasSize({ w: canvas.width, h: canvas.height });
        }
      };

      emu.onShowDialog = (info: DialogInfo) => {
        setDialogInfo(info);
        // Programs like ssmaze.scr /c show a dialog without creating a main window.
        setWindowReady(prev => { if (!prev) onReady?.(); return true; });
      };
      emu.onCloseDialog = () => setDialogInfo(null);
      emu.onControlsChanged = (controls: ControlOverlay[]) => setControlOverlays(controls);
      emu.onMenuChanged = () => setMenus(prev => [...prev]);
      // Apps that build their menu at runtime (CreateMenu + AppendMenu, e.g.
      // PabloDraw) only expose the structure via SetMenu(hwnd, hMenu). Walk
      // the runtime InternalMenuItem tree once the main window's menu is set
      // and convert it into the MenuResult[] shape the React MenuBar expects.
      emu.onSetMenu = (hwnd, hMenu) => {
        if (!emu.mainWindow || hwnd !== emu.mainWindow || !hMenu) return;
        const seen = new Set<number>();
        const toMenuItem = (it: { id: number; text: string; flags: number; hSubMenu: number }): import('../lib/pe/types').MenuItem => {
          const isSeparator = !!(it.flags & 0x800); // MF_SEPARATOR
          const isChecked = !!(it.flags & 0x08);
          const isGrayed = !!(it.flags & 0x03);   // MF_GRAYED | MF_DISABLED
          let children: import('../lib/pe/types').MenuItem[] | null = null;
          if (it.hSubMenu && !seen.has(it.hSubMenu)) {
            seen.add(it.hSubMenu);
            const sub = emu.handles.get<{ items: { id: number; text: string; flags: number; hSubMenu: number }[] }>(it.hSubMenu);
            if (sub?.items) children = sub.items.map(toMenuItem);
          }
          return { id: it.id, text: it.text || '', isSeparator, isChecked, isGrayed, isDefault: false, children };
        };
        const root = emu.handles.get<{ items: { id: number; text: string; flags: number; hSubMenu: number }[] }>(hMenu);
        if (!root?.items?.length) return;
        seen.add(hMenu);
        const items = root.items.map(toMenuItem);
        setMenus([{ id: null, name: null, languageId: 0, menu: { isExtended: false, items } }]);
        emu.menuItems = items;
      };
      emu.onShowCommonDialog = (req) => {
        setCommonDialog(req);
        setWindowReady(prev => { if (!prev) onReady?.(); return true; });
      };
      emu.onShowMessageBox = (id, caption, text, type) => {
        setMessageBoxes(prev => [...prev, { id, caption, text, type }]);
        // Programs like winver.exe show a message box without creating a main window.
        // Ensure the UI becomes visible so the message box can be seen.
        setWindowReady(prev => { if (!prev) onReady?.(); return true; });
      };
      emu.onCrash = (eip: string, description: string) => { setCrashInfo({ eip, description }); onReady?.(); };
      let initialLoadDone = false;
      emu.onMissingDll = (dllName: string) => {
        if (!initialLoadDone) return; // will be listed in the post-run batch
        const s = t();
        setMessageBoxes(prev => [...prev, {
          id: Date.now(),
          caption: exeBaseName,
          text: `${s.missingDlls.replace('{0}', dllName)}\n\n${s.missingDllsHint}`,
          type: 0x30, /* MB_ICONWARNING */
        }]);
      };
      emu.onReboot = () => { location.reload(); };
      emu.onExit = () => {
        emu.destroyAudio();
        if (emu.isConsole) {
          // Keep window open so user can see output, show a message box like cmd.exe
          const finishedTitle = `Finished - ${emu.consoleTitle || exeBaseName}`;
          emu.consoleTitle = finishedTitle;
          setWindowTitle(finishedTitle);
          onTitleChange?.(finishedTitle);
          setMessageBoxes(prev => [...prev, { id: -1, caption: exeBaseName, text: t().processExited.replace('{0}', String(emu.exitCode)), type: 0 /* MB_OK */, isExit: true }]);
          return;
        }
        onStop();
      };
      if (onOpenHelp) {
        emu.onOpenHelp = (fileBytes: ArrayBuffer, fileName: string) => {
          onOpenHelp(fileBytes, fileName);
        };
      }
      emu.onCreateProcess = (childExeName: string, childCmdLine: string) => {
        if (!onRunExe) return;
        const lowerName = childExeName.toLowerCase();
        for (const [name, data] of emu.additionalFiles) {
          if (name.toLowerCase() === lowerName) {
            const childPe = lowerName.endsWith('.com') ? parseCOM(data) : parsePE(data);
            // Pass all additionalFiles to the child too
            onRunExe(data, childPe, emu.additionalFiles, name, childCmdLine);
            return;
          }
        }
      };

      // Child console process from console parent: run in-process, share console
      emu.onCreateChildConsole = async (childExeName: string, childCmdLine: string, hProcess: number) => {
        const lowerName = childExeName.toLowerCase();
        let childData: ArrayBuffer | undefined;
        let childFileName = childExeName;
        for (const [name, data] of emu.additionalFiles) {
          if (name.toLowerCase() === lowerName) {
            childData = data;
            childFileName = name;
            break;
          }
        }
        if (!childData) return;

        const childPeInfo = lowerName.endsWith('.com') ? parseCOM(childData) : parsePE(childData);
        const procData = emu.handles.get<Record<string, unknown>>(hProcess);

        // Create child emulator in-process
        const childEmu = new Emulator();
        childEmu.configuredLcid = loadSettings().localeId;
        for (const [name, data] of emu.additionalFiles) {
          childEmu.additionalFiles.set(name, data);
        }
        if (childCmdLine) childEmu.commandLine = childCmdLine;
        if (processRegistry) {
          childEmu.processRegistry = processRegistry;
          processRegistry.register(childEmu, childFileName);
        }
        childEmu.screenWidth = emu.screenWidth;
        childEmu.screenHeight = emu.screenHeight;

        // Share file system, inherit current drive/directory
        childEmu.fs = emu.fs;
        childEmu.currentDrive = emu.currentDrive;
        childEmu.currentDirs = new Map(emu.currentDirs);

        // Store child emu on the process handle
        if (procData) {
          procData.childEmu = childEmu;
          procData.childExited = false;
          procData.childExitCode = 0;
        }

        // Apply DOS settings BEFORE load() — setupDosEnvironment in load() reads these flags
        {
          const ds = loadDosSettings();
          childEmu.wasmJitEnabled = ds.jitEnabled;
          childEmu.dosEnableDpmi = ds.dpmi;
          childEmu.dosEnableXms = ds.xms;
          childEmu.dosEnableEms = ds.ems;
          childEmu.dosEnableSoundBlaster = ds.soundBlaster;
          childEmu.dosEnableAdlib = ds.adlib;
          childEmu.dosEnableGus = ds.gus;
          childEmu.dosSpeedFactor = ds.speed;
          childEmu.traceApi = ds.traceApi;
        }

        // Load child (this creates its own consoleBuffer via initConsoleBuffer)
        await childEmu.load(childData, childPeInfo, canvas);
        if (childEmu.isDOS) {
          childEmu.vga.refreshHz = loadDosSettings().refreshRate;
        }

        // Share console state AFTER load() so initConsoleBuffer doesn't overwrite
        childEmu.consoleBuffer = emu.consoleBuffer;
        childEmu.consoleCursorX = emu.consoleCursorX;
        childEmu.consoleCursorY = emu.consoleCursorY;
        childEmu.consoleAttr = emu.consoleAttr;
        childEmu.consoleMode = emu.consoleMode;
        childEmu.consoleInputMode = emu.consoleInputMode;
        childEmu.consoleInputBuffer = emu.consoleInputBuffer;

        // Allow child to create GUI windows or spawn its own children
        childEmu.onCreateProcess = emu.onCreateProcess;
        childEmu.onCreateChildConsole = emu.onCreateChildConsole;
        childEmu.onOpenHelp = emu.onOpenHelp;

        // When child writes to console, sync cursor back to parent and notify UI
        childEmu.onConsoleOutput = () => {
          emu.consoleCursorX = childEmu.consoleCursorX;
          emu.consoleCursorY = childEmu.consoleCursorY;
          emu.consoleAttr = childEmu.consoleAttr;
          emu.onConsoleOutput?.();
        };

        childEmu.onConsoleTitleChange = () => {
          emu.consoleTitle = childEmu.consoleTitle;
          emu.onConsoleTitleChange?.();
        };

        // When child exits, signal the parent's process handle and resume parent
        childEmu.onExit = () => {
          emu.consoleCursorX = childEmu.consoleCursorX;
          emu.consoleCursorY = childEmu.consoleCursorY;
          emu.consoleAttr = childEmu.consoleAttr;
          emu.onConsoleOutput?.();

          if (procData) {
            procData.childExited = true;
            procData.childExitCode = childEmu.exitCode;
          }

          // Resume parent if it was waiting on WaitForSingleObject
          if (emu._childProcessWaiting && emu._childProcessResume) {
            const { stackBytes, retVal, completer } = emu._childProcessResume;
            emu._childProcessWaiting = false;
            emu._childProcessResume = null;
            emu.waitingForMessage = false;
            completer(emu, stackBytes, retVal);
            if (emu.running && !emu.halted) {
              requestAnimationFrame(emu.tick);
            }
          }
        };

        // Start the child
        childEmu.run();
      };

      // Load registry from IndexedDB then start
      initAndRun().then(() => {
        // Apply post-load DOS settings that depend on objects created during load()
        if (emu.isDOS) {
          const ds = loadDosSettings();
          emu.vga.refreshHz = ds.refreshRate;
        }

        // Assign shared AudioContext — created in App during user gesture
        if (sharedAudioContext) {
          emu.audioContext = sharedAudioContext;
          if (emu.isDOS) emu.dosAudio.init(sharedAudioContext);
        }

        // Console app detection (must be after load() which sets isDOS/isConsole)
        if (emu.isConsole) {
          setIsConsole(true);
          setWindowReady(true);
          if (!emu.consoleTitle) emu.consoleTitle = emu.exePath;
          setWindowTitle(emu.consoleTitle);
          onTitleChange?.(emu.consoleTitle);
          setWindowStyle(WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX);
          setCanvasSize({ w: 640, h: 480 });
          onReady?.();
        }

        emu.run();
        initialLoadDone = true;
        if (emu.missingDlls.length > 0) {
          const s = t();
          const dlls = emu.missingDlls.join(', ');
          setMessageBoxes(prev => [...prev, {
            id: -99,
            caption: exeBaseName,
            text: `${s.missingDlls.replace('{0}', dlls)}\n\n${s.missingDllsHint}`,
            type: 0x30, /* MB_ICONWARNING */
          }]);
        }
      });
    } catch (err: unknown) {
      console.error('Emulator error:', err);
    }

    return () => {
      window.removeEventListener('desktop-files-changed', onDesktopChanged);
      window.removeEventListener('pagehide', onPageHide);
      // Flush (not cancel) any debounced registry/profile writes so settings
      // saved right before the app closed are persisted.
      flushPendingPersistence();
      if (emuRef.current) {
        if (processRegistry && emuRef.current.pid) {
          processRegistry.unregister(emuRef.current.pid);
        }
        emuRef.current.destroyAudio();
        emuRef.current.stop();
        emuRef.current = null;
      }
      if (iconUrl) URL.revokeObjectURL(iconUrl);
    };
  }, [arrayBuffer, peInfo, resetCount]);

  // Live-update DOS settings (speed, JIT) without restarting
  useEffect(() => {
    const onSettingsChanged = () => {
      const emu = emuRef.current;
      if (!emu || !emu.isDOS) return;
      const ds = loadDosSettings();
      emu.wasmJitEnabled = ds.jitEnabled;
      emu.dosSpeedFactor = ds.speed;
      emu.vga.refreshHz = ds.refreshRate;
      emu.vga.invalidateRetraceCache();
    };
    window.addEventListener('retrotick-settings-changed', onSettingsChanged);
    return () => window.removeEventListener('retrotick-settings-changed', onSettingsChanged);
  }, []);

  // File open/save dialogs are now rendered as FileDialog components (see JSX below)

  // --- Find dialog: Find Next handler ---
  const handleFindNext = useCallback(() => {
    if (!commonDialog || (commonDialog.type !== 'find' && commonDialog.type !== 'find-replace') || !findTerm) return;
    const emu = emuRef.current;
    if (!emu) return;
    const wnd = emu.handles.get<WindowInfo>(commonDialog.editHwnd);
    if (!wnd) return;
    const text = wnd.domInput?.value || wnd.title || '';
    const startPos = (emu.findState?.term === findTerm) ? (emu.findState.lastIndex + 1) : 0;
    const idx = text.toLowerCase().indexOf(findTerm.toLowerCase(), startPos);
    if (idx >= 0) {
      emu.findState = { term: findTerm, lastIndex: idx };
      wnd.editSelStart = idx;
      wnd.editSelEnd = idx + findTerm.length;
      if (wnd.domInput) {
        wnd.domInput.focus();
        wnd.domInput.setSelectionRange(idx, idx + findTerm.length);
      }
      emu.notifyControlOverlays();
    } else {
      emu.findState = { term: findTerm, lastIndex: -1 };
      alert('Cannot find "' + findTerm + '"');
    }
    // Sync search term to FINDREPLACEW struct so menu "Find Next" (F3) also works
    if (emu.findReplacePtr) {
      const lpBuf = emu.memory.readU32(emu.findReplacePtr + 0x10); // lpstrFindWhat
      const bufLen = emu.memory.readU16(emu.findReplacePtr + 0x18); // wFindWhatLen
      if (lpBuf && bufLen > 0) {
        const maxChars = Math.min(findTerm.length, Math.floor(bufLen / 2) - 1);
        for (let i = 0; i < maxChars; i++) {
          emu.memory.writeU16(lpBuf + i * 2, findTerm.charCodeAt(i));
        }
        emu.memory.writeU16(lpBuf + maxChars * 2, 0);
      }
    }
  }, [commonDialog, findTerm]);

  // --- Find/Replace: Replace handler ---
  const handleReplace = useCallback(() => {
    if (!commonDialog || commonDialog.type !== 'find-replace' || !findTerm) return;
    const emu = emuRef.current;
    if (!emu) return;
    const wnd = emu.handles.get<WindowInfo>(commonDialog.editHwnd);
    if (!wnd) return;
    const text = wnd.domInput?.value || wnd.title || '';
    const selStart = wnd.editSelStart ?? 0;
    const selEnd = wnd.editSelEnd ?? 0;
    // If current selection matches the find term, replace it
    const selected = text.substring(selStart, selEnd);
    if (selected.toLowerCase() === findTerm.toLowerCase()) {
      const newText = text.substring(0, selStart) + replaceTerm + text.substring(selEnd);
      wnd.title = newText;
      if (wnd.domInput) wnd.domInput.value = newText;
      wnd.editSelStart = selStart;
      wnd.editSelEnd = selStart + replaceTerm.length;
      if (wnd.domInput) wnd.domInput.setSelectionRange(selStart, selStart + replaceTerm.length);
      emu.notifyControlOverlays();
    }
    // Then find next
    handleFindNext();
  }, [commonDialog, findTerm, replaceTerm, handleFindNext]);

  // --- Find/Replace: Replace All handler ---
  const handleReplaceAll = useCallback(() => {
    if (!commonDialog || commonDialog.type !== 'find-replace' || !findTerm) return;
    const emu = emuRef.current;
    if (!emu) return;
    const wnd = emu.handles.get<WindowInfo>(commonDialog.editHwnd);
    if (!wnd) return;
    const text = wnd.domInput?.value || wnd.title || '';
    // Case-insensitive replace all
    const regex = new RegExp(findTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const newText = text.replace(regex, replaceTerm);
    const count = (text.match(regex) || []).length;
    if (count > 0) {
      wnd.title = newText;
      if (wnd.domInput) wnd.domInput.value = newText;
      emu.notifyControlOverlays();
    }
  }, [commonDialog, findTerm, replaceTerm]);

  // --- Resize drag handling ---
  const onResizeStart = useCallback((edge: string, e: PointerEvent) => {
    e.preventDefault();
    // Send WM_GETMINMAXINFO so the app can set its min track size (cached on WindowInfo after dispatch)
    const emu = emuRef.current;
    if (emu && emu.mainWindow) {
      const addr = emu.allocHeap(40); // MINMAXINFO = 40 bytes
      emu.postMessage(emu.mainWindow, WM_GETMINMAXINFO, 0, addr);
    }
    resizeDrag.current = { edge, startX: e.clientX, startY: e.clientY, startW: canvasSize.w, startH: canvasSize.h, startPosX: windowPos.x, startPosY: windowPos.y };
  }, [canvasSize, windowPos]);

  const applyCanvasToEmu = useCallback((w: number, h: number) => {
    const emu = emuRef.current;
    if (!emu || !emu.mainWindow) return;
    const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
    if (!wnd) return;
    emu.setupCanvasSize(w, h);
    const bw = getBorderWidth(wnd.style);
    const hasCaption = (wnd.style & WS_CAPTION) === WS_CAPTION;
    const captionH = hasCaption ? 19 : 0;
    const menuH = wnd.hMenu ? 19 : 0;
    wnd.width = w + 2 * bw;
    wnd.height = h + 2 * bw + captionH + menuH;
    // Coalesce: remove any pending WM_SIZE for the main window from the queue
    const queue = emu.messageQueue;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].hwnd === emu.mainWindow && queue[i].message === WM_SIZE) {
        queue.splice(i, 1);
      }
    }
    // For NE (Win16) apps: also store pending resize so GetMessage can
    // synthesize it before the queue, ensuring WM_SIZE+WM_PAINT in same tick.
    if (emu.isNE) {
      emu._pendingResizeLParam = makeLParam(w, h);
    }
    emu.postMessage(emu.mainWindow, WM_SIZE, 0, makeLParam(w, h));
    wnd.needsPaint = true;
    wnd.needsErase = true;
    emu.notifyControlOverlays();
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      // MDI child move drag
      const md = mdiDrag.current;
      if (md) {
        const emu = emuRef.current;
        if (emu) {
          const childWnd = emu.handles.get<WindowInfo>(md.hwnd);
          if (childWnd) {
            childWnd.x = md.startWndX + e.clientX - md.startX;
            childWnd.y = md.startWndY + e.clientY - md.startY;
            // Trigger main window repaint so canvas content follows the MDI child
            const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow);
            if (mainWnd) mainWnd.needsPaint = true;
            // Repaint MDICLIENT background where child was
            const mdiClient = emu.handles.get<WindowInfo>(childWnd.parent);
            if (mdiClient && mdiClient.classInfo?.hbrBackground) {
              mdiClient.needsPaint = true;
              mdiClient.needsErase = true;
            }
            emu.notifyControlOverlays();
          }
        }
        return;
      }
      // MDI child resize drag
      const mr = mdiResize.current;
      if (mr) {
        const emu = emuRef.current;
        if (emu) {
          const childWnd = emu.handles.get<WindowInfo>(mr.hwnd);
          if (childWnd) {
            const dx = e.clientX - mr.startX;
            const dy = e.clientY - mr.startY;
            let w = mr.startW, h = mr.startH;
            let wx = mr.startWndX, wy = mr.startWndY;
            if (mr.edge.includes('e')) w = mr.startW + dx;
            if (mr.edge.includes('w')) { w = mr.startW - dx; wx = mr.startWndX + dx; }
            if (mr.edge.includes('s')) h = mr.startH + dy;
            if (mr.edge.includes('n')) { h = mr.startH - dy; wy = mr.startWndY + dy; }
            if (w < 80) { if (mr.edge.includes('w')) wx -= 80 - w; w = 80; }
            if (h < 40) { if (mr.edge.includes('n')) wy -= 40 - h; h = 40; }
            childWnd.x = wx;
            childWnd.y = wy;
            childWnd.width = w;
            childWnd.height = h;
            childWnd.needsPaint = true;
            const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow);
            if (mainWnd) mainWnd.needsPaint = true;
            // Repaint MDICLIENT background where child was
            const mdiClient = emu.handles.get<WindowInfo>(childWnd.parent);
            if (mdiClient && mdiClient.classInfo?.hbrBackground) {
              mdiClient.needsPaint = true;
              mdiClient.needsErase = true;
            }
            emu.notifyControlOverlays();
          }
        }
        return;
      }
      // Move drag
      const m = moveDrag.current;
      if (m) {
        setWindowPos({ x: m.startPosX + e.clientX - m.startX, y: m.startPosY + e.clientY - m.startY });
        return;
      }
      // Resize drag
      const d = resizeDrag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      let w = d.startW, h = d.startH;
      let px = d.startPosX, py = d.startPosY;
      if (d.edge.includes('e')) w = d.startW + dx;
      if (d.edge.includes('w')) { w = d.startW - dx; px = d.startPosX + dx; }
      if (d.edge.includes('s')) h = d.startH + dy;
      if (d.edge.includes('n')) { h = d.startH - dy; py = d.startPosY + dy; }
      // Windows SM_CXMINTRACK = 112 at 96 DPI (fits icon + caption buttons + borders)
      const SM_CXMINTRACK = 112;
      let minW = SM_CXMINTRACK, minH = 32;
      const emu = emuRef.current;
      if (emu && emu.mainWindow) {
        const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
        if (wnd && wnd.minTrackWidth) {
          const bw = getBorderWidth(wnd.style);
          const hasCaption = (wnd.style & WS_CAPTION) === WS_CAPTION;
          const captionH = hasCaption ? 19 : 0;
          const menuH = wnd.hMenu ? 19 : 0;
          minW = Math.max(SM_CXMINTRACK, wnd.minTrackWidth - 2 * bw);
          minH = Math.max(32, (wnd.minTrackHeight || 0) - 2 * bw - captionH - menuH);
        }
      }
      if (w < minW) { if (d.edge.includes('w')) px -= minW - w; w = minW; }
      if (h < minH) { if (d.edge.includes('n')) py -= minH - h; h = minH; }
      setCanvasSize({ w, h });
      setWindowPos({ x: px, y: py });
      applyCanvasToEmu(w, h);
    };
    const onUp = () => {
      if (mdiDrag.current) {
        mdiDrag.current = null;
        return;
      }
      if (mdiResize.current) {
        const emu = emuRef.current;
        const hwnd = mdiResize.current.hwnd;
        mdiResize.current = null;
        // Queue WM_SIZE via postMessage (safe from browser event handlers)
        if (emu) {
          const childWnd = emu.handles.get<WindowInfo>(hwnd);
          if (childWnd) {
            const { cw, ch } = getClientSize(childWnd.style, false, childWnd.width, childWnd.height, !!emu.isNE);
            emu.postMessage(hwnd, 0x0005, 0, makeLParam(cw, ch)); // WM_SIZE
          }
        }
        return;
      }
      if (moveDrag.current) { moveDrag.current = null; return; }
      resizeDrag.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
  }, [canvasSize, applyCanvasToEmu]);

  const handlePointerEvent = useCallback((e: PointerEvent, msg: number) => {
    const emu = emuRef.current;
    if (!emu || !emu.mainWindow) return;
    // Block mouse events while a modal dialog/MessageBox is showing
    if (emu.messageBoxes.length > 0) return;
    if (emu.dialogState) return;
    // Resume AudioContext if suspended (user gesture)
    if (emu.audioContext?.state === 'suspended') emu.audioContext.resume();

    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) * canvas.width / rect.width);
    const y = Math.round((e.clientY - rect.top) * canvas.height / rect.height);
    // Cache the screen-coord cursor so GetCursorPos / GetMessagePos can read
    // it without the app needing to receive a WM_MOUSEMOVE first.
    emu.cursorX = x;
    emu.cursorY = y;
    const wParam = buildMKFlags(e);
    if (emu.capturedWindow) {
      // Auto-release capture when no buttons pressed and cursor is outside the
      // captured window (matches Windows behavior for WM_MOUSEMOVE tracking)
      if (msg === WM_MOUSEMOVE && e.buttons === 0) {
        const cw = emu.handles.get<WindowInfo>(emu.capturedWindow);
        if (cw) {
          let ox = 0, oy = 0;
          let h = emu.capturedWindow;
          while (h && h !== emu.mainWindow) {
            const w = emu.handles.get<WindowInfo>(h);
            if (!w) break;
            ox += w.x; oy += w.y;
            h = w.parent;
          }
          const rx = x - ox, ry = y - oy;
          if (rx < 0 || ry < 0 || rx >= cw.width || ry >= cw.height) {
            emu.capturedWindow = 0;
          }
        }
      }
      // SetCapture: convert canvas coords to coords relative to captured window.
      // Walk up the parent chain to compute absolute canvas position, stopping
      // at the main window (canvas coords = main window's coordinate space).
      let ox = 0, oy = 0;
      let hwnd = emu.capturedWindow;
      while (hwnd && hwnd !== emu.mainWindow) {
        const w = emu.handles.get<WindowInfo>(hwnd);
        if (!w) break;
        ox += w.x; oy += w.y;
        hwnd = w.parent;
      }
      emu.postMessage(emu.capturedWindow, msg, wParam, makeLParam(x - ox, y - oy));
    } else {
      // Hit-test to find the correct child window and convert coordinates
      const hit = emu.windowFromPoint(x, y);
      // Real Windows sends WM_MOUSEACTIVATE before the button message ONLY
      // when the clicked window differs from the active window (Wine
      // win32u/message.c: `if (msg->hwnd != info.hwndActive)`). Child views
      // always get it (MFC CView::OnMouseActivate SetFocuses the view), but a
      // click straight on the active top-level must NOT — apps like FreeCell
      // answer MA_ACTIVATEANDEAT to swallow activation clicks, and sending it
      // every time made them eat every click.
      if ((msg === WM_LBUTTONDOWN || msg === WM_RBUTTONDOWN
        || msg === WM_LBUTTONDBLCLK || msg === WM_RBUTTONDBLCLK)
        && hit.hwnd !== emu.mainWindow) {
        emu.postMessage(hit.hwnd, WM_MOUSEACTIVATE, emu.mainWindow, (msg << 16) | HTCLIENT);
      }
      emu.postMessage(hit.hwnd, msg, wParam, makeLParam(hit.x, hit.y));
    }
  }, []);

  // Document-level mouse listeners for SetCapture support (drag over overlays)
  useEffect(() => {
    const onDocMouseMove = (e: PointerEvent) => {
      if (!mouseIsDown.current || !canvasRef.current) return;
      handlePointerEvent(e, WM_MOUSEMOVE);
    };
    const onDocMouseUp = (e: PointerEvent) => {
      if (!mouseIsDown.current || !canvasRef.current) return;
      mouseIsDown.current = false;
      const btn = e.button;
      const saved = { clientX: e.clientX, clientY: e.clientY, buttons: e.buttons } as PointerEvent;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        handlePointerEvent(saved, WM_MOUSEMOVE);
        if (btn === 0) handlePointerEvent(saved, WM_LBUTTONUP);
        else if (btn === 2) handlePointerEvent(saved, WM_RBUTTONUP);
      }));
    };
    document.addEventListener('pointermove', onDocMouseMove);
    document.addEventListener('pointerup', onDocMouseUp);
    return () => {
      document.removeEventListener('pointermove', onDocMouseMove);
      document.removeEventListener('pointerup', onDocMouseUp);
    };
  }, [handlePointerEvent]);

  // Keyboard input — post WM_KEYDOWN/WM_KEYUP/WM_CHAR to emulator
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!focused) return;
      // Don't intercept input into HTML form elements
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const emu = emuRef.current;
      if (!emu || !emu.mainWindow) return;
      // Don't intercept browser shortcuts (Ctrl+T, Ctrl+W, etc.)
      if (e.ctrlKey && !e.altKey && ['KeyT', 'KeyW', 'KeyN', 'KeyR', 'KeyL'].includes(e.code)) return;
      const keyToVK = getKeyToVK();
      const vk = keyToVK[e.code];
      if (vk === undefined) return;
      e.preventDefault();
      emu.keyStates.add(vk);
      // Mirror the host toggle-key state (GetKeyState bit 0)
      if (e.getModifierState) {
        const VK_CAPITAL = 0x14, VK_NUMLOCK = 0x90, VK_SCROLL = 0x91;
        const syncToggle = (mod: string, tvk: number) => {
          if (e.getModifierState(mod)) emu.keyToggles.add(tvk);
          else emu.keyToggles.delete(tvk);
        };
        syncToggle('CapsLock', VK_CAPITAL);
        syncToggle('NumLock', VK_NUMLOCK);
        syncToggle('ScrollLock', VK_SCROLL);
      }
      // lParam: repeat count (1) | scanCode << 16 | extended << 24 | previous state << 30
      const scanCode = e.keyCode & 0xFF;
      const lParam = 1 | (scanCode << 16);
      const target = emu.focusedWindow || emu.mainWindow;
      emu.postMessage(target, WM_KEYDOWN, vk, lParam);
      // Also send WM_CHAR for printable characters
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
        emu.postMessage(target, WM_CHAR, e.key.charCodeAt(0), lParam);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!focused) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const emu = emuRef.current;
      if (!emu || !emu.mainWindow) return;
      const keyToVK = getKeyToVK();
      const vk = keyToVK[e.code];
      if (vk === undefined) return;
      e.preventDefault();
      emu.keyStates.delete(vk);
      const scanCode = e.keyCode & 0xFF;
      const lParam = 1 | (scanCode << 16) | (3 << 30); // transition + previous state
      emu.postMessage(emu.focusedWindow || emu.mainWindow, WM_KEYUP, vk, lParam);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [focused]);

  const handleMenuCommand = useCallback((id: number) => {
    const emu = emuRef.current;
    if (!emu || !emu.mainWindow) return;
    emu.postMessage(emu.mainWindow, WM_COMMAND, id, 0);
  }, []);

  const handleMenuOpen = useCallback((index: number) => {
    const emu = emuRef.current;
    if (!emu || !emu.mainWindow) return;
    const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
    if (!wnd?.wndProc) return;
    const hMenu = wnd.hMenu || 0;
    console.log(`[MENU] handleMenuOpen index=${index} hMenu=0x${hMenu.toString(16)} wndProc=0x${wnd.wndProc.toString(16)}`);
    // Sync DOM textarea selection to emulator state before WM_INITMENU
    // (apps like Notepad call EM_GETSEL during WM_INITMENU to enable/disable Cut/Copy/Delete)
    for (const [, child] of emu.handles.findByType<WindowInfo>('window')) {
      if (child.classInfo?.className?.toUpperCase() === 'EDIT' && child.domInput) {
        child.editSelStart = child.domInput.selectionStart ?? 0;
        child.editSelEnd = child.domInput.selectionEnd ?? 0;
      }
    }
    // Send WM_INITMENU (some apps use this) then WM_INITMENUPOPUP
    const savedESP = emu.cpu.reg[4];
    const savedEIP = emu.cpu.eip;
    const savedWaiting = emu.waitingForMessage;
    emu.waitingForMessage = false;
    const callWndProc = emu.isNE
      ? (wp: number, hw: number, m: number, w: number, l: number) => emu.callWndProc16(wp, hw, m, w, l)
      : (wp: number, hw: number, m: number, w: number, l: number) => emu.callWndProc(wp, hw, m, w, l);
    callWndProc(wnd.wndProc, emu.mainWindow, WM_INITMENU, hMenu, 0);
    // Get submenu handle for INITMENUPOPUP
    const menuData = hMenu ? emu.handles.get<{ items: { hSubMenu: number }[] }>(hMenu) : null;
    const hSubMenu = menuData?.items?.[index]?.hSubMenu || 0;
    callWndProc(wnd.wndProc, emu.mainWindow, WM_INITMENUPOPUP, hSubMenu, index);
    emu.cpu.reg[4] = savedESP;
    emu.cpu.eip = savedEIP;
    emu.waitingForMessage = savedWaiting;
  }, []);

  const onTitleBarMouseDown = useCallback((e: PointerEvent) => {
    // Don't start drag on caption buttons
    if ((e.target as HTMLElement).closest('span[style*="border"]')) return;
    if (maximized) return;
    e.preventDefault();
    moveDrag.current = { startX: e.clientX, startY: e.clientY, startPosX: windowPos.x, startPosY: windowPos.y };
  }, [windowPos, maximized]);

  const handleMinimize = useCallback(() => {
    const emu = emuRef.current;
    if (emu?.mainWindow) {
      emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_MINIMIZE, 0);
    }
    // Don't set minimized on the window — let the taskbar handle hiding via minimizedProp
    onMinimize?.();
  }, [onMinimize]);

  const handleMaximize = useCallback(() => {
    const emu = emuRef.current;
    if (!emu || !emu.mainWindow) return;
    if (maximized) {
      // Restore
      emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_RESTORE, 0);
      const saved = preMaxState.current;
      if (saved) {
        setWindowPos({ x: saved.x, y: saved.y });
        setCanvasSize({ w: saved.w, h: saved.h });
        preMaxState.current = null;
        // Defer so state settles before applying to emu
        setTimeout(() => applyCanvasToEmu(saved.w, saved.h), 0);
      }
      const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
      if (wnd) {
        if (saved) { wnd.x = saved.x; wnd.y = saved.y; }
        wnd.minimized = false; wnd.maximized = false;
      }
      setMaximized(false);
      setMinimized(false);
    } else {
      // Maximize
      emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_MAXIMIZE, 0);
      preMaxState.current = { x: windowPos.x, y: windowPos.y, w: canvasSize.w, h: canvasSize.h };
      const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
      const hasCaption = wnd ? (wnd.style & WS_CAPTION) === WS_CAPTION : true;
      const captionH = hasCaption ? 21 : 0;
      const menuH = (menus.length > 0) ? 20 : 0;
      const TASKBAR_HEIGHT = 30;
      const dw = window.innerWidth;
      const dh = window.innerHeight - captionH - menuH - TASKBAR_HEIGHT;
      setWindowPos({ x: 0, y: 0 });
      setCanvasSize({ w: dw, h: dh });
      setTimeout(() => applyCanvasToEmu(dw, dh), 0);
      if (wnd) { wnd.x = 0; wnd.y = 0; wnd.maximized = true; wnd.minimized = false; }
      setMaximized(true);
      setMinimized(false);
    }
  }, [maximized, windowPos, canvasSize, menus.length, applyCanvasToEmu]);

  const handleTitleBarDblClick = useCallback(() => {
    if (minimized) {
      const emu = emuRef.current;
      if (!emu || !emu.mainWindow) return;
      emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_RESTORE, 0);
      const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
      if (wnd) {
        wnd.minimized = false; wnd.maximized = false;
        wnd.needsPaint = true; wnd.needsErase = true;
        emu.onWindowChange?.(wnd);
      }
    } else if (windowStyle & WS_MAXIMIZEBOX) {
      handleMaximize();
    }
  }, [minimized, handleMaximize, windowStyle]);

  // System-menu Move: cursor becomes "move" and the window follows the pointer
  // until the user clicks to commit (or presses Escape to cancel).
  const handleSystemMove = useCallback(() => {
    if (maximized) return;
    const startW = isConsole ? 640 * consoleZoom : canvasSize.w;
    const captionH = 21;
    const startPos = { x: windowPos.x, y: windowPos.y };
    const onMove = (e: PointerEvent) => {
      setWindowPos({ x: e.clientX - startW / 2, y: Math.max(0, e.clientY - captionH / 2) });
    };
    const cleanup = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerdown', onCommit, true);
      document.removeEventListener('keydown', onKey);
      document.body.style.cursor = '';
    };
    const onCommit = (e: PointerEvent) => { e.preventDefault(); e.stopPropagation(); cleanup(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setWindowPos(startPos); cleanup(); }
    };
    document.body.style.cursor = 'move';
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerdown', onCommit, true);
    document.addEventListener('keydown', onKey);
  }, [maximized, isConsole, consoleZoom, canvasSize.w, windowPos]);

  // System-menu Size: pointer drives the window's bottom-right corner until
  // the user clicks to commit (or presses Escape to cancel). Only meaningful
  // when WS_THICKFRAME is set, which the menu enforces by graying the item.
  const handleSystemSize = useCallback(() => {
    if (maximized) return;
    const start = { x: windowPos.x, y: windowPos.y, w: canvasSize.w, h: canvasSize.h };
    const onMove = (e: PointerEvent) => {
      const newW = Math.max(120, e.clientX - start.x);
      const newH = Math.max(60, e.clientY - start.y - 21);
      setCanvasSize({ w: newW, h: newH });
    };
    const cleanup = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerdown', onCommit, true);
      document.removeEventListener('keydown', onKey);
      document.body.style.cursor = '';
    };
    const onCommit = (e: PointerEvent) => {
      e.preventDefault(); e.stopPropagation();
      cleanup();
      applyCanvasToEmu(canvasSize.w, canvasSize.h);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setCanvasSize({ w: start.w, h: start.h }); cleanup(); }
    };
    document.body.style.cursor = 'nwse-resize';
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerdown', onCommit, true);
    document.addEventListener('keydown', onKey);
  }, [maximized, windowPos, canvasSize, applyCanvasToEmu]);


  if (crashInfo) {
    const crashExeName = windowTitle || exeBaseName;
    return (
      <div onPointerDown={onFocus}>
        <MessageBox
          caption={`${crashExeName} - ${t().applicationError}`}
          text={`${t().crashMessage.replace('{0}', crashExeName)}\n\nReason:  ${crashInfo.description}\nAddress: ${crashInfo.eip}\n\n${t().clickOkToTerminate}`}
          icon={<MsgBoxIcon type={MB_ICONERROR} />}
          onDismiss={onStop}
        />
      </div>
    );
  }

  const hasModalDialog = !!(messageBoxes.length > 0 || dialogInfo || commonDialog);
  const parentFocused = focused && !hasModalDialog;

  // Keyboard isolation from the desktop: the desktop div keeps DOM focus by
  // default, so every keydown while typing into the emulator ALSO fired the
  // desktop's onKeyDown (icon arrow-navigation, Enter re-launching the
  // selected icon). Hold DOM focus on this window's root while it is the
  // focused app — keydown events then target this div and never reach the
  // desktop's handler. Form fields (DOM EDIT overlays, rename inputs) keep
  // their focus: never steal from them.
  const grabDomFocus = useCallback((e?: PointerEvent) => {
    onFocus();
    const target = (e?.target as HTMLElement | null) ?? null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    desktopRef.current?.focus({ preventScroll: true });
  }, [onFocus]);

  useEffect(() => {
    if (!focused) return;
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName)) return;
    desktopRef.current?.focus({ preventScroll: true });
  }, [focused]);

  // Programs like winver.exe / ssmaze.scr /c have no main window — only show the message box / dialog
  if (!hasMainWindow && !isConsole && windowReady) {
    return (
      <>
        {dialogInfo && (
          <EmulatorDialog
            info={dialogInfo}
            emuRef={emuRef}
            focused={focused}
            lang={detectedLang}
            onDismiss={(action, values) => {
              emuRef.current?.dismissDialog(action, values);
              setDialogInfo(null);
            }}
          />
        )}
        {messageBoxes.map(mb => (
          <MessageBox
            key={mb.id}
            caption={mb.caption}
            text={mb.text}
            type={mb.type}
            focused={focused}
            onDismiss={(btnId) => {
              const isExit = mb.isExit;
              emuRef.current?.dismissMessageBox(mb.id, btnId);
              setMessageBoxes(prev => prev.filter(m => m.id !== mb.id));
              if (isExit) onStop();
            }}
          />
        ))}
        {commonDialog?.type === 'about' && (
          <AboutDialog
            caption={commonDialog.caption}
            extraInfo={commonDialog.extraInfo}
            otherText={commonDialog.otherText}
            focused={focused}
            flashTrigger={modalFlashTrigger}
            onDismiss={() => { commonDialog.onDismiss(); setCommonDialog(null); }}
          />
        )}
        {commonDialog?.type === 'find' && (
          <FindDialog
            findTerm={findTerm}
            onTermChange={setFindTerm}
            onFindNext={handleFindNext}
            onClose={() => { commonDialog.onClose(); setCommonDialog(null); setFindTerm(''); }}
            focused={focused}
          />
        )}
        {commonDialog?.type === 'find-replace' && (
          <FindReplaceDialog
            findTerm={findTerm}
            replaceTerm={replaceTerm}
            onFindChange={setFindTerm}
            onReplaceChange={setReplaceTerm}
            onFindNext={handleFindNext}
            onReplace={handleReplace}
            onReplaceAll={handleReplaceAll}
            onClose={() => { commonDialog.onClose(); setCommonDialog(null); setFindTerm(''); setReplaceTerm(''); }}
            focused={focused}
          />
        )}
        {(commonDialog?.type === 'file-open' || commonDialog?.type === 'file-save') && emuRef.current && (
          <FileDialog
            mode={commonDialog.type === 'file-open' ? 'open' : 'save'}
            filter={commonDialog.filter}
            initialFileName={commonDialog.type === 'file-save' ? commonDialog.defaultName : undefined}
            fileManager={emuRef.current.fs}
            additionalFiles={emuRef.current.additionalFiles}
            focused={focused}
            onResult={(result) => { commonDialog.onResult(result); setCommonDialog(null); }}
          />
        )}
      </>
    );
  }

  // Console window is always 640×480 — text modes scale their natural 720×400
  // (or 640×400) surface up to fill the 4:3 client area, matching real CRTs.
  const consoleClientH = 480 * consoleZoom;
  void consoleLayoutBump; // dependency: re-evaluate when the layout changes

  return (
    <div ref={desktopRef} tabIndex={-1} style={{ position: 'absolute', left: `${windowPos.x}px`, top: `${windowPos.y}px`, zIndex, visibility: windowReady ? 'visible' : 'hidden', display: minimizedProp ? 'none' : undefined, touchAction: 'none', outline: 'none' }} onPointerDown={grabDomFocus}>
      <Window
        title={windowTitle}
        style={windowStyle}
        clientW={isConsole ? 640 * consoleZoom : canvasSize.w}
        clientH={isConsole ? consoleClientH : canvasSize.h}
        iconUrl={iconUrl}
        iconElement={!iconUrl ? EXE_ICON_16 : undefined}
        focused={parentFocused}
        maximized={maximized}
        minimized={false}
        blocked={hasModalDialog}
        onBlockedClick={flashModal}
        menus={
          <div style={{ position: 'relative' }}>
            <MenuBar menus={menus} onCommand={handleMenuCommand} onFocus={onFocus} onMenuOpen={handleMenuOpen} />
            <canvas
              ref={(el: HTMLCanvasElement | null) => {
                ncCanvasRef.current = el;
                if (emuRef.current) emuRef.current.ncCanvas = el;
              }}
              height={19}
              style={{ position: 'absolute', left: 0, top: 0, height: '19px', pointerEvents: 'none', imageRendering: 'pixelated' }}
            />
          </div>
        }
        onClose={() => {
          const emu = emuRef.current;
          if (emu?.mainWindow) {
            emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_CLOSE, 0);
          } else {
            onStop();
          }
        }}
        onMinimize={handleMinimize}
        onMaximize={handleMaximize}
        onTitleBarMouseDown={onTitleBarMouseDown}
        onTitleBarDblClick={handleTitleBarDblClick}
        onResizeStart={onResizeStart}
        onZoomToggle={isConsole ? () => setConsoleZoom(z => z === 1 ? 2 : 1) : undefined}
        zoomActive={consoleZoom > 1}
        onSmoothToggle={isConsole ? () => setConsoleSmooth(s => !s) : undefined}
        smoothActive={consoleSmooth}
        onFullscreenToggle={isConsole ? handleFullscreenToggle : undefined}
        fullscreenActive={isFullscreen}
        onSystemMove={handleSystemMove}
        onSystemSize={handleSystemSize}
        lang={detectedLang}
      >
        <div
          style={{ width: '100%', height: '100%' }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            mouseIsDown.current = true;
            if (e.button === 0) handlePointerEvent(e, e.detail >= 2 ? WM_LBUTTONDBLCLK : WM_LBUTTONDOWN);
            else if (e.button === 2) handlePointerEvent(e, e.detail >= 2 ? WM_RBUTTONDBLCLK : WM_RBUTTONDOWN);
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {isConsole && emuRef.current ? (
            <div
              ref={fsWrapperRef}
              style={isFullscreen ? {
                width: '100vw', height: '100vh',
                background: '#000',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              } : undefined}
            >
              <div style={isFullscreen ? { transform: `scale(${fsScale})`, transformOrigin: 'center' } : undefined}>
                <ConsoleView emu={emuRef.current} focused={focused} zoom={consoleZoom} smooth={consoleSmooth} onScreenLayoutChange={handleScreenLayoutChange} />
              </div>
            </div>
          ) : (
            <canvas
              ref={canvasRef}
              style={{ imageRendering: 'pixelated', cursor: 'var(--win2k-cursor)', display: 'block', position: 'relative', zIndex: 0, backgroundColor: 'white' }}
              onPointerDown={(e) => {
                e.preventDefault();
                mouseIsDown.current = true;
                if (e.button === 0) handlePointerEvent(e, e.detail >= 2 ? WM_LBUTTONDBLCLK : WM_LBUTTONDOWN);
                else if (e.button === 2) handlePointerEvent(e, e.detail >= 2 ? WM_RBUTTONDBLCLK : WM_RBUTTONDOWN);
              }}
              onPointerMove={(e) => {
                if (mdiDrag.current || mdiResize.current) return;
                if (!mouseIsDown.current) handlePointerEvent(e, WM_MOUSEMOVE);
              }}
              onContextMenu={(e) => e.preventDefault()}
            />
          )}
          {!isConsole && controlOverlays.map((ctrl, idx) =>
            ctrl.isMdiChild
              ? renderMdiChildOverlay(ctrl, emuRef, setPressedControl, pressedControl, onResizeStart, mdiDrag, mdiResize, 15 + idx)
              : renderControlOverlay(ctrl, emuRef, setPressedControl, pressedControl, onResizeStart)
          )}
        </div>
      </Window>
      {dialogInfo && (
        <EmulatorDialog
          info={dialogInfo}
          emuRef={emuRef}
          focused={focused}
          flashTrigger={modalFlashTrigger}
          parentRef={desktopRef}
          lang={detectedLang}
          onDismiss={(action, values) => {
            emuRef.current?.dismissDialog(action, values);
            setDialogInfo(null);
          }}
        />
      )}
      {messageBoxes.map(mb => (
        <MessageBox
          key={mb.id}
          caption={mb.caption}
          text={mb.text}
          type={mb.type}
          focused={focused}
          flashTrigger={modalFlashTrigger}
          parentRef={desktopRef}
          onDismiss={(btnId) => {
            emuRef.current?.dismissMessageBox(mb.id, btnId);
            setMessageBoxes(prev => prev.filter(m => m.id !== mb.id));
          }}
        />
      ))}
      {commonDialog?.type === 'about' && (
        <AboutDialog
          caption={commonDialog.caption}
          extraInfo={commonDialog.extraInfo}
          otherText={commonDialog.otherText}
          focused={focused}
          flashTrigger={modalFlashTrigger}
          parentRef={desktopRef}
          onDismiss={() => { commonDialog.onDismiss(); setCommonDialog(null); }}
        />
      )}
      {commonDialog?.type === 'find' && (
        <FindDialog
          findTerm={findTerm}
          onTermChange={setFindTerm}
          onFindNext={handleFindNext}
          onClose={() => { commonDialog.onClose(); setCommonDialog(null); setFindTerm(''); }}
          focused={focused}
          parentRef={desktopRef}
        />
      )}
      {commonDialog?.type === 'find-replace' && (
        <FindReplaceDialog
          findTerm={findTerm}
          replaceTerm={replaceTerm}
          onFindChange={setFindTerm}
          onReplaceChange={setReplaceTerm}
          onFindNext={handleFindNext}
          onReplace={handleReplace}
          onReplaceAll={handleReplaceAll}
          onClose={() => { commonDialog.onClose(); setCommonDialog(null); setFindTerm(''); setReplaceTerm(''); }}
          focused={focused}
          parentRef={desktopRef}
        />
      )}
      {(commonDialog?.type === 'file-open' || commonDialog?.type === 'file-save') && emuRef.current && (
        <FileDialog
          mode={commonDialog.type === 'file-open' ? 'open' : 'save'}
          filter={commonDialog.filter}
          initialFileName={commonDialog.type === 'file-save' ? commonDialog.defaultName : undefined}
          fileManager={emuRef.current.fs}
          additionalFiles={emuRef.current.additionalFiles}
          focused={focused}
          parentRef={desktopRef}
          onResult={(result) => { commonDialog.onResult(result); setCommonDialog(null); }}
        />
      )}
    </div>
  );
}
