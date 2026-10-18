// roster-view.js —— 名册视图层：三级树（资源根 → 角色 → 变体）+ 搜索 + 选中态（M2）
//
// 做什么：
//   1. 一级：每个资源根一行（可折叠）。**首次展开才请求该根的模型清单**（懒加载），
//      之后再展开/折叠只用内存里的结果，不再发请求；
//   2. 二级：角色行（可折叠），组内变体在三级；角色与变体都用 roster.js 的归并结果；
//   3. 搜索：前端过滤（角色名 / 服装名 / 资源名 / 目录名），命中即自动展开到变体层；
//   4. 选中态：点变体行高亮并记录（M4 渲染用），状态写 localStorage（键名沿用旧前端）；
//   5. 顶部「收起」只清空展开状态，面板本身保留（面板显隐由顶栏「模型库」按钮控制）。
//
// 状态全部收在 state 里，DOM 只是投影：这样"点一下到底改了什么"可以直接读 state 验证。

import {
  createNameIndex, mergeNameTable, loadRootModels, loadRootNames, buildChars,
} from './roster.js';
import { el, renderRootRow, renderCharRow, renderVariantRow } from './roster-rows.js';
import { formatError } from './api.js';

/** localStorage 键名：与旧前端一致，不得改名（M7 要用它做持久化，改名会让用户既有状态失效） */
const LS_KEY = 'spine-multi-viewer.tree-state.v1';

/** 每个资源根最多渲染的角色行数（旧前端按游戏限额 400，避免 2000+ 角色一次铺满） */
const RENDER_LIMIT_PER_ROOT = 400;

/**
 * 名册状态：roots 来自 /api/roots；loaded 按根缓存模型加载结果；
 * expandedRoots/expandedChars 是两级展开键；keyword 是搜索词；selected 是当前选中变体。
 */

/** 创建名册视图并挂到容器上；返回对外 API（供 main.js 与自动化验证使用） */
export function createRosterView({ listEl, countEl, searchEl, collapseBtn, onSelect }) {
  const state = {
    roots: [],
    loaded: new Map(),
    expandedRoots: new Set(),
    expandedChars: new Set(),
    keyword: '',
    selected: null,
    activeRoot: null,
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
      };
    } catch {
      return { games: new Set(), chars: new Set(), activeGame: null, lastByGame: {} };
    }
  }

  /** 写展开态与每个游戏上次选中的变体（键名/结构沿用旧前端） */
  function saveState() {
    try {
      const s = readSaved();
      const lastByGame = { ...s.lastByGame };
      if (state.activeRoot && state.selected) lastByGame[state.activeRoot] = state.selected.modelId;
      localStorage.setItem(LS_KEY, JSON.stringify({
        games: [...state.expandedRoots],
        chars: [...state.expandedChars],
        activeGame: state.activeRoot || s.activeGame,
        lastByGame,
      }));
    } catch {
      // 隐私模式等写不了就忽略：持久化是增强，不影响当前会话
    }
  }

  // ------------------------------------------------------------ 数据加载

  /**
   * 确保某资源根的模型已加载（首次展开时调用；已加载/加载中则直接返回）。
   * 为什么按根加载：一个根一次请求（服务端有清单缓存），展开哪个根只付那个根的成本。
   * @param {object} root
   */
  async function ensureRootLoaded(root) {
    const cur = state.loaded.get(root.id);
    if (cur && (cur.status === 'ready' || cur.status === 'loading')) return cur;
    const entry = { status: 'loading', chars: [], source: '', stats: null, error: null };
    state.loaded.set(root.id, entry);
    render();
    try {
      // 名表按根取一次，合并进全局索引（同名表只并一次，避免重复 object assign）
      if (!namesLoaded.has(root.id)) {
        namesLoaded.add(root.id);
        const table = await loadRootNames(root.id);
        if (table) mergeNameTable(nameIndex, table);
      }
      const { models, source } = await loadRootModels(root);
      for (const m of models) modelById.set(m.id, { model: m, rootId: root.id });
      const { chars, stats } = buildChars(models, nameIndex);
      entry.status = 'ready';
      entry.chars = chars;
      entry.source = source;
      entry.stats = stats;
    } catch (err) {
      entry.status = 'error';
      entry.error = formatError(err);
    }
    render();
    return entry;
  }

  /** 搜索需要全局数据：首次输入关键词时把所有根补加载（并行，服务端有缓存） */
  async function ensureAllLoaded() {
    await Promise.all(state.roots.map((r) => ensureRootLoaded(r)));
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

  /** 某根在搜索下可见的角色（未加载的根不参与过滤） */
  function visibleChars(root) {
    const entry = state.loaded.get(root.id);
    if (!entry || entry.status !== 'ready') return [];
    if (!state.keyword) return entry.chars;
    const rootHit = String(root.name).toLowerCase().includes(state.keyword)
      || String(root.id).toLowerCase().includes(state.keyword);
    return rootHit ? entry.chars : entry.chars.filter(charMatches);
  }

  // ------------------------------------------------------------ 渲染

  /** 渲染整棵树（只渲染可见部分；展开的角色才生成变体行） */
  function render() {
    listEl.replaceChildren();

    const searching = state.keyword.length > 0;
    let totalChars = 0;
    let totalVariants = 0;
    let rendered = 0;

    for (const root of state.roots) {
      const entry = state.loaded.get(root.id);
      const rootOpen = state.expandedRoots.has(root.id) || (searching && visibleChars(root).length > 0);
      listEl.append(renderRootRow(root, {
        open: state.expandedRoots.has(root.id),
        status: entry ? entry.status : 'idle',
        charCount: entry && entry.chars ? entry.chars.length : 0,
      }));
      if (!rootOpen) continue;

      if (!entry || entry.status === 'loading') {
        listEl.append(el('p', 'muted-hint tree-hint', '加载中…'));
        continue;
      }
      if (entry.status === 'error') {
        listEl.append(el('p', 'error-banner', `加载失败：${entry.error}`));
        continue;
      }

      const chars = visibleChars(root);
      totalChars += chars.length;
      const selectedId = state.selected ? state.selected.modelId : null;
      for (const c of chars) {
        if (rendered >= RENDER_LIMIT_PER_ROOT) break;
        rendered += 1;
        const charOpen = state.expandedChars.has(c.key) || searching;
        listEl.append(renderCharRow(root, c, charOpen));
        if (!charOpen) continue;
        totalVariants += c.variants.length;
        for (const v of c.variants) listEl.append(renderVariantRow(root, c, v, selectedId));
      }
      if (!chars.length) listEl.append(el('p', 'muted-hint tree-hint', searching ? '无匹配' : '该资源根没有可加载模型'));
    }

    // 计数文案：搜索时显示"命中数"，平时显示"已加载的规模"
    const loadedRoots = [...state.loaded.values()].filter((e) => e.status === 'ready');
    const allChars = loadedRoots.reduce((n, e) => n + e.chars.length, 0);
    const allVariants = loadedRoots.reduce((n, e) => n + e.chars.reduce((t, c) => t + c.variants.length, 0), 0);
    countEl.textContent = searching
      ? `搜索「${state.keyword}」：${totalChars} 角色 / ${totalVariants} 变体`
      : `${state.roots.length} 资源根 / 已加载 ${loadedRoots.length} 根：${allChars} 角色 / ${allVariants} 变体`;

    // 供自动化断言：把状态投影成可读快照
    document.documentElement.dataset.rosterReady = '1';
    document.documentElement.dataset.rosterSnapshot = JSON.stringify(snapshot());
  }

  /** 状态快照（自动化断言与排查用，避免每次都去数 DOM） */
  function snapshot() {
    const roots = state.roots.map((r) => {
      const e = state.loaded.get(r.id);
      return {
        id: r.id,
        name: r.name,
        status: e ? e.status : 'idle',
        source: e ? e.source : '',
        chars: e && e.chars ? e.chars.length : 0,
        variants: e && e.chars ? e.chars.reduce((n, c) => n + c.variants.length, 0) : 0,
        miss: e && e.stats ? e.stats.miss : 0,
      };
    });
    return {
      roots,
      expandedRoots: [...state.expandedRoots],
      expandedChars: [...state.expandedChars],
      keyword: state.keyword,
      selected: state.selected,
      domRows: {
        roots: listEl.querySelectorAll('[data-root-id].tree-root').length,
        chars: listEl.querySelectorAll('[data-char-key].tree-char').length,
        variants: listEl.querySelectorAll('[data-model-id]').length,
      },
    };
  }

  // ------------------------------------------------------------ 事件

  /** 点一级：折叠/展开资源根（首次展开触发该根的数据加载） */
  async function onRootClick(rootId) {
    if (state.expandedRoots.has(rootId)) {
      state.expandedRoots.delete(rootId);
      render();
      saveState();
      return;
    }
    state.expandedRoots.add(rootId);
    // 先渲染一次：已加载过的根直接出角色行（ensureRootLoaded 在"已就绪"分支会提前返回，不会渲染）
    render();
    const root = state.roots.find((r) => r.id === rootId);
    if (root) await ensureRootLoaded(root);
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
  function onVariantClick(modelId, rootId, charKey) {
    state.selected = { modelId, rootId, charKey };
    state.activeRoot = rootId;
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
        onVariantClick(row.dataset.modelId, row.dataset.rootId, row.dataset.charKey);
      } else if (row.dataset.charKey) {
        onCharClick(row.dataset.charKey);
      } else if (row.dataset.rootId) {
        onRootClick(row.dataset.rootId);
      }
    }

    listEl.addEventListener('click', (e) => {
      const row = e.target.closest('[data-model-id], [data-char-key], [data-root-id]');
      if (row) activate(row);
    });

    // 键盘可达：树行带 tabindex="0"，Enter / 空格与点击等价
    listEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('[data-model-id], [data-char-key], [data-root-id]');
      if (!row) return;
      e.preventDefault();
      activate(row);
    });

    searchEl.addEventListener('input', () => {
      state.keyword = searchEl.value.trim().toLowerCase();
      // 搜索要全局数据：首次输入时把所有根补上（之后都走缓存，不再请求）
      if (state.keyword && state.loaded.size < state.roots.length) {
        ensureAllLoaded();
      } else {
        render();
      }
    });

    // 「收起」：只清空两级展开状态，面板保留
    collapseBtn.addEventListener('click', () => {
      state.expandedRoots.clear();
      state.expandedChars.clear();
      render();
      saveState();
    });
  }

  /** 初始化：拉资源根列表 → 渲染（不加载任何模型，等用户展开） */
  async function mount(roots) {
    state.roots = roots;
    const saved = readSaved();
    // 展开状态恢复：只恢复"仍存在的根"，避免历史配置残留导致空节点
    const ids = new Set(roots.map((r) => r.id));
    for (const g of saved.games) if (ids.has(g)) state.expandedRoots.add(g);
    for (const c of saved.chars) state.expandedChars.add(c);
    state.activeRoot = saved.activeGame;
    bindEvents();
    render();
    // 恢复展开的根要补加载数据（用户上次就是展开的）
    for (const id of [...state.expandedRoots]) {
      const root = roots.find((r) => r.id === id);
      if (root) ensureRootLoaded(root);
    }
  }

  return { mount, state, snapshot, render, ensureRootLoaded };
}
