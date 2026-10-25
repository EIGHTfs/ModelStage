#!/usr/bin/env node
// name-table-spec.mjs —— 角色名表（含头像）的**统一规范**定义与构造函数
//
// 规范目的：
//   各游戏的名字/头像来源五花八门（BD2 是 TS 里硬编码的对象、天命之子是社区查看器的
//   childs.json、头像有的外置成目录、有的在模型目录里自带 icon.png）。
//   本项目一律把它们**转成同一套 JSON 规范**，前端与后端只认这一套。
//
// 规范结构（specVersion 1）：
//   {
//     "_meta": {
//       "spec": "modelstage/character-table",
//       "specVersion": 1,
//       "game": "棕色尘埃2",              // 展示用游戏名
//       "source": "上游文件名",
//       "sourceUrl": "上游地址（可空）",
//       "generatedAt": "ISO 时间",
//       "counts": { "characters": N, "assets": M },
//       "icon": {                        // 头像来源说明（**可移植的命名规则**）
//         "pattern": "icon_{asset}.png", // {asset} 替换为资源名；空串表示无外置头像
//         "note": "..."
//       }
//     },
//     "characters": {
//       "<角色ID>": {
//         "name": "Lathel",              // 角色名（英文，必需）
//         "nameZh": "山城恋",            // 中文译名（与 name **同级**；可空）
//                                        //   前端只负责显示顺序（中文在前），不再分文件存放
//         "costume": "Herb Tracker",     // 服装名（可空）
//         "npc": false,                  // 是否 NPC
//         "assets": ["char000101"],      // 该角色对应的资源名（归一 key）
//         "icon": "icon_char000101.png"  // 头像文件名（相对资源根配置的 icons.dir；可空）
//       }
//     },
//     "byAsset": { "char000101": "000101" }   // 资源名(小写) -> 角色ID，供前端按模型名直接查
//   }
//
// 为什么头像只存**文件名**、目录另配：
//   文件名是可移植的数据（跟着名表走），而目录是机器相关路径（本机绝对路径），
//   放进 JSON 会导致换机器失效 —— 故目录由 config/resources.json 的 roots[].icons.dir 指定。

import fs from 'node:fs';

export const SPEC = 'modelstage/character-table';
export const SPEC_VERSION = 1;

/**
 * 按统一规范构造名表对象。
 *
 * @param {object} o
 * @param {string} o.game        游戏展示名
 * @param {string} o.source      上游文件名
 * @param {string} [o.sourceUrl] 上游地址
 * @param {string} [o.iconPattern] 头像命名模式（含 {asset} 占位符）；无外置头像传空串
 * @param {Array}  o.rows        每项 { id, name, nameZh, costume, npc, assets:[], icon }
 * @param {object} [o.keepZh]    已有的中文译名映射 { id: 中文 } 或 { 英文名: 中文 }，
 *                               用于重跑转换时**保留**人工整理的中文名（否则会被冲掉）
 * @returns {object} 规范化的名表
 */
export function buildNameTable(o) {
  const characters = {};
  const byAsset = {};
  let skipped = 0;

  // 已有的中文译名（重跑转换时沿用，避免人工整理的译名被冲掉）
  const keepZh = o.keepZh || {};
  for (const r of o.rows || []) {
    const name = String(r.name == null ? '' : r.name).trim();
    if (!name) { skipped++; continue; }   // 无名条目不入表
    const assets = (r.assets || []).map((a) => String(a).trim()).filter(Boolean);
    // 中文译名与 name **同级**存放在同一份文件里（不再另开文件）；
    //   来源优先级：行内自带 > 已有表按 id 匹配 > 已有表按英文名匹配。
    const nameZh = String(r.nameZh || keepZh[r.id] || keepZh[name] || '').trim();
    characters[r.id] = {
      name,
      nameZh,
      costume: String(r.costume == null ? '' : r.costume).trim(),
      npc: !!r.npc,
      assets,
      icon: r.icon ? String(r.icon).trim() : '',
    };
    for (const a of assets) byAsset[a.toLowerCase()] = r.id;
  }

  return {
    _meta: {
      spec: SPEC,
      specVersion: SPEC_VERSION,
      game: o.game || '',
      source: o.source || '',
      sourceUrl: o.sourceUrl || '',
      generatedAt: new Date().toISOString(),
      counts: { characters: Object.keys(characters).length, assets: Object.keys(byAsset).length },
      skipped,
      icon: {
        pattern: o.iconPattern == null ? '' : o.iconPattern,
        note: '头像文件名相对资源根配置的 icons.dir；{asset} 会被替换为资源名。'
          + '为空表示该游戏没有外置头像目录（此时回退用模型目录自带的 icon.png）。',
      },
    },
    characters,
    byAsset,
  };
}

/**
 * 按模式为某个角色挑头像文件名。
 *
 * 为什么需要它：图标通常只覆盖部分资源（BD2 实测只覆盖立绘 char000101，
 *   技能 cutscene_char000101 没有），所以要按 assets 顺序试，取第一个真实存在的文件。
 * @param {string} dir 头像目录（可为空，为空时按模式直接生成第一个候选，不校验存在性）
 * @param {string} pattern 形如 icon_{asset}.png
 * @param {string[]} assets 该角色的资源名列表
 * @param {Function} exists 判断文件是否存在的函数 (absPath)=>boolean
 */
export function pickIcon(dir, pattern, assets, exists) {
  if (!pattern) return '';
  for (const a of assets || []) {
    const file = pattern.replace(/\{asset\}/g, a);
    if (!dir) return file;                 // 无目录可校验时取第一个候选
    if (exists && exists(`${dir}/${file}`)) return file;
  }
  return '';
}

/**
 * 读取**已有名表**里的中文译名，供重跑转换时沿用。
 *
 * 为什么需要：主名表由转换器生成，重跑会整个覆盖；而 nameZh 是人工整理的增量数据，
 *   若不沿用就会被冲掉。返回同时按「角色ID」与「英文名」建索引，便于两种匹配方式。
 * @param {string} outFile 目标名表文件（不存在或损坏时返回空对象）
 */
export function readKeepZh(outFile) {
  try {
    const t = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const map = {};
    for (const [id, c] of Object.entries(t.characters || {})) {
      if (c && c.nameZh) {
        map[id] = c.nameZh;
        if (c.name) map[c.name] = c.nameZh;
      }
    }
    return map;
  } catch {
    return {};
  }
}
