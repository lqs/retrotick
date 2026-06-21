import type { Emulator } from '../../emulator';

export function registerSysinfo(emu: Emulator): void {
  const kernel32 = emu.registerDll('KERNEL32.DLL');

  let lastError = 0;

  kernel32.register('GetVersionExA', 1, () => {
    const ptr = emu.readArg(0);
    const v = emu.windowsVersion;
    emu.memory.writeU32(ptr, 148);      // dwOSVersionInfoSize
    emu.memory.writeU32(ptr + 4, v.major);
    emu.memory.writeU32(ptr + 8, v.minor);
    emu.memory.writeU32(ptr + 12, v.build);
    emu.memory.writeU32(ptr + 16, v.platformId);
    return 1;
  });

  kernel32.register('GetVersionExW', 1, () => {
    const ptr = emu.readArg(0);
    const v = emu.windowsVersion;
    emu.memory.writeU32(ptr, 276);
    emu.memory.writeU32(ptr + 4, v.major);
    emu.memory.writeU32(ptr + 8, v.minor);
    emu.memory.writeU32(ptr + 12, v.build);
    emu.memory.writeU32(ptr + 16, v.platformId);
    return 1;
  });

  kernel32.register('GetVersion', 0, () => {
    const v = emu.windowsVersion;
    return (v.build << 16) | (v.minor << 8) | v.major;
  });

  // VerifyVersionInfoW/A: report that the system meets the requested condition
  // (we present as Windows 5.x; apps check ">= minimum"). Returning 0 (the
  // no-handler default) makes version-gated apps like taskmgr take dead paths.
  kernel32.register('VerifyVersionInfoW', 4, () => 1);
  kernel32.register('VerifyVersionInfoA', 4, () => 1);

  kernel32.register('GetSystemInfo', 1, () => {
    const ptr = emu.readArg(0);
    // SYSTEM_INFO
    for (let i = 0; i < 36; i++) emu.memory.writeU8(ptr + i, 0);
    emu.memory.writeU16(ptr, 0); // wProcessorArchitecture = PROCESSOR_ARCHITECTURE_INTEL
    emu.memory.writeU32(ptr + 4, 4096); // dwPageSize
    emu.memory.writeU32(ptr + 8, 0x10000); // lpMinimumApplicationAddress
    emu.memory.writeU32(ptr + 12, 0x7FFEFFFF); // lpMaximumApplicationAddress
    emu.memory.writeU32(ptr + 20, 1); // dwNumberOfProcessors
    return 0;
  });

  kernel32.register('GetTickCount', 0, () => {
    return (Date.now() & 0xFFFFFFFF) >>> 0;
  });

  kernel32.register('QueryPerformanceCounter', 1, () => {
    const ptr = emu.readArg(0);
    const t = Date.now();
    emu.memory.writeU32(ptr, t & 0xFFFFFFFF);
    emu.memory.writeU32(ptr + 4, 0);
    return 1;
  });

  kernel32.register('QueryPerformanceFrequency', 1, () => {
    const ptr = emu.readArg(0);
    emu.memory.writeU32(ptr, 1000);
    emu.memory.writeU32(ptr + 4, 0);
    return 1;
  });

  kernel32.register('GetSystemTimeAsFileTime', 1, () => {
    const ptr = emu.readArg(0);
    // FILETIME: 100-nanosecond intervals since 1601-01-01
    const epoch = Date.now() * 10000 + 116444736000000000;
    emu.memory.writeU32(ptr, epoch & 0xFFFFFFFF);
    emu.memory.writeU32(ptr + 4, Math.floor(epoch / 0x100000000) & 0xFFFFFFFF);
    return 0;
  });

  kernel32.register('GetLocalTime', 1, () => {
    const ptr = emu.readArg(0);
    const d = new Date();
    emu.memory.writeU16(ptr, d.getFullYear());
    emu.memory.writeU16(ptr + 2, d.getMonth() + 1);
    emu.memory.writeU16(ptr + 4, d.getDay());
    emu.memory.writeU16(ptr + 6, d.getDate());
    emu.memory.writeU16(ptr + 8, d.getHours());
    emu.memory.writeU16(ptr + 10, d.getMinutes());
    emu.memory.writeU16(ptr + 12, d.getSeconds());
    emu.memory.writeU16(ptr + 14, d.getMilliseconds());
    return 0;
  });

  kernel32.register('GetSystemTime', 1, () => {
    const ptr = emu.readArg(0);
    const d = new Date();
    const utc = new Date(d.getTime() + d.getTimezoneOffset() * 60000);
    emu.memory.writeU16(ptr, utc.getFullYear());
    emu.memory.writeU16(ptr + 2, utc.getMonth() + 1);
    emu.memory.writeU16(ptr + 4, utc.getDay());
    emu.memory.writeU16(ptr + 6, utc.getDate());
    emu.memory.writeU16(ptr + 8, utc.getHours());
    emu.memory.writeU16(ptr + 10, utc.getMinutes());
    emu.memory.writeU16(ptr + 12, utc.getSeconds());
    emu.memory.writeU16(ptr + 14, utc.getMilliseconds());
    return 0;
  });

  // GetTimeZoneInformation(lpTimeZoneInformation) — fills TIME_ZONE_INFORMATION (172 bytes)
  kernel32.register('GetTimeZoneInformation', 1, () => {
    const ptr = emu.readArg(0);
    const offsetMin = new Date().getTimezoneOffset();
    // Bias is in minutes, positive = west of UTC
    emu.memory.writeU32(ptr, offsetMin & 0xFFFFFFFF); // LONG Bias
    // StandardName at offset 4 (64 bytes / 32 WCHARs) — leave zeroed
    // StandardDate at offset 68 (SYSTEMTIME, 16 bytes) — leave zeroed
    // StandardBias at offset 84 — 0
    // DaylightName at offset 88 (64 bytes) — leave zeroed
    // DaylightDate at offset 152 (16 bytes) — leave zeroed
    // DaylightBias at offset 168 — 0
    const TIME_ZONE_ID_UNKNOWN = 0;
    return TIME_ZONE_ID_UNKNOWN;
  });

  kernel32.register('IsBadCodePtr', 1, () => 0); // pointer is valid

  kernel32.register('GetComputerNameA', 2, () => {
    const bufPtr = emu.readArg(0);
    const sizePtr = emu.readArg(1);
    const name = 'EMULATOR';
    for (let i = 0; i < name.length; i++) emu.memory.writeU8(bufPtr + i, name.charCodeAt(i));
    emu.memory.writeU8(bufPtr + name.length, 0);
    if (sizePtr) emu.memory.writeU32(sizePtr, name.length);
    return 1;
  });

  kernel32.register('EncodePointer', 1, () => emu.readArg(0));
  kernel32.register('DecodePointer', 1, () => emu.readArg(0));

  // VirtualQueryEx(hProcess, lpAddress, lpBuffer, dwLength) → SIZE_T
  kernel32.register('VirtualQueryEx', 4, () => {
    const lpAddress = emu.readArg(1);
    const lpBuffer = emu.readArg(2);
    const dwLength = emu.readArg(3);
    const MBI_SIZE = 28;
    if (lpBuffer && dwLength >= MBI_SIZE) {
      const pageBase = lpAddress & ~0xFFF;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const k = (emu._v86Runtime as any);
      const q = (k && k.kQuery) ? k.kQuery(pageBase) : { state: 0x1000, protect: 0x04 };
      emu.memory.writeU32(lpBuffer + 0, pageBase);          // BaseAddress
      emu.memory.writeU32(lpBuffer + 4, pageBase);          // AllocationBase
      emu.memory.writeU32(lpBuffer + 8, q.protect || 0x04); // AllocationProtect
      emu.memory.writeU32(lpBuffer + 12, 0x1000);           // RegionSize = 4KB
      emu.memory.writeU32(lpBuffer + 16, q.state);          // State
      emu.memory.writeU32(lpBuffer + 20, q.protect || 0x04);// Protect
      emu.memory.writeU32(lpBuffer + 24, 0x20000);          // Type = MEM_PRIVATE
    }
    return MBI_SIZE;
  });

  kernel32.register('VirtualQuery', 3, () => {
    const lpAddress = emu.readArg(0);
    const lpBuffer = emu.readArg(1);
    const dwLength = emu.readArg(2);
    const MBI_SIZE = 28; // MEMORY_BASIC_INFORMATION
    if (lpBuffer && dwLength >= MBI_SIZE) {
      const pageBase = lpAddress & ~0xFFF;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const k = (emu._v86Runtime as any);
      const q = (k && k.kQuery) ? k.kQuery(pageBase) : { state: 0x1000, protect: 0x04 };
      emu.memory.writeU32(lpBuffer + 0, pageBase);          // BaseAddress
      emu.memory.writeU32(lpBuffer + 4, pageBase);          // AllocationBase
      emu.memory.writeU32(lpBuffer + 8, q.protect || 0x04); // AllocationProtect
      emu.memory.writeU32(lpBuffer + 12, 0x1000);           // RegionSize = 4KB
      emu.memory.writeU32(lpBuffer + 16, q.state);          // State
      emu.memory.writeU32(lpBuffer + 20, q.protect || 0x04);// Protect
      emu.memory.writeU32(lpBuffer + 24, 0x20000);          // Type = MEM_PRIVATE
    }
    return MBI_SIZE;
  });

  kernel32.register('SetThreadLocale', 1, () => 1);
  kernel32.register('SetLocalTime', 1, () => 1);
  kernel32.register('DebugBreak', 0, () => 0);
  kernel32.register('GetBinaryTypeW', 2, () => {
    const lpApplicationName = emu.readArg(0);
    const lpBinaryType = emu.readArg(1);
    if (!lpApplicationName) return 0;
    const name = emu.memory.readUTF16String(lpApplicationName);
    // Extract base filename
    const lastSlash = Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/'));
    const baseName = (lastSlash >= 0 ? name.substring(lastSlash + 1) : name).toLowerCase();
    // Check if it's a known exe in additionalFiles
    for (const [fn] of emu.additionalFiles) {
      if (fn.toLowerCase() === baseName) {
        const SCS_32BIT_BINARY = 0;
        if (lpBinaryType) emu.memory.writeU32(lpBinaryType, SCS_32BIT_BINARY);
        return 1;
      }
    }
    return 0;
  });
  kernel32.register('ReadProcessMemory', 5, () => 0); // fail
  kernel32.register('CmdBatNotification', 1, () => 1);
  kernel32.register('GetVDMCurrentDirectories', 2, () => 0);

  kernel32.register('CompareFileTime', 2, () => {
    const ft1 = emu.readArg(0);
    const ft2 = emu.readArg(1);
    const lo1 = emu.memory.readU32(ft1);
    const hi1 = emu.memory.readU32(ft1 + 4);
    const lo2 = emu.memory.readU32(ft2);
    const hi2 = emu.memory.readU32(ft2 + 4);
    if (hi1 !== hi2) return hi1 < hi2 ? -1 : 1;
    if (lo1 !== lo2) return lo1 < lo2 ? -1 : 1;
    return 0;
  });

  kernel32.register('GetExitCodeProcess', 2, () => {
    const hProcess = emu.readArg(0);
    const lpExitCode = emu.readArg(1);
    const STILL_ACTIVE = 259;
    const proc = emu.handles.get<{ childEmu?: unknown; childExited?: boolean; childExitCode?: number }>(hProcess);
    if (lpExitCode) {
      if (proc && proc.childEmu !== undefined) {
        emu.memory.writeU32(lpExitCode, proc.childExited ? (proc.childExitCode ?? 0) : STILL_ACTIVE);
      } else {
        emu.memory.writeU32(lpExitCode, 0);
      }
    }
    return 1;
  });

  kernel32.register('GetLastError', 0, () => {
    return lastError;
  });

  kernel32.register('SetLastError', 1, () => {
    lastError = emu.readArg(0);
    return 0;
  });
}
