#!/usr/bin/env node
// import-name-table.mjs —— 把上游的「角色名映射表」转成本项目**统一规范**的名表 JSON
//
// 统一规范见 tool/name-table-spec.mjs（名字与头像同在一份 JSON）。
//
// 本转换器处理 BD2 形态的输入：源码里硬编码的对象字面量
//   （BD2-L2D-Viewer/src/utils/character_list.ts），形如
//     "000101": { "charName":"Lathel", "costumeName":"Herb Tracker", "spine":"char000101", ... }
//
// 用法：
//   node tool/import-name-table.mjs <输入.ts> <输出.json> [选项]
// 选项：
//   --game=<展示用游戏名>            默认取输入文件名
//   --name-field=<字段>             默认 charName
//   --costume-field=<字段>          默认 costumeName
//   --assets-fields=<a,b,c>         组成 assets 的字段，默认 spine,cutscene,dating
//   --icons-dir=<目录>              头像目录（用于**校验哪个资源真有头像文件**）
//   --icon-pattern=<模式>           默认 icon_{asset}.png；{asset} 替换为资源名
//
// 说明：头像只把**文件名**写进名表（可移植），目录由 config/resources.json 的
//   roots[].icons.dir 指定（机器相关路径不入数据文件）。

import fs from 'node:fs';
import path from 'node:path';
import { buildNameTable, pickIcon, readKeepZh } from './name-table-spec.mjs';

/** 从 TS/JS 源码里按花括号配平提取首个对象字面量并解析为 JS 对象。 */
function extractObjectLiteral(src) {
  const start = src.indexOf('{');
  if (start < 0) throw new Error('未找到对象字面量起始 {');
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = false; continue; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw new Error('对象字面量花括号未配平');
  return JSON.parse(src.slice(start, end + 1));
}

function main() {
  const [, , inFile, outFile, ...rest] = process.argv;
  if (!inFile || !outFile) {
    console.error('用法: node tool/import-name-table.mjs <输入.ts> <输出.json> [--game=..] [--icons-dir=..]');
    process.exit(1);
  }
  const arg = (k, d) => {
    const hit = rest.find((x) => x.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };

  const nameField = arg('name-field', 'charName');
  const costumeField = arg('costume-field', 'costumeName');
  const assetFields = arg('assets-fields', 'spine,cutscene,dating').split(',').map((s) => s.trim());
  const iconsDir = arg('icons-dir', '');
  const iconPattern = arg('icon-pattern', 'icon_{asset}.png');
  const game = arg('game', path.basename(inFile).replace(/\.[^.]+$/, ''));

  const raw = extractObjectLiteral(fs.readFileSync(inFile, 'utf8'));

  // 头像文件存在性校验：图标通常只覆盖部分资源（BD2 实测只覆盖立绘），
  // 故按 assets 顺序试，取第一个真实存在的文件。
  const exists = iconsDir ? (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } } : null;

  const rows = [];
  for (const [id, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object') continue;
    const assets = assetFields.map((f) => String(v[f] == null ? '' : v[f]).trim()).filter(Boolean);
    let costume = String(v[costumeField] == null ? '' : v[costumeField]).trim();
    if (costume === '???' || costume === '?') costume = '';   // 上游用 ??? 表示未知
    const name = String(v[nameField] == null ? '' : v[nameField]).trim();
    rows.push({
      id,
      name,
      costume,
      npc: /\(npc\)/i.test(name),   // 上游用名字里带 (Npc) 标记 NPC
      assets,
      icon: pickIcon(iconsDir, iconPattern, assets, exists),
    });
  }

  // 沿用已有名表里的中文译名（重跑转换不冲掉人工整理的译名）
  const keepZh = readKeepZh(outFile);
  const table = buildNameTable({
    keepZh, game, source: path.basename(inFile), sourceUrl: '', iconPattern, rows });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(table, null, 2) + '\n', 'utf8');

  const m = table._meta;
  console.log(`输入: ${inFile}`);
  console.log(`输出: ${outFile}`);
  console.log(`  规范: ${m.spec} v${m.specVersion}   游戏: ${m.game}`);
  console.log(`  角色: ${m.counts.characters}   资源反查项: ${m.counts.assets}   跳过(无名): ${m.skipped}`);
  const withIcon = Object.values(table.characters).filter((c) => c.icon).length;
  console.log(`  带头像: ${withIcon}${iconsDir ? `（已按 ${iconsDir} 校验存在性）` : '（未给 --icons-dir，按模式取首个候选）'}`);
  const sample = Object.entries(table.characters).slice(0, 3)
    .map(([k, c]) => `${k}=${c.name}${c.costume ? ' / ' + c.costume : ''}${c.icon ? ' [' + c.icon + ']' : ''}`).join(' | ');
  console.log(`  样例: ${sample}`);
}

main();
