import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import { Window, WS_CAPTION, WS_SYSMENU, WS_MINIMIZEBOX, WS_THICKFRAME } from './win2k/Window';
import { Button } from './win2k/Button';
import { loadGeneralSettings, saveGeneralSettings, DEFAULT_PATH, type GeneralSettings } from '../lib/general-settings';
import { t } from '../lib/regional-settings';

const FONT = '11px "Tahoma", sans-serif';
const INIT_W = 320;
const INIT_H = 280;

interface Props {
  onClose: () => void;
  onFocus: () => void;
  onMinimize: () => void;
  zIndex: number;
  focused: boolean;
  minimized: boolean;
}

/** Convert semicolon-separated PATH to one-per-line for editing. */
function pathToLines(path: string): string {
  return path.split(';').filter(Boolean).join('\n');
}

/** Convert one-per-line back to semicolons. */
function linesToPath(text: string): string {
  return text.split('\n').map(s => s.trim()).filter(Boolean).join(';');
}

export function GeneralSettingsWindow({ onClose, onFocus, onMinimize, zIndex, focused, minimized }: Props) {
  const [settings, setSettings] = useState<GeneralSettings>(loadGeneralSettings);
  const [pathText, setPathText] = useState(() => pathToLines(settings.path));
  const [windowPos, setWindowPos] = useState({ x: Math.max(0, (window.innerWidth - INIT_W) / 2), y: Math.max(0, (window.innerHeight - INIT_H) / 2) });
  const [clientSize, setClientSize] = useState({ w: INIT_W, h: INIT_H });
  const moveDrag = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const resizeDrag = useRef<{ edge: string; startX: number; startY: number; startW: number; startH: number; startPosX: number; startPosY: number } | null>(null);

  const handleOK = () => {
    saveGeneralSettings({ ...settings, path: linesToPath(pathText) });
    onClose();
  };

  const handleReset = () => {
    setPathText(pathToLines(DEFAULT_PATH));
  };

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const m = moveDrag.current;
      if (m) { setWindowPos({ x: m.startPosX + e.clientX - m.startX, y: m.startPosY + e.clientY - m.startY }); return; }
      const d = resizeDrag.current;
      if (!d) return;
      const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
      let w = d.startW, h = d.startH, px = d.startPosX, py = d.startPosY;
      if (d.edge.includes('e')) w = d.startW + dx;
      if (d.edge.includes('w')) { w = d.startW - dx; px = d.startPosX + dx; }
      if (d.edge.includes('s')) h = d.startH + dy;
      if (d.edge.includes('n')) { h = d.startH - dy; py = d.startPosY + dy; }
      const minW = 240, minH = 160;
      if (w < minW) { if (d.edge.includes('w')) px -= minW - w; w = minW; }
      if (h < minH) { if (d.edge.includes('n')) py -= minH - h; h = minH; }
      setClientSize({ w, h });
      setWindowPos({ x: px, y: py });
    };
    const onPointerUp = () => { moveDrag.current = null; resizeDrag.current = null; };
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    return () => { document.removeEventListener('pointermove', onPointerMove); document.removeEventListener('pointerup', onPointerUp); };
  }, []);

  const onTitleBarMouseDown = useCallback((e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('span[style*="border"]')) return;
    e.preventDefault();
    moveDrag.current = { startX: e.clientX, startY: e.clientY, startPosX: windowPos.x, startPosY: windowPos.y };
  }, [windowPos]);

  const onResizeStart = useCallback((edge: string, e: PointerEvent) => {
    e.preventDefault();
    resizeDrag.current = { edge, startX: e.clientX, startY: e.clientY, startW: clientSize.w, startH: clientSize.h, startPosX: windowPos.x, startPosY: windowPos.y };
  }, [clientSize, windowPos]);

  return (
    <div
      style={{ position: 'absolute', left: `${windowPos.x}px`, top: `${windowPos.y}px`, zIndex, display: minimized ? 'none' : undefined, font: '11px/1 "Tahoma", "MS Sans Serif", sans-serif' }}
      onPointerDown={onFocus}
    >
      <Window
        title={t().generalSettings}
        style={WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_THICKFRAME}
        clientW={clientSize.w}
        clientH={clientSize.h}
        focused={focused}
        minimized={minimized}
        onClose={onClose}
        onMinimize={onMinimize}
        onTitleBarMouseDown={onTitleBarMouseDown}
        onResizeStart={onResizeStart}
      >
        <div style={{ background: '#D4D0C8', padding: '12px 14px', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
          {/* PATH */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', marginBottom: '10px', minHeight: 0 }}>
            <div style={{ font: FONT, marginBottom: '4px', fontWeight: 'bold' }}>{t().labelPath}</div>
            <div style={{ font: FONT, marginBottom: '6px', color: '#444' }}>{t().pathHint}</div>
            <textarea
              value={pathText}
              onInput={(e) => setPathText((e.target as HTMLTextAreaElement).value)}
              style={{
                width: '100%', flex: 1, boxSizing: 'border-box',
                background: '#FFF', font: FONT, padding: '2px 3px', resize: 'none',
                border: '2px inset #D4D0C8', outline: 'none',
              }}
            />
          </div>

          <div style={{ borderTop: '1px solid #808080', borderBottom: '1px solid #FFF', margin: '0 0 8px', flexShrink: 0 }} />

          {/* v86 backend */}
          <div style={{ font: FONT, marginBottom: '8px', flexShrink: 0 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.v86Backend}
                onInput={(e) => setSettings({ ...settings, v86Backend: (e.target as HTMLInputElement).checked })}
              />
              Use v86 JIT backend for PE32 (experimental)
            </label>
          </div>

          <div style={{ borderTop: '1px solid #808080', borderBottom: '1px solid #FFF', margin: '0 0 8px', flexShrink: 0 }} />

          {/* Buttons */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', flexShrink: 0 }}>
            <div style={{ width: '75px', height: '23px' }} onClick={handleReset}>
              <Button fontCSS={FONT}>Reset</Button>
            </div>
            <div style={{ width: '75px', height: '23px' }} onClick={handleOK}>
              <Button fontCSS={FONT} isDefault>OK</Button>
            </div>
            <div style={{ width: '75px', height: '23px' }} onClick={onClose}>
              <Button fontCSS={FONT}>{t().cancel}</Button>
            </div>
          </div>
        </div>
      </Window>
    </div>
  );
}
