// src/web/infra/plugin-host-warmup.mjs —— 预热链（从 plugin-host.js 抽出，B1）
//
// 为什么单独成模块：预热是"选中即触发"的后台任务，它的全部状态（容量缓存、在途去重、阶段文案）
//   只服务于这一件事；搬出去后 plugin-host 里只剩"对外暴露 warmup"。
//
// 依赖约定：
//   · ctx          —— 只用到 ctx.say / ctx.emit（工具按调研结论仍随 ctx 传入；本模块不读状态）
//   · postStream   —— 服务端事件流（由 ./api.js 提供）
//   · memoryGuard  —— 内存保护开关（决定 allowOverLimit；由 ../app/memory-guard.js 提供）
// 模块自有状态（低频，随模块走）：capCache / CAP_TTL_MS / warmupInflight / WARMUP_PHASE_TEXT。
//
// ⚠️ 行为契约（验收口径，搬迁时逐字保留）：预热**只看内存**、不设时间门槛；
//   去重命中时**静默返回**（连 diag 也不发）；失败一律记 info 不记 error。

import * as memoryGuard from '../app/memory-guard.js';
import { postStream } from './api.js';

/**
 * @param {{ctx: object}} deps
 * @returns {(file: {rootId: string, rel: string, size?: number}) => void} warmup
 */
export function createWarmup({ ctx }) {
  /** 容量探测缓存（60s）；失败时**保守不放行**（reason=fallback），绝不当成"随便解包" */
  let capCache = null;
  const CAP_TTL_MS = 60 * 1000;

  /**
   * 问服务端"这个包现在能预热吗"。判断全在服务端：可用内存**现取** × 0.5 预算 vs 预估峰值，
   * 预热**只看内存**（时间不再是门槛：旧规则"预估 >6s 不预热"会让 15MB 以上的包永远进不了缓存）。\n   * 前端只读 `allowWarmup` 一个布尔，不自己算任何阈值。
   * @param {{rootId: string, rel: string}} file
   * @returns {Promise<{allowWarmup: boolean, reason: string, peakEstMb?: number, budgetMb?: number, estUnpackSec?: number}>}
   */
  async function fetchCapacity(file) {
    const key = `${file.rootId}/${file.rel}`;
    if (capCache && capCache.key === key && Date.now() - capCache.at < CAP_TTL_MS) return capCache.value;
    const fallback = { allowWarmup: false, reason: 'fallback:capacity-unavailable' };
    try {
      const qs = `?rootId=${encodeURIComponent(file.rootId)}&rel=${encodeURIComponent(file.rel)}`;
      const res = await fetch(`/api/unpack/capacity${qs}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(1500) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const value = {
        allowWarmup: j.allowWarmup === true,
        reason: String(j.reason || 'unknown'),
        peakEstMb: j.peakEstMb,
        budgetMb: j.budgetMb,
        estUnpackSec: j.estUnpackSec,
        // 判据显示要贴真实值：可用内存与总内存一起带出来（不在这里重算任何阈值）
        memAvailableMb: j.memAvailableMb,
        memTotalMb: j.memTotalMb,
      };
      capCache = { at: Date.now(), key, value };
      return value;
    } catch {
      capCache = { at: Date.now(), key, value: fallback };
      return fallback;
    }
  }

  /**
   * 预热：**选中即触发**，让服务端把**当前这一个包**解包落盘，供下次命中。
   * 绝不预热整个根（19 个包 × 10s 白烧）。
   *
   * 两条必须：
   *   · 只预热当前包；
   *   · **必打 diag 日志** `unpack.warmup {rootId, rel, sizeMb, skipped?, ms}`，否则"为什么这个包没预热"无从查证。
   * 不加任何时间门槛：能不能预热只由内存准入决定（服务端给 allowWarmup），不看预估耗时、不延迟。
   * @param {{rootId: string, rel: string, size?: number}} file
   */
  function warmup(file) {
    const sizeMb = Number(file && file.size) / 1048576;
    const emitWarm = (extra) => ctx.emit('unpack.warmup', { rootId: file && file.rootId, rel: file && file.rel, sizeMb: +sizeMb.toFixed(1), ...extra });
    if (!file || !file.rootId || !file.rel) return;
    // 上限来自服务端（CPU 维度与内存维度取小）；拿不到则保守 12
    fetchCapacity(file).then((cap) => {
      if (!cap.allowWarmup) {
        emitWarm({ skipped: cap.reason, peakEstMb: cap.peakEstMb, budgetMb: cap.budgetMb, estUnpackSec: cap.estUnpackSec });
        ctx.say.info(`跳过预热：${file.rel} ${sizeMb.toFixed(1)}MB（${cap.reason}；预估峰值 ${cap.peakEstMb}MB / 预算 ${cap.budgetMb}MB / 预估耗时 ${cap.estUnpackSec}s）`);
        return;
      }
      scheduleWarmup(file, emitWarm, cap);
    }).catch(() => {
      // fetchCapacity 内部已有兜底（allowWarmup=false），这里防御未知异常：保守跳过
      emitWarm({ skipped: 'fallback:capacity-unavailable' });
    });
  }

  /**
   * 在途预热去重：key = `${rootId}/${rel}`。
   *
   * 为什么必须去重：`model-actions` 每次装载都会调 warmup()，同一个模型被装载多次就排多次请求；
   *   而服务端的解包是**串行**的（plugin-store 的 inflight + 队列），后到的那几个全部 join 到
   *   同一个 inflight 上 —— 于是每个都等足同一段时长、每个都被前台的 8.5s 掐断一次、每个再重试一次。
   *   实测（500 条日志那批）：同一个 rel 被重复预热 4~6 次
   *     xukufu_3_hx：ms=1969 / 19933 / 12770 / 18598(hit=true) 四条，全是同一次解包的不同等待者。
   *
   * 为什么"完成即删"而不是"永久记住已预热"：插件版本升级、服务端缓存被清（LRU/手工删目录）之后，
   *   同一个包仍然需要能重新预热 —— 记死就再也不会补了。
   */
  const warmupInflight = new Set();

  /**
   * `phase.name` → 界面措辞（契约 §四 ④：服务端只发 read/resolve/write 三个名字，文案归前端）。
   * 放这一处常量、别散落到各处：措辞变了只改这里，也避免服务端被逼着下发界面文字。
   * 注意**没有百分比**：解压是一次性整段，服务端给不出可信进度，假进度条比没有更糟。
   */
  const WARMUP_PHASE_TEXT = { read: '读盘中', resolve: '解压中', write: '写盘中' };

  /**
   * 真正执行预热：**选中即触发**，不等空闲、不延迟。
   *
   * 为什么删掉了 requestIdleCallback(timeout 3000) + setTimeout(2000)：
   *   那两个限制加起来最坏 5s 后才开始预热，而页面在 9s 就已经要加载同一个包了 ——
   *   首次打开任何新资源，缓存都来不及做好，前端只能自己解一遍（实测 4.3s / 19MB 白花）。
   *   服务端解包是原生能力，不是"抢 CPU 的备选"，不该被推迟到空闲。
   */
  function scheduleWarmup(file, emitWarm, cap) {
    const key = `${file.rootId}/${file.rel}`;
    // 去重命中时**静默返回**（连 diag 也不发）：验收口径是「unpack.warmup 条数 == 不同 rel 个数」，
    //   这里多发一条就等于把噪音从网络层搬到日志层。say 没有 debug 级，所以干脆不说话。
    if (warmupInflight.has(key)) return;
    warmupInflight.add(key);
    (async () => {
      const t0 = performance.now();
      let events = 0;
      try {
        // 预热是**后台**任务，不能借用前台的判失败策略：
        // · 不重试 —— 服务端解包是串行的，重发只会把队列压得更长。postStream 不走 fetchWithRetry，
        //   天生不重试，所以这一条与上一轮定的 `retries: 0` 等价（那条约定的目的不变）。
        // · **不设总时长上限** —— 慢机器解 30s、60s 都属正常。判失败只看「有没有进展」：
        //   postStream 每收到任意一帧（含 ping）就重置停摆计时，连续 15s 无帧才中止（契约 §四）。
        //   上一轮那个 120s 固定上限是"没有进展信号时"的妥协；有了事件流就该撤掉它。
        const j = await postStream('/api/unpack/resolve',
          { rootId: file.rootId, rel: file.rel, allowOverLimit: !memoryGuard.isMemoryGuardOn(), stream: true },
          {
            onEvent: (name, data) => {
              events += 1;
              // 进度只进**现有**日志/状态行，不新造 UI 控件；也不给百分比（服务端给不出可信的）
              if (name === 'queued') ctx.say.info(`预热排队中：${file.rel}（前面约 ${Number((data && data.waiting) || 0)} 个）`);
              else if (name === 'start') ctx.say.info(`预热开始解包：${file.rel}`);
              else if (name === 'phase') {
                const ph = (data && data.name) || '';
                ctx.say.info(`预热${WARMUP_PHASE_TEXT[ph] || `${ph || '进行'}中`}：${file.rel}（${Number((data && data.ms) || 0)}ms）`);
              }
              // ping 不显示：它只用于维持停摆计时（postStream 内部每帧都会重置计时器）
            },
            onStall: () => {
              // 措辞铁律（契约 §四）：这里是"停摆"，不是"超时"
              ctx.say.info(`预热停摆（15s 无事件），已放弃等待；服务端仍会解完并写缓存：${file.rel}`);
            },
          });
        emitWarm({
          ok: !!j.ok,
          hit: !!(j && j.hit),
          peakEstMb: cap && cap.peakEstMb,
          ms: Math.round(performance.now() - t0),
          events,
          ...(j && j.reason ? { reason: j.reason } : {}),
        });
        if (j && j.ok) {
          // done 即完成：hit:true（已有缓存）与 hit:false（本次已落盘）都算成功
          ctx.say.info(`预热完成：${file.rel}（${j.hit ? '已有缓存' : '已落盘'}，${Math.round(performance.now() - t0)}ms）`);
        } else {
          // 流内 error / 停摆：都只记 info —— 预热失败不是错误，前台装载有自己的路径
          ctx.say.info(`后台预热未完成：${file.rel}（${(j && j.message) || (j && j.reason) || '未知原因'}）—— 服务端仍会解完并写缓存，下次命中即可`);
        }
      } catch (e) {
        const why = String((e && e.message) || e).slice(0, 120);
        emitWarm({ ok: false, error: why, events });
        // 预热失败**不是错误**：前台装载有自己的路径（本地解包 / 服务端命中），预热只是"下次更快"。
        //   记 info 不记 error/warn —— 否则每次装载都在日志里刷一条红，把真问题淹掉。
        ctx.say.info(`后台预热未完成：${file.rel}（${why}）—— 服务端仍会解完并写缓存，下次命中即可`);
      } finally {
        // 成功/失败/超时都要移除，否则一次失败会让这个 rel 永远不再预热
        warmupInflight.delete(key);
      }
    })();
  }
  return warmup;
}
