// shared/type-labels.mjs —— 内容类型（kind）的显示名映射（**单一来源**）
//
// 谁用：前端名册的类型筛选胶囊、以及将来可能的插件/其它视图。
// 为什么放 shared 而不是各自写一份：显示名是"同一事实两处表达"的高危点——
//   前端写一套、插件再写一套，很快就会出现"同一个类型两处叫法不同"。
//
// 规则（设计口径）：
//   · 已知类型 → 可读名（下表）
//   · 未知类型 → **原样返回 key**，不做大小写美化（避免"看起来认识其实不认识"）

/** kind 为 null/空时的归并键（未解包容器条目走这一档，见设计稿 §5.1） */
export const UNKNOWN_TYPE_KEY = 'unknown';

/** 内置显示名：键是条目上的 kind 值（null 一律先归成 UNKNOWN_TYPE_KEY） */
export const TYPE_LABELS = Object.freeze({
  spine: 'Spine',
  live2d: 'Live2D',
  [UNKNOWN_TYPE_KEY]: '待解包',
  bundle: '资源包',
});

/**
 * 取显示名：已知返回中文/品牌名，未知**原值返回**。
 * @param {string} typeKey 类型键（如 'spine' / 'unknown' / 将来插件的自定义值）
 * @returns {string}
 */
export function typeLabel(typeKey) {
  const key = String(typeKey == null ? '' : typeKey);
  if (!key) return String(UNKNOWN_TYPE_KEY);
  return Object.prototype.hasOwnProperty.call(TYPE_LABELS, key) ? TYPE_LABELS[key] : key;
}
