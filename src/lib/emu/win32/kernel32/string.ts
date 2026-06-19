import type { Emulator } from '../../emulator';

// Unicode → Windows-1252 mapping for codepoints in the 0x80-0x9F range
const cp1252Map = new Map<number, number>([
  [0x20AC, 0x80], // €
  [0x201A, 0x82], // ‚
  [0x0192, 0x83], // ƒ
  [0x201E, 0x84], // „
  [0x2026, 0x85], // …
  [0x2020, 0x86], // †
  [0x2021, 0x87], // ‡
  [0x02C6, 0x88], // ˆ
  [0x2030, 0x89], // ‰
  [0x0160, 0x8A], // Š
  [0x2039, 0x8B], // ‹
  [0x0152, 0x8C], // Œ
  [0x017D, 0x8E], // Ž
  [0x2018, 0x91], // '
  [0x2019, 0x92], // '
  [0x201C, 0x93], // "
  [0x201D, 0x94], // "
  [0x2022, 0x95], // •
  [0x2013, 0x96], // –
  [0x2014, 0x97], // —
  [0x02DC, 0x98], // ˜
  [0x2122, 0x99], // ™
  [0x0161, 0x9A], // š
  [0x203A, 0x9B], // ›
  [0x0153, 0x9C], // œ
  [0x017E, 0x9E], // ž
  [0x0178, 0x9F], // Ÿ
]);

function unicodeToCP1252(codepoint: number): number {
  return cp1252Map.get(codepoint) ?? 0x3F; // '?' for unmappable
}

// CP-1252 byte 0x80-0x9F → Unicode (reverse of cp1252Map)
const cp1252ToUnicodeTable: number[] = [
  0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, // 80-87
  0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F, // 88-8F
  0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, // 90-97
  0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178, // 98-9F
];

function cp1252ToUnicode(byte: number): number {
  if (byte >= 0x80 && byte <= 0x9F) return cp1252ToUnicodeTable[byte - 0x80];
  return byte; // 0x00-0x7F and 0xA0-0xFF are same in Unicode
}

export function registerString(emu: Emulator): void {
  const kernel32 = emu.registerDll('KERNEL32.DLL');

  kernel32.register('lstrlenA', 1, () => {
    const ptr = emu.readArg(0);
    if (ptr === 0) return 0;
    let len = 0;
    while (emu.memory.readU8(ptr + len) !== 0) len++;
    return len;
  });

  kernel32.register('lstrcpyA', 2, () => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    let i = 0;
    while (true) {
      const ch = emu.memory.readU8(src + i);
      emu.memory.writeU8(dst + i, ch);
      if (ch === 0) break;
      i++;
    }
    return dst;
  });

  kernel32.register('lstrcmpA', 2, () => {
    const s1 = emu.readArg(0);
    const s2 = emu.readArg(1);
    const str1 = emu.memory.readCString(s1);
    const str2 = emu.memory.readCString(s2);
    if (str1 < str2) return -1;
    if (str1 > str2) return 1;
    return 0;
  });

  kernel32.register('lstrcmpiA', 2, () => {
    const s1 = emu.readArg(0);
    const s2 = emu.readArg(1);
    const str1 = emu.memory.readCString(s1).toLowerCase();
    const str2 = emu.memory.readCString(s2).toLowerCase();
    if (str1 < str2) return -1;
    if (str1 > str2) return 1;
    return 0;
  });

  kernel32.register('lstrlenW', 1, () => {
    const ptr = emu.readArg(0);
    if (ptr === 0) return 0;
    let len = 0;
    while (emu.memory.readU16(ptr + len * 2) !== 0) len++;
    return len;
  });

  kernel32.register('lstrcpyW', 2, () => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    let i = 0;
    while (true) {
      const ch = emu.memory.readU16(src + i * 2);
      emu.memory.writeU16(dst + i * 2, ch);
      if (ch === 0) break;
      i++;
    }
    return dst;
  });

  kernel32.register('lstrcatA', 2, () => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    let dstEnd = dst;
    while (emu.memory.readU8(dstEnd) !== 0) dstEnd++;
    let i = 0;
    while (true) {
      const ch = emu.memory.readU8(src + i);
      emu.memory.writeU8(dstEnd + i, ch);
      if (ch === 0) break;
      i++;
    }
    return dst;
  });

  kernel32.register('lstrcpynA', 3, () => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    const maxCount = emu.readArg(2);
    if (maxCount <= 0) return dst;
    let i = 0;
    while (i < maxCount - 1) {
      const ch = emu.memory.readU8(src + i);
      emu.memory.writeU8(dst + i, ch);
      if (ch === 0) break;
      i++;
    }
    if (i === maxCount - 1) emu.memory.writeU8(dst + i, 0);
    return dst;
  });

  kernel32.register('lstrcatW', 2, () => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    // Find end of dst
    let dstEnd = dst;
    while (emu.memory.readU16(dstEnd) !== 0) dstEnd += 2;
    // Copy src
    let i = 0;
    while (true) {
      const ch = emu.memory.readU16(src + i * 2);
      emu.memory.writeU16(dstEnd + i * 2, ch);
      if (ch === 0) break;
      i++;
    }
    return dst;
  });

  kernel32.register('lstrcmpiW', 2, () => {
    const s1 = emu.readArg(0);
    const s2 = emu.readArg(1);
    const str1 = emu.memory.readUTF16String(s1).toLowerCase();
    const str2 = emu.memory.readUTF16String(s2).toLowerCase();
    if (str1 < str2) return -1;
    if (str1 > str2) return 1;
    return 0;
  });

  kernel32.register('lstrcpynW', 3, () => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    const maxCount = emu.readArg(2);
    if (maxCount <= 0) return dst;
    let i = 0;
    while (i < maxCount - 1) {
      const ch = emu.memory.readU16(src + i * 2);
      emu.memory.writeU16(dst + i * 2, ch);
      if (ch === 0) break;
      i++;
    }
    if (i === maxCount - 1) emu.memory.writeU16(dst + i * 2, 0);
    return dst;
  });

  kernel32.register('lstrcmpW', 2, () => {
    const s1 = emu.readArg(0);
    const s2 = emu.readArg(1);
    let i = 0;
    while (true) {
      const c1 = emu.memory.readU16(s1 + i * 2);
      const c2 = emu.memory.readU16(s2 + i * 2);
      if (c1 !== c2) return c1 < c2 ? -1 : 1;
      if (c1 === 0) return 0;
      i++;
    }
  });

  kernel32.register('MultiByteToWideChar', 6, () => {
    const _codePage = emu.readArg(0);
    const _flags = emu.readArg(1);
    const srcPtr = emu.readArg(2);
    let srcLen = emu.readArg(3) | 0;
    const dstPtr = emu.readArg(4);
    const dstLen = emu.readArg(5);

    if (srcLen === -1) {
      srcLen = 0;
      while (emu.memory.readU8(srcPtr + srcLen) !== 0) srcLen++;
      srcLen++; // include null
    }

    if (dstPtr === 0 || dstLen === 0) return srcLen;

    const count = Math.min(srcLen, dstLen);
    for (let i = 0; i < count; i++) {
      const byte = emu.memory.readU8(srcPtr + i);
      emu.memory.writeU16(dstPtr + i * 2, cp1252ToUnicode(byte));
    }
    return count;
  });

  kernel32.register('WideCharToMultiByte', 8, () => {
    const _codePage = emu.readArg(0);
    const _flags = emu.readArg(1);
    const srcPtr = emu.readArg(2);
    let srcLen = emu.readArg(3) | 0;
    const dstPtr = emu.readArg(4);
    const dstLen = emu.readArg(5);

    if (srcLen === -1) {
      srcLen = 0;
      while (emu.memory.readU16(srcPtr + srcLen * 2) !== 0) srcLen++;
      srcLen++; // include null
    }

    if (dstPtr === 0 || dstLen === 0) return srcLen;

    const count = Math.min(srcLen, dstLen);
    for (let i = 0; i < count; i++) {
      const wc = emu.memory.readU16(srcPtr + i * 2);
      emu.memory.writeU8(dstPtr + i, wc < 0x100 ? wc : unicodeToCP1252(wc));
    }
    return count;
  });

  // CompareString(Locale, dwCmpFlags, lpString1, cchCount1, lpString2, cchCount2)
  // Returns CSTR_LESS_THAN=1, CSTR_EQUAL=2, CSTR_GREATER_THAN=3 (0 on error).
  // Self-consistent ordinal comparison; cchCount=-1 means NUL-terminated.
  const CSTR_LESS_THAN = 1;
  const CSTR_EQUAL = 2;
  const CSTR_GREATER_THAN = 3;
  const NORM_IGNORECASE = 0x00000001;

  const compareStringImpl = (wide: boolean): number => {
    const flags = emu.readArg(1);
    const p1 = emu.readArg(2);
    const c1 = emu.readArg(3) | 0;
    const p2 = emu.readArg(4);
    const c2 = emu.readArg(5) | 0;
    if (!p1 || !p2) return 0;

    const readStr = (ptr: number, count: number): string => {
      if (count === -1) {
        return wide ? emu.memory.readUTF16String(ptr) : emu.memory.readCString(ptr);
      }
      let s = '';
      for (let i = 0; i < count; i++) {
        const ch = wide ? emu.memory.readU16(ptr + i * 2) : emu.memory.readU8(ptr + i);
        s += String.fromCharCode(ch);
      }
      return s;
    };

    let s1 = readStr(p1, c1);
    let s2 = readStr(p2, c2);
    if (flags & NORM_IGNORECASE) {
      s1 = s1.toLowerCase();
      s2 = s2.toLowerCase();
    }
    if (s1 < s2) return CSTR_LESS_THAN;
    if (s1 > s2) return CSTR_GREATER_THAN;
    return CSTR_EQUAL;
  };

  kernel32.register('CompareStringA', 6, () => compareStringImpl(false));
  kernel32.register('CompareStringW', 6, () => compareStringImpl(true));

  // OutputDebugStringA
  kernel32.register('OutputDebugStringA', 1, () => {
    const ptr = emu.readArg(0);
    if (ptr) {
      const msg = emu.memory.readCString(ptr);
      console.log('[OutputDebug]', msg);
    }
    return 0;
  });

  kernel32.register('RtlZeroMemory', 2, () => {
    const dest = emu.readArg(0);
    const length = emu.readArg(1);
    for (let i = 0; i < length; i++) {
      emu.memory.writeU8(dest + i, 0);
    }
    return 0;
  });

  kernel32.register('RtlMoveMemory', 3, () => {
    const dest = emu.readArg(0);
    const src = emu.readArg(1);
    const length = emu.readArg(2);
    // Use temp buffer to handle overlapping regions
    const tmp = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      tmp[i] = emu.memory.readU8(src + i);
    }
    for (let i = 0; i < length; i++) {
      emu.memory.writeU8(dest + i, tmp[i]);
    }
    return 0;
  });
}
