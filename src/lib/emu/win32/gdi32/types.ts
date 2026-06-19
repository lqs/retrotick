export interface DCInfo {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  hwnd: number;
  selectedBitmap: number;
  selectedPen: number;
  selectedBrush: number;
  selectedFont: number;
  selectedPalette: number;
  textColor: number;
  bkColor: number;
  bkMode: number;
  penPosX: number;
  penPosY: number;
  rop2: number;
  textAlign?: number;
  textCharExtra?: number;
  textJustBreakCount?: number;
  textJustBreakExtra?: number;
  mapMode?: number;
  windowOrgX?: number;
  windowOrgY?: number;
  windowExtX?: number;
  windowExtY?: number;
  viewportOrgX?: number;
  viewportOrgY?: number;
  viewportExtX?: number;
  viewportExtY?: number;
  polyFillMode?: number;
  stretchBltMode?: number;
  brushOrgX?: number;
  brushOrgY?: number;
  /** Palette index buffer for palette animation: stores palette index per pixel (0 = no palette) */
  palIndexBuf?: Uint8Array;
  /** Number of unmatched SaveDC calls on this DC (like Wine's save_level).
   *  Used by releaseChildDC to pop all remaining saves when the DC is released. */
  saveLevel?: number;
}

export interface BitmapInfo {
  width: number;
  height: number;
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  imageData?: ImageData;
  monochrome?: boolean;
  dibBitsPtr?: number;  // emulator memory address of DIB section pixel data
  dibBpp?: number;      // bits per pixel of DIB section
  dibTopDown?: boolean; // DIB created with negative height (top-down row order)
  dibColorTable?: number[]; // palette colors (0x00BBGGRR) for <=8bpp DIB sections
  dimX?: number;        // logical dimension set by SetBitmapDimension
  dimY?: number;        // logical dimension set by SetBitmapDimension
}

export interface PenInfo {
  style: number;
  width: number;
  color: number;
}

export interface BrushInfo {
  color: number;
  style?: number;
  isNull: boolean;
  patternBitmap?: OffscreenCanvas | HTMLCanvasElement;
}

export interface PaletteInfo {
  entries: Uint8Array; // R,G,B,flags per entry (4 bytes each)
  count: number;
}
