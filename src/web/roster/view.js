// roster-view.js —— 名册视图层：三级树（游戏 → 角色 → 变体）+ 搜索 + 选中态（M2）
//
// 做什么：
//   1. 一级：按资源根配置的 name 合并成游戏节点（同名根合并）；展开该游戏时才请求其各根模型；
//   2. 二级：角色跨根归并——同一角色在多个根下的模型归到一个角色节点（不是把各根的行拼起来）；
//   3. 三级：变体（模型）。行上带类型标签（Spine / Live2D / 资源包）与来源根 id；
//   4. 搜索：前端过滤（角色名 / 服装名 / 资源名 / 目录名），命中即自动展开到变体层；
//   5. 选中态：点变体行高亮并记录（M4 渲染用），状态写 localStorage（键名/结构沿用既有）；
//   6. 顶部「收起」只清空展开状态，面板本身保留（面板显隐由顶栏「模型库」按钮控制）。
//
// 状态全部收在 state 里，DOM 只是投影：这样"点一下到底改了什么"可以直接读 state 验证。

import { createReveal } from './reveal.js';
import {
  aggregateScanSnapshots, createScanMonitor, formatScanStatus, mergeScanBaseline,
  readNdjsonStream, resolveGamePhase, scanNeedsRetry, scanStreamUrl, shouldDeferCatalogFailure,
} from './scan-stream.js';
import { visibleChars } from './filter.js';
import { deriveTypeCounts, filterCharsByType, typeKeyOf, usableTypeSelection } from './type-filter.js';
import { typeLabel } from '../../shared/type-labels.mjs';
import { snapshotRoster } from './snapshot.js';
import { createRosterStore } from './store.js';
import { readSaved, saveState, readLastModel, saveLastModel } from './persist.js';
import {
  createNameIndex, mergeNameTable, loadRootModels, loadRootNames, buildChars,
} from './list.js';
import { el, renderGameRow, renderCharRow, renderVariantRow, applyEntryState } from './rows.js';
import { formatError } from '../infra/api.js';
// 名册就绪那句 info 走项目统一的日志通道（与 catalog/bundle 那些 diag 同一出口）
import { stageLog } from '../app/status.js';
// 渲染调度（rAF 合批 + 后台标签页兜底）抽到公共层，行为与原先内联实现一致
import { createScheduler } from '../infra/schedule.js';
// 容器条目的装载失败记忆：渲染时读出注入行渲染（保持 rows.js 的"纯 DOM 工厂"性质）

/** localStorage 键名：不得改名（M7 要用它做持久化，改名会让用户既有状态失效） */

/** 渲染上限：每个游戏最多渲染多少角色行（避免 2000+ 角色一次铺满）。
 *  默认值只是兜底，可用 window.__WEB_CONFIG__.renderLimitPerGame 覆盖 */
const RENDER_LIMIT_DEFAULT = 400;
function renderLimitPerGame() {
  const custom = Number(window.__WEB_CONFIG__ && window.__WEB_CONFIG__.renderLimitPerGame);
  return Number.isFinite(custom) && custom > 0 ? custom : RENDER_LIMIT_DEFAULT;
}

/**
 * 名册状态：games 是按 name 合并后的游戏列表；loaded 按资源根缓存加载结果；
 * gameChars 按游戏缓存跨根归并后的角色；expandedGames/expandedChars 是两级展开键；
 * keyword 是搜索词；selected 是当前选中变体；activeGame 是最后活跃的游戏名。
 */

/** 创建名册视图并挂到容器上；返回对外 API（供 main.js 与自动化验证使用） */
export function createRosterView({ listEl, countEl, searchEl, collapseBtn, onSelect }) {
  // 类型胶囊行：容器由 index.html 提供（#roster-type-filter），这里只取引用；
  //   取不到（旧页面/单测）就整体降级为"没有类型筛选"，不影响名册其余功能。
  const typeFilterEl = typeof document !== 'undefined' ? document.getElementById('roster-type-filter') : null;
  // 定位控制器：把"选中后滚到可见"的策略外置（见 roster/reveal.js）
  /**
   * 调试计数器（**纯计量**，只做 ++，不影响任何调度与渲染结果）。
   * 用途：首屏渲染次数是"每个根各触发一次全树 render"这个性能问题的直接指标，
   *   优化前后必须用同一口径对比（见 __WEB__ 侧的 counters() 取数）。
   */
  const counters = { render: 0, ensureRootLoaded: 0, renderScheduled: 0 };

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
    const all = state.games.flatMap((g) => g.roots.map((r) => String(r.id)));
    if (!all.length || !all.every((id) => rosterPerRoot.has(id))) return;
    rosterLogged = true;
    // 延后一拍再取数：根 settle 的那一刻，调用方（ensureGameLoaded）的
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
    for (const v of state.gameChars.values()) chars += Array.isArray(v && v.chars) ? v.chars.length : 0;
    // 汇总只算**名册自己的根**：perRoot 允许出现额外条目（别的调用方加载过某个根），
    //   但那不属于"名册加载"，算进来会让 roots/entries 与左栏数字对不上。
    const named = new Set(state.games.flatMap((g) => g.roots.map((r) => String(r.id))));
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

  // ------------------------------------------------------------ 渲染调度（rAF 合并）
  // 加载阶段每条路径都会触发一次全树重绘（N 个资源根 ≈ 2N+ 次），中间态在同一帧里根本看不到；
  //   合批后既省时间也减少闪烁。三条性质与"为什么"见 infra/schedule.js 的文件头。
  // 这里只保留两样名册专属的东西：跑什么（render）与计量钩子（renderScheduled）。
  const scheduler = createScheduler(() => render(), { onRequest: () => { counters.renderScheduled += 1; } });
  const scheduleRender = scheduler.request;
  const flushRender = scheduler.flush;

  // 名册状态由 store 统一持有（**唯一可写者**）；view 只读 state、通过动作改。
  //   activeGame / probe / scannedRoots 是**视图自身展示态**（不属于名册数据），仍挂在这里。
  const store = createRosterStore({ buildChars, onChange: () => scheduleRender() });
  const state = store.state;
  state.activeGame = null;
  /** 本页生命周期内已经跑过进度流的根（避免每次展开/重渲染都重新订阅） */
  state.scannedRoots = new Set();
  /**
   * 后台形态探测的进度快照（**本次不做 UI，数据先就绪**）。
   *
   * 将来要加面板/进度条时，**直接读这里，不用再改服务端**：
   *   state.probe = { remaining, at, rootId }
   *     remaining 剩余待探条目数（服务端 probeRemaining 原值；null = 老服务端没这字段）
   *     at        这次取到它的时间戳（性能无关，只用于判断"多久没更新了"）
   *     rootId    最近一次刷新它的资源根（每列一个根都会刷新，值是**全局**队列深度）
   * 读法示例：`window.__WEB__.state.roster.state.probe.remaining`
   * 更细的计数（runs/probed/unsupported/unknown/skipped/lastBatchMs/lastTrigger）
   *   走 `GET /api/entries/probe`，那才是权威，这里只是"最近一次 catalog 响应顺带回来的"。
   */
  state.probe = { remaining: null, at: null, rootId: null };

  const reveal = createReveal({ listEl, getState: () => state, render: () => render() });

  const nameIndex = createNameIndex();
  const namesLoaded = new Set();
  const modelById = new Map();

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
    state.probe = { remaining: Number(remaining), at: Date.now(), rootId };
    if (remaining === lastLoggedProbeRemaining) return;
    lastLoggedProbeRemaining = remaining;
    stageLog('info', `后台形态探测：还剩 ${remaining} 个容器待探（UI 未实现，数据已挂 state.probe）`, {
      root: rootId, remaining,
    });
  }

  /**
   * 确保某个资源根的模型已加载。
   * 并发要点：正在加载中的根必须**可等待**（entry.promise），否则后到的调用方会拿到空数据
   *   ——启动恢复与"恢复展开态"的加载会并发进来，这一点决定恢复能否命中。
   * @param {object} root
   * @returns {Promise<object>} 该根的加载状态条目（ready / error）
   */
  /**
   * 显式加载一个游戏（用户点「未加载 · 点击加载」/「加载失败 · 重试」/ 展开该行时调用）。
   *
   * 只动这个游戏自己的根：不碰其它游戏，也不做任何预取 —— 这是"页面加载不扇出"的关键落点。
   * @param {string} gameKey
   * @param {{reset?: boolean}} [opts] reset=true 时先清掉该游戏各根的加载状态与扫描去重标记（重试用）
   */
  async function loadGame(gameKey, opts = {}) {
    const game = state.games.find((g) => g.key === gameKey);
    if (!game) return;
    if (opts.reset) {
      for (const root of game.roots) {
        const cur = store.getScan(root.id);
        if (cur && cur.controller) { try { cur.controller.abort(); } catch { /* 已结束 */ } }
        store.resetRoots([root.id]);
        store.clearScan(root.id);
        state.scannedRoots.delete(root.id);
      }
      store.clearScanBaseline(game.key);
    }
    store.expandGame(game.key);
    render();
    try { await ensureGameLoaded(game); } catch { /* 失败由 error 状态与行上的「重试」承载 */ }
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
    const entry = state.loaded.get(root.id);
    if (!entry) return;
    entry.pendingCatalogRetry = false;
    entry.status = 'loading';
    entry.error = null;
    scheduleRender();
    try {
      const { models, source, serverSource, probeRemaining } = await loadRootModels(root);
      for (const m of models) modelById.set(m.id, { model: m, rootId: root.id });
      entry.status = 'ready';
      entry.models = models;
      entry.source = source;
      noteProbeProgress(root.id, probeRemaining);
      recordRootLoad(root.id, performance.now(), models.length, serverSource || 'built', null);
      const game = gameOfRoot(root);
      if (game) rebuildGameChars(game);
    } catch (err) {
      entry.status = 'error';
      entry.error = formatError(err);
    }
    scheduleRender();
  }

  /** 某根属于哪个游戏（状态行按游戏显示，扫描按根进行） */
  function gameOfRoot(root) {
    return state.games.find((g) => g.roots.some((r) => r.id === root.id)) || null;
  }

  /** 找到该游戏当前的游戏行（渲染是整棵重建的，所以每次都要重新查，不能缓存节点） */
  function gameRowOf(game) {
    if (!game) return null;
    return [...listEl.querySelectorAll('[data-game-key].tree-game')]
      .find((row) => row.dataset.gameKey === game.key) || null;
  }

  /**
   * 把扫描状态贴到游戏行的状态位上（**就地改文本**，不整棵重渲染）。
   * 为什么不重渲染：一次扫描会发几十帧，每帧重建 400+ 行会把主线程占死 —— 而状态行就是一行文本。
   * @param {object|null} game
   * @param {object} snap createScanMonitor().state
   */
  /**
   * 把一个游戏下**所有正在扫描的根**聚合成一个状态（含"已完成根"的计数基线）。
   * 具体口径在 scan-stream.js:aggregateScanSnapshots（纯函数，有单测）；
   *   这里只负责把视图里活跃的 monitor 与基线凑起来。
   * @param {object|null} game
   * @returns {object|null} null = 该游戏当前没有扫描在进行
   */
  function aggregateScan(game) {
    if (!game) return null;
    const snaps = [];
    for (const [rootId, cur] of state.scan) {
      if (game.roots.some((r) => r.id === rootId)) snaps.push(cur.monitor.state);
    }
    return aggregateScanSnapshots(snaps, state.scanBaseline.get(game.key) || null);
  }

  function applyScanStatusToRow(game, snap) {
    const row = gameRowOf(game);
    if (!row) return;
    let slot = row.querySelector('.tree-count');
    if (!slot) {
      slot = el('span', 'tree-count', '');
      row.append(slot);
    }
    const text = formatScanStatus(snap);
    if (text) {
      slot.textContent = text;
      slot.classList.add('is-scanning');
      slot.title = snap.currentPath ? `当前：${snap.currentPath}` : '';
    } else if (slot.classList.contains('is-scanning')) {
      // 扫描结束（loaded/idle）⇒ 把进度文案收拾掉；正常计数由下一次 render 补上
      slot.textContent = '';
      slot.classList.remove('is-scanning');
      slot.title = '';
    }
    // 〔重试〕：只在 stalled/failed 出现；点击由 listEl 上的委托统一处理（见 bindEvents）
    let retry = row.querySelector('[data-scan-retry]');
    if (scanNeedsRetry(snap)) {
      if (!retry) {
        retry = el('button', 'tree-scan-retry', '重试');
        retry.type = 'button';
        retry.dataset.scanRetry = game.key;
        retry.title = '重新订阅扫描进度（服务端有单飞，不会重复扫描）';
        row.append(retry);
      }
    } else if (retry) {
      retry.remove();
    }
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
    if (!url || state.scannedRoots.has(root.id)) return Promise.resolve();
    state.scannedRoots.add(root.id);
    const game = gameOfRoot(root);
    const monitor = createScanMonitor({
      // 阈值来源：服务端 /api/web-config 下发（可选），缺省用 shared 里的常量——不在这里写死数字
      stallMs: (window.__WEB_CONFIG__ && window.__WEB_CONFIG__.scanStallMs) || undefined,
      // 每次变化都用"该游戏的聚合状态"刷新状态行（多根并行时不能互相覆盖）
      onChange: () => applyScanStatusToRow(game, aggregateScan(game)),
    });
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    store.updateScan(root.id, { monitor, controller, game });
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
      if (game && (finalState.phase === 'loaded' || finalState.phase === 'failed')) {
        store.setScanBaseline(game.key, mergeScanBaseline(store.getScanBaseline(game.key), finalState));
      }
      applyScanStatusToRow(game, aggregateScan(game) || { phase: 'loaded' });   // 其它根还在扫就继续显示它们
      // 扫描完成 ⇒ 若这根的清单请求当初没回来，现在补取一次（只补一次）
      if (finalState.phase === 'loaded') {
        const entry = store.getRoot(root.id);
        if (entry && entry.pendingCatalogRetry) refetchCatalog(root);
      }
      scheduleRender();                            // 紧接着渲染一次，把正常计数补回去
    });
  }

  /** 重试：关掉当前流 → 重新以 stream=1 订阅（服务端单飞，不会重复扫描） */
  function retryScan(gameKey) {
    const game = state.games.find((g) => g.key === gameKey);
    if (!game) return;
    store.clearScanBaseline(game.key);   // 新一轮：基线清零（否则重试后数字会叠加上一轮）
    for (const root of game.roots) {
      const cur = store.getScan(root.id);
      if (cur && cur.controller) { try { cur.controller.abort(); } catch { /* 已结束 */ } }
      store.clearScan(root.id);
      state.scannedRoots.delete(root.id);   // 允许重新订阅
    }
    const targets = game.roots.filter((r) => scanStreamUrl(r));
    if (!targets.length) return;
    Promise.all(targets.map((root) => trackScanProgress(root)))
      // 进度流跑完（成功或失败）后，若该根还没数据就顺手补一次正常加载
      .then(() => {
        const needLoad = game.roots.filter((r) => {
          const e = state.loaded.get(r.id);
          return !e || e.status === 'idle' || e.status === 'error';
        });
        return Promise.all(needLoad.map((r) => ensureRootLoaded(r)));
      })
      .then(() => { rebuildGameChars(game); scheduleRender(); })
      .catch(() => { /* 重试失败不影响名册本身 */ });
  }

  function ensureRootLoaded(root) {
    counters.ensureRootLoaded += 1;
    // 名册计时：从**第一次**请求某根开始，到"所有已知根都 settle"结束。
    //   为什么用 performance.now()：单调时钟，系统时间校准不会把耗时拉成负数。
    if (rosterT0 === null) rosterT0 = performance.now();
    const cur = state.loaded.get(root.id);
    if (cur && cur.promise) return cur.promise.then(() => cur);
    if (cur && cur.status === 'ready') return Promise.resolve(cur);
    const entry = { status: 'loading', models: [], source: '', error: null, promise: null };
    const rootT0 = performance.now();
    entry.promise = (async () => {
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
        entry.status = 'ready';
        entry.models = models;
        entry.source = source;
        // 探测进度：顺带记进 state.probe 与调试日志（只在数值变化时记一行，避免刷屏）
        noteProbeProgress(root.id, probeRemaining);
        recordRootLoad(root.id, rootT0, models.length, serverSource || 'built', null);
      } catch (err) {
        // 扫描流仍在推进 ⇒ 暂缓判死：保持 loading，等完成帧后自动补取一次清单
        //   （服务端扫描有单飞，done 之后清单已落盘，取一次是毫秒级）
        const liveScan = state.scan.get(root.id);
        if (shouldDeferCatalogFailure(liveScan && liveScan.monitor.state.phase)) {
          entry.status = 'loading';
          entry.error = null;
          entry.pendingCatalogRetry = true;
          stageLog('info', `清单请求未回来（扫描仍在进行，完成后自动补取）：${root.id}`, { source: 'roster' });
        } else {
          entry.status = 'error';
          entry.error = formatError(err);
        }
        // 失败也要进 perRoot（source:'error'）：否则"某个根挂了"在计时里凭空消失，
        //   总耗时看起来还挺快 —— 那正是这个功能最该暴露的情形。
        recordRootLoad(root.id, rootT0, 0, 'error', entry.error);
      }
      entry.promise = null;
      scheduleRender();          // 加载完成：合并到下一帧（不再每个根各渲一次）
    })();
    store.setRootStatus(root.id, entry);
    scheduleRender();            // 开始加载：同上（视觉上只是把游戏行标成 loading）
    return entry.promise.then(() => entry);
  }

  /** 某游戏的全部根是否都已就绪（有失败也算"可渲染"，错误在游戏节点下提示） */
  function gameStatus(game) {
    const entries = game.roots.map((r) => state.loaded.get(r.id));
    // 唯一判定：根加载状态 + 扫描聚合状态一起交给 resolveGamePhase（纯函数，有单测）。
    //   视图里不再有第二套推导 —— 那会让「扫描中」与「加载失败」同时出现。
    return resolveGamePhase({
      scan: aggregateScan(game),
      rootStates: entries.map((e) => (e && e.status ? e.status : 'idle')),
    });
  }

  /**
   * 重新归并某游戏的角色（跨根）：把该游戏所有已就绪根的模型并成一个数组再归并。
   * 为什么在游戏层归并：同一角色可能同时有 Live2D 与 Spine 变体（来自不同根），
   *   按根各自归并会得到两个同名角色节点，造成不一致。
   * @param {object} game
   */
  function rebuildGameChars(game) {
    // 归并逻辑收在 store（store.rebuildChars 与这里原来是同一份实现）
    store.rebuildChars(game.key, { nameIndex });
  }

  /**
   * 确保某游戏的模型已加载：先等在飞的根加载完，再补齐未开始的根，最后跨根归并。
   * @param {object} game
   */
  async function ensureGameLoaded(game) {
    const entries = game.roots.map((r) => state.loaded.get(r.id));
    const inflight = entries.filter((e) => e && e.promise).map((e) => e.promise);
    if (inflight.length) await Promise.all(inflight);
    const pending = game.roots.filter((r) => {
      const e = state.loaded.get(r.id);
      return !e || e.status === 'idle' || e.status === 'error';
    });
    if (pending.length) await Promise.all(pending.map((r) => ensureRootLoaded(r)));
    rebuildGameChars(game);
    scheduleRender();
  }

  /** 搜索需要全局数据：首次输入关键词时把所有游戏补加载（并行，服务端有缓存） */
  async function ensureAllLoaded() {
    await Promise.all(state.games.map((g) => ensureGameLoaded(g)));
    // 硬约束①：所有加载完成后**一定**有一次渲染，不依赖 rAF 是否被节流
    flushRender();
  }

  // ------------------------------------------------------------ 过滤

  /** 单条变体的可搜索文本（资源名 / 目录名 / 角色名 / 服装名） */
  // ------------------------------------------------------------ 渲染

  /**
   * 渲染类型胶囊行（搜索框下方那一行）。
   *
   * 为什么不复用工具栏按钮：胶囊要自动换行、要带计数、要表达 aria-pressed 的选中态，
   *   与 .mini-btn 的"单行操作按钮"定位不同；只复用它的视觉语言（描边+底色），类名单列。
   * @param {Array<{key: string, count: number}>} counts 类型与计数（已按数量降序）
   * @param {Set<string>} activeTypes 当前**生效**的选中集合（已剔除当前不存在的失效项）
   */
  function renderTypeFilter(counts, activeTypes) {
    if (!typeFilterEl) return;
    // 名册为空（一个类型都没有）⇒ 整行隐藏，不留一条空白（设计稿 §4.4）
    if (!counts.length) {
      typeFilterEl.hidden = true;
      typeFilterEl.replaceChildren();
      return;
    }
    typeFilterEl.hidden = false;
    const nodes = counts.map(({ key, count }) => {
      const chip = el('button', 'roster-type-chip', `${typeLabel(key)} ${count}`);
      chip.type = 'button';
      chip.dataset.typeKey = key;
      chip.setAttribute('aria-pressed', activeTypes.has(key) ? 'true' : 'false');
      chip.title = `只看 ${typeLabel(key)}（当前搜索下 ${count} 个变体）`;
      return chip;
    });
    // 「清除」只在至少选 1 个时出现；不提供「全部」按钮（全部 = 全部取消选中）
    if (activeTypes.size) {
      const clear = el('button', 'roster-type-clear', '清除');
      clear.type = 'button';
      clear.dataset.role = 'clear-type-filter';
      clear.setAttribute('aria-label', '清除类型筛选');
      clear.title = '清除类型筛选（等价于不筛选）';
      nodes.push(clear);
    }
    typeFilterEl.replaceChildren(...nodes);
  }

  /** 渲染整棵树（只渲染可见部分；展开的角色才生成变体行） */
  function render() {
    counters.render += 1;
    listEl.replaceChildren();

    // 首次渲染时插件指纹还没取到 ⇒ 这一帧不显示"不支持"标记（避免用过期结论误导），
    //   指纹就绪后再重画一次。之所以放在 render 里而不是 mount 里：mount 是同步函数。
    // 徽标颜色 / ⚠ / 文案全部来自条目自带的三字段（display/support/loadResult，契约 §一）：
    //   名册不再有"本地失败缓存"这一层，也就不需要指纹初始化与快照拉取。

    const searching = state.keyword.length > 0;
    let totalChars = 0;
    let totalVariants = 0;
    let rendered = 0;
    let loadedGames = 0;
    // 类型胶囊的计数口径 = **当前关键词下**的可见变体数（不含类型过滤本身的影响，见设计稿 §5.3）。
    //   所以先算 counts（只吃 keyword），再算 activeTypes，最后才把类型过滤作用到列表上。
    const typeCounts = deriveTypeCounts({ games: state.games, gameChars: state.gameChars, keyword: state.keyword });
    const activeTypes = usableTypeSelection([...state.typeFilter], typeCounts.map((entry) => entry.key));
    renderTypeFilter(typeCounts, activeTypes);
    // 被类型过滤挡掉的变体数 / 留下来的变体数：只用于"当前筛选下没有条目"的提示文案
    let hiddenByType = 0;
    let keptVariants = 0;

    for (const game of state.games) {
      const status = gameStatus(game);
      if (status === 'ready') loadedGames += 1;
      const charsByKeyword = visibleChars(game, state);
      const chars = filterCharsByType(charsByKeyword, activeTypes);
      if (activeTypes.size) {
        const visibleCount = charsByKeyword.reduce((n, c) => n + c.variants.length, 0);
        const keptCount = chars.reduce((n, c) => n + c.variants.length, 0);
        hiddenByType += visibleCount - keptCount;
        keptVariants += keptCount;
      }
      const open = state.expandedGames.has(game.key) || (searching && chars.length > 0);

      listEl.append(renderGameRow(game, {
        open: state.expandedGames.has(game.key),
        status,
        charCount: chars.length,
      }));
      if (!open) continue;

      if (status === 'loading') {
        listEl.append(el('p', 'muted-hint tree-hint', '加载中…'));
        continue;
      }
      if (status === 'error') {
        listEl.append(el('p', 'error-banner', `加载失败：${game.roots.map((r) => r.id).join(', ')}`));
        continue;
      }
      if (status === 'scanning' || status === 'stalled') {
        // 扫描还在推进：不显示"没有模型"这种结论，也不出失败横幅
        if (!chars.length) listEl.append(el('p', 'muted-hint tree-hint', '正在读取清单…'));
        continue;
      }
      if (status === 'idle') {
        // 恢复展开态但没加载（启动不预取）⇒ 明确告诉用户"要点一下"，而不是假装没有模型
        listEl.append(el('p', 'muted-hint tree-hint', '未加载 · 点这一行的「点击加载」'));
        continue;
      }

      totalChars += chars.length;
      const limit = renderLimitPerGame(); // 每次渲染读一次：改配置后刷新即生效
      const selectedId = state.selected ? state.selected.modelId : null;
      for (const c of chars) {
        if (rendered >= limit) break;
        rendered += 1;
        const charOpen = state.expandedChars.has(c.key) || searching;
        listEl.append(renderCharRow(game, c, charOpen));
        // 变体数按数据统计（不依赖是否展开），与「N 游戏 / M 角色 / K 变体」口径一致
        totalVariants += c.variants.length;
        if (!charOpen) continue;
        for (const v of c.variants) {
          // 行内的颜色 / ⚠ / 文案全部由条目自带的三字段渲染（display/support/loadResult），
          //   这里不再注入任何本地失败记录 —— 服务端是唯一权威（契约 §一）。
          listEl.append(renderVariantRow(game, c, v, selectedId));
        }
      }
      if (!chars.length) {
        listEl.append(el('p', 'muted-hint tree-hint', searching ? '无匹配' : '该游戏没有可加载模型'));
      }
    }

    // 类型筛选把所有条目都挡掉时给一句可读提示，不留空白（设计稿 §10.2 第 1 条）。
    //   不自动改用户的选择：解包完成后条目会从 unknown 跳到 spine/live2d，
    //   这里只如实说明"被挡掉了多少个"，让用户自己决定是否取消筛选。
    if (activeTypes.size && keptVariants === 0 && hiddenByType > 0) {
      listEl.prepend(el('p', 'muted-hint tree-hint', `当前筛选下没有条目（${hiddenByType} 个已移到其它类型）`));
    }

    // 计数文案：全量已加载时用统一口径（N 游戏 / M 角色 / K 变体），否则标注已加载多少
    const allLoaded = loadedGames === state.games.length;
    const prefix = allLoaded ? `${state.games.length} 游戏` : `${state.games.length} 游戏 / 已加载 ${loadedGames}`;
    countEl.textContent = searching
      ? `搜索「${state.keyword}」：${totalChars} 角色 / ${totalVariants} 变体`
      : `${prefix}：${totalChars} 角色 / ${totalVariants} 变体`;

    // 重建会把行换成新节点：仍在扫描的根要把状态行重新贴回去（否则一次别的渲染就把进度冲掉）
    for (const game of state.games) {
      const agg = aggregateScan(game);
      if (agg) { applyScanStatusToRow(game, agg); continue; }
      // 没有活跃扫描：这一轮结束（该游戏已 ready）⇒ 丢掉基线，免得下次展开时把旧数字算进去
      if (state.scanBaseline.has(game.key) && gameStatus(game) === 'ready') store.clearScanBaseline(game.key);
    }

    // 供自动化断言：把状态投影成可读快照
    document.documentElement.dataset.rosterReady = '1';
    document.documentElement.dataset.rosterSnapshot = JSON.stringify(snapshot());
  }

  /** 状态快照（自动化断言与排查用，避免每次都去数 DOM） */
  /** 快照：投影逻辑在 roster/snapshot.js（断言只读这份） */
  const snapshot = () => snapshotRoster({ state, listEl, gameStatus });

  // ------------------------------------------------------------ 事件

  /** 点一级：折叠/展开游戏（首次展开触发该游戏所有根的数据加载） */
  async function onGameClick(gameKey) {
    if (state.expandedGames.has(gameKey)) {
      store.toggleGame(gameKey);
      render();
      saveState(state);
      return;
    }
    store.expandGame(gameKey);
    // 先渲染一次：已加载过的游戏直接出角色行（ensureGameLoaded 在无待加载根时不会单独渲染）
    render();
    const game = state.games.find((g) => g.key === gameKey);
    if (game) await ensureGameLoaded(game);
    saveState(state);
  }

  /** 点二级：折叠/展开角色（变体已在内存，不发请求） */
  function onCharClick(charKey) {
    store.toggleChar(charKey);
    render();
    saveState(state);
  }

  /** 点三级：选中变体（高亮 + 记录状态，M4 用它去渲染） */
  function onVariantClick(modelId, gameKey, charKey) {
    const game = state.games.find((g) => g.key === gameKey);
    store.selectModel({ modelId, gameKey, gameName: game ? game.name : null, charKey });
    state.activeGame = game ? game.name : state.activeGame;
    // 记「上次所用模型」指针（rootId/kind/modelId）：下次冷启动只加载它所在的那一个根
    try { saveLastModel((modelById.get(modelId) || {}).model || null); } catch { /* 指针只是加速启动 */ }
    render();
    state.lastReveal = reveal.revealActive(); // 选中后把这一行滚到可视区（已可见/用户正在滚都会跳过）
    saveState(state);
    if (typeof onSelect === 'function') {
      const hit = modelById.get(modelId);
      onSelect(hit ? hit.model : null);
    }
  }

  /** 事件委托：树行是动态生成的，统一在容器上监听一次 */
  function bindEvents() {
    /** 按行的类型分派到对应动作（鼠标与键盘共用，避免两套逻辑走偏） */
    function activate(row) {
      if (row.dataset.modelId) {
        onVariantClick(row.dataset.modelId, row.dataset.gameKey, row.dataset.charKey);
      } else if (row.dataset.charKey) {
        onCharClick(row.dataset.charKey);
      } else if (row.dataset.gameKey) {
        onGameClick(row.dataset.gameKey);
      }
    }

    // 用户滚动信号由 reveal 控制器统一挂（滚轮 / 触摸 / 指针 / 滚动条）
    reveal.attachUserScrollListeners();

    listEl.addEventListener('click', (e) => {
      const row = e.target.closest('[data-model-id], [data-char-key], [data-game-key]');
      if (row) activate(row);
    });

    // 键盘可达：树行带 tabindex="0"，Enter / 空格与点击等价
    listEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('[data-model-id], [data-char-key], [data-game-key]');
      if (!row) return;
      e.preventDefault();
      activate(row);
    });

    // 类型胶囊：事件委托（胶囊每次重渲染都会换新节点，逐个绑定会漏）
    if (typeFilterEl) {
      typeFilterEl.addEventListener('click', (event) => {
        const button = event.target && event.target.closest ? event.target.closest('button') : null;
        if (!button || !typeFilterEl.contains(button)) return;
        if (button.dataset.role === 'clear-type-filter') {
          store.clearTypeFilter();
        } else {
          const typeKey = button.dataset.typeKey;
          if (!typeKey) return;
          store.toggleTypeFilter(typeKey);
        }
        // 不写 localStorage：筛选只在内存里生效（刷新后回到不筛选），
        //   否则旧的筛选会在下次启动时把上次所用的模型挡住。
        render();
      });
    }

    // 游戏行的「未加载 · 点击加载」/「加载失败 · 重试」：事件委托，且不能顺带折叠/展开这一行
    listEl.addEventListener('click', (event) => {
      const target = event.target && event.target.closest ? event.target.closest('[data-game-load], [data-game-retry]') : null;
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      loadGame(target.dataset.gameLoad || target.dataset.gameRetry, { reset: !!target.dataset.gameRetry });
    });

    // 扫描状态行上的〔重试〕：事件委托（行会被重建，逐个绑会漏）
    listEl.addEventListener('click', (event) => {
      const button = event.target && event.target.closest ? event.target.closest('[data-scan-retry]') : null;
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();     // 别让点重试顺带把游戏行折叠/展开
      retryScan(button.dataset.scanRetry);
    });

    searchEl.addEventListener('input', () => {
      store.setKeyword(searchEl.value);
      // 搜索要全局数据：首次输入时把所有游戏补上（之后都走缓存，不再请求）
      if (state.keyword && [...state.gameChars.keys()].length < state.games.length) {
        ensureAllLoaded();
      } else {
        render();
      }
    });

    // 「收起」：只清空两级展开状态，面板保留
    collapseBtn.addEventListener('click', () => {
      store.collapseAll();
      render();
      saveState(state);
    });
  }

  /**
   * 初始化：把资源根按 name 合并成游戏 → 渲染（不加载任何模型，等用户展开）
   * @param {object[]} roots /api/roots 的 roots
   * @param {{restoreExpanded?: boolean}} opts restoreExpanded=false 时不恢复任何展开态（自动恢复被关闭时用）
   */
  function mount(roots, opts) {
    const restoreExpanded = !opts || opts.restoreExpanded !== false;
    // 类型筛选不再持久化：每次打开都是不筛选（筛选是当次会话内的临时动作）
    store.setTypeFilter([]);
    // 同名根合并成游戏节点：合并规则收在 store.setRoots（与原来同一份实现）
    store.setRoots(roots);

    const saved = readSaved();
    if (restoreExpanded) {
      // 展开状态恢复：只恢复仍存在的游戏，避免历史配置残留导致空节点
      store.restoreExpanded({ games: saved.games, chars: saved.chars });
      state.activeGame = saved.activeGame;
    }

    bindEvents();
    render();
    // **不再**在启动时把"上次展开的游戏"全部加载：
    //   那等于页面一开就把所有资源根拉一遍（每个根一次全量扫描，串行排队 ⇒ 排在后面的必然超时）。
    //   恢复的展开态只保留"展开"这个视觉状态，数据等用户点这一行/点「加载」时再取。
    //   （启动唯一允许的主动加载在 restoreLast：只针对上次活跃的那**一个**游戏）
  }

  /** 从存档里取出"上次选中的变体 id"：优先按活跃游戏取，其次旧格式单个 id，最后取任一非空值 */
  function targetModelId(saved) {
    const byGame = saved.lastByGame || {};
    if (saved.activeGame && byGame[saved.activeGame]) return byGame[saved.activeGame];
    if (saved.lastModelId) return saved.lastModelId;
    const first = Object.values(byGame).find((v) => typeof v === 'string' && v);
    return first || null;
  }

  /** 在某游戏已加载的角色里找该变体，命中返回 { charKey, variant }（变体对象形如 { model, nm }） */
  function findVariant(game, modelId) {
    const entry = state.gameChars.get(game.key);
    if (!entry) return null;
    for (const c of entry.chars) {
      const v = c.variants.find((x) => x.model && x.model.id === modelId);
      if (v) return { charKey: c.key, variant: v };
    }
    return null;
  }

  /**
   * 把左栏树**从上到下**摊平成变体序列（翻页的池子就是它）。
   *
   * 为什么不让外部自己请求接口：树的"游戏"节点是**同名根合并**出来的
   *   （例如「碧蓝航线」= azurlane + azurlane_spine + azurlane_bundle 三个根），
   *   外部按单个 rootId 取清单会漏掉另外两个根 ⇒ 表现为"只能在 live2d 之间翻，翻不到 spine"。
   * 用树自己的数据结构（含合并、含排序）作唯一真相源，顺序天然与用户看到的一致。
   * @returns {Promise<Array<{model:object, gameKey:string, charKey:string}>>}
   */
  async function listVariants() {
    const out = [];
    for (const game of state.games) {
      if (state.expandedGames && !state.expandedGames.size) { /* 未展开也要能翻：下面统一加载 */ }
      // 目标游戏可能还没加载（用户没展开过）：按需加载一次，保证序列完整
      if (!state.gameChars.get(game.key)) {
        try { await ensureGameLoaded(game); } catch { continue; }
      }
      const entry = state.gameChars.get(game.key);
      if (!entry) continue;
      for (const c of entry.chars) {
        for (const v of c.variants) {
          if (v && v.model && v.model.id) out.push({ model: v.model, gameKey: game.key, charKey: c.key });
        }
      }
    }
    return out;
  }

  /**
   * 取某个变体的**兄弟变体**（同一角色/同一 charKey 下的全部变体）。
   * @param {string} modelId
   * @returns {Promise<Array<{model:object, gameKey:string, charKey:string}>>}
   */
  async function variantsOf(modelId) {
    for (const game of state.games) {
      if (!state.gameChars.get(game.key)) {
        try { await ensureGameLoaded(game); } catch { continue; }
      }
      const entry = state.gameChars.get(game.key);
      if (!entry) continue;
      for (const c of entry.chars) {
        const hit = c.variants.some((v) => v && v.model && v.model.id === modelId);
        if (hit) return c.variants.filter((v) => v && v.model).map((v) => ({ model: v.model, gameKey: game.key, charKey: c.key }));
      }
    }
    return [];
  }

  /**
   * 按 modelId 选中某个变体并同步左栏（**外部入口专用**）。
   *
   * 为什么需要它：左栏点击时选中态由 onVariantClick 自己维护，但"上一个/下一个"、快捷键等
   *   外部入口只调装载、不碰左栏 ⇒ 树上高亮停在上一个模型，看起来像没切过去。
   *   这里把"选中态 + 展开 + 渲染 + 定位 + 存盘"收成一处，外部入口只调它。
   * 不触发 onSelect：装载由调用方的统一入口负责，避免同一次切换装载两遍。
   * @param {string} modelId
   * @param {{reveal?: boolean}} [opts] reveal=false 时不滚动定位（默认滚到可视区）
   * @returns {Promise<{ok:boolean, gameKey?:string, charKey?:string, reason?:string}>}
   */
  async function selectById(modelId, opts = {}) {
    if (!modelId) return { ok: false, reason: 'no-id' };
    for (const game of state.games) {
      // 目标可能属于还没展开/加载的游戏：按需加载一次（与启动恢复同策略，不预取全部）
      if (!state.gameChars.get(game.key)) {
        try { await ensureGameLoaded(game); } catch { continue; }
      }
      const hit = findVariant(game, modelId);
      if (!hit) continue;
      store.selectModel({ modelId, gameKey: game.key, gameName: game.name, charKey: hit.charKey });
      state.activeGame = game.name;
      try { saveLastModel(hit.variant && hit.variant.model ? hit.variant.model : null); } catch { /* 忽略 */ }
      // 不展开的话目标行根本没渲染出来，高亮也就无从显示
      store.expandGame(game.key);
      store.expandChar(hit.charKey);
      render();
      if (opts.reveal !== false) state.lastReveal = reveal.revealActive();
      saveState(state);
      return { ok: true, gameKey: game.key, charKey: hit.charKey };
    }
    return { ok: false, reason: 'not-found' };
  }

  /**
   * 启动恢复：按存档把上次选中的变体重新选中并渲染。
   * 懒加载顺序：目标变体所属游戏可能还没加载 ⇒ 先按游戏逐个加载再看命中，不预取全部。
   * 失效兜底：所有游戏都找过仍没有 ⇒ 安静回落空舞台（不展开、不报错、不留半选中状态）。
   * @returns {Promise<{restored: boolean, modelId?: string, reason?: string}>}
   */
  async function restoreLast() {
    // 冷启动加载策略（唯一允许的启动加载）：
    //   读「上次所用模型」指针 → **只加载它所在的那一个根** → 展开并定位到它。
    //   没有指针 ⇒ 一个根都不扫（只渲染游戏列表，行上显示「未加载 · 点击加载」）。
    //   有指针但失败 ⇒ 该游戏行显示「加载失败 · 重试」，不影响其它游戏。
    const pointer = readLastModel();
    if (!pointer) return { restored: false, reason: 'no-pointer' };

    const game = state.games.find((g) => g.roots.some((r) => r.id === pointer.rootId));
    if (!game) return { restored: false, reason: 'root-gone', rootId: pointer.rootId };
    const root = game.roots.find((r) => r.id === pointer.rootId);

    try {
      await ensureRootLoaded(root);         // 只有这一个根（1 次 catalog + 1 条进度流）
    } catch {
      return { restored: false, reason: 'load-failed', rootId: pointer.rootId };
    }
    rebuildGameChars(game);
    store.expandGame(game.key);

    const hit = findVariant(game, pointer.modelId);
    if (!hit) {
      render();
      saveState(state);
      return { restored: false, reason: 'model-gone', rootId: pointer.rootId };
    }
    store.expandChar(hit.charKey);
    // 关键：复用"用户点击变体"的同一入口 —— 它会写入选中态、存盘，并调用 onSelect 真正装载模型。
    //   只设置 state.selected + render() 是不够的：那只是"列表里高亮"，画布上什么都不会出现。
    onVariantClick(pointer.modelId, game.key, hit.charKey);
    state.lastReveal = reveal.revealActive();
    return { restored: true, modelId: pointer.modelId, rootId: pointer.rootId, gameKey: game.key };
  }

  /**
   * 把服务端的三字段写回名册条目并就地重画那一行（契约 §一 INV-D1 的前端落点）。
   *
   * 为什么"写回对象"和"刷 DOM"两件事都要做（只刷 DOM 就是之前那个 bug）：
   *   DOM 是一次性快照，`render()` 每次都用条目对象重画该行。
   *   实测过的错位：装载成功后只改了 DOM ⇒ 当场看着对了，
   *   随后任意一次重渲染（切换模型 / 搜索 / 展开折叠）又把旧值画回来 ⇒ "马上变回中性色"。
   *   所以权威写回必须落在**名册持有的那个对象**上（modelById 与 buildChars 的
   *   variants[].model 是同一引用，改它两边都生效）。
   * @param {string} modelId 条目 id
   * @param {{display?:object, support?:object, loadResult?:object}|null} entryState 服务端三字段
   * @returns {boolean} 条目不在名册里返回 false（调用方可忽略）
   */
  function setEntryState(modelId, entryState) {
    const hit = modelById.get(String(modelId || ''));
    if (!hit || !hit.model) return false;
    const st = entryState || {};
    hit.model.display = st.display || { accent: null, provider: null, candidates: [] };
    hit.model.support = st.support || { state: 'unknown', detail: null };
    hit.model.loadResult = st.loadResult || null;
    // 对象已更新 ⇒ 只重画这一行（不整表重建，保留展开态/选中态/滚动位置）
    try { applyEntryState(hit.model, st); } catch { /* 单行重画失败不影响数据 */ }
    return true;
  }
  return {
    mount, state, snapshot, render, ensureGameLoaded, selectById, listVariants, variantsOf,
    setEntryState,
    restoreLast,
    revealActive: reveal.revealActive,
    markUserScroll: reveal.markUserScroll,
    /** 调试计数（渲染/加载次数）：优化前后用同一口径对比 */
    counters: () => ({ ...counters }),
    /** 名册加载计时快照（`window.__WEB__.rosterStats()` 用它；口径见文件内"名册加载计时"注释） */
    rosterStats,
    /** 立刻落地待渲染的请求（测试/自检用：不依赖 rAF 时机） */
    flushRender,
    /** 归零计数（测量前调用，避免把上一段的调用混进来） */
    resetCounters: () => { counters.render = 0; counters.ensureRootLoaded = 0; counters.renderScheduled = 0; },
  };
}
