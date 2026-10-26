// names.mjs —— 名表取值（前端与服务端共用的纯函数，无平台依赖）
//
// 名表结构见 docs/设计/名表.md：
//   characters[id] = { id, name: [{lang,text}], costume: [{lang,text}], icon }
//   byAsset[资源文件名] = 角色 id
//   _meta.mergeBy 声明用条目的哪个字段做归并键
//
// 为什么放在 shared：同一套取值规则前端要用（显示）、工具要用（校验）。
//   各写一份就会出现"页面显示的和校验认得的不是同一套规则"。

/**
 * 从多语言名数组里取一个显示名。
 *
 * 当前只维护中文 ⇒ 调用方一律用默认 lang（'zh'），**不接受外部传语言**：
 *   数据里只有中文时，做出"可选语言"只会让用户切过去还是看到中文，是假能力。
 * 将来接用户语言时，只改调用处传的 lang，本函数不动。
 *
 * @param {Array<{lang?: string, text?: string}>} names
 * @param {string} lang 目标语言（默认 'zh'）
 * @returns {string} 取不到返回空串，调用方自行回落（例如显示资源名）
 */
export function pickName(names, lang = 'zh') {
  if (!Array.isArray(names) || !names.length) return '';
  const ok = (n) => n && typeof n.text === 'string' && n.text.trim();
  const hit = names.find((n) => ok(n) && n.lang === lang);
  if (hit) return hit.text.trim();
  const zh = names.find((n) => ok(n) && n.lang === 'zh');
  if (zh) return zh.text.trim();
  const first = names.find(ok);
  return first ? first.text.trim() : '';
}

/**
 * 取一个名表条目的归并键。
 * 归并字段名由 `_meta.mergeBy` 声明（不硬编码字段名），取不到时回落到条目键。
 *
 * @param {object} entry 名表条目
 * @param {string} key 该条目在 characters 里的键
 * @param {string} mergeBy 声明的归并字段名
 * @returns {string}
 */
export function mergeKeyOf(entry, key, mergeBy = 'id') {
  const v = entry && entry[mergeBy];
  return typeof v === 'string' && v ? v : key;
}
