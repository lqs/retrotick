// 32-bit launcher placed at PHYS_LAUNCHER by the loader. BIOS far-jumps here
// after enabling paging. We reset ESP, optionally load FS to the TEB selector,
// clear scratch registers, then jump to the user entry point.

// Note: by the time the launcher runs, paging is on. PHYS_LAUNCHER is in the
// identity-mapped first 16 MB, so the launcher's own bytes are at VA = PHYS.

export interface DllMainCall {
    entryVA: number;      // DllMain function VA
    hModule: number;      // DLL imageBase passed as first arg
}

export interface LauncherConfig {
    entryVA: number;
    stackTop: number;
    fsSelector?: number;   // 0 to skip
    /** DllMain calls to chain before jumping to entryVA. Each is invoked as
     *  DllMain(hModule, DLL_PROCESS_ATTACH=1, lpReserved=NULL) — stdcall,
     *  callee pops 12 bytes. Return value is discarded. */
    dllMains?: DllMainCall[];
    /** VA the launcher is placed at; needed for E8 (CALL rel32) displacement
     *  calculation. Defaults to PHYS_LAUNCHER. */
    launcherVA?: number;
}

export function buildLauncher(cfg: LauncherConfig): Uint8Array {
    const launcherVA = cfg.launcherVA ?? 0x100000;
    const bytes: number[] = [];

    const emit = (...b: number[]) => bytes.push(...b);

    // mov esp, stackTop
    emit(0xBC,
        cfg.stackTop & 0xFF, (cfg.stackTop >>> 8) & 0xFF,
        (cfg.stackTop >>> 16) & 0xFF, (cfg.stackTop >>> 24) & 0xFF);

    if (cfg.fsSelector) {
        // mov ax, fsSelector ; mov fs, ax
        emit(0x66, 0xB8, cfg.fsSelector & 0xFF, (cfg.fsSelector >>> 8) & 0xFF);
        emit(0x8E, 0xE0);
    }

    // Chain DLL_PROCESS_ATTACH calls before running the main entry.
    for (const dm of cfg.dllMains ?? []) {
        // push 0      ; lpReserved
        emit(0x6A, 0x00);
        // push 1      ; DLL_PROCESS_ATTACH
        emit(0x6A, 0x01);
        // push hModule
        emit(0x68,
            dm.hModule & 0xFF, (dm.hModule >>> 8) & 0xFF,
            (dm.hModule >>> 16) & 0xFF, (dm.hModule >>> 24) & 0xFF);
        // call DllMain (rel32). E8 is at current offset; rel32 follows; CPU
        // computes target = (launcherVA + currentOffset + 5) + rel32.
        const callInsnOff = bytes.length;
        const ripAfter = launcherVA + callInsnOff + 5;
        const rel32 = (dm.entryVA - ripAfter) | 0;
        emit(0xE8,
            rel32 & 0xFF, (rel32 >>> 8) & 0xFF,
            (rel32 >>> 16) & 0xFF, (rel32 >>> 24) & 0xFF);
        // Callee is stdcall and pops 12 bytes, so ESP is balanced on return.
    }

    // xor scratch regs (Win32 ABI doesn't require it but it's cleaner for tests)
    emit(0x31, 0xC0);                 // xor eax, eax
    emit(0x31, 0xC9);                 // xor ecx, ecx
    emit(0x31, 0xD2);                 // xor edx, edx
    emit(0x31, 0xDB);                 // xor ebx, ebx
    emit(0x31, 0xED);                 // xor ebp, ebp
    emit(0x31, 0xF6);                 // xor esi, esi
    emit(0x31, 0xFF);                 // xor edi, edi

    // jmp far 0x08:entryVA
    emit(0xEA,
        cfg.entryVA & 0xFF, (cfg.entryVA >>> 8) & 0xFF,
        (cfg.entryVA >>> 16) & 0xFF, (cfg.entryVA >>> 24) & 0xFF,
        0x08, 0x00);

    return new Uint8Array(bytes);
}
