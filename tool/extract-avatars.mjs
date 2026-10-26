#!/usr/bin/env node
// extract-avatars.mjs —— 头像提取工具（一次性；提取完可删）
//
// 为什么单独一个仓：头像 png 是**二进制大文件**，放主项目仓会把仓吹大、且每次换头像都产生
//   不可读的 diff。所以头像进独立私有仓（本目录），主仓只存 `config/index/*.index.json`
//   里的 `avatar` 文件名（D2）。
//
// 三条提取路（docs/设计/名表.md §四）：
//   ① 资源目录自带 icon.png            → 首扫时拷入
//   ② 仓内头像目录（icons.dir 指向的目录）→ 全量拷入，并按 index 的 avatar 名重命名
//   ③ 无源                              → 留空（界面兜底占位图，不阻塞）
//
// 默认 **dry-run**：只统计「每个游戏能提多少、缺多少、各走哪条路」，不写任何文件。
//   真拷要显式 --write（第 5 步才做）。这样不会在没确认的情况下动资源仓/写几百个 png。
//
// 用法：
//   node tool/extract-avatars.mjs                    # 全部游戏 dry-run（默认）
//   node tool/extract-avatars.mjs --game bd2         # 只看一个
//   node tool/extract-avatars.mjs --manifest-only   # 只按 index 生成/刷新 manifest.json
//   node tool/extract-avatars.mjs --write           # 真拷（需要资源仓在本机）
//
// 注意：本工具**不**创建任何 git 远端、不推送。远端由维护者确认后统一建。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');            // 主仓根（本脚本在 tool/ 下）
// 头像根**可配置**：头像仓是独立私有仓，可能 clone 到本机任意可写位置
//   （本项目主仓在 CIFS 挂载上，git init/clone 会因 chmod 受限失败 ⇒ 不能假设它一定在主仓内）。
//   优先级：--avatar-root <dir> > 环境变量 MODELSTAGE_AVATAR_ROOT > <主仓>/avatars
const avatarArgIdx = process.argv.indexOf('--avatar-root');
const AVATAR_ROOT = path.resolve(
  (avatarArgIdx >= 0 && process.argv[avatarArgIdx + 1])
    || process.env.MODELSTAGE_AVATAR_ROOT
    || path.join(REPO_ROOT, 'avatars'),
);
const INDEX_DIR = path.join(REPO_ROOT, 'config', 'index');
const RESOURCES = path.join(REPO_ROOT, 'config', 'resources.json');

/** 剥 JSONC 注释（resources.json 带注释；URL 里的 // 不能当注释） */
function stripJsonComments(text) {
  let out = ''; let i = 0; let inStr = false; let esc = false;
  while (i < text.length) {
    const ch = text[i]; const next = text[i + 1];
    if (inStr) {
      out += ch;
      if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false;
      i += 1; continue;
    }
    if (ch === '"') { inStr = true; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 2; continue; }
    out += ch; i += 1;
  }
  return out;
}

/** 读 resources.json，返回属于某游戏（names===game）的根 {id, path, iconsDir} */
function rootsOf(gameKey) {
  try {
    const obj = JSON.parse(stripJsonComments(fs.readFileSync(RESOURCES, 'utf8')).replace(/,(\s*[}\]])/g, '$1'));
    const roots = Array.isArray(obj.roots) ? obj.roots : [];
    return roots.filter((r) => r && r.names === gameKey).map((r) => ({
      id: r.id,
      dir: r.path,
      // icons.dir 在 v2 下弃用（§七），但提取阶段仍可作为「仓内头像目录」的线索
      iconsDir: (r.icons && r.icons.dir) || null,
    }));
  } catch { return []; }
}

/** 该游戏已有哪些头像文件（png），返回 Set<文件名> */
function existingFiles(gameDir) {
  const set = new Set();
  try {
    for (const f of fs.readdirSync(gameDir)) if (f.toLowerCase().endsWith('.png')) set.add(f);
  } catch { /* 目录不存在就空集合 */ }
  return set;
}

function planGame(gameKey, { write }) {
  const indexFile = path.join(INDEX_DIR, `${gameKey}.index.json`);
  if (!fs.existsSync(indexFile)) return { gameKey, skipped: '没有 index.json（先跑迁移）' };
  const idx = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const chars = idx.characters || {};
  const gameDir = path.join(AVATAR_ROOT, gameKey);
  fs.mkdirSync(gameDir, { recursive: true });
  const have = existingFiles(gameDir);

  // manifest：<角色ID> → 文件名（只收录"有 avatar 声明"的角色；没有声明的不编文件名）
  const manifest = {};
  let declared = 0;
  let missing = 0;
  const byRoute = { alreadyPresent: 0 };

  for (const [id, c] of Object.entries(chars)) {
    if (!c || typeof c.avatar !== 'string' || !c.avatar.trim()) continue;
    declared += 1;
    manifest[id] = c.avatar.trim();
    if (have.has(c.avatar.trim())) byRoute.alreadyPresent += 1;
    else missing += 1;
  }

  if (write) {
    fs.writeFileSync(path.join(gameDir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`, 'utf8');
  }

  const roots = rootsOf(gameKey);
  // 三条路的可用性侦察（只读，不拷贝）
  const routes = {
    route1_iconInResourceDir: roots.filter((r) => fs.existsSync(r.dir)).length,
    route2_iconsDir: roots.filter((r) => r.iconsDir && fs.existsSync(r.iconsDir)).map((r) => r.iconsDir),
    route3_placeholder: 0,
  };
  if (!routes.route1_iconInResourceDir && !routes.route2_iconsDir.length) routes.route3_placeholder = missing;

  return {
    gameKey, declared, missing, byRoute, routes, haveCount: have.size,
    manifestCount: Object.keys(manifest).length,
    manifestPath: path.relative(REPO_ROOT, path.join(gameDir, 'manifest.json')),
    roots,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const manifestOnly = argv.includes('--manifest-only');
  const only = argv.includes('--game') ? argv[argv.indexOf('--game') + 1] : null;

  const games = fs.existsSync(INDEX_DIR)
    ? fs.readdirSync(INDEX_DIR).filter((f) => f.endsWith('.index.json')).map((f) => f.replace(/\.index\.json$/, ''))
    : [];
  if (!games.length) {
    console.error(`没有可用的 index：${path.relative(REPO_ROOT, INDEX_DIR)}/*.index.json（先跑 tool/migrate-names-v2.mjs）`);
    process.exit(2);
  }
  console.log(`头像提取${manifestOnly ? '（只生成 manifest）' : write ? '（**真拷**）' : '（dry-run，不写文件）'}\n`);

  let totalDeclared = 0; let totalMissing = 0;
  for (const g of games) {
    if (only && g !== only) continue;
    const r = planGame(g, { write: write || manifestOnly });
    if (r.skipped) { console.log(`⚠️ ${g}: ${r.skipped}`); continue; }
    totalDeclared += r.declared; totalMissing += r.missing;
    console.log(`📁 ${g}`);
    console.log(`   有 avatar 声明 ${r.declared} 条；现有 png ${r.haveCount} 个；待补 ${r.missing} 个`);
    console.log(`   manifest ${r.manifestCount} 条 → ${r.manifestPath}${write || manifestOnly ? '（已写）' : '（dry-run 未写）'}`);
    console.log(`   提取路：①资源目录存在 ${r.routes.route1_iconInResourceDir}/${r.roots.length} 个根 ②icons.dir ${r.routes.route2_iconsDir.length} 个 ③占位 ${r.routes.route3_placeholder}`);
  }
  console.log(`\n合计：有 avatar 声明 ${totalDeclared} 条，待补 png ${totalMissing} 个`);
  if (!write && !manifestOnly) console.log('（dry-run：真拷请加 --write；只刷清单加 --manifest-only）');
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
