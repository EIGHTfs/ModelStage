// panel/panel-settings.js —— 面板的"生效表 + 三态装配"
//
// 三件事集中在这里，避免 main.js 继续膨胀：
//   ① SHELL_APPLIERS：与渲染器无关的控件怎么落地；其余设置一律经 renderer.setSetting 下发
//   ② applyPanelSetting：控件回调的唯一入口（含"回显生效值"与"不支持则回退"）
//   ③ rebuildPanelFor：按当前渲染器能力重算三态 + 重跑能力自检（契约 INV-05）

import { dom, stage, state } from '../app/context.js';
import { refreshPanel } from '../app/memory-bars.js';
import { bindPanelBarRefresh } from '../app/memory-bars.js';
import { resetStage, trackElementStage } from '../infra/ready.js';
import { rendererSupports, setRendererSetting } from '../app/renderer-setting.js';
import * as uiState from '../app/ui-state.js';
import { stageLog, stageStatus } from '../app/status.js';
import { PANEL_GROUPS, applyCapabilities, mergeSlotControls, selfCheck, settingKeyOf } from './schema.js';
import { activeChain } from '../engine/effect-chain.js';
import { mountPanel } from './view.js';
import { syncPluginToolbar } from './toolbar.js';
import { applyDebugLog, applyHangGuard, applyMemoryGuard, applyShowStatus, connectShellControls, runSettingsAction } from './shell-controls.js';
import { applyBackground, applyTheme, readViewSettings, saveViewSettings } from '../app/view-settings.js';
import { bindBgGroupToggle, refreshBgSources } from './background-list.js';
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
  // 内存保护与防卡死保护是两件事：前者管内存容量（防 OOM），后者管帧停滞（防假死）
  'ctl-memory-guard': (v) => applyMemoryGuard(v),
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
/**
 * 插槽控件的动作回调表：控件 id → { pluginId, fn }。
 * 每次重建面板时刷新（控件随插件装载/卸载出现或消失）。
 */
const slotActions = new Map();

/**
 * 插件声明设置项的**当前快照**（当前值 ?? 清单里的 default）。
 * 为什么由面板侧构造：值存在 uiState 工厂里，插件宿主读不到；
 *   render(props) 与 onAction(props) 必须看到同一份真相，所以两边共用这个函数。
 * @param {string} pluginId
 * @returns {Record<string, unknown>}
 */
function pluginSettingsSnapshot(pluginId) {
  const host = state.pluginHost;
  const decls = host && typeof host.pluginSettings === 'function' ? host.pluginSettings(pluginId) : [];
  const out = {};
  for (const d of decls) {
    if (!d || !d.key) continue;
    const cur = uiState.getValue(d.key);
    out[d.key] = (cur === undefined || cur === null) ? d.default : cur;
  }
  return out;
}

/**
 * 构造插槽回调的 owner props（设计 §4.1）。
 * 现阶段：settings 真实值 + setSetting；geometry/activeSurface/document 先给 null，
 *   S4 换成 getter（resize / 换模型 / 换面后值会变，快照会陈旧）。
 * @param {{pluginId?: string}} entry
 * @returns {object}
 */
/**
 * 控件 id → **存值键**（`spec.setting` 给定时是清单设置键，否则就是控件 id）。
 * 每次重建刷新：控件（连同它的 setting）随插件装载/卸载出现或消失。
 */
const slotStoreKeyById = new Map();

/**
 * **反向表**：设置键 → 绑定它的控件 id 数组。
 *
 * 为什么需要：一个设置键可能被**多个控件**绑定（同一个值用两种形态展示），
 *   也可能被程序化写入（另一个控件、setSetting、恢复预设）。
 *   只维护 ctl→key 的话，"外部改了这个键"没有任何控件会重绘，界面停在旧值。
 * 为什么是数组：不做一对一假设（实测夹具里就挂了两个控件）。
 */
const slotCtlIdsByKey = new Map();

/** 本 tick 待重绘的控件 id（同一控件被 ctl id 与 key 两条路径同时命中时只重绘一次） */
const repaintPending = new Set();
let repaintScheduled = false;
/** 重绘计数（验收可读：每个控件实际重绘了几次） */
const repaintStats = { total: 0, byId: new Map() };

/** 把重绘计数挂到 window，供验收/排障读取（不写 dataset，避免污染 outerHTML 快照） */
function publishRepaintStats() {
  try {
    if (typeof window === 'undefined') return;
    window.__PANEL_REPAINT__ = {
      total: repaintStats.total,
      byId: Object.fromEntries(repaintStats.byId),
    };
  } catch { /* 无 window 忽略 */ }
}

/**
 * 安排一次控件重绘（**按 tick 合并**）。
 *
 * 去重方式：同一 microtask 内对同一个控件只重绘一次 —— 这样
 *   "外部改设置键" 与 "控件自己的 id 也被写" 两条路径同时命中时不会闪两下、计数也是 1。
 * @param {string} id 控件 id
 */
function scheduleControlRepaint(id) {
  const key = String(id || '');
  if (!key) return;
  repaintPending.add(key);
  if (repaintScheduled) return;
  repaintScheduled = true;
  const flush = () => {
    repaintScheduled = false;
    const ids = [...repaintPending];
    repaintPending.clear();
    for (const ctlId of ids) {
      try {
        const value = uiState.getValue(storeKeyOf(ctlId));
        const row = typeof document !== 'undefined'
          ? document.querySelector(`#right-panel [data-ctl="${ctlId}"]`) : null;
        // 节点已经不在了（插件卸载后重建过面板）⇒ 跳过：
        //   applier 注册在 uiState 里撤不掉，靠这条守卫让"已消失的控件"不产生悬空重绘与计数。
        if (!row) continue;
        // 开关按 aria-checked 回填，其余按"选中项"回填（renderControl 用静态表判 kind，插件控件不在表里）
        if (row.querySelector('[role="switch"]')) state.panel.setChecked(ctlId, value === true);
        else state.panel.setValue(ctlId, value);
        repaintStats.total += 1;
        repaintStats.byId.set(ctlId, (repaintStats.byId.get(ctlId) || 0) + 1);
      } catch { /* 单个控件重绘失败不影响其它控件 */ }
    }
    publishRepaintStats();
  };
  if (typeof queueMicrotask === 'function') queueMicrotask(flush);
  else setTimeout(flush, 0);
}

/** 控件 id → 存值键（没有映射就是它自己） */
function storeKeyOf(id) {
  const k = String(id || '');
  return slotStoreKeyById.get(k) || k;
}

/**
 * 构造插槽 owner props（设计 §4.1）—— **全部字段是 getter**，不是快照。
 *
 * 为什么必须是 getter：面板只在"插件装载完成 / 换渲染面"时重建，
 *   resize 与换模型**不会**重建面板（surface.js 有 onResize 但面板没订阅、换模型只刷动作列表）。
 *   快照会让插件读到过期尺寸与过期文档；getter 每次读都取当前值，且不会把 surface/state 的可变引用交出去。
 * @param {{pluginId?: string}} entry
 * @returns {object}
 */
function slotPropsFor(entry) {
  const pluginId = String((entry && entry.pluginId) || '');
  return {
    /** 插件声明设置项的当前值（当前值 ?? 声明默认值），每次读都重新求值 */
    get settings() { return pluginSettingsSnapshot(pluginId); },
    /** 舞台几何：{ cssW, cssH, dpr, res } —— 唯一来源是 surface.geometry() */
    get geometry() {
      try {
        const g = state.surface && typeof state.surface.geometry === 'function' ? state.surface.geometry() : null;
        return g ? { cssW: g.cssW, cssH: g.cssH, dpr: g.dpr } : null;
      } catch { return null; }
    },
    /** 当前渲染面：'spine' | 'live2d' | null */
    get activeSurface() {
      try {
        const r = state.surface && typeof state.surface.activeRenderer === 'function' ? state.surface.activeRenderer() : null;
        return r && r.id ? String(r.id) : null;
      } catch { return null; }
    },
    /** 当前文档的**只读摘要**（不给插件 model 引用：它持有的是可变对象） */
    get document() {
      const m = state.selectedModel;
      if (!m) return null;
      return {
        rootId: m.rootId ? String(m.rootId) : null,
        rel: m.rel ? String(m.rel) : null,
        kind: m.kind ? String(m.kind) : (m.container ? 'bundle' : null),
        files: Array.isArray(m.files) ? m.files.slice() : null,
      };
    },
    /** 插件写设置也走面板同一条通道（校验 → 生效 → 落盘） */
    setSetting(key, value) {
      try { applyPanelSetting(key, value); } catch { /* 插件侧写入失败不影响面板 */ }
    },
  };
}

function applyPanelSetting(id, value) {
  // 一次性动作（导出/导入/恢复默认）：执行，不进持久化（ONE_SHOT_IDS 已在工厂侧双保险）
  if (ONE_SHOT_IDS.has(String(id))) { runSettingsAction(value); return; }
  // 皮肤：**不进值工厂**（它的取值域随模型变，持久化没有意义 —— 见 ui-state 的 SPEC 过滤），
  //   直接下发渲染器。与动作列表同一条思路：面板只负责"把点到的值送出去"。
  if (String(id) === 'ctl-skin-list') {
    const fn = SHELL_APPLIERS[id];
    if (typeof fn === 'function') { try { fn(value); } catch { /* 下发失败保持原皮肤 */ } }
    return;
  }
  // 其余一律经工厂：校验 → apply（生效）→ render（显示）→ 去抖落盘。
  //   这样"谁是真相"只有一处（契约 R1），也就不会出现"值对但显示错"。
  // 插槽控件若声明了 spec.setting，值要落到**清单设置键**（插件 render/onAction 读的才是它）
  uiState.set(storeKeyOf(id), value);
  // 插槽控件：值落地后再派发插件的 onAction（先 onSetting 语义、后回调 —— 顺序固定）
  const act = slotActions.get(String(id));
  if (act) {
    try {
      act.fn({ value, id: String(id) }, slotPropsFor({ pluginId: act.pluginId }));
    } catch (e) {
      // 插件回调抛错**必须隔离**：面板值已经存好，不能因为插件写错就把界面带崩
      stageLog('warn', `插件动作回调抛错（已隔离，面板不受影响）：${(e && e.message) || e}`, { source: 'plugin-slots', id: String(id) });
    }
  }
}

/**
 * 只负责**生效**（下发给外壳实现或渲染器），不落盘、不碰显示态。
 * 由工厂的 apply() 调用 ⇒ 契约 R3 的 apply/render 分离。
 * @param {string} id
 * @param {unknown} value
 */
function applyCore(id, value) {
  // 插件声明了但效果没注册成功 ⇒ 明确拒绝并告知原因（契约 §9.3：绝不静默存值）
  if (PLUGIN_DISABLED_IDS.has(String(id))) {
    stageStatus(`「${id}」暂不可用：对应插件效果未注册成功`, 'warn', { show: true });
    return;
  }
  // 插件效果：①让渲染器记住档位（它是 getSetting 的唯一回读口）②重算整条链下发
  // 顺序/激活/参数换算都在 effect-chain.js，两条链路共用同一套语义。
  if (PLUGIN_EFFECTS.has(String(id))) {
    const r = state.currentRenderer;
    if (r && typeof r.setSetting === 'function') {
      try { r.setSetting(String(id), value); } catch { /* 记档位失败不影响链下发 */ }
    }
    applyPluginEffectChain();
    return;
  }
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

/**
 * 把插件**注册成功**的效果 id 追加进渲染器的能力键白名单（契约 §9.3）。
 *
 * 为什么要拷贝：capabilities 是渲染器自己的对象，直接 push 会把插件效果永久写进它的声明里，
 *   插件被拔掉后白名单还留着 ⇒ 面板能选、渲染层不认（正是"选了没反应"）。
 * @param {object} capabilities 渲染器声明的能力
 * @param {string[]} effectIds 注册成功的插件效果 id
 * @returns {object} 追加后的能力（新对象）
 */
function withPluginCapabilities(capabilities, effectIds) {
  if (!capabilities || !Array.isArray(capabilities.settings) || !effectIds.length) return capabilities;
  return { ...capabilities, settings: [...capabilities.settings, ...effectIds] };
}

/**
 * 已声明但没注册成功的插件控件 id（每次重建时刷新）。
 * 用途：这类控件在面板上是置灰的，正常点不到；但若被程序化调用 setSetting，
 *   契约 §9.3 要求"明确返回不支持"而不是静默存一个永远不会生效的值。
 */
const PLUGIN_DISABLED_IDS = new Set();

/**
 * 插件交完声明后重建一次面板 —— 插件是异步注入的，晚于首次建面板。
 * 幂等：只绑一次。
 */
/**
 * 插件效果的运行期元数据：id → { fragment, params, options }。
 * 顺序即 Map 插入顺序 = 控件节提交顺序 = 清单 effects[] 声明顺序（效果链的叠加顺序）。
 */
const PLUGIN_EFFECTS = new Map();

/**
 * 按当前设置算出生效链并下发给当前渲染器（**Spine / Live2D 同一入口**）。
 *
 * 这里只做"算 + 下发"：顺序/激活/参数换算在 effect-chain.js，挂载方式在各自渲染器。
 * 渲染器内部按结构签名决定"只改 uniform"还是"重建着色器"，所以切档位不会重挂/重新解析。
 * @returns {boolean} 是否成功下发
 */
function applyPluginEffectChain() {
  const renderer = state.currentRenderer;
  if (!renderer || typeof renderer.setEffectChain !== 'function') return false;
  const declared = [...PLUGIN_EFFECTS.entries()].map(([id, meta]) => ({ id, fragment: meta.fragment, params: meta.params }));
  const chain = activeChain(declared, (effectId) => {
    const meta = PLUGIN_EFFECTS.get(effectId);
    const options = meta && Array.isArray(meta.options) ? meta.options : [];
    const chosen = String(uiState.getValue(effectId) === undefined ? '' : uiState.getValue(effectId));
    const idx = options.length ? Math.max(0, options.indexOf(chosen)) : 0;
    return { optionIndex: idx, optionCount: options.length || 1 };
  });
  return renderer.setEffectChain(chain);
}

let pluginRebuildBound = false;
/**
 * 记录当前面板各组的展开态（重建前调用）。
 *
 * 为什么要记：`mountPanel` 会 `bodyEl.replaceChildren()` 整块重建（view.js:389/421），
 *   而展开态只写在 DOM 上（view.js:341 的 aria-expanded / :373 的 body.hidden / :375 的 is-open），
 *   没有持久化 ⇒ 插件装载完成、切换渲染面触发的重建都会把用户手动展开的组打回 defaultOpen。
 * 只存内存、不落盘：这是**会话内视图状态**，不是用户设置（面板设置由 uiState 工厂负责，二者别混）。
 * @returns {Map<string, boolean>} groupId → 是否展开
 */
/**
 * 模块级累积表：groupId → 是否展开（仅内存、不落盘）。
 *
 * 为什么不能"每次重建只快照当前 DOM"：切换渲染面时有些组会**临时不存在**
 *   （例如 live2d 面没有「皮肤」组，实测切过去再切回来，「皮肤」的展开态就丢了）。
 *   累积表把"最近一次见到它时的状态"留着，组重新出现时就能还原；
 *   组的永久消失（插件卸载）只会留下几个无用 key，代价可忽略，所以不做主动清理。
 */
const expandedState = new Map();

function snapshotExpandedGroups() {
  if (typeof document === 'undefined') return;
  for (const sec of document.querySelectorAll('#right-panel .acc[data-group]')) {
    const t = sec.querySelector('.acc-trigger');
    if (t) expandedState.set(sec.dataset.group, t.getAttribute('aria-expanded') === 'true');
  }
}

/**
 * 重建后回填展开态，并给每个手风琴节点写 `data-group-id`。
 *
 * 为什么不改 view.js：渲染层已经用 `section.dataset.group = group.id`（view.js:340）把 id 放在
 *   `data-group` 上；测试要断言的"插件组必须 plugin. 前缀"读 `data-group-id` 更直白，
 *   在装配期补写一行即可，不必为命名偏好去动渲染层（渲染层改动面越小越好）。
 */
function restoreExpandedGroups() {
  if (typeof document === 'undefined') return;
  for (const sec of document.querySelectorAll('#right-panel .acc')) {
    const id = sec.dataset.group || '';
    if (id) sec.dataset.groupId = id;                 // → 属性 data-group-id
    if (!id || !expandedState.has(id)) continue;       // 从没见过的组（插件新建）走自身 defaultOpen
    const open = !!expandedState.get(id);
    const t = sec.querySelector('.acc-trigger');
    const b = sec.querySelector('.acc-body');
    if (t) t.setAttribute('aria-expanded', String(open));
    if (b) b.hidden = !open;
    sec.classList.toggle('is-open', open);
  }
}

export function bindPluginPanelRebuild() {
  if (pluginRebuildBound) return false;
  pluginRebuildBound = true;
  window.addEventListener('spineviewer:plugins-loaded', () => {
    try {
      // 先重建面板（这一步把当前插件控件登记进 SPEC），**再**清孤儿键：
      //   顺序反了会把"还没来得及登记"的键当成残留删掉。
      rebuildPanelFor(state.currentRenderer);
      const orphans = uiState.pruneUnregistered();
      if (orphans.length) stageLog('info', `已清理失效的面板设置键：${orphans.join(' / ')}`, { source: 'plugin-controls' });
    } catch (e) {
      stageLog('warn', `插件控件合并失败：${(e && e.message) || e}`, { source: 'plugin-controls' });
    }
  });
  return true;
}

/**
 * 装配期聚合：内置表 + 旧控件节（已 deprecated，恒空）+ 插槽登记 → 同一份 groups。
 *
 * 抽出来的理由：rebuildPanelFor 还要管挂载、dataset、展开态、applier 等一堆事，
 *   聚合单独成函数才读得动（也才过得了"单函数 50 行"的口径）。
 * @returns {{host: object|null, merged: object, slotMerged: object, registeredEffects: string[], pluginControls: Array}}
 */
function aggregatePanelGroups() {
  const host = state.pluginHost;
  const registeredEffects = host && typeof host.registeredEffectIds === 'function' ? host.registeredEffectIds() : [];
  // 内置表 → 插槽登记聚合（唯一通路：老接口 registerControls 已在其内部转成插槽注册）
  const slotEntries = host && typeof host.slotSections === 'function' ? host.slotSections() : [];
  // 只把分组插槽交给面板聚合：toolbar.actions 是顶栏的，走到这里会被判"不是面板控件"并刷一条拒绝日志
  //   （实测每个顶栏按钮刷一条，纯噪音）。顶栏那条路由 syncToolbarPlugins 负责。
  const panelEntries = slotEntries.filter((e) => String((e && e.name) || '').startsWith('panel.group.'));
  const slotMerged = mergeSlotControls(PANEL_GROUPS, panelEntries, {
    buildProps: (entry) => slotPropsFor(entry),
    // 老接口迁移来的控件靠它判"效果是否注册成功"（置灰 + 原因，契约 §9.3）
    registeredEffects,
    onReject: (rej) => {
      // title-collision 是**提示**不是拒绝（设计 §七·一 明确允许与内置组同名）
      const advisory = rej.code === 'title-collision';
      stageLog(advisory ? 'info' : 'warn',
        `插件插槽${advisory ? '提示' : '控件被拒'}（${rej.pluginId || '未知插件'} · ${rej.slot || '未知插槽'}）：${rej.reason}`,
        { source: 'plugin-slots', code: rej.code || null });
    },
  });
  const pluginControls = slotMerged.groups.flatMap((g) => (g.controls || []).filter((c) => c && c.pluginId));
  // 旧控件节通道已删除：merged 只保留"零"计数以维持 dataset 字段口径（pluginControls 全来自插槽）
  const merged = { added: 0, rejected: 0, rejectedControls: 0 };
  return { host, merged, slotMerged, registeredEffects, pluginControls, slotEntries };
}

/**
 * 把插件控件登记进设置工厂（SPEC）+ 补 applier + 建"控件 id → 存值键"映射。
 *
 * 两件事必须一起做：
 *   · 声明了 spec.setting 的控件，值要落在**清单设置键**上 ⇒ SPEC 里要同时有控件 id 与存值键
 *     （只登记控件 id 的话，uiState.set(设置键) 会被工厂判成"未登记的键"直接丢弃）
 *   · appliers 是模块加载时按 SPEC 快照注册的，插件晚于那一刻 ⇒ 不补就"只存值不 render"
 * @param {Array} pluginControls 合并后的插件控件
 */
/**
 * 同步顶栏的插件按钮（toolbar.actions 插槽）。
 *
 * 为什么不在这里处理排序/上限：那是渲染器的规则（toolbar.js），装配层只负责
 *   "把插槽登记项与 onAction 通道接起来"，规则集中在一处才不会被两处表达。
 * @param {Array} slotEntries 插槽登记项（全部插槽，渲染器只挑 toolbar.actions）
 */
function syncToolbarPlugins(slotEntries) {
  const nav = document.getElementById('header-actions');
  if (!nav) return;
  syncPluginToolbar(nav, slotEntries, {
    // 日志能力由这里注入（渲染器不能 import app 层，否则 context.js 会提前快照顶栏节点）
    log: (level, message, detail) => stageLog(level, message, detail),
    onAction: (entry) => {
      const spec = (entry && entry.spec) || {};
      if (typeof spec.onAction !== 'function') return;
      try {
        // 与面板控件同一套动作口径：{ id, value } + owner props
        spec.onAction({ id: String(entry.id || ''), value: String(entry.id || '') }, slotPropsFor(entry));
      } catch (e) {
        stageLog('warn', `插件顶栏按钮回调抛错（已隔离，顶栏不受影响）：${(e && e.message) || e}`, { source: 'plugin-toolbar' });
      }
    },
  });
}

function registerSlotStorage(pluginControls) {
  if (!pluginControls.length) return;
  // 存值键映射随重建刷新（控件消失后不许还留着旧映射）
  slotStoreKeyById.clear();
  for (const ctl of pluginControls) {
    const id = String((ctl && ctl.id) || '');
    const setting = String((ctl && ctl.setting) || '');
    if (id && setting && setting !== id) slotStoreKeyById.set(id, setting);
  }
  // 反向表：设置键 → 绑定它的控件 id（一个键可能被多个控件绑定，所以是数组）
  slotCtlIdsByKey.clear();
  for (const ctl of pluginControls) {
    const id = String((ctl && ctl.id) || '');
    const setting = String((ctl && ctl.setting) || '');
    if (!id || !setting || setting === id) continue;
    const list = slotCtlIdsByKey.get(setting) || [];
    list.push(id);
    slotCtlIdsByKey.set(setting, list);
  }
  const specItems = [...pluginControls];
  for (const ctl of pluginControls) {
    const setting = String((ctl && ctl.setting) || '');
    if (setting && setting !== String(ctl.id || '')) specItems.push({ ...ctl, id: setting });
  }
  const reg = uiState.registerSpecItems(specItems);
  // 拒绝登记的要当场说清楚：否则表现为"控件在面板上、却不被工厂接管（恢复默认跳过它）"
  if (reg && Array.isArray(reg.skipped) && reg.skipped.length) {
    for (const s of reg.skipped) {
      stageLog('warn', `插件控件未进入设置工厂：${s.id}（${s.reason}）`, { source: 'plugin-controls' });
    }
  }
  // applier 两类：
  //   ① 按控件 id：老路径（外部写 control id）
  //   ② 按**设置键**：外部写清单设置键时，把它绑定的控件全部重绘（含被多个控件共享的情况）
  //   两条路径都走 scheduleControlRepaint ⇒ 同一 tick 内只重绘一次（不闪、计数也是 1）
  const appliers = {};
  for (const ctl of pluginControls) {
    const id = String((ctl && ctl.id) || '');
    if (!id) continue;
    appliers[id] = {
      apply: (v) => applyCore(id, v),
      render: () => scheduleControlRepaint(id),
    };
  }
  for (const [key, ids] of slotCtlIdsByKey) {
    appliers[key] = {
      apply: (v) => { for (const ctlId of ids) { try { applyCore(ctlId, v); } catch { /* 单个失败不影响其余 */ } } },
      render: () => { for (const ctlId of ids) scheduleControlRepaint(ctlId); },
    };
  }
  uiState.registerAppliers(appliers);
}

/**
 * 把插件效果元数据填进 PLUGIN_EFFECTS 并下发一次效果链（插件晚于首帧加载，不补这一次画面就不对）。
 * @param {object|null} host 插件宿主
 * @param {Array} pluginControls 合并后的插件控件（用来取每个效果的选项集）
 */
function syncPluginEffects(host, pluginControls) {
  PLUGIN_EFFECTS.clear();
  if (!host || typeof host.effectDeclarations !== 'function') return;
  for (const decl of host.effectDeclarations()) {
    const ctl = pluginControls.find((c) => String(c.id) === decl.id);
    PLUGIN_EFFECTS.set(decl.id, {
      fragment: decl.fragment,
      params: decl.params,
      options: ctl && Array.isArray(ctl.options) ? ctl.options.map(String) : [],
    });
  }
  if (PLUGIN_EFFECTS.size) applyPluginEffectChain();
}

/**
 * 能力过滤：把"已声明但注册失败"的控件置灰保留（契约 §9.3），其余按渲染器能力裁决。
 * 白名单 = 渲染器自身声明 + 注册成功的效果 id + 插槽控件的能力键（显式等于控件 id）。
 * @param {object} renderer 当前渲染器
 * @param {object} slotMerged mergeSlotControls 的结果
 * @param {Array} pluginControls 插件控件
 * @param {string[]} registeredEffects 注册成功的效果 id
 * @returns {Array} 可渲染的 groups
 */
function filterByCapabilities(renderer, slotMerged, pluginControls, registeredEffects) {
  // 已声明但注册失败的那些：置灰而不是消失（契约 §9.3）
  const keepDisabled = new Set(pluginControls.filter((c) => c.disabled === true && c.id).map((c) => String(c.id)));
  PLUGIN_DISABLED_IDS.clear();
  for (const ctlId of keepDisabled) PLUGIN_DISABLED_IDS.add(ctlId);
  const pluginCapabilityKeys = [...registeredEffects, ...slotMerged.capabilityKeys];
  return applyCapabilities(slotMerged.groups, withPluginCapabilities(renderer && renderer.capabilities, pluginCapabilityKeys), {
    onWarn: (message) => stageLog('warn', message, { source: 'panel-selfcheck' }),
    keepDisabled,
  });
}

/**
 * 挂载重建后的面板，并回填展开态。
 *
 * 顺序有讲究：**先**把当前展开态并入累积表（mountPanel 会整块换 DOM），
 *   再 mountPanel，最后回填 —— 中间不许再插入别的重建。
 * @param {Array} groups 已按能力过滤、可渲染的分组
 * @param {Array} pluginControls 插件控件（用于接线清单）
 * @returns {object} mountPanel 的句柄
 */
function mountRebuiltPanel(groups, pluginControls) {
  snapshotExpandedGroups();
  const info = mountPanel({
    groups,
    headEl: dom.panelHead,
    bodyEl: dom.panelBody,
    // 动态选项 → 值工厂的取值域。皮肤列表这类"选项由模型决定"的控件，schema 里只有占位值；
    //   不同步域的话，工厂会把运行时补进来的值判成非法并回落默认（表现为"点了没反应"）。
    onDomain: (id, list) => { try { uiState.setDomain(id, list); } catch { /* 域同步失败不影响面板 */ } },
    // 面板控件回调统一入口 + 暂停补帧：面板里的设置是**直调 renderer.setSetting**（不经
    //   app/renderer-setting.js），所以补帧必须挂在这一层，否则暂停中改设置"改了看不见"。
    onSetting: (id, value) => {
      applyPanelSetting(id, value);
      if (state.playing === false) { try { repaintActive(state.surface); } catch { /* 忽略 */ } }
    },
    // 插件控件的"接线"由宿主负责（插件只交声明式数据）⇒ 已注册成功的要进接线清单，
    //   否则渲染层会当成"未接线"：按钮不绑 click，点了没反应（实测踩过）。
    wiredIds: [...WIRED_IDS, ...pluginControls.filter((c) => c.disabled !== true && c.id).map((c) => String(c.id))],
    // 首次渲染就显示用户值（契约 R2）：工厂里已经有 loadAll 读回的值
    // 读存值键：声明了 spec.setting 的控件，值存在清单设置键上（不是 control id）
    initialValue: (id) => uiState.getValue(storeKeyOf(id)),
  });
  restoreExpandedGroups();
  return info;
}

function rebuildPanelFor(renderer) {
  bindPluginPanelRebuild();   // 幂等：确保"插件交完声明后重建面板"这条链只绑一次
  const { host, merged, slotMerged, registeredEffects, pluginControls, slotEntries } = aggregatePanelGroups();
  // 动作表随重建刷新：控件消失（插件卸载）后不许还留着能点的回调
  slotActions.clear();
  for (const ctl of pluginControls) {
    if (ctl && ctl.id && typeof ctl.onAction === 'function') {
      slotActions.set(String(ctl.id), { pluginId: ctl.pluginId, fn: ctl.onAction });
    }
  }
  syncPluginEffects(host, pluginControls);
  registerSlotStorage(pluginControls);
  const groups = filterByCapabilities(renderer, slotMerged, pluginControls, registeredEffects);
  // 顶栏插件按钮：与面板同一次重建里同步（卸载后旧按钮随重建消失）
  syncToolbarPlugins(slotEntries);
  document.documentElement.dataset.pluginControls = String(merged.added + slotMerged.added);
  document.documentElement.dataset.pluginControlsRejected = String(merged.rejected + merged.rejectedControls + slotMerged.rejected);
  document.documentElement.dataset.panelGroups = String(groups.length);
  // 重建前记住用户手动展开/收起的组：mountPanel 会整块换 DOM，不记就回缺省（实测过的现状缺陷）
  const info = mountRebuiltPanel(groups, pluginControls);
  // 先把句柄补完，再暴露 state.panel。
  //   为什么顺序重要：设置下拉的同步会**触发面板重建**，重建期间若 state.panel 指向
  //   一个"还没挂 refreshAnimations"的半成品，调用方一检查 typeof 就跳过，表现为
  //   "点了底栏、右栏高亮不动，且没有任何报错"（实测踩过）。
  info.refreshAnimations = () => refreshPanelAnimations();
  state.panel = info;
  // 暴露"实际构建出来的已接线控件"：能力不支持的项根本不构建（契约 §3.1），
  //   所以 panelWired 不能直接给全量 WIRED_IDS，否则断言会拿面板里不存在的 id 去比。
  //   但也不能直接给 builtIds —— 有些控件建出来了却处于 pending/disabled（如 ctl-anim-list），
  //   它们不算"已接线"，给进去会让 panel-actions 的严格集合相等断言反向失败（实测踩过）。
  //   正确口径 = 静态白名单里真正建出来的 + **插件控件**（插件控件 id 是裸 effect id，
  //   不带 ctl- 前缀、不在 WIRED_IDS 里，按契约 §9.2 由宿主负责接线）。
  const builtIds = [...document.querySelectorAll('#right-panel [data-ctl]')].map((n) => n.dataset.ctl);
  // 已接线的插件控件：必须与"合并进来的那份"同源。
  //   接线清单必须与"合并进来的那份"同源：曾经只查旧通道，导致插槽控件渲染出来了却不在这份清单里，
  //   测试的「可点集合 === 已接线集合」立刻变红（插件控件本就不该免检）。
  const pluginCtlIds = pluginControls
    .map((ctl) => ctl && ctl.id)
    .filter((id) => id && builtIds.includes(id));
  state.panelWired = [...new Set([
    ...WIRED_IDS.filter((id) => builtIds.includes(id)),
    ...pluginCtlIds,
  ])];
  exposePanelWired();
  startFpsReadout(info);
  // 契约 §三/§3.1（**唯一汇聚点**）：面板 DOM 刚被重建 ⇒ 当前 DOM 的显示态全是 schema 默认值，
  //   必须立刻按工厂里的生效值重放一次，否则「引擎在循环、开关显示关」会再次出现。
  try { document.dispatchEvent(new CustomEvent('panel:rebuilt')); } catch { /* 无 DOM 环境忽略 */ }
  try { uiState.applyAll({ render: true }); } catch { /* 回填失败不影响面板可用 */ }
  refreshSkinHook();
  // 自定义背景图列表：面板重建后重新拉一次（切面/重开面板都会走到这里）
  bindBgGroupToggle();   // 点「纯色▾ / 自定义▾」切换二级列表展开（幂等，只绑一次）
  refreshBgSources().catch(() => { /* 列表拉取失败只是少一块内容，不影响面板其余部分 */ });
  refreshPanel().catch(() => { /* 内存条取不到就隐藏，不阻塞面板 */ });
  // 文档 §五「展开设置面板 → 拉一次」：面板重建与"点开设置组"是两件事，
  //   后者不重建面板，所以单独绑一次点击（幂等）。
  bindPanelBarRefresh();
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
 * 造一行动作（样式左名称溢出省略 + 右时长等宽小字，选中主色描边）。
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
  box.classList.add('ctl-list'); // 容器行样式（见 panel.css 的 .ctl-list）
  if (!list.length) {
    const hint = document.createElement('p');
    hint.className = 'ctl-list-empty'; // 空态：居中弱化小字
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
