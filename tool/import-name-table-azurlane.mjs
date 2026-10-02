#!/usr/bin/env node
// import-name-table-azurlane.mjs —— 把碧蓝航线（AzurLane）的皮肤数据转成**统一规范**名表
//
// 统一规范见 tool/name-table-spec.mjs（名字与头像同在一份 JSON）。
//
// 背景：碧蓝航线有两个资源根（Live2D Cubism 4 的 live2d/<painting>/ 与
//   Spine 3.8 立绘的 docs/<base>/<painting>/），目录名都是拼音（如 abeikelongbi_3），
//   本身不含角色名；且同一角色的 Live2D 与 Spine 要**聚合成同一个角色条目**，
//   需要一个「角色 → 皮肤 → 资源」的内容级依据（不以文件名为聚合依据）。
//
// 数据来源（留档在 data/upstream/azurlane/，来源仓库 AzurLaneTools/AzurLaneData）：
//   ship_skin_template.json：
//     键=皮肤id，字段 painting=资源目录名（与 Live2D/Spine 目录一致）、
//     name=名称（skin_type===-1 基础皮肤时为**角色名**，其余为**皮肤名**）、
//     ship_group=角色归组号（同角色多个皮肤共享）→ 这就是聚合依据。
//   name_code.json：
//     部分名称是占位符 "{namecode:NN}"，用本表 NN→{code,name} 解析成中文名。
//
// 聚合规则（非文件名推导）：
//   1. 每个 ship_group 取「基础皮肤（skin_type===-1）」的名称作为角色名；
//      该组若无基础皮肤，取组内第一个有名称的条目兜底。
//   2. 皮肤名 = 条目自己的 name；等于角色名的记为空（界面不重复显示）。
//   3. Live2D 与 Spine 两根共用同一份名表：资源名就是 painting，
//      按资源名反查即自动归到同一角色下（实测 aerbien_3/aerbien_4 都归到「阿尔比恩」）。
//
// 用法：
//   node tool/import-name-table-azurlane.mjs <ship_skin_template.json> <name_code.json> <输出.json> \
//        [--game=碧蓝航线] [--icons-dir=<shipmodels 目录>]
//
// 头像：碧蓝航线没有模型目录自带的 icon.png；头像来自 AzurLane-Live2D-Viewer 的
//   shipmodels/ 目录（1947 张，文件名与 painting 同名）。传 --icons-dir 时按
//   <painting>.png 存在性写入 icon 字段；不传则留空（服务端回退无头像）。

import fs from 'node:fs';
import path from 'node:path';
import { buildNameTable, readKeepZh } from './name-table-spec.mjs';

function main() {
  const [, , skinFile, codeFile, outFile, ...rest] = process.argv;
  if (!skinFile || !codeFile || !outFile) {
    console.error('用法: node tool/import-name-table-azurlane.mjs <ship_skin_template.json> <name_code.json> <输出.json> [--game=碧蓝航线] [--icons-dir=<dir>]');
    process.exit(1);
  }
  const arg = (k, d) => {
    const hit = rest.find((x) => x.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };
  const game = arg('game', '碧蓝航线');
  const iconsDir = arg('icons-dir', '');

  const skins = JSON.parse(fs.readFileSync(skinFile, 'utf8'));
  const codes = JSON.parse(fs.readFileSync(codeFile, 'utf8'));

  // 解析占位符名称："{namecode:NN}" → name_code[NN].name；非占位符原样保留。
  // 为什么必须解析：爱宕等角色的上游 name 字段就是占位符（{namecode:67}），
  //   不解析会直接把花括号串显示出来。
  const resolveName = (s) => {
    s = String(s || '').trim();
    if (!s) return '';
    return s.replace(/\{namecode:(\d+)\}/g, (_, id) => {
      const c = codes[id];
      return c && c.name ? c.name : s;
    });
  };

  // 按角色归组（ship_group）找角色名：优先取基础皮肤（skin_type === -1）的名称。
  const charNameByGroup = new Map();
  const entries = Object.values(skins).filter((v) => v && v.painting);
  for (const v of entries) {
    if (v.skin_type === -1) {
      const nm = resolveName(v.name);
      if (nm && !charNameByGroup.has(v.ship_group)) charNameByGroup.set(v.ship_group, nm);
    }
  }
  for (const v of entries) {
    if (v.skin_type !== -1 && !charNameByGroup.has(v.ship_group)) {
      const nm = resolveName(v.name);
      if (nm) charNameByGroup.set(v.ship_group, nm);
    }
  }

  // 生成行：每个 painting 一条（Live2D 与 Spine 的资源名都等于 painting，同一张表通吃）
  const iconExists = (p) => {
    if (!iconsDir) return false;
    try { return fs.statSync(path.join(iconsDir, `${p}.png`)).isFile(); } catch { return false; }
  };
  const seen = new Set();
  const rows = [];
  let noName = 0;
  for (const v of entries) {
    const p = String(v.painting).trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    const character = charNameByGroup.get(v.ship_group) || resolveName(v.name);
    if (!character) { noName++; continue; }   // 完全查不到名字的条目不入表（保持拼音回退）
    const skinName = resolveName(v.name);
    rows.push({
      id: p,
      name: character,                                  // 角色名（中文）
      nameZh: '',                                        // 中文名直接存 name，nameZh 留空
      costume: skinName !== character ? skinName : '',   // 皮肤名与角色名不同时才显示
      npc: false,
      assets: [p],
      icon: iconExists(p) ? `${p}.png` : '',
    });
  }

  // 沿用已有名表里的中文译名（重跑转换不冲掉人工整理的译名）
  const keepZh = readKeepZh(outFile);
  const table = buildNameTable({
    keepZh,
    game,
    source: 'AzurLaneTools/AzurLaneData (CN/ShareCfg/ship_skin_template.json + name_code.json)',
    sourceUrl: 'https://github.com/AzurLaneTools/AzurLaneData',
    iconPattern: iconsDir ? '{asset}.png' : '',
    rows,
  });

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(table, null, 2) + '\n', 'utf8');

  const m = table._meta;
  console.log(`输入: ${skinFile} + ${codeFile}`);
  console.log(`输出: ${outFile}`);
  console.log(`  规范: ${m.spec} v${m.specVersion}   游戏: ${m.game}`);
  console.log(`  角色条目: ${m.counts.characters}   资源反查项: ${m.counts.assets}   查不到名跳过: ${noName}`);
  const sample = Object.entries(table.characters).slice(0, 4)
    .map(([k, c]) => `${k}=${c.name}${c.costume ? ' / ' + c.costume : ''}`).join(' | ');
  console.log(`  样例: ${sample}`);
}

main();
