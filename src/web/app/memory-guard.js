// app/memory-guard.js —— 内存保护（一个开关管三条路径）
//
// 与 ctl-hang-guard 的区别（别混）：
//   memoryGuard（本文件） = **内存容量**保护 → 防 OOM / 页面崩溃
//   ctl-hang-guard        = **帧停滞**看门狗 → 画面停住时尝试自愈
//   两者并列、互不替代。
//
// 三条路径：
//   A 服务端解包准入：开关开＝超预算拒绝（既有行为）；关＝请求带 allowOverLimit 强行解包。
//     判断全在服务端（capacity.mjs，读 /proc/meminfo），前端不自己算阈值。
//   B 前端加载前预检：jsHeap 占上限比例 > HEAP_RATIO 就拒绝并给出真实数字。
//   C 长操作中监控：解包/批量加载期间按帧采样 jsHeap，超限即中止（已完成的文件保留）。
//
// 为什么数值必须取真值：只说"内存不足"用户无法判断该拆包还是该关标签页 ——
//   所以所有提示都带「当前 / 上限 / 百分比 / MB」。

import { memStats } from '../infra/mem-stats.js';

/** 前端堆占用上限比例（路径 B / C 共用）。85% 与旧端 memoryGuard 的口径一致。 */
export const HEAP_RATIO = 0.85;

/** 操作中监控的采样间隔（帧）—— 每 20 帧约 1/3 秒，够快且不干扰渲染 */
export const MONITOR_FRAME_STRIDE = 20;

/** 开关状态（默认开：保持"服务端永远准入判断"的现状，关才放行） */
let enabled = true;

/** 最近一次判据读数（面板显示 + 断言都用它，避免各处各取一次导致数字对不上） */
let readout = { availMb: null, totalMb: null, peakEstMb: null, budgetMb: null, at: 0, error: '' };

/**
 * 设置开关（面板 ctl-memory-guard 变化时调用）。
 * @param {boolean} on
 * @returns {boolean} 生效后的值
 */
export function setMemoryGuard(on) {
  enabled = on !== false;
  try { document.documentElement.dataset.memoryGuard = enabled ? 'on' : 'off'; } catch { /* 忽略 */ }
  return enabled;
}

/** @returns {boolean} 内存保护是否开启 */
export function isMemoryGuardOn() {
  return enabled;
}

/**
 * 读前端堆占用（真值来自 performance.memory，不可用时返回 null 而不是瞎估）。
 * @returns {{usedMB:number|null, limitMB:number|null, pct:number|null}}
 */
export function heapSnapshot() {
  const s = memStats();
  return { usedMB: s.jsHeapMB, limitMB: s.jsHeapLimitMB, pct: s.jsHeapPct };
}

/**
 * 路径 B：加载大模型前的预检。
 *
 * 判不了（浏览器不暴露 performance.memory，如 Firefox/Safari）就**放行** ——
 *   拿不到真值时不假装保护，否则会变成"在部分浏览器上永远加载不了"。
 * @param {string} what 要加载的东西（写进提示，便于用户知道是哪一步被拦）
 * @returns {{ok: boolean, message?: string, usedMB?: number|null, limitMB?: number|null, pct?: number|null}}
 */
export function preflightLoad(what) {
  if (!enabled) return { ok: true };
  const h = heapSnapshot();
  if (h.pct === null || h.pct === undefined) return { ok: true, ...h, unjudgeable: true };
  if (h.pct <= HEAP_RATIO) return { ok: true, ...h };
  // 极低占用时 round 会给出 "0%"，看着像没数据 ⇒ 不足 1% 一律写成 <1%
  const pctText = h.pct < 0.01 ? '<1' : String(Math.round(h.pct * 100));
  return {
    ok: false,
    ...h,
    message: `内存占用较高（${h.usedMB} MB / ${h.limitMB} MB，${pctText}%），${what}已暂停；请关闭其他标签页后重试`,
  };
}

/**
 * 路径 C：长操作中的内存监控。
 *
 * 用法：
 *   const mon = startMemoryMonitor('解包');
 *   for (...) { await one(); if (mon.aborted()) break; }   // 中止但保留已完成的部分
 *   mon.stop();
 *
 * 为什么按帧采样而不是 setInterval：跟着渲染循环走，页面不可见时自然降频，
 *   不会在后台标签页里空转（符合《事件驱动优先》）。
 * @param {string} label 操作名（写进日志与提示）
 * @returns {{stop: () => void, aborted: () => boolean, reason: () => string, samples: () => number}}
 */
export function startMemoryMonitor(label) {
  const state = { hit: false, why: '', n: 0, frames: 0 };
  let raf = 0;
  let cancelled = false;

  /** 采一次样并判定（帧回调与同步检查共用这一处，避免两套判定漂移） */
  const sample = () => {
    if (state.hit || cancelled) return;
    state.n += 1;
    const h = heapSnapshot();
    if (!enabled || h.pct === null || h.pct <= HEAP_RATIO) return;
    state.hit = true;
    const pct = h.pct < 0.01 ? '<1' : String(Math.round(h.pct * 100));
    state.why = `${String(label).trim()}过程中内存占用较高（${h.usedMB} MB / ${h.limitMB} MB，${pct}%），已中止后续步骤（已完成的文件保留）`;
    try { document.documentElement.dataset.memGuardAbort = label; } catch { /* 忽略 */ }
  };

  const tick = () => {
    if (cancelled || state.hit) return;
    state.frames += 1;
    // 首帧就采一次，之后每 MONITOR_FRAME_STRIDE 帧一次。
    //   原来只在 %STRIDE===0 时采 ⇒ "几帧内跑完"的短操作等于没有监控
    //   （实测：取 19 个小文件一帧都没跨过，监控从未触发）。
    if (state.frames === 1 || state.frames % MONITOR_FRAME_STRIDE === 0) sample();
    if (state.hit) return;
    raf = requestAnimationFrame(tick);
  };
  if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(tick);

  return {
    stop: () => { cancelled = true; try { cancelAnimationFrame(raf); } catch { /* 忽略 */ } },
    aborted: () => state.hit,
    reason: () => state.why,
    samples: () => state.n,
    /**
     * 同步采样一次，返回是否已越线。
     *
     * 为什么需要：按帧采样对"密集但总时长短"的循环无能为力 —— 取 19 个小文件可能一帧都没跨过，
     *   那时监控等于不存在。调用方在每步开始前调它，就能在"还没排到下一帧"时也发现越线。
     */
    checkNow: () => { sample(); return state.hit; },
  };
}

/**
 * 刷新判据读数（面板「内存判据」那行显示的真实值）。
 *
 * 数值来源必须是服务端的 /api/unpack/capacity（它读 /proc/meminfo），
 *   前端不许自己拍脑袋算"大概够不够"。
 * @param {{rootId?: string, rel?: string}} [target] 给了就带上该包的需求估算
 * @returns {Promise<object>} 服务端返回的判据（失败时返回 {error}）
 */
export async function refreshMemoryReadout(target) {
  const qs = target && target.rootId && target.rel
    ? `?rootId=${encodeURIComponent(target.rootId)}&rel=${encodeURIComponent(target.rel)}`
    : '';
  try {
    const res = await fetch(`/api/unpack/capacity${qs}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    readout = {
      availMb: Number.isFinite(j.memAvailableMb) ? j.memAvailableMb : null,
      totalMb: Number.isFinite(j.memTotalMb) ? j.memTotalMb : null,
      peakEstMb: Number.isFinite(j.peakEstMb) ? j.peakEstMb : null,
      budgetMb: Number.isFinite(j.budgetMb) ? j.budgetMb : null,
      at: Date.now(),
      error: '',
    };
    return { ...j, readout };
  } catch (err) {
    readout = { ...readout, at: Date.now(), error: String((err && err.message) || err) };
    return { error: readout.error, readout };
  }
}

/**
 * 判据显示文案（带真实数字；拿不到时明说拿不到，不编）。
 * @returns {string}
 */
export function readoutText() {
  const r = readout;
  if (!r.at) return '内存判据：尚未取到（打开面板后自动拉取）';
  if (r.error) return `内存判据：取不到（${r.error}）`;
  const avail = r.availMb === null ? '未知' : `${r.availMb} MB`;
  const total = r.totalMb === null ? '' : ` / 总 ${r.totalMb} MB`;
  const need = r.peakEstMb === null ? '需求：选中有资源的模型后显示' : `需求 ${r.peakEstMb} MB（预算 ${r.budgetMb} MB）`;
  return `可用 ${avail}${total} · ${need}`;
}

/** 最近一次读数（断言用） */
export function memoryReadout() {
  return { ...readout };
}

/** 供测试/断言的整体快照 */
export function memGuardSnapshot() {
  return {
    enabled,
    heapRatio: HEAP_RATIO,
    heap: heapSnapshot(),
    readout: memoryReadout(),
    abortedLabel: (() => { try { return document.documentElement.dataset.memGuardAbort || ''; } catch { return ''; } })(),
  };
}

/** 供测试重置（仅测试用） */
export function __resetMemoryGuardForTest() {
  enabled = true;
  readout = { availMb: null, totalMb: null, peakEstMb: null, budgetMb: null, at: 0, error: '' };
  try { delete document.documentElement.dataset.memGuardAbort; } catch { /* 忽略 */ }
}
