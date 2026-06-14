import type { Emulator } from './emulator';
import type { WindowInfo } from './win32/user32/types';
import { syncVideoMemory, handleDosInt } from './dos/index';
import { syncGraphics } from './dos/vga';
import { dispatchMouseCallback } from './dos/mouse';
import { dispatchException } from './x86/dispatch';
import { tryFastLoop, tryCachedLoop } from './fast-loops';
import { FlatMemory, OFF_ENTRY, OFF_EIP, OFF_EXIT } from './x86/flat-memory';
import { compileWasmRegion, type WasmImports } from './x86/wasm-module';
import { materializeFlags } from './x86/flags';
import { AccessViolationError, PageFaultError } from './memory';

// A special "return from WndProc" thunk address
const WNDPROC_RETURN_THUNK = 0x00FE0000;
const STATUS_ACCESS_VIOLATION = 0xC0000005;

/** Raise an access violation exception via SEH (same mechanism as RaiseException). */
function raiseAccessViolation(emu: Emulator, faultAddr: number): void {
  const eip = emu.cpu.eip >>> 0;
  console.log(`[SEH] Access violation at EIP=0x${eip.toString(16)} writing 0x${faultAddr.toString(16)}`);

  // Build EXCEPTION_RECORD
  const excRec = emu.allocHeap(0x50);
  emu.memory.writeU32(excRec + 0x00, STATUS_ACCESS_VIOLATION);
  emu.memory.writeU32(excRec + 0x04, 0);           // flags: continuable
  emu.memory.writeU32(excRec + 0x08, 0);           // chained record
  emu.memory.writeU32(excRec + 0x0C, eip);         // exception address
  emu.memory.writeU32(excRec + 0x10, 2);           // 2 params
  emu.memory.writeU32(excRec + 0x14, 1);           // param0: 1 = write
  emu.memory.writeU32(excRec + 0x18, faultAddr);   // param1: fault address

  // Build CONTEXT
  const ctx = emu.allocHeap(0x2CC);
  emu.memory.writeU32(ctx + 0x00, 0x10007);
  emu.memory.writeU32(ctx + 0x9C, emu.cpu.reg[7] >>> 0);
  emu.memory.writeU32(ctx + 0xA0, emu.cpu.reg[6] >>> 0);
  emu.memory.writeU32(ctx + 0xA4, emu.cpu.reg[3] >>> 0);
  emu.memory.writeU32(ctx + 0xA8, emu.cpu.reg[2] >>> 0);
  emu.memory.writeU32(ctx + 0xAC, emu.cpu.reg[1] >>> 0);
  emu.memory.writeU32(ctx + 0xB0, emu.cpu.reg[0] >>> 0);
  emu.memory.writeU32(ctx + 0xB4, emu.cpu.reg[5] >>> 0);
  emu.memory.writeU32(ctx + 0xB8, eip);
  emu.memory.writeU32(ctx + 0xBC, 0x1B);
  emu.memory.writeU32(ctx + 0xC0, emu.cpu.getFlags());
  emu.memory.writeU32(ctx + 0xC4, emu.cpu.reg[4] >>> 0);
  emu.memory.writeU32(ctx + 0xC8, 0x23);

  const dispCtx = emu.allocHeap(4);

  // Find SEH chain head
  const firstReg = emu.memory.readU32((emu.cpu.fsBase + 0) >>> 0);
  if (firstReg === 0xFFFFFFFF || firstReg === 0) {
    console.error(`[SEH] No handler for access violation at 0x${eip.toString(16)}`);
    emu.haltReason = `access violation writing 0x${faultAddr.toString(16)}`;
    emu.halted = true;
    return;
  }

  emu._sehState = { excRecAddr: excRec, ctxAddr: ctx, currentReg: firstReg, dispCtxAddr: dispCtx };
  emu.dispatchToSehHandler(firstReg);
}

/** Handle a `PageFaultError` thrown from `cpu.step()`. Rewinds EIP to the
 *  faulting instruction, sets CR2, drops the negative TLB entry so the retry
 *  re-walks, and dispatches INT 0x0E through the client's IDT. The PM `#PF`
 *  handler is responsible for populating the PDE/PTE and IRETing back; the
 *  CPU then re-executes the faulting instruction.
 *  Returns true on success, false when the IDT has no usable entry and the
 *  emulator should halt. */
function handlePageFault(emu: Emulator, e: PageFaultError): boolean {
  const cpu = emu.cpu;
  cpu.eip = cpu._lastInstrEip;
  emu._cr2 = e.vaddr;
  cpu.mem.invalidatePage(e.vaddr);
  // Error code: P=0 (page not present is our only case) + W/R bit + U/S=0 + RSVD=0 + I/D=0
  const errCode = e.isWrite ? 2 : 0;
  if (!dispatchException(cpu, 0x0E, 'exception')) {
    cpu.halted = true;
    cpu.haltReason = `unhandled #PF vaddr=0x${e.vaddr.toString(16)} write=${e.isWrite}`;
    return false;
  }
  // Error-code push can itself PF if the new stack page is unmapped — bail
  // cleanly so we don't re-enter dispatch recursively.
  try {
    if (cpu._lastDispatchIs32) cpu.push32(errCode);
    else cpu.push16(errCode);
  } catch (err) {
    if (err instanceof PageFaultError) {
      cpu.halted = true;
      cpu.haltReason = `unhandled #PF (recursive): vaddr=0x${e.vaddr.toString(16)}`;
      return false;
    }
    throw err;
  }
  return true;
}

// Fast zero-delay scheduler using MessageChannel (avoids setTimeout's 4ms clamping
// after 5 nested calls). Used for DOS fast-path tick scheduling.
let _immedCb: (() => void) | null = null;
const _immedChan = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
if (_immedChan) { _immedChan.port1.onmessage = () => { if (_immedCb) { const cb = _immedCb; _immedCb = null; cb(); } }; }
function scheduleImmediate(fn: () => void): void {
  if (_immedChan) { _immedCb = fn; _immedChan.port2.postMessage(null); }
  else setTimeout(fn, 0);
}

export function emuCompleteThunk(emu: Emulator, retVal: number, stackBytes: number): void {
  emu.cpu.reg[0] = retVal | 0; // EAX
  const retAddr = emu.memory.readU32(emu.cpu.reg[4] >>> 0);
  emu.cpu.reg[4] = (emu.cpu.reg[4] + 4 + stackBytes) | 0; // pop retAddr + args (stdcall)
  emu.cpu.eip = retAddr;
}

export function emuCompleteThunk16(emu: Emulator, retVal: number, stackBytes: number): void {
  // Win16 PASCAL: 16-bit returns in AX, 32-bit returns (DWORD/FARPROC) in DX:AX
  emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000) | (retVal & 0xFFFF); // AX = low word
  emu.cpu.reg[2] = (emu.cpu.reg[2] & 0xFFFF0000) | ((retVal >>> 16) & 0xFFFF); // DX = high word
  // Pop FAR return address (IP, then CS)
  const ip = emu.cpu.pop16();
  const cs = emu.cpu.pop16();
  // Pop PASCAL args
  if (stackBytes > 0) {
    const sp = (emu.cpu.reg[4] & 0xFFFF) + stackBytes;
    emu.cpu.reg[4] = (emu.cpu.reg[4] & ~0xFFFF) | (sp & 0xFFFF);
  }
  emu.cpu.cs = cs;
  emu.cpu.eip = (emu.cpu.segBase(cs)) + ip;
}

export function emuResume(emu: Emulator): void {
  // Legacy: only used for DOS keyboard resume (INT 16h)
  if (!emu.waitingForMessage) return;
  if (emu._dosWaitingForKey) {
    // If dosKeyBuffer has keys, deliver directly
    if (emu.dosKeyBuffer.length > 0) {
      emu.deliverDosKey();
      return;
    }
    // Also check BDA keyboard buffer — keys injected via INT 09h go there
    const BDA = 0x400;
    const head = emu.memory.readU16(BDA + 0x1A);
    const tail = emu.memory.readU16(BDA + 0x1C);
    if (head !== tail) {
      // Copy key from BDA to dosKeyBuffer so deliverDosKey can process it
      const keyWord = emu.memory.readU16(BDA + head);
      const ascii = keyWord & 0xFF;
      const scan = (keyWord >> 8) & 0xFF;
      emu.dosKeyBuffer.push({ ascii, scan });
      // Advance BDA head
      const bufStart = emu.memory.readU16(BDA + 0x80);
      const bufEnd = emu.memory.readU16(BDA + 0x82);
      let newHead = head + 2;
      if (newHead >= bufEnd) newHead = bufStart;
      emu.memory.writeU16(BDA + 0x1A, newHead);
      emu.deliverDosKey();
    }
  }
}

/** Call a stdcall callback with N args. Used by callWndProc (4 args) and multimedia timers (5 args). */
function callStdcall(emu: Emulator, addr: number, args: number[]): number | undefined {
  if (!addr) return 0;
  if (!emu.isNE && emu.pe) {
    const isThunk = emu.thunkToApi.has(addr);
    let inImage = addr >= emu.pe.imageBase && addr < emu.pe.imageBase + emu.pe.sizeOfImage;
    if (!inImage) {
      for (const mod of emu.loadedModules.values()) {
        if (mod.sizeOfImage && addr >= mod.imageBase && addr < mod.imageBase + mod.sizeOfImage) {
          inImage = true;
          break;
        }
      }
    }
    const inVirtualAlloc = addr >= emu.virtualBase && addr < emu.virtualPtr;
    if (!isThunk && !inImage && !inVirtualAlloc) {
      console.error(`[callStdcall] addr 0x${(addr >>> 0).toString(16)} is outside known ranges: image=0x${emu.pe.imageBase.toString(16)}..0x${(emu.pe.imageBase + emu.pe.sizeOfImage).toString(16)}, virtualAlloc=0x${emu.virtualBase.toString(16)}..0x${emu.virtualPtr.toString(16)}, args=[${args.map(a => '0x' + (a >>> 0).toString(16))}]`);
      return 0;
    }
  }
  emu.wndProcDepth++;

  // Save callee-saved registers
  const savedEBX = emu.cpu.reg[3];
  const savedESI = emu.cpu.reg[6];
  const savedEDI = emu.cpu.reg[7];
  const savedEBP = emu.cpu.reg[5];

  // Push args right-to-left (stdcall)
  for (let i = args.length - 1; i >= 0; i--) emu.cpu.push32(args[i]);
  emu.cpu.push32(WNDPROC_RETURN_THUNK);
  const wndProcRetThunkAddr = emu.cpu.reg[4] >>> 0; // remember where the thunk was pushed
  emu.cpu.eip = addr;

  // Run a local step loop until the callback returns or goes async.
  // This reuses the frame stack so that WNDPROC_RETURN in emuTick
  // can also handle completion if we yield to async.
  const frame = {
    savedEBX, savedEBP, savedESI, savedEDI,
    outerStackBytes: 0,
    outerCompleter: emuCompleteThunk,
  };

  const targetDepth = emu.wndProcDepth - 1;
  let steps = 0;
  // Time-based yield so a long-running wndProc (heavy WM_PAINT, OnTimer iterating
  // a canvas, etc.) doesn't lock the JS thread for hundreds of milliseconds.
  // Only safe when the caller knows how to propagate `undefined` and resume the
  // wndProc later — currently DispatchMessageA, which sets emu._allowWndProcYield
  // around its emu.callWndProc call. Init-time handlers like CreateWindowExA need
  // synchronous completion to chain WM_NCCREATE → WM_NCCALCSIZE → WM_CREATE, so
  // yields are off by default.
  const canYield = (targetDepth === 0) && emu._allowWndProcYield;
  const YIELD_MS = 16;
  const startTime = canYield ? performance.now() : 0;
  // Tight loop detection: three consecutive-match samplers at different periods.
  // P=256 catches loops of length 1,2,4,8,16... (powers of 2).
  // P=252 catches loops of length 1,2,3,4,6,7,9,12,14... (highly composite).
  // P=64 catches short-lived loops (100-300 iterations) before the larger periods trigger.
  let csEipA = 0, csHitA = 0;  // period 256
  let csEipB = 0, csHitB = 0, csNextB = 252;  // period 252
  let csEipC = 0, csHitC = 0;  // period 64
  while (emu.wndProcDepth > targetDepth && !emu.halted && !emu.cpu.halted) {
    // Periodic time check — yield to the browser if we've been busy too long
    if (canYield && (steps & 0xFFF) === 0 && steps > 0 && performance.now() - startTime > YIELD_MS) {
      if (!emu._wndProcFrames.includes(frame)) emu._wndProcFrames.push(frame);
      emu._wndProcSetupPending = true;
      return undefined;
    }
    const eip = emu.cpu.eip >>> 0;

    // Fast path: check loop cache every 64 steps
    if ((steps & 0x3F) === 0 && steps > 0) {
      try {
        const ci = tryCachedLoop(emu.cpu, emu.memory);
        if (ci > 0) { steps += ci; csHitA = csHitB = 0; csNextB = steps + 252; continue; }
      } catch (e) {
        if (e instanceof AccessViolationError) { raiseAccessViolation(emu, e.addr); continue; }
        if (e instanceof PageFaultError) { if (!handlePageFault(emu, e)) break; continue; }
        throw e;
      }
    }

    let csTry = false;
    if ((steps & 0xFF) === 0 && steps > 0) {
      if (eip === csEipA) { if (++csHitA >= 2) csTry = true; } else { csEipA = eip; csHitA = 0; }
    }
    if (steps >= csNextB) {
      csNextB = steps + 252;
      if (eip === csEipB) { if (++csHitB >= 2) csTry = true; }
      else {
          csEipB = eip; csHitB = 0;
      }
    }
    if ((steps & 0x3F) === 0 && steps > 0) {
      if (eip === csEipC) { if (++csHitC >= 2) csTry = true; } else { csEipC = eip; csHitC = 0; }
    }
    if (csTry) {
      try {
        const iters = tryFastLoop(emu.cpu, emu.memory);
        if (iters > 0) { steps += iters; emu._pitInsnCount += iters; csHitA = csHitB = csHitC = 0; csNextB = steps + 252; continue; }
      } catch (e) {
        if (e instanceof AccessViolationError) { raiseAccessViolation(emu, e.addr); continue; }
        if (e instanceof PageFaultError) { if (!handlePageFault(emu, e)) break; continue; }
        throw e;
      }
      csHitA = csHitB = csHitC = 0;
    }

    const thunk = emu.thunkPages.has(eip >>> 12) ? emu.thunkToApi.get(eip) : undefined;
    if (thunk) {
      const key = `${thunk.dll}:${thunk.name}`;
      const handler = emu.apiDefs.get(key)?.handler;
      if (handler) {
        if (key === 'SYSTEM:WNDPROC_RETURN') {
          handler(emu);
          break;
        }
        emu._currentThunkStackBytes = thunk.stackBytes;
        const retVal = handler(emu);
        // If a nested callWndProc was set up, execute it within this loop
        if (emu._wndProcSetupPending) {
          emu._wndProcSetupPending = false;
          // The nested call pushed its own frame; fill in its outer thunk info
          const nestedFrame = emu._wndProcFrames[emu._wndProcFrames.length - 1];
          nestedFrame.outerStackBytes = thunk.stackBytes;
          nestedFrame.outerCompleter = emuCompleteThunk;
          // If still waiting (e.g. nested async API like MessageBox), propagate up
          if (emu.waitingForMessage) {
            emu._wndProcFrames.push(frame);
            emu._wndProcSetupPending = true;
            break;
          }
          steps++;
          continue;
        }
        if (retVal === undefined) {
          // Handler returned undefined — either:
          // 1. It handled EIP/ESP itself (e.g. _EH_prolog) — continue executing
          // 2. It set waitingForMessage — break and push frame for async completion
          if (emu.waitingForMessage) {
            emu._wndProcFrames.push(frame);
            emu._wndProcSetupPending = true;
            break;
          }
          // Case 1: handler adjusted EIP/ESP directly, continue execution
          steps++;
          continue;
        }
        if (emu.waitingForMessage || emu.halted) break;
        emuCompleteThunk(emu, retVal as number, thunk.stackBytes);
      } else {
        emu.haltReason = `Unimplemented API: ${key}`;
        emu.halted = true;
        break;
      }
    } else {
      try {
        emu.cpu.step();
      } catch (e) {
        if (e instanceof AccessViolationError) { raiseAccessViolation(emu, e.addr); continue; }
        if (e instanceof PageFaultError) { if (!handlePageFault(emu, e)) break; continue; }
        throw e;
      }
    }
    steps++;
  }

  // If we're waiting (handler set waitingForMessage), push frame for emuTick to complete
  if ((emu.waitingForMessage || emu._wndProcSetupPending) && !emu._wndProcFrames.includes(frame)) {
    emu._wndProcFrames.push(frame);
    emu._wndProcSetupPending = true;
    return undefined;
  }
  if (emu._wndProcSetupPending) {
    return undefined;
  }

  // Zero out the stale WNDPROC_RETURN_THUNK from stack memory to prevent
  // it from being picked up by a later RET instruction when the stack grows
  emu.memory.writeU32(wndProcRetThunkAddr, 0);

  // Synchronous return — restore callee-saved registers
  emu.cpu.reg[3] = savedEBX;
  emu.cpu.reg[5] = savedEBP;
  emu.cpu.reg[6] = savedESI;
  emu.cpu.reg[7] = savedEDI;

  return emu.wndProcResult;
}

export function emuCallWndProc(emu: Emulator, wndProc: number, hwnd: number, message: number, wParam: number, lParam: number): number | undefined {
  return callStdcall(emu, wndProc, [hwnd, message, wParam, lParam]);
}

/** Call any stdcall callback with arbitrary args. Used for COM enumeration callbacks etc. */
export function emuCallCallback(emu: Emulator, addr: number, args: number[]): number | undefined {
  return callStdcall(emu, addr, args);
}

export function emuCallTimerProc(emu: Emulator, callback: number, timerId: number, dwUser: number): number | undefined {
  // void CALLBACK TimeProc(UINT uTimerID, UINT uMsg, DWORD_PTR dwUser, DWORD_PTR dw1, DWORD_PTR dw2)
  return callStdcall(emu, callback, [timerId, 0 /* TIME_CALLBACK */, dwUser, 0, 0]);
}

export function emuCallWndProc16(emu: Emulator, wndProc: number, hwnd: number, message: number, wParam: number, lParam: number): number | undefined {
  if (!wndProc) return 0;

  emu.wndProcDepth++;

  const savedSP = emu.cpu.reg[4] & 0xFFFF;
  const savedDS = emu.cpu.ds;
  const savedCS = emu.cpu.cs;
  const savedEIP = emu.cpu.eip;
  const savedEBX = emu.cpu.reg[3];
  const savedESI = emu.cpu.reg[6];
  const savedEDI = emu.cpu.reg[7];
  const savedEBP = emu.cpu.reg[5];

  // Set DS to the module that owns this wndProc (MakeProcInstance would set this).
  // DLL wndProcs (e.g. COMMCTRL toolbar) need the DLL's DS, not the app's.
  if (emu.isNE && emu.ne) {
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    const classHInst = wnd?.classInfo?.hInstance;
    if (classHInst && emu.neDllDataSegs.has(classHInst)) {
      emu.cpu.ds = classHInst;
    } else {
      emu.cpu.ds = emu.ne.dataSegSelector;
    }
  }

  // Push PASCAL args (left to right): hwnd, message, wParam, lParam
  emu.cpu.push16(hwnd & 0xFFFF);
  emu.cpu.push16(message & 0xFFFF);
  emu.cpu.push16(wParam & 0xFFFF);
  emu.cpu.push32(lParam); // LONG = 4 bytes

  // Push FAR return address (WNDPROC_RETURN thunk)
  const WNDPROC_RETURN_SELECTOR = 0xFE;
  const WNDPROC_RETURN_OFFSET = 0xFF04;
  emu.cpu.push16(WNDPROC_RETURN_SELECTOR);
  emu.cpu.push16(WNDPROC_RETURN_OFFSET);

  // Set CS:IP to wndProc (linear address → SEG:OFFSET lookup)
  let segFound = false;
  if (wndProc > 0xFFFF) {
    for (const [sel, base] of emu.cpu.segBases) {
      if (wndProc >= base && wndProc < base + 0x10000) {
        emu.cpu.cs = sel;
        emu.cpu.eip = wndProc;
        segFound = true;
        break;
      }
    }
  } else {
    emu.cpu.eip = (emu.cpu.segBase(emu.cpu.cs)) + wndProc;
    segFound = true;
  }
  if (!segFound) {
    // No segment contains this address — can't execute, bail out
    console.warn(`[MSG16] callWndProc16: no segment for wndProc=0x${wndProc.toString(16)} msg=0x${message.toString(16)} hwnd=0x${hwnd.toString(16)}`);
    emu.cpu.reg[4] = (emu.cpu.reg[4] & 0xFFFF0000) | (savedSP & 0xFFFF);
    emu.cpu.cs = savedCS;
    emu.cpu.eip = savedEIP;
    emu.cpu.ds = savedDS;
    emu.cpu.reg[3] = savedEBX;
    emu.cpu.reg[5] = savedEBP;
    emu.cpu.reg[6] = savedESI;
    emu.cpu.reg[7] = savedEDI;
    emu.wndProcDepth--;
    return 0;
  }

  const frame = {
    savedEBX, savedEBP, savedESI, savedEDI,
    savedDS, savedSP,
    outerStackBytes: 0,
    outerCompleter: emuCompleteThunk16,
  };

  const targetDepth = emu.wndProcDepth - 1;
  let steps = 0;
  // Only the outermost callWndProc16 may yield to the browser.
  // Nested calls (from thunk handlers like WM_MDICREATE) must run to
  // completion because their JS callers can't handle an undefined return.
  const canYield = targetDepth === 0;
  // Use a lower step limit for nested calls to avoid long UI freezes
  // when a nested WndProc enters an infinite loop.
  const MAX_STEPS = canYield ? 200_000_000 : 50_000_000;
  const YIELD_MS = 40;
  const startTime = performance.now();

  while (emu.wndProcDepth > targetDepth && !emu.halted && !emu.cpu.halted && steps < MAX_STEPS) {
    // Yield to browser periodically so the UI stays responsive
    if (canYield && (steps & 0xFFF) === 0 && steps > 0 && performance.now() - startTime > YIELD_MS) {
      // Push frame so the tick loop continues executing this wndproc
      emu._wndProcFrames.push(frame);
      emu._wndProcSetupPending = true;
      return undefined;
    }

    const eip = emu.cpu.eip >>> 0;
    const thunk = emu.thunkPages.has(eip >>> 12) ? emu.thunkToApi.get(eip) : undefined;
    if (thunk) {
      const key = `${thunk.dll}:${thunk.name}`;
      emu.diagThunk(`[d=${emu.wndProcDepth}] ${key}`);
      const handler = emu.apiDefs.get(key)?.handler;
      if (handler) {
        if (key === 'SYSTEM:WNDPROC_RETURN') {
          handler(emu);
          break;
        }
        emu._currentThunkStackBytes = thunk.stackBytes;
        const retVal = handler(emu);
        // If a nested callWndProc16 was set up, execute it within this loop
        if (emu._wndProcSetupPending) {
          emu._wndProcSetupPending = false;
          const nestedFrame = emu._wndProcFrames[emu._wndProcFrames.length - 1];
          nestedFrame.outerStackBytes = thunk.stackBytes;
          nestedFrame.outerCompleter = emuCompleteThunk16;
          if (emu.waitingForMessage) {
            emu._wndProcFrames.push(frame);
            emu._wndProcSetupPending = true;
            break;
          }
          steps++;
          continue;
        }
        if (retVal === undefined) {
          if (emu.waitingForMessage) {
            emu._wndProcFrames.push(frame);
            emu._wndProcSetupPending = true;
            break;
          }
          // Handler adjusted EIP/ESP directly — continue execution
          steps++;
          continue;
        }
        if (emu.waitingForMessage || emu.halted) break;
        emuCompleteThunk16(emu, retVal as number, thunk.stackBytes);
      } else {
        console.warn(`Unimplemented Win16 API: ${key}`);
        emuCompleteThunk16(emu, 0, thunk.stackBytes);
      }
    } else {
      emu.cpu.step();
    }
    steps++;
  }

  // If waiting, push frame for emuTick to complete
  if ((emu.waitingForMessage || emu._wndProcSetupPending) && !emu._wndProcFrames.includes(frame)) {
    emu._wndProcFrames.push(frame);
    emu._wndProcSetupPending = true;
    return undefined;
  }
  if (emu._wndProcSetupPending) {
    return undefined;
  }

  if (steps >= MAX_STEPS) {
    console.warn(`[MSG16] WndProc exceeded max steps for msg 0x${message.toString(16)} EIP=0x${(emu.cpu.eip >>> 0).toString(16)} CS=${emu.cpu.cs} hwnd=0x${hwnd.toString(16)} wndProc=0x${wndProc.toString(16)} depth=${emu.wndProcDepth}\n  THUNK TRACE:\n${emu.diagThunkDump()}`);
    emu.wndProcDepth = targetDepth;
  }

  // Synchronous return — always restore SP, DS, CS:EIP, and callee-saved registers.
  // SP restoration is critical: even if the WndProc completed normally
  // (RETF cleaned up args), we force SP back to guarantee no leak.
  // CS:EIP restoration prevents the tick loop from seeing a stale WNDPROC_RETURN
  // address and misinterpreting it as a new thunk invocation.
  emu.cpu.reg[4] = (emu.cpu.reg[4] & 0xFFFF0000) | (savedSP & 0xFFFF);
  emu.cpu.cs = savedCS;
  emu.cpu.eip = savedEIP;
  emu.cpu.ds = savedDS;
  emu.cpu.reg[3] = savedEBX;
  emu.cpu.reg[5] = savedEBP;
  emu.cpu.reg[6] = savedESI;
  emu.cpu.reg[7] = savedEDI;

  return emu.wndProcResult;
}

/**
 * Call a DLL entry point: DllMain(hModule, DLL_PROCESS_ATTACH, 0)
 * Uses the same nested-loop mechanism as callWndProc.
 */
export function emuCallDllMain(emu: Emulator, entryPoint: number, hModule: number): number {
  if (!entryPoint) return 1;

  const savedEBX = emu.cpu.reg[3];
  const savedESI = emu.cpu.reg[6];
  const savedEDI = emu.cpu.reg[7];
  const savedEBP = emu.cpu.reg[5];
  const savedESP = emu.cpu.reg[4];

  const DLL_PROCESS_ATTACH = 1;
  // stdcall: push args right-to-left
  emu.cpu.push32(0);                     // lpReserved
  emu.cpu.push32(DLL_PROCESS_ATTACH);    // fdwReason
  emu.cpu.push32(hModule);               // hinstDLL
  emu.cpu.push32(WNDPROC_RETURN_THUNK);  // return address
  emu.cpu.eip = entryPoint;

  emu.wndProcDepth++;
  const targetDepth = emu.wndProcDepth - 1;
  let steps = 0;
  const MAX_STEPS = 5000000;

  while (emu.wndProcDepth > targetDepth && !emu.halted && !emu.cpu.halted && steps < MAX_STEPS) {
    const eip = emu.cpu.eip >>> 0;
    const thunk = emu.thunkPages.has(eip >>> 12) ? emu.thunkToApi.get(eip) : undefined;
    if (thunk) {
      const key = `${thunk.dll}:${thunk.name}`;
      const handler = emu.apiDefs.get(key)?.handler;
      if (handler) {
        if (key === 'SYSTEM:WNDPROC_RETURN') {
          handler(emu);
          break;
        }
        emu._currentThunkStackBytes = thunk.stackBytes;
        const retVal = handler(emu);
        if (emu._wndProcSetupPending) {
          emu._wndProcSetupPending = false;
          steps++;
          continue;
        }
        if (emu.waitingForMessage || emu.halted) break;
        if (retVal !== undefined) {
          emuCompleteThunk(emu, retVal as number, thunk.stackBytes);
        }
      } else {
        emuCompleteThunk(emu, 0, thunk.stackBytes);
      }
    } else {
      emu.cpu.step();
    }
    steps++;
  }

  const retVal = emu.cpu.reg[0]; // EAX
  emu.cpu.reg[3] = savedEBX;
  emu.cpu.reg[5] = savedEBP;
  emu.cpu.reg[6] = savedESI;
  emu.cpu.reg[7] = savedEDI;
  emu.cpu.reg[4] = savedESP;

  console.log(`[DLL] DllMain(0x${hModule.toString(16)}, DLL_PROCESS_ATTACH) => ${retVal} (${steps} steps)`);
  return retVal;
}

export function emuCallNative(emu: Emulator, addr: number): number | undefined {
  const savedESP = emu.cpu.reg[4];
  const result = emuCallWndProc(emu, addr, 0, 0, 0, 0);
  emu.cpu.reg[4] = savedESP;
  return result;
}

const BATCH_SIZE = 500000;
const DOS_TICK_MS = 16; // fill one rAF frame (~16.7ms) for maximum throughput
const DOS_POST_KEY_STEPS = 0x80;

// WASM JIT diagnostics — logs every ~1s
let _diagWasmRuns = 0, _diagWasmInsns = 0, _diagInterpInsns = 0;
let _diagWasmExits: Record<number, number> = {};
let _diagTickCount = 0, _diagTickTotalMs = 0;
let _diagLastLog = 0;

export function emuTick(emu: Emulator): void {
  if (!emu.running || emu.halted) return;
  // Guard against reentrant tick() calls — can happen when multiple
  // requestAnimationFrame(tick) are queued from different code paths.
  if (emu._tickRunning) return;
  emu._tickRunning = true;

  try {
  // If waiting for DOS key (INT 21h AH=01/07/08) and key available, deliver it
  if (emu._dosWaitingForKey && (emu.dosKeyBuffer.length > 0 || emu._dosExtKeyPending !== undefined)) {
    emu.deliverDosKey();
    emu._tickRunning = false;
    return;
  }
  if (emu._dosWaitingForKey && emu.dosKeyBuffer.length === 0) {
    const BDA = 0x400;
    const head = emu.memory.readU16(BDA + 0x1A);
    const tail = emu.memory.readU16(BDA + 0x1C);
    if (head !== tail) {
      const keyWord = emu.memory.readU16(BDA + head);
      const ascii = keyWord & 0xFF;
      const scan = (keyWord >> 8) & 0xFF;
      emu.dosKeyBuffer.push({ ascii, scan });
      const bufStart = emu.memory.readU16(BDA + 0x80);
      const bufEnd = emu.memory.readU16(BDA + 0x82);
      let newHead = head + 2;
      if (newHead >= bufEnd) newHead = bufStart;
      emu.memory.writeU16(BDA + 0x1A, newHead);
      emu.deliverDosKey();
      emu._tickRunning = false;
      return;
    }
  }

  const tickStart = performance.now();
  let stepCount = 0;
  const tickMs = emu.isDOS ? DOS_TICK_MS * emu.dosSpeedFactor : 50;
  let dosYieldAfterKeyAt = -1;
  let prevDosKeyBufferLen = emu.dosKeyBuffer.length;
  let prevBdaKeyHead = emu.isDOS ? emu.memory.readU16(0x41A) : 0;
  emu._dosKeyConsumedThisTick = false;
  // emu._hwIntSavedSP is stored on `emu` so it persists across tick() calls.
  // If an interrupt handler is still running when a tick ends (time limit),
  // the next tick must NOT dispatch new interrupts until the handler IRETs.
  emu._dosHwKeyReadThisTick = false;

  // Wake from HLT: check if a timer interrupt is due
  if (emu._dosHalted && emu.isDOS) {
    const now = performance.now();
    const pitReload = emu._pitCounters[0] || 0x10000;
    const timerIntervalMs = (pitReload / 1193182) * 1000;
    // Gate PIT on emulated cycles too: real hardware fires IRQ0 once every
    // pitReload PIT ticks, which for a ~20 MIPS 386 is pitReload * 16.76 insns.
    // Without a cycle gate, a slow JS emulator overfires IRQ0 during boot
    // (each hit permanently consumes a DOS/4GW exception-stack frame at
    // cs=1569:0x580, eventually starving the guard at SI<=0x4840 and firing
    // DOS/4GW's exit(2002)).
    // PIT cycle gate — only applied when DPMI is active. DOS/4GW's PM IRQ
    // dispatch + user handler takes many emulator steps, so a wall-clock-only
    // timer would overfire IRQ0 during boot and starve the exception-stack
    // frame. For pure real-mode DOS games the wall-clock rate alone is
    // sufficient and adding a cycle gate starves music/animations (PoP, SR,
    // Monkey Island all slow down ~40x because they reprogram the PIT for
    // fast audio callbacks).
    const minStepsPerPitTick = emu._dpmiState ? pitReload * 200 : 0;
    const stepsSince = emu.cpuSteps - emu._dosLastTimerTickSteps;
    // Headless tests advance cpuSteps much faster than wall-clock, so the
    // wall-clock gate practically never triggers. emu._pitCycleOnly bypasses
    // the wall-clock check and fires PIT purely on emulated cycles — useful
    // for headless integration tests that need the timer to advance.
    const wallOk = emu._pitCycleOnly || (now - emu._dosLastTimerTick >= timerIntervalMs);
    if (wallOk && stepsSince >= minStepsPerPitTick) {
      emu._dosLastTimerTick += timerIntervalMs;
      emu._dosLastTimerTickSteps = emu.cpuSteps;
      // Cap: don't fall more than 200ms behind (prevents catch-up storm after tab background)
      if (now - emu._dosLastTimerTick > 200) emu._dosLastTimerTick = now;
      const timerInt = emu._picMasterBase; // IRQ 0
      // Count already-queued IRQ0s: with the IF=0 gate, the guest can sit in a
      // CLI section for multiple PIT intervals and each interval needs to be
      // accounted for so music / timer callbacks don't lose time. Cap the
      // queue at 4 pending IRQ0s to avoid unbounded growth if the guest has
      // masked the PIC (also checked via _picMasterMask below).
      if (!(emu._picMasterMask & 0x01)) {
        let pendingCount = 0;
        for (const v of emu._pendingHwInts) if (v === timerInt) pendingCount++;
        if (pendingCount < 4) emu._pendingHwInts.push(timerInt);
      }
      emu._dosHalted = false;
    }
    // Also wake on pending keyboard interrupt
    if (emu._pendingHwInts.length > 0 || emu.dosKeyBuffer.length > 0) {
      emu._dosHalted = false;
    }
    // If still halted, fall through to bottom where next tick is scheduled
  }

  // Dispatch multimedia timers (timeSetEvent)
  if (emu._mmTimers.size > 0 && !emu.isDOS) {
    const now = Date.now();
    for (const [id, t] of emu._mmTimers) {
      if (now >= t.nextFire) {
        // Save ALL CPU state — the timer callback runs via callStdcall which
        // clobbers general-purpose registers. Without saving them, long-running
        // computations (e.g. CRC loops) that span multiple ticks get corrupted.
        const savedEIP = emu.cpu.eip;
        const savedRegs = [...emu.cpu.reg]; // EAX, ECX, EDX, EBX, ESP, EBP, ESI, EDI
        const savedFlags = emu.cpu.getFlags();
        emuCallTimerProc(emu, t.callback, id, t.dwUser);
        // Restore CPU state after callback
        emu.cpu.eip = savedEIP;
        for (let ri = 0; ri < 8; ri++) emu.cpu.reg[ri] = savedRegs[ri];
        emu.cpu.setFlags(savedFlags);
        if (t.periodic) {
          t.nextFire = now + t.delay;
        } else {
          emu._mmTimers.delete(id);
        }
        if (emu.halted || emu.waitingForMessage) break;
      }
    }
  }

  let tkEipA = 0, tkHitA = 0, tkEipB = 0, tkHitB = 0, tkNextB = 252;
  let tkEipC = 0, tkHitC = 0; // period 64
  const hasThunks = emu.thunkPages.size > 0; // DOS programs have no thunks

  for (let i = 0; i < BATCH_SIZE; i++) {
    if (emu._int09ReturnCS >= 0) {
      const ip16 = (emu.cpu.eip - emu.cpu.segBase(emu.cpu.cs)) & 0xFFFF;
      if (emu.cpu.cs === emu._int09ReturnCS && ip16 === emu._int09ReturnIP) {
        // INT 09h handler returned (IRET) to interrupted context.
        emu._kbdReplayPending = false;
        emu._kbdDataReadsLeft = 0;
        emu._int09ReturnCS = -1;
      }
    }
    // Detect mouse callback completion: SP returned to pre-dispatch level.
    // The trampoline at F000:0500 handles register restoration via x86 POPs+IRET;
    // this check just clears the "active" flag so the next callback can dispatch.
    if (emu._mouseCallbackSavedSP >= 0 && (emu.cpu.reg[4] & 0xFFFF) >= emu._mouseCallbackSavedSP) {
      emu._mouseCallbackSavedSP = -1;
    }
    // Detect IRET from hardware interrupt handler by monitoring SP (RM dispatch)
    // or IF flag restoration (PM IDT dispatch).
    // SS must also match: DOS/4GW's PM ISR pops up to 18 bytes from the caller's
    // stack (handoff between outer and inner frames) before it switches SS:ESP
    // onto the allocated exception stack. During that window SP transiently
    // rises above _hwIntSavedSP on the OUTER stack — without an SS check, we
    // would clear the guard and dispatch another HW IRQ on top of the handler.
    if (
      emu._hwIntSavedSP >= 0 &&
      (emu._hwIntSavedSS < 0 || emu.cpu.ss === emu._hwIntSavedSS) &&
      (emu.cpu.reg[4] & 0xFFFF) >= emu._hwIntSavedSP
    ) {
      emu._hwIntSavedSP = -1;
      emu._hwIntSavedSS = -1;
      // Restore PM state if we switched to RM for the interrupt handler
      if (emu._hwIntPMState) {
        emu._cr0 = emu._hwIntPMState.cr0;
        emu.cpu.realMode = false;
        emu.cpu.use32 = emu._hwIntPMState.use32;
        emu.cpu._addrSize16 = !emu._hwIntPMState.use32;
        emu.cpu.cs = emu._hwIntPMState.cs;
        emu.cpu.ss = emu._hwIntPMState.ss;
        emu.cpu.ds = emu._hwIntPMState.ds;
        emu.cpu.es = emu._hwIntPMState.es;
        emu.cpu.segBases = emu._hwIntPMState.segBases;
        emu._hwIntPMState = undefined;
      }
    }
    if (emu.halted || emu.waitingForMessage || emu._dosHalted) break;
    if (emu.isDOS && dosYieldAfterKeyAt < 0 && emu.dosSpeedFactor >= 1
        && (emu._dosKeyConsumedThisTick || emu._dosHwKeyReadThisTick)) {
      // A DOS key was consumed this tick (INT 16h or direct port 0x60 path):
      // let guest run a little longer
      // so it can finish drawing before we yield/sync the frame.
      // Disabled at reduced speed: rAF + reduced tickMs already ensures 60Hz sync,
      // and yielding after 128 insns would starve the game (~7k insns/sec).
      dosYieldAfterKeyAt = i + DOS_POST_KEY_STEPS;
    }
    if (dosYieldAfterKeyAt >= 0 && i >= dosYieldAfterKeyAt) break;
    if ((i & 0xFFF) === 0 && i > 0) {
      // Periodic time check — amortize performance.now() cost across 4096 instructions
      const now = performance.now();
      const waitingForPostKeyWindow = dosYieldAfterKeyAt >= 0 && i < dosYieldAfterKeyAt;
      if (!waitingForPostKeyWindow && now - tickStart > tickMs) break;
      // Yield after screen draws so browser can render intermediate frames (Win32 only —
      // DOS games do rapid VGA writes and yielding on each one kills throughput)
      if (!emu.isDOS && emu.screenDirty) { emu.screenDirty = false; break; }

      // DOS timer interrupt — frequency derived from PIT channel 0.
      // Gate on emulated cycles too (see matching comment in the HLT branch)
      // so a slow JS emulator does not overfire IRQ0 during boot.
      if (emu.isDOS) {
        const pitReload = emu._pitCounters[0] || 0x10000;
        const timerIntervalMs = (pitReload / 1193182) * 1000;
        // PIT cycle gate — only applied when DPMI is active (see HLT branch
        // comment). Pure real-mode games need IRQ0 at wall-clock rate for
        // music and animations to run correctly.
        const minStepsPerPitTick = emu._dpmiState ? pitReload * 200 : 0;
        const stepsSince = (emu.cpuSteps + stepCount) - emu._dosLastTimerTickSteps;
        const wallOk = emu._pitCycleOnly || (now - emu._dosLastTimerTick >= timerIntervalMs);
        if (wallOk && stepsSince >= minStepsPerPitTick) {
          const timerInt = emu._picMasterBase; // IRQ 0
          if (!(emu._picMasterMask & 0x01)) {
            // Allow stacking up to 4 pending IRQ0s so CLI sections do not
            // silently drop PIT ticks (see HLT-branch comment above).
            let pendingCount = 0;
            for (const v of emu._pendingHwInts) if (v === timerInt) pendingCount++;
            if (pendingCount < 4) {
              emu._dosLastTimerTick += timerIntervalMs;
              emu._dosLastTimerTickSteps = emu.cpuSteps + stepCount;
              if (now - emu._dosLastTimerTick > 200) emu._dosLastTimerTick = now;
              emu._pendingHwInts.push(timerInt);
            }
          }
          emu._dosHalted = false;
        }
        // (mouse callback dispatch moved to per-instruction check above)
      }
    }
    if (emu.isDOS) {
      // Advance Sound Blaster DMA transfer (may queue IRQ 7)
      if ((i & 0x1FF) === 0) emu.dosAudio.tickDMA();
    }

    // Deliver queued scancodes one at a time, throttled to ~30 Hz to match
    // real keyboard repeat rate and prevent starving game logic with INT 09h.
    if (
      emu._pendingHwInts.length === 0 &&
      emu._pendingHwKeys.length > 0 &&
      emu._int09ReturnCS < 0
    ) {
      const nextCode = emu._pendingHwKeys[0];
      // E0 prefix bytes are always delivered immediately (they're part of a scancode pair).
      // Other scancodes are throttled: at least 30ms between deliveries.
      const KEY_THROTTLE_MS = 30;
      const now = performance.now();
      const elapsed = now - emu._lastHwKeyDeliverTime;
      if (nextCode === 0xE0 || elapsed >= KEY_THROTTLE_MS) {
        const code = emu._pendingHwKeys.shift()!;
        emu._currentHwKeyChar = emu._pendingHwKeyChars.get(code);
        emu._pendingHwKeyChars.delete(code);
        emu._ioPorts.set(0x60, code);
        emu._ioPorts.set(0x64, (emu._ioPorts.get(0x64) ?? 0) | 0x01);
        emu._kbdReplayPending = false;
        emu._kbdDataReadsLeft = 0;
        // Pre-update BDA shift flags for modifier keys so programs that hook
        // INT 09h without chaining to BIOS still see correct modifier state
        const BDA_SHIFT = 0x417;
        const flags = emu.memory.readU8(BDA_SHIFT);
        if (code === 0x2A) emu.memory.writeU8(BDA_SHIFT, flags | 0x02);       // LShift make
        else if (code === 0x36) emu.memory.writeU8(BDA_SHIFT, flags | 0x01);  // RShift make
        else if (code === 0x1D) emu.memory.writeU8(BDA_SHIFT, flags | 0x04);  // Ctrl make
        else if (code === 0x38) emu.memory.writeU8(BDA_SHIFT, flags | 0x08);  // Alt make
        else if (code === 0xAA) emu.memory.writeU8(BDA_SHIFT, flags & ~0x02); // LShift break
        else if (code === 0xB6) emu.memory.writeU8(BDA_SHIFT, flags & ~0x01); // RShift break
        else if (code === 0x9D) emu.memory.writeU8(BDA_SHIFT, flags & ~0x04); // Ctrl break
        else if (code === 0xB8) emu.memory.writeU8(BDA_SHIFT, flags & ~0x08); // Alt break
        emu._pendingHwInts.push(0x09);
        if (code !== 0xE0) emu._lastHwKeyDeliverTime = now;
        if (emu.isDOS && dosYieldAfterKeyAt < 0 && code !== 0xE0
            && emu._pendingHwKeys.length === 0) {
          // Hardware key delivered this tick: give DOS app a short execution window
          // to finish drawing, then yield/sync so the frame is observable.
          // Skip when more keys are queued (key repeat) — no point yielding just
          // to deliver another key next tick; that starves the game at low speed.
          dosYieldAfterKeyAt = i + DOS_POST_KEY_STEPS;
        }
        emu._hwKeyDelay = 0;
      }
    } else if (emu._pendingHwInts.length === 0) {
      emu._hwKeyDelay = 0;
    }
    // Dispatch pending mouse callback (far call via trampoline at F000:0500).
    // Safe at every instruction boundary since the trampoline handles register
    // restoration via real x86 POPs + IRET (no fragile JS-side detection).
    if (emu.dosMouse.pendingCallbackMask && emu._mouseCallbackSavedSP < 0 && emu._hwIntSavedSP < 0) {
      dispatchMouseCallback(emu);
    }
    if (
      emu._pendingHwInts.length > 0 &&
      emu._hwIntSavedSP < 0 &&
      !emu.cpu._inhibitIRQ &&
      // Only gate on IF when DPMI is active. DPMI clients (DOOM via DOS/4GW)
      // need strict IF=0 blocking so IRQs do not dispatch nested on top of a
      // PM ISR. Real-mode / VCPI guests (Second Reality's pmodew, Prince of
      // Persia, Monkey Island) do their own timing with CLI/STI around
      // critical sections and rely on the emulator to honor PIT ticks
      // back-to-back — blocking IRQ dispatch on IF=0 causes lost ticks and
      // stalls animations / title-card code.
      (!emu._dpmiState || (emu.cpu.getFlags() & 0x0200) !== 0)
    ) {
      // _inhibitIRQ: MOV SS/POP SS inhibits for 1 instruction (real x86 behavior).
      const intNum = emu._pendingHwInts.shift()!;
      // Set PIC ISR bit for this IRQ (cleared by EOI from handler)
      const masterBase = emu._picMasterBase;
      const slaveBase = emu._picSlaveBase;
      if (intNum >= masterBase && intNum < masterBase + 8) {
        emu._picMasterISR |= (1 << (intNum - masterBase));
      } else if (intNum >= slaveBase && intNum < slaveBase + 8) {
        emu._picSlaveISR |= (1 << (intNum - slaveBase));
      }

      // In PM with DPMI active, dispatch HW interrupts through dispatchException
      // so PM handlers installed via INT 31h AX=0205 are used.
      if (!emu.cpu.realMode && emu._dpmiState) {
        const prevSS = emu.cpu.ss;
        dispatchException(emu.cpu, intNum, 'interrupt', true);
        // Mark handler active so the batch loop does not dispatch another HW
        // interrupt on top of this one. Cleared in the IRETD detection above
        // when SS matches the saved value AND SP rises back to this level.
        emu._hwIntSavedSP = emu.cpu.reg[4] & 0xFFFF;
        emu._hwIntSavedSS = prevSS;
        continue;
      }

      const biosDefault = emu._dosBiosDefaultVectors.get(intNum) ?? ((0xF000 << 16) | (intNum * 5));
      // Always read IVT memory first — programs chain multiple handlers
      // by writing directly to IVT (e.g. PoP chains timer→animation→sound)
      const ivtOff = emu.memory.readU16(intNum * 4);
      const ivtSeg = emu.memory.readU16(intNum * 4 + 2);
      const ivtVec = (ivtSeg << 16) | ivtOff;
      let vec: number | undefined;
      // Skip PM-modified IVT entries in V86 mode (VCPI PM code rewrites vectors
      // with PM selectors; dispatching them as RM segments crashes)
      // In V86 (RM) with VCPI: skip IVT entries modified by PM code (PM selectors
      // interpreted as RM segments → wrong addresses). In PM: dispatch normally
      // (PM selectors ARE valid in PM).
      let pmModifiedHW = false;
      if (emu.cpu.realMode && emu._vcpiSavedIVT && ivtSeg !== 0xF000) {
        const origSeg = emu._vcpiSavedIVT[intNum];
        if (origSeg !== undefined && ivtSeg !== origSeg) pmModifiedHW = true;
      }
      if (ivtVec !== biosDefault && ivtSeg !== 0xF000 && !pmModifiedHW) {
        vec = ivtVec;
      } else {
        vec = emu._dosIntVectors.get(intNum);
      }
      if (vec && vec !== biosDefault) {
        // Custom handler installed — dispatch via INT (push flags/CS/IP, jump)
        const seg = (vec >>> 16) & 0xFFFF;
        const off = vec & 0xFFFF;
        emu._ioPorts.set(0x64, (emu._ioPorts.get(0x64) ?? 0) | 0x01);

        // In protected mode (PMODEW), IVT handlers are real-mode code.
        // Temporarily switch to real mode so segment arithmetic is correct
        // and the handler can use DS/ES as real-mode segments.
        if (!emu.cpu.realMode) {
          const pmSSBase = emu.cpu.segBase(emu.cpu.ss);
          emu._hwIntPMState = {
            cr0: emu._cr0,
            cs: emu.cpu.cs,
            ss: emu.cpu.ss,
            ds: emu.cpu.ds,
            es: emu.cpu.es,
            use32: emu.cpu.use32,
            segBases: new Map(emu.cpu.segBases),
          };
          emu._cr0 = 0x12; // keep MP+ET on PM→RM transition
          emu.cpu.realMode = true;
          emu.cpu.use32 = false;       // RM handlers are 16-bit code
          emu.cpu._addrSize16 = true;
          emu.cpu.segBases.clear();
          // Convert SS to real-mode paragraph (linear address stays the same)
          const rmSS = (pmSSBase >>> 4) & 0xFFFF;
          emu.cpu.ss = rmSS;
          // Encode PM return address as real-mode seg:off
          const pmEIP = emu.cpu.eip;
          const returnSeg = (pmEIP >>> 4) & 0xFFFF;
          const returnOff = pmEIP & 0xF;
          emu._hwIntSavedSP = emu.cpu.reg[4] & 0xFFFF;
          emu.cpu.push16(emu.cpu.getFlags() & 0xFFFF);
          emu.cpu.push16(returnSeg);
          emu.cpu.push16(returnOff);
          emu.cpu.setFlags(emu.cpu.getFlags() & ~0x0300);
          emu.cpu.cs = seg;
          emu.cpu.eip = (seg * 16 + off) >>> 0;
        } else {
          const returnIP = (emu.cpu.eip - emu.cpu.segBase(emu.cpu.cs)) & 0xFFFF;
          emu._hwIntSavedSP = emu.cpu.reg[4] & 0xFFFF;
          emu.cpu.push16(emu.cpu.getFlags() & 0xFFFF);
          emu.cpu.push16(emu.cpu.cs);
          emu.cpu.push16(returnIP);
          emu.cpu.setFlags(emu.cpu.getFlags() & ~0x0300);
          if (intNum === 0x09) {
            emu._int09ReturnCS = emu.cpu.cs;
            emu._int09ReturnIP = returnIP;
          }
          emu.cpu.cs = seg;
          emu.cpu.eip = emu.cpu.segBase(seg) + off;
        }
      } else {
        // No custom handler — call built-in BIOS handler directly
        emu._hwIntSavedSP = emu.cpu.reg[4] & 0xFFFF;
        handleDosInt(emu.cpu, intNum, emu);
        if (intNum === 0x09) {
          emu._kbdReplayPending = false;
          emu._kbdDataReadsLeft = 0;
        }
      }
    }

    stepCount++;

    const eip = emu.cpu.eip >>> 0;

    const thunk = hasThunks ? (emu.thunkPages.has(eip >>> 12) ? emu.thunkToApi.get(eip) : undefined) : undefined;
    if (thunk) {
      stepCount += 999; // thunks represent significant work (~1000 real instructions)
      emu._lastThunkTick = emu._tickCount;
      const key = `${thunk.dll}:${thunk.name}`;
      emu.diagThunk(key);
      const handler = emu.apiDefs.get(key)?.handler;

      const origESP = emu.cpu.reg[4] + thunk.stackBytes + 4;

      if (emu.traceApi && key !== 'SYSTEM:WNDPROC_RETURN') {
        console.log(`[API] ${key}`);
      }

      if (handler) {
        if (key === 'SYSTEM:WNDPROC_RETURN') {
          // Check if this is a legitimate WNDPROC_RETURN or a stale value on the stack.
          const frame = emu._wndProcFrames.length > 0 ? emu._wndProcFrames.shift() : undefined;
          if (!frame && emu.wndProcDepth <= 0) {
            // Stale WNDPROC_RETURN_THUNK on stack — treat as a no-op function.
            // The RET instruction already popped this address. Read next value from
            // the stack as the real return address and continue.
            const realRetAddr = emu.memory.readU32(emu.cpu.reg[4] >>> 0);
            emu.cpu.reg[4] = (emu.cpu.reg[4] + 4) | 0;
            emu.cpu.eip = realRetAddr;
            continue;
          }
          handler(emu);
          // Pop saved frame, restore callee-saved registers, complete outer thunk
          if (frame) {
            emu.cpu.reg[3] = frame.savedEBX;
            emu.cpu.reg[5] = frame.savedEBP;
            emu.cpu.reg[6] = frame.savedESI;
            emu.cpu.reg[7] = frame.savedEDI;
            if (frame.savedDS !== undefined) emu.cpu.ds = frame.savedDS;
            // Complete the outer thunk (e.g. DispatchMessage) that triggered this wndproc
            frame.outerCompleter(emu, emu.wndProcResult, frame.outerStackBytes);
          }
          // Continue executing — don't break
          continue;
        } else {
          emu._currentThunkStackBytes = thunk.stackBytes;
          const retVal = handler(emu);
          // If handler called callWndProc (which sets up stack and returns Promise),
          // store outer thunk info in the frame and continue executing the wndproc code.
          if (emu._wndProcSetupPending) {
            emu._wndProcSetupPending = false;
            const frame = emu._wndProcFrames[emu._wndProcFrames.length - 1];
            frame.outerStackBytes = thunk.stackBytes;
            frame.outerCompleter = emu.isNE ? emuCompleteThunk16 : emuCompleteThunk;
            continue;
          }
          // Handler returned undefined — skip thunk completion (handler adjusted EIP/ESP or set waitingForMessage)
          if (retVal === undefined) break;
          if (emu.halted || emu.waitingForMessage || emu._dosHalted) break;
          if (emu.isNE) {
            emuCompleteThunk16(emu, retVal as number, thunk.stackBytes);
          } else {
            emuCompleteThunk(emu, retVal as number, thunk.stackBytes);
          }
        }
      } else {
        emu.haltReason = `Unimplemented API: ${thunk.dll}:${thunk.displayName || thunk.name}`;
        emu.halted = true;
        break;
      }
      continue;
    }

    // Tight loop fast-forward + JIT (triggered by loop detection, zero overhead otherwise)
    {
      // Fast path: check loop cache every 64 steps
      if ((stepCount & 0x3F) === 0 && stepCount > 0) {
        try {
          const ci = tryCachedLoop(emu.cpu, emu.memory);
          if (ci > 0) { stepCount += ci; tkHitA = tkHitB = 0; tkNextB = stepCount + 252; continue; }
        } catch (e) {
          if (e instanceof AccessViolationError) { raiseAccessViolation(emu, e.addr); continue; }
          if (e instanceof PageFaultError) { if (!handlePageFault(emu, e)) break; continue; }
          throw e;
        }
      }
      let tkTry = false;
      if ((stepCount & 0xFF) === 0 && stepCount > 0) {
        if (eip === tkEipA) { if (++tkHitA >= 2) tkTry = true; } else { tkEipA = eip; tkHitA = 0; }
      }
      if (stepCount >= tkNextB) {
        tkNextB = stepCount + 252;
        if (eip === tkEipB) { if (++tkHitB >= 2) tkTry = true; } else { tkEipB = eip; tkHitB = 0; }
      }
      if ((stepCount & 0x3F) === 0 && stepCount > 0) {
        if (eip === tkEipC) { if (++tkHitC >= 2) tkTry = true; } else { tkEipC = eip; tkHitC = 0; }
      }
      if (tkTry) {
        try {
          const it = tryFastLoop(emu.cpu, emu.memory);
          if (it > 0) { stepCount += it; emu._pitInsnCount += it; tkHitA = tkHitB = tkHitC = 0; tkNextB = stepCount + 252; continue; }
        } catch (e) {
          if (e instanceof AccessViolationError) { raiseAccessViolation(emu, e.addr); continue; }
          if (e instanceof PageFaultError) { if (!handlePageFault(emu, e)) break; continue; }
          throw e;
        }
        // Fast-loop failed — try WASM JIT (zero-copy via shared flat buffer)
        if (emu.flatMemory && emu.wasmJitEnabled && !(emu.cpu.flagsCache & 0x100)) {
          const regionBase = eip & ~0xFFFF;
          const region = emu.wasmRegions.get(regionBase);
          if (region) {
            // Staleness check: verify compiled code matches current memory
            // (PMODE/W overwrites real-mode code during init → stale modules)
            const expectedDword = region.entryChecks.get(eip);
            if (expectedDword !== undefined && emu.memory.readU32(eip) !== expectedDword) {
              emu.wasmRegions.delete(regionBase);
              emu._wasmBlacklist.add(regionBase);
              tkHitA = tkHitB = tkHitC = 0;
              continue;
            }
            const entryIdx = region.entryMap.get(eip);
            if (entryIdx !== undefined) {
              const flat = emu.flatMemory;
              // Only sync registers/flags — memory is already shared (zero-copy)
              flat.writeRegs(emu.cpu);
              flat.writeFlags(emu.cpu);
              flat.writeSegBases(emu.cpu);
              flat.dv.setInt32(OFF_ENTRY, entryIdx, true);
              try {
                region.run();
                flat.readRegs(emu.cpu);
                flat.readFlags(emu.cpu);
                emu.cpu.eip = flat.readEip();
                const wasmInsns = flat.readCounter();
                const exitReason = flat.readExitReason();
                _diagWasmRuns++;
                _diagWasmInsns += wasmInsns;
                _diagWasmExits[exitReason] = (_diagWasmExits[exitReason] || 0) + 1;
                stepCount += wasmInsns;
                emu._pitInsnCount += wasmInsns;
                if (wasmInsns > 64) {
                  // WASM did real work — advance i and force time/PIT check
                  i = (i + wasmInsns) | 0xFFF;
                }
                // exit_reason=2 (unsupported opcode) is normal — block bails to
                // interpreter. No blacklisting needed.
              } catch {
                // WASM OOB or other runtime error — discard this region and fall back to interpreter
                flat.readRegs(emu.cpu);
                flat.readFlags(emu.cpu);
                emu.cpu.eip = flat.readEip() || eip; // restore EIP
                emu.wasmRegions.delete(regionBase);
                emu._wasmBlacklist.add(regionBase);
              }
              tkHitA = tkHitB = tkHitC = 0;
              continue;
            }
          }
          // Record hotness and trigger async compilation
          // Wait 180 ticks (~3s) before compiling — let PMODE/W finish rewriting memory
          if (emu._tickCount > 180 && emu._wasmPending.size === 0 && !emu._wasmBlacklist.has(regionBase)) {
            const count = (emu._wasmHotness.get(regionBase) || 0) + 1;
            emu._wasmHotness.set(regionBase, count);
            if (count >= 50) {
              emu._wasmPending.add(regionBase);
              const flat = emu.flatMemory;
              const wasmImports: WasmImports = {
                writeVGA: (addr, val) => { emu.memory.writeU8(addr, val); },
                testCC: (cc) => {
                  // Sync flags from flat buffer (written by WASM) to CPU before materializing
                  flat.readFlags(emu.cpu);
                  materializeFlags(emu.cpu);
                  return emu.cpu.testCC(cc) ? 1 : 0;
                },
                portIn: (port) => emu.portIn(port),
                portOut: (port, val) => emu.portOut(port, val),
              };
              compileWasmRegion(emu.memory, eip, emu.cpu.use32, flat, wasmImports).then(compiled => {
                emu._wasmPending.delete(regionBase);
                if (compiled) emu.wasmRegions.set(regionBase, compiled);
              });
            }
          }
        }
        tkHitA = tkHitB = tkHitC = 0;
      }
    }

    const prevEip = eip;
    // EIP history for crash diagnostics (ring buffer)
    if (!emu._eipHistory) { emu._eipHistory = new Uint32Array(64); emu._eipHistIdx = 0; }
    emu._eipHistory[emu._eipHistIdx & 63] = eip;
    emu._eipHistIdx++;
    // (Tight-loop detector removed — produced false positives on legitimate
    // demo scroll loops (Second Reality) and VBL waits. The original DOOM
    // mixer corruption it was designed to catch is now prevented upstream
    // by the proper SB Pro mixer register implementation.)
    try {
      emu.cpu.step();
    } catch (e) {
      if (e instanceof AccessViolationError) { raiseAccessViolation(emu, e.addr); continue; }
      if (e instanceof PageFaultError) { if (!handlePageFault(emu, e)) break; continue; }
      throw e;
    }
    emu._pitInsnCount++;
    if (emu.isDOS) {
      const curDosKeyBufferLen = emu.dosKeyBuffer.length;
      if (dosYieldAfterKeyAt < 0 && curDosKeyBufferLen < prevDosKeyBufferLen) {
        // Key was consumed this tick (direct INT 16h/INT 21h path): keep running
        // briefly so app can finish rendering before we sync/yield.
        dosYieldAfterKeyAt = i + DOS_POST_KEY_STEPS;
      }
      prevDosKeyBufferLen = curDosKeyBufferLen;
      const curBdaKeyHead = emu.memory.readU16(0x41A);
      if (dosYieldAfterKeyAt < 0 && curBdaKeyHead !== prevBdaKeyHead) {
        // Some programs consume keys from BDA ring buffer directly.
        dosYieldAfterKeyAt = i + DOS_POST_KEY_STEPS;
      }
      prevBdaKeyHead = curBdaKeyHead;
    }
    // (Stack corruption trap removed — low SP is legitimate for interrupt handlers)
    if (emu.cpu.halted) {
      const hBytes: string[] = [];
      for (let j = 0; j < 8; j++) hBytes.push(emu.memory.readU8((prevEip + j) >>> 0).toString(16).padStart(2, '0'));
      console.warn(`[CPU-HALT] at EIP=0x${prevEip.toString(16)} bytes: ${hBytes.join(' ')} ESP=0x${(emu.cpu.reg[4]>>>0).toString(16)} reason="${emu.cpu.haltReason}" cs=${emu.cpu.cs.toString(16)} ds=${emu.cpu.ds.toString(16)} ss=${emu.cpu.ss.toString(16)} RM=${emu.cpu.realMode}`);
      // Dump the per-instruction ring buffer so we can see how we reached the halt.
      if (emu._eipHistory) {
        const idx = emu._eipHistIdx || 0;
        const arr = emu._eipHistory;
        const lines: string[] = [];
        for (let h = Math.max(0, idx - 32); h < idx; h++) {
          const addr = arr[h & 63] >>> 0;
          const bytes: string[] = [];
          for (let b = 0; b < 8; b++) bytes.push(emu.memory.readU8((addr + b) >>> 0).toString(16).padStart(2, '0'));
          lines.push(`    0x${addr.toString(16).padStart(8, '0')}: ${bytes.join(' ')}`);
        }
        console.warn(`[CPU-HALT] EIP history (last 32):\n${lines.join('\n')}`);
      }
      emu.haltReason = emu.cpu.haltReason || 'illegal instruction';
      emu.halted = true;
      break;
    }
    // Detect wild EIP
    const newEip = emu.cpu.eip >>> 0;
    if (!emu.thunkToApi.has(newEip)) {
      let inImage = false;
      if (emu.isNE && emu.ne) {
        for (const seg of emu.ne.segments) {
          if (newEip >= seg.linearBase && newEip < seg.linearBase + 0x10000) {
            inImage = true;
            break;
          }
        }
        if (!inImage && newEip >= emu.heapBase && newEip < emu.virtualPtr + 0x100000) {
          inImage = true;
        }
      } else if (emu.isDOS) {
        // DOS mode: any address in conventional memory (0-0xFFFFF) or heap is valid.
        // In protected mode (DOS extender code), allow any address — DOS extenders
        // run code at high linear addresses via VCPI/DPMI page tables, and the
        // conventional-memory bound doesn't apply once we're past the V86 layer.
        inImage = !emu.cpu.realMode
          || newEip < 0x100000
          || (newEip >= emu.heapBase && newEip < emu.virtualPtr + 0x100000);
      } else {
        inImage = emu.pe && newEip >= emu.pe.imageBase && newEip < emu.pe.imageBase + emu.pe.sizeOfImage;
        if (!inImage) {
          for (const mod of emu.loadedModules.values()) {
            if (mod.sizeOfImage && newEip >= mod.imageBase && newEip < mod.imageBase + mod.sizeOfImage) {
              inImage = true;
              break;
            }
          }
        }
      }
      if (!inImage) {
        const before: string[] = [];
        for (let j = -16; j < 0; j++) before.push(emu.memory.readU8((prevEip + j) >>> 0).toString(16).padStart(2, '0'));
        const at: string[] = [];
        for (let j = 0; j < 16; j++) at.push(emu.memory.readU8((newEip + j) >>> 0).toString(16).padStart(2, '0'));
        const bt: string[] = [];
        let bp = emu.cpu.reg[5] >>> 0;
        for (let f = 0; f < 10 && bp > 0x10000 && bp < 0xFFF00000; f++) {
          const retAddr = emu.memory.readU32((bp + 4) >>> 0);
          const prevBp = emu.memory.readU32(bp >>> 0);
          bt.push(`  [${f}] EBP=0x${bp.toString(16)} ret=0x${retAddr.toString(16)}`);
          bp = prevBp;
        }
        // 16-bit stack backtrace (BP chain within the stack segment)
        const bt16: string[] = [];
        if (emu.isNE) {
          const ssBase = emu.cpu.segBase(emu.cpu.ss);
          let bp16 = emu.cpu.reg[5] & 0xFFFF;
          for (let f = 0; f < 15 && bp16 > 0 && bp16 < 0xFFF0; f++) {
            const retIP = emu.memory.readU16(ssBase + bp16 + 2);
            const retCS = emu.memory.readU16(ssBase + bp16 + 4);
            const prevBP16 = emu.memory.readU16(ssBase + bp16);
            const retLinear = (emu.cpu.segBases.get(retCS) ?? (retCS * 16)) + retIP;
            bt16.push(`  [${f}] BP=0x${bp16.toString(16)} ret=${retCS.toString(16)}:${retIP.toString(16)} (linear=0x${retLinear.toString(16)})`);
            bp16 = prevBP16;
          }
        }
        // EIP history (last 64 instructions before crash)
        const hist: string[] = [];
        if (emu._eipHistory) {
          const idx = emu._eipHistIdx || 0;
          const arr = emu._eipHistory;
          for (let h = Math.max(0, idx - 32); h < idx; h++) {
            const addr = arr[h & 63];
            const bytes: string[] = [];
            for (let b = 0; b < 8; b++) bytes.push(emu.memory.readU8((addr + b) >>> 0).toString(16).padStart(2, '0'));
            hist.push(`    0x${addr.toString(16).padStart(5,'0')}: ${bytes.join(' ')}`);
          }
        }
        console.error(
          `[WILD EIP] jumped to 0x${newEip.toString(16)} from 0x${prevEip.toString(16)}\n` +
          `  CS=0x${emu.cpu.cs.toString(16)} SS=0x${emu.cpu.ss.toString(16)} DS=0x${emu.cpu.ds.toString(16)} ES=0x${emu.cpu.es.toString(16)}\n` +
          `  bytes before (at prev EIP): [${before.join(' ')}]\n` +
          `  bytes at (at new EIP):      [${at.join(' ')}]\n` +
          `  EAX=0x${(emu.cpu.reg[0] >>> 0).toString(16)} ECX=0x${(emu.cpu.reg[1] >>> 0).toString(16)} EDX=0x${(emu.cpu.reg[2] >>> 0).toString(16)} EBX=0x${(emu.cpu.reg[3] >>> 0).toString(16)}\n` +
          `  ESP=0x${(emu.cpu.reg[4] >>> 0).toString(16)} EBP=0x${(emu.cpu.reg[5] >>> 0).toString(16)} ESI=0x${(emu.cpu.reg[6] >>> 0).toString(16)} EDI=0x${(emu.cpu.reg[7] >>> 0).toString(16)}\n` +
          `  stack top 16 words:\n` +
          `    ${Array.from({length: 16}, (_, i) => '0x' + emu.memory.readU16(((emu.cpu.reg[4] >>> 0) + i * 2) >>> 0).toString(16).padStart(4, '0')).join(' ')}\n` +
          `  EIP history (last 32):\n${hist.join('\n')}\n` +
          `  EBP backtrace (32-bit):\n${bt.join('\n')}\n` +
          `  BP backtrace (16-bit):\n${bt16.join('\n')}\n` +
          `  THUNK TRACE (last ${emu._diagThunkSize}):\n${emu.diagThunkDump()}`
        );
        emu.haltReason = 'access violation';
        emu.halted = true;
        // WILD EIP detected
        break;
      }
    }
  }
  _diagInterpInsns += stepCount;
  _diagTickCount++;
  _diagTickTotalMs += performance.now() - tickStart;
  const now2 = performance.now();
  if (emu.wasmJitEnabled && now2 - _diagLastLog > 2000) {
    console.log(`[WASM-DIAG] ${_diagTickCount} ticks in ${_diagTickTotalMs.toFixed(0)}ms | WASM: ${_diagWasmRuns} runs, ${_diagWasmInsns} insns | Interp: ${_diagInterpInsns} insns | exits: ${JSON.stringify(_diagWasmExits)} | avg tick: ${(_diagTickTotalMs/_diagTickCount).toFixed(1)}ms | use32=${emu.cpu.use32} realMode=${emu.cpu.realMode}`);
    _diagWasmRuns = 0; _diagWasmInsns = 0; _diagInterpInsns = 0;
    _diagWasmExits = {}; _diagTickCount = 0; _diagTickTotalMs = 0;
    _diagLastLog = now2;
  }
  emu.cpuSteps += stepCount;
  emu._pitInsnCount += stepCount;
  // DOS heartbeat: log CS:IP + key regs once per ~500ms of wall clock so we
  // can tell a compute-bound infinite loop from genuine work (IP moving).
  if (emu.isDOS) {
    const nowHB = performance.now();
    const lastHB = (emu as any)._dbgHeartbeatMs ?? 0;
    if (nowHB - lastHB > 500) {
      (emu as any)._dbgHeartbeatMs = nowHB;
      const cs = emu.cpu.cs;
      const csBase = emu.cpu.realMode ? (cs * 16) >>> 0 : emu.cpu.segBase(cs);
      const ip = (emu.cpu.eip - csBase) >>> 0;
      const eax = emu.cpu.reg[0] >>> 0;
      const ebx = emu.cpu.reg[3] >>> 0;
      const ecx = emu.cpu.reg[1] >>> 0;
      const edx = emu.cpu.reg[2] >>> 0;
      const ds = emu.cpu.ds;
      const es = emu.cpu.es;
      const ss = emu.cpu.ss;
      const esp = emu.cpu.reg[4] >>> 0;
      const rm = emu.cpu.realMode ? 'RM' : 'PM';
      let bytes = '';
      for (let k = 0; k < 8; k++) bytes += emu.memory.readU8((emu.cpu.eip + k) >>> 0).toString(16).padStart(2, '0') + ' ';
      console.log(`[HB] ${rm} steps=${emu.cpuSteps} ${cs.toString(16)}:${ip.toString(16)} eax=${eax.toString(16)} ebx=${ebx.toString(16)} ecx=${ecx.toString(16)} edx=${edx.toString(16)} ds=${ds.toString(16)} es=${es.toString(16)} ss=${ss.toString(16)} esp=${esp.toString(16)} bytes=[${bytes.trim()}]`);
      // On the first RM heartbeat AFTER we've seen a DPMI entry (= post-V86
      // transition), dump 512 bytes around current EIP so we can disassemble
      // the looping code.
      if (emu.cpu.realMode && (emu as any)._dbgSawDpmiEntry && !(emu as any)._dbgDumpedLoopCode) {
        (emu as any)._dbgDumpedLoopCode = true;
        const dumpStart = (emu.cpu.eip - 0x100) >>> 0;
        let hex = '';
        for (let k = 0; k < 512; k++) {
          hex += emu.memory.readU8((dumpStart + k) >>> 0).toString(16).padStart(2, '0');
          if ((k & 15) === 15) hex += '\n';
          else hex += ' ';
        }
        console.log(`[LOOPDUMP] 512 bytes starting at linear 0x${dumpStart.toString(16)} (eip-0x100..+0x100):\n${hex}`);
      }
    }
  }
  } catch (err) {
    console.error(`[EMU] tick() error at EIP=0x${(emu.cpu.eip >>> 0).toString(16)}:`, err);
    emu.haltReason = 'internal emulator error';
    emu.halted = true;
  }

  emu._tickRunning = false;

  // Sync video memory for DOS mode.
  // Graphics mode: only sync when VBlank signals a complete frame (avoids tearing
  // from capturing a half-written framebuffer mid-copy).
  // Text mode: sync every tick (no tearing concern, direct B800:0000 writes).
  if (emu.isDOS) {
    if (emu.isGraphicsMode) {
      const now = performance.now();
      // Sync on VBlank (normal path), or every ~14ms as fallback for games
      // that don't poll 0x3DA (aligns with 70 Hz ≈ 14.28 ms frame time).
      if (emu.vga.pendingSync || now - emu.vga.lastSyncTime > 14) {
        emu.vga.pendingSync = false;
        emu.vga.lastSyncTime = now;
        syncGraphics(emu);
      }
    } else {
      syncVideoMemory(emu);
    }
  }

  // Flush audio at end of tick — ensures the AudioWorklet ring buffer is fed
  // even when scheduleImmediate starves setInterval's fill callback at 1x speed.
  if (emu.isDOS) emu.dosAudio.flushAudio();

  if (emu.running && !emu.halted && !emu.waitingForMessage) {
    emu._tickCount++;
    if (emu._dosHalted) {
      // HLT: sleep until next timer tick. Use scheduleImmediate for short
      // delays (≤4ms) to avoid setTimeout's 4ms clamping after nested calls.
      const pitReload = emu._pitCounters[0] || 0x10000;
      const timerIntervalMs = (pitReload / 1193182) * 1000;
      const elapsed = performance.now() - emu._dosLastTimerTick;
      const delay = timerIntervalMs - elapsed;
      if (delay <= 4) {
        scheduleImmediate(emu.tick);
      } else {
        setTimeout(emu.tick, delay);
      }
    } else if (emu.isDOS) {
      // DOS games need maximum throughput — MessageChannel avoids setTimeout's
      // 4ms clamping after 5 nested calls, giving near-zero inter-tick delay.
      if (emu.dosSpeedFactor < 1) {
        // Frame-locked throttling: reduced tick budget (tickMs = 16 * speed)
        // fills only part of each ~16.7ms rAF frame → smooth, predictable slowdown.
        requestAnimationFrame(emu.tick);
      } else {
        scheduleImmediate(emu.tick);
      }
    } else {
      requestAnimationFrame(emu.tick);
    }
  } else if (emu.waitingForMessage) {
    // Idle — waiting for input or message
  } else if (emu.halted) {
    if (emu.exitedNormally) {
      emu.onExit?.();
    } else if (!emu._crashFired) {
      emu._crashFired = true;
      const eip = '0x' + (emu.cpu.eip >>> 0).toString(16).padStart(8, '0');
      emu.onCrash?.(eip, emu.haltReason || 'unknown error');
    }
  }
}
