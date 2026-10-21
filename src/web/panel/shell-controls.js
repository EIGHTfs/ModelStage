// panel/shell-controls.js —— 四个「外壳级」控件的真实实现
//
// 这四项与渲染器能力无关（主题/背景那类才走 panel 的能力过滤），所以归外壳自己管：
//   ctl-show-status   显示状态信息    → 控制舞台顶部状态行的显隐（日志照旧写）
//   ctl-debug-log     调试日志        → 控制 debug/panel.js 浮层的显隐（采集与展示分离）
//   ctl-hang-guard    防卡死保护      → 帧停滞看门狗（检出 + 自愈 + 计数）
//   ctl-settings-io   导出/导入/恢复默认 → 导出走前端生成 JSON；导入依赖后端（未实现即如实禁用）
//
// 与 main.js 的分工：main.js 只做装配（把 SHELL_APPLIERS 指向这里导出的函数），
//   跨模块需要的"面板重放"通过 connectShellControls 注入，避免 main ↔ 本模块循环依赖。

import { createDebugLog } from '../debug/log.js';
import { mountDebugPanel } from '../debug/panel.js';
import { formatError } from '../infra/api.js';
import { dom, state, stage } from '../app/context.js';
import { stageStatus } from '../app/status.js';
import { VIEW_SETTINGS_KEY, applyBackground, applyTheme, readViewSettings } from '../app/view-settings.js';
import { DEFAULT_PART_FILTER_KEYWORDS, applyPartFilter } from '../app/part-filter.js';

/**
 * 防卡死保护的参数：单点定义，测试与排障都读这里（不许在逻辑里散落裸数字）。
 *   tickMs     采样间隔
 *   stallLimit 连续多少次"帧数不增长"判定为卡死（3 次 ≈ 3 秒）
 */
export const hangGuardConfig = { tickMs: 1000, stallLimit: 3 };

/** 面板桥：恢复默认要"按面板声明的默认值重放一遍"，由 main.js 在装配完成后注入 */
let panelBridge = {
  applyPanelSetting: null,
  getPanelDefaults: () => ({}),
};

/**
 * 注入面板桥（在 main.js 里装配好面板后调用一次）。
 * @param {{applyPanelSetting?: Function, getPanelDefaults?: Function}} bridge
 */
export function connectShellControls(bridge) {
  panelBridge = { ...panelBridge, ...(bridge || {}) };
  window.__WEB__ && (window.__WEB__.hangGuardConfig = hangGuardConfig);
}

/**
 * 显示状态信息（ctl-show-status）：控制舞台顶部那条状态行的显隐。
 * 关掉只是不显示，日志与控制台照旧（排障不能因为藏了提示就断线）。
 */
export function applyShowStatus(on) {
  state.showStatus = on !== false;
  document.documentElement.dataset.showStatus = state.showStatus ? 'on' : 'off';
  if (dom.stageHint && !state.showStatus) {
    dom.stageHint.textContent = '';
    dom.stageHint.hidden = true;
  }
  stageStatus(`状态信息显示：${state.showStatus ? '开' : '关'}`, 'info', { show: true });
}

/**
 * 调试日志（ctl-debug-log）：控制 debug/panel.js 浮层的显隐。
 * 采集与展示分开——关掉只隐藏面板，已采内容保留，重新打开能接着看。
 */
export function applyDebugLog(on) {
  state.debugLog = on !== false;
  document.documentElement.dataset.debugLog = state.debugLog ? 'on' : 'off';
  const host = ensureDebugPanelHost();
  if (host) host.hidden = !state.debugLog;
  if (state.debugLogHandle && typeof state.debugLogHandle.setEnabled === 'function') {
    try { state.debugLogHandle.setEnabled(state.debugLog); } catch { /* 开关失败不影响渲染 */ }
  }
  stageStatus(`调试日志：${state.debugLog ? '开' : '关'}`, 'info', { show: true });
}

/** 调试日志浮层的容器与实例（懒建；样式由 debug/panel.js 自己注入） */
export function ensureDebugPanelHost() {
  if (state.debugPanelHost) return state.debugPanelHost;
  const host = document.createElement('div');
  host.id = 'debug-panel-host';
  // 浮在舞台右下角：避开右栏（x≥1744）与播放条，不遮名册与面板
  host.style.cssText = 'position:fixed;right:200px;bottom:100px;z-index:40;width:288px;';
  document.body.append(host);
  state.debugPanelHost = host;
  try {
    state.debugLogHandle = createDebugLog({ capacity: 200 });
    state.debugPanel = mountDebugPanel({ log: state.debugLogHandle, container: host });
    window.__WEB__ && (window.__WEB__.debugLog = state.debugLogHandle);
  } catch (err) {
    stageStatus(`调试日志面板不可用：${formatError(err)}`, 'warn');
    state.debugLogHandle = null;
  }
  return state.debugPanelHost;
}

/**
 * 防卡死保护（ctl-hang-guard）：防的是「画面停住但没人知道」。
 * 做法：每 tickMs 采一次舞台累计帧数，连续 stallLimit 次不增长（且已有模型在渲染）判为停滞 →
 *   写一条 warn + 尝试 pause→play 自愈一次；计数写进 __WEB__.hangGuard 供断言。
 * 只看"有没有新帧"，不看帧率高低（慢 ≠ 卡死）。关掉时定时器直接停，不留后台轮询。
 */
export function applyHangGuard(on) {
  state.hangGuard = on !== false;
  document.documentElement.dataset.hangGuard = state.hangGuard ? 'on' : 'off';
  if (state.hangGuardTimer) {
    clearInterval(state.hangGuardTimer);
    state.hangGuardTimer = null;
  }
  if (!state.hangGuard) {
    stageStatus('防卡死保护：关', 'info', { show: true });
    return;
  }
  state.hangGuardStats = { ticks: 0, stalls: 0, recoveries: 0, lastFrames: null };
  window.__WEB__ && (window.__WEB__.hangGuard = state.hangGuardStats);
  state.hangGuardTimer = setInterval(hangGuardTick, hangGuardConfig.tickMs);
  stageStatus(`防卡死保护：开（连续 ${hangGuardConfig.stallLimit}s 无新帧则尝试恢复）`, 'info', { show: true });
}

/** 看门狗单次采样 */
function hangGuardTick() {
  const stats = state.hangGuardStats;
  if (!stats || !stage || typeof stage.stats !== 'function') return;
  let snap = null;
  try { snap = stage.stats(); } catch { snap = null; }
  if (!snap) return;
  stats.ticks += 1;
  const frames = typeof snap.frames === 'number' ? snap.frames : null;
  // 没模型在渲染时不计停滞：没东西可卡，报了就是误报
  const loaded = !!(snap.model || snap.phase === 'ready');
  if (!loaded || frames === null) { stats.lastFrames = frames; return; }
  stats.stalls = stats.lastFrames !== null && frames <= stats.lastFrames ? stats.stalls + 1 : 0;
  stats.lastFrames = frames;
  if (stats.stalls >= hangGuardConfig.stallLimit) {
    stats.stalls = 0;
    stats.recoveries += 1;
    stageStatus(`检测到渲染停滞（${hangGuardConfig.stallLimit}s 无新帧），已尝试恢复`, 'warn');
    try { stage.pause(); stage.play(); } catch { /* 自愈失败不影响主流程 */ }
  }
  document.documentElement.dataset.hangGuardStats =
    `ticks=${stats.ticks} stalls=${stats.stalls} rec=${stats.recoveries}`;
}

/**
 * 设置导入导出（ctl-settings-io）：三个动作共用一条通路，按按钮文字分派。
 * 导入依赖后端写接口，接口没实现就不假装能做（按钮在 schema 里已带禁用原因）。
 */
export function runSettingsAction(action) {
  if (action === '导出设置') return exportSettingsFile();
  if (action === '恢复默认') return restoreDefaultSettings();
  stageStatus(`设置动作不可用：${action}`, 'warn');
  return false;
}

/** 导出：前端生成 JSON + 触发下载（内容同时留在 __WEB__.settingsExport 供断言） */
export function exportSettingsFile() {
  const payload = {
    schema: 'spine-viewer-settings/v2',
    exportedAt: new Date().toISOString(),
    panel: { ...(state.panelSettings || {}) },
    view: readViewSettings(),
  };
  const text = JSON.stringify(payload, null, 2);
  window.__WEB__ && (window.__WEB__.settingsExport = { text, panelCount: Object.keys(payload.panel).length });
  document.documentElement.dataset.settingsExport = String(text.length);
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `spine-viewer-settings-${payload.exportedAt.slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    stageStatus(`已导出设置：${Object.keys(payload.panel).length} 项，${text.length} 字节`, 'info', { show: true });
    return true;
  } catch (err) {
    stageStatus(`导出设置失败：${formatError(err)}`, 'error');
    return false;
  }
}

/** 恢复默认：清本地存储 → 按面板声明的默认值重放一遍 → 视图复位 */
export function restoreDefaultSettings() {
  try { localStorage.removeItem(VIEW_SETTINGS_KEY); } catch { /* 存储不可用不算失败 */ }
  state.panelSettings = {};
  const defaults = panelBridge.getPanelDefaults() || {};
  for (const [id, value] of Object.entries(defaults)) {
    // MSAA 默认值已由建上下文时生效，重放会白等一次上下文重建
    if (id === 'ctl-msaa') continue;
    if (typeof panelBridge.applyPanelSetting === 'function') panelBridge.applyPanelSetting(id, value);
  }
  applyTheme('dark-cyan');
  applyBackground('checkerboard');
  applyPartFilter({ enabled: false, keywords: DEFAULT_PART_FILTER_KEYWORDS.slice() });
  const panel = state.panel;
  if (panel && panel.setValue) {
    panel.setValue('ctl-theme', state.viewTheme);
    panel.setValue('ctl-bg-mode', state.viewBg);
  }
  try { if (stage && stage.resetView) stage.resetView(); } catch { /* 视图复位失败不影响设置 */ }
  document.documentElement.dataset.settingsRestored = String(Date.now());
  stageStatus('已恢复默认设置（本地存储已清空、视图已复位）', 'info', { show: true });
  return true;
}
