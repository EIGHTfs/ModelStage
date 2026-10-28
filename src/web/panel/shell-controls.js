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
import { setStageVisible } from '../app/memory-bars.js';
import { mountDebugPanel } from '../debug/panel.js';
import { formatError } from '../infra/api.js';
import { dom, state, stage } from '../app/context.js';
import { resetViewViaRenderer } from '../render/reset-view.js';
import { stageLog, stageStatus } from '../app/status.js';
import * as memoryGuard from '../app/memory-guard.js';
import { VIEW_SETTINGS_KEY, applyBackground, applyTheme, readViewSettings, saveViewSettings } from '../app/view-settings.js';
import {
  connectSettingsIo, exportSettingsFile, importSettingsFromText, openImportPicker,
} from './settings-io.js';

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
  /** 导入项目配置后需要重载资源根与名册树（由 main.js 注入） */
  reloadApp: null,
  /** 应用导入的视图偏好（主题/背景/部件筛除） */
  applyViewerPrefs: null,
};

/**
 * 注入面板桥（在 main.js 里装配好面板后调用一次）。
 * @param {{applyPanelSetting?: Function, getPanelDefaults?: Function}} bridge
 */
export function connectShellControls(bridge) {
  panelBridge = { ...panelBridge, ...(bridge || {}) };
  // 设置导入/导出模块用同一套桥（重载名册、应用偏好、面板回放）
  connectSettingsIo({
    applyPanelSetting: (id, value) => panelBridge.applyPanelSetting?.(id, value),
    applyViewerPrefs: (prefs) => panelBridge.applyViewerPrefs?.(prefs),
    reloadApp: () => panelBridge.reloadApp?.(),
    panelSettings: () => state.panelSettings || {},
  });
  window.__WEB__ && (window.__WEB__.hangGuardConfig = hangGuardConfig);
}

/**
 * 显示状态信息（ctl-show-status）：控制舞台顶部那条状态行的显隐。
 * 关掉只是不显示，日志与控制台照旧（排障不能因为藏了提示就断线）。
 */
export function applyShowStatus(on) {
  // 舞台顶部的内存条与状态行同策略：关掉「显示状态信息」时它也不显示
  setStageVisible(on !== false);
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
  // S4：把持久化的"收起/展开"补上（面板可能比启动读回更早挂载，挂载那一刻还读不到持久值）
  if (state.debugPanel && typeof state.debugPanel.restoreCollapsed === 'function') {
    try { state.debugPanel.restoreCollapsed(); } catch { /* 回放失败保持当前形态 */ }
  }
  stageStatus(`调试日志：${state.debugLog ? '开' : '关'}`, 'info', { show: true });
}

/** 调试日志浮层的容器与实例（懒建；样式由 debug/panel.js 自己注入） */
export function ensureDebugPanelHost() {
  if (state.debugPanelHost) return state.debugPanelHost;
  const host = document.createElement('div');
  host.id = 'debug-panel-host';
  // 位置/尺寸在 style.css 的 #debug-panel-host（契约：设计值不进 JS）
  document.body.append(host);
  state.debugPanelHost = host;
  try {
    state.debugLogHandle = createDebugLog({ capacity: 200 });
    state.debugPanel = mountDebugPanel({ log: state.debugLogHandle, container: host });
    window.__WEB__ && (window.__WEB__.debugLog = state.debugLogHandle);
  } catch (err) {
    stageLog('warn', `调试日志面板不可用：${formatError(err)}`, { err: formatError(err) });
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
  state.hangGuardStats = { ticks: 0, stalls: 0, recoveries: 0, lastFrames: null, skippedHidden: 0 };
  window.__WEB__ && (window.__WEB__.hangGuard = state.hangGuardStats);
  state.hangGuardTimer = setInterval(hangGuardTick, hangGuardConfig.tickMs);
  stageStatus(`防卡死保护：开（连续 ${hangGuardConfig.stallLimit}s 无新帧则尝试恢复）`, 'info', { show: true });
}

/**
 * 内存保护（ctl-memory-guard）：与防卡死保护并列、互不替代。
 *   · 开关开（默认）＝ 服务端解包前按可用内存准入 + 前端加载前查 JS 堆占用；
 *   · 开关关 ＝ 服务端放行超预算解包（用户自担风险），前端预检也不再拦。
 * 这里只翻转状态并刷新判据读数，真正的判断在 app/memory-guard.js 与服务端 capacity.mjs。
 * @param {boolean} on
 */
export function applyMemoryGuard(on) {
  const value = memoryGuard.setMemoryGuard(on);
  stageStatus(value ? '内存保护：开（解包按可用内存准入）' : '内存保护：关（允许超预算解包，请自行确认内存充足）', 'info', { show: true });
}

/** 看门狗单次采样 */
function hangGuardTick() {
  const stats = state.hangGuardStats;
  if (!stats || !stage || typeof stage.stats !== 'function') return;
  // 标签页在后台时**直接跳过，连统计都不做**：
  //   浏览器按规范会暂停后台页的 requestAnimationFrame（省电），frames 自然不增长 ——
  //   那是浏览器的正常行为，不是我们的渲染卡死。在这儿统计只会得出"后台=卡死"的假结论，
  //   而且下一段的 stallLimit 一到就会真的去 pause()/play() 自愈一次（多余动作）。
  // 计数单独记 skippedHidden（不是把 stalls 归零），让它可观测：将来要看"到底跳过了多少次"有据可查。
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    stats.skippedHidden = (stats.skippedHidden || 0) + 1;
    return;
  }
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
    stageLog('warn', `检测到渲染停滞（${hangGuardConfig.stallLimit}s 无新帧），已尝试恢复`, { stallLimit: hangGuardConfig.stallLimit });
    try { stage.pause(); stage.play(); } catch { /* 自愈失败不影响主流程 */ }
  }
  document.documentElement.dataset.hangGuardStats =
    `ticks=${stats.ticks} stalls=${stats.stalls} rec=${stats.recoveries} skip=${stats.skippedHidden || 0}`;
}

// 从后台切回可见时**重置基线**：
//   后台期间 rAF 停着、frames 冻住，stats.lastFrames 是"很久以前的旧值"。
//   不重置就直接比，会把整个后台时长一次性算成停滞 ⇒ 切回来第一个 tick 就报"渲染停滞"，
//   和后台误报是同一个病，只是晚了一步。
// 这里只清基线（lastFrames=null 让下一个 tick 只记录不比较；stalls 归零），
//   不动 recoveries/skippedHidden（那是累计事实，不该被一次切页抹掉）。
// 幂等注册：模块只加载一次，监听只挂一次。
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    const stats = state.hangGuardStats;
    if (!stats) return;
    if (document.visibilityState === 'visible') {
      stats.lastFrames = null;
      stats.stalls = 0;
    }
  });
}

/**
 * 设置导入导出（ctl-settings-io）：三个动作共用一条通路，按按钮文字分派。
 * 导入依赖后端写接口，接口没实现就不假装能做（按钮在 schema 里已带禁用原因）。
 */
// 自动化入口：文件选择器在无头环境里没法点，测试直接喂 JSON 文本
window.__WEB__ && (window.__WEB__.settingsIo = { importText: importSettingsFromText, exportNow: exportSettingsFile });

export function runSettingsAction(action) {
  if (action === '导出设置') return exportSettingsFile();
  if (action === '导入设置') return openImportPicker();
  if (action === '恢复默认') return restoreDefaultSettings();
  stageLog('warn', `设置动作不可用：${action}`, { action });
  return false;
}

/** 恢复默认：清本地存储 → 按面板声明的默认值重放一遍 → 视图复位 */
export function restoreDefaultSettings() {
  try { localStorage.removeItem(VIEW_SETTINGS_KEY); } catch { /* 存储不可用不算失败 */ }
  state.panelSettings = {};
  try { saveViewSettings({ panel: {} }); } catch { /* 存储不可用忽略 */ }
  const defaults = panelBridge.getPanelDefaults() || {};
  for (const [id, value] of Object.entries(defaults)) {
    // MSAA 默认值已由建上下文时生效，重放会白等一次上下文重建
    if (id === 'ctl-msaa') continue;
    if (typeof panelBridge.applyPanelSetting === 'function') panelBridge.applyPanelSetting(id, value);
  }
  applyTheme('dark-cyan');
  applyBackground('checkerboard');
  const panel = state.panel;
  if (panel && panel.setValue) {
    panel.setValue('ctl-theme', state.viewTheme);
    panel.setValue('ctl-bg-mode', state.viewBg);
  }
  // 视图复位走统一入口（只认当前渲染器，避免 Live2D 面打到隐藏的 Spine 舞台）
  try { resetViewViaRenderer(state.currentRenderer); } catch { /* 视图复位失败不影响设置 */ }
  document.documentElement.dataset.settingsRestored = String(Date.now());
  stageStatus('已恢复默认设置（本地存储已清空、视图已复位）', 'info', { show: true });
  return true;
}
