// live2d/probe.js —— 只读诊断（渲染器状态 / 像素采样 / MODELCMP 采集）
//
// 全部只读：不重置视图、不改渲染、不触发重排。之所以独立成文件，
//   是因为这些函数是"排查用"的，和渲染主链路没有调用关系，混在一起会掩盖主干。
// 注：rendererInfo 里的 __transparentClear* 等字段对应的 GL 包装代码已删除，
//   这些键现在恒为 null/false（历史遗留），保留是为了不改变对外返回键集合。
import { collectLive2DModelCmp } from '../debug/model-cmp.js';

/** 渲染器自身的清屏配置（PIXI 字段，不做 GL 查询） */
function readClearConfig(r, gl) {
  return {
    backgroundAlpha: r.backgroundAlpha,
    backgroundColor: r.backgroundColor,
    clearBeforeRender: r.clearBeforeRender,
    resolution: r.resolution,
    width: r.width,
    height: r.height,
    rendererType: r.type,
    dirty: !!r.dirty,
    // 以下三项对应的 GL 包装代码已删除，现恒为 null/false（历史遗留，保留键名）
    wrapped: !!(gl && gl.__transparentClearInstalled),
    clearCalls: gl ? gl.__transparentClearCalls : null,
    clearBufferCalls: gl && gl.__clearBufferCalls ? { ...gl.__clearBufferCalls } : null,
    wrappedChained: gl ? !!gl.__transparentClearChained : null,
  };
}

/** 逐项读一个 GL 参数（读失败返回 null，绝不抛） */
function glParam(gl, name, map) {
  try {
    const v = gl.getParameter(gl[name]);
    return map ? map(v) : v;
  } catch {
    return null;
  }
}

/** GL 状态里与"清屏/裁剪"相关的项（每项都可能抛，逐项兜住） */
function readGlState(gl) {
  if (!gl) return {};
  const out = {};
  try { out.contextLost = gl.isContextLost(); } catch { out.contextLost = null; }
  try { out.scissorTest = gl.isEnabled(gl.SCISSOR_TEST); } catch { out.scissorTest = null; }
  out.scissorBox = glParam(gl, 'SCISSOR_BOX', (v) => (v ? Array.from(v) : null));
  out.clearColor = glParam(gl, 'COLOR_CLEAR_VALUE', (v) => (v ? Array.from(v) : null));
  // 最可疑的一项：alpha 写入被关掉时，清什么都保持旧 alpha ⇒ 出现"这块透明那块不透明"
  out.colorWriteMask = glParam(gl, 'COLOR_WRITEMASK', (v) => (v ? Array.from(v) : null));
  out.samples = glParam(gl, 'SAMPLES');
  try {
    const a = gl.getContextAttributes ? gl.getContextAttributes() : null;
    out.contextAlpha = a ? a.alpha : null;
    out.antialias = a ? a.antialias : null;
  } catch { /* 忽略 */ }
  return out;
}

/**
 * 创建只读诊断模块。
 * @param {object} ctx 运行时上下文
 * @returns {{readCanvasPixels:Function, collectCmp:Function, rendererInfo:Function, rendererSize:Function}}
 */
export function createProbe(ctx) {
  const { st, surfaceSize } = ctx;

  async function readCanvasPixels(points = []) {
    const app = st.app;
    if (!app || !app.renderer) return null;
    const gl = app.renderer.gl;
    if (!gl) return null;
    const res = app.renderer.resolution || 1;
    const h = app.renderer.height;
    const buf = new Uint8Array(4);
    const out = [];
    await new Promise((r) => requestAnimationFrame(() => r()));
    try { app.renderer.render(app.stage); } catch { /* 忽略 */ }
    for (const p of points) {
      const px = Math.round(p[0] * res);
      const py = Math.round(h - p[1] * res);
      try {
        gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        out.push({ x: p[0], y: p[1], rgba: [buf[0], buf[1], buf[2], buf[3]] });
      } catch (e) { out.push({ x: p[0], y: p[1], err: String(e && e.message).slice(0, 40) }); }
    }
    return out;
  }

  function collectCmp(tag) {
    const rootEl = document.getElementById('stage');
    return collectLive2DModelCmp({
      app: st.app,
      model: st.model,
      internal: st.model && st.model.internalModel ? st.model.internalModel : null,
      size: surfaceSize(),
      dpr: ctx.handleRef ? ctx.handleRef.dpr : null,
      meta: st.meta,
      modelId: st.modelId,
      zoomRatio: st.zoomRatio,
      stageMode: rootEl ? rootEl.getAttribute('data-stage-mode') : null,
      tag: String(tag || 'default'),
    });
  }

  function rendererInfo() {
    const app = st.app;
    if (!app || !app.renderer) return null;
    const r = app.renderer;
    const gl = r.gl || null;
    return { ...readClearConfig(r, gl), ...readGlState(gl) };
  }

  function rendererSize() {
    if (!st.app || !st.app.renderer) return null;
    const r = st.app.renderer;
    const size = surfaceSize() || { width: 0, height: 0 };
    return { w: r.width, h: r.height, res: r.resolution || 1, cssW: size.width, cssH: size.height };
  }

  return { readCanvasPixels, collectCmp, rendererInfo, rendererSize };
}