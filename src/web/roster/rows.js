// roster-rows.js —— 名册三级树的「行」渲染（纯 DOM 工厂，无状态）（M2）
//
// 做什么：把一条树数据渲染成一个可点击的 treeitem 行，三级别各一个函数。
// 为什么单独一个文件：
//   1. 单文件 ≤400 行的硬约束（视图逻辑 + 行结构放一起会超）；
//   2. 职责分离：本文件只管"一行长什么样"，roster-view.js 只管"状态怎么变、事件怎么派"。
// 约定：每行都带 data-* 标识与 tabindex=0（键盘可达），事件由 roster-view.js 在容器上委托。

import { variantLabel, variantText } from './list.js';

// el 的唯一实现在 infra/dom.js。
//   本文件自己要用它（rowBase 等 15 处），所以必须 import 绑定到本地作用域；
//   同时对外转发导出，roster/view.js 的 `import { el, ... } from './rows.js'` 无需改动。
//   注意：只写 `export { el } from '...'` 是**不绑定本地**的 —— 那些内部调用会变成 undefined。
import { el } from '../infra/dom.js';
// 名册徽标的配色类来自面元数据表（badge 字段）
import { byKind } from '../render/surfaces.js';

export { el };

/** 建一个树行骨架（三级别共用：data 属性 + treeitem 语义 + 键盘可达） */
function rowBase(className, dataset) {
  const row = el('div', `tree-row ${className}`);
  Object.assign(row.dataset, dataset);
  row.setAttribute('role', 'treeitem');
  row.tabIndex = 0; // 键盘可达：Enter/空格与点击等价
  return row;
}

/**
 * 展开箭头：内联 SVG 而不是 ▸/▾ 文字。
 * 为什么不用文字：无桌面字体环境（无头 chromium / 精简系统）里 ▸ ▾ 会渲染成豆腐块，
 *   而它是"能不能展开"的唯一视觉提示，必须稳定可见。
 * @param {boolean} open
 */
function arrowEl(open) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'tree-arrow');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/**
 * 一级：游戏行（按资源根配置的 name 合并后的节点）。
 * 一个游戏可能由多个资源根供给（碧蓝航线 = 3 个根），所以徽标显示根数量、title 列出具体根 id，
 * 数据属性 data-root-ids 供自动化断言核对"这些根都在同一个游戏节点下"。
 * @param {{key: string, name: string, roots: object[]}} game
 * @param {{open: boolean, status: string, charCount: number}} view
 */
export function renderGameRow(game, view) {
  const rootIds = game.roots.map((r) => r.id);
  const row = rowBase('tree-game', { gameKey: game.key, rootIds: rootIds.join(',') });
  row.setAttribute('aria-expanded', String(view.open));
  if (view.open) row.classList.add('is-open');

  row.append(arrowEl(view.open));
  row.append(el('span', 'tree-game-name', game.name));
  // 多根时标注根数（单根不标注，避免噪音）
  if (rootIds.length > 1) {
    const badge = el('span', 'tree-badge', `${rootIds.length} 根`);
    badge.title = rootIds.join(' · ');
    row.append(badge);
  } else {
    row.append(el('span', 'tree-badge', rootIds[0] || ''));
  }

  if (view.status === 'ready') row.append(el('span', 'tree-count', `${view.charCount} 角色`));
  else if (view.status === 'loading') row.append(el('span', 'tree-count', '加载中…'));
  return row;
}

/**
 * 二级：角色行（头像 + 显示名 + 原名标签 + 变体数）。
 * @param {object} game
 * @param {object} c 角色（title/baseName/iconUrl/variants）
 * @param {boolean} open
 */
export function renderCharRow(game, c, open) {
  const row = rowBase('tree-char', { charKey: c.key, gameKey: game.key });
  row.setAttribute('aria-expanded', String(open));
  if (open) row.classList.add('is-open');

  row.append(arrowEl(open));

  if (c.iconUrl) {
    const img = document.createElement('img');
    img.className = 'tree-icon';
    img.src = c.iconUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    row.append(img);
  } else {
    row.append(el('span', 'tree-icon'));
  }

  row.append(el('span', 'tree-char-title', c.title));
  // 「原名」标签：归一化键与显示名不同才有信息增量（照 char-tree.js 的去重规则）
  if (c.baseName && c.baseName !== String(c.title)) row.append(el('span', 'tree-orig', c.baseName));
  row.append(el('span', 'tree-count', c.variants.length));
  return row;
}

/**
 * 三级：变体行（类型标签 + 服装名/目录名 + 原名后缀）。
 * 行上带 data-root-id：证明同一角色节点下确实聚合了来自不同资源根的变体。
 * @param {object} game
 * @param {object} c
 * @param {{model: object, nm: object|null}} v
 * @param {string|null} selectedId 当前选中的模型 id
 */
export function renderVariantRow(game, c, v, selectedId) {
  const m = v.model;
  const { text, origName } = variantText(m, v.nm);
  const row = rowBase('tree-variant', {
    modelId: m.id, gameKey: game.key, charKey: c.key, rootId: m.rootId || '',
  });

  const isSelected = selectedId === m.id;
  if (isSelected) {
    row.classList.add('is-selected');
    row.setAttribute('aria-selected', 'true');
  }

  const label = variantLabel(m);
  // 样式类只用来分组（容器单文件用 bundle 类），**不带颜色**。
  //   颜色/归属/可装载性/失败原因全部来自服务端三字段（契约 §一 INV-D1）：
  //     display.accent  徽标底色（null ⇒ 中性色）
  //     display.provider 归属提供者 id（展示名按 /api/plugins 的 label 查）
  //     display.candidates 候选提供者（按 matchPriority 降序）
  //     support.state   ready | unknown | unsupported
  //     support.detail  不支持时的 { reason, message }（与装载失败文案同源）
  //     loadResult      最近一次真实装载尝试的结果
  //   前端**不做任何判定**：不按 kind 猜色、不自己算"能不能装"、不读 localStorage。
  const meta = byKind(m.kind);
  const kindClass = m.container ? 'bundle' : (meta ? meta.badge : 'spine');
  const typeBadge = el('span', `tree-type tree-type-${kindClass}`, label);
  const display = (m && m.display) || {};
  if (display.accent) typeBadge.style.setProperty('--badge-accent', String(display.accent));
  // 悬浮文案：归属定了说"谁"，没定就把候选列出来（用户悬停就知道该找哪个插件）
  const cands = Array.isArray(display.candidates) ? display.candidates : [];
  if (display.provider) typeBadge.title = `归属：${display.provider}`;
  else if (cands.length) typeBadge.title = `归属待定（候选：${cands.join('、')}）`;
  row.append(typeBadge);
  row.append(el('span', 'tree-variant-text', text));
  if (origName && origName !== text) row.append(el('span', 'tree-variant-orig', ` · ${origName}`));

  // ⚠ 只有一处来源：support 判"装不动"，或 loadResult 判"上次失败"。
  //   两者的文案都由服务端给（support.detail.message / loadResult.message），前端只展示。
  //   契约保证 support.unsupported 与 loadResult.ok 不并存 ⇒ 这里不会出现"一边说不行一边说刚成功"。
  const support = (m && m.support) || {};
  const loadResult = (m && m.loadResult) || null;
  const warnText = (support.state === 'unsupported' && support.detail && support.detail.message)
    ? String(support.detail.message)
    : (loadResult && loadResult.result === 'failed'
      ? String(loadResult.message || loadResult.reason || '装载失败')
      : '');
  if (warnText) {
    const badge = el('span', 'tree-variant-warn', '⚠');
    // 打标记：applyEntryState 就地刷新时**只认这个标记**找回已有的 ⚠。
    //   不打的话它会以为"这行还没有警告"，于是再 append 一个 ⇒ 同一行挂两个 ⚠（实测踩过）。
    badge.dataset.entryWarn = '1';
    badge.title = warnText;
    row.append(badge);
    row.classList.add('is-incomplete');
  }
  row.title = `${origName}${m.srcDir && m.srcDir !== origName ? `  ·  ${m.srcDir}` : ''}${warnText ? `\n⚠ ${warnText}` : ''}`;
  return row;
}

/**
 * 按条目**就地**刷新徽标：只动命中那一行，**不重渲染整棵名册**。
 *
 * 为什么不能整棵重渲染：名册是带展开态 / 选中态 / 滚动位置的树，
 *   重渲染会把这三样全部丢掉 —— 用户看到的是"点一下模型，列表跳回顶部、节点全折叠"。
 *
 * 服务端返回的 display/support/loadResult 是唯一真相（契约 §一 INV-D1）：
 *   本函数只把三个字段"画"到那一行，不接收前端自造的失败记录、不猜颜色。
 *   ⇒ 装载成功后服务端 recompute 一变，照着画就对（这就是"当场变色"的全部机制）。
 *
 * @param {object} model 名册条目（只需 id / name）
 * @param {{display?:object, support?:object, loadResult?:object}|null} entryState 服务端三字段；
 *        null/缺省 = 该条目已无状态（等价于全部清空）
 * @returns {boolean} 命中并处理了返回 true；该条目当前不在名册里（被折叠/搜索过滤）返回 false
 */
export function applyEntryState(model, entryState) {
  const id = String((model && (model.id || model.name)) || '');
  if (!id) return false;
  // 不用属性选择器：条目 id 里常有空格 / 斜杠 / 引号，拼进选择器必须转义，
  //   而 CSS.escape 不是所有环境都有。名册数百行量级，直接遍历更稳也更清楚。
  let row = null;
  for (const candidate of document.querySelectorAll('.tree-row.tree-variant')) {
    if (candidate.dataset && candidate.dataset.modelId === id) { row = candidate; break; }
  }
  if (!row) return false;

  const st = entryState || {};
  const display = st.display || {};
  const support = st.support || {};
  const loadResult = st.loadResult || null;

  // ① 徽标颜色：只认 display.accent（null ⇒ 中性色，绝不按 kind 猜）
  const typeBadge = row.querySelector('.tree-type');
  if (typeBadge) {
    if (display.accent) typeBadge.style.setProperty('--badge-accent', String(display.accent));
    else typeBadge.style.removeProperty('--badge-accent');
    const cands = Array.isArray(display.candidates) ? display.candidates : [];
    if (display.provider) typeBadge.title = `归属：${display.provider}`;
    else if (cands.length) typeBadge.title = `归属待定（候选：${cands.join('、')}）`;
    else typeBadge.title = '';
  }

  // ② ⚠：support 说"装不动" 或 loadResult 说"上次失败"；文案由服务端给
  const warnText = (support.state === 'unsupported' && support.detail && support.detail.message)
    ? String(support.detail.message)
    : (loadResult && loadResult.result === 'failed'
      ? String(loadResult.message || loadResult.reason || '装载失败')
      : '');
  const existing = row.querySelector('[data-entry-warn="1"]');
  if (warnText) {
    if (existing) existing.title = warnText;
    else {
      const badge = el('span', 'tree-variant-warn', '⚠');
      badge.dataset.entryWarn = '1';
      badge.title = warnText;
      row.append(badge);
    }
    row.classList.add('is-incomplete');
  } else {
    if (existing) existing.remove();
    if (!row.querySelector('.tree-variant-warn')) row.classList.remove('is-incomplete');
  }

  // ③ 行级 title：正文（原名 / 目录）原样保留，只替换末尾那句警告
  const baseTitle = String(row.title || '').replace(/\n⚠ [^\n]*$/, '');
  row.title = warnText ? `${baseTitle}\n⚠ ${warnText}` : baseTitle;
  return true;
}
