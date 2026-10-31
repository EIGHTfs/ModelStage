#!/usr/bin/env node
// check-index.mjs —— 名表（config/names/<表id>.json）结构校验
//
// 规则来自 docs/设计/名表.md §一「格式」与 §五「验收」：
//   · _meta.v / game / mergeBy 齐全
//   · characters[<键>] 每条有 id、name 非空数组（元素必须 {lang, text}）、costume 是数组
//   · byAsset 的值必须指向存在的 characters 键（保证归并键两侧对得上）
//   · icon 允许空串（无头像就省略或写空）
//
// 这是**提交前门禁**：运行期不做业务校验（服务端只当文件搬运工，见规范 §二）。
//
// 用法：
//   node tool/check-index.mjs                # 校验 config/names/*.json 全部
//   node tool/check-index.mjs <file...>      # 校验指定文件
//   node tool/check-index.mjs --json         # 机器读
//
// 退出码：有错 ⇒ 1，否则 0。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { here } from './lib/paths.mjs';

// 本文件所在目录（写法见 tool/lib/paths.mjs，6 个脚本共用一处实现）
const HERE = here(import.meta.url);
const ROOT = path.resolve(HERE, '..');
const NAMES_DIR = path.join(ROOT, 'config', 'names');

export const SPEC_VERSION = 2;

/** 校验一个语言名数组：必须是非空数组，元素 {lang, text} 都有非空字符串 */
function checkNames(arr, where, errors) {
  if (!Array.isArray(arr)) {
    errors.push(`${where} 必须是数组 [{lang, text}]，实际是 ${arr === undefined ? '缺失' : typeof arr}`);
    return;
  }
  if (arr.length === 0) {
    errors.push(`${where} 是空数组（等于丢名字；无皮肤名请写 [] 但角色名不能为空）`);
    return;
  }
  arr.forEach((item, i) => {
    if (!item || typeof item !== 'object') { errors.push(`${where}[${i}] 必须是对象 {lang, text}`); return; }
    if (typeof item.lang !== 'string' || !item.lang.trim()) errors.push(`${where}[${i}] 缺 lang 或为空`);
    if (typeof item.text !== 'string' || !item.text.trim()) errors.push(`${where}[${i}] 缺 text 或为空`);
  });
}

/** 校验 _meta */
function checkMeta(meta, errors) {
  if (!meta || typeof meta !== 'object') { errors.push('缺 _meta'); return; }
  if (meta.v !== SPEC_VERSION) errors.push(`_meta.v 必须是 ${SPEC_VERSION}，实际是 ${JSON.stringify(meta.v)}`);
  if (typeof meta.game !== 'string' || !meta.game.trim()) errors.push('_meta.game 缺失或为空');
  if (typeof meta.mergeBy !== 'string' || !meta.mergeBy.trim()) errors.push('_meta.mergeBy 缺失（必须声明归并键字段名）');
}

/** 校验单条角色（归并字段必填且与键一致、name 非空数组、costume 是数组） */
function checkCharacter(key, c, mergeBy, errors) {
  const where = `characters["${key}"]`;
  if (!c || typeof c !== 'object' || Array.isArray(c)) { errors.push(`${where} 必须是对象`); return; }
  const mergeVal = c[mergeBy];
  if (typeof mergeVal !== 'string' || !mergeVal.trim()) errors.push(`${where}.${mergeBy} 缺失或为空（归并字段必填）`);
  else if (mergeVal !== key) errors.push(`${where}.${mergeBy}=${JSON.stringify(mergeVal)} 与键不一致（键 = 该条目的身份）`);
  checkNames(c.name, `${where}.name`, errors);
  if (!Array.isArray(c.costume)) errors.push(`${where}.costume 必须是数组（无皮肤名写 []）`);
  else if (c.costume.length) checkNames(c.costume, `${where}.costume`, errors);
  if (c.icon !== undefined && typeof c.icon !== 'string') errors.push(`${where}.icon 必须是字符串（允许空串）`);
}

/**
 * 校验一份名表（库形态：返回错误列表，不退出进程）。
 * @param {object} obj 解析后的 config/names/*.json
 * @param {string} [label]
 * @returns {{ok: boolean, errors: string[], stats: object}}
 */
export function checkTable(obj, label = '(未命名)') {
  const errors = [];
  const tag = (m) => errors.push(`[${label}] ${m}`);
  const stats = { characters: 0, byAsset: 0, withCostume: 0, withIcon: 0 };
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: [`[${label}] 顶层必须是对象`], stats };
  }
  const metaErrors = [];
  checkMeta(obj._meta, metaErrors);
  for (const e of metaErrors) tag(e);
  const mergeBy = (obj._meta && obj._meta.mergeBy) || 'id';

  const chars = obj.characters;
  if (!chars || typeof chars !== 'object' || Array.isArray(chars)) {
    tag('characters 必须是对象（角色 id → 条目）');
    return { ok: false, errors, stats };
  }
  for (const [key, c] of Object.entries(chars)) {
    const errs = [];
    checkCharacter(key, c, mergeBy, errs);
    for (const e of errs) tag(e);
    stats.characters += 1;
    if (Array.isArray(c && c.costume) && c.costume.length) stats.withCostume += 1;
    if (c && typeof c.icon === 'string' && c.icon) stats.withIcon += 1;
  }

  const byAsset = obj.byAsset;
  if (!byAsset || typeof byAsset !== 'object' || Array.isArray(byAsset)) {
    tag('byAsset 必须是对象（资源文件名 → 角色 id）');
  } else {
    for (const [filename, id] of Object.entries(byAsset)) {
      stats.byAsset += 1;
      if (typeof id !== 'string' || !id.trim()) { tag(`byAsset["${filename}"] 必须是角色 id 字符串`); continue; }
      if (!chars[id]) tag(`byAsset["${filename}"] = ${JSON.stringify(id)} 指向不存在的角色（悬空引用 ⇒ 查表命中不到）`);
    }
  }
  return { ok: errors.length === 0, errors, stats };
}

/** 校验一个文件 */
function checkFile(file) {
  const label = path.basename(file);
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`[${label}] JSON 解析失败：${e.message}`], stats: {} };
  }
  return checkTable(obj, label);
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const files = args.filter((a) => !a.startsWith('--'));
  let targets = files;
  if (!targets.length) {
    if (!fs.existsSync(NAMES_DIR)) {
      console.error(`目录不存在：${path.relative(ROOT, NAMES_DIR)}（名表不入库，本机没有就跳过）`);
      process.exit(2);
    }
    targets = fs.readdirSync(NAMES_DIR).filter((f) => f.endsWith('.json')).map((f) => path.join(NAMES_DIR, f));
    if (!targets.length) {
      console.error(`目录里没有 *.json：${path.relative(ROOT, NAMES_DIR)}`);
      process.exit(2);
    }
  }
  const results = [];
  let bad = 0;
  for (const file of targets) {
    const r = checkFile(file);
    results.push({ file: path.relative(ROOT, file), ...r });
    if (!r.ok) bad += 1;
  }
  if (json) {
    console.log(JSON.stringify({ ok: bad === 0, results }, null, 2));
  } else {
    for (const r of results) {
      const s = r.stats || {};
      console.log(`${r.ok ? '✅' : '❌'} ${r.file}  角色=${s.characters ?? '-'} byAsset=${s.byAsset ?? '-'} 有皮肤名=${s.withCostume ?? '-'} 有头像=${s.withIcon ?? '-'}`);
      if (!r.ok) r.errors.slice(0, 20).forEach((e) => console.log(`   ${e}`));
      if (!r.ok && r.errors.length > 20) console.log(`   …还有 ${r.errors.length - 20} 处`);
    }
    console.log(bad === 0 ? `\n✅ 全部通过（${results.length} 个文件）` : `\n❌ ${bad}/${results.length} 个文件未通过`);
  }
  process.exit(bad === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
