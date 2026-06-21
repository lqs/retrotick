// f64 → 80-bit extended (x87 F80) encoding, for pushing JS-computed results
// onto v86's hardware FPU stack (CRT math helpers: sin/cos/sqrt/...). v86 stores
// each FPU slot as {mantissa: u64, sign_exponent: u16}; the integer bit is
// explicit (bit 63 of mantissa).

const F64_VIEW = new DataView(new ArrayBuffer(8));

export function f64ToF80(v: number): { mantissa: bigint; signExp: number } {
    F64_VIEW.setFloat64(0, v, true);
    const bits = F64_VIEW.getBigUint64(0, true);
    const sign = Number((bits >> 63n) & 1n);
    const exp11 = Number((bits >> 52n) & 0x7FFn);
    const frac52 = bits & 0xFFFFFFFFFFFFFn;

    if (exp11 === 0x7FF) {
        // Inf (frac=0) or NaN.
        const mantissa = frac52 === 0n ? 0x8000000000000000n : 0xC000000000000000n;
        return { mantissa, signExp: (sign << 15) | 0x7FFF };
    }
    if (exp11 === 0) {
        if (frac52 === 0n) return { mantissa: 0n, signExp: sign << 15 }; // ±0
        // Denormal f64: normalize into F80 (which has far more exponent range).
        let m = frac52;
        let e = 1 - 1023 + 16383; // f64 denormal exponent base
        while ((m & 0x10000000000000n) === 0n) { m <<= 1n; e--; } // shift until bit52 set
        m &= 0xFFFFFFFFFFFFFn;                    // drop the now-implicit leading bit
        const mantissa = (1n << 63n) | (m << 11n);
        return { mantissa, signExp: (sign << 15) | (e & 0x7FFF) };
    }
    // Normal number.
    const f80exp = exp11 - 1023 + 16383;
    const mantissa = (1n << 63n) | (frac52 << 11n);
    return { mantissa, signExp: (sign << 15) | (f80exp & 0x7FFF) };
}
