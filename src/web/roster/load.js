// roster/load.js —— 名册加载编排（从 view.js 原样搬出：函数体、文案、调用顺序一字不改）
//
// 负责什么：
//   · 资源根 → /api/catalog 的加载编排（entry.promise 让并发调用方**可等待**）；
//   · 扫描进度流（NDJSON）的订阅、进度贴行、重试；
//   · 「名册加载计时」（每根耗时 / 总耗时 / 就绪那句 info）与后台形态探测进度；
//   · 惰性加载策略：只加载被点开的那一个游戏（启动不扇出）。
//
// 不负责什么：DOM 结构与文案排版（render.js）、DOM 事件（events.js）、装配（view.js）。
//
// 依赖方向（单向，无环）：store ← load ← render/events ← view。
//   本文件只 import 叶子模块（scan-stream / list / infra/api / app/status）；
//   与渲染相关的能力（render / scheduleRender / flushRender / aggregateScan /
//   applyScanStatusToRow / rebuildGroupChars）**由 view 在装配时注入**，
//   这样 load 不会反向依赖 render —— 否则 load ↔ render 就是环。
//
// 状态写入：原先散在本段的 18 处 entry 字段写入（status / models / error / source /
//   promise / pendingCatalogRetry）全部改走 store 动作（setRootStatus / setRootModels），
//   本文件不再直接改写 state.loaded 里的对象 —— 这是"只剩 store 改状态"的最后一块。

import {
  createScanMonitor, mergeScanBaseline, readNdjsonStream, scanStreamUrl,
  shouldDeferCatalogFailure,
} from './scan-stream.js';
import { loadRootModels, loadRootNames, mergeNameTable } from './list.js';
// 展开态/选中态的持久化（loadGroup 末尾要落盘，与原实现同一处、同一时机）
import { saveState } from './persist.js';
import { formatError } from '../infra/api.js';
// 名册就绪那句 info 走项目统一的日志通道（与 catalog/bundle 那些 diag 同一出口）
import { stageLog } from '../app/status.js';

/**
 * @param {object} deps 全部由 view 注入（本文件不 import 任何上层模块）
 * @param {object} deps.store      名册 store（唯一状态持有者；读写一律走它的动作）
 * @param {{render:number, ensureRootLoaded:number, renderScheduled:number}} deps.counters
 *        调试计数器对象（与 view 共用**同一个引用**，只做 ++）
 * @param {Map} deps.nameIndex     名表索引（跨根共用一份）
 * @param {Set} deps.namesLoaded   已取过名表的根（防重复取）
 * @param {Map} deps.modelById     modelId → { model, rootId }（名册持有的权威对象来源）
 * @param {() => void} deps.render          立即整棵重绘
 * @param {() => void} deps.scheduleRender  合并到下一帧重绘
 * @param {() => void} deps.flushRender     强制落地待渲染请求
 * @param {(group: object) => void} deps.rebuildGroupChars        重新跨根归并角色
 * @param {(group: object) => object|null} deps.aggregateScan     把该游戏各根的扫描聚合成一个状态
 * @param {(group: object, snap: object) => void} deps.applyScanStatusToRow 就地贴扫描状态
 */
export function createRosterLoad({
  store, counters, nameIndex, namesLoaded, modelById,
  render, scheduleRender, flushRender, rebuildGroupChars, aggregateScan, applyScanStatusToRow,
}) {
  const state = store.state;

  // ------------------------------------------------------------ 名册加载计时（A）
  //
  // 口径（写清是为了以后不要"人均一套秒表"）：
  //   · 起点 = 第一次调用 ensureRootLoaded（第一个根开始取 catalog）
  //   · 终点 = **所有已知根都 settle**（ready 与 error 都算 settle）
  //     为什么把 error 也算：不然一个根失败会让总时长永远不结束，这个数就永远出不来。
  //   · 计时一律 performance.now()（单调），不用 Date.now()（会被系统时间校准拉走）。
  //   · 不做阈值判断、不认根名：这里只报事实。
  let rosterT0 = null;
  /** rootId → { rootId, ms, count, source, at, error? }（同一根只留最新一次） */
  const rosterPerRoot = new Map();
  /** 「名册就绪」只打一次：之后再有根被补加载（懒加载/搜索）不再重复刷屏 */
  let rosterLogged = false;

  /** 记一个根的加载结果；若此刻所有已知根都已 settle，打一条 info 日志并定稿 */
  function recordRootLoad(rootId, t0, count, source, error) {
    rosterPerRoot.set(String(rootId), {
      rootId: String(rootId),
      ms: Math.round(performance.now() - t0),
      count: Number(count) || 0,
      source: error ? 'error' : (source || 'built'),
      at: Date.now(),
      ...(error ? { error: String(error) } : {}),
    });
    if (rosterLogged) return;
    const all = state.groups.flatMap((g) => g.roots.map((r) => String(r.id)));
    if (!all.length || !all.every((id) => rosterPerRoot.has(id))) return;
    rosterLogged = true;
    // 延后一拍再取数：根 settle 的那一刻，调用方（ensureGroupLoaded）的
    //   「跨根归并角色」还没跑（它在 await 之后才执行），此刻取 chars 会偏小，
    //   导致日志里的角色数与 rosterStats() 对不上。放到宏任务里取，归并已完成。
    setTimeout(() => {
      const s = rosterStats();
      // 走既有 say/log 通道（与 catalog/bundle 那些 diag 同一出口），文案里不带路径与根名
      stageLog('info', `名册就绪：${s.roots} 根 / ${s.chars} 角色 / ${s.ms} ms`, {
        tag: 'roster', roots: s.roots, entries: s.entries, chars: s.chars, ms: s.ms,
        slowest: s.perRoot.slice().sort((a, b) => b.ms - a.ms).slice(0, 3),
      });
    }, 0);
  }

  /**
   * 名册加载统计快照（`window.__WEB__.rosterStats()` 的实现在这里）。
   *
   * 主要用途是**看哪一根慢/失败**：perRoot 按实际加载顺序给出每根的耗时与来源，
   *   `source` 的 cache/built 来自服务端 `/api/catalog` 的自报（前端拿不到这个证据），
   *   失败根为 `error` 并带 `error` 文本 —— 失败绝不从表里消失。
   * @returns {{at: number|null, ms: number, roots: number, entries: number, chars: number,
   *            perRoot: Array<{rootId: string, ms: number, count: number, source: string, at: number, error?: string}>}}
   */
  function rosterStats() {
    const perRoot = [...rosterPerRoot.values()].map((r) => ({ ...r }));
    let chars = 0;
    for (const v of state.groupChars.values()) chars += Array.isArray(v && v.chars) ? v.chars.length : 0;
    // 汇总只算**名册自己的根**：perRoot 允许出现额外条目（别的调用方加载过某个根），
    //   但那不属于"名册加载"，算进来会让 roots/entries 与左栏数字对不上。
    const named = new Set(state.groups.flatMap((g) => g.roots.map((r) => String(r.id))));
    const mine = perRoot.filter((r) => named.has(r.rootId));
    return {
      at: mine.length ? Math.max(...mine.map((r) => r.at)) : null,
      // 全部根还没 settle 时给"到目前为止"的耗时：仍是有意义的读数，不是假值
      ms: rosterT0 === null ? 0 : Math.round(performance.now() - rosterT0),
      roots: named.size,
      entries: mine.reduce((s, r) => s + r.count, 0),
      chars,
      perRoot,
    };
  }

  // ------------------------------------------------------------ 数据加载

  /** 上一次写进调试日志的"剩余待探"数（只用来去重：数值没变就不再记一行） */
  let lastLoggedProbeRemaining = null;

  /**
   * 记录后台形态探测的进度：写进 state.probe（**给将来 UI 读**），并在数值变化时记一行日志。
   *
   * 为什么只在变化时记：一次启动会按根拉九次 catalog，每根都记一行会把调试面板刷满同类信息；
   *   真正有用的是"剩余数发生变化"这个事件。
   * 为什么不做 UI：本轮只要求可见性 + 数据面预留，展示位留待后续。
   * @param {string} rootId 本次刷新它的根（值是全局队列深度，与根无关，只作溯源）
   * @param {number|null} remaining 服务端 probeRemaining 原值；null = 老服务端没该字段
   */
  function noteProbeProgress(rootId, remaining) {
    if (!Number.isFinite(remaining)) return;      // 没这个字段 ⇒ 不更新、不记录（不把未知当 0）
    store.setProbe({ remaining: Number(remaining), at: Date.now(), rootId });
    if (remaining === lastLoggedProbeRemaining) return;
    lastLoggedProbeRemaining = remaining;
    stageLog('info', `后台形态探测：还剩 ${remaining} 个容器待探（UI 未实现，数据已挂 state.probe）`, {
      root: rootId, remaining,
    });
  }

  /**
   * 显式加载一个游戏（用户点「未加载 · 点击加载」/「加载失败 · 重试」/ 展开该行时调用）。
   *
   * 只动这个游戏自己的根：不碰其它游戏，也不做任何预取 —— 这是"页面加载不扇出"的关键落点。
   * @param {string} groupKey
   * @param {{reset?: boolean}} [opts] reset=true 时先清掉该游戏各根的加载状态与扫描去重标记（重试用）
   */
  async function loadGroup(groupKey, opts = {}) {
    const group = state.groups.find((g) => g.key === groupKey);
    if (!group) return;
    if (opts.reset) {
      for (const root of group.roots) {
        const cur = store.getScan(root.id);
        if (cur && cur.controller) { try { cur.controller.abort(); } catch { /* 已结束 */ } }
        store.resetRoots([root.id]);
        store.clearScan(root.id);
        store.unmarkRootSubscribed(root.id);
      }
      store.clearScanBaseline(group.key);
    }
    store.expandGroup(group.key);
    render();
    try { await ensureGroupLoaded(group); } catch { /* 失败由 error 状态与行上的「重试」承载 */ }
    render();
    saveState(state);
  }

  /**
   * 扫描完成（done / cached 帧）之后补取一次清单。
   *
   * 为什么由完成帧驱动而不是定时器：扫描完成后清单已落盘，此时取一次是毫秒级；
   *   用固定等待猜时机既慢又不准。只补一次，仍失败就落到 error，由行上的「加载失败 · 重试」按钮重来。
   * @param {object} root
   */
  async function refetchCatalog(root) {
    const entry = store.getRoot(root.id);
    if (!entry) return;
    // 三字段一起写：清掉待补标记、回到 loading、清掉上一次的错误文案
    store.setRootStatus(root.id, { pendingCatalogRetry: false, status: 'loading', error: null });
    scheduleRender();
    try {
      const { models, source, serverSource, probeRemaining } = await loadRootModels(root);
      for (const m of models) modelById.set(m.id, { model: m, rootId: root.id });
      // models + source + status='ready' 一次写成（loadRootModels 的 source 恒为 'catalog'）；
      //   角色树归并由 setRootModels 内部自动完成（唯一写入入口，见 store.js 的注释）
      store.setRootModels(root.id, models, { source });
      noteProbeProgress(root.id, probeRemaining);
      recordRootLoad(root.id, performance.now(), models.length, serverSource || 'built', null);
    } catch (err) {
      store.setRootStatus(root.id, { status: 'error', error: formatError(err) });
    }
    scheduleRender();
  }

  /**
   * 首次展开时用 `stream=1` 订阅扫描进度（NDJSON 帧）。
   *
   * 为什么先流后 JSON：首次扫描（缓存未命中）要几十秒，这段时间原来只有"加载中…"；
   *   先订阅流拿到 progress，扫描结束后再走原来的 `/api/catalog`（那时已落盘、命中缓存很快）。
   * 失败一律**不阻断**名册：进度是增强，读不到就照旧等 JSON（只是看不到数字）。
   *
   * @param {object} root
   * @returns {Promise<void>} 流结束（done/cached/error/网络失败）后 resolve —— 永不 reject
   */
  function trackScanProgress(root) {
    const url = scanStreamUrl(root);
    if (!url || store.hasRootSubscribed(root.id)) return Promise.resolve();
    store.markRootSubscribed(root.id);
    const group = store.groupOfRoot(root.id);
    const monitor = createScanMonitor({
      // 阈值来源：服务端 /api/web-config 下发（可选），缺省用 shared 里的常量——不在这里写死数字
      stallMs: (window.__WEB_CONFIG__ && window.__WEB_CONFIG__.scanStallMs) || undefined,
      // 每次变化都用"该游戏的聚合状态"刷新状态行（多根并行时不能互相覆盖）
      onChange: () => applyScanStatusToRow(group, aggregateScan(group)),
    });
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    store.updateScan(root.id, { monitor, controller, group });
    monitor.begin();
    const done = (async () => {
      try {
        const res = await fetch(url, {
          headers: { accept: 'application/x-ndjson' },
          signal: controller ? controller.signal : undefined,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await readNdjsonStream(res, (frame) => monitor.frame(frame));
        monitor.end();     // 流结束但没有完成帧 ⇒ 判失败（不假装完成）
      } catch (error) {
        if (controller && controller.signal.aborted) return;   // 主动关流（重试/换游戏）不算失败
        monitor.fail((error && error.message) || String(error));
      }
    })();
    return done.finally(() => {
      const finalState = monitor.state;
      const cur = store.getScan(root.id);
      if (cur && cur.monitor === monitor) store.clearScan(root.id);
      // 这一根结束了：把它的计数并入"已完成基线"，否则下一个根从 0 开始会让总数倒退
      if (group && (finalState.phase === 'loaded' || finalState.phase === 'failed')) {
        store.setScanBaseline(group.key, mergeScanBaseline(store.getScanBaseline(group.key), finalState));
      }
      applyScanStatusToRow(group, aggregateScan(group) || { phase: 'loaded' });   // 其它根还在扫就继续显示它们
      // 扫描完成 ⇒ 若这根的清单请求当初没回来，现在补取一次（只补一次）
      if (finalState.phase === 'loaded') {
        const entry = store.getRoot(root.id);
        if (entry && entry.pendingCatalogRetry) refetchCatalog(root);
      }
      scheduleRender();                            // 紧接着渲染一次，把正常计数补回去
    });
  }

  /** 重试：关掉当前流 → 重新以 stream=1 订阅（服务端单飞，不会重复扫描） */
  function retryScan(groupKey) {
    const group = state.groups.find((g) => g.key === groupKey);
    if (!group) return;
    store.clearScanBaseline(group.key);   // 新一轮：基线清零（否则重试后数字会叠加上一轮）
    for (const root of group.roots) {
      const cur = store.getScan(root.id);
      if (cur && cur.controller) { try { cur.controller.abort(); } catch { /* 已结束 */ } }
      store.clearScan(root.id);
      store.unmarkRootSubscribed(root.id);   // 允许重新订阅
    }
    const targets = group.roots.filter((r) => scanStreamUrl(r));
    if (!targets.length) return;
    Promise.all(targets.map((root) => trackScanProgress(root)))
      // 进度流跑完（成功或失败）后，若该根还没数据就顺手补一次正常加载
      .then(() => {
        const needLoad = group.roots.filter((r) => {
          const e = store.getRoot(r.id);
          return !e || e.status === 'idle' || e.status === 'error';
        });
        return Promise.all(needLoad.map((r) => ensureRootLoaded(r)));
      })
      .then(() => { rebuildGroupChars(group); scheduleRender(); })
      .catch(() => { /* 重试失败不影响名册本身 */ });
  }

  /**
   * 确保某个资源根的模型已加载。
   * 并发要点：正在加载中的根必须**可等待**（entry.promise），否则后到的调用方会拿到空数据
   *   ——启动恢复与"恢复展开态"的加载会并发进来，这一点决定恢复能否命中。
   * @param {object} root
   * @returns {Promise<object>} 该根的加载状态条目（ready / error）
   */
  function ensureRootLoaded(root) {
    counters.ensureRootLoaded += 1;
    // 名册计时：从**第一次**请求某根开始，到"所有已知根都 settle"结束。
    //   为什么用 performance.now()：单调时钟，系统时间校准不会把耗时拉成负数。
    if (rosterT0 === null) rosterT0 = performance.now();
    const cur = store.getRoot(root.id);
    if (cur && cur.promise) return cur.promise.then(() => store.getRoot(root.id));
    if (cur && cur.status === 'ready') return Promise.resolve(cur);
    // 起始态一次写全：status/models/source/error/promise 都经 store 落地
    store.setRootStatus(root.id, {
      status: 'loading', models: [], source: '', error: null, promise: null,
    });
    const rootT0 = performance.now();
    const promise = (async () => {
      try {
        // 名表按根取一次并合并进全局索引（同名表只并一次，避免重复 assign）
        if (!namesLoaded.has(root.id)) {
          namesLoaded.add(root.id);
          const table = await loadRootNames(root.id);
          if (table) mergeNameTable(nameIndex, table);
        }
        // 进度流**并行**订阅（不阻塞取清单）：
        //   服务端扫描有单飞，catalog 自己也会触发/加入同一次扫描；先 await 流会把首屏拖慢一整轮扫描，
        //   而进度只是"看得见"，不该成为加载的前置条件。失败也不阻断（trackScanProgress 自身不 reject）。
        trackScanProgress(root);
        const { models, source, serverSource, probeRemaining } = await loadRootModels(root);
        for (const m of models) {
          // 名册持有的就是这个对象本身（buildChars 的 variants[].model 也是它），
          //   所以"写回三字段"必须落在这里 —— 只改 DOM 的话，下一次 render 读的还是旧对象，
          //   表现为"当场变了色、一切换/搜索就掉回中性色"。
          modelById.set(m.id, { model: m, rootId: root.id });
        }
        // 就绪：models + source + status='ready' 一次写成
        store.setRootModels(root.id, models, { source });
        // 探测进度：顺带记进 state.probe 与调试日志（只在数值变化时记一行，避免刷屏）
        noteProbeProgress(root.id, probeRemaining);
        recordRootLoad(root.id, rootT0, models.length, serverSource || 'built', null);
      } catch (err) {
        // 扫描流仍在推进 ⇒ 暂缓判死：保持 loading，等完成帧后自动补取一次清单
        //   （服务端扫描有单飞，done 之后清单已落盘，取一次是毫秒级）
        const liveScan = store.getScan(root.id);
        const livePhase = liveScan && liveScan.monitor.state.phase;
        let entryError = null;
        if (shouldDeferCatalogFailure(livePhase)) {
          store.setRootStatus(root.id, { status: 'loading', error: null, pendingCatalogRetry: true });
          stageLog('info', `清单请求未回来（扫描仍在进行，完成后自动补取）：${root.id}`, { source: 'roster' });
        } else {
          entryError = formatError(err);
          store.setRootStatus(root.id, { status: 'error', error: entryError });
        }
        // 失败也要进 perRoot（source:'error'）：否则"某个根挂了"在计时里凭空消失，
        //   总耗时看起来还挺快 —— 那正是这个功能最该暴露的情形。
        recordRootLoad(root.id, rootT0, 0, 'error', entryError);
      }
      store.setRootStatus(root.id, { promise: null });
      scheduleRender();          // 加载完成：合并到下一帧（不再每个根各渲一次）
    })();
    store.setRootStatus(root.id, { promise });
    scheduleRender();            // 开始加载：同上（视觉上只是把游戏行标成 loading）
    return promise.then(() => store.getRoot(root.id));
  }

  /**
   * 确保某游戏的模型已加载：先等在飞的根加载完，再补齐未开始的根，最后跨根归并。
   * @param {object} group
   */
  async function ensureGroupLoaded(group) {
    const entries = group.roots.map((r) => store.getRoot(r.id));
    const inflight = entries.filter((e) => e && e.promise).map((e) => e.promise);
    if (inflight.length) await Promise.all(inflight);
    const pending = group.roots.filter((r) => {
      const e = store.getRoot(r.id);
      return !e || e.status === 'idle' || e.status === 'error';
    });
    if (pending.length) await Promise.all(pending.map((r) => ensureRootLoaded(r)));
    rebuildGroupChars(group);
    scheduleRender();
  }

  /** 搜索需要全局数据：首次输入关键词时把所有游戏补加载（并行，服务端有缓存） */
  async function ensureAllLoaded() {
    await Promise.all(state.groups.map((g) => ensureGroupLoaded(g)));
    // 硬约束①：所有加载完成后**一定**有一次渲染，不依赖 rAF 是否被节流
    flushRender();
  }

  return {
    loadGroup, refetchCatalog, trackScanProgress, retryScan,
    ensureRootLoaded, ensureGroupLoaded, ensureAllLoaded,
    /** 名册加载计时快照（`window.__WEB__.rosterStats()` 用它；口径见本文件"名册加载计时"注释） */
    rosterStats,
  };
}
