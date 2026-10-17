// panel/dom.js —— 面板 DOM 小工具（view.js 与各控件渲染模块共用）
//
// 拆出来的原因：view.js 有行数上限，控件渲染要分模块；共用的三个小工具集中放这里，
//   避免各模块各写一份导致行为漂移。

/** 建元素：tag + class + 文本 */
export function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/** 未接线标记（data-pending + 可选 id） */
export function markPending(node, id) {
  node.dataset.pending = 'true';
  if (id) node.id = id;
  return node;
}

/**
 * 标成不可点控件，并区分两种原因：
 *   · 能力不支持（schema 过滤给了 reason）→ 写 reason，不打"待接线"
 *   · 未接线 → data-pending + 统一的 pending 文案
 * @param {HTMLElement} node
 * @param {object} ctl 控件定义
 * @param {{disabledReason?: Function}} ctx
 */
export function markDisabled(node, ctl, ctx) {
  node.disabled = true;
  const reason = ctx && ctx.disabledReason ? ctx.disabledReason(ctl.id) : null;
  if (reason) {
    node.title = `${reason}：${ctl.label || ''}`.trim();
    node.dataset.disabledReason = reason; // 便于断言与排查
    return;
  }
  markPending(node, null);
  node.title = '待接线（M6）';
}
