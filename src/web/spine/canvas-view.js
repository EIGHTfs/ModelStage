// spine/canvas-view.js —— 视口/相机/设置快照
//
// 职责：相机缩放与取景、设置默认值与回读、stats 快照的组装。
// 为什么单独成模块：这些是「纯状态换算」，不碰引擎生命周期；拆开后 canvas.js 只留装配。
// 注意：settings 快照是设置类 setter 的"回显权威"（getSetting 读它判成功），字段名不可改。

/**
 * 相机视图约定（交互层按此实现，勿改）：
 *   · pan 单位 = 屏幕像素，原点 = 画布中心（即 fit 视图的中心），向右/向下为正；
 *   · zoom = 相对 fit 的倍数，reset 后为 1.0，取值 0.2~8；
 *   · 世界单位 ↔ 屏幕像素的换算只在本文件做：屏幕 = 世界差值 × base.zoom × zoom。
 */

/** 相机视图：缩放范围（相对 fit 的倍数）与取景基准缓存 */
const VIEW_ZOOM_MIN = 0.2;

const VIEW_ZOOM_MAX = 8;

export const DEFAULT_SETTINGS = {
  pma: 'auto', fit: 'subject', textureFilter: 'linear', speed: 1, loop: true, debug: null,
  fpsLimit: 60, dprMode: 'auto', msaa: 'auto', filter: 'original',
};

/** 当前相机对象（部分运行时用 scale 而非 zoom） */
function cameraOf(st) {
  return st.engine && st.engine.camera ? st.engine.camera : null;
}

/** 读相机缩放（统一成"越大越放大"的 zoom 语义） */
function cameraZoom(cam) {
  if (!cam) return 1;
  if (cam.zoom !== undefined) return cam.zoom;
  if (cam.scale) return 1 / cam.scale;
  return 1;
}

/** 写相机缩放（与 cameraZoom 的两种字段对应） */
function setCameraZoom(cam, zoom) {
  if (!cam) return;
  if (cam.zoom !== undefined) cam.zoom = zoom;
  else if (cam.scale !== undefined) cam.scale = 1 / zoom;
}

/**
 * 取"fit 后的缩放"作为视图基准。
 * 引擎的 baseZoom 就是 fit 结果；只有在拿不到时才退回当前相机 zoom。
 * （曾经用"调用时的相机 zoom"当基准，导致 reset 之后基准被上一次的缩放污染）
 */

/**
 * 记录视图基准：缩放基准取引擎的 userScale（引擎语义「越大越放大」），平移累计归零。
 * 不在本文件推导相机字段——引擎的 camera.zoom 是 userScale 的倒数，自己算必错。
 */
export function captureViewBase(st) {
  const engine = st.engine;
  // 基准 = 当前 userScale（引擎的 getCameraZoom 是唯一真相；resetCamera 之后取一次即可）
  st.viewBaseScale = engine && typeof engine.getCameraZoom === 'function' ? engine.getCameraZoom() : 1;
  st.viewPan = { x: 0, y: 0 };
}

/**
 * 标定「平移输入 1 像素 → 画面位移多少像素」。
 * 为什么要标定：引擎 applyPan 内部有 `×2` 与 flip 系数，直接原样传会让拖动比手指快一倍多。
 * 做法：applyPan(±1) 探测相机世界位移，再乘「每世界单位对应多少屏幕像素」，探测后立即复原（净位移 0）。
 */

/**
 * 视图快照（对外单位约定）。
 *   zoom = 相对 fit 的倍数：engine.getCameraZoom() / 基准 userScale；reset 后为 1；
 *   panX/panY = **屏幕像素**，原点画布中心，向右/向下为正（累计值）。
 */
export function viewOf(st) {
  const engine = st.engine;
  const base = st.viewBaseScale || 1;
  const cur = engine && typeof engine.getCameraZoom === 'function' ? engine.getCameraZoom() : base;
  const pan = st.viewPan || { x: 0, y: 0 };
  return {
    zoom: +(cur / base).toFixed(4),
    panX: +pan.x.toFixed(2),
    panY: +pan.y.toFixed(2),
    userScale: +cur.toFixed(6),
    baseUserScale: +base.toFixed(6),
    available: !!engine,
  };
}

/** 只读统计（不暴露 engine 内部对象） */
export function statsOf(st) {
  const e = st.engine;
  return {
    model: st.model ? { name: st.model.name, version: st.model.version } : null,
    runtimeVersion: e && e.getRuntimeVersion ? e.getRuntimeVersion() : null,
    runtimeKeys: [...st.runtimeKeys],
    contexts: e && e.gl ? 1 : 0,
    frames: st.frames,
    fps: e && e.getCurrentFps ? e.getCurrentFps() : null,
    loads: st.loads,
    disposes: st.disposes,
    lastError: st.lastError,
    animations: e && e.getAnimations ? e.getAnimations() : [],
    settings: { ...st.settings },
    view: viewOf(st),
  };
}
