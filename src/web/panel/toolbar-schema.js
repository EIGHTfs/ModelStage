// src/web/panel/toolbar-schema.js —— 顶栏按钮的**声明式表**（内置 5 个）
//
// 为什么要有这张表：顶栏原先在 index.html 里手写 5 个 <button>（每个带内联 SVG），
//   插件按钮就没有位置可插、更无法与内置按钮定序。改成"数据 → 渲染"之后，
//   内置与插件按钮走**同一个渲染器**、同一套排序与图标白名单。
//
// 字段口径：
//   id       DOM id（**必须与旧手写按钮一致**：context.js 在模块加载时按 id 取节点）
//   icon     图标名（白名单见 icons.js 的三张表：TOPBAR_ICONS / GROUP_ICONS / ACTION_ICONS）
//   label    aria-label（可访问名）
//   title    tooltip（与 aria-label 可以不同：tooltip 更简短）
//   action   事件名（由连接层 dispatch；渲染器不认识业务）
//   order    升序；插件按钮缺省 1000，因此天然排在内置之后
//   pressed  可选：'true'/'false' 初值的 aria-pressed（开关类按钮）

import { TOPBAR_ICONS, GROUP_ICONS, ACTION_ICONS } from './icons.js';

/** 内置按钮的有效顺序与旧 HTML 完全一致（左→右） */
export const TOOLBAR_ACTIONS = [
  {
    id: 'btn-library',
    icon: 'panelLeft',
    label: '模型库（显示/隐藏左栏）',
    title: '模型库（显示/隐藏左栏）',
    action: 'toggle-left-panel',
    order: 10,
  },
  {
    id: 'btn-menu',
    icon: 'panelRight',
    label: '菜单（显示/隐藏右侧控制面板）',
    title: '菜单（显示/隐藏右侧控制面板）',
    action: 'toggle-right-panel',
    order: 20,
    pressed: 'true',
  },
  {
    id: 'btn-shot',
    icon: 'camera',
    label: '截图导出',
    title: '截图导出（PNG，文件名带模型名与时间戳）',
    action: 'screenshot',
    order: 30,
  },
  {
    id: 'btn-cinema',
    // 影院模式图标是"画框"，与内置分组图标无关，单独登记在 TOOLBAR_EXTRA_ICONS
    icon: 'cinema',
    label: '影院模式（显示/隐藏顶栏与左右栏，Esc 或中心双击退出）',
    title: '影院模式（Esc 或中心双击退出）',
    action: 'toggle-cinema',
    order: 40,
    pressed: 'false',
  },
  {
    id: 'btn-fullscreen',
    icon: 'fullscreen',
    label: '全屏',
    title: '全屏',
    action: 'fullscreen',
    order: 50,
  },
];

/**
 * 顶栏专用图标（内联 SVG 的 path/d 串）：这三种在内置分组表里没有对应项。
 * 从 index.html 原样搬过来，避免"迁移后图标变了"这种无意义回归。
 */
export const TOOLBAR_EXTRA_ICONS = {
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  cinema: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 12h20"/>',
  fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
};

/**
 * 图标白名单：插件只能报**名字**，拿不到就退化成纯文本按钮。
 *
 * 为什么必须白名单：顶栏图标的实现是"注入 SVG 内层 HTML"，
 *   如果允许插件传任意串，等于允许它往宿主 DOM 里塞任意标记（声明式纪律的第一条禁止项）。
 */
export const TOOLBAR_ICON_WHITELIST = new Set([
  ...Object.keys(TOPBAR_ICONS),
  ...Object.keys(GROUP_ICONS),
  ...Object.keys(ACTION_ICONS),
  ...Object.keys(TOOLBAR_EXTRA_ICONS),
]);

/**
 * 按图标名取 SVG 内层内容。
 * @param {string} name 图标名
 * @returns {string|null} 命中白名单返回内层标记；否则 null（调用方退化成文本按钮）
 */
export function iconBodyOf(name) {
  const key = String(name || '');
  if (!key) return null;
  if (TOOLBAR_EXTRA_ICONS[key]) return TOOLBAR_EXTRA_ICONS[key];
  if (TOPBAR_ICONS[key]) return TOPBAR_ICONS[key];
  if (GROUP_ICONS[key]) return GROUP_ICONS[key];
  if (ACTION_ICONS[key]) return ACTION_ICONS[key];
  return null;
}

/**
 * 插件按钮的**安全阀**（不是布局上限）。
 *
 * 历史：S3 时这里是 3，超出即丢弃 —— 用户既看不到按钮也不知道被跳过。
 * 现在布局改成"插件按钮进横向滚动区"，可见性问题由滚动解决；
 *   保留 20 只是防"某个插件一口气注册上百个按钮"把 DOM 撑爆的安全阀。
 * @type {number}
 */
export const PLUGIN_TOOLBAR_MAX = 20;
