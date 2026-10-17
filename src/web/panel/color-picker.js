// panel/color-picker.js —— 自研调色盘（**纯 UI 组件，无状态**）
//
// 职责边界（硬约束）：
//   只做：弹出调色盘 → 用户选完 → 回调返回一个 '#rrggbb' 字符串。
//   不做：不碰本地存储、不调任何接口、不认识"预设"这个概念、不负责命名、不缓存上次选择。
//   自证方式：`openColorPicker` 的函数体里只做「取值 → 校色 → 回调」，没有任何外部状态读写。
//
// 为什么自己写：项目零依赖（不引第三方取色器），而原生 <input type="color"> 在无头环境与
//   部分浏览器下弹的是系统对话框，样式不可控、也无法做"十六进制输入 + 三滑块双向同步"。
//
// 交互口径：
//   · HSL 三滑块驱动预览；hex 输入双向同步（合法即回写滑块，非法则标红 + 禁用确定）
//   · Esc / 点遮罩 / 取消 ⇒ onCancel（不回调 onConfirm）
//   · 单例：重复 open 会先销毁前一个，避免两个遮罩叠在一起

import { el } from './dom.js';

/** 样式表只注入一次（面板会重建，重复插入 <link> 会浪费） */
const CSS_HREF = 'panel/color-picker.css';
const CSS_ATTR = 'data-color-picker-css';

/** 当前打开的实例（单例约束） */
let current = null;

/** 严格校验 6 位十六进制（大小写都收，输出统一小写） */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * 规范化颜色：合法则返回小写 '#rrggbb'，否则返回 null。
 * @param {string} v
 * @returns {string|null}
 */
function normalizeHex(v) {
  const s = String(v || '').trim();
  return HEX_RE.test(s) ? s.toLowerCase() : null;
}

/**
 * #rrggbb → {h,s,l}（h:0-360, s/l:0-100）。
 * @param {string} hex 已规范化的颜色
 * @returns {{h:number,s:number,l:number}}
 */
function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  // 不取整：取整会在「输入 hex → 转 HSL → 再转回 hex」时丢精度（实测 #8844cc 会变成 #8743cb）
  return { h: h * 360, s: s * 100, l: l * 100 };
}

/**
 * {h,s,l} → '#rrggbb'。
 * @param {number} h 0-360
 * @param {number} s 0-100
 * @param {number} l 0-100
 * @returns {string}
 */
function hslToHex(h, s, l) {
  const hh = ((h % 360) + 360) % 360 / 360;
  const ss = Math.min(100, Math.max(0, s)) / 100;
  const ll = Math.min(100, Math.max(0, l)) / 100;
  const f = (n) => {
    const k = (n + hh * 12) % 12;
    const a = ss * Math.min(ll, 1 - ll);
    const v = ll - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * v).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** 注入样式表（幂等；失败不阻塞组件可用） */
function ensureStylesheet(doc) {
  if (doc.querySelector(`link[${CSS_ATTR}]`)) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = CSS_HREF;
  link.setAttribute(CSS_ATTR, '1');
  (doc.head || doc.documentElement).append(link);
}

/**
 * 打开调色盘。
 *
 * @param {object} opts
 * @param {string} [opts.initial] 初始颜色 '#rrggbb'（非法/缺省时用 #000000）
 * @param {HTMLElement} [opts.anchor] 可选锚点（就近弹出；缺省居中）
 * @param {(color:string)=>void} opts.onConfirm 用户点确定时回调，参数是规范化后的 '#rrggbb'
 * @param {()=>void} [opts.onCancel] 取消/Esc/点遮罩时回调
 * @returns {{destroy: () => void}} 句柄（重复 open 会先销毁上一个）
 */
export function openColorPicker(opts = {}) {
  if (current) { try { current.destroy(); } catch { /* 旧实例销毁失败不影响新开 */ } }

  const doc = (opts.anchor && opts.anchor.ownerDocument) || document;
  ensureStylesheet(doc);

  const start = hexToHsl(normalizeHex(opts.initial) || '#000000');
  let hue = start.h;
  let sat = start.s;
  let lit = start.l;
  let hex = hslToHex(hue, sat, lit);
  /** 用户直接输入且合法的原始值（滑块没动过就原样返回，避免 HSL 往返丢精度） */
  let exactHex = null;
  let closed = false;

  const mask = el('div', 'cp-mask');
  const panel = el('div', 'cp-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '选择颜色');

  const preview = el('div', 'cp-preview');
  const rows = el('div', 'cp-rows');

  /** 造一行滑块（标签 + input[type=range]） */
  const makeRow = (label, cls, max, value) => {
    const row = el('div', 'cp-row');
    row.append(el('span', 'cp-row-label', label));
    const input = el('input', `cp-slider ${cls}`);
    input.type = 'range';
    input.min = '0';
    input.max = String(max);
    input.step = '1';
    input.value = String(value);
    input.setAttribute('aria-label', { H: '色相', S: '饱和度', L: '亮度' }[label] || label);
    row.append(input);
    rows.append(row);
    return input;
  };

  const hIn = makeRow('H', 'cp-slider--h', 360, hue);
  const sIn = makeRow('S', 'cp-slider--s', 100, sat);
  const lIn = makeRow('L', 'cp-slider--l', 100, lit);

  const top = el('div', 'cp-top');
  top.append(preview, rows);

  const hexRow = el('div', 'cp-hex-row');
  hexRow.append(el('span', 'cp-hex-label', '十六进制'));
  const hexIn = el('input', 'cp-hex');
  hexIn.type = 'text';
  hexIn.value = hex;
  hexIn.spellcheck = false;
  hexIn.setAttribute('aria-label', '十六进制颜色');
  hexRow.append(hexIn);

  const actions = el('div', 'cp-actions');
  const btnCancel = el('button', 'cp-btn', '取消');
  btnCancel.type = 'button';
  const btnOk = el('button', 'cp-btn cp-btn--primary', '确定');
  btnOk.type = 'button';
  actions.append(btnCancel, btnOk);

  panel.append(top, hexRow, actions);
  mask.append(panel);
  (doc.body || doc.documentElement).append(mask);

  /**
   * 把当前 h/s/l 写进 DOM（预览、滑块、变量、hex）。
   * 只设 CSS 变量与 input.value —— 不拼 background 字面量。
   */
  const paint = () => {
    hex = exactHex || hslToHex(hue, sat, lit);
    preview.style.setProperty('--cp-preview', hex);
    // 饱和度条两端：左端同亮度灰、右端当前色相纯色
    panel.style.setProperty('--cp-sat-from', hslToHex(hue, 0, lit));
    panel.style.setProperty('--cp-sat-to', hslToHex(hue, 100, lit));
    // 亮度条中点：当前色相/饱和度的"标准亮度"
    panel.style.setProperty('--cp-lit-mid', hslToHex(hue, sat, 50));
    hIn.value = String(hue);
    sIn.value = String(sat);
    lIn.value = String(lit);
    hexIn.value = hex;
    hexIn.classList.remove('is-bad');
    btnOk.disabled = false;
  };

  /** 滑块 → 状态 → 重绘 */
  const onSlide = () => {
    hue = Number(hIn.value);
    sat = Number(sIn.value);
    lit = Number(lIn.value);
    exactHex = null;   // 滑块一动就按 HSL 算，原始输入值不再代表当前色
    paint();
  };

  /** hex 输入 → 合法则回写滑块；非法标红并禁用确定 */
  const onHexInput = () => {
    const ok = normalizeHex(hexIn.value);
    if (!ok) {
      hexIn.classList.add('is-bad');
      btnOk.disabled = true;
      return;
    }
    const hsl = hexToHsl(ok);
    hue = hsl.h; sat = hsl.s; lit = hsl.l;
    exactHex = ok;     // 原样保留用户输入的精确值
    paint();
  };

  hIn.addEventListener('input', onSlide);
  sIn.addEventListener('input', onSlide);
  lIn.addEventListener('input', onSlide);
  hexIn.addEventListener('input', onHexInput);

  /** 关闭并清理（先标记 closed，避免 Esc 与遮罩点击重复回调） */
  const close = (confirmed) => {
    if (closed) return;
    closed = true;
    doc.removeEventListener('keydown', onKey, true);
    try { mask.remove(); } catch { /* 已被移除 */ }
    current = null;
    if (confirmed) {
      const v = normalizeHex(hexIn.value) || hex;
      if (typeof opts.onConfirm === 'function') opts.onConfirm(v);
    } else if (typeof opts.onCancel === 'function') opts.onCancel();
  };

  /** Esc 只取消（捕获阶段，避免被页面其它 Esc 处理抢先） */
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(false); }
  }
  doc.addEventListener('keydown', onKey, true);

  btnCancel.addEventListener('click', () => close(false));
  btnOk.addEventListener('click', () => { if (!btnOk.disabled) close(true); });
  mask.addEventListener('click', (e) => { if (e.target === mask) close(false); });

  // 就近弹出：贴着锚点下方；越界时翻到上方/左移，保证整块在视口内
  if (opts.anchor && typeof opts.anchor.getBoundingClientRect === 'function') {
    /**
     * 定位一次。
     * 为什么要在 rAF 里再跑一次：刚 append 的面板还没布局，getBoundingClientRect 尺寸为 0，
     *   拿 0 尺寸判越界会把坐标错误地夹到视口边缘（实测跑到左下角 8px）。
     */
    const place = () => {
      const r = opts.anchor.getBoundingClientRect();
      const box = panel.getBoundingClientRect();
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      let left = r.left;
      let top = r.bottom + 6;
      if (vw && box.width && left + box.width > vw - 8) left = Math.max(8, vw - box.width - 8);
      if (vh && box.height && top + box.height > vh - 8) top = Math.max(8, r.top - box.height - 6);
      panel.classList.add('is-anchored');
      // 坐标是运行时算出来的动态值（契约允许的唯一动态例外）
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
    };
    place();
    requestAnimationFrame(place);
  }

  paint();

  const handle = {
    destroy() {
      if (closed) return;
      closed = true;
      doc.removeEventListener('keydown', onKey, true);
      try { mask.remove(); } catch { /* 已被移除 */ }
      if (current === handle) current = null;
    },
  };
  current = handle;
  return handle;
}
