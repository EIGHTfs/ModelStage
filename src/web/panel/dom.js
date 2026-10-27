// panel/dom.js —— 面板 DOM 小工具（view.js 与各控件渲染模块共用）
//
// 拆出来的原因：view.js 有行数上限，控件渲染要分模块；共用的三个小工具集中放这里，
//   避免各模块各写一份导致行为漂移。

// el 的唯一实现在 infra/dom.js；这里 re-export，本模块的 9 个 import 方无需改动。
//   判据是"函数体只有一份"，不是"文本只出现一次" —— 别再在这里加回一份实现。
export { el } from '../infra/dom.js';

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
