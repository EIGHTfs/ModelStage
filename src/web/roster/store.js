// roster/store.js —— 名册**唯一状态持有者**（状态收口）
//
// 为什么要有它：名册原先有 7 份状态（loaded / scan / gameChars / expandedGames /
//   expandedChars / selected / scanBaseline）分散在 mount、ensureRootLoaded、trackScanProgress、
//   loadGame、ensureGameLoaded、rebuildGameChars、restoreLast、render 里各自直接改写。
//   写入点一多，任何新功能（例如"增量加条目"）都会变成第 8、9 个写入点，行为难以推理。
//
// 约定：
//   · **只有本文件可以写 state 的字段**；外部（view.js / snapshot.js）只读。
//   · 所有变更走下面的动作方法；每次变更后调用一次 onChange（视图据此合并渲染）。
//   · 动作保持"最小原子"：一个动作只做一件事，不夹带 UI 逻辑（渲染由 onChange 触发）。

/**
 * @param {{buildChars: Function, onChange?: () => void}} deps
 *        buildChars(models, nameIndex, gameName) ⇒ { chars, stats }（由 view.js 注入，避免本文件依赖构建细节）
 */
export function createRosterStore({ buildChars, onChange } = {}) {
  const state = {
    /** 按 name 合并后的游戏列表（结构：{ key, name, roots[] }） */
    games: [],
    /** rootId → { status, models, source, error, promise, pendingCatalogRetry } */
    loaded: new Map(),
    /** rootId → { monitor, controller, game }（扫描进行中的根） */
    scan: new Map(),
    /** gameKey → { chars, stats }（跨根归并后的角色树） */
    gameChars: new Map(),
    expandedGames: new Set(),
    expandedChars: new Set(),
    selected: null,
    keyword: '',
    typeFilter: new Set(),
    /** gameKey → { scanned, dirs }（多根逐根扫描时的计数基线） */
    scanBaseline: new Map(),
  };

  const notify = () => {
    if (typeof onChange === 'function') {
      try { onChange(); } catch { /* 视图回调异常不影响状态 */ }
    }
  };

  /** 读：某根的加载条目（不存在返回 null，不隐式创建） */
  const rootEntry = (rootId) => state.loaded.get(String(rootId)) || null;

  const actions = {
    state,

    // ---------------------------------------------------------------- 根与游戏
    /**
     * 重建游戏列表（按 name 合并同名根）。
     * @param {Array} roots /api/roots 的 roots
     * @returns {Array} 合并后的 games
     */
    setRoots(roots) {
      const byName = new Map();
      for (const root of Array.isArray(roots) ? roots : []) {
        const name = root.name || root.id;
        if (!byName.has(name)) byName.set(name, { key: `game:${name}`, name, roots: [] });
        byName.get(name).roots.push(root);
      }
      state.games = [...byName.values()];
      notify();
      return state.games;
    },

    /** 某游戏对象（按 key） */
    gameOf(gameKey) {
      return state.games.find((g) => g.key === gameKey) || null;
    },

    /** 某根所属的游戏 */
    gameOfRoot(rootId) {
      return state.games.find((g) => g.roots.some((r) => r.id === rootId)) || null;
    },

    // ---------------------------------------------------------------- 根的加载状态
    /**
     * 写某根的加载状态（浅合并；不传的字段保持不变）。
     * @param {string} rootId
     * @param {object} patch 例：{ status:'loading' } / { status:'error', error:'…' }
     */
    setRootStatus(rootId, patch) {
      const id = String(rootId);
      const cur = state.loaded.get(id) || { status: 'idle', models: [], source: '', error: null, promise: null };
      state.loaded.set(id, { ...cur, ...(patch || {}) });
    },

    /** 读某根条目 */
    getRoot(rootId) {
      return rootEntry(rootId);
    },

    /** 清掉若干根的加载状态（重试用：让它们回到"未加载"） */
    resetRoots(rootIds) {
      for (const id of rootIds || []) state.loaded.delete(String(id));
    },

    /**
     * 写某根的模型清单（权威全量）。
     * @param {string} rootId
     * @param {Array} models
     * @param {{authoritative?: boolean, source?: string}} [opts]
     */
    setRootModels(rootId, models, opts = {}) {
      const id = String(rootId);
      const entry = state.loaded.get(id);
      if (!entry) return;
      entry.models = Array.isArray(models) ? models : [];
      if (opts.source) entry.source = String(opts.source);
      if (opts.authoritative !== false) entry.status = 'ready';
    },

    // ---------------------------------------------------------------- 扫描
    updateScan(rootId, payload) {
      state.scan.set(String(rootId), payload);
    },

    clearScan(rootId) {
      state.scan.delete(String(rootId));
    },

    getScan(rootId) {
      return state.scan.get(String(rootId)) || null;
    },

    setScanBaseline(gameKey, base) {
      state.scanBaseline.set(String(gameKey), base);
    },

    getScanBaseline(gameKey) {
      return state.scanBaseline.get(String(gameKey)) || null;
    },

    clearScanBaseline(gameKey) {
      state.scanBaseline.delete(String(gameKey));
    },

    // ---------------------------------------------------------------- 角色树
    /**
     * 用该游戏各根**已就绪**的模型重建角色树（跨根归并）。
     * @param {string} gameKey
     * @param {{nameIndex?: Map}} [opts] 名表索引（不传则用注入的默认值由调用方提供）
     * @returns {object|null} { chars, stats }
     */
    rebuildChars(gameKey, opts = {}) {
      const game = state.games.find((g) => g.key === String(gameKey));
      if (!game) return null;
      const models = [];
      for (const root of game.roots) {
        const entry = state.loaded.get(root.id);
        if (entry && entry.status === 'ready') models.push(...(entry.models || []));
      }
      const built = buildChars(models, opts.nameIndex, game.name);
      state.gameChars.set(game.key, built);
      return built;
    },

    // ---------------------------------------------------------------- 展开态
    toggleGame(gameKey) {
      const key = String(gameKey);
      const next = !state.expandedGames.has(key);
      if (next) state.expandedGames.add(key); else state.expandedGames.delete(key);
      return next;
    },

    expandGame(gameKey) {
      state.expandedGames.add(String(gameKey));
    },

    collapseAll() {
      state.expandedGames.clear();
      state.expandedChars.clear();
    },

    toggleChar(charKey) {
      const key = String(charKey);
      const next = !state.expandedChars.has(key);
      if (next) state.expandedChars.add(key); else state.expandedChars.delete(key);
      return next;
    },

    expandChar(charKey) {
      state.expandedChars.add(String(charKey));
    },

    /** 恢复持久化里的展开态（只保留仍存在的游戏） */
    restoreExpanded({ games, chars }) {
      const keys = new Set(state.games.map((g) => g.key));
      for (const key of games || []) if (keys.has(key)) state.expandedGames.add(key);
      for (const key of chars || []) state.expandedChars.add(key);
    },

    // ---------------------------------------------------------------- 选中 / 关键词 / 筛选
    /**
     * 写选中项。
     * @param {{modelId:string, gameKey:string, gameName:string|null, charKey:string}|null} payload
     */
    selectModel(payload) {
      state.selected = payload || null;
    },

    setKeyword(keyword) {
      state.keyword = String(keyword || '').trim().toLowerCase();
    },

    toggleTypeFilter(typeKey) {
      const key = String(typeKey);
      const next = !state.typeFilter.has(key);
      if (next) state.typeFilter.add(key); else state.typeFilter.delete(key);
      return next;
    },

    clearTypeFilter() {
      state.typeFilter.clear();
    },

    /** 一次性把筛选集合替换掉（测试/外部恢复用；正常交互请用 toggleTypeFilter） */
    setTypeFilter(keys) {
      state.typeFilter = new Set(keys || []);
    },
  };

  return actions;
}
