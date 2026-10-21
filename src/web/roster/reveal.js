// roster/reveal.js —— 「定位当前角色」：把选中的那一行滚进可视区
//
// 三条纪律（F3）：
//   ① 行已可见就不动 —— 绝大多数选中都不需要滚，乱跳反而干扰阅读
//   ② 用户正在滚 / 刚滚过 SCROLL_IDLE_MS 内不滚 —— 绝不跟用户抢滚动位置
//   ③ 目标被折叠时不硬滚，先按"展开状态"把父级展开（渲染出这一行）再滚
//
// 为什么单独成模块：这段是纯"滚动策略"，与树的渲染/数据加载无关，拆开后 view.js 也能守住行数上限。

/** 用户停手多久之后才允许自动滚动（毫秒） */
export const SCROLL_IDLE_MS = 800;

/**
 * 创建定位控制器。
 * @param {{listEl: HTMLElement, getState: () => object, render: () => void}} deps
 *   getState 返回名册状态（expandedGames / expandedChars / selected）
 *   render   重新渲染整棵树（展开父级后需要它把目标行画出来）
 */
export function createReveal({ listEl, getState, render }) {
  // 自己触发的 scrollIntoView 也会派发 scroll 事件：用它区分"用户的滚"与"我们的滚"
  let autoScrollUntil = 0;
  let lastUserScrollAt = 0;

  /** 记录一次"用户滚动"（程序触发的滚动不计） */
  function markUserScroll() {
    if (Date.now() < autoScrollUntil) return;
    lastUserScrollAt = Date.now();
  }

  /** 挂上用户滚动信号：滚轮 / 触摸 / 指针按下 / 滚动条拖动（scroll 事件同时覆盖键盘与拖滚动条） */
  function attachUserScrollListeners() {
    listEl.addEventListener('scroll', markUserScroll, { passive: true });
    listEl.addEventListener('wheel', markUserScroll, { passive: true });
    listEl.addEventListener('touchstart', markUserScroll, { passive: true });
    listEl.addEventListener('pointerdown', markUserScroll, { passive: true });
  }

  /**
   * 把当前选中的变体行滚进可视区。
   * @returns {'visible'|'scrolled'|'skipped-user-scrolling'|'no-selection'|'no-row'}
   *   visible：本来就在可视区，没动；skipped-user-scrolling：用户正在滚，主动让位
   */
  function revealActive() {
    const state = getState();
    const selected = state && state.selected;
    if (!selected || !selected.modelId) return 'no-selection';
    // ③ 折叠时先展开父级：没渲染出这一行，后面也就无从滚起
    let expanded = false;
    if (selected.gameKey && !state.expandedGames.has(selected.gameKey)) {
      state.expandedGames.add(selected.gameKey);
      expanded = true;
    }
    if (selected.charKey && !state.expandedChars.has(selected.charKey)) {
      state.expandedChars.add(selected.charKey);
      expanded = true;
    }
    if (expanded) render();
    // 按 dataset 值逐个比对：模型 id 里可能有引号等字符，拼选择器不可靠
    const row = [...listEl.querySelectorAll('[data-model-id]')]
      .find((node) => node.dataset.modelId === selected.modelId);
    if (!row) return 'no-row';
    const box = listEl.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top >= box.top - 1 && r.bottom <= box.bottom + 1) return 'visible'; // ① 已可见
    if (Date.now() - lastUserScrollAt < SCROLL_IDLE_MS) return 'skipped-user-scrolling'; // ② 不抢
    autoScrollUntil = Date.now() + 300;
    row.scrollIntoView({ block: 'nearest' });
    return 'scrolled';
  }

  /** 只读：最近一次用户滚动距今毫秒（断言用） */
  function sinceUserScroll() {
    return Date.now() - lastUserScrollAt;
  }

  return { revealActive, markUserScroll, attachUserScrollListeners, sinceUserScroll };
}
