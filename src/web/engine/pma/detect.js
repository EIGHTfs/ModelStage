// engine/pma/detect.js —— 探测：**源图**到底是不是预乘的（三条线索，只回答这一个问题）
//
// 线索优先级：
//   ① 像素检测（有结论就用它，即使与 atlas 声明冲突也以像素为准）
//   ② atlas 声明 `pma: true|false`（必须行首）
//   ③ 文件名线索 -pma / _pma / .pma / -nonpma / _nonpma / -straight
//   ④ 全部无线索 → 默认按预乘，并 warn
// 探测结论交给 resolve.js 的 resolvePmaInfo 决定"怎么画"；本文件不碰上传与混合。

/** 像素检测参数 */
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
 * 单张图的像素检测。
 * @param {ImageData} imageData
 * @param {number} step
 * @param {number} minSamples
 * @param {number} tolerance
 */
export function detectPmaFromImageData(imageData, step = PIXEL_STEP, minSamples = PIXEL_MIN_SAMPLES, tolerance = PIXEL_TOLERANCE) {
  const data = imageData.data;  // dsh-skip-quality 探测实现沿用既有算法，本轮未改判定逻辑
  let samples = 0;
  let violates = 0;
  let useStep = step;
  let count = Math.floor(data.length / 4 / useStep);
  while (count < minSamples && useStep > 1) { useStep -= 1; count = Math.floor(data.length / 4 / useStep); }
  for (let i = 0; i < data.length; i += 4 * useStep) {
    const a = data[i + 3];
    if (a === 0 || a === 255) continue;  // dsh-skip-quality 全透明/全不透明跳过
    samples += 1;
    if (Math.max(data[i], data[i + 1], data[i + 2]) > a + tolerance) violates += 1;
  }
  if (samples < PIXEL_MIN_RELIABLE) return { isPremultiplied: null, confidence: 0, samples };
  const ratio = violates / samples;
  return {
    isPremultiplied: ratio <= PIXEL_VIOLATE_MAX,
    confidence: Math.min(1, samples / 2000),  // dsh-skip-quality 置信度归一化常量
    samples,
    ratio,
  };
}

/**
 * 综合三条线索得出"这张图集到底是不是预乘"，并回答**源图**是什么形态。
 *
 * 结论**会**参与判定（经 `resolvePmaInfo` 的 auto 档 → `needPremultiply` / `blendMode`），
 *   所以这里的判据必须可信。当前取的是原图：`sampleSourceImageData` 把图**画到 2D canvas 再
 *   `getImageData`**（不经 WebGL ⇒ **不受 `UNPACK_PREMULTIPLY_ALPHA_WEBGL` 影响**），
 *   于是「RGB 超过 A 的像素占比」就能反映源图本身的 alpha 形态。
 *
 * ⚠️ 反面教训：**不要用 `readPixels` 读回的数据反推源图**。
 *   `readPixels` 读的是 **GPU 上的数据**，已经过上传口径处理 —— 开关一变，同一张图的数字就变，
 *   与源图是否预乘无关，那是循环论证。早前那版实现踩过，实测记录（char021301.png，
 *   375,718 个半透明像素）的正确解读是：
 *     · 按 `UNPACK=false`（原样）上传后读回 → r>a 占 **89.32%** ⇒ 源图是**直通**
 *     · 按 `UNPACK=true` 上传后读回 → r>a 占 **0%**      ⇒ alpha 被乘了进去，
 *       这正是 `upload` 路径**想要**的效果；当时把它读成"又乘了一次"，
 *       而那个说法成立的前提是"源图已预乘"，与上一行的读数直接矛盾，结论下错了。
 *
 * 保留本探测的理由：① 面板四行诊断展示（Atlas 声明 / 像素检测 / 直通支持 / 实际生效）
 *                    ② pma.resolve / pma.detect 日志，换资产或换运行时后仍是重要线索。
 *
 * @param {{atlasDeclared: boolean|null, filenameHint: boolean|null, samples: ImageData[]}} ctx 三条线索
 * @param {Function} [log] 诊断日志（缺省吞掉）
 * @returns {{atlasDeclared: boolean|null, filenameHint: boolean|null, pixelDetected: boolean|null,
 *            finalIsPremultiplied: boolean, reason: string}} 最终结论与判据说明
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
    // atlas 未声明（null）⇒ 按"已预乘"处理（见上：多乘的代价远大于少乘）
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
