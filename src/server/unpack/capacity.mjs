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
//     ⇒ 预估耗时只作为参考信息返回（日志里能看"大概多久"），**不参与任何判断**：
//       曾经用它做过预热门槛，结果 15MB 以上的包永远进不了预热、服务端缓存永远填不上。
//   · `os.freemem()` 在 Linux 不含可回收 buff/cache，会严重低估 ⇒ 必须优先 /proc/meminfo 的 MemAvailable。
import fs from 'node:fs';
import os from 'node:os';

/** 预算比例：只用可用内存的一半，给系统/渲染留另一半 */
const MEM_BUDGET_RATIO = 0.5;

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
 * 源包大小 → 预估解包峰值（MB）。**仅供第③段回落**（插件没有声明 memory 时，保证不倒退）。
 * 现在**只作第③段兜底**：准不准是插件的事（它声明 peakBytes 就用它的），核心不再维护容器结构模型。
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
export function capacity(sourceMb, memory) {
  const avail = memAvailableMb();
  const budgetMb = Math.round(avail.mb * MEM_BUDGET_RATIO);
  const base = {
    memTotalMb: Math.round(os.totalmem() / 1024 / 1024),
    memAvailableMb: avail.mb,
    memAvailableSource: avail.source,
    budgetMb,
    ratio: MEM_BUDGET_RATIO,
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
  };
  if (!(sourceMb > 0)) {
    return { ...base, sourceMb: null, peakEstMb: null, estUnpackSec: null, allowWarmup: true, reason: 'no-package', basis: null };
  }
  // 与准入判断（checkUnpackMemory）**同源**：都走 estimatePeakWithBasis，同一个包只该有一个数字
  const est = estimatePeakWithBasis(sourceMb, memory);
  const peakEstMb = est.peakEstMb;
  // 预估耗时只作参考信息（日志里能看"大概多久"），**不参与任何判断**
  const estUnpackSec = estimateUnpackSec(sourceMb);
  if (peakEstMb > budgetMb) {
    return { ...base, sourceMb, peakEstMb, estUnpackSec, allowWarmup: false, reason: 'insufficient-memory', basis: est.basis };
  }
  // 预热只看内存：**不再有时间门槛**。旧实现"预估 >6s 就不预热"导致 15.4MB 以上的包永远进不了预热，
  //   data/unpacked 永远填不上 ⇒ 前端一直回落本地解包，服务端为判断付的 probe/内存读取全都白跑。
  return { ...base, sourceMb, peakEstMb, estUnpackSec, allowWarmup: true, reason: 'ok', basis: est.basis };
}

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
  // ① 实测回填优先：同一容器解过包了，用真实峰值 + 5% 环境波动余量（比任何声明都准）
  if (mem.measuredPeakBytes > 0) {
    return { peakEstMb: Math.ceil((mem.measuredPeakBytes / (1024 * 1024)) * 1.05), basis: 'measured' };
  }
  // ② 插件声明峰值：**直接采信，不叠加安全垫**（准不准是插件的责任，见 docs/契约/插件.md §2.2）
  if (mem.peakBytes > 0) {
    return { peakEstMb: Math.ceil(mem.peakBytes / (1024 * 1024)), basis: 'plugin-peak' };
  }
  // ③ 回落：按源包大小分段粗估（核心不维护任何"容器结构模型"——那是各插件自己的事）
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
      // 说清"为什么被拒 + 还能怎么办"：解包本来就是**串行**的（plugin-store 的 enqueue 链），
      //   所以这里不是"并发太多"，而是这个包自己就要这么多 —— 能做的只有等内存回来再试。
      //   不提高全局上限（那等于把守护关掉），也不自动重试（会在内存紧张时形成抖动重试风暴）。
      message: `预估峰值 ${peakEstMb}MB 超过可用预算 ${budgetMb}MB（当前可用 ${avail.mb}MB × ${MEM_BUDGET_RATIO}）`
        + '；解包串行执行，稍后内存释放后可重试（或先关掉其它已加载模型）',
      budgetMb,
      peakEstMb,
      availMb: avail.mb,
      overLimit: true,
      basis: est.basis,
    };
  }
  return { ok: true, budgetMb, peakEstMb, availMb: avail.mb, overLimit: false, basis: est.basis };
}
