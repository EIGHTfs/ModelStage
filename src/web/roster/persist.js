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
    // 内存里叫 activeGroup（分组语义），存储字段仍叫 activeGame（旧格式，改名会让既有用户状态丢失）
    const activeGroup = state.activeGroup || null;
    if (activeGroup && state.selected) lastByGame[activeGroup] = state.selected.modelId;
    uiState.setTreeState({
      games: [...state.expandedGames],
      chars: [...state.expandedChars],
      activeGame: activeGroup || s.activeGame,
      lastByGame,
    });
  } catch {
    // 隐私模式等写不了就忽略：持久化是增强，不影响当前会话
  }
}


/**
 * 「上次所用模型」指针的存储键。
 *
 * 为什么单独存一份（不复用 lastByGame）：冷启动要能**只加载一个根**，就必须知道模型属于哪个根；
 *   而 lastByGame 只记"游戏名 → 模型 id"，同一个游戏常有 2~3 个根，光靠它无法定位到根。
 * 结构：{ rootId: string, kind: string|null, modelId: string, at: number }
 */
export const LAST_MODEL_KEY = 'roster.lastModel';

/** 读上次所用模型指针（形状不对当没有：宁可回到"什么都不加载"，也不要拿半截数据去扫） */
export function readLastModel() {
  try {
    const raw = localStorage.getItem(LAST_MODEL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const rootId = typeof parsed.rootId === 'string' ? parsed.rootId : '';
    const modelId = typeof parsed.modelId === 'string' ? parsed.modelId : '';
    if (!rootId || !modelId) return null;
    return { rootId, modelId, kind: typeof parsed.kind === 'string' ? parsed.kind : null, at: Number(parsed.at) || 0 };
  } catch {
    return null;
  }
}

/**
 * 记下这次所用的模型（供下次冷启动"只加载它所在的那一个根"）。
 * 写失败静默：这只是加速启动的增强，不能影响选中本身。
 * @param {{rootId?: string, kind?: string|null, modelId?: string}|null} model 变体里的 model 对象
 */
export function saveLastModel(model) {
  try {
    const rootId = model && model.rootId ? String(model.rootId) : '';
    const modelId = model && (model.id || model.name) ? String(model.id || model.name) : '';
    if (!rootId || !modelId) return false;
    localStorage.setItem(LAST_MODEL_KEY, JSON.stringify({
      rootId, kind: model.kind ? String(model.kind) : null, modelId, at: Date.now(),
    }));
    return true;
  } catch {
    return false;
  }
}
