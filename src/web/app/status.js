// app/status.js —— 舞台状态行的唯一写入口
//
// 一条状态行有三个去处，全部由这里统一分发（顺序不能颠倒）：
//   ① 进 window.__WEB__.stageLog（自动化断言的唯一真相，前端一切"发生了什么"都靠它）
//   ② 进调试日志浮层的缓冲（若已建）
//   ③ 按"显示状态信息"开关决定要不要写到舞台顶部那一行
//
// 为什么不让调用方自己写 DOM：状态行是"最近一次发生了什么"，多处各写一处必然漂移；
//   而且 error/warn 必须始终可见，info 只在被要求时显示——这条策略只能有一份实现。

import { dom, state } from './context.js';
import { createLogger } from '../infra/log.js';

// 适配层：状态行的文本同时进统一日志工厂（面板与"上传日志"只认工厂这一份）。
//   注意：状态行的**展示策略**仍在本文件（什么时候写 stageHint），工厂只管"记一条"。
const logStage = createLogger('stage');

/**
 * 记录一条状态行（**无条件执行**，与"显不显示"完全无关）。
 *
 * 记录有三个去处，缺一不可：
 *   ① `window.__WEB__.stageLog` —— 自动化断言的唯一真相
 *   ② 调试日志浮层的缓冲（面板看得到）
 *   ③ 统一日志工厂（"上传日志"导出）—— 只有 `toLog` 为真的调用才进
 *
 * 为什么要单独抽出来：以前这条记录写在显示分支之后，两处 early return（没有 stageHint、
 *   或「显示状态信息」被关掉）会**连日志一起跳过**。后果是：用户为了少看 UI 噪音关掉状态行，
 *   真出问题想上传日志时恰好是空的——最需要日志的时刻没有日志。
 *   现在记录在前、显示在后，开关只影响"看不看得见"，不影响"有没有记"。
 *
 * @param {'info'|'warn'|'error'} level
 * @param {string} line 已转成字符串的文本
 * @param {object} [detail] 结构化上下文（仅 toLog 时进工厂）
 * @param {{toLog?: boolean}} [flags] toLog=true ⇒ 同时写入统一日志工厂
 */
function record(level, line, detail, flags) {
  if (typeof window !== 'undefined' && window.__WEB__) {
    const bag = (window.__WEB__.stageLog = window.__WEB__.stageLog || []);
    bag.push({ at: Date.now(), level, line });
    if (bag.length > 200) bag.shift();
  }
  try {
    console.info(`%c[STAGE:${level}]`, 'color:#8b8b8b', line);
  } catch { /* 控制台不可用时忽略 */ }
  if (state.debugLogHandle && typeof state.debugLogHandle.log === 'function') {
    try { state.debugLogHandle.log('STAGE', line, { level }); } catch { /* 日志失败不影响业务 */ }
  }
  if (!flags || flags.toLog !== true) return;
  try {
    const lv = level === 'warn' || level === 'error' ? level : 'info';
    logStage[lv](line, detail);
  } catch { /* 工厂异常不影响状态行 */ }
}

/**
 * 按「显示状态信息」开关与级别决定要不要写舞台顶部那一行。
 * 只碰 DOM，不碰任何日志通路。
 * @param {string} line
 * @param {'info'|'warn'|'error'} level
 * @param {{show?: boolean}} opts
 */
function renderStatusLine(line, level, opts) {
  const visible = state.showStatus !== false;
  if (!dom.stageHint) return;
  if (!visible) {
    dom.stageHint.textContent = '';
    dom.stageHint.hidden = true;
    return;
  }
  const show = opts.show === true || level === 'error' || level === 'warn';
  if (show) {
    dom.stageHint.textContent = line;
    dom.stageHint.hidden = false;
  } else {
    dom.stageHint.textContent = '';
    dom.stageHint.hidden = true;
  }
}

/**
 * 写一条状态行（**只上状态行**，不额外记日志）。
 *
 * ---- 什么时候用 stageStatus、什么时候用 stageLog（总则，新增状态行前先读这段）----
 * 判据：这句话说的是"**现在是什么**"还是"**刚刚发生了什么**"？
 *   · "现在是什么"（设置回显 / 操作回执 / 进度 / 装载结果） → **stageStatus**
 *     只占状态行，不额外记日志 —— 状态行本来就是"当前状态"，再记一条只会把日志刷屏。
 *   · "刚刚发生了什么"（失败 / 被拒绝 / 跳过了什么） → **stageLog**
 *     带结构化 detail 进面板与"上传日志"，排查时要靠它回溯。
 * 例外：错误与告警类即使描述的是某种状态，也一律走 stageLog —— 人需要能回溯，不能只闪一下。
 * 注意：日志不能走 console.error，否则页面错误统计会把正常状态当成异常。
 * @param {string} text
 * @param {'info'|'warn'|'error'} [level]
 * @param {{show?: boolean}} [opts] show=true 表示这条 info 也要显示在状态行上
 * @returns {string} 写进状态行的文本
 */
export function stageStatus(text, level = 'info', opts = {}) {
  const line = String(text == null ? '' : text);
  record(level, line, undefined, { toLog: false });
  renderStatusLine(line, level, opts || {});
  return line;
}

/**
 * 写状态行 + 记一条**带结构化 detail** 的日志（(a) 类：既要人看见，也要进面板与上传）。
 *
 * 为什么单开一个入口：失败类与"预期内不可用"要进日志，而且必须带可排查上下文
 *   （错误对象、输入、当前模型…）——纯文本的 stageStatus 记不出结构化字段。
 *   **状态行的可见性策略不变**（error/warn 始终可见），日志记录也不受显示开关影响。
 * @param {'info'|'warn'|'error'} level
 * @param {string} text 人话（同时写进状态行与日志的 msg）
 * @param {object} [detail] 结构化上下文（对象原样保留，不会被字符串化成 [object Object]）
 * @param {{show?: boolean}} [opts] 同 stageStatus
 * @returns {string} 写进状态行的文本
 */
export function stageLog(level, text, detail, opts) {
  const lv = level === 'warn' || level === 'error' ? level : 'info';
  const line = String(text == null ? '' : text);
  record(lv, line, detail, { toLog: true });
  renderStatusLine(line, lv, opts || {});
  return line;
}

/**
 * 向诊断探针上报一条"应用语义"事件（plugin.load / bundle.parse / model.mount 等）。
 * 探针不在（未装/被禁用）时静默跳过——日志是旁路，不能影响主流程。
 * @param {string} name 事件名（点号分隔，如 model.mount）
 * @param {object} [data] 结构化字段
 * @param {{level?: string, src?: string}} [opts]
 */
export function diagEvent(name, data, opts) {
  try {
    const diag = typeof window !== 'undefined' ? window.__DIAG__ : null;
    if (!diag || typeof diag.event !== 'function') return null;
    return diag.event(name, data || {}, opts || {});
  } catch {
    return null; // 上报失败不影响业务
  }
}
