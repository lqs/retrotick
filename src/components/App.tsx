import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import {
  parsePE, extractBitmaps, extractIcons, extractCursors, extractMenus,
  extractDialogs, extractDelphiForms, extractAccelerators, extractAvi,
  extractWav, extractStrings, extractManifests, extractVersionInfo,
  extractImports, extractExports,
} from '../lib/pe';
import type {
  PEInfo, BitmapResult, IconResult, CursorResult, MenuResult,
  DialogResult, DfmResult, AccelResult, AviResult, WavResult,
  StringResult, ManifestResult, VersionResult,
  ImportResult, ExportResult,
} from '../lib/pe';
import { dibToTransparentBlob } from '../lib/image';
import { useBlobUrls } from '../hooks/useBlobUrls';
import type { ResUrls } from './DialogDisplay';
import { EmulatorView } from './EmulatorView';
import { ResourceViewerWindow } from './ResourceViewerWindow';
import { HelpViewerWindow } from './HelpViewerWindow';
import { FolderWindow } from './FolderWindow';
import { WelcomeWindow } from './WelcomeWindow';
import { RegionalSettingsWindow } from './RegionalSettingsWindow';
import { DosSettingsWindow } from './DosSettingsWindow';
import { GeneralSettingsWindow } from './GeneralSettingsWindow';
import { Desktop } from './Desktop';
import { Taskbar } from './win2k/Taskbar';
import { FOLDER_ICON_16, EXE_ICON_16 } from './DesktopIcon';
import { MessageBox, MB_OK, MB_YESNO, MB_ICONQUESTION, MB_ICONERROR, IDYES } from './win2k/MessageBox';
import { exportWorkbench, importWorkbench, downloadWorkbench, pickWorkbenchFile, type WorkbenchProgress } from '../lib/workbench';
import { downloadSingleFile, downloadItemsAsZip, shouldDownloadAsZip, type DownloadItem } from '../lib/download';
import { ProgressDialog } from './win2k/ProgressDialog';
import { ProcessRegistry } from '../lib/emu/emulator';
import type { Emulator } from '../lib/emu/emulator';
import { displayName, listFileMetadata, getFile } from '../lib/file-store';
import { isExeFile } from '../lib/file-utils';
import { useClipboard } from '../hooks/useClipboard';
import { detectPELanguageId, langToHtmlLang } from '../lib/lang';
import { t } from '../lib/regional-settings';
import { DisplayPropertiesDialog } from './DisplayPropertiesDialog';
import type { BackgroundSettings } from './DisplayPropertiesDialog';

interface ResourceViewerApp {
  id: number;
  data: LoadedData;
  exeName: string;
}

interface HelpViewerApp {
  id: number;
  fileBytes: ArrayBuffer;
  fileName: string;
}

interface RunningApp {
  id: number;
  arrayBuffer: ArrayBuffer;
  peInfo: PEInfo;
  additionalFiles?: Map<string, ArrayBuffer>;
  exeName: string;
  commandLine?: string;
  onSetupEmulator?: (emu: Emulator) => void;
}

interface OpenFolder {
  id: number;
  path: string;
}

export interface LoadedData {
  peInfo: PEInfo;
  arrayBuffer: ArrayBuffer;
  bitmaps: BitmapResult[];
  icons: IconResult[];
  cursors: CursorResult[];
  menus: MenuResult[];
  dialogs: DialogResult[];
  delphiForms: DfmResult[];
  accelerators: AccelResult[];
  aviResources: AviResult[];
  wavResources: WavResult[];
  strings: StringResult[];
  manifests: ManifestResult[];
  versionInfos: VersionResult[];
  imports: ImportResult[];
  exports: ExportResult | null;
  resUrls: ResUrls;
}

function isExecutable(peInfo: PEInfo, fileName?: string): boolean {
  if (peInfo.isNE) return true;
  const isDll = !!(peInfo.coffHeader.characteristics & 0x2000);
  if (isDll && fileName?.toLowerCase().endsWith('.cpl')) return true;
  return !isDll && peInfo.coffHeader.machine === 0x014C;
}

export function App() {
  const [runningApps, setRunningApps] = useState<RunningApp[]>([]);
  const [resourceViewers, setResourceViewers] = useState<ResourceViewerApp[]>([]);
  const [helpViewers, setHelpViewers] = useState<HelpViewerApp[]>([]);
  const [openFolders, setOpenFolders] = useState<OpenFolder[]>([]);
  const [focusedAppId, setFocusedAppId] = useState<number | null>(-1);
  const focusHistory = useRef<number[]>([]);
  const [loadingAppIds, setLoadingAppIds] = useState<Set<number>>(new Set());
  const [windowTitles, setWindowTitles] = useState<Map<number, string>>(new Map());
  const [windowIcons, setWindowIcons] = useState<Map<number, string | null>>(new Map());
  const [appLangs, setAppLangs] = useState<Map<number, string | null>>(new Map());
  const [minimizedApps, setMinimizedApps] = useState<Set<number>>(new Set());
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem('welcome-dismissed'));
  const [showRegionalSettings, setShowRegionalSettings] = useState(false);
  const [showDosSettings, setShowDosSettings] = useState(false);
  const [showGeneralSettings, setShowGeneralSettings] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ text: string; onYes: () => void } | null>(null);
  const [infoDialog, setInfoDialog] = useState<{ text: string; isError?: boolean } | null>(null);
  const [workbenchProgress, setWorkbenchProgress] = useState<{ caption: string; progress: WorkbenchProgress } | null>(null);
  const [showDisplayProperties, setShowDisplayProperties] = useState(false);
  const [taskmgrPath, setTaskmgrPath] = useState<string | null>(null);
  const [bgSettings, setBgSettings] = useState<BackgroundSettings>(() => {
    const saved = localStorage.getItem('bg-settings');
    if (saved) {
      try { return JSON.parse(saved); } catch {}
    }
    return { color: '#3A6EA5', imageDataUrl: null, imageName: null, mode: 'center' as const };
  });
  const welcomeId = useRef(-1);
  const regionalSettingsId = useRef(-2);
  const dosSettingsId = useRef(-3);
  const generalSettingsId = useRef(-4);
  const nextAppId = useRef(1);
  const processRegistry = useRef(new ProcessRegistry()).current;
  const closeHandlers = useRef(new Map<number, () => void>());
  const { createUrl } = useBlobUrls();
  const { clipboard, cut: clipCut, copy: clipCopy, paste: clipPaste } = useClipboard();
  const audioContextRef = useRef<AudioContext | null>(null);

  /** Get or create the shared AudioContext. */
  const ensureAudioContext = useCallback(() => {
    let ctx = audioContextRef.current;
    if (!ctx) {
      ctx = new AudioContext();
      audioContextRef.current = ctx;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }, []);

  // Create AudioContext on first user gesture (click/keydown/pointerdown)
  useEffect(() => {
    const handler = () => {
      ensureAudioContext();
      document.removeEventListener('click', handler);
      document.removeEventListener('keydown', handler);
      document.removeEventListener('pointerdown', handler);
    };
    document.addEventListener('click', handler);
    document.addEventListener('keydown', handler);
    document.addEventListener('pointerdown', handler);
    return () => {
      document.removeEventListener('click', handler);
      document.removeEventListener('keydown', handler);
      document.removeEventListener('pointerdown', handler);
    };
  }, [ensureAudioContext]);

  const focusApp = useCallback((id: number | null) => {
    if (id !== null) {
      focusHistory.current = focusHistory.current.filter(h => h !== id);
      focusHistory.current.push(id);
    }
    setFocusedAppId(id);
  }, []);

  const getZIndex = useCallback((id: number) => {
    const idx = focusHistory.current.indexOf(id);
    return 100 + (idx >= 0 ? idx : 0);
  }, []);

  const handleRunExe = useCallback((arrayBuffer: ArrayBuffer, peInfo: PEInfo, additionalFiles?: Map<string, ArrayBuffer>, exeName: string = 'unknown', commandLine?: string, onSetupEmulator?: (emu: Emulator) => void) => {
    // Create/resume AudioContext during this user gesture (double-click on EXE)
    ensureAudioContext();
    const id = nextAppId.current++;
    const langId = detectPELanguageId(peInfo.resources);
    const htmlLang = langToHtmlLang(langId);
    setRunningApps(prev => [...prev, { id, arrayBuffer, peInfo, additionalFiles, exeName, commandLine, onSetupEmulator }]);
    setAppLangs(prev => new Map(prev).set(id, htmlLang));
    setLoadingAppIds(prev => new Set(prev).add(id));
    focusApp(id);
  }, [focusApp, ensureAudioContext]);

  const handleOpenHelp = useCallback((arrayBuffer: ArrayBuffer, fileName: string) => {
    const id = nextAppId.current++;
    setHelpViewers(prev => [...prev, { id, fileBytes: arrayBuffer, fileName }]);
    setWindowTitles(prev => new Map(prev).set(id, fileName));
    focusApp(id);
  }, [focusApp]);

  const handleViewResources = useCallback(async (arrayBuffer: ArrayBuffer, fileName?: string) => {
    // .hlp files take a separate path
    if (fileName && fileName.toLowerCase().endsWith('.hlp')) {
      handleOpenHelp(arrayBuffer, fileName);
      return;
    }
    try {
      const peInfo = parsePE(arrayBuffer);
      const bitmaps = extractBitmaps(peInfo, arrayBuffer);
      const icons = extractIcons(peInfo, arrayBuffer);
      const cursors = extractCursors(peInfo, arrayBuffer);
      const menus = extractMenus(peInfo, arrayBuffer);
      const delphiForms = extractDelphiForms(peInfo, arrayBuffer);
      const dialogs = extractDialogs(peInfo, arrayBuffer);
      const accelerators = extractAccelerators(peInfo, arrayBuffer);
      const aviResources = extractAvi(peInfo, arrayBuffer);
      const wavResources = extractWav(peInfo, arrayBuffer);
      const strings = extractStrings(peInfo, arrayBuffer);
      const manifests = extractManifests(peInfo, arrayBuffer);
      const versionInfos = extractVersionInfo(peInfo, arrayBuffer);
      const imports = extractImports(peInfo, arrayBuffer);
      const exports = extractExports(peInfo, arrayBuffer);

      const resUrls: ResUrls = { icons: new Map(), bitmaps: new Map(), appIconUrl: null };
      for (const icon of icons) {
        const url = createUrl(icon.blob);
        if (icon.id != null) resUrls.icons.set(icon.id, url);
        if (icon.name != null) resUrls.icons.set(icon.name, url);
        if (!resUrls.appIconUrl) resUrls.appIconUrl = url;
      }
      const bmpTransparentPromises: Promise<void>[] = [];
      for (const bmp of bitmaps) {
        if (bmp.magentaIndex >= 0 && bmp.dibData) {
          bmpTransparentPromises.push(
            dibToTransparentBlob(bmp.dibData).then(pngBlob => {
              const url = createUrl(pngBlob || bmp.bmpBlob);
              resUrls.bitmaps.set(bmp.id!, url);
            }),
          );
        } else {
          const url = createUrl(bmp.bmpBlob);
          resUrls.bitmaps.set(bmp.id!, url);
        }
      }
      await Promise.all(bmpTransparentPromises);

      const data: LoadedData = {
        peInfo, arrayBuffer, bitmaps, icons, cursors, menus, dialogs, delphiForms,
        accelerators, aviResources, wavResources, strings, manifests, versionInfos,
        imports, exports, resUrls,
      };

      const id = nextAppId.current++;
      const exeName = fileName || 'unknown.exe';
      setResourceViewers(prev => [...prev, { id, data, exeName }]);
      setWindowTitles(prev => new Map(prev).set(id, exeName));
      setWindowIcons(prev => new Map(prev).set(id, resUrls.appIconUrl));
      focusApp(id);
    } catch (err: unknown) {
      console.error('Failed to parse PE:', err instanceof Error ? err.message : String(err));
    }
  }, [createUrl, focusApp]);

  const handleOpenFolder = useCallback((path: string) => {
    const id = nextAppId.current++;
    setOpenFolders(prev => [...prev, { id, path }]);
    setWindowTitles(prev => new Map(prev).set(id, displayName(path)));
    focusApp(id);
  }, [focusApp]);

  const handleStopApp = useCallback((id: number) => {
    setRunningApps(prev => prev.filter(a => a.id !== id));
    setResourceViewers(prev => prev.filter(a => a.id !== id));
    setHelpViewers(prev => prev.filter(a => a.id !== id));
    setOpenFolders(prev => prev.filter(a => a.id !== id));
    setLoadingAppIds(prev => { const s = new Set(prev); s.delete(id); return s; });
    setWindowTitles(prev => { const m = new Map(prev); m.delete(id); return m; });
    setWindowIcons(prev => { const m = new Map(prev); m.delete(id); return m; });
    setAppLangs(prev => { const m = new Map(prev); m.delete(id); return m; });
    setMinimizedApps(prev => { const s = new Set(prev); s.delete(id); return s; });
    focusHistory.current = focusHistory.current.filter(h => h !== id);
    setFocusedAppId(prev => prev === id ? (focusHistory.current[focusHistory.current.length - 1] ?? null) : prev);
    closeHandlers.current.delete(id);
  }, []);

  const handleRequestClose = useCallback((id: number) => {
    if (id === welcomeId.current) {
      setShowWelcome(false);
      setMinimizedApps(prev => { const s = new Set(prev); s.delete(id); return s; });
      setFocusedAppId(prev => prev === id ? null : prev);
      return;
    }
    if (id === regionalSettingsId.current) {
      setShowRegionalSettings(false);
      setMinimizedApps(prev => { const s = new Set(prev); s.delete(id); return s; });
      setFocusedAppId(prev => prev === id ? null : prev);
      return;
    }
    const handler = closeHandlers.current.get(id);
    if (handler) handler();
    else handleStopApp(id);
  }, [handleStopApp]);

  const handleAppReady = useCallback((id: number) => {
    setLoadingAppIds(prev => { const s = new Set(prev); s.delete(id); return s; });
  }, []);

  const handleFocusApp = useCallback((id: number) => {
    focusApp(id);
  }, [focusApp]);

  const handleTaskbarActivate = useCallback((id: number) => {
    setMinimizedApps(prev => { const s = new Set(prev); s.delete(id); return s; });
    focusApp(id);
  }, [focusApp]);

  const handleTaskbarMinimize = useCallback((id: number) => {
    setMinimizedApps(prev => new Set(prev).add(id));
    setFocusedAppId(prev => {
      if (prev !== id) return prev;
      for (let i = focusHistory.current.length - 1; i >= 0; i--) {
        const h = focusHistory.current[i];
        if (h !== id) return h;
      }
      return null;
    });
  }, []);

  const handleExportWorkbench = useCallback(async () => {
    const caption = t().workbenchExporting;
    setWorkbenchProgress({ caption, progress: { phase: 'reading', current: 0, total: 1 } });
    try {
      const bytes = await exportWorkbench(p => setWorkbenchProgress({ caption, progress: p }));
      downloadWorkbench(bytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setInfoDialog({ text: t().workbenchImportFailed.replace('{0}', msg), isError: true });
    } finally {
      setWorkbenchProgress(null);
    }
  }, []);

  const handleDownloadItems = useCallback(async (items: DownloadItem[]) => {
    if (items.length === 0) return;
    if (!shouldDownloadAsZip(items)) {
      try {
        await downloadSingleFile(items[0].name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setInfoDialog({ text: t().downloadFailed.replace('{0}', msg), isError: true });
      }
      return;
    }
    const caption = t().downloadingZip;
    setWorkbenchProgress({ caption, progress: { phase: 'reading', current: 0, total: 1 } });
    try {
      await downloadItemsAsZip(items, p => setWorkbenchProgress({ caption, progress: p }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setInfoDialog({ text: t().downloadFailed.replace('{0}', msg), isError: true });
    } finally {
      setWorkbenchProgress(null);
    }
  }, []);

  const handleImportWorkbench = useCallback(() => {
    setConfirmDialog({
      text: t().confirmImportWorkbench,
      onYes: async () => {
        const file = await pickWorkbenchFile();
        if (!file) return;
        const caption = t().workbenchImporting;
        setWorkbenchProgress({ caption, progress: { phase: 'loading', current: 0, total: file.size } });
        try {
          await importWorkbench(file, p => setWorkbenchProgress({ caption, progress: p }));
          location.reload();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setInfoDialog({ text: t().workbenchImportFailed.replace('{0}', msg), isError: true });
        } finally {
          setWorkbenchProgress(null);
        }
      },
    });
  }, []);

  const refreshTaskmgr = useCallback(async () => {
    const metas = await listFileMetadata();
    const found = metas.find(m => m.name.toLowerCase().replace(/^.*\//, '') === 'taskmgr.exe');
    setTaskmgrPath(found?.name ?? null);
  }, []);

  useEffect(() => {
    refreshTaskmgr();
    const onChange = () => refreshTaskmgr();
    window.addEventListener('desktop-files-changed', onChange);
    return () => window.removeEventListener('desktop-files-changed', onChange);
  }, [refreshTaskmgr]);

  const handleLaunchTaskmgr = useCallback(async () => {
    if (!taskmgrPath) return;
    const data = await getFile(taskmgrPath);
    if (!data) return;
    const result = isExeFile(data, taskmgrPath);
    if (!result.ok || !result.peInfo) return;
    const metas = await listFileMetadata();
    const dllExts = new Set(['dll', 'ocx', 'drv', 'vxd', 'cpl']);
    const siblingDlls = metas.filter(m =>
      m.name !== taskmgrPath && !m.name.includes('/') &&
      dllExts.has((m.name.split('.').pop() ?? '').toLowerCase()));
    const additional = new Map<string, ArrayBuffer>();
    await Promise.all(siblingDlls.map(async m => {
      const buf = await getFile(m.name);
      if (buf) additional.set(m.name, buf);
    }));
    handleRunExe(data, result.peInfo, additional.size > 0 ? additional : undefined, taskmgrPath);
  }, [taskmgrPath, handleRunExe]);

  const handleBgApply = useCallback((settings: BackgroundSettings) => {
    setBgSettings(settings);
    localStorage.setItem('bg-settings', JSON.stringify(settings));
  }, []);

  const allApps = [
    ...runningApps.filter(app => !loadingAppIds.has(app.id)).map(app => ({
      id: app.id,
      title: windowTitles.get(app.id) || app.exeName,
      iconUrl: windowIcons.get(app.id),
      iconElement: !windowIcons.get(app.id) ? EXE_ICON_16 : undefined,
      minimized: minimizedApps.has(app.id),
      lang: appLangs.get(app.id) || undefined,
    })),
    ...resourceViewers.map(app => ({
      id: app.id,
      title: windowTitles.get(app.id) || app.exeName,
      iconUrl: windowIcons.get(app.id),
      iconElement: !windowIcons.get(app.id) ? EXE_ICON_16 : undefined,
      minimized: minimizedApps.has(app.id),
    })),
    ...helpViewers.map(app => ({
      id: app.id,
      title: windowTitles.get(app.id) || app.fileName,
      iconUrl: null as string | null | undefined,
      iconElement: EXE_ICON_16,
      minimized: minimizedApps.has(app.id),
    })),
    ...openFolders.map(folder => ({
      id: folder.id,
      title: windowTitles.get(folder.id) || displayName(folder.path),
      iconUrl: null as string | null | undefined,
      iconElement: FOLDER_ICON_16,
      minimized: minimizedApps.has(folder.id),
    })),
    ...(showWelcome ? [{
      id: welcomeId.current,
      title: t().welcomeTitle,
      iconUrl: null as string | null | undefined,
      minimized: minimizedApps.has(welcomeId.current),
    }] : []),
    ...(showRegionalSettings ? [{
      id: regionalSettingsId.current,
      title: t().regionalSettings,
      iconUrl: null as string | null | undefined,
      minimized: minimizedApps.has(regionalSettingsId.current),
    }] : []),
    ...(showDosSettings ? [{
      id: dosSettingsId.current,
      title: t().dosSettings,
      iconUrl: null as string | null | undefined,
      minimized: minimizedApps.has(dosSettingsId.current),
    }] : []),
    ...(showGeneralSettings ? [{
      id: generalSettingsId.current,
      title: t().generalSettings,
      iconUrl: null as string | null | undefined,
      minimized: minimizedApps.has(generalSettingsId.current),
    }] : []),
  ];

  useEffect(() => {
    const focused = allApps.find(a => a.id === focusedAppId);
    document.title = focused ? `${focused.title} - RetroTick` : 'RetroTick';
  }, [focusedAppId, windowTitles, allApps]);

  // Dev/E2E hook: launch an EXE by ArrayBuffer directly (Playwright verification).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as typeof window & { __runExe?: (ab: ArrayBuffer, name: string, extra?: Record<string, ArrayBuffer>, commandLine?: string) => void }).__runExe =
      (ab, name, extra, commandLine) => {
        const peInfo = parsePE(ab);
        const additional = extra ? new Map(Object.entries(extra)) : undefined;
        handleRunExe(ab, peInfo, additional, name, commandLine);
      };
  }, [handleRunExe]);

  return (
    <div class="w-full h-screen" style={{ display: 'flex', flexDirection: 'column', cursor: loadingAppIds.size > 0 ? 'progress' : undefined }}>
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
        <div style={{
          position: 'absolute', inset: 0, overflow: 'auto',
          backgroundColor: bgSettings.color,
          ...(bgSettings.imageDataUrl ? {
            backgroundImage: `url(${bgSettings.imageDataUrl})`,
            backgroundRepeat: bgSettings.mode === 'tile' ? 'repeat' : 'no-repeat',
            backgroundPosition: 'center',
            backgroundSize: bgSettings.mode === 'stretch' ? '100% 100%' : bgSettings.mode === 'tile' ? 'auto' : 'contain',
          } : {}),
        }} onPointerDown={() => setFocusedAppId(null)}>
          <Desktop onRunExe={handleRunExe} onViewResources={handleViewResources} onOpenFolder={handleOpenFolder}
            onShowDisplayProperties={() => setShowDisplayProperties(true)}
            onDownload={handleDownloadItems}
            clipboard={clipboard} onCut={clipCut} onCopy={clipCopy} onPaste={clipPaste} />
        </div>
        {runningApps.map((app) => (
          <EmulatorView
            key={app.id}
            arrayBuffer={app.arrayBuffer}
            peInfo={app.peInfo}
            additionalFiles={app.additionalFiles}
            exeName={app.exeName}
            commandLine={app.commandLine}
            onSetupEmulator={app.onSetupEmulator}
            processRegistry={processRegistry}
            audioContext={audioContextRef.current}
            onStop={() => handleStopApp(app.id)}
            onFocus={() => handleFocusApp(app.id)}
            onReady={() => handleAppReady(app.id)}
            onRunExe={handleRunExe}
            onOpenHelp={handleOpenHelp}
            onTitleChange={(title) => setWindowTitles(prev => new Map(prev).set(app.id, title))}
            onIconChange={(url) => setWindowIcons(prev => new Map(prev).set(app.id, url))}
            onMinimize={() => handleTaskbarMinimize(app.id)}
            onRegisterCloseHandler={(handler) => closeHandlers.current.set(app.id, handler)}
            zIndex={getZIndex(app.id)}
            focused={focusedAppId === app.id}
            minimized={minimizedApps.has(app.id)}
          />
        ))}
        {resourceViewers.map((app) => (
          <ResourceViewerWindow
            key={app.id}
            data={app.data}
            exeName={app.exeName}
            isExecutable={isExecutable(app.data.peInfo, app.exeName)}
            onStop={() => handleStopApp(app.id)}
            onFocus={() => handleFocusApp(app.id)}
            onMinimize={() => handleTaskbarMinimize(app.id)}
            onRunExe={handleRunExe}
            zIndex={getZIndex(app.id)}
            focused={focusedAppId === app.id}
            minimized={minimizedApps.has(app.id)}
          />
        ))}
        {helpViewers.map((app) => (
          <HelpViewerWindow
            key={app.id}
            fileBytes={app.fileBytes}
            fileName={app.fileName}
            onStop={() => handleStopApp(app.id)}
            onFocus={() => handleFocusApp(app.id)}
            onMinimize={() => handleTaskbarMinimize(app.id)}
            zIndex={getZIndex(app.id)}
            focused={focusedAppId === app.id}
            minimized={minimizedApps.has(app.id)}
          />
        ))}
        {openFolders.map((folder) => (
          <FolderWindow
            key={folder.id}
            folderPath={folder.path}
            onStop={() => handleStopApp(folder.id)}
            onFocus={() => handleFocusApp(folder.id)}
            onMinimize={() => handleTaskbarMinimize(folder.id)}
            onOpenFolder={handleOpenFolder}
            onRunExe={handleRunExe}
            onViewResources={handleViewResources}
            zIndex={getZIndex(folder.id)}
            focused={focusedAppId === folder.id}
            minimized={minimizedApps.has(folder.id)}
            clipboard={clipboard} onCut={clipCut} onCopy={clipCopy} onPaste={clipPaste}
            onDownload={handleDownloadItems}
          />
        ))}
        {showWelcome && (
          <WelcomeWindow
            onClose={() => { setShowWelcome(false); localStorage.setItem('welcome-dismissed', '1'); setMinimizedApps(prev => { const s = new Set(prev); s.delete(welcomeId.current); return s; }); setFocusedAppId(prev => prev === welcomeId.current ? null : prev); }}
            onFocus={() => focusApp(welcomeId.current)}
            onMinimize={() => handleTaskbarMinimize(welcomeId.current)}
            zIndex={getZIndex(welcomeId.current)}
            focused={focusedAppId === welcomeId.current}
            minimized={minimizedApps.has(welcomeId.current)}
          />
        )}
        {showRegionalSettings && (
          <RegionalSettingsWindow
            onClose={() => { setShowRegionalSettings(false); setMinimizedApps(prev => { const s = new Set(prev); s.delete(regionalSettingsId.current); return s; }); setFocusedAppId(prev => prev === regionalSettingsId.current ? null : prev); }}
            onFocus={() => focusApp(regionalSettingsId.current)}
            onMinimize={() => handleTaskbarMinimize(regionalSettingsId.current)}
            zIndex={getZIndex(regionalSettingsId.current)}
            focused={focusedAppId === regionalSettingsId.current}
            minimized={minimizedApps.has(regionalSettingsId.current)}
          />
        )}
        {showDosSettings && (
          <DosSettingsWindow
            onClose={() => { setShowDosSettings(false); setMinimizedApps(prev => { const s = new Set(prev); s.delete(dosSettingsId.current); return s; }); setFocusedAppId(prev => prev === dosSettingsId.current ? null : prev); }}
            onFocus={() => focusApp(dosSettingsId.current)}
            onMinimize={() => handleTaskbarMinimize(dosSettingsId.current)}
            zIndex={getZIndex(dosSettingsId.current)}
            focused={focusedAppId === dosSettingsId.current}
            minimized={minimizedApps.has(dosSettingsId.current)}
          />
        )}
        {showGeneralSettings && (
          <GeneralSettingsWindow
            onClose={() => { setShowGeneralSettings(false); setMinimizedApps(prev => { const s = new Set(prev); s.delete(generalSettingsId.current); return s; }); setFocusedAppId(prev => prev === generalSettingsId.current ? null : prev); }}
            onFocus={() => focusApp(generalSettingsId.current)}
            onMinimize={() => handleTaskbarMinimize(generalSettingsId.current)}
            zIndex={getZIndex(generalSettingsId.current)}
            focused={focusedAppId === generalSettingsId.current}
            minimized={minimizedApps.has(generalSettingsId.current)}
          />
        )}
        {showDisplayProperties && (
          <DisplayPropertiesDialog
            current={bgSettings}
            onApply={handleBgApply}
            onClose={() => setShowDisplayProperties(false)}
          />
        )}
      </div>
      <Taskbar
        runningApps={allApps}
        focusedAppId={focusedAppId}
        onActivateApp={handleTaskbarActivate}
        onMinimizeApp={handleTaskbarMinimize}
        onCloseApp={handleRequestClose}
        onShowWelcome={() => { setShowWelcome(true); focusApp(welcomeId.current); setMinimizedApps(prev => { const s = new Set(prev); s.delete(welcomeId.current); return s; }); }}
        onShowRegionalSettings={() => { setShowRegionalSettings(true); focusApp(regionalSettingsId.current); setMinimizedApps(prev => { const s = new Set(prev); s.delete(regionalSettingsId.current); return s; }); }}
        onShowDosSettings={() => { setShowDosSettings(true); focusApp(dosSettingsId.current); setMinimizedApps(prev => { const s = new Set(prev); s.delete(dosSettingsId.current); return s; }); }}
        onShowGeneralSettings={() => { setShowGeneralSettings(true); focusApp(generalSettingsId.current); setMinimizedApps(prev => { const s = new Set(prev); s.delete(generalSettingsId.current); return s; }); }}
        onExportWorkbench={handleExportWorkbench}
        onImportWorkbench={handleImportWorkbench}
        onLaunchTaskmgr={handleLaunchTaskmgr}
        taskmgrAvailable={!!taskmgrPath}
        onMinimizeAll={() => {
          const ids = new Set([
            ...runningApps.map(a => a.id),
            ...resourceViewers.map(v => v.id),
            ...openFolders.map(f => f.id),
            ...(showWelcome ? [welcomeId.current] : []),
            ...(showRegionalSettings ? [regionalSettingsId.current] : []),
            ...(showDosSettings ? [dosSettingsId.current] : []),
            ...(showGeneralSettings ? [generalSettingsId.current] : []),
          ]);
          setMinimizedApps(ids);
          setFocusedAppId(null);
        }}
        onResetToDefault={() => setConfirmDialog({
          text: t().confirmReset,
          onYes: () => { localStorage.clear(); indexedDB.deleteDatabase('exeviewer'); location.reload(); },
        })}
        onShutDown={() => setConfirmDialog({
          text: t().confirmShutDown,
          onYes: () => { setConfirmDialog(null); window.location.href = 'https://github.com/lqs/retrotick'; },
        })}
      />
      {/* Confirm dialog */}
      {confirmDialog && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 99999 }}>
          <MessageBox
            caption="RetroTick"
            text={confirmDialog.text}
            type={MB_YESNO | MB_ICONQUESTION}
            focused
            onDismiss={(id) => {
              if (id === IDYES) confirmDialog.onYes();
              setConfirmDialog(null);
            }}
          />
        </div>
      )}
      {/* Info / error dialog */}
      {infoDialog && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 99999 }}>
          <MessageBox
            caption="RetroTick"
            text={infoDialog.text}
            type={MB_OK | (infoDialog.isError ? MB_ICONERROR : 0)}
            focused
            onDismiss={() => setInfoDialog(null)}
          />
        </div>
      )}
      {/* Workbench export/import progress */}
      {workbenchProgress && (() => {
        const p = workbenchProgress.progress;
        let message = '';
        let percent: number | null = null;
        if (p.phase === 'reading') {
          message = t().workbenchPhaseReading.replace('{0}', String(p.current)).replace('{1}', String(p.total));
          percent = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
        } else if (p.phase === 'compressing') {
          message = t().workbenchPhaseCompressing;
          percent = null;
        } else if (p.phase === 'loading') {
          const fmt = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
          message = t().workbenchPhaseLoading.replace('{0}', fmt(p.current)).replace('{1}', fmt(p.total));
          percent = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
        } else if (p.phase === 'decompressing') {
          message = t().workbenchPhaseDecompressing;
          percent = null;
        } else if (p.phase === 'restoring') {
          message = t().workbenchPhaseRestoring.replace('{0}', String(p.current)).replace('{1}', String(p.total));
          percent = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
        } else if (p.phase === 'finalizing') {
          message = t().workbenchPhaseFinalizing;
          percent = 100;
        }
        return <ProgressDialog caption={workbenchProgress.caption} message={message} percent={percent} />;
      })()}
    </div>
  );
}
