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
  return line;
}
