// roster/type-filter.js —— 名册「内容类型」筛选（纯函数，不碰 DOM、不读存储）
//
// 与 filter.js 的分工：
//   · filter.js      管**关键词**（角色整组判定：命中角色名或任一变体即显示整组）
//   · 本文件         管**类型**（按条目自带的 kind 归并、计数、过滤）
//   两者正交：视图层先按类型筛，再按关键词筛（或反过来），结果一致（交集）。
//
// 类型从哪来：条目的 `kind`（内容类型）。**未解包的容器条目 kind 可能为 null**，
//   一律归入 UNKNOWN_TYPE_KEY（显示名「待解包」）—— 否则这些条目在"选中任意类型"时会被全部滤掉，
//   用户会以为资源包不见了（设计稿 §5.1 的关键结论）。

import { UNKNOWN_TYPE_KEY } from '../../shared/type-labels.mjs';
import { visibleChars } from './filter.js';

/**
 * 单个变体的类型键：条目 kind 为空 ⇒ unknown。
 * 为什么看 kind 而不是 container：container 是"装载方式"（要先解包），kind 才是"内容类型"。
 * @param {{model?: {kind?: string|null}}} variant
 * @returns {string}
 */
export function typeKeyOf(variant) {
  const model = variant && variant.model ? variant.model : variant;
  const kind = model && model.kind != null ? String(model.kind).trim() : '';
  return kind || UNKNOWN_TYPE_KEY;
}

/**
 * 类型计数：**当前关键词下、该类型可见的变体数**（不含类型过滤本身的影响）。
 *
 * 为什么要排除类型过滤：数字要回答"如果我再选它，会有多少"。
 *   若把类型过滤也算进去，选中 Spine 后其它胶囊会立刻变 0，用户就没法判断要不要切换。
 * 为什么仍计入关键词：面板上的数字必须和"现在列表里能看到多少"对得上（设计稿 §5.3）。
 *
 * scope 参数是为将来扩维度（如按资源根）预留的：当前只消费 keyword，新增维度时只加 scope 字段，
 *   不动本函数的排序/计数逻辑（设计稿 §5.4）。
 *
 * @param {{groups: object[], groupChars: Map, keyword?: string,
 *          scope?: {keyword?: string}}} input
 * @returns {Array<{key: string, count: number}>} 按数量降序，并列按 key 字典序（稳定）
 */
export function deriveTypeCounts({ groups, groupChars, keyword = '', scope = null }) {
  const effectiveKeyword = String((scope && scope.keyword) != null ? scope.keyword : keyword || '').toLowerCase();
  const counts = new Map();
  for (const group of groups || []) {
    // 复用关键词过滤的同一口径（角色整组判定），保证"数字"与"列表可见性"不会两套算法
    const chars = visibleChars(group, { groupChars, keyword: effectiveKeyword });
    for (const char of chars) {
      for (const variant of char.variants || []) {
        const typeKey = typeKeyOf(variant);
        counts.set(typeKey, (counts.get(typeKey) || 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => (right.count - left.count) || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

/**
 * 按选中类型过滤角色（并把每个角色的变体裁到命中集合）。
 *
 * 语义：selectedTypes 为空 ⇒ 不过滤（等于"全部"）；否则 = 并集（命中任一选中类型即保留）。
 * 注意返回的是**新数组/新角色对象**，不改动 state.groupChars 里的原对象（渲染层只读）。
 *
 * @param {object[]} chars 角色数组（每个带 variants）
 * @param {Set<string>|string[]} selectedTypes
 * @returns {object[]}
 */
export function filterCharsByType(chars, selectedTypes) {
  const selected = selectedTypes instanceof Set ? selectedTypes : new Set(selectedTypes || []);
  if (!selected.size) return chars;
  const kept = [];
  for (const char of chars) {
    const variants = (char.variants || []).filter((variant) => selected.has(typeKeyOf(variant)));
    if (variants.length) kept.push({ ...char, variants });
  }
  return kept;
}

/**
 * 把存储里读到的选中集合收敛成"当前可用"的集合。
 *
 * 失效项（当前类型集合里没有的 key）在**当前页面生命周期内被忽略**，但**不删存储**——
 *   这样某个类型暂时消失（例如最后一个资源包被解包）后再出现时，用户的选中会自动恢复。
 * @param {string[]} storedKeys 存储里读到的 key 列表
 * @param {Iterable<string>} availableKeys 当前名册实际出现的类型
 * @returns {Set<string>} 可用的选中集合
 */
export function usableTypeSelection(storedKeys, availableKeys) {
  const available = new Set([...availableKeys].map((key) => String(key)));
  const out = new Set();
  for (const raw of Array.isArray(storedKeys) ? storedKeys : []) {
    const key = String(raw == null ? '' : raw);
    if (key && available.has(key)) out.add(key);
  }
  return out;
}
