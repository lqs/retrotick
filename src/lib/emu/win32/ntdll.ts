import type { Emulator } from '../emulator';

export function registerNtdll(emu: Emulator): void {
  const ntdll = emu.registerDll('NTDLL.DLL');

  // VerSetConditionMask(ULONGLONG conditionMask, DWORD typeMask, BYTE condition)
  // ULONGLONG = 8 bytes on stack, so total stackBytes = 8+4+4 = 16 (nArgs=4)
  ntdll.register('VerSetConditionMask', 4, () => {
    // Returns a 64-bit condition mask in EDX:EAX
    // Just return a non-zero value so the caller can use it
    emu.cpu.reg[0] = 1; // EAX (low)
    emu.cpu.reg[2] = 0; // EDX (high)
    return 1;
  });

  // VerifyVersionInfoW/A: check OS version — pretend we match
  emu.apiDefs.set('KERNEL32.DLL:VerifyVersionInfoW', { handler: () => 1, stackBytes: 4 * 4 });
  emu.apiDefs.set('KERNEL32.DLL:VerifyVersionInfoA', { handler: () => 1, stackBytes: 4 * 4 });

  ntdll.register('NtQuerySystemInformation', 4, () => {
    const infoClass = emu.readArg(0);
    const bufPtr = emu.readArg(1);
    const bufLen = emu.readArg(2);
    const retLenPtr = emu.readArg(3);
    console.log(`[NTDLL] NtQuerySystemInformation class=${infoClass} buf=0x${bufPtr.toString(16)} len=${bufLen} retLenPtr=0x${retLenPtr.toString(16)}`);

    if (infoClass === 5) { // SystemProcessInformation
      // SYSTEM_PROCESS_INFORMATION is 0xB8 bytes on Win2000+ (32-bit)
      // followed by NumberOfThreads * SYSTEM_THREAD_INFORMATION (0x40 each)
      const ENTRY_SIZE = 0xB8;
      const THREAD_SIZE = 0x40;
      // Process list: prefer the real ring3 kernel's process table (true
      // concurrent processes with their own address spaces), else the shared
      // registry, else just this emulator.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const krt = emu._v86Runtime as any;
      let procs;
      if (krt && Array.isArray(krt.procs)) {
        // Collapse threads to processes (kernel models each thread as a KProc
        // sharing a pid); count threads per pid; skip zombies.
        const byPid = new Map<number, { pid: number; name: string; threadCount: number; basePriority: number; handleCount: number; workingSetSize: number; cpuTime: number }>();
        for (const p of krt.procs) {
          if (p.state === 'zombie') continue;
          const ex = byPid.get(p.pid);
          if (ex) { ex.threadCount++; continue; }
          const name = (p.emu?.exeName) || 'process.exe';
          byPid.set(p.pid, { pid: p.pid, name, threadCount: 1, basePriority: 8, handleCount: p.emu?.handles?.size?.() ?? 0, workingSetSize: 0x100000, cpuTime: 0 });
        }
        procs = [...byPid.values()];
        // Synthesize a System Idle Process so the list looks like a real machine.
        procs.unshift({ pid: 0, name: 'System Idle Process', threadCount: 1, basePriority: 0, handleCount: 0, workingSetSize: 0x1000, cpuTime: 0 });
      } else {
        procs = emu.processRegistry
          ? emu.processRegistry.getProcessList()
          : [{ pid: emu.pid || 1234, name: emu.exeName, threadCount: 1, basePriority: 8, handleCount: emu.handles.size(), workingSetSize: (emu.heapPtr - emu.heapBase + emu.virtualPtr - emu.virtualBase) || 0, cpuTime: emu.cpuTimeMs }];
      }
      // Calculate total size: each process entry + 1 thread each + string data
      let strDataSize = 0;
      for (const p of procs) strDataSize += (p.name.length + 1) * 2;
      const totalSize = procs.length * (ENTRY_SIZE + THREAD_SIZE) + strDataSize;

      if (retLenPtr) emu.memory.writeU32(retLenPtr, totalSize);
      if (bufLen < totalSize) return 0xC0000004; // STATUS_INFO_LENGTH_MISMATCH

      const strArea = bufPtr + procs.length * (ENTRY_SIZE + THREAD_SIZE);
      let off = 0;
      let strOff = 0;

      for (let idx = 0; idx < procs.length; idx++) {
        const proc = procs[idx];
        const pAddr = bufPtr + off;
        // Zero out entry + 1 thread
        for (let i = 0; i < ENTRY_SIZE + THREAD_SIZE; i += 4) emu.memory.writeU32(pAddr + i, 0);
        // NextEntryOffset (0 for last)
        const isLast = idx === procs.length - 1;
        emu.memory.writeU32(pAddr + 0x00, isLast ? 0 : ENTRY_SIZE + THREAD_SIZE);
        emu.memory.writeU32(pAddr + 0x04, proc.threadCount); // NumberOfThreads
        // ImageName UNICODE_STRING at offset 0x38
        if (proc.name) {
          const nameBytes = proc.name.length * 2;
          const namePtr = strArea + strOff;
          for (let i = 0; i < proc.name.length; i++) emu.memory.writeU16(namePtr + i * 2, proc.name.charCodeAt(i));
          emu.memory.writeU16(namePtr + nameBytes, 0);
          emu.memory.writeU16(pAddr + 0x38, nameBytes); // Length
          emu.memory.writeU16(pAddr + 0x3A, nameBytes + 2); // MaximumLength
          emu.memory.writeU32(pAddr + 0x3C, namePtr); // Buffer pointer
          strOff += nameBytes + 2;
        }
        emu.memory.writeU32(pAddr + 0x40, proc.basePriority); // BasePriority (0x40)
        emu.memory.writeU32(pAddr + 0x44, proc.pid); // UniqueProcessId (0x44)
        emu.memory.writeU32(pAddr + 0x4C, proc.handleCount); // HandleCount (0x4C)
        emu.memory.writeU32(pAddr + 0x68, proc.workingSetSize); // WorkingSetSize (0x68)
        // UserTime at offset 0x28 (LARGE_INTEGER, units of 100ns)
        const userTime100ns = Math.floor(proc.cpuTime * 10000);
        emu.memory.writeU32(pAddr + 0x28, userTime100ns & 0xFFFFFFFF); // low DWORD
        emu.memory.writeU32(pAddr + 0x2C, (userTime100ns / 0x100000000) >>> 0); // high DWORD

        // Fill SYSTEM_THREAD_INFORMATION (0x40 bytes) after process entry
        const tAddr = pAddr + ENTRY_SIZE;
        // Thread UserTime at offset 0x08
        emu.memory.writeU32(tAddr + 0x08, userTime100ns & 0xFFFFFFFF);
        emu.memory.writeU32(tAddr + 0x0C, (userTime100ns / 0x100000000) >>> 0);
        // CLIENT_ID at offset 0x20: UniqueProcess (PID) + UniqueThread (TID)
        emu.memory.writeU32(tAddr + 0x20, proc.pid);       // UniqueProcess
        emu.memory.writeU32(tAddr + 0x24, proc.pid + 1);   // UniqueThread
        // BasePriority at offset 0x2C
        emu.memory.writeU32(tAddr + 0x2C, proc.basePriority);

        off += ENTRY_SIZE + THREAD_SIZE;
      }

      return 0; // STATUS_SUCCESS
    }

    if (infoClass === 8) { // SystemProcessorPerformanceInformation
      // SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION: 48 bytes per CPU
      // struct { LARGE_INTEGER IdleTime, KernelTime, UserTime, DpcTime, InterruptTime; ULONG InterruptCount; }
      if (retLenPtr) emu.memory.writeU32(retLenPtr, 48);
      if (bufLen >= 48) {
        for (let i = 0; i < 48; i += 4) emu.memory.writeU32(bufPtr + i, 0);
        // Provide incrementing times to prevent division by zero
        // Each call should return larger values so the delta is non-zero
        emu._perfCounter = (emu._perfCounter || 0) + 1000000;
        const t = emu._perfCounter;
        // IdleTime (8 bytes) — ~50% idle
        emu.memory.writeU32(bufPtr + 0, (t * 5) >>> 0);
        emu.memory.writeU32(bufPtr + 4, 0);
        // KernelTime (8 bytes)
        emu.memory.writeU32(bufPtr + 8, (t * 3) >>> 0);
        emu.memory.writeU32(bufPtr + 12, 0);
        // UserTime (8 bytes)
        emu.memory.writeU32(bufPtr + 16, (t * 2) >>> 0);
        emu.memory.writeU32(bufPtr + 20, 0);
      }
      return 0;
    }

    if (infoClass === 2) { // SystemPerformanceInformation (312 bytes)
      const size = 312;
      if (retLenPtr) emu.memory.writeU32(retLenPtr, size);
      if (bufLen >= size) {
        for (let i = 0; i < size; i += 4) emu.memory.writeU32(bufPtr + i, 0);
        // Use browser memory info if available (Chrome performance.memory), else emulator stats
        const PAGE_SIZE = 4096;
        const perf: Performance & { memory?: { jsHeapSizeLimit: number; usedJSHeapSize: number; totalJSHeapSize: number } } = globalThis.performance;
        const mem = perf?.memory;
        let availablePages: number, committedPages: number, commitLimit: number;
        let totalPhysPages: number, pagedPoolPages: number, nonPagedPoolPages: number;
        if (mem && mem.jsHeapSizeLimit) {
          totalPhysPages = Math.floor(mem.jsHeapSizeLimit / PAGE_SIZE);
          committedPages = Math.floor(mem.usedJSHeapSize / PAGE_SIZE);
          commitLimit = Math.floor(mem.totalJSHeapSize / PAGE_SIZE);
          availablePages = totalPhysPages - committedPages;
          pagedPoolPages = Math.floor(mem.usedJSHeapSize / PAGE_SIZE / 8);
          nonPagedPoolPages = Math.floor(pagedPoolPages / 2);
        } else {
          const usedHeap = (emu.heapPtr - emu.heapBase) || 0;
          const usedVirtual = (emu.virtualPtr - emu.virtualBase) || 0;
          const totalUsed = usedHeap + usedVirtual;
          totalPhysPages = 65536; // 256 MB
          committedPages = Math.floor(totalUsed / PAGE_SIZE) || 256;
          commitLimit = totalPhysPages * 2;
          availablePages = totalPhysPages - Math.floor(totalUsed / PAGE_SIZE);
          pagedPoolPages = Math.floor(committedPages / 8) || 1024;
          nonPagedPoolPages = Math.floor(pagedPoolPages / 2) || 512;
        }
        // Offsets from SYSTEM_PERFORMANCE_INFORMATION:
        emu.memory.writeU32(bufPtr + 0x2C, availablePages);    // AvailablePages
        emu.memory.writeU32(bufPtr + 0x30, committedPages);    // CommittedPages
        emu.memory.writeU32(bufPtr + 0x34, commitLimit);       // CommitLimit
        emu.memory.writeU32(bufPtr + 0x48, totalPhysPages);    // TotalSystemCodePages
        emu.memory.writeU32(bufPtr + 0x60, pagedPoolPages);    // PagedPoolPages
        emu.memory.writeU32(bufPtr + 0x64, nonPagedPoolPages); // NonPagedPoolPages
      }
      return 0;
    }

    if (infoClass === 21) { // SystemFileCacheInformation (36 bytes)
      const size = 36;
      if (retLenPtr) emu.memory.writeU32(retLenPtr, size);
      if (bufLen >= size) {
        for (let i = 0; i < size; i += 4) emu.memory.writeU32(bufPtr + i, 0);
      }
      return 0;
    }

    if (infoClass === 0) { // SystemBasicInformation (44 bytes)
      if (retLenPtr) emu.memory.writeU32(retLenPtr, 44);
      if (bufLen >= 44) {
        for (let i = 0; i < 44; i += 4) emu.memory.writeU32(bufPtr + i, 0);
        const perf0: Performance & { memory?: { jsHeapSizeLimit: number } } = globalThis.performance;
        const mem0 = perf0.memory;
        const physPages = mem0?.jsHeapSizeLimit ? Math.floor(mem0.jsHeapSizeLimit / 4096) : 65536;
        emu.memory.writeU32(bufPtr + 0, 0);           // Reserved
        emu.memory.writeU32(bufPtr + 4, 4096);         // TimerResolution
        emu.memory.writeU32(bufPtr + 8, 4096);         // PageSize
        emu.memory.writeU32(bufPtr + 12, physPages);    // NumberOfPhysicalPages
        emu.memory.writeU32(bufPtr + 16, 1);            // LowestPhysicalPageNumber
        emu.memory.writeU32(bufPtr + 20, 0x3FFFF);      // HighestPhysicalPageNumber
        emu.memory.writeU32(bufPtr + 24, 4096);         // AllocationGranularity
        emu.memory.writeU32(bufPtr + 28, 0x10000);      // MinimumUserModeAddress
        emu.memory.writeU32(bufPtr + 32, 0x7FFEFFFF);   // MaximumUserModeAddress
        emu.memory.writeU32(bufPtr + 36, 1);            // ActiveProcessorsAffinityMask
        emu.memory.writeU8(bufPtr + 40, 1);             // NumberOfProcessors
      }
      return 0;
    }

    // Default: return STATUS_NOT_IMPLEMENTED
    if (retLenPtr) emu.memory.writeU32(retLenPtr, 0);
    return 0xC0000001;
  });

  // _chkstk: stack probe — EAX = bytes to allocate on stack
  // Probes pages and adjusts ESP; special calling convention
  ntdll.register('_chkstk', 0, () => {
    const allocSize = emu.cpu.reg[0] >>> 0; // EAX = number of bytes
    const retAddr = emu.memory.readU32(emu.cpu.reg[4] >>> 0);
    // Pop return address, subtract allocSize from ESP, then push return address back
    emu.cpu.reg[4] = (emu.cpu.reg[4] + 4) | 0; // pop retAddr
    emu.cpu.reg[4] = (emu.cpu.reg[4] - allocSize) | 0; // allocate stack space
    emu.cpu.eip = retAddr;
    return undefined;
  });

  // NTDLL CRT helpers
  ntdll.register('_wcsicmp', 0, () => {
    const s1 = emu.readArg(0);
    const s2 = emu.readArg(1);
    const str1 = emu.memory.readUTF16String(s1).toLowerCase();
    const str2 = emu.memory.readUTF16String(s2).toLowerCase();
    return str1 < str2 ? -1 : str1 > str2 ? 1 : 0;
  });
  ntdll.register('strrchr', 0, () => {
    const sPtr = emu.readArg(0);
    const ch = emu.readArg(1) & 0xFF;
    const str = emu.memory.readCString(sPtr);
    const idx = str.lastIndexOf(String.fromCharCode(ch));
    return idx >= 0 ? sPtr + idx : 0;
  });
  // _allmul: 64-bit multiply EDX:EAX = arg1(64) * arg2(64) — stdcall, 4 DWORDs (ret 16)
  ntdll.register('_allmul', 4, () => {
    const a_lo = emu.readArg(0);
    const a_hi = emu.readArg(1) | 0;
    const b_lo = emu.readArg(2);
    const b_hi = emu.readArg(3) | 0;
    const a = BigInt(a_hi) * 0x100000000n + BigInt(a_lo >>> 0);
    const b = BigInt(b_hi) * 0x100000000n + BigInt(b_lo >>> 0);
    const r = a * b;
    emu.cpu.reg[0] = Number(r & 0xFFFFFFFFn); // EAX = low
    emu.cpu.reg[2] = Number((r >> 32n) & 0xFFFFFFFFn); // EDX = high
    return emu.cpu.reg[0];
  });
  // _alldiv: 64-bit signed divide EDX:EAX = arg1(64) / arg2(64) — stdcall (ret 16)
  ntdll.register('_alldiv', 4, () => {
    const a_lo = emu.readArg(0);
    const a_hi = emu.readArg(1) | 0;
    const b_lo = emu.readArg(2);
    const b_hi = emu.readArg(3) | 0;
    const a = (BigInt(a_hi) << 32n) | BigInt(a_lo >>> 0);
    const b = (BigInt(b_hi) << 32n) | BigInt(b_lo >>> 0);
    const r = b !== 0n ? a / b : 0n;
    emu.cpu.reg[0] = Number(r & 0xFFFFFFFFn);
    emu.cpu.reg[2] = Number((r >> 32n) & 0xFFFFFFFFn);
    return emu.cpu.reg[0];
  });

  // RtlLargeIntegerToChar: convert 64-bit integer to ANSI string
  // NTSTATUS RtlLargeIntegerToChar(PLARGE_INTEGER Value, ULONG Base, ULONG StringLength, PCHAR String)
  ntdll.register('RtlLargeIntegerToChar', 4, () => {
    const valuePtr = emu.readArg(0);
    const base = emu.readArg(1) || 10;
    const strLen = emu.readArg(2);
    const strPtr = emu.readArg(3);
    const lo = emu.memory.readU32(valuePtr) >>> 0;
    const hi = emu.memory.readU32(valuePtr + 4) >>> 0;
    const val = BigInt(hi) * 0x100000000n + BigInt(lo);
    const str = val.toString(base);
    if (str.length + 1 > strLen) return 0xC0000023; // STATUS_BUFFER_OVERFLOW
    for (let i = 0; i < str.length; i++) emu.memory.writeU8(strPtr + i, str.charCodeAt(i));
    emu.memory.writeU8(strPtr + str.length, 0);
    return 0; // STATUS_SUCCESS
  });

  // RtlInitUnicodeString: init UNICODE_STRING from LPCWSTR
  // void RtlInitUnicodeString(PUNICODE_STRING DestinationString, PCWSTR SourceString)
  ntdll.register('RtlInitUnicodeString', 2, () => {
    const dest = emu.readArg(0);
    const src = emu.readArg(1);
    if (!src) {
      emu.memory.writeU16(dest, 0);     // Length
      emu.memory.writeU16(dest + 2, 0); // MaximumLength
      emu.memory.writeU32(dest + 4, 0); // Buffer
    } else {
      const str = emu.memory.readUTF16String(src);
      const byteLen = str.length * 2;
      emu.memory.writeU16(dest, byteLen);         // Length (bytes, no null)
      emu.memory.writeU16(dest + 2, byteLen + 2); // MaximumLength
      emu.memory.writeU32(dest + 4, src);          // Buffer
    }
    return 0;
  });

  // RtlAnsiStringToUnicodeString: convert ANSI_STRING to UNICODE_STRING
  // NTSTATUS RtlAnsiStringToUnicodeString(PUNICODE_STRING Dest, PCANSI_STRING Src, BOOLEAN AllocateDestinationString)
  ntdll.register('RtlAnsiStringToUnicodeString', 3, () => {
    const destPtr = emu.readArg(0);
    const srcPtr = emu.readArg(1);
    const allocDest = emu.readArg(2) & 0xFF;
    const srcLen = emu.memory.readU16(srcPtr);       // Length in bytes
    const srcBuf = emu.memory.readU32(srcPtr + 4);   // Buffer pointer
    // Read ANSI string
    let str = '';
    for (let i = 0; i < srcLen; i++) {
      const ch = emu.memory.readU8(srcBuf + i);
      if (ch === 0) break;
      str += String.fromCharCode(ch);
    }
    const uniByteLen = str.length * 2;
    let uniBuf: number;
    if (allocDest) {
      uniBuf = emu.allocHeap(uniByteLen + 2);
    } else {
      uniBuf = emu.memory.readU32(destPtr + 4);
    }
    for (let i = 0; i < str.length; i++) emu.memory.writeU16(uniBuf + i * 2, str.charCodeAt(i));
    emu.memory.writeU16(uniBuf + uniByteLen, 0);
    emu.memory.writeU16(destPtr, uniByteLen);          // Length
    emu.memory.writeU16(destPtr + 2, uniByteLen + 2);  // MaximumLength
    emu.memory.writeU32(destPtr + 4, uniBuf);           // Buffer
    return 0; // STATUS_SUCCESS
  });

  // RtlUnicodeStringToInteger: convert UNICODE_STRING to ULONG
  // NTSTATUS RtlUnicodeStringToInteger(PCUNICODE_STRING String, ULONG Base, PULONG Value)
  ntdll.register('RtlUnicodeStringToInteger', 3, () => {
    const strPtr = emu.readArg(0);
    const base = emu.readArg(1) || 10;
    const valuePtr = emu.readArg(2);
    const len = emu.memory.readU16(strPtr);       // Length in bytes
    const buf = emu.memory.readU32(strPtr + 4);   // Buffer pointer
    let str = '';
    for (let i = 0; i < len; i += 2) {
      const ch = emu.memory.readU16(buf + i);
      if (ch === 0) break;
      str += String.fromCharCode(ch);
    }
    str = str.trim();
    const val = parseInt(str, base) || 0;
    emu.memory.writeU32(valuePtr, val >>> 0);
    return 0; // STATUS_SUCCESS
  });

  // RtlFreeUnicodeString: free a UNICODE_STRING allocated by Rtl* functions
  ntdll.register('RtlFreeUnicodeString', 1, () => {
    // We don't track heap frees precisely, just zero the struct
    const strPtr = emu.readArg(0);
    emu.memory.writeU16(strPtr, 0);
    emu.memory.writeU16(strPtr + 2, 0);
    emu.memory.writeU32(strPtr + 4, 0);
    return 0;
  });

  // NTDLL CRT memory ops
  ntdll.register('memmove', 0, () => {
    const dst = emu.readArg(0);
    const src = emu.readArg(1);
    const len = emu.readArg(2);
    if (len > 0 && dst !== src) {
      const tmp = new Uint8Array(len);
      for (let i = 0; i < len; i++) tmp[i] = emu.memory.readU8(src + i);
      for (let i = 0; i < len; i++) emu.memory.writeU8(dst + i, tmp[i]);
    }
    return dst;
  });

  ntdll.register('isspace', 0, () => {
    const ch = emu.readArg(0);
    // space, tab, newline, vertical tab, form feed, carriage return
    return (ch === 0x20 || (ch >= 0x09 && ch <= 0x0D)) ? 1 : 0;
  });

  // RtlOemToUnicodeN(UnicodeString, MaxBytesInUnicodeString, BytesInUnicodeString, OemString, BytesInOemString)
  ntdll.register('RtlOemToUnicodeN', 5, () => {
    const uniPtr = emu.readArg(0);
    const maxBytes = emu.readArg(1);
    const bytesOutPtr = emu.readArg(2);
    const oemPtr = emu.readArg(3);
    const oemLen = emu.readArg(4);
    // Simple ASCII→UTF-16 conversion
    const outLen = Math.min(oemLen * 2, maxBytes);
    for (let i = 0; i < oemLen && i * 2 + 1 < maxBytes; i++) {
      emu.memory.writeU16(uniPtr + i * 2, emu.memory.readU8(oemPtr + i));
    }
    if (bytesOutPtr) emu.memory.writeU32(bytesOutPtr, outLen);
    return 0; // STATUS_SUCCESS
  });

  // RtlMultiByteToUnicodeN(UnicodeString, MaxBytesInUnicodeString, BytesInUnicodeString, MultiByteString, BytesInMultiByteString)
  ntdll.register('RtlMultiByteToUnicodeN', 5, () => {
    const uniPtr = emu.readArg(0);
    const maxBytes = emu.readArg(1);
    const bytesOutPtr = emu.readArg(2);
    const mbPtr = emu.readArg(3);
    const mbLen = emu.readArg(4);
    const maxChars = maxBytes >>> 1;
    const count = Math.min(mbLen, maxChars);
    for (let i = 0; i < count; i++) {
      emu.memory.writeU16(uniPtr + i * 2, emu.memory.readU8(mbPtr + i));
    }
    if (bytesOutPtr) emu.memory.writeU32(bytesOutPtr, count * 2);
    return 0; // STATUS_SUCCESS
  });

  // NTDLL heap APIs — same semantics as HeapAlloc/HeapFree/HeapReAlloc/HeapSize
  ntdll.register('RtlAllocateHeap', 3, () => {
    const _hHeap = emu.readArg(0);
    const flags = emu.readArg(1);
    const size = emu.readArg(2);
    const HEAP_ZERO_MEMORY = 0x00000008;
    const ptr = emu.allocHeap(size);
    if (ptr && (flags & HEAP_ZERO_MEMORY)) {
      for (let i = 0; i < size; i++) emu.memory.writeU8(ptr + i, 0);
    }
    return ptr;
  });
  ntdll.register('RtlFreeHeap', 3, () => 1);
  ntdll.register('RtlReAllocateHeap', 4, () => {
    const _hHeap = emu.readArg(0);
    const _flags = emu.readArg(1);
    const ptr = emu.readArg(2);
    const size = emu.readArg(3);
    return emu.reallocHeap(ptr, size);
  });
  ntdll.register('RtlSizeHeap', 3, () => {
    const _hHeap = emu.readArg(0);
    const _flags = emu.readArg(1);
    const ptr = emu.readArg(2);
    return emu.heapSize(ptr);
  });

  ntdll.register('NtClose', 1, () => 0); // STATUS_SUCCESS
  ntdll.register('NtOpenThread', 4, () => {
    // Write a pseudo-handle to the out-pointer
    const handlePtr = emu.readArg(0);
    if (handlePtr) emu.memory.writeU32(handlePtr, emu.handles.alloc('thread', {}));
    return 0;
  });
  ntdll.register('RtlTimeToElapsedTimeFields', 2, () => {
    const outPtr = emu.readArg(1);
    if (outPtr) {
      // TIME_FIELDS: 8 USHORTs = 16 bytes, write zeroes
      for (let i = 0; i < 16; i += 2) emu.memory.writeU16(outPtr + i, 0);
    }
    return 0;
  });

  // NtOpenProcessToken(ProcessHandle, DesiredAccess, TokenHandle) → NTSTATUS
  ntdll.register('NtOpenProcessToken', 3, () => {
    const tokenPtr = emu.readArg(2);
    if (tokenPtr) emu.memory.writeU32(tokenPtr, 0x3000); // pseudo token handle
    return 0; // STATUS_SUCCESS
  });

  // RtlAllocateAndInitializeSid(IdentifierAuthority, SubAuthorityCount, ..., Sid) → NTSTATUS
  ntdll.register('RtlAllocateAndInitializeSid', 11, () => {
    const sidPtr = emu.readArg(10);
    if (sidPtr) {
      const fakeSid = emu.allocHeap(28);
      emu.memory.writeU32(fakeSid, 0x01010000);
      emu.memory.writeU32(sidPtr, fakeSid);
    }
    return 0; // STATUS_SUCCESS
  });

  // NtQueryInformationToken(TokenHandle, TokenInformationClass, TokenInformation, TokenInformationLength, ReturnLength) → NTSTATUS
  ntdll.register('NtQueryInformationToken', 5, () => {
    const retLenPtr = emu.readArg(4);
    if (retLenPtr) emu.memory.writeU32(retLenPtr, 0);
    return 0xC0000001; // STATUS_UNSUCCESSFUL — caller handles gracefully
  });

  // RtlFreeSid(Sid) → PVOID (NULL on success)
  ntdll.register('RtlFreeSid', 1, () => 0);

  // RtlEqualSid(Sid1, Sid2) → BOOLEAN
  ntdll.register('RtlEqualSid', 2, () => 0); // not equal

  // RtlUnwind(TargetFrame, TargetIp, ExceptionRecord, ReturnValue) → void
  ntdll.register('RtlUnwind', 4, () => 0);

  // NtQueryInformationProcess(ProcessHandle, ProcessInformationClass, ProcessInformation, ProcessInformationLength, ReturnLength) → NTSTATUS
  const STATUS_SUCCESS = 0;
  const STATUS_INFO_LENGTH_MISMATCH = 0xC0000004;
  const ProcessBasicInformation = 0;
  const ProcessDebugPort = 7;
  const ProcessWow64Information = 26;
  const ProcessDebugObjectHandle = 30;
  const ProcessDebugFlags = 31;
  ntdll.register('NtQueryInformationProcess', 5, () => {
    const hProcess = emu.readArg(0);
    const infoClass = emu.readArg(1);
    const infoBuf = emu.readArg(2);
    const infoLen = emu.readArg(3);
    const retLenPtr = emu.readArg(4);
    console.log(`[NTDLL] NtQueryInformationProcess handle=0x${hProcess.toString(16)} class=${infoClass} buf=0x${infoBuf.toString(16)} len=${infoLen}`);
    switch (infoClass) {
      case ProcessBasicInformation: {
        // PROCESS_BASIC_INFORMATION: 24 bytes
        // { ExitStatus, PebBaseAddress, AffinityMask, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId }
        const size = 24;
        if (infoLen < size) return STATUS_INFO_LENGTH_MISMATCH;
        const teb = emu.cpu.fsBase;
        const peb = emu.memory.readU32(teb + 0x30);
        emu.memory.writeU32(infoBuf + 0, 0);       // ExitStatus = STATUS_PENDING
        emu.memory.writeU32(infoBuf + 4, peb);      // PebBaseAddress
        emu.memory.writeU32(infoBuf + 8, 1);        // AffinityMask
        emu.memory.writeU32(infoBuf + 12, 8);       // BasePriority (NORMAL)
        emu.memory.writeU32(infoBuf + 16, 1234);    // UniqueProcessId (matches GetCurrentProcessId)
        emu.memory.writeU32(infoBuf + 20, 0);       // InheritedFromUniqueProcessId
        if (retLenPtr) emu.memory.writeU32(retLenPtr, size);
        return STATUS_SUCCESS;
      }
      case 1: { // ProcessQuotaLimits → QUOTA_LIMITS (28 bytes on 32-bit)
        // { PagedPoolLimit, NonPagedPoolLimit, MinimumWorkingSetSize, MaximumWorkingSetSize, PagefileLimit, TimeLimit(i64) }
        const size = 28;
        if (infoLen < size) return STATUS_INFO_LENGTH_MISMATCH;
        emu.memory.writeU32(infoBuf + 0, 0x20000000);   // PagedPoolLimit (512 MB)
        emu.memory.writeU32(infoBuf + 4, 0x01000000);   // NonPagedPoolLimit (16 MB)
        emu.memory.writeU32(infoBuf + 8, 0x00032000);   // MinimumWorkingSetSize (200 KB)
        emu.memory.writeU32(infoBuf + 12, 0x08000000);  // MaximumWorkingSetSize (128 MB)
        emu.memory.writeU32(infoBuf + 16, 0x20000000);  // PagefileLimit (512 MB)
        emu.memory.writeU32(infoBuf + 20, 0);            // TimeLimit low (no limit)
        emu.memory.writeU32(infoBuf + 24, 0);            // TimeLimit high
        if (retLenPtr) emu.memory.writeU32(retLenPtr, size);
        return STATUS_SUCCESS;
      }
      case ProcessDebugPort: {
        // Returns DWORD_PTR: 0 = not being debugged
        if (infoLen < 4) return STATUS_INFO_LENGTH_MISMATCH;
        emu.memory.writeU32(infoBuf, 0);
        if (retLenPtr) emu.memory.writeU32(retLenPtr, 4);
        return STATUS_SUCCESS;
      }
      case ProcessWow64Information: {
        // Returns ULONG_PTR: 0 = not WoW64
        if (infoLen < 4) return STATUS_INFO_LENGTH_MISMATCH;
        emu.memory.writeU32(infoBuf, 0);
        if (retLenPtr) emu.memory.writeU32(retLenPtr, 4);
        return STATUS_SUCCESS;
      }
      case ProcessDebugObjectHandle: {
        // Not being debugged — return STATUS_PORT_NOT_SET
        return 0xC0000353;
      }
      case ProcessDebugFlags: {
        // Returns ULONG: 1 = no debugger
        if (infoLen < 4) return STATUS_INFO_LENGTH_MISMATCH;
        emu.memory.writeU32(infoBuf, 1);
        if (retLenPtr) emu.memory.writeU32(retLenPtr, 4);
        return STATUS_SUCCESS;
      }
      default:
        console.warn(`[NTDLL] NtQueryInformationProcess: unhandled class ${infoClass}`);
        return STATUS_SUCCESS;
    }
  });

  // NtSetInformationProcess(ProcessHandle, ProcessInformationClass, ProcessInformation, ProcessInformationLength) → NTSTATUS
  ntdll.register('NtSetInformationProcess', 4, () => {
    const hProcess = emu.readArg(0);
    const infoClass = emu.readArg(1);
    console.log(`[NTDLL] NtSetInformationProcess handle=0x${hProcess.toString(16)} class=${infoClass}`);
    return STATUS_SUCCESS;
  });
}
