// roster/events.js —— 名册的 DOM 事件层（从 view.js 原样搬出：监听目标、分派规则、文案一字不改）
//
// 负责什么：
//   · 树行的事件委托（点击 + 键盘 Enter/空格，两者共用同一个 activate 分派）；
//   · 类型胶囊（点击 / 清除）、游戏行「加载失败·重试」、扫描状态行〔重试〕；
//   · 搜索框输入（含"首次输入补全量"）、「收起」按钮、用户滚动信号挂载。
//
// 不负责什么：DOM 结构与文案（render.js）、加载编排（load.js）、装配（view.js）。
// 依赖方向（单向）：store ← load ← events ← view。
//   load 提供"点开要加载"的动作，render 提供"改完重画"，本文件只做分派。

import { saveState, saveLastModel } from './persist.js';
import { fetchDisplayName, paintDisplayName } from './display-name.js';

/**
 * @param {object} deps 全部由 view 注入
 * @param {object} deps.store       名册 store（状态读写一律走它的动作）
 * @param {HTMLElement} deps.listEl 名册列表容器（树行的委托挂在这里）
 * @param {HTMLElement} deps.searchEl 搜索框
 * @param {HTMLElement} deps.collapseBtn 「收起」按钮
 * @param {HTMLElement|null} deps.typeFilterEl 类型胶囊行容器（null ⇒ 本功能整体不生效）
 * @param {object} deps.reveal      定位控制器（挂用户滚动信号 + 选中后定位）
 * @param {() => void} deps.render  立即整棵重绘
 * @param {object} deps.load        加载编排（loadGroup / retryScan / ensureGroupLoaded / ensureAllLoaded）
 * @param {Map} deps.modelById      modelId → { model, rootId }（选中后回调 onSelect 用）
 * @param {Function} [deps.onSelect] 选中变体后的回调（装载由调用方负责）
 */
export function createRosterEvents({
  store, listEl, searchEl, collapseBtn, typeFilterEl, reveal, render, load, modelById, onSelect,
}) {
  const state = store.state;

  /** 点一级：折叠/展开游戏（首次展开触发该游戏所有根的数据加载） */
  async function onGroupClick(groupKey) {
    if (state.expandedGroups.has(groupKey)) {
      store.toggleGroup(groupKey);
      render();
      saveState(state);
      return;
    }
    store.expandGroup(groupKey);
    // 先渲染一次：已加载过的游戏直接出角色行（ensureGroupLoaded 在无待加载根时不会单独渲染）
    render();
    const group = state.groups.find((g) => g.key === groupKey);
    if (group) await load.ensureGroupLoaded(group);
    saveState(state);
  }

  /** 点二级：折叠/展开角色（变体已在内存，不发请求） */
  function onCharClick(charKey) {
    store.toggleChar(charKey);
    render();
    saveState(state);
  }

  /** 点三级：选中变体（高亮 + 记录状态，M4 用它去渲染） */
  function onVariantClick(modelId, groupKey, charKey) {
    const group = state.groups.find((g) => g.key === groupKey);
    store.selectModel({ modelId, groupKey, groupName: group ? group.name : null, charKey });
    store.setActiveGroup(group ? group.name : state.activeGroup);
    // 记「上次所用模型」指针（rootId/kind/modelId）：下次冷启动只加载它所在的那一个根
    try { saveLastModel((modelById.get(modelId) || {}).model || null); } catch { /* 指针只是加速启动 */ }
    render();
    store.setLastReveal(reveal.revealActive()); // 选中后把这一行滚到可视区（已可见/用户正在滚都会跳过）
    saveState(state);
    // 选中时顺手取一次显示名（服务端命中缓存就不跑分析）。
    //   **不 await**：名字是展示态，晚到几百毫秒不影响装载；但绝不能因为等它而拖慢 onSelect。
    if (typeof onSelect === 'function') {
      const hit = modelById.get(modelId);
      void hydrateDisplayName(hit ? hit.model : null, charKey);
      // 把装载的 promise 交回调用方：冷启动要能等"首个模型真的出来"再放行后面的加载队列，
      //   否则队列的整根扫描和首个模型的资源请求会抢同一份磁盘 IO。
      return onSelect(hit ? hit.model : null);
    }
  }

  /** 事件委托：树行是动态生成的，统一在容器上监听一次 */
  /**
   * 取一次显示名并就地贴到列表上（不重建 chars）。
   *
   * 为什么只对选中项取：181 个包全量取名要 2~5 分钟，且大包会 OOM；用户实际只看少数几个。
   * 为什么失败不提示：名字是展示增强，取不到就保持文件名；弹错会把"列表能用"变成"每次点都弹错"。
   * 为什么改 DOM 而不是重画：重画会丢展开态、滚动位置和当前选中项。
   *
   * @param {object|null} model 选中的条目（catalog 里的那条）
   * @param {string} [charKey] 所属角色键（用于同时更新角色行标题）
   */
  async function hydrateDisplayName(model, charKey) {
    if (!model || !model.rootId || !model.rel) return;
    // 已有名字（缓存命中过、或插件当场给了）就不重复请求
    if (typeof model.displayName === 'string' && model.displayName.trim()) return;
    const name = await fetchDisplayName({ base: '', rootId: model.rootId, rel: model.rel });
    if (!name) return;
    model.displayName = name;   // 记在内存里：同一会话再点它不必再请求
    // 名字是**分组键的输入**（buildChars 优先用 displayName 分组），所以不能只改文本：
    //   只改文本的话分组结构、角色标题、别名都还是旧值 —— 表现为"刷新浏览器才正确"。
    // 重建会重算分组/标题/别名；展开态与选中项在 store 内按 model id 迁移。
    const group = state.groups.find((g) => g.roots.some((r) => r.id === model.rootId));
    let rebuilt = null;
    try {
      if (group && typeof store.rebuildCharsPreservingExpansion === 'function') {
        rebuilt = store.rebuildCharsPreservingExpansion(group.key);
      }
    } catch { rebuilt = null; }
    if (rebuilt) {
      render();   // 整组重画（展开态已迁移，滚动位置由 reveal 逻辑保持）
      return;
    }
    // 兜底：拿不到分组（或 store 不支持重建）时仍只改文本，保证名字能显示
    paintDisplayName(document, { modelId: model.id, charKey, displayName: name });
  }

  function bindEvents() {
    /** 按行的类型分派到对应动作（鼠标与键盘共用，避免两套逻辑走偏） */
    function activate(row) {
      if (row.dataset.modelId) {
        onVariantClick(row.dataset.modelId, row.dataset.groupKey, row.dataset.charKey);
      } else if (row.dataset.charKey) {
        onCharClick(row.dataset.charKey);
      } else if (row.dataset.groupKey) {
        onGroupClick(row.dataset.groupKey);
      }
    }

    // 用户滚动信号由 reveal 控制器统一挂（滚轮 / 触摸 / 指针 / 滚动条）
    reveal.attachUserScrollListeners();

    listEl.addEventListener('click', (e) => {
      const row = e.target.closest('[data-model-id], [data-char-key], [data-group-key]');
      if (row) activate(row);
    });

    // 键盘可达：树行带 tabindex="0"，Enter / 空格与点击等价
    listEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('[data-model-id], [data-char-key], [data-group-key]');
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

    // 游戏行的「加载失败 · 重试」：事件委托，且不能顺带折叠/展开这一行。
    //   「未加载 · 点击加载」按钮已经取消（改由加载队列自动推进），所以这里只处理重试。
    listEl.addEventListener('click', (event) => {
      const target = event.target && event.target.closest ? event.target.closest('[data-group-retry]') : null;
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      load.loadGroup(target.dataset.groupRetry, { reset: true });
    });

    // 扫描状态行上的〔重试〕：事件委托（行会被重建，逐个绑会漏）
    listEl.addEventListener('click', (event) => {
      const button = event.target && event.target.closest ? event.target.closest('[data-scan-retry]') : null;
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();     // 别让点重试顺带把游戏行折叠/展开
      load.retryScan(button.dataset.scanRetry);
    });

    searchEl.addEventListener('input', () => {
      store.setKeyword(searchEl.value);
      // 搜索要全局数据：首次输入时把所有游戏补上（之后都走缓存，不再请求）
      if (state.keyword && [...state.groupChars.keys()].length < state.groups.length) {
        load.ensureAllLoaded();
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

  return { bindEvents, onGroupClick, onCharClick, onVariantClick };
}
