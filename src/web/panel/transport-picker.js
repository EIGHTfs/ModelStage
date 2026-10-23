// panel/transport-picker.js —— 底栏「自绘下拉」的完整实现
//
// 从 transport.js 抽出来的原因：那块代码（触发器 + listbox + 键盘语义 + 背景选项源）占了
//   半个文件，混在"渲染编排 + 接线"里读不下去。这里只负责"一个下拉怎么工作"，
//   不知道底栏有几个控件、也不知道它们怎么分组。
//
// 对外只暴露四件事：
//   createPicker(ctl, onPick, hooks) 建一个下拉
//   refreshBgOptions(picker)         重新拉背景选项（内置 4 模式 + 服务端自定义图）
//   applyBgValue(value)              应用一次背景选择（mode:xxx / img:url）
//   bindBgSync(picker)               任何来源改了背景都让下拉重新对齐

import { el } from './dom.js';
import { listBackgrounds } from '../app/backgrounds.js';
import { applyBackground, readViewSettings, setCustomBackground } from '../app/view-settings.js';
import { stageStatus } from '../app/status.js';

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
    // 分组标题：只做视觉分隔（role=presentation），不进可选项数组，键盘不会停在它上面
    if (opt.group) {
      const head = el('li', 'transport-picker-group', opt.text);
      head.setAttribute('role', 'presentation');
      list.append(head);
      continue;
    }
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
export function createPicker(ctl, onPick, hooks = {}) {
  const root = el('div', 'transport-picker');
  root.dataset.ctl = ctl.id;
  const btn = el('button', 'transport-picker-btn');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', ctl.label || '选择');
  if (ctl.title) btn.title = ctl.title;
  // 图标由调用方传入（图标表在 transport.js，这里不重复维护一份）
  const iconBody = ctl.icon;
  if (iconBody) {
    const wrap = el('span', 'btn-icon');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconBody}</svg>`;
    btn.append(wrap);
    btn.classList.add('has-icon');
  }
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
    // 打开前刷新（背景图列表会随上传/删除变化，不刷新就会列出过期项）
    if (typeof hooks.onBeforeOpen === 'function') { try { hooks.onBeforeOpen(); } catch { /* 刷新失败就用现有选项 */ } }
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

/** 底栏「背景」的内置模式（与右栏「背景模式」四个档位一一对应） */
export const BG_MODES = [
  { text: '棋盘格', value: 'mode:checkerboard' },
  { text: '纯色', value: 'mode:solid' },
  { text: '透明', value: 'mode:transparent' },
  { text: '自定义（选本地图片）', value: 'mode:custom' },
];

/**
 * 当前背景在列表里的值：内置模式用 `mode:<模式>`，服务端自定义图用 `img:<url>`。
 * @param {Array<{url: string}>} images 服务端已有的自定义图
 * @returns {string} 当前值
 */
export function currentBgValue(images) {
  const bg = readViewSettings().background || {};
  if (bg.mode === 'custom' && bg.imageUrl) {
    const hit = (images || []).find((it) => it.url === bg.imageUrl);
    return hit ? `img:${hit.url}` : 'mode:custom';
  }
  return `mode:${bg.mode || 'checkerboard'}`;
}

/**
 * 应用一个背景选择值。
 * @param {string} value `mode:<模式>` 或 `img:<url>`
 * @returns {boolean} 是否落地
 */
/** url → 自定义图名字（切图时状态行要显示人话，而不是一串 url） */
const bgImageNames = new Map();

/**
 * 应用一个背景选择值，并写一条状态（与皮肤/动作切换保持一致：让用户看到"切成了什么"）。
 * @param {string} value `mode:<模式>` 或 `img:<url>`
 * @returns {boolean} 是否落地
 */
export function applyBgValue(value) {
  const v = String(value || '');
  if (v.startsWith('img:')) {
    const url = v.slice(4);
    const ok = setCustomBackground(url);
    document.dispatchEvent(new CustomEvent('panel:bg-applied', { detail: { mode: 'custom' } }));
    stageStatus(`背景 → ${bgImageNames.get(url) || '自定义图片'}${ok ? '' : '（舞台未就绪）'}`, ok ? 'info' : 'warn', { show: true });
    return ok;
  }
  if (v.startsWith('mode:')) {
    const mode = v.slice(5);
    applyBackground(mode);   // 内部会广播 panel:bg-applied，底栏/右栏据此同步
    const text = (BG_MODES.find((m) => m.value === `mode:${mode}`) || {}).text || mode;
    stageStatus(`背景 → ${text}`, 'info', { show: true });
    return true;
  }
  return false;
}

/**
 * 重新拉取背景选项（内置 4 模式 + 服务端自定义图，自定义图带分组标题）。
 * 没有自定义图时只列内置 4 项——不出现空的「自定义图片」分组。
 * @param {object} picker createPicker 句柄
 * @returns {Promise<number>} 选项条数
 */
export async function refreshBgOptions(picker) {
  if (!picker) return 0;
  const r = await listBackgrounds();
  const images = r && r.ok ? (r.items || []) : [];
  const opts = BG_MODES.slice();
  if (images.length) {
    opts.push({ text: '自定义图片', group: true });
    bgImageNames.clear();
    for (const it of images) {
      bgImageNames.set(it.url, it.name);
      opts.push({ text: it.name, value: `img:${it.url}` });
    }
  }
  picker.setOptions(opts, currentBgValue(images));
  return opts.length;
}

/**
 * 任何来源（右栏档位 / 右栏列表 / 底栏自己）改了背景，都让底栏下拉重新对齐。
 * 只刷新自己、不再往回广播，避免来回触发。
 */
export function bindBgSync(picker) {
  if (typeof document === 'undefined') return;
  document.addEventListener('panel:bg-applied', () => {
    refreshBgOptions(picker).catch(() => { /* 刷新失败保持现状 */ });
  });
}

