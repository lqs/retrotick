// Shared import-normalization tables: ordinal→name maps for DLLs that export by
// ordinal, DLL-name aliases, and the set of cdecl DLLs. Used by both the legacy
// thunk builder (emu-thunks-pe.ts) and the v86 kernel import resolver
// (kernel-bootstrap.ts) so both paths resolve ordinal/aliased imports the same.

export const ORDINAL_MAP: Record<string, Record<number, string>> = {
    'COMCTL32.DLL': {
        2: 'MenuHelp', 4: 'GetEffectiveClientRect',
        7: 'CreateToolbar', 8: 'CreateMappedBitmap', 17: 'InitCommonControlsEx',
        71: 'ImageList_Create', 72: 'ImageList_Destroy', 73: 'ImageList_GetImageCount',
        74: 'ImageList_Add', 75: 'ImageList_ReplaceIcon', 76: 'ImageList_Remove',
        77: 'ImageList_Replace', 78: 'ImageList_AddMasked', 79: 'ImageList_Draw',
        84: 'ImageList_SetBkColor', 85: 'ImageList_GetBkColor',
        86: 'ImageList_SetOverlayImage', 87: 'ImageList_Draw',
        236: 'Str_SetPtrW',
        329: 'DSA_Destroy', 337: 'DPA_DeletePtr', 338: 'DPA_DeleteAllPtrs', 340: 'DPA_CreateEx',
        320: 'CreatePropertySheetPageA', 321: 'CreatePropertySheetPageW',
        322: 'DestroyPropertySheetPage',
        334: 'PropertySheetA', 335: 'PropertySheetW',
        358: 'StrChrW', 359: 'StrRChrW', 363: 'StrStrIW', 365: 'StrToIntW',
        410: 'FlatSB_SetScrollProp', 413: 'FlatSB_SetScrollInfo',
    },
    'SHLWAPI.DLL': {
        219: 'SHLoadIndirectString',
        437: 'IsOS',
    },
    'SHELL32.DLL': {
        30: 'PathBuildRootA', 34: 'PathRemoveBlanksA', 36: 'PathAppendA',
        39: 'PathIsRelativeA', 45: 'PathFileExistsA',
        61: 'ord_61', 100: 'ord_100',
        183: 'ShellMessageBoxA', 195: 'SHFree',
    },
    'WINMM.DLL': { 2: 'PlaySoundA' },
    'WS2_32.DLL': {
        1: 'accept', 2: 'bind', 3: 'closesocket', 4: 'connect',
        5: 'getpeername', 6: 'getsockname', 7: 'getsockopt',
        8: 'htonl', 9: 'htons', 10: 'ioctlsocket',
        11: 'inet_addr', 12: 'inet_ntoa', 13: 'listen',
        14: 'ntohl', 15: 'ntohs', 16: 'recv', 17: 'recvfrom',
        18: 'select', 19: 'send', 20: 'sendto', 21: 'setsockopt',
        22: 'shutdown', 23: 'socket',
        51: 'gethostbyaddr', 52: 'gethostbyname',
        53: 'getprotobyname', 54: 'getprotobynumber',
        55: 'getservbyname', 56: 'getservbyport', 57: 'gethostname',
        101: 'WSAStartup', 102: 'WSACleanup', 103: 'WSASetLastError',
        104: 'WSAGetLastError', 105: 'WSAIsBlocking', 108: 'WSACancelBlockingCall',
        111: 'WSAAsyncGetProtoByName', 112: 'WSAAsyncGetProtoByNumber',
        113: 'WSAAsyncGetHostByName', 114: 'WSAAsyncGetHostByAddr',
        115: 'WSACancelAsyncRequest', 116: 'WSAAsyncSelect',
    },
    'OLEAUT32.DLL': {
        2: 'SysAllocString', 3: 'SysReAllocString', 4: 'SysAllocStringLen',
        5: 'SysReAllocStringLen', 6: 'SysFreeString', 7: 'SysStringLen',
        8: 'VariantInit', 9: 'VariantClear', 10: 'VariantCopy',
        11: 'SafeArrayDestroy', 12: 'VariantChangeType',
        147: 'VariantChangeTypeEx',
        149: 'SysAllocStringLen', 150: 'SysFreeString', 151: 'SysStringLen',
    },
};

export const DLL_ALIASES: Record<string, string> = {
    'API-MS-WIN-CRT-RUNTIME-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-STDIO-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-STRING-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-MATH-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-HEAP-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-LOCALE-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-CONVERT-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-ENVIRONMENT-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-TIME-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-FILESYSTEM-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-UTILITY-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-MULTIBYTE-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-CONIO-L1-1-0.DLL': 'MSVCRT.DLL',
    'API-MS-WIN-CRT-PROCESS-L1-1-0.DLL': 'MSVCRT.DLL',
    'UCRTBASE.DLL': 'MSVCRT.DLL',
    'VCRUNTIME140.DLL': 'MSVCRT.DLL',
};

export const CDECL_DLLS = new Set([
    'MSVCRT.DLL', 'MSVCRT20.DLL', 'MSVCRT40.DLL',
    'MSVCR70.DLL', 'MSVCR71.DLL', 'MSVCR80.DLL', 'MSVCR90.DLL',
    'MSVCR100.DLL', 'MSVCR110.DLL', 'MSVCR120.DLL',
    'UCRTBASE.DLL', 'VCRUNTIME140.DLL',
]);

/** Normalize an import (DLL alias + ordinal→name) to its canonical (dll, name). */
export function normalizeImport(dll: string, name: string): { dll: string; name: string } {
    const aliased = DLL_ALIASES[dll] ?? dll;
    const m = /^ord_(\d+)$/.exec(name);
    if (m) {
        const resolved = ORDINAL_MAP[dll]?.[parseInt(m[1], 10)] ?? ORDINAL_MAP[aliased]?.[parseInt(m[1], 10)];
        if (resolved) return { dll: aliased, name: resolved };
    }
    return { dll: aliased, name };
}
