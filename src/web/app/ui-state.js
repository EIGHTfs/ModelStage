// app/ui-state.js —— UI 状态的单一真相源（S1）
//
// 契约：docs/契约/状态.md
//   R1 单一真相源：UI 显示值 == 生效值 == 工厂里的值（禁止控件自己留一份显示副本）
//   R2 读回早于首次渲染：loadAll() 必须在第一次面板 DOM 构建之前完成（纯内存，不碰 DOM）
//   R3 apply 与 render 分离：apply=下发给引擎/渲染器（幂等）；render=更新已存在 DOM 的显示态（可重放）
//   §三 任何面板重建完成后必须派发 panel:rebuilt + applyAll({render:true})（汇聚在 rebuildPanelFor）
//   §四 能力不支持 ⇒ 保留值、不 apply、不 render，切回支持的面再生效（禁回落默认）
//   §五 默认值唯一来源 = schema.js；本模块只派生、不另写一份，并提供启动一致性断言
//
// 为什么要有这一层（本次 bug 的直接教训）：
//   旧实现里"显示态"只能靠一次性命令（panel.setChecked / setValue）同步，
//   面板 DOM 一旦重建（rebuildPanelFor），那些一次性同步就丢了，
//   于是出现"引擎在循环、开关显示关"。差的就是"按当前生效值重新渲染"这个能力。
//
// 依赖方向（**单向，防环**）：本模块只依赖 schema/context/view-settings；
//   "怎么 apply / 怎么 render" 由 panel-settings 在装配时 registerAppliers 注入（本模块不 import 业务模块）。

import { PANEL_GROUPS } from '../panel/schema.js';
import { state } from './context.js';
import { readViewSettings, saveViewSettings } from './view-settings.js';
import { stageLog } from './status.js';

/** 写盘去抖（ms）：滑块的连续事件会产生大量写，攒一帧以上再落盘 */
const WRITE_DEBOUNCE_MS = 150;

/**
 * 从 schema 派生"可持久化的面板控件"清单（默认值的唯一来源）。
 *
 * 只收录真正"有状态"的控件：
 *   · 排除 kind==='actions'（一次性按钮：导出/导入/恢复默认，存了就会在启动时重放）
 *   · 排除 kind==='readonly' / 'dynamic-list'（前者是显示值，后者内容由模型决定）
 * 默认值取 schema 的 defaultValue（有取值域的控件）或 defaultOn（开关）。
 */
export const SPEC = (() => {
  const out = [];
  for (const group of PANEL_GROUPS) {
    for (const ctl of (group && group.controls) || []) {
      if (!ctl || !ctl.id) continue;
      if (ctl.kind === 'actions' || ctl.kind === 'readonly' || ctl.kind === 'dynamic-list') continue;
      // 皮肤不持久化（与动作列表同一条思路）：它的取值域由**当前模型**决定，
      //   跨模型记一个皮肤名毫无意义（A 模型的 "00" 到 B 模型可能根本不存在），
      //   而记住上一个模型的皮肤还会让"装载后自动挑一个能画出东西的皮肤"失效 ——
      //   表现为刷新后又回到空白画面。每次装载重新挑最稳。
      if (ctl.capabilityKey === 'skin') continue;
      // 开关即使没写 defaultOn 也算"有状态"：DOM 默认就是关（false）。
      //   `ctl-anim-loop` 正是这种写法——漏了它，本 bug 的控件根本进不了工厂。
      const isSwitch = ctl.kind === 'switch';
      const hasValue = ctl.defaultValue !== undefined;
      if (!hasValue && !isSwitch) continue;
      out.push({
        id: String(ctl.id),
        kind: ctl.kind,
        label: ctl.label || ctl.id,
        capabilityKey: ctl.capabilityKey || null,
        // 取值域：分段控件用 ctl.values，下拉/胶囊常用 options:[{text,value}] ⇒ 两种都要认，
        //   否则"非法值"校验会被静默跳过（实测：塞 uiTheme='nope' 竟然被接受）。
        values: Array.isArray(ctl.values)
          ? ctl.values.map(String)
          : (Array.isArray(ctl.options)
            ? ctl.options.map((o) => (o && typeof o === 'object' ? String(o.value) : String(o)))
            : null),
        defaultValue: hasValue ? ctl.defaultValue : ctl.defaultOn === true,
        // 存储槽：主题/背景模式的值一直存在顶层（uiTheme / background.mode），
        //   这里只**读**它们做显示真相，不再往 panel 段写一份（否则就是双份存储）
        store: ctl.id === 'ctl-theme' ? 'theme' : (ctl.id === 'ctl-bg-mode' ? 'bgMode' : 'panel'),
      });
    }
  }
  return out;
})();

/**
 * 动态补登记面板控件（插件在运行期提交的控件走这里）。
 *
 * 为什么必须登记进 SPEC 而不是另开一条存取路径：
 *   `set()` 对**未登记**的 id 会走 `defaultOf()` ⇒ 拿到 undefined ⇒ 值根本存不住，
 *   而且不报错（表现为"选了刷新就回默认"）。所以插件控件必须进同一份 SPEC，
 *   才能复用 loadAll / applyAll / set / commit / flush 全套通道，不产生第二份真相。
 *
 * 幂等：已存在的 id 不覆盖（内置控件优先，插件不能顶掉内置项）。
 * @param {Array<object>} ctls schema 形态的控件声明（与 PANEL_GROUPS 里的一致）
 * @returns {number} 实际新增条数
 */
export function registerSpecItems(ctls) {
  let added = 0;
  /** 拒绝登记的表单项（含原因）：让"为什么没被工厂接管"当场可见 */
  const skipped = [];
  for (const ctl of ctls || []) {
    const id = String((ctl && ctl.id) || '');
    if (!id || byId.has(id)) continue;
    const isSwitch = ctl.kind === 'toggle' || ctl.kind === 'switch';
    const hasValue = ctl.defaultValue !== undefined;
    const firstOption = Array.isArray(ctl.options) && ctl.options.length ? ctl.options[0] : undefined;
    const item = {
      id,
      kind: ctl.kind,
      label: ctl.label || id,
      capabilityKey: ctl.capabilityKey || null,
      values: Array.isArray(ctl.values)
        ? ctl.values.map(String)
        : (Array.isArray(ctl.options)
          ? ctl.options.map((o) => (o && typeof o === 'object' ? String(o.value) : String(o)))
          : null),
      // 分段控件没写 defaultValue 时默认取第一项（与"第一个就是关/默认档"的既有惯例一致）
      defaultValue: hasValue ? ctl.defaultValue : (isSwitch ? (ctl.defaultOn === true) : firstOption),
      store: 'panel',
    };
    // 强制断言（设计 §1.5「默认值唯一来源」）：进工厂的控件必须能算出默认值。
    //   没有默认值 ⇒「恢复默认」会漏掉它、spec 断言也没法比对 ⇒ 宁可拒绝登记并在
    //   skipped 里报出来（让"为什么这个控件没被工厂接管"当场可见，而不是以后靠猜）。
    if (item.defaultValue === undefined) {
      skipped.push({ id, reason: '无法确定默认值（档位控件缺 options / 开关缺 defaultOn）' });
      continue;
    }
    SPEC.push(item);
    byId.set(id, item);
    added += 1;
  }
  return { added, skipped };
}

/**
 * 清掉存档里"确认已无主"的键（插件被真删掉之后留下的残留）。
 *
 * 什么时候才敢调：**插件声明全部交完之后**（`spineviewer:plugins-loaded`）。
 *   在那之前 SPEC 里可能只是"还没来得及登记"，此时清理会误删用户已经设好的值。
 *   调用时机由 panel-settings 保证（先 rebuildPanelFor 登记 SPEC，再调本函数）。
 *
 * 判据就是 SPEC：它是"当前所有有效控件"的唯一清单（内置 + 已加载插件）。
 *   不在 SPEC 里的面板键，说明对应控件已经不存在了 ⇒ 值留着只会变成永远读不到的垃圾。
 * @returns {string[]} 被清掉的键
 */
export function pruneUnregistered() {
  let saved = {};
  try { saved = (readViewSettings() || {}).panel || {}; } catch { return []; }
  const orphans = Object.keys(saved).filter((key) => !byId.has(key));
  if (!orphans.length) return [];
  const next = { ...saved };
  for (const key of orphans) {
    delete next[key];
    values.delete(key);
  }
  try { saveViewSettings({ panel: next }); } catch { /* 存储不可用：内存里也已删掉 */ }
  return orphans;
}

/** id → SPEC 声明 */
const byId = new Map(SPEC.map((it) => [it.id, it]));

/**
 * 更新某个控件的**取值域**（运行时动态选项用）。
 *
 * 为什么必须有它：SPEC 的取值域是从 schema 的静态 `options` 推出来的，而有些控件的选项
 *   是**装载模型后才填**的（皮肤列表：schema 里只声明了 `default` 占位，真实皮肤名
 *   由 `panel.setOptions` 在运行时补进来）。
 *   不把动态选项同步进域 ⇒ `set()` 的校验判它"非法"⇒ 回落默认值 ⇒
 *   表现成"点了没反应"（实测：点皮肤 `00` 会切回 `default`，且连高亮都不动）。
 * @param {string} id 控件 id
 * @param {string[]} list 新的候选值（字符串化后保存）
 * @returns {boolean} 该控件是否已登记
 */
export function setDomain(id, list) {
  const key = String(id);
  const it = byId.get(key);
  if (!it) return false;
  it.values = Array.isArray(list) ? list.map(String) : null;
  return true;
}

/** 当前值（唯一真相源；启动时由 loadAll 填充，用户改动由 set 更新） */
const values = new Map();

/** id → {apply, render} 应用器（由 panel-settings 装配时注入） */
const appliers = new Map();

/** 落盘调度 */
let writeTimer = 0;
/** 是否已成功读过一次（写入前的安全闸） */
let loadedOnce = false;
/** 最近一次被校验拒绝的项（诊断用：脏数据回落不该静默） */
const rejected = [];
/**
 * 启动阶段"不参与 applyAll"的项（STARTUP_SKIP：如 MSAA，重建渲染上下文要 2~5 秒）。
 * 它们的**值照常保存**，只是本轮不下发；面板重建时的 applyAll 也会跳过，行为与旧实现一致。
 */
let applySkip = new Set();

/** 设置 applyAll 的跳过集合（启动时序用；传空集恢复全量） */
export function setApplySkip(ids) {
  applySkip = ids instanceof Set ? new Set([...ids].map(String)) : new Set([...(ids || [])].map(String));
}

/** 读整个 debug 段（内部用） */
function debugSection() {
  try {
    const root = readViewSettings() || {};
    return (root && typeof root.debug === 'object' && root.debug) ? root.debug : {};
  } catch { return {}; }
}

/**
 * 面板位置（收起态胶囊锚点）。
 * @returns {{left:number, top:number}|null} 无记录/损坏返回 null（调用方用 CSS 默认位置）
 */
export function getPanelPos() {
  const v = debugSection().panelPos;
  if (!v || !Number.isFinite(v.left) || !Number.isFinite(v.top)) return null;
  return { left: v.left, top: v.top };
}

/** 保存面板位置（走同一条落盘路径） */
export function setPanelPos(pos) {
  if (!pos || !Number.isFinite(pos.left) || !Number.isFinite(pos.top)) return false;
  const next = { ...debugSection(), panelPos: { left: Math.round(pos.left), top: Math.round(pos.top) } };
  try { saveViewSettings({ debug: next }); return true; } catch { return false; }
}

/** 调试日志四档（未存过 ⇒ null，调用方用默认三档） */
export function getLogLevels() {
  const v = debugSection().logLevels;
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null;
}

/** 保存四档选择 */
export function setLogLevels(levels) {
  const arr = Array.isArray(levels) ? levels.filter((x) => typeof x === 'string') : [];
  const next = { ...debugSection(), logLevels: arr };
  try { saveViewSettings({ debug: next }); return true; } catch { return false; }
}


// ---------------------------------------------------------------- 布局 / 浮层收起 / 名册 三个独立槽位
//
// 三者各自独立存储（一个坏不连累另一个）：
//   layout  → 左右栏显隐（布局偏好，与模型无关）
//   debug   → 浮层收起 + 位置 + 四档
//   roster  → 名册展开态与上次选中（**键名沿用历史命名，是当前唯一键**）

/** 布局槽默认值：无记录**一律全展开**（把"没有值"当成"用户选了收起"会让新用户以为界面坏了） */
const LAYOUT_DEFAULT = { leftVisible: true, rightVisible: true };

/**
 * 读左右栏显隐偏好。
 * @returns {{leftVisible:boolean, rightVisible:boolean}} 无记录/损坏 ⇒ 全展开
 */
export function getLayout() {
  let v = null;
  try {
    const root = readViewSettings() || {};
    v = root.layout && typeof root.layout === 'object' ? root.layout : null;
  } catch { v = null; }
  if (!v) return { ...LAYOUT_DEFAULT };
  return {
    leftVisible: typeof v.leftVisible === 'boolean' ? v.leftVisible : LAYOUT_DEFAULT.leftVisible,
    rightVisible: typeof v.rightVisible === 'boolean' ? v.rightVisible : LAYOUT_DEFAULT.rightVisible,
  };
}

/**
 * 保存左右栏显隐（可只传一项，另一项沿用当前值）。
 * @param {{leftVisible?:boolean, rightVisible?:boolean}} patch
 * @returns {{leftVisible:boolean, rightVisible:boolean}} 保存后的完整状态
 */
export function setLayout(patch) {
  const next = { ...getLayout(), ...(patch || {}) };
  try { saveViewSettings({ layout: next }); } catch { /* 存储不可用就只在当前页面存活期内生效 */ }
  return next;
}

/**
 * 调试浮层是否收起。
 * @returns {boolean} 无记录 ⇒ false（默认展开）
 */
export function getDebugCollapsed() {
  const v = debugSection().collapsed;
  return typeof v === 'boolean' ? v : false;
}

/** 保存浮层收起状态（与位置/四档共用 debug 段，互不覆盖） */
export function setDebugCollapsed(collapsed) {
  const next = { ...debugSection(), collapsed: !!collapsed };
  try { saveViewSettings({ debug: next }); return true; } catch { return false; }
}

// ---------------------------------------------------------------- 名册键代理（结构不动）
/**
 * 右栏背景「二级列表」当前展开的组（'solid' | 'custom' | ''）。
 *
 * 为什么要持久化：刷新后按钮状态能回填（档位由 ctl-bg-mode 的工厂值驱动），
 *   但"展开哪一组"原来只是内存变量 ⇒ 刷新后列表收起了，用户以为丢了状态。
 * @returns {'solid'|'custom'|''} 无记录/非法值 ⇒ ''（都不展开）
 */
export function getBgOpen() {
  let v = '';
  try {
    const root = readViewSettings() || {};
    v = typeof root.bgOpen === 'string' ? root.bgOpen : '';
  } catch { v = ''; }
  return v === 'solid' || v === 'custom' ? v : '';
}

/** 保存"展开哪一组"（'' = 都收起） */
export function setBgOpen(group) {
  const g = group === 'solid' || group === 'custom' ? group : '';
  try { saveViewSettings({ bgOpen: g }); } catch { /* 存储不可用就只在当前页面生效 */ }
  return g;
}

/** 名册状态存储键（全站唯一名册状态键） */
export const TREE_STATE_KEY = 'modelstage.tree-state.v1';


/**
 * 读名册状态（原样返回解析后的对象；缺省/损坏返回 {}）。
 * @returns {object}
 */
export function getTreeState() {
  try {
    const raw = localStorage.getItem(TREE_STATE_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

/**
 * 写名册状态（原样写入调用方给的对象，不做字段增删）。
 * @param {object} obj 调用方构造的完整对象
 * @returns {boolean} 是否写入成功
 */
export function setTreeState(obj) {
  if (!obj || typeof obj !== 'object') return false;
  try { localStorage.setItem(TREE_STATE_KEY, JSON.stringify(obj)); return true; } catch { return false; }
}

/** 某控件的默认值（SPEC 派生，等于 schema 的默认） */
export function defaultOf(id) {
  const it = byId.get(String(id));
  return it ? it.defaultValue : undefined;
}

/** 当前值（未 set 过且未 load 过 ⇒ 返回 undefined，调用方用 defaultOf 兜底） */
export function getValue(id) {
  const key = String(id);
  if (values.has(key)) return values.get(key);
  return defaultOf(key);
}

/** 全量快照（供导出/断言） */
export function getAll() {
  const out = {};
  for (const it of SPEC) out[it.id] = getValue(it.id);
  return out;
}

/** 装配注入：{ id: { apply(value), render(value) } } */
export function registerAppliers(map) {
  for (const [id, fn] of Object.entries(map || {})) {
    if (fn && typeof fn.apply === 'function') appliers.set(String(id), fn);
  }
}

/**
 * 校验一个值是否合法（类型与取值域）。不合法返回 false，由调用方回落默认。
 * @param {{id:string, kind:string, values:string[]|null, defaultValue:unknown}} it
 * @param {unknown} v
 */
function valid(it, v) {
  // ① **有取值域时以域为准**：域内即合法。
  //   必须按字符串比较 —— 取值域可能是混合类型（如 DPR 的 ['auto', 1, 1.5, 2]），
  //   若按 defaultValue 的类型（'auto' ⇒ string）判，点 1/1.5/2 会被判非法并回落默认，
  //   表现为"面板点不动"（这条曾把分段控件变成假接线）。
  if (Array.isArray(it.values) && it.values.length) {
    return it.values.map(String).includes(String(v));
  }
  // ② 无取值域（开关/滑块等）：按默认值的类型校验
  const d = it.defaultValue;
  if (typeof d === 'boolean') return typeof v === 'boolean';
  if (typeof d === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (typeof d === 'string') return typeof v === 'string';
  return false;
}

/**
 * 启动时一次性读回全部（**纯内存，不碰 DOM**）。
 * 脏数据/类型不符 ⇒ 回落默认并记录（不抛、不阻塞启动）。
 * @returns {{loaded:number, rejected:string[]}} 诊断信息
 */
export function loadAll() {
  let saved = {};
  let root = {};
  try { root = readViewSettings() || {}; } catch { root = {}; }
  saved = (root && root.panel) || {};
  values.clear();
  rejected.length = 0;
  for (const it of SPEC) {
    // 按存储槽取值：主题/背景模式在顶层，其余在 panel 段
    let v;
    let has = false;
    if (it.store === 'theme') { v = root.uiTheme; has = v !== undefined; }
    else if (it.store === 'bgMode') { v = root.background && root.background.mode; has = v !== undefined; }
    else if (it.id in saved) { v = saved[it.id]; has = true; }

    if (!has) { values.set(it.id, it.defaultValue); continue; }   // 没存过 ⇒ 用 schema 默认（S2：默认值由工厂补齐）
    if (valid(it, v)) { values.set(it.id, v); continue; }
    // 非法值：回落默认，但**仍然记进内存**。
    //   为什么不能只跳过：flush() 会把 values 整包写回，跳过就等于把这些键从存储里删掉，
    //   一条脏数据会连带清空用户其余设置（实测：塞 4 个脏值后 panel 被写成 {}）。
    values.set(it.id, it.defaultValue);
    rejected.push(it.id);
  }
  // 插件控件是**运行期**才登记进 SPEC 的（插件脚本异步注入），而本函数在启动早期就读盘了 ——
  //   那时它们的声明还不在 SPEC 里。若不把 panel 段里这些"暂时无主的键"也读进内存，
  //   插件登记完成后 getValue 只能拿到默认值，表现为"设过的档位刷新后回到默认"。
  //   这里原样保留（不合并不校验），等 registerSpecItems 登记后用同一套 getValue 取到。
  for (const [key, val] of Object.entries(saved || {})) {
    if (!byId.has(key)) values.set(key, val);
  }
  loadedOnce = true;
  return { loaded: values.size, rejected: [...rejected] };
}

/**
 * 某个控件当前是否"可生效"：能力不支持的控件不会被构建（不进 panelWired）。
 * 契约 §四：这类项**保留值、不 apply、不 render**，切回支持渲染面后由 applyAll 自然生效。
 * @param {string} id
 */
function canApplyNow(id) {
  const wired = state.panelWired;
  // 面板还没构建（null/空）⇒ 不拦（启动早期由调用顺序保证）
  if (!Array.isArray(wired) || wired.length === 0) return true;
  return wired.includes(id);
}

/**
 * 把当前值下发给引擎/渲染器，并（可选）重放显示态。
 *
 * **幂等**：可以在每次面板重建后反复调用（契约 §三）。
 * @param {{render?: boolean, only?: string[]}} [opts] render=true 同时更新已存在 DOM 的显示态
 * @returns {{applied:string[], skipped:string[]}}
 */
export function applyAll(opts = {}) {
  const wantRender = opts.render === true;
  const only = Array.isArray(opts.only) ? new Set(opts.only.map(String)) : null;
  const applied = [];
  const skipped = [];
  for (const it of SPEC) {
    if (only && !only.has(it.id)) continue;
    if (applySkip.has(it.id)) { skipped.push(it.id); continue; }
    const v = getValue(it.id);
    if (v === undefined) continue;
    if (!canApplyNow(it.id)) { skipped.push(it.id); continue; }
    const fn = appliers.get(it.id);
    if (!fn) { skipped.push(it.id); continue; }
    try {
      fn.apply(v);
      if (wantRender && typeof fn.render === 'function') fn.render(v);
      applied.push(it.id);
    } catch {
      skipped.push(it.id);   // 单项失败不拖垮其它项（与旧 restorePanelSettings 的容错一致）
    }
  }
  return { applied, skipped };
}

/** 立即落盘（幂等；visibilitychange 隐藏时也会调） */
export function flush() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = 0; }
  // 从未成功读回就不写：否则一次启动异常/未初始化就把整个 panel 段写成 {}（用户设置全丢）
  if (!loadedOnce) return false;
  // 两个集合要分开：
  //   panel    = 真正写进 panel 段的项（主题/背景模式由 applyTheme/applyBackground 写顶层，不重复存）
  //   snapshot = **全部**项的值，只作为 dataset 上的可观测快照（自动化判"点击是否生效"用它）
  const panel = {};
  const snapshot = {};
  for (const it of SPEC) {
    const v = values.get(it.id);
    if (v === undefined) continue;
    snapshot[it.id] = v;
    if (it.store === 'panel') panel[it.id] = v;
  }
  // 未登记的键（插件控件：尚未登记，或插件已被卸载）不能在这里被抹掉 ——
  //   `saveViewSettings({panel})` 是整体替换语义，漏掉就等于"改别的设置把插件的值删了"。
  for (const [key, val] of values.entries()) {
    if (byId.has(key) || val === undefined) continue;
    panel[key] = val;
    snapshot[key] = val;
  }
  state.panelSettings = { ...panel };
  try { document.documentElement.dataset.panelSetting = JSON.stringify(snapshot); } catch { /* 忽略 */ }
  try { saveViewSettings({ panel }); } catch { /* 存储不可用就只保留内存态 */ }
  return true;
}

/** 去抖落盘 */
function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = 0; flush(); }, WRITE_DEBOUNCE_MS);
}

/**
 * 改一个值：校验 → 内存 → 生效 → 显示 → （去抖）落盘。
 * @param {string} id
 * @param {unknown} value
 * @param {{persist?: boolean, render?: boolean}} [opts]
 * @returns {unknown} 实际采用的值（非法时为默认值）
 */
export function set(id, value, opts = {}) {
  const key = String(id);
  const it = byId.get(key);
  const v = it && valid(it, value) ? value : defaultOf(key);
  if (it) values.set(key, v);
  const fn = appliers.get(key);
  if (fn) {
    try { fn.apply(v); } catch { /* 生效失败不影响记录 */ }
    if (opts.render !== false && typeof fn.render === 'function') {
      try { fn.render(v); } catch { /* 显示失败不影响生效 */ }
    }
  }
  if (opts.persist !== false) scheduleWrite();
  return v;
}

/**
 * **只记录**一个已经生效的值（不再 apply）。
 *
 * 为什么需要它：渲染器可能把请求值钳制/回退（契约 INV-08），此时工厂里必须存"生效值"而不是"请求值"。
 *   若走 set() 会再次调用 apply ⇒ 自递归（而且是把钳制后的值反复下发）。
 * @param {string} id
 * @param {unknown} value
 * @param {{render?: boolean}} [opts]
 * @returns {unknown} 实际记录的值
 */
export function commit(id, value, opts = {}) {
  const key = String(id);
  const it = byId.get(key);
  const v = it && valid(it, value) ? value : defaultOf(key);
  if (it) values.set(key, v);
  if (opts.render !== false) {
    const fn = appliers.get(key);
    if (fn && typeof fn.render === 'function') {
      try { fn.render(v); } catch { /* 显示失败不影响记录 */ }
    }
  }
  scheduleWrite();
  return v;
}

/** 诊断快照（断言用） */
export function snapshot() {
  return { values: getAll(), rejected: [...rejected], loadedOnce, specCount: SPEC.length };
}

// 关页/切后台时把去抖中的值落盘（否则"改完立刻关页面"会丢最后一次）
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
