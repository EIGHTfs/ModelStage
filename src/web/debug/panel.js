// debug-panel.js —— 调试日志浮层面板（纯 DOM，只依赖 debug-log 实例）
//
// 结构按 docs/设计/调试日志面板.md 的真实 DOM 复现：
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
import { createPanelDrag } from './drag.js';
import { createUploader } from './upload.js';
import * as uiState from '../app/ui-state.js';

const CSS_FILE = './panel.css';
const CSS_LINK_ATTR = 'data-debug-panel-css';

/**
 * 级别多选状态统一走 app/ui-state 工厂（偏好键的 debug.logLevels 段）。
 * 本文件不直接读写存储 —— 不再有独立的键常量。
 */

/**
 * 读取上次勾选的级别；没存过或存的值非法 ⇒ 用默认（debug 关、其余开）。
 * @returns {string[]}
 */
function loadLevels() {
  try {
    const arr = uiState.getLogLevels();          // S3：唯一真相源 = 工厂
    if (!Array.isArray(arr)) return [...DEFAULT_LEVELS];
    const valid = arr.filter((x) => LEVEL_UI.some(([lv]) => lv === x));
    return valid.length ? valid : [...DEFAULT_LEVELS];
  } catch {
    return [...DEFAULT_LEVELS];
  }
}

/** 保存勾选的级别（写失败不影响使用：持久化只是增强） */
function saveLevels(levels) {
  try { uiState.setLogLevels([...levels]); } catch { /* 忽略 */ }
}

// el 的唯一实现在 infra/dom.js（本文件 31 处调用全靠这一个 import，
//   删掉旧的私有实现后若漏了它，运行时就是 undefined）。
import { el } from '../infra/dom.js';

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
    // 四档/操作用（lucide 同名图标）：bug / upload / trash-2
    bug: ['M8 2l1.88 1.88', 'M14.12 3.88 16 2', 'M9 7.13V6a3 3 0 1 1 6 0v1.13',
      'M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6z',
      'M6 13H2', 'M22 13h-4', 'M6.53 9 3.6 7.3', 'M20.4 7.3 17.47 9',
      'M6.53 17 3.6 18.7', 'M20.4 18.7 17.47 17'],
    upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
    trash: ['M3 6h18', 'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2',
      'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'],
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

/**
 * 第 1 行：info 图标 + 「调试日志」 + 「N 条」 + 收起按钮。
 *
 * 布局约束（防挤爆）：左边 `flex:1; min-width:0` 可压缩，收起按钮 `flex:none` 不压缩
 *   ⇒ 窗口再窄也只会压缩标题文字，**收起按钮永远不会被挤出右边界**（曾经溢出 6px 点不到）。
 * @param {Document} doc
 */
function createHeadRow(doc) {
  const head = el('div', 'dbg-head');
  const left = el('div', 'dbg-head-left');
  const countEl = el('span', 'dbg-count', '0 条');
  left.append(icon('info'), el('span', 'dbg-title', '调试日志'), countEl);
  // 上传结果就写在标题旁：成功给文件名+条数+体积，失败给原因（可见、可重试，不静默）。
  //   平时隐藏；出现时靠 CSS 省略号收窄，不参与把标题行挤爆。
  const uploadStatus = el('span', 'dbg-upload-status', '');
  uploadStatus.hidden = true;
  left.append(uploadStatus);

  // 操作按钮与标题同一行（图标 + 文字）：上传 / 清空 / 收起。
  //   放在第 1 行是为了让第 2 行专心放"级别筛选"——操作与筛选是两件事，不混在一起。
  const acts = el('div', 'dbg-acts');
  const btnUpload = el('button', 'dbg-act');
  btnUpload.type = 'button';
  btnUpload.title = '把当前日志上传到服务端（data/logs/）';
  btnUpload.setAttribute('aria-label', '上传日志');
  const uploadLabel = el('span', 'dbg-act-text', '上传');
  uploadLabel.dataset.uploadLabel = '1';
  btnUpload.append(icon('upload'), uploadLabel);

  const btnClear = el('button', 'dbg-act');
  btnClear.type = 'button';
  btnClear.title = '清空';
  btnClear.setAttribute('aria-label', '清空日志');
  btnClear.append(icon('trash'), el('span', 'dbg-act-text', '清空'));

  acts.append(btnUpload, btnClear);

  const btnCollapse = el('button', 'dbg-collapse');
  btnCollapse.type = 'button';
  btnCollapse.title = '收起';
  btnCollapse.setAttribute('aria-label', '收起日志面板');
  const headChevron = icon('chevron');
  headChevron.classList.add('dbg-chevron', 'dbg-chevron-head');
  btnCollapse.append(headChevron);

  head.append(left, acts, btnCollapse);
  return { head, countEl, btnCollapse, uploadStatus, btnUpload, btnClear, acts };
}

/** 四档定义：图标名取自 lucide 同名图标；顺序固定（调试→信息→警告→错误） */
const LEVEL_UI = [
  ['debug', '调试', 'bug'],
  ['info', '信息', 'info'],
  ['warn', '警告', 'warn'],
  ['error', '错误', 'error'],
];

/** 默认开启的档位：debug 关（机器日志量大、人不好读），其余三档开 */
export const DEFAULT_LEVELS = ['info', 'warn', 'error'];

/**
 * 第 2 行：四档多选按钮（图标 + 文字）。上传/清空在第 1 行，与标题同行。
 *
 * 为什么用按钮而不是下拉：下拉只能表达"某一档及以上"，而人真实的诉求是任意组合
 *   （比如"只看警告+错误"、"全都看但不要信息级噪音"）。多选是能表达这些的唯一形态。
 * @param {Document} doc
 */
function createBarRow(doc) {
  const bar = el('div', 'dbg-bar');
  const levels = el('div', 'dbg-levels');
  levels.setAttribute('role', 'group');
  levels.setAttribute('aria-label', '日志级别（可多选）');
  const levelBtns = {};
  for (const [level, text, iconName] of LEVEL_UI) {
    const btn = el('button', 'dbg-lv');
    btn.type = 'button';
    btn.dataset.level = level;
    btn.title = `${text}级：点击显示/隐藏`;
    btn.append(icon(iconName), el('span', 'dbg-lv-text', text));
    levels.append(btn);
    levelBtns[level] = btn;
  }

  bar.append(levels);
  return { bar, levelBtns };
}

/**
 * 收起态的胶囊按钮（info 图标 + 「日志」 + 计数徽标 + chevron）。
 *
 * 为什么单独做一颗按钮而不是"把面板缩到只剩标题栏"：收起后是一个小胶囊浮在右下角，
 *   用户点它就是"再打开"。这颗胶囊承载"已收起了多少条日志"的信息，比只剩一个图标更清楚。
 * @param {Document} doc
 * @returns {{pill: HTMLButtonElement, badge: HTMLElement}}
 */
function createPill(doc) {
  const pill = el('button', 'dbg-pill');
  pill.type = 'button';
  pill.title = '展开调试日志';
  pill.setAttribute('aria-label', '展开调试日志');
  const text = el('span', 'dbg-pill-text', '日志');
  const badge = el('span', 'dbg-pill-count', '0');
  const chev = icon('chevron');
  chev.classList.add('dbg-chevron', 'dbg-chevron-pill');
  pill.append(icon('info'), text, badge, chev);
  // 收起态唯一可见的抓手就是这颗胶囊：标记为"自己是拖拽手柄"，
  //   否则 drag 的"按钮不拖"规则会把它排除掉（收起后就再也拖不动了）。
  pill.dataset.dragHandle = 'self';
  pill.title = '展开调试日志（可拖动）';
  return { pill, badge };
}

/**
 * 建完整骨架。
 * 注意 container：挂载点**必须**用调用方给的容器（否则面板永远贴在 body 上，
 *   外面再怎么调定位都不生效——踩过：改宿主 left/bottom 完全没效果）。
 */
function createShell(doc, container) {
  const root = el('div', 'dbg-panel');
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', '调试日志');
  const head = createHeadRow(doc);
  const bar = createBarRow(doc);
  const list = el('div', 'dbg-list');
  const { pill, badge } = createPill(doc);
  // 折叠动画用 grid 的 0fr→1fr 技巧（height:auto 不能 transition）：
  //   .dbg-shell 是**动画外壳**（唯一子项 .dbg-shell-inner，min-height:0 + overflow:hidden），
  //   .dbg-shell-inner 内部才是三行网格：标题行 / 工具行 / 列表（行高由 --dbg-h-* 常量给）。
  //   收起时外壳轨道压到 0fr ⇒ 高度平滑归零，不需要猜任何固定高度。
  const shellInner = el('div', 'dbg-shell-inner');
  shellInner.append(head.head, bar.bar, list);
  const shellBox = el('div', 'dbg-shell');
  shellBox.append(shellInner);
  // 初始收起态由挂载方写入（S4：来自工厂；下面这行只是兜底默认，随后会被真实值覆盖）
  root.dataset.collapsed = 'false';
  // 默认展开方向：与 CSS 默认定位（right/bottom）一致 ⇒ 向左上长，胶囊落在右下角
  root.dataset.openDir = 'up-left';
  root.append(pill, shellBox);
  (container || doc.body).append(root);
  return {
    root, list, pill, badge, shellBox,
    ...head, ...bar,
  };
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
  // tag 在 DOM 里保持小写，显示靠 CSS text-transform: uppercase
  // 来源（app/error/net/…）：一眼看出这条是"应用自己说的"还是"探针抓到的"
  meta.append(el('span', `dbg-src dbg-src-${String(entry.src || 'app').toLowerCase()}`, String(entry.src || 'app')));
  meta.append(el('span', 'dbg-tag', `[${String(entry.tag || '').toLowerCase()}]`));
  // 结构化字段是自有属性：正文只写"发生了什么"，细节挂在行上（悬停可见）+ 一个 { } 标记
  const detail = entry.data === undefined || entry.data === null ? '' : dataToText(entry.data);
  if (detail) {
    // 用「⋯」而不是「{}」：花括号会被读成"这是一个空对象 value"，而它其实只是
    //   "这条还有更多内容（悬停可看）"的记号。⋯ 是"还有更多"的通用记号，不会被误读。
    meta.append(el('span', 'dbg-data-mark', '⋯'));
    const shown = detail.length > 400 ? `${detail.slice(0, 400)}…` : detail;
    row.title = `有结构化数据（悬停查看）\n${shown}`;
  }
  body.append(meta, el('div', `dbg-text dbg-text-${level}`, entry.message));
  row.append(body);
  if (isCollapsed) row.hidden = true;
  return row;
}

/**
 * 渲染器：全量重绘 / 增量追加 / 条数 / 自动滚动。
 * @param {{log: object, list: HTMLElement, countEl: HTMLElement, state: {collapsed: boolean}}} ctx
 */
function createRenderer({ log, list, countEl, badgeEl, state }) {
  /** 新增后自动滚到底（列表未溢出时无副作用） */
  function scrollToBottom() {
    if (state.collapsed) return;
    list.scrollTop = list.scrollHeight;
  }

  /** 容差（px）：离底部这么近就算"用户在看最新" */
  const BOTTOM_TOLERANCE = 4;

  /**
   * 用户当前是否停在底部。
   * **必须在改 DOM 之前测**：改完 scrollHeight 就变了，再测永远为 false/true 失真。
   *
   * 三种情况都要算「在底部」，否则首次渲染就判 false、stick 从此固定为 false，
   *   表现为「刷新后日志永远停在顶部」：
   *   ① 还没布局（隐藏/刚创建，clientHeight=0）：无法判断 ⇒ 视为应跟随；
   *   ② 内容不足以滚动（maxScroll≈0，容器 padding 让 scrollHeight 略大）：顶就是底；
   *   ③ 正常情形：距底 ≤ 容差。
   * @returns {boolean}
   */
  function isAtBottom() {
    if (list.clientHeight === 0) return true;
    const maxScroll = list.scrollHeight - list.clientHeight;
    if (maxScroll <= BOTTOM_TOLERANCE) return true;
    return maxScroll - list.scrollTop <= BOTTOM_TOLERANCE;
  }

  /**
   * 「是否跟随最新」的显式状态。
   * 为什么不每次现算 isAtBottom()：面板隐藏时 clientHeight=0、内容不足以滚动时顶=底，
   *   这两种情况下现算都只能得到"在底部"，但用户**明确向上翻看过**这件事会丢；
   *   用滚动事件把用户意图记下来，隐藏→显示时才能恢复正确的跟随行为。
   */
  let followLatest = true;
  list.addEventListener('scroll', () => { followLatest = isAtBottom(); }, { passive: true });

  /**
   * 面板从隐藏变可见（clientHeight 0 → 非 0）时补一次跟随。
   * 为什么需要：隐藏期间追加的日志不会触发滚动（scrollTop 赋值在不可见元素上无效），
   *   展开后就会停在顶部——这也是"刷新/展开后看不到最新"的一个来源。
   */
  let lastClientHeight = 0;
  function watchListResize() {
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => {
      const h = list.clientHeight;
      if (lastClientHeight === 0 && h > 0 && followLatest) scrollToBottom();
      lastClientHeight = h;
    });
    ro.observe(list);
  }
  watchListResize();

  function updateCount(n) {
    countEl.textContent = `${n} 条`;
    // 收起态那颗胶囊上的徽标：收起后用户看不到标题栏，条数只能靠它
    if (badgeEl) badgeEl.textContent = String(n);
  }

  /**
   * 多选级别过滤：**只显示被勾选的那几档**（任意组合）。
   *   为什么不是阈值：阈值表达不了"只看警告+错误"（不要信息）这种真实诉求。
   *   条目本身仍在环形缓冲与 /api/diag 里，勾回来即恢复，不丢数据。
   * @param {{level?: string}} record
   */
  function levelPass(record) {
    const levels = state.levels;
    if (!(levels instanceof Set)) return true;
    const lv = DEBUG_LEVELS.includes(record.level) ? record.level : 'info';
    return levels.has(lv);
  }

  /**
   * 全量重绘（初始化 / 清空后 / 切换过滤 / 样式就绪后）。
   *
   * 滚动语义（标准日志面板）：只有"用户本来就在底部"时才跟着滚到最新一条；
   *   正在向上翻阅时**一律不打断**——否则切过滤/点空白/来一条新日志都会把视线拽回底部。
   * @param {{forceBottom?: boolean}} [opts] forceBottom：清空后无内容可看，回底属合理
   */
  function renderAll(opts = {}) {
    const forceBottom = opts.forceBottom === true;
    const stick = forceBottom || followLatest;   // ← 必须在 replaceChildren 之前测
    const records = log.entries().filter(levelPass);
    list.replaceChildren();
    if (!records.length) {
      const allOff = state.levels instanceof Set && state.levels.size === 0;
      list.append(el('div', 'dbg-empty', allOff ? '已关闭全部级别（点上方档位恢复显示）' : '暂无日志'));
    }
    else for (const record of records) list.append(renderEntry(record, state));
    updateCount(records.length);
    if (stick) scrollToBottom();
  }

  /**
   * 批量刷新：高频错误下每帧最多重绘一次。
   * 为什么不在 subscribe 里直接 append：一次网络风暴可能几十条同时到，
   *   逐条 append + 滚动会把主线程钉住（面板本来就不该拖慢页面）。
   */
  let pending = [];
  let scheduled = false;
  function scheduleRender(entry) {
    if (entry === null) { pending = []; renderAll({ forceBottom: true }); return; }
    pending.push(entry);
    if (scheduled) return;
    scheduled = true;
    const run = () => {
      scheduled = false;
      const batch = pending;
      pending = [];
      if (!batch.length) return;
      const stick = followLatest;   // 先测：append 之后 scrollHeight 变大，就判断不出用户原本在底部
      const hasEmpty = !!list.querySelector('.dbg-empty');
      if (hasEmpty) list.replaceChildren();
      for (const record of batch) if (levelPass(record)) list.append(renderEntry(record, state));
      updateCount(list.childElementCount);
      if (stick) scrollToBottom();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  return { renderAll, appendEntry: scheduleRender, scrollToBottom, isAtBottom, list };
}

/**
 * 让面板显隐跟随日志开关（关闭只是隐藏，实例保留）。
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
function wireControls({ shell, view, log, state, dragRef }) {
  /** 清空：先清数据再重绘，异常也保证界面回到空态 */
  function onClear() {
    try { log.clear(); } finally { view.renderAll(); }
  }

  /**
   * 折叠/展开。
   *
   * 实现口径：只切 `data-collapsed`，动画全部交给 CSS（高度 0fr↔1fr + 透明度 + 位移）。
   *   **不能再写 `list.hidden`** —— 那会让列表瞬间从布局里消失，高度过渡就没得可动，
   *   动画会退化成"啪一下不见了"。列表留在文档里、由外层 .dbg-shell 把轨道压到 0，
   *   内容被 overflow:hidden 裁掉，视觉上同样干净。
   * @param {boolean} next 目标状态
   */
  function setCollapsed(next, opts) {
    state.collapsed = !!next;
    shell.root.dataset.collapsed = String(state.collapsed);
    // S4：把用户这次选择记下来（opts.persist === false 用于启动回放，不写盘）
    if (!opts || opts.persist !== false) {
      try { uiState.setDebugCollapsed(state.collapsed); } catch { /* 存储不可用就只在当前页面存活期内生效 */ }
    }
    // 形态一换盒子尺寸就变（胶囊 120×30 ↔ 面板 322×422）：
    //   交给 drag 重新定位 —— 展开时会**重新判断方向**（靠右向左长、靠下向上长），
    //   所以从任何位置展开都放得下，胶囊态的拖动范围也不必预留展开空间。
    try { if (dragRef.api) dragRef.api.applyForm(state.collapsed ? 'collapsed' : 'expanded'); } catch { /* 定位失败不影响展开 */ }
    shell.btnCollapse.title = state.collapsed ? '展开' : '收起';
    shell.btnCollapse.setAttribute('aria-label', state.collapsed ? '展开日志面板' : '收起日志面板');
    shell.pill.setAttribute('aria-expanded', String(!state.collapsed));
    if (!state.collapsed) {
      // 收起期间新增的条目是按"收起态"渲染的（不建 DOM）；展开时整表重绘一次补齐
      try { view.renderAll(); } catch { /* 渲染失败不影响展开 */ }
      view.scrollToBottom();
    }
  }

  function onCollapse() { setCollapsed(!state.collapsed); }
  /** 胶囊点击 = 展开（收起态下唯一可见的入口） */
  function onPillOpen() { if (state.collapsed) setCollapsed(false); }

  shell.btnClear.addEventListener('click', onClear);
  shell.btnCollapse.addEventListener('click', onCollapse);
  shell.pill.addEventListener('click', onPillOpen);

  // 订阅：新条目增量追加；null 表示「已清空」→ 整表重绘
  const unsubscribe = log.subscribe((entry) => {
    try {
      if (entry === null) view.renderAll();
      else view.appendEntry(entry);
    } catch {
      // 面板渲染失败不能影响业务
    }
  });

  return { onClear, onCollapse, onPillOpen, setCollapsed, unsubscribe };
}

/** diag 条目的正文：event + 数据摘要（截断与 log.js 的 300 字规则一致） */
/** 超长正文截断（面板一行能放下的量级） */
function clip(text) {
  const s = String(text || '');
  return s.length > 300 ? `${s.slice(0, 290)}…` : s;
}

/** data 字段序列化成一行；不可序列化时给明确标记而不是抛错 */
function dataToText(data) {
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') return data;
  try {
    const text = JSON.stringify(data);
    // 空对象/空数组与"没有 detail"等价：单独输出一行 `{}` 是纯噪音
    //   （服务端 core/log.mjs 的 detailText 用的是同一判据，两端必须一致）。
    //   用序列化结果比较而不是 Object.keys().length：一次覆盖数组/数字/布尔，
    //   也顺手避开 `Object.keys(new Date()).length === 0` 这种"看起来空其实有值"的陷阱。
    return (text === '{}' || text === '[]') ? '' : text;
  } catch { return '[unserializable]'; }
}

function diagMessage(entry) {
  // 正文优先：应用侧（stageStatus / camera / debugLog.log）都带了 message，直接用它
  if (entry && typeof entry.message === 'string' && entry.message) return clip(entry.message.trim());
  const head = String((entry && (entry.event || entry.src)) || 'event');
  const tail = dataToText(entry && entry.data);
  return clip(tail ? `${head} · ${tail}` : head);
}

/**
 * 注册 diag sink：把探针事件转写进调试日志缓冲。
 *
 * 为什么放在面板这一侧：log 实例与面板是一起装配的（panel/shell-controls.js），
 *   面板知道"该往哪个 log 写"；diag 只需要提供 addSink 通道，不必知道 UI。
 * 防自激：addExternal 只写缓冲 + 广播，不再回头调 __DIAG__.event，所以不会递归。
 *
 * @param {object} log createDebugLog() 实例
 * @returns {() => void} 取消订阅
 */
function registerDiagSink(log) {
  const diagApi = typeof window !== 'undefined' ? window.__DIAG__ : null;
  if (!diagApi || typeof diagApi.addSink !== 'function') return () => {};
  if (typeof log.addExternal !== 'function') return () => {};
  // 同一条目可能既来自"补历史"又来自"订阅推送"（dump 与 sink 是两条路），按 diag 条目 id 去重
  const seen = new Set();
  const forward = (entry) => {
    if (!entry) return;
    const id = entry.id;
    if (id !== undefined) { if (seen.has(id)) return; seen.add(id); }
    // 交互流水（pointerdown / wheel）不进面板：它们由 diag 继续采集（/api/diag 可查），
    //   相机动作另有 __WEB__.cameraLog；面板是"看问题"的地方，不该被每点一下刷一行。
    const tag = String(entry.tag || entry.event || '');
    const lcTag = tag.toLowerCase();
    // 状态行已经通过 STAGE 通道进来过一次；console 监听会把同一条再抓一遍（%c[STAGE:…]），
    //   重复行对排障没用，这里把它滤掉，避免每条状态都显示两遍。
    // 正文要按 diag 条目的真实结构取（sink 层没有 message 字段，是 diagMessage 现算的）
    let msgText = '';
    try { msgText = String(diagMessage(entry) || ''); } catch { msgText = ''; }
    const rawText = (entry.data && entry.data.text) ? String(entry.data.text) : '';
    // 控制台镜像去重：应用自己 console 出去的 [STAGE:] / [CAMERA] 已经通过各自通道进过一次
    const isMirror = (t) => t.indexOf('[STAGE:') !== -1 || t.indexOf('[CAMERA]') !== -1;
    if (lcTag === 'console' && (isMirror(msgText) || isMirror(rawText))) return;
    try {
      log.addExternal({
        ts: Date.parse(entry.t) || Date.now(),
        level: entry.level,
        tag: entry.tag || entry.event || entry.src,
        message: diagMessage(entry),
        src: entry.src,
        event: entry.event,
        data: entry.data,
      });
    } catch { /* 转写失败不影响探针 */ }
  };
  // 先补历史再订阅：面板是在页面启动后才装配的，之前的事件只躺在 diag 缓冲里。
  //   不补这一段，面板显示的是"半截现场"，与 GET /api/diag 的条数永远对不上（排查时极易误判为漏采）。
  try { for (const past of (diagApi.dump() || [])) forward(past); } catch { /* 补历史失败不影响后续订阅 */ }
  return diagApi.addSink(forward);
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
  // S4：收起状态也持久化（位置/四档 S3 已收编，同处 debug 段）。
  //   默认 false（展开）—— 首次访问不能一进来就是收起的，那看起来像面板坏了。
  const state = { collapsed: uiState.getDebugCollapsed(), levels: new Set(loadLevels()) };
  const shell = createShell(doc, container);
  // 防闪烁：面板样式是异步 <link>，样式到位前这块 DOM 会以"无样式裸块"绘制，
  //   刷新时会闪一大片（看起来像样式加载失败）。先 visibility:hidden，样式就绪再显形；
  //   link 出错或超时也放开，保证面板不会永久不可见。
  const revealWhenStyled = () => { try { shell.root.style.visibility = ''; } catch { /* 忽略 */ } };
  try { shell.root.style.visibility = 'hidden'; } catch { /* 忽略 */ }
  // 拖拽句柄在 wireControls 之后才创建，而展开逻辑要用它做"重新夹取"：
  //   用一个可变容器传递（直接闭包引用会在创建前触发 TDZ）。
  const dragRef = { api: null };
  const view = createRenderer({ log, list: shell.list, countEl: shell.countEl, badgeEl: shell.badge, state });
  const wired = wireControls({ shell, view, log, state, dragRef });
  const unwatchVisibility = syncVisibility({ root: shell.root, view, log });

  // 样式表异步加载：加载完成前列表没有高度约束，「滚到底」无效，故就绪后重绘一次；
  //   同时也是"防闪烁"的解锁点（样式一到就显形）。
  if (linkEl) {
    linkEl.addEventListener('load', () => {
      revealWhenStyled();
      try { view.renderAll(); } catch { /* 重绘失败不影响业务 */ }
    }, { once: true });
    linkEl.addEventListener('error', revealWhenStyled, { once: true });
    setTimeout(revealWhenStyled, 800); // 兜底：慢网络/缓存异常也不至于一直看不见
  } else {
    revealWhenStyled(); // 样式表本来就在（重复挂载/已加载过）
  }

  // ---------------------------------------------------------------- diag → 面板（唯一数据源）
  // 三类事件（应用 / 运行时异常 / 网络）都从 __DIAG__ 的 sink 进来：
  //   注释掉这一段，面板会一条都不再产生 —— 这正是"接通了"的反向证明。
  const sinkOff = registerDiagSink(log);

  // 级别多选：点一下切一档，任意组合；切换后整表重绘（数据在缓冲里，重绘成本低）
  /** 把 Set 刷到按钮的激活态与 aria-pressed（对屏幕阅读器也是"按下/未按下"） */
  function paintLevels() {
    for (const [level] of LEVEL_UI) {
      const btn = shell.levelBtns[level];
      if (!btn) continue;
      const on = state.levels.has(level);
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(on));
    }
  }
  function onLevelClick(ev) {
    const level = ev.currentTarget && ev.currentTarget.dataset ? ev.currentTarget.dataset.level : '';
    if (!level) return;
    if (state.levels.has(level)) state.levels.delete(level);
    else state.levels.add(level);
    paintLevels();
    saveLevels(state.levels);
    view.renderAll();
  }
  for (const [level] of LEVEL_UI) {
    const btn = shell.levelBtns[level];
    if (btn) btn.addEventListener('click', onLevelClick);
  }
  paintLevels();

  // 浮层可拖动 + 记住位置（只移动，不做缩放）
  // 两个手柄：展开态拖第 1 行；收起态拖胶囊（此时标题栏高度为 0，抓不到）
  const drag = createPanelDrag({ root: shell.root, head: [shell.head, shell.pill] });
  dragRef.api = drag;
  // S4：先按工厂恢复"收起/展开"，再恢复位置 —— 顺序不能反：
  //   收起态与展开态是两套盒子尺寸，先定位再切形态会让像素位置按错误的盒子算（会歪）。
  //   persist:false 保证这是"回放"，不会把刚读回的值又写一遍。
  try { wired.setCollapsed(state.collapsed, { persist: false }); } catch { /* 回放失败就用 CSS 默认（展开） */ }
  drag.restore();
  // 样式表是**异步注入**的：样式到位前面板还是"无样式裸块"，尺寸与 --dbg-w/--dbg-h 都不可用，
  //   此时按尺寸夹取会把存下的位置夹歪（实测：存 top=658，样式前恢复到 532）。
  //   样式就绪后再恢复一次（幂等），并在下一帧补一次兜底。
  if (linkEl) linkEl.addEventListener('load', () => { try { drag.restore(); } catch { /* 忽略 */ } }, { once: true });
  requestAnimationFrame(() => { try { drag.restore(); } catch { /* 忽略 */ } });

  // 上传日志：数据源统一从 infra/log.js 的 recent() 取（stageStatus 与 diag 事件都在里面）
  const uploader = createUploader({
    button: shell.btnUpload,
    statusEl: shell.uploadStatus,
    readState: () => ({
      version: (typeof window !== 'undefined' && window.__WEB__ && window.__WEB__.version) || '',
      selectedModel: state.selectedModel || null,
      renderer: state.currentRenderer || null,
    }),
  });
  const onUpload = () => { uploader.run(); };
  shell.btnUpload.addEventListener('click', onUpload);

  view.renderAll();

  // 把上传句柄挂到 __WEB__（供自动化断言三态；不存在就下次挂载再挂）
  try {
    if (typeof window !== 'undefined' && window.__WEB__) window.__WEB__.logUpload = uploader;
  } catch { /* 忽略 */ }

  // 把拖动句柄挂到 __WEB__（供自动化读节流计数；不存在就下次挂载再挂）
  try {
    if (typeof window !== 'undefined' && window.__WEB__) window.__WEB__.debugPanelDrag = drag;
  } catch { /* 忽略 */ }

  return {
    drag,
    element: shell.root,
    /**
     * 按工厂当前值回放"收起/展开"（幂等，persist:false 不写盘）。
     *
     * 为什么需要它：调试浮层可能在**读回之前**就被挂载（渲染器就绪即建面板），
     *   那一刻工厂里还没有持久值 ⇒ 只能按默认（展开）挂上。等启动读回完成后，
     *   由 applyDebugLog 再调一次本方法把真实状态补上（否则刷新后"收起"记不住）。
     */
    restoreCollapsed() {
      try { wired.setCollapsed(uiState.getDebugCollapsed(), { persist: false }); return true; } catch { return false; }
    },
    destroy() {
      try { wired.unsubscribe(); } catch { /* 忽略 */ }
      try { unwatchVisibility(); } catch { /* 忽略 */ }
      try { drag.dispose(); } catch { /* 忽略 */ }
      shell.pill.removeEventListener('click', wired.onPillOpen);
      shell.btnUpload.removeEventListener('click', onUpload);
      shell.btnClear.removeEventListener('click', wired.onClear);
      shell.btnCollapse.removeEventListener('click', wired.onCollapse);
      try { sinkOff(); } catch { /* 忽略 */ }
      for (const [level] of LEVEL_UI) {
        const btn = shell.levelBtns[level];
        if (btn) btn.removeEventListener('click', onLevelClick);
      }
      shell.root.remove();
      if (linkEl && linkEl.parentNode) linkEl.remove();
    },
  };
}
