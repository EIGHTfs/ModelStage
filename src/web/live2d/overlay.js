// live2d/overlay.js —— 覆盖层容器与画布的 DOM 生命周期
//
// 覆盖层是一个 absolute + overflow:hidden 的 div，里面放 PIXI 用的 canvas。
//   · 它 pointer-events:none ⇒ 指针事件下穿到舞台，交互路径与 Spine 完全一致；
//   · 元素由 Surface.ensureOverlay 创建，**尺寸也由 overlay.setBox 写入**
//     （容器 style + canvas attr/style 一处收口）。本模块只管显隐与结构，
//     不再写任何内联尺寸 —— 历史上这里写过 px，导致旋转后容器钉在旧尺寸、把画布裁掉。
import { OVERLAY_ID, OVERLAY_CANVAS_ID } from './stage-ctx.js';

/** 取尺寸几何：入参优先，否则向 Surface 句柄要（兼容 {geometry()} 与 {size,dpr}） */
function resolveBoxGeometry(ctx, geo) {
  if (geo && geo.cssW && geo.cssH) return geo;
  try { return ctx.surfaceGeometry ? ctx.surfaceGeometry() : null; } catch { return null; }
}

/** 生效像素比：优先 res，其次 dpr，都没有就当 1 */
function pickResolution(g) {
  if (Number(g.res) > 0) return Number(g.res);
  if (Number(g.dpr) > 0) return Number(g.dpr);
  return 1;
}

/**
 * 创建覆盖层模块。
 * @param {object} ctx 运行时上下文
 * @returns {{buildOverlay:Function, setBox:Function, showOverlay:Function, hide:Function}}
 */
export function createOverlay(ctx) {
  const { st, note, surfaceSize, getOverlayHost } = ctx;

  /**
   * 取覆盖层容器（**由 Surface.ensureOverlay 创建**，本函数只取用）。
   *
   * 兜底：若 Surface 还没建（独立使用本模块/异常时序），这里按同样的结构补一个，
   *   但尺寸仍由 overlay.setBox 写 —— 本模块不再拥有"尺寸"这件事。
   */
  function buildOverlay() {
    // 复用条件必须**同时**满足：容器还在 DOM 里 **且** 里面确实有覆盖层 canvas。
    //
    // 为什么必须查 canvas（这个条件是踩过坑才补上的）：
    //   PIXI 的 `app.destroy(true)` 第一参数是 removeView —— 它会把 canvas 从容器里摘掉。
    //   渲染面"卸载"（同面换模型会走 unmount）正是这么做的；此时容器 div 仍在 DOM、
    //   `st.overlay.isConnected` 仍为 true，只看 isConnected 就会**复用空容器** ⇒
    //   ensureApp 用 getElementById 取 canvas 得到 null ⇒ PIXI 自建 canvas 但不插入 DOM ⇒
    //   渲染在游离画布上，页面一片空白，而 stats 照样报"已加载"。
    // 所以：容器可复用，但**canvas 丢了必须补建**（不整块重建，省掉重建容器的副作用）。
    const hasCanvas = (el) => !!(el && el.querySelector && el.querySelector(`#${OVERLAY_CANVAS_ID}`));
    if (st.overlay && st.overlay.isConnected && hasCanvas(st.overlay)) return st.overlay;
    const host = (typeof getOverlayHost === 'function' ? getOverlayHost() : null)
      || document.getElementById('stage') || document.body;
    let el = document.getElementById(OVERLAY_ID)
      || (st.overlay && st.overlay.isConnected ? st.overlay : null);
    if (!el) {
      el = document.createElement('div');
      el.id = OVERLAY_ID;
      // 关键：pointer-events:none ⇒ 事件下穿到 Spine 画布（规则在 style.css 的 #live2d-overlay）
      host.appendChild(el);
    }
    if (!hasCanvas(el)) {
      const cv = document.createElement('canvas');
      cv.id = OVERLAY_CANVAS_ID;
      el.appendChild(cv);
    }
    st.overlay = el;
    return el;
  }

  /** 写容器盒（只在真的变了才写，避免每帧触发样式重算） */
  function setContainerBox(el, pxW, pxH) {
    if (el.style.width !== pxW) el.style.width = pxW;
    if (el.style.height !== pxH) el.style.height = pxH;
  }

  /** 写画布：attr = css×res（backing store），style = css px（显示尺寸，两者必须同时改） */
  function setCanvasBox(cv, w, h, res, pxW, pxH) {
    const attrW = Math.max(1, Math.round(w * res));
    const attrH = Math.max(1, Math.round(h * res));
    if (cv.width !== attrW) cv.width = attrW;
    if (cv.height !== attrH) cv.height = attrH;
    if (cv.style.width !== pxW) cv.style.width = pxW;
    if (cv.style.height !== pxH) cv.style.height = pxH;
  }

  /**
   * 覆盖层尺寸的**唯一写入点**（容器 style + 内部 canvas 的 attr/style）。
   *
   * 为什么必须单点且显式声明：覆盖层是 absolute + overflow:hidden，可见区域由容器内联 px 决定。
   *   只 resize PIXI 而不改容器，画布会被旧宽度裁掉 —— 真机旋转后表现为
   *   "模型挤在左侧窄带、右侧露出棋盘格"，而手动重载模型（重走 showOverlay）就恢复。
   *   Surface 只负责建元素（ensureOverlay，初值 100%），尺寸同步归渲染器自己。
   *
   * 尺寸来源只用 Surface 下发的 geometry，不读 DOM。
   * @param {{cssW:number, cssH:number, dpr?:number, res?:number}} [geo] 缺省时向 Surface 句柄取
   * @returns {boolean} 是否写入成功
   */
  function setBox(geo) {
    const g = resolveBoxGeometry(ctx, geo);
    if (!g) return false;
    const el = document.getElementById(OVERLAY_ID);
    if (!el) return false;
    const w = Math.max(1, Math.round(g.cssW));
    const h = Math.max(1, Math.round(g.cssH));
    const pxW = `${w}px`;
    const pxH = `${h}px`;
    setContainerBox(el, pxW, pxH);
    const cv = document.getElementById(OVERLAY_CANVAS_ID);
    if (cv) setCanvasBox(cv, w, h, pickResolution(g), pxW, pxH);
    return true;
  }

  /**
   * 显示覆盖层（不改变 active；active 由 loadForEngine 决定）。
   *
   * 本函数**只管显隐**，不写任何尺寸：容器与画布的尺寸统一由 setBox() 写。
   *   历史教训：这里曾按装载时的尺寸写内联 px，旋转后容器钉在旧 px、把画布裁掉，
   *   表现为"模型挤在左侧窄带"，重载模型（重走本函数）才恢复。
   */
  function showOverlay() {
    const el = buildOverlay();
    el.style.display = 'block';
    // 已有 PIXI 实例（二次显示）：立即按句柄尺寸重校准渲染器与视图
    if (st.app) ctx.api.pixiApp.fitAppToOverlay();
    ctx.api.view.syncRect();
  }

  function hide() {
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.style.display = 'none';
    if (st.model) {
      try { st.app && st.app.stage.removeChild(st.model); } catch { /* 忽略 */ }
      try { st.model.destroy({ children: true }); } catch { /* 忽略 */ }
      st.model = null;
    }
    try { if (st.app && typeof st.app.stop === 'function') st.app.stop(); } catch { /* 忽略 */ }
    st.active = false;
    st.modelId = null;
    note('Live2D 已卸载（覆盖层隐藏、模型销毁、渲染循环停止）');
    return true;
  }

  return { buildOverlay, setBox, showOverlay, hide };
}