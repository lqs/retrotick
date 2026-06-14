import type { Emulator } from '../emulator';

export function registerWinspool(emu: Emulator): void {
  const winspool = emu.registerDll('WINSPOOL.DRV');

  winspool.register('OpenPrinterA', 3, () => 0);  // failure
  winspool.register('OpenPrinterW', 3, () => 0);
  winspool.register('DocumentPropertiesA', 6, () => 0);
  winspool.register('GetPrinterDriverW', 6, () => 0);
  winspool.register('ClosePrinter', 1, () => 1);
  // BOOL GetJobA(HANDLE, DWORD JobId, DWORD Level, LPBYTE pJob, DWORD cbBuf, LPDWORD pcbNeeded)
  winspool.register('GetJobA', 6, () => {
    const pcbNeeded = emu.readArg(5);
    if (pcbNeeded) emu.memory.writeU32(pcbNeeded, 0);
    return 0; // failure
  });
  winspool.register('GetJobW', 6, () => {
    const pcbNeeded = emu.readArg(5);
    if (pcbNeeded) emu.memory.writeU32(pcbNeeded, 0);
    return 0;
  });

  // DocumentPropertiesW(hWnd, hPrinter, pDeviceName, pDevModeOutput, pDevModeInput, fMode) → LONG
  winspool.register('DocumentPropertiesW', 6, () => -1); // failure
  // GetDefaultPrinterW(pszBuffer, pcchBuffer) → BOOL
  winspool.register('GetDefaultPrinterW', 2, () => 0); // no printer
  // EnumPrintersW(Flags, Name, Level, pPrinterEnum, cbBuf, pcbNeeded, pcReturned) → BOOL
  winspool.register('EnumPrintersW', 7, () => {
    const pcbNeeded = emu.readArg(5);
    const pcReturned = emu.readArg(6);
    if (pcbNeeded) emu.memory.writeU32(pcbNeeded, 0);
    if (pcReturned) emu.memory.writeU32(pcReturned, 0);
    return 1; // success with 0 printers
  });
}
