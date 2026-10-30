// engine/pma/blend.js —— 混合口径的执行层：把运行时的 blendFunc 调用改写成 decision 要求的口径
//
// decision 来自 resolve.js（`pmaInfo.blendMode`）；本文件只负责"按它改写"，不再自己判定档位。
// 钩子**总是**装上（init 时无条件调用），是否真的改写由每次调用时读到的 blendMode 决定。

/** 防止同一上下文重复挂钩子 */
const HOOK_FLAG = '__bvBlendHooked';

/**
 * 安装混合钩子：非预乘口径下运行时仍按预乘 blendFuncSeparate 提交，必须改写因子。
 * @param {WebGLRenderingContext} gl
 * @param {{pmaInfo?: {blendMode?: string}}} engine 读 pmaInfo.blendMode
 * @returns {boolean} 是否新装了钩子
 */
export function installBlendHooks(gl, engine) {
  const g = gl;
  if (!g || g[HOOK_FLAG]) return false;
  g[HOOK_FLAG] = true;
  const glONE = g.ONE;
  const glZERO = g.ZERO;
  const glSRC_ALPHA = g.SRC_ALPHA;
  const glDST_ALPHA = g.DST_ALPHA;
  const glONE_MINUS_SRC_COLOR = g.ONE_MINUS_SRC_COLOR;
  const glONE_MINUS_SRC_ALPHA = g.ONE_MINUS_SRC_ALPHA;
  const raw = g.blendFuncSeparate ? g.blendFuncSeparate.bind(g) : null;
  if (!raw) return false;
  const mapped = (src, dst, alphaSrc, alphaDst) => {
    const straight = !(engine.pmaInfo && engine.pmaInfo.blendMode === 'premultiplied');
    let a; let b; let c; let d;
    if (dst === glONE_MINUS_SRC_COLOR || alphaDst === glONE_MINUS_SRC_COLOR) {
      a = straight ? glSRC_ALPHA : glDST_ALPHA; b = glONE_MINUS_SRC_COLOR; c = glZERO; d = glONE;
    } else if (dst === glONE) {
      // 加性混合的 alphaDst 是 ONE（不是 ONE_MINUS_SRC_ALPHA）——
      //   写错会让加性部件（高光/发丝阴影层）在预乘口径下变暗发黑。
      a = src; b = dst; c = straight ? glZERO : glONE; d = glONE;
    } else {
      a = src; b = dst; c = glONE; d = glONE_MINUS_SRC_ALPHA;
    }
    raw(a, b, c, d);
  };
  g.blendFuncSeparate = (src, dst, alphaSrc, alphaDst) => mapped(src, dst, alphaSrc, alphaDst);
  g.blendFunc = (src, dst) => mapped(src, dst);
  return true;
}

/**
 * 给运行时的混合模式转换器打补丁：**Screen** 的 dest 因子强制为 `ONE_MINUS_SRC_COLOR`(769)。
 *
 * 为什么必须打：spine 运行时对 `BlendMode.Screen` 的默认映射不是标准 screen 混合，
 *   而 3D 预览里 Screen 常被用在发光/高光层；映射不对 ⇒ 这些部件画成暗块/黑块
 *   （现场形态：面内竖条纹/斑块，容易被误当成 PMA 问题）。
 *   这个 patch 必须在建渲染器时调用，否则混合模式不生效。
 *
 * @param {object} spine 运行时命名空间（含 webgl.WebGLBlendModeConverter 与 BlendMode）
 * @returns {boolean} 是否新打了补丁
 */
export function patchRuntimeBlendConverter(spine) {
  try {
    const webgl = spine && spine.webgl;
    const conv = (webgl && webgl.WebGLBlendModeConverter) || (spine && spine.WebGLBlendModeConverter);
    const BlendMode = spine && spine.BlendMode;
    if (!conv || !BlendMode || typeof conv.getDestGLBlendMode !== 'function' || conv.__bvScreenPatched) return false;
    const SCREEN_DEST = 769;   // ONE_MINUS_SRC_COLOR
    const orig = conv.getDestGLBlendMode.bind(conv);
    conv.getDestGLBlendMode = (mode) => (mode === BlendMode.Screen ? SCREEN_DEST : orig(mode));
    conv.__bvScreenPatched = true;
    return true;
  } catch {
    return false;
  }
}

/** 该上下文是否已挂钩子 */
export function hasBlendHooks(gl) {
  return !!(gl && gl[HOOK_FLAG]);
}
