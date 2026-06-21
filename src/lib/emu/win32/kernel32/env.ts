import type { Emulator } from '../../emulator';

export function registerEnv(emu: Emulator): void {
  const kernel32 = emu.registerDll('KERNEL32.DLL');

  // Static data area for strings etc.
  let staticDataPtr = 0;
  function allocStaticData(size: number): number {
    if (staticDataPtr === 0) {
      staticDataPtr = emu.allocHeap(0x10000); // Reserve 64KB for static data
    }
    const ptr = staticDataPtr;
    staticDataPtr += (size + 3) & ~3;
    return ptr;
  }

  // Command line (A and W). Built LAZILY on first GetCommandLine call, not at
  // registration: under the ring3 kernel the process's address space isn't active
  // when DLLs are registered, so an eager write would land in the wrong AS (the
  // guest would then read an empty string and, for a screensaver, miss its "/s"
  // run flag and fall into config mode). By first call the guest is running with
  // its own AS active and emu.exeName/commandLine are set.
  // Windows GetCommandLine returns the full command line including the program name.
  let cmdLineAddrA = 0, cmdLineAddrW = 0;
  const cmdLineStr = (): string => {
    const cmdArgs = emu.commandLine || '';
    const exeName = emu.exeName || '';
    return cmdArgs ? `${exeName} ${cmdArgs}` : exeName;
  };

  // Build an ANSI environment block from emu.envVars: KEY=VALUE\0...\0\0
  const buildEnvBlockA = (): number => {
    const entries = [...emu.envVars.entries()].map(([k, v]) => `${k}=${v}`);
    const total = entries.reduce((n, e) => n + e.length + 1, 0) + 1;
    const ptr = allocStaticData(total);
    let off = 0;
    for (const e of entries) {
      emu.memory.writeCString(ptr + off, e);
      off += e.length + 1;
    }
    emu.memory.writeU8(ptr + off, 0); // double null terminator
    return ptr;
  };

  // Build a UTF-16 environment block from emu.envVars
  const buildEnvBlockW = (): number => {
    const entries = [...emu.envVars.entries()].map(([k, v]) => `${k}=${v}`);
    const total = entries.reduce((n, e) => n + e.length + 1, 0) + 1;
    const ptr = allocStaticData(total * 2);
    let off = 0;
    for (const e of entries) {
      emu.memory.writeUTF16String(ptr + off * 2, e);
      off += e.length + 1;
    }
    emu.memory.writeU16(ptr + off * 2, 0); // double null terminator
    return ptr;
  };

  kernel32.register('GetEnvironmentStringsW', 0, () => buildEnvBlockW());
  kernel32.register('FreeEnvironmentStringsW', 1, () => 1);
  kernel32.register('GetEnvironmentStringsA', 0, () => buildEnvBlockA());
  kernel32.register('FreeEnvironmentStringsA', 1, () => 1);
  kernel32.register('GetEnvironmentStrings', 0, () => buildEnvBlockA());

  kernel32.register('GetCommandLineA', 0, () => {
    if (!cmdLineAddrA) { const s = cmdLineStr(); cmdLineAddrA = allocStaticData(s.length + 1); emu.memory.writeCString(cmdLineAddrA, s); }
    return cmdLineAddrA;
  });
  kernel32.register('GetCommandLineW', 0, () => {
    if (!cmdLineAddrW) { const s = cmdLineStr(); cmdLineAddrW = allocStaticData((s.length + 1) * 2); emu.memory.writeUTF16String(cmdLineAddrW, s); }
    return cmdLineAddrW;
  });

  kernel32.register('GetStartupInfoA', 1, () => {
    const ptr = emu.readArg(0);
    // STARTUPINFOA is 68 bytes; fill with zeros
    for (let i = 0; i < 68; i++) emu.memory.writeU8(ptr + i, 0);
    emu.memory.writeU32(ptr, 68); // cb = sizeof(STARTUPINFOA)
    return 0; // void
  });

  const lookupEnv = (name: string): string | undefined => {
    const key = name.toUpperCase();
    if (/^=[A-Z]:$/.test(key)) {
      const drive = key[1];
      return emu.currentDirs.get(drive) ?? (drive + ':\\');
    }
    return emu.envVars.get(key);
  };

  const setEnv = (name: string, value: string | null): void => {
    const key = name.toUpperCase();
    if (/^=[A-Z]:$/.test(key)) {
      const drive = key[1];
      if (value !== null) emu.currentDirs.set(drive, value);
      else emu.currentDirs.delete(drive);
    } else {
      if (value !== null) emu.envVars.set(key, value);
      else emu.envVars.delete(key);
    }
  };

  const expandEnvStr = (src: string): string =>
    src.replace(/%([^%]+)%/g, (_, name) => lookupEnv(name) ?? `%${name}%`);

  kernel32.register('GetEnvironmentVariableA', 3, () => {
    const namePtr = emu.readArg(0);
    const bufPtr = emu.readArg(1);
    const bufSize = emu.readArg(2);
    if (!namePtr) return 0;
    const value = lookupEnv(emu.memory.readCString(namePtr));
    if (value === undefined) return 0;
    if (bufPtr && bufSize > value.length) emu.memory.writeCString(bufPtr, value);
    return value.length;
  });

  kernel32.register('GetEnvironmentVariableW', 3, () => {
    const namePtr = emu.readArg(0);
    const bufPtr = emu.readArg(1);
    const bufSize = emu.readArg(2);
    if (!namePtr) return 0;
    const value = lookupEnv(emu.memory.readUTF16String(namePtr));
    if (value === undefined) return 0;
    if (bufPtr && bufSize > value.length) emu.memory.writeUTF16String(bufPtr, value);
    return value.length;
  });

  kernel32.register('SetEnvironmentVariableA', 2, () => {
    const namePtr = emu.readArg(0);
    const valuePtr = emu.readArg(1);
    if (!namePtr) return 0;
    setEnv(emu.memory.readCString(namePtr), valuePtr ? emu.memory.readCString(valuePtr) : null);
    return 1;
  });

  kernel32.register('SetEnvironmentVariableW', 2, () => {
    const namePtr = emu.readArg(0);
    const valuePtr = emu.readArg(1);
    if (!namePtr) return 0;
    setEnv(emu.memory.readUTF16String(namePtr), valuePtr ? emu.memory.readUTF16String(valuePtr) : null);
    return 1;
  });

  kernel32.register('ExpandEnvironmentStringsA', 3, () => {
    const srcPtr = emu.readArg(0);
    const dstPtr = emu.readArg(1);
    const nSize = emu.readArg(2);
    if (!srcPtr) return 0;
    const result = expandEnvStr(emu.memory.readCString(srcPtr));
    const len = result.length + 1;
    if (dstPtr && nSize >= len) emu.memory.writeCString(dstPtr, result);
    return len;
  });

  kernel32.register('ExpandEnvironmentStringsW', 3, () => {
    const srcPtr = emu.readArg(0);
    const dstPtr = emu.readArg(1);
    const nSize = emu.readArg(2);
    if (!srcPtr) return 0;
    const result = expandEnvStr(emu.memory.readUTF16String(srcPtr));
    const len = result.length + 1;
    if (dstPtr && nSize >= len) emu.memory.writeUTF16String(dstPtr, result);
    return len;
  });

  kernel32.register('GetStartupInfoW', 1, () => {
    const ptr = emu.readArg(0);
    for (let i = 0; i < 68; i++) emu.memory.writeU8(ptr + i, 0);
    emu.memory.writeU32(ptr, 68);
    return 0;
  });
}
