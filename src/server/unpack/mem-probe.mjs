// server/unpack/mem-probe.mjs —— 读进程内存（RSS 与内核记录的峰值 VmHWM）
//
// 为什么抽成模块：解包搬进 worker 后，worker 里也要在解包前后各读一次（算本次峰值增量），
//   而主线程的准入/统计路径同样要读 —— 两边必须同一份实现、同一口径。
//
// **口径不变（关键）**：worker_threads 里 `/proc/self` 指向同一个进程，
//   所以在 worker 里读与在主线程读得到的是同一组数字，VmHWM 语义完全不变 —— 不需要改测量代码。

import fs from 'node:fs';

/**
 * 读当前 RSS 与进程峰值。
 * @param {number} [peakFallback] 非 Linux（读不到 /proc）时的兜底峰值基线
 * @returns {{rss:number, peak:number, source:'vmhwm'|'sample'}}
 */
export function rssNow(peakFallback = 0) {
  try {
    const txt = fs.readFileSync('/proc/self/status', 'utf8');
    const hwm = /VmHWM:\s+(\d+)\s+kB/.exec(txt);
    const rss = /VmRSS:\s+(\d+)\s+kB/.exec(txt);
    if (hwm) return { rss: rss ? Number(rss[1]) * 1024 : process.memoryUsage().rss, peak: Number(hwm[1]) * 1024, source: 'vmhwm' };
  } catch { /* 非 Linux：退回抽样 */ }
  const rss = process.memoryUsage().rss;
  return { rss, peak: Math.max(peakFallback, rss), source: 'sample' };
}

export default rssNow;
