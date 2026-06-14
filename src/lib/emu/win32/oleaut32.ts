import type { Emulator } from '../emulator';

export function registerOleaut32(emu: Emulator): void {
  const oleaut32 = emu.registerDll('OLEAUT32.DLL');

  // BSTR allocation helper: allocates [4-byte len][wchar data][null terminator]
  // Returns pointer to the string data (past the length prefix)
  function bstrAlloc(srcPtr: number, lenChars: number): number {
    const byteLen = lenChars * 2;
    const totalSize = 4 + byteLen + 2; // length prefix + data + null terminator
    const block = emu.allocHeap(totalSize);
    if (!block) return 0;
    // Write byte length prefix
    emu.memory.writeU32(block, byteLen);
    const bstr = block + 4;
    // Copy source data if provided
    if (srcPtr && lenChars > 0) {
      for (let i = 0; i < byteLen; i++) {
        emu.memory.writeU8(bstr + i, emu.memory.readU8(srcPtr + i));
      }
    } else {
      // Zero-fill
      for (let i = 0; i < byteLen; i++) {
        emu.memory.writeU8(bstr + i, 0);
      }
    }
    // Null terminator
    emu.memory.writeU16(bstr + byteLen, 0);
    return bstr;
  }

  // SysAllocStringLen(oleChar*, len) - allocates BSTR with given length
  oleaut32.register('SysAllocStringLen', 2, () => {
    const psz = emu.readArg(0);
    const len = emu.readArg(1);
    return bstrAlloc(psz, len);
  });

  // SysAllocString(oleChar*) - allocates BSTR from null-terminated wide string
  oleaut32.register('SysAllocString', 1, () => {
    const psz = emu.readArg(0);
    if (!psz) return 0;
    // Find length of null-terminated wide string
    let len = 0;
    while (emu.memory.readU16(psz + len * 2) !== 0) len++;
    return bstrAlloc(psz, len);
  });

  // SysReAllocStringLen(BSTR*, oleChar*, len)
  oleaut32.register('SysReAllocStringLen', 3, () => {
    const pbstr = emu.readArg(0);
    const psz = emu.readArg(1);
    const len = emu.readArg(2);
    const newBstr = bstrAlloc(psz, len);
    if (!newBstr) return 0; // FALSE
    // Free old BSTR (just overwrite pointer)
    if (pbstr) emu.memory.writeU32(pbstr, newBstr);
    return 1; // TRUE
  });

  // SysFreeString(BSTR)
  oleaut32.register('SysFreeString', 1, () => 0);

  // SysStringLen(BSTR) - returns length in characters
  oleaut32.register('SysStringLen', 1, () => {
    const bstr = emu.readArg(0);
    if (!bstr) return 0;
    const byteLen = emu.memory.readU32(bstr - 4);
    return byteLen >>> 1; // bytes to chars
  });

  oleaut32.register('VariantChangeTypeEx', 5, () => 0);
  oleaut32.register('VariantCopyInd', 2, () => 0);
  oleaut32.register('VariantClear', 1, () => 0);

  oleaut32.register('VariantInit', 1, () => {
    const ptr = emu.readArg(0);
    // VARIANT is 16 bytes, zero it out (VT_EMPTY = 0)
    if (ptr) for (let i = 0; i < 16; i++) emu.memory.writeU8(ptr + i, 0);
    return 0;
  });

  // GetErrorInfo(dwReserved, pperrinfo) → HRESULT
  oleaut32.register('GetErrorInfo', 2, () => {
    const pperrinfo = emu.readArg(1);
    if (pperrinfo) emu.memory.writeU32(pperrinfo, 0);
    return 1; // S_FALSE — no error info
  });

  // SafeArrayCreate(vt, cDims, rgsabound) — stub, return 0 (failure)
  oleaut32.register('SafeArrayCreate', 3, () => 0);
  // SafeArrayGetLBound(psa, nDim, plLbound) — stub
  oleaut32.register('SafeArrayGetLBound', 3, () => 0);
  // SafeArrayGetUBound(psa, nDim, plUbound) — stub
  oleaut32.register('SafeArrayGetUBound', 3, () => 0);
  // SafeArrayPtrOfIndex(psa, rgIndices, ppvData) — stub
  oleaut32.register('SafeArrayPtrOfIndex', 3, () => 0x80004005); // E_FAIL
  // SafeArrayDestroy(psa) — stub
  oleaut32.register('SafeArrayDestroy', 1, () => 0); // S_OK
  // SafeArrayDestroyData(psa) — stub
  oleaut32.register('SafeArrayDestroyData', 1, () => 0);
  // SafeArrayDestroyDescriptor(psa) — stub
  oleaut32.register('SafeArrayDestroyDescriptor', 1, () => 0);

  // SysStringByteLen(BSTR) — returns length in bytes (mirrors SysStringLen but in bytes)
  oleaut32.register('SysStringByteLen', 1, () => {
    const bstr = emu.readArg(0);
    if (!bstr) return 0;
    return emu.memory.readU32(bstr - 4);
  });

  // OleTranslateColor(clr, hpal, pcolorref) — translate OLE_COLOR to COLORREF
  // OLE_COLOR encoding: high byte 0=raw RGB, 1=palette index, 2=palette RGB, 0x80=system color index
  oleaut32.register('OleTranslateColor', 3, () => {
    const clr = emu.readArg(0) >>> 0;
    const pcolorref = emu.readArg(2);
    if (!pcolorref) return 0; // S_OK with null out is permissible per MSDN
    let colorref = clr & 0xFFFFFF;
    if ((clr & 0xFF000000) === 0x80000000) {
      // System color index — fall back to mid-gray approximation
      colorref = 0xC0C0C0;
    }
    emu.memory.writeU32(pcolorref, colorref);
    return 0; // S_OK
  });

  oleaut32.register('VariantCopy', 2, () => 0);
  oleaut32.register('VariantChangeType', 4, () => 0);

  // ord_277 = VarDateFromStr(strIn, lcid, dwFlags, pdateOut)
  oleaut32.register('ord_277', 4, () => {
    const pdateOut = emu.readArg(3);
    if (pdateOut) {
      // Write 0.0 as DATE (double) — epoch date
      emu.memory.writeU32(pdateOut, 0);
      emu.memory.writeU32(pdateOut + 4, 0);
    }
    return 0; // S_OK
  });

  // ord_94 = VarFormatNumber — 7 args
  oleaut32.register('ord_94', 7, () => 0x80004001); // E_NOTIMPL

  // --- VARIANT type constants ---
  const VT_EMPTY = 0, VT_NULL = 1, VT_I2 = 2, VT_I4 = 3, VT_R4 = 4, VT_R8 = 5;
  const VT_CY = 6, VT_DATE = 7, VT_BSTR = 8, VT_BOOL = 11;
  const VT_I1 = 16, VT_UI1 = 17, VT_UI2 = 18, VT_UI4 = 19, VT_INT = 22, VT_UINT = 23;
  const S_OK = 0;
  const DISP_E_TYPEMISMATCH = 0x80020005;
  const DISP_E_OVERFLOW = 0x8002000A;
  const _f64 = new Float64Array(1);
  const _u32 = new Uint32Array(_f64.buffer);
  const _f32 = new Float32Array(1);
  const _f32u = new Uint32Array(_f32.buffer);

  /** Read a VARIANT's numeric value as a JS number. Returns null for unsupported types. */
  function readVariantNum(ptr: number): number | null {
    const vt = emu.memory.readU16(ptr) & 0xFFF; // mask off VT_BYREF etc.
    const data = ptr + 8;
    switch (vt) {
      case VT_EMPTY: return 0;
      case VT_NULL: return null;
      case VT_I2: { const v = emu.memory.readU16(data); return (v << 16) >> 16; } // sign-extend
      case VT_I4: case VT_INT: return emu.memory.readI32(data);
      case VT_R4: { _f32u[0] = emu.memory.readU32(data); return _f32[0]; }
      case VT_R8: case VT_DATE: {
        _u32[0] = emu.memory.readU32(data);
        _u32[1] = emu.memory.readU32(data + 4);
        return _f64[0];
      }
      case VT_CY: {
        // Currency is a 64-bit int scaled by 10000
        const lo = emu.memory.readU32(data);
        const hi = emu.memory.readI32(data + 4);
        return (hi * 0x100000000 + lo) / 10000;
      }
      case VT_BOOL: { const v = emu.memory.readU16(data); return v === 0xFFFF ? -1 : 0; }
      case VT_I1: { const v = emu.memory.readU8(data); return (v << 24) >> 24; }
      case VT_UI1: return emu.memory.readU8(data);
      case VT_UI2: return emu.memory.readU16(data);
      case VT_UI4: case VT_UINT: return emu.memory.readU32(data);
      case VT_BSTR: {
        const bstr = emu.memory.readU32(data);
        if (!bstr) return 0;
        const str = emu.memory.readUTF16String(bstr);
        const n = Number(str);
        return isNaN(n) ? null : n;
      }
      default: return null;
    }
  }

  /** Get the VARTYPE of a variant */
  function readVarType(ptr: number): number {
    return emu.memory.readU16(ptr) & 0xFFF;
  }

  /** Write a numeric result into a VARIANT, choosing an appropriate output type */
  function writeVariantResult(ptr: number, value: number, preferType: number): void {
    // Zero the variant first
    for (let i = 0; i < 16; i++) emu.memory.writeU8(ptr + i, 0);
    const data = ptr + 8;
    switch (preferType) {
      case VT_I2: emu.memory.writeU16(ptr, VT_I2); emu.memory.writeU16(data, value & 0xFFFF); break;
      case VT_I4: case VT_INT: emu.memory.writeU16(ptr, VT_I4); emu.memory.writeU32(data, value | 0); break;
      case VT_BOOL: emu.memory.writeU16(ptr, VT_BOOL); emu.memory.writeU16(data, value ? 0xFFFF : 0); break;
      case VT_CY: {
        emu.memory.writeU16(ptr, VT_CY);
        const scaled = Math.round(value * 10000);
        emu.memory.writeU32(data, scaled & 0xFFFFFFFF);
        emu.memory.writeI32(data + 4, Math.floor(scaled / 0x100000000));
        break;
      }
      case VT_R4: {
        emu.memory.writeU16(ptr, VT_R4);
        _f32[0] = value;
        emu.memory.writeU32(data, _f32u[0]);
        break;
      }
      default: // VT_R8, VT_DATE, or fallback
        emu.memory.writeU16(ptr, preferType === VT_DATE ? VT_DATE : VT_R8);
        _f64[0] = value;
        emu.memory.writeU32(data, _u32[0]);
        emu.memory.writeU32(data + 4, _u32[1]);
        break;
    }
  }

  /** Choose the result type for a binary arithmetic operation (type coercion rules) */
  function coerceArithType(vtL: number, vtR: number): number {
    // If either is R8 or DATE, result is R8
    if (vtL === VT_R8 || vtR === VT_R8 || vtL === VT_DATE || vtR === VT_DATE) return VT_R8;
    if (vtL === VT_R4 || vtR === VT_R4) return VT_R4;
    if (vtL === VT_CY || vtR === VT_CY) return VT_CY;
    if (vtL === VT_I4 || vtR === VT_I4 || vtL === VT_INT || vtR === VT_INT) return VT_I4;
    if (vtL === VT_BSTR || vtR === VT_BSTR) return VT_R8;
    return VT_I4; // default for small int types
  }

  // --- OLE Variant arithmetic ---

  // VarNeg(pvarIn, pvarOut) — negate variant
  oleaut32.register('VarNeg', 2, () => {
    const pIn = emu.readArg(0);
    const pOut = emu.readArg(1);
    const val = readVariantNum(pIn);
    if (val === null) return DISP_E_TYPEMISMATCH;
    const vt = readVarType(pIn);
    writeVariantResult(pOut, -val, vt === VT_BOOL ? VT_I2 : vt);
    return S_OK;
  });

  // VarNot(pvarIn, pvarOut) — bitwise NOT
  oleaut32.register('VarNot', 2, () => {
    const pIn = emu.readArg(0);
    const pOut = emu.readArg(1);
    const val = readVariantNum(pIn);
    if (val === null) return DISP_E_TYPEMISMATCH;
    const vt = readVarType(pIn);
    if (vt === VT_BOOL) {
      writeVariantResult(pOut, val === 0 ? -1 : 0, VT_BOOL);
    } else {
      writeVariantResult(pOut, ~(val | 0), vt === VT_I2 ? VT_I2 : VT_I4);
    }
    return S_OK;
  });

  // Binary arithmetic helper
  function varBinaryOp(op: (a: number, b: number) => number | null): () => number {
    return () => {
      const pL = emu.readArg(0);
      const pR = emu.readArg(1);
      const pOut = emu.readArg(2);
      const a = readVariantNum(pL);
      const b = readVariantNum(pR);
      if (a === null || b === null) return DISP_E_TYPEMISMATCH;
      const result = op(a, b);
      if (result === null) return DISP_E_OVERFLOW;
      const outType = coerceArithType(readVarType(pL), readVarType(pR));
      writeVariantResult(pOut, result, outType);
      return S_OK;
    };
  }

  oleaut32.register('VarAdd', 3, varBinaryOp((a, b) => a + b));
  oleaut32.register('VarSub', 3, varBinaryOp((a, b) => a - b));
  oleaut32.register('VarMul', 3, varBinaryOp((a, b) => a * b));
  oleaut32.register('VarDiv', 3, varBinaryOp((a, b) => b === 0 ? null : a / b));
  oleaut32.register('VarIdiv', 3, varBinaryOp((a, b) => b === 0 ? null : Math.trunc(a / b)));
  oleaut32.register('VarMod', 3, varBinaryOp((a, b) => b === 0 ? null : a % b));

  // Bitwise ops — operate on integer values
  oleaut32.register('VarAnd', 3, varBinaryOp((a, b) => (a | 0) & (b | 0)));
  oleaut32.register('VarOr', 3, varBinaryOp((a, b) => (a | 0) | (b | 0)));
  oleaut32.register('VarXor', 3, varBinaryOp((a, b) => (a | 0) ^ (b | 0)));

  // VarCmp(left, right, lcid, flags) — compare two variants
  const VARCMP_LT = 0, VARCMP_EQ = 1, VARCMP_GT = 2, VARCMP_NULL = 3;
  oleaut32.register('VarCmp', 4, () => {
    const pL = emu.readArg(0);
    const pR = emu.readArg(1);
    const vtL = readVarType(pL);
    const vtR = readVarType(pR);
    if (vtL === VT_NULL || vtR === VT_NULL) return VARCMP_NULL;
    // Try BSTR string comparison first
    if (vtL === VT_BSTR && vtR === VT_BSTR) {
      const bstrL = emu.memory.readU32(pL + 8);
      const bstrR = emu.memory.readU32(pR + 8);
      const sL = bstrL ? emu.memory.readUTF16String(bstrL) : '';
      const sR = bstrR ? emu.memory.readUTF16String(bstrR) : '';
      if (sL < sR) return VARCMP_LT;
      if (sL > sR) return VARCMP_GT;
      return VARCMP_EQ;
    }
    const a = readVariantNum(pL);
    const b = readVariantNum(pR);
    if (a === null || b === null) return VARCMP_NULL;
    if (a < b) return VARCMP_LT;
    if (a > b) return VARCMP_GT;
    return VARCMP_EQ;
  });

  // --- VarXxxFromStr: string-to-type conversions ---

  // VarI4FromStr(strIn, lcid, dwFlags, plOut)
  oleaut32.register('VarI4FromStr', 4, () => {
    const strPtr = emu.readArg(0);
    const plOut = emu.readArg(3);
    if (!strPtr || !plOut) return DISP_E_TYPEMISMATCH;
    const str = emu.memory.readUTF16String(strPtr);
    const val = parseInt(str, 10);
    if (isNaN(val)) return DISP_E_TYPEMISMATCH;
    if (val < -2147483648 || val > 2147483647) return DISP_E_OVERFLOW;
    emu.memory.writeI32(plOut, val);
    return S_OK;
  });

  // VarR4FromStr(strIn, lcid, dwFlags, pfltOut)
  oleaut32.register('VarR4FromStr', 4, () => {
    const strPtr = emu.readArg(0);
    const pfltOut = emu.readArg(3);
    if (!strPtr || !pfltOut) return DISP_E_TYPEMISMATCH;
    const str = emu.memory.readUTF16String(strPtr);
    const val = parseFloat(str);
    if (isNaN(val)) return DISP_E_TYPEMISMATCH;
    _f32[0] = val;
    emu.memory.writeU32(pfltOut, _f32u[0]);
    return S_OK;
  });

  // VarR8FromStr(strIn, lcid, dwFlags, pdblOut)
  oleaut32.register('VarR8FromStr', 4, () => {
    const strPtr = emu.readArg(0);
    const pdblOut = emu.readArg(3);
    if (!strPtr || !pdblOut) return DISP_E_TYPEMISMATCH;
    const str = emu.memory.readUTF16String(strPtr);
    const val = parseFloat(str);
    if (isNaN(val)) return DISP_E_TYPEMISMATCH;
    _f64[0] = val;
    emu.memory.writeU32(pdblOut, _u32[0]);
    emu.memory.writeU32(pdblOut + 4, _u32[1]);
    return S_OK;
  });

  // VarDateFromStr(strIn, lcid, dwFlags, pdateOut)
  oleaut32.register('VarDateFromStr', 4, () => {
    const strPtr = emu.readArg(0);
    const pdateOut = emu.readArg(3);
    if (!strPtr || !pdateOut) return DISP_E_TYPEMISMATCH;
    const str = emu.memory.readUTF16String(strPtr);
    const ms = Date.parse(str);
    if (isNaN(ms)) return DISP_E_TYPEMISMATCH;
    // OLE DATE: days since Dec 30, 1899
    const oleDate = (ms / 86400000) + 25569;
    _f64[0] = oleDate;
    emu.memory.writeU32(pdateOut, _u32[0]);
    emu.memory.writeU32(pdateOut + 4, _u32[1]);
    return S_OK;
  });

  // VarCyFromStr(strIn, lcid, dwFlags, pcyOut)
  oleaut32.register('VarCyFromStr', 4, () => {
    const strPtr = emu.readArg(0);
    const pcyOut = emu.readArg(3);
    if (!strPtr || !pcyOut) return DISP_E_TYPEMISMATCH;
    const str = emu.memory.readUTF16String(strPtr).replace(/[,$]/g, '');
    const val = parseFloat(str);
    if (isNaN(val)) return DISP_E_TYPEMISMATCH;
    const scaled = Math.round(val * 10000);
    emu.memory.writeU32(pcyOut, scaled & 0xFFFFFFFF);
    emu.memory.writeI32(pcyOut + 4, Math.floor(scaled / 0x100000000));
    return S_OK;
  });

  // VarBoolFromStr(strIn, lcid, dwFlags, pboolOut)
  oleaut32.register('VarBoolFromStr', 4, () => {
    const strPtr = emu.readArg(0);
    const pboolOut = emu.readArg(3);
    if (!strPtr || !pboolOut) return DISP_E_TYPEMISMATCH;
    const str = emu.memory.readUTF16String(strPtr).trim().toLowerCase();
    let val: boolean;
    if (str === 'true' || str === '#true#' || str === '-1' || str === '1') val = true;
    else if (str === 'false' || str === '#false#' || str === '0') val = false;
    else return DISP_E_TYPEMISMATCH;
    emu.memory.writeU16(pboolOut, val ? 0xFFFF : 0); // VARIANT_TRUE=-1, VARIANT_FALSE=0
    return S_OK;
  });

  // --- VarBstrFromXxx: type-to-BSTR conversions ---

  function allocBstrFromStr(s: string): number {
    const ptr = emu.allocHeap(4 + s.length * 2 + 2);
    if (!ptr) return 0;
    emu.memory.writeU32(ptr, s.length * 2);
    for (let i = 0; i < s.length; i++) {
      emu.memory.writeU16(ptr + 4 + i * 2, s.charCodeAt(i));
    }
    emu.memory.writeU16(ptr + 4 + s.length * 2, 0);
    return ptr + 4;
  }

  // VarBstrFromCy(cyIn, lcid, dwFlags, pbstrOut) — cyIn is 8 bytes passed by value
  oleaut32.register('VarBstrFromCy', 4, () => {
    const lo = emu.readArg(0);
    const hi = emu.readArg(1) | 0;
    // arg2=lcid, arg3=dwFlags — shifted because cyIn takes 2 stack slots
    const pbstrOut = emu.readArg(4);
    if (!pbstrOut) return DISP_E_TYPEMISMATCH;
    const scaled = hi * 0x100000000 + (lo >>> 0);
    const val = scaled / 10000;
    const bstr = allocBstrFromStr(val.toFixed(4));
    if (!bstr) return 0x8007000E; // E_OUTOFMEMORY
    emu.memory.writeU32(pbstrOut, bstr);
    return S_OK;
  });

  // VarBstrFromDate(dateIn, lcid, dwFlags, pbstrOut) — dateIn is 8 bytes (double)
  oleaut32.register('VarBstrFromDate', 4, () => {
    _u32[0] = emu.readArg(0);
    _u32[1] = emu.readArg(1);
    // arg2=lcid, arg3=dwFlags — shifted because dateIn takes 2 stack slots
    const pbstrOut = emu.readArg(4);
    if (!pbstrOut) return DISP_E_TYPEMISMATCH;
    const oleDate = _f64[0];
    const ms = (oleDate - 25569) * 86400000;
    const d = new Date(ms);
    const str = d.toLocaleDateString('en-US');
    const bstr = allocBstrFromStr(str);
    if (!bstr) return 0x8007000E;
    emu.memory.writeU32(pbstrOut, bstr);
    return S_OK;
  });

  // VarBstrFromR4(fltIn, lcid, dwFlags, pbstrOut)
  oleaut32.register('VarBstrFromR4', 4, () => {
    _f32u[0] = emu.readArg(0);
    const pbstrOut = emu.readArg(3);
    if (!pbstrOut) return DISP_E_TYPEMISMATCH;
    const bstr = allocBstrFromStr(_f32[0].toString());
    if (!bstr) return 0x8007000E;
    emu.memory.writeU32(pbstrOut, bstr);
    return S_OK;
  });

  // VarBstrFromR8(dblIn, lcid, dwFlags, pbstrOut) — dblIn takes 2 stack slots
  oleaut32.register('VarBstrFromR8', 4, () => {
    _u32[0] = emu.readArg(0);
    _u32[1] = emu.readArg(1);
    const pbstrOut = emu.readArg(4);
    if (!pbstrOut) return DISP_E_TYPEMISMATCH;
    const bstr = allocBstrFromStr(_f64[0].toString());
    if (!bstr) return 0x8007000E;
    emu.memory.writeU32(pbstrOut, bstr);
    return S_OK;
  });

  // VarBstrFromI2(iIn, lcid, dwFlags, pbstrOut)
  oleaut32.register('VarBstrFromI2', 4, () => {
    const v = (emu.readArg(0) << 16) >> 16; // sign-extend 16-bit
    const pbstrOut = emu.readArg(3);
    if (!pbstrOut) return DISP_E_TYPEMISMATCH;
    const bstr = allocBstrFromStr(v.toString());
    if (!bstr) return 0x8007000E;
    emu.memory.writeU32(pbstrOut, bstr);
    return S_OK;
  });

  // VarBstrFromI4(lIn, lcid, dwFlags, pbstrOut)
  oleaut32.register('VarBstrFromI4', 4, () => {
    const v = emu.readArg(0) | 0; // signed 32-bit
    const pbstrOut = emu.readArg(3);
    if (!pbstrOut) return DISP_E_TYPEMISMATCH;
    const bstr = allocBstrFromStr(v.toString());
    if (!bstr) return 0x8007000E;
    emu.memory.writeU32(pbstrOut, bstr);
    return S_OK;
  });

  // VarBstrFromBool(boolIn, lcid, dwFlags, pbstrOut)
  oleaut32.register('VarBstrFromBool', 4, () => {
    const boolIn = emu.readArg(0) & 0xFFFF;
    const pbstrOut = emu.readArg(3);
    if (!pbstrOut) return DISP_E_TYPEMISMATCH;
    const str = boolIn !== 0 ? 'True' : 'False';
    const bstr = allocBstrFromStr(str);
    if (!bstr) return 0x8007000E;
    emu.memory.writeU32(pbstrOut, bstr);
    return S_OK;
  });

  // ord_185 = SysAllocStringByteLen(psz, len) — 2 args
  oleaut32.register('ord_185', 2, () => {
    const psz = emu.readArg(0);
    const len = emu.readArg(1);
    // Allocate BSTR: 4 byte length prefix + string data + 2 byte null
    const ptr = emu.allocHeap(4 + len + 2);
    if (!ptr) return 0;
    emu.memory.writeU32(ptr, len);
    if (psz) {
      for (let i = 0; i < len; i++) {
        emu.memory.writeU8(ptr + 4 + i, emu.memory.readU8(psz + i));
      }
    }
    emu.memory.writeU16(ptr + 4 + len, 0);
    return ptr + 4; // BSTR points past the length prefix
  });
}
