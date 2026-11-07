// roster/snapshot.js —— 把名册状态投影成可读快照（自动化断言与手工排查共用）
//
// 为什么需要：断言不该去猜内部结构；这里把"每个游戏有多少角色/变体、展开了哪些、选中了谁、
//   DOM 里真的渲染了几行、最近一次定位动作是什么"一次性摊平，测试只读这份快照。

/**
 * @param {{state: object, listEl: HTMLElement, groupStatus: (group: object) => string}} deps
 */
export function snapshotRoster({ state, listEl, groupStatus }) {
  const groups = state.groups.map((g) => {
    const chars = state.groupChars.get(g.key);
    return {
      key: g.key,
      name: g.name,
      roots: g.roots.map((r) => r.id),
      status: groupStatus(g),
      sources: g.roots.map((r) => (state.loaded.get(r.id) || {}).source || '').filter(Boolean),
      chars: chars ? chars.chars.length : 0,
      variants: chars ? chars.chars.reduce((n, c) => n + c.variants.length, 0) : 0,
      miss: chars ? chars.stats.miss : 0,
    };
  });
  return {
    groups,
    expandedGroups: [...state.expandedGroups],
    expandedChars: [...state.expandedChars],
    keyword: state.keyword,
    /** 类型筛选的选中集合（**存储原样**，可能含当前名册里不存在的失效项） */
    typeFilter: state.typeFilter ? [...state.typeFilter] : [],
    /** 正在扫描的根（断言"状态行数字在动"时读这里，不必解析文案） */
    scan: state.scan ? [...state.scan.entries()].map(([rootId, cur]) => ({
      rootId, phase: cur.monitor.state.phase, scanned: cur.monitor.state.scanned,
      dirs: cur.monitor.state.dirs, currentPath: cur.monitor.state.currentPath,
      stalledFor: cur.monitor.state.stalledFor,
    })) : [],
    selected: state.selected,
    /** 最近一次"定位当前角色"的结果（visible / scrolled / skipped-user-scrolling / …） */
    lastReveal: state.lastReveal || null,
    domRows: {
      groups: listEl.querySelectorAll('[data-group-key].tree-game').length,
      chars: listEl.querySelectorAll('[data-char-key].tree-char').length,
      variants: listEl.querySelectorAll('[data-model-id]').length,
    },
  };
}
