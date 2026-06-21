import type { Emulator } from '../emulator';

// DirectDraw COM interface emulation
// IDirectDraw7 vtable offsets (each method = 4 bytes)
// 0x00 QueryInterface, 0x04 AddRef, 0x08 Release
// 0x0C Compact, 0x10 CreateClipper, 0x14 CreatePalette, 0x18 CreateSurface
// 0x1C DuplicateSurface, 0x20 EnumDisplayModes, 0x24 EnumSurfaces
// 0x28 FlipToGDISurface, 0x2C GetCaps, 0x30 GetDisplayMode
// 0x34 GetFourCCCodes, 0x38 GetGDISurface, 0x3C GetMonitorFrequency
// 0x40 GetScanLine, 0x44 GetVerticalBlankStatus, 0x48 Initialize
// 0x4C RestoreDisplayMode, 0x50 SetCooperativeLevel, 0x54 SetDisplayMode
// 0x58 WaitForVerticalBlank, 0x5C GetAvailableVidMem, 0x60 GetSurfaceFromDC
// 0x64 RestoreAllSurfaces, 0x68 TestCooperativeLevel, 0x6C GetDeviceIdentifier
// 0x70 StartModeTest, 0x74 EvaluateMode
const DD7_VTABLE_SIZE = 30; // 30 methods

// IDirectDrawSurface7 vtable offsets
// 0x00 QueryInterface, 0x04 AddRef, 0x08 Release
// 0x0C AddAttachedSurface, 0x10 AddOverlayDirtyRect, 0x14 Blt
// 0x18 BltBatch, 0x1C BltFast, 0x20 DeleteAttachedSurface
// 0x24 EnumAttachedSurfaces, 0x28 EnumOverlayZOrders, 0x2C Flip
// 0x30 GetAttachedSurface, 0x34 GetBltStatus, 0x38 GetCaps
// 0x3C GetClipper, 0x40 GetColorKey, 0x44 GetDC, 0x48 GetFlipStatus
// 0x4C GetOverlayPosition, 0x50 GetPalette, 0x54 GetPixelFormat
// 0x58 GetSurfaceDesc, 0x5C Initialize, 0x60 IsLost
// 0x64 Lock, 0x68 ReleaseDC, 0x6C Restore, 0x70 SetClipper
// 0x74 SetColorKey, 0x78 SetOverlayPosition, 0x7C SetPalette
// 0x80 Unlock, 0x84 UpdateOverlay, 0x88 UpdateOverlayDisplay
// 0x8C UpdateOverlayZOrder, 0x90 GetDDInterface, 0x94 PageLock
// 0x98 PageUnlock, 0x9C SetSurfaceDesc, 0xA0 SetPrivateData
// 0xA4 GetPrivateData, 0xA8 FreePrivateData, 0xAC GetUniquenessValue
// 0xB0 ChangeUniquenessValue, 0xB4 SetPriority, 0xB8 GetPriority
// 0xBC SetLOD, 0xC0 GetLOD
const DDS7_VTABLE_SIZE = 49; // 49 methods

// IDirectDrawClipper vtable: QI, AddRef, Release, GetClipList, GetHWnd, Initialize, IsClipListChanged, SetClipList, SetHWnd
const DDC_VTABLE_SIZE = 9;

// IDirectDrawPalette vtable: QI, AddRef, Release, GetCaps, GetEntries, Initialize, SetEntries
const DDP_VTABLE_SIZE = 7;

// DDSCAPS2 flags
const DDSCAPS_PRIMARYSURFACE = 0x00000200;
const DDSCAPS_BACKBUFFER = 0x00000004;
const DDSCAPS_FLIP = 0x00000010;
const DDSCAPS_COMPLEX = 0x00000008;

// DDSD flags
const DDSD_CAPS = 0x00000001;
const DDSD_HEIGHT = 0x00000002;
const DDSD_WIDTH = 0x00000004;
const DDSD_PITCH = 0x00000008;
const DDSD_BACKBUFFERCOUNT = 0x00000020;
const DDSD_PIXELFORMAT = 0x00001000;
const DDSD_LPSURFACE = 0x00000800;

// DDPF flags
const DDPF_PALETTEINDEXED8 = 0x00000020;
const DDPF_RGB = 0x00000040;

// HRESULT codes
const DD_OK = 0;
const DDERR_GENERIC = 0x80004005;
const E_NOINTERFACE = 0x80004002;
// GUID.Data1 (first u32) of the IDirectDraw interface family + IUnknown. A
// QueryInterface for any of these returns the same object; anything else (most
// notably the IDirect3D* interfaces) must fail with E_NOINTERFACE so callers
// fall back to the DirectDraw software path instead of using an unsupported
// interface whose vtable we don't provide.
const DDRAW_IID_DATA1 = new Set<number>([
  0x00000000, // IID_IUnknown
  0x6C14DB80, // IID_IDirectDraw
  0xB3A6F3E0, // IID_IDirectDraw2
  0x9C59509A, // IID_IDirectDraw4
  0x15E65EC0, // IID_IDirectDraw7
]);

interface DDSurface {
  objAddr: number;        // COM object address
  width: number;
  height: number;
  pitch: number;
  bpp: number;            // bits per pixel
  pixelData: number;      // address of pixel buffer
  isPrimary: boolean;
  backBuffer?: number;    // handle to back buffer surface
  attachedTo?: number;    // parent surface objAddr
  paletteAddr?: number;   // address of palette data (256 RGBQUAD entries)
}

function allocComObject(emu: Emulator, prefix: string, methodCount: number, handlers: Record<number, (() => number) | undefined>): number {
  // Allocate vtable
  const vtableAddr = emu.allocHeap(methodCount * 4);
  // Allocate object (first DWORD = vtable pointer)
  const objAddr = emu.allocHeap(4);
  emu.memory.writeU32(objAddr, vtableAddr);

  // For each method, create a thunk. Under the ring3 kernel, vtable entries must
  // be real callable `int 0x2E` stubs (the own-backend's dynamicThunkPtr path is
  // only intercepted by cpu.step, which the kernel doesn't use). Default the
  // stdcall cleanup to 4 (`this` only); callers patch it via setComThunkStackBytes.
  const kernel = !!emu._kernelMakeComThunk;
  for (let i = 0; i < methodCount; i++) {
    const methodName = `${prefix}_Method${i}`;
    const handler = handlers[i] ?? (() => {
      console.log(`Unimplemented COM: ${methodName} (vtable offset 0x${(i * 4).toString(16)})`);
      return DD_OK;
    });
    if (kernel) {
      const thunkVA = emu._kernelMakeComThunk!(`DDRAW:${methodName}`, 4, handler);
      emu.memory.writeU32(vtableAddr + i * 4, thunkVA);
    } else {
      const thunkAddr = emu.dynamicThunkPtr;
      emu.dynamicThunkPtr += 4;
      emu.memory.writeU32(vtableAddr + i * 4, thunkAddr);
      emu.thunkToApi.set(thunkAddr, { dll: 'DDRAW.DLL', name: methodName, stackBytes: handlers[i] ? 0 : 4 });
      emu.thunkPages.add(thunkAddr >>> 12);
      emu.apiDefs.set(`DDRAW.DLL:${methodName}`, { handler, stackBytes: handlers[i] ? 0 : 4 });
    }
  }

  return objAddr;
}

export function registerDdraw(emu: Emulator): void {
  const surfaces = new Map<number, DDSurface>();
  const paletteDataMap = new Map<number, number>(); // palette COM obj → paletteData address
  let lastPaletteData = 0; // fallback: most recently created palette
  let displayWidth = 640, displayHeight = 480, displayBpp = 32;

  // Helper to set stackBytes for a COM thunk after creation
  function setComThunkStackBytes(objAddr: number, methodIndex: number, nArgs: number) {
    const vtableAddr = emu.memory.readU32(objAddr);
    const thunkAddr = emu.memory.readU32(vtableAddr + methodIndex * 4);
    if (emu._kernelSetThunkRet) { emu._kernelSetThunkRet(thunkAddr, nArgs * 4); return; }
    const info = emu.thunkToApi.get(thunkAddr);
    if (info) info.stackBytes = nArgs * 4;
  }

  // Blit surface pixels to canvas
  function blitToCanvas(surf: DDSurface) {
    const ctx = emu.canvasCtx;
    if (!ctx) return;
    const w = surf.width, h = surf.height;
    const imgData = ctx.createImageData(w, h);
    const dst = imgData.data;
    const mem = emu.memory;
    const base = surf.pixelData;
    const pitch = surf.pitch;
    const bpp = surf.bpp;

    const palAddr8 = surf.paletteAddr || lastPaletteData;
    if (bpp === 8 && palAddr8) {
      // 8-bit palettized — palette is 256 RGBQUAD entries (R, G, B, flags)
      const palAddr = palAddr8;
      for (let y = 0; y < h; y++) {
        const rowOff = base + y * pitch;
        for (let x = 0; x < w; x++) {
          const idx = mem.readU8(rowOff + x);
          const pe = palAddr + idx * 4;
          // PALETTEENTRY: peRed, peGreen, peBlue, peFlags
          const di = (y * w + x) * 4;
          dst[di] = mem.readU8(pe);       // R
          dst[di + 1] = mem.readU8(pe + 1); // G
          dst[di + 2] = mem.readU8(pe + 2); // B
          dst[di + 3] = 255;
        }
      }
    } else if (bpp === 16) {
      // RGB565
      for (let y = 0; y < h; y++) {
        const rowOff = base + y * pitch;
        for (let x = 0; x < w; x++) {
          const px = mem.readU16(rowOff + x * 2);
          const r = ((px >> 11) & 0x1F) * 255 / 31;
          const g = ((px >> 5) & 0x3F) * 255 / 63;
          const b = (px & 0x1F) * 255 / 31;
          const di = (y * w + x) * 4;
          dst[di] = r; dst[di + 1] = g; dst[di + 2] = b; dst[di + 3] = 255;
        }
      }
    } else if (bpp === 32) {
      // BGRA (Windows DWORD order: B,G,R,A in memory)
      for (let y = 0; y < h; y++) {
        const rowOff = base + y * pitch;
        for (let x = 0; x < w; x++) {
          const px = mem.readU32(rowOff + x * 4);
          const di = (y * w + x) * 4;
          dst[di] = (px >> 16) & 0xFF;     // R
          dst[di + 1] = (px >> 8) & 0xFF;  // G
          dst[di + 2] = px & 0xFF;          // B
          dst[di + 3] = 255;
        }
      }
    }

    // Resize canvas to match display mode if needed
    if (emu.canvas && (emu.canvas.width !== w || emu.canvas.height !== h)) {
      emu.canvas.width = w;
      emu.canvas.height = h;
    }
    ctx.putImageData(imgData, 0, 0);
  }

  // Copy pixels between surfaces for Blt
  function bltSurfaces(dstSurf: DDSurface, dstRect: number, srcSurf: DDSurface | null, srcRect: number) {
    if (!srcSurf) return;
    const mem = emu.memory;

    // Read rects (RECT: left, top, right, bottom — each LONG = 4 bytes)
    let dl = 0, dt = 0, dr = dstSurf.width, db = dstSurf.height;
    if (dstRect) {
      dl = mem.readU32(dstRect) | 0; dt = mem.readU32(dstRect + 4) | 0;
      dr = mem.readU32(dstRect + 8) | 0; db = mem.readU32(dstRect + 12) | 0;
    }
    let sl = 0, st = 0, sr = srcSurf.width, sb = srcSurf.height;
    if (srcRect) {
      sl = mem.readU32(srcRect) | 0; st = mem.readU32(srcRect + 4) | 0;
      sr = mem.readU32(srcRect + 8) | 0; sb = mem.readU32(srcRect + 12) | 0;
    }

    const sw = sr - sl, sh = sb - st;
    const dw = dr - dl, dh = db - dt;
    const copyW = Math.min(sw, dw), copyH = Math.min(sh, dh);
    const bytesPerPixel = dstSurf.bpp / 8;

    for (let y = 0; y < copyH; y++) {
      const srcOff = srcSurf.pixelData + (st + y) * srcSurf.pitch + sl * bytesPerPixel;
      const dstOff = dstSurf.pixelData + (dt + y) * dstSurf.pitch + dl * bytesPerPixel;
      for (let x = 0; x < copyW * bytesPerPixel; x++) {
        mem.writeU8(dstOff + x, mem.readU8(srcOff + x));
      }
    }
  }

  function createDDSurface(width: number, height: number, bpp: number, isPrimary: boolean): number {
    const pitch = ((width * (bpp / 8) + 3) & ~3); // DWORD-aligned
    const pixelData = emu.allocHeap(pitch * height);

    const handlers: Record<number, () => number> = {};
    const surfaceRef = { objAddr: 0 } as DDSurface;

    // QueryInterface (0)
    handlers[0] = () => DDERR_GENERIC;
    // AddRef (1)
    handlers[1] = () => 2;
    // Release (2)
    handlers[2] = () => 0;
    // Blt (5) - this, destRect, srcSurface, srcRect, flags, bltFx
    handlers[5] = () => {
      const thisPtr = emu.readArg(0);
      const dstRect = emu.readArg(1);
      const srcObj = emu.readArg(2);
      const srcRectPtr = emu.readArg(3);
      const flags = emu.readArg(4);
      const bltFxPtr = emu.readArg(5);
      const dstSurf = surfaces.get(thisPtr);
      if (!dstSurf) return DD_OK;
      const DDBLT_COLORFILL = 0x00000400;
      if ((flags & DDBLT_COLORFILL) && bltFxPtr) {
        // Color fill — dwFillColor at offset 80 in DDBLTFX
        const fillColor = emu.memory.readU32(bltFxPtr + 80);
        const mem = emu.memory;
        let dl = 0, dt = 0, dr = dstSurf.width, db = dstSurf.height;
        if (dstRect) {
          dl = mem.readU32(dstRect) | 0; dt = mem.readU32(dstRect + 4) | 0;
          dr = mem.readU32(dstRect + 8) | 0; db = mem.readU32(dstRect + 12) | 0;
        }
        const bytesPerPixel = dstSurf.bpp / 8;
        for (let y = dt; y < db; y++) {
          const rowOff = dstSurf.pixelData + y * dstSurf.pitch + dl * bytesPerPixel;
          for (let x = 0; x < (dr - dl); x++) {
            if (bytesPerPixel === 1) mem.writeU8(rowOff + x, fillColor & 0xFF);
            else if (bytesPerPixel === 2) mem.writeU16(rowOff + x * 2, fillColor & 0xFFFF);
            else if (bytesPerPixel === 4) mem.writeU32(rowOff + x * 4, fillColor);
          }
        }
      } else {
        const srcSurf = srcObj ? surfaces.get(srcObj) : null;
        if (srcSurf) bltSurfaces(dstSurf, dstRect, srcSurf, srcRectPtr);
      }
      return DD_OK;
    };
    // BltFast (7) - this, x, y, srcSurface, srcRect, flags
    handlers[7] = () => {
      const thisPtr = emu.readArg(0);
      const dx = emu.readArg(1);
      const dy = emu.readArg(2);
      const srcObj = emu.readArg(3);
      const srcRectPtr = emu.readArg(4);
      const dstSurf = surfaces.get(thisPtr);
      const srcSurf = srcObj ? surfaces.get(srcObj) : null;
      if (dstSurf && srcSurf) {
        const mem = emu.memory;
        let sl = 0, st = 0, sr = srcSurf.width, sb = srcSurf.height;
        if (srcRectPtr) {
          sl = mem.readU32(srcRectPtr) | 0; st = mem.readU32(srcRectPtr + 4) | 0;
          sr = mem.readU32(srcRectPtr + 8) | 0; sb = mem.readU32(srcRectPtr + 12) | 0;
        }
        const copyW = sr - sl, copyH = sb - st;
        const bytesPerPixel = dstSurf.bpp / 8;
        for (let y = 0; y < copyH; y++) {
          const srcOff = srcSurf.pixelData + (st + y) * srcSurf.pitch + sl * bytesPerPixel;
          const dstOff = dstSurf.pixelData + (dy + y) * dstSurf.pitch + dx * bytesPerPixel;
          for (let x = 0; x < copyW * bytesPerPixel; x++) {
            mem.writeU8(dstOff + x, mem.readU8(srcOff + x));
          }
        }
      }
      return DD_OK;
    };
    // Flip (11) - this, targetOverride, flags
    handlers[11] = () => {
      const thisPtr = emu.readArg(0);
      const surf = surfaces.get(thisPtr);
      if (surf && surf.backBuffer) {
        const bbSurf = surfaces.get(surf.backBuffer);
        if (bbSurf) blitToCanvas(bbSurf);
      }
      return DD_OK;
    };
    // GetAttachedSurface (12) - this, caps, outSurface
    handlers[12] = () => {
      const thisPtr = emu.readArg(0);
      const outPtr = emu.readArg(2);
      const surf = surfaces.get(thisPtr);
      if (surf && surf.backBuffer) {
        emu.memory.writeU32(outPtr, surf.backBuffer);
        return DD_OK;
      }
      console.log(`[DDRAW] GetAttachedSurface FAILED for 0x${thisPtr.toString(16)}`);
      return DDERR_GENERIC;
    };
    // GetBltStatus (13)
    handlers[13] = () => DD_OK;
    // GetCaps (14)
    handlers[14] = () => DD_OK;
    // GetDC (17) - this, outHDC
    handlers[17] = () => {
      const outPtr = emu.readArg(1);
      // Return a fake HDC
      emu.memory.writeU32(outPtr, 0xDDDC0001);
      return DD_OK;
    };
    // GetFlipStatus (18)
    handlers[18] = () => DD_OK;
    // GetPixelFormat (21) - this, outPF
    handlers[21] = () => {
      const pfPtr = emu.readArg(1);
      // DDPIXELFORMAT: size(4), flags(4), fourCC(4), rgbBitCount(4), rMask(4), gMask(4), bMask(4), aMask(4)
      emu.memory.writeU32(pfPtr + 0, 32); // size
      emu.memory.writeU32(pfPtr + 4, DDPF_RGB);
      emu.memory.writeU32(pfPtr + 8, 0); // fourCC
      emu.memory.writeU32(pfPtr + 12, bpp);
      if (bpp === 32) {
        emu.memory.writeU32(pfPtr + 16, 0x00FF0000); // R
        emu.memory.writeU32(pfPtr + 20, 0x0000FF00); // G
        emu.memory.writeU32(pfPtr + 24, 0x000000FF); // B
        emu.memory.writeU32(pfPtr + 28, 0xFF000000); // A
      } else if (bpp === 16) {
        emu.memory.writeU32(pfPtr + 16, 0xF800);
        emu.memory.writeU32(pfPtr + 20, 0x07E0);
        emu.memory.writeU32(pfPtr + 24, 0x001F);
        emu.memory.writeU32(pfPtr + 28, 0);
      }
      return DD_OK;
    };
    // GetSurfaceDesc (22) - this, outDesc
    handlers[22] = () => {
      const descPtr = emu.readArg(1);
      writeSurfaceDesc(descPtr, width, height, pitch, bpp, pixelData);
      return DD_OK;
    };
    // IsLost (24)
    handlers[24] = () => DD_OK;
    // Lock (25) - this, destRect, surfaceDesc, flags, event
    handlers[25] = () => {
      const descPtr = emu.readArg(2);
      writeSurfaceDesc(descPtr, width, height, pitch, bpp, pixelData);
      return DD_OK;
    };
    // ReleaseDC (26) - this, hdc
    handlers[26] = () => DD_OK;
    // Restore (27)
    handlers[27] = () => DD_OK;
    // SetClipper (28) - this, clipper
    handlers[28] = () => DD_OK;
    // SetColorKey (29) - this, flags, colorKey
    handlers[29] = () => DD_OK;
    // SetPalette (31) - this, palette
    handlers[31] = () => {
      const thisPtr = emu.readArg(0);
      const palObj = emu.readArg(1);
      const surf = surfaces.get(thisPtr);
      if (surf && palObj) {
        const palData = paletteDataMap.get(palObj);
        if (palData !== undefined) surf.paletteAddr = palData;
      }
      return DD_OK;
    };
    // Unlock (32) - this, rect
    handlers[32] = () => {
      const thisPtr = emu.readArg(0);
      const surf = surfaces.get(thisPtr);
      if (surf && surf.isPrimary) {
        blitToCanvas(surf);
      }
      return DD_OK;
    };

    const objAddr = allocComObject(emu, 'DDS7', DDS7_VTABLE_SIZE, handlers);
    surfaceRef.objAddr = objAddr;

    // Set correct stackBytes for known methods (stdcall, includes 'this')
    setComThunkStackBytes(objAddr, 0, 3);  // QueryInterface(this, riid, ppv)
    setComThunkStackBytes(objAddr, 1, 1);  // AddRef(this)
    setComThunkStackBytes(objAddr, 2, 1);  // Release(this)
    setComThunkStackBytes(objAddr, 5, 6);  // Blt(this, destRect, srcSurf, srcRect, flags, bltFx)
    setComThunkStackBytes(objAddr, 7, 6);  // BltFast(this, x, y, srcSurf, srcRect, flags)
    setComThunkStackBytes(objAddr, 11, 3); // Flip(this, target, flags)
    setComThunkStackBytes(objAddr, 12, 3); // GetAttachedSurface(this, caps, out)
    setComThunkStackBytes(objAddr, 13, 2); // GetBltStatus(this, flags)
    setComThunkStackBytes(objAddr, 14, 2); // GetCaps(this, caps)
    setComThunkStackBytes(objAddr, 17, 2); // GetDC(this, hdc)
    setComThunkStackBytes(objAddr, 18, 2); // GetFlipStatus(this, flags)
    setComThunkStackBytes(objAddr, 21, 2); // GetPixelFormat(this, pf)
    setComThunkStackBytes(objAddr, 22, 2); // GetSurfaceDesc(this, desc)
    setComThunkStackBytes(objAddr, 24, 1); // IsLost(this)
    setComThunkStackBytes(objAddr, 25, 5); // Lock(this, rect, desc, flags, event)
    setComThunkStackBytes(objAddr, 26, 2); // ReleaseDC(this, hdc)
    setComThunkStackBytes(objAddr, 27, 1); // Restore(this)
    setComThunkStackBytes(objAddr, 28, 2); // SetClipper(this, clipper)
    setComThunkStackBytes(objAddr, 29, 3); // SetColorKey(this, flags, ck)
    setComThunkStackBytes(objAddr, 30, 3); // SetOverlayPosition(this, x, y)
    setComThunkStackBytes(objAddr, 31, 2); // SetPalette(this, palette)
    setComThunkStackBytes(objAddr, 32, 2); // Unlock(this, rect)

    const surf: DDSurface = { objAddr, width, height, pitch, bpp, pixelData, isPrimary };
    surfaces.set(objAddr, surf);
    surfaceRef.objAddr = objAddr;
    Object.assign(surfaceRef, surf);

    return objAddr;
  }

  function writeSurfaceDesc(ptr: number, width: number, height: number, pitch: number, bpp: number, pixelData: number) {
    // DDSURFACEDESC2: size=124 bytes
    emu.memory.writeU32(ptr + 0, 124); // dwSize
    emu.memory.writeU32(ptr + 4, DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PITCH | DDSD_PIXELFORMAT | DDSD_LPSURFACE);
    emu.memory.writeU32(ptr + 8, height);  // dwHeight
    emu.memory.writeU32(ptr + 12, width);  // dwWidth
    emu.memory.writeU32(ptr + 16, pitch);  // lPitch
    emu.memory.writeU32(ptr + 20, 0);      // dwBackBufferCount
    emu.memory.writeU32(ptr + 36, pixelData); // lpSurface
    // DDPIXELFORMAT at offset 72
    emu.memory.writeU32(ptr + 72, 32);     // dwSize
    if (bpp === 8) {
      emu.memory.writeU32(ptr + 76, DDPF_PALETTEINDEXED8 | DDPF_RGB);
      emu.memory.writeU32(ptr + 80, 0);
      emu.memory.writeU32(ptr + 84, 8);
      emu.memory.writeU32(ptr + 88, 0);
      emu.memory.writeU32(ptr + 92, 0);
      emu.memory.writeU32(ptr + 96, 0);
      emu.memory.writeU32(ptr + 100, 0);
    } else {
      emu.memory.writeU32(ptr + 76, DDPF_RGB);
      emu.memory.writeU32(ptr + 80, 0);      // fourCC
      emu.memory.writeU32(ptr + 84, bpp);    // rgbBitCount
      if (bpp === 32) {
        emu.memory.writeU32(ptr + 88, 0x00FF0000);
        emu.memory.writeU32(ptr + 92, 0x0000FF00);
        emu.memory.writeU32(ptr + 96, 0x000000FF);
        emu.memory.writeU32(ptr + 100, 0xFF000000);
      } else if (bpp === 16) {
        emu.memory.writeU32(ptr + 88, 0xF800);
        emu.memory.writeU32(ptr + 92, 0x07E0);
        emu.memory.writeU32(ptr + 96, 0x001F);
        emu.memory.writeU32(ptr + 100, 0);
      }
    }
    // DDSCAPS2 at offset 104
    emu.memory.writeU32(ptr + 104, 0);
  }

  // DirectDrawCreateEx(lpGUID, lplpDD, iid, pUnkOuter) → HRESULT
  emu.apiDefs.set('DDRAW.DLL:DirectDrawCreateEx', { handler: () => {
    const lpGUID = emu.readArg(0);
    const lplpDD = emu.readArg(1);
    const iid = emu.readArg(2);
    const pUnkOuter = emu.readArg(3);

    console.log(`[DDRAW] DirectDrawCreateEx lpGUID=0x${lpGUID.toString(16)} lplpDD=0x${lplpDD.toString(16)}`);

    // Create IDirectDraw7 COM object
    const handlers: Record<number, () => number> = {};

    // QueryInterface (0) - this, riid, ppv
    handlers[0] = () => {
      const thisPtr = emu.readArg(0);
      const riid = emu.readArg(1);
      const ppv = emu.readArg(2);
      const data1 = riid ? emu.memory.readU32(riid) >>> 0 : 0;
      // Only the IDirectDraw family is supported. Refuse IDirect3D* (and anything
      // else) so the caller takes its non-D3D / software path rather than calling
      // through an interface we can't back.
      if (!DDRAW_IID_DATA1.has(data1)) {
        console.log(`[DDRAW] QueryInterface unsupported iid.Data1=0x${data1.toString(16)} → E_NOINTERFACE`);
        if (ppv) emu.memory.writeU32(ppv, 0);
        return E_NOINTERFACE;
      }
      if (ppv) emu.memory.writeU32(ppv, thisPtr);
      return DD_OK;
    };
    // AddRef (1)
    handlers[1] = () => 2;
    // Release (2)
    handlers[2] = () => 0;
    // CreateClipper (4) - this, flags, outClipper, outer
    handlers[4] = () => {
      const outPtr = emu.readArg(2);
      // Create a simple clipper COM object
      const clipHandlers: Record<number, () => number> = {};
      clipHandlers[0] = () => DDERR_GENERIC; // QI
      clipHandlers[1] = () => 2; // AddRef
      clipHandlers[2] = () => 0; // Release
      // SetHWnd (8) - this, flags, hwnd
      clipHandlers[8] = () => DD_OK;
      const clipObj = allocComObject(emu, 'DDC', DDC_VTABLE_SIZE, clipHandlers);
      setComThunkStackBytes(clipObj, 0, 3);
      setComThunkStackBytes(clipObj, 1, 1);
      setComThunkStackBytes(clipObj, 2, 1);
      setComThunkStackBytes(clipObj, 8, 3); // SetHWnd(this, flags, hwnd)
      emu.memory.writeU32(outPtr, clipObj);
      return DD_OK;
    };
    // CreatePalette (5) - this, flags, colorArray, outPalette, outer
    handlers[5] = () => {
      const flags = emu.readArg(1);
      const colorArrayPtr = emu.readArg(2);
      const outPtr = emu.readArg(3);
      console.log(`[DDRAW] CreatePalette flags=0x${flags.toString(16)} colorArray=0x${colorArrayPtr.toString(16)}`);

      // Store palette entries (256 RGBQUAD entries = 1024 bytes)
      const paletteData = emu.allocHeap(1024);
      if (colorArrayPtr) {
        for (let i = 0; i < 1024; i++) {
          emu.memory.writeU8(paletteData + i, emu.memory.readU8(colorArrayPtr + i));
        }
      }

      const palHandlers: Record<number, () => number> = {};
      palHandlers[0] = () => DDERR_GENERIC; // QI
      palHandlers[1] = () => 2; // AddRef
      palHandlers[2] = () => 0; // Release
      palHandlers[3] = () => DD_OK; // GetCaps
      palHandlers[4] = () => DD_OK; // GetEntries
      palHandlers[5] = () => DD_OK; // Initialize
      // SetEntries (6) - this, flags, start, count, entries
      palHandlers[6] = () => {
        const start = emu.readArg(2);
        const count = emu.readArg(3);
        const entriesPtr = emu.readArg(4);
        if (entriesPtr) {
          for (let i = 0; i < count * 4; i++) {
            emu.memory.writeU8(paletteData + start * 4 + i, emu.memory.readU8(entriesPtr + i));
          }
        }
        return DD_OK;
      };

      const palObj = allocComObject(emu, 'DDP', DDP_VTABLE_SIZE, palHandlers);
      setComThunkStackBytes(palObj, 0, 3);  // QI
      setComThunkStackBytes(palObj, 1, 1);  // AddRef
      setComThunkStackBytes(palObj, 2, 1);  // Release
      setComThunkStackBytes(palObj, 3, 2);  // GetCaps(this, caps)
      setComThunkStackBytes(palObj, 4, 5);  // GetEntries(this, flags, start, count, entries)
      setComThunkStackBytes(palObj, 5, 2);  // Initialize(this, dd)
      setComThunkStackBytes(palObj, 6, 5);  // SetEntries(this, flags, start, count, entries)

      paletteDataMap.set(palObj, paletteData);
      lastPaletteData = paletteData;
      if (outPtr) emu.memory.writeU32(outPtr, palObj);
      return DD_OK;
    };
    // CreateSurface (6) - this, desc, outSurface, outer
    handlers[6] = () => {
      const descPtr = emu.readArg(1);
      const outPtr = emu.readArg(2);

      const flags = emu.memory.readU32(descPtr + 4);
      const height = (flags & DDSD_HEIGHT) ? emu.memory.readU32(descPtr + 8) : displayHeight;
      const width = (flags & DDSD_WIDTH) ? emu.memory.readU32(descPtr + 12) : displayWidth;
      const caps = emu.memory.readU32(descPtr + 104);
      const backBufferCount = (flags & DDSD_BACKBUFFERCOUNT) ? emu.memory.readU32(descPtr + 20) : 0;

      console.log(`[DDRAW] CreateSurface ${width}x${height} caps=0x${caps.toString(16)} backBuffers=${backBufferCount} flags=0x${flags.toString(16)}`);

      const isPrimary = !!(caps & DDSCAPS_PRIMARYSURFACE);
      const surfW = isPrimary ? displayWidth : width;
      const surfH = isPrimary ? displayHeight : height;

      const surfObj = createDDSurface(surfW, surfH, displayBpp, isPrimary);
      emu.memory.writeU32(outPtr, surfObj);

      // Create back buffer if requested
      if (backBufferCount > 0) {
        const bbObj = createDDSurface(surfW, surfH, displayBpp, false);
        const surf = surfaces.get(surfObj);
        if (surf) surf.backBuffer = bbObj;
        const bbSurf = surfaces.get(bbObj);
        if (bbSurf) bbSurf.attachedTo = surfObj;
      }

      return DD_OK;
    };
    // EnumDisplayModes (8) - this, flags, surfDesc, context, callback
    handlers[8] = () => {
      const context = emu.readArg(3);
      const callback = emu.readArg(4);
      console.log(`[DDRAW] EnumDisplayModes callback=0x${callback.toString(16)} context=0x${context.toString(16)}`);
      if (!callback) return DD_OK;
      const DDENUMRET_OK = 1;
      const modes = [
        { w: 640, h: 480, bpp: 8 },
        { w: 640, h: 480, bpp: 16 },
        { w: 640, h: 480, bpp: 32 },
        { w: 800, h: 600, bpp: 8 },
        { w: 800, h: 600, bpp: 16 },
        { w: 800, h: 600, bpp: 32 },
        { w: 1024, h: 768, bpp: 16 },
        { w: 1024, h: 768, bpp: 32 },
      ];
      const modeDescPtr = emu.allocHeap(124);
      for (const mode of modes) {
        const pitch = ((mode.w * (mode.bpp / 8) + 3) & ~3);
        writeSurfaceDesc(modeDescPtr, mode.w, mode.h, pitch, mode.bpp, 0);
        // HRESULT CALLBACK EnumModesCallback(LPDDSURFACEDESC2, LPVOID)
        const ret = emu.callCallback(callback, [modeDescPtr, context]);
        console.log(`[DDRAW] EnumDisplayModes callback returned ${ret} for ${mode.w}x${mode.h}x${mode.bpp}`);
        if (ret !== DDENUMRET_OK) break;
      }
      return DD_OK;
    };
    // GetCaps (11) - this, driverCaps, helCaps
    handlers[11] = () => {
      const driverCapsPtr = emu.readArg(1);
      const helCapsPtr = emu.readArg(2);
      // Fill in minimal DDCAPS structure
      // dwSize at offset 0, dwCaps at offset 4
      if (driverCapsPtr) {
        const size = emu.memory.readU32(driverCapsPtr);
        // Zero it out then set dwCaps
        for (let i = 4; i < Math.min(size, 380); i += 4) emu.memory.writeU32(driverCapsPtr + i, 0);
        emu.memory.writeU32(driverCapsPtr + 4, 0x00000040); // DDCAPS_BLT
        // dwVidMemTotal at offset 24
        emu.memory.writeU32(driverCapsPtr + 24, 64 * 1024 * 1024); // 64MB
        // dwVidMemFree at offset 28
        emu.memory.writeU32(driverCapsPtr + 28, 60 * 1024 * 1024);
      }
      if (helCapsPtr) {
        const size = emu.memory.readU32(helCapsPtr);
        for (let i = 4; i < Math.min(size, 380); i += 4) emu.memory.writeU32(helCapsPtr + i, 0);
      }
      return DD_OK;
    };
    // GetDisplayMode (12) - this, surfDesc
    handlers[12] = () => {
      const descPtr = emu.readArg(1);
      const pitch = ((displayWidth * (displayBpp / 8) + 3) & ~3);
      writeSurfaceDesc(descPtr, displayWidth, displayHeight, pitch, displayBpp, 0);
      return DD_OK;
    };
    // RestoreDisplayMode (19)
    handlers[19] = () => DD_OK;
    // SetCooperativeLevel (20) - this, hwnd, flags
    handlers[20] = () => {
      console.log(`[DDRAW] SetCooperativeLevel hwnd=0x${emu.readArg(1).toString(16)} flags=0x${emu.readArg(2).toString(16)}`);
      return DD_OK;
    };
    // SetDisplayMode (21) - this, width, height, bpp, refreshRate, flags
    handlers[21] = () => {
      displayWidth = emu.readArg(1);
      displayHeight = emu.readArg(2);
      displayBpp = emu.readArg(3);
      console.log(`[DDRAW] SetDisplayMode ${displayWidth}x${displayHeight}x${displayBpp}`);
      if (emu.canvas) {
        emu.canvas.width = displayWidth;
        emu.canvas.height = displayHeight;
      }
      return DD_OK;
    };
    // WaitForVerticalBlank (22) - this, flags, event
    handlers[22] = () => DD_OK;
    // GetAvailableVidMem (23) - this, caps, total, free
    handlers[23] = () => {
      const totalPtr = emu.readArg(2);
      const freePtr = emu.readArg(3);
      if (totalPtr) emu.memory.writeU32(totalPtr, 64 * 1024 * 1024); // 64MB
      if (freePtr) emu.memory.writeU32(freePtr, 60 * 1024 * 1024); // 60MB free
      return DD_OK;
    };
    // TestCooperativeLevel (26)
    handlers[26] = () => DD_OK;

    const ddObj = allocComObject(emu, 'DD7', DD7_VTABLE_SIZE, handlers);

    // Set stackBytes for known methods
    setComThunkStackBytes(ddObj, 0, 3);  // QueryInterface
    setComThunkStackBytes(ddObj, 1, 1);  // AddRef
    setComThunkStackBytes(ddObj, 2, 1);  // Release
    setComThunkStackBytes(ddObj, 4, 4);  // CreateClipper(this, flags, out, outer)
    setComThunkStackBytes(ddObj, 5, 5);  // CreatePalette(this, flags, colorArray, out, outer)
    setComThunkStackBytes(ddObj, 6, 4);  // CreateSurface(this, desc, out, outer)
    setComThunkStackBytes(ddObj, 8, 5);  // EnumDisplayModes(this, flags, desc, ctx, cb)
    setComThunkStackBytes(ddObj, 11, 3); // GetCaps(this, driver, hel)
    setComThunkStackBytes(ddObj, 12, 2); // GetDisplayMode(this, desc)
    setComThunkStackBytes(ddObj, 19, 1); // RestoreDisplayMode(this)
    setComThunkStackBytes(ddObj, 20, 3); // SetCooperativeLevel(this, hwnd, flags)
    setComThunkStackBytes(ddObj, 21, 6); // SetDisplayMode(this, w, h, bpp, refresh, flags)
    setComThunkStackBytes(ddObj, 22, 3); // WaitForVerticalBlank(this, flags, event)
    setComThunkStackBytes(ddObj, 23, 4); // GetAvailableVidMem(this, caps, total, free)
    setComThunkStackBytes(ddObj, 26, 1); // TestCooperativeLevel(this)

    // Write object pointer to output
    emu.memory.writeU32(lplpDD, ddObj);
    console.log(`[DDRAW] Created IDirectDraw7 at 0x${ddObj.toString(16)}`);

    return DD_OK;
  }, stackBytes: 4 * 4 });

  // DirectDrawCreate(lpGUID, lplpDD, pUnkOuter) → HRESULT
  // IDirectDraw (not IDirectDraw7): SetDisplayMode takes 3 args, not 5
  emu.apiDefs.set('DDRAW.DLL:DirectDrawCreate', { handler: () => {
    const lplpDD = emu.readArg(1);
    // Create via DirectDrawCreateEx handler (reuses same logic)
    const ddCreateEx = emu.apiDefs.get('DDRAW.DLL:DirectDrawCreateEx');
    if (!ddCreateEx) return DDERR_GENERIC;
    // Temporarily store lplpDD for the inner handler
    const result = ddCreateEx.handler(emu);
    if (result !== DD_OK) return result;
    // Patch SetDisplayMode to expect IDirectDraw args (this, w, h, bpp) = 4 args
    const ddObj = emu.memory.readU32(lplpDD);
    setComThunkStackBytes(ddObj, 21, 4); // IDirectDraw::SetDisplayMode(this, w, h, bpp)
    return DD_OK;
  }, stackBytes: 3 * 4 });
}
