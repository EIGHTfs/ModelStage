// live2d/stage.js —— Live2D 渲染器装配（原生 ES 模块，无构建）
//
// 角色：作为「2D 渲染器」的 Live2D 分支实现，与 Spine 共用同一套相机与交互。
//   · 覆盖层 canvas 覆盖在 Spine 画布之上（pointer-events:none）⇒ 指针事件落到舞台区域，
//     由交互层驱动当前渲染器的相机；Live2D 侧的相机动作经 bridge 落到 PIXI。
//   · 本文件只做**装配**：建上下文 → 依次建各职责模块 → 组装 handle → 装诊断 HUD。
//     具体实现在同目录下：
//       stage-ctx.js      状态与薄工具（st / handleRef / 尺寸 / vfs 解析 / 常量）
//       overlay.js        覆盖层容器与画布的 DOM 显隐（尺寸由 overlay.setBox 写）
//       pixi-app.js       运行时库懒加载与 PIXI 实例、渲染器尺寸校准
//       view.js           视图数学：computeFit / applyZoom / syncRect / syncSize
//       probe.js          只读诊断：像素采样 / MODELCMP / rendererInfo / rendererSize
//       probe-geometry.js 只读诊断：inspectGeometry（几何取证）
//       model.js          模型装载与动作表
//       bridge.js         相机 backend 与播放控制（对外能力面）
//
// 资源入口先经 VirtualFS.resolve()（命中用 Blob URL，未命中回落原 URL）——不 patch PIXI 加载器。
import { installDiagHud } from '../debug/diag-hud.js';
import { createStageContext, OVERLAY_CANVAS_ID } from './stage-ctx.js';
import { releaseLive2DResources } from './release.js';
import { createOverlay } from './overlay.js';
import { createPixiApp } from './pixi-app.js';
import { createView } from './view.js';
import { createProbe } from './probe.js';
import { createProbeGeometry } from './probe-geometry.js';
import { createModel } from './model.js';
import { createBridge } from './bridge.js';

/**
 * 创建 Live2D 舞台。
 * @param {{
 *   vfs?: { resolve: (url: string) => string|null },
 *   getOverlayHost?: () => HTMLElement|null,
 *   log?: (message: string, level?: 'info'|'warn'|'error') => void,
 * }} options
 */
export function createLive2DStage({ vfs, getOverlayHost, log } = {}) {
  const ctx = createStageContext({ vfs, getOverlayHost, log });

  // 装配顺序 = 依赖顺序（无环）：
  //   overlay → pixiApp → view → probe → probeGeometry → model → bridge
  // 为什么用 ctx.api 注册表而不是模块间直接 import：模块之间是"互相调用"的关系
  //   （overlay 要 pixiApp.fitAppToOverlay、model 要 view.applyZoom…），直接 import 会成环；
  //   装配期一次性挂进来，运行期只按名字取。
  const overlay = createOverlay(ctx);
  ctx.api.overlay = overlay;
  const pixiApp = createPixiApp(ctx);
  ctx.api.pixiApp = pixiApp;
  const view = createView(ctx);
  ctx.api.view = view;
  const probe = createProbe(ctx);
  ctx.api.probe = probe;
  const probeGeometry = createProbeGeometry(ctx);
  ctx.api.probeGeometry = probeGeometry;
  const model = createModel(ctx);
  ctx.api.model = model;
  const bridge = createBridge(ctx);
  ctx.api.bridge = bridge;

  // 诊断 HUD 句柄（延迟到首次模型加载成功后安装，见 model.loadModel 末尾）
  let diagHandle = null;

  /**
   * 装载入口（渲染器调它）。
   * @param {object} doc 文档/条目
   * @param {object} handle StageSurface 句柄
   */
  /**
   * 断言"Live2D 画布真的在页面上"。
   *
   * 为什么需要这个断言（血的教训）：
   *   PIXI 在**游离 canvas** 上渲染时，画面完全不可见，但 `readPixels`/像素采样**照样能读到有效像素**——
   *   于是"ratio>0 / alpha=255"这类判据会把白屏判成正常。唯一可靠的判据是 DOM 关系：
   *   canvas 在容器里、容器在文档里、且 `app.view` 就是这张 canvas。
   * @returns {{ok: boolean, detail: object}}
   */
  function assertCanvasAttached() {
    const app = ctx.st.app;
    const el = (ctx.st.overlay && ctx.st.overlay.isConnected) ? ctx.st.overlay : document.getElementById('live2d-overlay');
    const canvas = document.getElementById(OVERLAY_CANVAS_ID);
    const inContainer = !!(canvas && el && typeof el.contains === 'function' && el.contains(canvas));
    const inDom = !!(canvas && canvas.isConnected);
    const viewOk = !!(app && app.view && app.view.isConnected === true);
    const viewIsCanvas = !!(app && canvas && app.view === canvas);
    return {
      ok: inContainer && inDom && viewOk && viewIsCanvas,
      detail: {
        hasCanvas: !!canvas, inContainer, inDom, viewOk, viewIsCanvas,
        appViewId: app && app.view ? (app.view.id || '(无 id)') : null,
      },
    };
  }

  async function mount(doc, handle) {
    ctx.handleRef = handle || null;
    const entry = doc && (doc.model || doc);
    const result = await bridge.loadForEngine(entry);
    // 装载后立刻校验"画布在页面上"：同面切换曾因 canvas 被 PIXI 摘掉而整屏空白，
    //   而 stats/像素采样全都报正常；这里让缺陷当场变成一条 warn（自检也会读它）。
    const chk = assertCanvasAttached();
    if (!chk.ok) ctx.note(`Live2D 画布不在页面上（画面将不可见）：${JSON.stringify(chk.detail)}`, 'warn');
    return result;
  }

  /**
   * 卸载 / 彻底释放：**同一条释放路径**（实现在 live2d/release.js，便于静态回归）。
   *
   * 为什么 live2d 两面不做区分（与 spine 相反）：
   *   PIXI `app.destroy(true)` 的 removeView 会摘掉 canvas 只留容器，留下「容器在、canvas 不在」
   *   的中间态；一旦下游按容器复用，PIXI 就会渲染到**不在 DOM 的游离画布**上——页面全白，
   *   而 stats 与像素采样全都正常（曾真实发生）。app 与覆盖层 DOM 重建成本都很低，
   *   不值得为"保留 DOM"维护第二套生命周期。下次 mount 由 buildOverlay 全量重建。
   * spine 相反：重建引擎要重注入运行时源码并按版本选运行时，代价高，所以那边保留引擎。
   */
  function unmount() {
    releaseLive2DResources({ st: ctx.st, note: ctx.note, stopDiag: takeDiagStop() });
  }

  /** 彻底释放：与 unmount 同一路径（渲染器实例是否丢弃由调用方决定） */
  function dispose() {
    releaseLive2DResources({ st: ctx.st, note: ctx.note, stopDiag: takeDiagStop() });
  }

  /** 取出并清空诊断 HUD 停止函数（幂等：第二次返回 null） */
  function takeDiagStop() {
    const h = diagHandle;
    diagHandle = null;
    return h && typeof h.stop === 'function' ? () => h.stop() : null;
  }

  // 诊断 HUD：仅在 ?diag=1 时创建；所有取值都延迟到调用时（此处 app 可能为 null）
  diagHandle = installDiagHud({
    getRendererInfo: () => {
      try {
        const w = typeof window !== 'undefined' ? window.__WEB__ : null;
        return w && w.live2d && typeof w.live2d.rendererInfo === 'function' ? w.live2d.rendererInfo() : null;
      } catch { return null; }
    },
    readCanvasPixels: (...args) => probe.readCanvasPixels(...args),
    overlayCanvasId: OVERLAY_CANVAS_ID,
    log: (m) => ctx.note(m),
  });

  // 对外面：成员集合与顺序属于契约，增删需同步渲染器与面板
  return {
    id: 'live2d',
    bridge,
    mount,
    unmount,
    dispose,
    show: (m) => bridge.loadForEngine(m),
    hide: () => overlay.hide(),
    isActive: () => ctx.st.active,
    debug: () => bridge.readState(),
    /** 诊断：按当前状态采一条 MODELCMP（不改渲染） */
    collectCmp: (tag) => probe.collectCmp(tag),
    syncRect: () => view.syncRect(),
    readCanvasPixels: (points) => probe.readCanvasPixels(points),
    /** 只读：取 PIXI app 引用（诊断实验用，不改变渲染逻辑） */
    getApp() { return ctx.st.app; },
    rendererInfo: () => probe.rendererInfo(),
    inspectGeometry: () => probeGeometry.inspectGeometry(),
    rendererSize: () => probe.rendererSize(),
    /**
     * 尺寸同步：Surface 量好尺寸后调用（渲染器不自己读 DOM）。
     * @param {object} handle StageSurface 句柄
     */
    syncSize: (handle) => view.syncSize(handle),
    /** 写一条日志（供渲染器记录切换断言） */
    note: (message) => ctx.note(message),
    /**
     * 断言"画布真的在页面上"（切换/装载后自检用）。
     * 像素采样在游离 canvas 上照样能读到有效像素，所以可见性只能用 DOM 关系判定。
     */
    assertCanvasAttached,
  };
}
