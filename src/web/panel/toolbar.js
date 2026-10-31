// src/web/panel/toolbar.js —— 顶栏渲染器（内置 + 插件按钮走同一套）
//
// 两类按钮的差异只有"事件怎么来"：
//   · 内置：DOM id 与旧手写按钮**完全一致**（btn-library / btn-menu / …），
//     所以既有连接层（topbar-actions.js 按 id getElementById 绑事件）**一行都不用改**。
//   · 插件：点击走 onAction（与面板控件同一套回调通道），由装配层注入。
//
// 渲染器不认识业务、不发请求、不碰状态：只按数据造节点。

import { svgIcon } from './icons.js';
import { PLUGIN_TOOLBAR_MAX, TOOLBAR_ACTIONS, iconBodyOf } from './toolbar-schema.js';

// ⚠️ 这里**不能**顶层 import app/status.js（它 → app/context.js，会在模块加载时
//   用 getElementById 把顶栏按钮快照成 null）。顶栏渲染必须发生在 context 之前，
//   所以日志能力由装配层注入（opts.log），渲染器本身保持"零依赖 app 层"。

/**
 * 造一个顶栏按钮（内置与插件共用）。
 * @param {{id:string, label:string, title?:string, icon?:string, pressed?:string, pluginId?:string}} item
 * @returns {HTMLButtonElement}
 */
function buildButton(item) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn';
  btn.id = String(item.id || '');
  // 可访问名与 tooltip 分开：tooltip 可以更短（与旧 HTML 的口径一致）
  btn.setAttribute('aria-label', String(item.label || item.id || ''));
  btn.title = String(item.title || item.label || item.id || '');
  if (item.pressed === 'true' || item.pressed === 'false') btn.setAttribute('aria-pressed', item.pressed);
  if (item.pluginId) {
    btn.dataset.pluginId = String(item.pluginId);
    btn.dataset.pluginToolbar = '1';   // 重建时按它清理，不影响内置按钮节点
  }
  const body = iconBodyOf(item.icon);
  if (body) {
    btn.append(svgIcon(body));
  } else {
    // 图标名不在白名单（或没给）：只显示文本 label —— 绝不放行任意标记
    const text = document.createElement('span');
    text.className = 'icon-btn-text';
    text.textContent = String(item.label || item.id || '');
    btn.append(text);
  }
  return btn;
}

/**
 * 渲染内置按钮（幂等：已渲染过就直接返回）。
 *
 * 必须在 main.js 之前跑：`context.js` 在模块加载时用 getElementById 缓存这些节点。
 * @param {HTMLElement} nav 顶栏 `<nav class="header-actions">`
 * @returns {number} 本次新建的按钮数
 */
export function mountToolbar(nav) {
  if (!nav) return 0;
  if (nav.dataset.toolbarMounted === '1') return 0;
  const items = [...TOOLBAR_ACTIONS].sort((a, b) => (a.order || 0) - (b.order || 0));
  for (const item of items) nav.append(buildButton(item));
  nav.dataset.toolbarMounted = '1';
  return items.length;
}

/**
 * 同步插件按钮（每次面板重建后调用）。
 *
 * 规则（设计 §7.2 的声明式纪律）：
 *   · 只追加在内置按钮之后，按 order 升序（缺省 1000）
 *   · 图标只认白名单名字，拿不到就只显示文本
 *   · 超过 PLUGIN_TOOLBAR_MAX 的部分不渲染，并记一条 info（溢出菜单留后续）
 * @param {HTMLElement} nav 顶栏 nav
 * @param {Array} entries 插槽登记项（name === 'toolbar.actions'）
 * @param {{onAction?: (entry:object, ev:MouseEvent) => void}} [opts]
 * @returns {{added:number, skipped:number}}
 */
/**
 * 单值插槽 `panel.brand`：换掉顶栏品牌名（**纯文本**，不做标记解析）。
 *
 * 生效模型："后注册者胜出"——按全局注册序号 seq 取最大的那条；
 *   它的 disposer 执行后自然回退到**上一个**注册者（不是直接回内置），因为记录被移除后
 *   重新算一遍"最大 seq"就落到前一条。一条都没有时用内置文本。
 * @param {HTMLElement} el 品牌元素（#brand-title）
 * @param {Array} entries 插槽登记项
 * @param {{fallback?: string}} [opts]
 * @returns {{text: string, pluginId: string|null}}
 */
export function syncBrand(el, entries, opts = {}) {
  const fallback = String(opts.fallback || 'ModelStage');
  if (!el) return { text: fallback, pluginId: null };
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && String(e.name || '') === 'panel.brand')
    .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  const top = list.length ? list[list.length - 1] : null;
  const spec = (top && top.spec) || {};
  // 文本取 spec.text / spec.label；用 textContent 写入（HTML 字符串会被当字面文本，不会解析）
  const text = top ? String(spec.text != null ? spec.text : (spec.label != null ? spec.label : '')) : fallback;
  el.textContent = text || fallback;
  if (top) el.dataset.brandPlugin = String(top.pluginId || '');
  else delete el.dataset.brandPlugin;
  return { text: el.textContent, pluginId: top ? String(top.pluginId || '') : null };
}

export function syncPluginToolbar(nav, entries, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  if (!nav) return { added: 0, skipped: 0 };
  // 先清掉上一轮的插件按钮（内置按钮有 data-toolbar-mounted 保护，不会被误伤）
  for (const old of [...nav.querySelectorAll('[data-plugin-toolbar="1"]')]) old.remove();
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && String(e.name || '') === 'toolbar.actions')
    .sort((a, b) => (Number(a.order) || 1000) - (Number(b.order) || 1000));
  let added = 0;
  let skipped = 0;
  for (const entry of list) {
    if (added >= PLUGIN_TOOLBAR_MAX) {
      skipped += 1;
      continue;
    }
    const spec = (entry && entry.spec) || {};
    const btn = buildButton({
      id: String(entry.id || `plugin-toolbar-${added}`),
      label: String(spec.label || entry.label || entry.id || ''),
      title: String(spec.title || spec.label || entry.label || entry.id || ''),
      icon: String(spec.icon || ''),
      pluginId: entry.pluginId,
    });
    btn.addEventListener('click', (ev) => {
      try {
        if (typeof opts.onAction === 'function') opts.onAction(entry, ev);
      } catch { /* 插件回调抛错不影响顶栏 */ }
    });
    nav.append(btn);
    added += 1;
  }
  if (skipped) {
    log('info', `顶栏插件按钮超过上限（${PLUGIN_TOOLBAR_MAX} 个），已跳过 ${skipped} 个：${list
      .slice(PLUGIN_TOOLBAR_MAX).map((e) => e.id).join(' / ')}`, { source: 'plugin-toolbar' });
  }
  return { added, skipped };
}
