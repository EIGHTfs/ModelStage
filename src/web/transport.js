// transport.js —— 底部播放条渲染（M3：控件齐全、未接线一律 disabled）
//
// 做什么：按 panel-schema.js 的 TRANSPORT_CONTROLS 渲染播放条上的 8 个控件。
// 为什么和面板分文件：两者由不同里程碑接线（面板 M6、播放条 M4/M6），
//   而且播放条控件少、结构简单，独立后 panel.js 不会因为"顺带"而膨胀。
//
// M3 边界：所有控件 disabled + data-pending="true"（铁律 1：不允许看着能点却没反应）。

import { TRANSPORT_CONTROLS } from './panel-schema.js';

/** 元素工厂 */
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/** 统一打死"未接线"标记 */
function markPending(node, id, title) {
  node.dataset.pending = 'true';
  if (id) node.id = id;
  node.disabled = true;
  node.title = `${title || '待接线'}（M6 接线）`;
  return node;
}

/** 单个控件（按钮 / 下拉） */
function renderControl(ctl) {
  if (ctl.kind === 'select') {
    const sel = document.createElement('select');
    sel.className = 'transport-select';
    markPending(sel, ctl.id, ctl.title || ctl.label);
    for (const opt of ctl.options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      sel.append(o);
    }
    sel.value = ctl.value || ctl.options[0];
    sel.setAttribute('aria-label', ctl.label);
    return sel;
  }
  const btn = el('button', 'mini-btn', ctl.label);
  btn.type = 'button';
  markPending(btn, ctl.id, ctl.title || ctl.label);
  return btn;
}

/**
 * 把播放条内容挂到 footer 容器里（容器本身在 index.html，负责定位）。
 * @param {HTMLElement} footerEl
 * @returns {{controls: number}}
 */
export function mountTransport(footerEl) {
  footerEl.replaceChildren();

  // 分三组摆位，与旧前端一致：左（循环/上一个）· 中（皮肤/播放/动作）· 右（下一个/重置/背景）
  const groups = [
    ['transport-loop', 'transport-prev'],
    ['transport-skin', 'transport-play', 'transport-motion'],
    ['transport-next', 'transport-reset-view', 'transport-bg'],
  ];
  const byId = new Map(TRANSPORT_CONTROLS.map((c) => [c.id, c]));

  for (const ids of groups) {
    const box = el('div', 'transport-group');
    for (const id of ids) {
      const ctl = byId.get(id);
      if (ctl) box.append(renderControl(ctl));
    }
    footerEl.append(box);
  }

  return { controls: footerEl.querySelectorAll('button, select').length };
}
