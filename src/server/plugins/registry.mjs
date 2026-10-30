// plugins.mjs —— 展示类型插件的发现与开关（config/plugins.json）
//
// 插件是「放目录即加能力」：这里只负责把 plugins/<id>/plugin.json 读成清单，
// 并回答「某个 fileKind 当前有没有启用的插件」。
import fs from 'node:fs';
import { createLogger } from '../core/log.mjs';
import path from 'node:path';
import { parseJsonc } from '../../../tool/parse-jsonc.mjs';

/**
 * 插件角色集合（契约 插件契约 §一）：五类角色，**别处不得自创角色名**。
 * 一个插件可以同时担任多个角色（provides 是数组）。
 */
export const PLUGIN_ROLES = ['asset-provider', 'renderer', 'editor', 'exporter', 'panel'];

// ---------------- 契约 §九（受限扩展点 effects / controls）的共用校验 ----------------
// 这份实现同时被「运行期注册」（本文件 readPluginManifest）与「离线门禁」（tool/check-plugin.mjs）
//   调用 —— 契约 §9.6 要求两处同口径，各写一遍必然漂移。

/** 效果 id 命名规则（契约 §9.1：只允许 [a-z][a-z0-9_-]*） */
const EFFECT_ID_RE = /^[a-z][a-z0-9_-]*$/;
/** 参数键的 uniform 命名空间前缀（避免与内建着色器变量撞名，契约 §9.1） */
const EFFECT_PARAM_KEY_PREFIX = 'u_';
/** 当前允许的参数类型（契约 §9.1：先只开 float） */
const EFFECT_PARAM_TYPES = ['float'];
/** 声明了 effects 就必须在插件脚本里找得到的注册调用（契约 §9.6） */
const EFFECT_REGISTER_CALL = 'registerEffect(';

/**
 * 校验单个效果的 params 数组。
 * @param {unknown} params 原始 params
 * @param {string} where 报错前缀（如 `effects[0]`）
 * @returns {string|null} 错误文本；null 表示通过
 */
function validateEffectParams(params, where) {
  if (params !== undefined && !Array.isArray(params)) return `${where}.params 必须是数组`;
  const list = Array.isArray(params) ? params : [];
  for (let i = 0; i < list.length; i += 1) {
    const param = list[i];
    const paramWhere = `${where}.params[${i}]`;
    if (!param || typeof param !== 'object' || Array.isArray(param)) return `${paramWhere} 必须是对象`;
    const key = String(param.key || '');
    if (!key) return `${paramWhere}.key 必填`;
    if (!key.startsWith(EFFECT_PARAM_KEY_PREFIX)) {
      return `${paramWhere}.key「${key}」必须以 ${EFFECT_PARAM_KEY_PREFIX} 开头（uniform 命名空间）`;
    }
    if (!EFFECT_PARAM_TYPES.includes(param.type)) {
      return `${paramWhere}.type 非法：${param.type}（当前只允许 ${EFFECT_PARAM_TYPES.join(' / ')}）`;
    }
    for (const field of ['min', 'max', 'default']) {
      if (typeof param[field] !== 'number' || !Number.isFinite(param[field])) {
        return `${paramWhere}.${field} 必填且必须是有限数字`;
      }
    }
    if (!(param.min < param.max)) return `${paramWhere} 要求 min < max（当前 ${param.min} / ${param.max}）`;
    if (param.default < param.min || param.default > param.max) {
      return `${paramWhere}.default=${param.default} 越界（应在 [${param.min}, ${param.max}]）`;
    }
  }
  return null;
}

/**
 * 校验 plugin.json 的 `effects[]`（契约 §9.1 / §9.6）。
 *
 * 三条容易漏的语义：
 *   · 声明了 panel 角色却没有任何 effects ⇒ 报错（控件必须对应一个效果，不许出现"点了没反应"的控件）
 *   · 声明了 effects，但脚本里 grep 不到 `registerEffect(` ⇒ 报错（不是静默忽略）
 *   · id 必须**跨插件全局唯一** —— 因此 `seenIds` 由调用方跨插件持有并传进来
 *
 * @param {unknown} effects 清单里的 effects（可缺省）
 * @param {{provides?: string[], scriptText?: string|null, seenIds?: Set<string>|null}} opts
 *   scriptText 为 null 表示"不检查脚本调用"（离线门禁里没读源码时用）
 * @returns {string|null} 错误文本；null 表示通过
 */
export function validateEffects(effects, opts = {}) {
  const { provides = [], scriptText = null, seenIds = null } = opts;
  if (effects !== undefined && !Array.isArray(effects)) return 'effects 必须是数组';
  const list = Array.isArray(effects) ? effects : [];
  const hasPanelRole = Array.isArray(provides) && provides.includes('panel');
  if (!list.length) {
    return hasPanelRole ? '声明了 panel 角色却没有 effects：控件必须对应一个效果（契约 §9.6）' : null;
  }
  const localIds = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const effect = list[i];
    const where = `effects[${i}]`;
    if (!effect || typeof effect !== 'object' || Array.isArray(effect)) return `${where} 必须是对象`;
    const id = String(effect.id || '');
    if (!id) return `${where}.id 必填`;
    if (!EFFECT_ID_RE.test(id)) return `${where}.id「${id}」命名非法（只允许 [a-z][a-z0-9_-]*）`;
    if (localIds.has(id)) return `${where}.id「${id}」在同一插件内重复`;
    if (seenIds && seenIds.has(id)) return `${where}.id「${id}」与其他插件的效果 id 重复（必须跨插件唯一）`;
    if (typeof effect.label !== 'string' || !effect.label.trim()) return `${where}.label 必填且非空字符串`;
    const paramsErr = validateEffectParams(effect.params, where);
    if (paramsErr) return paramsErr;
    // 全部通过后再登记，避免"半合法"的 id 污染跨插件唯一性判断
    localIds.add(id);
    if (seenIds) seenIds.add(id);
  }
  // 形状全通过后再查脚本调用：否则"脚本缺注册调用"会掩盖真正的形状错误（id/params 才是首要原因）
  if (scriptText !== null && !stripComments(String(scriptText)).includes(EFFECT_REGISTER_CALL)) {
    return `声明了 effects 但插件脚本里没有 ${EFFECT_REGISTER_CALL} 调用（契约 §9.6）`;
  }
  return null;
}

/**
 * 去掉 JS 注释后再判"有没有调用某函数"。
 * 为什么必须剥：注释里写一句「这里要调 registerEffect(」就会让朴素 includes 假通过 ——
 *   本仓库踩到过（样本的说明注释直接让一份非法清单过检）。只剥注释，不做完整语法解析。
 * @param {string} code 源码文本
 * @returns {string} 去掉注释后的文本
 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

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
/** 服务端日志（统一形状 {at,level,tag,msg,detail}） */
const log = createLogger('plugins');

/**
 * 归一化清单里的 runtime 字段。
 * 缺省 "node" = 历史行为（vm 沙盒里按 files[] 顺序跑 classic script）；
 * "exec" = 插件目录里有一个可执行文件，宿主 spawn 它并用帧协议通信（**没有 js 要加载**）。
 * @param {unknown} raw 清单里的原始值
 * @returns {string}
 */
function normalizeRuntime(raw) {
  if (raw === undefined || raw === null || raw === '') return 'node';
  return String(raw);
}

/**
 * 按 runtime 算出"这个插件要加载哪些 js 文件"，并做对应的存在性校验。
 *
 * 为什么必须分流：node 插件靠 files[] 顺序加载脚本，而 exec 插件根本没有 js
 *   （它的入口是 entry 指向的可执行文件）。若不分流，兜底逻辑会把 entry（如 bin/unpack）
 *   当成 js 读进沙盒，用户看到的是一堆看不懂的语法错误而不是"清单写错了"。
 * @param {{m: object, runtime: string, dirName: string, isFile: Function}} p
 * @returns {{ok: true, files: string[]} | {ok: false, reason: string}}
 */
function resolveLoadFiles({ m, runtime, dirName, isFile }) {
  if (runtime === 'exec') {
    if (!m.entry) return { ok: false, reason: 'runtime:"exec" 的插件缺 entry（相对插件目录的可执行路径），跳过' };
    return { ok: true, files: [] };
  }
  const declared = Array.isArray(m.files) && m.files.length ? m.files : (m.entry ? [m.entry] : ['index.js']);
  const files = declared.map((f) => String(f).replace(/^\.?\//, '')).filter((f) => isFile(`${dirName}/${f}`));
  if (!files.length) return { ok: false, reason: '清单里没有任何存在的 js，跳过' };
  return { ok: true, files };
}

export function readPluginManifest(pluginsDir, dirName, isFile, disabled, seenEffectIds = null) {
  let m = null;
  try {
    m = JSON.parse(fs.readFileSync(path.join(pluginsDir, dirName, 'plugin.json'), 'utf8'));
  } catch (err) {
    log.warn('plugin.json 解析失败，跳过该插件', { plugin: dirName, err: err.message });
    return null;
  }
  const runtime = normalizeRuntime(m.runtime);
  // 按 runtime 决定"要加载哪些 js"（exec 插件不加载任何 js），并做对应的存在性校验
  const filesResult = resolveLoadFiles({ m, runtime, dirName, isFile });
  if (!filesResult.ok) {
    log.warn(filesResult.reason, { plugin: dirName });
    return null;
  }
  const files = filesResult.files;
  const pid = String(m.id || dirName);
  if (isPluginDisabled(disabled, pid, dirName)) {
    log.info('已按 config/plugins.json 禁用', { plugin: pid });
    return null;
  }
  // PL1：provides 必选且角色合法，否则整体不注册（并打印可读原因，避免静默消失）
  const badProvides = validateProvides(m.provides);
  if (badProvides) {
    log.warn('注册失败', { plugin: pid, reason: badProvides });
    return null;
  }
  // 契约 §九：effects 与 provides 的 panel 角色互相约束，非法就不进入运行期（不静默忽略）
  //   只在**声明了 effects** 时才读脚本内容做 grep（无 effects 的插件零额外 I/O）
  let scriptText = null;
  if (Array.isArray(m.effects) && m.effects.length) {
    try {
      scriptText = files.map((f) => fs.readFileSync(path.join(pluginsDir, dirName, f), 'utf8')).join('\n');
    } catch (e) {
      log.warn('效果校验：读取脚本失败，按"找不到 registerEffect(" 处理', { plugin: pid, err: e.message });
      scriptText = '';
    }
  }
  const badEffects = validateEffects(m.effects, { provides: m.provides, scriptText, seenIds: seenEffectIds });
  if (badEffects) {
    log.warn('注册失败', { plugin: pid, reason: badEffects });
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
    /**
     * 展示色（插件自声明，如 "#2b6cb0"）：列表徽标用它上色，前端不再按 kind 硬编码。
     * 只接受 #rgb / #rrggbb / #rrggbbaa，非法值一律按"未声明"处理（给 null ⇒ 前端走中性色），
     *   绝不替插件猜一个颜色 —— 猜错就等于用颜色撒谎。
     */
    accent: /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(m.accent || '')) ? String(m.accent) : null,
    /**
     * 匹配优先级（数字，越大越靠前）：**只用于展示归属的排序**，不参与装载决策。
     * 多个插件都声明能读同一类资源（fileKinds 都是 bundle）时，解包前无法判定谁对，
     *   于是"已解包过的包以实际命中的插件为准，没解包过的一律中性色"，
     *   优先级只决定候选列表在提示里的先后。
     */
    matchPriority: Number.isFinite(Number(m.matchPriority)) ? Number(m.matchPriority) : 0,
    produces: m.produces && typeof m.produces === 'object' ? m.produces : null,
    errorCodes: Array.isArray(m.errorCodes) ? m.errorCodes.map(String) : [],
    files: files.map((f) => `${dirName}/${f}`),
    /** 运行时（"node" | "exec"，缺省 node）：决定宿主用哪个适配器装载本插件 */
    runtime,
    /** exec 运行时的可执行入口（相对插件目录）；node 运行时为 null（入口由 files[] 末项决定） */
    entry: m.entry ? String(m.entry) : null,
    /** exec 运行时的帧协议版本；node 运行时为 null */
    frameProtocol: m.frameProtocol === undefined || m.frameProtocol === null ? null : Number(m.frameProtocol),
    /** 受限扩展点（契约 §九）：空数组表示"没声明"，前端据此建能力键白名单 */
    effects: Array.isArray(m.effects) ? m.effects : [],
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

  // 效果 id 必须跨插件全局唯一（契约 §9.1）⇒ 整个扫描共享一个已见集合
  const seenEffectIds = new Set();

  const isFile = (rel) => {
    const abs = path.join(pluginsDir, rel);
    try { return fs.existsSync(abs) && fs.statSync(abs).isFile(); } catch { return false; }
  };

  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isFile() && e.name.toLowerCase().endsWith('.js')) {
      const id = e.name.replace(/\.js$/i, '');
      if (isPluginDisabled(disabled, id, id)) { log.info('已按 config/plugins.json 禁用', { plugin: id }); continue; }
      // 平铺单文件没有清单 ⇒ provides 无从声明 ⇒ 按契约 PL1 不注册（日志说清，别静默消失）
      log.warn('未注册：缺少 plugin.json，provides 无法声明', { plugin: id, roles: PLUGIN_ROLES.join(' / ') });
      continue;
    }
    if (!e.isDirectory()) continue;

    const manifestPath = path.join(pluginsDir, e.name, 'plugin.json');
    if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
      const entry = readPluginManifest(pluginsDir, e.name, isFile, disabled, seenEffectIds);
      if (entry) out.push(entry);
      continue;
    }

    let inner = [];
    try { inner = fs.readdirSync(path.join(pluginsDir, e.name), { withFileTypes: true }); } catch { continue; }
    const js = inner.filter((x) => x.isFile() && x.name.toLowerCase().endsWith('.js')).map((x) => x.name).sort();
    if (!js.length) continue;
    if (isPluginDisabled(disabled, e.name, e.name)) { log.info('已按 config/plugins.json 禁用', { plugin: e.name }); continue; }
    // 目录里没有 plugin.json ⇒ 同上，provides 无从声明 ⇒ 不注册
    log.warn('未注册：目录内缺少 plugin.json，provides 无法声明', { plugin: e.name, roles: PLUGIN_ROLES.join(' / ') });
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
  catch (err) { log.warn('config/plugins.json 解析失败，按全部启用处理', { err: err.message }); return empty; }
  const list = Array.isArray(cfg && cfg.disabled) ? cfg.disabled : [];
  const disabled = new Set(list.map((x) => String(x).trim()).filter(Boolean));
  if (disabled.size) log.info('config/plugins.json 禁用插件', { count: disabled.size, plugins: [...disabled] });
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
