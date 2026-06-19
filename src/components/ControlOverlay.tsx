import type { ComponentChildren } from 'preact';
import { useCallback } from 'preact/hooks';
import type { Emulator, ControlOverlay } from '../lib/emu/emulator';
import type { WindowInfo } from '../lib/emu/win32/user32/index';
import type { TreeViewItem, ListViewItem, ListViewColumn } from '../lib/emu/win32/user32/types';
import { WM_COMMAND, WS_BORDER, WS_EX_CLIENTEDGE } from '../lib/emu/win32/types';
import { encodeMBCS } from '../lib/emu/memory';
import { Button } from './win2k/Button';
import { Checkbox } from './win2k/Checkbox';
import { Radio } from './win2k/Radio';
import { GroupBox } from './win2k/GroupBox';
import { Edit } from './win2k/Edit';
import { RichEdit } from './win2k/RichEdit';
import { Trackbar } from './win2k/Trackbar';
import { TabControl } from './win2k/TabControl';
import { Static } from './win2k/Static';
import { formatMnemonic } from '../lib/format';
import { ComboBox } from './win2k/ComboBox';

export function ctrlFont(ctrl: ControlOverlay): string {
  const size = ctrl.fontHeight ? `${Math.abs(ctrl.fontHeight)}px` : '12px';
  return `${size}/1 "Tahoma", "MS Sans Serif", Arial, sans-serif`;
}

/** Effective class for rendering: use baseClassName (from superclassing) if available */
export function effectiveClass(ctrl: ControlOverlay): string {
  return ctrl.baseClassName || ctrl.className;
}

// --- Companion Canvas ---
// A transparent canvas layered on top of a control overlay for custom drawing (WM_DRAWITEM / WM_PAINT).
// pointer-events: none so mouse events pass through to the overlay underneath.

function CompanionCanvas({ ctrl, emuRef }: { ctrl: ControlOverlay; emuRef: { current: Emulator | null } }) {
  const ref = useCallback((el: HTMLCanvasElement | null) => {
    const emu = emuRef.current;
    if (!emu) return;
    const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
    if (!wnd) return;
    if (el) {
      el.width = ctrl.width;
      el.height = ctrl.height;
      wnd.domCanvas = el;
      // Invalidate cached DC so next getWindowDC picks up the new canvas
      const oldDC = emu.windowDCs.get(ctrl.childHwnd);
      if (oldDC) { emu.handles.free(oldDC); emu.windowDCs.delete(ctrl.childHwnd); }
      // Mark main window for repaint and wake GetMessage if waiting
      const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow);
      if (mainWnd) {
        mainWnd.needsPaint = true;
        // Post WM_NULL to wake GetMessage so it synthesizes WM_PAINT
        if (emu.mainWindow) emu.postMessage(emu.mainWindow, 0, 0, 0);
      }
    } else {
      wnd.domCanvas = undefined;
      const oldDC = emu.windowDCs.get(ctrl.childHwnd);
      if (oldDC) { emu.handles.free(oldDC); emu.windowDCs.delete(ctrl.childHwnd); }
    }
  }, [ctrl.childHwnd, ctrl.width, ctrl.height]);

  return (
    <canvas
      ref={ref}
      width={ctrl.width}
      height={ctrl.height}
      style={{
        position: 'absolute', left: 0, top: 0,
        width: `${ctrl.width}px`, height: `${ctrl.height}px`,
        pointerEvents: 'none',
        imageRendering: 'pixelated',
      }}
    />
  );
}

// --- Control Overlay Rendering ---

export function renderControlOverlay(
  ctrl: ControlOverlay,
  emuRef: { current: Emulator | null },
  setPressedControl: (id: number | null) => void,
  pressedControl: number | null,
  onResizeStart?: (edge: string, e: PointerEvent) => void,
) {
  const posStyle: Record<string, string | number | undefined> = {
    position: 'absolute',
    left: `${ctrl.x}px`,
    top: `${ctrl.y}px`,
    width: `${ctrl.width}px`,
    height: `${ctrl.height}px`,
    zIndex: 100, // above MDI children (z-index 15+) so toolbar/statusbar aren't covered
  };

  const postCommand = () => {
    const emu = emuRef.current;
    if (!emu || !emu.mainWindow) return;

    // Auto-toggle for BS_AUTOCHECKBOX(3) and BS_AUTORADIOBUTTON(9)
    if (effectiveClass(ctrl) === 'BUTTON') {
      const bsType = ctrl.style & 0xF;
      const childWnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (childWnd) {
        if (bsType === 3) {
          // Toggle checkbox
          childWnd.checked = childWnd.checked ? 0 : 1;
        } else if (bsType === 4 || bsType === 9) {
          // Radio button: uncheck siblings in the same WS_GROUP group, then check this.
          // Windows groups radio buttons by WS_GROUP (0x20000): a new group starts at each
          // control that has WS_GROUP set. Find the contiguous run of radio buttons that
          // contains ctrl.childHwnd and uncheck only those.
          const WS_GROUP = 0x00020000;
          const parentWnd = emu.handles.get<WindowInfo>(childWnd.parent);
          if (parentWnd?.childList) {
            const siblings = parentWnd.childList.map(h => ({
              h, w: emu.handles.get<WindowInfo>(h)!
            })).filter(e => e.w);
            // Find index of clicked radio
            const idx = siblings.findIndex(e => e.h === ctrl.childHwnd);
            if (idx !== -1) {
              // Walk backwards to find group start (first control with WS_GROUP or index 0)
              let start = idx;
              while (start > 0 && !(siblings[start].w.style & WS_GROUP)) start--;
              // Walk forwards to find group end (next control with WS_GROUP or end)
              let end = idx + 1;
              while (end < siblings.length && !(siblings[end].w.style & WS_GROUP)) end++;
              // Uncheck all radio buttons in [start, end)
              for (let i = start; i < end; i++) {
                const sib = siblings[i].w;
                const sibType = sib.style & 0xF;
                if (sib.classInfo.className.toUpperCase() === 'BUTTON' && (sibType === 4 || sibType === 9)) {
                  sib.checked = 0;
                }
              }
            }
          }
          childWnd.checked = 1;
        }
      }
    }

    // Trigger immediate repaint so overlays update
    const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow);
    if (mainWnd) { mainWnd.needsPaint = true; }

    // Immediately refresh control overlays so checkbox/radio state is reflected in React.
    // Must temporarily clear waitingForMessage because notifyControlOverlays may call
    // callWndProc (for WM_CTLCOLORSTATIC), which breaks early if waitingForMessage is true.
    const savedWaiting = emu.waitingForMessage;
    emu.waitingForMessage = false;
    emu.notifyControlOverlays();

    // For modal dialogs, dispatch WM_COMMAND synchronously so the app can update its state.
    // postMessage would sit in the queue until the pump picks it up, but synchronous dispatch
    // ensures immediate visual feedback (e.g. selection highlight on owner-draw buttons).
    const ds = emu.dialogState;
    if (ds && !ds.ended) {
      const WM_COMMAND = 0x0111;
      const dlgWnd = emu.handles.get<WindowInfo>(ds.hwnd);
      const wndProc = dlgWnd?.wndProc || ds.dlgProc;
      if (wndProc) {
        const savedEIP = emu.cpu.eip;
        const savedESP = emu.cpu.reg[4];
        if (emu.isNE) {
          // Win16: wParam = controlId, lParam = MAKELONG(hwndCtl, BN_CLICKED)
          emu.callWndProc16(wndProc, ds.hwnd, WM_COMMAND, ctrl.controlId, ctrl.childHwnd & 0xFFFF);
        } else {
          emu.callWndProc(wndProc, ds.hwnd, WM_COMMAND, ctrl.controlId, ctrl.childHwnd);
        }
        emu.cpu.eip = savedEIP;
        emu.cpu.reg[4] = savedESP;
        // Refresh overlays and trigger owner-draw repaint after state change
        if (!ds.ended) {
          const dlgWndInfo = emu.handles.get<WindowInfo>(ds.hwnd);
          if (dlgWndInfo) dlgWndInfo._ownerDrawPending = true;
          emu.notifyControlOverlays();
        }
      }
      emu.waitingForMessage = savedWaiting;
    } else {
      // Restore waitingForMessage BEFORE posting so the onMessageAvailable
      // callback (triggered by postMessage) can properly transition from waiting→running.
      emu.waitingForMessage = savedWaiting;
      emu.postMessage(emu.mainWindow, WM_COMMAND, ctrl.controlId, ctrl.childHwnd);
    }

    // Resume AudioContext if suspended (user gesture)
    if (emu.audioContext?.state === 'suspended') emu.audioContext.resume();
  };

  const isDisabled = !!(ctrl.style & 0x08000000); // WS_DISABLED

  if (effectiveClass(ctrl) === 'BUTTON') {
    const bsType = ctrl.style & 0xF;

    // Ownerdraw — Button overlay for clicks + companion canvas on top for custom drawing
    if (bsType === 0xB) {
      // Repaint the owner-drawn button so the app redraws it with the new
      // ODS_SELECTED state. Modal dialogs use the dialog pump's
      // _ownerDrawPending flag; modeless windows repaint via WM_PAINT.
      const repaintOwnerDraw = (emu: NonNullable<typeof emuRef.current>) => {
        const ds = emu.dialogState;
        const dlgWnd = ds ? emu.handles.get<WindowInfo>(ds.hwnd) : null;
        if (dlgWnd) {
          dlgWnd._ownerDrawPending = true;
        } else if (emu.mainWindow) {
          const WM_PAINT = 0x000F;
          const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow);
          if (mainWnd) mainWnd.needsPaint = true;
          emu.postMessage(emu.mainWindow, WM_PAINT, 0, 0);
        }
      };
      const onOwnerDrawMouseDown = (e: PointerEvent) => {
        if (isDisabled) return;
        e.preventDefault();
        setPressedControl(ctrl.childHwnd);
        // Send WM_DRAWITEM with ODS_SELECTED to show pressed state
        const emu = emuRef.current;
        if (emu) {
          const childWnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
          if (childWnd) childWnd._odsSelected = true;
          repaintOwnerDraw(emu);
        }
      };
      const onOwnerDrawMouseUp = () => {
        if (isDisabled) return;
        setPressedControl(null);
        const emu = emuRef.current;
        if (emu) {
          const childWnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
          if (childWnd) childWnd._odsSelected = false;
          repaintOwnerDraw(emu);
        }
        postCommand();
      };
      return (
        <div key={ctrl.childHwnd} style={{ ...posStyle, cursor: 'var(--win2k-cursor)', pointerEvents: isDisabled ? 'none' : 'auto' }}
          onPointerDown={onOwnerDrawMouseDown} onPointerUp={onOwnerDrawMouseUp}>
          <Button fontCSS={ctrlFont(ctrl)} disabled={isDisabled}>{formatMnemonic(ctrl.title)}</Button>
          <canvas
            ref={useCallback((el: HTMLCanvasElement | null) => {
              const emu = emuRef.current;
              if (!emu) return;
              const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
              if (!wnd) return;
              if (el) {
                el.width = ctrl.width;
                el.height = ctrl.height;
                wnd.domCanvas = el;
                const oldDC = emu.windowDCs.get(ctrl.childHwnd);
                if (oldDC) { emu.handles.free(oldDC); emu.windowDCs.delete(ctrl.childHwnd); }
                const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow);
                if (mainWnd) { mainWnd.needsPaint = true; if (emu.mainWindow) emu.postMessage(emu.mainWindow, 0, 0, 0); }
              } else {
                wnd.domCanvas = undefined;
                const oldDC = emu.windowDCs.get(ctrl.childHwnd);
                if (oldDC) { emu.handles.free(oldDC); emu.windowDCs.delete(ctrl.childHwnd); }
              }
            }, [ctrl.childHwnd, ctrl.width, ctrl.height])}
            width={ctrl.width}
            height={ctrl.height}
            style={{
              position: 'absolute', left: 0, top: 0,
              width: `${ctrl.width}px`, height: `${ctrl.height}px`,
              pointerEvents: 'none',
              imageRendering: 'pixelated',
              ...(isDisabled ? { filter: 'grayscale(100%) opacity(0.5)' } : {}),
            }}
          />
        </div>
      );
    }

    // GroupBox
    if (bsType === 7) {
      return (
        <div key={ctrl.childHwnd} style={posStyle}>
          <GroupBox label={formatMnemonic(ctrl.title)} fontCSS={ctrlFont(ctrl)}>{null}</GroupBox>
          <CompanionCanvas ctrl={ctrl} emuRef={emuRef} />
        </div>
      );
    }

    // Checkbox (2=checkbox, 3=auto checkbox)
    if (bsType === 2 || bsType === 3) {
      return (
        <div key={ctrl.childHwnd} style={{ ...posStyle, cursor: 'var(--win2k-cursor)', pointerEvents: isDisabled ? 'none' : 'auto' }} onClick={postCommand}>
          <Checkbox fontCSS={ctrlFont(ctrl)} checked={ctrl.checked === 1} disabled={isDisabled}>{formatMnemonic(ctrl.title)}</Checkbox>
          <CompanionCanvas ctrl={ctrl} emuRef={emuRef} />
        </div>
      );
    }

    // Radio (4=radiobutton, 9=auto radiobutton)
    if (bsType === 4 || bsType === 9) {
      return (
        <div key={ctrl.childHwnd} style={{ ...posStyle, cursor: 'var(--win2k-cursor)', pointerEvents: isDisabled ? 'none' : 'auto' }} onClick={postCommand}>
          <Radio fontCSS={ctrlFont(ctrl)} checked={ctrl.checked === 1} disabled={isDisabled}>{formatMnemonic(ctrl.title)}</Radio>
          <CompanionCanvas ctrl={ctrl} emuRef={emuRef} />
        </div>
      );
    }

    // Pushbutton (0) / DefPushbutton (1)
    return (
      <div key={ctrl.childHwnd} style={{ ...posStyle, cursor: 'var(--win2k-cursor)', pointerEvents: isDisabled ? 'none' : 'auto' }} onClick={postCommand}>
        <Button fontCSS={ctrlFont(ctrl)} isDefault={bsType === 1} disabled={isDisabled}>{formatMnemonic(ctrl.title)}</Button>
        <CompanionCanvas ctrl={ctrl} emuRef={emuRef} />
      </div>
    );
  }

  if (effectiveClass(ctrl) === 'STATIC') {
    const ssType = ctrl.style & 0x1F;
    // SS_ICON (0x03) / SS_BITMAP (0x0E) — resolve live emulator handles to image content
    let imageContent: ComponentChildren = undefined;
    if (ssType === 0x03) {
      const emu = emuRef.current;
      if (emu) {
        const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
        if (wnd?.hImage) {
          const icon = emu.handles.get<{ dataUrl?: string }>(wnd.hImage);
          if (icon?.dataUrl) {
            imageContent = <img src={icon.dataUrl} style={{ imageRendering: 'pixelated' }} />;
          }
        }
      }
    } else if (ssType === 0x0E) {
      const emu = emuRef.current;
      if (emu) {
        const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
        if (wnd?.hImage) {
          const bmp = emu.handles.get<import('../lib/emu/win32/gdi32/types').BitmapInfo>(wnd.hImage);
          if (bmp?.canvas) {
            const canvasRef = (el: HTMLCanvasElement | null) => {
              if (!el) return;
              if (el.width !== bmp.width || el.height !== bmp.height) {
                el.width = bmp.width;
                el.height = bmp.height;
              }
              const ctx2d = el.getContext('2d');
              if (ctx2d) ctx2d.drawImage(bmp.canvas, 0, 0);
            };
            imageContent = <canvas ref={canvasRef} style={{ width: `${bmp.width}px`, height: `${bmp.height}px`, imageRendering: 'pixelated' }} />;
          }
        }
      }
    }
    return (
      <div key={ctrl.childHwnd} style={posStyle}>
        <Static style={ctrl.style} text={ctrl.title} fontCSS={ctrlFont(ctrl)} bgColor={ctrl.bgColor} imageContent={imageContent} />
      </div>
    );
  }

  if (effectiveClass(ctrl) === 'EDIT') {
    const multiline = !!(ctrl.style & 0x0004); // ES_MULTILINE
    const password = !!(ctrl.style & 0x0020);   // ES_PASSWORD
    const readonly = !!(ctrl.style & 0x0800);   // ES_READONLY
    const sunken = !!(ctrl.exStyle & WS_EX_CLIENTEDGE);
    const thinBorder = !sunken && !!(ctrl.style & WS_BORDER);
    const onTextChange = (text: string) => {
      const emu = emuRef.current;
      if (!emu) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (wnd) {
        wnd.title = text;
        // Sync text to the local memory buffer (Win16 apps read it directly via LocalLock)
        if (wnd.editBufferHandle) {
          let handle = wnd.editBufferHandle;
          if (emu._localRelocations) {
            let steps = 0;
            while (emu._localRelocations.has(handle) && steps < 20) { handle = emu._localRelocations.get(handle)!; steps++; }
          }
          const dsBase = emu.cpu?.segBases.get(emu.cpu.ds) ?? 0;
          const addr = dsBase + handle;
          const encoded = encodeMBCS(text);
          for (let i = 0; i < encoded.length; i++) {
            emu.memory.writeU8(addr + i, encoded[i]);
          }
          emu.memory.writeU8(addr + encoded.length, 0);
        }
        // Also update dialog controlValues so GetDlgItemInt/GetDlgItemText see it
        if (emu.dialogState && wnd.controlId !== undefined) {
          emu.dialogState.info.controlValues.set(wnd.controlId, text);
        }
        // Notify parent of EN_CHANGE
        const EN_CHANGE = 0x0300;
        const WM_COMMAND = 0x0111;
        const wParam = ((EN_CHANGE << 16) | (wnd.controlId || 0)) >>> 0;
        emu.postMessage(wnd.parent, WM_COMMAND, wParam, ctrl.childHwnd);
      }
    };
    const onEditRef = (el: HTMLTextAreaElement | HTMLInputElement | null) => {
      const emu = emuRef.current;
      if (!emu) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (wnd) {
        wnd.domInput = el ?? undefined;
        if (el) {
          // Save selection when textarea loses focus (e.g. menu click)
          el.addEventListener('blur', () => {
            wnd.editSelStart = el.selectionStart ?? 0;
            wnd.editSelEnd = el.selectionEnd ?? 0;
          });
        }
      }
    };
    return (
      <div key={ctrl.childHwnd} style={posStyle}>
        <Edit fontCSS={ctrlFont(ctrl)} text={ctrl.title} multiline={multiline} password={password} readonly={readonly} sunken={sunken} thinBorder={thinBorder} onTextChange={onTextChange} onRef={onEditRef} />
      </div>
    );
  }

  if (['RICHEDIT20W', 'RICHEDIT20A', 'RICHEDIT'].includes(effectiveClass(ctrl))) {
    const readonly = !!(ctrl.style & 0x0800);   // ES_READONLY
    const onTextChange = (text: string) => {
      const emu = emuRef.current;
      if (!emu) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (wnd) {
        wnd.title = text;
        const EN_CHANGE = 0x0300;
        const WM_COMMAND = 0x0111;
        const wParam = ((EN_CHANGE << 16) | (wnd.controlId || 0)) >>> 0;
        emu.postMessage(wnd.parent, WM_COMMAND, wParam, ctrl.childHwnd);
      }
    };
    return (
      <div key={ctrl.childHwnd} style={posStyle}>
        <RichEdit fontCSS={ctrlFont(ctrl)} text={ctrl.title} readonly={readonly} onTextChange={onTextChange} />
      </div>
    );
  }

  if (effectiveClass(ctrl) === 'LISTBOX') {
    const lbItems = ctrl.lbItems || [];
    const LBS_MULTIPLESEL = 0x0008, LBS_EXTENDEDSEL = 0x0800, LBS_NOSEL = 0x4000;
    const isMultiSel = !!(ctrl.style & (LBS_MULTIPLESEL | LBS_EXTENDEDSEL));
    const noSel = !!(ctrl.style & LBS_NOSEL);
    const selIndex = ctrl.lbSelectedIndex ?? -1;
    const selIndices = new Set(ctrl.lbSelectedIndices || []);

    const LBN_SELCHANGE = 1;
    const LBN_DBLCLK = 2;
    const LBN_SELCANCEL = 3;

    const getParentHwnd = (emu: Emulator): number => {
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      return wnd?.parent || emu.mainWindow || 0;
    };

    const sendLBNotify = (emu: Emulator, code: number) => {
      const parent = getParentHwnd(emu);
      if (!parent) return;
      if (emu.isNE) {
        // Win16 WM_COMMAND: wParam=controlId, lParam=MAKELONG(childHwnd, notifyCode)
        const lParam = ((code & 0xFFFF) << 16) | (ctrl.childHwnd & 0xFFFF);
        emu.postMessage(parent, WM_COMMAND, ctrl.controlId, lParam);
      } else {
        const wParam = ((code << 16) | (ctrl.controlId & 0xFFFF)) >>> 0;
        emu.postMessage(parent, WM_COMMAND, wParam, ctrl.childHwnd);
      }
    };

    const onItemClick = (idx: number, e: MouseEvent) => {
      if (noSel) return;
      const emu = emuRef.current;
      if (!emu) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (!wnd || !wnd.lbItems) return;
      if (isMultiSel) {
        if (!wnd.lbSelectedIndices) wnd.lbSelectedIndices = new Set();
        if (e.ctrlKey || (wnd.style & LBS_MULTIPLESEL)) {
          // Toggle individual item
          if (wnd.lbSelectedIndices.has(idx)) wnd.lbSelectedIndices.delete(idx);
          else wnd.lbSelectedIndices.add(idx);
        } else {
          // Extended sel without Ctrl: single select
          wnd.lbSelectedIndices.clear();
          wnd.lbSelectedIndices.add(idx);
        }
      } else {
        wnd.lbSelectedIndex = idx;
      }
      sendLBNotify(emu, LBN_SELCHANGE);
      emu.notifyControlOverlays();
      const mainWnd = emu.handles.get<WindowInfo>(getParentHwnd(emu));
      if (mainWnd) mainWnd.needsPaint = true;
    };

    const onItemDblClick = (idx: number, _e: MouseEvent) => {
      const emu = emuRef.current;
      if (!emu) return;
      sendLBNotify(emu, LBN_DBLCLK);
      const mainWnd = emu.handles.get<WindowInfo>(getParentHwnd(emu));
      if (mainWnd) mainWnd.needsPaint = true;
    };

    const isSelected = (idx: number): boolean => {
      if (isMultiSel) return selIndices.has(idx);
      return idx === selIndex;
    };

    return (
      <div key={ctrl.childHwnd} style={{
        ...posStyle, background: '#FFF', boxSizing: 'border-box',
        border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
        boxShadow: 'inset 1px 1px 0 #404040, inset -1px -1px 0 #D4D0C8',
        overflow: 'hidden', font: ctrlFont(ctrl) || '11px/1 "Tahoma", "MS Sans Serif", sans-serif',
      }}>
        <div style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden' }}
          onClick={(e: Event) => {
            if (e.target === e.currentTarget && !noSel) {
              // Clicked empty area — deselect
              const emu = emuRef.current;
              if (!emu) return;
              const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
              if (!wnd) return;
              if (isMultiSel) { wnd.lbSelectedIndices?.clear(); }
              else { wnd.lbSelectedIndex = -1; }
              sendLBNotify(emu, LBN_SELCANCEL);
              const mainWnd = emu.handles.get<WindowInfo>(getParentHwnd(emu));
              if (mainWnd) mainWnd.needsPaint = true;
            }
          }}>
          {lbItems.map((text: string, i: number) => {
            const selected = isSelected(i);
            return (
              <div key={i}
                onClick={(e: Event) => { e.stopPropagation(); onItemClick(i, e as MouseEvent); }}
                onDblClick={(e: Event) => { e.stopPropagation(); onItemDblClick(i, e as MouseEvent); }}
                style={{
                  height: '16px', padding: '0 2px', display: 'flex', alignItems: 'center',
                  cursor: 'var(--win2k-cursor)', fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden',
                  background: selected ? '#0A246A' : undefined,
                  color: selected ? '#FFF' : undefined,
                }}>{text}</div>
            );
          })}
        </div>
      </div>
    );
  }

  if (effectiveClass(ctrl) === 'COMBOBOX') {
    const cbItems = ctrl.cbItems || [];
    const selIdx = ctrl.cbSelectedIndex ?? -1;
    const isDisabled = !!(ctrl.style & 0x08000000); // WS_DISABLED

    // Helper: post a CBN_ notification to the combobox's parent
    const postCBN = (notifyCode: number) => {
      const emu = emuRef.current;
      if (!emu) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (!wnd) return;
      const target = wnd.parent || emu.mainWindow || 0;
      if (emu.isNE) {
        const lp = ((notifyCode << 16) | (ctrl.childHwnd & 0xFFFF)) >>> 0;
        emu.postMessage(target, WM_COMMAND, ctrl.controlId & 0xFFFF, lp);
      } else {
        const wp = ((notifyCode << 16) | (ctrl.controlId & 0xFFFF)) >>> 0;
        emu.postMessage(target, WM_COMMAND, wp, ctrl.childHwnd);
      }
    };

    // Called when the dropdown OPENS — sends CBN_SETFOCUS + CBN_DROPDOWN
    // while cbSelectedIndex still holds the OLD value. This lets the app
    // save the current selection (e.g. WINFILE's DriveListMessage saves iSel).
    const onDropdownOpen = () => {
      const CBN_SETFOCUS = 3;
      const CBN_DROPDOWN = 7;
      postCBN(CBN_SETFOCUS);
      postCBN(CBN_DROPDOWN);
    };

    // Called when the user SELECTS an item — updates index then sends
    // CBN_SELCHANGE + CBN_SELENDOK + CBN_CLOSEUP with the new value.
    const onSelChange = (idx: number) => {
      const emu = emuRef.current;
      if (!emu) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (!wnd) return;

      // Update selection
      wnd.cbSelectedIndex = idx;

      // Notifications with new selection
      const CBN_SELCHANGE = 1;
      const CBN_KILLFOCUS = 4;
      const CBN_SELENDOK = 9;
      const CBN_CLOSEUP = 8;
      postCBN(CBN_SELCHANGE);
      postCBN(CBN_SELENDOK);
      postCBN(CBN_CLOSEUP);
      postCBN(CBN_KILLFOCUS);

      // Mark for repaint
      const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow);
      if (mainWnd) mainWnd.needsPaint = true;
      const parentWnd = emu.handles.get<WindowInfo>(wnd.parent || 0);
      if (parentWnd) parentWnd.needsPaint = true;

      // Refresh overlays
      const savedWaiting = emu.waitingForMessage;
      emu.waitingForMessage = false;
      emu.notifyControlOverlays();
      emu.waitingForMessage = savedWaiting;
    };

    // ComboBox display height is always one row; the full height is for the dropdown.
    const cbStyle = { ...posStyle, height: 21 };

    return (
      <div key={ctrl.childHwnd} style={{ ...cbStyle, boxSizing: 'border-box' }}>
        <ComboBox
          items={cbItems}
          selectedIndex={selIdx}
          onSelect={onSelChange}
          onOpen={onDropdownOpen}
          font={ctrlFont(ctrl)}
          disabled={isDisabled}
        />
      </div>
    );
  }

  if (effectiveClass(ctrl) === 'SYSTREEVIEW32') {
    const items = ctrl.treeItems || [];
    const rootItems = items.filter((i: TreeViewItem) => i.parent === 0);
    const TVS_HASBUTTONS = 0x0001, TVS_HASLINES = 0x0002, TVS_LINESATROOT = 0x0004;
    const hasButtons = !!(ctrl.style & TVS_HASBUTTONS);
    const hasLines = !!(ctrl.style & TVS_HASLINES);
    const linesAtRoot = !!(ctrl.style & TVS_LINESATROOT);
    const lineColor = '#808080';
    const dotBg = `url("data:image/svg+xml,${encodeURIComponent(
      `<svg width='2' height='2' xmlns='http://www.w3.org/2000/svg'><rect x='0' y='0' width='1' height='1' fill='${lineColor}'/></svg>`
    )}")`;
    const indent = 15;
    const btnSize = 9;

    const toggleExpand = (item: TreeViewItem) => {
      const emu = emuRef.current;
      if (!emu) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (!wnd?.treeItems) return;
      const treeItem = wnd.treeItems.get(item.id);
      if (treeItem) treeItem.expanded = !treeItem.expanded;
      // Send TVN_ITEMEXPANDEDA notification to parent: WM_NOTIFY with NMTREEVIEW
      const WM_NOTIFY = 0x004E;
      const TVN_ITEMEXPANDEDA = -406;
      const nmhdr = emu.allocHeap(104); // NMTREEVIEWA
      emu.memory.writeU32(nmhdr, ctrl.childHwnd);    // hwndFrom
      emu.memory.writeU32(nmhdr + 4, ctrl.controlId); // idFrom
      emu.memory.writeU32(nmhdr + 8, TVN_ITEMEXPANDEDA & 0xFFFFFFFF); // code
      emu.memory.writeU32(nmhdr + 12, treeItem?.expanded ? 2 : 1); // action: TVE_EXPAND/TVE_COLLAPSE
      // itemNew at offset 56
      emu.memory.writeU32(nmhdr + 56, 0x4); // mask: TVIF_PARAM
      emu.memory.writeU32(nmhdr + 60, item.id); // hItem
      emu.memory.writeU32(nmhdr + 92, item.lParam ?? 0); // lParam
      emu.postMessage(emu.mainWindow!, WM_NOTIFY, ctrl.controlId, nmhdr);
      // Trigger repaint
      const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow!);
      if (mainWnd) mainWnd.needsPaint = true;
    };

    const selectItem = (item: TreeViewItem) => {
      const emu = emuRef.current;
      if (!emu) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (!wnd?.treeItems) return;
      const oldSelected = wnd.treeSelectedItem;
      wnd.treeSelectedItem = item.id;
      // Send TVN_SELCHANGINGA then TVN_SELCHANGEDA notifications
      const WM_NOTIFY = 0x004E;
      const TVN_SELCHANGINGA = -401;
      const TVN_SELCHANGEDA = -402;
      // NMTREEVIEWA: NMHDR(12)+action(4)+itemOld(40)+itemNew(40)+ptDrag(8) = 104 bytes
      const nmhdr = emu.allocHeap(104);
      emu.memory.writeU32(nmhdr, ctrl.childHwnd);
      emu.memory.writeU32(nmhdr + 4, ctrl.controlId);
      // Send TVN_SELCHANGING first
      emu.memory.writeU32(nmhdr + 8, TVN_SELCHANGINGA & 0xFFFFFFFF);
      emu.memory.writeU32(nmhdr + 12, 1); // action: TVC_BYMOUSE
      // itemOld at offset 16: mask(4) hItem(4) state(4) stateMask(4) pszText(4) cchTextMax(4) iImage(4) iSelectedImage(4) cChildren(4) lParam(4)
      if (oldSelected) {
        const oldItem = wnd.treeItems?.get(oldSelected);
        emu.memory.writeU32(nmhdr + 16, 0x4); // mask: TVIF_PARAM
        emu.memory.writeU32(nmhdr + 20, oldSelected); // hItem
        emu.memory.writeU32(nmhdr + 52, oldItem?.lParam ?? 0); // lParam (offset 16+36)
      }
      // itemNew at offset 56
      emu.memory.writeU32(nmhdr + 56, 0x4); // mask: TVIF_PARAM
      emu.memory.writeU32(nmhdr + 60, item.id); // hItem
      emu.memory.writeU32(nmhdr + 92, item.lParam ?? 0); // lParam (offset 56+36)
      emu.postMessage(emu.mainWindow!, WM_NOTIFY, ctrl.controlId, nmhdr);
      // Send TVN_SELCHANGED
      const nmhdr2 = emu.allocHeap(104);
      for (let i = 0; i < 104; i += 4) emu.memory.writeU32(nmhdr2 + i, emu.memory.readU32(nmhdr + i));
      emu.memory.writeU32(nmhdr2 + 8, TVN_SELCHANGEDA & 0xFFFFFFFF);
      emu.postMessage(emu.mainWindow!, WM_NOTIFY, ctrl.controlId, nmhdr2);
      const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow!);
      if (mainWnd) mainWnd.needsPaint = true;
    };

    const imageUrls = ctrl.treeImageUrls || [];

    const renderTreeItem = (item: TreeViewItem, depth: number, isLast: boolean, parentLineDepths: number[]): ComponentChildren => {
      const hasChild = item.children && item.children.length > 0;
      const childItems = hasChild ? items.filter((i: TreeViewItem) => item.children.includes(i.id)) : [];
      const effectiveDepth = linesAtRoot ? depth : depth - 1;
      const lineX = (linesAtRoot ? 0 : -indent) + depth * indent + 7;
      const btnLeft = lineX - 4;
      const iconLeft = (linesAtRoot ? 0 : -indent) + depth * indent + indent + 1;
      const selected = item.id === ctrl.treeSelectedItem;
      const imgIdx = selected ? (item.selectedImageIndex ?? item.imageIndex ?? -1) : (item.imageIndex ?? -1);
      const iconUrl = imgIdx >= 0 && imgIdx < imageUrls.length ? imageUrls[imgIdx] : undefined;
      const textLeft = iconUrl ? iconLeft + 18 : iconLeft;

      return (
        <div key={item.id}>
          <div style={{
            position: 'relative', height: '17px',
            display: 'flex', alignItems: 'center',
            whiteSpace: 'nowrap', overflow: 'visible', cursor: 'var(--win2k-cursor)',
          }} onClick={(e) => { e.stopPropagation(); selectItem(item); }}>
            {/* Vertical continuation lines for ancestors */}
            {hasLines && parentLineDepths.map((d) => {
              const lx = (linesAtRoot ? 0 : -indent) + d * indent + 7;
              return <div key={`vl${d}`} style={{
                position: 'absolute', left: `${lx}px`, top: 0,
                width: '1px', height: '100%',
                backgroundImage: dotBg, backgroundRepeat: 'repeat-y',
              }} />;
            })}
            {/* Vertical line from top to center */}
            {hasLines && (effectiveDepth >= 0) && (
              <div style={{
                position: 'absolute', left: `${lineX}px`, top: 0,
                width: '1px', height: isLast ? '9px' : '100%',
                backgroundImage: dotBg, backgroundRepeat: 'repeat-y',
              }} />
            )}
            {/* Horizontal line to icon */}
            {hasLines && (effectiveDepth >= 0) && (
              <div style={{
                position: 'absolute', left: `${lineX}px`, top: '8px',
                width: `${iconLeft - lineX}px`, height: '1px',
                backgroundImage: dotBg, backgroundRepeat: 'repeat-x',
              }} />
            )}
            {/* Expand/collapse button */}
            {hasButtons && hasChild && (
              <div onClick={(e) => { e.stopPropagation(); toggleExpand(item); }} style={{
                position: 'absolute', left: `${btnLeft}px`, top: '4px',
                width: `${btnSize}px`, height: `${btnSize}px`, boxSizing: 'border-box',
                border: '1px solid #808080', background: '#FFF', zIndex: 2,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '9px', lineHeight: '1', color: '#000', fontFamily: 'monospace',
                cursor: 'pointer',
              }}>
                {item.expanded ? '\u2212' : '+'}
              </div>
            )}
            {/* Item icon from ImageList */}
            {iconUrl && <img src={iconUrl} style={{
              position: 'absolute', left: `${iconLeft}px`, top: '1px',
              width: '16px', height: '16px', imageRendering: 'pixelated',
            }} />}
            {/* Selection highlight + text */}
            <span style={{
              marginLeft: `${textLeft}px`, fontSize: '11px', padding: '0 2px',
              background: selected ? '#0A246A' : 'transparent',
              color: selected ? '#FFF' : '#000',
            }}>{item.text}</span>
          </div>
          {item.expanded && childItems.map((c: TreeViewItem, ci: number) =>
            renderTreeItem(c, depth + 1, ci === childItems.length - 1,
              isLast ? parentLineDepths : [...parentLineDepths, depth])
          )}
        </div>
      );
    };
    return (
      <div key={ctrl.childHwnd} style={{
        ...posStyle, background: '#FFF', boxSizing: 'border-box',
        border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
        boxShadow: 'inset 1px 1px 0 #404040, inset -1px -1px 0 #D4D0C8',
        overflow: 'hidden', font: '11px/1 "Tahoma", "MS Sans Serif", sans-serif',
        padding: '2px 0',
      }}>
        {rootItems.map((item: TreeViewItem, i: number) => renderTreeItem(item, 0, i === rootItems.length - 1, []))}
      </div>
    );
  }

  if (effectiveClass(ctrl) === 'SYSLISTVIEW32') {
    const columns = ctrl.listColumns || [];
    const items = ctrl.listItems || [];
    const LVS_REPORT = 0x0001, LVS_NOCOLUMNHEADER = 0x4000, LVS_SINGLESEL = 0x0004;
    const LVIS_SELECTED = 0x2, LVIS_FOCUSED = 0x1;
    const WM_NOTIFY = 0x004E;
    const LVN_ITEMCHANGING = -100;
    const LVN_ITEMCHANGED = -101;
    const NM_CLICK = -2;
    const NM_DBLCLK = -3;
    const NM_RCLICK = -5;
    const NM_RETURN = -4;
    const LVN_COLUMNCLICK = -108;
    const LVIF_STATE = 0x8;
    const isReport = (ctrl.style & 0x3) === LVS_REPORT;
    const noHeader = !!(ctrl.style & LVS_NOCOLUMNHEADER);
    const singleSel = !!(ctrl.style & LVS_SINGLESEL);
    const showHeader = isReport && !noHeader && columns.length > 0;
    const headerH = showHeader ? 18 : 0;

    const getParentHwnd = (emu: Emulator): number => {
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      return wnd?.parent || emu.mainWindow || 0;
    };

    // Allocate and fill an NMLISTVIEW struct (44 bytes)
    // NMHDR(12) + iItem(4) + iSubItem(4) + uNewState(4) + uOldState(4) + uChanged(4) + ptAction(8) + lParam(4)
    const makeNMListView = (emu: Emulator, code: number, iItem: number, iSubItem: number, uNewState: number, uOldState: number, uChanged: number, lParam: number): number => {
      const nm = emu.allocHeap(44);
      emu.memory.writeU32(nm, ctrl.childHwnd);                 // hwndFrom
      emu.memory.writeU32(nm + 4, ctrl.controlId);             // idFrom
      emu.memory.writeU32(nm + 8, code & 0xFFFFFFFF);          // code
      emu.memory.writeU32(nm + 12, iItem);                     // iItem
      emu.memory.writeU32(nm + 16, iSubItem);                  // iSubItem
      emu.memory.writeU32(nm + 20, uNewState);                 // uNewState
      emu.memory.writeU32(nm + 24, uOldState);                 // uOldState
      emu.memory.writeU32(nm + 28, uChanged);                  // uChanged
      // ptAction at +32 (8 bytes) — left as 0
      emu.memory.writeU32(nm + 40, lParam);                    // lParam
      return nm;
    };

    // Send NMITEMACTIVATE struct for NM_CLICK / NM_DBLCLK / NM_RCLICK
    // NMHDR(12) + iItem(4) + iSubItem(4) + uNewState(4) + uOldState(4) + uChanged(4) + ptAction(8) + lParam(4) + ...
    const sendNMClick = (emu: Emulator, code: number, iItem: number, iSubItem: number) => {
      const parent = getParentHwnd(emu);
      if (!parent) return;
      const nm = makeNMListView(emu, code, iItem, iSubItem, 0, 0, 0, 0);
      emu.postMessage(parent, WM_NOTIFY, ctrl.controlId, nm);
    };

    const sendItemChanged = (emu: Emulator, idx: number, uNewState: number, uOldState: number, lParam: number) => {
      const parent = getParentHwnd(emu);
      if (!parent) return;
      // Send LVN_ITEMCHANGING first — app can return TRUE to deny
      const nmChanging = makeNMListView(emu, LVN_ITEMCHANGING, idx, 0, uNewState, uOldState, LVIF_STATE, lParam);
      emu.postMessage(parent, WM_NOTIFY, ctrl.controlId, nmChanging);
      // Send LVN_ITEMCHANGED
      const nmChanged = makeNMListView(emu, LVN_ITEMCHANGED, idx, 0, uNewState, uOldState, LVIF_STATE, lParam);
      emu.postMessage(parent, WM_NOTIFY, ctrl.controlId, nmChanged);
    };

    const onItemClick = (idx: number, e: MouseEvent) => {
      const emu = emuRef.current;
      if (!emu) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (!wnd || !wnd.listItems) return;
      const item = wnd.listItems[idx];
      if (!item) return;
      const oldState = item.state || 0;
      // Clear selection (unless Ctrl held and multi-select allowed)
      if (singleSel || !e.ctrlKey) {
        for (let i = 0; i < wnd.listItems.length; i++) {
          const it = wnd.listItems[i];
          if (i !== idx && ((it.state || 0) & LVIS_SELECTED)) {
            const prev = it.state || 0;
            it.state = prev & ~(LVIS_SELECTED | LVIS_FOCUSED);
            sendItemChanged(emu, i, it.state, prev, it.lParam || 0);
          }
        }
      }
      // Toggle selection and set focus on clicked item
      const newState = ((oldState ^ LVIS_SELECTED) | LVIS_FOCUSED);
      item.state = newState;
      sendItemChanged(emu, idx, newState, oldState, item.lParam || 0);
      // Send NM_CLICK
      sendNMClick(emu, NM_CLICK, idx, 0);
      const mainWnd = emu.handles.get<WindowInfo>(getParentHwnd(emu));
      if (mainWnd) mainWnd.needsPaint = true;
    };

    const onItemDblClick = (idx: number, _e: MouseEvent) => {
      const emu = emuRef.current;
      if (!emu) return;
      sendNMClick(emu, NM_DBLCLK, idx, 0);
      const mainWnd = emu.handles.get<WindowInfo>(getParentHwnd(emu));
      if (mainWnd) mainWnd.needsPaint = true;
    };

    const onItemContextMenu = (idx: number, e: MouseEvent) => {
      e.preventDefault();
      const emu = emuRef.current;
      if (!emu) return;
      sendNMClick(emu, NM_RCLICK, idx, 0);
      const mainWnd = emu.handles.get<WindowInfo>(getParentHwnd(emu));
      if (mainWnd) mainWnd.needsPaint = true;
    };

    const onColumnClick = (colIdx: number) => {
      const emu = emuRef.current;
      if (!emu) return;
      const parent = getParentHwnd(emu);
      if (!parent) return;
      const nm = makeNMListView(emu, LVN_COLUMNCLICK, -1, colIdx, 0, 0, 0, 0);
      emu.postMessage(parent, WM_NOTIFY, ctrl.controlId, nm);
      const mainWnd = emu.handles.get<WindowInfo>(parent);
      if (mainWnd) mainWnd.needsPaint = true;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const emu = emuRef.current;
      if (!emu) return;
      const parent = getParentHwnd(emu);
      if (!parent) return;
      // Send NM_RETURN
      const nm = emu.allocHeap(12);
      emu.memory.writeU32(nm, ctrl.childHwnd);
      emu.memory.writeU32(nm + 4, ctrl.controlId);
      emu.memory.writeU32(nm + 8, NM_RETURN & 0xFFFFFFFF);
      emu.postMessage(parent, WM_NOTIFY, ctrl.controlId, nm);
    };
    return (
      <div key={ctrl.childHwnd} style={{
        ...posStyle, background: '#FFF', boxSizing: 'border-box',
        border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
        boxShadow: 'inset 1px 1px 0 #404040, inset -1px -1px 0 #D4D0C8',
        overflow: 'hidden', font: '11px/1 "Tahoma", "MS Sans Serif", sans-serif',
        display: 'flex', flexDirection: 'column',
      }}>
        {showHeader && (
          <div style={{ display: 'flex', height: `${headerH}px`, background: '#D4D0C8', flexShrink: 0 }}>
            {columns.map((col: ListViewColumn, i: number) => (
              <div key={i} onClick={() => onColumnClick(i)} style={{
                width: `${col.width}px`, height: '100%', boxSizing: 'border-box',
                border: '1px solid', borderColor: '#FFF #404040 #404040 #FFF',
                boxShadow: 'inset -1px -1px 0 #808080',
                padding: '0 4px', display: 'flex', alignItems: 'center', cursor: 'pointer',
                whiteSpace: 'nowrap', overflow: 'hidden', fontSize: '11px', flexShrink: 0,
              }}>{col.text}</div>
            ))}
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }} tabIndex={0}
          onKeyDown={(e: Event) => onKeyDown(e as KeyboardEvent)}
          onClick={(e: Event) => {
            if (e.target === e.currentTarget) {
              // Clicked empty area — deselect all and send NM_CLICK with iItem=-1
              const emu = emuRef.current;
              if (!emu) return;
              const w = emu.handles.get<WindowInfo>(ctrl.childHwnd);
              if (w?.listItems) {
                for (let i = 0; i < w.listItems.length; i++) {
                  const it = w.listItems[i];
                  if ((it.state || 0) & LVIS_SELECTED) {
                    const prev = it.state || 0;
                    it.state = prev & ~(LVIS_SELECTED | LVIS_FOCUSED);
                    sendItemChanged(emu, i, it.state, prev, it.lParam || 0);
                  }
                }
                sendNMClick(emu, NM_CLICK, -1, 0);
                const mainWnd = emu.handles.get<WindowInfo>(getParentHwnd(emu));
                if (mainWnd) mainWnd.needsPaint = true;
              }
            }
          }}>
          {items.map((item: ListViewItem, i: number) => {
            const selected = !!((item.state || 0) & LVIS_SELECTED);
            return (
              <div key={i}
                onClick={(e: Event) => onItemClick(i, e as MouseEvent)}
                onDblClick={(e: Event) => onItemDblClick(i, e as MouseEvent)}
                onContextMenu={(e: Event) => onItemContextMenu(i, e as MouseEvent)}
                style={{
                  display: 'flex', height: '16px', alignItems: 'center', cursor: 'var(--win2k-cursor)',
                  background: selected ? '#0A246A' : undefined,
                  color: selected ? '#FFF' : undefined,
                }}>
                {columns.length > 0 ? columns.map((col: ListViewColumn, j: number) => (
                  <div key={j} style={{
                    width: `${col.width}px`, padding: '0 4px', fontSize: '11px',
                    overflow: 'hidden', whiteSpace: 'nowrap', flexShrink: 0,
                    textAlign: (col.fmt & 0x3) === 1 ? 'right' : (col.fmt & 0x3) === 2 ? 'center' : 'left',
                  }}>{j === 0 ? item.text : (item.subItems?.[j - 1] ?? '')}</div>
                )) : (
                  <div style={{ padding: '0 4px', fontSize: '11px', overflow: 'hidden', whiteSpace: 'nowrap' }}>{item.text}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (effectiveClass(ctrl) === 'SYSTABCONTROL32') {
    const onTabClick = (index: number) => {
      const emu = emuRef.current;
      if (!emu || !emu.mainWindow) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (!wnd) return;
      const oldIdx = wnd.tabSelectedIndex ?? 0;
      if (index === oldIdx) return;

      const WM_NOTIFY = 0x004E;
      const TCN_SELCHANGING = -552;
      const TCN_SELCHANGE = -551;
      // NMHDR: hwndFrom(4) + idFrom(4) + code(4) = 12 bytes
      const nmhdr = emu.allocHeap(12);
      emu.memory.writeU32(nmhdr, ctrl.childHwnd);
      emu.memory.writeU32(nmhdr + 4, ctrl.controlId);

      // Send TCN_SELCHANGING — if wndproc returns TRUE, cancel the switch
      emu.memory.writeU32(nmhdr + 8, TCN_SELCHANGING & 0xFFFFFFFF);
      emu.postMessage(emu.mainWindow, WM_NOTIFY, ctrl.controlId, nmhdr);

      // Update the selected index on the control
      wnd.tabSelectedIndex = index;

      // Send TCN_SELCHANGE
      emu.memory.writeU32(nmhdr + 8, TCN_SELCHANGE & 0xFFFFFFFF);
      emu.postMessage(emu.mainWindow, WM_NOTIFY, ctrl.controlId, nmhdr);

      // Trigger repaint
      const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow);
      if (mainWnd) mainWnd.needsPaint = true;
    };
    return (
      <div key={ctrl.childHwnd} style={posStyle}>
        <TabControl tabs={ctrl.tabItems || []} selectedIndex={ctrl.tabSelectedIndex ?? 0} onTabClick={onTabClick} />
      </div>
    );
  }

  const ec = effectiveClass(ctrl);
  if (ec === 'MSCTLS_STATUSBAR32' || ec === 'MSCTLS_STATUSBAR') {
    const texts = ctrl.statusTexts || [];
    const SBARS_SIZEGRIP = 0x0100;
    const hasSizeGrip = !!(ctrl.style & SBARS_SIZEGRIP);
    return (
      <div key={ctrl.childHwnd} style={{
        ...posStyle, background: '#D4D0C8', boxSizing: 'border-box',
        display: 'flex', alignItems: 'center',
        font: '11px/1 "Tahoma", "MS Sans Serif", sans-serif',
        borderTop: '1px solid #FFF',
      }}>
        {texts.map((t: string, i: number) => {
          // statusParts contains absolute right-edge positions (like Wine).
          // Value -1 means "extend to right edge". Compute width from positions.
          const parts = ctrl.statusParts || [];
          const rightEdge = (parts[i] != null && parts[i] !== -1) ? parts[i] : undefined;
          const leftEdge = i === 0 ? 0 : (parts[i - 1] != null && parts[i - 1] !== -1 ? parts[i - 1] : undefined);
          const w = (rightEdge != null && leftEdge != null) ? rightEdge - leftEdge : undefined;
          return (
            <div key={i} style={{
              width: w != null ? `${w}px` : undefined,
              flex: w == null ? 1 : undefined,
              flexShrink: w != null ? 0 : undefined,
              padding: '0 2px', margin: '0 1px',
              border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
              height: 'calc(100% - 2px)', display: 'flex', alignItems: 'center',
              overflow: 'hidden', whiteSpace: 'nowrap', fontSize: '11px',
              boxSizing: 'border-box',
            }}>{t}</div>
          );
        })}
        {hasSizeGrip && (
          <svg
            width="13" height="13" viewBox="0 0 13 13"
            style={{ flexShrink: 0, marginLeft: 'auto', marginTop: '3px', cursor: 'se-resize' }}
            onPointerDown={(e: Event) => onResizeStart?.('se', e as PointerEvent)}
          >
            <line x1="11" y1="1" x2="1" y2="11" stroke="#FFF" />
            <line x1="11" y1="2" x2="2" y2="11" stroke="#808080" />
            <line x1="11" y1="5" x2="5" y2="11" stroke="#FFF" />
            <line x1="11" y1="6" x2="6" y2="11" stroke="#808080" />
            <line x1="11" y1="9" x2="9" y2="11" stroke="#FFF" />
            <line x1="11" y1="10" x2="10" y2="11" stroke="#808080" />
          </svg>
        )}
      </div>
    );
  }

  if (effectiveClass(ctrl) === 'MSCTLS_TRACKBAR32') {
    const onTrackMouseDown = (e: PointerEvent) => {
      e.preventDefault();
      const emu = emuRef.current;
      if (!emu || !emu.mainWindow) return;
      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const isVert = !!(ctrl.style & 0x02);
      const tMin = ctrl.trackMin ?? 0;
      const tMax = ctrl.trackMax ?? 100;

      const computePos = (ev: PointerEvent) => {
        const frac = isVert
          ? Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height))
          : Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        return Math.round(tMin + frac * (tMax - tMin));
      };

      const childWnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      const sendTrack = (pos: number, code: number) => {
        if (childWnd) childWnd.trackPos = pos;
        // WM_HSCROLL=0x114, wParam=MAKELONG(code, pos), lParam=childHwnd
        emu.postMessage(emu.mainWindow!, 0x0114, (pos << 16) | code, ctrl.childHwnd);
        if (childWnd) { const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow!); if (mainWnd) mainWnd.needsPaint = true; }
      };

      const pos0 = computePos(e);
      sendTrack(pos0, 5); // TB_THUMBTRACK

      const onMove = (ev: PointerEvent) => sendTrack(computePos(ev), 5);
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        sendTrack(computePos(ev), 4); // TB_THUMBPOSITION
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    return (
      <div key={ctrl.childHwnd} style={posStyle} onPointerDown={onTrackMouseDown}>
        <Trackbar style={ctrl.style} width={ctrl.width} height={ctrl.height}
          pos={ctrl.trackPos} min={ctrl.trackMin} max={ctrl.trackMax} />
      </div>
    );
  }

  return null;
}
