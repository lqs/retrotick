// CP437 (DOS/OEM) to Unicode mapping for bytes 0x00-0xFF
// Bytes 0x20-0x7E map to identical Unicode code points (standard ASCII printable range)
// Bytes 0x00-0x1F and 0x7F-0xFF need special mapping

const CP437_TABLE: string[] = [
  // 0x00-0x0F: control chars displayed as symbols in DOS
  '\u0000', '\u263A', '\u263B', '\u2665', '\u2666', '\u2663', '\u2660', '\u2022',
  '\u25D8', '\u25CB', '\u25D9', '\u2642', '\u2640', '\u266A', '\u266B', '\u263C',
  // 0x10-0x1F
  '\u25BA', '\u25C4', '\u2195', '\u203C', '\u00B6', '\u00A7', '\u25AC', '\u21A8',
  '\u2191', '\u2193', '\u2192', '\u2190', '\u221F', '\u2194', '\u25B2', '\u25BC',
  // 0x20-0x7E: standard ASCII (identity mapping)
  ' ', '!', '"', '#', '$', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', ';', '<', '=', '>', '?',
  '@', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
  'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', '[', '\\', ']', '^', '_',
  '`', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
  'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '{', '|', '}', '~', '\u2302',
  // 0x80-0x8F: accented characters
  '\u00C7', '\u00FC', '\u00E9', '\u00E2', '\u00E4', '\u00E0', '\u00E5', '\u00E7',
  '\u00EA', '\u00EB', '\u00E8', '\u00EF', '\u00EE', '\u00EC', '\u00C4', '\u00C5',
  // 0x90-0x9F
  '\u00C9', '\u00E6', '\u00C6', '\u00F4', '\u00F6', '\u00F2', '\u00FB', '\u00F9',
  '\u00FF', '\u00D6', '\u00DC', '\u00A2', '\u00A3', '\u00A5', '\u20A7', '\u0192',
  // 0xA0-0xAF
  '\u00E1', '\u00ED', '\u00F3', '\u00FA', '\u00F1', '\u00D1', '\u00AA', '\u00BA',
  '\u00BF', '\u2310', '\u00AC', '\u00BD', '\u00BC', '\u00A1', '\u00AB', '\u00BB',
  // 0xB0-0xBF: box-drawing light
  '\u2591', '\u2592', '\u2593', '\u2502', '\u2524', '\u2561', '\u2562', '\u2556',
  '\u2555', '\u2563', '\u2551', '\u2557', '\u255D', '\u255C', '\u255B', '\u2510',
  // 0xC0-0xCF: box-drawing
  '\u2514', '\u2534', '\u252C', '\u251C', '\u2500', '\u253C', '\u255E', '\u255F',
  '\u255A', '\u2554', '\u2569', '\u2566', '\u2560', '\u2550', '\u256C', '\u2567',
  // 0xD0-0xDF
  '\u2568', '\u2564', '\u2565', '\u2559', '\u2558', '\u2552', '\u2553', '\u256B',
  '\u256A', '\u2518', '\u250C', '\u2588', '\u2584', '\u258C', '\u2590', '\u2580',
  // 0xE0-0xEF: Greek and math
  '\u03B1', '\u00DF', '\u0393', '\u03C0', '\u03A3', '\u03C3', '\u00B5', '\u03C4',
  '\u03A6', '\u0398', '\u03A9', '\u03B4', '\u221E', '\u03C6', '\u03B5', '\u2229',
  // 0xF0-0xFF
  '\u2261', '\u00B1', '\u2265', '\u2264', '\u2320', '\u2321', '\u00F7', '\u2248',
  '\u00B0', '\u2219', '\u00B7', '\u221A', '\u207F', '\u00B2', '\u25A0', '\u00A0',
];

/** Convert a CP437 byte (0-255) to its Unicode character */
export function cp437ToChar(byte: number): string {
  return CP437_TABLE[byte & 0xFF];
}

// Reverse map: Unicode code point → CP437 byte. Built from CP437_TABLE so the
// two never drift. Only the first byte that maps to a given code point wins
// (the table has no duplicate printable code points in 0x20-0xFF).
const UNICODE_TO_CP437 = new Map<number, number>();
for (let b = 0; b < 256; b++) {
  const cp = CP437_TABLE[b].codePointAt(0)!;
  if (!UNICODE_TO_CP437.has(cp)) UNICODE_TO_CP437.set(cp, b);
}

/**
 * Convert a Unicode code point to the CP437 byte that renders the same glyph,
 * for keyboard input destined to DOS/OEM programs (their keyboard buffer and
 * CP437 font expect OEM bytes, not Unicode). ASCII (≤0x7F) is identity. Code
 * points with a CP437 equivalent (accented letters, box-drawing, symbols) map
 * to that byte — e.g. 'à' U+00E0 → 0x85, 'é' U+00E9 → 0x82. Anything with no
 * CP437 glyph falls back to the low byte (legacy behavior, no regression).
 */
export function unicodeToCp437(codePoint: number): number {
  if (codePoint <= 0x7F) return codePoint;
  const b = UNICODE_TO_CP437.get(codePoint);
  return b !== undefined ? b : (codePoint & 0xFF);
}

/** Convert a CP437 byte array to a Unicode string */
export function cp437ToString(bytes: Uint8Array | number[], start = 0, length?: number): string {
  const end = length !== undefined ? start + length : bytes.length;
  let s = '';
  for (let i = start; i < end; i++) {
    s += CP437_TABLE[bytes[i] & 0xFF];
  }
  return s;
}
