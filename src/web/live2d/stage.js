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
  async function mount(doc, handle) {
    ctx.handleRef = handle || null;
    const entry = doc && (doc.model || doc);
    const result = await bridge.loadForEngine(entry);
    return result;
  }

  /** 卸载（保留 PIXI app，便于快速再切回） */
  function unmount() {
    return overlay.hide();
  }

  /** 彻底释放（销毁 PIXI app 与覆盖层） */
  function dispose() {
    try { if (diagHandle && typeof diagHandle.stop === 'function') diagHandle.stop(); } catch { /* 忽略 */ }
    diagHandle = null;
    overlay.hide();
    try { if (ctx.st.app) ctx.st.app.destroy(true, { children: true }); } catch { /* 忽略 */ }
    ctx.st.app = null;
    const el = document.getElementById('live2d-overlay');
    if (el && el.parentElement) el.parentElement.removeChild(el);
    ctx.st.overlay = null;
    ctx.st.libsReady = null;
    ctx.note('Live2D 已彻底释放（app 销毁、覆盖层移除）');
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
  };
}
