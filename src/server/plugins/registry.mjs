// plugins.mjs —— 展示类型插件的发现与开关（config/plugins.json）
//
// 插件是「放目录即加能力」：这里只负责把 plugins/<id>/plugin.json 读成清单，
// 并回答「某个 fileKind 当前有没有启用的插件」。
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc } from '../../../tool/parse-jsonc.mjs';

/**
 * 插件角色集合（契约 插件契约 §一）：五类角色，**别处不得自创角色名**。
 * 一个插件可以同时担任多个角色（provides 是数组）。
 */
export const PLUGIN_ROLES = ['asset-provider', 'renderer', 'editor', 'exporter', 'panel'];

/**
 * PL1 校验：`provides` 必选，且只能含已知角色。
 *
 * 为什么必须严格：`provides` 是"这个插件能干什么"的唯一声明，核心按它决定把插件挂到哪个注册表。
 *   未声明或写错角色时，插件会变成一个"注册了但没人认识"的黑盒——静默消失最难查，
 *   所以这里宁可拒绝注册并打印可读原因。
 * @param {unknown} provides
 * @returns {string|null} null = 通过；否则返回可读原因
 */
export function validateProvides(provides) {
  if (!Array.isArray(provides) || !provides.length) {
    return `未声明 provides（必选；合法角色：${PLUGIN_ROLES.join(' / ')}）`;
  }
  const unknown = provides.filter((r) => !PLUGIN_ROLES.includes(String(r)));
  if (unknown.length) {
    return `provides 含未知角色「${unknown.join('、')}」（合法角色：${PLUGIN_ROLES.join(' / ')}）`;
  }
  return null;
}

/** @param {{pluginsDir: string, pluginSwitchFile: string}} p */

/**
 * 读一个带 plugin.json 清单的插件目录。
 * 清单里的展示/契约字段原样透传给前端：label（角色库变体标签文字）、version、
 * assets（插件自己的数据文件，如 profiles/<游戏>.json）、fileKinds（能读哪几类资源，
 * 服务端据此决定条目可见性）；produces/errorCodes 是可选能力自描述，未声明时给 null/[]。
 * @returns {object|null} 不可用（清单坏/没有存在的 js/被禁用）时返回 null
 */
export function readPluginManifest(pluginsDir, dirName, isFile, disabled) {
  let m = null;
  try {
    m = JSON.parse(fs.readFileSync(path.join(pluginsDir, dirName, 'plugin.json'), 'utf8'));
  } catch (err) {
    console.warn(`[plugins] ${dirName}/plugin.json 解析失败，跳过该插件: ${err.message}`);
    return null;
  }
  const declared = Array.isArray(m.files) && m.files.length ? m.files : (m.entry ? [m.entry] : ['index.js']);
  const files = declared.map((f) => String(f).replace(/^\.?\//, '')).filter((f) => isFile(`${dirName}/${f}`));
  if (!files.length) {
    console.warn(`[plugins] ${dirName} 清单里没有任何存在的 js，跳过`);
    return null;
  }
  const pid = String(m.id || dirName);
  if (isPluginDisabled(disabled, pid, dirName)) {
    console.log(`[plugins] 已按 config/plugins.json 禁用: ${pid}`);
    return null;
  }
  // PL1：provides 必选且角色合法，否则整体不注册（并打印可读原因，避免静默消失）
  const badProvides = validateProvides(m.provides);
  if (badProvides) {
    console.warn(`[plugins] ${pid} 注册失败：${badProvides}`);
    return null;
  }
  return {
    id: pid,
    name: String(m.name || dirName),
    label: m.label ? String(m.label) : null,
    /** 插件角色（契约 §一）：决定核心把它挂到哪个注册表 */
    provides: m.provides.map(String),
    version: m.version === undefined ? null : m.version,
    assets: Array.isArray(m.assets) ? m.assets.map(String) : [],
    fileKinds: Array.isArray(m.fileKinds) ? m.fileKinds.map(String) : [],
    produces: m.produces && typeof m.produces === 'object' ? m.produces : null,
    errorCodes: Array.isArray(m.errorCodes) ? m.errorCodes.map(String) : [],
    files: files.map((f) => `${dirName}/${f}`),
    manifest: true,
  };
}

/**
 * 扫描展示类型插件目录，返回**按序加载**的插件清单。
 *
 * **只支持一种落盘形态**：`plugins/<id>/plugin.json` 清单
 *   （`{ id, name, provides[], entry, files[] }`，files 里的 js 按数组顺序加载；
 *     未写 files 时用 entry；都没有则退回 index.js）。
 *
 * 历史上的另外两种形态——目录内顶层 js（无清单）、平铺 `<name>.js`——**不再注册**：
 *   它们无法声明 `provides`，而角色是"这个插件能干什么"的唯一声明（契约 插件契约 §二 / PL1）；
 *   缺了它，插件就是一个"注册了但没人认识"的黑盒，静默消失最难查。
 *   所以这两种形态一律跳过，并打印可读原因（不是静默忽略）。
 *
 * 只做**只读发现**：不解析 js 内容、不校验语法（加载与隔离由前端 plugin-host.js 负责）。
 * files 用相对 pluginsDir 的 POSIX 风格路径（前端拼 /plugins/<rel>）。
 *
 * @returns {Array<{id:string,name:string,files:string[],manifest:boolean}>}
 */
export function readPlugins(pluginsDir, switchFile) {
  const out = [];
  const disabled = readPluginSwitch(switchFile).disabled;
  if (!fs.existsSync(pluginsDir) || !fs.statSync(pluginsDir).isDirectory()) return out;
  let entries = [];
  try { entries = fs.readdirSync(pluginsDir, { withFileTypes: true }); } catch { return out; }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const isFile = (rel) => {
    const abs = path.join(pluginsDir, rel);
    try { return fs.existsSync(abs) && fs.statSync(abs).isFile(); } catch { return false; }
  };

  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isFile() && e.name.toLowerCase().endsWith('.js')) {
      const id = e.name.replace(/\.js$/i, '');
      if (isPluginDisabled(disabled, id, id)) { console.log(`[plugins] 已按 config/plugins.json 禁用: ${id}`); continue; }
      // 平铺单文件没有清单 ⇒ provides 无从声明 ⇒ 按契约 PL1 不注册（日志说清，别静默消失）
      console.warn(`[plugins] ${id} 未注册：缺少 plugin.json，provides 无法声明（合法角色：${PLUGIN_ROLES.join(' / ')}）`);
      continue;
    }
    if (!e.isDirectory()) continue;

    const manifestPath = path.join(pluginsDir, e.name, 'plugin.json');
    if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
      const entry = readPluginManifest(pluginsDir, e.name, isFile, disabled);
      if (entry) out.push(entry);
      continue;
    }

    let inner = [];
    try { inner = fs.readdirSync(path.join(pluginsDir, e.name), { withFileTypes: true }); } catch { continue; }
    const js = inner.filter((x) => x.isFile() && x.name.toLowerCase().endsWith('.js')).map((x) => x.name).sort();
    if (!js.length) continue;
    if (isPluginDisabled(disabled, e.name, e.name)) { console.log(`[plugins] 已按 config/plugins.json 禁用: ${e.name}`); continue; }
    // 目录里没有 plugin.json ⇒ 同上，provides 无从声明 ⇒ 不注册
    console.warn(`[plugins] ${e.name} 未注册：目录内缺少 plugin.json，provides 无法声明（合法角色：${PLUGIN_ROLES.join(' / ')}）`);
    continue;
  }
  return out;
}

/**
 * 读插件开关配置（config/plugins.json，JSONC）。
 *
 * 为什么用配置文件而不是 env：这是**结构性列表**（可增删多个条目），按项目约定
 *   结构化配置一律 JSON 作唯一权威，env 只承担部署差异单值。
 * 容错：文件缺失、解析失败、字段类型不对 → 一律当作「全部启用」并告警，不因配置写错让插件静默消失。
 *
 * @returns {{disabled: Set<string>}}
 */
export function readPluginSwitch(switchFile) {
  const empty = { disabled: new Set() };
  if (!fs.existsSync(switchFile)) return empty;
  let cfg = null;
  try { cfg = parseJsonc(fs.readFileSync(switchFile, 'utf8'), 'config/plugins.json'); }
  catch (err) { console.warn(`[plugins] config/plugins.json 解析失败，按全部启用处理: ${err.message}`); return empty; }
  const list = Array.isArray(cfg && cfg.disabled) ? cfg.disabled : [];
  const disabled = new Set(list.map((x) => String(x).trim()).filter(Boolean));
  if (disabled.size) console.log(`[plugins] config/plugins.json 禁用插件 ${disabled.size} 个: ${[...disabled].join(', ')}`);
  return { disabled };
}

/** 插件是否被禁用：id 与目录名任一命中即禁用（清单里的 id 可能与目录名不同）。 */
export function isPluginDisabled(disabled, id, dirName) {
  return disabled.has(String(id)) || (dirName ? disabled.has(String(dirName)) : false);
}

/**
 * 当前**启用**的插件声明的 fileKinds 集合（如 'bundle' = Unity 资源包单文件）。
 *
 * 用途：资源条目的可见性由「有没有插件能读它」决定 —— 插件未启用时，它提供的能力整体消失，
 *   角色库里就不该再出现这类条目（条目本身是插件能力的一部分）。
 *
 * @returns {Set<string>}
 */
export function enabledPluginKinds(pluginsDir, switchFile) {
  const kinds = new Set();
  for (const p of readPlugins(pluginsDir, switchFile)) {
    for (const k of (Array.isArray(p.fileKinds) ? p.fileKinds : [])) kinds.add(String(k));
  }
  return kinds;
}

/**
 * 按**魔数**识别资源包容器（kind:"bundle" 的资源根用）。
 *
 * 为什么不能按扩展名：碧蓝航线的 Live2D 资源包就是**无扩展名**的单文件（实测样本 `adaerbote_3`），
 *   按扩展名过滤会一个都列不出来。容器标识在文件头，读前 8 字节即可判定，成本可忽略。
 *
 * @param {string} abs 文件绝对路径
 * @returns {'unityfs'|null} 'unityfs' = UnityFS AssetBundle（Unity 5+ 的打包格式）
 */
export function detectBundleContainer(abs) {
  let fd = null;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(8);
    const n = fs.readSync(fd, buf, 0, 8, 0);
    if (n < 8) return null;
    if (buf.toString('latin1') === 'UnityFS\0') return 'unityfs';
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
  }
}

/**
 * 绑定型适配器：把插件目录与开关文件固定，调用方无需重复传参。
 * @param {{pluginsDir: string, pluginSwitchFile: string}} p
 */
export function createPlugins(p) {
  return {
    readPlugins: () => readPlugins(p.pluginsDir, p.pluginSwitchFile),
    /**
     * 角色注册表：角色 → 插件 id 列表（契约 §一 五类角色）。
     * 只列**已注册成功**的插件（PL1 校验通过的），所以这里是"核心真正认得的角色面"。
     * @returns {Record<string, string[]>}
     */
    roleIndex: () => buildRoleIndex(readPlugins(p.pluginsDir, p.pluginSwitchFile)),
    readPluginSwitch: () => readPluginSwitch(p.pluginSwitchFile),
    isPluginDisabled,
    enabledPluginKinds: () => enabledPluginKinds(p.pluginsDir, p.pluginSwitchFile),
    detectBundleContainer,
  };
}

/**
 * 由插件清单构建角色注册表（角色 → 插件 id 列表）。
 * @param {Array<{id: string, provides?: string[]}>} list
 * @returns {Record<string, string[]>} 五个角色键都齐全（无插件时为空数组）
 */
export function buildRoleIndex(list) {
  const index = {};
  for (const role of PLUGIN_ROLES) index[role] = [];
  for (const p of list || []) {
    for (const role of (p && p.provides) || []) {
      if (index[role] && !index[role].includes(p.id)) index[role].push(p.id);
    }
  }
  return index;
}
