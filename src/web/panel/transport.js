// transport.js —— 底部播放条渲染与接线
//
// 做什么：按 panel-schema.js 的 TRANSPORT_CONTROLS 渲染播放条上的 8 个控件，
//   并把调用方提供了 handler 的控件接上线；没提供 handler 的保持 disabled + data-pending。
// 铁律：不允许"看着能点却没反应"——只有 handler 存在的控件才会被解锁。
//
// 动态选项：动作/皮肤下拉的选项由模型数据填充（setOptions），渲染时的 options 只是占位文案。
//
// 自绘下拉本身（触发器 + listbox + 键盘 + 背景选项源）在 panel/transport-picker.js；
//   本文件只负责"有哪些控件、怎么分组、怎么和 app 层接线"。

import { TRANSPORT_CONTROLS } from './schema.js';
import { GROUP_ICONS } from './icons.js';
import { el } from './dom.js';
import { setBackgroundColor, setCustomBackground } from '../app/view-settings.js';
import { stageStatus } from '../app/status.js';
import {
  BG_MODES, applyBgValue, bindBgSync, createPicker, currentBgValue, refreshBgOptions, renderBgSubmenu,
} from './transport-picker.js';

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
// 皮肤/动作/背景与右栏是同一个功能，图标**直接引右栏那套**（GROUP_ICONS），
//   两处各抄一份 path 必然漂移（曾出现：右栏动作是网格图标、底栏是波形图标）。
// 上一个/下一个/播放/重置视图右栏没有对应功能，图标留在这里。
const ICONS = {
  'transport-prev': '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>',
  'transport-play': '<polygon points="6 3 20 12 6 21 6 3"/>',
  'transport-next': '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>',
  'transport-reset-view': '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/>',
  // 以下三个与右栏同名功能共用一份 path
  'transport-bg': GROUP_ICONS.theme,
  'transport-skin': GROUP_ICONS.skin,
  'transport-motion': GROUP_ICONS.motion,
};

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

  // 分组由数组派生：center:true 的控件单独成中块，它之前→左块、之后→右块。
  //   这样调整控件顺序只需改 schema 的数组，不必同步维护第二份分组表（以前漏改一处就错位）。
  const ids = TRANSPORT_CONTROLS.map((c) => c.id);
  const centerIdx = TRANSPORT_CONTROLS.findIndex((c) => c.center === true);
  const groups = centerIdx < 0
    ? [ids]                                                              // 没标 center ⇒ 单块兜底
    : [ids.slice(0, centerIdx), [ids[centerIdx]], ids.slice(centerIdx + 1)];
  const byId = new Map(TRANSPORT_CONTROLS.map((c) => [c.id, c]));
  const nodes = new Map();
  /** 自绘下拉的句柄（id → picker），setOptions/setSelectValue 走它 */
  const pickers = new Map();
  /** 自带回调的 picker（不依赖 handlers 即可用）：背景选择器属于这一类 */
  const selfWired = new Set();

  for (let gi = 0; gi < groups.length; gi += 1) {
    const groupIds = groups[gi];
    // 空块直接跳过：否则会占掉一个 grid 列（center 标在数组首项时左块就是空的）
    if (!groupIds.length) continue;
    const box = el('div', 'transport-group');
    // 显式标出这块该落在哪一列：跳过空块后，剩下的块不能靠 DOM 顺序去猜列
    //   （否则 center 标在首项时，中块会被排到第 1 列、偏移 300+px）
    box.dataset.slot = centerIdx < 0 ? 'left' : ['left', 'center', 'right'][gi];
    for (const id of groupIds) {
      const ctl = byId.get(id);
      if (!ctl) continue;
      if (id === 'transport-bg') {
        // 背景：内置 4 模式 + 服务端自定义图，选中即应用（不再"点一次换一个"的循环切换）。
        //   这里不接 handlers['transport-bg']：那个是旧的循环切换动作，接了就会"选了又跳下一项"。
        const bgPicker = createPicker(
          { ...ctl, icon: ICONS[ctl.id], options: BG_MODES.slice(), value: currentBgValue() },
          (value) => applyBgValue(value),
          {
            onBeforeOpen: () => { refreshBgOptions(bgPicker).catch(() => { /* 刷新失败沿用现有选项 */ }); },
            /**
             * 一级里点「纯色 / 自定义」→ 侧向弹出二级（色块列表 / 图片列表）。
             * 二级内容由 bg-source.renderSourceGroup 渲染，与右栏那份是同一套代码；
             * 选中后：应用 + 关掉两级 + 让一级重新对齐（勾选与按钮回显都靠 refreshBgOptions）。
             */
            onSubmenu: (groupId, host) => {
              renderBgSubmenu(host, groupId, ({ groupId: g, item }) => {
                if (g === 'solid') {
                  setBackgroundColor(item.color);
                  stageStatus(`背景 → ${item.name}`, 'info', { show: true });
                } else {
                  setCustomBackground(item.url);
                  document.dispatchEvent(new CustomEvent('panel:bg-applied', { detail: { mode: 'custom' } }));
                  stageStatus(`背景 → ${item.name}`, 'info', { show: true });
                }
                try { bgPicker.closeSub(); } catch { /* 忽略 */ }
                bgPicker.close();
                refreshBgOptions(bgPicker).catch(() => { /* 忽略 */ });
              }).catch(() => { /* 二级渲染失败：保持一级 */ });
            },
          },
        );
        pickers.set(id, bgPicker);
        selfWired.add(id);
        nodes.set(id, bgPicker.root);
        box.append(bgPicker.root);
        refreshBgOptions(bgPicker).catch(() => { /* 首次拉取失败：保留内置 4 项 */ });
        bindBgSync(bgPicker);
        continue;
      }
      if (ctl.custom === 'picker') {
        // 自绘下拉：回调直接接到 handlers[id]（与原生 select 的 change 同义）
        const picker = createPicker(
          {
            ...ctl,
            icon: ICONS[ctl.id],
            options: (ctl.options || []).map((o) => (typeof o === 'string' ? { text: o, value: o } : o)),
          },
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
    // 自绘下拉的"已接线"判定：自带回调的（背景）不依赖 handlers；
    //   其余（动作/皮肤）的选中回调会转调 handlers[id]，没有 handler 仍算未接线。
    if (pickers.has(id)) {
      if (selfWired.has(id) || typeof handlers[id] === 'function') wired.push(id);
      continue;
    }
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
