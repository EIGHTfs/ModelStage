// main.js —— ModelStage 新前端入口（M4）
//
// 做什么：
//   1. 装配各区域 DOM 引用并向 window.__WEB__ 暴露（自动化断言与手工排查都读它）；
//   2. 拉 GET /api/brand 应用品牌（标题 + 图标），未配置时回落到默认品牌名；
//   3. 接上顶栏「模型库」按钮 = 左栏显示/隐藏切换（与旧前端的面板开关语义一致）；
//   4. 拉 /api/roots 后把名册三级树挂到左栏（roster-view.js，首次展开某游戏才请求该游戏模型）；
//      失败时在左栏显示红色横幅，不抛到控制台；
//   5. 挂右侧控制面板与底部播放条的骨架（panel.js / transport.js）——
//      M3 只做控件齐全、位置就位，组内控件一律 disabled + data-pending（M6 接线）。
// 为什么把状态放在 window.__WEB__.state：M7 要做持久化，需要一个显式 store；
//   现在先立最小形态（不引框架），后续里程碑往里加字段，避免各处散落全局变量。

// 诊断探针必须最先装：后面的模块/渲染出问题时才有取证（API 与旧前端 legacy/patches/diag.js 一致）
import { installDiag } from './infra/diag.js';
import { getJson, formatError } from './infra/api.js';
import { createRosterView } from './roster/view.js';
import { mountPanel } from './panel/view.js';
import { PANEL_GROUPS, applyCapabilities, settingKeyOf, selfCheck } from './panel/schema.js';
import { mountTransport } from './panel/transport.js';
import { createSpineStage } from './spine/canvas.js';
import { createStageSurface } from './render/surface.js';
import { createSpineRenderer } from './render/spine.js';
import { createLive2DRenderer } from './render/live2d.js';
import { createLive2DStage } from './live2d/stage.js';
import { attachStageInteraction } from './render/interaction.js';

// 页面级第一件事：装诊断探针（幂等，重复调用不会重复包装 console）
const diag = installDiag();

/** 服务端没配置品牌时的默认品牌名（唯一默认值，别处不重复写） */
const DEFAULT_BRAND = 'ModelStage';

/** 各区域 DOM 引用：集中取一次，避免函数里反复 querySelector */
const dom = {
  leftPanel: document.getElementById('left-panel'),
  rosterList: document.getElementById('roster-list'),
  rosterCount: document.getElementById('roster-count'),
  rosterSearch: document.getElementById('roster-search'),
  btnCollapse: document.getElementById('btn-collapse'),
  brandTitle: document.getElementById('brand-title'),
  brandIcon: document.getElementById('brand-icon'),
  btnLibrary: document.getElementById('btn-library'),
  btnFullscreen: document.getElementById('btn-fullscreen'),
  stageHint: document.getElementById('stage-hint'),
  stageCanvas: document.getElementById('stage-canvas'),
  panelHead: document.getElementById('panel-head'),
  panelBody: document.getElementById('panel-body'),
  footer: document.getElementById('app-footer'),
};

/** Spine 渲染舞台：boot 时创建（WebGL 不可用时保持 null，UI 只提示不报错） */
let stage = null;

/** 最小状态容器（M7 会扩展成带持久化的 store） */
// 提前建好容器：早期状态日志（如面板能力推导告警）在 boot 末尾赋值前也要能落盘
window.__WEB__ = window.__WEB__ || {};

const state = {
  roots: [],
  rootsError: null,
  leftPanelVisible: true,
  selectedModel: null,
  // 当前渲染器：核心不再直接持有相机，统一从它取（现阶段只有 2D 一个实现）
  currentRenderer: null,
};

/**
 * 应用品牌：标题与图标一律来自 GET /api/brand（服务端读项目配置下发），不在前端写死。
 * 服务端未配置时返回 null，此时回落到页面内置的默认品牌名。
 * @param {{title: string|null, icon: string|null, iconKind: 'text'|'image'|null}} brand
 */
function applyBrand(brand) {
  const title = brand && brand.title ? brand.title : DEFAULT_BRAND;
  dom.brandTitle.textContent = title;
  document.title = title;

  const icon = brand && brand.icon ? brand.icon : '';
  if (icon && brand.iconKind === 'image') {
    // 图片形态（站内绝对路径 / http(s) / data:）：换成 <img>，替代内置 SVG。
    // 只替换容器内容、不动容器本身：id/类名保持稳定，后续换品牌不会把 DOM 引用弄丢。
    const img = document.createElement('img');
    img.alt = '';
    img.src = icon;
    dom.brandIcon.replaceChildren(img);
    dom.brandIcon.classList.add('is-image');
  } else if (icon) {
    // 文字形态（emoji 等）：直接当文本渲染
    dom.brandIcon.classList.remove('is-image');
    dom.brandIcon.replaceChildren(document.createTextNode(icon));
  }
  // 两者都没有：保留 index.html 里的内置 SVG 图标与默认标题
}

/** 拉品牌配置；失败只回落到默认值，不打断首屏（品牌不是关键路径） */
async function loadBrand() {
  try {
    const brand = await getJson('/api/brand');
    applyBrand(brand);
  } catch {
    applyBrand(null);
  }
}

/**
 * 读"启动自动恢复上次模型"开关：GET /api/web-config。
 * 语义：显式 false 才关闭；true 与 null（未配置）都按恢复处理。
 * 请求失败也按"恢复"处理——配置不是关键路径，不能因为它读不到就白屏或改变既有行为。
 * @returns {Promise<boolean>}
 */
async function loadWebConfig() {
  try {
    const cfg = await getJson('/api/web-config');
    if (cfg && typeof cfg.autoRestoreLast === 'boolean') return cfg.autoRestoreLast;
    return true;
  } catch {
    return true;
  }
}

/**
 * 面板已接线控件的生效表：key = 控件 id，value = 把该控件的机器值应用到舞台。
 * 未列出的控件在面板里仍是 disabled + data-pending，不会被回调到这里。
 */
/** 视图设置存储键（与旧端同一键：主题、背景等展示类设置） */
const VIEW_SETTINGS_KEY = 'spine-viewer-settings-v2';

/** 读视图设置（沿用旧端结构：{uiTheme, background:{mode,color,imageUrl}}） */
function readViewSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(VIEW_SETTINGS_KEY) || '{}');
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

/** 写视图设置：只覆盖自己管的键，其余字段原样保留（与旧端共用同一份） */
function saveViewSettings(patch) {
  try {
    const cur = readViewSettings();
    const next = { ...cur, ...patch };
    if (patch.background) next.background = { ...(cur.background || {}), ...patch.background };
    localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify(next));
  } catch { /* 隐私模式等写不了就忽略：持久化是增强 */ }
}

/** 主题：只改 CSS 变量所在的选择器属性，颜色全部集中在 panel.css 的主题色板 */
function applyTheme(id) {
  const theme = id || 'dark-cyan';
  document.documentElement.dataset.uiTheme = theme;
  state.viewTheme = theme;
  saveViewSettings({ uiTheme: theme });
}

/** 背景模式：写舞台容器的 data-bg，具体底色由 CSS 决定 */
function applyBackground(mode) {
  const stageEl = document.getElementById('stage');
  if (!stageEl) return;
  const m = mode || 'checkerboard';
  // 背景唯一入口：交给 Surface（它会写 data-bg 并通知所有渲染器）
  try {
    if (state.surface && typeof state.surface.setBackground === 'function') state.surface.setBackground(m);
    else stageEl.dataset.bg = m;
  } catch { stageEl.dataset.bg = m; }
  state.viewBg = m;
  const cur = readViewSettings();
  saveViewSettings({
    background: {
      mode: m,
      color: (cur.background && cur.background.color) || '#2a2a2a',
      imageUrl: (cur.background && cur.background.imageUrl) || '',
    },
  });
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

/**
 * 切换当前渲染器（预埋）：先让旧渲染器 unmount，再换新。
 * 现阶段只有 2D 一个实现，这里不会被外部调用；将来 3D 渲染器接入时复用同一入口。
 * @param {object} next 新渲染器（需带 capabilities / camera / mount / unmount / dispose）
 */
function setRenderer(next) {
  if (state.currentRenderer && state.currentRenderer !== next) {
    try { state.currentRenderer.unmount(); } catch { /* 旧渲染器卸载失败不影响切换 */ }
  }
  state.currentRenderer = next;
  document.documentElement.dataset.renderer = next && next.id ? next.id : 'none';
  return next;
}

/**
 * 用当前舞台实例建立 2D 渲染器并设为当前。
 * 舞台不可用时保持 null，调用方靠 `state.currentRenderer?.camera` 做空值保护。
 */
let live2dStage = null;

/** 建 Live2D 舞台（幂等）：覆盖层挂到 #stage 内，日志统一走 stageStatus */
function ensureLive2DStage() {
  if (live2dStage) return live2dStage;
  live2dStage = createLive2DStage({
    getOverlayHost: () => document.getElementById('stage'),
    // 引擎是懒创建的：每次加载时动态取当前实例（MSAA 重建后实例会换）
    getEngine: () => { try { return stage && stage.debug() ? stage.debug().engine : null; } catch { return null; } },
    log: (message, level) => stageStatus(message, level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'),
  });
  window.__WEB__ && (window.__WEB__.live2d = live2dStage);
  return live2dStage;
}

function initRenderer() {
  // 渲染面：画布/尺寸/DPR/可见性/帧调度都由 StageSurface 拥有；渲染器只注册进来
  if (state.surface) return state.currentRenderer;
  const surface = createStageSurface({ log: (message, level) => stageStatus(message, level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info') });
  surface.register(createSpineRenderer({ stage, onMsaa: applyMsaa }));
  surface.register(createLive2DRenderer({ live2d: ensureLive2DStage() }));
  state.surface = surface;
  window.__WEB__ && (window.__WEB__.surface = surface);
  // 只读断言入口（summary/results/disable/enable/run）
  // 兼容层：对外仍是一个 renderer（camera 按当前面取，mount 走 Surface 的唯一入口）
  const facade = {
    id: 'renderer-2d',
    // 能力一律取当前激活渲染器的声明（不再硬编码兜底，否则"默认全支持"的缺陷会静默存在）
    get capabilities() { return surface.capabilities ? surface.capabilities() : null; },
    setSetting: (key, value) => {
      const r = surface.activeRenderer ? surface.activeRenderer() : null;
      if (!r || typeof r.setSetting !== 'function') return false;
      try { return r.setSetting(key, value) === true; } catch { return false; }
    },
    getSetting: (key) => {
      const r = surface.activeRenderer ? surface.activeRenderer() : null;
      try { return r && r.getSetting ? r.getSetting(key) : null; } catch { return null; }
    },
    get camera() { return surface.activeCamera() || stage.camera; },
    mount(document) { return surface.activate(document); },
    unmount() { return surface.disposeActive(); },
    dispose() { return surface.dispose(); },
    stageMode() { return surface.stageMode(); },
  };
  return setRenderer(facade);
}

/** 当前交互层解绑函数（重建画布或测试清理时调用；null 表示未挂） */
let detachInteraction = null;

function cameraProxy() {
  const pick = () => (state.currentRenderer && state.currentRenderer.camera)
    || (stage && stage.camera) || null;
  const forward = (name) => (...args) => {
    const cam = pick();
    return cam && typeof cam[name] === 'function' ? cam[name](...args) : null;
  };
  return {
    zoomStep: forward('zoomStep'),
    zoomTo: forward('zoomTo'),
    panBy: forward('panBy'),
    reset: forward('reset'),
    scale: forward('scale'),
    note: forward('note'),
    setLogger: forward('setLogger'),
  };
}

/** 交互层用的视图门面：camera 动态取，其余转发舞台（getView/setView/resetView 语义不变） */
function interactionStage() {
  return {
    camera: cameraProxy(),
    getView: (...args) => (stage && stage.getView ? stage.getView(...args) : null),
    setView: (...args) => (stage && stage.setView ? stage.setView(...args) : null),
    resetView: (...args) => (stage && stage.resetView ? stage.resetView(...args) : null),
  };
}

function attachInteraction() {
  if (detachInteraction) {
    try { detachInteraction(); } catch { /* 解绑失败继续挂新的 */ }
    detachInteraction = null;
  }
  // 交互目标是「舞台区域」而不是某块画布：由 StageSurface 给出（画布可见性随渲染面切换，
  //   绑定到具体画布会在切面后失去命中；#stage 与画布同尺寸同位置，坐标换算不受影响）
  const target = (state.surface && state.surface.interactionTarget) || null;
  if (!target || !stage) return null;
  try {
    detachInteraction = attachStageInteraction({ canvas: target, stage: interactionStage() });
  } catch (err) {
    state.stageError = formatError(err);
  }
  return detachInteraction;
}

/**
 * 统一状态出口：所有舞台状态文字都走这里。
 * 规则：
 *   · 一律写日志（控制台 [STAGE:level] + `__WEB__.stageLog`，cap 200）；
 *   · 只有 error / warn（或显式 show:true）才上屏，其余一律隐藏，避免挡住画面。
 * 注意：日志不能走 console.error，否则页面错误统计会把正常状态当成异常。
 * @param {string} text
 * @param {'info'|'warn'|'error'} [level]
 * @param {{show?: boolean}} [opts]
 */
function stageStatus(text, level = 'info', opts = {}) {
  const line = String(text == null ? '' : text);
  if (window.__WEB__) {
    const bag = (window.__WEB__.stageLog = window.__WEB__.stageLog || []);
    bag.push({ at: Date.now(), level, line });
    if (bag.length > 200) bag.shift();
  }
  try {
    console.info(`%c[STAGE:${level}]`, 'color:#8b8b8b', line);
  } catch { /* 控制台不可用时忽略 */ }
  const show = opts.show === true || level === 'error' || level === 'warn';
  if (!dom.stageHint) return line;
  if (show) {
    dom.stageHint.textContent = line;
    dom.stageHint.hidden = false;
  } else {
    dom.stageHint.textContent = '';
    dom.stageHint.hidden = true;
  }
  return line;
}

/** 切换抗锯齿：要换画布重建上下文，先提示"正在重建"避免用户以为卡住 */
async function applyMsaa(mode) {
  if (!stage || typeof stage.rebuildWithAntialias !== 'function') return;
  const on = mode === 'auto';
  stageStatus('正在重建渲染上下文（切换抗锯齿）…', 'info');
  try {
    const r = await stage.rebuildWithAntialias(on);
    stageStatus(`抗锯齿已${r.antialias ? '开启' : '关闭'} · 重建耗时 ${r.restoreMs} ms`, 'info');
    document.documentElement.dataset.msaa = r.antialias ? 'on' : 'off';
    // 顶栏里仍 disabled 的按钮（导入/截图/菜单/影院）是待接线项：运行期补标记，
  // 让未接线=disabled+pending 的口径在顶栏也成立（index.html 不在本模块范围）

  } catch (err) {
    stageStatus(`切换抗锯齿失败：${formatError(err)}`, 'error');
  }
}

/** 部件筛除默认关键字：取自旧端存储 partFilterKeywords 的默认值 */
const DEFAULT_PART_FILTER_KEYWORDS = ['mask', 'mosai', 'mmd', 'mozaiku'];

/** 部件筛除：开关与恢复按钮共用同一状态，只覆盖传入字段 */
function applyPartFilter(patch) {
  const cur = state.partFilter || { enabled: false, keywords: DEFAULT_PART_FILTER_KEYWORDS.slice() };
  const next = { enabled: !!cur.enabled, keywords: cur.keywords.slice(), ...patch };
  state.partFilter = next;
  if (stage && stage.setPartFilter) stage.setPartFilter(next);
  saveViewSettings({ partFilterEnabled: next.enabled, partFilterKeywords: next.keywords.join(',') });
  document.documentElement.dataset.partFilter = next.enabled ? next.keywords.join(',') : 'off';
  return next;
}

/** 播放/暂停：切换引擎播放并同步按钮按下态与 dataset（进 CAMERA 之外的状态日志） */
function toggleTransportPlay() {
  if (!stage) return;
  const stats = stage.stats();
  const playing = !!(stats && stats.playing);
  if (playing) stage.pause(); else stage.play();
  const next = !playing;
  if (state.transport) state.transport.setPressed('transport-play', next);
  document.documentElement.dataset.transportPlaying = next ? 'on' : 'off';
  stageStatus(`transport 播放${next ? '' : '暂停'}`, 'info');
}

/** 单动循环：切换 settings.loop（引擎 setLoop 走通用 setter） */
function toggleTransportLoop() {
  if (!stage) return;
  const stats = stage.stats();
  const cur = !!(stats && stats.settings && stats.settings.loop);
  const next = !cur;
  if (typeof stage.setLoop === 'function') stage.setLoop(next);
  if (state.transport) state.transport.setPressed('transport-loop', next);
  document.documentElement.dataset.transportLoop = next ? 'on' : 'off';
  stageStatus(`transport 单动循环 ${next ? '开' : '关'}`, 'info');
}

/**
 * 上一个/下一个变体：取「当前根下、同一目录」的兄弟变体循环切换。
 * 为什么用 API 取：名册树是懒加载的，兄弟列表不在 state 里，直接查 /api/models 最准。
 */
async function stepVariant(dir) {
  const cur = state.selectedModel;
  if (!cur || !cur.rootId || !cur.directory) { stageStatus('切换变体失败：当前没有可用的兄弟变体', 'warn'); return; }
  try {
    const data = await getJson(`/api/models?root=${encodeURIComponent(cur.rootId)}`);
    const peers = (data.models || []).filter((m) => m.directory === cur.directory);
    if (peers.length < 2) { stageStatus('切换变体失败：当前角色只有 1 个变体', 'warn'); return; }
    const at = peers.findIndex((m) => m.id === cur.id || m.name === cur.name);
    const next = peers[(at + dir + peers.length) % peers.length];
    document.documentElement.dataset.transportVariant = next.name;
    stageStatus(`transport 切换变体 → ${next.name}`, 'info');
    onSelectModel(next);
  } catch (err) {
    stageStatus(`切换变体失败：${formatError(err)}`, 'error');
  }
}

/** 背景：底栏快捷入口，循环切换 棋盘 → 纯色 → 透明（与主题背景组的 bg-mode 同一状态） */
function cycleBackground() {
  const order = ['checkerboard', 'solid', 'transparent'];
  const cur = state.viewBg || 'checkerboard';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  applyBackground(next);
  if (state.panel && state.panel.setValue) state.panel.setValue('ctl-bg-mode', next);
  document.documentElement.dataset.transportBg = next;
  stageStatus(`transport 背景 → ${next}`, 'info');
}

/** 动作下拉选择：切动画并回填 dataset */
function applyTransportMotion(name) {
  if (!stage || !name) return;
  const ok = stage.setAnimation(name);
  document.documentElement.dataset.transportMotion = String(name);
  stageStatus(`transport 动作 → ${name}${ok ? '' : '（引擎拒绝，保持原动作）'}`, ok ? 'info' : 'warn');
}

/** 模型加载完成后填充播放条：动作下拉 + 循环/播放按下态 */
function fillTransportOptions(info) {
  const transport = state.transport;
  if (!transport) return;
  const anims = Array.isArray(info && info.animations) ? info.animations : [];
  if (anims.length) {
    transport.setOptions('transport-motion', anims.map((a) => ({ text: a, value: a })), info.motion || anims[0]);
  }
  const stats = stage ? stage.stats() : null;
  transport.setPressed('transport-loop', !!(stats && stats.settings && stats.settings.loop));
  document.documentElement.dataset.transportPlaying = stats && stats.playing ? 'on' : 'off';
}

/** 混合模式：两处开关指向同一状态，点任一处都要同步另一处的显示 */
function applyMixMode(on) {
  const value = !!(stage && stage.setMixMode ? stage.setMixMode(on) : 0);
  state.mixMode = !!on;
  if (state.panel) {
    state.panel.setChecked('ctl-mix-mode', !!on);
    state.panel.setChecked('ctl-skin-mix', !!on);
  }
  document.documentElement.dataset.mixMode = on ? 'on' : 'off';
  return value;
}

/** 加载模型后刷新皮肤列表（换模型必须重建，不能停在上一个模型的皮肤） */
function refreshSkinList() {
  if (!state.panel || !stage) return;
  const skins = stage.getSkins ? stage.getSkins() : ['default'];
  const current = skins.includes('default') ? 'default' : skins[0];
  state.panel.setOptions('ctl-skin-list', skins.map((s) => ({ text: s, value: s })), current);
  if (state.transport) state.transport.setOptions('transport-skin', skins.map((s) => ({ text: s, value: s })), current);
  document.documentElement.dataset.skinCount = String(skins.length);
}

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
  refreshSkinList();
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

/** 左栏显示/隐藏：位移 + 淡出，与旧前端「模型库」按钮的过渡一致 */
function toggleLeftPanel() {
  state.leftPanelVisible = !state.leftPanelVisible;
  dom.leftPanel.classList.toggle('is-hidden', !state.leftPanelVisible);
  dom.btnLibrary.setAttribute('aria-expanded', String(state.leftPanelVisible));
}

/** 全屏切换（原生 API，无副作用；不需要等后续里程碑） */
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch {
    // 浏览器策略拒绝（非用户手势、iframe 限制等）：静默忽略，不污染控制台
  }
}

/** 在左栏顶部插一条错误横幅（替代抛异常到控制台） */
function showRootsError(message) {
  const banner = document.createElement('p');
  banner.className = 'error-banner';
  banner.id = 'roots-error';
  banner.textContent = `读取资源根失败：${message}`;
  dom.rosterList.replaceChildren(banner);
}

/** 选中变体的回调：M2 只记状态（M4 用它去渲染舞台） */
function onSelectModel(model) {
  state.selectedModel = model;
  const name = model ? (model.name || model.id) : '无';
  if (!stage) { stageStatus(`已选中 ${name}（渲染器不可用）`, 'error'); return; }
  if (!model) { stage.unload(); return; }

  // 只有 Spine 走本路径；Live2D 与资源包由 M5 的插件管线接管
  const kind = model.kind || 'spine';
  if (kind !== 'spine' && kind !== 'live2d') {
    // 资源包（bundle）仍未接入：保持明确提示，不做"看着能选却渲不出来"
    stage.unload();
    stageStatus(`已选中 ${name}（资源包渲染未接入）`, 'warn');
    return;
  }

  // Live2D 与 Spine 共用同一装载入口：引擎在 loadModel 里认出 kind==="live2d" 后

  stageStatus(`正在加载 ${name}…`, 'info');
  // 走当前渲染器装载：Live2D 必须由 renderer 分流到覆盖层，
  //   否则会落到舞台的 Spine 前置流程（取骨架/图集）并 404。
  const loadDoc = {
    ...model,
    kind,
    rootId: model.rootId,
    rootName: model.rootName,
    entry: model.entry || (model.modelUrl ? { url: model.modelUrl } : null),
  };
  const loadPromise = state.currentRenderer
    ? state.currentRenderer.mount(loadDoc)
    : stage.load({ root: model.rootId, model });
  loadPromise
    .then((info) => {
      // null = 本次请求被排队/被更新的选择取代（Surface 的 last-wins 语义）：
      //   不能当成功读结果字段，否则出现"旧面已释放 + 新面没装"的空白 + TypeError
      if (!info) return; // 被排队/被取代：由真正生效的那次装载负责状态文案
      const isL2D = /^Live2D/.test(String(info.version || ''));
      const anims = Array.isArray(info.animations) ? info.animations : [];
      const motion = info.motion || anims[0] || '（无动作）';
      const head = isL2D ? String(info.version) : `Spine ${info.version}`;
      stageStatus(`${model.name} · ${head} · ${anims.length} 动作 · 播放 ${motion}`, 'info');
      // 运行时组只读：显示本次实际使用的运行时版本（引擎按骨架版本自动选，不可手切）
      if (state.panel) state.panel.setReadonly('ctl-runtime', `Spine ${info.version}`);
      refreshSkinList();
      fillTransportOptions(info);
      document.documentElement.dataset.stageReady = '1';
    })
    .catch((err) => {
      // 被取代属正常竞态结果（不是故障）：只记一条 info，不显示红色错误
      if (err && err.aborted) return; // 被取代是正常竞态结果，不报故障（真生效的那次会写状态）
      // 渲染失败属业务错误：显示在舞台提示与 __WEB__ 里，不抛到控制台（验收要求零错误）
      const msg = formatError(err);
      state.stageError = msg;
      stageStatus(`渲染失败：${msg}`, 'error');
      document.documentElement.dataset.stageReady = 'error';
    });
}

/** 拉资源根并把名册三级树挂到左栏（并按配置决定是否恢复上次选中） */
async function loadRoots() {
  try {
    // 资源根与恢复开关互不依赖：并行取，任一失败都不影响另一条（开关失败按"恢复"处理）
    const [data, autoRestore] = await Promise.all([getJson('/api/roots'), loadWebConfig()]);
    const roots = Array.isArray(data?.roots) ? data.roots : [];
    state.roots = roots;
    const roster = createRosterView({
      listEl: dom.rosterList,
      countEl: dom.rosterCount,
      searchEl: dom.rosterSearch,
      collapseBtn: dom.btnCollapse,
      onSelect: onSelectModel,
    });
    state.roster = roster;
    // 关闭自动恢复时，连"上次展开的节点"也不还原：保持空舞台、空展开
    await roster.mount(roots, { restoreExpanded: autoRestore });
    state.autoRestore = autoRestore;
    state.restore = autoRestore
      ? await roster.restoreLast()
      : { restored: false, reason: 'config-off' };
    // 供自动化断言：资源根 id 序列 + 恢复结果
    document.documentElement.dataset.rootsIds = roots.map((r) => r.id).join(',');
    document.documentElement.dataset.rootsReady = '1';
    document.documentElement.dataset.restore = JSON.stringify(state.restore);
    if (!state.restore.restored) {
      stageStatus(autoRestore ? `M2 名册 · ${roots.length} 个资源根 · 暂无上次选中的模型` : `M2 名册 · ${roots.length} 个资源根 · 已按配置关闭自动恢复`, 'info');
    }
  } catch (err) {
    state.rootsError = formatError(err);
    document.documentElement.dataset.rootsReady = 'error';
    showRootsError(state.rootsError);
  }
}

/** 绑定事件（只给"有真实行为"的控件挂处理器；其余控件在 HTML 里 disabled） */
function bindEvents() {
  dom.btnLibrary.addEventListener('click', toggleLeftPanel);
  dom.btnLibrary.setAttribute('aria-expanded', 'true');
  dom.btnFullscreen.addEventListener('click', toggleFullscreen);
}

function boot() {
  // 面板与播放条是纯静态骨架（不依赖网络）：先挂上，保证首屏五区域都有内容
  // 舞台渲染器：WebGL 不可用（无头精简环境等）时只提示，不让整页崩
  try {
    stage = createSpineStage({ canvas: dom.stageCanvas });
    document.documentElement.dataset.stageContext = 'webgl';
  } catch (err) {
    state.stageError = formatError(err);
    stageStatus(`渲染器不可用：${state.stageError}`, 'error');
    document.documentElement.dataset.stageContext = 'none';
  }

  // topbar-disabled-mark
  for (const b of document.querySelectorAll('#app-header button:disabled')) b.dataset.pending = 'true';

  // 相机操作日志：供真机操作时判定（不做模拟测试）。
  // 输出通道 presently 走控制台 + __WEB__.cameraLog；debug-log 接线后把这里换成 debugLog.log('CAMERA', line) 即可。
  const cameraEntry = state.currentRenderer && state.currentRenderer.camera;
  if (cameraEntry && cameraEntry.setLogger) {
    cameraEntry.setLogger((line, data) => {
      window.__WEB__ && (window.__WEB__.cameraLog = window.__WEB__.cameraLog || []).push({ at: Date.now(), line, data });
      if (window.__WEB__.cameraLog.length > 200) window.__WEB__.cameraLog.shift();
      console.info('%c[CAMERA]', 'color:#1fc0c5', line);
    });
  }


  initRenderer();

  attachInteraction();

  // 面板三态由当前渲染器能力决定；切换渲染器时必须重算 + 重跑自检（契约 INV-05）
  rebuildPanelFor(state.currentRenderer);
  if (state.surface && typeof state.surface.onRendererChange === 'function') {
    state.surface.onRendererChange(() => { rebuildPanelFor(state.currentRenderer); });
  }

  const transportInfo = mountTransport(dom.footer, {
    'transport-reset-view': () => { if (stage && stage.resetView) stage.resetView(); },
    'transport-loop': () => toggleTransportLoop(),
    'transport-play': () => toggleTransportPlay(),
    'transport-prev': () => stepVariant(-1),
    'transport-next': () => stepVariant(1),
    'transport-bg': () => cycleBackground(),
    'transport-motion': (name) => applyTransportMotion(name),
    'transport-skin': (name) => { if (stage && stage.setSkin) stage.setSkin(name); },
  });
  state.transport = transportInfo;
  // 存储优先：主题/背景先按上次的选择恢复，再让"面板默认值"兜底未存过的项
  const savedView = readViewSettings();
  applyTheme(savedView.uiTheme || 'dark-cyan');
  applyBackground((savedView.background && savedView.background.mode) || 'checkerboard');
  const savedKeywords = typeof savedView.partFilterKeywords === 'string' && savedView.partFilterKeywords.trim()
    ? savedView.partFilterKeywords.split(',').map((k) => k.trim()).filter(Boolean)
    : DEFAULT_PART_FILTER_KEYWORDS.slice();
  applyPartFilter({ enabled: savedView.partFilterEnabled === true, keywords: savedKeywords });
  if (state.panel && state.panel.setValue) {
    state.panel.setValue('ctl-theme', state.viewTheme);
    state.panel.setValue('ctl-bg-mode', state.viewBg);
  }
  // 面板声明的默认值即唯一真相：启动时统一走一遍生效表，避免"高亮在 A、引擎在 B"
  // MSAA 例外：它的默认值已由建上下文时的 antialias 生效，启动就重建会白等 2~5 秒
  const STARTUP_SKIP = new Set(['ctl-msaa', 'ctl-theme', 'ctl-bg-mode']);
  for (const [id, value] of Object.entries((state.panel && state.panel.defaults) || {})) {
    if (STARTUP_SKIP.has(id)) continue;
    applyPanelSetting(id, value);
  }
  state.panelDefaults = { ...((state.panel && state.panel.defaults) || {}) };
  document.documentElement.dataset.panelReady = '1';
  document.documentElement.dataset.panelControls = String((state.panel && state.panel.controls) || 0);
  document.documentElement.dataset.transportControls = String(transportInfo.controls);

  // 品牌与资源根互不依赖，并行拉取；任一失败都不影响另一条链路
  loadBrand();
  bindEvents();
  // 暴露给调试与自动化断言（M2 验收用）
  window.__WEB__ = Object.assign(window.__WEB__ || {}, {
    /** 当前渲染器（只读，便于排查：id / capabilities / camera 是否就绪） */
    get renderer() { return state.currentRenderer; },
    /** 能力自检（契约 §四）：随时可重跑，violations 非空即缺陷 */
    panelSelfCheck: () => {
      const check = selfCheck(state.currentRenderer || {});
      state.panelSelfCheck = check;
      document.documentElement.dataset.selfCheck = check.passed ? 'pass' : 'fail';
      return check;
    },
    /** 面板三态快照（禁用/可用/隐藏），切换渲染器前后各取一次做对比 */
    panelSnapshot: () => panelSnapshot(),
    state,
    version: 'M4',
    /** 渲染舞台（测试脚本用它取像素、看统计） */
    get stage() { return stage; },
    /** 启动恢复结果：{restored, reason?, modelId?}（自动化断言用） */
    get restore() { return state.restore || null; },
    /** 自动恢复开关的生效值（true=恢复，false=配置关闭） */
    get autoRestore() { return state.autoRestore; },
    /** 诊断探针实例（等价于 window.__DIAG__，便于同一套检查代码复用） */
    get diag() { return diag; },
    /** 解绑交互层（测试清理用；正常运行时不必调用） */
    detachInteraction: () => {
      if (detachInteraction) { try { detachInteraction(); } catch { /* 忽略 */ } detachInteraction = null; }
    },
    /** 已接线的面板控件 id（断言用：可点集合必须与它一致） */
    panelWired: WIRED_IDS,
    /** 当前视图设置（主题/背景），断言用 */
    viewSettings: () => ({ uiTheme: state.viewTheme, background: { mode: state.viewBg } }),
    /** 已接线控件的声明默认值（断言：引擎实际生效值必须与之一致） */
    get panelDefaults() { return state.panelDefaults || null; },
    /** 面板/播放条骨架规模（自动化断言用） */
    chrome: {
      groups: (state.panel && state.panel.groups) || 0,
      panelControls: (state.panel && state.panel.controls) || 0,
      transportControls: transportInfo.controls,
    },
    defaultBrand: DEFAULT_BRAND,
    /** 名册状态快照（未挂载时返回 null） */
    rosterSnapshot: () => (state.roster ? state.roster.snapshot() : null),
  });
  loadRoots();
}

boot();
