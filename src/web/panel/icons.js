// panel/icons.js —— 面板内联图标（不引图标库，与顶栏/底栏同一套线条风格）
//
// 单独成模块的原因：panel/view.js 要守 400 行上限，图标只是数据 + 一个小工厂。

/** 设置动作按钮的图标（按按钮文字取，避免再维护一套 id 表） */
export const ACTION_ICONS = {
  导出设置: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polygon points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  导入设置: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polygon points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  恢复默认: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/>',
};

/**
 * 顶栏图标。形状取自 lucide 图标库的同名组件（PanelLeft / PanelRight）：
 *   PanelLeft  = rect(3,3,18,18,r2) + path M9 3v18
 *   PanelRight = rect(3,3,18,18,r2) + path M15 3v18
 * 顶栏按钮在 index.html 里只放空 <svg> 占位，path 由 applyTopbarIcons() 从这里注入，
 *   保证图标只有这一处来源。
 */
export const TOPBAR_ICONS = {
  panelLeft: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  panelRight: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
};

/** 把顶栏图标的 path 注入到按钮里的 <svg>；返回注入个数 */
export function applyTopbarIcons(doc = document) {
  const map = { 'btn-library': TOPBAR_ICONS.panelLeft, 'btn-menu': TOPBAR_ICONS.panelRight };
  let filled = 0;
  for (const [id, body] of Object.entries(map)) {
    const svg = doc.querySelector(`#${id} svg`);
    if (!svg) continue;
    svg.innerHTML = body;
    filled += 1;
  }
  return filled;
}

/** 分组标题图标 */
export const GROUP_ICONS = {
  motion: '<path d="M4 4h16v16H4z"/><path d="M4 9h16"/><path d="m9 4 2 5"/><path d="m15 4 2 5"/><path d="M8 14h8v6H8z"/>',
  // Shirt：lucide 图标库的 Shirt path
  skin: '<path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  filter: '<path d="m5 3 7 9v6h2v-6l7-9H5z"/><path d="M12 18v3"/>',
  pma: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
  runtime: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z"/>',
  theme: '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 1 0 0 20 2.5 2.5 0 0 0 0-5 2.5 2.5 0 0 1 0-5h5a3 3 0 0 0 3-3 7 7 0 0 0-8-7z"/>',
  debug: '<path d="M14.7 6.3a4 4 0 0 1 5 5L21 13l-8 8-6-6 8-8z"/><path d="m6 15-3 3 3 3 3-3"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
};

/** 生成包住 svg 的 span（aria-hidden，装饰性） */
export function svgIcon(body) {
  const span = document.createElement('span');
  span.className = 'btn-icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  return span;
}
