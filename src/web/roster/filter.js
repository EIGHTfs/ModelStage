// roster/filter.js —— 名册搜索过滤（纯函数，不碰 DOM）
//
// 搜索口径：
//   · 空关键词 ⇒ 全显示
//   · 角色整组判定：角色名命中，或该角色任意变体命中（变体命中显示整组，避免"只剩一个变体"的割裂感）
//   · 游戏名 / 资源根 id 命中也算，直接显示该游戏全部角色

/** 变体参与搜索的文本（模型名 + 目录 + 中文名/原名/服装；统一小写） */
export function variantSearchText(v) {
  const m = v.model;
  const nm = v.nm;
  return `${m.name} ${m.srcDir || ''} ${nm ? `${nm.name} ${nm.costume}` : ''}`.toLowerCase();
}

/** 角色是否命中（按角色整组判定：搜角色名时显示该角色全部变体） */
export function charMatches(c, kw) {
  if (!kw) return true;
  if (String(c.title).toLowerCase().includes(kw)) return true;
  return c.variants.some((v) => variantSearchText(v).includes(kw));
}

/** 某游戏在搜索下可见的角色（未加载的游戏不参与过滤） */
export function visibleChars(game, state) {
  const entry = state.gameChars.get(game.key);
  if (!entry) return [];
  const kw = state.keyword;
  if (!kw) return entry.chars;
  const gameHit = String(game.name).toLowerCase().includes(kw)
    || game.roots.some((r) => String(r.id).toLowerCase().includes(kw));
  return gameHit ? entry.chars : entry.chars.filter((c) => charMatches(c, kw));
}
