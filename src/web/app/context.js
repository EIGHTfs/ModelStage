// app/context.js —— 页面级共享上下文（DOM 引用、状态容器、舞台实例）
//
// 为什么要单独成模块：main.js 只做装配，各功能模块（状态行、视图设置、部件筛除、外壳控件…）
//   都要读同一份 state / dom / stage。用一个共享上下文模块把它们接起来，避免层层传参。
//
// 关键点：stage 是**可变绑定**（boot 时创建、WebGL 不可用时保持 null）。ESM 的 import 是活绑定，
//   所以其它模块 `import { stage }` 能实时看到这里的新值；main.js 通过 setStage() 赋值
//   （模块外不能直接给导入的绑定赋值）。

/**
 * 自动化断言与手工排查的唯一读取口。必须**尽早**建好：boot 早期就有状态日志要落盘、
 *   有 hangGuard/panelSelfCheck 等计数要暴露，晚建会让这些记录静默丢失（实测踩过）。
 */
window.__WEB__ = window.__WEB__ || {};

/** 各区域 DOM 引用：集中取一次，避免函数里反复 querySelector */
export const dom = {
  leftPanel: document.getElementById('left-panel'),
  rosterList: document.getElementById('roster-list'),
  rosterCount: document.getElementById('roster-count'),
  rosterSearch: document.getElementById('roster-search'),
  btnCollapse: document.getElementById('btn-collapse'),
  brandTitle: document.getElementById('brand-title'),
  brandIcon: document.getElementById('brand-icon'),
  btnLibrary: document.getElementById('btn-library'),
  btnShot: document.getElementById('btn-shot'),
  btnCinema: document.getElementById('btn-cinema'),
  btnFullscreen: document.getElementById('btn-fullscreen'),
  stageHint: document.getElementById('stage-hint'),
  stageCanvas: document.getElementById('stage-canvas'),
  panelHead: document.getElementById('panel-head'),
  panelBody: document.getElementById('panel-body'),
  footer: document.getElementById('app-footer'),
  // 资源根管理（F4）
  rootAddForm: document.getElementById('root-add-form'),
  rootAddPath: document.getElementById('root-add-path'),
  rootAddName: document.getElementById('root-add-name'),
  rootPathHints: document.getElementById('root-path-hints'),
  rootList: document.getElementById('root-list'),
  rootMsg: document.getElementById('root-msg'),
  rootCount: document.getElementById('root-count'),
  btnRootToggle: document.getElementById('btn-root-toggle'),
  rootManagerBody: document.getElementById('root-manager-body'),
};

/** Spine 渲染舞台：boot 时创建（WebGL 不可用时保持 null，UI 只提示不报错） */
export let stage = null;

/** 设置舞台实例（唯一写入口；外部模块通过 import 的活绑定读到新值） */
export function setStage(next) {
  stage = next;
  return stage;
}

/** 最小状态容器（M7 会扩展成带持久化的 store） */
export const state = {
  // 表现侧开关（与渲染器无关，由外壳自己维护）：状态行显隐 / 调试日志浮层 / 防卡死保护
  showStatus: true,
  debugLog: true,
  hangGuard: true,
  debugLogHandle: null,
  debugPanel: null,
  debugPanelHost: null,
  hangGuardTimer: null,
  hangGuardStats: null,
  roots: [],
  rootsError: null,
  leftPanelVisible: true,
  selectedModel: null,
  // 当前渲染器：核心不再直接持有相机，统一从它取（现阶段只有 2D 一个实现）
  currentRenderer: null,
};
