// app/memory-budget.js —— 内存判据的**唯一决策入口**（策略层）
//
// 为什么要有这一层：项目里曾经同时存在三处"防内存打爆"的判断，各写各的
//   ① capacity.mjs 用「可用内存 × 0.5 vs 预估峰值」——有权威翻译器、受开关控、文案带数字
//   ② memory-guard.js 用「JS 堆 85%」——受开关控
//   ③ plugin-host.js 用「裸包字节 > 512MB 硬编码」——不受开关控、文案丢数字、更不看内存余量
//   同一个包在 8GB 机器上没事、在 2GB 机器上必炸，第③处却一视同仁地拦。
//   所以这里把"能不能做"收成一个函数，谁要判断都问它。
//
// 🔴 铁律：**前端不自己算倍数**。
//   「包字节 → 预估峰值」的权威实现只有服务端 capacity.mjs 的 estimatePeakMb（三档实测上包络），
//   前端自己写 bytes*20 之类的倍数 = 又造一个新口径，正是本任务要消灭的东西。
//
// 数据源分工（不许越界）：
//   · 服务端内存：只能从 GET /api/unpack/capacity 拿（浏览器里读不到系统内存）
//   · 前端堆占用：只能从浏览器 performance.memory 拿（服务端读不到）

import { memStats } from '../infra/mem-stats.js';
import { stageLog } from './status.js';

/**
 * 前端堆占用阈值（路径 B / C 与 assess 共用**同一个**值）。
 * 为什么放在这里：判据口径只允许有一份，memory-guard 从这里 import ——
 *   两边各写一个 0.85 就是新一轮"同一事实两处表达"，迟早漂移。
 *
 * 缺省 0.85；服务端可用 **MODELSTAGE_ADMIT_HEAP_RATIO** 覆盖，
 *   经 `GET /api/web-config` 的 `admitHeapRatio` 下发到前端（前端读不到 env）。
 * 这里用 `let` 而不是 const：下发值要在启动后覆盖缺省，而 import 方拿到的是**活绑定**，
 *   memory-guard 里那些 `h.pct > HEAP_RATIO` 无需改动就会看到新值。
 */
export let HEAP_RATIO = 0.85;
/** 缺省值（下发值缺失/非法时回落到它；也是文档里写的那个数） */
export const DEFAULT_HEAP_RATIO = 0.85;

/**
 * 应用服务端下发的准入配置（幂等；非法值回落缺省并 warn 一次）。
 * @param {{admitHeapRatio?: number}} cfg /api/web-config 的响应
 * @returns {{ratio: number, applied: boolean}}
 */
export function applyAdmitConfig(cfg) {
  if (!cfg || cfg.admitHeapRatio === undefined || cfg.admitHeapRatio === null) {
    return { ratio: HEAP_RATIO, applied: false };
  }
  const v = Number(cfg.admitHeapRatio);
  const ok = Number.isFinite(v) && v > 0 && v <= 1;
  if (!ok) {
    // 不静默：下发值非法时说明白用的是哪个数，否则"为什么阈值没变"只能靠猜
    try { stageLog('warn', `准入堆比例下发值非法（${JSON.stringify(cfg.admitHeapRatio)}）—— 继续用 ${HEAP_RATIO}`); } catch { /* 日志失败不影响判据 */ }
    return { ratio: HEAP_RATIO, applied: false };
  }
  HEAP_RATIO = v;
  try { stageLog('info', `准入堆比例已按服务端下发调整：${v}`); } catch { /* 同上 */ }
  return { ratio: HEAP_RATIO, applied: true };
}

/** 服务端判据缓存时长：同一个包在短时间内反复判断不该每次都打服务端 */
const CAP_TTL_MS = 5000;

/** 开关状态镜像（由 memory-guard.setMemoryGuard 同步过来，避免两层互相 import 成环） */
let guardEnabled = true;

/** 缓存：key = 包 MB（取整）/ 'machine' → { at, value } */
const capCache = new Map();

/** 实际发起过的服务端请求次数（验收"缓存生效"用） */
let fetchCount = 0;

/**
 * 同步"内存保护开关"状态。memory-guard.setMemoryGuard 里会调它。
 * @param {boolean} on
 */
export function setBudgetGuardEnabled(on) {
  guardEnabled = on !== false;
}

/** @returns {boolean} 当前是否受开关约束 */
export function isBudgetGuardEnabled() {
  return guardEnabled;
}

/**
 * 取服务端判据（带 5 秒缓存）。
 * @param {number} sourceMb 包大小（MB）；0/缺省 ⇒ 只问机器级信息
 * @returns {Promise<object|null>} 拿不到返回 null（调用方按"这一路不可用"处理）
 */
async function fetchServerJudgement(sourceMb) {
  const key = sourceMb > 0 ? String(Math.round(sourceMb)) : 'machine';
  const hit = capCache.get(key);
  if (hit && Date.now() - hit.at < CAP_TTL_MS) return hit.value;
  const qs = sourceMb > 0 ? `?sourceMb=${encodeURIComponent(sourceMb)}` : '';
  try {
    fetchCount += 1;
    const res = await fetch(`/api/unpack/capacity${qs}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    capCache.set(key, { at: Date.now(), value: j });
    return j;
  } catch (err) {
    stageLog('warn', `内存判据取不到服务端数据：${String((err && err.message) || err)}`, { sourceMb });
    return null;
  }
}

/** 读前端堆占用（不可用返回 null，不瞎估） */
function heapStats() {
  try {
    const s = memStats();
    if (s.jsHeapPct === null || s.jsHeapPct === undefined) return null;
    return { pct: s.jsHeapPct, usedMB: s.jsHeapMB, limitMB: s.jsHeapLimitMB };
  } catch {
    return null;
  }
}

/** 百分比显示：不足 1% 写成 <1%（写 0% 会让人以为没数据） */
function pctText(pct) {
  return pct < 0.01 ? '<1' : String(Math.round(pct * 100));
}

/**
 * 统一决策：这次操作能不能做。
 *
 * 判据取**更严格的一路**（任一路不通过即不通过）；两路都拿不到 ⇒ **放行 + 记日志**
 *   —— 拿不到真值时不假装保护，否则会变成"在某些浏览器上永远加载不了"。
 *
 * @param {object} opts
 * @param {number} [opts.bytesHint] 已知的包字节数（能算出预估峰值）
 * @param {'web-load'|'web-unpack'|'web-long-op'} [opts.where] 调用场景（只影响文案与默认策略）
 * @param {string} [opts.label] 对象名（写进文案，让用户知道是哪一步被拦）
 * @returns {Promise<{ok:boolean, reason:string, numbers:object, message:string}>}
 *   numbers: { pkgBytes, peakEstMb, budgetMb, availMb, heapPct, usedMB, limitMB }
 */
export async function assess(opts = {}) {
  const where = opts.where || 'web-load';
  const label = String(opts.label || '').trim();
  const bytes = Number(opts.bytesHint) > 0 ? Number(opts.bytesHint) : 0;
  const numbers = {
    pkgBytes: bytes || null,
    peakEstMb: null,
    budgetMb: null,
    availMb: null,
    heapPct: null,
    usedMB: null,
    limitMB: null,
  };

  if (!guardEnabled) {
    // 开关关闭：**连绝对兜底也不拦**（用户明示要试）
    return { ok: true, reason: 'guard-off', numbers, message: '' };
  }

  // 路 A｜服务端：包字节 → 预估峰值 / 预算 / 可用
  const srv = await fetchServerJudgement(bytes > 0 ? bytes / 1024 / 1024 : 0);
  const heap = heapStats();
  let serverJudged = false;
  let serverFails = false;
  let serverDetail = '';
  if (srv && Number.isFinite(srv.peakEstMb) && Number.isFinite(srv.budgetMb)) {
    serverJudged = true;
    numbers.peakEstMb = srv.peakEstMb;
    numbers.budgetMb = srv.budgetMb;
    numbers.availMb = Number.isFinite(srv.memAvailableMb) ? srv.memAvailableMb : null;
    if (srv.peakEstMb > srv.budgetMb) {
      serverFails = true;
      serverDetail = `预估峰值 ${srv.peakEstMb}MB 超过可用预算 ${srv.budgetMb}MB（当前可用 ${numbers.availMb}MB × 0.5）`;
    }
  }
  if (heap) {
    numbers.heapPct = heap.pct;
    numbers.usedMB = heap.usedMB;
    numbers.limitMB = heap.limitMB;
  }

  // 两路都拿不到 ⇒ 放行 + 记日志（不假装保护）
  if (!serverJudged && !heap) {
    stageLog('warn', `内存判据两路都不可用，放行（${where}${label ? ` · ${label}` : ''}）`, { where, bytes });
    return { ok: true, reason: 'unjudgeable', numbers, message: '' };
  }

  const heapFails = !!(heap && heap.pct > HEAP_RATIO);
  if (serverFails || heapFails) {
    return {
      ok: false,
      reason: serverFails ? 'insufficient-memory' : 'heap-high',
      numbers,
      message: buildMessage({ where, label, serverFails, heapFails, serverDetail, numbers }),
    };
  }
  return { ok: true, reason: 'ok', numbers, message: '' };
}

/**
 * 统一文案模板（三处同一套格式）：`无法<动作>「<对象>」：<判据含真实数字>。<能怎么办>`
 *
 * 为什么必须带数字：只说"内存不足/文件过大"，用户无法判断该关标签页、拆包还是换机器。
 * @returns {string}
 */
export function buildMessage({ where, label, serverFails, heapFails, serverDetail, numbers }) {
  const obj = label ? `「${label}」` : '';
  const verb = where === 'web-unpack' ? '解包' : (where === 'web-long-op' ? '继续' : '加载');
  const parts = [];
  if (serverFails && serverDetail) parts.push(serverDetail);
  if (heapFails && numbers.heapPct !== null) {
    parts.push(`内存占用较高（${numbers.usedMB} MB / ${numbers.limitMB} MB，${pctText(numbers.heapPct)}%）`);
  }
  const why = parts.join('；');
  const advice = where === 'web-unpack'
    ? '可先关闭其他程序，或改用更小的包。'
    : (where === 'web-long-op'
      ? '已完成的文件保留，可稍后重试剩余部分。'
      : '请关闭其他标签页后重试。');
  return `无法${verb}${obj}：${why}。${advice}`;
}

/** 验收用：已发起的服务端判据请求次数 */
export function budgetStats() {
  return { fetchCount, cachedKeys: [...capCache.keys()] };
}

/** 供测试重置 */
export function __resetMemoryBudgetForTest() {
  capCache.clear();
  fetchCount = 0;
  guardEnabled = true;
}
