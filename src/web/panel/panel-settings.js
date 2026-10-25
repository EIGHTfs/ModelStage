// panel/panel-settings.js —— 面板的"生效表 + 三态装配"
//
// 三件事集中在这里，避免 main.js 继续膨胀：
//   ① SHELL_APPLIERS：与渲染器无关的控件怎么落地；其余设置一律经 renderer.setSetting 下发
//   ② applyPanelSetting：控件回调的唯一入口（含"回显生效值"与"不支持则回退"）
//   ③ rebuildPanelFor：按当前渲染器能力重算三态 + 重跑能力自检（契约 INV-05）

import { dom, stage, state } from '../app/context.js';
import { resetStage, trackElementStage } from '../infra/ready.js';
import { rendererSupports, setRendererSetting } from '../app/renderer-setting.js';
import * as uiState from '../app/ui-state.js';
import { stageLog, stageStatus } from '../app/status.js';
import { PANEL_GROUPS, applyCapabilities, selfCheck, settingKeyOf } from './schema.js';
import { mountPanel } from './view.js';
import { applyDebugLog, applyHangGuard, applyShowStatus, connectShellControls, runSettingsAction } from './shell-controls.js';
import { applyBackground, applyTheme, readViewSettings, saveViewSettings } from '../app/view-settings.js';
import { refreshBackgrounds, refreshSolids } from './background-list.js';
import { applyAnimLoop, applyTransportMotion } from '../app/transport-actions.js';
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
 *   皮肤虽然也由外壳记住偏好，但**落地一律经 renderer.setSetting**（契约 INV-01）。
 *   其它设置项同理——面板层不得直接调用舞台的 set 方法。
 *
 * 注：`ctl-mix-mode` / `ctl-skin-mix` / `ctl-part-filter` / `ctl-part-filter-reset`
 *   已从面板移除（混合过渡统一由「播放 → 混合时长」一个滑块控制，部件筛除整项下线），
 *   对应的映射表条目一并删除；底层 setMixMode / setMixTime 保留（部件筛除整项已下线，底层也删）。
 */
const SHELL_APPLIERS = {
  'ctl-theme': (v) => applyTheme(v),
  'ctl-bg-mode': (v) => applyBackground(v),
  'ctl-anim-loop': (v) => applyAnimLoop(v),
  // 皮肤切换同样经渲染器（INV-01）：Live2D 面没声明 skin ⇒ 不会打到隐藏的 spine 舞台
  'ctl-skin-list': (v) => setRendererSetting('skin', v),
  'ctl-hang-guard': (v) => applyHangGuard(v),
  'ctl-show-status': (v) => applyShowStatus(v),
  'ctl-debug-log': (v) => applyDebugLog(v),
  'ctl-settings-io': (v) => runSettingsAction(v),
};

/**
 * **一次性动作控件**：点击即执行、本身没有"状态"的那类按钮组（schema 里 kind==='actions'）。
 *
 * 为什么必须排除在持久化之外（真 bug 的成因）：这类控件如果被 rememberPanelSetting 存下来，
 *   启动回放 restorePanelSettings 会把它**再执行一次**——
 *     导出设置 ⇒ 每次刷新都自动下载一份设置；
 *     导入设置 ⇒ 每次刷新弹一次文件选择器；
 *     恢复默认 ⇒ 每次刷新把用户设置清掉。
 *   判据按 schema 的数据形状推导（kind==='actions'），不手写 id 名单：以后再加动作组自动被排除。
 */
const ONE_SHOT_IDS = (() => {
  const ids = new Set();
  for (const group of PANEL_GROUPS) {
    for (const ctl of (group && group.controls) || []) {
      if (ctl && ctl.kind === 'actions' && ctl.id) ids.add(String(ctl.id));
    }
  }
  return ids;
})();

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
// S2 起：启动不再"先回放默认值再读回"，默认值由工厂 loadAll 一次性补齐，
//   因此原来那套 suspendPanelPersist 旁路开关已删除（写盘只有工厂一条路径，契约 R1）。

/**
 * 记住一项面板设置（**唯一写入口**，契约 R1）。
 * 去抖落盘、校验回落默认、写 dataset 都在工厂里，这里不重复实现。
 * @param {string} id
 * @param {unknown} value
 */
function rememberPanelSetting(id, value) {
  // 一次性动作不记（见 ONE_SHOT_IDS：记了就会在下次启动回放时重放）
  if (ONE_SHOT_IDS.has(String(id))) return;
  uiState.set(id, value);
}

/**
 * 启动时把上次保存的面板设置读回并应用。
 *
 * 契约 R2：读回必须是**纯内存**的一步（工厂 loadAll），应用与显示重放交给 applyAll。
 * @param {Set<string>} [skipIds] 有专门恢复通道的项（STARTUP_SKIP：主题/背景/MSAA）
 * @returns {number} 读回的项数
 */
export function restorePanelSettings(skipIds) {
  const skip = skipIds instanceof Set ? skipIds : new Set(skipIds || []);
  // 历史脏数据迁移：旧版本把一次性动作控件也存进了 panel（"导出过设置后每次刷新又导出一次"）。
  //   就地清掉并写回存储，否则每次启动都要绕一遍。
  try {
    const saved = (readViewSettings().panel) || {};
    const stale = Object.keys(saved).filter((id) => ONE_SHOT_IDS.has(id));
    if (stale.length) {
      for (const id of stale) delete saved[id];
      try { saveViewSettings({ panel: { ...saved } }); } catch { /* 存储不可用就只跳过 */ }
      stageLog('warn', '已清理面板设置里的一次性动作记录（旧版本遗留，会导致每次启动重放）', { removed: stale });
    }
  } catch { /* 迁移失败不影响读回 */ }

  uiState.setApplySkip(skip);
  const info = uiState.loadAll();          // 纯内存读回（在首次面板渲染之后调用时，值仍会覆盖显示态）
  uiState.applyAll({ render: true });      // 生效 + 重放显示态（幂等）
  if (info.rejected.length) {
    stageLog('warn', '面板设置里有非法值，已回落默认', { rejected: info.rejected });
  }
  return info.loaded;
}

/** 面板控件回调：外壳项直接处理，其余一律经 renderer.setSetting（回显用生效值） */
function applyPanelSetting(id, value) {
  // 一次性动作（导出/导入/恢复默认）：执行，不进持久化（ONE_SHOT_IDS 已在工厂侧双保险）
  if (ONE_SHOT_IDS.has(String(id))) { runSettingsAction(value); return; }
  // 其余一律经工厂：校验 → apply（生效）→ render（显示）→ 去抖落盘。
  //   这样"谁是真相"只有一处（契约 R1），也就不会出现"值对但显示错"。
  uiState.set(id, value);
}

/**
 * 只负责**生效**（下发给外壳实现或渲染器），不落盘、不碰显示态。
 * 由工厂的 apply() 调用 ⇒ 契约 R3 的 apply/render 分离。
 * @param {string} id
 * @param {unknown} value
 */
function applyCore(id, value) {
  const shell = SHELL_APPLIERS[id];
  if (shell) {
    // 外壳项里也有"依赖渲染面能力"的（皮肤/混合模式/部件筛除）：
    //   渲染器没声明该键 ⇒ 直接拒绝并留痕，不静默无效（面板本身已把它置灰）
    const cap = settingKeyOf(id);
    const needKey = cap ? (cap.kind === 'debug' ? `debug:${cap.capabilityKey}` : cap.settingKey) : null;
    if (needKey && !rendererSupports(needKey)) {
      // 同上：能力不支持时该控件不会出现在面板里，这条告警没有可对应的用户操作 ⇒ 静默拒绝
      return;
    }
    shell(value);
    return;
  }
  const cap = settingKeyOf(id);
  const renderer = state.currentRenderer;
  const key = cap ? (cap.kind === 'debug' ? `debug:${cap.capabilityKey}` : cap.settingKey) : null;
  if (!key || !renderer || typeof renderer.setSetting !== 'function') {
    stageLog('warn', `当前渲染器不支持该项设置：${id}`, { id, renderer: state.currentRenderer && state.currentRenderer.id, reason: !key ? 'no-setting-key' : 'renderer-cannot-set' });
    return;
  }
  let ok = false;
  try { ok = renderer.setSetting(key, value) === true; } catch { ok = false; }
  // 生效值回显（不是请求值）：契约 INV-08
  let applied = null;
  try { applied = renderer.getSetting ? renderer.getSetting(key) : null; } catch { applied = null; }
  if (!ok) {
    stageLog('warn', `渲染器不支持设置 ${key}（已回退到生效值 ${String(applied)}）`, { id, key, requested: value, applied });
    if (applied !== null) uiState.commit(id, applied, { render: true });
    return;
  }
  // 生效值可能被渲染器钳制（INV-08）：把**生效值**记进工厂（commit=只记录不重发，防自递归）
  const effective = applied === null ? value : applied;
  if (effective !== value) uiState.commit(id, effective, { render: true });
}
// ---------------------------------------------------------------- 工厂装配（契约 R3）
/** id → 控件声明（render 需要知道形态：开关用 setChecked，其余用 setValue） */
const CTL_BY_ID = new Map();
for (const group of PANEL_GROUPS) {
  for (const ctl of (group && group.controls) || []) {
    if (ctl && ctl.id) CTL_BY_ID.set(String(ctl.id), ctl);
  }
}

/**
 * 把值重放到**当前已存在的 DOM**（契约 R3 的 render）。
 * 幂等：可以在每次面板重建后反复调用；`state.panel` 还没建好时静默跳过。
 * @param {string} id
 * @param {unknown} value
 */
function renderControl(id, value) {
  if (!state.panel) return;
  const ctl = CTL_BY_ID.get(String(id));
  if (ctl && ctl.kind === 'switch' && typeof state.panel.setChecked === 'function') {
    state.panel.setChecked(id, value === true);
    return;
  }
  if (typeof state.panel.setValue === 'function') state.panel.setValue(id, value);
}

// 注册全部"有状态"控件：apply 只负责生效，render 只负责显示（两者失败模式不同，见契约 R3）
uiState.registerAppliers(Object.fromEntries(
  uiState.SPEC.map((it) => [it.id, {
    apply: (v) => applyCore(it.id, v),
    render: (v) => renderControl(it.id, v),
  }]),
));

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

/** 就绪信号：panel 阶段的跟踪句柄（面板每次重建都会重新起算，旧句柄要先停） */
let panelStageStop = null;

/**
 * 就绪信号 panel 阶段（埋点，不改面板逻辑）。
 * interactive 的附加判据（契约要求）：
 *   · 当前渲染器**声明内**的控件都已构建：state.panelWired 里的每个 id 都能在 DOM 里找到
 *     （panelWired 本身就是"实际构建出来的已接线控件"，两者互证，避免"报绿但少控件"）
 *   · ctl-anim-list 已有内容或明确空态（空态是 .ctl-list-empty 提示，不是空白容器）
 */
function trackPanelStage() {
  if (panelStageStop) { try { panelStageStop(); } catch { /* 忽略 */ } panelStageStop = null; }
  resetStage('panel');   // 换渲染器/重建面板 ⇒ 控件集合变了，必须从 mounted 重新走三级
  panelStageStop = trackElementStage({
    name: 'panel',
    el: dom.panelBody,
    timeoutMs: 12000,
    interactiveProbe: () => {
      const built = [...document.querySelectorAll('#right-panel [data-ctl]')].map((n) => n.dataset.ctl);
      const wired = Array.isArray(state.panelWired) ? state.panelWired : [];
      const missing = wired.filter((id) => !built.includes(id));
      const box = document.querySelector('#right-panel [data-ctl="ctl-anim-list"]');
      const rows = box ? [...box.children].filter((n) => !n.classList.contains('ctl-list-empty')).length : 0;
      const emptyHint = !!(box && box.querySelector('.ctl-list-empty'));
      const animOk = !!box && (rows > 0 || emptyHint);
      return {
        ok: wired.length > 0 && missing.length === 0 && animOk,
        detail: { wired: wired.length, built: built.length, missing: missing.length, animRows: rows, animEmptyHint: emptyHint },
      };
    },
  });
}

function rebuildPanelFor(renderer) {
  const groups = applyCapabilities(PANEL_GROUPS, renderer && renderer.capabilities, {
    onWarn: (message) => stageLog('warn', message, { source: 'panel-selfcheck' }),
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
    // 首次渲染就显示用户值（契约 R2）：工厂里已经有 loadAll 读回的值
    initialValue: (id) => uiState.getValue(id),
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
  // 契约 §三/§3.1（**唯一汇聚点**）：面板 DOM 刚被重建 ⇒ 当前 DOM 的显示态全是 schema 默认值，
  //   必须立刻按工厂里的生效值重放一次，否则「引擎在循环、开关显示关」会再次出现。
  try { document.dispatchEvent(new CustomEvent('panel:rebuilt')); } catch { /* 无 DOM 环境忽略 */ }
  try { uiState.applyAll({ render: true }); } catch { /* 回填失败不影响面板可用 */ }
  refreshSkinHook();
  // 自定义背景图列表：面板重建后重新拉一次（切面/重开面板都会走到这里）
  refreshBackgrounds().catch(() => { /* 列表拉取失败只是少一块内容，不影响面板其余部分 */ });
  refreshSolids().catch(() => { /* 同上：纯色预设取不到不阻塞面板 */ });
  state.panelSnapshot = panelSnapshot();
  const check = selfCheck(renderer || {});
  state.panelSelfCheck = check;
  document.documentElement.dataset.selfCheck = check.passed ? 'pass' : 'fail';
  if (!check.passed) {
    stageLog('error', `能力自检未通过：${check.violations.map((v) => `${v.key}（${v.actual}）`).join('、')}`, { violations: check.violations });
  }
  trackPanelStage();   // 就绪信号：面板构建完毕 → 三级跟踪（mount/稳定/可交互）
  return check;
}
// 应用层请求"重绘动作列表"（如底栏自绘下拉选中后）——用事件解耦，避免 app⇄panel 循环依赖。
if (typeof document !== 'undefined') {
  document.addEventListener('panel:refresh-animations', () => {
    try { refreshPanelAnimations(); } catch { /* 重绘失败不影响播放 */ }
  });
}

// 列表里点了某张图设为背景 → 「背景模式」档位同步到「自定义」（视觉一致，不是另存一套状态）
if (typeof document !== 'undefined') {
  document.addEventListener('panel:bg-applied', (ev) => {
    const mode = (ev && ev.detail && ev.detail.mode) || 'custom';
    try { if (state.panel && state.panel.setValue) state.panel.setValue('ctl-bg-mode', mode); } catch { /* 忽略 */ }
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
  // 下拉可能刚被填好（首次打开时为空）——按最终值补一次高亮，避免"首屏没有当前项"。
  //
  // 取值的优先级为什么不是 currentAnimationId()：它**优先读 state.transportMotion 这个缓存**
  //   （见 anim-list.js 的实现）。而缓存只有"用户手动选动作"时才会被写；换模型时没人同步它，
  //   于是它仍停在上一个模型的 id。实测：换模型后底栏已显示 idle，缓存却还是上一模型的 "3"，
  //   新清单里没有 "3" ⇒ 一圈都匹配不上 ⇒ 右栏一个 aria-pressed="true" 都没有（底栏正常、刷新页面正常）。
  // 正确口径：**底栏下拉才是"当前动作"的唯一真相（契约 §七）**，缓存只是它的副本。
  //   所以顺序改为「底栏值 → 缓存值 → 清单首项」，且候选必须真的落在本清单里（否则宁可不选）。
  const listIds = new Set(list.map((x) => String(x.id)));
  const pickerValue = (() => {
    const transport = state && state.transport;
    if (!transport || typeof transport.picker !== 'function') return '';
    const pk = transport.picker('transport-motion');
    return pk && typeof pk.value === 'function' ? String(pk.value() || '') : '';
  })();
  const finalId = [pickerValue, String(currentAnimationId() || ''), String(list[0] ? list[0].id : '')]
    .find((v) => v && listIds.has(v)) || '';
  // 缓存与真相对齐（下次任何读"当前动作"的地方都不会再拿到上一个模型的 id）
  if (finalId && state) state.transportMotion = finalId;
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
