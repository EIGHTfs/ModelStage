// main.js —— ModelStage 新前端入口（M1）
//
// 做什么：
//   1. 装配各区域 DOM 引用并向 window.__WEB__ 暴露（自动化断言与手工排查都读它）；
//   2. 拉 GET /api/brand 应用品牌（标题 + 图标），未配置时回落到默认品牌名；
//   3. 接上顶栏「模型库」按钮 = 左栏显示/隐藏切换（与旧前端的面板开关语义一致）；
//   4. 拉 /api/roots 渲染资源根列表；失败时在左栏显示红色横幅，不抛到控制台。
// 为什么把状态放在 window.__WEB__.state：M7 要做持久化，需要一个显式 store；
//   现在先立最小形态（不引框架），后续里程碑往里加字段，避免各处散落全局变量。

import { getJson, formatError } from './api.js';
import { renderRoots } from './roots-list.js';

/** 服务端没配置品牌时的默认品牌名（唯一默认值，别处不重复写） */
const DEFAULT_BRAND = 'ModelStage';

/** 各区域 DOM 引用：集中取一次，避免函数里反复 querySelector */
const dom = {
  leftPanel: document.getElementById('left-panel'),
  rootsList: document.getElementById('roots-list'),
  brandTitle: document.getElementById('brand-title'),
  brandIcon: document.getElementById('brand-icon'),
  btnLibrary: document.getElementById('btn-library'),
  btnFullscreen: document.getElementById('btn-fullscreen'),
  stageHint: document.getElementById('stage-hint'),
};

/** 最小状态容器（M7 会扩展成带持久化的 store） */
const state = {
  roots: [],
  rootsError: null,
  leftPanelVisible: true,
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
  dom.rootsList.replaceChildren(banner);
}

/** 拉取并渲染资源根列表 */
async function loadRoots() {
  try {
    const data = await getJson('/api/roots');
    const roots = Array.isArray(data?.roots) ? data.roots : [];
    state.roots = roots;
    const { ids } = renderRoots(roots, dom.rootsList);
    // 供自动化断言：页面渲染出的 id 序列（顺序即服务端返回顺序）
    document.documentElement.dataset.rootsIds = ids.join(',');
    document.documentElement.dataset.rootsReady = '1';
    dom.stageHint.textContent = `M1 骨架 · 资源根 ${roots.length} 个 · 舞台渲染在 M4 接入`;
  } catch (err) {
    state.rootsError = formatError(err);
    document.documentElement.dataset.rootsReady = 'error';
    showRootsError(state.rootsError);
  }
}

/** 绑定事件（只在有真实行为的按钮上挂；M3 之前其余按钮保持无处理器） */
function bindEvents() {
  dom.btnLibrary.addEventListener('click', toggleLeftPanel);
  dom.btnLibrary.setAttribute('aria-expanded', 'true');
  dom.btnFullscreen.addEventListener('click', toggleFullscreen);
}

function boot() {
  // 品牌与资源根互不依赖，并行拉取；任一失败都不影响另一条链路
  loadBrand();
  bindEvents();
  // 暴露给调试与自动化断言（M1 验收用）
  window.__WEB__ = { state, version: 'M1', defaultBrand: DEFAULT_BRAND };
  loadRoots();
}

boot();
