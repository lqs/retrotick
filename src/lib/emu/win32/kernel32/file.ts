import type { Emulator } from '../../emulator';
import type { OpenFile } from '../../file-manager';
import { emuCompleteThunk } from '../../emu-exec';

export function registerFile(emu: Emulator): void {
  const kernel32 = emu.registerDll('KERNEL32.DLL');

  const STD_INPUT_HANDLE = 0xFFFFFFF6;
  const STD_OUTPUT_HANDLE = 0xFFFFFFF5;
  const STD_ERROR_HANDLE = 0xFFFFFFF4;
  const INVALID_HANDLE_VALUE = 0xFFFFFFFF;

  const GENERIC_READ = 0x80000000;
  const GENERIC_WRITE = 0x40000000;
  const CREATE_NEW = 1;
  const CREATE_ALWAYS = 2;
  const OPEN_EXISTING = 3;
  const OPEN_ALWAYS = 4;
  const TRUNCATE_EXISTING = 5;

  const FILE_BEGIN = 0;
  const FILE_CURRENT = 1;
  const FILE_END = 2;

  const isConsoleHandle = (h: number) =>
    h === (STD_INPUT_HANDLE >>> 0) || h === (STD_OUTPUT_HANDLE >>> 0) || h === (STD_ERROR_HANDLE >>> 0);

  const fs = emu.fs;

  function doCreateFile(isWide: boolean): number {
    const lpFileName = emu.readArg(0);
    const dwDesiredAccess = emu.readArg(1);
    const _dwShareMode = emu.readArg(2);
    const _lpSecurityAttributes = emu.readArg(3);
    const dwCreationDisposition = emu.readArg(4);
    const _dwFlagsAndAttributes = emu.readArg(5);
    const _hTemplateFile = emu.readArg(6);

    if (!lpFileName) return INVALID_HANDLE_VALUE;
    const rawPath = isWide ? emu.memory.readUTF16String(lpFileName) : emu.memory.readCString(lpFileName);

    // CONIN$ and CONOUT$ are special console device names
    const rawUpper = rawPath.toUpperCase();
    if (rawUpper === 'CONIN$') return STD_INPUT_HANDLE >>> 0;
    if (rawUpper === 'CONOUT$') return STD_OUTPUT_HANDLE >>> 0;

    const resolved = emu.resolvePath(rawPath);
    const upper = resolved.toUpperCase();

    console.log(`[CreateFile] path="${rawPath}" resolved="${resolved}" access=0x${dwDesiredAccess.toString(16)} creation=${dwCreationDisposition}`);

    const existing = fs.findFile(resolved, emu.additionalFiles);

    if (dwCreationDisposition === OPEN_EXISTING) {
      if (!existing) return INVALID_HANDLE_VALUE;
      let syncData: Uint8Array | null = null;
      if (existing.source === 'external') {
        syncData = fs.externalFiles.get(upper)?.data ?? null;
      } else if (existing.source === 'additional') {
        const ab = emu.additionalFiles.get(existing.name);
        if (ab) syncData = new Uint8Array(ab);
      } else if (existing.source === 'virtual') {
        // Check in-memory cache for virtual files (IndexedDB-backed)
        const cacheKey = existing.name.toUpperCase();
        const cached = fs.virtualFileCache?.get(cacheKey);
        if (cached) {
          syncData = new Uint8Array(cached);
        } else if (fs.onFileRequest) {
          // Async fetch: pause execution, create handle when data arrives
          const stackBytes = emu._currentThunkStackBytes;
          emu.waitingForMessage = true;
          const fileSize = existing.size;
          const fileName = existing.name;
          fs.fetchFileData(existing, emu.additionalFiles, resolved).then(buf => {
            emu.waitingForMessage = false;
            if (buf) fs.virtualFileCache?.set(fileName.toUpperCase(), buf);
            const data = buf ? new Uint8Array(buf) : null;
            const handle = emu.handles.alloc('file', {
              path: upper, access: dwDesiredAccess, pos: 0,
              data, size: data ? data.length : fileSize, modified: false,
            } satisfies OpenFile);
            emuCompleteThunk(emu, handle, stackBytes);
            if (emu.running && !emu.halted) {
              requestAnimationFrame(emu.tick);
            }
          });
          return undefined as any;
        }
      }
      return emu.handles.alloc('file', {
        path: upper, access: dwDesiredAccess, pos: 0,
        data: syncData, size: existing.size, modified: false,
      } satisfies OpenFile);
    }

    if (dwCreationDisposition === OPEN_ALWAYS) {
      if (existing) {
        let syncData: Uint8Array | null = null;
        if (existing.source === 'external') {
          syncData = fs.externalFiles.get(upper)?.data ?? null;
        } else if (existing.source === 'virtual') {
          const cached = fs.virtualFileCache?.get(existing.name.toUpperCase());
          if (cached) syncData = new Uint8Array(cached);
        } else if (existing.source === 'additional') {
          const addBuf = emu.additionalFiles.get(existing.name);
          if (addBuf) syncData = new Uint8Array(addBuf);
        }
        if (!syncData && existing.source === 'virtual' && fs.onFileRequest) {
          // Async fetch from IndexedDB
          const stackBytes = emu._currentThunkStackBytes;
          emu.waitingForMessage = true;
          const fileSize = existing.size;
          const fileName = existing.name;
          fs.fetchFileData(existing, emu.additionalFiles, resolved).then(buf => {
            emu.waitingForMessage = false;
            if (buf) fs.virtualFileCache?.set(fileName.toUpperCase(), buf);
            const data = buf ? new Uint8Array(buf) : null;
            const h = emu.handles.alloc('file', {
              path: upper, access: dwDesiredAccess, pos: 0,
              data, size: data ? data.length : fileSize, modified: false,
            } satisfies OpenFile);
            emuCompleteThunk(emu, h, stackBytes);
            if (emu.running && !emu.halted) {
              requestAnimationFrame(emu.tick);
            }
          });
          return undefined as any;
        }
        return emu.handles.alloc('file', {
          path: upper, access: dwDesiredAccess, pos: 0,
          data: syncData, size: existing.size, modified: false,
        } satisfies OpenFile);
      }
      if (upper.startsWith('D:\\')) {
        const storeName = resolved.substring(3).replace(/\\/g, '/');
        fs.virtualFiles.push({ name: storeName, size: 0 });
        return emu.handles.alloc('file', {
          path: upper, access: dwDesiredAccess, pos: 0,
          data: new Uint8Array(0), size: 0, modified: true,
        } satisfies OpenFile);
      }
      if (upper.startsWith('Z:\\')) {
        const baseName = resolved.substring(3);
        fs.externalFiles.set(upper, { data: new Uint8Array(0), name: baseName });
        return emu.handles.alloc('file', {
          path: upper, access: dwDesiredAccess, pos: 0,
          data: new Uint8Array(0), size: 0, modified: true,
        } satisfies OpenFile);
      }
      return INVALID_HANDLE_VALUE;
    }

    if (dwCreationDisposition === CREATE_ALWAYS || dwCreationDisposition === CREATE_NEW) {
      if (dwCreationDisposition === CREATE_NEW && existing) return INVALID_HANDLE_VALUE;
      if (upper.startsWith('D:\\')) {
        const storeName = resolved.substring(3).replace(/\\/g, '/');
        if (!existing) {
          fs.virtualFiles.push({ name: storeName, size: 0 });
        }
        return emu.handles.alloc('file', {
          path: upper, access: dwDesiredAccess, pos: 0,
          data: new Uint8Array(0), size: 0, modified: true,
        } satisfies OpenFile);
      }
      if (upper.startsWith('Z:\\')) {
        const baseName = resolved.substring(3);
        fs.externalFiles.set(upper, { data: new Uint8Array(0), name: baseName });
        return emu.handles.alloc('file', {
          path: upper, access: dwDesiredAccess, pos: 0,
          data: new Uint8Array(0), size: 0, modified: true,
        } satisfies OpenFile);
      }
      return INVALID_HANDLE_VALUE;
    }

    if (dwCreationDisposition === TRUNCATE_EXISTING) {
      if (!existing) return INVALID_HANDLE_VALUE;
      return emu.handles.alloc('file', {
        path: upper, access: dwDesiredAccess, pos: 0,
        data: new Uint8Array(0), size: 0, modified: true,
      } satisfies OpenFile);
    }

    return INVALID_HANDLE_VALUE;
  }

  kernel32.register('CreateFileA', 7, () => doCreateFile(false));
  kernel32.register('CreateFileW', 7, () => doCreateFile(true));

  // Open an existing file, returning a handle. Handles all four sources (external,
  // additional, virtual sync-cached, virtual async-fetched). For the async path, pauses
  // the CPU and resumes the thunk via emuCompleteThunk; returns undefined to signal that.
  // Used by OpenFile, _lopen, and similar APIs that don't create files.
  function openExistingFile(
    resolved: string,
    access: number,
    label: string,
  ): number | undefined {
    const upper = resolved.toUpperCase();
    const existing = fs.findFile(resolved, emu.additionalFiles);
    if (!existing) return undefined;
    let fileData: Uint8Array | null = null;
    if (existing.source === 'external') {
      fileData = fs.externalFiles.get(upper)?.data ?? null;
    } else if (existing.source === 'additional') {
      const ab = emu.additionalFiles.get(existing.name);
      if (ab) fileData = new Uint8Array(ab);
    } else if (existing.source === 'virtual') {
      const cached = fs.virtualFileCache?.get(existing.name.toUpperCase());
      if (cached) {
        fileData = new Uint8Array(cached);
      } else if (fs.onFileRequest) {
        const stackBytes = emu._currentThunkStackBytes;
        emu.waitingForMessage = true;
        const fileSize = existing.size;
        const fileName = existing.name;
        fs.fetchFileData(existing, emu.additionalFiles, resolved).then(buf => {
          emu.waitingForMessage = false;
          if (buf) fs.virtualFileCache?.set(fileName.toUpperCase(), buf);
          const data = buf ? new Uint8Array(buf) : null;
          const handle = emu.handles.alloc('file', {
            path: upper, access, pos: 0,
            data, size: data ? data.length : fileSize, modified: false,
          } satisfies OpenFile);
          console.log(`[${label}] async-resolved size=${data?.length ?? 0}`);
          emuCompleteThunk(emu, handle, stackBytes);
          if (emu.running && !emu.halted) requestAnimationFrame(emu.tick);
        });
        return undefined;
      }
    }
    return emu.handles.alloc('file', {
      path: upper, access, pos: 0,
      data: fileData, size: existing.size, modified: false,
    } satisfies OpenFile);
  }

  // OpenFile(lpFileName, lpReOpenBuff, uStyle)
  const OF_EXIST = 0x4000;
  const HFILE_ERROR = 0xFFFFFFFF;
  kernel32.register('OpenFile', 3, () => {
    const lpFileName = emu.readArg(0);
    const lpReOpenBuff = emu.readArg(1);
    const uStyle = emu.readArg(2);
    const fileName = emu.memory.readCString(lpFileName);
    const resolved = emu.resolvePath(fileName);

    if (lpReOpenBuff) {
      emu.memory.writeU8(lpReOpenBuff, 136);
      const pathBytes = new TextEncoder().encode(resolved);
      for (let i = 0; i < Math.min(pathBytes.length, 127); i++) {
        emu.memory.writeU8(lpReOpenBuff + 8 + i, pathBytes[i]);
      }
      emu.memory.writeU8(lpReOpenBuff + 8 + Math.min(pathBytes.length, 127), 0);
    }

    const existing = fs.findFile(resolved, emu.additionalFiles);
    console.log(`[OpenFile] file="${fileName}" resolved="${resolved}" style=0x${uStyle.toString(16)} found=${!!existing}`);

    if ((uStyle & OF_EXIST) !== 0) return existing ? 0 : HFILE_ERROR;
    if (!existing) return HFILE_ERROR;

    const handle = openExistingFile(resolved, GENERIC_READ, 'OpenFile');
    if (handle === undefined && existing.source === 'virtual') {
      return undefined as unknown as number; // async fetch pending
    }
    return handle ?? HFILE_ERROR;
  });

  // _lopen(lpPathName, iReadWrite)
  kernel32.register('_lopen', 2, () => {
    const lpPathName = emu.readArg(0);
    const iReadWrite = emu.readArg(1);
    const fileName = emu.memory.readCString(lpPathName);
    const resolved = emu.resolvePath(fileName);
    const existing = fs.findFile(resolved, emu.additionalFiles);
    console.log(`[_lopen] file="${fileName}" resolved="${resolved}" mode=${iReadWrite} found=${!!existing}`);
    if (!existing) return HFILE_ERROR;
    const access = iReadWrite === 0 ? GENERIC_READ : GENERIC_READ | GENERIC_WRITE;
    const handle = openExistingFile(resolved, access, '_lopen');
    if (handle === undefined && existing.source === 'virtual') {
      // Async fetch in progress — completion happens in openExistingFile callback
      return undefined as unknown as number;
    }
    return handle ?? HFILE_ERROR;
  });

  // _hread/_lread(hFile, lpBuffer, uBytes)
  const hreadImpl = () => {
    const hFile = emu.readArg(0);
    const lpBuffer = emu.readArg(1);
    const uBytes = emu.readArg(2);
    const file = emu.handles.get<OpenFile>(hFile);
    if (!file || !file.data) return 0;
    const avail = Math.max(0, file.data.length - file.pos);
    const toRead = Math.min(uBytes, avail);
    for (let i = 0; i < toRead; i++) {
      emu.memory.writeU8(lpBuffer + i, file.data[file.pos + i]);
    }
    file.pos += toRead;
    return toRead;
  };
  kernel32.register('_lread', 3, hreadImpl);
  kernel32.register('_hread', 3, hreadImpl);

  // _lclose(hFile)
  kernel32.register('_lclose', 1, () => {
    const hFile = emu.readArg(0);
    const file = emu.handles.get<OpenFile>(hFile);
    if (file) fs.persistOnClose(file);
    emu.handles.free(hFile);
    return 0;
  });

  // _lwrite(hFile, lpBuffer, uBytes)
  kernel32.register('_lwrite', 3, () => {
    const hFile = emu.readArg(0);
    const lpBuffer = emu.readArg(1);
    const uBytes = emu.readArg(2);
    const file = emu.handles.get<OpenFile>(hFile);
    if (!file) return HFILE_ERROR;
    if (file.data === null) file.data = new Uint8Array(0);
    const needed = file.pos + uBytes;
    if (needed > file.data.length) {
      const newData = new Uint8Array(needed);
      newData.set(file.data);
      file.data = newData;
    }
    for (let i = 0; i < uBytes; i++) {
      file.data[file.pos + i] = emu.memory.readU8(lpBuffer + i);
    }
    file.pos += uBytes;
    if (file.pos > file.size) file.size = file.pos;
    file.modified = true;
    return uBytes;
  });

  // _llseek(hFile, lOffset, iOrigin)
  kernel32.register('_llseek', 3, () => {
    const hFile = emu.readArg(0);
    const lOffset = emu.readArg(1) | 0;
    const iOrigin = emu.readArg(2);
    const file = emu.handles.get<OpenFile>(hFile);
    if (!file) return HFILE_ERROR;
    if (iOrigin === FILE_BEGIN) file.pos = lOffset;
    else if (iOrigin === FILE_CURRENT) file.pos += lOffset;
    else if (iOrigin === FILE_END) file.pos = file.size + lOffset;
    return file.pos;
  });

  // WinExec(lpCmdLine, uCmdShow)
  kernel32.register('WinExec', 2, () => 33);

  // ---- ReadFile ----
  kernel32.register('ReadFile', 5, () => {
    const hFile = emu.readArg(0);
    const bufPtr = emu.readArg(1);
    const nBytes = emu.readArg(2);
    const bytesReadPtr = emu.readArg(3);

    // Console stdin
    if (hFile === (STD_INPUT_HANDLE >>> 0)) {
      if (emu.consoleInputBuffer.length === 0) {
        emu._pendingReadConsole = { bufPtr, nCharsToRead: nBytes, charsReadPtr: bytesReadPtr };
        const stackBytes = emu._currentThunkStackBytes;
        emu.waitingForMessage = true;
        emu._consoleInputResume = { stackBytes, completer: emuCompleteThunk };
        return undefined;
      }
      let count = 0;
      while (count < nBytes && emu.consoleInputBuffer.length > 0) {
        const evt = emu.consoleInputBuffer.shift()!;
        emu.memory.writeU8(bufPtr + count, evt.char & 0xFF);
        count++;
      }
      if (bytesReadPtr) emu.memory.writeU32(bytesReadPtr, count);
      return 1;
    }

    const file = emu.handles.get<OpenFile>(hFile);
    if (!file) {
      console.log(`[ReadFile] handle=0x${hFile.toString(16)} — not found`);
      return 0;
    }

    console.log(`[ReadFile] handle=0x${hFile.toString(16)} path="${file.path}" pos=${file.pos} nBytes=${nBytes} dataLen=${file.data?.length ?? 'null'}`);

    if (file.data !== null) {
      const avail = Math.max(0, file.data.length - file.pos);
      const toRead = Math.min(nBytes, avail);
      for (let i = 0; i < toRead; i++) {
        emu.memory.writeU8(bufPtr + i, file.data[file.pos + i]);
      }
      file.pos += toRead;
      if (bytesReadPtr) emu.memory.writeU32(bytesReadPtr, toRead);
      console.log(`[ReadFile] read ${toRead} bytes, newPos=${file.pos}`);
      return 1;
    }

    // Data not loaded — need async fetch
    const fileInfo = fs.findFile(file.path, emu.additionalFiles);
    if (!fileInfo) {
      if (bytesReadPtr) emu.memory.writeU32(bytesReadPtr, 0);
      return 1;
    }

    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    fs.fetchFileData(fileInfo, emu.additionalFiles).then(ab => {
      if (ab) {
        file.data = new Uint8Array(ab);
        file.size = file.data.length;
      } else {
        file.data = new Uint8Array(0);
        file.size = 0;
      }
      const avail = Math.max(0, file.data.length - file.pos);
      const toRead = Math.min(nBytes, avail);
      for (let i = 0; i < toRead; i++) {
        emu.memory.writeU8(bufPtr + i, file.data[file.pos + i]);
      }
      file.pos += toRead;
      if (bytesReadPtr) emu.memory.writeU32(bytesReadPtr, toRead);
      emu.waitingForMessage = false;
      emuCompleteThunk(emu, 1, stackBytes);
      if (emu.running && !emu.halted) {
        requestAnimationFrame(emu.tick);
      }
    });
    return undefined;
  });

  // ---- WriteFile ----
  kernel32.register('WriteFile', 5, () => {
    const hFile = emu.readArg(0);
    const buf = emu.readArg(1);
    const nBytes = emu.readArg(2);
    const writtenPtr = emu.readArg(3);

    // Console output
    if (isConsoleHandle(hFile)) {
      if (buf && nBytes > 0) {
        for (let i = 0; i < nBytes; i++) {
          emu.consoleWriteChar(emu.memory.readU8(buf + i));
        }
        emu.onConsoleOutput?.();
      }
      if (writtenPtr) emu.memory.writeU32(writtenPtr, nBytes);
      return 1;
    }

    const file = emu.handles.get<OpenFile>(hFile);
    if (!file) {
      console.log(`[WriteFile] handle=0x${hFile.toString(16)} — not found`);
      if (writtenPtr) emu.memory.writeU32(writtenPtr, 0);
      return 0;
    }

    console.log(`[WriteFile] handle=0x${hFile.toString(16)} path="${file.path}" pos=${file.pos} nBytes=${nBytes}`);

    if (file.data === null) file.data = new Uint8Array(0);

    const endPos = file.pos + nBytes;
    if (endPos > file.data.length) {
      const newBuf = new Uint8Array(endPos);
      newBuf.set(file.data);
      file.data = newBuf;
    }

    for (let i = 0; i < nBytes; i++) {
      file.data[file.pos + i] = emu.memory.readU8(buf + i);
    }
    file.pos += nBytes;
    file.size = Math.max(file.size, file.pos);
    file.modified = true;

    if (writtenPtr) emu.memory.writeU32(writtenPtr, nBytes);
    return 1;
  });

  // ---- CloseHandle ----
  kernel32.register('CloseHandle', 1, () => {
    const handle = emu.readArg(0);
    const type = emu.handles.getType(handle);
    if (type === 'file') {
      const file = emu.handles.get<OpenFile>(handle);
      console.log(`[CloseHandle] handle=0x${handle.toString(16)} type=file path="${file?.path}" modified=${file?.modified}`);
      if (file) fs.persistOnClose(file);
    } else if (type) {
      console.log(`[CloseHandle] handle=0x${handle.toString(16)} type=${type}`);
    } else {
      console.log(`[CloseHandle] handle=0x${handle.toString(16)} — unknown handle`);
    }
    emu.handles.free(handle);
    return 1;
  });

  // ---- GetFileType ----
  kernel32.register('GetFileType', 1, () => {
    const h = emu.readArg(0);
    if (isConsoleHandle(h)) return 2; // FILE_TYPE_CHAR
    if (emu.handles.getType(h) === 'file') return 1; // FILE_TYPE_DISK
    return 0; // FILE_TYPE_UNKNOWN
  });

  kernel32.register('SetHandleCount', 1, () => emu.readArg(0));
  kernel32.register('FlushFileBuffers', 1, () => 1);

  // ---- SetFilePointer ----
  kernel32.register('SetFilePointer', 4, () => {
    const hFile = emu.readArg(0);
    const lDistanceToMove = emu.readArg(1) | 0;
    const lpDistanceToMoveHigh = emu.readArg(2);
    const dwMoveMethod = emu.readArg(3);

    const file = emu.handles.get<OpenFile>(hFile);
    if (!file) {
      console.log(`[SetFilePointer] handle=0x${hFile.toString(16)} — not found`);
      return INVALID_HANDLE_VALUE;
    }

    let newPos: number;
    if (dwMoveMethod === FILE_BEGIN) {
      newPos = lDistanceToMove;
    } else if (dwMoveMethod === FILE_CURRENT) {
      newPos = file.pos + lDistanceToMove;
    } else if (dwMoveMethod === FILE_END) {
      newPos = file.size + lDistanceToMove;
    } else {
      return INVALID_HANDLE_VALUE;
    }

    if (newPos < 0) newPos = 0;
    console.log(`[SetFilePointer] handle=0x${hFile.toString(16)} path="${file.path}" method=${dwMoveMethod} offset=${lDistanceToMove} newPos=${newPos}`);
    file.pos = newPos;
    if (lpDistanceToMoveHigh) emu.memory.writeU32(lpDistanceToMoveHigh, 0);
    return newPos >>> 0;
  });

  // ---- GetFileSize ----
  kernel32.register('GetFileSize', 2, () => {
    const hFile = emu.readArg(0);
    const lpFileSizeHigh = emu.readArg(1);
    const file = emu.handles.get<OpenFile>(hFile);
    if (!file) {
      console.log(`[GetFileSize] handle=0x${hFile.toString(16)} — not found`);
      return INVALID_HANDLE_VALUE;
    }
    console.log(`[GetFileSize] handle=0x${hFile.toString(16)} path="${file.path}" size=${file.size}`);
    if (lpFileSizeHigh) emu.memory.writeU32(lpFileSizeHigh, 0);
    return file.size >>> 0;
  });

  kernel32.register('SetEndOfFile', 1, () => {
    const hFile = emu.readArg(0);
    const file = emu.handles.get<OpenFile>(hFile);
    if (!file) return 0;
    if (file.data === null) file.data = new Uint8Array(0);
    if (file.pos < file.data.length) {
      file.data = file.data.slice(0, file.pos);
    } else if (file.pos > file.data.length) {
      const newBuf = new Uint8Array(file.pos);
      newBuf.set(file.data);
      file.data = newBuf;
    }
    file.size = file.pos;
    file.modified = true;
    return 1;
  });

  // BY_HANDLE_FILE_INFORMATION: 52 bytes
  // dwFileAttributes(4) ftCreationTime(8) ftLastAccessTime(8) ftLastWriteTime(8)
  // dwVolumeSerialNumber(4) nFileSizeHigh(4) nFileSizeLow(4) nNumberOfLinks(4)
  // nFileIndexHigh(4) nFileIndexLow(4)
  kernel32.register('GetFileInformationByHandle', 2, () => {
    const hFile = emu.readArg(0);
    const lpInfo = emu.readArg(1);
    if (emu.handles.getType(hFile) !== 'file') return 0;
    const file = emu.handles.get<OpenFile>(hFile)!;
    const size = file.data ? file.data.length : file.size;
    // Zero the struct, then fill in key fields
    for (let i = 0; i < 52; i += 4) emu.memory.writeU32(lpInfo + i, 0);
    const FILE_ATTRIBUTE_NORMAL = 0x80;
    emu.memory.writeU32(lpInfo, FILE_ATTRIBUTE_NORMAL); // dwFileAttributes
    emu.memory.writeU32(lpInfo + 32, 0);                // nFileSizeHigh
    emu.memory.writeU32(lpInfo + 36, size);              // nFileSizeLow
    emu.memory.writeU32(lpInfo + 40, 1);                 // nNumberOfLinks
    return 1;
  });

  // ---- File mapping ----
  kernel32.register('CreateFileMappingA', 6, () => {
    const hFile = emu.readArg(0);
    const _lpAttributes = emu.readArg(1);
    const _flProtect = emu.readArg(2);
    const _dwMaxSizeHigh = emu.readArg(3);
    const dwMaxSizeLow = emu.readArg(4);
    const size = dwMaxSizeLow || 0x10000;
    const addr = emu.allocHeap(size);
    const file = emu.handles.get<OpenFile>(hFile);
    if (file && file.data) {
      const copyLen = Math.min(file.data.length, size);
      for (let i = 0; i < copyLen; i++) emu.memory.writeU8(addr + i, file.data[i]);
    }
    return emu.handles.alloc('fileMapping', { addr, size });
  });
  kernel32.register('CreateFileMappingW', 6, () => {
    const hFile = emu.readArg(0);
    const _lpAttributes = emu.readArg(1);
    const _flProtect = emu.readArg(2);
    const _dwMaxSizeHigh = emu.readArg(3);
    const dwMaxSizeLow = emu.readArg(4);
    const file = emu.handles.get<OpenFile>(hFile);
    const fileSize = file?.data?.length ?? file?.size ?? 0;
    const size = dwMaxSizeLow || fileSize || 0x10000;
    const addr = emu.allocHeap(size);
    if (file && file.data) {
      const copyLen = Math.min(file.data.length, size);
      for (let i = 0; i < copyLen; i++) emu.memory.writeU8(addr + i, file.data[i]);
    }
    return emu.handles.alloc('fileMapping', { addr, size });
  });
  kernel32.register('MapViewOfFile', 5, () => {
    const hFileMappingObject = emu.readArg(0);
    const mapping = emu.handles.get<{ addr: number; size: number }>(hFileMappingObject);
    if (mapping && mapping.addr) return mapping.addr;
    return emu.allocHeap(0x10000);
  });
  kernel32.register('UnmapViewOfFile', 1, () => {
    return 1;
  });

  // ---- Time conversions ----
  kernel32.register('FileTimeToLocalFileTime', 2, () => {
    const lpFileTime = emu.readArg(0);
    const lpLocalFileTime = emu.readArg(1);
    if (lpFileTime && lpLocalFileTime) {
      emu.memory.writeU32(lpLocalFileTime, emu.memory.readU32(lpFileTime));
      emu.memory.writeU32(lpLocalFileTime + 4, emu.memory.readU32(lpFileTime + 4));
    }
    return 1;
  });
  kernel32.register('FileTimeToDosDateTime', 3, () => 1);
  kernel32.register('DosDateTimeToFileTime', 3, () => 1);

  kernel32.register('LocalFileTimeToFileTime', 2, () => {
    const lpLocalFileTime = emu.readArg(0);
    const lpFileTime = emu.readArg(1);
    if (lpLocalFileTime && lpFileTime) {
      emu.memory.writeU32(lpFileTime, emu.memory.readU32(lpLocalFileTime));
      emu.memory.writeU32(lpFileTime + 4, emu.memory.readU32(lpLocalFileTime + 4));
    }
    return 1;
  });

  kernel32.register('FileTimeToSystemTime', 2, () => {
    const lpFileTime = emu.readArg(0);
    const lpSystemTime = emu.readArg(1);
    if (!lpFileTime || !lpSystemTime) return 0;
    const lo = emu.memory.readU32(lpFileTime);
    const hi = emu.memory.readU32(lpFileTime + 4);
    const ft = BigInt(hi) * 0x100000000n + BigInt(lo);
    const msFromEpoch = Number((ft - 116444736000000000n) / 10000n);
    const d = new Date(msFromEpoch);
    emu.memory.writeU16(lpSystemTime + 0, d.getUTCFullYear());
    emu.memory.writeU16(lpSystemTime + 2, d.getUTCMonth() + 1);
    emu.memory.writeU16(lpSystemTime + 4, d.getUTCDay());
    emu.memory.writeU16(lpSystemTime + 6, d.getUTCDate());
    emu.memory.writeU16(lpSystemTime + 8, d.getUTCHours());
    emu.memory.writeU16(lpSystemTime + 10, d.getUTCMinutes());
    emu.memory.writeU16(lpSystemTime + 12, d.getUTCSeconds());
    emu.memory.writeU16(lpSystemTime + 14, d.getUTCMilliseconds());
    return 1;
  });

  kernel32.register('SystemTimeToFileTime', 2, () => {
    const lpSystemTime = emu.readArg(0);
    const lpFileTime = emu.readArg(1);
    if (!lpSystemTime || !lpFileTime) return 0;
    const y = emu.memory.readU16(lpSystemTime);
    const m = emu.memory.readU16(lpSystemTime + 2) - 1;
    const day = emu.memory.readU16(lpSystemTime + 6);
    const h = emu.memory.readU16(lpSystemTime + 8);
    const min = emu.memory.readU16(lpSystemTime + 10);
    const s = emu.memory.readU16(lpSystemTime + 12);
    const ms = emu.memory.readU16(lpSystemTime + 14);
    const d = new Date(Date.UTC(y, m, day, h, min, s, ms));
    const ft = BigInt(d.getTime()) * 10000n + 116444736000000000n;
    emu.memory.writeU32(lpFileTime, Number(ft & 0xFFFFFFFFn));
    emu.memory.writeU32(lpFileTime + 4, Number((ft >> 32n) & 0xFFFFFFFFn));
    return 1;
  });

  kernel32.register('SetStdHandle', 2, () => 1);

  // ---- FindFirstFile / FindNextFile ----
  let nextFindHandle = 0x100;
  const findHandles = new Map<number, { files: { name: string; size: number; isDir: boolean }[]; index: number }>();

  const FILE_ATTRIBUTE_ARCHIVE = 0x20;
  const FILE_ATTRIBUTE_DIRECTORY = 0x10;

  /** Generate an 8.3 short filename from a long filename */
  function toShortName(name: string): string {
    // Strip trailing slash for directories
    const n = name.endsWith('/') ? name.slice(0, -1) : name;
    const dot = n.lastIndexOf('.');
    let base = dot >= 0 ? n.substring(0, dot) : n;
    let ext = dot >= 0 ? n.substring(dot + 1) : '';
    base = base.toUpperCase().replace(/[^A-Z0-9_\-]/g, '').substring(0, 8);
    ext = ext.toUpperCase().replace(/[^A-Z0-9_\-]/g, '').substring(0, 3);
    if (!base) base = 'FILE';
    return ext ? `${base}.${ext}` : base;
  }

  function writeFindDataW(ptr: number, entry: { name: string; size: number; isDir: boolean }): void {
    for (let i = 0; i < 592; i++) emu.memory.writeU8(ptr + i, 0);
    emu.memory.writeU32(ptr, entry.isDir ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_ARCHIVE);
    const ft = 0x01BF53EB256D4000n;
    const ftLow = Number(ft & 0xFFFFFFFFn);
    const ftHigh = Number((ft >> 32n) & 0xFFFFFFFFn);
    for (const off of [4, 12, 20]) {
      emu.memory.writeU32(ptr + off, ftLow);
      emu.memory.writeU32(ptr + off + 4, ftHigh);
    }
    emu.memory.writeU32(ptr + 32, entry.size);
    // cFileName at offset 44 (WCHAR[260])
    const nameToWrite = entry.name.substring(0, 259);
    for (let i = 0; i < nameToWrite.length; i++) {
      emu.memory.writeU16(ptr + 44 + i * 2, nameToWrite.charCodeAt(i));
    }
    // cAlternateFileName at offset 564 (WCHAR[14])
    const shortName = toShortName(entry.name);
    for (let i = 0; i < shortName.length && i < 13; i++) {
      emu.memory.writeU16(ptr + 564 + i * 2, shortName.charCodeAt(i));
    }
  }

  function writeFindDataA(ptr: number, entry: { name: string; size: number; isDir: boolean }): void {
    for (let i = 0; i < 320; i++) emu.memory.writeU8(ptr + i, 0);
    emu.memory.writeU32(ptr, entry.isDir ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_ARCHIVE);
    const ft = 0x01BF53EB256D4000n;
    const ftLow = Number(ft & 0xFFFFFFFFn);
    const ftHigh = Number((ft >> 32n) & 0xFFFFFFFFn);
    for (const off of [4, 12, 20]) {
      emu.memory.writeU32(ptr + off, ftLow);
      emu.memory.writeU32(ptr + off + 4, ftHigh);
    }
    emu.memory.writeU32(ptr + 32, entry.size);
    // cFileName at offset 44 (CHAR[260])
    const nameToWrite = entry.name.substring(0, 259);
    for (let i = 0; i < nameToWrite.length; i++) {
      emu.memory.writeU8(ptr + 44 + i, nameToWrite.charCodeAt(i) & 0xFF);
    }
    // cAlternateFileName at offset 304 (CHAR[14])
    const shortName = toShortName(entry.name);
    for (let i = 0; i < shortName.length && i < 13; i++) {
      emu.memory.writeU8(ptr + 304 + i, shortName.charCodeAt(i) & 0xFF);
    }
  }

  kernel32.register('FindFirstFileA', 2, () => {
    const lpFileName = emu.readArg(0);
    const lpFindData = emu.readArg(1);
    if (!lpFileName) return INVALID_HANDLE_VALUE;
    const rawName = emu.memory.readCString(lpFileName);
    const pattern = emu.resolvePath(rawName);
    const files = fs.getVirtualDirListing(pattern, emu.additionalFiles);
    console.log(`[FindFirstFileA] pattern="${rawName}" resolved="${pattern}" found=${files.length} files`);
    if (files.length === 0) return INVALID_HANDLE_VALUE;
    writeFindDataA(lpFindData, files[0]);
    const handle = nextFindHandle++;
    findHandles.set(handle, { files, index: 1 });
    return handle;
  });

  kernel32.register('FindFirstFileW', 2, () => {
    const lpFileName = emu.readArg(0);
    const lpFindData = emu.readArg(1);
    if (!lpFileName) return INVALID_HANDLE_VALUE;
    const rawName = emu.memory.readUTF16String(lpFileName);
    const pattern = emu.resolvePath(rawName);
    const files = fs.getVirtualDirListing(pattern, emu.additionalFiles);
    console.log(`[FindFirstFileW] pattern="${rawName}" resolved="${pattern}" found=${files.length} files`);
    if (files.length === 0) return INVALID_HANDLE_VALUE;
    writeFindDataW(lpFindData, files[0]);
    const handle = nextFindHandle++;
    findHandles.set(handle, { files, index: 1 });
    return handle;
  });

  kernel32.register('FindNextFileA', 2, () => {
    const hFind = emu.readArg(0);
    const lpFindData = emu.readArg(1);
    const state = findHandles.get(hFind);
    if (!state || state.index >= state.files.length) return 0;
    writeFindDataA(lpFindData, state.files[state.index]);
    state.index++;
    return 1;
  });

  kernel32.register('FindNextFileW', 2, () => {
    const hFind = emu.readArg(0);
    const lpFindData = emu.readArg(1);
    const state = findHandles.get(hFind);
    if (!state || state.index >= state.files.length) return 0;
    writeFindDataW(lpFindData, state.files[state.index]);
    state.index++;
    return 1;
  });

  kernel32.register('FindClose', 1, () => {
    const hFind = emu.readArg(0);
    findHandles.delete(hFind);
    return 1;
  });

  function doDeleteFile(isWide: boolean): number {
    const lpFileName = emu.readArg(0);
    if (!lpFileName) return 0;
    const rawPath = isWide ? emu.memory.readUTF16String(lpFileName) : emu.memory.readCString(lpFileName);
    const resolved = emu.resolvePath(rawPath);
    const result = fs.deleteFile(resolved) ? 1 : 0;
    console.log(`[DeleteFile] path="${rawPath}" resolved="${resolved}" result=${result}`);
    return result;
  }
  kernel32.register('DeleteFileA', 1, () => doDeleteFile(false));
  kernel32.register('DeleteFileW', 1, () => doDeleteFile(true));
  kernel32.register('GetTempFileNameW', 4, () => 0);

  // ---- Path resolution APIs ----
  kernel32.register('GetFullPathNameW', 4, () => {
    const lpFileName = emu.readArg(0);
    const nBufferLength = emu.readArg(1);
    const lpBuffer = emu.readArg(2);
    const lpFilePart = emu.readArg(3);
    if (!lpFileName) return 0;
    const name = emu.resolvePath(emu.memory.readUTF16String(lpFileName));
    if (lpBuffer && nBufferLength > name.length) {
      emu.memory.writeUTF16String(lpBuffer, name);
      if (lpFilePart) {
        const lastSlash = name.lastIndexOf('\\');
        if (lastSlash >= 0 && lastSlash < name.length - 1) {
          emu.memory.writeU32(lpFilePart, lpBuffer + (lastSlash + 1) * 2);
        } else {
          emu.memory.writeU32(lpFilePart, 0);
        }
      }
    }
    return name.length;
  });

  kernel32.register('GetFullPathNameA', 4, () => {
    const lpFileName = emu.readArg(0);
    const nBufferLength = emu.readArg(1);
    const lpBuffer = emu.readArg(2);
    const lpFilePart = emu.readArg(3);
    if (!lpFileName) return 0;
    const name = emu.resolvePath(emu.memory.readCString(lpFileName));
    if (lpBuffer && nBufferLength > name.length) {
      emu.memory.writeCString(lpBuffer, name);
      if (lpFilePart) {
        const lastSlash = name.lastIndexOf('\\');
        if (lastSlash >= 0 && lastSlash < name.length - 1) {
          emu.memory.writeU32(lpFilePart, lpBuffer + lastSlash + 1);
        } else {
          emu.memory.writeU32(lpFilePart, 0);
        }
      }
    }
    return name.length;
  });

  kernel32.register('GetShortPathNameW', 3, () => {
    const lpszLong = emu.readArg(0);
    const lpszShort = emu.readArg(1);
    const cchBuffer = emu.readArg(2);
    if (!lpszLong) return 0;
    let len = 0;
    while (emu.memory.readU16(lpszLong + len * 2) !== 0) len++;
    if (lpszShort && cchBuffer > len) {
      for (let i = 0; i <= len; i++) {
        emu.memory.writeU16(lpszShort + i * 2, emu.memory.readU16(lpszLong + i * 2));
      }
    }
    return len;
  });

  kernel32.register('GetShortPathNameA', 3, () => {
    const longPath = emu.readArg(0);
    const shortPath = emu.readArg(1);
    const bufSize = emu.readArg(2);
    const str = emu.memory.readCString(longPath);
    if (shortPath && bufSize > str.length) {
      for (let i = 0; i < str.length; i++) emu.memory.writeU8(shortPath + i, str.charCodeAt(i));
      emu.memory.writeU8(shortPath + str.length, 0);
    }
    return str.length;
  });

  // ---- Directory APIs ----
  const writeCString = (ptr: number, str: string, maxLen: number): number => {
    if (maxLen === 0 || ptr === 0) return str.length + 1;
    if (str.length + 1 > maxLen) return str.length + 1;
    for (let i = 0; i < str.length; i++) emu.memory.writeU8(ptr + i, str.charCodeAt(i));
    emu.memory.writeU8(ptr + str.length, 0);
    return str.length;
  };

  kernel32.register('GetTempPathA', 2, () => {
    const bufSize = emu.readArg(0);
    const bufPtr = emu.readArg(1);
    return writeCString(bufPtr, 'C:\\TEMP\\', bufSize);
  });

  kernel32.register('GetTempPathW', 2, () => {
    const nBufferLength = emu.readArg(0);
    const lpBuffer = emu.readArg(1);
    const path = 'C:\\TEMP\\';
    if (nBufferLength === 0 || lpBuffer === 0) return path.length;
    if (nBufferLength > path.length) {
      for (let i = 0; i < path.length; i++) {
        emu.memory.writeU16(lpBuffer + i * 2, path.charCodeAt(i));
      }
      emu.memory.writeU16(lpBuffer + path.length * 2, 0);
    }
    return path.length;
  });

  kernel32.register('GetSystemDirectoryA', 2, () => {
    const bufPtr = emu.readArg(0);
    const bufSize = emu.readArg(1);
    return writeCString(bufPtr, 'C:\\WINDOWS\\SYSTEM32', bufSize);
  });

  kernel32.register('GetWindowsDirectoryA', 2, () => {
    const bufPtr = emu.readArg(0);
    const bufSize = emu.readArg(1);
    return writeCString(bufPtr, 'C:\\WINDOWS', bufSize);
  });

  kernel32.register('GetWindowsDirectoryW', 2, () => {
    const bufPtr = emu.readArg(0);
    const bufSize = emu.readArg(1);
    const path = 'C:\\WINDOWS';
    if (bufPtr && bufSize > 0) emu.memory.writeUTF16String(bufPtr, path);
    return path.length;
  });

  kernel32.register('SearchPathA', 6, () => {
    const lpPath = emu.readArg(0);
    const lpFileName = emu.readArg(1);
    const lpExtension = emu.readArg(2);
    const nBufferLength = emu.readArg(3);
    const lpBuffer = emu.readArg(4);
    const lpFilePart = emu.readArg(5);
    let fileName = lpFileName ? emu.memory.readCString(lpFileName) : '';
    const ext = lpExtension ? emu.memory.readCString(lpExtension) : '';
    if (ext && !fileName.includes('.')) fileName += ext;
    const lowerName = fileName.toLowerCase();
    let found = false;
    for (const vf of fs.virtualFiles) {
      if (vf.name.toLowerCase() === lowerName) { found = true; break; }
    }
    if (!found) {
      for (const [name] of emu.additionalFiles) {
        if (name.toLowerCase() === lowerName) { found = true; break; }
      }
    }
    if (!found) return 0;
    const fullPath = `C:\\WINDOWS\\${fileName}`;
    const needed = fullPath.length + 1;
    if (nBufferLength < needed) return needed;
    if (lpBuffer) {
      emu.memory.writeCString(lpBuffer, fullPath);
      if (lpFilePart) {
        const lastSlash = fullPath.lastIndexOf('\\');
        emu.memory.writeU32(lpFilePart, lpBuffer + lastSlash + 1);
      }
    }
    return fullPath.length;
  });

  kernel32.register('SearchPathW', 6, () => {
    const lpPath = emu.readArg(0);
    const lpFileName = emu.readArg(1);
    const lpExtension = emu.readArg(2);
    const nBufferLength = emu.readArg(3);
    const lpBuffer = emu.readArg(4);
    const lpFilePart = emu.readArg(5);
    let fileName = lpFileName ? emu.memory.readUTF16String(lpFileName) : '';
    const ext = lpExtension ? emu.memory.readUTF16String(lpExtension) : '';
    if (ext && !fileName.includes('.')) fileName += ext;
    const lowerName = fileName.toLowerCase();
    let found = false;
    for (const vf of fs.virtualFiles) {
      if (vf.name.toLowerCase() === lowerName) { found = true; break; }
    }
    if (!found) {
      for (const [name] of emu.additionalFiles) {
        if (name.toLowerCase() === lowerName) { found = true; break; }
      }
    }
    if (!found) return 0;
    const fullPath = `C:\\WINDOWS\\${fileName}`;
    const needed = fullPath.length + 1;
    if (nBufferLength < needed) return needed;
    if (lpBuffer) {
      emu.memory.writeUTF16String(lpBuffer, fullPath);
      if (lpFilePart) {
        const lastSlash = fullPath.lastIndexOf('\\');
        emu.memory.writeU32(lpFilePart, lpBuffer + (lastSlash + 1) * 2);
      }
    }
    return fullPath.length;
  });

  kernel32.register('GetCurrentDirectoryA', 2, () => {
    const bufSize = emu.readArg(0);
    const bufPtr = emu.readArg(1);
    const path = emu.currentDirs.get(emu.currentDrive) || (emu.currentDrive + ':\\');
    return writeCString(bufPtr, path, bufSize);
  });

  kernel32.register('GetCurrentDirectoryW', 2, () => {
    const bufSize = emu.readArg(0);
    const bufPtr = emu.readArg(1);
    const path = emu.currentDirs.get(emu.currentDrive) || (emu.currentDrive + ':\\');
    if (bufPtr && bufSize > path.length) {
      emu.memory.writeUTF16String(bufPtr, path);
    }
    return path.length;
  });

  kernel32.register('SetCurrentDirectoryA', 1, () => {
    const bufPtr = emu.readArg(0);
    if (!bufPtr) return 0;
    return setCurrentDir(emu.memory.readCString(bufPtr));
  });

  kernel32.register('SetCurrentDirectoryW', 1, () => {
    const bufPtr = emu.readArg(0);
    if (!bufPtr) return 0;
    return setCurrentDir(emu.memory.readUTF16String(bufPtr));
  });

  function setCurrentDir(path: string): number {
    let resolved = emu.resolvePath(path);
    if (resolved.length > 3 && resolved.endsWith('\\')) resolved = resolved.slice(0, -1);
    const attrs = fs.getFileAttributes(resolved, emu.additionalFiles);
    if (attrs === INVALID_HANDLE_VALUE) return 0;
    if (!(attrs & FILE_ATTRIBUTE_DIRECTORY)) return 0;
    const drive = resolved[0].toUpperCase();
    emu.currentDrive = drive;
    emu.currentDirs.set(drive, resolved);
    return 1;
  }

  function doCreateDirectory(isWide: boolean): number {
    const lpPathName = emu.readArg(0);
    if (!lpPathName) return 0;
    const rawPath = isWide ? emu.memory.readUTF16String(lpPathName) : emu.memory.readCString(lpPathName);
    const resolved = emu.resolvePath(rawPath).toUpperCase();
    return fs.createDirectory(resolved) ? 1 : 0;
  }
  kernel32.register('CreateDirectoryA', 2, () => doCreateDirectory(false));
  kernel32.register('CreateDirectoryW', 2, () => doCreateDirectory(true));

  function doRemoveDirectory(isWide: boolean): number {
    const lpPathName = emu.readArg(0);
    if (!lpPathName) return 0;
    const rawPath = isWide ? emu.memory.readUTF16String(lpPathName) : emu.memory.readCString(lpPathName);
    const resolved = emu.resolvePath(rawPath).toUpperCase();
    return fs.removeDirectory(resolved) ? 1 : 0;
  }
  kernel32.register('RemoveDirectoryA', 1, () => doRemoveDirectory(false));
  kernel32.register('RemoveDirectoryW', 1, () => doRemoveDirectory(true));

  // ---- Drive / disk APIs ----
  const DRIVE_FIXED = 3;
  const DRIVE_CDROM = 5;
  function getDriveType(wide: boolean) {
    const ptr = emu.readArg(0);
    if (ptr) {
      const ch = wide ? emu.memory.readU16(ptr) : emu.memory.readU8(ptr);
      // D: is the virtual file drive — report as CD-ROM for games that scan for their CD
      if (ch === 0x44 || ch === 0x64) return DRIVE_CDROM; // 'D' or 'd'
    }
    return DRIVE_FIXED;
  }
  kernel32.register('GetDriveTypeW', 1, () => getDriveType(true));
  kernel32.register('GetDriveTypeA', 1, () => getDriveType(false));
  kernel32.register('GetLogicalDrives', 0, () => 0x0200000C);
  // GetFileAttributesEx fills a WIN32_FILE_ATTRIBUTE_DATA struct (36 bytes):
  //   DWORD attributes; FILETIME create, access, write; DWORD sizeHi, sizeLo.
  // Stub→0 made installers and CRT stat()s misreport "file missing" even
  // when GetFileAttributesA would return a valid value for the same path.
  const getFileAttrsEx = (wide: boolean) => (): number => {
    const lpFileName = emu.readArg(0);
    const _level = emu.readArg(1);
    const lpInfo = emu.readArg(2);
    if (!lpFileName || !lpInfo) return 0;
    const name = wide ? emu.memory.readUTF16String(lpFileName) : emu.memory.readCString(lpFileName);
    const attrs = fs.getFileAttributes(name, emu.additionalFiles);
    if (attrs === INVALID_HANDLE_VALUE) return 0;
    emu.memory.writeU32(lpInfo,      attrs);
    // FILETIMEs — we don't track them; zero is OK (callers usually only check
    // attributes for existence and FILE_ATTRIBUTE_DIRECTORY).
    emu.memory.writeU32(lpInfo + 4,  0); emu.memory.writeU32(lpInfo + 8,  0);
    emu.memory.writeU32(lpInfo + 12, 0); emu.memory.writeU32(lpInfo + 16, 0);
    emu.memory.writeU32(lpInfo + 20, 0); emu.memory.writeU32(lpInfo + 24, 0);
    // File size — directories are 0; for files we don't have a cheap way to
    // peek size without opening, so zero is the safest fallback.
    emu.memory.writeU32(lpInfo + 28, 0);
    emu.memory.writeU32(lpInfo + 32, 0);
    return 1;
  };
  kernel32.register('GetFileAttributesExA', 3, getFileAttrsEx(false));
  kernel32.register('GetFileAttributesExW', 3, getFileAttrsEx(true));

  kernel32.register('GetDiskFreeSpaceW', 5, () => {
    const _lpRootPathName = emu.readArg(0);
    const lpSectorsPerCluster = emu.readArg(1);
    const lpBytesPerSector = emu.readArg(2);
    const lpNumberOfFreeClusters = emu.readArg(3);
    const lpTotalNumberOfClusters = emu.readArg(4);
    // Use FAT16-style values (all under 65536) to avoid 16-bit overflow in older games
    if (lpSectorsPerCluster) emu.memory.writeU32(lpSectorsPerCluster, 64);
    if (lpBytesPerSector) emu.memory.writeU32(lpBytesPerSector, 512);
    if (lpNumberOfFreeClusters) emu.memory.writeU32(lpNumberOfFreeClusters, 32760);   // ~1GB free
    if (lpTotalNumberOfClusters) emu.memory.writeU32(lpTotalNumberOfClusters, 65520); // ~2GB total
    return 1;
  });

  kernel32.register('GetDiskFreeSpaceA', 5, () => {
    const _lpRootPathName = emu.readArg(0);
    const lpSectorsPerCluster = emu.readArg(1);
    const lpBytesPerSector = emu.readArg(2);
    const lpNumberOfFreeClusters = emu.readArg(3);
    const lpTotalNumberOfClusters = emu.readArg(4);
    // Use FAT16-style values (all under 65536) to avoid 16-bit overflow in older games
    if (lpSectorsPerCluster) emu.memory.writeU32(lpSectorsPerCluster, 64);
    if (lpBytesPerSector) emu.memory.writeU32(lpBytesPerSector, 512);
    if (lpNumberOfFreeClusters) emu.memory.writeU32(lpNumberOfFreeClusters, 32760);   // ~1GB free
    if (lpTotalNumberOfClusters) emu.memory.writeU32(lpTotalNumberOfClusters, 65520); // ~2GB total
    return 1;
  });

  const getDiskFreeSpaceExImpl = () => {
    const _lpDir = emu.readArg(0);
    const lpFreeBytesAvailable = emu.readArg(1);
    const lpTotalBytes = emu.readArg(2);
    const lpTotalFreeBytes = emu.readArg(3);
    // Report 1GB free, 10GB total
    if (lpFreeBytesAvailable) { emu.memory.writeU32(lpFreeBytesAvailable, 0x40000000); emu.memory.writeU32(lpFreeBytesAvailable + 4, 0); }
    if (lpTotalBytes) { emu.memory.writeU32(lpTotalBytes, 0x80000000); emu.memory.writeU32(lpTotalBytes + 4, 2); }
    if (lpTotalFreeBytes) { emu.memory.writeU32(lpTotalFreeBytes, 0x40000000); emu.memory.writeU32(lpTotalFreeBytes + 4, 0); }
    return 1;
  };
  kernel32.register('GetDiskFreeSpaceExW', 4, getDiskFreeSpaceExImpl);
  kernel32.register('GetDiskFreeSpaceExA', 4, getDiskFreeSpaceExImpl);

  kernel32.register('DeviceIoControl', 8, () => 0);

  kernel32.register('GetVolumeInformationW', 8, () => {
    const lpRootPathName = emu.readArg(0);
    const lpVolumeNameBuffer = emu.readArg(1);
    const nVolumeNameSize = emu.readArg(2);
    const lpSerialNumber = emu.readArg(3);
    const lpMaxComponentLength = emu.readArg(4);
    const lpFileSystemFlags = emu.readArg(5);
    const lpFileSystemNameBuffer = emu.readArg(6);
    const nFileSystemNameSize = emu.readArg(7);
    if (lpVolumeNameBuffer && nVolumeNameSize > 0) emu.memory.writeUTF16String(lpVolumeNameBuffer, 'LOCAL DISK');
    if (lpSerialNumber) emu.memory.writeU32(lpSerialNumber, 0x1234ABCD);
    if (lpMaxComponentLength) emu.memory.writeU32(lpMaxComponentLength, 255);
    if (lpFileSystemFlags) emu.memory.writeU32(lpFileSystemFlags, 0x00000003);
    if (lpFileSystemNameBuffer && nFileSystemNameSize > 0) emu.memory.writeUTF16String(lpFileSystemNameBuffer, 'NTFS');
    return 1;
  });

  // ---- File attributes ----
  // Probe the path for a known JS-stub system DLL at a canonical location.
  // Programs like WINHLP32 call GetFileAttributesA/SearchPathA before LoadLibrary; without this,
  // dynamically-loaded system DLLs (comdlg32, shell32, etc.) appear missing even though we have stubs.
  function attrsForJsStubDll(pathStr: string): number | null {
    const upper = pathStr.toUpperCase().replace(/\//g, '\\');
    let basename: string | null = null;
    for (const prefix of ['C:\\WINDOWS\\SYSTEM32\\', 'C:\\WINDOWS\\']) {
      if (upper.startsWith(prefix)) {
        const rest = upper.substring(prefix.length);
        if (rest && !rest.includes('\\')) { basename = rest; break; }
      }
    }
    if (!basename) return null;
    const dllPrefix = basename + ':';
    for (const key of emu.apiDefs.keys()) {
      if (key.startsWith(dllPrefix)) return FILE_ATTRIBUTE_ARCHIVE;
    }
    return null;
  }

  kernel32.register('GetFileAttributesW', 1, () => {
    const lpFileName = emu.readArg(0);
    if (!lpFileName) return INVALID_HANDLE_VALUE;
    const name = emu.memory.readUTF16String(lpFileName);
    let result = fs.getFileAttributes(name, emu.additionalFiles);
    if (result === INVALID_HANDLE_VALUE) {
      const stubResult = attrsForJsStubDll(name);
      if (stubResult !== null) result = stubResult;
    }
    console.log(`[GetFileAttributesW] path="${name}" result=0x${result.toString(16)}`);
    return result;
  });

  kernel32.register('GetFileAttributesA', 1, () => {
    const lpFileName = emu.readArg(0);
    if (!lpFileName) return INVALID_HANDLE_VALUE;
    const name = emu.memory.readCString(lpFileName);
    let result = fs.getFileAttributes(name, emu.additionalFiles);
    if (result === INVALID_HANDLE_VALUE) {
      const stubResult = attrsForJsStubDll(name);
      if (stubResult !== null) result = stubResult;
    }
    console.log(`[GetFileAttributesA] path="${name}" result=0x${result.toString(16)}`);
    return result;
  });

  kernel32.register('SetFileAttributesA', 2, () => 1);
  kernel32.register('SetFileAttributesW', 2, () => 1);
  kernel32.register('SetFileTime', 4, () => 1);
  kernel32.register('GetFileTime', 4, () => 1);
  kernel32.register('GetTempFileNameA', 4, () => 0);

  // CopyFile: async
  function doCopyFile(isWide: boolean): number | undefined {
    const lpExisting = emu.readArg(0);
    const lpNew = emu.readArg(1);
    const bFailIfExists = emu.readArg(2);
    if (!lpExisting || !lpNew) return 0;

    const srcPath = isWide ? emu.memory.readUTF16String(lpExisting) : emu.memory.readCString(lpExisting);
    const dstPath = isWide ? emu.memory.readUTF16String(lpNew) : emu.memory.readCString(lpNew);
    const resolvedSrc = emu.resolvePath(srcPath);
    const resolvedDst = emu.resolvePath(dstPath);
    const dstUpper = resolvedDst.toUpperCase();

    console.log(`[CopyFile] "${srcPath}" -> "${dstPath}"`);

    const srcFile = fs.findFile(resolvedSrc, emu.additionalFiles);
    if (!srcFile) return 0;

    if (bFailIfExists) {
      const dstFile = fs.findFile(resolvedDst, emu.additionalFiles);
      if (dstFile) return 0;
    }

    if (!dstUpper.startsWith('D:\\')) return 0;

    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    fs.fetchFileData(srcFile, emu.additionalFiles).then(ab => {
      const data = ab ? new Uint8Array(ab) : new Uint8Array(0);
      const dstStoreName = resolvedDst.substring(3).replace(/\\/g, '/');
      fs.saveVirtualFile(dstStoreName, data);

      emu.waitingForMessage = false;
      emuCompleteThunk(emu, 1, stackBytes);
      if (emu.running && !emu.halted) {
        requestAnimationFrame(emu.tick);
      }
    });
    return undefined;
  }

  kernel32.register('CopyFileA', 3, () => doCopyFile(false));
  kernel32.register('CopyFileW', 3, () => doCopyFile(true));

  // MoveFile: copy source to dest, then remove source
  function doMoveFile(isWide: boolean, hasFlags: boolean): number | undefined {
    const lpExisting = emu.readArg(0);
    const lpNew = emu.readArg(1);
    if (!lpExisting || !lpNew) return 0;

    const srcPath = isWide ? emu.memory.readUTF16String(lpExisting) : emu.memory.readCString(lpExisting);
    const dstPath = isWide ? emu.memory.readUTF16String(lpNew) : emu.memory.readCString(lpNew);
    const resolvedSrc = emu.resolvePath(srcPath);
    const resolvedDst = emu.resolvePath(dstPath);
    const srcUpper = resolvedSrc.toUpperCase();
    const dstUpper = resolvedDst.toUpperCase();

    console.log(`[MoveFile] "${srcPath}" -> "${dstPath}"`);

    const srcFile = fs.findFile(resolvedSrc, emu.additionalFiles);
    if (!srcFile) return 0;

    if (!dstUpper.startsWith('D:\\')) return 0;

    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    fs.fetchFileData(srcFile, emu.additionalFiles).then(ab => {
      const data = ab ? new Uint8Array(ab) : new Uint8Array(0);
      const dstStoreName = resolvedDst.substring(3).replace(/\\/g, '/');
      fs.saveVirtualFile(dstStoreName, data);

      // Remove source from virtualFiles (if on D:\)
      if (srcUpper.startsWith('D:\\')) {
        const srcRelPath = srcUpper.substring(3);
        fs.removeVirtualFile(srcRelPath, srcFile.name);
      }

      emu.waitingForMessage = false;
      emuCompleteThunk(emu, 1, stackBytes);
      if (emu.running && !emu.halted) {
        requestAnimationFrame(emu.tick);
      }
    });
    return undefined;
  }

  kernel32.register('MoveFileA', 2, () => doMoveFile(false, false));
  kernel32.register('MoveFileW', 2, () => doMoveFile(true, false));
  kernel32.register('MoveFileExA', 3, () => doMoveFile(false, true));
  kernel32.register('MoveFileExW', 3, () => doMoveFile(true, true));

  kernel32.register('UnlockFile', 5, () => 1);
  kernel32.register('LockFile', 5, () => 1);

  kernel32.register('OpenFileMappingA', 3, () => 0);

  // SetFilePointerEx(hFile, liDistanceToMove_lo, liDistanceToMove_hi,
  //                   lpNewFilePointer, dwMoveMethod) — the 64-bit variant
  // of SetFilePointer. Was a stub returning 0 (fail), so any app built for
  // large-file support saw "seek failed" and refused to read past 2 GB —
  // and modern CRT/MFC apps prefer Ex even for tiny files.
  kernel32.register('SetFilePointerEx', 5, () => {
    const hFile = emu.readArg(0);
    const distLo = emu.readArg(1) | 0;
    const distHi = emu.readArg(2) | 0;
    const lpNewFP = emu.readArg(3);
    const dwMoveMethod = emu.readArg(4);
    const file = emu.handles.get<OpenFile>(hFile);
    if (!file) return 0;
    // Combine 64-bit signed offset (we cap at JS safe int range — files
    // here never approach 2 PB).
    const dist = distLo + distHi * 0x100000000;
    let newPos: number;
    if (dwMoveMethod === FILE_BEGIN)        newPos = dist;
    else if (dwMoveMethod === FILE_CURRENT) newPos = file.pos + dist;
    else if (dwMoveMethod === FILE_END)     newPos = file.size + dist;
    else return 0;
    if (newPos < 0) return 0; // seek before start is an error per docs
    file.pos = newPos;
    if (lpNewFP) {
      emu.memory.writeU32(lpNewFP,     newPos >>> 0);
      emu.memory.writeU32(lpNewFP + 4, Math.floor(newPos / 0x100000000) >>> 0);
    }
    return 1; // TRUE
  });

  // FindFirstFileExA(lpFileName, fInfoLevelId, lpFindFileData, fSearchOp, lpSearchFilter, dwAdditionalFlags) — 6 args
  kernel32.register('FindFirstFileExA', 6, () => 0xFFFFFFFF); // INVALID_HANDLE_VALUE

  // FindFirstFileExW — 6 args
  kernel32.register('FindFirstFileExW', 6, () => 0xFFFFFFFF);

  // CreateDirectoryExW(lpTemplateDirectory, lpNewDirectory, lpSecurityAttributes) — 3 args
  kernel32.register('CreateDirectoryExW', 3, () => 0); // fail

  // VerLanguageNameW(wLang, szLang, cchLang) — 3 args
  kernel32.register('VerLanguageNameW', 3, () => {
    const szLang = emu.readArg(1);
    const cchLang = emu.readArg(2);
    const name = 'English (United States)';
    if (szLang && cchLang > 0) {
      const len = Math.min(name.length, cchLang - 1);
      for (let i = 0; i < len; i++) emu.memory.writeU16(szLang + i * 2, name.charCodeAt(i));
      emu.memory.writeU16(szLang + len * 2, 0);
      return len;
    }
    return 0;
  });

  // GetCompressedFileSizeW(lpFileName, lpFileSizeHigh) — 2 args
  kernel32.register('GetCompressedFileSizeW', 2, () => 0xFFFFFFFF); // INVALID_FILE_SIZE

  // FindCloseChangeNotification(hChangeHandle) — 1 arg
  kernel32.register('FindCloseChangeNotification', 1, () => 1);

  // FindNextChangeNotification(hChangeHandle) — 1 arg
  kernel32.register('FindNextChangeNotification', 1, () => 1);

  // FindFirstChangeNotificationW(lpPathName, bWatchSubtree, dwNotifyFilter) — 3 args
  kernel32.register('FindFirstChangeNotificationW', 3, () => 0xFFFFFFFF); // INVALID_HANDLE_VALUE

  // CreateHardLinkW(lpFileName, lpExistingFileName, lpSecurityAttributes) — 3 args
  kernel32.register('CreateHardLinkW', 3, () => 0); // fail

  // CopyFileExW(lpExistingFileName, lpNewFileName, lpProgressRoutine, lpData, pbCancel, dwCopyFlags) — 6 args
  kernel32.register('CopyFileExW', 6, () => 0); // fail

  // GetVolumeInformationA(lpRootPathName, lpVolName, nVolNameSize, lpSerialNumber, lpMaxComponentLen, lpFlags, lpFSName, nFSNameSize) — 8 args
  kernel32.register('GetVolumeInformationA', 8, () => {
    const lpVolumeNameBuffer = emu.readArg(1);
    const nVolumeNameSize = emu.readArg(2);
    const lpSerialNumber = emu.readArg(3);
    const lpMaxComponentLength = emu.readArg(4);
    const lpFileSystemFlags = emu.readArg(5);
    const lpFileSystemNameBuffer = emu.readArg(6);
    const nFileSystemNameSize = emu.readArg(7);
    if (lpVolumeNameBuffer && nVolumeNameSize > 0) emu.memory.writeCString(lpVolumeNameBuffer, 'LOCAL DISK');
    if (lpSerialNumber) emu.memory.writeU32(lpSerialNumber, 0x1234ABCD);
    if (lpMaxComponentLength) emu.memory.writeU32(lpMaxComponentLength, 255);
    if (lpFileSystemFlags) emu.memory.writeU32(lpFileSystemFlags, 0x00000003);
    if (lpFileSystemNameBuffer && nFileSystemNameSize > 0) emu.memory.writeCString(lpFileSystemNameBuffer, 'NTFS');
    return 1;
  });

  // QueryDosDeviceA(lpDeviceName, lpTargetPath, ucchMax) — 3 args
  kernel32.register('QueryDosDeviceA', 3, () => 0);

  // DefineDosDeviceA(dwFlags, lpDeviceName, lpTargetPath) — 3 args
  kernel32.register('DefineDosDeviceA', 3, () => 1);

  // CreatePipe(hReadPipe, hWritePipe, lpPipeAttributes, nSize) — 4 args
  kernel32.register('CreatePipe', 4, () => 0); // fail

  // PeekNamedPipe(hNamedPipe, lpBuffer, nBufferSize, lpBytesRead, lpTotalBytesAvail, lpBytesLeftThisMessage) — 6 args
  kernel32.register('PeekNamedPipe', 6, () => 0);

  // _lcreat(lpPathName, iAttribute) — create or truncate a file
  kernel32.register('_lcreat', 2, () => {
    const lpPathName = emu.readArg(0);
    const fileName = emu.memory.readCString(lpPathName);
    const resolved = emu.resolvePath(fileName);
    const upper = resolved.toUpperCase();
    return emu.handles.alloc('file', {
      path: upper,
      access: GENERIC_READ | GENERIC_WRITE,
      pos: 0, data: new Uint8Array(0), size: 0, modified: true,
    } satisfies OpenFile);
  });

  // GetBinaryTypeA(lpApplicationName, lpBinaryType) → BOOL
  // Reports executable type: 0=SCS_32BIT_BINARY, 1=SCS_DOS_BINARY, 2=SCS_WOW_BINARY, 3=SCS_PIF_BINARY, 4=SCS_POSIX_BINARY, 5=SCS_OS216_BINARY, 6=SCS_64BIT_BINARY
  kernel32.register('GetBinaryTypeA', 2, () => {
    const lpBinaryType = emu.readArg(1);
    if (lpBinaryType) emu.memory.writeU32(lpBinaryType, 0); // SCS_32BIT_BINARY
    return 1;
  });
}
