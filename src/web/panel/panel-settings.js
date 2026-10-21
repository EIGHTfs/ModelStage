// panel/panel-settings.js —— 面板的"生效表 + 三态装配"
//
// 三件事集中在这里，避免 main.js 继续膨胀：
//   ① SHELL_APPLIERS：与渲染器无关的控件怎么落地；其余设置一律经 renderer.setSetting 下发
//   ② applyPanelSetting：控件回调的唯一入口（含"回显生效值"与"不支持则回退"）
//   ③ rebuildPanelFor：按当前渲染器能力重算三态 + 重跑能力自检（契约 INV-05）

import { dom, stage, state } from '../app/context.js';
import { stageStatus } from '../app/status.js';
import { PANEL_GROUPS, applyCapabilities, selfCheck, settingKeyOf } from './schema.js';
import { mountPanel } from './view.js';
import { applyDebugLog, applyHangGuard, applyShowStatus, connectShellControls, runSettingsAction } from './shell-controls.js';
import { applyBackground, applyTheme } from '../app/view-settings.js';
import { DEFAULT_PART_FILTER_KEYWORDS, applyPartFilter } from '../app/part-filter.js';
import { applyMixMode } from '../app/transport-actions.js';

/**
 * 皮肤列表刷新钩子：它依赖"当前模型"，实现在 model-actions 里（那边反过来要用 rebuildPanelFor），
 * 用钩子注入把这条双向依赖拆成单向：model-actions → panel-settings。
 */
let refreshSkinHook = () => {};
export function connectPanelRefresh(fn) {
  if (typeof fn === 'function') refreshSkinHook = fn;
}

/**
 * 外壳自己处理的控件（与渲染器无关）：主题/背景走 CSS 与 Surface，混合模式与皮肤列表走舞台既有状态，
 * 部件筛除是显示层策略。其余设置一律经 renderer.setSetting 下发（契约 INV-01：不得出现 stage.setXxx）。
 */
const SHELL_APPLIERS = {
  'ctl-theme': (v) => applyTheme(v),
  'ctl-bg-mode': (v) => applyBackground(v),
  'ctl-mix-mode': (v) => applyMixMode(v),
  'ctl-skin-mix': (v) => applyMixMode(v),
  'ctl-skin-list': (v) => stage && stage.setSkin(v),
  'ctl-part-filter': (v) => applyPartFilter({ enabled: !!v }),
  'ctl-part-filter-reset': () => applyPartFilter({ keywords: DEFAULT_PART_FILTER_KEYWORDS.slice() }),
  'ctl-hang-guard': (v) => applyHangGuard(v),
  'ctl-show-status': (v) => applyShowStatus(v),
  'ctl-debug-log': (v) => applyDebugLog(v),
  'ctl-settings-io': (v) => runSettingsAction(v),
};

/** 可点控件全集 = 外壳项 + 声明了能力键的项（能力过滤决定其中哪些真的可点） */
const WIRED_IDS = (() => {
  const ids = new Set(Object.keys(SHELL_APPLIERS));
  for (const group of PANEL_GROUPS) {
    for (const ctl of group.controls || []) {
      if (ctl && ctl.id && settingKeyOf(ctl.id)) ids.add(ctl.id);
    }
  }
  return [...ids];
})();

/** 面板控件回调：外壳项直接处理，其余一律经 renderer.setSetting（回显用生效值） */
function applyPanelSetting(id, value) {
  const shell = SHELL_APPLIERS[id];
  if (shell) {
    shell(value);
    state.panelSettings = { ...(state.panelSettings || {}), [id]: value };
    document.documentElement.dataset.panelSetting = JSON.stringify(state.panelSettings);
    return;
  }
  const cap = settingKeyOf(id);
  const renderer = state.currentRenderer;
  const key = cap ? (cap.kind === 'debug' ? `debug:${cap.capabilityKey}` : cap.settingKey) : null;
  if (!key || !renderer || typeof renderer.setSetting !== 'function') {
    stageStatus(`当前渲染器不支持该项设置：${id}`, 'warn');
    return;
  }
  let ok = false;
  try { ok = renderer.setSetting(key, value) === true; } catch { ok = false; }
  // 生效值回显（不是请求值）：契约 INV-08
  let applied = null;
  try { applied = renderer.getSetting ? renderer.getSetting(key) : null; } catch { applied = null; }
  if (!ok) {
    stageStatus(`渲染器不支持设置 ${key}（已回退到生效值 ${String(applied)}）`, 'warn');
    if (state.panel && applied !== null) state.panel.setValue(id, applied);
    return;
  }
  state.panelSettings = { ...(state.panelSettings || {}), [id]: applied === null ? value : applied };
  document.documentElement.dataset.panelSetting = JSON.stringify(state.panelSettings);
}
/** 面板三态快照（断言用：可用项 / 禁用项 / 隐藏项） */
function panelSnapshot() {
  const on = [];
  const off = [];
  for (const node of document.querySelectorAll('#right-panel [data-ctl]')) {
    const id = node.dataset.ctl;
    const control = node.matches('select') ? node : node.querySelector('button, select');
    if (!control || control.classList.contains('acc-trigger')) continue;
    (control.disabled ? off : on).push(id);
  }
  const present = [...document.querySelectorAll('#right-panel [data-ctl]')].map((n) => n.dataset.ctl);
  const hidden = [...WIRED_IDS, ...PANEL_GROUPS.flatMap((g) => (g.controls || []).map((c) => c.id)).filter(Boolean)]
    .filter((id) => !present.includes(id));
  return { enabled: [...new Set(on)], disabled: [...new Set(off)], hidden: [...new Set(hidden)] };
}
/** 按当前渲染器能力重建面板三态，并跑一次能力自检（契约 §四、§五） */
function rebuildPanelFor(renderer) {
  const groups = applyCapabilities(PANEL_GROUPS, renderer && renderer.capabilities, {
    onWarn: (message) => stageStatus(message, 'warn'),
  });
  document.documentElement.dataset.panelGroups = String(groups.length);
  const info = mountPanel({
    groups,
    headEl: dom.panelHead,
    bodyEl: dom.panelBody,
    onSetting: applyPanelSetting,
    wiredIds: WIRED_IDS,
  });
  state.panel = info;
  startFpsReadout(info);
  refreshSkinHook();
  state.panelSnapshot = panelSnapshot();
  const check = selfCheck(renderer || {});
  state.panelSelfCheck = check;
  document.documentElement.dataset.selfCheck = check.passed ? 'pass' : 'fail';
  if (!check.passed) {
    stageStatus(`能力自检未通过：${check.violations.map((v) => `${v.key}（${v.actual}）`).join('、')}`, 'error');
  }
  return check;
}
/** 帧率读数：把舞台实测帧率刷到面板上（500ms 一次；无舞台或未就绪时显示 —） */
function startFpsReadout(panel) {
  if (!panel || typeof panel.setFps !== 'function') return;
  const tick = () => {
    const st = stage && stage.stats ? stage.stats() : null;
    panel.setFps(st && typeof st.fps === 'number' ? st.fps : null);
  };
  tick();
  setInterval(tick, 500);
}
/** 装配完成后注入面板桥：恢复默认需要"按面板声明的默认值重放一遍" */
connectShellControls({
  applyPanelSetting: (id, value) => applyPanelSetting(id, value),
  getPanelDefaults: () => (state.panel && state.panel.defaults) || {},
});


/**
 * 重跑能力自检（契约 §四）：随时可调，violations 非空即缺陷。
 * 放在这里而不是 main.js，是因为它依赖 schema 的 selfCheck 与当前渲染器能力。
 */
export function runPanelSelfCheck() {
  const check = selfCheck(state.currentRenderer || {});
  state.panelSelfCheck = check;
  document.documentElement.dataset.selfCheck = check.passed ? 'pass' : 'fail';
  return check;
}

export { SHELL_APPLIERS, WIRED_IDS, applyPanelSetting, panelSnapshot, rebuildPanelFor, startFpsReadout };
