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
import { listBgSources, renderSourceGroup, selectedSourceId } from './bg-source.js';
import { listBackgrounds } from '../app/backgrounds.js';
import { applyBackground, readViewSettings, setCustomBackground } from '../app/view-settings.js';
import { stageLog, stageStatus } from '../app/status.js';

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
function buildPickerItems(options, onPickItem, list, onSubmenu) {
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
    if (opt.submenu) {
      // 有二级：行尾加 ▸，点它不"选中"而是展开侧向二级（键盘 Enter 同样走这条）
      li.dataset.submenu = String(opt.submenu);
      li.append(el('span', 'transport-picker-arrow', '▸'));
      li.addEventListener('click', () => {
        if (typeof onSubmenu === 'function') onSubmenu(String(opt.submenu), li);
      });
    } else {
      li.addEventListener('click', () => onPickItem(String(opt.value)));
    }
    items.push({ value: String(opt.value), text: opt.text, node: li, submenu: opt.submenu || null });
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
 * 为什么不用原生 select：视觉无法与本实现设计语言统一（动作/皮肤列表同样是自绘的，保持一致），
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
  // 二级菜单（侧向弹出）：内容由调用方的 hooks.onSubmenu 用统一渲染层填
  const sub = el('div', 'transport-picker-sub');
  sub.hidden = true;
  root.append(btn, list, sub);

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

  function closeSub() {
    sub.hidden = true;
    sub.replaceChildren();
  }

  function close(returnFocus = false) {
    closeSub();
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
    items = buildPickerItems(next, (v) => { pick(v); close(true); }, list, (groupId, node) => {
      // 展开二级：把容器交给调用方渲染（内容与右栏同一份 renderSourceGroup）
      items.forEach((it) => it.node.classList.toggle('is-sub', it.node === node));
      sub.hidden = false;
      if (typeof hooks.onSubmenu === 'function') {
        try { hooks.onSubmenu(String(groupId), sub); } catch { closeSub(); }
      }
    });
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
    /**
     * 按钮上的"当前项预览"（小色块 / 缩略图）。
     * 用 CSS 变量下发颜色与图片地址（运行时数据，不写内联 background 字面量）。
     * @param {{swatch?:string, thumb?:string}|null} preview 传 null 清掉预览
     */
    setPreview: (preview) => {
      let block = btn.querySelector('.picker-prev');
      if (!preview) { if (block) block.remove(); return; }
      if (!block) { block = el('span', 'picker-prev'); btn.insertBefore(block, btn.firstChild); }
      if (preview.swatch) block.style.setProperty('--prev-swatch', preview.swatch);
      else block.style.removeProperty('--prev-swatch');
      if (preview.thumb) block.style.setProperty('--prev-thumb', `url("${preview.thumb}")`);
      else block.style.removeProperty('--prev-thumb');
      block.dataset.kind = preview.thumb ? 'thumb' : 'swatch';
    },
    closeSub,
    open,
    close: () => close(false),
    isOpen: () => !list.hidden,
    value: () => current,
  };
}

/**
 * 底栏「背景」的一级菜单（与右栏四个档位一一对应）。
 *
 * 结构是**两级**：棋盘格 / 透明 直接选；纯色 ▸ / 自定义 ▸ 展开侧向二级（色块列表 / 图片列表），
 * 二级内容由 panel/bg-source.js 的统一渲染层出，与右栏那份是同一套代码。
 * 这里的初值只用于"数据还没拉回来"的第一帧，真实文案（含当前项名与 ✓）由 refreshBgOptions 重算。
 */
export const BG_MODES = [
  { text: '棋盘格', value: 'mode:checkerboard' },
  { text: '透明', value: 'mode:transparent' },
  { text: '纯色', value: 'g:solid', submenu: 'solid' },
  { text: '自定义', value: 'g:custom', submenu: 'custom' },
];

/**
 * 当前背景在**一级菜单**里对应的值：内置模式用 `mode:<模式>`，纯色/自定义用档位值 `g:<组>`。
 * 具体是哪一条色/图不在这里体现（二级菜单里打勾），一级只标"哪一档"。
 * @param {{mode?:string}} [background] 缺省读当前设置
 * @returns {string}
 */
export function currentBgValue(background) {
  const bg = background || (readViewSettings().background || {});
  const mode = String(bg.mode || 'checkerboard');
  if (mode === 'solid') return 'g:solid';
  if (mode === 'custom') return 'g:custom';
  return `mode:${mode === 'transparent' ? 'transparent' : 'checkerboard'}`;
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
    const bgName = bgImageNames.get(url) || '自定义图片';
    if (ok) stageStatus(`背景 → ${bgName}`, 'info', { show: true });
    else stageLog('warn', `背景 → ${bgName}（舞台未就绪）`, { url, reason: 'stage-not-ready' });
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
  const sources = await listBgSources();
  const sel = selectedSourceId(readViewSettings().background || {}, sources);
  // 两组各自找自己的命中条目：不能共用一个 item，否则会出现「自定义 · 暖暗」这种串味
  const findIn = (pool) => (sel.itemId ? (pool || []).find((x) => x.id === sel.itemId) || null : null);
  const solidItem = sel.groupId === 'solid' ? findIn(sources.solid) : null;
  const customItem = sel.groupId === 'custom' ? findIn(sources.custom) : null;

  const tick = (on) => (on ? '✓ ' : '');
  const opts = [
    { text: `${tick(sel.groupId === 'builtin' && sel.id === 'checkerboard')}棋盘格`, value: 'mode:checkerboard' },
    { text: `${tick(sel.groupId === 'builtin' && sel.id === 'transparent')}透明`, value: 'mode:transparent' },
    // 一级只标"哪一档"；有具体命中的条目就把名字带出来，按钮回显因此自然是「纯色 · 暖暗」
    { text: `${tick(sel.groupId === 'solid')}${solidItem ? `纯色 · ${solidItem.name}` : '纯色'}`, value: 'g:solid', submenu: 'solid' },
    { text: `${tick(sel.groupId === 'custom')}${customItem ? `自定义 · ${customItem.name}` : '自定义'}`, value: 'g:custom', submenu: 'custom' },
  ];
  picker.setOptions(opts, currentBgValue());
  // 按钮上的小预览：纯色给色块、自定义给缩略图；内置模式清掉
  if (typeof picker.setPreview === 'function') {
    picker.setPreview(solidItem ? { swatch: solidItem.color }
      : (customItem ? { thumb: customItem.url } : null));
  }
  return opts.length;
}

/**
 * 渲染某一组的二级菜单内容（供底栏 picker 的 onSubmenu 调用）。
 * 与右栏共用 panel/bg-source.js 的同一个渲染函数 ⇒ 两处永远一致。
 * @param {HTMLElement} host 二级容器
 * @param {'solid'|'custom'} groupId
 * @param {(payload:{groupId:string, item:object})=>void} onPick 选中回调
 * @returns {Promise<number>} 条数
 */
export async function renderBgSubmenu(host, groupId, onPick) {
  const sources = await listBgSources();
  const sel = selectedSourceId(readViewSettings().background || {}, sources);
  const items = groupId === 'custom' ? sources.custom : sources.solid;
  const { count } = renderSourceGroup(host, groupId, items, {
    variant: 'menu',
    selectedItemId: sel.itemId || null,
    onApply: (item) => { if (typeof onPick === 'function') onPick({ groupId, item }); },
  });
  return count;
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

