#!/usr/bin/env node
// check-index.mjs —— `config/index/<game>.index.json`（名表 v2）spec 校验器
//
// 两种用法（与 check-wiring 同构：库形态给门禁/迁移器调，CLI 给人跑）：
//   ① 库：import { checkIndex, formatIndexErrors } from './check-index.mjs';
//         const { ok, errors } = checkIndex(obj, 'azurlane.index.json');
//   ② CLI：node tool/check-index.mjs                    # 校验 config/index/*.index.json 全部
//           node tool/check-index.mjs <file...>          # 校验指定文件
//           node tool/check-index.mjs --json             # 机器读
//
// 校验什么（对应 docs/设计/名表.md §三 的模型 + §9.2 的映射要求）：
//   · _meta.specVersion === 2（v1 的结构能通过一半校验，必须一眼区分开）
//   · characters[*].name 是非空数组，且每个元素有非空 lang / text
//     —— 空数组等于"这个角色没有名字"，界面会静默回退目录名，属于数据丢失，必须拦
//   · characters[*].costumes（若有）里每个皮肤名的结构与 name 同要求
//   · byAsset[*].char 必须指向存在的角色 ID（悬空引用 = 聚合时命中不到，表现为"红点/无名字"）
//   · byAsset[*].how 只能取 upstream / fuzzy / manual（拼错会让"保留 manual"的合并逻辑失效）
//   · characters[*].npc 若存在必须是布尔（roster 直接读它做分类，别的类型会行为诡异）
//
// 退出码（CLI）：有错 ⇒ 1，否则 0。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const INDEX_DIR = path.join(ROOT, 'config', 'index');

export const SPEC_VERSION = 2;
/** byAsset.how 的合法取值：upstream（上游表）/ fuzzy（模糊匹配）/ manual（人工补） */
export const HOW_VALUES = ['upstream', 'fuzzy', 'manual'];

/**
 * 校验一个语言名数组。
 * @returns {string[]} 错误描述（空数组表示通过）
 */
function checkNameArray(arr, where) {
  const errs = [];
  if (!Array.isArray(arr)) {
    errs.push(`${where}.name 必须是数组，实际是 ${arr === undefined ? '缺失' : typeof arr}`);
    return errs;
  }
  if (arr.length === 0) {
    errs.push(`${where}.name 是空数组（角色没有名字 ⇒ 界面会静默回退资源目录名，等于丢名字）`);
    return errs;
  }
  arr.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      errs.push(`${where}.name[${i}] 必须是对象 {lang, text}`);
      return;
    }
    if (typeof item.lang !== 'string' || !item.lang.trim()) errs.push(`${where}.name[${i}] 缺 lang 或为空`);
    if (typeof item.text !== 'string' || !item.text.trim()) errs.push(`${where}.name[${i}] 缺 text 或为空`);
  });
  return errs;
}

/** 校验 _meta（v2 三个新增必填项：idSemantics / roots / normalize） */
function checkMeta(meta, push) {
  if (!meta || typeof meta !== 'object') { push('缺 _meta'); return; }
  if (meta.specVersion !== SPEC_VERSION) {
    push(`_meta.specVersion 必须是 ${SPEC_VERSION}，实际是 ${JSON.stringify(meta.specVersion)}（v1 的表不该进这个目录）`);
  }
  if (typeof meta.game !== 'string' || !meta.game.trim()) push('_meta.game 缺失或为空');
  // idSemantics / roots / normalize 是 v2 新增的三个必填项：缺了说明是按 v1 结构手写的
  if (typeof meta.idSemantics !== 'string' || !meta.idSemantics.trim()) push('_meta.idSemantics 缺失或为空（角色 ID 语义按游戏异构，必须写明）');
  if (!Array.isArray(meta.roots) || meta.roots.length === 0) push('_meta.roots 必须是非空数组（本索引服务的资源根）');
  if (typeof meta.normalize !== 'string') push('_meta.normalize 必须是字符串（不做归一化就写空串，不能缺）');
}

/** 校验一个角色的 costumes 段（皮肤 ID → {name:[...]}） */
function checkCostumes(costumes, where, push) {
  if (!costumes || typeof costumes !== 'object' || Array.isArray(costumes)) {
    push(`${where}.costumes 必须是对象（皮肤 ID → {name:[...]}）`);
    return;
  }
  for (const [skinId, skin] of Object.entries(costumes)) {
    const sw = `${where}.costumes["${skinId}"]`;
    if (!skin || typeof skin !== 'object') { push(`${sw} 必须是对象`); continue; }
    for (const e of checkNameArray(skin.name, sw)) push(e);
  }
}

/** 校验单个角色条目 */
function checkOneCharacter(id, c, push) {
  const where = `characters["${id}"]`;
  if (!c || typeof c !== 'object' || Array.isArray(c)) { push(`${where} 必须是对象`); return null; }
  for (const e of checkNameArray(c.name, where)) push(e);
  if (c.costumes !== undefined) checkCostumes(c.costumes, where, push);
  if (c.npc !== undefined && typeof c.npc !== 'boolean') push(`${where}.npc 必须是布尔（roster 直接读它做分类）`);
  if (c.avatar !== undefined && (typeof c.avatar !== 'string' || !c.avatar.trim())) {
    push(`${where}.avatar 必须是非空字符串（无头像就直接省略该字段）`);
  }
  return c;
}

/** 校验 characters 段，返回统计 */
function checkCharacters(chars, push) {
  const nameLenDist = {};
  let npcCount = 0;
  let costumeCharCount = 0;
  for (const [id, raw] of Object.entries(chars)) {
    const c = checkOneCharacter(id, raw, push);
    if (!c) continue;
    if (Array.isArray(c.name)) nameLenDist[c.name.length] = (nameLenDist[c.name.length] || 0) + 1;
    if (c.costumes !== undefined && c.costumes && typeof c.costumes === 'object') costumeCharCount += 1;
    if (c.npc === true) npcCount += 1;
  }
  return { characters: Object.keys(chars).length, npc: npcCount, costumeChars: costumeCharCount, nameLenDist };
}

/** 校验单条 byAsset 映射 */
function checkOneAsset(key, v, chars, push) {
  const where = `byAsset["${key}"]`;
  if (typeof v === 'string') {
    // v1 残留形态：能读但属于迁移未完成，明确报出来（不然"改完看着过了"其实还是旧结构）
    push(`${where} 的值是字符串 ${JSON.stringify(v)}（v1 形态；v2 必须是 {char, how}）`);
    return null;
  }
  if (!v || typeof v !== 'object') { push(`${where} 必须是对象 {char, how}`); return null; }
  if (typeof v.char !== 'string' || !v.char.trim()) push(`${where}.char 缺失或为空`);
  else if (!chars[v.char]) push(`${where}.char=${JSON.stringify(v.char)} 指向不存在的角色（悬空引用 ⇒ 聚合命中不到）`);
  if (v.costume !== undefined && typeof v.costume !== 'string') push(`${where}.costume 必须是字符串`);
  if (!HOW_VALUES.includes(v.how)) push(`${where}.how 必须是 ${HOW_VALUES.join('/')} 之一，实际是 ${JSON.stringify(v.how)}`);
  return v;
}

/** 校验 byAsset 段，返回统计 */
function checkByAsset(byAsset, chars, push) {
  const howDist = {};
  if (byAsset === undefined) return { byAsset: 0, howDist };
  if (!byAsset || typeof byAsset !== 'object' || Array.isArray(byAsset)) {
    push('byAsset 必须是对象（资源键 → {char, how}）');
    return { byAsset: 0, howDist };
  }
  const keys = Object.keys(byAsset);
  for (const key of keys) {
    const v = checkOneAsset(key, byAsset[key], chars, push);
    if (v && HOW_VALUES.includes(v.how)) howDist[v.how] = (howDist[v.how] || 0) + 1;
  }
  return { byAsset: keys.length, howDist };
}

/**
 * 校验一份 index 对象（库形态：不退出进程）。
 * 只做编排：各段校验拆到 checkMeta / checkCharacters / checkByAsset，避免单函数圈复杂度失控。
 * @param {object} obj 解析后的 index.json
 * @param {string} label 出错时用来标注来源（文件名）
 * @returns {{ok:boolean, errors:string[], stats:object}}
 */
export function checkIndex(obj, label = '(未命名)') {
  const errors = [];
  const push = (msg) => errors.push(`[${label}] ${msg}`);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: [`[${label}] 顶层必须是对象`], stats: {} };
  }
  checkMeta(obj._meta, push);
  const chars = obj.characters;
  if (!chars || typeof chars !== 'object' || Array.isArray(chars)) {
    push('characters 必须是对象（角色 ID → 条目）');
    return { ok: false, errors, stats: {} };
  }
  const charStats = checkCharacters(chars, push);
  const assetStats = checkByAsset(obj.byAsset, chars, push);
  return {
    ok: errors.length === 0,
    errors,
    stats: { ...charStats, ...assetStats },
  };
}

export function formatIndexErrors(errors) {
  if (!errors.length) return '';
  const out = [`❌ 名表 index 校验失败（${errors.length} 处）：`];
  for (const e of errors.slice(0, 40)) out.push(`   ${e}`);
  if (errors.length > 40) out.push(`   …还有 ${errors.length - 40} 处`);
  return out.join('\n');
}

/** CLI */
async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const files = args.filter((a) => !a.startsWith('--'));
  let targets = files;
  if (!targets.length) {
    if (!fs.existsSync(INDEX_DIR)) {
      console.error(`目录不存在：${path.relative(ROOT, INDEX_DIR)}（第 1 步迁移后才有）`);
      process.exit(2);
    }
    targets = fs.readdirSync(INDEX_DIR).filter((f) => f.endsWith('.index.json')).map((f) => path.join(INDEX_DIR, f));
    if (!targets.length) {
      console.error(`目录里没有 *.index.json：${path.relative(ROOT, INDEX_DIR)}`);
      process.exit(2);
    }
  }
  const results = [];
  let bad = 0;
  for (const file of targets) {
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      results.push({ file: path.relative(ROOT, file), ok: false, errors: [`JSON 解析失败：${e.message}`], stats: {} });
      bad += 1;
      continue;
    }
    const r = checkIndex(obj, path.basename(file));
    results.push({ file: path.relative(ROOT, file), ...r });
    if (!r.ok) bad += 1;
  }
  if (json) {
    console.log(JSON.stringify({ ok: bad === 0, results }, null, 2));
  } else {
    for (const r of results) {
      const s = r.stats || {};
      const dist = s.nameLenDist ? Object.entries(s.nameLenDist).map(([k, v]) => `${k}条×${v}`).join(' ') : '-';
      console.log(`${r.ok ? '✅' : '❌'} ${r.file}  角色=${s.characters ?? '-'} byAsset=${s.byAsset ?? '-'} 名字条数分布=${dist} how=${JSON.stringify(s.howDist || {})}`);
      if (!r.ok) console.log(formatIndexErrors(r.errors));
    }
    console.log(bad === 0 ? `\n✅ 全部通过（${results.length} 个文件）` : `\n❌ ${bad}/${results.length} 个文件未通过`);
  }
  process.exit(bad === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error('check-index 执行失败：', (e && e.message) || e); process.exit(2); });
}
