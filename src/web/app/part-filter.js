// app/part-filter.js —— 部件筛除（按关键词隐藏插槽）
//
// 开关与"恢复默认关键字"按钮共用同一份状态，所以落地逻辑只能有一处：
//   写 state → 下发给舞台 → 持久化 → 打 dataset（断言与排查都读它）。
// 关键词默认值来自旧端存储的默认值，别处不再重复写死。

import { state, stage } from './context.js';
import { saveViewSettings } from './view-settings.js';

/** 部件筛除默认关键字：取自旧端存储 partFilterKeywords 的默认值 */
export const DEFAULT_PART_FILTER_KEYWORDS = ['mask', 'mosai', 'mmd', 'mozaiku'];

/** 部件筛除：开关与恢复按钮共用同一状态，只覆盖传入字段 */
export function applyPartFilter(patch) {
  const cur = state.partFilter || { enabled: false, keywords: DEFAULT_PART_FILTER_KEYWORDS.slice() };
  const next = { enabled: !!cur.enabled, keywords: cur.keywords.slice(), ...patch };
  state.partFilter = next;
  if (stage && stage.setPartFilter) stage.setPartFilter(next);
  saveViewSettings({ partFilterEnabled: next.enabled, partFilterKeywords: next.keywords.join(',') });
  document.documentElement.dataset.partFilter = next.enabled ? next.keywords.join(',') : 'off';
  return next;
}
