import type { Emulator } from '../../emulator';
import { loadSettings, getLocalePreset } from '../../../regional-settings';

export function registerLocale(emu: Emulator): void {
  const kernel32 = emu.registerDll('KERNEL32.DLL');

  kernel32.register('GetACP', 0, () => {
    return getLocalePreset(emu.configuredLcid).ansiCodePage;
  });

  // CPINFO: MaxCharSize(4) + DefaultChar[2](2) + LeadByte[12](12) = 18 bytes
  kernel32.register('GetCPInfo', 2, () => {
    const _cp = emu.readArg(0);
    const ptr = emu.readArg(1);
    // Zero-fill entire struct first
    for (let i = 0; i < 18; i++) emu.memory.writeU8(ptr + i, 0);
    emu.memory.writeU32(ptr, 1); // MaxCharSize = 1 (single-byte)
    // DefaultChar[2] at offset 4 = {0x3F, 0} ('?')
    emu.memory.writeU8(ptr + 4, 0x3F);
    // LeadByte[12] at offset 6 = all zeros (no lead bytes for single-byte CP)
    return 1;
  });

  kernel32.register('IsValidCodePage', 1, () => {
    return 1;
  });

  // BOOL GetStringTypeW(DWORD dwInfoType, LPCWSTR lpSrcStr, int cchSrc, LPWORD lpCharType)
  const CT_CTYPE1 = 0x00000001;
  const CT_CTYPE2 = 0x00000002;
  const CT_CTYPE3 = 0x00000003;

  // CT1 flags
  const C1_UPPER  = 0x0001;
  const C1_LOWER  = 0x0002;
  const C1_DIGIT  = 0x0004;
  const C1_SPACE  = 0x0008;
  const C1_PUNCT  = 0x0010;
  const C1_CNTRL  = 0x0020;
  const C1_BLANK  = 0x0040;
  const C1_XDIGIT = 0x0080;
  const C1_ALPHA  = 0x0100;
  const C1_DEFINED = 0x0200;

  kernel32.register('GetStringTypeW', 4, () => {
    const dwInfoType = emu.readArg(0);
    const lpSrcStr = emu.readArg(1);
    const cchSrc = emu.readArg(2) | 0; // signed
    const lpCharType = emu.readArg(3);

    let len = cchSrc;
    if (len < 0) {
      // -1 means null-terminated
      len = 0;
      while (emu.memory.readU16(lpSrcStr + len * 2) !== 0) len++;
      len++; // include null
    }

    for (let i = 0; i < len; i++) {
      const ch = emu.memory.readU16(lpSrcStr + i * 2);
      let flags = 0;
      if (dwInfoType === CT_CTYPE1) {
        if (ch >= 0x41 && ch <= 0x5A) flags |= C1_UPPER | C1_ALPHA | C1_DEFINED;
        else if (ch >= 0x61 && ch <= 0x7A) flags |= C1_LOWER | C1_ALPHA | C1_DEFINED;
        else if (ch >= 0x30 && ch <= 0x39) flags |= C1_DIGIT | C1_XDIGIT | C1_DEFINED;
        else if (ch === 0x20) flags |= C1_SPACE | C1_BLANK | C1_DEFINED;
        else if (ch === 0x09) flags |= C1_SPACE | C1_BLANK | C1_CNTRL | C1_DEFINED;
        else if (ch >= 0x0A && ch <= 0x0D) flags |= C1_SPACE | C1_CNTRL | C1_DEFINED;
        else if (ch < 0x20 || ch === 0x7F) flags |= C1_CNTRL | C1_DEFINED;
        else if (ch >= 0x21 && ch <= 0x2F) flags |= C1_PUNCT | C1_DEFINED;
        else if (ch >= 0x3A && ch <= 0x40) flags |= C1_PUNCT | C1_DEFINED;
        else if (ch >= 0x5B && ch <= 0x60) flags |= C1_PUNCT | C1_DEFINED;
        else if (ch >= 0x7B && ch <= 0x7E) flags |= C1_PUNCT | C1_DEFINED;
        else if (ch > 0x7F) flags |= C1_DEFINED; // non-ASCII: mark as defined
        // xdigit extras: A-F, a-f
        if ((ch >= 0x41 && ch <= 0x46) || (ch >= 0x61 && ch <= 0x66)) flags |= C1_XDIGIT;
      } else if (dwInfoType === CT_CTYPE2) {
        // simplified: return 0 (no strong directionality info)
        flags = 0;
      } else if (dwInfoType === CT_CTYPE3) {
        // simplified: return 0
        flags = 0;
      }
      emu.memory.writeU16(lpCharType + i * 2, flags);
    }
    return 1;
  });

  /** Fill character type info for ANSI string (shared by GetStringTypeA and GetStringTypeExA) */
  function fillCharTypeA(dwInfoType: number, lpSrcStr: number, cchSrc: number, lpCharType: number): number {
    let len = cchSrc;
    if (len < 0) {
      // -1 means null-terminated
      len = 0;
      while (emu.memory.readU8(lpSrcStr + len) !== 0) len++;
      len++; // include null
    }
    for (let i = 0; i < len; i++) {
      const ch = emu.memory.readU8(lpSrcStr + i);
      let flags = 0;
      if (dwInfoType === CT_CTYPE1) {
        if (ch >= 0x41 && ch <= 0x5A) flags |= C1_UPPER | C1_ALPHA | C1_DEFINED;
        else if (ch >= 0x61 && ch <= 0x7A) flags |= C1_LOWER | C1_ALPHA | C1_DEFINED;
        else if (ch >= 0x30 && ch <= 0x39) flags |= C1_DIGIT | C1_XDIGIT | C1_DEFINED;
        else if (ch === 0x20) flags |= C1_SPACE | C1_BLANK | C1_DEFINED;
        else if (ch === 0x09) flags |= C1_SPACE | C1_BLANK | C1_CNTRL | C1_DEFINED;
        else if (ch >= 0x0A && ch <= 0x0D) flags |= C1_SPACE | C1_CNTRL | C1_DEFINED;
        else if (ch < 0x20 || ch === 0x7F) flags |= C1_CNTRL | C1_DEFINED;
        else if (ch >= 0x21 && ch <= 0x2F) flags |= C1_PUNCT | C1_DEFINED;
        else if (ch >= 0x3A && ch <= 0x40) flags |= C1_PUNCT | C1_DEFINED;
        else if (ch >= 0x5B && ch <= 0x60) flags |= C1_PUNCT | C1_DEFINED;
        else if (ch >= 0x7B && ch <= 0x7E) flags |= C1_PUNCT | C1_DEFINED;
        else if (ch > 0x7F) flags |= C1_DEFINED; // high ANSI
        if ((ch >= 0x41 && ch <= 0x46) || (ch >= 0x61 && ch <= 0x66)) flags |= C1_XDIGIT;
      }
      // CT_CTYPE2 and CT_CTYPE3: leave as 0 (simplified)
      emu.memory.writeU16(lpCharType + i * 2, flags);
    }
    return 1;
  }

  // GetStringTypeA(Locale, dwInfoType, lpSrcStr, cchSrc, lpCharType)
  kernel32.register('GetStringTypeA', 5, () => {
    const _locale = emu.readArg(0);
    const dwInfoType = emu.readArg(1);
    const lpSrcStr = emu.readArg(2);
    const cchSrc = emu.readArg(3) | 0;
    const lpCharType = emu.readArg(4);
    return fillCharTypeA(dwInfoType, lpSrcStr, cchSrc, lpCharType);
  });

  // GetStringTypeExA(Locale, dwInfoType, lpSrcStr, cchSrc, lpCharType)
  kernel32.register('GetStringTypeExA', 5, () => {
    const _locale = emu.readArg(0);
    const dwInfoType = emu.readArg(1);
    const lpSrcStr = emu.readArg(2);
    const cchSrc = emu.readArg(3) | 0;
    const lpCharType = emu.readArg(4);
    return fillCharTypeA(dwInfoType, lpSrcStr, cchSrc, lpCharType);
  });

  const LCMAP_LOWERCASE = 0x00000100;
  const LCMAP_UPPERCASE = 0x00000200;
  const LCMAP_SORTKEY   = 0x00000400;

  kernel32.register('LCMapStringA', 6, () => {
    const _locale = emu.readArg(0);
    const dwMapFlags = emu.readArg(1);
    const lpSrcStr = emu.readArg(2);
    let cchSrc = emu.readArg(3) | 0;
    const lpDestStr = emu.readArg(4);
    const cchDest = emu.readArg(5);

    if (cchSrc === -1) {
      cchSrc = 0;
      while (emu.memory.readU8(lpSrcStr + cchSrc) !== 0) cchSrc++;
      cchSrc++; // include null
    }

    if (dwMapFlags & LCMAP_SORTKEY) {
      // Sort key: produce simplified byte sequence (char + 1 for each byte, terminated by 0x01 0x01 0x00)
      const needed = cchSrc + 3;
      if (cchDest === 0) return needed;
      const n = Math.min(cchSrc, cchDest - 3);
      for (let i = 0; i < n; i++) {
        const ch = emu.memory.readU8(lpSrcStr + i);
        const lower = (ch >= 0x41 && ch <= 0x5A) ? ch + 0x20 : ch;
        emu.memory.writeU8(lpDestStr + i, lower + 1);
      }
      if (n + 2 < cchDest) { emu.memory.writeU8(lpDestStr + n, 0x01); emu.memory.writeU8(lpDestStr + n + 1, 0x01); emu.memory.writeU8(lpDestStr + n + 2, 0x00); }
      return n + 3;
    }

    if (cchDest === 0) return cchSrc;
    const n = Math.min(cchSrc, cchDest);
    for (let i = 0; i < n; i++) {
      let ch = emu.memory.readU8(lpSrcStr + i);
      if (dwMapFlags & LCMAP_LOWERCASE) {
        if (ch >= 0x41 && ch <= 0x5A) ch += 0x20;
      } else if (dwMapFlags & LCMAP_UPPERCASE) {
        if (ch >= 0x61 && ch <= 0x7A) ch -= 0x20;
      }
      emu.memory.writeU8(lpDestStr + i, ch);
    }
    return n;
  });

  kernel32.register('LCMapStringW', 6, () => {
    const _locale = emu.readArg(0);
    const dwMapFlags = emu.readArg(1);
    const lpSrcStr = emu.readArg(2);
    let cchSrc = emu.readArg(3) | 0;
    const lpDestStr = emu.readArg(4);
    const cchDest = emu.readArg(5);

    if (cchSrc === -1) {
      cchSrc = 0;
      while (emu.memory.readU16(lpSrcStr + cchSrc * 2) !== 0) cchSrc++;
      cchSrc++; // include null
    }

    if (dwMapFlags & LCMAP_SORTKEY) {
      // Sort key: output byte array (not wide), 1 byte per char + separators + null
      const needed = cchSrc + 3;
      if (cchDest === 0) return needed;
      const n = Math.min(cchSrc, cchDest - 3);
      for (let i = 0; i < n; i++) {
        const ch = emu.memory.readU16(lpSrcStr + i * 2);
        const lower = (ch >= 0x41 && ch <= 0x5A) ? ch + 0x20 : ch;
        emu.memory.writeU8(lpDestStr + i, (lower < 0xFF ? lower : 0xFF) + 1);
      }
      if (n + 2 < cchDest) { emu.memory.writeU8(lpDestStr + n, 0x01); emu.memory.writeU8(lpDestStr + n + 1, 0x01); emu.memory.writeU8(lpDestStr + n + 2, 0x00); }
      return n + 3;
    }

    if (cchDest === 0) return cchSrc;
    const n = Math.min(cchSrc, cchDest);
    for (let i = 0; i < n; i++) {
      let ch = emu.memory.readU16(lpSrcStr + i * 2);
      if (dwMapFlags & LCMAP_LOWERCASE) {
        if (ch >= 0x41 && ch <= 0x5A) ch += 0x20;
      } else if (dwMapFlags & LCMAP_UPPERCASE) {
        if (ch >= 0x61 && ch <= 0x7A) ch -= 0x20;
      }
      emu.memory.writeU16(lpDestStr + i * 2, ch);
    }
    return n;
  });

  function getLocaleDefaults(): Record<number, string> {
    const preset = getLocalePreset(emu.configuredLcid);
    return {
      0x0001: '0',                      // LOCALE_ILANGUAGE
      0x0002: preset.name,
      0x000C: preset.listSep,
      0x000D: preset.measure,
      0x000E: preset.decimalSep,
      0x000F: preset.thousandsSep,
      0x0010: preset.grouping,
      0x0011: preset.iDigits,
      0x0012: preset.iLZero,
      0x001D: preset.dateSep,
      0x001E: preset.timeSep,
      0x001F: preset.shortDate,
      0x0020: preset.longDate,
      0x0023: preset.iTime,
      0x0025: preset.iTLZero,
      0x0028: preset.am,
      0x0029: preset.pm,
      0x1003: preset.timeFormat,
      0x1005: '0',                      // LOCALE_ITIMEMARKPOSN
    };
  }

  const LOCALE_RETURN_NUMBER = 0x20000000;

  kernel32.register('GetLocaleInfoA', 4, () => {
    const _lcid = emu.readArg(0);
    const lcType = emu.readArg(1);
    const buf = emu.readArg(2);
    const cchBuf = emu.readArg(3);
    const defaults = getLocaleDefaults();
    const key = lcType & 0xFFFF;
    const hasKey = key in defaults;
    if (!hasKey) return 0; // unknown locale type
    const str = defaults[key];
    if (lcType & LOCALE_RETURN_NUMBER) {
      // Return numeric value as DWORD
      const val = parseInt(str, 10) || 0;
      if (cchBuf === 0) return 4; // sizeof(DWORD)
      if (buf && cchBuf >= 4) emu.memory.writeU32(buf, val);
      return 4;
    }
    if (cchBuf === 0) return str.length + 1;
    if (buf && cchBuf > 0) {
      for (let i = 0; i < Math.min(str.length, cchBuf - 1); i++) {
        emu.memory.writeU8(buf + i, str.charCodeAt(i) & 0xFF);
      }
      emu.memory.writeU8(buf + Math.min(str.length, cchBuf - 1), 0);
    }
    return Math.min(str.length + 1, cchBuf);
  });
  kernel32.register('GetLocaleInfoW', 4, () => {
    const _lcid = emu.readArg(0);
    const lcType = emu.readArg(1);
    const buf = emu.readArg(2);
    const cchBuf = emu.readArg(3);
    const defaults = getLocaleDefaults();
    const key = lcType & 0xFFFF;
    const hasKey = key in defaults;
    if (!hasKey) return 0; // unknown locale type
    const str = defaults[key];
    if (lcType & LOCALE_RETURN_NUMBER) {
      const val = parseInt(str, 10) || 0;
      if (cchBuf === 0) return 2; // sizeof(DWORD) in WCHARs
      if (buf && cchBuf >= 2) emu.memory.writeU32(buf, val);
      return 2;
    }
    if (cchBuf === 0) return str.length + 1; // query size
    if (buf && cchBuf > 0) {
      for (let i = 0; i < Math.min(str.length, cchBuf - 1); i++) {
        emu.memory.writeU16(buf + i * 2, str.charCodeAt(i));
      }
      emu.memory.writeU16(buf + Math.min(str.length, cchBuf - 1) * 2, 0);
    }
    return Math.min(str.length + 1, cchBuf);
  });
  // GetNumberFormatW: format a number string with locale-specific grouping/separators
  // int GetNumberFormatW(LCID, DWORD, LPCWSTR lpValue, const NUMBERFMTW*, LPWSTR, int)
  kernel32.register('GetNumberFormatW', 6, () => {
    const _locale = emu.readArg(0);
    const _dwFlags = emu.readArg(1);
    const lpValue = emu.readArg(2);
    const lpFormat = emu.readArg(3);
    const lpBuf = emu.readArg(4);
    const cchBuf = emu.readArg(5);

    const valueStr = emu.memory.readUTF16String(lpValue);

    // Parse format or use locale defaults
    const nfPreset = getLocalePreset(emu.configuredLcid);
    let numDigits = 0;
    let leadingZero = 1;
    let grouping = 3;
    let decSep = nfPreset.decimalSep;
    let thousandSep = nfPreset.thousandsSep;
    let negOrder = 1;

    if (lpFormat) {
      numDigits = emu.memory.readU32(lpFormat);
      leadingZero = emu.memory.readU32(lpFormat + 4);
      grouping = emu.memory.readU32(lpFormat + 8);
      const decSepPtr = emu.memory.readU32(lpFormat + 12);
      const thousandSepPtr = emu.memory.readU32(lpFormat + 16);
      negOrder = emu.memory.readU32(lpFormat + 20);
      if (decSepPtr) decSep = emu.memory.readUTF16String(decSepPtr);
      if (thousandSepPtr) thousandSep = emu.memory.readUTF16String(thousandSepPtr);
    }

    // Format the number
    const num = parseFloat(valueStr);
    const isNeg = num < 0;
    const abs = Math.abs(num);
    let formatted = abs.toFixed(numDigits);

    // Apply thousand separators to integer part
    const parts = formatted.split('.');
    let intPart = parts[0];
    if (grouping > 0 && thousandSep) {
      let result = '';
      let count = 0;
      for (let i = intPart.length - 1; i >= 0; i--) {
        if (count > 0 && count % grouping === 0) result = thousandSep + result;
        result = intPart[i] + result;
        count++;
      }
      intPart = result;
    }
    formatted = parts.length > 1 ? intPart + decSep + parts[1] : intPart;

    // Handle leading zero
    if (!leadingZero && formatted.startsWith('0' + decSep)) {
      formatted = formatted.substring(1);
    }

    // Handle negative
    if (isNeg) {
      switch (negOrder) {
        case 0: formatted = '(' + formatted + ')'; break;
        case 1: formatted = '-' + formatted; break;
        case 2: formatted = '- ' + formatted; break;
        case 3: formatted = formatted + '-'; break;
        case 4: formatted = formatted + ' -'; break;
      }
    }

    if (cchBuf === 0) return formatted.length + 1;
    if (lpBuf && cchBuf > 0) {
      const toWrite = formatted.substring(0, cchBuf - 1);
      for (let i = 0; i < toWrite.length; i++) {
        emu.memory.writeU16(lpBuf + i * 2, toWrite.charCodeAt(i));
      }
      emu.memory.writeU16(lpBuf + toWrite.length * 2, 0);
    }
    return formatted.length + 1;
  });

  kernel32.register('GetOEMCP', 0, () => {
    return getLocalePreset(emu.configuredLcid).oemCodePage;
  });
  kernel32.register('GetUserDefaultLCID', 0, () => {
    return emu.configuredLcid;
  });
  kernel32.register('GetSystemDefaultLCID', 0, () => emu.configuredLcid);
  kernel32.register('GetThreadLocale', 0, () => emu.configuredLcid);
  // LCID ConvertDefaultLocale(LCID Locale) — resolve LOCALE_USER_DEFAULT (0)
  // and LOCALE_SYSTEM_DEFAULT (0x400) to the actual LCID; pass others through.
  const LOCALE_USER_DEFAULT = 0x0400;
  const LOCALE_SYSTEM_DEFAULT = 0x0800;
  kernel32.register('ConvertDefaultLocale', 1, () => {
    const lcid = emu.readArg(0);
    if (lcid === 0 || lcid === LOCALE_USER_DEFAULT || lcid === LOCALE_SYSTEM_DEFAULT) {
      return emu.configuredLcid;
    }
    return lcid;
  });
  kernel32.register('IsDBCSLeadByte', 1, () => 0);
  kernel32.register('IsDBCSLeadByteEx', 2, () => 0);
  kernel32.register('GetUserDefaultLangID', 0, () => emu.configuredLcid & 0xFFFF);

  // --- Date/Time formatting helpers ---

  const DATE_SHORTDATE = 0x00000001;
  const DATE_LONGDATE  = 0x00000002;
  const TIME_NOSECONDS = 0x00000002;
  const TIME_FORCE24HOURFORMAT = 0x00000008;

  /** Read a SYSTEMTIME struct (16 bytes) or return current time if ptr is 0 */
  function readSystemTime(ptr: number): { year: number; month: number; dow: number; day: number; hour: number; min: number; sec: number } {
    if (ptr === 0) {
      const now = new Date();
      return { year: now.getFullYear(), month: now.getMonth() + 1, dow: now.getDay(), day: now.getDate(), hour: now.getHours(), min: now.getMinutes(), sec: now.getSeconds() };
    }
    return {
      year: emu.memory.readU16(ptr),
      month: emu.memory.readU16(ptr + 2),
      dow: emu.memory.readU16(ptr + 4),
      day: emu.memory.readU16(ptr + 6),
      hour: emu.memory.readU16(ptr + 8),
      min: emu.memory.readU16(ptr + 10),
      sec: emu.memory.readU16(ptr + 12),
    };
  }

  /** Format a date string using Win32 date picture format (d, dd, ddd, dddd, M, MM, MMM, MMMM, y, yy, yyyy) */
  function formatDatePicture(fmt: string, st: { year: number; month: number; dow: number; day: number }, preset: import('../../../regional-settings').LocalePreset): string {
    let result = '';
    let i = 0;
    while (i < fmt.length) {
      const ch = fmt[i];
      if (ch === "'") {
        // Quoted literal
        i++;
        while (i < fmt.length && fmt[i] !== "'") { result += fmt[i]; i++; }
        i++; // skip closing quote
      } else if (ch === 'd') {
        let count = 0;
        while (i < fmt.length && fmt[i] === 'd') { count++; i++; }
        if (count === 1) result += String(st.day);
        else if (count === 2) result += String(st.day).padStart(2, '0');
        else if (count === 3) {
          // ddd = abbreviated day name; dow: 0=Sun in JS Date, but SYSTEMTIME also 0=Sun
          const idx = st.dow === 0 ? 6 : st.dow - 1; // convert to Mon=0..Sun=6
          result += preset.dayAbbr[idx];
        } else {
          const idx = st.dow === 0 ? 6 : st.dow - 1;
          result += preset.dayNames[idx];
        }
      } else if (ch === 'M') {
        let count = 0;
        while (i < fmt.length && fmt[i] === 'M') { count++; i++; }
        if (count === 1) result += String(st.month);
        else if (count === 2) result += String(st.month).padStart(2, '0');
        else if (count === 3) result += preset.monthAbbr[st.month - 1];
        else result += preset.monthNames[st.month - 1];
      } else if (ch === 'y') {
        let count = 0;
        while (i < fmt.length && fmt[i] === 'y') { count++; i++; }
        if (count <= 2) result += String(st.year % 100).padStart(2, '0');
        else result += String(st.year);
      } else {
        result += ch;
        i++;
      }
    }
    return result;
  }

  /** Format a time string using Win32 time picture format (h, hh, H, HH, m, mm, s, ss, t, tt) */
  function formatTimePicture(fmt: string, st: { hour: number; min: number; sec: number }, preset: import('../../../regional-settings').LocalePreset, flags: number): string {
    let result = '';
    let i = 0;
    const force24 = !!(flags & TIME_FORCE24HOURFORMAT);
    while (i < fmt.length) {
      const ch = fmt[i];
      if (ch === "'") {
        i++;
        while (i < fmt.length && fmt[i] !== "'") { result += fmt[i]; i++; }
        i++;
      } else if (ch === 'h') {
        let count = 0;
        while (i < fmt.length && fmt[i] === 'h') { count++; i++; }
        if (force24) {
          result += count >= 2 ? String(st.hour).padStart(2, '0') : String(st.hour);
        } else {
          const h12 = st.hour % 12 || 12;
          result += count >= 2 ? String(h12).padStart(2, '0') : String(h12);
        }
      } else if (ch === 'H') {
        let count = 0;
        while (i < fmt.length && fmt[i] === 'H') { count++; i++; }
        result += count >= 2 ? String(st.hour).padStart(2, '0') : String(st.hour);
      } else if (ch === 'm') {
        let count = 0;
        while (i < fmt.length && fmt[i] === 'm') { count++; i++; }
        result += count >= 2 ? String(st.min).padStart(2, '0') : String(st.min);
      } else if (ch === 's') {
        let count = 0;
        while (i < fmt.length && fmt[i] === 's') { count++; i++; }
        if (!(flags & TIME_NOSECONDS)) {
          result += count >= 2 ? String(st.sec).padStart(2, '0') : String(st.sec);
        }
      } else if (ch === 't') {
        let count = 0;
        while (i < fmt.length && fmt[i] === 't') { count++; i++; }
        if (!force24) {
          const marker = st.hour < 12 ? preset.am : preset.pm;
          result += count >= 2 ? marker : marker.charAt(0);
        }
      } else {
        // Handle ':' preceding or following seconds when TIME_NOSECONDS
        if (ch === ':' && (flags & TIME_NOSECONDS) && i + 1 < fmt.length && fmt[i + 1] === 's') {
          i++; // skip the colon, the 's' handler will skip itself
        } else {
          result += ch;
          i++;
        }
      }
    }
    return result;
  }

  // GetDateFormatW(LCID, DWORD dwFlags, SYSTEMTIME*, LPCWSTR lpFormat, LPWSTR, int)
  kernel32.register('GetDateFormatW', 6, () => {
    const _lcid = emu.readArg(0);
    const dwFlags = emu.readArg(1);
    const lpDate = emu.readArg(2);
    const lpFormat = emu.readArg(3);
    const lpBuf = emu.readArg(4);
    const cchBuf = emu.readArg(5);

    const dfwPreset = getLocalePreset(emu.configuredLcid);
    const st = readSystemTime(lpDate);

    let fmt: string;
    if (lpFormat) {
      fmt = emu.memory.readUTF16String(lpFormat);
    } else if (dwFlags & DATE_LONGDATE) {
      fmt = dfwPreset.longDate;
    } else {
      fmt = dfwPreset.shortDate;
    }

    const result = formatDatePicture(fmt, st, dfwPreset);

    if (cchBuf === 0) return result.length + 1;
    if (lpBuf && cchBuf > 0) {
      const toWrite = result.substring(0, cchBuf - 1);
      for (let j = 0; j < toWrite.length; j++) {
        emu.memory.writeU16(lpBuf + j * 2, toWrite.charCodeAt(j));
      }
      emu.memory.writeU16(lpBuf + toWrite.length * 2, 0);
    }
    return result.length + 1;
  });

  // GetTimeFormatW(LCID, DWORD dwFlags, SYSTEMTIME*, LPCWSTR lpFormat, LPWSTR, int)
  kernel32.register('GetTimeFormatW', 6, () => {
    const _lcid = emu.readArg(0);
    const dwFlags = emu.readArg(1);
    const lpTime = emu.readArg(2);
    const lpFormat = emu.readArg(3);
    const lpBuf = emu.readArg(4);
    const cchBuf = emu.readArg(5);

    const tfwPreset = getLocalePreset(emu.configuredLcid);
    const st = readSystemTime(lpTime);

    let fmt: string;
    if (lpFormat) {
      fmt = emu.memory.readUTF16String(lpFormat);
    } else {
      fmt = tfwPreset.timeFormat;
    }

    const result = formatTimePicture(fmt, st, tfwPreset, dwFlags);

    if (cchBuf === 0) return result.length + 1;
    if (lpBuf && cchBuf > 0) {
      const toWrite = result.substring(0, cchBuf - 1);
      for (let j = 0; j < toWrite.length; j++) {
        emu.memory.writeU16(lpBuf + j * 2, toWrite.charCodeAt(j));
      }
      emu.memory.writeU16(lpBuf + toWrite.length * 2, 0);
    }
    return result.length + 1;
  });
  kernel32.register('FormatMessageW', 7, () => {
    const FORMAT_MESSAGE_FROM_STRING = 0x00000400;
    const FORMAT_MESSAGE_FROM_HMODULE = 0x00000800;
    const FORMAT_MESSAGE_FROM_SYSTEM = 0x00001000;
    const FORMAT_MESSAGE_IGNORE_INSERTS = 0x00000200;
    const FORMAT_MESSAGE_ARGUMENT_ARRAY = 0x00002000;
    const FORMAT_MESSAGE_ALLOCATE_BUFFER = 0x00000100;
    const RT_MESSAGETABLE = 11;

    const dwFlags = emu.readArg(0);
    const lpSource = emu.readArg(1);
    const dwMessageId = emu.readArg(2);
    const _dwLanguageId = emu.readArg(3);
    const lpBuffer = emu.readArg(4);
    const nSize = emu.readArg(5);
    const vaArgs = emu.readArg(6);

    // Try to find message from module's message table resource
    let msgText: string | null = null;
    if (dwFlags & FORMAT_MESSAGE_FROM_STRING) {
      // lpSource is a pointer to the format string
      if (lpSource) {
        msgText = emu.memory.readUTF16String(lpSource);
      }
    } else if (dwFlags & (FORMAT_MESSAGE_FROM_HMODULE | FORMAT_MESSAGE_FROM_SYSTEM)) {
      // Find RT_MESSAGETABLE resource (ID 1 is typical)
      const entry = emu.findResourceEntry(RT_MESSAGETABLE, 1);
      if (entry) {
        const dataAddr = (emu.pe.imageBase + entry.dataRva) >>> 0;
        const numBlocks = emu.memory.readU32(dataAddr);
        let blockOff = dataAddr + 4;
        for (let i = 0; i < numBlocks; i++) {
          const lowId = emu.memory.readU32(blockOff);
          const highId = emu.memory.readU32(blockOff + 4);
          const offsetToEntries = emu.memory.readU32(blockOff + 8);
          blockOff += 12;
          if (dwMessageId >= lowId && dwMessageId <= highId) {
            // Walk entries from lowId to dwMessageId
            let entryAddr = dataAddr + offsetToEntries;
            for (let id = lowId; id <= highId; id++) {
              const entryLen = emu.memory.readU16(entryAddr);
              const flags = emu.memory.readU16(entryAddr + 2); // 0=ANSI, 1=Unicode
              if (id === dwMessageId) {
                if (flags & 1) {
                  // Unicode
                  let s = '';
                  for (let k = 4; k < entryLen - 2; k += 2) {
                    const ch = emu.memory.readU16(entryAddr + k);
                    if (ch === 0) break;
                    s += String.fromCharCode(ch);
                  }
                  msgText = s;
                } else {
                  // ANSI
                  let s = '';
                  for (let k = 4; k < entryLen - 1; k++) {
                    const ch = emu.memory.readU8(entryAddr + k);
                    if (ch === 0) break;
                    s += String.fromCharCode(ch);
                  }
                  msgText = s;
                }
                break;
              }
              entryAddr += entryLen;
            }
            break;
          }
        }
      }
    }

    if (msgText === null) return 0;

    // Handle %0 — terminates output (truncate everything from %0 onwards)
    const pctZeroIdx = msgText.indexOf('%0');
    if (pctZeroIdx >= 0) msgText = msgText.substring(0, pctZeroIdx);

    // Handle argument substitution unless IGNORE_INSERTS
    if (!(dwFlags & FORMAT_MESSAGE_IGNORE_INSERTS) && vaArgs) {
      // Replace %1, %2, etc. with arguments (treat as string pointers)
      msgText = msgText.replace(/%(\d+)/g, (_match, numStr) => {
        const idx = parseInt(numStr) - 1;
        let argBase: number;
        if (dwFlags & FORMAT_MESSAGE_ARGUMENT_ARRAY) {
          // vaArgs points directly to an array of DWORD_PTR values
          argBase = vaArgs;
        } else {
          // vaArgs is a va_list* — dereference once to get the args base
          argBase = emu.memory.readU32(vaArgs);
        }
        const argVal = emu.memory.readU32(argBase + idx * 4);
        if (argVal) {
          try { return emu.memory.readUTF16String(argVal); } catch { /* */ }
        }
        return '';
      });
    }

    // Write to buffer
    if (dwFlags & FORMAT_MESSAGE_ALLOCATE_BUFFER) {
      const allocSize = (msgText.length + 1) * 2;
      const bufAddr = emu.allocHeap(allocSize);
      emu.memory.writeUTF16String(bufAddr, msgText);
      emu.memory.writeU32(lpBuffer, bufAddr);
    } else if (lpBuffer && nSize > 0) {
      const toWrite = msgText.substring(0, nSize - 1);
      emu.memory.writeUTF16String(lpBuffer, toWrite);
    }
    return msgText.length;
  });
  kernel32.register('FormatMessageA', 7, () => {
    // Simplified A variant - return 0 (failure) for now
    return 0;
  });
  kernel32.register('FoldStringW', 5, () => 0);

  // EnumSystemLocalesW: return TRUE without calling callback
  // CRT uses this to build locale tables; empty table still works
  kernel32.register('EnumSystemLocalesW', 2, () => 1);

  // IsValidLocale: return TRUE for any locale
  kernel32.register('IsValidLocale', 2, () => {
    return 1; // TRUE — locale is valid
  });

  // GetUserDefaultUILanguage / GetSystemDefaultUILanguage: return configured locale
  kernel32.register('GetUserDefaultUILanguage', 0, () => emu.configuredLcid & 0xFFFF);
  kernel32.register('GetSystemDefaultUILanguage', 0, () => emu.configuredLcid & 0xFFFF);

  // SetThreadUILanguage: return the language passed in
  kernel32.register('SetThreadUILanguage', 1, () => {
    return emu.readArg(0) || 0x0409;
  });

  // GetCPInfoExW: fill CPINFOEXW struct
  kernel32.register('GetCPInfoExW', 3, () => {
    const codePage = emu.readArg(0);
    const _flags = emu.readArg(1);
    const lpCPInfoEx = emu.readArg(2);
    if (lpCPInfoEx) {
      emu.memory.writeU32(lpCPInfoEx, 1); // MaxCharSize
      emu.memory.writeU8(lpCPInfoEx + 4, 0x3F); // DefaultChar[0] = '?'
      emu.memory.writeU8(lpCPInfoEx + 5, 0);     // DefaultChar[1]
      // LeadByte[12] = all zeros (no lead bytes)
      for (let i = 0; i < 12; i++) emu.memory.writeU8(lpCPInfoEx + 6 + i, 0);
      // UnicodeDefaultChar
      emu.memory.writeU16(lpCPInfoEx + 18, 0x003F);
      // CodePage
      emu.memory.writeU32(lpCPInfoEx + 20, codePage);
      // CodePageName — empty string
      emu.memory.writeU16(lpCPInfoEx + 24, 0);
    }
    return 1;
  });

  // EnumSystemCodePagesW: just return TRUE without calling callback
  kernel32.register('EnumSystemCodePagesW', 2, () => 1);

  // MulDiv(a, b, c) = (a * b) / c with 64-bit intermediate
  kernel32.register('MulDiv', 3, () => {
    const a = emu.readArg(0) | 0;
    const b = emu.readArg(1) | 0;
    const c = emu.readArg(2) | 0;
    if (c === 0) return -1;
    const result = Number(BigInt(a) * BigInt(b) / BigInt(c));
    return result | 0;
  });

  kernel32.register('GetStringTypeExW', 5, () => {
    const _locale = emu.readArg(0);
    const dwInfoType = emu.readArg(1);
    const lpSrcStr = emu.readArg(2);
    const cchSrc = emu.readArg(3) | 0;
    const lpCharType = emu.readArg(4);
    // Same logic as GetStringTypeW
    let len = cchSrc;
    if (len < 0) {
      len = 0;
      while (emu.memory.readU16(lpSrcStr + len * 2) !== 0) len++;
      len++;
    }
    for (let i = 0; i < len; i++) {
      const ch = emu.memory.readU16(lpSrcStr + i * 2);
      let flags = 0;
      if (dwInfoType === CT_CTYPE1) {
        if (ch >= 0x41 && ch <= 0x5A) flags |= C1_UPPER | C1_ALPHA | C1_DEFINED;
        else if (ch >= 0x61 && ch <= 0x7A) flags |= C1_LOWER | C1_ALPHA | C1_DEFINED;
        else if (ch >= 0x30 && ch <= 0x39) flags |= C1_DIGIT | C1_XDIGIT | C1_DEFINED;
        else if (ch === 0x20) flags |= C1_SPACE | C1_BLANK | C1_DEFINED;
        else if (ch === 0x09) flags |= C1_SPACE | C1_BLANK | C1_CNTRL | C1_DEFINED;
        else if (ch >= 0x0A && ch <= 0x0D) flags |= C1_SPACE | C1_CNTRL | C1_DEFINED;
        else if (ch < 0x20 || ch === 0x7F) flags |= C1_CNTRL | C1_DEFINED;
        else if (ch >= 0x21 && ch <= 0x2F) flags |= C1_PUNCT | C1_DEFINED;
        else if (ch >= 0x3A && ch <= 0x40) flags |= C1_PUNCT | C1_DEFINED;
        else if (ch >= 0x5B && ch <= 0x60) flags |= C1_PUNCT | C1_DEFINED;
        else if (ch >= 0x7B && ch <= 0x7E) flags |= C1_PUNCT | C1_DEFINED;
        else if (ch > 0x7F) flags |= C1_DEFINED;
        if ((ch >= 0x41 && ch <= 0x46) || (ch >= 0x61 && ch <= 0x66)) flags |= C1_XDIGIT;
      }
      emu.memory.writeU16(lpCharType + i * 2, flags);
    }
    return 1;
  });

  // EnumSystemLocalesA(LOCALE_ENUMPROCA, DWORD) — return TRUE without calling callback
  kernel32.register('EnumSystemLocalesA', 2, () => 1);

  // EnumCalendarInfoA(CALINFO_ENUMPROCA, LCID, CALID, CALTYPE) — stub, return TRUE
  kernel32.register('EnumCalendarInfoA', 4, () => 1);

  // GetDateFormatA(LCID, DWORD, SYSTEMTIME*, LPCSTR lpFormat, LPSTR, int)
  kernel32.register('GetDateFormatA', 6, () => {
    const _lcid = emu.readArg(0);
    const dwFlags = emu.readArg(1);
    const lpDate = emu.readArg(2);
    const lpFormat = emu.readArg(3);
    const lpBuf = emu.readArg(4);
    const cchBuf = emu.readArg(5);

    const dfaPreset = getLocalePreset(emu.configuredLcid);
    const st = readSystemTime(lpDate);

    let fmt: string;
    if (lpFormat) {
      fmt = emu.memory.readCString(lpFormat);
    } else if (dwFlags & DATE_LONGDATE) {
      fmt = dfaPreset.longDate;
    } else {
      fmt = dfaPreset.shortDate;
    }

    const result = formatDatePicture(fmt, st, dfaPreset);

    if (cchBuf === 0) return result.length + 1;
    if (lpBuf && cchBuf > 0) {
      const toWrite = result.substring(0, cchBuf - 1);
      for (let j = 0; j < toWrite.length; j++) {
        emu.memory.writeU8(lpBuf + j, toWrite.charCodeAt(j) & 0xFF);
      }
      emu.memory.writeU8(lpBuf + toWrite.length, 0);
    }
    return result.length + 1;
  });

  // GetTimeFormatA(LCID, DWORD, SYSTEMTIME*, LPCSTR lpFormat, LPSTR, int)
  kernel32.register('GetTimeFormatA', 6, () => {
    const _lcid = emu.readArg(0);
    const dwFlags = emu.readArg(1);
    const lpTime = emu.readArg(2);
    const lpFormat = emu.readArg(3);
    const lpBuf = emu.readArg(4);
    const cchBuf = emu.readArg(5);

    const tfaPreset = getLocalePreset(emu.configuredLcid);
    const st = readSystemTime(lpTime);

    let fmt: string;
    if (lpFormat) {
      fmt = emu.memory.readCString(lpFormat);
    } else {
      fmt = tfaPreset.timeFormat;
    }

    const result = formatTimePicture(fmt, st, tfaPreset, dwFlags);

    if (cchBuf === 0) return result.length + 1;
    if (lpBuf && cchBuf > 0) {
      const toWrite = result.substring(0, cchBuf - 1);
      for (let j = 0; j < toWrite.length; j++) {
        emu.memory.writeU8(lpBuf + j, toWrite.charCodeAt(j) & 0xFF);
      }
      emu.memory.writeU8(lpBuf + toWrite.length, 0);
    }
    return result.length + 1;
  });

  // EnumCalendarInfoW(lpCalInfoEnumProc, Locale, Calendar, CalType) → BOOL
  kernel32.register('EnumCalendarInfoW', 4, () => 0);

  // VerSetConditionMask(ULONGLONG conditionMask, DWORD typeMask, BYTE condition) → ULONGLONG
  // ULONGLONG = 2 DWORDs on stack, so 4 DWORDs total = stackBytes 16
  // Encodes condition (3 bits) into specific bit positions based on typeMask.
  kernel32.register('VerSetConditionMask', 4, () => {
    const condMaskLo = emu.readArg(0); // low 32 bits of existing mask
    const condMaskHi = emu.readArg(1); // high 32 bits of existing mask
    const typeMask = emu.readArg(2);
    const condition = emu.readArg(3) & 0x07;
    // Map typeMask to bit position: each VER_xxx type is a power of 2
    // VER_MINORVERSION=1, VER_MAJORVERSION=2, VER_BUILDNUMBER=4, ...
    // Shift = log2(typeMask) * 3
    if (typeMask === 0 || condition === 0) {
      emu.cpu.reg[2] = condMaskHi; // EDX = high
      return condMaskLo;
    }
    const shift = (Math.log2(typeMask & -typeMask) | 0) * 3;
    const result = (condMaskLo | (condition << shift)) >>> 0;
    emu.cpu.reg[2] = condMaskHi; // EDX = high (unchanged for low-bit masks)
    return result;
  });
}
