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
/** 少于该样本数不表态（返回 null） */
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
  const data = imageData.data;
  let samples = 0;
  let violates = 0;
  let useStep = step;
  let count = Math.floor(data.length / 4 / useStep);
  while (count < minSamples && useStep > 1) { useStep -= 1; count = Math.floor(data.length / 4 / useStep); }
  for (let i = 0; i < data.length; i += 4 * useStep) {
    const a = data[i + 3];
    if (a === 0 || a === 255) continue;
    samples += 1;
    if (Math.max(data[i], data[i + 1], data[i + 2]) > a + tolerance) violates += 1;
  }
  if (samples < PIXEL_MIN_RELIABLE) return { isPremultiplied: null, confidence: 0, samples };
  const ratio = violates / samples;
  return {
    isPremultiplied: ratio <= PIXEL_VIOLATE_MAX,
    confidence: Math.min(1, samples / 2000),
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
    return { atlasDeclared, filenameHint, pixelDetected: null, finalIsPremultiplied: atlasDeclared, reason: `像素不足，回退 atlas 声明 pma=${atlasDeclared}` };
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
    default:
      return auto
        ? { effectiveMode: 'premultiplied', needPremultiply: false, blendMode: 'premultiplied', runtimeSupportsStraight: supportsStraight, degraded: false }
        : { effectiveMode: 'upload', needPremultiply: true, blendMode: 'premultiplied', runtimeSupportsStraight: supportsStraight, degraded: false };
  }
}

/** 上传时是否需要真正"转预乘"（旧引擎：gpuUnpack 优先，否则 CPU 整页） */
export function gpuUnpackAvailable(gl) {
  return typeof gl.pixelStorei === 'function'
    && typeof gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL !== 'undefined'
    && gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL !== null;
}
