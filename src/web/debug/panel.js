// debug-panel.js —— 调试日志浮层面板（纯 DOM，只依赖 debug-log 实例）
//
// 结构按 doc/参考-旧端调试日志面板.html 的真实 DOM 复现：
//   容器（288px 宽 / 最高 320px / 圆角 12px / 卡片底 / 阴影 / 纵向 flex）
//   ├ 头部：info 图标 + 「调试日志」 + 「N 条」 ｜ 右侧「清空」「收起」两个图标按钮
//   └ 列表（最高 256px，可滚动，等宽 12px）：每条 = 级别图标 + [时间 + [tag]] + 正文
// 空态「暂无日志」居中淡色；新增条目自动滚到底；折叠只留头部。
//
// 与业务解耦：mountDebugPanel({ log, container }) 挂在传入容器上，返回 { destroy() }。
// 样式来自同目录 debug-panel.css（用 import.meta.url 解析，不写死路径）。
//
// 结构：图标 / 时间格式 / 样式注入 / 骨架 / 渲染器 / 编排，各自独立成函数（每函数 ≤50 行）。

import { DEBUG_LEVELS } from './log.js';

const CSS_FILE = './debug-panel.css';
const CSS_LINK_ATTR = 'data-debug-panel-css';

/** 元素工厂 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** 内联 SVG 图标（不依赖图标字体/外部库） */
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  })) svg.setAttribute(k, v);
  const paths = {
    info: ['M12 16v-4', 'M12 8h.01', 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z'],
    x: ['M18 6 6 18', 'M6 6l12 12'],
    chevron: ['M6 9l6 6 6-6'],
    warn: ['M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'],
    error: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M15 9l-6 6', 'M9 9l6 6'],
  };
  for (const d of paths[name] || []) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  svg.classList.add('dbg-icon', `dbg-icon-${name}`);
  return svg;
}

/** 毫秒时间戳 → HH:MM:SS.mmm */
function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 注入样式表（幂等）；返回本次新建的 link（已存在则返回 null，便于销毁时不误删） */
function ensureStylesheet(doc) {
  if (doc.querySelector(`link[${CSS_LINK_ATTR}]`)) return null;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.setAttribute(CSS_LINK_ATTR, '1');
  link.href = new URL(CSS_FILE, import.meta.url).href; // 由模块位置推导，不写死
  doc.head.append(link);
  return link;
}

/** 建头部：标题 + 条数 + 清空/收起按钮 */
function createHeader() {
  const head = el('div', 'dbg-head');
  const left = el('div', 'dbg-head-left');
  const countEl = el('span', 'dbg-count', '0 条');
  left.append(icon('info'), el('span', 'dbg-title', '调试日志'), countEl);

  const right = el('div', 'dbg-head-right');
  const btnClear = el('button', 'dbg-btn');
  btnClear.type = 'button';
  btnClear.title = '清空';
  btnClear.setAttribute('aria-label', '清空日志');
  btnClear.append(icon('x'));

  const btnCollapse = el('button', 'dbg-btn');
  btnCollapse.type = 'button';
  btnCollapse.title = '收起';
  btnCollapse.setAttribute('aria-label', '收起日志面板');
  btnCollapse.append(icon('chevron'));

  right.append(btnClear, btnCollapse);
  head.append(left, right);
  return { head, countEl, btnClear, btnCollapse };
}

/** 建完整骨架 */
function createShell(doc) {
  const root = el('div', 'dbg-panel');
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', '调试日志');
  const parts = createHeader();
  const list = el('div', 'dbg-list');
  root.append(parts.head, list);
  doc.body.append(root);
  return { root, list, ...parts };
}

/** 生成一条日志的 DOM */
function renderEntry(entry, { isCollapsed }) {
  const level = DEBUG_LEVELS.includes(entry.level) ? entry.level : 'info';
  const row = el('div', `dbg-row dbg-row-${level}`);
  const levelIcon = icon(level === 'info' ? 'info' : level);
  levelIcon.classList.add('dbg-level-icon');
  row.append(levelIcon);

  const body = el('div', 'dbg-body');
  const meta = el('div', 'dbg-meta');
  meta.append(el('span', 'dbg-time', formatTime(entry.ts)));
  // tag 在 DOM 里保持小写，显示靠 CSS text-transform: uppercase（与旧端一致）
  meta.append(el('span', 'dbg-tag', `[${String(entry.tag || '').toLowerCase()}]`));
  body.append(meta, el('div', `dbg-text dbg-text-${level}`, entry.message));
  row.append(body);
  if (isCollapsed) row.hidden = true;
  return row;
}

/**
 * 渲染器：全量重绘 / 增量追加 / 条数 / 自动滚动。
 * @param {{log: object, list: HTMLElement, countEl: HTMLElement, state: {collapsed: boolean}}} ctx
 */
function createRenderer({ log, list, countEl, state }) {
  /** 新增后自动滚到底（列表未溢出时无副作用） */
  function scrollToBottom() {
    if (state.collapsed) return;
    list.scrollTop = list.scrollHeight;
  }

  /** 更新头部条数 */
  function updateCount(n) {
    countEl.textContent = `${n} 条`;
  }

  /** 全量重绘（初始化 / 清空后 / 样式就绪后） */
  function renderAll() {
    const records = log.entries();
    list.replaceChildren();
    if (!records.length) list.append(el('div', 'dbg-empty', '暂无日志'));
    else for (const record of records) list.append(renderEntry(record, state));
    updateCount(records.length);
    scrollToBottom();
  }

  /** 追加一条（避免每次新条目都整表重绘） */
  function appendEntry(entry) {
    if (list.querySelector('.dbg-empty')) list.replaceChildren();
    list.append(renderEntry(entry, state));
    updateCount(list.childElementCount);
    scrollToBottom();
  }

  return { renderAll, appendEntry, scrollToBottom };
}

/**
 * 让面板显隐跟随日志开关（关闭只是隐藏，实例保留 —— 与旧端开关的显隐语义一致）。
 * @param {{root: HTMLElement, view: object, log: object}} ctx
 * @returns {() => void} 取消订阅
 */
function syncVisibility({ root, view, log }) {
  const apply = (enabled) => {
    try {
      root.hidden = !enabled;
      if (enabled) {
        view.renderAll();      // 打开时把期间积累的条目补上，并滚到底
      }
    } catch { /* 显隐失败不影响业务 */ }
  };
  apply(log.getEnabled() !== false);
  if (typeof log.onEnabledChange !== 'function') return () => {};
  return log.onEnabledChange(apply);
}

/**
 * 接线：清空、折叠、日志订阅。返回解绑所需的三件套。
 * @param {{shell: object, view: object, log: object, state: {collapsed: boolean}}} ctx
 */
function wireControls({ shell, view, log, state }) {
  /** 清空：先清数据再重绘，异常也保证界面回到空态 */
  function onClear() {
    try { log.clear(); } finally { view.renderAll(); }
  }

  /** 折叠/展开：只切列表可见性与按钮语义 */
  function onCollapse() {
    state.collapsed = !state.collapsed;
    shell.root.classList.toggle('is-collapsed', state.collapsed);
    shell.list.hidden = state.collapsed;
    shell.btnCollapse.title = state.collapsed ? '展开' : '收起';
    shell.btnCollapse.setAttribute('aria-label', state.collapsed ? '展开日志面板' : '收起日志面板');
    shell.btnCollapse.classList.toggle('is-collapsed', state.collapsed);
    if (!state.collapsed) view.scrollToBottom();
  }

  shell.btnClear.addEventListener('click', onClear);
  shell.btnCollapse.addEventListener('click', onCollapse);

  // 订阅：新条目增量追加；null 表示「已清空」→ 整表重绘
  const unsubscribe = log.subscribe((entry) => {
    try {
      if (entry === null) view.renderAll();
      else view.appendEntry(entry);
    } catch {
      // 面板渲染失败不能影响业务
    }
  });

  return { onClear, onCollapse, unsubscribe };
}

/**
 * 挂载调试日志面板。
 * @param {{log: {entries: Function, subscribe: Function, clear: Function}, container?: HTMLElement}} params
 * @returns {{destroy: Function, element: HTMLElement}}
 */
export function mountDebugPanel({ log, container } = {}) {
  if (!log || typeof log.entries !== 'function' || typeof log.subscribe !== 'function') {
    throw new Error('mountDebugPanel: 需要 createDebugLog() 的实例');
  }
  const doc = (container || document.body).ownerDocument || document;
  const linkEl = ensureStylesheet(doc);
  const state = { collapsed: false };
  const shell = createShell(doc);
  const view = createRenderer({ log, list: shell.list, countEl: shell.countEl, state });
  const wired = wireControls({ shell, view, log, state });
  const unwatchVisibility = syncVisibility({ root: shell.root, view, log });

  // 样式表异步加载：加载完成前列表没有高度约束，「滚到底」无效，故就绪后重绘一次
  if (linkEl) {
    linkEl.addEventListener('load', () => {
      try { view.renderAll(); } catch { /* 重绘失败不影响业务 */ }
    }, { once: true });
  }

  view.renderAll();

  return {
    element: shell.root,
    destroy() {
      try { wired.unsubscribe(); } catch { /* 忽略 */ }
      try { unwatchVisibility(); } catch { /* 忽略 */ }
      shell.btnClear.removeEventListener('click', wired.onClear);
      shell.btnCollapse.removeEventListener('click', wired.onCollapse);
      shell.root.remove();
      if (linkEl && linkEl.parentNode) linkEl.remove();
    },
  };
}
