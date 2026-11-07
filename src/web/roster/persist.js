// roster/persist.js —— 名册展开态与"上次选中"的持久化
//
// 键名与结构（modelstage.tree-state.v1）：
//   { groups: [], chars: [], activeGroup: '游戏名', lastByGroup: { '游戏名': '变体id' }, lastModelId? }
// 单独成模块的原因：读写逻辑与渲染无关，且 view.js 需要守住单文件行数上限。

import * as uiState from '../app/ui-state.js';


/**
 * 名册状态存储键（**当前唯一键**，不是历史遗留）。
 *
 * 键名沿用项目早期命名（改名会让已有用户的"上次选中的模型/展开态"丢失），故键名保持不变；
 *   读写统一经 app/ui-state 工厂代理，**字段**用 group 口径 `{groups, chars, activeGroup, lastByGroup}`
 *   —— 旧的 game 口径字段（games/activeGame/lastByGame）读到就当没有：不报错、不迁移，下次保存自然写成新格式。
 */
export const LS_KEY = uiState.TREE_STATE_KEY;

/** 读展开态与上次选中（结构的 {groups, chars, activeGroup, lastByGroup}） */
export function readSaved() {
  try {
    const s = uiState.getTreeState();
    return {
      groups: new Set(Array.isArray(s.groups) ? s.groups : []),
      chars: new Set(Array.isArray(s.chars) ? s.chars : []),
      activeGroup: typeof s.activeGroup === 'string' ? s.activeGroup : null,
      lastByGroup: s.lastByGroup && typeof s.lastByGroup === 'object' ? s.lastByGroup : {},
      // 旧格式：只有单个 lastModelId（更早版本写入的），读出来用于兼容恢复
      lastModelId: typeof s.lastModelId === 'string' ? s.lastModelId : null,
    };
  } catch {
    return { groups: new Set(), chars: new Set(), activeGroup: null, lastByGroup: {}, lastModelId: null };
  }
}

/**
 * 写展开态与每个游戏上次选中的变体（键名不变；字段用 group 口径：activeGroup 存分组名）。
 * @param {object} state 名册状态（读 expandedGroups/expandedChars/activeGroup/selected）
 */
export function saveState(state) {
  try {
    const s = readSaved();
    const lastByGroup = { ...s.lastByGroup };
    // 内存与存储用同一个字段名（activeGroup）：不再为"旧键名"留兼容分支，旧数据读到即视为没有
    const activeGroup = state.activeGroup || null;
    if (activeGroup && state.selected) lastByGroup[activeGroup] = state.selected.modelId;
    uiState.setTreeState({
      groups: [...state.expandedGroups],
      chars: [...state.expandedChars],
      activeGroup: activeGroup || s.activeGroup,
      lastByGroup,
    });
  } catch {
    // 隐私模式等写不了就忽略：持久化是增强，不影响当前会话
  }
}


/**
 * 「上次所用模型」指针的存储键。
 *
 * 为什么单独存一份（不复用 lastByGroup）：冷启动要能**只加载一个根**，就必须知道模型属于哪个根；
 *   而 lastByGroup 只记"游戏名 → 模型 id"，同一个游戏常有 2~3 个根，光靠它无法定位到根。
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
