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

// 诊断探针必须最先装：后面的模块/渲染出问题时才有取证（API 与旧前端 public/diag.js 一致）
import { installDiag } from './diag.js';
import { getJson, formatError } from './api.js';
import { createRosterView } from './roster-view.js';
import { mountPanel } from './panel.js';
import { mountTransport } from './transport.js';
import { createSpineStage } from './spine-canvas.js';

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
const state = {
  roots: [],
  rootsError: null,
  leftPanelVisible: true,
  selectedModel: null,
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
  if (!stage) { dom.stageHint.textContent = `已选中 ${name}（渲染器不可用）`; return; }
  if (!model) { stage.unload(); return; }

  // 只有 Spine 走本路径；Live2D 与资源包由 M5 的插件管线接管
  const kind = model.kind || 'spine';
  if (kind !== 'spine') {
    stage.unload();
    dom.stageHint.textContent = `已选中 ${name}（${kind === 'live2d' ? 'Live2D' : '资源包'} 渲染在 M5 接入）`;
    return;
  }

  dom.stageHint.textContent = `正在加载 ${name}…`;
  stage.load({ root: model.rootId, model })
    .then((info) => {
      dom.stageHint.textContent = `${model.name} · Spine ${info.version} · ${info.animations.length} 动作 · 播放 ${info.motion || '（无动作）'}`;
      document.documentElement.dataset.stageReady = '1';
    })
    .catch((err) => {
      // 渲染失败属业务错误：显示在舞台提示与 __WEB__ 里，不抛到控制台（验收要求零错误）
      const msg = formatError(err);
      state.stageError = msg;
      dom.stageHint.textContent = `渲染失败：${msg}`;
      document.documentElement.dataset.stageReady = 'error';
    });
}

/** 拉资源根并把名册三级树挂到左栏 */
async function loadRoots() {
  try {
    const data = await getJson('/api/roots');
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
    await roster.mount(roots);
    // 供自动化断言：资源根 id 序列（与 /api/roots 一致）+ 名册状态快照
    document.documentElement.dataset.rootsIds = roots.map((r) => r.id).join(',');
    document.documentElement.dataset.rootsReady = '1';
    dom.stageHint.textContent = `M2 名册 · ${roots.length} 个资源根 · 舞台渲染在 M4 接入`;
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
    dom.stageHint.textContent = `渲染器不可用：${state.stageError}`;
    document.documentElement.dataset.stageContext = 'none';
  }

  const panelInfo = mountPanel({ headEl: dom.panelHead, bodyEl: dom.panelBody });
  const transportInfo = mountTransport(dom.footer);
  document.documentElement.dataset.panelReady = '1';
  document.documentElement.dataset.panelControls = String(panelInfo.controls);
  document.documentElement.dataset.transportControls = String(transportInfo.controls);

  // 品牌与资源根互不依赖，并行拉取；任一失败都不影响另一条链路
  loadBrand();
  bindEvents();
  // 暴露给调试与自动化断言（M2 验收用）
  window.__WEB__ = {
    state,
    version: 'M4',
    /** 渲染舞台（测试脚本用它取像素、看统计） */
    get stage() { return stage; },
    /** 诊断探针实例（等价于 window.__DIAG__，便于同一套检查代码复用） */
    get diag() { return diag; },
    /** 面板/播放条骨架规模（自动化断言用） */
    chrome: { groups: panelInfo.groups, panelControls: panelInfo.controls, transportControls: transportInfo.controls },
    defaultBrand: DEFAULT_BRAND,
    /** 名册状态快照（未挂载时返回 null） */
    rosterSnapshot: () => (state.roster ? state.roster.snapshot() : null),
  };
  loadRoots();
}

boot();
