// roster/persist.js —— 名册展开态与"上次选中"的持久化
//
// 键名与结构（modelstage.tree-state.v1）：
//   { games: [], chars: [], activeGame: '游戏名', lastByGame: { '游戏名': '变体id' }, lastModelId? }
// 单独成模块的原因：读写逻辑与渲染无关，且 view.js 需要守住单文件行数上限。

import * as uiState from '../app/ui-state.js';

/**
 * 名册状态存储键（**当前唯一键**，不是历史遗留）。
 *
 * 键名沿用项目早期命名，改名会让已有用户的"上次选中的模型/展开态"丢失，故保持不变；
 * 读写统一经 app/ui-state 工厂代理，字段结构 `{games, chars, activeGame, lastByGame}` 不动。
 */
export const LS_KEY = uiState.TREE_STATE_KEY;

/** 读展开态与上次选中（结构的 {games, chars, activeGame, lastByGame}） */
export function readSaved() {
  try {
    const s = uiState.getTreeState();
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
 * 写展开态与每个游戏上次选中的变体（键名/结构沿用既有：activeGame 存游戏名）。
 * @param {object} state 名册状态（读 expandedGames/expandedChars/activeGame/selected）
 */
export function saveState(state) {
  try {
    const s = readSaved();
    const lastByGame = { ...s.lastByGame };
    if (state.activeGame && state.selected) lastByGame[state.activeGame] = state.selected.modelId;
    uiState.setTreeState({
      games: [...state.expandedGames],
      chars: [...state.expandedChars],
      activeGame: state.activeGame || s.activeGame,
      lastByGame,
    });
  } catch {
    // 隐私模式等写不了就忽略：持久化是增强，不影响当前会话
  }
}
