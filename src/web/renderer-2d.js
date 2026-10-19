// renderer-2d.js —— 2D 渲染器（Spine 与 Live2D 共用同一个实现）
//
// 为什么是「一个渲染器」而不是两个：引擎的 applyZoom / applyPan / resetCamera 开头都有
//   l2dActive() 分支，会把相机操作委托给 Live2D bridge，所以 Spine 与 Live2D 天然共享同一套相机；
//   「渲染器 ≠ 内容类型」——3D 才是另一个渲染器（自带透视/轨道相机）。
//
// 本模块只做三件事：
//   1. 声明能力（capabilities）：本渲染器支持哪些设置项、哪些调试项、相机类型；
//   2. 把现有 stage 的生命周期薄转发成 mount / unmount / dispose；
//   3. 直接复用 stage.camera（**不复制、不改写** stage-camera 的逻辑）。
//
// 边界：不做任何坐标换算、不引入新依赖、不判断内容类型（由 document.kind 决定，交给 stage.load）。

/** 2D 渲染器支持的设置项（面板据此显隐/禁用） */
const SETTINGS = ['fps', 'dpr', 'msaa', 'filter', 'pma', 'fit'];

/** 2D 渲染器支持的调试绘制项（与引擎 setDebugDraw 的键一一对应） */
const DEBUG_DRAW = ['bones', 'meshes', 'boundingBoxes', 'paths', 'points', 'regions', 'clipping', 'hulls'];

/**
 * 创建 2D 渲染器。
 * @param {{stage: object}} options stage 为现有舞台实例（提供 load/unload/dispose/camera）
 * @returns {{
 *   id: string,
 *   capabilities: {settings: string[], debugDraw: string[], camera: string},
 *   camera: object,
 *   mount: (document: object, host?: object) => any,
 *   unmount: () => any,
 *   dispose: () => any,
 * }} 渲染器对象
 */
export function createRenderer2D({ stage } = {}) {
  if (!stage || typeof stage.load !== 'function') {
    throw new Error('createRenderer2D: 需要提供 load 能力的 stage');
  }

  return {
    id: 'renderer-2d',
    capabilities: {
      settings: SETTINGS.slice(),
      debugDraw: DEBUG_DRAW.slice(),
      camera: 'ortho-2d',
    },
    // 相机归属渲染器：直接引用现有入口，语义与行为保持零改动
    camera: stage.camera,
    /**
     * 挂载（现阶段薄转发到 stage.load）。
     * @param {object} document 舞台文档描述（当前即 { root, model } 形态）
     * @param {object} [host] 预留：{ gl, canvas, requestRender, onResize }
     */
    mount(document, host) {
      void host; // 预留参数：3D 渲染器会用到，2D 现阶段不需要
      return stage.load(document);
    },
    /** 卸载当前内容（保留渲染器本身） */
    unmount() {
      return typeof stage.unload === 'function' ? stage.unload() : undefined;
    },
    /** 释放渲染器自身资源 */
    dispose() {
      return typeof stage.dispose === 'function' ? stage.dispose() : undefined;
    },
  };
}

export default createRenderer2D;
