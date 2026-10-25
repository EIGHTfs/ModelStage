// app/ui-state.js —— UI 状态的单一真相源（S1）
//
// 契约：doc/契约/UI状态持久化契约.md
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
      });
    }
  }
  return out;
})();

/** id → SPEC 声明 */
const byId = new Map(SPEC.map((it) => [it.id, it]));

/** 当前值（唯一真相源；启动时由 loadAll 填充，用户改动由 set 更新） */
const values = new Map();

/** id → {apply, render} 应用器（由 panel-settings 装配时注入） */
const appliers = new Map();

/** 落盘调度 */
let writeTimer = 0;
/** 落盘是否被暂停（面板默认值回放期间不写盘，避免把用户设置覆盖成默认） */
let persistSuspended = false;
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
  const d = it.defaultValue;
  if (typeof d === 'boolean') return typeof v === 'boolean';
  if (typeof d === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (typeof d === 'string') {
    if (typeof v !== 'string') return false;
    // 有取值域的（分段/下拉/胶囊）必须落在域内，否则是脏数据
    if (Array.isArray(it.values) && it.values.length && !it.values.includes(v)) return false;
    return true;
  }
  return false;
}

/**
 * 启动时一次性读回全部（**纯内存，不碰 DOM**）。
 * 脏数据/类型不符 ⇒ 回落默认并记录（不抛、不阻塞启动）。
 * @returns {{loaded:number, rejected:string[]}} 诊断信息
 */
export function loadAll() {
  let saved = {};
  try { saved = (readViewSettings().panel) || {}; } catch { saved = {}; }
  values.clear();
  rejected.length = 0;
  for (const it of SPEC) {
    if (!(it.id in saved)) continue;
    const v = saved[it.id];
    if (valid(it, v)) { values.set(it.id, v); continue; }
    // 非法值：回落默认，但**仍然记进内存**。
    //   为什么不能只跳过：flush() 会把 values 整包写回，跳过就等于把这些键从存储里删掉，
    //   一条脏数据会连带清空用户其余设置（实测：塞 4 个脏值后 panel 被写成 {}）。
    values.set(it.id, it.defaultValue);
    rejected.push(it.id);
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
  if (persistSuspended) return false;
  // 从未成功读回就不写：否则一次启动异常/未初始化就把整个 panel 段写成 {}（用户设置全丢）
  if (!loadedOnce) return false;
  const panel = {};
  for (const [id, v] of values) panel[id] = v;
  state.panelSettings = { ...panel };
  try { document.documentElement.dataset.panelSetting = JSON.stringify(panel); } catch { /* 忽略 */ }
  try { saveViewSettings({ panel }); } catch { /* 存储不可用就只保留内存态 */ }
  return true;
}

/** 去抖落盘 */
function scheduleWrite() {
  if (persistSuspended) return;
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
  // 启动期回放 schema 默认值时，**已读回的用户值优先**：
  //   否则会出现"先按用户值显示 → 被默认值覆盖 → 再被读回值覆盖"的闪烁（契约 §六 A3 明令禁止）。
  //   （这段时序本身在 S2 会整体收进工厂，这里先保证语义正确。）
  if (persistSuspended && values.has(key)) return values.get(key);
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

/** 暂停/恢复落盘（面板默认值回放期间用；S2 会把这段时序整体收进本模块） */
export function setPersistSuspended(on) {
  persistSuspended = !!on;
  if (!persistSuspended) scheduleWrite();
}

/** 诊断快照（断言用） */
export function snapshot() {
  return { values: getAll(), rejected: [...rejected], suspended: persistSuspended, specCount: SPEC.length };
}

// 关页/切后台时把去抖中的值落盘（否则"改完立刻关页面"会丢最后一次）
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
