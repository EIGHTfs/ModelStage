// app/view-settings.js —— 展示类设置的持久化与落地（主题 / 背景）
//
// 这些设置与渲染器无关：主题只改 CSS 变量所在属性，背景由 Surface 写 data-bg 后交给 CSS。
// 存储沿用旧端的同一个键与结构（{uiTheme, background:{mode,color,imageUrl}}；旧版的 partFilter* 已下线并清理），
// 新旧实现共用一份，切换时用户看到的选择不会丢。

import { state } from './context.js';
import { defaultSolidColor } from './background-solids.js';

/** 视图设置存储键：主题、背景等展示类设置（全站唯一的偏好键，面板/布局/调试段都在里面） */
export const VIEW_SETTINGS_KEY = 'spine-viewer-settings-v2';

/** 已下线的视图设置字段：读到就地清掉，避免"看不见的设置还在生效/还在占存储" */
const DEPRECATED_VIEW_KEYS = ['partFilterEnabled', 'partFilterKeywords'];

/**
 * 读视图设置（结构：{uiTheme, background:{mode,color,imageUrl}, panel, layout, debug}）。
 * 副作用：**顺手清理已下线字段**（一次写回），这样老 localStorage 里的残留会被自然淘汰，
 *   不用用户手动清缓存，也不会因为残留字段让"看不见的设置"继续生效。
 */
export function readViewSettings() {
  let s;
  try {
    s = JSON.parse(localStorage.getItem(VIEW_SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
  if (!s || typeof s !== 'object') return {};
  const stale = DEPRECATED_VIEW_KEYS.filter((k) => k in s);
  if (stale.length) {
    for (const k of stale) delete s[k];
    try { localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify(s)); } catch { /* 写不了就只保留内存态 */ }
  }
  return s;
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

/** 自定义背景图片上限（dataURL 存 localStorage，太大不安全） */
const MAX_BG_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * 自定义背景：取一张本地图片作为舞台背景。
 * 为什么用 dataURL 而不是 objectURL：要跟着视图设置一起持久化（localStorage），
 *   objectURL 只活在当前页面生命周期里，刷新即失效；文件过大时拒绝并提示，避免把存储写爆。
 * @returns {Promise<boolean>} 是否落地成功
 */
export function pickBackgroundImage() {
  return new Promise((resolve) => {
    // 标准做法：<label> 包 <input type="file">，点 label 即触发选择框（不需要 JS 绑定 click）
    const label = document.createElement('label');
    label.classList.add('file-picker-hidden');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    label.append(input);
    document.body.append(label);
    // 仍需要 change 才能拿到文件内容（这是数据回调，不是"点击代理"）
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      label.remove();
      if (!file) { resolve(false); return; }
      if (file.size > MAX_BG_IMAGE_BYTES) {
        document.documentElement.dataset.bgError = `图片过大（${Math.round(file.size / 1024)}KB > ${MAX_BG_IMAGE_BYTES / 1024 / 1024}MB）`;
        resolve(false);
        return;
      }
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        const url = String(reader.result || '');
        setCustomBackground(url);
        resolve(!!url);
      }, { once: true });
      reader.addEventListener('error', () => { resolve(false); }, { once: true });
      reader.readAsDataURL(file);
    }, { once: true });
    label.click();   // 点 label 等价于点 input（原生行为）
    document.documentElement.dataset.bgPicker = 'open';
  });
}

/** 把图片落到舞台背景并持久化（data-bg=custom 时 CSS 不再画底色，由内联 backgroundImage 负责） */
export function setCustomBackground(url) {
  const stageEl = document.getElementById('stage');
  if (!stageEl) return false;
  stageEl.dataset.bg = url ? 'custom' : 'checkerboard';
  // 内联例外（契约《禁止内联CSS与JS》§3.1 动态计算值）：
  //   背景图 URL 属于运行时数据（从界面导入或粘贴产生），不可能预先写进 CSS；
  //   size/position 是跟随该 URL 的联动值。颜色/边框/字体等设计令牌一律走 CSS 变量。
  stageEl.style.backgroundImage = url ? `url("${url}")` : '';
  // 没有图就不要留 cover（否则空 url 也会把棋盘图案拉伸）
  stageEl.style.backgroundSize = url ? 'cover' : '';
  stageEl.style.backgroundPosition = url ? 'center' : '';
  state.viewBg = 'custom';
  saveViewSettings({ background: { mode: 'custom', color: defaultSolidColor(), imageUrl: url || '' } });
  document.documentElement.dataset.bgImage = url ? 'set' : 'none';
  return !!url;
}

/** 背景模式：写舞台容器的 data-bg，具体底色由 CSS 决定；custom 走文件选择器 */
export function applyBackground(mode) {
  const stageEl = document.getElementById('stage');
  if (!stageEl) return;
  const m = mode || 'checkerboard';
  if (m === 'custom') {
    // 已经选过图就直接用回来，没有才让用户选（避免每次切档都弹框）
    const saved = (readViewSettings().background || {}).imageUrl || '';
    if (saved) { setCustomBackground(saved); return; }
    pickBackgroundImage();
    return;
  }
  // 三个内联样式都要清：只清 backgroundImage 不够——自定义图设过 background-size:cover，
  //   留着会把棋盘格/纯色依赖的 CSS 图案尺寸覆盖成 cover（整块拉伸成一个巨大格子，看着"背景不对"）。
  stageEl.style.backgroundImage = '';
  stageEl.style.backgroundSize = '';
  stageEl.style.backgroundPosition = '';
  // 纯色模式：颜色值由 CSS 变量 --stage-solid 驱动（panel.css 里 #stage[data-bg="solid"] 读它）
  //   颜色属于运行时数据 ⇒ 以变量下发，不写 style.background 字面量（契约 §3.1 动态值例外）
  const savedColor = (readViewSettings().background || {}).color || defaultSolidColor();
  if (m === 'solid') { try { stageEl.style.setProperty('--stage-solid', savedColor); } catch { /* 忽略 */ } }
  // 背景唯一入口：交给 Surface（它会写 data-bg 并通知所有渲染器）
  try {
    if (state.surface && typeof state.surface.setBackground === 'function') state.surface.setBackground(m);
    else stageEl.dataset.bg = m;
  } catch { stageEl.dataset.bg = m; }
  state.viewBg = m;
  // 广播一次：右栏档位与底栏下拉都靠它同步（谁改的都能收敛到同一状态）
  try { document.dispatchEvent(new CustomEvent('panel:bg-applied', { detail: { mode: m } })); } catch { /* 忽略 */ }
  const cur = readViewSettings();
  saveViewSettings({
    background: {
      mode: m,
      color: (cur.background && cur.background.color) || defaultSolidColor(),
      imageUrl: (cur.background && cur.background.imageUrl) || '',
    },
  });
}


/**
 * 应用一个纯色（并切到纯色模式）。
 *
 * 语义：**存的是颜色值本身，不是预设 id** —— 预设只是快捷方式，
 *   因此预设被删/改名都不会影响已经选中的颜色（这也是它敢放在界面上随便改的前提）。
 * @param {string} color '#rrggbb'（非法时回落到默认预设色）
 * @returns {boolean} 是否成功应用
 */
export function setBackgroundColor(color) {
  const stageEl = document.getElementById('stage');
  if (!stageEl) return false;
  const ok = /^#[0-9a-f]{6}$/i.test(String(color || ''));
  const c = ok ? String(color).toLowerCase() : defaultSolidColor();
  try { stageEl.style.setProperty('--stage-solid', c); } catch { return false; }
  state.viewBg = 'solid';
  try {
    if (state.surface && typeof state.surface.setBackground === 'function') state.surface.setBackground('solid');
    else stageEl.dataset.bg = 'solid';
  } catch { stageEl.dataset.bg = 'solid'; }
  // 与切模式同一条广播：右栏档位/底栏下拉都靠它收敛
  try { document.dispatchEvent(new CustomEvent('panel:bg-applied', { detail: { mode: 'solid' } })); } catch { /* 忽略 */ }
  const cur = readViewSettings();
  saveViewSettings({
    background: {
      mode: 'solid',
      color: c,
      imageUrl: (cur.background && cur.background.imageUrl) || '',
    },
  });
  return true;
}
