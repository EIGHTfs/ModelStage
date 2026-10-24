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
 * 写一条状态行。
 * 注意：日志不能走 console.error，否则页面错误统计会把正常状态当成异常。
 * @param {string} text
 * @param {'info'|'warn'|'error'} [level]
 * @param {{show?: boolean}} [opts] show=true 表示这条 info 也要显示在状态行上
 */
export function stageStatus(text, level = 'info', opts = {}) {
  const line = String(text == null ? '' : text);
  if (window.__WEB__) {
    const bag = (window.__WEB__.stageLog = window.__WEB__.stageLog || []);
    bag.push({ at: Date.now(), level, line });
    if (bag.length > 200) bag.shift();
  }
  try {
    console.info(`%c[STAGE:${level}]`, 'color:#8b8b8b', line);
  } catch { /* 控制台不可用时忽略 */ }
  // 调试日志浮层：状态行同时进日志缓冲（关掉显示不影响采集，采集在 applyDebugLog 里控制）
  if (state.debugLogHandle && typeof state.debugLogHandle.log === 'function') {
    try { state.debugLogHandle.log('STAGE', line, { level }); } catch { /* 日志失败不影响业务 */ }
  }
  // "显示状态信息"关掉时只保留日志与控制台，不再占用状态行（切回来的那一瞬间由 applyShowStatus 恢复）
  const visible = state.showStatus !== false;
  const show = visible && (opts.show === true || level === 'error' || level === 'warn');
  if (!dom.stageHint) return line;
  if (!visible) {
    dom.stageHint.textContent = '';
    dom.stageHint.hidden = true;
    return line;
  }
  if (show) {
    dom.stageHint.textContent = line;
    dom.stageHint.hidden = false;
  } else {
    dom.stageHint.textContent = '';
    dom.stageHint.hidden = true;
  }
  // 适配层：状态行同时记进统一工厂（级别沿用调用方给的 info/warn/error）。
  //   `show` 只是"要不要占用状态行"的显示开关，与"记不记日志"无关，所以不因它决定是否记录；
  //   把它作为 detail 留下，排查时能区分"当时是否可见"。
  try {
    const lv = level === 'warn' || level === 'error' ? level : 'info';
    logStage[lv](line, opts && opts.show === true ? { show: true } : undefined);
  } catch { /* 工厂异常不影响状态行 */ }
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
