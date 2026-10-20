// engine/blend.js —— 混合函数钩子（照抄旧引擎 installBlendHooks，行 284 @49420）
//
// 为什么需要它：非预乘（straight）模式下，运行时内部仍按预乘的 `blendFuncSeparate` 提交，
//   画面会整体偏暗/边缘发白。旧引擎的做法是给 gl 打一层钩子，按当前 pmaInfo.blendMode 改写参数。
//   漏掉这一步，"切到 straight 方法没报错"照样是错的画面 —— 所以必须实现。

/** 防止同一上下文重复挂钩子（旧引擎用 gl.__bvBlendHooked 标记，保持一致） */
const HOOK_FLAG = '__bvBlendHooked';

/**
 * 安装混合钩子。
 * @param {WebGLRenderingContext} gl
 * @param {{pmaInfo: {blendMode: string}}} engine 读取 pmaInfo.blendMode 的引擎实例
 * @returns {boolean} 是否新装了钩子（已装过返回 false）
 */
export function installBlendHooks(gl, engine) {
  const g = gl;
  if (!g || g[HOOK_FLAG]) return false;
  g[HOOK_FLAG] = true;
  const ONE = g.ONE;
  const ZERO = g.ZERO;
  const SRC_ALPHA = g.SRC_ALPHA;
  const DST_ALPHA = g.DST_ALPHA;
  const ONE_MINUS_SRC_COLOR = g.ONE_MINUS_SRC_COLOR;
  const ONE_MINUS_SRC_ALPHA = g.ONE_MINUS_SRC_ALPHA;
  const raw = g.blendFuncSeparate ? g.blendFuncSeparate.bind(g) : null;
  if (!raw) return false;
  const mapped = (src, dst, alphaSrc, alphaDst) => {
    // 非预乘口径下要换一套因子（与旧引擎逐分支一致）
    const straight = !(engine.pmaInfo && engine.pmaInfo.blendMode === 'premultiplied');
    let a;
    let b;
    let c;
    let d;
    if (dst === ONE_MINUS_SRC_COLOR || alphaDst === ONE_MINUS_SRC_COLOR) {
      a = straight ? SRC_ALPHA : DST_ALPHA;
      b = ONE_MINUS_SRC_COLOR;
      c = ZERO;
      d = ONE;
    } else if (dst === ONE) {
      a = src;
      b = dst;
      c = straight ? ZERO : ONE;
      d = ONE_MINUS_SRC_ALPHA;
    } else {
      a = src;
      b = dst;
      c = ONE;
      d = ONE_MINUS_SRC_ALPHA;
    }
    raw(a, b, c, d);
  };
  g.blendFuncSeparate = (src, dst, alphaSrc, alphaDst) => mapped(src, dst, alphaSrc, alphaDst);
  g.blendFunc = (src, dst) => mapped(src, dst);
  return true;
}

/** 该上下文是否已挂钩子 */
export function hasBlendHooks(gl) {
  return !!(gl && gl[HOOK_FLAG]);
}
