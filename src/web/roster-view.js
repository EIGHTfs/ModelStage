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

import {
  createNameIndex, mergeNameTable, loadRootModels, loadRootNames, buildChars,
} from './roster.js';
import { el, renderGameRow, renderCharRow, renderVariantRow } from './roster-rows.js';
import { formatError } from './api.js';

/** localStorage 键名：与旧前端一致，不得改名（M7 要用它做持久化，改名会让用户既有状态失效） */
const LS_KEY = 'spine-multi-viewer.tree-state.v1';

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
  const nameIndex = createNameIndex();
  const namesLoaded = new Set();
  const modelById = new Map();

  // ------------------------------------------------------------ 持久化

  /** 读展开态与上次选中（结构照旧前端的 {games, chars, activeGame, lastByGame}） */
  function readSaved() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      return {
        games: new Set(Array.isArray(s.games) ? s.games : []),
        chars: new Set(Array.isArray(s.chars) ? s.chars : []),
        activeGame: typeof s.activeGame === 'string' ? s.activeGame : null,
        lastByGame: s.lastByGame && typeof s.lastByGame === 'object' ? s.lastByGame : {},
        // 旧格式：只有单个 lastModelId（更早版本写入的），读出来用于兼容恢复
        lastModelId: typeof s.lastModelId === 'string' ? s.lastModelId : null,
      };
    } catch {
      return { games: new Set(), chars: new Set(), activeGame: null, lastByGame: {}, lastModelId: null };
    }
  }

  /** 写展开态与每个游戏上次选中的变体（键名/结构沿用旧前端：activeGame 存游戏名） */
  function saveState() {
    try {
      const s = readSaved();
      const lastByGame = { ...s.lastByGame };
      if (state.activeGame && state.selected) lastByGame[state.activeGame] = state.selected.modelId;
      localStorage.setItem(LS_KEY, JSON.stringify({
        games: [...state.expandedGames],
        chars: [...state.expandedChars],
        activeGame: state.activeGame || s.activeGame,
        lastByGame,
      }));
    } catch {
      // 隐私模式等写不了就忽略：持久化是增强，不影响当前会话
    }
  }

  // ------------------------------------------------------------ 数据加载

  /**
   * 确保某个资源根的模型已加载。
   * 并发要点：正在加载中的根必须**可等待**（entry.promise），否则后到的调用方会拿到空数据
   *   ——启动恢复与"恢复展开态"的加载会并发进来，这一点决定恢复能否命中。
   * @param {object} root
   * @returns {Promise<object>} 该根的加载状态条目（ready / error）
   */
  function ensureRootLoaded(root) {
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
      render();
    })();
    state.loaded.set(root.id, entry);
    render();
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
    render();
  }

  /** 搜索需要全局数据：首次输入关键词时把所有游戏补加载（并行，服务端有缓存） */
  async function ensureAllLoaded() {
    await Promise.all(state.games.map((g) => ensureGameLoaded(g)));
  }

  // ------------------------------------------------------------ 过滤

  /** 单条变体的可搜索文本（资源名 / 目录名 / 角色名 / 服装名） */
  function variantSearchText(v) {
    const m = v.model;
    const nm = v.nm;
    return `${m.name} ${m.srcDir || ''} ${nm ? `${nm.nameZh} ${nm.name} ${nm.costume}` : ''}`.toLowerCase();
  }

  /** 角色是否命中（按角色整组判定：搜角色名时显示该角色全部变体） */
  function charMatches(c) {
    const kw = state.keyword;
    if (!kw) return true;
    if (String(c.title).toLowerCase().includes(kw)) return true;
    return c.variants.some((v) => variantSearchText(v).includes(kw));
  }

  /** 某游戏在搜索下可见的角色（未加载的游戏不参与过滤） */
  function visibleChars(game) {
    const entry = state.gameChars.get(game.key);
    if (!entry) return [];
    if (!state.keyword) return entry.chars;
    const gameHit = String(game.name).toLowerCase().includes(state.keyword)
      || game.roots.some((r) => String(r.id).toLowerCase().includes(state.keyword));
    return gameHit ? entry.chars : entry.chars.filter(charMatches);
  }

  // ------------------------------------------------------------ 渲染

  /** 渲染整棵树（只渲染可见部分；展开的角色才生成变体行） */
  function render() {
    listEl.replaceChildren();

    const searching = state.keyword.length > 0;
    let totalChars = 0;
    let totalVariants = 0;
    let rendered = 0;
    let loadedGames = 0;

    for (const game of state.games) {
      const status = gameStatus(game);
      if (status === 'ready') loadedGames += 1;
      const chars = visibleChars(game);
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
  function snapshot() {
    const games = state.games.map((g) => {
      const chars = state.gameChars.get(g.key);
      return {
        key: g.key,
        name: g.name,
        roots: g.roots.map((r) => r.id),
        status: gameStatus(g),
        sources: g.roots.map((r) => (state.loaded.get(r.id) || {}).source || '').filter(Boolean),
        chars: chars ? chars.chars.length : 0,
        variants: chars ? chars.chars.reduce((n, c) => n + c.variants.length, 0) : 0,
        miss: chars ? chars.stats.miss : 0,
      };
    });
    return {
      games,
      expandedGames: [...state.expandedGames],
      expandedChars: [...state.expandedChars],
      keyword: state.keyword,
      selected: state.selected,
      domRows: {
        games: listEl.querySelectorAll('[data-game-key].tree-game').length,
        chars: listEl.querySelectorAll('[data-char-key].tree-char').length,
        variants: listEl.querySelectorAll('[data-model-id]').length,
      },
    };
  }

  // ------------------------------------------------------------ 事件

  /** 点一级：折叠/展开游戏（首次展开触发该游戏所有根的数据加载） */
  async function onGameClick(gameKey) {
    if (state.expandedGames.has(gameKey)) {
      state.expandedGames.delete(gameKey);
      render();
      saveState();
      return;
    }
    state.expandedGames.add(gameKey);
    // 先渲染一次：已加载过的游戏直接出角色行（ensureGameLoaded 在无待加载根时不会单独渲染）
    render();
    const game = state.games.find((g) => g.key === gameKey);
    if (game) await ensureGameLoaded(game);
    saveState();
  }

  /** 点二级：折叠/展开角色（变体已在内存，不发请求） */
  function onCharClick(charKey) {
    if (state.expandedChars.has(charKey)) state.expandedChars.delete(charKey);
    else state.expandedChars.add(charKey);
    render();
    saveState();
  }

  /** 点三级：选中变体（高亮 + 记录状态，M4 用它去渲染） */
  function onVariantClick(modelId, gameKey, charKey) {
    const game = state.games.find((g) => g.key === gameKey);
    state.selected = { modelId, gameKey, gameName: game ? game.name : null, charKey };
    state.activeGame = game ? game.name : state.activeGame;
    render();
    saveState();
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
      saveState();
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
      saveState(); // 顺带把旧格式迁移成 lastByGame（saveState 只写 lastByGame）
      if (typeof onSelect === 'function') onSelect(modelById.get(modelId)?.model || null);
      return { restored: true, modelId, gameKey: game.key, charKey: hit.charKey };
    }
    // 存档里的模型已不存在：清掉半状态，保持空舞台
    state.selected = null;
    render();
    return { restored: false, reason: 'missing', modelId };
  }

  return { mount, state, snapshot, render, ensureGameLoaded, restoreLast };
}
