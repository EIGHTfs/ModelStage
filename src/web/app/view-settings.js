// app/view-settings.js —— 展示类设置的持久化与落地（主题 / 背景）
//
// 这些设置与渲染器无关：主题只改 CSS 变量所在属性，背景由 Surface 写 data-bg 后交给 CSS。
// 存储沿用旧端的同一个键与结构（{uiTheme, background:{mode,color,imageUrl}, partFilter*…}），
// 新旧实现共用一份，切换时用户看到的选择不会丢。

import { state } from './context.js';

/** 视图设置存储键（与旧端同一键：主题、背景等展示类设置） */
export const VIEW_SETTINGS_KEY = 'spine-viewer-settings-v2';

/** 读视图设置（沿用旧端结构：{uiTheme, background:{mode,color,imageUrl}}） */
export function readViewSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(VIEW_SETTINGS_KEY) || '{}');
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

/** 写视图设置：只覆盖自己管的键，其余字段原样保留（与旧端共用同一份） */
export function saveViewSettings(patch) {
  try {
    const cur = readViewSettings();
    const next = { ...cur, ...patch };
    if (patch.background) next.background = { ...(cur.background || {}), ...patch.background };
    localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify(next));
  } catch { /* 隐私模式等写不了就忽略：持久化是增强 */ }
}

/** 主题：只改 CSS 变量所在的选择器属性，颜色全部集中在 panel.css 的主题色板 */
export function applyTheme(id) {
  const theme = id || 'dark-cyan';
  document.documentElement.dataset.uiTheme = theme;
  state.viewTheme = theme;
  saveViewSettings({ uiTheme: theme });
}

/** 背景模式：写舞台容器的 data-bg，具体底色由 CSS 决定 */
export function applyBackground(mode) {
  const stageEl = document.getElementById('stage');
  if (!stageEl) return;
  const m = mode || 'checkerboard';
  // 背景唯一入口：交给 Surface（它会写 data-bg 并通知所有渲染器）
  try {
    if (state.surface && typeof state.surface.setBackground === 'function') state.surface.setBackground(m);
    else stageEl.dataset.bg = m;
  } catch { stageEl.dataset.bg = m; }
  state.viewBg = m;
  const cur = readViewSettings();
  saveViewSettings({
    background: {
      mode: m,
      color: (cur.background && cur.background.color) || '#2a2a2a',
      imageUrl: (cur.background && cur.background.imageUrl) || '',
    },
  });
}
