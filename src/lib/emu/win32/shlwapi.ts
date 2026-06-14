import type { Emulator } from '../emulator';

export function registerShlwapi(emu: Emulator): void {
  const shlwapi = emu.registerDll('SHLWAPI.DLL');

  // StrChrW: find first occurrence of char in string
  shlwapi.register('StrChrW', 2, () => {
    const pszStart = emu.readArg(0);
    const wMatch = emu.readArg(1) & 0xFFFF;
    if (!pszStart) return 0;
    let ptr = pszStart;
    while (true) {
      const ch = emu.memory.readU16(ptr);
      if (ch === wMatch) return ptr;
      if (ch === 0) return 0;
      ptr += 2;
    }
  });

  // StrCpyW: copy wide string
  shlwapi.register('StrCpyW', 2, () => {
    const pszDst = emu.readArg(0);
    const pszSrc = emu.readArg(1);
    if (!pszDst || !pszSrc) return pszDst;
    let i = 0;
    while (true) {
      const ch = emu.memory.readU16(pszSrc + i);
      emu.memory.writeU16(pszDst + i, ch);
      if (ch === 0) break;
      i += 2;
    }
    return pszDst;
  });

  // StrToIntW: convert wide string to integer
  shlwapi.register('StrToIntW', 1, () => {
    const pszStr = emu.readArg(0);
    if (!pszStr) return 0;
    const str = emu.memory.readUTF16String(pszStr);
    return (parseInt(str, 10) || 0) >>> 0;
  });

  // IsOS (ordinal 437): check OS type — return FALSE for all queries
  shlwapi.register('IsOS', 1, () => {
    const _dwOS = emu.readArg(0);
    return 0; // FALSE
  });

  // StrCmpIW: case-insensitive wide string compare
  shlwapi.register('StrCmpIW', 2, () => {
    const psz1 = emu.readArg(0);
    const psz2 = emu.readArg(1);
    if (!psz1 || !psz2) return psz1 === psz2 ? 0 : (psz1 ? 1 : -1);
    let i = 0;
    while (true) {
      let c1 = emu.memory.readU16(psz1 + i);
      let c2 = emu.memory.readU16(psz2 + i);
      // Simple ASCII case folding
      if (c1 >= 0x41 && c1 <= 0x5A) c1 += 0x20;
      if (c2 >= 0x41 && c2 <= 0x5A) c2 += 0x20;
      if (c1 !== c2) return c1 < c2 ? -1 : 1;
      if (c1 === 0) return 0;
      i += 2;
    }
  });

  // StrRChrW(lpStart, lpEnd, wMatch) — 3 args, returns pointer to last occurrence
  shlwapi.register('StrRChrW', 3, () => {
    const lpStart = emu.readArg(0);
    const lpEnd = emu.readArg(1);
    const wMatch = emu.readArg(2) & 0xFFFF;
    if (!lpStart) return 0;
    const end = lpEnd || 0x7FFFFFFF;
    let last = 0;
    let ptr = lpStart;
    while (ptr < end) {
      const ch = emu.memory.readU16(ptr);
      if (ch === 0) break;
      if (ch === wMatch) last = ptr;
      ptr += 2;
    }
    return last;
  });

  // StrCpyNW(pszDst, pszSrc, cchMax) — 3 args
  shlwapi.register('StrCpyNW', 3, () => {
    const pszDst = emu.readArg(0);
    const pszSrc = emu.readArg(1);
    const cchMax = emu.readArg(2);
    if (!pszDst || !pszSrc || cchMax <= 0) return pszDst;
    for (let i = 0; i < cchMax - 1; i++) {
      const ch = emu.memory.readU16(pszSrc + i * 2);
      emu.memory.writeU16(pszDst + i * 2, ch);
      if (ch === 0) return pszDst;
    }
    emu.memory.writeU16(pszDst + (cchMax - 1) * 2, 0);
    return pszDst;
  });

  // StrStrIW(pszFirst, pszSrch) — 2 args, case-insensitive substring search
  shlwapi.register('StrStrIW', 2, () => {
    const pszFirst = emu.readArg(0);
    const pszSrch = emu.readArg(1);
    if (!pszFirst || !pszSrch) return 0;
    const first = emu.memory.readUTF16String(pszFirst).toLowerCase();
    const srch = emu.memory.readUTF16String(pszSrch).toLowerCase();
    const idx = first.indexOf(srch);
    if (idx < 0) return 0;
    return pszFirst + idx * 2;
  });

  // PathIsDirectoryW / PathIsDirectoryA — query the file manager for the
  // path's attributes and check the FILE_ATTRIBUTE_DIRECTORY bit. The stubs
  // claimed everything was a file, breaking File→Open dialogs that recurse
  // into the user's working directory.
  const INVALID = 0xFFFFFFFF;
  const FILE_ATTRIBUTE_DIRECTORY = 0x10;
  const isDirectoryImpl = (wide: boolean) => (): number => {
    const pszPath = emu.readArg(0);
    if (!pszPath) return 0;
    const path = wide ? emu.memory.readUTF16String(pszPath) : emu.memory.readCString(pszPath);
    const attrs = emu.fileManager?.getFileAttributes(path, emu.additionalFiles) ?? INVALID;
    if (attrs === INVALID) return 0;
    return (attrs & FILE_ATTRIBUTE_DIRECTORY) ? 1 : 0;
  };
  shlwapi.register('PathIsDirectoryW', 1, isDirectoryImpl(true));
  shlwapi.register('PathIsDirectoryA', 1, isDirectoryImpl(false));

  // PathFindExtensionW(pszPath) — 1 arg, returns pointer to '.' or end of string
  shlwapi.register('PathFindExtensionW', 1, () => {
    const pszPath = emu.readArg(0);
    if (!pszPath) return 0;
    let ptr = pszPath;
    let dotPtr = 0;
    while (true) {
      const ch = emu.memory.readU16(ptr);
      if (ch === 0) break;
      if (ch === 0x2E) dotPtr = ptr; // '.'
      if (ch === 0x5C || ch === 0x2F) dotPtr = 0; // reset on path separator
      ptr += 2;
    }
    return dotPtr || ptr; // return dot position or end of string
  });

  // PathFileExistsW / PathFileExistsA — exists if getFileAttributes returns
  // anything other than INVALID. Was stub→0, so every File→Open / installer
  // path check reported "file missing" even for files we'd happily open.
  const fileExistsImpl = (wide: boolean) => (): number => {
    const pszPath = emu.readArg(0);
    if (!pszPath) return 0;
    const path = wide ? emu.memory.readUTF16String(pszPath) : emu.memory.readCString(pszPath);
    const attrs = emu.fileManager?.getFileAttributes(path, emu.additionalFiles) ?? INVALID;
    return attrs !== INVALID ? 1 : 0;
  };
  shlwapi.register('PathFileExistsW', 1, fileExistsImpl(true));
  shlwapi.register('PathFileExistsA', 1, fileExistsImpl(false));

  // LPSTR PathFindExtensionA(LPCSTR pszPath) — pointer to '.' or end of string
  shlwapi.register('PathFindExtensionA', 1, () => {
    const pszPath = emu.readArg(0);
    if (!pszPath) return 0;
    let ptr = pszPath;
    let dotPtr = 0;
    while (true) {
      const ch = emu.memory.readU8(ptr);
      if (ch === 0) break;
      if (ch === 0x2E) dotPtr = ptr; // '.'
      if (ch === 0x5C || ch === 0x2F) dotPtr = 0; // reset on path separator
      ptr += 1;
    }
    return dotPtr || ptr;
  });

  // LPSTR PathFindFileNameA(LPCSTR pszPath) — pointer to filename after last separator
  shlwapi.register('PathFindFileNameA', 1, () => {
    const pszPath = emu.readArg(0);
    if (!pszPath) return 0;
    let ptr = pszPath;
    let last = pszPath;
    while (true) {
      const ch = emu.memory.readU8(ptr);
      if (ch === 0) break;
      if (ch === 0x5C || ch === 0x2F || ch === 0x3A) last = ptr + 1; // '\', '/', ':'
      ptr += 1;
    }
    return last;
  });
  shlwapi.register('PathFindFileNameW', 1, () => {
    const pszPath = emu.readArg(0);
    if (!pszPath) return 0;
    let ptr = pszPath;
    let last = pszPath;
    while (true) {
      const ch = emu.memory.readU16(ptr);
      if (ch === 0) break;
      if (ch === 0x5C || ch === 0x2F || ch === 0x3A) last = ptr + 2;
      ptr += 2;
    }
    return last;
  });

  // BOOL PathStripToRootA(LPSTR pszPath) — truncate to drive root
  shlwapi.register('PathStripToRootA', 1, () => {
    const pszPath = emu.readArg(0);
    if (!pszPath) return 0;
    // Look for "X:\..." or "\\server\share\..."
    const c0 = emu.memory.readU8(pszPath);
    const c1 = emu.memory.readU8(pszPath + 1);
    if (c0 === 0x5C && c1 === 0x5C) {
      // UNC: keep up to "\\server\share"
      let pos = 2;
      let slashes = 0;
      while (true) {
        const ch = emu.memory.readU8(pszPath + pos);
        if (ch === 0) { return slashes >= 2 ? 1 : 0; }
        if (ch === 0x5C) {
          slashes++;
          if (slashes === 2) {
            emu.memory.writeU8(pszPath + pos, 0);
            return 1;
          }
        }
        pos++;
      }
    }
    if (c1 === 0x3A) {
      // Drive letter: keep "X:\"
      const c2 = emu.memory.readU8(pszPath + 2);
      if (c2 === 0x5C) {
        emu.memory.writeU8(pszPath + 3, 0);
        return 1;
      }
    }
    emu.memory.writeU8(pszPath, 0);
    return 0;
  });

  // BOOL PathIsUNCA(LPCSTR pszPath) — UNC path begins with "\\"
  shlwapi.register('PathIsUNCA', 1, () => {
    const pszPath = emu.readArg(0);
    if (!pszPath) return 0;
    const c0 = emu.memory.readU8(pszPath);
    const c1 = emu.memory.readU8(pszPath + 1);
    return (c0 === 0x5C && c1 === 0x5C) ? 1 : 0;
  });
  shlwapi.register('PathIsUNCW', 1, () => {
    const pszPath = emu.readArg(0);
    if (!pszPath) return 0;
    const c0 = emu.memory.readU16(pszPath);
    const c1 = emu.memory.readU16(pszPath + 2);
    return (c0 === 0x5C && c1 === 0x5C) ? 1 : 0;
  });

  // PathAppendW(pszPath, pszMore) — 2 args
  shlwapi.register('PathAppendW', 2, () => {
    const pszPath = emu.readArg(0);
    const pszMore = emu.readArg(1);
    if (!pszPath || !pszMore) return 0;
    const path = emu.memory.readUTF16String(pszPath);
    const more = emu.memory.readUTF16String(pszMore);
    const sep = path.endsWith('\\') ? '' : '\\';
    const combined = path + sep + more;
    for (let i = 0; i < combined.length; i++) {
      emu.memory.writeU16(pszPath + i * 2, combined.charCodeAt(i));
    }
    emu.memory.writeU16(pszPath + combined.length * 2, 0);
    return 1;
  });
}
