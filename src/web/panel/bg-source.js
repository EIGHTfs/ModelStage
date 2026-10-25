// panel/bg-source.js —— 背景「来源」的统一数据层与渲染层（右栏与底栏共用这一份）
//
// 为什么要有这一层：背景来源有两处入口（右栏二级列表 / 底栏两级菜单），
//   如果两边各写一套"列出哪些来源 + 哪个是选中"，加一种新来源（例如渐变）就得改两处，
//   而且两处的选中判定迟早会不一致。这里把「数据」与「渲染」各写一遍，两边都只调它。
//
// 选中判定口径（**颜色值/URL 是唯一真相，预设只是快捷方式**）：
//   · 纯色：按 background.color 匹配；两条预设同色时**只取第一条**（不要两条都打勾）
//   · 自定义：按 background.imageUrl 匹配
//   · 当前 color 不在任何预设里（手动改过 / 预设被删）⇒ 列表内无勾，但「纯色」这一档仍算选中
//
// 本文件只做"读数据 + 画列表 + 回调"，不直接改背景（应用由调用方的 onApply 决定）。

import { el } from './dom.js';
import { listSolids, FALLBACK_COLOR } from '../app/background-solids.js';
import { listBackgrounds } from '../app/backgrounds.js';

/** 内置模式（无列表可展开的两项） */
export const BUILTIN_SOURCES = [
  { id: 'checkerboard', name: '棋盘格' },
  { id: 'transparent', name: '透明' },
];

/**
 * 规范化一个颜色值（小写 #rrggbb）；非法返回空串。
 * @param {unknown} v
 * @returns {string}
 */
export function normColor(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : '';
}

/**
 * 取全部背景来源，按三组返回。
 *
 * @returns {Promise<{builtin:object[], solid:object[], custom:object[], errors:string[]}>}
 *   solid 项：`{ id:'solid:<color>', name, color }`
 *   custom 项：`{ id:'custom:<url>', name, url, thumb }`
 */
export async function listBgSources() {
  const errors = [];
  const [solidsRes, imagesRes] = await Promise.all([
    listSolids().catch((err) => ({ ok: false, items: [], message: String(err && err.message || err) })),
    listBackgrounds().catch((err) => ({ ok: false, items: [], message: String(err && err.message || err) })),
  ]);
  if (!solidsRes.ok) errors.push(solidsRes.message || '取纯色预设失败');
  if (!imagesRes.ok) errors.push(imagesRes.message || '取自定义图片失败');

  const solid = (solidsRes.items || []).map((it) => ({
    // id 必须**唯一**（用预设真实 id）：曾经用 `solid:<color>` 当 id，
    //   两条同色预设有同一个 id ⇒ 选中判定把两条都打上勾（实测踩过）。
    id: `solid:${it.id || normColor(it.color) || FALLBACK_COLOR}`,
    name: it.name,
    color: normColor(it.color) || FALLBACK_COLOR,
    raw: it,
  }));
  const custom = (imagesRes.items || []).map((it) => ({
    id: `custom:${it.url}`,
    name: it.name,
    url: it.url,
    thumb: it.thumbUrl || it.url,
    raw: it,
  }));
  return { builtin: BUILTIN_SOURCES.slice(), solid, custom, errors };
}

/**
 * 当前背景对应哪个来源（选中判定的唯一实现）。
 *
 * @param {{mode?:string, color?:string, imageUrl?:string}} background readViewSettings().background
 * @param {{solid?:object[], custom?:object[]}} [groups] 已取到的分组（用于把 color/url 映射成具体某条）
 * @returns {{groupId:'builtin'|'solid'|'custom', id:string, itemId:string|null}}
 *   `id` 是"档位 id"（builtin 用模式名、solid/custom 用组名），`itemId` 是列表里真正要打勾的那一条。
 */
export function selectedSourceId(background, groups) {
  const bg = background && typeof background === 'object' ? background : {};
  const mode = String(bg.mode || 'checkerboard');
  const color = normColor(bg.color);
  const url = String(bg.imageUrl || '');

  if (mode === 'custom') {
    const hit = url && groups && Array.isArray(groups.custom)
      ? groups.custom.find((it) => it.url === url)
      : null;
    return { groupId: 'custom', id: 'custom', itemId: hit ? hit.id : null };
  }
  if (mode === 'solid') {
    // 同色多条只认第一条（find 天然只返回第一个匹配）
    const hit = color && groups && Array.isArray(groups.solid)
      ? groups.solid.find((it) => it.color === color)
      : null;
    return { groupId: 'solid', id: 'solid', itemId: hit ? hit.id : null };
  }
  // 棋盘格 / 透明：内置档位
  return { groupId: 'builtin', id: mode === 'transparent' ? 'transparent' : 'checkerboard', itemId: null };
}

/**
 * 渲染一组来源列表（右栏行内、底栏二级都用它）。
 *
 * 选中态 = **描边 + ✓ 双标识**（不只靠颜色，色盲/灰度下也能分辨）。
 *
 * @param {HTMLElement} host 容器（会被清空后重填）
 * @param {'solid'|'custom'} groupId 组
 * @param {object[]} items 该组条目（listBgSources 的结果）
 * @param {object} opts
 * @param {string|null} opts.selectedItemId 当前选中条目 id（null = 无勾）
 * @param {(item:object)=>void} [opts.onApply] 点条目应用
 * @param {(item:object)=>void} [opts.onRename] 改名（仅纯色/自定义）
 * @param {(btn:HTMLElement, item:object)=>void} [opts.onRemove] 删除（由调用方做二次确认）
 * @param {()=>void} [opts.onAdd] 底部「添加颜色」
 * @param {()=>void} [opts.onReset] 底部「恢复默认」
 * @param {()=>void} [opts.onUpload] 底部「上传图片」
 * @param {string} [opts.emptyText] 空态文案
 * @param {'panel'|'menu'} [opts.variant] 渲染风格（右栏行内 / 底栏菜单）
 * @returns {{count:number}} 渲染条数
 */
export function renderSourceGroup(host, groupId, items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const o = opts || {};
  const variant = o.variant === 'menu' ? 'menu' : 'panel';
  const rows = [];

  for (const item of list) {
    const isSel = o.selectedItemId && item.id === o.selectedItemId;
    const row = el('div', `bg-src-row bg-src-row--${variant}`);
    row.dataset.srcId = item.id;
    if (isSel) row.dataset.selected = '1';        // 选中态由 CSS 画描边（data-selected）
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(!!isSel));

    // ✓ 标记（与描边一起构成双标识）
    const tick = el('span', 'bg-src-tick', isSel ? '✓' : '');
    tick.setAttribute('aria-hidden', 'true');
    row.append(tick);

    // 色块 / 缩略图
    if (groupId === 'solid') {
      const sw = el('span', 'bg-src-swatch');
      sw.style.setProperty('--swatch', item.color);   // 运行时数据 ⇒ CSS 变量（非内联 background 字面量）
      row.append(sw);
    } else {
      const thumb = el('span', 'bg-src-thumb');
      if (item.thumb) thumb.style.setProperty('--thumb', `url("${item.thumb}")`);
      row.append(thumb);
    }

    row.append(el('span', 'bg-src-name', item.name || item.id));

    // 行内操作：改名 / 删（底栏菜单里不显示，避免菜单里塞二级操作）
    if (variant === 'panel') {
      if (typeof o.onRename === 'function') {
        const rn = el('button', 'bg-btn', '改名');
        rn.type = 'button';
        rn.addEventListener('click', (e) => { e.stopPropagation(); o.onRename(item); });
        row.append(rn);
      }
      if (typeof o.onRemove === 'function') {
        const rm = el('button', 'bg-btn bg-btn-danger', '删');
        rm.type = 'button';
        rm.addEventListener('click', (e) => { e.stopPropagation(); o.onRemove(rm, item); });
        row.append(rm);
      }
    }

    row.addEventListener('click', () => { if (typeof o.onApply === 'function') o.onApply(item); });
    rows.push(row);
  }

  host.replaceChildren(...rows);

  if (!rows.length) {
    const emptyText = o.emptyText || (groupId === 'solid' ? '还没有颜色，点添加' : '还没有图片，点上传');
    host.append(el('p', 'ctl-list-empty', emptyText));
  }

  // 底部操作（仅右栏行内）
  if (variant === 'panel') {
    const foot = el('div', 'bg-src-foot');
    if (groupId === 'solid' && typeof o.onAdd === 'function') {
      const add = el('button', 'bg-btn bg-btn-primary', '+ 添加颜色');
      add.type = 'button';
      add.addEventListener('click', o.onAdd);
      foot.append(add);
    }
    if (groupId === 'custom' && typeof o.onUpload === 'function') {
      const up = el('button', 'bg-btn bg-btn-primary', '上传图片');
      up.type = 'button';
      up.addEventListener('click', o.onUpload);
      foot.append(up);
    }
    if (groupId === 'solid' && typeof o.onReset === 'function') {
      const reset = el('button', 'bg-btn bg-btn-danger', '恢复默认');
      reset.type = 'button';
      reset.addEventListener('click', () => o.onReset(reset));
      foot.append(reset);
    }
    if (foot.children.length) host.append(foot);
  }

  return { count: rows.length };
}
