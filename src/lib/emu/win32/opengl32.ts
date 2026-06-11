import type { Emulator } from '../emulator';
import { GL1Context } from './gl-context';
import { emuCompleteThunk } from '../emu-exec';

// Helper: read a float from stack arg (passed as 32-bit IEEE 754)
function readFloat(emu: Emulator, argIdx: number): number {
  const bits = emu.readArg(argIdx);
  const buf = new DataView(new ArrayBuffer(4));
  buf.setUint32(0, bits, false);
  return buf.getFloat32(0, false);
}

// Helper: read a double from 2 consecutive stack dwords (little-endian)
function readDouble(emu: Emulator, argIdx: number): number {
  const lo = emu.readArg(argIdx);
  const hi = emu.readArg(argIdx + 1);
  const buf = new DataView(new ArrayBuffer(8));
  buf.setUint32(0, lo, true);
  buf.setUint32(4, hi, true);
  return buf.getFloat64(0, true);
}

// Helper: read N floats from a pointer in emulator memory
function readFloatPtr(emu: Emulator, ptr: number, count: number): Float32Array {
  const result = new Float32Array(count);
  const buf = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < count; i++) {
    const bits = emu.memory.readU32(ptr + i * 4);
    buf.setUint32(0, bits, false);
    result[i] = buf.getFloat32(0, false);
  }
  return result;
}

// Helper: read N doubles from a pointer
function readDoublePtr(emu: Emulator, ptr: number, count: number): Float64Array {
  const result = new Float64Array(count);
  const buf = new DataView(new ArrayBuffer(8));
  for (let i = 0; i < count; i++) {
    const lo = emu.memory.readU32(ptr + i * 8);
    const hi = emu.memory.readU32(ptr + i * 8 + 4);
    buf.setUint32(0, lo, true);
    buf.setUint32(4, hi, true);
    result[i] = buf.getFloat64(0, true);
  }
  return result;
}

function getGL(emu: Emulator): GL1Context | null {
  return emu.glContext;
}

export function registerOpengl32(emu: Emulator): void {
  const opengl32 = emu.registerDll('OPENGL32.DLL');

  // Map of HGLRC handle → GL1Context
  const glContexts = new Map<number, GL1Context>();
  let currentHglrc = 0;

  // wgl context management
  const GL_SCALE = 1; // Supersampling factor for GL rendering

  opengl32.register('wglCreateContext', 1, () => {
    const w = (emu.canvas?.width || 640) * GL_SCALE;
    const h = (emu.canvas?.height || 480) * GL_SCALE;
    const handle = emu.handles.alloc('glrc', {});
    try {
      const ctx = new GL1Context(w, h);
      glContexts.set(handle, ctx);
      console.log(`[GL] Created GL1Context ${w}x${h} handle=0x${handle.toString(16)}`);
    } catch (e: unknown) {
      console.warn(`[GL] Failed to create GL1Context: ${e instanceof Error ? e.message : String(e)}`);
    }
    return handle;
  });

  opengl32.register('wglMakeCurrent', 2, () => {
    const hdc = emu.readArg(0);
    const hglrc = emu.readArg(1);
    if (hglrc === 0) {
      // Deactivate
      emu.glContext = null;
      currentHglrc = 0;
    } else {
      const ctx = glContexts.get(hglrc);
      if (ctx) {
        emu.glContext = ctx;
        currentHglrc = hglrc;
      }
    }
    return 1;
  });
  opengl32.register('wglDeleteContext', 1, () => {
    const hglrc = emu.readArg(0);
    glContexts.delete(hglrc);
    if (currentHglrc === hglrc) {
      emu.glContext = null;
      currentHglrc = 0;
    }
    return 1;
  });
  opengl32.register('wglGetProcAddress', 1, () => 0);
  opengl32.register('wglGetCurrentContext', 0, () => currentHglrc);
  opengl32.register('wglGetCurrentDC', 0, () => currentHglrc ? 1 : 0);
  opengl32.register('wglShareLists', 2, () => 1);

  // wglUseFontOutlinesW(hdc, first, count, listBase, deviation, extrusion, format, lpgmf)
  opengl32.register('wglUseFontOutlinesW', 8, () => {
    const _hdc = emu.readArg(0);
    const first = emu.readArg(1);
    const count = emu.readArg(2);
    const listBaseArg = emu.readArg(3);
    // deviation(4), extrusion(5), format(6) — ignored in stub
    const lpgmf = emu.readArg(7);
    const gl = getGL(emu);
    if (!gl) return 0;
    const cellWidth = 0.6; // approximate glyph cell width in GL units
    const cellHeight = 1.0;
    for (let i = 0; i < count; i++) {
      const listId = listBaseArg + i;
      // Build a display list that translates by cellWidth (advancing the "cursor")
      gl.newList(listId, 0x1300 /* GL_COMPILE */);
      gl.translatef(cellWidth, 0, 0);
      gl.endList();
      // Fill GLYPHMETRICSFLOAT if pointer provided (24 bytes per entry)
      if (lpgmf) {
        const off = lpgmf + i * 24;
        const buf = new Float32Array([cellWidth, cellHeight, 0, 0, cellWidth, 0]);
        for (let j = 0; j < 6; j++) emu.memory.writeU32(off + j * 4, new Uint32Array(buf.buffer)[j]);
      }
    }
    return 1;
  });

  // glGetString
  opengl32.register('glGetString', 1, () => {
    const name = emu.readArg(0);
    const gl = getGL(emu);
    const str = gl ? gl.getString(name) : '';
    const addr = emu.allocHeap(str.length + 1);
    for (let i = 0; i < str.length; i++) emu.memory.writeU8(addr + i, str.charCodeAt(i));
    emu.memory.writeU8(addr + str.length, 0);
    return addr;
  });

  // glGetIntegerv
  opengl32.register('glGetIntegerv', 2, () => {
    const pname = emu.readArg(0);
    const ptr = emu.readArg(1);
    const gl = getGL(emu);
    if (!ptr) return 0;
    if (pname === 0x0BA2 /* GL_VIEWPORT */) {
      const vp = gl ? gl.getViewport() : [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) emu.memory.writeU32(ptr + i * 4, vp[i] | 0);
    } else {
      emu.memory.writeU32(ptr, gl ? gl.getIntegerv(pname) : 0);
    }
    return 0;
  });

  // glGetFloatv / glGetDoublev — mostly used to retrieve matrices
  function writeMatrixFloats(ptr: number, m: Float32Array) {
    const buf = new DataView(new ArrayBuffer(4));
    for (let i = 0; i < 16; i++) {
      buf.setFloat32(0, m[i], true);
      emu.memory.writeU32(ptr + i * 4, buf.getUint32(0, true));
    }
  }
  function writeMatrixDoubles(ptr: number, m: Float32Array) {
    const buf = new DataView(new ArrayBuffer(8));
    for (let i = 0; i < 16; i++) {
      buf.setFloat64(0, m[i], true);
      emu.memory.writeU32(ptr + i * 8, buf.getUint32(0, true));
      emu.memory.writeU32(ptr + i * 8 + 4, buf.getUint32(4, true));
    }
  }
  opengl32.register('glGetFloatv', 2, () => {
    const pname = emu.readArg(0);
    const ptr = emu.readArg(1);
    const gl = getGL(emu);
    if (!ptr || !gl) return 0;
    const m = gl.getMatrix(pname);
    if (m) writeMatrixFloats(ptr, m);
    else if (pname === 0x0BA2 /* GL_VIEWPORT */) {
      const vp = gl.getViewport();
      const buf = new DataView(new ArrayBuffer(4));
      for (let i = 0; i < 4; i++) {
        buf.setFloat32(0, vp[i], true);
        emu.memory.writeU32(ptr + i * 4, buf.getUint32(0, true));
      }
    }
    return 0;
  });
  opengl32.register('glGetDoublev', 2, () => {
    const pname = emu.readArg(0);
    const ptr = emu.readArg(1);
    const gl = getGL(emu);
    if (!ptr || !gl) return 0;
    const m = gl.getMatrix(pname);
    if (m) writeMatrixDoubles(ptr, m);
    return 0;
  });

  // glGetTexEnviv
  opengl32.register('glGetTexEnviv', 3, () => {
    const _target = emu.readArg(0);
    const pname = emu.readArg(1);
    const ptr = emu.readArg(2);
    const gl = getGL(emu);
    if (ptr) emu.memory.writeU32(ptr, gl ? gl.getTexEnviv(pname) : 0);
    return 0;
  });

  // Texture generation
  opengl32.register('glGenTextures', 2, () => {
    const n = emu.readArg(0);
    const ptr = emu.readArg(1);
    const gl = getGL(emu);
    if (gl) {
      const ids = gl.genTextures(n);
      for (let i = 0; i < n; i++) emu.memory.writeU32(ptr + i * 4, ids[i]);
    } else {
      for (let i = 0; i < n; i++) emu.memory.writeU32(ptr + i * 4, emu.handles.alloc('gltex', {}));
    }
    return 0;
  });

  opengl32.register('glDeleteTextures', 2, () => {
    const n = emu.readArg(0);
    const ptr = emu.readArg(1);
    const gl = getGL(emu);
    if (gl) {
      const ids: number[] = [];
      for (let i = 0; i < n; i++) ids.push(emu.memory.readU32(ptr + i * 4));
      gl.deleteTextures(ids);
    }
    return 0;
  });

  // Display lists
  opengl32.register('glGenLists', 1, () => {
    const range = emu.readArg(0);
    return emu.handles.alloc('gllist', { range });
  });

  // Matrix operations
  opengl32.register('glMatrixMode', 1, () => { getGL(emu)?.matrixModeSet(emu.readArg(0)); return 0; });
  opengl32.register('glLoadIdentity', 0, () => { getGL(emu)?.loadIdentity(); return 0; });
  opengl32.register('glPushMatrix', 0, () => { getGL(emu)?.pushMatrix(); return 0; });
  opengl32.register('glPopMatrix', 0, () => { getGL(emu)?.popMatrix(); return 0; });

  opengl32.register('glTranslatef', 3, () => {
    getGL(emu)?.translatef(readFloat(emu, 0), readFloat(emu, 1), readFloat(emu, 2));
    return 0;
  });

  opengl32.register('glTranslated', 6, () => {
    const x = readDouble(emu, 0), y = readDouble(emu, 2), z = readDouble(emu, 4);
    getGL(emu)?.translatef(x, y, z);
    return 0;
  });

  opengl32.register('glRotatef', 4, () => {
    getGL(emu)?.rotatef(readFloat(emu, 0), readFloat(emu, 1), readFloat(emu, 2), readFloat(emu, 3));
    return 0;
  });

  opengl32.register('glRotated', 8, () => {
    const angle = readDouble(emu, 0), x = readDouble(emu, 2), y = readDouble(emu, 4), z = readDouble(emu, 6);
    getGL(emu)?.rotatef(angle, x, y, z);
    return 0;
  });

  opengl32.register('glScaled', 6, () => {
    const x = readDouble(emu, 0), y = readDouble(emu, 2), z = readDouble(emu, 4);
    getGL(emu)?.scalef(x, y, z);
    return 0;
  });

  opengl32.register('glScalef', 3, () => {
    getGL(emu)?.scalef(readFloat(emu, 0), readFloat(emu, 1), readFloat(emu, 2));
    return 0;
  });

  opengl32.register('glOrtho', 12, () => {
    const left = readDouble(emu, 0), right = readDouble(emu, 2);
    const bottom = readDouble(emu, 4), top = readDouble(emu, 6);
    const zNear = readDouble(emu, 8), zFar = readDouble(emu, 10);
    getGL(emu)?.ortho(left, right, bottom, top, zNear, zFar);
    return 0;
  });

  opengl32.register('glFrustum', 12, () => {
    const left = readDouble(emu, 0), right = readDouble(emu, 2);
    const bottom = readDouble(emu, 4), top = readDouble(emu, 6);
    const zNear = readDouble(emu, 8), zFar = readDouble(emu, 10);
    getGL(emu)?.frustum(left, right, bottom, top, zNear, zFar);
    return 0;
  });

  // Enable/Disable
  opengl32.register('glEnable', 1, () => { getGL(emu)?.enable(emu.readArg(0)); return 0; });
  opengl32.register('glDisable', 1, () => { getGL(emu)?.disable(emu.readArg(0)); return 0; });

  // Viewport and state
  opengl32.register('glViewport', 4, () => {
    getGL(emu)?.viewport(emu.readArg(0) * GL_SCALE, emu.readArg(1) * GL_SCALE, emu.readArg(2) * GL_SCALE, emu.readArg(3) * GL_SCALE);
    return 0;
  });
  opengl32.register('glScissor', 4, () => {
    getGL(emu)?.scissor(emu.readArg(0), emu.readArg(1), emu.readArg(2), emu.readArg(3));
    return 0;
  });
  opengl32.register('glHint', 2, () => { getGL(emu)?.hint(emu.readArg(0), emu.readArg(1)); return 0; });
  opengl32.register('glCullFace', 1, () => { getGL(emu)?.cullFace(emu.readArg(0)); return 0; });
  opengl32.register('glFrontFace', 1, () => { getGL(emu)?.frontFace(emu.readArg(0)); return 0; });
  opengl32.register('glPolygonMode', 2, () => { getGL(emu)?.polygonMode(emu.readArg(0), emu.readArg(1)); return 0; });
  opengl32.register('glShadeModel', 1, () => { getGL(emu)?.shadeModel(emu.readArg(0)); return 0; });
  opengl32.register('glBlendFunc', 2, () => { getGL(emu)?.blendFunc(emu.readArg(0), emu.readArg(1)); return 0; });

  // Clear
  opengl32.register('glClear', 1, () => {
    getGL(emu)?.clear(emu.readArg(0));
    return 0;
  });
  opengl32.register('glClearDepth', 2, () => { getGL(emu)?.clearDepth(readDouble(emu, 0)); return 0; });
  opengl32.register('glClearColor', 4, () => {
    getGL(emu)?.clearColor(readFloat(emu, 0), readFloat(emu, 1), readFloat(emu, 2), readFloat(emu, 3));
    return 0;
  });
  opengl32.register('glDepthFunc', 1, () => { getGL(emu)?.depthFunc(emu.readArg(0)); return 0; });

  // Lighting
  opengl32.register('glLightfv', 3, () => {
    const light = emu.readArg(0);
    const pname = emu.readArg(1);
    const ptr = emu.readArg(2);
    getGL(emu)?.lightfv(light, pname, readFloatPtr(emu, ptr, 4));
    return 0;
  });

  opengl32.register('glLightModelfv', 2, () => {
    const pname = emu.readArg(0);
    const ptr = emu.readArg(1);
    getGL(emu)?.lightModelfv(pname, readFloatPtr(emu, ptr, 4));
    return 0;
  });

  opengl32.register('glLightModeli', 2, () => {
    getGL(emu)?.lightModeli(emu.readArg(0), emu.readArg(1));
    return 0;
  });

  // Texture env
  opengl32.register('glTexEnvi', 3, () => {
    getGL(emu)?.texEnvi(emu.readArg(0), emu.readArg(1), emu.readArg(2));
    return 0;
  });

  // Texture params
  opengl32.register('glTexParameteri', 3, () => {
    getGL(emu)?.texParameteri(emu.readArg(0), emu.readArg(1), emu.readArg(2));
    return 0;
  });

  opengl32.register('glBindTexture', 2, () => {
    getGL(emu)?.bindTexture(emu.readArg(0), emu.readArg(1));
    return 0;
  });

  opengl32.register('glPixelStorei', 2, () => {
    getGL(emu)?.pixelStorei(emu.readArg(0), emu.readArg(1));
    return 0;
  });

  // glTexImage2D(target, level, internalformat, width, height, border, format, type, pixels)
  opengl32.register('glTexImage2D', 9, () => {
    const target = emu.readArg(0);
    const level = emu.readArg(1);
    const internalFormat = emu.readArg(2);
    const width = emu.readArg(3);
    const height = emu.readArg(4);
    const border = emu.readArg(5);
    const format = emu.readArg(6);
    const type = emu.readArg(7);
    const pixelsPtr = emu.readArg(8);

    const gl = getGL(emu);
    if (!gl) return 0;

    let pixels: Uint8Array | null = null;
    if (pixelsPtr) {
      // Determine bytes per pixel
      let bpp = 4;
      if (format === 0x1907) bpp = 3; // GL_RGB
      else if (format === 0x1909) bpp = 1; // GL_LUMINANCE
      else if (format === 0x190A) bpp = 2; // GL_LUMINANCE_ALPHA
      else if (format === 0x1906) bpp = 1; // GL_ALPHA
      else if (format === 0x80E0) bpp = 3; // GL_BGR_EXT
      else if (format === 0x80E1) bpp = 4; // GL_BGRA_EXT
      const size = width * height * bpp;
      pixels = new Uint8Array(size);
      for (let i = 0; i < size; i++) pixels[i] = emu.memory.readU8(pixelsPtr + i);
    }

    gl.texImage2D(target, level, internalFormat, width, height, border, format, type, pixels);
    return 0;
  });

  // Immediate mode
  opengl32.register('glBegin', 1, () => {
    getGL(emu)?.begin(emu.readArg(0));
    return 0;
  });
  opengl32.register('glEnd', 0, () => { getGL(emu)?.end(); return 0; });

  opengl32.register('glVertex2f', 2, () => {
    getGL(emu)?.vertex2f(readFloat(emu, 0), readFloat(emu, 1));
    return 0;
  });

  opengl32.register('glVertex3f', 3, () => {
    getGL(emu)?.vertex3f(readFloat(emu, 0), readFloat(emu, 1), readFloat(emu, 2));
    return 0;
  });

  opengl32.register('glVertex3dv', 1, () => {
    const ptr = emu.readArg(0);
    const v = readDoublePtr(emu, ptr, 3);
    getGL(emu)?.vertex3f(v[0], v[1], v[2]);
    return 0;
  });

  opengl32.register('glNormal3f', 3, () => {
    getGL(emu)?.normal3f(readFloat(emu, 0), readFloat(emu, 1), readFloat(emu, 2));
    return 0;
  });

  opengl32.register('glNormal3dv', 1, () => {
    const ptr = emu.readArg(0);
    const v = readDoublePtr(emu, ptr, 3);
    getGL(emu)?.normal3f(v[0], v[1], v[2]);
    return 0;
  });

  opengl32.register('glNormal3fv', 1, () => {
    const ptr = emu.readArg(0);
    const v = readFloatPtr(emu, ptr, 3);
    getGL(emu)?.normal3f(v[0], v[1], v[2]);
    return 0;
  });

  opengl32.register('glVertex3fv', 1, () => {
    const ptr = emu.readArg(0);
    const v = readFloatPtr(emu, ptr, 3);
    getGL(emu)?.vertex3f(v[0], v[1], v[2]);
    return 0;
  });

  opengl32.register('glColor3f', 3, () => {
    getGL(emu)?.color3f(readFloat(emu, 0), readFloat(emu, 1), readFloat(emu, 2));
    return 0;
  });

  opengl32.register('glColor3fv', 1, () => {
    const ptr = emu.readArg(0);
    const v = readFloatPtr(emu, ptr, 3);
    getGL(emu)?.color3f(v[0], v[1], v[2]);
    return 0;
  });

  opengl32.register('glColor4f', 4, () => {
    getGL(emu)?.color4f(readFloat(emu, 0), readFloat(emu, 1), readFloat(emu, 2), readFloat(emu, 3));
    return 0;
  });

  opengl32.register('glColorMask', 4, () => {
    getGL(emu)?.colorMask(!!emu.readArg(0), !!emu.readArg(1), !!emu.readArg(2), !!emu.readArg(3));
    return 0;
  });
  opengl32.register('glDepthMask', 1, () => { getGL(emu)?.depthMask(!!emu.readArg(0)); return 0; });
  opengl32.register('glStencilMask', 1, () => { getGL(emu)?.stencilMask(emu.readArg(0)); return 0; });
  opengl32.register('glStencilFunc', 3, () => {
    getGL(emu)?.stencilFunc(emu.readArg(0), emu.readArg(1) | 0, emu.readArg(2));
    return 0;
  });
  opengl32.register('glStencilOp', 3, () => {
    getGL(emu)?.stencilOp(emu.readArg(0), emu.readArg(1), emu.readArg(2));
    return 0;
  });
  opengl32.register('glClearStencil', 1, () => { getGL(emu)?.clearStencil(emu.readArg(0) | 0); return 0; });
  opengl32.register('glPolygonOffset', 2, () => {
    getGL(emu)?.polygonOffset(readFloat(emu, 0), readFloat(emu, 1));
    return 0;
  });

  // glColorMaterial(face, mode) — our shader treats glColor as the material color
  // already, so this is effectively a no-op. Just accept the call.
  opengl32.register('glColorMaterial', 2, () => 0);

  // Fog — accept but don't implement (demos typically work fine without fog in WebGL)
  opengl32.register('glFogf', 2, () => 0);
  opengl32.register('glFogi', 2, () => 0);
  opengl32.register('glFogfv', 2, () => 0);
  opengl32.register('glFogiv', 2, () => 0);

  // Attribute stack — no-op stubs (WebGL doesn't have server-side attrib stacks)
  opengl32.register('glPushAttrib', 1, () => 0);
  opengl32.register('glPopAttrib', 0, () => 0);
  opengl32.register('glPushClientAttrib', 1, () => 0);
  opengl32.register('glPopClientAttrib', 0, () => 0);

  // TexGen — not available in WebGL2 core. Accept calls so sphere mapping etc.
  // doesn't crash; the texcoords will simply not be generated automatically.
  opengl32.register('glTexGeni', 3, () => 0);
  opengl32.register('glTexGenf', 3, () => 0);
  opengl32.register('glTexGend', 4, () => 0);
  opengl32.register('glTexGenfv', 3, () => 0);
  opengl32.register('glTexGeniv', 3, () => 0);
  opengl32.register('glTexGendv', 3, () => 0);

  // ReadPixels / CopyTexImage — used for screen-space effects.
  // Stub: leave destination unchanged (caller sees garbage or zeros).
  opengl32.register('glReadPixels', 7, () => 0);
  opengl32.register('glReadBuffer', 1, () => 0);
  opengl32.register('glDrawBuffer', 1, () => 0);
  opengl32.register('glCopyTexImage2D', 8, () => 0);
  opengl32.register('glCopyTexSubImage2D', 8, () => 0);
  opengl32.register('glCopyPixels', 5, () => 0);
  opengl32.register('glPixelTransferf', 2, () => 0);
  opengl32.register('glPixelTransferi', 2, () => 0);
  opengl32.register('glPixelZoom', 2, () => 0);

  // Accumulation buffer — not supported, noop.
  opengl32.register('glAccum', 2, () => 0);
  opengl32.register('glClearAccum', 4, () => 0);

  // Raster position / DrawPixels — rarely critical, noop.
  opengl32.register('glRasterPos2i', 2, () => 0);
  opengl32.register('glRasterPos2f', 2, () => 0);
  opengl32.register('glRasterPos3f', 3, () => 0);
  opengl32.register('glRasterPos3fv', 1, () => 0);
  opengl32.register('glRasterPos4fv', 1, () => 0);
  opengl32.register('glWindowPos2i', 2, () => 0);
  opengl32.register('glWindowPos2f', 2, () => 0);
  opengl32.register('glDrawPixels', 5, () => 0);
  opengl32.register('glBitmap', 7, () => 0);

  // Clip planes — noop (not supported by our shader).
  opengl32.register('glClipPlane', 2, () => 0);

  // Point & line attributes — noop (WebGL only has default sizes).
  opengl32.register('glPointSize', 1, () => 0);
  opengl32.register('glLineWidth', 1, () => 0);
  opengl32.register('glLineStipple', 2, () => 0);
  opengl32.register('glPolygonStipple', 1, () => 0);

  // Error reporting — always return GL_NO_ERROR (0).
  opengl32.register('glGetError', 0, () => 0);

  // Edge flags — ignored.
  opengl32.register('glEdgeFlag', 1, () => 0);

  opengl32.register('glColor4fv', 1, () => {
    const ptr = emu.readArg(0);
    const v = readFloatPtr(emu, ptr, 4);
    getGL(emu)?.color4f(v[0], v[1], v[2], v[3]);
    return 0;
  });

  opengl32.register('glTexCoord2f', 2, () => {
    getGL(emu)?.texCoord2f(readFloat(emu, 0), readFloat(emu, 1));
    return 0;
  });

  opengl32.register('glTexCoord2d', 4, () => {
    getGL(emu)?.texCoord2f(readDouble(emu, 0), readDouble(emu, 2));
    return 0;
  });

  // Display lists
  opengl32.register('glNewList', 2, () => { getGL(emu)?.newList(emu.readArg(0), emu.readArg(1)); return 0; });
  opengl32.register('glEndList', 0, () => { getGL(emu)?.endList(); return 0; });
  opengl32.register('glCallList', 1, () => { getGL(emu)?.callList(emu.readArg(0)); return 0; });
  opengl32.register('glCallLists', 3, () => {
    const n = emu.readArg(0);
    const type = emu.readArg(1);
    const listsPtr = emu.readArg(2);
    const gl = getGL(emu);
    if (gl && listsPtr) {
      const GL_UNSIGNED_BYTE = 0x1401;
      const GL_UNSIGNED_SHORT = 0x1403;
      const GL_UNSIGNED_INT = 0x1405;
      for (let i = 0; i < n; i++) {
        let id: number;
        if (type === GL_UNSIGNED_BYTE) id = emu.memory.readU8(listsPtr + i);
        else if (type === GL_UNSIGNED_SHORT) id = emu.memory.readU16(listsPtr + i * 2);
        else if (type === GL_UNSIGNED_INT) id = emu.memory.readU32(listsPtr + i * 4);
        else id = emu.memory.readU8(listsPtr + i);
        gl.callList(gl.listBase + id);
      }
    }
    return 0;
  });
  opengl32.register('glIsList', 1, () => {
    const gl = getGL(emu);
    return gl ? (gl.isList(emu.readArg(0)) ? 1 : 0) : 0;
  });
  opengl32.register('glListBase', 1, () => {
    const gl = getGL(emu);
    if (gl) gl.listBase = emu.readArg(0);
    return 0;
  });
  opengl32.register('glDeleteLists', 2, () => {
    getGL(emu)?.deleteLists(emu.readArg(0), emu.readArg(1));
    return 0;
  });

  // Material
  opengl32.register('glMaterialfv', 3, () => {
    const face = emu.readArg(0);
    const pname = emu.readArg(1);
    const ptr = emu.readArg(2);
    getGL(emu)?.materialfv(face, pname, readFloatPtr(emu, ptr, 4));
    return 0;
  });
  opengl32.register('glMaterialf', 3, () => {
    const face = emu.readArg(0);
    const pname = emu.readArg(1);
    const param = readFloat(emu, 2);
    getGL(emu)?.materialf(face, pname, param);
    return 0;
  });

  // Evaluators
  opengl32.register('glMap2f', 10, () => {
    // glMap2f(target, u1, u2, ustride, uorder, v1, v2, vstride, vorder, points)
    const target = emu.readArg(0);
    const u1 = readFloat(emu, 1), u2 = readFloat(emu, 2);
    const ustride = emu.readArg(3), uorder = emu.readArg(4);
    const v1 = readFloat(emu, 5), v2 = readFloat(emu, 6);
    const vstride = emu.readArg(7), vorder = emu.readArg(8);
    const ptr = emu.readArg(9);
    // Read all control points from memory. Points are laid out as:
    // for v in 0..vorder: for u in 0..uorder: point at offset (v*vstride + u*ustride) floats from ptr
    // We store them in a flat array with the same stride layout
    const totalFloats = (vorder - 1) * vstride + (uorder - 1) * ustride + 3; // conservative upper bound
    const points = readFloatPtr(emu, ptr, Math.max(totalFloats, uorder * vorder * 3));
    getGL(emu)?.map2f(target, u1, u2, ustride, uorder, v1, v2, vstride, vorder, points);
    return 0;
  });
  opengl32.register('glMapGrid2f', 6, () => {
    const un = emu.readArg(0);
    const u1 = readFloat(emu, 1), u2 = readFloat(emu, 2);
    const vn = emu.readArg(3);
    const v1 = readFloat(emu, 4), v2 = readFloat(emu, 5);
    getGL(emu)?.mapGrid2f(un, u1, u2, vn, v1, v2);
    return 0;
  });
  opengl32.register('glEvalMesh2', 5, () => {
    getGL(emu)?.evalMesh2(emu.readArg(0), emu.readArg(1), emu.readArg(2), emu.readArg(3), emu.readArg(4));
    return 0;
  });

  // Vertex arrays
  let vaPtr = 0, vaSize = 3, vaStride = 0;
  let naPtr = 0, naStride = 0;

  opengl32.register('glEnableClientState', 1, () => {
    getGL(emu)?.enableClientState(emu.readArg(0));
    return 0;
  });
  opengl32.register('glDisableClientState', 1, () => {
    getGL(emu)?.disableClientState(emu.readArg(0));
    return 0;
  });
  opengl32.register('glVertexPointer', 4, () => {
    vaSize = emu.readArg(0);
    // arg1 = type (GL_FLOAT), arg2 = stride, arg3 = pointer
    vaStride = emu.readArg(2);
    vaPtr = emu.readArg(3);
    return 0;
  });
  opengl32.register('glNormalPointer', 3, () => {
    // arg0 = type, arg1 = stride, arg2 = pointer
    naStride = emu.readArg(1);
    naPtr = emu.readArg(2);
    return 0;
  });

  // Texture coord array — tracked but only consumed by our glDrawArrays/Elements emulation
  let taSize = 2, taStride = 0, taPtr = 0;
  let caSize = 4, caStride = 0, caPtr = 0;
  opengl32.register('glTexCoordPointer', 4, () => {
    taSize = emu.readArg(0);
    taStride = emu.readArg(2);
    taPtr = emu.readArg(3);
    return 0;
  });
  opengl32.register('glColorPointer', 4, () => {
    caSize = emu.readArg(0);
    caStride = emu.readArg(2);
    caPtr = emu.readArg(3);
    return 0;
  });
  void taSize; void taStride; void taPtr;
  void caSize; void caStride; void caPtr;
  // glArrayElement(i) — emit vertex i from the enabled vertex arrays.
  // Minimal: read the vertex from glVertexPointer buffer and push it via glVertex3f/2f.
  opengl32.register('glArrayElement', 1, () => {
    const gl = getGL(emu);
    if (!gl || !vaPtr) return 0;
    const i = emu.readArg(0);
    const stride = vaStride || vaSize * 4;
    const base = vaPtr + i * stride;
    const v = readFloatPtr(emu, base, vaSize);
    if (naPtr) {
      const nStride = naStride || 12;
      const n = readFloatPtr(emu, naPtr + i * nStride, 3);
      gl.normal3f(n[0], n[1], n[2]);
    }
    if (vaSize >= 3) gl.vertex3f(v[0], v[1], v[2]);
    else gl.vertex2f(v[0], v[1]);
    return 0;
  });

  // glDrawArrays(mode, first, count) — draw count vertices starting from `first`
  opengl32.register('glDrawArrays', 3, () => {
    const gl = getGL(emu);
    if (!gl || !vaPtr) return 0;
    const mode = emu.readArg(0);
    const first = emu.readArg(1);
    const count = emu.readArg(2);
    const stride = vaStride || vaSize * 4;
    gl.begin(mode);
    for (let i = 0; i < count; i++) {
      const base = vaPtr + (first + i) * stride;
      const v = readFloatPtr(emu, base, vaSize);
      if (naPtr) {
        const nStride = naStride || 12;
        const n = readFloatPtr(emu, naPtr + (first + i) * nStride, 3);
        gl.normal3f(n[0], n[1], n[2]);
      }
      if (vaSize >= 3) gl.vertex3f(v[0], v[1], v[2]);
      else gl.vertex2f(v[0], v[1]);
    }
    gl.end();
    return 0;
  });

  opengl32.register('glDrawElements', 4, () => {
    const gl = getGL(emu);
    if (!gl) return 0;
    const mode = emu.readArg(0);
    const count = emu.readArg(1);
    const type = emu.readArg(2);
    const idxPtr = emu.readArg(3);

    // Read vertex data from emulator memory and pass to GL context
    // First figure out max index to know how many vertices to read
    const indices = new Uint32Array(count);
    let maxIdx = 0;
    for (let i = 0; i < count; i++) {
      const idx = type === 0x1403 /* GL_UNSIGNED_SHORT */
        ? emu.memory.readU16(idxPtr + i * 2)
        : emu.memory.readU32(idxPtr + i * 4);
      indices[i] = idx;
      if (idx > maxIdx) maxIdx = idx;
    }

    // Read vertex array
    const vFloatsPerVert = vaStride ? vaStride / 4 : vaSize;
    const vCount = maxIdx + 1;
    const vData = readFloatPtr(emu, vaPtr, vCount * vFloatsPerVert);
    gl.vertexPointer(vaSize, 0x1406, vaStride, vData);

    // Read normal array if set
    if (naPtr) {
      const nFloatsPerVert = naStride ? naStride / 4 : 3;
      const nData = readFloatPtr(emu, naPtr, vCount * nFloatsPerVert);
      gl.normalPointer(0x1406, naStride, nData);
    }

    gl.drawElements(mode, count, indices);
    return 0;
  });

  // Flush/Finish — auto-blit GL canvas to main canvas (needed for stretch-mode apps that use BitBlt instead of SwapBuffers)
  const blitGL = () => {
    const glc = emu.glContext;
    if (glc && emu.canvasCtx && emu.canvas) {
      glc.gl.flush();
      // Read the current viewport to determine the rendered region
      const vp = glc.gl.getParameter(glc.gl.VIEWPORT) as Int32Array;
      const sx = vp[0], sy = vp[1], sw = vp[2], sh = vp[3];
      // Blit viewport region stretched to fill the main canvas
      // GL viewport Y is bottom-up, canvas Y is top-down: flip by reading from (sx, canvasH - sy - sh)
      const srcY = glc.canvas.height - sy - sh;
      emu.canvasCtx.drawImage(glc.canvas, sx, srcY, sw, sh, 0, 0, emu.canvas.width, emu.canvas.height);
    }
  };
  opengl32.register('glFlush', 0, () => { getGL(emu)?.flush(); blitGL(); return 0; });
  opengl32.register('glFinish', 0, () => {
    // If previous frame yielded at glFinish but never reached SwapBuffers,
    // treat this glFinish as the start of a new frame.
    if (emu.glSyncYieldedThisFrame && emu.glSyncAwaitingSwap) {
      emu.glSyncYieldedThisFrame = false;
      emu.glSyncAwaitingSwap = false;
    }
    // v86 backend: blit synchronously, don't rAF-defer (would mis-resume an
    // unrelated parked thunk). v86's scheduler handles frame pacing.
    if (emu._v86Runtime) {
      getGL(emu)?.finish();
      blitGL();
      return 0;
    }

    // If this frame already yielded (e.g. at SwapBuffers), don't block again.
    if (emu.glSyncYieldedThisFrame) {
      getGL(emu)?.finish();
      blitGL();
      return 0;
    }

    const stackBytes = emu._currentThunkStackBytes;
    emu.glSyncYieldedThisFrame = true;
    emu.glSyncAwaitingSwap = true;
    emu.waitingForMessage = true;
    requestAnimationFrame(() => {
      getGL(emu)?.finish();
      blitGL();
      emu.waitingForMessage = false;
      emuCompleteThunk(emu, 0, stackBytes);
      if (emu.running && !emu.halted) requestAnimationFrame(emu.tick);
    });
    return undefined;
  });
}
