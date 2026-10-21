// roster/snapshot.js —— 把名册状态投影成可读快照（自动化断言与手工排查共用）
//
// 为什么需要：断言不该去猜内部结构；这里把"每个游戏有多少角色/变体、展开了哪些、选中了谁、
//   DOM 里真的渲染了几行、最近一次定位动作是什么"一次性摊平，测试只读这份快照。

/**
 * @param {{state: object, listEl: HTMLElement, gameStatus: (game: object) => string}} deps
 */
export function snapshotRoster({ state, listEl, gameStatus }) {
  const games = state.games.map((g) => {
    const chars = state.gameChars.get(g.key);
    return {
      key: g.key,
      name: g.name,
      roots: g.roots.map((r) => r.id),
      status: gameStatus(g),
      sources: g.roots.map((r) => (state.loaded.get(r.id) || {}).source || '').filter(Boolean),
      chars: chars ? chars.chars.length : 0,
      variants: chars ? chars.chars.reduce((n, c) => n + c.variants.length, 0) : 0,
      miss: chars ? chars.stats.miss : 0,
    };
  });
  return {
    games,
    expandedGames: [...state.expandedGames],
    expandedChars: [...state.expandedChars],
    keyword: state.keyword,
    selected: state.selected,
    /** 最近一次"定位当前角色"的结果（visible / scrolled / skipped-user-scrolling / …） */
    lastReveal: state.lastReveal || null,
    domRows: {
      games: listEl.querySelectorAll('[data-game-key].tree-game').length,
      chars: listEl.querySelectorAll('[data-char-key].tree-char').length,
      variants: listEl.querySelectorAll('[data-model-id]').length,
    },
  };
}
