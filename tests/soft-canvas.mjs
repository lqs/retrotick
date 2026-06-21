// Minimal software-rasterized 2D canvas for headless pixel verification.
// Supports the subset used by the emulator's GDI layer: fillRect, drawImage,
// getImageData/putImageData, transforms (translate/setTransform), and
// rectangular clip. Text and path drawing are no-ops.

function parseColor(style) {
  if (typeof style !== 'string') return [0, 0, 0, 255];
  let m = /^#([0-9a-f]{6})$/i.exec(style);
  if (m) {
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF, 255];
  }
  m = /^#([0-9a-f]{3})$/i.exec(style);
  if (m) {
    const r = parseInt(m[1][0], 16) * 17, g = parseInt(m[1][1], 16) * 17, b = parseInt(m[1][2], 16) * 17;
    return [r, g, b, 255];
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(style);
  if (m) return [+m[1], +m[2], +m[3], m[4] !== undefined ? Math.round(+m[4] * 255) : 255];
  if (style === 'black') return [0, 0, 0, 255];
  if (style === 'white') return [255, 255, 255, 255];
  if (style === 'transparent') return [0, 0, 0, 0];
  return [0, 0, 0, 255];
}

export class SoftContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.font = '';
    this.textAlign = 'left';
    this.textBaseline = 'top';
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.imageSmoothingEnabled = false;
    this._t = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    this._clip = null; // {x,y,w,h} in device coords
    this._stack = [];
    this._pathRects = [];
  }

  // --- transforms ---
  getTransform() { return { ...this._t }; }
  setTransform(a, b, c, d, e, f) {
    if (typeof a === 'object') { this._t = { a: a.a, b: a.b, c: a.c, d: a.d, e: a.e, f: a.f }; }
    else this._t = { a, b, c, d, e, f };
  }
  resetTransform() { this._t = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
  transform(a, b, c, d, e, f) {
    const t = this._t;
    this._t = {
      a: t.a * a + t.c * b, b: t.b * a + t.d * b,
      c: t.a * c + t.c * d, d: t.b * c + t.d * d,
      e: t.a * e + t.c * f + t.e, f: t.b * e + t.d * f + t.f,
    };
  }
  translate(x, y) { this.transform(1, 0, 0, 1, x, y); }
  scale(x, y) { this.transform(x, 0, 0, y, 0, 0); }
  rotate() {}
  save() { this._stack.push({ t: { ...this._t }, clip: this._clip ? { ...this._clip } : null, fillStyle: this.fillStyle }); }
  restore() {
    const s = this._stack.pop();
    if (s) { this._t = s.t; this._clip = s.clip; this.fillStyle = s.fillStyle; }
  }

  _dev(x, y) {
    const t = this._t;
    return [t.e + x * t.a + y * t.c, t.f + x * t.b + y * t.d];
  }

  // --- path (rect-only, for clip) ---
  beginPath() { this._pathRects = []; }
  closePath() {}
  rect(x, y, w, h) { this._pathRects.push({ x, y, w, h }); }
  moveTo() {} lineTo() {} arc() {} arcTo() {} ellipse() {}
  fill() {} stroke() {}
  clip() {
    if (this._pathRects.length === 0) return;
    const r = this._pathRects[0];
    const [x0, y0] = this._dev(r.x, r.y);
    const [x1, y1] = this._dev(r.x + r.w, r.y + r.h);
    const nc = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    if (this._clip) {
      const ix = Math.max(this._clip.x, nc.x), iy = Math.max(this._clip.y, nc.y);
      const ix2 = Math.min(this._clip.x + this._clip.w, nc.x + nc.w);
      const iy2 = Math.min(this._clip.y + this._clip.h, nc.y + nc.h);
      this._clip = { x: ix, y: iy, w: Math.max(0, ix2 - ix), h: Math.max(0, iy2 - iy) };
    } else {
      this._clip = nc;
    }
  }

  _inClip(x, y) {
    if (!this._clip) return true;
    return x >= this._clip.x && y >= this._clip.y && x < this._clip.x + this._clip.w && y < this._clip.y + this._clip.h;
  }

  // --- pixels ---
  fillRect(x, y, w, h) {
    const [r, g, b, a] = parseColor(this.fillStyle);
    if (a === 0) return;
    const [dx0, dy0] = this._dev(x, y);
    const [dx1, dy1] = this._dev(x + w, y + h);
    const X0 = Math.max(0, Math.round(Math.min(dx0, dx1)));
    const Y0 = Math.max(0, Math.round(Math.min(dy0, dy1)));
    const X1 = Math.min(this.canvas.width, Math.round(Math.max(dx0, dx1)));
    const Y1 = Math.min(this.canvas.height, Math.round(Math.max(dy0, dy1)));
    const px = this.canvas._px;
    for (let yy = Y0; yy < Y1; yy++) {
      for (let xx = X0; xx < X1; xx++) {
        if (!this._inClip(xx, yy)) continue;
        const i = (yy * this.canvas.width + xx) * 4;
        px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
      }
    }
  }
  clearRect(x, y, w, h) { const fs = this.fillStyle; this.fillStyle = 'transparent'; /* leave pixels */ this.fillStyle = fs; }
  strokeRect() {}

  getImageData(x, y, w, h) {
    x |= 0; y |= 0; w |= 0; h |= 0;
    const out = new Uint8ClampedArray(w * h * 4);
    const px = this.canvas._px;
    for (let yy = 0; yy < h; yy++) {
      const sy = y + yy;
      if (sy < 0 || sy >= this.canvas.height) continue;
      for (let xx = 0; xx < w; xx++) {
        const sx = x + xx;
        if (sx < 0 || sx >= this.canvas.width) continue;
        const si = (sy * this.canvas.width + sx) * 4;
        const di = (yy * w + xx) * 4;
        out[di] = px[si]; out[di + 1] = px[si + 1]; out[di + 2] = px[si + 2]; out[di + 3] = px[si + 3];
      }
    }
    return { data: out, width: w, height: h };
  }

  putImageData(img, dx, dy) {
    dx |= 0; dy |= 0;
    const px = this.canvas._px;
    for (let yy = 0; yy < img.height; yy++) {
      const ty = dy + yy;
      if (ty < 0 || ty >= this.canvas.height) continue;
      for (let xx = 0; xx < img.width; xx++) {
        const tx = dx + xx;
        if (tx < 0 || tx >= this.canvas.width) continue;
        const si = (yy * img.width + xx) * 4;
        const ti = (ty * this.canvas.width + tx) * 4;
        px[ti] = img.data[si]; px[ti + 1] = img.data[si + 1]; px[ti + 2] = img.data[si + 2]; px[ti + 3] = img.data[si + 3];
      }
    }
  }

  createImageData(w, h) {
    if (typeof w === 'object') { h = w.height; w = w.width; }
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }

  drawImage(src, ...args) {
    let sx = 0, sy = 0, sw = src.width, sh = src.height, dx, dy, dw, dh;
    if (args.length === 2) { [dx, dy] = args; dw = sw; dh = sh; }
    else if (args.length === 4) { [dx, dy, dw, dh] = args; }
    else { [sx, sy, sw, sh, dx, dy, dw, dh] = args; }
    if (!src._px) return; // not a soft canvas
    const spx = src._px;
    const dpx = this.canvas._px;
    for (let yy = 0; yy < dh; yy++) {
      for (let xx = 0; xx < dw; xx++) {
        const ssx = sx + Math.floor(xx * sw / dw);
        const ssy = sy + Math.floor(yy * sh / dh);
        if (ssx < 0 || ssy < 0 || ssx >= src.width || ssy >= src.height) continue;
        const [fdx, fdy] = this._dev(dx + xx, dy + yy);
        const tx = Math.round(fdx), ty = Math.round(fdy);
        if (tx < 0 || ty < 0 || tx >= this.canvas.width || ty >= this.canvas.height) continue;
        if (!this._inClip(tx, ty)) continue;
        const si = (ssy * src.width + ssx) * 4;
        const sa = spx[si + 3];
        if (sa === 0) continue; // fully transparent source pixel
        const ti = (ty * this.canvas.width + tx) * 4;
        dpx[ti] = spx[si]; dpx[ti + 1] = spx[si + 1]; dpx[ti + 2] = spx[si + 2]; dpx[ti + 3] = 255;
      }
    }
  }

  // --- text (no-op) ---
  fillText() {} strokeText() {}
  measureText(s) { return { width: (s ? String(s).length : 0) * 8 }; }
  createLinearGradient() { return { addColorStop() {} }; }
  createRadialGradient() { return { addColorStop() {} }; }
  createPattern() { return null; }
  setLineDash() {} getLineDash() { return []; }
}

export class SoftCanvas {
  constructor(w, h) {
    this._w = Math.max(1, w | 0);
    this._h = Math.max(1, h | 0);
    this._px = new Uint8ClampedArray(this._w * this._h * 4);
    this._ctx = new SoftContext(this);
    this.style = { cursor: 'default' };
    this.parentElement = { style: { cursor: 'default' } };
  }
  get width() { return this._w; }
  set width(v) { this._resize(v | 0, this._h); }
  get height() { return this._h; }
  set height(v) { this._resize(this._w, v | 0); }
  _resize(w, h) {
    w = Math.max(1, w); h = Math.max(1, h);
    const np = new Uint8ClampedArray(w * h * 4);
    const cw = Math.min(w, this._w), ch = Math.min(h, this._h);
    for (let y = 0; y < ch; y++) {
      np.set(this._px.subarray(y * this._w * 4, y * this._w * 4 + cw * 4), y * w * 4);
    }
    this._w = w; this._h = h; this._px = np;
  }
  getContext() { return this._ctx; }
  toDataURL() { return 'data:image/png;base64,'; }
  addEventListener() {} removeEventListener() {}
}

/** Install SoftCanvas as the global OffscreenCanvas + document.createElement('canvas') mock. */
export function installSoftCanvas(screenW = 800, screenH = 600) {
  globalThis.OffscreenCanvas = SoftCanvas;
  globalThis.document = {
    createElement: () => new SoftCanvas(screenW, screenH),
    title: '',
  };
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.Image = class { set src(_) {} };
  // Augment Node's URL constructor instead of replacing it (loaders need `new URL`)
  if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => 'blob:mock';
  if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {};
  globalThis.Blob = class { constructor() {} };
  return new SoftCanvas(screenW, screenH);
}
