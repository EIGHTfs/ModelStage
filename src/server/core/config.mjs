// config.mjs —— 资源根配置的读写与分组视图（config/resources.json 是唯一权威）

//
// 写回时保留原文件的注释头，避免系统写一次就把人工写的说明冲掉；
// 写入走 tmp + rename，避免读到写了一半的内容。
import fs from 'node:fs';
import { createLogger } from './log.mjs';
import path from 'node:path';
import { parseJsonc } from '../../../tool/parse-jsonc.mjs';

/** 服务端日志（统一形状 {at,level,tag,msg,detail}；error→stderr，其余→stdout） */
const log = createLogger('config');

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
    log.error('读取 config/resources.json 失败', { err: e.message });
    return [];
  }
}

/**
 * 读配置里的**全部**资源根（含 enabled:false 的），供写路径使用。
 *
 * 为什么写路径不能复用 readConfig()：
 *   readConfig() 是「运行时生效视图」，会把 enabled:false 的根过滤掉；
 *   若拿它的结果写回文件，停用的根就会被静默删除（改一次别的根就丢一条配置）。
 *   写路径必须基于完整列表做增删改，停用与否只是某个字段的值。
 *
 * 只做最小形状校验（id + path 必须存在），其余字段原样保留：
 *   roots[] 还承载 names / icons / kind / profile 等附加配置，写回时不能丢。
 *
 * @returns {Array<object>} 完整资源根数组（保持文件中的顺序）
 */
function readConfigRaw() {
  try {
    const cfg = parseJsonc(fs.readFileSync(CONFIG_FILE, 'utf8'), 'config/resources.json');
    const roots = Array.isArray(cfg.roots) ? cfg.roots : [];
    return roots.filter((r) => r && typeof r === 'object' && r.id && r.path);
  } catch (e) {
    // 读不出来时抛出而不是返回空数组：写路径拿空列表写回会把整份配置清空
    throw new Error(`读取 config/resources.json 失败: ${e.message}`);
  }
}

/**
 * 写回 config/resources.json（保留原文件注释头部）。
 *
 * 为什么保留注释头：配置文件带 // 注释（JSONC），若整文件用 JSON.stringify 覆盖，
 *   注释会被冲掉；而注释是给"人"看的说明，系统自动生成时也应保留。
 *
 * 头部怎么取（重要）：只取**文件开头的连续注释/空行块**，不能"截到第一个 '{'"。
 *   因为注释正文里也可能出现花括号（例如 icons 说明写了 `{ dir: 绝对路径 }`），
 *   按第一个 { 截断会把注释切成半行、且新 JSON 的首行被并进该注释行 —— 整份文件随即解析失败
 *   （实测：写入成功但回读报 "Unexpected non-whitespace character after JSON"，配置等于写坏）。
 *
 * 原子写入：先写 .tmp 再 rename，避免写到一半中断导致配置损坏。
 *
 * @param {Array} roots 资源根数组
 */
function writeConfig(roots) {
  let header = readHeader();
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
 * 取配置文件开头的注释块（连续的行首 // 与空行），作为写回时要保留的 header。
 *
 * 判据按**行**而不是按字符：从第一行开始，遇到第一行"不是注释也不是空行"就停。
 *   这样注释里出现的花括号、引号都不会影响截断位置；返回值保证以换行结尾，
 *   让新 JSON 从独立一行开始。
 *
 * @returns {string} 以换行结尾的注释块；文件不存在或无注释块时返回空串
 */
function readHeader() {
  if (!fs.existsSync(CONFIG_FILE)) return '';
  let old;
  try {
    old = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch {
    return '';
  }
  const lines = old.split('\n');
  const keep = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === '' || t.startsWith('//')) keep.push(line);
    else break;
  }
  if (!keep.length) return '';
  return `${keep.join('\n')}\n`;
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

  // readConfig     = 运行时生效视图（已滤掉 enabled:false），只读消费方用它
  // readConfigRaw  = 完整列表（含停用），写路径必须用它，否则会丢配置
  return { readConfig, readConfigRaw, writeConfig, buildGroups, exportableConfigFiles, exportConfigFiles, CONFIG_FILE };
}

