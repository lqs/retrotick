import { type Emulator, type DialogControlInfo, type ControlOverlay, getNextCascadePos } from '../../emulator';
import type { WindowInfo } from './types';
import { extractDialogs, parseDialogTemplate } from '../../../pe';
import type { DialogTemplate } from '../../../pe/types';
import { emuFindResourceEntryForModule } from '../../emu-load';
import { emuCompleteThunk } from '../../emu-exec';
import { renderChildControls } from '../../emu-render';
import { IDCANCEL } from '../types';
import { getNonClientMetrics } from './_helpers';

const RT_DIALOG = 5;

export function registerDialog(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  // Helper: find the thunk address for DefDlgProcA so dialog windows use it as wndProc
  function getDefDlgProcThunk(): number {
    for (const [addr, info] of emu.thunkToApi) {
      if (info.dll === 'USER32.DLL' && (info.name === 'DefDlgProcA' || info.name === 'DefDlgProcW')) return addr;
    }
    // If the EXE doesn't import DefDlgProc, allocate a dynamic thunk for it
    if (emu.dynamicThunkPtr) {
      const addr = emu.dynamicThunkPtr;
      emu.dynamicThunkPtr += 4;
      const def = emu.apiDefs.get('USER32.DLL:DefDlgProcA');
      emu.thunkToApi.set(addr, { dll: 'USER32.DLL', name: 'DefDlgProcA', stackBytes: def?.stackBytes ?? 16 });
      emu.thunkPages.add(addr >>> 12);
      return addr;
    }
    return 0;
  }

  // Pre-extract all dialog templates for use by CreateDialogParamW and DialogBoxParamW
  const allDialogs = extractDialogs(emu.peInfo, emu.arrayBuffer);

  /**
   * Read a dialog template from emulator memory at the given address.
   * Used when CreateDialogIndirectParam passes a pointer to a DLGTEMPLATE in memory.
   */
  function readDialogTemplateFromMemory(addr: number): DialogTemplate | null {
    // Read enough data for the template (cap at 4KB to be safe)
    const maxSize = 4096;
    const buf = new ArrayBuffer(maxSize);
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < maxSize; i++) {
      u8[i] = emu.memory.readU8(addr + i);
    }
    try {
      return parseDialogTemplate(buf, 0, maxSize);
    } catch (e: unknown) {
      console.warn(`[DLG] Failed to parse in-memory dialog template at 0x${addr.toString(16)}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * Find a dialog template by ID, checking both the main exe and loaded DLL modules.
   * hInstance indicates which module to search.
   */
  function findDialogTemplate(hInstance: number, templateId: number | string): DialogTemplate | null {
    // First check main exe
    const mainResult = typeof templateId === 'string'
      ? allDialogs.find(d => d.name?.toUpperCase() === templateId.toUpperCase())
      : allDialogs.find(d => d.id === templateId);
    if (mainResult) return mainResult.dialog;

    // Fallback: read the main exe's resource directory from emulator memory.
    // This is needed for UPX-packed executables where the resource data in the
    // raw file is compressed but has been decompressed in memory at runtime.
    try {
      const entry = emu.findResourceEntry(5 /* RT_DIALOG */, templateId);
      if (entry) {
        const addr = emu.pe.imageBase + entry.dataRva;
        const buf = new ArrayBuffer(entry.dataSize);
        const u8 = new Uint8Array(buf);
        for (let i = 0; i < entry.dataSize; i++) u8[i] = emu.memory.readU8(addr + i);
        return parseDialogTemplate(buf, 0, entry.dataSize);
      }
    } catch (e: unknown) {
      console.warn(`[DLG] Failed to parse main-exe dialog template ${templateId} from memory: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Check loaded DLL modules by hInstance
    for (const [, mod] of emu.loadedModules) {
      if (mod.imageBase !== hInstance && mod.base !== hInstance) continue;
      if (!mod.resourceRva) continue;
      const entry = emuFindResourceEntryForModule(emu, mod.imageBase, mod.resourceRva, RT_DIALOG, templateId);
      if (!entry) continue;
      try {
        // Read dialog template data from emulator memory into a buffer
        const addr = mod.imageBase + entry.dataRva;
        const buf = new ArrayBuffer(entry.dataSize);
        const u8 = new Uint8Array(buf);
        for (let i = 0; i < entry.dataSize; i++) {
          u8[i] = emu.memory.readU8(addr + i);
        }
        return parseDialogTemplate(buf, 0, entry.dataSize);
      } catch (e: unknown) {
        console.warn(`[DLG] Failed to parse DLL dialog template ${templateId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Also try all loaded modules regardless of hInstance (some programs pass wrong hInstance)
    for (const [, mod] of emu.loadedModules) {
      if (!mod.resourceRva) continue;
      const entry = emuFindResourceEntryForModule(emu, mod.imageBase, mod.resourceRva, RT_DIALOG, templateId);
      if (!entry) continue;
      try {
        const addr = mod.imageBase + entry.dataRva;
        const buf = new ArrayBuffer(entry.dataSize);
        const u8 = new Uint8Array(buf);
        for (let i = 0; i < entry.dataSize; i++) {
          u8[i] = emu.memory.readU8(addr + i);
        }
        return parseDialogTemplate(buf, 0, entry.dataSize);
      } catch {
        // continue
      }
    }

    return null;
  }

  // DLU to pixel conversion based on dialog font.
  // Windows DLU base values come from GetTextMetrics on the dialog font at 96 DPI:
  //   baseX = tmAveCharWidth, baseY = tmHeight
  //   pixelX = round(dlu * baseX / 4),  pixelY = round(dlu * baseY / 8)
  //
  // Known measured values at 96 DPI (source: Raymond Chen / Win32 docs):
  //   MS Sans Serif 8pt  → baseX=6,  baseY=13  (Windows 3.x / 9x default)
  //   MS Shell Dlg  8pt  → baseX=6,  baseY=13  (maps to MS Sans Serif 8pt)
  //   Tahoma        8pt  → baseX=6,  baseY=13
  //   MS Shell Dlg2 8pt  → baseX=6,  baseY=13  (maps to Tahoma 8pt)
  //   Tahoma        9pt  → baseX=7,  baseY=16  (Windows 2000/XP common dialogs)
  //   Tahoma       10pt  → baseX=8,  baseY=17
  let _dluBaseX: number = 6, _dluBaseY: number = 13;
  function setDluBase(dlg: DialogTemplate): void {
    if (!dlg.font) { _dluBaseX = 6; _dluBaseY = 13; return; }
    const name = dlg.font.typeface?.toLowerCase() ?? '';
    const pt = dlg.font.pointSize;
    // Lookup table for common dialog fonts
    if ((name === 'tahoma' || name === 'ms shell dlg 2') && pt === 9) {
      _dluBaseX = 7; _dluBaseY = 16; return;
    }
    if ((name === 'tahoma' || name === 'ms shell dlg 2') && pt === 10) {
      _dluBaseX = 8; _dluBaseY = 17; return;
    }
    if (pt === 8 || name === 'ms sans serif' || name === 'ms shell dlg' || name === 'ms shell dlg 2' || name === 'tahoma') {
      _dluBaseX = 6; _dluBaseY = 13; return;
    }
    // Fallback: approximate from point size at 96 DPI
    _dluBaseY = Math.round(pt * 96 / 72);
    _dluBaseX = Math.round(_dluBaseY * 0.48);
  }
  const dluX = (v: number) => Math.round(v * _dluBaseX / 4);
  const dluY = (v: number) => Math.round(v * _dluBaseY / 8);

  const runModalDialog = (capturedStackBytes: number, dlg: DialogTemplate, hInstance: number, hwndParent: number, dlgProc: number, lParam: number, templateDesc: string): number | undefined => {
    setDluBase(dlg);
    const clientW = dluX(dlg.cx);
    const clientH = dluY(dlg.cy);
    const WS_CAPTION = 0x00C00000;
    const WS_THICKFRAME = 0x00040000;
    let ncBorderW = 0, ncBorderH = 0, ncCaptionH = 0;
    if (dlg.style & WS_CAPTION) {
      ncCaptionH = 18;
      if (dlg.style & WS_THICKFRAME) { ncBorderW = 4; ncBorderH = 4; }
      else { ncBorderW = 3; ncBorderH = 3; }
    }
    const width = clientW + 2 * ncBorderW;
    const height = clientH + 2 * ncBorderH + ncCaptionH;

    // Create class info for the dialog — wndProc is DefDlgProc, not the app's dlgProc
    const defDlgThunk = getDefDlgProcThunk();
    const classInfo = {
      style: 0, wndProc: defDlgThunk, cbClsExtra: 0, cbWndExtra: 30,
      hInstance, hIcon: 0, hCursor: 0, hbrBackground: 16,
      menuName: 0, className: '#32770',
    };

    const cascPos = getNextCascadePos(emu.screenWidth, emu.screenHeight);
    const wnd: WindowInfo = {
      hwnd: 0, classInfo, wndProc: defDlgThunk,
      parent: hwndParent,
      x: cascPos.x, y: cascPos.y, width, height,
      style: dlg.style, exStyle: dlg.exStyle,
      title: dlg.title, visible: false, hMenu: 0,
      extraBytes: new Uint8Array(30), userData: 0, ownerThreadId: emu.currentThread?.id,
      children: new Map<number, number>(),
      dlgProc,
    };
    const hwnd = emu.handles.alloc('window', wnd);
    wnd.hwnd = hwnd;
    // Store dlgProc at DWL_DLGPROC (offset 4)
    if (dlgProc && wnd.extraBytes.length >= 8) {
      wnd.extraBytes[4] = dlgProc & 0xFF;
      wnd.extraBytes[5] = (dlgProc >> 8) & 0xFF;
      wnd.extraBytes[6] = (dlgProc >> 16) & 0xFF;
      wnd.extraBytes[7] = (dlgProc >> 24) & 0xFF;
    }
    console.log(`[DLG] DialogBoxParam template=${templateDesc} hwnd=0x${hwnd.toString(16)} size=${width}x${height} title="${dlg.title}"`);

    // Create child controls
    for (let i = 0; i < dlg.items.length; i++) {
      const item = dlg.items[i];
      const pxX = dluX(item.x);
      const pxY = dluY(item.y);
      const pxW = dluX(item.cx);
      const pxH = dluY(item.cy);
      let ctrlCls = emu.windowClasses.get(item.className);
      if (!ctrlCls) {
        for (const [name, c] of emu.windowClasses) {
          if (name.toUpperCase() === item.className.toUpperCase()) { ctrlCls = c; break; }
        }
      }
      if (!ctrlCls) {
        ctrlCls = {
          style: 0, wndProc: 0, cbClsExtra: 0, cbWndExtra: 0,
          hInstance: 0, hIcon: 0, hCursor: 0, hbrBackground: 0,
          menuName: 0, className: item.className,
        };
      }
      const childWnd: WindowInfo = {
        hwnd: 0, classInfo: ctrlCls, wndProc: ctrlCls.wndProc,
        parent: hwnd,
        x: pxX, y: pxY, width: pxW, height: pxH,
        style: item.style, exStyle: item.exStyle,
        title: item.text, visible: true, hMenu: 0,
        extraBytes: new Uint8Array(Math.max(0, ctrlCls.cbWndExtra)),
        userData: 0, controlId: item.id, ownerThreadId: emu.currentThread?.id,
      };
      const childHwnd = emu.handles.alloc('window', childWnd);
      childWnd.hwnd = childHwnd;
      (wnd.children ??= new Map()).set(item.id, childHwnd);
      if (!wnd.childList) wnd.childList = [];
      wnd.childList.push(childHwnd);

      // Auto-load images for SS_ICON and SS_BITMAP controls with resource ordinal titles
      if (item.className.toUpperCase() === 'STATIC' && item.titleOrdinal) {
        const ssType = item.style & 0x1F;
        const SS_ICON = 3, SS_BITMAP = 0x0E;
        if (ssType === SS_ICON) {
          const hIcon = emu.loadIconResource(item.titleOrdinal);
          if (hIcon) {
            childWnd.hImage = hIcon;
            // Windows auto-sizes SS_ICON to match actual icon dimensions
            const iconInfo = emu.handles.get<{ width?: number; height?: number }>(hIcon);
            if (iconInfo?.width && iconInfo?.height) {
              childWnd.width = iconInfo.width;
              childWnd.height = iconInfo.height;
            }
          }
        } else if (ssType === SS_BITMAP) {
          const hBmp = emu.loadBitmapResource(item.titleOrdinal);
          if (hBmp) childWnd.hImage = hBmp;
        }
      }
    }

    // Send WM_INITDIALOG
    // Save EIP/ESP — callWndProc modifies them
    const savedEIP = emu.cpu.eip;
    const savedESP = emu.cpu.reg[4];
    emu.callWndProc(defDlgThunk || dlgProc, hwnd, 0x0110, hwndParent, lParam);
    emu.cpu.eip = savedEIP;
    emu.cpu.reg[4] = savedESP;

    // Build dialog info for UI overlay
    const controls: DialogControlInfo[] = dlg.items.map(item => ({
      id: item.id,
      className: item.className,
      text: item.text,
      style: item.style,
      x: dluX(item.x),
      y: dluY(item.y),
      width: dluX(item.cx),
      height: dluY(item.cy),
    }));

    // Build ControlOverlay[] from live child windows (after WM_INITDIALOG may have modified them)
    const overlays: ControlOverlay[] = [];
    if (wnd.childList) {
      for (const childHwnd of wnd.childList) {
        const child = emu.handles.get<WindowInfo>(childHwnd);
        if (!child || !child.visible) continue;
        const overlay: ControlOverlay = {
          controlId: child.controlId ?? 0,
          childHwnd,
          className: child.classInfo.className.toUpperCase(),
          baseClassName: child.classInfo.baseClassName,
          x: child.x, y: child.y, width: child.width, height: child.height,
          style: child.style, exStyle: child.exStyle, title: child.title,
          checked: child.checked ?? 0,
          fontHeight: child.hFont ? (emu.handles.get<{ height: number }>(child.hFont)?.height ?? 0) : 0,
          trackPos: child.trackPos ?? 0,
          trackMin: child.trackMin ?? 0,
          trackMax: child.trackMax ?? 100,
        };
        if (child.tabItems) overlay.tabItems = child.tabItems;
        if (child.tabSelectedIndex !== undefined) overlay.tabSelectedIndex = child.tabSelectedIndex;
        if (child.cbItems) overlay.cbItems = child.cbItems;
        if (child.cbSelectedIndex !== undefined) overlay.cbSelectedIndex = child.cbSelectedIndex;
        if (child.lbItems) overlay.lbItems = child.lbItems;
        if (child.lbSelectedIndex !== undefined) overlay.lbSelectedIndex = child.lbSelectedIndex;
        if (child.lbSelectedIndices) overlay.lbSelectedIndices = Array.from(child.lbSelectedIndices);
        overlays.push(overlay);
      }
    }

    // Push current dialog state onto stack if nesting
    if (emu.dialogState) {
      emu._dialogStack.push({
        dialogState: emu.dialogState,
        resolve: emu._dialogResolve,
        pumpTimer: emu._dialogPumpTimer,
      });
      emu._dialogResolve = null;
      emu._dialogPumpTimer = null;
    }

    emu.dialogState = {
      hwnd,
      dlgProc,
      info: {
        title: dlg.title,
        style: dlg.style,
        width: clientW,
        height: clientH,
        hwnd,
        controls,
        overlays,
        controlValues: new Map(),
      },
      result: IDCANCEL,
      ended: false,
    };

    wnd.visible = true;
    wnd._ownerDrawPending = true;

    let isPromoted = false;
    // If no main window exists, this is a dialog-based app — promote to mainWindow
    // for canvas rendering (needed for apps that do custom drawing via WM_PAINT)
    if (!emu.mainWindow) {
      isPromoted = true;
      emu.promoteToMainWindow(hwnd, wnd);
      // Dispatch WM_ERASEBKGND + WM_PAINT synchronously so the canvas has content
      const WM_ERASEBKGND = 0x0014, WM_PAINT = 0x000F;
      emu.callWndProc(defDlgThunk || dlgProc, hwnd, WM_ERASEBKGND, emu.getWindowDC(hwnd), 0);
      emu.callWndProc(defDlgThunk || dlgProc, hwnd, WM_PAINT, 0, 0);
      emu.cpu.eip = savedEIP;
      emu.cpu.reg[4] = savedESP;
      // Render child controls (sends WM_DRAWITEM for owner-draw buttons)
      renderChildControls(emu, hwnd);
    } else {
      // Show dialog via React overlay for apps that already have a main window
      emu.onShowDialog?.(emu.dialogState.info);
    }

    // If EndDialog was called during WM_INITDIALOG, return result synchronously
    if (emu.dialogState.ended) {
      const result = emu.dialogState.result;
      emu._endDialog(result);
      return result;
    }

    // Wait for EndDialog or dismissDialog — resolved via _dialogResolve callback
    const stackBytes = capturedStackBytes;
    emu.waitingForMessage = true;
    emu._dialogResolve = (result: number) => {
      emu.waitingForMessage = false;
      emuCompleteThunk(emu, result, stackBytes);
      if (emu._dialogPumpTimer !== null) { clearInterval(emu._dialogPumpTimer); emu._dialogPumpTimer = null; }
      if (emu.running && !emu.halted) {
        requestAnimationFrame(emu.tick);
      }
    };

    // Pump messages via timer so WM_PAINT/WM_TIMER/WM_DRAWITEM are dispatched
    emu._dialogPumpTimer = setInterval(() => {
      const ds = emu.dialogState;
      if (!ds || ds.ended || !emu._dialogResolve) {
        if (emu._dialogPumpTimer !== null) { clearInterval(emu._dialogPumpTimer); emu._dialogPumpTimer = null; }
        return;
      }
      const dlgWnd = emu.handles.get<WindowInfo>(ds.hwnd);
      if (!dlgWnd?.wndProc) return;

      const eipSave = emu.cpu.eip;
      const espSave = emu.cpu.reg[4];

      // Temporarily clear waitingForMessage so callWndProc can execute
      const savedWaiting = emu.waitingForMessage;
      emu.waitingForMessage = false;

      // Dispatch queued messages
      while (emu.messageQueue.length > 0) {
        const msg = emu.messageQueue.shift()!;
        const ret = emu.callWndProc(dlgWnd.wndProc, msg.hwnd, msg.message, msg.wParam, msg.lParam);
        emu.cpu.eip = eipSave;
        emu.cpu.reg[4] = espSave;
        if (ds.ended) {
          emu.cpu.halted = false;
          emu.cpu.haltReason = '';
          return;
        }
        if (ret === undefined) {
          emu.waitingForMessage = savedWaiting;
          return;
        }
      }

      // Synthesize WM_PAINT if needed (only for promoted dialogs that have their own canvas)
      if (isPromoted && dlgWnd.needsPaint) {
        dlgWnd.needsPaint = false;
        const ret = emu.callWndProc(dlgWnd.wndProc, ds.hwnd, 0x000F, 0, 0); // WM_PAINT
        emu.cpu.eip = eipSave;
        emu.cpu.reg[4] = espSave;
        if (ret !== undefined) emu.notifyControlOverlays();
      }

      // Send WM_DRAWITEM for BS_OWNERDRAW buttons when dialog needs repaint
      const WM_DRAWITEM = 0x002B;
      const BS_OWNERDRAW = 0x0B;
      if (dlgWnd._ownerDrawPending && dlgWnd.childList) {
        dlgWnd._ownerDrawPending = false;
        for (const childHwnd of dlgWnd.childList) {
          const child = emu.handles.get<WindowInfo>(childHwnd);
          if (!child || !child.visible) continue;
          if (child.classInfo.className.toUpperCase() !== 'BUTTON') continue;
          if ((child.style & 0xF) !== BS_OWNERDRAW) continue;
          const controlId = child.controlId ?? 0;

          // For non-promoted (overlay) dialogs, only draw to companion canvas
          if (!isPromoted && !child.domCanvas) continue;
          const useDomCanvas = !!child.domCanvas;
          const hdc = useDomCanvas ? emu.getWindowDC(childHwnd) : emu.getWindowDC(ds.hwnd);
          const dc = emu.getDC(hdc);
          if (dc && !useDomCanvas) {
            dc.ctx.save();
            dc.ctx.translate(child.x, child.y);
          }

          // Allocate DRAWITEMSTRUCT if needed
          if (!emu.drawItemStructAddr) emu.drawItemStructAddr = emu.allocHeap(48);
          const addr = emu.drawItemStructAddr;
          const ODT_BUTTON = 4, ODA_DRAWENTIRE = 1;
          const WS_DISABLED = 0x08000000, ODS_DISABLED = 0x4, ODS_SELECTED = 0x1;
          let itemState = 0;
          if (child.style & WS_DISABLED) itemState |= ODS_DISABLED;
          if (child._odsSelected) itemState |= ODS_SELECTED;
          emu.memory.writeU32(addr + 0, ODT_BUTTON);
          emu.memory.writeU32(addr + 4, controlId);
          emu.memory.writeU32(addr + 8, 0);
          emu.memory.writeU32(addr + 12, ODA_DRAWENTIRE);
          emu.memory.writeU32(addr + 16, itemState);
          emu.memory.writeU32(addr + 20, childHwnd);
          emu.memory.writeU32(addr + 24, hdc);
          emu.memory.writeU32(addr + 28, 0);
          emu.memory.writeU32(addr + 32, 0);
          emu.memory.writeU32(addr + 36, child.width);
          emu.memory.writeU32(addr + 40, child.height);
          emu.memory.writeU32(addr + 44, 0);

          emu.callWndProc(dlgWnd.wndProc, ds.hwnd, WM_DRAWITEM, controlId, addr);
          emu.cpu.eip = eipSave;
          emu.cpu.reg[4] = espSave;

          if (dc && !useDomCanvas) dc.ctx.restore();

          if (ds.ended) {
            emu.cpu.halted = false;
            emu.cpu.haltReason = '';
            return;
          }
        }
      }

      emu.waitingForMessage = savedWaiting;
    }, 50);
    return undefined;
  };

  const dialogBoxParamImpl = (wide: boolean): number | undefined => {
    const capturedStackBytes = emu._currentThunkStackBytes;
    const hInstance = emu.readArg(0);
    const templatePtr = emu.readArg(1);
    const hwndParent = emu.readArg(2);
    const dlgProc = emu.readArg(3);
    const lParam = emu.readArg(4);

    let dlg: DialogTemplate | null = null;
    if (templatePtr < 0x10000) {
      dlg = findDialogTemplate(hInstance, templatePtr);
    } else {
      const name = wide ? emu.memory.readUTF16String(templatePtr) : emu.memory.readCString(templatePtr);
      dlg = findDialogTemplate(hInstance, name);
    }
    if (!dlg) {
      const desc = templatePtr < 0x10000 ? String(templatePtr) : '"' + (wide ? emu.memory.readUTF16String(templatePtr) : emu.memory.readCString(templatePtr)) + '"';
      console.warn(`Dialog template ${desc} not found`);
      return IDCANCEL;
    }
    return runModalDialog(capturedStackBytes, dlg, hInstance, hwndParent, dlgProc, lParam, String(templatePtr));
  };

  user32.register('DialogBoxParamW', 5, () => dialogBoxParamImpl(true));
  user32.register('DialogBoxParamA', 5, () => dialogBoxParamImpl(false));

  const dialogBoxIndirectParamImpl = (): number | undefined => {
    const capturedStackBytes = emu._currentThunkStackBytes;
    const hInstance = emu.readArg(0);
    const lpTemplate = emu.readArg(1);
    const hwndParent = emu.readArg(2);
    const dlgProc = emu.readArg(3);
    const lParam = emu.readArg(4);
    if (!lpTemplate) return IDCANCEL;
    const dlg = readDialogTemplateFromMemory(lpTemplate);
    if (!dlg) {
      console.warn(`[DLG] DialogBoxIndirectParam: failed to parse template at 0x${lpTemplate.toString(16)}`);
      return IDCANCEL;
    }
    return runModalDialog(capturedStackBytes, dlg, hInstance, hwndParent, dlgProc, lParam, `@0x${lpTemplate.toString(16)}`);
  };

  user32.register('DialogBoxIndirectParamA', 5, () => dialogBoxIndirectParamImpl());
  user32.register('DialogBoxIndirectParamW', 5, () => dialogBoxIndirectParamImpl());

  // CreateDialogParam — creates a modeless dialog (calc.exe main window)
  const createDialogParamImpl = (wide: boolean) => {
    const hInstance = emu.readArg(0);
    const templatePtr = emu.readArg(1);
    const hwndParent = emu.readArg(2);
    const dlgProc = emu.readArg(3);
    const lParam = emu.readArg(4);

    let dlg: DialogTemplate | null = null;
    let templateDesc: string;
    if (templatePtr < 0x10000) {
      // Numeric resource ID
      templateDesc = `id=${templatePtr}`;
      dlg = findDialogTemplate(hInstance, templatePtr);
    } else {
      const name = wide ? emu.memory.readUTF16String(templatePtr) : emu.memory.readCString(templatePtr);
      templateDesc = `name="${name}"`;
      dlg = findDialogTemplate(hInstance, name);
    }
    console.log(`[DLG] CreateDialogParamW ${templateDesc} hInstance=0x${hInstance.toString(16)} parent=0x${hwndParent.toString(16)} dlgProc=0x${dlgProc.toString(16)} lParam=0x${lParam.toString(16)}`);
    if (!dlg) {
      console.warn(`[DLG] Dialog template ${templateDesc} not found`);
      return 0;
    }
    setDluBase(dlg);
    const clientW = dluX(dlg.cx);
    const clientH = dluY(dlg.cy);
    // Dialog template cx/cy are client area dimensions. Add non-client chrome
    // (caption bar, border, menu bar) to get the full window size.
    const hasMenu = !!dlg.menuName;
    const { bw, captionH, menuH } = getNonClientMetrics(dlg.style, hasMenu);
    const width = clientW + bw * 2;
    const height = clientH + captionH + menuH + bw * 2;
    console.log(`[DLG] style=0x${dlg.style.toString(16)} exStyle=0x${dlg.exStyle.toString(16)} cdit=${dlg.items.length} size=${dlg.cx}x${dlg.cy} -> client=${clientW}x${clientH} window=${width}x${height}px`);
    console.log(`[DLG] class="${dlg.className || ''}" title="${dlg.title}" menu="${dlg.menuName || ''}" cdit=${dlg.items.length}`);

    // Resolve the window class
    const dlgClassName = dlg.className || '';

    // Look up the registered window class
    let cls = dlgClassName ? emu.windowClasses.get(dlgClassName) : null;
    if (!cls && dlgClassName) {
      // Try case-insensitive lookup
      for (const [name, c] of emu.windowClasses) {
        if (name.toUpperCase() === dlgClassName.toUpperCase()) {
          cls = c;
          break;
        }
      }
    }

    // Determine wndProc: prefer template class's wndProc, fall back to DefDlgProc
    let wndProc = 0;
    if (cls && cls.wndProc) {
      wndProc = cls.wndProc;
      console.log(`[DLG] Using class "${dlgClassName}" wndProc=0x${wndProc.toString(16)}`);
    } else {
      wndProc = getDefDlgProcThunk();
      console.log(`[DLG] Using DefDlgProc thunk=0x${wndProc.toString(16)} as wndProc`);
    }

    const classInfo = cls || {
      style: 0, wndProc, cbClsExtra: 0, cbWndExtra: 30,
      hInstance, hIcon: 0, hCursor: 0, hbrBackground: 16,
      menuName: 0, className: dlgClassName || '#32770',
    };

    const cbExtra = Math.max(classInfo.cbWndExtra, 30); // at least DLGWINDOWEXTRA
    const cascPos = !hwndParent ? getNextCascadePos(emu.screenWidth, emu.screenHeight) : { x: 0, y: 0 };
    const wnd: WindowInfo = {
      hwnd: 0, classInfo, wndProc,
      parent: hwndParent,
      x: cascPos.x, y: cascPos.y, width, height,
      style: dlg.style, exStyle: dlg.exStyle,
      title: dlg.title, visible: false, hMenu: 0,
      extraBytes: new Uint8Array(cbExtra), userData: 0, ownerThreadId: emu.currentThread?.id,
      children: new Map<number, number>(),
      dlgProc,
    };
    const hwnd = emu.handles.alloc('window', wnd);
    wnd.hwnd = hwnd;
    // Store dlgProc at DWL_DLGPROC (offset 4) in extraBytes so SetWindowLong can update it
    if (dlgProc && wnd.extraBytes.length >= 8) {
      wnd.extraBytes[4] = dlgProc & 0xFF;
      wnd.extraBytes[5] = (dlgProc >> 8) & 0xFF;
      wnd.extraBytes[6] = (dlgProc >> 16) & 0xFF;
      wnd.extraBytes[7] = (dlgProc >> 24) & 0xFF;
    }
    console.log(`[DLG] Created dialog hwnd=0x${hwnd.toString(16)} size=${width}x${height} title="${dlg.title}" wndProc=0x${wndProc.toString(16)} dlgProc=0x${dlgProc.toString(16)} class="${dlgClassName}"`);

    // Create child controls from parsed dialog items
    for (let i = 0; i < dlg.items.length; i++) {
      const item = dlg.items[i];
      const pxX = dluX(item.x);
      const pxY = dluY(item.y);
      const pxW = dluX(item.cx);
      const pxH = dluY(item.cy);

      // Look up control class (case-insensitive)
      let ctrlCls = emu.windowClasses.get(item.className);
      if (!ctrlCls) {
        for (const [name, c] of emu.windowClasses) {
          if (name.toUpperCase() === item.className.toUpperCase()) {
            ctrlCls = c;
            break;
          }
        }
      }
      if (!ctrlCls) {
        ctrlCls = {
          style: 0, wndProc: 0, cbClsExtra: 0, cbWndExtra: 0,
          hInstance: 0, hIcon: 0, hCursor: 0, hbrBackground: 0,
          menuName: 0, className: item.className,
        };
      }

      // Create child window
      const childWnd: WindowInfo = {
        hwnd: 0, classInfo: ctrlCls, wndProc: ctrlCls.wndProc,
        parent: hwnd,
        x: pxX, y: pxY, width: pxW, height: pxH,
        style: item.style, exStyle: item.exStyle,
        title: item.text, visible: true, hMenu: 0,
        extraBytes: new Uint8Array(Math.max(0, ctrlCls.cbWndExtra)),
        userData: 0, controlId: item.id, ownerThreadId: emu.currentThread?.id,
      };
      const childHwnd = emu.handles.alloc('window', childWnd);
      childWnd.hwnd = childHwnd;
      (wnd.children ??= new Map()).set(item.id, childHwnd);
      if (!wnd.childList) wnd.childList = [];
      wnd.childList.push(childHwnd);

      // Send WM_CREATE to custom controls with their own wndProc
      if (ctrlCls.wndProc) {
        emu.callWndProc(ctrlCls.wndProc, childHwnd, 0x0001, 0, 0); // WM_CREATE
      }

      if (i < 5) {
        console.log(`[DLG] Control #${i}: id=${item.id} class="${item.className}" text="${item.text}" style=0x${item.style.toString(16)} pos=${pxX},${pxY} size=${pxW}x${pxH}`);
      }
    }
    console.log(`[DLG] Created ${dlg.items.length} child controls`);

    // Create font from dialog template and send WM_SETFONT to all controls
    if (dlg.font) {
      const fontHeight = Math.round(dlg.font.pointSize * 96 / 72); // pt → px at 96 DPI
      const hFont = emu.handles.alloc('font', { height: fontHeight });
      for (const [, childHwnd] of (wnd.children ?? new Map())) {
        const childWnd = emu.handles.get<WindowInfo>(childHwnd);
        if (childWnd) {
          childWnd.hFont = hFont;
          if (childWnd.wndProc) {
            emu.callWndProc(childWnd.wndProc, childHwnd, 0x0030, hFont, 0); // WM_SETFONT
          }
        }
      }
    }

    // For dialog-based apps: promote top-level dialog to mainWindow before WM_INITDIALOG
    // so that canvas is ready for any painting during init
    const WS_CHILD = 0x40000000;

    // Register as child of parent window (for WS_CHILD dialogs like tab pages)
    if (hwndParent && (dlg.style & WS_CHILD)) {
      const parentWnd = emu.handles.get<WindowInfo>(hwndParent);
      if (parentWnd) {
        if (!parentWnd.childList) parentWnd.childList = [];
        parentWnd.childList.push(hwnd);
      }
    }

    // Check if the parent is actually a window; if not, treat as top-level
    const parentIsWindow = hwndParent ? !!(emu.handles.get<WindowInfo>(hwndParent)?.classInfo) : false;
    const isTopLevel = width > 0 && height > 0 && (!(dlg.style & WS_CHILD) || !parentIsWindow);
    const currentMain = emu.mainWindow ? emu.handles.get(emu.mainWindow) as WindowInfo | undefined : null;
    const shouldPromote = isTopLevel && (!currentMain || (width > currentMain.width || height > currentMain.height));
    // If promoting a WS_CHILD dialog whose parent isn't a real window, clear WS_CHILD
    // so it behaves as a top-level window (prevents SetWindowPos from shrinking it)
    if (shouldPromote && (dlg.style & WS_CHILD) && !parentIsWindow) {
      wnd.style = wnd.style & ~WS_CHILD;
      wnd.parent = 0;
    }
    if (shouldPromote) {
      console.log(`[DLG] Promoting dialog 0x${hwnd.toString(16)} to mainWindow`);
      emu.promoteToMainWindow(hwnd, wnd as WindowInfo);
      // Override canvas size: dialog width/height ARE client dimensions,
      // so set canvas directly instead of relying on getClientSize subtraction.
      emu.setupCanvasSize(clientW, clientH);
    }

    // Send WM_INITDIALOG through wndProc (DefDlgProc or class wndProc)
    if (wndProc) {
      emu.callWndProc(wndProc, hwnd, 0x0110, hwndParent, lParam); // WM_INITDIALOG
    }

    // After WM_INITDIALOG, ensure the dialog is visible and painted
    if (shouldPromote) {
      wnd.visible = true;
      wnd.needsPaint = true;
      wnd.needsErase = true;
      emu.onWindowChange?.(wnd as WindowInfo);
    }

    return hwnd;
  };
  user32.register('CreateDialogParamW', 5, () => createDialogParamImpl(true));
  user32.register('CreateDialogParamA', 5, () => createDialogParamImpl(false));

  user32.register('EndDialog', 2, () => {
    const hwndDlg = emu.readArg(0);
    const nResult = emu.readArg(1);
    console.log(`[DLG] EndDialog hwnd=0x${hwndDlg.toString(16)} result=${nResult}`);
    if (emu.dialogState && emu.dialogState.hwnd === hwndDlg) {
      emu.dialogState.result = nResult;
      emu.dialogState.ended = true;
      // Resolve the DialogBoxParam promise (cleanup handled by _endDialog)
      emu._endDialog(nResult);
    }
    return 1;
  });

  user32.register('SetDlgItemInt', 4, () => {
    const hwndDlg = emu.readArg(0);
    const controlId = emu.readArg(1);
    const uValue = emu.readArg(2);
    const bSigned = emu.readArg(3);
    const text = bSigned ? (uValue | 0).toString() : (uValue >>> 0).toString();
    console.log(`[EDIT] SetDlgItemInt hwnd=0x${hwndDlg.toString(16)} id=${controlId} text="${text}"`);
    if (emu.dialogState && emu.dialogState.hwnd === hwndDlg) {
      emu.dialogState.info.controlValues.set(controlId, text);
    }
    // Also update child window title so the overlay shows the value
    const dlgWnd = emu.handles.get<WindowInfo>(hwndDlg);
    if (dlgWnd?.children) {
      const childHwnd = dlgWnd.children.get(controlId);
      if (childHwnd) {
        const child = emu.handles.get<WindowInfo>(childHwnd);
        if (child) child.title = text;
      }
    }
    return 1;
  });

  user32.register('GetDlgItemInt', 4, () => {
    const hwndDlg = emu.readArg(0);
    const controlId = emu.readArg(1);
    const lpTranslated = emu.readArg(2);
    const bSigned = emu.readArg(3);
    // Try controlValues first, then fall back to child window title
    let text: string | undefined;
    if (emu.dialogState && emu.dialogState.hwnd === hwndDlg) {
      text = emu.dialogState.info.controlValues.get(controlId);
    }
    if (text === undefined) {
      const dlgWnd = emu.handles.get<WindowInfo>(hwndDlg);
      const childHwnd = dlgWnd?.children?.get(controlId);
      if (childHwnd) {
        const child = emu.handles.get<WindowInfo>(childHwnd);
        if (child) text = child.title;
      }
    }
    if (text !== undefined) {
      const val = parseInt(text) || 0;
      console.log(`[EDIT] GetDlgItemInt hwnd=0x${hwndDlg.toString(16)} id=${controlId} text="${text}" val=${val}`);
      if (lpTranslated) emu.memory.writeU32(lpTranslated, 1);
      return bSigned ? (val | 0) : (val >>> 0);
    }
    if (lpTranslated) emu.memory.writeU32(lpTranslated, 0);
    return 0;
  });

  user32.register('SetDlgItemTextW', 3, () => {
    const hwndDlg = emu.readArg(0);
    const controlId = emu.readArg(1);
    const textPtr = emu.readArg(2);
    const text = textPtr ? emu.memory.readUTF16String(textPtr) : '';

    // Update modal dialog state if applicable
    if (emu.dialogState && emu.dialogState.hwnd === hwndDlg) {
      emu.dialogState.info.controlValues.set(controlId, text);
    }

    // Update child window title and trigger repaint
    const wnd = emu.handles.get<WindowInfo>(hwndDlg);
    if (wnd?.children) {
      const childHwnd = wnd.children.get(controlId);
      if (childHwnd) {
        const child = emu.handles.get<WindowInfo>(childHwnd);
        if (child) {
          child.title = text;
          // Send WM_SETTEXT to the control so custom-drawn controls update their internal state
          if (child.wndProc && textPtr) {
            emu.callWndProc(child.wndProc, childHwnd, 0x000C, 0, textPtr); // WM_SETTEXT
          }
          // Notify DOM overlay of text change (lightweight, no WM_PAINT)
          if (hwndDlg === emu.mainWindow) {
            emu.notifyControlOverlays();
          }
        }
      }
    }
    return 1;
  });

  function getDlgItemText(hwndDlg: number, controlId: number): string {
    // Try controlValues first (for modal dialogs), then fall back to child window title
    if (emu.dialogState && emu.dialogState.hwnd === hwndDlg) {
      const text = emu.dialogState.info.controlValues.get(controlId);
      if (text !== undefined) return text;
    }
    const dlgWnd = emu.handles.get<WindowInfo>(hwndDlg);
    const childHwnd = dlgWnd?.children?.get(controlId);
    if (childHwnd) {
      const child = emu.handles.get<WindowInfo>(childHwnd);
      if (child) return child.title || '';
    }
    return '';
  }

  user32.register('GetDlgItemTextW', 4, () => {
    const hwndDlg = emu.readArg(0);
    const controlId = emu.readArg(1);
    const bufPtr = emu.readArg(2);
    const bufSize = emu.readArg(3);
    if (bufSize <= 0) return 0;
    const text = getDlgItemText(hwndDlg, controlId);
    const maxChars = Math.min(text.length, bufSize - 1);
    for (let i = 0; i < maxChars; i++) emu.memory.writeU16(bufPtr + i * 2, text.charCodeAt(i));
    emu.memory.writeU16(bufPtr + maxChars * 2, 0);
    return maxChars;
  });

  user32.register('GetDlgItemTextA', 4, () => {
    const hwndDlg = emu.readArg(0);
    const controlId = emu.readArg(1);
    const bufPtr = emu.readArg(2);
    const bufSize = emu.readArg(3);
    if (bufSize <= 0) return 0;
    const text = getDlgItemText(hwndDlg, controlId);
    const maxChars = Math.min(text.length, bufSize - 1);
    for (let i = 0; i < maxChars; i++) emu.memory.writeU8(bufPtr + i, text.charCodeAt(i) & 0xFF);
    emu.memory.writeU8(bufPtr + maxChars, 0);
    return maxChars;
  });

  user32.register('GetDlgItem', 2, () => {
    const hwndDlg = emu.readArg(0);
    const controlId = emu.readArg(1);
    // Control ID 0 refers to the dialog window itself
    if (controlId === 0) return hwndDlg;
    const wnd = emu.handles.get<WindowInfo>(hwndDlg);
    if (wnd?.children) {
      const childHwnd = wnd.children.get(controlId);
      if (childHwnd) return childHwnd;
    }
    // Fallback: search all windows for a child with matching controlId and parent
    for (const [handle, data] of emu.handles.findByType('window')) {
      const w = data as WindowInfo;
      if (w.parent === hwndDlg && w.controlId === controlId) return handle;
    }
    return 0; // child not found
  });

  user32.register('GetDlgCtrlID', 1, () => {
    const hwnd = emu.readArg(0);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (wnd && wnd.controlId !== undefined) return wnd.controlId;
    // Fallback for pseudo control handles: low word is control ID
    return hwnd & 0xFFFF;
  });

  user32.register('IsDialogMessageA', 2, () => 0);
  user32.register('IsDialogMessageW', 2, () => 0);

  // Parse a DLGTEMPLATE or DLGTEMPLATEEX from emulator memory at `baseAddr`
  const DIALOG_CLASS_NAMES: Record<number, string> = {
    0x0080: 'Button', 0x0081: 'Edit', 0x0082: 'Static',
    0x0083: 'ListBox', 0x0084: 'ScrollBar', 0x0085: 'ComboBox',
  };

  function parseDlgTemplateFromMemory(mem: typeof emu.memory, baseAddr: number) {
    let pos = baseAddr;
    const u8 = () => { const v = mem.readU8(pos); pos++; return v; };
    const u16 = () => { const v = mem.readU16(pos); pos += 2; return v; };
    const i16 = () => { const v = mem.readU16(pos); pos += 2; return (v & 0x8000) ? v - 0x10000 : v; };
    const u32 = () => { const v = mem.readU32(pos); pos += 4; return v; };
    const align4 = () => { pos = (pos + 3) & ~3; };
    const wstr = (): string => {
      let s = '';
      for (;;) { const ch = u16(); if (ch === 0) break; s += String.fromCharCode(ch); }
      return s;
    };
    const szOrOrd = (): string | { ordinal: number } | null => {
      const first = mem.readU16(pos);
      if (first === 0x0000) { pos += 2; return null; }
      if (first === 0xFFFF) { pos += 2; return { ordinal: u16() }; }
      return wstr();
    };
    const szOrOrdStr = (v: string | { ordinal: number } | null): string | null => {
      if (v === null) return null;
      if (typeof v === 'string') return v;
      return `#${v.ordinal}`;
    };

    const isEx = mem.readU16(baseAddr) === 1 && mem.readU16(baseAddr + 2) === 0xFFFF;

    let style: number, exStyle: number, count: number;
    let x: number, y: number, cx: number, cy: number;
    let title: string, menuName: string | null, className: string | null;
    let font: { pointSize: number; weight?: number; italic?: boolean; typeface: string } | null = null;

    if (isEx) {
      pos = baseAddr;
      u16(); u16(); u32(); // sig, reserved, version
      exStyle = u32(); style = u32(); count = u16();
      x = i16(); y = i16(); cx = i16(); cy = i16();
      menuName = szOrOrdStr(szOrOrd());
      className = szOrOrdStr(szOrOrd());
      title = wstr();
      if (style & 0x40) { // DS_SETFONT
        const pt = u16(), wt = u16(), it = u8(); u8();
        font = { pointSize: pt, weight: wt, italic: it !== 0, typeface: wstr() };
      }
    } else {
      pos = baseAddr;
      style = u32(); exStyle = u32(); count = u16();
      x = i16(); y = i16(); cx = i16(); cy = i16();
      menuName = szOrOrdStr(szOrOrd());
      className = szOrOrdStr(szOrOrd());
      title = wstr();
      if (style & 0x40) { // DS_SETFONT
        const pt = u16();
        font = { pointSize: pt, typeface: wstr() };
      }
    }

    const items: { style: number; exStyle: number; x: number; y: number; cx: number; cy: number; id: number; className: string; text: string }[] = [];
    for (let i = 0; i < count; i++) {
      align4();
      let s: number, ex: number, ix: number, iy: number, icx: number, icy: number, id: number;
      if (isEx) {
        u32(); // helpID
        ex = u32(); s = u32();
        ix = i16(); iy = i16(); icx = i16(); icy = i16();
        id = u32();
      } else {
        s = u32(); ex = u32();
        ix = i16(); iy = i16(); icx = i16(); icy = i16();
        id = u16();
      }
      const cls = szOrOrd();
      const ttl = szOrOrd();
      const extra = u16();
      if (extra > 0) pos += extra;

      let cn: string;
      if (cls && typeof cls === 'object') cn = DIALOG_CLASS_NAMES[cls.ordinal] || 'Unknown';
      else cn = (typeof cls === 'string') ? cls : 'Unknown';

      let text = '';
      if (typeof ttl === 'string') text = ttl;

      items.push({ style: s, exStyle: ex, x: ix, y: iy, cx: icx, cy: icy, id, className: cn, text });
    }

    return { style, exStyle, x, y, cx, cy, title, className, menuName, font, items };
  }

  user32.register('CreateDialogIndirectParamA', 5, () => {
    const hInstance = emu.readArg(0);
    const lpTemplate = emu.readArg(1);
    const hwndParent = emu.readArg(2);
    const dlgProc = emu.readArg(3);
    const lParam = emu.readArg(4);

    const dlg = parseDlgTemplateFromMemory(emu.memory, lpTemplate);
    console.log(`[DLG] CreateDialogIndirectParamA template@0x${lpTemplate.toString(16)} style=0x${dlg.style.toString(16)} size=${dlg.cx}x${dlg.cy} title="${dlg.title}" items=${dlg.items.length}`);
    const clientW = dluX(dlg.cx);
    const clientH = dluY(dlg.cy);
    const WS_CAPTION = 0x00C00000;
    const WS_THICKFRAME = 0x00040000;
    let ncBorderW = 0, ncBorderH = 0, ncCaptionH = 0;
    if (dlg.style & WS_CAPTION) {
      ncCaptionH = 18;
      if (dlg.style & WS_THICKFRAME) { ncBorderW = 4; ncBorderH = 4; }
      else { ncBorderW = 3; ncBorderH = 3; }
    }
    const width = clientW + 2 * ncBorderW;
    const height = clientH + 2 * ncBorderH + ncCaptionH;

    const dlgClassName = dlg.className || '';
    let cls = dlgClassName ? emu.windowClasses.get(dlgClassName) : null;
    if (!cls && dlgClassName) {
      for (const [name, c] of emu.windowClasses) {
        if (name.toUpperCase() === dlgClassName.toUpperCase()) { cls = c; break; }
      }
    }

    let wndProc = 0;
    if (cls && cls.wndProc) wndProc = cls.wndProc;
    else wndProc = getDefDlgProcThunk();

    const classInfo = cls || {
      style: 0, wndProc, cbClsExtra: 0, cbWndExtra: 30,
      hInstance, hIcon: 0, hCursor: 0, hbrBackground: 16,
      menuName: 0, className: dlgClassName || '#32770',
    };

    const cbExtra = Math.max(classInfo.cbWndExtra, 30);
    const cascPos2 = !hwndParent ? getNextCascadePos(emu.screenWidth, emu.screenHeight) : { x: 0, y: 0 };
    const wnd: WindowInfo = {
      hwnd: 0, classInfo, wndProc,
      parent: hwndParent,
      x: cascPos2.x, y: cascPos2.y, width, height,
      style: dlg.style, exStyle: dlg.exStyle,
      title: dlg.title, visible: false, hMenu: 0,
      extraBytes: new Uint8Array(cbExtra), userData: 0, ownerThreadId: emu.currentThread?.id,
      children: new Map<number, number>(),
      dlgProc,
    };
    const hwnd = emu.handles.alloc('window', wnd);
    wnd.hwnd = hwnd;
    if (dlgProc && wnd.extraBytes.length >= 8) {
      wnd.extraBytes[4] = dlgProc & 0xFF;
      wnd.extraBytes[5] = (dlgProc >> 8) & 0xFF;
      wnd.extraBytes[6] = (dlgProc >> 16) & 0xFF;
      wnd.extraBytes[7] = (dlgProc >> 24) & 0xFF;
    }

    // Register as child of parent window (for WS_CHILD dialogs)
    const WS_CHILD2 = 0x40000000;
    if (hwndParent && (dlg.style & WS_CHILD2)) {
      const parentWnd = emu.handles.get<WindowInfo>(hwndParent);
      if (parentWnd) {
        if (!parentWnd.childList) parentWnd.childList = [];
        parentWnd.childList.push(hwnd);
      }
    }

    // Create child controls
    for (let i = 0; i < dlg.items.length; i++) {
      const item = dlg.items[i];
      const pxX = dluX(item.x); const pxY = dluY(item.y);
      const pxW = dluX(item.cx); const pxH = dluY(item.cy);

      let ctrlCls = emu.windowClasses.get(item.className);
      if (!ctrlCls) {
        for (const [name, c] of emu.windowClasses) {
          if (name.toUpperCase() === item.className.toUpperCase()) { ctrlCls = c; break; }
        }
      }
      if (!ctrlCls) {
        ctrlCls = { style: 0, wndProc: 0, cbClsExtra: 0, cbWndExtra: 0, hInstance: 0, hIcon: 0, hCursor: 0, hbrBackground: 0, menuName: 0, className: item.className };
      }

      const childWnd: WindowInfo = {
        hwnd: 0, classInfo: ctrlCls, wndProc: ctrlCls.wndProc,
        parent: hwnd,
        x: pxX, y: pxY, width: pxW, height: pxH,
        style: item.style, exStyle: item.exStyle,
        title: item.text, visible: true, hMenu: 0,
        extraBytes: new Uint8Array(Math.max(0, ctrlCls.cbWndExtra)),
        userData: 0, controlId: item.id, ownerThreadId: emu.currentThread?.id,
      };
      const childHwnd = emu.handles.alloc('window', childWnd);
      childWnd.hwnd = childHwnd;
      (wnd.children ??= new Map()).set(item.id, childHwnd);
      if (!wnd.childList) wnd.childList = [];
      wnd.childList.push(childHwnd);
      if (ctrlCls.wndProc) emu.callWndProc(ctrlCls.wndProc, childHwnd, 0x0001, 0, 0);
    }

    // Font
    if (dlg.font) {
      const fontHeight = Math.round(dlg.font.pointSize * 96 / 72);
      const hFont = emu.handles.alloc('font', { height: fontHeight });
      for (const [, childHwnd] of (wnd.children ?? new Map())) {
        const childWnd = emu.handles.get<WindowInfo>(childHwnd);
        if (childWnd) {
          childWnd.hFont = hFont;
          if (childWnd.wndProc) emu.callWndProc(childWnd.wndProc, childHwnd, 0x0030, hFont, 0);
        }
      }
    }

    // Promote to main window if top-level
    const WS_CHILD = 0x40000000;
    const isTopLevel = emu.mainWindow === 0 && width > 0 && height > 0 && !(dlg.style & WS_CHILD);
    if (isTopLevel) emu.promoteToMainWindow(hwnd, wnd as WindowInfo);

    // WM_INITDIALOG
    if (wndProc) emu.callWndProc(wndProc, hwnd, 0x0110, hwndParent, lParam);

    if (isTopLevel) {
      wnd.visible = true;
      wnd.needsPaint = true;
      wnd.needsErase = true;
      emu.onWindowChange?.(wnd as WindowInfo);
    }

    return hwnd;
  });

  const sendDlgItemMessage = () => {
    const hwndDlg = emu.readArg(0);
    const controlId = emu.readArg(1);
    const msg = emu.readArg(2);
    const wParam = emu.readArg(3);
    const lParam = emu.readArg(4);
    // Resolve child hwnd, then delegate to SendMessageW handler
    const wnd = emu.handles.get<WindowInfo>(hwndDlg);
    if (wnd?.children) {
      const childHwnd = wnd.children.get(controlId);
      if (childHwnd) {
        // Rewrite stack args so SendMessageW sees (childHwnd, msg, wParam, lParam)
        const sendMessageW = emu.apiDefs.get('USER32.DLL:SendMessageW')?.handler;
        if (sendMessageW) {
          const esp = emu.cpu.reg[4] >>> 0;
          // Overwrite arg0..arg3 (don't touch retAddr at [esp])
          emu.memory.writeU32(esp + 4, childHwnd);
          emu.memory.writeU32(esp + 8, msg);
          emu.memory.writeU32(esp + 12, wParam);
          emu.memory.writeU32(esp + 16, lParam);
          return sendMessageW(emu);
        }
      }
    }
    return 0;
  };
  user32.register('SendDlgItemMessageA', 5, sendDlgItemMessage);
  user32.register('SendDlgItemMessageW', 5, sendDlgItemMessage);

  user32.register('SetDlgItemTextA', 3, () => {
    const hwndDlg = emu.readArg(0);
    const controlId = emu.readArg(1);
    const textPtr = emu.readArg(2);
    const text = textPtr ? emu.memory.readCString(textPtr) : '';

    if (emu.dialogState && emu.dialogState.hwnd === hwndDlg) {
      emu.dialogState.info.controlValues.set(controlId, text);
    }

    const wnd = emu.handles.get<WindowInfo>(hwndDlg);
    if (wnd?.children) {
      const childHwnd = wnd.children.get(controlId);
      if (childHwnd) {
        const child = emu.handles.get<WindowInfo>(childHwnd);
        if (child) child.title = text;
      }
    }
    return 1;
  });

  user32.register('GetNextDlgTabItem', 3, () => 0); // no tab item found
  user32.register('GetNextDlgGroupItem', 3, () => 0);

  // CreateDialogIndirectParamW(hInstance, lpTemplate, hwndParent, lpDialogFunc, lParamInit) → HWND
  // Return 0 (fail gracefully) - modeless dialog
  user32.register('CreateDialogIndirectParamW', 5, () => 0);

  const findChildByControlId = (hwndDlg: number, controlId: number): WindowInfo | null => {
    const wnd = emu.handles.get<WindowInfo>(hwndDlg);
    if (wnd?.children) {
      const childHwnd = wnd.children.get(controlId);
      if (childHwnd) return emu.handles.get<WindowInfo>(childHwnd) ?? null;
    }
    for (const [, data] of emu.handles.findByType('window')) {
      const w = data as WindowInfo;
      if (w.parent === hwndDlg && w.controlId === controlId) return w;
    }
    return null;
  };

  user32.register('CheckDlgButton', 3, () => {
    const hwndDlg = emu.readArg(0);
    const controlId = emu.readArg(1);
    const uCheck = emu.readArg(2);
    const child = findChildByControlId(hwndDlg, controlId);
    if (child) child.checked = uCheck & 0x3;
    return 1;
  });

  user32.register('CheckRadioButton', 4, () => {
    const hwndDlg = emu.readArg(0);
    const nFirst = emu.readArg(1);
    const nLast = emu.readArg(2);
    const nCheck = emu.readArg(3);
    const wnd = emu.handles.get<WindowInfo>(hwndDlg);
    if (wnd?.children) {
      for (const [ctrlId, childHwnd] of wnd.children) {
        const child = emu.handles.get<WindowInfo>(childHwnd);
        if (child && ctrlId >= nFirst && ctrlId <= nLast) {
          child.checked = (ctrlId === nCheck) ? 1 : 0;
        }
      }
    }
    return 1;
  });

  user32.register('IsDlgButtonChecked', 2, () => {
    const hwndDlg = emu.readArg(0);
    const controlId = emu.readArg(1);
    const child = findChildByControlId(hwndDlg, controlId);
    return child?.checked ?? 0;
  });

  // MapDialogRect — converts DLU to pixels
  user32.register('MapDialogRect', 2, () => {
    const _hwndDlg = emu.readArg(0);
    const rectPtr = emu.readArg(1);
    if (rectPtr) {
      const left = emu.memory.readI32(rectPtr);
      const top = emu.memory.readI32(rectPtr + 4);
      const right = emu.memory.readI32(rectPtr + 8);
      const bottom = emu.memory.readI32(rectPtr + 12);
      emu.memory.writeU32(rectPtr, dluX(left) >>> 0);
      emu.memory.writeU32(rectPtr + 4, dluY(top) >>> 0);
      emu.memory.writeU32(rectPtr + 8, dluX(right) >>> 0);
      emu.memory.writeU32(rectPtr + 12, dluY(bottom) >>> 0);
    }
    return 1;
  });
}
