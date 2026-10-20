// renderer-live2d.js —— Live2D 渲染器（注册到 StageSurface 的渲染面实现）
//
// 契约（StageSurface.renderer）：
//   { id, capabilities, mount(document, handle) → info, dispose(), isActive(), camera }
// 边界：画布与尺寸由 StageSurface 提供（handle），本文件不读 DOM 尺寸、不建画布。

import { createCamera } from './render/camera/index.js';

/**
 * 创建 Live2D 渲染器。
 * @param {{live2d: object}} options live2d 为覆盖层实现（提供 mount/dispose/isActive/bridge）
 */
export function createLive2DRenderer({ live2d } = {}) {
  if (!live2d) throw new Error('createLive2DRenderer: 需要 live2d 实现');
  // 相机统一入口：档位/范围/复位语义与 Spine 完全一致，差异只在 backend
  const camera = createCamera({
    kind: 'live2d',
    backend: {
      /** 当前缩放（bridge 是唯一真相） */
      getScale: () => { try { return live2d.bridge.readState().zoom; } catch { return null; } },
      /** 写入缩放（bridge 内部仍会按 CAMERA 常量夹取） */
      setScale: (v) => { try { live2d.bridge.setZoomRatio(v); } catch { /* 忽略 */ } },
      /** 平移：屏幕像素增量，1:1 交给覆盖层 */
      pan: (dx, dy) => { try { live2d.bridge.pan(dx, dy); } catch { /* 忽略 */ } },
      /** 复位：bridge 归 1 并重排 */
      resetView: () => { try { live2d.bridge.resetView(); } catch { /* 忽略 */ } },
    },
  });
  let handleRef = null;

  return {
    id: 'live2d',
    capabilities: {
      // Live2D 不支持 Spine 的插槽/网格类设置项：只声明确实生效的
      settings: ['filter'],
      debugDraw: [],
      camera: 'ortho-2d',
    },
    camera,
    /**
     * 装载：把 Surface 句柄透传给覆盖层实现（画布/尺寸/DPR 都从这里来）。
     * @param {object} document
     * @param {object} handle
     */
    async mount(document, handle) {
      handleRef = handle || null;
      return live2d.mount(document, handle);
    },
    /**
     * 尺寸变化：覆盖层 canvas 的像素尺寸按**引擎同一口径**的 DPR 设置。
     * 不做设备像素比推断（软件渲染 / 封顶 2 / dprMode 只有引擎知道），
     *   统一由 StageSurface 的 geometry().res 下发。
     * @param {{cssW:number, cssH:number}} box
     */
    resize(box) {
      // 尺寸唯一来源：handle.geometry()（Surface 提供）；box 只作兜底
      const g = (() => { try { return handleRef && handleRef.geometry ? handleRef.geometry() : null; } catch { return null; } })();
      const cssW = Math.max(1, Math.round((g && g.cssW) || (box && box.cssW) || 0));
      const cssH = Math.max(1, Math.round((g && g.cssH) || (box && box.cssH) || 0));
      const res = Math.max(1, (g && g.res) || (box && box.dpr) || 1);
      if (!cssW || !cssH) return;
      const overlayCv = (() => { try { return document.getElementById('live2d-overlay-canvas'); } catch { return null; } })();
      if (overlayCv) {
        const w = Math.max(1, Math.floor(cssW * res));
        const h = Math.max(1, Math.floor(cssH * res));
        if (overlayCv.width !== w) overlayCv.width = w;
        if (overlayCv.height !== h) overlayCv.height = h;
      }
      if (typeof live2d.syncSize === 'function') {
        try { live2d.syncSize({ size: { width: cssW, height: cssH }, dpr: res }); } catch { /* 忽略 */ }
      }
    },
    /** DPR 变化：与引擎保持同口径（Live2D 自身不决定像素比） */
    setDpr() { /* 由 resize() 统一按引擎口径同步 */ },
/** 幂等卸载（覆盖层的隐藏由 StageSurface 负责） */
    dispose() {
      try { if (typeof live2d.dispose === 'function') live2d.dispose(); } catch { /* 忽略 */ }
    },
    isActive() {
      try { return !!live2d.isActive(); } catch { return false; }
    },
    /** Surface 的帧入口（Live2D 由 PIXI 自己的 ticker 驱动，这里只对齐画布尺寸） */
    render(handle) {
      try { if (live2d.syncSize && handle) live2d.syncSize(handle); } catch { /* 忽略 */ }
    },
  };
}

export default createLive2DRenderer;
