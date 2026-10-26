#!/usr/bin/env node
// migrate-names-v2.mjs —— 把 v1 名表 `config/names/<game>.json` 迁移成 v2 `config/index/<game>.index.json`
//
// 依据 docs/设计/名表.md §9.2 的字段映射表（逐条对上，漏一个就丢数据）：
//   name(字符串)      → name([{lang:'zh', text: nameZh || name}])
//   nameZh            → 并入上条，不再单独存在
//   costume(字符串)   → **不硬造皮肤 ID**：v1 没有皮肤 ID，建不出 costumes 键 ⇒ 聚合记进 _meta.migrateNotes 待第 5 步补
//   icon              → avatar（改名）
//   assets            → 删除；但先用它补全 byAsset 缺失项（D7），补出来的标 how:'manual'
//   npc(布尔)         → 保留（roster 5 处读取；不并进 tags —— tags 是筛选、npc 是分类）
//   byAsset(字符串)   → {char, how:'upstream'}
//   _meta             → 保留原有字段 + 新增 idSemantics / roots / normalize
//
// 用法：
//   node tool/migrate-names-v2.mjs --dry-run     # 只报统计，不写文件（先看再写）
//   node tool/migrate-names-v2.mjs               # 写 config/index/*.index.json
//
// 为什么 roots 要从 resources.json 现算：`_meta.roots` 的语义是"本索引服务的资源根"，
//   而"哪个根属于哪个游戏"的事实只存在于 resources.json 的 `names` 字段里。
//   写死一份根名清单 = 造第二份真相，加根/改名就漂移。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkIndex } from './check-index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NAMES_DIR = path.join(ROOT, 'config', 'names');
const INDEX_DIR = path.join(ROOT, 'config', 'index');
const RESOURCES = path.join(ROOT, 'config', 'resources.json');

/**
 * 剥 JSONC 注释（resources.json 带注释）。
 * 必须按字符扫：URL 里的 `//`（"https://…"）不能当成行注释起点。
 */
export function stripJsonComments(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  let esc = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      i += 1;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') {                       // 行注释
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {                       // 块注释
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 从 resources.json 按 `names` 字段筛出属于某游戏的根 id（事实来源，不写死） */
function rootsFor(gameKey) {
  try {
    const raw = stripJsonComments(fs.readFileSync(RESOURCES, 'utf8'));
    const obj = JSON.parse(raw.replace(/,(\s*[}\]])/g, '$1')); // 顺手容错尾逗号
    const roots = Array.isArray(obj.roots) ? obj.roots : [];
    return roots.filter((r) => r && r.names === gameKey).map((r) => r.id).filter(Boolean);
  } catch {
    return [];
  }
}

/** 每个游戏的 _meta 附加信息（idSemantics 按 ID 形态与来源给，normalize 不给的写空串表示"不做归一化"） */
const GAME_META = {
  azurlane: {
    idSemantics: 'ship_id',
    normalize: 'strip-suffix:_ii,_new,_hx + roman-numerals',
  },
  bd2: {
    // ID 是纯数字角色编号（9016），来源 character_list.ts —— 语义按 ID 形态记录，导入工具阶段再确认
    idSemantics: 'numeric_character_id',
    normalize: '',
  },
  dcg: {
    // ID 形如 c000_10（childs.json 的 child 编号 + 变体），故记 child 编号语义
    idSemantics: 'child_id',
    normalize: '',
  },
};

/**
 * 把 v1 条目迁成 v2 条目。
 * @returns {{entry:object, notes:string[]}}
 */
function migrateChar(id, v1, notes) {
  // nameZh 优先，空则用 name；两者都空 ⇒ 空数组（**不编造**，让 check 拦出来如实暴露）
  const zh = typeof v1.nameZh === 'string' && v1.nameZh.trim() ? v1.nameZh.trim() : '';
  const base = typeof v1.name === 'string' ? v1.name.trim() : '';
  const text = zh || base;
  const entry = { name: text ? [{ lang: 'zh', text }] : [] };

  if (v1.npc === true) entry.npc = true;                      // 只为 true 落字段，保持文件小；false 是缺省语义
  if (typeof v1.icon === 'string' && v1.icon.trim()) entry.avatar = v1.icon.trim();
  // costume：v1 是单字符串、没有皮肤 ID ⇒ 建不出 costumes{皮肤ID→…}，逐条记 note 由调用方聚合
  if (typeof v1.costume === 'string' && v1.costume.trim()) notes.push(v1.costume.trim());
  return entry;
}

function migrateOne(gameKey, { dryRun }) {
  const src = path.join(NAMES_DIR, `${gameKey}.json`);
  if (!fs.existsSync(src)) return { gameKey, skipped: true };
  const v1 = JSON.parse(fs.readFileSync(src, 'utf8'));
  const v1Chars = v1.characters || {};
  const v1ByAsset = v1.byAsset || {};
  const v1Meta = v1._meta || {};

  const characters = {};
  const costumeNotes = [];              // 收集非空 costume 字符串，后面按值聚合
  for (const [id, c] of Object.entries(v1Chars)) {
    characters[id] = migrateChar(id, c || {}, costumeNotes);
  }

  // byAsset：v1 值是字符串 ⇒ {char, how:'upstream'}
  const byAsset = {};
  let upstreamCount = 0;
  for (const [key, val] of Object.entries(v1ByAsset)) {
    if (typeof val === 'string' && val) { byAsset[key] = { char: val, how: 'upstream' }; upstreamCount += 1; }
  }

  // D7：用 v1 的 assets 补全 byAsset 缺失项（"角色有资产、但 byAsset 里没这个键"）
  let filled = 0;
  for (const [id, c] of Object.entries(v1Chars)) {
    const assets = Array.isArray(c && c.assets) ? c.assets : [];
    for (const a of assets) {
      if (typeof a !== 'string' || !a) continue;
      if (byAsset[a]) continue;                                   // 已有映射就不动（不覆盖上游结论）
      byAsset[a] = { char: id, how: 'manual' };                   // 补出来的标 manual，导入工具重跑时保留
      filled += 1;
    }
  }

  // costume 值的聚合分布（只记分布，不逐条堆 2583 行）
  const costumeDist = {};
  for (const v of costumeNotes) costumeDist[v] = (costumeDist[v] || 0) + 1;

  const roots = rootsFor(gameKey);
  const gm = GAME_META[gameKey] || { idSemantics: '', normalize: '' };
  const index = {
    _meta: {
      spec: v1Meta.spec || 'modelstage/character-table',
      specVersion: 2,
      game: v1Meta.game || gameKey,
      source: v1Meta.source || '',
      sourceUrl: v1Meta.sourceUrl || '',
      generatedAt: v1Meta.generatedAt || '',
      idSemantics: gm.idSemantics,
      roots,
      normalize: gm.normalize,
      migratedAt: new Date().toISOString(),
      migrateNotes: {
        fromVersion: 1,
        // v1 的 costume 是单字符串、无皮肤 ID ⇒ v2 的 costumes 建不出来。这里只记录分布，等第 5 步导入工具补。
        costumeWithoutSkinId: {
          note: 'v1 的 costume 是单字符串、没有皮肤 ID，无法建 costumes 键；已保留在 _meta 待补（不猜 ID）',
          distinctValues: Object.keys(costumeDist).length,
          byValue: costumeDist,
        },
        assetsFilledByAsset: {
          note: 'v1 的 assets 在 v2 删除；先用它补全 byAsset 缺失的键（D7），这些条目 how=manual',
          filled,
        },
        npcKept: true,
        counts: { characters: Object.keys(characters).length, byAsset: Object.keys(byAsset).length, upstream: upstreamCount, filledByAssets: filled },
      },
    },
    characters,
    byAsset,
  };

  const check = checkIndex(index, `${gameKey}.index.json`);
  const outPath = path.join(INDEX_DIR, `${gameKey}.index.json`);
  let bytes = 0;
  if (!dryRun) {
    fs.mkdirSync(INDEX_DIR, { recursive: true });
    const text = JSON.stringify(index, null, 1);   // 缩进 1：可读且比 2 省 ~25% 体积
    fs.writeFileSync(outPath, `${text}\n`, 'utf8');
    bytes = Buffer.byteLength(text, 'utf8');
  }
  return {
    gameKey, v1Chars: Object.keys(v1Chars).length, v2Chars: Object.keys(characters).length,
    v1Assets: Object.keys(v1ByAsset).length, v2Assets: Object.keys(byAsset).length,
    upstream: upstreamCount, filled, roots,
    costumeDistinct: Object.keys(costumeDist).length,
    check, bytes, outPath: path.relative(ROOT, outPath),
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const games = fs.readdirSync(NAMES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  console.log(`名表 v1 → v2 迁移${dryRun ? '（dry-run，不写文件）' : ''}：${games.join(', ')}\n`);
  let allOk = true;
  for (const g of games) {
    const r = migrateOne(g, { dryRun });
    if (r.skipped) { console.log(`⚠️ ${g}: 源文件不存在，跳过`); continue; }
    const dist = Object.entries(r.check.stats.nameLenDist || {}).map(([k, v]) => `${k}条×${v}`).join(' ');
    console.log(`${r.check.ok ? '✅' : '❌'} ${g}`);
    console.log(`   角色数 v1=${r.v1Chars} → v2=${r.v2Chars}  ${r.v1Chars === r.v2Chars ? '（相等 ✓）' : '（**不相等，丢了！**）'}`);
    console.log(`   byAsset v1=${r.v1Assets} → v2=${r.v2Assets}（upstream=${r.upstream} + assets补全=${r.filled}）`);
    console.log(`   名字条数分布：${dist}`);
    console.log(`   roots=${JSON.stringify(r.roots)}  costume 单值种类=${r.costumeDistinct}`);
    if (!dryRun) console.log(`   写出 ${r.outPath}（${(r.bytes / 1024).toFixed(0)} KB）`);
    if (!r.check.ok) {
      allOk = false;
      for (const e of r.check.errors.slice(0, 8)) console.log(`   ✗ ${e}`);
    }
  }
  console.log(allOk ? '\n✅ 全部迁移并通过校验' : '\n❌ 有文件未通过校验（上面有明细）');
  process.exit(allOk ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error('migrate-names-v2 执行失败：', (e && e.message) || e); process.exit(2); });
}
