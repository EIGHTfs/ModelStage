// roster/store.js —— 名册**唯一状态持有者**（状态收口）
//
// 为什么要有它：名册原先有 7 份状态（loaded / scan / groupChars / expandedGroups /
//   expandedChars / selected / scanBaseline）分散在 mount、ensureRootLoaded、trackScanProgress、
//   loadGroup、ensureGroupLoaded、rebuildGroupChars、restoreLast、render 里各自直接改写。
//   写入点一多，任何新功能（例如"增量加条目"）都会变成第 8、9 个写入点，行为难以推理。
//
// 约定：
//   · **只有本文件可以写 state 的字段**；外部（view.js / snapshot.js）只读。
//   · 所有变更走下面的动作方法；动作保持"最小原子"：只改状态，不夹带 UI 逻辑。
//   · 渲染时机分两种（别假设"改完就一定会重画"）：
//       ① 改结构/活跃分组的动作（setRoots / setActiveGroup）内部调 notify → 视图的 onChange；
//       ② 其余动作**不** notify —— 由调用方在合适的时机自己补一次渲染（名册走 rAF 合批的 scheduleRender）。
//     为什么②不统一 notify：加载期一条路径会连改十几次状态，每次 notify 就是十几次整树重绘；
//       合批是名册首屏性能的关键（见 infra/schedule.js 文件头）。

/**
 * @param {{buildChars: Function, nameIndex?: Map, onChange?: () => void}} deps
 *        buildChars(models, nameIndex, groupName) ⇒ { chars, stats }（由 view.js 注入，避免本文件依赖构建细节）
 *        nameIndex 名表索引（同样由 view.js 注入）：本文件要"写完 models 就重算角色树"，
 *          而归并需要它 —— 让 store 自己持有，调用方就不必每次记得传
 */
export function createRosterStore({ buildChars, nameIndex, onChange } = {}) {
  const state = {
    /** 按 name 合并后的游戏列表（结构：{ key, name, roots[] }） */
    groups: [],
    /** rootId → { status, models, source, error, promise, pendingCatalogRetry } */
    loaded: new Map(),
    /** rootId → { monitor, controller, group }（扫描进行中的根） */
    scan: new Map(),
    /** groupKey → { chars, stats }（跨根归并后的角色树） */
    groupChars: new Map(),
    expandedGroups: new Set(),
    expandedChars: new Set(),
    selected: null,
    keyword: '',
    typeFilter: new Set(),
    /** groupKey → { scanned, dirs }（多根逐根扫描时的计数基线） */
    scanBaseline: new Map(),
    /** 当前活跃的**分组**名（注意：语义是"分组"，不假设它一定是游戏） */
    activeGroup: null,
    /** 本页生命周期内已经跑过进度流的根（防止重复订阅） */
    scannedRoots: new Set(),
    /** 后台形态探测队列快照：{ remaining, at, rootId }（UI 未实现，数据先就绪） */
    probe: { remaining: null, at: null, rootId: null },
    /** 最近一次"定位到当前项"的结果（滚动/已可见/用户正在滚动…） */
    lastReveal: null,
  };

  const notify = () => {
    if (typeof onChange === 'function') {
      try { onChange(); } catch { /* 视图回调异常不影响状态 */ }
    }
  };

  /** 读：某根的加载条目（不存在返回 null，不隐式创建） */
  const rootEntry = (rootId) => state.loaded.get(String(rootId)) || null;

  /**
   * 跨根归并该组的角色树（内部实现，`setRootModels` 与公开动作 `rebuildChars` 共用一份）。
   *
   * 只收 `status === 'ready'` 的根：还在 loading / 已 error 的根不参与归并，
   *   否则半截数据会先被画出来（用户看到角色数忽多忽少）。
   * @param {string} groupKey
   */
  function rebuildCharsFor(groupKey) {
    const group = state.groups.find((g) => g.key === String(groupKey));
    if (!group) return null;
    const models = [];
    for (const root of group.roots) {
      const entry = state.loaded.get(root.id);
      if (entry && entry.status === 'ready') models.push(...(entry.models || []));
    }
    const built = buildChars(models, nameIndex, group.name);
    state.groupChars.set(group.key, built);
    return built;
  }

  const actions = {
    state,

    // ---------------------------------------------------------------- 根与游戏
    /**
     * 重建游戏列表（按 name 合并同名根）。
     * @param {Array} roots /api/roots 的 roots
     * @returns {Array} 合并后的 groups
     */
    setRoots(roots) {
      const byName = new Map();
      for (const root of Array.isArray(roots) ? roots : []) {
        const name = root.name || root.id;
        if (!byName.has(name)) byName.set(name, { key: `group:${name}`, name, roots: [] });
        byName.get(name).roots.push(root);
      }
      state.groups = [...byName.values()];
      notify();
      return state.groups;
    },

    /** 某根所属的游戏 */
    groupOfRoot(rootId) {
      return state.groups.find((g) => g.roots.some((r) => r.id === rootId)) || null;
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
     *
     * **写完自动重算该根所属组的角色树**（派生状态跟着源状态走）。
     *   为什么在这里而不是让调用方各自记得调 rebuildChars：调用方一多必然漏 ——
     *   实测过一次：restoreLast 那条路径漏了归并 ⇒ 加载完成后行上 0 角色、
     *   收起再展开才出现（第二次走的是另一条会归并的路径）。把重算钉在唯一的
     *   写入入口上，新增调用方就不可能再漏。
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
      // 就绪状态已落地，此刻归并才拿得到这份 models（rebuildChars 只收 status==='ready' 的根）
      const group = actions.groupOfRoot(id);
      if (group) rebuildCharsFor(group.key);
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

    setScanBaseline(groupKey, base) {
      state.scanBaseline.set(String(groupKey), base);
    },

    getScanBaseline(groupKey) {
      return state.scanBaseline.get(String(groupKey)) || null;
    },

    clearScanBaseline(groupKey) {
      state.scanBaseline.delete(String(groupKey));
    },

    // ---------------------------------------------------------------- 角色树
    /**
     * 用该组各根**已就绪**的模型重建角色树（跨根归并）。
     *
     * 正常流程里不需要手动调：`setRootModels` 写完就会自动重算（见那里的注释）。
     *   留成公开动作是为了"幂等兜底"：某些路径上模型早已就绪、本次没有新的写入
     *   （例如重复展开一个已加载的组），调用方仍可显式要求"确保已归并"。
     * @param {string} groupKey
     * @returns {object|null} { chars, stats }
     */
    rebuildChars(groupKey) {
      return rebuildCharsFor(groupKey);
    },

    // ---------------------------------------------------------------- 展开态
    toggleGroup(groupKey) {
      const key = String(groupKey);
      const next = !state.expandedGroups.has(key);
      if (next) state.expandedGroups.add(key); else state.expandedGroups.delete(key);
      return next;
    },

    expandGroup(groupKey) {
      state.expandedGroups.add(String(groupKey));
    },

    collapseAll() {
      state.expandedGroups.clear();
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
    restoreExpanded({ groups, chars }) {
      const keys = new Set(state.groups.map((g) => g.key));
      for (const key of groups || []) if (keys.has(key)) state.expandedGroups.add(key);
      for (const key of chars || []) state.expandedChars.add(key);
    },

    // ---------------------------------------------------------------- 选中 / 关键词 / 筛选
    /**
     * 写选中项。
     * @param {{modelId:string, groupKey:string, groupName:string|null, charKey:string}|null} payload
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

    // ---------------------------------------------------------------- 分组 / 订阅标记 / 探测 / 定位
    /**
     * 写"当前活跃分组"（分组名，不是 groupKey）。
     * @param {string|null} name
     */
    setActiveGroup(name) {
      state.activeGroup = name ? String(name) : null;
      notify();
    },

    /** 标记某根已订阅过进度流（防重复订阅） */
    markRootSubscribed(rootId) {
      state.scannedRoots.add(String(rootId));
    },

    unmarkRootSubscribed(rootId) {
      state.scannedRoots.delete(String(rootId));
    },

    hasRootSubscribed(rootId) {
      return state.scannedRoots.has(String(rootId));
    },

    /**
     * 写后台形态探测快照。
     * @param {{remaining:number|null, at:number, rootId:string|null}} snapshot
     */
    setProbe(snapshot) {
      state.probe = { ...(snapshot || {}) };
    },

    /** 写"最近一次定位结果"（reveal 的返回值，排障与断言读它） */
    setLastReveal(result) {
      state.lastReveal = result || null;
    },
  };

  return actions;
}
