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
  /** RT_BITMAP resource ID of the currently selected bitmap (propagated through
   *  SelectObject). Used by BitBlt to tag destination bitmaps. */
  selectedBitmapResId?: number;
  selectedBitmapResModule?: number;
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
  dimX?: number;        // logical dimension set by SetBitmapDimension
  dimY?: number;        // logical dimension set by SetBitmapDimension
  /** RT_BITMAP resource ID. Set by loadBitmapResource* and propagated through
   *  SelectObject/BitBlt so renderToolbar can fall back to a direct resource
   *  reload when the canvas was lost in a CreateCompatibleBitmap copy chain. */
  resourceId?: number;
  /** Module handle (PE imageBase) of the resource source, for foreign-DLL bitmaps. */
  resourceModule?: number;
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
