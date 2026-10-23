// transport.js —— 底部播放条渲染与接线
//
// 做什么：按 panel-schema.js 的 TRANSPORT_CONTROLS 渲染播放条上的 8 个控件，
//   并把调用方提供了 handler 的控件接上线；没提供 handler 的保持 disabled + data-pending。
// 铁律：不允许"看着能点却没反应"——只有 handler 存在的控件才会被解锁。
//
// 动态选项：动作/皮肤下拉的选项由模型数据填充（setOptions），渲染时的 options 只是占位文案。

import { TRANSPORT_CONTROLS } from './schema.js';

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
  // 自绘下拉：返回 {root, setOptions...} 句柄由调用方登记（不在这里建，避免丢句柄）
  if (ctl.custom === 'picker') return null;
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
  // 文字放进独立 span：播放/暂停按钮的文字要能随状态换（图标与文字必须同义）
  const btn = el('button', 'mini-btn');
  btn.append(el('span', 'btn-label', ctl.label));
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
/**
 * 播放/暂停按钮的双态图标（lucide Play / Pause 的 path 原文）。
 * 语义同 8803：**播放中显示"暂停"图标**（点它=暂停），暂停后显示"播放"三角。
 */
const PLAY_ICONS = {
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
};

/**
 * 图标对应的文案（与图标同义：写的是"点它会做什么"，不是"当前是什么状态"）。
 * 播放中 → 图标是暂停符号 → 文案「暂停」；已暂停 → 图标是三角 → 文案「播放」。
 * 两者必须同源派生，否则会出现"图标说暂停、tooltip 说播放/暂停"的错位。
 */
const PLAY_LABELS = { play: '播放', pause: '暂停' };

/** 底栏按钮图标（内联 SVG，与顶栏同一套线条风格；不引图标库） */
const ICONS = {
  'transport-prev': '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>',
  'transport-play': '<polygon points="6 3 20 12 6 21 6 3"/>',
  'transport-next': '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>',
  'transport-reset-view': '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/>',
  'transport-bg': '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  'transport-skin': '<path d="M12 2 4 6v6c0 5 3.4 9.4 8 10 4.6-.6 8-5 8-10V6l-8-4z"/>',
  'transport-motion': '<circle cx="12" cy="12" r="9"/><polygon points="10 8 16 12 10 16 10 8"/>',
};

/**
 * 自绘下拉的键盘语义（WAI-ARIA combobox 惯用法）：
 *   Esc      关闭并把焦点还给触发按钮
 *   ↑/↓      打开（若关闭）或移动高亮
 *   Enter/空格 确认当前高亮项并关闭
 * 抽成模块级函数是为了让 createPicker 本体保持可读（单函数长度门禁）。
 * @param {KeyboardEvent} ev
 * @param {{isOpen:Function, open:Function, close:Function, count:Function,
 *          activeIndex:Function, setActive:Function, pickActive:Function}} api
 */
/**
 * 按选项清单重建列表项（纯 DOM 构建，便于测试与复用）。
 * @param {Array<{text:string,value:string}>} options
 * @param {(value:string) => void} onPickItem 点某项时回调
 * @param {HTMLElement} list 目标 <ul>
 * @returns {Array<{value:string, text:string, node:HTMLLIElement}>}
 */
function buildPickerItems(options, onPickItem, list) {
  list.replaceChildren();
  const items = [];
  for (const opt of options || []) {
    const li = el('li', 'transport-picker-item', opt.text);
    li.setAttribute('role', 'option');
    li.dataset.value = String(opt.value);
    li.tabIndex = -1;
    li.addEventListener('click', () => onPickItem(String(opt.value)));
    items.push({ value: String(opt.value), text: opt.text, node: li });
    list.append(li);
  }
  return items;
}

function handlePickerKey(ev, api) {
  const key = ev.key;
  if (key === 'Escape') { if (api.isOpen()) { api.close(); ev.preventDefault(); } return; }
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    if (!api.isOpen()) { api.open(); ev.preventDefault(); return; }
    const step = key === 'ArrowDown' ? 1 : -1;
    const next = Math.max(0, Math.min(api.count() - 1, (api.activeIndex() < 0 ? 0 : api.activeIndex()) + step));
    api.setActive(next);
    ev.preventDefault();
    return;
  }
  if (key === 'Enter' || key === ' ') {
    if (!api.isOpen()) return;
    api.pickActive();
    ev.preventDefault();
  }
}

/**
 * 自绘下拉（替代原生 <select>）：触发按钮 + 弹出列表。
 *
 * 为什么不用原生 select：视觉无法与新端设计语言统一（旧端的动作/皮肤也是自绘面板），
 *   而且原生 select 的键盘行为在各浏览器不一致，无法保证"上下键移动高亮、Esc 关闭并回焦"。
 *
 * 结构（无障碍语义照 WAI-ARIA combobox/listbox）：
 *   .transport-picker[data-ctl]
 *     button.transport-picker-btn[aria-haspopup=listbox][aria-expanded]
 *       span.picker-label（显示当前项文案）+ svg chevron
 *     ul.transport-picker-list[role=listbox] > li[role=option][aria-selected]
 *
 * @param {{id:string, label:string, title?:string, options:Array<{text:string,value:string}>, value:string}} ctl
 * @param {(value:string) => void} onPick 选中回调（只有真实选中才触发，与原生 select 的 change 同义）
 */
function createPicker(ctl, onPick) {
  const root = el('div', 'transport-picker');
  root.dataset.ctl = ctl.id;
  const btn = el('button', 'transport-picker-btn');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', ctl.label || '选择');
  if (ctl.title) btn.title = ctl.title;
  const labelEl = el('span', 'picker-label', '');
  btn.append(labelEl);
  const list = el('ul', 'transport-picker-list');
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  root.append(btn, list);

  let items = [];
  let activeIndex = -1;
  let current = ctl.value || '';

  /** 更新触发按钮上的文案 */
  function paintLabel() {
    const hit = items.find((it) => it.value === current);
    labelEl.textContent = hit ? hit.text : (items[0] ? items[0].text : '');
  }

  /** 高亮某一项（-1 = 不高亮） */
  function paintActive() {
    items.forEach((it, i) => {
      it.node.classList.toggle('is-active', i === activeIndex);
      it.node.setAttribute('aria-selected', String(it.value === current));
    });
  }

  function close(returnFocus = false) {
    if (list.hidden) return;
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    root.classList.remove('is-open');
    activeIndex = -1;
    paintActive();
    if (returnFocus) { try { btn.focus(); } catch { /* 忽略 */ } }
  }

  function open() {
    // 影院模式下底栏整体被收起，不自作主张弹出
    if (document.documentElement.dataset.cinema === 'on') return;
    list.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    root.classList.add('is-open');
    const cur = items.findIndex((it) => it.value === current);
    activeIndex = cur >= 0 ? cur : 0;
    paintActive();
    try { (items[activeIndex] || {}).node.focus(); } catch { /* 忽略 */ }
  }

  /** 选中（真实选择）：更新显示 + 通知调用方（与原生 change 一致，不重复触发同值） */
  function pick(value, { silent = false } = {}) {
    const hit = items.find((it) => it.value === value);
    if (!hit) return false;
    const changed = value !== current;
    current = value;
    paintLabel();
    paintActive();
    if (!silent && changed) onPick(value);
    return true;
  }

  /** 重建选项（换模型/换面时调用）：建行细节在模块级 buildPickerItems */
  function setOptions(next, value) {
    items = buildPickerItems(next, (v) => { pick(v); close(true); }, list);
    if (typeof value === 'string') current = value;
    if (!items.some((it) => it.value === current)) current = items[0] ? items[0].value : '';
    paintLabel();
    paintActive();
    return items.length;
  }

  // 触发按钮：点击开合
  btn.addEventListener('click', () => { if (list.hidden) open(); else close(); });
  // 键盘：↓/↑ 移动高亮、Enter 确认、Esc 关闭并回焦（逻辑在模块级 handlePickerKey）
  root.addEventListener('keydown', (ev) => handlePickerKey(ev, {
    isOpen: () => !list.hidden,
    open,
    close: () => close(true),
    count: () => items.length,
    activeIndex: () => activeIndex,
    setActive: (i) => { activeIndex = i; paintActive(); try { (items[i] || {}).node.focus(); } catch { /* 忽略 */ } },
    pickActive: () => { const hit = items[activeIndex]; if (hit) { pick(hit.value); close(true); } },
  }));
  // 点外部收起
  document.addEventListener('click', (ev) => { if (!root.contains(ev.target)) close(); });

  setOptions(ctl.options && ctl.options.length
    ? ctl.options.map((o) => (typeof o === 'string' ? { text: o, value: o } : o))
    : [], current);

  return {
    root,
    setOptions,
    setValue: (v) => { current = String(v); paintLabel(); paintActive(); },
    open,
    close: () => close(false),
    isOpen: () => !list.hidden,
    value: () => current,
  };
}

/** 给按钮前置一个图标（非按钮/未配图标则原样返回） */
function withIcon(node, id) {
  const body = ICONS[id];
  if (!body || !node || node.tagName !== 'BUTTON') return node;
  const wrap = document.createElement('span');
  wrap.className = 'btn-icon';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  node.prepend(wrap);
  node.classList.add('has-icon');
  return node;
}

export function mountTransport(footerEl, handlers = {}) {
  footerEl.replaceChildren();

  // 分三组摆位，与旧前端一致：左（循环/上一个）· 中（皮肤/播放/动作）· 右（下一个/重置/背景）
  const groups = [
    ['transport-prev'],
    ['transport-skin', 'transport-play', 'transport-motion'],
    ['transport-next', 'transport-reset-view', 'transport-bg'],
  ];
  const byId = new Map(TRANSPORT_CONTROLS.map((c) => [c.id, c]));
  const nodes = new Map();
  /** 自绘下拉的句柄（id → picker），setOptions/setSelectValue 走它 */
  const pickers = new Map();

  for (const ids of groups) {
    const box = el('div', 'transport-group');
    for (const id of ids) {
      const ctl = byId.get(id);
      if (!ctl) continue;
      if (ctl.custom === 'picker') {
        // 自绘下拉：回调直接接到 handlers[id]（与原生 select 的 change 同义）
        const picker = createPicker(
          { ...ctl, options: (ctl.options || []).map((o) => (typeof o === 'string' ? { text: o, value: o } : o)) },
          (value) => {
            const h = handlers[id];
            if (typeof h !== 'function') { document.documentElement.dataset.pickerError = `no-handler:${id}`; return; }
            try {
              h(value);
              document.documentElement.dataset.pickerError = '';
            } catch (err) {
              // 不再静默：把错误留痕，验收脚本可读（选择本身已更新，不至于"点了没反应"却查不出原因）
              document.documentElement.dataset.pickerError = String((err && err.message) || err);
            }
          },
        );
        pickers.set(id, picker);
        nodes.set(id, picker.root);
        box.append(picker.root);
        continue;
      }
      const node = withIcon(renderControl(ctl), id);
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
    if (pickers.has(id)) { wired.push(id); continue; }   // picker 的选中回调已在构造时接好
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
    const pk = pickers.get(id);
    if (pk) return pk.setOptions(options, value) > 0;
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

  /** 按钮按下态（播放暂停这类开关型按钮） */
  /**
   * 换图标（仅播放/暂停这种双态按钮用）：清空 svg 子节点后写入新 path。
   * 图标与 aria-pressed 一起由 app 层同一份状态派生，面板不自己判断播放状态。
   * @param {string} id 控件 id
   * @param {'play'|'pause'} name 变体名
   */
  function setIcon(id, name) {
    const node = nodes.get(id);
    const body = PLAY_ICONS[name];
    if (!node || !body) return false;
    const svg = node.querySelector('svg');
    if (!svg) return false;
    svg.innerHTML = body;   // 与 withIcon 同一套包装，只换 path 内容
    const label = PLAY_LABELS[name];
    if (label) {
      node.title = label;                          // tooltip：点了会发生什么
      node.setAttribute('aria-label', label);       // 无障碍名与之一致
      const text = node.querySelector('.btn-label');
      if (text) text.textContent = label;           // 按钮上的可见文字同源（否则会"图标变、文字不动"）
    }
    return true;
  }

  function setPressed(id, on) {
    const node = nodes.get(id);
    if (!node) return;
    node.setAttribute('aria-pressed', String(!!on));
  }

  /** 下拉当前值（不再触发回调） */
  function setSelectValue(id, value) {
    const pk = pickers.get(id);
    if (pk) { pk.setValue(value); return; }
    const node = nodes.get(id);
    if (node && node.tagName === 'SELECT' && typeof value === 'string') node.value = value;
  }

  /** 读按钮按下态 */
  function pressed(id) {
    const node = nodes.get(id);
    return node ? node.getAttribute('aria-pressed') === 'true' : null;
  }

  // 初始为"播放中"：按 8803 语义，播放中显示暂停图标 + aria-pressed=true
  setIcon('transport-play', 'pause');
  setPressed('transport-play', true);

  return {
    controls: footerEl.querySelectorAll('button, select').length,
    wired,
    setOptions,
    setPressed,
    setIcon,
    /** 自绘下拉句柄（测试/断言用：isOpen / value） */
    picker: (id) => pickers.get(id) || null,
    setSelectValue,
    pressed,
  };
}
