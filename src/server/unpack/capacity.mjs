// unpack/capacity.mjs —— 解包的准入判据（只按**可用内存**动态判断，不设可调阈值）
//
// 设计取舍（前一版是"包大小阈值 + 内存百分比 + 三个 env"，属过度设计）：
//   包大小阈值本来就是为了控内存 ⇒ 两者是同一件事。现在直接算「这个包解包后的预估峰值
//   会不会超过"可用内存的一半"」，一次判断，不拍脑袋定包大小门槛。
//
// 三条实测依据（本机测量，决定了下面的分段系数）：
//   · VmHWM 峰值：12MB→176MB（14.7×）、19MB→451MB（23.7×）、42MB→479MB（11.4×）
//     ⇒ **非线性**（19MB 比 42MB 还费内存），所以不能用单一倍数，按档取上包络。
//   · 解包耗时：12MB→2.3s、19MB→10.0s、42MB→8.6s（同样非线性，19MB 最费）
//     ⇒ 预热大包会让用户在看模型时单核占满 8~10 秒，所以**预热另有一条时间上限**（WARMUP_MAX_EST_SEC）。
//   · `os.freemem()` 在 Linux 不含可回收 buff/cache，会严重低估 ⇒ 必须优先 /proc/meminfo 的 MemAvailable。
import fs from 'node:fs';
import os from 'node:os';

/** 预算比例：只用可用内存的一半，给系统/渲染留另一半 */
const MEM_BUDGET_RATIO = 0.5;

/** 预热的时间上限（秒）：预估解包超过这个时长就不预热（表达"CPU 影响"，比"包大小阈值"更贴近真实代价） */
const WARMUP_MAX_EST_SEC = 6;

/**
 * 可用内存（MB）——**每次判断时现取，绝不缓存**。
 *
 * 三个分支（跨平台）：
 *   ① Linux：读 /proc/meminfo 的 MemAvailable。这是内核估算的"真要用了能腾出多少"，
 *      含可回收的 buff/cache；`os.freemem()` 不含 ⇒ 本机实测会低估数倍，不能用作准入判据。
 *   ② macOS / Windows：`os.freemem()` 相对准确（没有 Linux 那个 buff/cache 的口径问题）。
 *   ③ 兜底（拿不到或为 0）：总内存的一半 —— 保守方向，宁可少解包也不误放行。
 * @returns {{mb: number, source: 'MemAvailable'|'freemem'|'totalmem/2'}}
 */
export function memAvailableMb() {
  try {
    const m = /MemAvailable:\s+(\d+)\s*kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return { mb: Math.round(Number(m[1]) / 1024), source: 'MemAvailable' };
  } catch { /* 非 Linux / 无该文件：落到下一分支 */ }
  const free = os.freemem();
  if (free > 0) return { mb: Math.round(free / 1024 / 1024), source: 'freemem' };
  return { mb: Math.round(os.totalmem() / 1024 / 1024 / 2), source: 'totalmem/2' };
}

/**
 * **解压后容器 MB → 预估峰值 MB**（准入主判据，见 docs/设计/解包内存预估.md）。
 *
 * 为什么变量是"解压后容器"而不是"源包大小"：19 个真实样本实测
 *   · 峰值 ~ 解压容器 R²=0.971、MAPE 2.5%
 *   · 峰值 ~ 源包      R²=0.695（aijier_3 源包 19MB 却解压 42MB，源包完全看不出来）
 *
 * 分段值 = 各段实测 max × **1.15 安全垫**（段内样本不均衡，用单点 max 当边界会漏新包）：
 *   ≤5MB → 147（实测 max 128）｜5~13MB → 239（max 208）｜13~21MB → 267（max 232）
 *   21~43MB → 423（max 368）｜>43MB → 7.0×uncomp + 118（与 43MB 处连续：7×43+118=419）
 * @param {number} decompressedMb 解压后容器总大小（MB）
 * @returns {number} 预估峰值（MB，已含安全垫）
 */
export function estimatePeakFromDecompressed(decompressedMb) {
  if (!(decompressedMb > 0)) return 0;
  for (const [limit, peak] of PEAK_TABLE) {
    if (decompressedMb <= limit) return peak;
  }
  return Math.ceil(decompressedMb * 7.0 + 118);   // >45MB 外推（与 45MB 处连续：7×45+118=433）
}

/**
 * 分段表（解压容器 MB 上界 → 预估峰值 MB）。**每段 = 该段实测 max × 1.15 安全垫**。
 *
 * 为什么段划得比较密（11 / 11.5 / 11.9 / 12.5…）：19 个实测样本在 11~12MB 这一小段里
 *   同时出现了 169MB 和 208MB 两种包（同尺寸、同格式、同动作数，差 23%）——
 *   段划粗了就会让低值包为高值包陪绑，高估冲到 55%。密段把最大高估压到 22% 以内。
 *   **这是贴着样本划的，属于已知的过拟合**：新包靠 §回填（measuredPeakBytes）修正，
 *   公式只当冷启动初值（见 docs/设计/解包内存预估.md）。
 */
const PEAK_TABLE = [
  [5, 147],        // 样本 4.44MB → 实测 128
  [8, 177],        // 7.38 → 154
  [11, 192],       // 9.4~10.74 → 154~167
  [11.5, 239],     // 11.04 → 208（离群包，回填后会被真值替换）
  [11.95, 194],    // 11.54 / 11.77 → 169 / 168
  [12.5, 214],     // 11.94 → 186
  [16, 216],       // 14.02 → 188
  [25, 267],       // 20.86 → 232
  [45, 423],       // 41.98 / 42.11 → 348 / 368
];

/**
 * 源包大小 → 预估解包峰值（MB）。**仅供第③段回落**（插件没有声明 memory 时，保证不倒退）。
 * 主判据已改用 estimatePeakFromDecompressed —— 源包大小这个变量解释力很弱（R²=0.695）。
 *   12MB→240（实测 176，留 36% 余量）
 *   19MB→494（实测 451，留 10% 余量）
 *   42MB→630（实测 479，留 32% 余量）
 * @param {number} sourceMb
 * @returns {number}
 */
export function estimatePeakMb(sourceMb) {
  if (sourceMb <= 12) return Math.ceil(sourceMb * 20);
  if (sourceMb <= 19) return Math.ceil(sourceMb * 26);
  return Math.ceil(sourceMb * 15);
}

/**
 * 源包大小 → 预估解包耗时（秒）。同样按实测分段（非线性，19MB 那档最费）。
 *   12MB→3s（实测 2.3s）/ 19MB→9.3s（实测 10.0s）/ ≥20MB→9s 起（42MB 实测 8.6s）
 * @param {number} sourceMb
 * @returns {number}
 */
export function estimateUnpackSec(sourceMb) {
  if (sourceMb <= 12) return +(sourceMb * 0.25).toFixed(1);
  if (sourceMb <= 20) return +(3 + (sourceMb - 12) * 0.9).toFixed(1);
  return 9;
}

/**
 * 当前机器 + 某个包的准入判断（前端只读 `allowWarmup` 一个布尔，不再自己算）。
 * @param {number} [sourceMb] 源包大小（MB）；不传则只返回机器级信息，allowWarmup=true（不下结论）
 * @returns {object}
 */
export function capacity(sourceMb) {
  const avail = memAvailableMb();
  const budgetMb = Math.round(avail.mb * MEM_BUDGET_RATIO);
  const base = {
    memTotalMb: Math.round(os.totalmem() / 1024 / 1024),
    memAvailableMb: avail.mb,
    memAvailableSource: avail.source,
    budgetMb,
    ratio: MEM_BUDGET_RATIO,
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
    warmupMaxEstSec: WARMUP_MAX_EST_SEC,
  };
  if (!(sourceMb > 0)) {
    return { ...base, sourceMb: null, peakEstMb: null, estUnpackSec: null, allowWarmup: true, reason: 'no-package' };
  }
  const peakEstMb = estimatePeakMb(sourceMb);
  const estUnpackSec = estimateUnpackSec(sourceMb);
  if (peakEstMb > budgetMb) {
    return { ...base, sourceMb, peakEstMb, estUnpackSec, allowWarmup: false, reason: 'insufficient-memory' };
  }
  // 内存够，但预热会长时间占核 ⇒ 只影响**预热**，不影响用户主动加载
  //   （主动加载走 store.resolve 的纯内存判据：不能因为"慢"就拒绝用户要看的模型）
  if (estUnpackSec > WARMUP_MAX_EST_SEC) {
    return { ...base, sourceMb, peakEstMb, estUnpackSec, allowWarmup: false, reason: 'insufficient-cpu-time' };
  }
  return { ...base, sourceMb, peakEstMb, estUnpackSec, allowWarmup: true, reason: 'ok' };
}

/**
 * 解包入口的内存判据（服务端 resolve 用；**不含时间上限**——用户主动加载不能因为"慢"被拒）。
 * @param {number} sourceBytes 源文件字节数
 * @returns {{ok: boolean, reason?: string, message?: string, budgetMb: number, peakEstMb: number, availMb: number}}
 */
/** 覆盖阈值的说明文案（放行时也要把数字带出来，用户才知道自己放行了多大的包） */
const OVER_LIMIT_TEXT = (peakEstMb, budgetMb, availMb) =>
  `已放行超限解包：预估峰值 ${peakEstMb}MB 超过可用预算 ${budgetMb}MB（当前可用 ${availMb}MB × ${MEM_BUDGET_RATIO}），内存保护已关闭`;

/**
 * 三段回落，选出本次判据用的「预估峰值」。
 *
 * 顺序固定（契约 §2.2）：
 *   ① 插件/缓存给了 peakBytes        → **直接采信，不再叠加安全垫**（责任在声明方）
 *   ② 给了 decompressedBytes（或缓存里的实测解压量）→ 按模型算（模型自带 15% 垫）
 *   ③ 什么都没有（第三方/旧插件）     → 回落到「源包大小分段」= 既有行为，保证不倒退
 *
 * 另外：缓存里若有该包的**实测峰值**（runningPeakBytes），优先用它 ×1.05
 *   ——公式只是冷启动初值，真值由运行积累（见设计文档 §5 回填）。
 * @param {number} sourceMb 源包大小（MB）
 * @param {{peakBytes?:number, decompressedBytes?:number, measuredPeakBytes?:number}} [memory]
 * @returns {{peakEstMb:number, basis:'measured'|'plugin-peak'|'model-decompressed'|'legacy-source'}}
 */
export function estimatePeakWithBasis(sourceMb, memory) {
  const mem = memory || {};
  // ① 实测回填优先（同一指纹解过包了，用真实值 + 5% 环境波动余量）
  if (mem.measuredPeakBytes > 0) {
    return { peakEstMb: Math.ceil((mem.measuredPeakBytes / (1024 * 1024)) * 1.05), basis: 'measured' };
  }
  // ② 插件直接声明峰值：不再叠垫
  if (mem.peakBytes > 0) {
    return { peakEstMb: Math.ceil(mem.peakBytes / (1024 * 1024)), basis: 'plugin-peak' };
  }
  // ③ 声明了解压后大小：模型算（已含 15% 垫）
  if (mem.decompressedBytes > 0) {
    return { peakEstMb: estimatePeakFromDecompressed(mem.decompressedBytes / (1024 * 1024)), basis: 'model-decompressed' };
  }
  // ④ 回落：源包大小分段（旧行为）
  return { peakEstMb: estimatePeakMb(sourceMb), basis: 'legacy-source' };
}

/**
 * 解包入口的内存判据（服务端 resolve 用；**不含时间上限**——用户主动加载不能因为"慢"被拒）。
 *
 * 内存保护开关的落地口径：
 *   默认（不传 opts）＝现状，超预算就拒绝 —— 保持既有行为，现有调用方零改动；
 *   前端把面板里的「内存保护」开关关掉后，请求带上 allowOverLimit:true ⇒ 这里放行，
 *   但仍把真实数字一起返回（调用方要能提示"你放行了 X MB 的包"）。
 * @param {number} sourceBytes 源文件字节数
 * @param {{allowOverLimit?: boolean}} [opts] 是否允许越过内存预算强行解包
 * @returns {{ok: boolean, reason?: string, message?: string, budgetMb: number, peakEstMb: number, availMb: number, overLimit?: boolean}}
 */
export function checkUnpackMemory(sourceBytes, opts = {}) {
  const sourceMb = sourceBytes / 1024 / 1024;
  const avail = memAvailableMb();
  const budgetMb = Math.round(avail.mb * MEM_BUDGET_RATIO);
  const est = estimatePeakWithBasis(sourceMb, opts.memory);
  const peakEstMb = est.peakEstMb;
  if (peakEstMb > budgetMb) {
    // 开关关闭 ⇒ 放行（用户自担风险），但 overLimit 标记与文案都要带出去
    if (opts && opts.allowOverLimit === true) {
      return {
        ok: true,
        reason: 'over-limit-allowed',
        message: OVER_LIMIT_TEXT(peakEstMb, budgetMb, avail.mb),
        budgetMb,
        peakEstMb,
        availMb: avail.mb,
        overLimit: true,
        basis: est.basis,
      };
    }
    return {
      ok: false,
      reason: 'insufficient-memory',
      message: `预估峰值 ${peakEstMb}MB 超过可用预算 ${budgetMb}MB（当前可用 ${avail.mb}MB × ${MEM_BUDGET_RATIO}）`,
      budgetMb,
      peakEstMb,
      availMb: avail.mb,
      overLimit: true,
      basis: est.basis,
    };
  }
  return { ok: true, budgetMb, peakEstMb, availMb: avail.mb, overLimit: false, basis: est.basis };
}
