// transport.js —— 底部播放条渲染与接线
//
// 做什么：按 panel-schema.js 的 TRANSPORT_CONTROLS 渲染播放条上的 8 个控件，
//   并把调用方提供了 handler 的控件接上线；没提供 handler 的保持 disabled + data-pending。
// 铁律：不允许"看着能点却没反应"——只有 handler 存在的控件才会被解锁。
//
// 动态选项：动作/皮肤下拉的选项由模型数据填充（setOptions），渲染时的 options 只是占位文案。

import { TRANSPORT_CONTROLS } from './panel/schema.js';

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

/** 解锁控件：去掉 pending 与 disabled，换上真实提示 */
function unwirePending(node, title) {
  delete node.dataset.pending;
  node.disabled = false;
  node.title = title || '';
  return node;
}

/** 单个控件（按钮 / 下拉） */
function renderControl(ctl) {
  if (ctl.kind === 'select') {
    const sel = document.createElement('select');
    sel.className = 'transport-select';
    markPending(sel, ctl.id, ctl.title || ctl.label);
    for (const opt of ctl.options || []) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      sel.append(o);
    }
    sel.value = ctl.value || (ctl.options && ctl.options[0]) || '';
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
 * @param {Record<string, Function>} handlers 控件 id → 回调（存在即视为已接线）
 * @returns {{
 *   controls: number,
 *   wired: string[],
 *   setOptions: (id: string, options: Array<{text:string,value:string}>, value?: string) => boolean,
 *   setPressed: (id: string, on: boolean) => void,
 *   setSelectValue: (id: string, value: string) => void,
 *   pressed: (id: string) => boolean|null,
 * }} 播放条能力
 */
export function mountTransport(footerEl, handlers = {}) {
  footerEl.replaceChildren();

  // 分三组摆位，与旧前端一致：左（循环/上一个）· 中（皮肤/播放/动作）· 右（下一个/重置/背景）
  const groups = [
    ['transport-loop', 'transport-prev'],
    ['transport-skin', 'transport-play', 'transport-motion'],
    ['transport-next', 'transport-reset-view', 'transport-bg'],
  ];
  const byId = new Map(TRANSPORT_CONTROLS.map((c) => [c.id, c]));
  const nodes = new Map();

  for (const ids of groups) {
    const box = el('div', 'transport-group');
    for (const id of ids) {
      const ctl = byId.get(id);
      if (!ctl) continue;
      const node = renderControl(ctl);
      nodes.set(id, node);
      box.append(node);
    }
    footerEl.append(box);
  }

  // 接线：只有提供 handler 的控件才解锁
  const wired = [];
  for (const [id, node] of nodes) {
    const handler = handlers[id];
    if (typeof handler !== 'function') continue;
    const ctl = byId.get(id);
    unwirePending(node, ctl ? (ctl.title || ctl.label) : '');
    if (node.tagName === 'SELECT') {
      node.addEventListener('change', () => {
        try { handler(node.value); } catch { /* 回调失败保持当前选择 */ }
      });
    } else {
      node.addEventListener('click', () => {
        try { handler(); } catch { /* 回调失败不改状态 */ }
      });
    }
    wired.push(id);
  }

  /** 重建下拉选项（动作/皮肤在模型加载后填充） */
  function setOptions(id, options, value) {
    const node = nodes.get(id);
    if (!node || node.tagName !== 'SELECT' || !Array.isArray(options)) return false;
    node.replaceChildren();
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.text;
      node.append(o);
    }
    if (typeof value === 'string') node.value = value;
    node.dataset.filled = String(options.length);
    return true;
  }

  /** 按钮按下态（单动循环/播放暂停这类开关型按钮） */
  function setPressed(id, on) {
    const node = nodes.get(id);
    if (!node) return;
    node.setAttribute('aria-pressed', String(!!on));
  }

  /** 下拉当前值（不再触发回调） */
  function setSelectValue(id, value) {
    const node = nodes.get(id);
    if (node && node.tagName === 'SELECT' && typeof value === 'string') node.value = value;
  }

  /** 读按钮按下态 */
  function pressed(id) {
    const node = nodes.get(id);
    return node ? node.getAttribute('aria-pressed') === 'true' : null;
  }

  return {
    controls: footerEl.querySelectorAll('button, select').length,
    wired,
    setOptions,
    setPressed,
    setSelectValue,
    pressed,
  };
}
