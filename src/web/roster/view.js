// roster-view.js —— 名册视图层（M2）：三级树（游戏 → 角色 → 变体）+ 搜索 + 选中态
//
// 本文件只做**装配**（拆分后）：store.js = 名册唯一状态持有者；load.js = 加载编排；render.js = 渲染；
//   events.js = DOM 事件。依赖方向（单向，无环）：store ← load ← render/events ← view。
// 产品行为（与拆分前一致）：① 一级按资源根 name 合并成游戏节点（同名根合并，展开时才请求模型）；
//   ② 二级角色跨根归并（同一角色多根模型归到一个节点，不是把各根的行拼起来）；
//   ③ 三级变体带类型标签（Spine / Live2D / 资源包）与来源根 id；④ 搜索是前端过滤，命中即展开到变体层；
//   ⑤ 选中态写 localStorage（键名沿用既有，字段用 group 口径）；⑥ 顶部「收起」只清空展开状态，面板本身保留。

import { createReveal } from './reveal.js';
import { snapshotRoster } from './snapshot.js';
import { createRosterStore } from './store.js';
import { readSaved, saveState, readLastModel, saveLastModel } from './persist.js';
import { createNameIndex, buildChars } from './list.js';
import { applyEntryState } from './rows.js';
import { createScheduler } from '../infra/schedule.js';
import { createRosterLoad } from './load.js';
import { createRosterRender } from './render.js';
import { createRosterEvents } from './events.js';

/** 创建名册视图并挂到容器上；返回对外 API（供 main.js 与自动化验证使用） */
export function createRosterView({ listEl, countEl, searchEl, collapseBtn, onSelect }) {
  // 类型胶囊行：容器由 index.html 提供（#roster-type-filter）；取不到（旧页面/单测）就整体降级为"没有类型筛选"
  const typeFilterEl = typeof document !== 'undefined' ? document.getElementById('roster-type-filter') : null;

  /** 调试计数器（纯计量，只做 ++）：首屏渲染次数是"每个根各触发一次全树 render"的直接指标，优化前后同口径对比 */
  const counters = { render: 0, ensureRootLoaded: 0, renderScheduled: 0 };

  // 渲染调度（rAF 合批 + 后台标签页兜底）：三条性质与"为什么"见 infra/schedule.js 文件头
  const scheduler = createScheduler(() => render(), { onRequest: () => { counters.renderScheduled += 1; } });
  const scheduleRender = scheduler.request;
  const flushRender = scheduler.flush;

  // 名表索引（跨根共用一份）：store 写完 models 要自动重算角色树，归并时也要用它 ⇒ 先于 store 建
  const nameIndex = createNameIndex();
  // 名册状态由 store 统一持有（**唯一可写者**）；view 只读 state、通过动作改
  const store = createRosterStore({ buildChars, nameIndex, onChange: () => scheduleRender() });
  const state = store.state;
  // 定位控制器：把"选中后滚到可见"的策略外置（见 roster/reveal.js）
  const reveal = createReveal({ listEl, getState: () => state, render: () => render() });

  // 名册持有的模型对象（渲染与选中都读它，跨模块共用同一份引用）
  const namesLoaded = new Set();
  const modelById = new Map();

  // ------------------------------------------------------------ 模块装配
  // store/reveal 只持有"延迟调用"的引用（() => render()），能写在渲染模块前面；render 用函数声明避免 TDZ。
  // render 转调渲染模块（四处装配行都通过它拿最新实现）；snapshot 的投影逻辑在 roster/snapshot.js。
  function render() { return renderModule.render(); }
  function snapshot() { return snapshotRoster({ state, listEl, groupStatus: renderModule.groupStatus }); }

  const renderModule = createRosterRender({
    store, counters, listEl, countEl, typeFilterEl,
    snapshotOf: () => snapshot(),
  });

  const load = createRosterLoad({
    store, counters, nameIndex, namesLoaded, modelById,
    render, scheduleRender, flushRender,
    rebuildGroupChars: renderModule.rebuildGroupChars,
    aggregateScan: renderModule.aggregateScan,
    applyScanStatusToRow: renderModule.applyScanStatusToRow,
  });

  const events = createRosterEvents({
    store, listEl, searchEl, collapseBtn, typeFilterEl, reveal, render, load, modelById, onSelect,
  });

  /**
   * 初始化：把资源根按 name 合并成游戏 → 渲染（不加载任何模型，等用户展开）
   * @param {{restoreExpanded?: boolean}} opts restoreExpanded=false 时不恢复任何展开态
   */
  function mount(roots, opts) {
    const restoreExpanded = !opts || opts.restoreExpanded !== false;
    store.setTypeFilter([]);          // 类型筛选不持久化：每次打开都是不筛选（当次会话内的临时动作）
    store.setRoots(roots);            // 同名根合并成游戏节点：规则收在 store.setRoots
    const saved = readSaved();
    if (restoreExpanded) {
      // 展开状态恢复：只恢复仍存在的游戏，避免历史配置残留导致空节点
      store.restoreExpanded({ groups: saved.groups, chars: saved.chars });
      store.setActiveGroup(saved.activeGroup);   // 存储字段与内存同名（activeGroup）
    }
    events.bindEvents();
    render();
    // **不再**在启动时把"上次展开的游戏"全部加载：那等于页面一开就把所有资源根拉一遍（每根一次全量扫描，
    //   串行排队 ⇒ 后面的必然超时）。恢复的展开态只保留视觉状态，数据等用户点这一行时再取。
  }

  /** 某组是否已归并出角色（判据是"真有 chars"，不是"根有 models"） */
  function hasGroupChars(group) {
    const entry = state.groupChars.get(group.key);
    return !!(entry && Array.isArray(entry.chars) && entry.chars.length);
  }

  /** 在某游戏已加载的角色里找该变体，命中返回 { charKey, variant }（变体对象形如 { model, nm }） */
  function findVariant(group, modelId) {
    const entry = state.groupChars.get(group.key);
    if (!entry) return null;
    for (const c of entry.chars) {
      const v = c.variants.find((x) => x.model && x.model.id === modelId);
      if (v) return { charKey: c.key, variant: v };
    }
    return null;
  }

  /**
   * 把左栏树**从上到下**摊平成变体序列（翻页的池子就是它）。用树自己的数据结构（含同名根合并、含排序）
   *   作唯一真相源 —— 外部按单 rootId 取清单会漏掉同名的另外几个根。
   * @returns {Promise<Array<{model:object, groupKey:string, charKey:string}>>}
   */
  async function listVariants() {
    const out = [];
    for (const group of state.groups) {
      if (state.expandedGroups && !state.expandedGroups.size) { /* 未展开也要能翻：下面统一加载 */ }
      // 目标游戏可能还没加载（用户没展开过）：按需加载一次，保证序列完整
      if (!state.groupChars.get(group.key)) {
        try { await load.ensureGroupLoaded(group); } catch { continue; }
      }
      const entry = state.groupChars.get(group.key);
      if (!entry) continue;
      for (const c of entry.chars) {
        for (const v of c.variants) {
          if (v && v.model && v.model.id) out.push({ model: v.model, groupKey: group.key, charKey: c.key });
        }
      }
    }
    return out;
  }

  /**
   * 取某个变体的**兄弟变体**（同一角色/同一 charKey 下的全部变体）。
   * @returns {Promise<Array<{model:object, groupKey:string, charKey:string}>>}
   */
  async function variantsOf(modelId) {
    for (const group of state.groups) {
      if (!state.groupChars.get(group.key)) {
        try { await load.ensureGroupLoaded(group); } catch { continue; }
      }
      const entry = state.groupChars.get(group.key);
      if (!entry) continue;
      for (const c of entry.chars) {
        const hit = c.variants.some((v) => v && v.model && v.model.id === modelId);
        if (hit) return c.variants.filter((v) => v && v.model).map((v) => ({ model: v.model, groupKey: group.key, charKey: c.key }));
      }
    }
    return [];
  }

  /**
   * 按 modelId 选中某个变体并同步左栏（**外部入口专用**：上/下一个、快捷键等只调装载、不碰左栏，
   *   树上高亮就会停在上一个模型）。不触发 onSelect：装载由调用方统一入口负责，避免切换装载两遍。
   * @param {{reveal?: boolean}} [opts] reveal=false 时不滚动定位（默认滚到可视区）
   * @returns {Promise<{ok:boolean, groupKey?:string, charKey?:string, reason?:string}>}
   */
  async function selectById(modelId, opts = {}) {
    if (!modelId) return { ok: false, reason: 'no-id' };
    for (const group of state.groups) {
      // 目标可能属于还没展开/加载的游戏：按需加载一次（与启动恢复同策略，不预取全部）
      if (!state.groupChars.get(group.key)) {
        try { await load.ensureGroupLoaded(group); } catch { continue; }
      }
      const hit = findVariant(group, modelId);
      if (!hit) continue;
      store.selectModel({ modelId, groupKey: group.key, groupName: group.name, charKey: hit.charKey });
      store.setActiveGroup(group.name);
      try { saveLastModel(hit.variant && hit.variant.model ? hit.variant.model : null); } catch { /* 忽略 */ }
      // 不展开的话目标行根本没渲染出来，高亮也就无从显示
      store.expandGroup(group.key);
      store.expandChar(hit.charKey);
      render();
      if (opts.reveal !== false) store.setLastReveal(reveal.revealActive());
      saveState(state);
      return { ok: true, groupKey: group.key, charKey: hit.charKey };
    }
    return { ok: false, reason: 'not-found' };
  }

  /**
   * 启动恢复：按存档把上次选中的变体重新选中并渲染。找不到 ⇒ 安静回落空舞台（不展开、不报错、不留半选中）
   * @returns {Promise<{restored: boolean, modelId?: string, reason?: string}>}
   */
  async function restoreLast() {
    // 冷启动加载策略（唯一允许的启动加载）：读「上次所用模型」指针 → **只加载它所在的那一个根**
    //   → 展开并定位到它。没有指针 ⇒ 一个根都不扫；有指针但失败 ⇒ 该行显示「加载失败 · 重试」。
    const pointer = readLastModel();
    if (!pointer) return { restored: false, reason: 'no-pointer' };

    const group = state.groups.find((g) => g.roots.some((r) => r.id === pointer.rootId));
    if (!group) return { restored: false, reason: 'root-gone', rootId: pointer.rootId };
    const root = group.roots.find((r) => r.id === pointer.rootId);

    try {
      await load.ensureRootLoaded(root);         // 只有这一个根（1 次 catalog + 1 条进度流）
    } catch {
      return { restored: false, reason: 'load-failed', rootId: pointer.rootId };
    }
    // 归并判据是"**groupChars 里该组真有 chars**"，不是"根有 models"：
    //   根就绪 ≠ 角色树已归并（归并是另一件事，任何一条路径漏了它都会让下面 findVariant
    //   误判成 model-gone —— 表现就是"加载完成后 0 角色、收起再展开才出现"）。
    //   正常情况下 setRootModels 已经自动归并过，这里只是一次幂等兜底。
    if (!hasGroupChars(group)) renderModule.rebuildGroupChars(group);
    store.expandGroup(group.key);

    const hit = findVariant(group, pointer.modelId);
    if (!hit) {
      render();
      saveState(state);
      return { restored: false, reason: 'model-gone', rootId: pointer.rootId };
    }
    store.expandChar(hit.charKey);
    // 关键：复用"用户点击变体"的同一入口 —— 它写入选中态、存盘，并调用 onSelect 真正装载模型。
    //   只设置 state.selected + render() 是不够的：那只是"列表里高亮"，画布上什么都不会出现。
    events.onVariantClick(pointer.modelId, group.key, hit.charKey);
    store.setLastReveal(reveal.revealActive());
    return { restored: true, modelId: pointer.modelId, rootId: pointer.rootId, groupKey: group.key };
  }

  /**
   * 把服务端的三字段写回名册条目并就地重画那一行（契约 §一 INV-D1 的前端落点）。
   * 为什么"写回对象"和"刷 DOM"都要做（只刷 DOM 就是之前那个 bug）：DOM 是一次性快照，render() 每次都用
   *   条目对象重画 ⇒ 只改 DOM 的话，任一次重渲染又把旧值画回来（"马上变回中性色"）。
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
    mount, state, snapshot, render, ensureGroupLoaded: load.ensureGroupLoaded, selectById, listVariants, variantsOf,
    setEntryState,
    restoreLast,
    revealActive: reveal.revealActive,
    markUserScroll: reveal.markUserScroll,
    /** 调试计数（渲染/加载次数）：优化前后用同一口径对比 */
    counters: () => ({ ...counters }),
    /** 名册加载计时快照（`window.__WEB__.rosterStats()` 用它；口径见 load.js） */
    rosterStats: load.rosterStats,
    /** 立刻落地待渲染的请求（测试/自检用：不依赖 rAF 时机） */
    flushRender,
    /** 归零计数（测量前调用，避免把上一段的调用混进来） */
    resetCounters: () => { counters.render = 0; counters.ensureRootLoaded = 0; counters.renderScheduled = 0; },
  };
}
