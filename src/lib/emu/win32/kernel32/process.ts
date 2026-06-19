import type { Emulator } from '../../emulator';
import { initThreadTEB } from '../../emu-thunks-pe';

const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;

/** Build EXCEPTION_RECORD + CONTEXT and dispatch to the SEH handler chain.
 *  The caller must already have popped its own thunk frame off the stack;
 *  retAddr is the address the raising call would have returned to. */
export function raiseSehException(
  emu: Emulator, excCode: number, excFlags: number, params: number[], retAddr: number,
): undefined {
  // Build EXCEPTION_RECORD on heap (80 bytes = 0x50)
  const excRec = emu.allocHeap(0x50);
  emu.memory.writeU32(excRec + 0x00, excCode);       // ExceptionCode
  emu.memory.writeU32(excRec + 0x04, excFlags);       // ExceptionFlags
  emu.memory.writeU32(excRec + 0x08, 0);              // ExceptionRecord (chained, NULL)
  emu.memory.writeU32(excRec + 0x0C, retAddr);        // ExceptionAddress
  const numParams = Math.min(params.length, 15);
  emu.memory.writeU32(excRec + 0x10, numParams);      // NumberParameters
  for (let i = 0; i < numParams; i++) {
    emu.memory.writeU32(excRec + 0x14 + i * 4, params[i]);
  }

  // Build CONTEXT on heap (0x2CC bytes)
  const ctx = emu.allocHeap(0x2CC);
  emu.memory.writeU32(ctx + 0x00, 0x10007);           // ContextFlags = CONTEXT_FULL
  // Segment registers
  emu.memory.writeU32(ctx + 0x8C, 0);                 // SegGs
  emu.memory.writeU32(ctx + 0x90, 0x3B);              // SegFs
  emu.memory.writeU32(ctx + 0x94, 0x23);              // SegEs
  emu.memory.writeU32(ctx + 0x98, 0x23);              // SegDs
  // Integer registers
  emu.memory.writeU32(ctx + 0x9C, (emu.cpu.reg[7] >>> 0)); // EDI
  emu.memory.writeU32(ctx + 0xA0, (emu.cpu.reg[6] >>> 0)); // ESI
  emu.memory.writeU32(ctx + 0xA4, (emu.cpu.reg[3] >>> 0)); // EBX
  emu.memory.writeU32(ctx + 0xA8, (emu.cpu.reg[2] >>> 0)); // EDX
  emu.memory.writeU32(ctx + 0xAC, (emu.cpu.reg[1] >>> 0)); // ECX
  emu.memory.writeU32(ctx + 0xB0, (emu.cpu.reg[0] >>> 0)); // EAX
  // Control registers
  emu.memory.writeU32(ctx + 0xB4, (emu.cpu.reg[5] >>> 0)); // EBP
  emu.memory.writeU32(ctx + 0xB8, retAddr);                 // EIP (caller's address)
  emu.memory.writeU32(ctx + 0xBC, 0x1B);                    // SegCs
  emu.memory.writeU32(ctx + 0xC0, emu.cpu.getFlags());      // EFlags
  emu.memory.writeU32(ctx + 0xC4, (emu.cpu.reg[4] >>> 0));  // ESP (after cleanup)
  emu.memory.writeU32(ctx + 0xC8, 0x23);                    // SegSs

  // Allocate DispatcherContext (just needs to exist, can be zeroed)
  const dispCtx = emu.allocHeap(4);

  // Read SEH chain head from FS:[0]
  const firstReg = emu.memory.readU32((emu.cpu.fsBase + 0) >>> 0);

  if (firstReg === 0xFFFFFFFF || firstReg === 0) {
    console.error(`[SEH] No exception handler installed! ExceptionCode=0x${excCode.toString(16)}`);
    emu.halted = true;
    return undefined;
  }

  // Save SEH dispatch state
  emu._sehState = {
    excRecAddr: excRec,
    ctxAddr: ctx,
    currentReg: firstReg,
    dispCtxAddr: dispCtx,
  };

  // Dispatch to the first handler in the chain
  emu.dispatchToSehHandler(firstReg);
  return undefined;
}

/** Check if an exe buffer is a console (CUI) subsystem app */
function isConsoleExe(data: ArrayBuffer): boolean {
  const view = new DataView(data);
  if (data.byteLength < 64) return false;
  const peOffset = view.getUint32(0x3C, true);
  if (peOffset + 0x5C > data.byteLength) return false;
  if (view.getUint32(peOffset, true) !== 0x00004550) return false;
  const subsystem = view.getUint16(peOffset + 0x5C, true);
  return subsystem === IMAGE_SUBSYSTEM_WINDOWS_CUI;
}

// Strip the first token (program name) from a Windows command line, returning only the arguments
function stripProgramName(cmdLine: string): string {
  const trimmed = cmdLine.trimStart();
  if (!trimmed) return '';
  let rest: string;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    rest = end > 0 ? trimmed.substring(end + 1) : '';
  } else {
    const sp = trimmed.indexOf(' ');
    rest = sp > 0 ? trimmed.substring(sp) : '';
  }
  return rest.trimStart();
}

export function registerProcess(emu: Emulator): void {
  const kernel32 = emu.registerDll('KERNEL32.DLL');

  kernel32.register('ExitProcess', 1, () => {
    emu.exitCode = emu.readArg(0);
    emu.exitedNormally = true;
    emu.halted = true;
    return 0;
  });

  kernel32.register('GetCurrentProcess', 0, () => {
    return 0xFFFFFFFF; // pseudo-handle
  });

  kernel32.register('GetCurrentProcessId', 0, () => {
    return 1234;
  });

  kernel32.register('GetCurrentThreadId', 0, () => {
    return emu.currentThread ? emu.currentThread.id : 1;
  });

  kernel32.register('TerminateProcess', 2, () => {
    const hProcess = emu.readArg(0);
    const uExitCode = emu.readArg(1);

    // Check if this is the current process (pseudo-handle or no valid child)
    const CURRENT_PROCESS_PSEUDO = 0xFFFFFFFF;
    if (hProcess === CURRENT_PROCESS_PSEUDO || hProcess === 0) {
      emu.exitCode = uExitCode;
      emu.exitedNormally = true;
      emu.halted = true;
      return 1;
    }

    // Check if it's a handle to a child process or the current process
    const info = emu.handles.get<{ threadId?: number; name?: string }>(hProcess);
    if (!info) {
      // Unknown handle — treat as current process for safety
      emu.exitCode = uExitCode;
      emu.exitedNormally = true;
      emu.halted = true;
      return 1;
    }

    // It's a child process handle — just close it, don't halt the emulator
    console.log(`[PROCESS] TerminateProcess: child process handle=0x${hProcess.toString(16)} exitCode=${uExitCode}`);
    return 1;
  });

  kernel32.register('TerminateThread', 2, () => 1);

  // RaiseException — dispatch to SEH handler chain via FS:[0]
  kernel32.register('RaiseException', 4, () => {
    const excCode = emu.readArg(0);
    const excFlags = emu.readArg(1);
    const nArgs = emu.readArg(2);
    const lpArgs = emu.readArg(3);

    console.log(`[SEH] RaiseException code=0x${excCode.toString(16)} flags=${excFlags} nArgs=${nArgs} lpArgs=0x${lpArgs.toString(16)}`);

    // Dump exception info for Delphi exceptions
    if (excCode === 0x0EEDFACE && lpArgs) {
      console.log(`[SEH] Delphi exception! ExceptionInformation:`);
      for (let i = 0; i < Math.min(nArgs, 15); i++) {
        const val = emu.memory.readU32((lpArgs + i * 4) >>> 0);
        console.log(`  [${i}] = 0x${val.toString(16)}`);
      }
    }

    // Read the thunk return address (the address RaiseException would return to)
    const retAddr = emu.memory.readU32(emu.cpu.reg[4] >>> 0);

    // Manually clean up the thunk frame: pop retAddr + 4 stdcall args
    emu.cpu.reg[4] = (emu.cpu.reg[4] + 20) | 0;

    const params: number[] = [];
    const numParams = Math.min(nArgs, 15);
    for (let i = 0; i < numParams; i++) {
      params.push(lpArgs ? emu.memory.readU32((lpArgs + i * 4) >>> 0) : 0);
    }
    return raiseSehException(emu, excCode, excFlags, params, retAddr);
  });

  // RtlUnwind — unwind the SEH chain to a target frame
  kernel32.register('RtlUnwind', 4, () => {
    const targetFrame = emu.readArg(0);
    const targetIp = emu.readArg(1);
    const excRecord = emu.readArg(2);
    const returnValue = emu.readArg(3);

    console.log(`[SEH] RtlUnwind targetFrame=0x${targetFrame.toString(16)} targetIp=0x${targetIp.toString(16)} retVal=0x${returnValue.toString(16)}`);

    // Walk the SEH chain from FS:[0] and remove frames until we reach targetFrame
    let current = emu.memory.readU32((emu.cpu.fsBase + 0) >>> 0);
    let unwound = 0;

    while (current !== targetFrame && current !== 0xFFFFFFFF && current !== 0) {
      const prev = emu.memory.readU32(current >>> 0);
      // Skip calling intermediate handlers with EH_UNWINDING for now (simplification)
      current = prev;
      unwound++;
    }

    // Set FS:[0] = targetFrame (unwind to this frame)
    emu.memory.writeU32((emu.cpu.fsBase + 0) >>> 0, current);

    console.log(`[SEH] RtlUnwind: unwound ${unwound} frames, FS:[0] now = 0x${current.toString(16)}`);

    // If there's a pending SEH state and an exception record was provided,
    // set the EXCEPTION_FLAGS to indicate unwind is in progress
    if (excRecord && emu._sehState) {
      const flags = emu.memory.readU32(excRecord + 0x04);
      emu.memory.writeU32(excRecord + 0x04, flags | 0x02); // EH_UNWINDING
    }

    return returnValue;
  });

  kernel32.register('SetUnhandledExceptionFilter', 1, () => 0);
  kernel32.register('UnhandledExceptionFilter', 1, () => 1);
  kernel32.register('IsDebuggerPresent', 0, () => 0);
  kernel32.register('IsProcessorFeaturePresent', 1, () => {
    // PF_* constants from winnt.h
    const PF_FLOATING_POINT_PRECISION_ERRATA  = 0;
    const PF_FLOATING_POINT_EMULATED          = 1;
    const PF_COMPARE_EXCHANGE_DOUBLE          = 2;
    const PF_MMX_INSTRUCTIONS_AVAILABLE       = 3;
    const PF_ALPHA_BYTE_INSTRUCTIONS          = 5;
    const PF_XMMI_INSTRUCTIONS_AVAILABLE      = 6;
    const PF_3DNOW_INSTRUCTIONS_AVAILABLE     = 7;
    const PF_RDTSC_INSTRUCTION_AVAILABLE      = 8;
    const PF_PAE_ENABLED                      = 9;
    const PF_XMMI64_INSTRUCTIONS_AVAILABLE    = 10;
    const PF_SSE_DAZ_MODE_AVAILABLE           = 11;
    const PF_NX_ENABLED                       = 12;
    const PF_SSE3_INSTRUCTIONS_AVAILABLE      = 13;
    const PF_COMPARE_EXCHANGE128              = 14;
    const PF_COMPARE64_EXCHANGE128            = 15;
    const PF_CHANNELS_ENABLED                 = 16;
    const PF_XSAVE_ENABLED                    = 17;
    const PF_ARM_VFP_32_REGISTERS_AVAILABLE   = 18;
    const PF_ARM_NEON_INSTRUCTIONS_AVAILABLE  = 19;
    const PF_SECOND_LEVEL_ADDRESS_TRANSLATION = 20;
    const PF_VIRT_FIRMWARE_ENABLED            = 21;
    const PF_RDWRFSGSBASE_AVAILABLE           = 22;
    const PF_FASTFAIL_AVAILABLE               = 23;
    const PF_ARM_DIVIDE_INSTRUCTION_AVAILABLE = 24;
    const PF_ARM_64BIT_LOADSTORE_ATOMIC       = 25;
    const PF_ARM_EXTERNAL_CACHE_AVAILABLE     = 26;
    const PF_ARM_FMAC_INSTRUCTIONS_AVAILABLE  = 27;
    const PF_RDRAND_INSTRUCTION_AVAILABLE     = 28;
    const PF_ARM_V8_INSTRUCTIONS_AVAILABLE    = 29;
    const PF_ARM_V8_CRYPTO_INSTRUCTIONS_AVAILABLE = 30;
    const PF_ARM_V8_CRC32_INSTRUCTIONS_AVAILABLE  = 31;

    const PF_NAMES: Record<number, string> = {
      0: 'PF_FLOATING_POINT_PRECISION_ERRATA',
      1: 'PF_FLOATING_POINT_EMULATED',
      2: 'PF_COMPARE_EXCHANGE_DOUBLE',
      3: 'PF_MMX_INSTRUCTIONS_AVAILABLE',
      5: 'PF_ALPHA_BYTE_INSTRUCTIONS',
      6: 'PF_XMMI_INSTRUCTIONS_AVAILABLE',
      7: 'PF_3DNOW_INSTRUCTIONS_AVAILABLE',
      8: 'PF_RDTSC_INSTRUCTION_AVAILABLE',
      9: 'PF_PAE_ENABLED',
      10: 'PF_XMMI64_INSTRUCTIONS_AVAILABLE',
      11: 'PF_SSE_DAZ_MODE_AVAILABLE',
      12: 'PF_NX_ENABLED',
      13: 'PF_SSE3_INSTRUCTIONS_AVAILABLE',
      14: 'PF_COMPARE_EXCHANGE128',
      15: 'PF_COMPARE64_EXCHANGE128',
      16: 'PF_CHANNELS_ENABLED',
      17: 'PF_XSAVE_ENABLED',
      23: 'PF_FASTFAIL_AVAILABLE',
      28: 'PF_RDRAND_INSTRUCTION_AVAILABLE',
    };

    const feature = emu.readArg(0);
    const name = PF_NAMES[feature] ?? `PF_UNKNOWN_${feature}`;
    console.log(`[IsProcessorFeaturePresent] ${name} (${feature})`);
    switch (feature) {
      // FPU is emulated (cpu-fpu*.ts), not a precision errata issue
      case PF_FLOATING_POINT_PRECISION_ERRATA:  return 0;
      // FPU is supported via software emulation in cpu-fpu*.ts
      case PF_FLOATING_POINT_EMULATED:          return 1;
      // CMPXCHG8B supported (cpu-exec0f-ext.ts)
      case PF_COMPARE_EXCHANGE_DOUBLE:          return 1;
      // RDTSC supported (cpu-exec0f-ext.ts)
      case PF_RDTSC_INSTRUCTION_AVAILABLE:      return 1;
      // MMX supported (cpu-exec0f.ts)
      case PF_MMX_INSTRUCTIONS_AVAILABLE:       return 1;
      // SSE supported (cpu-exec0f.ts)
      case PF_XMMI_INSTRUCTIONS_AVAILABLE:      return 1;
      // SSE2 supported (cpu-exec0f.ts)
      case PF_XMMI64_INSTRUCTIONS_AVAILABLE:    return 1;
      default:                                   return 0;
    }
  });
  kernel32.register('SetErrorMode', 1, () => 0);
  kernel32.register('GetErrorMode', 0, () => 0);
  const CREATE_SUSPENDED = 0x00000004;
  kernel32.register('CreateThread', 6, () => {
    const _lpThreadAttributes = emu.readArg(0);
    const dwStackSize = emu.readArg(1);
    const lpStartAddress = emu.readArg(2);
    const lpParameter = emu.readArg(3);
    const dwCreationFlags = emu.readArg(4);
    const lpThreadId = emu.readArg(5);

    // Create the thread with its own stack and TEB
    const thread = emu.createThread(lpStartAddress, lpParameter, dwStackSize);

    // Set up TEB for the new thread (reuse PEB from main thread)
    const mainTeb = emu.cpu.fsBase;
    const mainPeb = emu.memory.readU32(mainTeb + 0x30);
    const teb = initThreadTEB(emu, thread.stackTop, thread.id, mainPeb);
    thread.state.fsBase = teb;

    if (dwCreationFlags & CREATE_SUSPENDED) {
      thread.suspended = true;
    }

    if (lpThreadId) emu.memory.writeU32(lpThreadId, thread.id);

    console.log(`[THREAD] CreateThread id=${thread.id} start=0x${lpStartAddress.toString(16)} param=0x${lpParameter.toString(16)} stack=0x${thread.stackTop.toString(16)} suspended=${thread.suspended}`);

    return emu.handles.alloc('thread', { threadId: thread.id });
  });

  // Thread/priority stubs
  kernel32.register('GetCurrentThread', 0, () => 0xFFFFFFFE); // pseudo-handle
  kernel32.register('ExitThread', 1, () => {
    const exitCode = emu.readArg(0);
    if (emu.currentThread) {
      emu.currentThread.exited = true;
      emu.currentThread.exitCode = exitCode;
      const next = emu.getNextRunnableThread();
      if (next) {
        emu.switchToThread(next);
        return undefined; // skip thunk completion — we switched threads
      }
      // Threads blocked in GetMessage/Sleep are still alive — switch to one
      // and idle until its async resume fires.
      const waiter = emu.threads.find(t => !t.exited && t !== emu.currentThread);
      if (waiter) {
        emu.switchToThread(waiter);
        return undefined;
      }
    }
    // Last thread — halt
    emu.exitedNormally = true;
    emu.halted = true;
    return 0;
  });
  kernel32.register('GetPriorityClass', 1, () => 0x20); // NORMAL_PRIORITY_CLASS
  kernel32.register('SetPriorityClass', 2, () => 1);
  kernel32.register('GetThreadPriority', 1, () => 0); // THREAD_PRIORITY_NORMAL
  kernel32.register('SetThreadPriority', 2, () => 1);
  kernel32.register('SetThreadAffinityMask', 2, () => 1); // previous affinity mask
  kernel32.register('ResumeThread', 1, () => {
    const hThread = emu.readArg(0);
    const info = emu.handles.get<{ threadId?: number }>(hThread);
    if (info?.threadId) {
      const thread = emu.threads.find(t => t.id === info.threadId);
      if (thread && thread.suspended) {
        thread.suspended = false;
        return 1; // previous suspend count was 1
      }
    }
    return 0; // previous suspend count
  });
  kernel32.register('SuspendThread', 1, () => {
    const hThread = emu.readArg(0);
    const info = emu.handles.get<{ threadId?: number }>(hThread);
    if (info?.threadId) {
      const thread = emu.threads.find(t => t.id === info.threadId);
      if (thread) {
        thread.suspended = true;
        return 0; // previous suspend count was 0
      }
    }
    return 0;
  });
  kernel32.register('GetProcessAffinityMask', 3, () => {
    const procMaskPtr = emu.readArg(1);
    const sysMaskPtr = emu.readArg(2);
    if (procMaskPtr) emu.memory.writeU32(procMaskPtr, 1);
    if (sysMaskPtr) emu.memory.writeU32(sysMaskPtr, 1);
    return 1;
  });
  kernel32.register('GetProcessVersion', 1, () => {
    const v = emu.windowsVersion;
    return (v.major << 16) | v.minor;
  })
  kernel32.register('OpenProcess', 3, () => {
    const _dwDesiredAccess = emu.readArg(0);
    const _bInheritHandle = emu.readArg(1);
    const dwProcessId = emu.readArg(2);
    return emu.handles.alloc('process', { processId: dwProcessId });
  });
  kernel32.register('SetProcessAffinityMask', 2, () => 1);
  kernel32.register('SetProcessShutdownParameters', 2, () => 1);
  kernel32.register('CreateProcessA', 10, () => {
    const lpApplicationName = emu.readArg(0);
    const lpCommandLine = emu.readArg(1);
    // args 2-7: security attrs, inherit, flags, env, curdir, startupinfo
    const lpProcessInformation = emu.readArg(9);

    let exePath = '';
    let cmdLine = '';
    if (lpApplicationName) {
      exePath = emu.memory.readCString(lpApplicationName);
    }
    if (lpCommandLine) {
      cmdLine = emu.memory.readCString(lpCommandLine);
    }
    if (!exePath && cmdLine) {
      const trimmed = cmdLine.trimStart();
      if (trimmed.startsWith('"')) {
        const end = trimmed.indexOf('"', 1);
        exePath = end > 0 ? trimmed.substring(1, end) : trimmed.substring(1);
      } else {
        const sp = trimmed.indexOf(' ');
        exePath = sp > 0 ? trimmed.substring(0, sp) : trimmed;
      }
    }


    const lastSlash = Math.max(exePath.lastIndexOf('\\'), exePath.lastIndexOf('/'));
    const baseName = lastSlash >= 0 ? exePath.substring(lastSlash + 1) : exePath;

    let lowerBase = baseName.toLowerCase();
    const candidates = [lowerBase];
    if (!lowerBase.includes('.')) candidates.push(lowerBase + '.exe');
    let found = false;
    let matchedName = baseName;
    for (const candidate of candidates) {
      for (const [name] of emu.additionalFiles) {
        const nameLower = name.toLowerCase();
        // Match by exact name or by trailing basename (after / or \)
        const nameBase = nameLower.includes('/') ? nameLower.substring(nameLower.lastIndexOf('/') + 1)
          : nameLower.includes('\\') ? nameLower.substring(nameLower.lastIndexOf('\\') + 1)
          : nameLower;
        if (nameLower === candidate || nameBase === candidate) {
          found = true;
          matchedName = name;
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      console.log(`[CreateProcessA] exe not found: "${exePath}" (baseName="${baseName}")`);
      return 0;
    }

    if (lpProcessInformation) {
      const hProcess = emu.handles.alloc('process', { name: matchedName });
      const hThread = emu.handles.alloc('thread', { name: matchedName });
      emu.memory.writeU32(lpProcessInformation, hProcess);
      emu.memory.writeU32(lpProcessInformation + 4, hThread);
      emu.memory.writeU32(lpProcessInformation + 8, 100);
      emu.memory.writeU32(lpProcessInformation + 12, 101);
    }

    // Pass only the arguments (strip program name) so the child doesn't see the exe name twice
    const childArgs = stripProgramName(cmdLine);
    const childExeData = emu.additionalFiles.get(matchedName);
    if (emu.isConsole && childExeData && isConsoleExe(childExeData) && emu.onCreateChildConsole) {
      const hProcess = lpProcessInformation ? emu.memory.readU32(lpProcessInformation) : 0;
      emu.onCreateChildConsole(matchedName, childArgs, hProcess);
    } else if (emu.onCreateProcess) {
      emu.onCreateProcess(matchedName, childArgs);
    }


    return 1;
  });

  kernel32.register('CreateProcessW', 10, () => {
    const lpApplicationName = emu.readArg(0);
    const lpCommandLine = emu.readArg(1);
    // args 2-7: security attrs, inherit, flags, env, curdir, startupinfo
    const lpProcessInformation = emu.readArg(9);

    // Extract exe name from application name or command line
    let exePath = '';
    let cmdLine = '';
    if (lpApplicationName) {
      exePath = emu.memory.readUTF16String(lpApplicationName);
    }
    if (lpCommandLine) {
      cmdLine = emu.memory.readUTF16String(lpCommandLine);
    }
    if (!exePath && cmdLine) {
      // Extract exe path from command line (first token)
      const trimmed = cmdLine.trimStart();
      if (trimmed.startsWith('"')) {
        const end = trimmed.indexOf('"', 1);
        exePath = end > 0 ? trimmed.substring(1, end) : trimmed.substring(1);
      } else {
        const sp = trimmed.indexOf(' ');
        exePath = sp > 0 ? trimmed.substring(0, sp) : trimmed;
      }
    }

    // Extract base filename
    const lastSlash = Math.max(exePath.lastIndexOf('\\'), exePath.lastIndexOf('/'));
    const baseName = lastSlash >= 0 ? exePath.substring(lastSlash + 1) : exePath;

    // Check if we have this file in additionalFiles (try with .exe if no extension)
    let lowerBase = baseName.toLowerCase();
    const candidates = [lowerBase];
    if (!lowerBase.includes('.')) candidates.push(lowerBase + '.exe');
    let found = false;
    let matchedName = baseName;
    for (const candidate of candidates) {
      for (const [name] of emu.additionalFiles) {
        const nameLower = name.toLowerCase();
        const nameBase = nameLower.includes('/') ? nameLower.substring(nameLower.lastIndexOf('/') + 1)
          : nameLower.includes('\\') ? nameLower.substring(nameLower.lastIndexOf('\\') + 1)
          : nameLower;
        if (nameLower === candidate || nameBase === candidate) {
          found = true;
          matchedName = name;
          break;
        }
      }
      if (found) break;
    }

    // Fill PROCESS_INFORMATION struct (hProcess, hThread, dwProcessId, dwThreadId)
    if (lpProcessInformation) {
      const hProcess = emu.handles.alloc('process', { name: matchedName });
      const hThread = emu.handles.alloc('thread', { name: matchedName });
      emu.memory.writeU32(lpProcessInformation, hProcess);
      emu.memory.writeU32(lpProcessInformation + 4, hThread);
      emu.memory.writeU32(lpProcessInformation + 8, 100); // dwProcessId
      emu.memory.writeU32(lpProcessInformation + 12, 101); // dwThreadId
    }

    if (!found) {
      // Return success anyway - fill process info so the caller doesn't crash
      if (lpProcessInformation) {
        const hProcess = emu.handles.alloc('process', { name: baseName });
        const hThread = emu.handles.alloc('thread', { name: baseName });
        emu.memory.writeU32(lpProcessInformation, hProcess);
        emu.memory.writeU32(lpProcessInformation + 4, hThread);
        emu.memory.writeU32(lpProcessInformation + 8, 100);
        emu.memory.writeU32(lpProcessInformation + 12, 101);
      }
      return 1;
    }

    // Pass only the arguments (strip program name) so the child doesn't see the exe name twice
    const childArgs = stripProgramName(cmdLine);
    const childExeData = emu.additionalFiles.get(matchedName);
    if (emu.isConsole && childExeData && isConsoleExe(childExeData) && emu.onCreateChildConsole) {
      const hProcess = lpProcessInformation ? emu.memory.readU32(lpProcessInformation) : 0;
      emu.onCreateChildConsole(matchedName, childArgs, hProcess);
    } else if (emu.onCreateProcess) {
      emu.onCreateProcess(matchedName, childArgs);
    }

    return 1; // success
  });
  kernel32.register('GetThreadTimes', 5, () => {
    // Write zeroes into the 4 FILETIME out params
    const creationTime = emu.readArg(1);
    const exitTime = emu.readArg(2);
    const kernelTime = emu.readArg(3);
    const userTime = emu.readArg(4);
    for (const ptr of [creationTime, exitTime, kernelTime, userTime]) {
      if (ptr) { emu.memory.writeU32(ptr, 0); emu.memory.writeU32(ptr + 4, 0); }
    }
    return 1;
  });

  // GetProcessTimes(hProcess, lpCreationTime, lpExitTime, lpKernelTime, lpUserTime)
  kernel32.register('GetProcessTimes', 5, () => {
    const creationTime = emu.readArg(1);
    const exitTime = emu.readArg(2);
    const kernelTime = emu.readArg(3);
    const userTime = emu.readArg(4);
    for (const ptr of [creationTime, exitTime, kernelTime, userTime]) {
      if (ptr) { emu.memory.writeU32(ptr, 0); emu.memory.writeU32(ptr + 4, 0); }
    }
    return 1;
  });

  // SetDllDirectoryW(LPCWSTR): return TRUE (success)
  kernel32.register('SetDllDirectoryW', 1, () => 1);

  // SetSearchPathMode(DWORD Flags): return TRUE (success)
  kernel32.register('SetSearchPathMode', 1, () => 1);

  // IsWow64Process(HANDLE, PBOOL): write FALSE to output
  kernel32.register('IsWow64Process', 2, () => {
    const _hProcess = emu.readArg(0);
    const pWow64 = emu.readArg(1);
    if (pWow64) emu.memory.writeU32(pWow64, 0); // not WoW64
    return 1;
  });

  // Wow64DisableWow64FsRedirection / Wow64RevertWow64FsRedirection
  kernel32.register('Wow64DisableWow64FsRedirection', 1, () => 1);
  kernel32.register('Wow64RevertWow64FsRedirection', 1, () => 1);

  // GetLongPathNameW(LPCWSTR lpszShort, LPWSTR lpszLong, DWORD cchBuffer): copy short→long
  kernel32.register('GetLongPathNameW', 3, () => {
    const lpszShort = emu.readArg(0);
    const lpszLong = emu.readArg(1);
    const cchBuffer = emu.readArg(2);
    if (!lpszShort) return 0;
    const str = emu.memory.readUTF16String(lpszShort);
    if (cchBuffer === 0) return str.length + 1;
    if (lpszLong && cchBuffer > 0) {
      emu.memory.writeUTF16String(lpszLong, str.substring(0, cchBuffer - 1));
    }
    return str.length;
  });

  // GetSystemDirectoryW(LPWSTR, UINT): return "C:\\Windows\\system32"
  kernel32.register('GetSystemDirectoryW', 2, () => {
    const lpBuffer = emu.readArg(0);
    const uSize = emu.readArg(1);
    const dir = 'C:\\Windows\\system32';
    if (uSize === 0) return dir.length + 1;
    if (lpBuffer) emu.memory.writeUTF16String(lpBuffer, dir.substring(0, uSize - 1));
    return dir.length;
  });

  // AreFileApisANSI: return TRUE
  kernel32.register('AreFileApisANSI', 0, () => 1);

  // SwitchToThread: return FALSE (no thread switched)
  kernel32.register('SwitchToThread', 0, () => 0);

  // GetTickCount64: return millisecond count as low DWORD (64-bit not possible in 32-bit return)
  kernel32.register('GetTickCount64', 0, () => Date.now() & 0x7FFFFFFF);

  // WaitForSingleObjectEx: same as WaitForSingleObject
  kernel32.register('WaitForSingleObjectEx', 3, () => 0); // WAIT_OBJECT_0

  // FreeLibraryAndExitThread: just return
  kernel32.register('FreeLibraryAndExitThread', 2, () => 0);

  // DisableThreadLibraryCalls: no-op, return TRUE
  kernel32.register('DisableThreadLibraryCalls', 1, () => 1);

  kernel32.register('DuplicateHandle', 7, () => {
    const _hSourceProcessHandle = emu.readArg(0);
    const hSourceHandle = emu.readArg(1);
    const _hTargetProcessHandle = emu.readArg(2);
    const lpTargetHandle = emu.readArg(3);
    const _dwDesiredAccess = emu.readArg(4);
    const _bInheritHandle = emu.readArg(5);
    const _dwOptions = emu.readArg(6);
    if (lpTargetHandle) {
      emu.memory.writeU32(lpTargetHandle, hSourceHandle);
    }
    return 1;
  });

  kernel32.register('OutputDebugStringW', 1, () => {
    const ptr = emu.readArg(0);
    if (ptr) {
      const msg = emu.memory.readUTF16String(ptr);
      console.log('[OutputDebug]', msg);
    }
    return 0;
  });

  // GetThreadContext — stub (2 args)
  kernel32.register('GetThreadContext', 2, () => 0); // fail

  // Comm port stubs
  kernel32.register('ClearCommBreak', 1, () => 1);
  kernel32.register('SetCommBreak', 1, () => 1);
  kernel32.register('PurgeComm', 2, () => 1);
  kernel32.register('SetCommTimeouts', 2, () => 1);
  kernel32.register('SetupComm', 3, () => 1);
  kernel32.register('GetOverlappedResult', 4, () => 0); // fail

  // GetExitCodeThread(hThread, lpExitCode) → BOOL
  kernel32.register('GetExitCodeThread', 2, () => {
    const lpExitCode = emu.readArg(1);
    const STILL_ACTIVE = 259;
    if (lpExitCode) emu.memory.writeU32(lpExitCode, STILL_ACTIVE);
    return 1;
  });

  // FatalAppExitA(uAction, lpMessageText) — terminate the emulated app
  kernel32.register('FatalAppExitA', 2, () => {
    const msgPtr = emu.readArg(1);
    const msg = msgPtr ? emu.memory.readCString(msgPtr) : '';
    console.log(`[FATAL] FatalAppExitA: ${msg}`);
    emu.stopped = true;
    return 0;
  });
}
