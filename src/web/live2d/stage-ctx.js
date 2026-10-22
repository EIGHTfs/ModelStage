// live2d/stage-ctx.js —— Live2D 舞台的运行时上下文（状态 + 薄工具）
//
// 为什么单独成模块：整个 Live2D 分支是"一个对象 + 一堆方法"的形状，状态（st / handleRef）
//   是它们共同的隐式参数。把这个上下文集中到一处，其余模块按职责切开时才有明确的边界。
//
// 约定：ctx.st 对子模块可见（读写）。这些函数本来就是同一个对象的内部实现，
//   再套一层 getter/setter 只增加噪音，换不来真实约束。
//   ctx.api 是装配期注册表：stage.js 依次建好各模块后挂进来，模块之间不直接 import（避免环）。
import { CAMERA } from '../render/camera/constants.js';

/** 覆盖层容器 id（与参考实现区分：这是新前端的独立覆盖层） */
export const OVERLAY_ID = 'live2d-overlay';
/** 覆盖层内 canvas 的 id */
export const OVERLAY_CANVAS_ID = 'live2d-overlay-canvas';
/** 运行时库（顺序不可颠倒：cubismcore 必须最先，pixi-live2d-display 初始化会检查它） */
export const LIBS = [
  '/live2d-lib/live2dcubismcore.min.js',
  '/live2d-lib/live2d.min.js',
  '/live2d-lib/pixi.min.js',
  '/live2d-lib/index.min.js',
];
/** 缩放范围唯一来源：render/camera/constants.js（禁止在此写裸数字） */
export const ZOOM_MIN = CAMERA.MIN;
export const ZOOM_MAX = CAMERA.MAX;

/**
 * 判定"带 scheme 的引用"（拼接目录时用）：任意 scheme 或 data: 都不要拼目录。
 *
 * 为什么拼接前必须判：模型定义里允许写绝对 URL，拼上去会变成
 *   `/files/dir/http://host/x.motion3.json` 这种无效地址（曾导致 14 次 miss）。
 *   注意这里包含 `vfs://` —— 它的作用是"别再前缀目录"，不是"可直连"。
 * @param {string} url
 * @returns {boolean}
 */
export function isAbsoluteRef(url) {
  const text = String(url == null ? '' : url);
  if (!text) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return true;
  return /^data:/i.test(text);   // data: 可能不带 //
}

/**
 * 判定"浏览器可直接取用"的地址（resolveAsset 短接用）：http/https/blob/data。
 *
 * **不能包含 vfs://**：vfs:// 是虚拟地址，必须交给 VirtualFS 解析成 blob/真实地址；
 *   当成"可直连"放行会让浏览器直接 fetch('vfs://…') → Network error
 *   （这条我自己先踩了一次：短接后 vfs:// 装载全挂、hits 变 0）。
 * @param {string} url
 * @returns {boolean}
 */
export function isDirectUrl(url) {
  const text = String(url == null ? '' : url);
  if (!text) return false;
  if (/^(https?|blob):/i.test(text)) return true;
  return /^data:/i.test(text);
}

/** 创建运行时上下文。
 * @param {{vfs?: object, getOverlayHost?: Function, log?: Function}} options
 * @returns {object} ctx（st / handleRef / 薄工具 / api 注册表）
 */
export function createStageContext({ vfs, getOverlayHost, log } = {}) {
  const ctx = {
    vfs: vfs || null,
    getOverlayHost: typeof getOverlayHost === 'function' ? getOverlayHost : null,
    /** 装配期注册表：overlay / pixiApp / view / probe / model 依次挂进来 */
    api: {},
  };
  /** StageSurface 句柄（画布/尺寸/DPR 由 Surface 提供；为空时退回自建覆盖层） */
  ctx.handleRef = null;

  const st = {
    app: null,          // PIXI.Application
    model: null,        // PIXI.live2d.Live2DModel
    libsReady: null,    // 库加载 Promise
    active: false,      // 是否处于激活态（引擎 l2dActive 依赖它）
    zoomRatio: 1,       // 缩放倍数（唯一写入方是 bridge.setZoomRatio）
    panX: 0,
    panY: 0,
    modelId: null,      // 当前模型 id（引擎用它判断复用）
    meta: null,         // 当前模型元数据（motions / expressions）
    motionMap: new Map(), // 标签 -> { group, index }
  };
  ctx.st = st;

  /** 统一日志出口（缺省静默） */
  function note(message, level = 'info') {
    if (typeof log === 'function') {
      try { log(message, level); } catch { /* 日志失败不影响渲染 */ }
    }
  }

  /** 资源入口经 VirtualFS 解析（命中用 Blob URL，未命中回落原 URL） */
  function resolveAsset(url) {
    if (!url) return null;
    // 已经可直接取用（http/https/blob/data）就不必问 VFS：它对这些永远 miss
    // 注意 vfs:// 不在此列 —— 那是虚拟地址，必须由 VirtualFS 解析
    if (isDirectUrl(url)) return url;
    try {
      const hit = vfs && typeof vfs.resolve === 'function' ? vfs.resolve(url) : null;
      return hit || url;
    } catch {
      return url;
    }
  }

  /** 取条目的入口地址（兼容 entry.url / modelUrl） */
  function entryUrlOf(doc) {
    if (!doc) return null;
    if (doc.entry && doc.entry.url) return doc.entry.url;
    return doc.modelUrl || null;
  }

  /**
   * Surface 下发的几何（唯一尺寸来源）。
   *
   * 必须兼容两种"句柄"形态，因为调用方给的并不总是同一个东西：
   *   · 真 handle：`{ geometry(), dpr, ... }` —— Surface 在 mount / render(handle) 时传；
   *   · 轻量盒：  `{ size: { width, height }, dpr }` —— render/live2d.js 在 resize() 里传。
   * 早期只认第一种，于是渲染器 resize 那条路径上 `surfaceGeometry()` 恒为 null：
   *   渲染器自己 resize 了 PIXI，但覆盖层**容器**的 CSS 盒拿不到尺寸、没人更新 ⇒
   *   画布被旧容器裁掉（真机旋转后"模型挤在左侧窄带"）。这里补上第二种形态即可。
   *
   * @returns {{cssW:number, cssH:number, dpr:number, res:number}|null}
   */
  function surfaceGeometry() {
    try {
      const h = ctx.handleRef;
      if (!h) return null;
      if (typeof h.geometry === 'function') return h.geometry();
      const size = h.size || null;
      if (size && size.width > 0 && size.height > 0) {
        // 轻量盒没有 res 字段时用 dpr 顶上（Surface 的 res 缺省就是设备比）
        const res = Number(h.res) > 0 ? Number(h.res) : (Number(h.dpr) > 0 ? Number(h.dpr) : 1);
        return { cssW: size.width, cssH: size.height, dpr: res, res };
      }
      return null;
    } catch { return null; }
  }

  /** Surface 下发的 CSS 尺寸 */
  function surfaceSize() {
    const g = surfaceGeometry();
    return g ? { width: g.cssW, height: g.cssH } : null;
  }

  function width8() { const g = surfaceGeometry(); return g ? g.cssW : 0; }
  function height8() { const g = surfaceGeometry(); return g ? g.cssH : 0; }

  Object.assign(ctx, { note, resolveAsset, entryUrlOf, surfaceGeometry, surfaceSize, width8, height8 });
  return ctx;
}