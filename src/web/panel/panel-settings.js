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
import { applyMixMode, applyTransportMotion } from '../app/transport-actions.js';

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
  'ctl-skin-mix': (v) => applySkinMix(v),
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
  // 面板头「收起菜单」：事件由 main.js 在 #panel-head 上委托绑定（不是 schema 控件），
  //   但它是真接线的（收起右栏），所以要计入"已接线集合"，否则断言会把可点项当成漏网。
  ids.add('btn-collapse-menu');
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
/**
 * 刷新"动作列表"：按当前模型的动画逐条列出，点一条直接播放。
 * 数据来源是渲染器的 getAnimations()（Spine/Live2D 都实现了），所以换渲染器也不用改这里。
 */
export function refreshPanelAnimations() {
  const box = document.querySelector('#right-panel [data-ctl="ctl-anim-list"]');
  if (!box) return 0;
  // 数据来源按优先级取（两个渲染器都不直接暴露 getAnimations）：
  //   ① 渲染器自带 getAnimations（将来可能加）
  //   ② 舞台 stats().animations（Spine：canvas.js 把引擎动画摊平在 stats 里）
  //   ③ Live2D：bridge.readState().motions / motions 列表
  const pickList = () => {
    const r = state.currentRenderer || {};
    try { if (typeof r.getAnimations === 'function') return r.getAnimations() || []; } catch { /* 继续兜底 */ }
    try {
      const snap = stage && typeof stage.stats === 'function' ? stage.stats() : null;
      if (snap && Array.isArray(snap.animations) && snap.animations.length) return snap.animations;
    } catch { /* 继续兜底 */ }
    try {
      const l2d = window.__WEB__ && window.__WEB__.live2d;
      const st = l2d && l2d.bridge && typeof l2d.bridge.readState === 'function' ? l2d.bridge.readState() : null;
      const arr = st && (st.motions || st.animations);
      if (Array.isArray(arr)) return arr.map((m) => (typeof m === 'string' ? m : m && (m.name || m.id))).filter(Boolean);
    } catch { /* 无 Live2D 就到此为止 */ }
    return [];
  };
  let list = [];
  try { list = pickList(); } catch { list = []; }
  box.replaceChildren();
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'ctl-note';
    p.textContent = state.selectedModel ? '该模型没有动作' : '选中模型后显示';
    box.append(p);
    return 0;
  }
  // 当前播放中的动作：以播放条那个动作用下拉为准（它是唯一真相，模型换了也会同步）
  const current = (document.querySelector('#transport-motion') || {}).value || null;
  for (const name of list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = name === current ? 'mini-btn is-primary ctl-anim' : 'mini-btn ctl-anim';
    btn.dataset.anim = name;
    btn.textContent = name;
    btn.addEventListener('click', () => { applyTransportMotion(name); refreshPanelAnimations(); });
    box.append(btn);
  }
  return list.length;
}

/** 帧率读数：把舞台实测帧率刷到面板上（500ms 一次；无舞台或未就绪时显示 —） */
function startFpsReadout(panel) {
  if (!panel || typeof panel.setFps !== 'function') return;
  /** Live2D 的实测帧率来自 PIXI ticker（FPS 是它自己统计的），Spine 的来自舞台 stats */
  const live2dFps = () => {
    try {
      const l2d = window.__WEB__ && window.__WEB__.live2d;
      if (!l2d || typeof l2d.isActive !== 'function' || !l2d.isActive()) return null;
      const app = typeof l2d.getApp === 'function' ? l2d.getApp() : null;
      const v = app && app.ticker ? app.ticker.FPS : null;
      return typeof v === 'number' && isFinite(v) ? v : null;
    } catch { return null; }
  };
  const tick = () => {
    const l2d = live2dFps();
    if (l2d !== null) { panel.setFps(l2d); return; }
    const st = stage && stage.stats ? stage.stats() : null;
    panel.setFps(st && typeof st.fps === 'number' ? st.fps : null);
  };
  tick();
  setInterval(tick, 500);
}
/** 装配完成后注入面板桥：恢复默认需要"按面板声明的默认值重放一遍" */
// 导入项目配置后要重载资源根与名册树：实现在 app/model-actions.js，
//   用钩子注入（那边反过来要用 rebuildPanelFor），保持单向依赖
let reloadAppHook = null;
export function connectReloadApp(fn) {
  if (typeof fn === 'function') reloadAppHook = fn;
}

connectShellControls({
  applyPanelSetting: (id, value) => applyPanelSetting(id, value),
  getPanelDefaults: () => (state.panel && state.panel.defaults) || {},
  reloadApp: () => (typeof reloadAppHook === 'function' ? reloadAppHook() : null),
  applyViewerPrefs: (prefs) => {
    applyTheme(prefs.uiTheme || 'dark-cyan');
    applyBackground((prefs.background && prefs.background.mode) || 'checkerboard');
    const kw = typeof prefs.partFilterKeywords === 'string' && prefs.partFilterKeywords.trim()
      ? prefs.partFilterKeywords.split(',').map((k) => k.trim()).filter(Boolean)
      : DEFAULT_PART_FILTER_KEYWORDS.slice();
    applyPartFilter({ enabled: prefs.partFilterEnabled === true, keywords: kw });
    if (state.panel && state.panel.setValue) {
      state.panel.setValue('ctl-theme', state.viewTheme);
      state.panel.setValue('ctl-bg-mode', state.viewBg);
    }
  },
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
