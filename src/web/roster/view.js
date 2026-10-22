// roster-view.js —— 名册视图层：三级树（游戏 → 角色 → 变体）+ 搜索 + 选中态（M2）
//
// 做什么：
//   1. 一级：按资源根配置的 name 合并成游戏节点（同名根合并，照 legacy/patches/char-tree.js）；展开该游戏时才请求其各根模型；
//   2. 二级：角色跨根归并——同一角色在多个根下的模型归到一个角色节点（不是把各根的行拼起来）；
//   3. 三级：变体（模型）。行上带类型标签（Spine / Live2D / 资源包）与来源根 id；
//   4. 搜索：前端过滤（角色名 / 服装名 / 资源名 / 目录名），命中即自动展开到变体层；
//   5. 选中态：点变体行高亮并记录（M4 渲染用），状态写 localStorage（键名/结构沿用旧前端）；
//   6. 顶部「收起」只清空展开状态，面板本身保留（面板显隐由顶栏「模型库」按钮控制）。
//
// 状态全部收在 state 里，DOM 只是投影：这样"点一下到底改了什么"可以直接读 state 验证。

import { createReveal } from './reveal.js';
import { visibleChars } from './filter.js';
import { snapshotRoster } from './snapshot.js';
import { readSaved, saveState } from './persist.js';
import {
  createNameIndex, mergeNameTable, loadRootModels, loadRootNames, buildChars,
} from './list.js';
import { el, renderGameRow, renderCharRow, renderVariantRow } from './rows.js';
import { formatError } from '../infra/api.js';

/** localStorage 键名：与旧前端一致，不得改名（M7 要用它做持久化，改名会让用户既有状态失效） */

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
 * keyword 是搜索词；selected 是当前选中变体；activeGame 是最后活跃的游戏名（与旧前端同义）。
 */

/** 创建名册视图并挂到容器上；返回对外 API（供 main.js 与自动化验证使用） */
export function createRosterView({ listEl, countEl, searchEl, collapseBtn, onSelect }) {
  const state = {
    games: [],
    loaded: new Map(),
    gameChars: new Map(),
    expandedGames: new Set(),
    expandedChars: new Set(),
    keyword: '',
    selected: null,
    activeGame: null,
  };
  // 定位控制器：把"选中后滚到可见"的策略外置（见 roster/reveal.js）
  /**
   * 调试计数器（**纯计量**，只做 ++，不影响任何调度与渲染结果）。
   * 用途：首屏渲染次数是"每个根各触发一次全树 render"这个性能问题的直接指标，
   *   优化前后必须用同一口径对比（见 __WEB__ 侧的 counters() 取数）。
   */
  const counters = { render: 0, ensureRootLoaded: 0, renderScheduled: 0 };

  // ------------------------------------------------------------ 渲染调度（rAF 合并）
  //
  // 为什么需要：加载阶段每条路径都会触发一次全树重绘——ensureRootLoaded 里"开始加载"与
  //   "加载完成"各一次、ensureGameLoaded 末尾再来一次。N 个资源根就是 ~2N+ 次全树替换，
  //   首屏 1000+ 行时单次 100~250ms，叠加起来就是成片的长任务（实测冷搜 8 个长任务）。
  //   这些中间态在视觉上没有价值（同一帧内根本看不到），合并成一次既省时间也减少闪烁。
  //
  // 三条硬约束：
  //   ① 不漏最后一帧：pending 标志只在真正 render() 之后清除；另有 flushRender() 强制落地，
  //      加载流程末尾与"rAF 不触发"（后台标签页）时都会走它。
  //   ② 不闪烁：同一帧内多次请求只渲染一次，因此**只会更少**中间态，不会多出来。
  //   ③ 状态不丢：render() 本身没改，展开态/滚动/选中/关键词全部照旧读取。
  let pendingRender = false;
  let rafId = null;
  let fallbackTimer = null;

  /** 清理已排队的调度（rAF 与兜底定时器都要清，否则会多渲一次） */
  function clearScheduled() {
    if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    rafId = null;
    fallbackTimer = null;
    pendingRender = false;
  }

  /** 下一帧渲染（同帧内多次调用合并为一次） */
  function scheduleRender() {
    counters.renderScheduled += 1;
    if (pendingRender) return;
    pendingRender = true;
    if (typeof requestAnimationFrame !== 'function') { flushRender(); return; }
    rafId = requestAnimationFrame(() => { rafId = null; flushRender(); });
    // 兜底：后台标签页/被节流的 rAF 可能长时间不回调，绝不能让首屏永久空白
    fallbackTimer = setTimeout(() => { fallbackTimer = null; flushRender(); }, 120);
  }

  /** 立刻渲染（若有已排队的请求）。幂等：没有待渲染时什么都不做。 */
  function flushRender() {
    if (!pendingRender) return;
    clearScheduled();
    render();
  }

  const reveal = createReveal({ listEl, getState: () => state, render: () => render() });

  const nameIndex = createNameIndex();
  const namesLoaded = new Set();
  const modelById = new Map();

  // ------------------------------------------------------------ 数据加载

  /**
   * 确保某个资源根的模型已加载。
   * 并发要点：正在加载中的根必须**可等待**（entry.promise），否则后到的调用方会拿到空数据
   *   ——启动恢复与"恢复展开态"的加载会并发进来，这一点决定恢复能否命中。
   * @param {object} root
   * @returns {Promise<object>} 该根的加载状态条目（ready / error）
   */
  function ensureRootLoaded(root) {
    counters.ensureRootLoaded += 1;
    const cur = state.loaded.get(root.id);
    if (cur && cur.promise) return cur.promise.then(() => cur);
    if (cur && cur.status === 'ready') return Promise.resolve(cur);
    const entry = { status: 'loading', models: [], source: '', error: null, promise: null };
    entry.promise = (async () => {
      try {
        // 名表按根取一次并合并进全局索引（同名表只并一次，避免重复 assign）
        if (!namesLoaded.has(root.id)) {
          namesLoaded.add(root.id);
          const table = await loadRootNames(root.id);
          if (table) mergeNameTable(nameIndex, table);
        }
        const { models, source } = await loadRootModels(root);
        for (const m of models) modelById.set(m.id, { model: m, rootId: root.id });
        entry.status = 'ready';
        entry.models = models;
        entry.source = source;
      } catch (err) {
        entry.status = 'error';
        entry.error = formatError(err);
      }
      entry.promise = null;
      scheduleRender();          // 加载完成：合并到下一帧（不再每个根各渲一次）
    })();
    state.loaded.set(root.id, entry);
    scheduleRender();            // 开始加载：同上（视觉上只是把游戏行标成 loading）
    return entry.promise.then(() => entry);
  }

  /** 某游戏的全部根是否都已就绪（有失败也算"可渲染"，错误在游戏节点下提示） */
  function gameStatus(game) {
    const entries = game.roots.map((r) => state.loaded.get(r.id));
    if (entries.some((e) => e && e.status === 'loading')) return 'loading';
    if (entries.some((e) => !e || e.status === 'idle')) return 'idle';
    if (entries.every((e) => e && e.status === 'error')) return 'error';
    return 'ready';
  }

  /**
   * 重新归并某游戏的角色（跨根）：把该游戏所有已就绪根的模型并成一个数组再归并。
   * 为什么在游戏层归并：同一角色可能同时有 Live2D 与 Spine 变体（来自不同根），
   *   按根各自归并会得到两个同名角色节点，与旧前端行为不一致。
   * @param {object} game
   */
  function rebuildGameChars(game) {
    const models = [];
    for (const root of game.roots) {
      const entry = state.loaded.get(root.id);
      if (entry && entry.status === 'ready') models.push(...entry.models);
    }
    const { chars, stats } = buildChars(models, nameIndex, game.name);
    state.gameChars.set(game.key, { chars, stats });
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

  /** 渲染整棵树（只渲染可见部分；展开的角色才生成变体行） */
  function render() {
    counters.render += 1;
    listEl.replaceChildren();

    const searching = state.keyword.length > 0;
    let totalChars = 0;
    let totalVariants = 0;
    let rendered = 0;
    let loadedGames = 0;

    for (const game of state.games) {
      const status = gameStatus(game);
      if (status === 'ready') loadedGames += 1;
      const chars = visibleChars(game, state);
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

      totalChars += chars.length;
      const limit = renderLimitPerGame(); // 每次渲染读一次：改配置后刷新即生效
      const selectedId = state.selected ? state.selected.modelId : null;
      for (const c of chars) {
        if (rendered >= limit) break;
        rendered += 1;
        const charOpen = state.expandedChars.has(c.key) || searching;
        listEl.append(renderCharRow(game, c, charOpen));
        // 变体数按数据统计（不依赖是否展开），与旧前端「N 游戏 / M 角色 / K 变体」口径一致
        totalVariants += c.variants.length;
        if (!charOpen) continue;
        for (const v of c.variants) listEl.append(renderVariantRow(game, c, v, selectedId));
      }
      if (!chars.length) {
        listEl.append(el('p', 'muted-hint tree-hint', searching ? '无匹配' : '该游戏没有可加载模型'));
      }
    }

    // 计数文案：全量已加载时用旧前端的口径（N 游戏 / M 角色 / K 变体），否则标注已加载多少
    const allLoaded = loadedGames === state.games.length;
    const prefix = allLoaded ? `${state.games.length} 游戏` : `${state.games.length} 游戏 / 已加载 ${loadedGames}`;
    countEl.textContent = searching
      ? `搜索「${state.keyword}」：${totalChars} 角色 / ${totalVariants} 变体`
      : `${prefix}：${totalChars} 角色 / ${totalVariants} 变体`;

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
      state.expandedGames.delete(gameKey);
      render();
      saveState(state);
      return;
    }
    state.expandedGames.add(gameKey);
    // 先渲染一次：已加载过的游戏直接出角色行（ensureGameLoaded 在无待加载根时不会单独渲染）
    render();
    const game = state.games.find((g) => g.key === gameKey);
    if (game) await ensureGameLoaded(game);
    saveState(state);
  }

  /** 点二级：折叠/展开角色（变体已在内存，不发请求） */
  function onCharClick(charKey) {
    if (state.expandedChars.has(charKey)) state.expandedChars.delete(charKey);
    else state.expandedChars.add(charKey);
    render();
    saveState(state);
  }

  /** 点三级：选中变体（高亮 + 记录状态，M4 用它去渲染） */
  function onVariantClick(modelId, gameKey, charKey) {
    const game = state.games.find((g) => g.key === gameKey);
    state.selected = { modelId, gameKey, gameName: game ? game.name : null, charKey };
    state.activeGame = game ? game.name : state.activeGame;
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

    searchEl.addEventListener('input', () => {
      state.keyword = searchEl.value.trim().toLowerCase();
      // 搜索要全局数据：首次输入时把所有游戏补上（之后都走缓存，不再请求）
      if (state.keyword && [...state.gameChars.keys()].length < state.games.length) {
        ensureAllLoaded();
      } else {
        render();
      }
    });

    // 「收起」：只清空两级展开状态，面板保留
    collapseBtn.addEventListener('click', () => {
      state.expandedGames.clear();
      state.expandedChars.clear();
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
    // 同名根合并成一个游戏节点（照 char-tree.js：name 是归一 key）
    const byName = new Map();
    for (const root of roots) {
      const name = root.name || root.id;
      if (!byName.has(name)) byName.set(name, { key: `game:${name}`, name, roots: [] });
      byName.get(name).roots.push(root);
    }
    state.games = [...byName.values()];

    const saved = readSaved();
    if (restoreExpanded) {
      // 展开状态恢复：只恢复仍存在的游戏，避免历史配置残留导致空节点
      const gameKeys = new Set(state.games.map((g) => g.key));
      for (const k of saved.games) if (gameKeys.has(k)) state.expandedGames.add(k);
      for (const c of saved.chars) state.expandedChars.add(c);
      state.activeGame = saved.activeGame;
    }

    bindEvents();
    render();
    // 恢复展开的游戏要补加载数据（用户上次就是展开的）
    if (restoreExpanded) {
      for (const key of [...state.expandedGames]) {
        const game = state.games.find((g) => g.key === key);
        if (game) ensureGameLoaded(game);
      }
    }
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
   * 启动恢复：按存档把上次选中的变体重新选中并渲染。
   * 懒加载顺序：目标变体所属游戏可能还没加载 ⇒ 先按游戏逐个加载再看命中，不预取全部。
   * 失效兜底：所有游戏都找过仍没有 ⇒ 安静回落空舞台（不展开、不报错、不留半选中状态）。
   * @returns {Promise<{restored: boolean, modelId?: string, reason?: string}>}
   */
  async function restoreLast() {
    const saved = readSaved();
    const modelId = targetModelId(saved);
    if (!modelId) return { restored: false, reason: 'no-saved' };

    // 活跃游戏先试（多数命中在第一个），再按顺序找其余游戏
    const ordered = [...state.games];
    const active = ordered.find((g) => g.name === saved.activeGame);
    if (active) ordered.unshift(...ordered.splice(ordered.indexOf(active), 1));

    for (const game of ordered) {
      await ensureGameLoaded(game);
      const hit = findVariant(game, modelId);
      if (!hit) continue;
      state.expandedGames.add(game.key);
      state.expandedChars.add(hit.charKey);
      state.selected = { modelId, gameKey: game.key, gameName: game.name, charKey: hit.charKey };
      state.activeGame = game.name;
      render();
      // 自动恢复同样把恢复到的那一行滚进视野；但用户若正在滚动就不会抢（守卫在 revealActive 里）
      state.lastReveal = reveal.revealActive();
      saveState(state); // 顺带把旧格式迁移成 lastByGame（saveState 只写 lastByGame）
      if (typeof onSelect === 'function') onSelect(modelById.get(modelId)?.model || null);
      return { restored: true, modelId, gameKey: game.key, charKey: hit.charKey };
    }
    // 存档里的模型已不存在：清掉半状态，保持空舞台
    state.selected = null;
    render();
    return { restored: false, reason: 'missing', modelId };
  }

  return {
    mount, state, snapshot, render, ensureGameLoaded,
    restoreLast,
    revealActive: reveal.revealActive,
    markUserScroll: reveal.markUserScroll,
    /** 调试计数（渲染/加载次数）：优化前后用同一口径对比 */
    counters: () => ({ ...counters }),
    /** 立刻落地待渲染的请求（测试/自检用：不依赖 rAF 时机） */
    flushRender,
    /** 归零计数（测量前调用，避免把上一段的调用混进来） */
    resetCounters: () => { counters.render = 0; counters.ensureRootLoaded = 0; counters.renderScheduled = 0; },
  };
}
