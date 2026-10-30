// server/unpack/probe-store.mjs —— probe.json（内存声明/实测缓存）的读写
//
// 为什么抽成独立模块：解包搬进 worker 后，**worker 里要写 probe.json**（recordMeasuredPeak 与
//   writeResult 的"删旧目录前先取走 probe、rename 后再写回"逻辑强耦合）；而主线程的命中/准入
//   路径也要读它。两边必须是**同一份实现** —— 否则"改一处、另一处静默失效"。
//
// 口径（一个字都不许改，改动等于把历史 measuredPeakBytes 变成不可比）：
//   峰值 = 起始 RSS + 本次 VmHWM 增量
//   即 guess = before.rss + max(0, after.peak - before.peak)，再与历史值取 max 单调不降。

import fs from 'node:fs';
import path from 'node:path';

/** probe 缓存文件名（与解包产物同指纹同目录，跟着 LRU 一起回收） */
export const PROBE_FILE = 'probe.json';

/**
 * 造一个 probe 读写器。
 * @param {{rootDir: string}} opts rootDir = 解包缓存根（如 <dataRoot>/unpacked）
 */
export function createProbeStore(opts) {
  if (typeof (opts || {}).rootDir !== 'string' || !opts.rootDir) {
    throw new Error('createProbeStore: rootDir 必填（解包缓存根目录）');
  }
  const rootDir = opts.rootDir;
  const fpDir = (fp) => path.join(rootDir, fp);
  const probePath = (fp) => path.join(fpDir(fp), PROBE_FILE);

  /** 读 probe 缓存（不存在/损坏都当没有，不让缓存问题阻断解包） */
  function read(fp) {
    try { return JSON.parse(fs.readFileSync(probePath(fp), 'utf8')); } catch { return null; }
  }

  /** 合并写 probe 缓存（写不进去不影响正确性） */
  function write(fp, patch) {
    const next = { ...(read(fp) || {}), ...patch };
    try {
      fs.mkdirSync(fpDir(fp), { recursive: true });
      fs.writeFileSync(probePath(fp), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    } catch { /* 缓存写不进去不影响正确性 */ }
    return next;
  }

  /**
   * 记录本次解包的实测峰值。
   *
   * 语义与搬 worker 之前**逐字相同**：
   *   · 峰值口径 = 起始 RSS + 本次 VmHWM 增量（VmHWM 是进程级、只增不减，所以要看"增量"）
   *   · measuredPeakBytes 与历史值取 max（单调不降，跨多次解包保留最高水位）
   * @param {string} fp
   * @param {{rss:number, peak:number}} before 解包前（worker 里读的，与主线程同源）
   * @param {{rss:number, peak:number}} after 解包后
   * @param {{decompressedBytes?:number, compressedBytes?:number, probeAt?:number}|null} decl 内存声明
   */
  function recordMeasuredPeak(fp, before, after, decl) {
    const guess = before.rss + Math.max(0, after.peak - before.peak);
    const prev = read(fp) || {};
    const measuredPeakBytes = Math.max(prev.measuredPeakBytes || 0, guess);
    return write(fp, {
      // 声明值存档（供下次准入直接用，避免再 probe）
      decompressedBytes: (decl && decl.decompressedBytes) || prev.decompressedBytes || 0,
      compressedBytes: (decl && decl.compressedBytes) || prev.compressedBytes || 0,
      probeAt: (decl && decl.probeAt) || prev.probeAt || Date.now(),
      measuredPeakBytes,
      measuredAt: Date.now(),
      samples: (prev.samples || 0) + 1,
    });
  }

  return { fpDir, probePath, read, write, recordMeasuredPeak };
}

export default createProbeStore;
