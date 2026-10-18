// roots-list.js —— 资源根列表渲染（M1）
//
// 做什么：把 /api/roots 的 roots[] 渲染成左栏的一张平铺列表。
// 为什么 M1 只做平铺：M1 的验收就是「资源根列表与 8803 /api/roots 的 roots[].id 完全一致」，
//   三级树（游戏→角色→变体）属于 M2，要等 /api/models + 名表接线后才有数据。
// 约定：每行同时输出 id 到 data-root-id，供自动化断言逐个比对（不靠肉眼）。

/**
 * @typedef {{id: string, name: string, path: string, kind?: string, profile?: string|null, exists?: boolean}} RootEntry
 */

/**
 * 渲染资源根列表。
 * @param {RootEntry[]} roots
 * @param {HTMLElement} container
 * @returns {{ids: string[]}} 实际渲染出的 id 顺序，供调用方回填/断言
 */
export function renderRoots(roots, container) {
  container.replaceChildren();

  const ids = [];
  for (const root of roots) {
    ids.push(root.id);
    container.append(buildRootRow(root));
  }

  if (roots.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted-hint';
    empty.textContent = '配置里还没有资源根（用「＋ 资源根」添加，或编辑 config/resources.json）';
    container.append(empty);
  }

  const foot = document.createElement('p');
  foot.className = 'roots-foot';
  foot.textContent = `共 ${roots.length} 个资源根 · 数据来自 /api/roots`;
  container.append(foot);

  return { ids };
}

/**
 * 单行：主行（显示名 + id 徽标）+ 元信息行（kind / profile / 路径）。
 * @param {RootEntry} root
 * @returns {HTMLElement}
 */
function buildRootRow(root) {
  const row = document.createElement('div');
  row.className = 'root-row';
  row.dataset.rootId = root.id;
  row.setAttribute('role', 'listitem');
  if (root.exists === false) row.classList.add('is-missing');

  const main = document.createElement('div');
  main.className = 'root-row-main';

  const name = document.createElement('span');
  name.className = 'root-name';
  name.textContent = root.name || root.id;

  const idBadge = document.createElement('code');
  idBadge.className = 'root-id';
  idBadge.textContent = root.id;

  main.append(name, idBadge);

  const meta = document.createElement('span');
  meta.className = 'root-meta';
  meta.textContent = describeRoot(root);
  meta.title = root.path || '';

  row.append(main, meta);
  return row;
}

/**
 * 元信息文案：类型 + 插件 profile（只有 bundle 根才有 profile）+ 路径。
 * @param {RootEntry} root
 * @returns {string}
 */
function describeRoot(root) {
  const parts = [root.kind || 'spine'];
  if (root.profile) parts.push(`profile=${root.profile}`);
  if (root.path) parts.push(root.path);
  return parts.join(' · ');
}
