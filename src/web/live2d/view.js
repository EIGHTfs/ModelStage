// live2d/view.js —— 视图数学（适配 / 缩放 / 平移 / 尺寸同步）
//
// 这里是"模型在画布上落在哪、多大"的唯一算法来源：computeFit 量包围盒，applyZoom 叠加
//   缩放与平移。相机状态（zoomRatio / panX / panY）在 ctx.st 上，由 bridge 写入。
//
// 两条尺寸入口都必须同时做两件事，缺一就会出现"画布变了但可见区域没变"：
//   ① PIXI 渲染器 resize（pixiApp.fitAppToOverlay / 直接 resize）
//   ② 覆盖层容器与画布尺寸由 overlay.setBox 统一写入（本模块两条尺寸入口都会调它）
//   —— 旋转后"模型挤在左侧窄带"就是只做了 ① 没做 ②。

/** 取包围盒字段，缺失时回落（b 可能为 null） */
function boundOr(b, key, fallback) {
  return (b && b[key]) || fallback;
}

/**
 * 创建视图模块。
 * @param {object} ctx 运行时上下文
 * @returns {{computeFit:Function, applyZoom:Function, syncRect:Function, syncSize:Function}}
 */
export function createView(ctx) {
  const { st, surfaceGeometry, surfaceSize } = ctx;

  function computeFit() {
    const model = st.model;
    if (!model) return null;
    model.scale.set(1);
    model.position.set(0, 0);
    const b = model.getBounds();
    return {
      x: boundOr(b, 'x', 0),
      y: boundOr(b, 'y', 0),
      w: boundOr(b, 'width', model.width || 1),
      h: boundOr(b, 'height', model.height || 1),
    };
  }

  function applyZoom() {
    const model = st.model;
    if (!model || !st.app) return;
    const res = st.app.renderer.resolution || 1;
    // 尺寸优先取 Surface 句柄（渲染器不自己算画布尺寸）
    const size = surfaceSize();
    const W = size ? size.width : st.app.renderer.width / res;
    const H = size ? size.height : st.app.renderer.height / res;
    const fit = computeFit();
    if (!fit) return;
    const s = Math.min(W / fit.w, H / fit.h) * 0.98 * st.zoomRatio;
    model.scale.set(s);
    model.x = W / 2 - (fit.x + fit.w / 2) * s + st.panX;
    model.y = H / 2 - (fit.y + fit.h / 2) * s + st.panY;
  }

  /**
   * 覆盖层与画布几何对齐（尺寸变化、旋转时都会走到）。
   *
   * 关键：**覆盖层容器的 CSS 盒必须一起同步**。容器是 absolute + overflow:hidden，
   *   尺寸由内联 px 决定；只 resize PIXI 而不改容器，画布会被旧宽度裁掉
   *   （真机现象：模型挤在左侧窄带、右侧露出棋盘格，重载模型才恢复）。
   *   尺寸写入收口到 overlay.setBox（本模块不写内联尺寸，只负责调用）。
   */
  function syncRect() {
    // 几何由 StageSurface 负责：有句柄时直接同步尺寸，不再读 DOM
    if (!ctx.handleRef) return;
    ctx.api.overlay.setBox();
    ctx.api.pixiApp.fitAppToOverlay();
    applyZoom();
  }

  /**
   * 尺寸同步：Surface 量好尺寸后调用（渲染器不自己读 DOM）。
   * 顺序：句柄 → 渲染器 resize → 覆盖层容器盒 → 视图重算。
   *   覆盖层盒放在 resize 之后、applyZoom 之前：先把"画布可见区域"改对，再算模型落点。
   * @param {object} handle StageSurface 句柄
   */
  function syncSize(handle) {
    ctx.handleRef = handle || ctx.handleRef;
    try {
      const gSync = surfaceGeometry();
      if (st.app && st.app.renderer && gSync) {
        st.app.renderer.resize(gSync.cssW, gSync.cssH);
      }
      ctx.api.overlay.setBox(gSync);
      applyZoom();
    } catch { /* 忽略 */ }
  }

  return { computeFit, applyZoom, syncRect, syncSize };
}