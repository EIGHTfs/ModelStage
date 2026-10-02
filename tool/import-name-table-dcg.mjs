#!/usr/bin/env node
// import-name-table-dcg.mjs —— 把天命之子（Destiny Child）的角色数据转成**统一规范**名表
//
// 统一规范见 tool/name-table-spec.mjs（名字与头像同在一份 JSON）。
//
// 背景：天命之子的 Live2D 资源目录名只是 ID（如 c000_01），
//   上游项目（DestinyChildLive2D）里的 assets/names.json **只是目录名索引数组**，
//   不含任何角色名——所以界面只能显示 c000_01 这种 ID。
//
// 数据来源：社区查看器 Live2D-DCG 的角色数据 static/json/childs.json
//   （键为角色基名、name 为角色名、variants.<后缀>.title 为服装名）：
//     { "c000": { "name": "Master", "variants": { "10": {"title":"Mysterious"}, ... } } }
//   与我们的目录名结构（<基名>_<两位后缀>）完全对应。
//   下载：curl -sL -o childs.json \
//     https://raw.githubusercontent.com/Live2D-DCG/Live2D-DCG.github.io/master/static/json/childs.json
//
// 用法：
//   node tool/import-name-table-dcg.mjs <childs.json> <输出.json> [--game=天命之子]
//
// 头像：天命之子的头像在**每个模型目录里自带 icon.png**，没有外置头像目录，
//   故本表不写 icon 字段、_meta.icon.pattern 留空——服务端会回退用模型目录里的 icon.png。

import fs from 'node:fs';
import path from 'node:path';
import { buildNameTable, readKeepZh } from './name-table-spec.mjs';

function main() {
  const [, , inFile, outFile, ...rest] = process.argv;
  if (!inFile || !outFile) {
    console.error('用法: node tool/import-name-table-dcg.mjs <childs.json> <输出.json> [--game=天命之子]');
    process.exit(1);
  }
  const arg = (k, d) => {
    const hit = rest.find((x) => x.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };
  const game = arg('game', '天命之子');

  const raw = JSON.parse(fs.readFileSync(inFile, 'utf8'));

  // 每个「基名 + 后缀」是一个独立条目（服装名随后缀变化：c000_10=Mysterious、c000_12=Swimsuit）
  const rows = [];
  for (const [base, v] of Object.entries(raw)) {
    const name = String((v && v.name) || '').trim();
    if (!name) continue;
    const variants = (v && v.variants) || {};
    for (const [suffix, meta] of Object.entries(variants)) {
      const dir = `${base}_${suffix}`;
      rows.push({
        id: dir,
        name,
        costume: String((meta && meta.title) || '').trim(),
        npc: false,
        assets: [dir],   // 资源名就是目录名
        icon: '',        // 头像在模型目录里自带 icon.png，见文件头说明
      });
    }
  }

  // 沿用已有名表里的中文译名（重跑转换不冲掉人工整理的译名）
  const keepZh = readKeepZh(outFile);
  const table = buildNameTable({
    keepZh,
    game,
    source: path.basename(inFile),
    sourceUrl: 'https://github.com/Live2D-DCG/Live2D-DCG.github.io (static/json/childs.json)',
    iconPattern: '',   // 无外置头像目录
    rows,
  });

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(table, null, 2) + '\n', 'utf8');

  const m = table._meta;
  console.log(`输入: ${inFile}`);
  console.log(`输出: ${outFile}`);
  console.log(`  规范: ${m.spec} v${m.specVersion}   游戏: ${m.game}`);
  console.log(`  角色: ${m.counts.characters}   资源反查项: ${m.counts.assets}   跳过(无名): ${m.skipped}`);
  const sample = Object.entries(table.characters).slice(0, 4)
    .map(([k, c]) => `${k}=${c.name}${c.costume ? ' / ' + c.costume : ''}`).join(' | ');
  console.log(`  样例: ${sample}`);
}

main();
