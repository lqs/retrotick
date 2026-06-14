import type { Emulator } from '../../emulator';
import type { BitmapInfo } from './types';
import {
  SRCCOPY, NOTSRCCOPY, SRCPAINT, SRCAND, SRCINVERT, BLACKNESS, WHITENESS,
  SIZEOF_BITMAP,
} from '../types';
import type { DCInfo } from './types';
import type { WindowInfo } from '../user32/types';
import { colorToCSS, disableSmoothing, STOCK_BASE } from './_helpers';
import { decodeDib } from '../../../pe/decode-dib';
import { dcPutImageData } from '../../emu-window';
import { resolvePaletteColors } from './palette';
import { emuCompleteThunk } from '../../emu-exec';

export function registerBitmap(emu: Emulator): void {
  const gdi32 = emu.registerDll('GDI32.DLL');

  gdi32.register('CreateCompatibleBitmap', 3, () => {
    const _hdc = emu.readArg(0);
    const width = emu.readArg(1);
    const height = emu.readArg(2);
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    disableSmoothing(ctx);
    const bmp: BitmapInfo = { width: w, height: h, canvas, ctx };
    return emu.handles.alloc('bitmap', bmp);
  });

  // CreateDiscardableBitmap is same as CreateCompatibleBitmap
  gdi32.register('CreateDiscardableBitmap', 3, () => {
    const _hdc = emu.readArg(0);
    const width = Math.max(1, emu.readArg(1));
    const height = Math.max(1, emu.readArg(2));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    disableSmoothing(ctx);
    const bmp: BitmapInfo = { width, height, canvas, ctx };
    return emu.handles.alloc('bitmap', bmp);
  });

  gdi32.register('CreateBitmap', 5, () => {
    const width = Math.max(1, emu.readArg(0));
    const height = Math.max(1, emu.readArg(1));
    const nPlanes = emu.readArg(2);
    const nBitCount = emu.readArg(3);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    disableSmoothing(ctx);
    const monochrome = (nPlanes === 1 && nBitCount === 1);
    return emu.handles.alloc('bitmap', { width, height, canvas, ctx, monochrome });
  });

  gdi32.register('CreateDIBSection', 6, () => {
    const _hdc = emu.readArg(0);
    const bmiPtr = emu.readArg(1);
    const _usage = emu.readArg(2);
    const bitsPtr = emu.readArg(3);

    // Read BITMAPINFOHEADER
    const width = Math.abs(emu.memory.readI32(bmiPtr + 4));
    const height = Math.abs(emu.memory.readI32(bmiPtr + 8));
    const bpp = emu.memory.readU16(bmiPtr + 14);
    const w = Math.max(1, width);
    const h = Math.max(1, height);

    // Allocate pixel buffer in emulated memory (stride aligned to 4 bytes)
    const stride = Math.floor((w * bpp + 31) / 32) * 4;
    const bufSize = stride * h;
    const pixelBuf = emu.allocHeap(bufSize);
    if (bitsPtr) emu.memory.writeU32(bitsPtr, pixelBuf);

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    disableSmoothing(ctx);
    const bmp: BitmapInfo = { width: w, height: h, canvas, ctx, dibBitsPtr: pixelBuf, dibBpp: bpp };
    return emu.handles.alloc('bitmap', bmp);
  });

  // GetDIBColorTable(hdc, iStart, cEntries, prgbq) — returns number of entries
  gdi32.register('GetDIBColorTable', 4, () => {
    const _hdc = emu.readArg(0);
    const _iStart = emu.readArg(1);
    const _cEntries = emu.readArg(2);
    const _prgbq = emu.readArg(3);
    // No color table stored — return 0 entries
    return 0;
  });

  gdi32.register('CreateDIBitmap', 6, () => {
    // CreateDIBitmap(hdc, lpbmih, fdwInit, lpbInit, lpbmi, fuUsage)
    const _hdc = emu.readArg(0);
    const bmihPtr = emu.readArg(1);
    const fdwInit = emu.readArg(2);
    const lpbInit = emu.readArg(3);
    const lpbmi = emu.readArg(4);
    const _fuUsage = emu.readArg(5);

    let width = 1, height = 1;
    if (bmihPtr) {
      width = Math.max(1, Math.abs(emu.memory.readI32(bmihPtr + 4)));
      height = Math.max(1, Math.abs(emu.memory.readI32(bmihPtr + 8)));
    }

    const CBM_INIT = 0x4;
    if ((fdwInit & CBM_INIT) && lpbInit && lpbmi) {
      // Decode the DIB: build a contiguous buffer from header (at lpbmi) + pixel data (at lpbInit)
      try {
        const biSize = emu.memory.readU32(lpbmi);
        const biBitCount = emu.memory.readU16(lpbmi + 14);
        const biClrUsed = emu.memory.readU32(lpbmi + 32);
        const nColors = biClrUsed > 0 ? biClrUsed : (biBitCount <= 8 ? (1 << biBitCount) : 0);
        const headerSize = biSize + nColors * 4;
        const absH = Math.abs(emu.memory.readI32(lpbmi + 8));
        const stride = Math.floor((width * biBitCount + 31) / 32) * 4;
        const imageSize = stride * absH;
        // Build contiguous DIB: header+colortable+pixels
        const dibBuf = new Uint8Array(headerSize + imageSize);
        for (let i = 0; i < headerSize; i++) dibBuf[i] = emu.memory.readU8(lpbmi + i);
        for (let i = 0; i < imageSize; i++) dibBuf[headerSize + i] = emu.memory.readU8(lpbInit + i);
        const decoded = decodeDib(dibBuf);
        const bmp: BitmapInfo = { width: decoded.width, height: decoded.height, canvas: decoded.canvas, ctx: decoded.ctx };
        return emu.handles.alloc('bitmap', bmp);
      } catch (e: unknown) {
        console.warn(`[GDI] CreateDIBitmap decode failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    disableSmoothing(ctx);
    return emu.handles.alloc('bitmap', { width, height, canvas, ctx });
  });

  gdi32.register('GetObjectA', 3, () => {
    const hObj = emu.readArg(0);
    const cbBuffer = emu.readArg(1);
    const bufPtr = emu.readArg(2);

    const bmp = emu.handles.get<BitmapInfo>(hObj);
    if (bmp && cbBuffer >= SIZEOF_BITMAP) {
      // Fill BITMAP structure
      const bitsPixel = bmp.monochrome ? 1 : (bmp.dibBpp || 32);
      const widthBytes = Math.floor((bmp.width * bitsPixel + 31) / 32) * 4;
      emu.memory.writeU32(bufPtr, 0);       // bmType
      emu.memory.writeU32(bufPtr + 4, bmp.width);  // bmWidth
      emu.memory.writeU32(bufPtr + 8, bmp.height); // bmHeight
      emu.memory.writeU32(bufPtr + 12, widthBytes); // bmWidthBytes
      emu.memory.writeU16(bufPtr + 16, 1);  // bmPlanes
      emu.memory.writeU16(bufPtr + 18, bitsPixel); // bmBitsPixel
      emu.memory.writeU32(bufPtr + 20, bmp.dibBitsPtr || 0);  // bmBits
      return SIZEOF_BITMAP;
    }
    return 0;
  });

  gdi32.register('GetObjectW', 3, emu.apiDefs.get('GDI32.DLL:GetObjectA')?.handler!);

  // int GetDIBits(HDC hdc, HBITMAP hbm, UINT start, UINT cLines,
  //               LPVOID lpvBits, LPBITMAPINFO lpbmi, UINT usage)
  // Reads pixels from a bitmap into the caller's BITMAPINFO + pixel buffer.
  // When lpvBits is NULL, only fills the BITMAPINFOHEADER (and palette) —
  // this is how MFC apps query "how big is this bitmap" before allocating
  // pixel storage. NOTE: previous arg count was 5 — wrong, it's 7 (28 bytes),
  // and the mismatch corrupted the stdcall stack on every call.
  gdi32.register('GetDIBits', 7, () => {
    const _hdc = emu.readArg(0);
    const hbm = emu.readArg(1);
    const startScan = emu.readArg(2);
    const cLines = emu.readArg(3);
    const lpvBits = emu.readArg(4);
    const lpbmi = emu.readArg(5);
    const _usage = emu.readArg(6);
    const bmp = emu.handles.get<BitmapInfo>(hbm);
    if (!bmp || !lpbmi) return 0;

    const w = bmp.width, h = bmp.height;

    // If lpvBits is NULL, just fill the header — Windows fills biWidth/Height
    // /BitCount/SizeImage so caller can size a buffer.
    if (!lpvBits) {
      const requestedBpp = emu.memory.readU16(lpbmi + 14);
      const bpp = requestedBpp || 32;
      const stride = Math.floor((w * bpp + 31) / 32) * 4;
      emu.memory.writeI32(lpbmi + 4, w);
      emu.memory.writeI32(lpbmi + 8, h);
      emu.memory.writeU16(lpbmi + 12, 1);
      emu.memory.writeU16(lpbmi + 14, bpp);
      emu.memory.writeU32(lpbmi + 16, 0);
      emu.memory.writeU32(lpbmi + 20, stride * h);
      return h;
    }

    // Read pixels from the bitmap canvas
    const ctx = bmp.ctx || bmp.canvas.getContext('2d')!;
    const imgData = ctx.getImageData(0, 0, w, h);
    const px = imgData.data;
    const bpp = emu.memory.readU16(lpbmi + 14) || 32;
    const stride = Math.floor((w * bpp + 31) / 32) * 4;
    // GetDIBits returns bottom-up by default
    for (let scan = 0; scan < cLines; scan++) {
      const dibRow = startScan + scan;
      const srcY = (h - 1) - dibRow;
      if (srcY < 0 || srcY >= h) continue;
      const rowDst = lpvBits + dibRow * stride;
      if (bpp === 32) {
        for (let x = 0; x < w; x++) {
          const off = (srcY * w + x) * 4;
          emu.memory.writeU8(rowDst + x * 4 + 0, px[off + 2]);
          emu.memory.writeU8(rowDst + x * 4 + 1, px[off + 1]);
          emu.memory.writeU8(rowDst + x * 4 + 2, px[off + 0]);
          emu.memory.writeU8(rowDst + x * 4 + 3, 0);
        }
      } else if (bpp === 24) {
        for (let x = 0; x < w; x++) {
          const off = (srcY * w + x) * 4;
          emu.memory.writeU8(rowDst + x * 3 + 0, px[off + 2]);
          emu.memory.writeU8(rowDst + x * 3 + 1, px[off + 1]);
          emu.memory.writeU8(rowDst + x * 3 + 2, px[off + 0]);
        }
      } else {
        return 0; // 1/4/8 bpp would need palette quantization — out of scope
      }
    }
    emu.memory.writeU32(lpbmi + 20, stride * h);
    return cLines;
  });

  gdi32.register('SetDIBitsToDevice', 12, () => {
    const hdc = emu.readArg(0);
    const xDest = emu.readArg(1) | 0;
    const yDest = emu.readArg(2) | 0;
    const width = emu.readArg(3);
    const height = emu.readArg(4);
    const xSrc = emu.readArg(5) | 0;
    const ySrc = emu.readArg(6) | 0;
    const startScan = emu.readArg(7);
    const numScans = emu.readArg(8);
    const bitsPtr = emu.readArg(9);
    const bmiPtr = emu.readArg(10);
    const fuUsage = emu.readArg(11);  // DIB_RGB_COLORS=0, DIB_PAL_COLORS=1

    const dc = emu.getDC(hdc);
    if (!dc || !bitsPtr || !bmiPtr) return 0;

    // Read BITMAPINFOHEADER
    const biSize = emu.memory.readU32(bmiPtr);
    const biWidth = Math.abs(emu.memory.readI32(bmiPtr + 4));
    const biHeight = emu.memory.readI32(bmiPtr + 8);
    const biBitCount = emu.memory.readU16(bmiPtr + 14);
    const biCompression = emu.memory.readU32(bmiPtr + 16);
    const biClrUsed = emu.memory.readU32(bmiPtr + 32);
    const isBottomUp = biHeight > 0;
    const absHeight = Math.abs(biHeight);

    if (biCompression !== 0) return 0; // Only support BI_RGB

    // Build palette for indexed formats
    const numColors = biClrUsed || (biBitCount <= 8 ? (1 << biBitCount) : 0);
    let palette: [number, number, number][];
    if (fuUsage === 1 && numColors > 0) {
      // DIB_PAL_COLORS: color table contains WORD indices into the DC's logical palette
      palette = resolvePaletteColors(emu, dc, bmiPtr, biSize, numColors);
    } else {
      palette = [];
      const paletteOffset = bmiPtr + biSize;
      for (let i = 0; i < numColors; i++) {
        const b = emu.memory.readU8(paletteOffset + i * 4);
        const g = emu.memory.readU8(paletteOffset + i * 4 + 1);
        const r = emu.memory.readU8(paletteOffset + i * 4 + 2);
        palette.push([r, g, b]);
      }
    }

    // Calculate row stride in the DIB data
    let paddedRow: number;
    if (biBitCount === 1) paddedRow = ((Math.ceil(biWidth / 8)) + 3) & ~3;
    else if (biBitCount === 4) paddedRow = ((Math.ceil(biWidth / 2)) + 3) & ~3;
    else if (biBitCount === 8) paddedRow = (biWidth + 3) & ~3;
    else if (biBitCount === 24) paddedRow = (biWidth * 3 + 3) & ~3;
    else if (biBitCount === 32) paddedRow = biWidth * 4;
    else return 0;

    const drawW = Math.min(width, biWidth - xSrc);
    const drawH = Math.min(height, absHeight);
    if (drawW <= 0 || drawH <= 0) return 0;

    const imgData = dc.ctx.createImageData(drawW, drawH);
    const px = imgData.data;

    // For each output row y (0 = top of output):
    // Bottom-up: output y=0 is the top -> scan line (ySrc + height - 1)
    //            output y=height-1 is the bottom -> scan line ySrc
    // Top-down:  output y=0 -> scan ySrc, output y=height-1 -> scan (ySrc + height - 1)
    // Buffer: row 0 in data = scan startScan, row N = scan startScan + N

    for (let y = 0; y < drawH; y++) {
      const scanLine = isBottomUp ? (ySrc + drawH - 1 - y) : (ySrc + y);
      const bufferRow = scanLine - startScan;
      if (bufferRow < 0 || bufferRow >= numScans) continue;

      const rowStart = bitsPtr + bufferRow * paddedRow;

      for (let x = 0; x < drawW; x++) {
        const sx = xSrc + x;
        const off = (y * drawW + x) * 4;
        let r = 0, g = 0, b = 0;

        if (biBitCount === 4) {
          const byteVal = emu.memory.readU8(rowStart + (sx >> 1));
          const idx = (sx & 1) === 0 ? (byteVal >> 4) & 0x0F : byteVal & 0x0F;
          [r, g, b] = palette[idx] || [0, 0, 0];
        } else if (biBitCount === 8) {
          const idx = emu.memory.readU8(rowStart + sx);
          [r, g, b] = palette[idx] || [0, 0, 0];
        } else if (biBitCount === 1) {
          const idx = (emu.memory.readU8(rowStart + (sx >> 3)) >> (7 - (sx & 7))) & 1;
          [r, g, b] = palette[idx] || [0, 0, 0];
        } else if (biBitCount === 24) {
          const srcOff = rowStart + sx * 3;
          b = emu.memory.readU8(srcOff);
          g = emu.memory.readU8(srcOff + 1);
          r = emu.memory.readU8(srcOff + 2);
        } else if (biBitCount === 32) {
          const srcOff = rowStart + sx * 4;
          b = emu.memory.readU8(srcOff);
          g = emu.memory.readU8(srcOff + 1);
          r = emu.memory.readU8(srcOff + 2);
        }

        px[off] = r; px[off + 1] = g; px[off + 2] = b; px[off + 3] = 255;
      }
    }

    dcPutImageData(dc, imgData, xDest, yDest);
    emu.syncDCToCanvas(hdc);
    return drawH;
  });

  // int StretchDIBits(HDC hdc, int xDest, int yDest, int destW, int destH,
  //                   int xSrc, int ySrc, int srcW, int srcH,
  //                   const VOID *lpBits, const BITMAPINFO *lpbmi,
  //                   UINT iUsage, DWORD rop)
  // Used by MFC's CToolBar to copy a resource bitmap (DIB data fetched via
  // FindResource/LockResource) into a CreateCompatibleBitmap canvas. Without
  // a real implementation the toolbar buttons remain blank.
  gdi32.register('StretchDIBits', 13, () => {
    const hdc = emu.readArg(0);
    const xDest = emu.readArg(1) | 0;
    const yDest = emu.readArg(2) | 0;
    const destW = emu.readArg(3) | 0;
    const destH = emu.readArg(4) | 0;
    const xSrc = emu.readArg(5) | 0;
    const ySrc = emu.readArg(6) | 0;
    const srcW = emu.readArg(7) | 0;
    const srcH = emu.readArg(8) | 0;
    const bitsPtr = emu.readArg(9);
    const bmiPtr = emu.readArg(10);
    const fuUsage = emu.readArg(11);
    const _rop = emu.readArg(12);

    const dc = emu.getDC(hdc);
    if (!dc || !bitsPtr || !bmiPtr || srcW <= 0 || srcH <= 0 || destW === 0 || destH === 0) return 0;

    const biSize = emu.memory.readU32(bmiPtr);
    const biWidth = Math.abs(emu.memory.readI32(bmiPtr + 4));
    const biHeight = emu.memory.readI32(bmiPtr + 8);
    const biBitCount = emu.memory.readU16(bmiPtr + 14);
    const biCompression = emu.memory.readU32(bmiPtr + 16);
    const biClrUsed = emu.memory.readU32(bmiPtr + 32);
    const isBottomUp = biHeight > 0;
    if (biCompression !== 0) return 0;

    const numColors = biClrUsed || (biBitCount <= 8 ? (1 << biBitCount) : 0);
    let palette: [number, number, number][];
    if (fuUsage === 1 && numColors > 0) {
      palette = resolvePaletteColors(emu, dc, bmiPtr, biSize, numColors);
    } else {
      palette = [];
      const paletteOffset = bmiPtr + biSize;
      for (let i = 0; i < numColors; i++) {
        const b = emu.memory.readU8(paletteOffset + i * 4);
        const g = emu.memory.readU8(paletteOffset + i * 4 + 1);
        const r = emu.memory.readU8(paletteOffset + i * 4 + 2);
        palette.push([r, g, b]);
      }
    }

    let paddedRow: number;
    if (biBitCount === 1) paddedRow = ((Math.ceil(biWidth / 8)) + 3) & ~3;
    else if (biBitCount === 4) paddedRow = ((Math.ceil(biWidth / 2)) + 3) & ~3;
    else if (biBitCount === 8) paddedRow = (biWidth + 3) & ~3;
    else if (biBitCount === 24) paddedRow = (biWidth * 3 + 3) & ~3;
    else if (biBitCount === 32) paddedRow = biWidth * 4;
    else return 0;

    // Decode the source rect into an ImageData, then drawImage with stretching.
    const imgData = dc.ctx.createImageData(srcW, srcH);
    const px = imgData.data;
    for (let y = 0; y < srcH; y++) {
      const scanLine = isBottomUp ? (ySrc + srcH - 1 - y) : (ySrc + y);
      if (scanLine < 0 || scanLine >= Math.abs(biHeight)) continue;
      const rowStart = bitsPtr + scanLine * paddedRow;
      for (let x = 0; x < srcW; x++) {
        const sx = xSrc + x;
        const off = (y * srcW + x) * 4;
        let r = 0, g = 0, b = 0;
        if (biBitCount === 4) {
          const byteVal = emu.memory.readU8(rowStart + (sx >> 1));
          const idx = (sx & 1) === 0 ? (byteVal >> 4) & 0x0F : byteVal & 0x0F;
          [r, g, b] = palette[idx] || [0, 0, 0];
        } else if (biBitCount === 8) {
          const idx = emu.memory.readU8(rowStart + sx);
          [r, g, b] = palette[idx] || [0, 0, 0];
        } else if (biBitCount === 1) {
          const idx = (emu.memory.readU8(rowStart + (sx >> 3)) >> (7 - (sx & 7))) & 1;
          [r, g, b] = palette[idx] || [0, 0, 0];
        } else if (biBitCount === 24) {
          const srcOff = rowStart + sx * 3;
          b = emu.memory.readU8(srcOff);
          g = emu.memory.readU8(srcOff + 1);
          r = emu.memory.readU8(srcOff + 2);
        } else if (biBitCount === 32) {
          const srcOff = rowStart + sx * 4;
          b = emu.memory.readU8(srcOff);
          g = emu.memory.readU8(srcOff + 1);
          r = emu.memory.readU8(srcOff + 2);
        }
        px[off] = r; px[off + 1] = g; px[off + 2] = b; px[off + 3] = 255;
      }
    }

    if (destW === srcW && destH === srcH) {
      dcPutImageData(dc, imgData, xDest, yDest);
    } else {
      // Stretch via intermediate canvas + drawImage (handles negative dimensions = mirror)
      const tmp = new OffscreenCanvas(srcW, srcH);
      tmp.getContext('2d')!.putImageData(imgData, 0, 0);
      const prevSmooth = dc.ctx.imageSmoothingEnabled;
      dc.ctx.imageSmoothingEnabled = false;
      const dx = destW < 0 ? xDest + destW : xDest;
      const dy = destH < 0 ? yDest + destH : yDest;
      dc.ctx.drawImage(tmp, dx, dy, Math.abs(destW), Math.abs(destH));
      dc.ctx.imageSmoothingEnabled = prevSmooth;
    }
    emu.syncDCToCanvas(hdc);
    return srcH;
  });
  gdi32.register('GetBitmapBits', 3, () => 0);

  gdi32.register('BitBlt', 9, () => {
    const hdcDest = emu.readArg(0);
    const xDst = emu.readArg(1) | 0;
    const yDst = emu.readArg(2) | 0;
    const width = emu.readArg(3);
    const height = emu.readArg(4);
    const hdcSrc = emu.readArg(5);
    const xSrc = emu.readArg(6) | 0;
    const ySrc = emu.readArg(7) | 0;
    const rop = emu.readArg(8);
    const dstDC = emu.getDC(hdcDest);
    if (!dstDC) return 0;
    if (width <= 0 || height <= 0 || width > 16384 || height > 16384) return 1;

    if (rop === BLACKNESS) {
      dstDC.ctx.fillStyle = '#000';
      dstDC.ctx.fillRect(xDst, yDst, width, height);
      emu.syncDCToCanvas(hdcDest);
      return 1;
    }
    if (rop === WHITENESS) {
      dstDC.ctx.fillStyle = '#fff';
      dstDC.ctx.fillRect(xDst, yDst, width, height);
      emu.syncDCToCanvas(hdcDest);
      return 1;
    }

    const srcDC = emu.getDC(hdcSrc);
    if (!srcDC) return 0;

    const srcBmp = emu.handles.get<BitmapInfo>(srcDC.selectedBitmap);
    const dstBmp = emu.handles.get<BitmapInfo>(dstDC.selectedBitmap);
    const srcMono = !!srcBmp?.monochrome;
    const dstMono = !!dstBmp?.monochrome;

    // Helper: get source pixels, applying mono↔color conversion as needed
    const getConvertedSrcData = (): ImageData => {
      const raw = srcDC.ctx.getImageData(xSrc, ySrc, width, height);
      const px = raw.data;
      if (srcMono && !dstMono) {
        // Mono→color: 0(black)→textColor, 1(white)→bkColor of dest DC
        const bk = dstDC.bkColor, tx = dstDC.textColor;
        const bkR = bk & 0xFF, bkG = (bk >> 8) & 0xFF, bkB = (bk >> 16) & 0xFF;
        const txR = tx & 0xFF, txG = (tx >> 8) & 0xFF, txB = (tx >> 16) & 0xFF;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] + px[i + 1] + px[i + 2] < 128 * 3) {
            px[i] = txR; px[i + 1] = txG; px[i + 2] = txB;
          } else {
            px[i] = bkR; px[i + 1] = bkG; px[i + 2] = bkB;
          }
          px[i + 3] = 255;
        }
      } else if (!srcMono && dstMono) {
        // Color→mono: pixels matching srcDC.bkColor → white(1), else → black(0)
        const bk = srcDC.bkColor;
        const bkR = bk & 0xFF, bkG = (bk >> 8) & 0xFF, bkB = (bk >> 16) & 0xFF;
        for (let i = 0; i < px.length; i += 4) {
          const match = px[i] === bkR && px[i + 1] === bkG && px[i + 2] === bkB;
          px[i] = px[i + 1] = px[i + 2] = match ? 255 : 0;
          px[i + 3] = 255;
        }
      }
      return raw;
    };

    // Helper: write result ImageData respecting canvas transforms
    const putResult = (imgData: ImageData) => {
      const tmp = new OffscreenCanvas(width, height);
      tmp.getContext('2d')!.putImageData(imgData, 0, 0);
      dstDC.ctx.drawImage(tmp, xDst, yDst);
    };

    // Helper: read destination pixels at transform-aware coordinates
    // getImageData() ignores canvas transforms, so we must apply them manually
    const getDstData = (): ImageData => {
      const t = dstDC.ctx.getTransform();
      const rawX = Math.round(t.e + xDst * t.a + yDst * t.c);
      const rawY = Math.round(t.f + xDst * t.b + yDst * t.d);
      return dstDC.ctx.getImageData(rawX, rawY, width, height);
    };

    const PSDPxax = 0x00B8074A;

    if (rop === SRCCOPY) {
      if (srcMono || dstMono) {
        putResult(getConvertedSrcData());
      } else {
        dstDC.ctx.drawImage(srcDC.canvas, xSrc, ySrc, width, height, xDst, yDst, width, height);
      }
      // Propagate RT_BITMAP origin from src DC's selected bitmap to dst bitmap
      // when the BitBlt copies from a resource bitmap. MFC CToolBar uses this
      // pattern: LoadBitmap → CreateCompatibleBitmap → BitBlt → TB_ADDBITMAP.
      // renderToolbar then falls back to a direct resource reload if the compat
      // bitmap canvas was lost in the transfer.
      if (dstBmp && srcDC.selectedBitmapResId !== undefined
          && dstBmp.resourceId === undefined) {
        dstBmp.resourceId = srcDC.selectedBitmapResId;
        dstBmp.resourceModule = srcDC.selectedBitmapResModule;
      }
    } else if (rop === NOTSRCCOPY) {
      const srcData = getConvertedSrcData();
      const px = srcData.data;
      for (let i = 0; i < px.length; i += 4) {
        px[i] = 255 - px[i]; px[i + 1] = 255 - px[i + 1]; px[i + 2] = 255 - px[i + 2];
      }
      putResult(srcData);
    } else if (rop === SRCPAINT) {
      // dst |= src
      const srcData = getConvertedSrcData();
      const dstData = getDstData();
      for (let i = 0; i < srcData.data.length; i += 4) {
        dstData.data[i] |= srcData.data[i];
        dstData.data[i + 1] |= srcData.data[i + 1];
        dstData.data[i + 2] |= srcData.data[i + 2];
      }
      putResult(dstData);
    } else if (rop === SRCAND) {
      // dst &= src
      const srcData = getConvertedSrcData();
      const dstData = getDstData();
      for (let i = 0; i < srcData.data.length; i += 4) {
        dstData.data[i] &= srcData.data[i];
        dstData.data[i + 1] &= srcData.data[i + 1];
        dstData.data[i + 2] &= srcData.data[i + 2];
      }
      putResult(dstData);
    } else if (rop === SRCINVERT) {
      // dst ^= src
      const srcData = getConvertedSrcData();
      const dstData = getDstData();
      for (let i = 0; i < srcData.data.length; i += 4) {
        dstData.data[i] ^= srcData.data[i];
        dstData.data[i + 1] ^= srcData.data[i + 1];
        dstData.data[i + 2] ^= srcData.data[i + 2];
      }
      putResult(dstData);
    } else if (rop === PSDPxax) {
      // Ternary ROP: where src=0 → pattern (brush), where src=1 → dest
      // P ^ (D & (P ^ S)) — with mono→color conversion applied first
      const srcData = getConvertedSrcData();
      const dstData = getDstData();
      const brush = emu.getBrush(dstDC.selectedBrush);
      const patColor = brush ? brush.color : 0;
      const pR = patColor & 0xFF, pG = (patColor >> 8) & 0xFF, pB = (patColor >> 16) & 0xFF;
      const sp = srcData.data, dp = dstData.data;
      for (let i = 0; i < sp.length; i += 4) {
        dp[i]     = pR ^ (dp[i]     & (pR ^ sp[i]));
        dp[i + 1] = pG ^ (dp[i + 1] & (pG ^ sp[i + 1]));
        dp[i + 2] = pB ^ (dp[i + 2] & (pB ^ sp[i + 2]));
      }
      putResult(dstData);
    } else {
      // Default: SRCCOPY
      dstDC.ctx.drawImage(srcDC.canvas, xSrc, ySrc, width, height, xDst, yDst, width, height);
    }

    emu.syncDCToCanvas(hdcDest);
    return 1;
  });

  // OpenGL pixel format / swap support
  gdi32.register('ChoosePixelFormat', 2, () => 1); // return pixel format index 1
  gdi32.register('DescribePixelFormat', 4, () => 1);
  gdi32.register('SetPixelFormat', 3, () => 1); // TRUE
  gdi32.register('SwapBuffers', 1, () => {
    const hdc = emu.readArg(0);
    const blitSwap = () => {
      const glc = emu.glContext;
      if (glc && emu.canvasCtx && emu.canvas) {
        // Determine destination rectangle from the DC's window
        const dc = hdc ? emu.handles.get<DCInfo>(hdc) : null;
        const hwnd = dc?.hwnd || emu.mainWindow;
        const wnd = hwnd ? emu.handles.get<WindowInfo>(hwnd) : null;
        const isChild = wnd && hwnd !== emu.mainWindow && (wnd.style & 0x40000000);

        glc.gl.flush();
        // Read viewport to blit only the rendered region
        const vp = glc.gl.getParameter(glc.gl.VIEWPORT) as Int32Array;
        const sx = vp[0], sy = vp[1], sw = vp[2], sh = vp[3];
        // GL viewport Y is bottom-up, canvas Y is top-down
        const srcY = glc.canvas.height - sy - sh;

        if (isChild) {
          // Draw at child window's position within the parent canvas
          let ox = 0, oy = 0;
          let cur: WindowInfo | null = wnd;
          while (cur && cur.hwnd !== emu.mainWindow) {
            ox += cur.x || 0;
            oy += cur.y || 0;
            cur = cur.parent ? emu.handles.get<WindowInfo>(cur.parent) : null;
          }
          emu.canvasCtx.drawImage(glc.canvas, sx, srcY, sw, sh, ox, oy, wnd.width, wnd.height);
        } else {
          emu.canvasCtx.drawImage(glc.canvas, sx, srcY, sw, sh, 0, 0, emu.canvas.width, emu.canvas.height);
        }
      }
    };

    // If glFinish already yielded in this frame, don't block again at SwapBuffers.
    if (emu.glSyncYieldedThisFrame) {
      blitSwap();
      emu.glSyncYieldedThisFrame = false;
      emu.glSyncAwaitingSwap = false;
      return 1;
    }

    const stackBytes = emu._currentThunkStackBytes;
    emu.glSyncYieldedThisFrame = true;
    emu.glSyncAwaitingSwap = false;
    emu.waitingForMessage = true;
    requestAnimationFrame(() => {
      blitSwap();
      emu.glSyncYieldedThisFrame = false;
      emu.glSyncAwaitingSwap = false;
      emu.waitingForMessage = false;
      emuCompleteThunk(emu, 1, stackBytes);
      if (emu.running && !emu.halted) requestAnimationFrame(emu.tick);
    });
    return undefined;
  });
  gdi32.register('GdiFlush', 0, () => 1); // TRUE
  gdi32.register('GdiSetBatchLimit', 1, () => 20); // return previous limit
  gdi32.register('GetSystemPaletteUse', 1, () => 1); // SYSPAL_STATIC
  gdi32.register('SetSystemPaletteUse', 2, () => 1); // prev value
  gdi32.register('SetDIBColorTable', 4, () => 0);
  // DWORD GetObjectType(HGDIOBJ h) — returns OBJ_* constant identifying the
  // handle's GDI type. MFC's CGdiObject::FromHandlePermanent uses this to
  // dispatch to the correct CGdiObject subclass; a stub of 0 makes MFC
  // mistreat valid handles as invalid.
  gdi32.register('GetObjectType', 1, () => {
    const h = emu.readArg(0);
    if (h >= STOCK_BASE) {
      const idx = h - STOCK_BASE;
      // Stock objects: WHITE_BRUSH..BLACK_BRUSH=0..4, NULL_BRUSH=5,
      // WHITE_PEN=6, BLACK_PEN=7, NULL_PEN=8, OEM_FIXED_FONT..ANSI_VAR_FONT=10..13,
      // DEFAULT_PALETTE=15, SYSTEM_FIXED_FONT=16, DEFAULT_GUI_FONT=17.
      if (idx >= 0 && idx <= 5) return 2;            // OBJ_BRUSH
      if (idx >= 6 && idx <= 8) return 1;            // OBJ_PEN
      if (idx >= 10 && idx <= 17) return 6;          // OBJ_FONT
      if (idx === 15) return 5;                       // OBJ_PAL
      return 0;
    }
    const objType = emu.handles.getType(h);
    if (objType === 'pen') return 1;
    if (objType === 'brush') return 2;
    if (objType === 'dc') return 3;       // OBJ_DC — caller can distinguish memdc via DC.hwnd==0
    if (objType === 'palette') return 5;
    if (objType === 'font') return 6;
    if (objType === 'bitmap') return 7;
    return 0;
  });
  gdi32.register('SetDIBits', 7, () => {
    // SetDIBits(hdc, hbm, uStartScan, cScanLines, lpvBits, lpbmi, fuColorUse)
    const _hdc = emu.readArg(0);
    const hbm = emu.readArg(1);
    const uStartScan = emu.readArg(2);
    const cScanLines = emu.readArg(3);
    const lpvBits = emu.readArg(4);
    const lpbmi = emu.readArg(5);

    const bmp = emu.handles.get<BitmapInfo>(hbm);
    if (!bmp || !bmp.dibBitsPtr || !lpvBits || !lpbmi) return 0;

    // Read source BITMAPINFO
    const srcWidth = Math.abs(emu.memory.readI32(lpbmi + 4));
    const srcHeight = Math.abs(emu.memory.readI32(lpbmi + 8));
    const srcBpp = emu.memory.readU16(lpbmi + 14);
    const biClrUsed = emu.memory.readU32(lpbmi + 32);

    const dstBpp = bmp.dibBpp || 24;
    const dstStride = Math.floor((bmp.width * dstBpp + 31) / 32) * 4;
    const srcStride = Math.floor((srcWidth * srcBpp + 31) / 32) * 4;

    // Read palette if needed
    const nColors = biClrUsed > 0 ? biClrUsed : (srcBpp <= 8 ? (1 << srcBpp) : 0);
    const palette: number[] = [];
    if (nColors > 0) {
      const palOff = lpbmi + 40; // after BITMAPINFOHEADER
      for (let i = 0; i < nColors; i++) {
        const b = emu.memory.readU8(palOff + i * 4);
        const g = emu.memory.readU8(palOff + i * 4 + 1);
        const r = emu.memory.readU8(palOff + i * 4 + 2);
        palette.push((r << 16) | (g << 8) | b);
      }
    }

    const lines = Math.min(cScanLines, srcHeight);
    for (let y = 0; y < lines; y++) {
      const srcRow = lpvBits + (uStartScan + y) * srcStride;
      const dstRow = bmp.dibBitsPtr + y * dstStride;

      for (let x = 0; x < bmp.width && x < srcWidth; x++) {
        let r = 0, g = 0, b = 0;
        if (srcBpp === 24) {
          b = emu.memory.readU8(srcRow + x * 3);
          g = emu.memory.readU8(srcRow + x * 3 + 1);
          r = emu.memory.readU8(srcRow + x * 3 + 2);
        } else if (srcBpp === 32) {
          b = emu.memory.readU8(srcRow + x * 4);
          g = emu.memory.readU8(srcRow + x * 4 + 1);
          r = emu.memory.readU8(srcRow + x * 4 + 2);
        } else if (srcBpp === 8) {
          const idx = emu.memory.readU8(srcRow + x);
          const c = palette[idx] || 0;
          r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
        } else if (srcBpp === 4) {
          const byteVal = emu.memory.readU8(srcRow + (x >> 1));
          const idx = (x & 1) === 0 ? (byteVal >> 4) : (byteVal & 0xF);
          const c = palette[idx] || 0;
          r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
        } else if (srcBpp === 1) {
          const byteVal = emu.memory.readU8(srcRow + (x >> 3));
          const bit = (byteVal >> (7 - (x & 7))) & 1;
          const c = palette[bit] || 0;
          r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
        }

        if (dstBpp === 24) {
          emu.memory.writeU8(dstRow + x * 3, b);
          emu.memory.writeU8(dstRow + x * 3 + 1, g);
          emu.memory.writeU8(dstRow + x * 3 + 2, r);
        } else if (dstBpp === 32) {
          emu.memory.writeU8(dstRow + x * 4, b);
          emu.memory.writeU8(dstRow + x * 4 + 1, g);
          emu.memory.writeU8(dstRow + x * 4 + 2, r);
          emu.memory.writeU8(dstRow + x * 4 + 3, 0xFF);
        }
      }
    }
    return lines;
  });

  gdi32.register('StretchBlt', 11, () => {
    const hdcDest = emu.readArg(0);
    const xDst = emu.readArg(1) | 0;
    const yDst = emu.readArg(2) | 0;
    const wDst = emu.readArg(3);
    const hDst = emu.readArg(4);
    const hdcSrc = emu.readArg(5);
    const xSrc = emu.readArg(6) | 0;
    const ySrc = emu.readArg(7) | 0;
    const wSrc = emu.readArg(8);
    const hSrc = emu.readArg(9);
    const _rop = emu.readArg(10);

    const dstDC = emu.getDC(hdcDest);
    const srcDC = emu.getDC(hdcSrc);
    if (!dstDC || !srcDC) return 0;

    dstDC.ctx.drawImage(srcDC.canvas, xSrc, ySrc, wSrc, hSrc, xDst, yDst, wDst, hDst);
    emu.syncDCToCanvas(hdcDest);
    return 1;
  });

  // MaskBlt(hdcDest, xDest, yDest, width, height, hdcSrc, xSrc, ySrc, hbmMask, xMask, yMask, rop)
  gdi32.register('MaskBlt', 12, () => 0);

  gdi32.register('PatBlt', 6, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const w = emu.readArg(3);
    const h = emu.readArg(4);
    const rop = emu.readArg(5);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    if (rop === BLACKNESS) {
      dc.ctx.fillStyle = '#000';
      dc.ctx.fillRect(x, y, w, h);
    } else if (rop === WHITENESS) {
      dc.ctx.fillStyle = '#fff';
      dc.ctx.fillRect(x, y, w, h);
    } else {
      // PATCOPY: fill with brush
      const brush = emu.getBrush(dc.selectedBrush);
      if (brush && !brush.isNull) {
        dc.ctx.fillStyle = colorToCSS(brush.color);
        dc.ctx.fillRect(x, y, w, h);
      }
    }

    emu.syncDCToCanvas(hdc);
    return 1;
  });
}
