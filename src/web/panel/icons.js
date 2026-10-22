// panel/icons.js —— 面板内联图标（不引图标库，与顶栏/底栏同一套线条风格）
//
// 单独成模块的原因：panel/view.js 要守 400 行上限，图标只是数据 + 一个小工厂。

/** 设置动作按钮的图标（按按钮文字取，避免再维护一套 id 表） */
export const ACTION_ICONS = {
  导出设置: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polygon points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  导入设置: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polygon points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  恢复默认: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/>',
};

/** 分组标题图标（与旧端同一套语义与配色：主色线条图标） */
export const GROUP_ICONS = {
  motion: '<path d="M4 4h16v16H4z"/><path d="M4 9h16"/><path d="m9 4 2 5"/><path d="m15 4 2 5"/><path d="M8 14h8v6H8z"/>',
  skin: '<path d="M20.4 3.6a2 2 0 0 1 0 2.8L9 17.8 4 19l1.2-5L16.6 3.6a2 2 0 0 1 3.8 0z"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  filter: '<path d="m5 3 7 9v6h2v-6l7-9H5z"/><path d="M12 18v3"/>',
  pma: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
  runtime: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z"/>',
  theme: '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 1 0 0 20 2.5 2.5 0 0 0 0-5 2.5 2.5 0 0 1 0-5h5a3 3 0 0 0 3-3 7 7 0 0 0-8-7z"/>',
  debug: '<path d="M14.7 6.3a4 4 0 0 1 5 5L21 13l-8 8-6-6 8-8z"/><path d="m6 15-3 3 3 3 3-3"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
};

/** 收起菜单（面板头）图标 */
export const COLLAPSE_ICON = '<path d="m9 18 6-6-6-6"/>';

/** 生成包住 svg 的 span（aria-hidden，装饰性） */
export function svgIcon(body) {
  const span = document.createElement('span');
  span.className = 'btn-icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  return span;
}
