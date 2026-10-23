// panel/panel-settings.js —— 面板的"生效表 + 三态装配"
//
// 三件事集中在这里，避免 main.js 继续膨胀：
//   ① SHELL_APPLIERS：与渲染器无关的控件怎么落地；其余设置一律经 renderer.setSetting 下发
//   ② applyPanelSetting：控件回调的唯一入口（含"回显生效值"与"不支持则回退"）
//   ③ rebuildPanelFor：按当前渲染器能力重算三态 + 重跑能力自检（契约 INV-05）

import { dom, stage, state } from '../app/context.js';
import { rendererSupports, setRendererSetting } from '../app/renderer-setting.js';
import { stageStatus } from '../app/status.js';
import { PANEL_GROUPS, applyCapabilities, selfCheck, settingKeyOf } from './schema.js';
import { mountPanel } from './view.js';
import { applyDebugLog, applyHangGuard, applyShowStatus, connectShellControls, runSettingsAction } from './shell-controls.js';
import { applyBackground, applyTheme, readViewSettings, saveViewSettings } from '../app/view-settings.js';
import { DEFAULT_PART_FILTER_KEYWORDS, applyPartFilter } from '../app/part-filter.js';
import { applyAnimLoop, applyMixMode, applySkinMix, applyTransportMotion } from '../app/transport-actions.js';
import { repaintActive } from '../render/playback.js';
import {
  buildAnimationList, currentAnimationId, durationText, labelWithDuration, onCycleAdvance,
  primeAnimationDurations, syncTransportOptions,
} from '../app/anim-list.js';

/**
 * 皮肤列表刷新钩子：它依赖"当前模型"，实现在 model-actions 里（那边反过来要用 rebuildPanelFor），
 * 用钩子注入把这条双向依赖拆成单向：model-actions → panel-settings。
 */
let refreshSkinHook = () => {};
export function connectPanelRefresh(fn) {
  if (typeof fn === 'function') refreshSkinHook = fn;
}

/**
 * 外壳自己处理的控件：主题/背景走 CSS 与 Surface（与渲染器无关）；
 *   皮肤、混合模式、部件筛除虽然也由外壳记住偏好，但**落地一律经 renderer.setSetting**（契约 INV-01）。
 *   其它设置项同理——面板层不得直接调用舞台的 set 方法。
 */
const SHELL_APPLIERS = {
  'ctl-theme': (v) => applyTheme(v),
  'ctl-bg-mode': (v) => applyBackground(v),
  'ctl-mix-mode': (v) => applyMixMode(v),
  'ctl-anim-loop': (v) => applyAnimLoop(v),
  'ctl-skin-mix': (v) => applySkinMix(v),
  // 皮肤切换同样经渲染器（INV-01）：Live2D 面没声明 skin ⇒ 不会打到隐藏的 spine 舞台
  'ctl-skin-list': (v) => setRendererSetting('skin', v),
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

/**
 * 记住一项面板设置并落盘（刷新后保持）。
 * 与视图偏好共用同一存储键的 panel 字段：一处读写，避免两套持久化各说一套。
 */
/** 启动回放默认值时暂停落盘：否则默认值会覆盖用户上次保存的设置 */
let persistSuspended = false;
export function suspendPanelPersist(on) {
  persistSuspended = !!on;
}

function rememberPanelSetting(id, value) {
  state.panelSettings = { ...(state.panelSettings || {}), [id]: value };
  document.documentElement.dataset.panelSetting = JSON.stringify(state.panelSettings);
  if (persistSuspended) return; // 回放阶段不落盘，避免默认值覆盖用户保存值
  try { saveViewSettings({ panel: { ...state.panelSettings } }); } catch { /* 存储不可用就只保留内存态 */ }
}

/** 启动时把上次保存的面板设置重新应用一遍（跳过有专门恢复通道的项） */
export function restorePanelSettings(skipIds) {
  const saved = (readViewSettings().panel) || {};
  const skip = skipIds instanceof Set ? skipIds : new Set();
  for (const [id, value] of Object.entries(saved)) {
    if (skip.has(id)) continue;
    try { applyPanelSetting(id, value); } catch { /* 单项失败继续 */ }
  }
  return Object.keys(saved).length;
}

/** 面板控件回调：外壳项直接处理，其余一律经 renderer.setSetting（回显用生效值） */
function applyPanelSetting(id, value) {
  const shell = SHELL_APPLIERS[id];
  if (shell) {
    // 外壳项里也有"依赖渲染面能力"的（皮肤/混合模式/部件筛除）：
    //   渲染器没声明该键 ⇒ 直接拒绝并留痕，不静默无效（面板本身已把它置灰）
    const cap = settingKeyOf(id);
    const needKey = cap ? (cap.kind === 'debug' ? `debug:${cap.capabilityKey}` : cap.settingKey) : null;
    if (needKey && !rendererSupports(needKey)) {
      stageStatus(`当前渲染面未声明能力「${needKey}」，${id} 不可用`, 'warn');
      return;
    }
    shell(value);
    rememberPanelSetting(id, value);
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
  rememberPanelSetting(id, applied === null ? value : applied);
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
/**
 * 把「实建的已接线集合」挂给自动化断言。
 * 用 getter 覆盖而不是直接赋值：`__WEB__` 由 main.js 在 boot 后段才建好、并且会用全量
 *   WIRED_IDS 再赋一次；直接赋值会被那次覆盖（断言因此拿到已隐藏的 ctl-mix-mode）。
 * @param {number} [tries] 剩余重试次数（等 __WEB__ 出现）
 */
function exposePanelWired(tries = 20) {
  if (typeof window === 'undefined') return;
  const web = window.__WEB__;
  if (!web) {
    if (tries > 0) setTimeout(() => exposePanelWired(tries - 1), 0);
    return;
  }
  try {
    Object.defineProperty(web, 'panelWired', {
      configurable: true,
      get: () => state.panelWired || [],
      set: () => { /* 外部整体赋值忽略：真相在 state.panelWired */ },
    });
  } catch { /* 无法覆盖就保持原样 */ }
}

function rebuildPanelFor(renderer) {
  const groups = applyCapabilities(PANEL_GROUPS, renderer && renderer.capabilities, {
    onWarn: (message) => stageStatus(message, 'warn'),
  });
  document.documentElement.dataset.panelGroups = String(groups.length);
  const info = mountPanel({
    groups,
    headEl: dom.panelHead,
    bodyEl: dom.panelBody,
    // 面板控件回调统一入口 + 暂停补帧：面板里的设置是**直调 renderer.setSetting**（不经
    //   app/renderer-setting.js），所以补帧必须挂在这一层，否则暂停中改设置"改了看不见"。
    onSetting: (id, value) => {
      applyPanelSetting(id, value);
      if (state.playing === false) { try { repaintActive(state.surface); } catch { /* 忽略 */ } }
    },
    wiredIds: WIRED_IDS,
  });
  // 先把句柄补完，再暴露 state.panel。
  //   为什么顺序重要：设置下拉的同步会**触发面板重建**，重建期间若 state.panel 指向
  //   一个"还没挂 refreshAnimations"的半成品，调用方一检查 typeof 就跳过，表现为
  //   "点了底栏、右栏高亮不动，且没有任何报错"（实测踩过）。
  info.refreshAnimations = () => refreshPanelAnimations();
  state.panel = info;
  // 暴露"实际构建出来的已接线控件"：能力不支持的项根本不构建（契约 §3.1），
  //   所以 panelWired 不能直接给全量 WIRED_IDS，否则断言会拿面板里不存在的 id 去比。
  const builtIds = [...document.querySelectorAll('#right-panel [data-ctl]')].map((n) => n.dataset.ctl);
  state.panelWired = WIRED_IDS.filter((id) => builtIds.includes(id));
  exposePanelWired();
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
// 应用层请求"重绘动作列表"（如底栏自绘下拉选中后）——用事件解耦，避免 app⇄panel 循环依赖。
if (typeof document !== 'undefined') {
  document.addEventListener('panel:refresh-animations', () => {
    try { refreshPanelAnimations(); } catch { /* 重绘失败不影响播放 */ }
  });
}

/**
 * 底栏下拉变化 → 右栏高亮跟随（契约 §七：当前动作的唯一真相是下拉的值）。
 * 为什么不只在应用层回调里刷：change 事件派发时下拉的值可能尚未落定，
 *   当场重绘会读到旧值；这里挂独立监听并在下一拍重绘，两条路径互不依赖。
 */
let transportWatcherBound = false;
function bindTransportMotionWatcher() {
  if (transportWatcherBound) return;
  const sel = document.querySelector('#transport-motion');
  if (!sel) return;
  sel.addEventListener('change', () => {
    setTimeout(() => { try { refreshPanelAnimations(); } catch { /* 忽略 */ } }, 0);
  });
  transportWatcherBound = true;
}

/**
 * 刷新右栏「动作列表」：与底栏同一份清单（同顺序、同文案、同时长），点一条即播。
 * 高亮跟随底栏下拉的值（契约 §七：当前动作只有一处真相）。
 * @returns {number} 列出的条数
 */
/**
 * 造一行动作（样式照旧端：左名称溢出省略 + 右时长等宽小字，选中主色描边）。
 * 单独成函数：列表重绘逻辑本身要保持在可读范围，行构造细节拆出来。
 * @param {{id: string, label: string, duration: number|null}} anim
 * @param {string} currentId 当前播放中的动作 id
 * @returns {HTMLButtonElement}
 */
function buildAnimRow(anim, currentId) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'ctl-list-row ctl-anim';
  row.dataset.anim = anim.id;
  row.setAttribute('aria-pressed', String(anim.id === currentId));
  const name = document.createElement('span');
  name.className = 'ctl-list-name';
  name.textContent = anim.label;
  row.append(name);
  const timeText = durationText(anim.duration);
  if (timeText) { // 时长取不到就不显示（契约 §二禁止 0s / — 冒充）
    const time = document.createElement('span');
    time.className = 'ctl-list-time';
    time.textContent = timeText;
    row.append(time);
  }
  row.title = anim.id + (timeText ? `（${timeText}）` : '（时长未知）');
  row.addEventListener('click', () => { applyTransportMotion(anim.id); refreshPanelAnimations(); });
  return row;
}

export function refreshPanelAnimations() {
  const box = document.querySelector('#right-panel [data-ctl="ctl-anim-list"]');
  // 诊断：记录"进来了/box 是否存在/清单条数"，出现"调了没反应"时一眼看出卡在哪一步
  document.documentElement.dataset.refreshEnter = box ? '1' : '0';
  if (!box) return 0;
  const list = buildAnimationList();
  document.documentElement.dataset.refreshListLen = String(list.length);
  const currentId = currentAnimationId();
  box.replaceChildren();
  box.classList.add('ctl-list'); // 容器行样式（旧端 space-y-1 / max-h-48 / overflow-y-auto）
  if (!list.length) {
    const hint = document.createElement('p');
    hint.className = 'ctl-list-empty'; // 旧端空态：居中弱化小字
    hint.textContent = state.selectedModel ? '该模型没有动作' : '选中模型后显示';
    box.append(hint);
    return 0;
  }
  for (const anim of list) box.append(buildAnimRow(anim, currentId));
  // 同一份清单同步底栏下拉（契约 §一/§三：两处必须逐项一致）
  syncTransportOptions();
  bindTransportMotionWatcher();
  // 下拉可能刚被填好（首次打开时为空）——按最终值补一次高亮，避免"首屏没有当前项"
  const finalId = currentAnimationId();
  // 记录"这次重绘用的 id"：出现"高亮被刷回去"时，看一眼最后一次用的值就能定性
  document.documentElement.dataset.lastRefreshId = String(finalId || '');
  if (finalId) {
    // 选中态统一用 aria-pressed（样式在 panel.css 的 .ctl-list-row[aria-pressed='true']）
    for (const btn of box.querySelectorAll('[data-anim]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.anim === finalId));
    }
  }
  // 循环推进后由应用层回调重绘（不轮询 DOM）
  onCycleAdvance(() => refreshPanelAnimations());
  // 有缺时长的条目就预热一次（Live2D：读动作文件 Meta.Duration；取到后自动再刷一遍）
  if (list.some((x) => !durationText(x.duration))) {
    primeAnimationDurations().then((n) => { if (n > 0) refreshPanelAnimations(); }).catch(() => {});
  }
  return list.length;
}

/** 帧率读数：把舞台实测帧率刷到面板上（500ms 一次；无舞台或未就绪时显示 —） */
function startFpsReadout(panel) {
  if (!panel || typeof panel.setFps !== 'function') return;
  /**
   * Live2D 面的实测帧率取自**渲染器统计的实际出画帧数**（getMeasuredFps）。
   *
   * 为什么不再用 `app.ticker.FPS`：那是 rAF/ticker 的触发频率，不是渲染次数。渲染被门控跳过时
   *   tick 照样发生，用它显示会恒等于屏幕刷新率——"上限 60 却显示 89"里就有一部分来自这个读数失真。
   *   （Spine 面本来就是引擎按实际渲染帧统计，读数口径正确。）
   */
  const live2dFps = () => {
    try {
      // 取**当前激活的真实渲染器**（state.currentRenderer 是门面，只转发固定几个方法，
      //   不含 getMeasuredFps；activeRenderer() 拿到的才是带门控计数的那个实例）
      const r = (state.surface && typeof state.surface.activeRenderer === 'function')
        ? state.surface.activeRenderer()
        : state.currentRenderer;
      if (r && typeof r.getMeasuredFps === 'function') {
        const v = r.getMeasuredFps();
        if (typeof v === 'number' && isFinite(v) && v > 0) return v;
      }
      // 兜底：渲染器没提供时回退 ticker.FPS（会偏高，仅供观察，不能用于验收）
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

export {
  SHELL_APPLIERS, WIRED_IDS, applyPanelSetting, panelSnapshot, rebuildPanelFor, startFpsReadout,
};
