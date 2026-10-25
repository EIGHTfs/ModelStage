// engine/gl.js —— WebGL 上下文、像素尺寸、DPR 与渲染器探测
//
// 边界：只管"画布与上下文"，不碰骨架/动画/相机（相机在 camera-adapter，B2 落地）。
// DPR 语义auto 时软件渲染钳 1，否则 min(deviceDpr, 2)。

/** 软件渲染探测正则 */
const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|basic render|software|warp|mesa offscreen/i;

/**
 * 建上下文。
 * @param {HTMLCanvasElement} canvas
 * @param {{antialias?: boolean}} opts
 * @returns {{gl: WebGLRenderingContext|null, isSoftware: boolean, rendererStr: string}}
 */
export function createContext(canvas, opts = {}) {
  const attrs = {
    premultipliedAlpha: true,
    antialias: opts.antialias === true,
    alpha: true,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  };
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
  } catch {
    gl = null;
  }
  if (!gl) return { gl: null, isSoftware: false, rendererStr: '' };
  let rendererStr = '';
  let isSoftware = false;
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    rendererStr = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
    isSoftware = SOFTWARE_RE.test(rendererStr.toLowerCase());
  } catch {
    /* 取不到就当硬件渲染 */
  }
  return { gl, isSoftware, rendererStr };
}

/**
 * 生效 DPR。
 * @param {string} dprMode 'auto' | '1' | '1.5' | '2'
 * @param {boolean} isSoftware 软件渲染时 auto 钳到 1
 * @param {number} deviceDpr
 * @returns {number}
 */
export function effectiveDpr(dprMode, isSoftware, deviceDpr) {
  if (dprMode !== 'auto') {
    const n = parseFloat(dprMode);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }
  const cap = isSoftware ? 1 : 2;
  return Math.min(Number(deviceDpr) || 1, cap);
}

/**
 * 把逻辑尺寸 + DPR 落到画布 backing store，并同步 GL viewport。
 * @param {HTMLCanvasElement} canvas
 * @param {WebGLRenderingContext} gl
 * @param {{logicalW: number, logicalH: number, dpr: number}} box
 * @returns {{w: number, h: number, changed: boolean}}
 */
export function applyPixelSize(canvas, gl, box) {
  const w = Math.max(1, Math.floor((box.logicalW || 0) * (box.dpr || 1)));
  const h = Math.max(1, Math.floor((box.logicalH || 0) * (box.dpr || 1)));
  const changed = canvas.width !== w || canvas.height !== h;
  if (changed) {
    canvas.width = w;
    canvas.height = h;
  }
  if (gl) {
    try { gl.viewport(0, 0, w, h); } catch { /* 上下文丢失时忽略 */ }
  }
  return { w, h, changed };
}
