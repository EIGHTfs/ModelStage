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
import { markStage, installReadyApi, trackElementStage, trackElementWhenReady } from './infra/ready.js';
import { installMemStats, memStats } from './infra/mem-stats.js';
import { getJson, formatError } from './infra/api.js';
import { getSharedVirtualFS } from './infra/vfs.js';
import { createPluginHost } from './infra/plugin-host.js';
import { mountTransport } from './panel/transport.js';
import { createSpineStage } from './spine/canvas.js';
import { createStageSurface } from './render/surface.js';
import { createSpineRenderer } from './render/spine.js';
import { createLive2DRenderer } from './render/live2d.js';
import { createLive2DStage } from './live2d/stage.js';
import { attachStageInteraction } from './render/interaction.js';
import { dom, setStage, stage, state } from './app/context.js';
import { diagEvent } from './app/status.js';
import { stageLog, stageStatus } from './app/status.js';
import { VIEW_SETTINGS_KEY, applyBackground, applyTheme, readViewSettings, saveViewSettings } from './app/view-settings.js';
import {
  WIRED_IDS, applyPanelSetting, panelSnapshot, rebuildPanelFor, restorePanelSettings,
  runPanelSelfCheck, suspendPanelPersist,
} from './panel/panel-settings.js';
import { loadRoots } from './app/model-actions.js';
import { installCameraLogger } from './app/camera-log.js';
import { recent as recentLogs } from './infra/log.js';
import { resetViewViaRenderer } from './render/reset-view.js';
import { applyTopbarIcons } from './panel/icons.js';
import {
  bindCinemaKeys, bindSidebarStateSync, exportScreenshot, retrackStage, syncSidebarButtons, toggleCinema, toggleRightPanel,
} from './app/topbar-actions.js';
import {
  applyTransportMotion, stepVariant, toggleTransportPlay,
} from './app/transport-actions.js';

// 页面级第一件事：装诊断探针（幂等，重复调用不会重复包装 console）
const diag = installDiag();

/** 服务端没配置品牌时的默认品牌名（唯一默认值，别处不重复写） */
const DEFAULT_BRAND = 'ModelStage';

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

/**
 * 面板已接线控件的生效表：key = 控件 id，value = 把该控件的机器值应用到舞台。
 * 未列出的控件在面板里仍是 disabled + data-pending，不会被回调到这里。
 */
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
    // 资源位置解析的唯一入口（VirtualFS 契约 §四）：先问 vfs，命中用虚拟地址，未命中回落原 URL。
    // 必须是**同一个共享实例** —— 注册方（插件/验收脚本经 window.__VFS__）与消费方各建一个的话，
    //   register 完也解析不到，表现为"接了但没生效"（这一行之前漏了，等于 Live2D 从未消费过 VFS）。
    vfs: getSharedVirtualFS(),
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
  // 就绪信号 renderer 阶段（契约 §三）：两面都注册完 = 已实例化；
  //   能力声明可读 = settled；能拿到 activeRenderer 且可下发设置 = interactive
  markStage('renderer', 'mounted', { faces: 2 });
  const twoFrames = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));
  twoFrames(() => {
    const caps = (() => { try { return surface.capabilities ? surface.capabilities() : null; } catch { return null; } })();
    if (caps) markStage('renderer', 'settled', { settings: (caps.settings || []).length, camera: caps.camera || null });
    const active = (() => { try { return surface.activeRenderer ? surface.activeRenderer() : null; } catch { return null; } })();
    if (active && typeof active.setSetting === 'function') {
      markStage('renderer', 'interactive', { activeId: active.id || null });
    }
  });
  state.surface = surface;
  // 就绪信号：三个 DOM 阶段（契约 §2.1 三级；settled = 动画/布局稳定后才报）
  trackElementWhenReady({ name: 'topbar', selector: '#app-header' });
  trackElementWhenReady({ name: 'sidebarLeft', selector: '#left-panel' });
  // 调试浮层由面板模块异步挂载（.dbg-panel），出现后再开始三级跟踪
  trackElementWhenReady({ name: 'debugPanel', selector: '.dbg-panel', timeoutMs: 15000 });
  trackElementWhenReady({ name: 'sidebarRight', selector: '#right-panel' });
  // 底栏：现在是**自绘 picker**（button[aria-expanded] + ul[role=listbox]），不是原生 select。
  //   interactive 额外要求：触发按钮存在、aria-expanded=false（收起态=可用且没被展开卡住）、
  //   且**不存在** select.transport-select（存在即说明退回旧实现）。
  if (dom.footer) {
    trackElementStage({
      name: 'bottombar',
      el: dom.footer,
      interactiveProbe: () => {
        const btn = dom.footer.querySelector('.transport-picker .transport-picker-btn');
        const nativeSelect = dom.footer.querySelector('select.transport-select');
        const expanded = btn ? btn.getAttribute('aria-expanded') : null;
        return {
          ok: !!btn && expanded === 'false' && !nativeSelect,
          detail: { pickerBtn: !!btn, expanded, nativeSelect: !!nativeSelect },
        };
      },
    });
  }
  window.__WEB__ && (window.__WEB__.surface = surface);
  // 就绪信号（契约 §5.1）：__WEB__.ready() 全量、__WEB__.ready('model') 单阶段
  installReadyApi(window.__WEB__);
  // 资源/上下文计数（只读观测，给"泄漏是否累积"提供数字；必须在渲染器创建上下文前安装）
  installMemStats();
  window.__WEB__.memStats = () => memStats();
  // PMA 诊断读取口（只读）：把"当前档位 / 生效判定 / 最近 pma.* 日志"一次取回，
  //   便于在浏览器控制台或自动化探针里核对"auto 到底判了什么"，不必翻面板。
  window.__WEB__.pmaDebug = () => {
    try {
      // 引擎实例从 stage 侧取（surface.debug() 不一定有）；两条路都试，取到即用
      let eng = null;
      try { eng = state.surface && state.surface.debug ? (state.surface.debug().engine || null) : null; } catch { /* 忽略 */ }
      if (!eng) { try { eng = window.__WEB__.stage.debug().engine; } catch { /* 忽略 */ } }
      const logs = recentLogs().filter((r) => {
        const d = r && r.detail;
        return (d && d.event && String(d.event).startsWith('pma.')) || String(r.tag || '') === 'pma';
      }).slice(-10);
      return {
        mode: eng ? eng.pmaMode : null,
        pmaInfo: eng ? eng.pmaInfo : null,
        logs,
      };
    } catch (e) { return { error: String(e && e.message) }; }
  };
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
    stageLog('error', `切换抗锯齿失败：${formatError(err)}`, { err: formatError(err) });
  }
}





















/** 左栏显示/隐藏：位移 + 淡出，与旧前端「模型库」按钮的过渡一致 */
function toggleLeftPanel() {
  state.leftPanelVisible = !state.leftPanelVisible;
  dom.leftPanel.classList.toggle('is-hidden', !state.leftPanelVisible);
  // 左栏位移是一次过渡 ⇒ 它的就绪状态重新起算（只重置左栏；右栏/顶栏不受影响）
  retrackStage('sidebarLeft');
  syncSidebarButtons(); // 高亮只认"实际可见"，不在这里单独写 aria
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




/** 绑定事件（只给"有真实行为"的控件挂处理器；其余控件在 HTML 里 disabled） */
function bindEvents() {
  applyTopbarIcons();          // 顶栏图标唯一来源：panel/icons.js
  bindSidebarStateSync();      // 高亮与边栏真实显隐同步（含影院/收起/过渡）
  dom.btnLibrary.addEventListener('click', toggleLeftPanel);
  dom.btnFullscreen.addEventListener('click', toggleFullscreen);
  // 顶栏两个真动作：截图导出（canvas→blob→下载）与影院模式（切 data-cinema，显隐在 CSS）
  if (dom.btnShot) dom.btnShot.addEventListener('click', () => exportScreenshot());
  if (dom.btnCinema) dom.btnCinema.addEventListener('click', () => toggleCinema());
  if (dom.btnMenu) dom.btnMenu.addEventListener('click', () => toggleRightPanel());
  // 面板头的「收起菜单」：委托绑定（面板会按渲染器能力重建，直接绑按钮会随重建丢失）
  if (dom.panelHead) {
    dom.panelHead.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ctl="btn-collapse-menu"]');
      if (btn) toggleRightPanel(false);
    });
  }
  bindCinemaKeys();
}

/** 插件宿主实例（boot 时创建；未就绪为 null） */
let pluginHost = null;

function boot() {
  // 面板与播放条是纯静态骨架（不依赖网络）：先挂上，保证首屏五区域都有内容
  // 舞台渲染器：WebGL 不可用（无头精简环境等）时只提示，不让整页崩
  try {
    setStage(createSpineStage({ canvas: dom.stageCanvas }));
    document.documentElement.dataset.stageContext = 'webgl';
  } catch (err) {
    state.stageError = formatError(err);
    stageLog('error', `渲染器不可用：${state.stageError}`, { reason: String(state.stageError || '') });
    document.documentElement.dataset.stageContext = 'none';
  }

  // topbar-disabled-mark
  for (const b of document.querySelectorAll('#app-header button:disabled')) b.dataset.pending = 'true';

  initRenderer();
  installCameraLogger(state.currentRenderer && state.currentRenderer.camera);

  attachInteraction();

  // 面板三态由当前渲染器能力决定；切换渲染器时必须重算 + 重跑自检（契约 INV-05）
  rebuildPanelFor(state.currentRenderer);
  if (state.surface && typeof state.surface.onRendererChange === 'function') {
    state.surface.onRendererChange(() => {
      rebuildPanelFor(state.currentRenderer);
      installCameraLogger(state.currentRenderer && state.currentRenderer.camera); // 换面后相机入口换了
    });
  }

  const transportInfo = mountTransport(dom.footer, {
    'transport-reset-view': () => resetViewViaRenderer(state.currentRenderer),
    'transport-play': () => toggleTransportPlay(),
    'transport-prev': () => stepVariant(-1),
    'transport-next': () => stepVariant(1),
    'transport-motion': (name) => applyTransportMotion(name),
    'transport-skin': (name) => { if (stage && stage.setSkin) stage.setSkin(name); },
  });
  state.transport = transportInfo;
  // 存储优先：主题/背景先按上次的选择恢复，再让"面板默认值"兜底未存过的项
  const savedView = readViewSettings();
  applyTheme(savedView.uiTheme || 'dark-cyan');
  applyBackground((savedView.background && savedView.background.mode) || 'checkerboard');
  if (state.panel && state.panel.setValue) {
    state.panel.setValue('ctl-theme', state.viewTheme);
    state.panel.setValue('ctl-bg-mode', state.viewBg);
  }
  // 面板声明的默认值即唯一真相：启动时统一走一遍生效表，避免"高亮在 A、引擎在 B"
  // MSAA 例外：它的默认值已由建上下文时的 antialias 生效，启动就重建会白等 2~5 秒
  const STARTUP_SKIP = new Set(['ctl-msaa', 'ctl-theme', 'ctl-bg-mode']);
  suspendPanelPersist(true); // 回放默认值不落盘：否则每次刷新都会把用户设置覆盖回默认
  for (const [id, value] of Object.entries((state.panel && state.panel.defaults) || {})) {
    if (STARTUP_SKIP.has(id)) continue;
    applyPanelSetting(id, value);
  }
  suspendPanelPersist(false);
  state.panelDefaults = { ...((state.panel && state.panel.defaults) || {}) };
  // 刷新后保持：把上次保存的面板设置重新应用一遍（主题/背景/MSAA 有各自恢复通道，跳过）
  try { restorePanelSettings(STARTUP_SKIP); } catch (err) { stageLog('warn', `恢复上次面板设置失败：${formatError(err)}`, { err: formatError(err) }); }
  document.documentElement.dataset.panelReady = '1';
  document.documentElement.dataset.panelControls = String((state.panel && state.panel.controls) || 0);
  document.documentElement.dataset.transportControls = String(transportInfo.controls);

  // 品牌与资源根互不依赖，并行拉取；任一失败都不影响另一条链路
  loadBrand();
  bindEvents();
  // 暴露给调试与自动化断言（M2 验收用）
  // 就绪信号：`__WEB__` 一建好就算"骨架可用"（契约 §三 shell 阶段）
  markStage('shell', 'interactive', { version: 'M4' });
  window.__WEB__ = Object.assign(window.__WEB__ || {}, {
    /** 当前渲染器（只读，便于排查：id / capabilities / camera 是否就绪） */
    get renderer() { return state.currentRenderer; },
    /** 能力自检（契约 §四）：随时可重跑，violations 非空即缺陷 */
    panelSelfCheck: () => runPanelSelfCheck(),
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
    /**
     * 插件宿主（资产提供者）。
     * 本阶段只做"加载 + 查询面"，不接渲染链路（接线在后续步骤）；
     * 但宿主必须在页面起来时就绪，否则插件脚本会注册到空宿主上白跑。
     */
    pluginHost: () => pluginHost,
  });
  loadRoots();

  // 插件宿主：非阻塞启动（失败只警告，绝不影响页面其它功能）。
  //   顺序关键：createPluginHost 内部先挂 window.SpineViewerPlugins 再注入 <script>，
  //   插件顶层读宿主时才拿得到。
  try {
    pluginHost = createPluginHost({
      log: (level, msg) => stageStatus(msg, level),
      // 解包来源（命中缓存/服务端解包/回落前端）必须进 diag：验收与排障都靠它取证
      diagEvent: (name, data) => diagEvent(name, data),
    });
    state.pluginHost = pluginHost;   // app 层（选模型分流）经 state 取用，不反向 import

    // 这里只是**启动预热**：不 await，不阻塞首屏。真正需要插件的能力入口
    //   （如资源包装载 loadBundleModel）会自己 await 一次 loadAll（幂等，已装载则立即返回），
    //   所以插件注册晚于首屏也安全。
    pluginHost.loadAll().catch((e) => stageLog('warn', `插件加载异常：${(e && e.message) || e}`, { err: String((e && e.message) || e) }));
  } catch (e) {
    stageLog('warn', `插件宿主初始化失败（页面其余功能不受影响）：${(e && e.message) || e}`, { err: String((e && e.message) || e) });
  }
}

boot();
