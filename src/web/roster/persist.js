// roster/persist.js —— 名册展开态与"上次选中"的持久化
//
// 键名与结构沿用旧前端（spine-multi-viewer.tree-state.v1）：
//   { games: [], chars: [], activeGame: '游戏名', lastByGame: { '游戏名': '变体id' }, lastModelId? }
// 单独成模块的原因：读写逻辑与渲染无关，且 view.js 需要守住单文件行数上限。

/** 存储键（与旧前端同名，切实现不丢用户的选择） */
export const LS_KEY = 'spine-multi-viewer.tree-state.v1';

/** 读展开态与上次选中（结构照旧前端的 {games, chars, activeGame, lastByGame}） */
export function readSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return {
      games: new Set(Array.isArray(s.games) ? s.games : []),
      chars: new Set(Array.isArray(s.chars) ? s.chars : []),
      activeGame: typeof s.activeGame === 'string' ? s.activeGame : null,
      lastByGame: s.lastByGame && typeof s.lastByGame === 'object' ? s.lastByGame : {},
      // 旧格式：只有单个 lastModelId（更早版本写入的），读出来用于兼容恢复
      lastModelId: typeof s.lastModelId === 'string' ? s.lastModelId : null,
    };
  } catch {
    return { games: new Set(), chars: new Set(), activeGame: null, lastByGame: {}, lastModelId: null };
  }
}

/**
 * 写展开态与每个游戏上次选中的变体（键名/结构沿用旧前端：activeGame 存游戏名）。
 * @param {object} state 名册状态（读 expandedGames/expandedChars/activeGame/selected）
 */
export function saveState(state) {
  try {
    const s = readSaved();
    const lastByGame = { ...s.lastByGame };
    if (state.activeGame && state.selected) lastByGame[state.activeGame] = state.selected.modelId;
    localStorage.setItem(LS_KEY, JSON.stringify({
      games: [...state.expandedGames],
      chars: [...state.expandedChars],
      activeGame: state.activeGame || s.activeGame,
      lastByGame,
    }));
  } catch {
    // 隐私模式等写不了就忽略：持久化是增强，不影响当前会话
  }
}
