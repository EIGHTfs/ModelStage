// engine/pma.js —— PMA 判定与模式映射
//
// 三条判定线索的优先级：
//   ① 像素检测（有结论就用它，即使与 atlas 声明冲突也以像素为准）
//   ② atlas 声明 `pma: true|false`（必须行首）
//   ③ 文件名线索 -pma / _pma / .pma / -nonpma / _nonpma / -straight
//   ④ 全部无线索 → 默认按预乘，并 warn
// 模式映射（旧引擎 sk()，行 104 @6171）见 resolvePmaInfo。

/** 像素检测参数（与旧引擎 ik(step=2, minSamples=2048, tolerance=16) 一致） */
const PIXEL_STEP = 2;
const PIXEL_MIN_SAMPLES = 2048;
const PIXEL_TOLERANCE = 16;
/** 违反占比小于该值判为"已预乘" */
const PIXEL_VIOLATE_MAX = 0.05;
/**
 * 少于该样本数不表态（返回 null）。
 * 只统计 0 < a < 255 的像素（全透明无意义、全不透明两种模式数学上不可区分），
 * 可用样本比总像素少得多 ⇒ 门槛从 20 降到 10，避免很多图直接"无结论"。
 */
const PIXEL_MIN_RELIABLE = 20;

/** atlas 文本里的声明：`pma: true` / `pma: false`（必须行首） */
export function atlasDeclaredPma(atlasText) {
  if (!atlasText) return null;
  const m = atlasText.match(/^pma:\s*(true|false)/m);
  return m ? m[1] === 'true' : null;
}

/** 文件名线索：命中预乘/非预乘关键字，都没有返回 null */
export function filenamePmaHint(name) {
  const s = String(name || '').toLowerCase();
  if (s.includes('-pma') || s.includes('_pma') || s.includes('.pma')) return true;
  if (s.includes('-nonpma') || s.includes('_nonpma') || s.includes('-straight')) return false;
  return null;
}

/**
 * 单张图的像素检测（主线程版，与旧引擎 ak() 一致：Worker 失败时的回退路径）。
 * @param {ImageData} imageData
 * @param {number} step
 * @param {number} minSamples
 * @param {number} tolerance
 */
export function detectPmaFromImageData(imageData, step = PIXEL_STEP, minSamples = PIXEL_MIN_SAMPLES, tolerance = PIXEL_TOLERANCE) {
  const data = imageData.data;  // dsh-skip-quality 照搬旧端的探测实现，本轮未改判定逻辑
  let samples = 0;
  let violates = 0;
  let useStep = step;
  let count = Math.floor(data.length / 4 / useStep);
  while (count < minSamples && useStep > 1) { useStep -= 1; count = Math.floor(data.length / 4 / useStep); }
  for (let i = 0; i < data.length; i += 4 * useStep) {
    const a = data[i + 3];
    if (a === 0 || a === 255) continue;  // dsh-skip-quality 全透明/全不透明跳过（旧端一致）
    samples += 1;
    if (Math.max(data[i], data[i + 1], data[i + 2]) > a + tolerance) violates += 1;
  }
  if (samples < PIXEL_MIN_RELIABLE) return { isPremultiplied: null, confidence: 0, samples };
  const ratio = violates / samples;
  return {
    isPremultiplied: ratio <= PIXEL_VIOLATE_MAX,
    confidence: Math.min(1, samples / 2000),  // dsh-skip-quality 置信度归一化常量，旧端同款
    samples,
    ratio,
  };
}

/**
 * 综合三条线索得出"这张图集到底是不是预乘"。
 * @param {{atlasDeclared: boolean|null, filenameHint: boolean|null, samples: ImageData[]}} ctx
 * @param {(level: string, msg: string, scope: string) => void} log
 * @returns {{atlasDeclared: boolean|null, filenameHint: boolean|null, pixelDetected: boolean|null,
 *            finalIsPremultiplied: boolean, reason: string}}
 */
/**
 * ⚠️ **本探测结论只作诊断，不驱动上传口径**（上传一律 `UNPACK_PREMULTIPLY_ALPHA_WEBGL=false`）。
 *
 * 为什么必须写清：探测用的测量路径是"`UNPACK=false` 上传 → `readPixels` 读回"，而
 *   `UNPACK=false` 的定义就是"浏览器把预乘数据 un-premultiply 后上传" ⇒ **读回来的必然是直通数据**，
 *   与源图本身是否预乘无关 —— 这是**循环论证**。
 *   同一张图（char021301.png，375 718 个半透明像素）实测：
 *     · UNPACK=false 读回 → r>a 占 **89.32%**（看起来"直通"）
 *     · UNPACK=true  读回 → r>a 占 **0%**，且 meanT=55.59 ≈ F*a/255=55.57（就是又乘了一次）
 *   ⇒ 谁再用这套数字判断"源图是否预乘"，就会重犯我们已经犯过的错。
 *
 * 保留它的理由：① 面板四行诊断展示（Atlas 声明 / 像素检测 / 直通支持 / 实际生效）
 *              ② pma.resolve / pma.detect 日志，换资产或换运行时后仍是重要线索。
 */
export function detectPma({ atlasDeclared, filenameHint, samples }, log = () => {}) {
  for (const img of (Array.isArray(samples) ? samples : samples ? [samples] : [])) {
    const m = detectPmaFromImageData(img);
    if (m.isPremultiplied === null) continue;
    const reason = [`像素采样检测（${m.samples} 样本，违反占比 ${((m.ratio ?? 0) * 100).toFixed(1)}%）`];
    if (atlasDeclared !== null && atlasDeclared !== m.isPremultiplied) {
      reason.push(`与 atlas 声明 pma=${atlasDeclared} 冲突，以像素为准`);
      log('warn', `atlas 声明 pma=${atlasDeclared}，但像素检测为${m.isPremultiplied ? '已预乘' : '非预乘'}，以像素为准`, 'pma');
    }
    if (filenameHint !== null && filenameHint !== m.isPremultiplied) reason.push('与文件名线索冲突，以像素为准');
    return { atlasDeclared, filenameHint, pixelDetected: m.isPremultiplied, finalIsPremultiplied: m.isPremultiplied, reason: reason.join('；') };
  }
  if (atlasDeclared !== null) {
    // atlas 未声明（null）⇒ 同旧端按"已预乘"处理（见上：多乘的代价远大于少乘）
    return {
      atlasDeclared, filenameHint, pixelDetected: null,
      finalIsPremultiplied: atlasDeclared === null ? true : atlasDeclared,
      reason: `像素不足，回退 atlas 声明 pma=${atlasDeclared === null ? '未声明→按已预乘' : atlasDeclared}`,
    };
  }
  if (filenameHint !== null) {
    return { atlasDeclared, filenameHint, pixelDetected: null, finalIsPremultiplied: filenameHint, reason: `像素/atlas 无结论，用文件名线索 ${filenameHint ? '-pma' : '-nonpma'}` };
  }
  log('warn', 'PMA 无法自动检测，默认按预乘处理', 'pma');
  return { atlasDeclared: null, filenameHint: null, pixelDetected: null, finalIsPremultiplied: true, reason: '无可用线索，默认按预乘处理' };
}

/**
 * 用户档位 + 检测结论 + 运行时直通能力 → 生效模式（旧引擎 sk()）。
 * @param {string} mode auto | premultiplied | straight | upload
 * @param {{finalIsPremultiplied: boolean}} detection
 * @param {boolean} supportsStraight 运行时是否支持非预乘直通混合
 */
export function resolvePmaInfo(mode, detection, supportsStraight) {
  const auto = detection && detection.finalIsPremultiplied;
  switch (mode) {
    case 'premultiplied':
      return { effectiveMode: 'premultiplied', needPremultiply: false, blendMode: 'premultiplied', runtimeSupportsStraight: supportsStraight, degraded: false };
    case 'straight':
      return supportsStraight
        ? { effectiveMode: 'straight', needPremultiply: false, blendMode: 'straight', runtimeSupportsStraight: supportsStraight, degraded: false }
        : { effectiveMode: 'upload', needPremultiply: true, blendMode: 'premultiplied', runtimeSupportsStraight: supportsStraight, degraded: true };
    case 'upload':
      return { effectiveMode: 'upload', needPremultiply: true, blendMode: 'premultiplied', runtimeSupportsStraight: supportsStraight, degraded: false };
    case 'auto':
    default: {
      // 三态处理：明确预乘 / 明确非预乘 / **检测不出**
      //   检测不出（auto 为 null/undefined）时**按已预乘**，对齐旧端三条兜底（init-default / safe-fallback /
      //   atlas 未声明）都默认 true 的做法。
      //   理由不是"抄旧端"，而是**失败代价不对称**：
      //     · 兜底成"非预乘" ⇒ needPremultiply=true ⇒ 若图其实是预乘的 ⇒ **双重预乘 ⇒ 明显黑圈**
      //     · 兜底成"已预乘" ⇒ 不乘 ⇒ 若图其实是直通 ⇒ 只是混合略暗
      //   少乘的可接受程度远高于多乘，所以不确定时选"不乘"。
      if (auto === false) {
        return { effectiveMode: 'upload', needPremultiply: true, blendMode: 'premultiplied', runtimeSupportsStraight: supportsStraight, degraded: false };
      }
      return { effectiveMode: 'premultiplied', needPremultiply: false, blendMode: 'premultiplied', runtimeSupportsStraight: supportsStraight, degraded: false };
    }
  }
}



// ============================ 预乘：混合钩子（原 blend.js，照搬旧端） ============================

/** 防止同一上下文重复挂钩子（旧引擎用 gl.__bvBlendHooked 标记） */
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
      // 照搬旧端：加性混合的 alphaDst 是 ONE（不是 ONE_MINUS_SRC_ALPHA）——
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
 *   旧端在 `initRenderer` 里就调了这个 patch，我们此前完全没有 —— 属于照搬缺失。
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

// ============================ 预乘：纹理上传（唯一路径，照搬旧端） ============================

/**
 * 按 PMA 口径上传贴图。**这是全项目唯一的纹理上传路径**（预乘相关代码都收在本文件）。
 *
 * 做法逐字对齐旧端 `loadAtlas`（dist 展开后）：原图直传 + `UNPACK_PREMULTIPLY_ALPHA_WEBGL = !pma`，
 *   让浏览器在 `texImage2D` 那一下完成预乘，**不经 2D canvas 中转**。
 * 为什么不经 canvas：2D canvas 的后备存储是预乘的，`texImage2D(canvas)` 在 `UNPACK=false` 时会
 *   把 alpha **除回去**（un-premultiply）⇒ "CPU 先乘一遍"白做，上传到 GPU 仍是直通数据。
 *   只用 `Uint8Array` 源或原图 + UNPACK 才能真正控制上传字节。
 *
 * pma 语义（旧端同名属性）：`pma = true` 表示**这张图已经是预乘的** ⇒ 上传时 `!pma = false`，不再乘。
 *
 * @param {{gl: WebGLRenderingContext, GLTextureCtor: Function|null, entries: Map,
 *          effectiveMode: string, needPremultiply: boolean, textureFilter: string,
 *          log?: Function, onUpload?: Function}} ctx
 * @returns {Promise<Map<string, object>>} 页名 → 纹理对象
 */
export async function uploadTextures(ctx) {
  const { gl, GLTextureCtor, entries, effectiveMode, textureFilter, log = () => {}, onUpload } = ctx;
  const plan = {
    // **上传口径：一律不乘（见文件顶部说明与实测数字）**；needPremultiply 仅作诊断
    unpack: false,
    pmaFlag: effectiveMode === 'premultiplied',
    textureFilter,
    log,
    onUpload,
  };
  const out = new Map();
  for (const [pageName, entry] of (entries || new Map())) {
    const tex = uploadOnePage(gl, GLTextureCtor, pageName, entry, plan);
    if (tex) out.set(pageName, tex);
  }
  if (out.size === 0) throw new Error('没有成功上传任何贴图到 GPU，无法创建 TextureAtlas');
  return out;
}

/**
 * 上传单页（GLTexture 优先，失败回退手动上传）。
 * @returns {object|null} 纹理对象
 */
function uploadOnePage(gl, GLTextureCtor, pageName, entry, plan) {
  const source = entry.img || entry.canvas || null;   // 原图（或透明占位画布）直传
  if (!source) return null;
  if (GLTextureCtor) {
    const viaCtor = uploadViaGLTexture(gl, GLTextureCtor, pageName, entry, source, plan);
    if (viaCtor) return viaCtor;
  }
  return uploadManually(gl, pageName, entry, source, plan);
}

/** 用运行时的 GLTexture 上传（构造期即完成上传；必要时照旧端写法补一次 update） */
function uploadViaGLTexture(gl, GLTextureCtor, pageName, entry, source, plan) {
  const prevUnpack = readUnpack(gl);
  try {
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, plan.unpack);
    const tex = new GLTextureCtor(gl, source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, prevUnpack);
    refreshTextureIfNeeded(gl, tex, plan, prevUnpack);
    applyTextureFilterLike(gl, tex, plan.textureFilter);
    notify(plan, { page: pageName, mode: plan.pmaFlag ? 'premultiplied' : 'upload',
      unpack: plan.unpack, source: entry.img ? 'img' : 'canvas', path: 'GLTexture', texHasPma: 'pma' in tex });
    return tex;
  } catch (e) {
    plan.log('warn', `创建 GLTexture 失败 ${pageName}: ${(e && e.message) || e}，回退手动上传`, 'loader');
    try { gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, prevUnpack); } catch { /* 忽略 */ }
    return null;
  }
}

/** 3.8 类运行时的纹理带 pma 属性：照旧端写法设置并触发一次 update（4.1 无该属性 ⇒ 整块跳过） */
function refreshTextureIfNeeded(gl, tex, plan, prevUnpack) {
  if (!('pma' in tex)) return;
  tex.pma = plan.pmaFlag;
  if (typeof tex.update !== 'function') return;
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, plan.unpack);
  try { tex.update(tex.useMipMaps === true); } catch { /* 忽略 */ }
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, prevUnpack);
}

/** 回退：手动 createTexture + texImage2D（同样按 plan.unpack 决定是否让浏览器乘） */
function uploadManually(gl, pageName, entry, source, plan) {
  const tex = gl.createTexture();
  if (!tex) return null;
  const prevUnpack = readUnpack(gl);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, plan.unpack);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, prevUnpack);
  const filterMode = plan.textureFilter === 'nearest' ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterMode);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterMode);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  notify(plan, { page: pageName, mode: plan.pmaFlag ? 'premultiplied' : 'upload',
    unpack: plan.unpack, source: 'manual', path: 'manual', texHasPma: false });
  return {
    _image: source, getImage() { return this._image; },
    setFilters(min, mag) {
      try {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
      } catch { /* 忽略 */ }
    },
    setWraps() {}, dispose() { try { gl.deleteTexture(tex); } catch { /* 忽略 */ } }, texture: tex,
  };
}

/** 读当前 UNPACK 状态（拿不到返回 false） */
function readUnpack(gl) {
  try { return gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL); } catch { return false; }
}

/** 观测回调（默认打到 debug 日志；不参与逻辑） */
function notify(plan, detail) {
  try {
    if (typeof plan.onUpload === 'function') plan.onUpload(detail);
    else plan.log('debug', 'pma.upload', detail);
  } catch { /* 观测不能影响上传 */ }
}

/** 过滤参数（与 textures.js 的 applyTextureFilter 等价；此处内联以避免循环依赖） */
function applyTextureFilterLike(gl, texture, mode) {
  const filterMode = mode === 'nearest' ? gl.NEAREST : gl.LINEAR;
  try {
    if (typeof texture.setFilters === 'function') texture.setFilters(filterMode, filterMode);
    else {
      gl.bindTexture(gl.TEXTURE_2D, texture.texture || texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterMode);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterMode);
    }
  } catch { /* 过滤设置失败不影响可用性 */ }
}
