// server/data/display-name-cache.mjs —— 列表显示名缓存（config/bundle-display-names.json）
//
// 只做存取，不解其意：名字是内容语义，由插件经 analyze() 给出；本模块不认识
//   `.skel` / `.atlas` / moc3，也不对名字做任何截断、拼接、大小写处理。
//
// 为什么缓存归核心而不是插件：插件可能被禁用或替换，但"上次算出来的名字"仍然可读；
//   而且跨请求存取本来就是核心的职责（与 entry-states 的结论缓存同性质）。
//
// 失效：mtimeMs 或 size 任一变化即视为失效（与 manifests 的 dirStamps 同一思路：
//   内容没变就别重算，变了就重算，不依赖时间）。

import fs from 'node:fs';
import path from 'node:path';

/** 缓存文件名（与 models/ 清单目录并列，落在 config/config 同级） */
const CACHE_FILENAME = 'bundle-display-names.json';

/**
 * 缓存文件路径。
 *
 * 数据根形如 `<dataRoot>/config/resources.json`，本文件放 `<dataRoot>/config/bundle-display-names.json`。
 * @param {string} configFile 资源根配置文件路径（与清单缓存用同一个入口）
 * @returns {string}
 */
export function displayNameCacheFile(configFile) {
  return path.join(path.dirname(configFile), CACHE_FILENAME);
}

/**
 * 读整个缓存表。
 *
 * 文件不存在 / 解析失败一律返回空表（**不抛**）：缓存坏了回落到旧行为（显示文件名），
 *   不能因为一个展示态缓存让列表打不开。
 * @param {string} configFile
 * @returns {Record<string, {displayName: string|null, mtimeMs: number, size: number}>}
 */
export function readDisplayNameCache(configFile) {
  try {
    const raw = fs.readFileSync(displayNameCacheFile(configFile), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

/**
 * 写整个缓存表（调用方负责合并，本函数只落盘）。
 *
 * 原子写：先写 `.tmp` 再 rename —— 与清单写入同一做法，避免读到半份 JSON。
 * @param {string} configFile
 * @param {Record<string, object>} table
 */
export function writeDisplayNameCache(configFile, table) {
  const file = displayNameCacheFile(configFile);
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(table, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 该条目是否**已经尝试过**（无论拿到名字还是拿不到）。
 *
 * 为什么要区分"没记录"与"记录为 null"：
 *   插件不支持 / 解析失败时我们会写一条 `displayName: null` 的记录（表示"这个包取不到名字"）。
 *   若只看 `lookupDisplayName` 是否为 null，那种条目会被当成"没查过"而**每次都重跑一遍分析**，
 *   在 181 个包的规模下就是白烧 2~5 分钟。
 *
 * @param {Record<string, object>} table
 * @param {string} rootId
 * @param {string} rel
 * @param {{mtimeMs?: number, size: number}} [stat]
 * @returns {boolean}
 */
export function hasDisplayNameRecord(table, rootId, rel, stat) {
  const key = `${rootId}/${rel}`;
  const hit = table && table[key];
  if (!hit) return false;
  if (stat) {
    if (Number(hit.size) !== Number(stat.size)) return false;
    if (Number.isFinite(stat.mtimeMs) && Number(hit.mtimeMs) !== Number(stat.mtimeMs)) return false;
  }
  return true;
}

/**
 * 取一个条目的显示名（按 mtimeMs/size 判失效）。
 *
 * `mtimeMs` 是**可选**的：catalog 构造条目时只顺手带了 `size`，为了一个展示态去多做一次
 *   stat 不值得。给了 mtimeMs 就两个都比，没给就只比 size（文件内容变了 size 几乎必变）。
 *
 * @param {Record<string, object>} table 缓存表
 * @param {string} rootId
 * @param {string} rel
 * @param {{mtimeMs?: number, size: number}} stat 当前文件状态；缺了就按"无法判失效"处理
 * @returns {string|null}
 */
export function lookupDisplayName(table, rootId, rel, stat) {
  const key = `${rootId}/${rel}`;
  const hit = table && table[key];
  if (!hit || typeof hit.displayName !== 'string') return null;
  // 没有当前 stat 时无法判失效 ⇒ 采信缓存（采信旧名比丢名更稳）
  if (stat) {
    if (Number(hit.size) !== Number(stat.size)) return null;
    if (Number.isFinite(stat.mtimeMs) && Number(hit.mtimeMs) !== Number(stat.mtimeMs)) return null;
  }
  return hit.displayName;
}

/**
 * 写入一条缓存（就地改表，不落盘；由调用方决定何时 write）。
 *
 * `displayName` 为空串或全空白时**写成 null** —— 契约要求"空串表达未给"不是合法状态，
 *   存成 null 后下次读就会回落旧行为，避免列表出现空标题。
 * @param {Record<string, object>} table
 * @param {string} rootId
 * @param {string} rel
 * @param {{displayName: string|null, mtimeMs: number, size: number}} entry
 */
export function setDisplayNameEntry(table, rootId, rel, entry) {
  const name = typeof entry.displayName === 'string' ? entry.displayName.trim() : '';
  table[`${rootId}/${rel}`] = {
    displayName: name || null,
    mtimeMs: Number(entry.mtimeMs),
    size: Number(entry.size),
    at: Date.now(),
  };
  return table;
}

export { CACHE_FILENAME };
