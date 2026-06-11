/** General emulator settings — persisted in localStorage. */

export interface GeneralSettings {
  /** Semicolon-separated search path for executables and DLLs. */
  path: string;
  /** Use the v86 JIT backend for PE32 executables (experimental). */
  v86Backend: boolean;
}

const STORAGE_KEY = 'retrotick-general';

export const DEFAULT_PATH =
  'D:\\DOS;C:\\DOS;D:\\WINDOWS;C:\\WINDOWS;D:\\WINDOWS\\SYSTEM;C:\\WINDOWS\\SYSTEM;' +
  'D:\\WINDOWS\\SYSTEM32;C:\\WINDOWS\\SYSTEM32;D:\\WINDOWS\\SYSTEM32\\WBEM;C:\\WINDOWS\\SYSTEM32\\WBEM';

const DEFAULTS: GeneralSettings = {
  path: DEFAULT_PATH,
  v86Backend: false,
};

export function loadGeneralSettings(): GeneralSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* ignore corrupt data */ }
  return { ...DEFAULTS };
}

export function saveGeneralSettings(settings: GeneralSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new CustomEvent('retrotick-settings-changed'));
}
