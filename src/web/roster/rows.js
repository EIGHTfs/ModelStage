// roster-rows.js —— 名册三级树的「行」渲染（纯 DOM 工厂，无状态）（M2）
//
// 做什么：把一条树数据渲染成一个可点击的 treeitem 行，三级别各一个函数。
// 为什么单独一个文件：
//   1. 单文件 ≤400 行的硬约束（视图逻辑 + 行结构放一起会超）；
//   2. 职责分离：本文件只管"一行长什么样"，roster-view.js 只管"状态怎么变、事件怎么派"。
// 约定：每行都带 data-* 标识与 tabindex=0（键盘可达），事件由 roster-view.js 在容器上委托。

import { variantLabel, variantText } from './list.js';

/** 元素工厂：减少重复的 createElement 样板 */
export function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

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
 * @param {object} c 角色（title/baseName/iconUrl/variants/npc）
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
  // 样式类按"条目性质"取（容器单文件用 bundle 类，颜色与普通模型区分），与 label 文案解耦
  const kindClass = m.container ? 'bundle' : (m.kind === 'live2d' ? 'live2d' : 'spine');
  row.append(el('span', `tree-type tree-type-${kindClass}`, label));
  row.append(el('span', 'tree-variant-text', text));
  if (origName && origName !== text) row.append(el('span', 'tree-variant-orig', ` · ${origName}`));
  row.title = `${origName}${m.srcDir && m.srcDir !== origName ? `  ·  ${m.srcDir}` : ''}`;
  return row;
}
