// live2d/pixi-app.js —— 运行时库懒加载与 PIXI 实例
//
// 库顺序不可颠倒（cubismcore 必须最先：pixi-live2d-display 初始化时会检查它）。
// 渲染器尺寸只认 Surface 下发的几何（fitAppToOverlay 的入参或句柄），本模块不读 DOM 尺寸。
// 注意：覆盖层**容器与画布的尺寸**不在这里写 —— 那是 overlay.setBox 的唯一职责。
import { LIBS, OVERLAY_CANVAS_ID } from './stage-ctx.js';

/**
 * 创建 PIXI 应用模块。
 * @param {object} ctx 运行时上下文
 * @returns {{loadScript:Function, ensureLibs:Function, fitAppToOverlay:Function, ensureApp:Function}}
 */
export function createPixiApp(ctx) {
  const { st, note } = ctx;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve(src);
      el.onerror = () => reject(new Error(`Live2D 运行时加载失败：${src}`));
      document.head.appendChild(el);
    });
  }

  function ensureLibs() {
    if (!st.libsReady) {
      st.libsReady = (async () => {
        note('首次使用 Live2D，按需加载运行时库…');
        for (const src of LIBS) {
          await loadScript(src);
          note(`运行时已加载：${src.split('/').pop()}`);
        }
        if (!(typeof PIXI !== 'undefined' && PIXI.live2d)) {
          throw new Error('PIXI.live2d 不存在：运行时库顺序或版本不匹配（live2dcubismcore 必须最先）');
        }
        note(`Live2D 运行时就绪（PIXI ${PIXI.VERSION || '?'}）`);
      })();
    }
    return st.libsReady;
  }

  /** 取几何：入参优先，否则问 Surface（兼容 {geometry()} 与 {size,dpr} 两种形态） */
  function resolveGeo(geo) {
    if (geo && geo.cssW && geo.cssH) return geo;
    try { return ctx.surfaceGeometry ? ctx.surfaceGeometry() : null; } catch { return null; }
  }

  /** 取 Surface 期望的分辨率（?res=N 覆盖时与 dpr 不同）；拿不到返回 null */
  function forcedResOf() {
    try { return ctx.handleRef && ctx.handleRef.geometry ? ctx.handleRef.geometry().res : null; } catch { return null; }
  }

  /** 让 PIXI 分辨率跟 Surface 的期望值一致（画布 attr/style 由 overlay.setBox 统一写） */
  function syncRendererResolution(app, forced) {
    if (!forced) return;
    if (app.renderer.resolution !== forced) app.renderer.resolution = forced;
  }

  /**
   * 按 Surface 下发的几何校准 PIXI 渲染器尺寸。
   * 尺寸唯一来源 = Surface.geometry()；本函数不读 DOM，也不写覆盖层的 CSS/attr
   *   （覆盖层容器与画布的尺寸由 overlay.setBox 单点写入）。
   * @param {{cssW:number, cssH:number, dpr:number, res:number}} [geo]
   * @returns {boolean} 是否成功校准
   */
  function fitAppToOverlay(geo) {
    const app = st.app;
    if (!app || !app.renderer) return false;
    const g = resolveGeo(geo);
    if (!g) return false;
    const w = Math.max(1, Math.round(g.cssW));
    const h = Math.max(1, Math.round(g.cssH));
    const res = app.renderer.resolution || 1;
    syncRendererResolution(app, forcedResOf());
    const curW = Math.round((app.renderer.width || 0) / res);
    const curH = Math.round((app.renderer.height || 0) / res);
    if (curW !== w || curH !== h) app.renderer.resize(w, h);
    return true;
  }

  async function ensureApp() {
    if (st.app) return st.app;
    const el = ctx.api.overlay.buildOverlay();
    // 兜底：buildOverlay 已保证容器里有 canvas；这里再取一次仍可能为空（例如被外部脚本摘掉）。
    //   拿不到就补建并塞回容器 —— 绝不能让 PIXI 拿到 view:null（它会自建一张不在 DOM 里的游离画布，
    //   渲染正常但页面空白，且像素采样照样能读到有效像素，极难发现）。
    let canvas = document.getElementById(OVERLAY_CANVAS_ID);
    if (!canvas && el) {
      canvas = document.createElement('canvas');
      canvas.id = OVERLAY_CANVAS_ID;
      canvas.style.cssText = 'display:block;width:100%;height:100%;background:transparent';
      el.appendChild(canvas);
    }
    const opts = {
      view: canvas,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: (ctx.handleRef && ctx.handleRef.geometry) ? (ctx.handleRef.geometry().res || 1) : 1,
    };
    const isModern = typeof PIXI.Application.prototype.init === 'function';
    const app = isModern ? new PIXI.Application() : new PIXI.Application(opts);
    if (isModern) await app.init(opts);
    st.app = app;
    // 强制透明清屏：实测 PIXI 6.5.3 下 opts.backgroundAlpha 未落到 renderer，
    //   canvas 每帧被不透明黑填满（readPixels 得到 [0,0,0,255]），
    //   于是 Live2D 画布整块盖住 #stage 的 CSS 背景，只剩模型区域可见 = 看起来"内容被框在矩形里"。
    try {
      app.renderer.backgroundAlpha = 0;
      app.renderer.backgroundColor = 0x000000;
      app.renderer.clearBeforeRender = true;
    } catch { /* 忽略 */ }
    fitAppToOverlay();
    return app;
  }

  return { loadScript, ensureLibs, fitAppToOverlay, ensureApp };
}