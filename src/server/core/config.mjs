// config.mjs —— 资源根配置的读写与分组视图（config/resources.json 是唯一权威）
//
// 写回时保留原文件的注释头，避免系统写一次就把人工写的说明冲掉；
// 写入走 tmp + rename，避免读到写了一半的内容。
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc } from '../../../tool/parse-jsonc.mjs';

/** @param {{root: string, configFile: string}} p */
export function createConfig(p) {
  const ROOT = p.root;
  const CONFIG_FILE = p.configFile;

/**
 * 读配置（JSONC），返回生效的资源根数组。
 *
 * 职责划分（重要）：
 *   资源根目录列表**只由 config/resources.json 负责**（唯一权威），
 *   由用户在界面上选择文件夹后自动生成/写入（见 POST /api/roots）。
 *   env 只负责部署差异类的单值（PORT、SPINE_RUNTIME_DIR 等），
 *   不用于增删资源根 —— 结构性列表交给 JSON，避免两套真相源。
 *
 * @returns {Array<{id:string,name:string,path:string,enabled:boolean}>}
 */
function readConfig() {
  try {
    const cfg = parseJsonc(fs.readFileSync(CONFIG_FILE, 'utf8'), 'config/resources.json');
    const roots = Array.isArray(cfg.roots) ? cfg.roots : [];
    return roots.filter((r) => r && r.id && r.path && r.enabled !== false);
  } catch (e) {
    console.error('读取 config/resources.json 失败:', e.message);
    return [];
  }
}

/**
 * 写回 config/resources.json（保留原文件注释头部）。
 *
 * 为什么保留注释头：配置文件带 // 注释（JSONC），若整文件用 JSON.stringify 覆盖，
 *   注释会被冲掉；而注释是给"人"看的说明，系统自动生成时也应保留。
 *   做法：截取原文件第一个 '{' 之前的内容作为 header，再拼接新的完整 JSON。
 *
 * 原子写入：先写 .tmp 再 rename，避免写到一半中断导致配置损坏。
 *
 * @param {Array} roots 资源根数组
 */
function writeConfig(roots) {
  let header = '';
  if (fs.existsSync(CONFIG_FILE)) {
    const old = fs.readFileSync(CONFIG_FILE, 'utf8');
    const brace = old.indexOf('{');
    if (brace > 0) header = old.slice(0, brace);
  }
  if (!header) {
    header = [
      '// 本地资源根配置 —— 由界面「添加资源根」自动生成，也可手动编辑',
      '// 文件格式：JSONC（标准 JSON + // 注释）；注释由 tool/parse-jsonc.mjs 剥离',
      '// 字段：id(唯一标识) / name(显示名) / path(本机绝对路径) / enabled(默认 true)',
      '',
    ].join('\n');
  }

  const body = JSON.stringify({ roots }, null, 2);
  fs.writeFileSync(CONFIG_FILE + '.tmp', header + body + '\n', 'utf8');
  fs.renameSync(CONFIG_FILE + '.tmp', CONFIG_FILE);
}

/**
 * 按 name（显示名称 = 归一 key）把资源根归并成组，供前端直接渲染。
 *
 * 归一语义：name 相同的多个资源根合并为一个条目。
 *   例：「棕色尘埃2 原版」与「棕色尘埃2 mod」两个目录若都命名为"棕色尘埃2"，
 *      界面合并成一个"棕色尘埃2"，其下汇总各 root 的模型（原版 + mod 共存不覆盖）。
 *
 * @param {Array} roots 资源根数组
 * @returns {Array<{name:string, rootCount:number, roots:Array}>}
 */
function buildGroups(roots) {
  const map = new Map();
  for (const r of roots) {
    if (!map.has(r.name)) map.set(r.name, { name: r.name, rootCount: 0, roots: [] });
    const g = map.get(r.name);
    g.rootCount++;
    g.roots.push({ id: r.id, path: r.path, exists: fs.existsSync(r.path) && fs.statSync(r.path).isDirectory() });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** 可导出/导入的配置文件清单（相对 config/ 的路径）。 */
function exportableConfigFiles() {
  const files = ['resources.json'];
  const namesDir = path.join(ROOT, 'config', 'names');
  try {
    for (const n of fs.readdirSync(namesDir)) {
      if (n.endsWith('.json')) files.push(`names/${n}`);
    }
  } catch { /* names 目录不存在则只有 resources.json */ }
  return files;
}

/** 读取全部可导出配置的原始文本。 */
function exportConfigFiles() {
  const out = {};
  for (const rel of exportableConfigFiles()) {
    try {
      out[rel] = fs.readFileSync(path.join(ROOT, 'config', rel), 'utf8');
    } catch { /* 读不到就跳过该文件 */ }
  }
  return out;
}

  return { readConfig, writeConfig, buildGroups, exportableConfigFiles, exportConfigFiles, CONFIG_FILE };
}

