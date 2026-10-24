// live2d/release.js —— Live2D 面的统一资源释放（unmount 与 dispose 共用）
//
// 为什么单独成模块：这段是「契约 §五-7（unmount/dispose 不得遗留自建 GL 资源）」的落地实现，
//   也是曾经出过 bug 的地方（PIXI 的 destroy(true) 会摘掉 canvas 只留容器，下游按容器复用 ⇒
//   渲染到不在 DOM 的游离画布上、页面全白而 stats 与像素采样都正常）。
//   抽出来之后可以用 `node --test` 做静态回归（最小 DOM 垫片即可），不必每次都开浏览器验。
//
// 释放清单（顺序有意义：先停诊断 → 藏容器 → 销毁 app → 移除容器 → 复位状态）：
//   ① 诊断 HUD 句柄停掉（它会定时取数据，留着会读到已销毁的 app）
//   ② 覆盖层隐藏（视觉上立刻消失，避免销毁过程中的中间帧露出来）
//   ③ PIXI app.destroy(true) —— 释放 WebGL 上下文与整棵 display tree（自建 GL 资源的唯一持有者）
//   ④ 移除 #live2d-overlay 容器（不做"保留容器以便快速切回"：那个中间态正是上面那个 bug 的来源）
//   ⑤ 状态复位（否则 isActive()/debug() 继续报告"还有模型在显示"）

export const OVERLAY_ID = 'live2d-overlay';

/**
 * 释放 Live2D 面持有的全部资源与状态。
 * @param {{
 *   st: object,                       // live2d 舞台状态（app/model/modelId/meta/motionMap/vfsStats/active/overlay/libsReady）
 *   note?: Function,                  // 日志通道
 *   stopDiag?: Function|null,         // 停诊断 HUD（可选）
 *   doc?: object,                     // 文档对象（默认 globalThis.document，便于测试注入）
 * }} opts
 * @returns {boolean} 是否真的释放了什么（用于幂等与日志判断）
 */
export function releaseLive2DResources({ st, note, stopDiag, doc } = {}) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!st) return false;
  const hadApp = !!st.app;
  const hadOverlay = !!(d && d.getElementById && d.getElementById(OVERLAY_ID));

  try { if (typeof stopDiag === 'function') stopDiag(); } catch { /* 停诊断失败不阻塞释放 */ }
  try { if (st.overlay && typeof st.overlay.style === 'object') st.overlay.style.display = 'none'; } catch { /* 忽略 */ }
  // **app 常驻**：不 destroy（`destroy(true)` 的 removeView 会摘掉 canvas，那才是孤儿上下文的来源）。
  //   每次 spine↔live2d 切换都 `new PIXI.Application()` 会新建 1 个匿名探测上下文且永不释放，
  //   累积到浏览器上限（~16）就丢最旧 ⇒ 画布黑（实测：来回切 15 次即到顶）。
  //   所以释放只做三件事：停渲染循环、释放纹理（GPU 内存大头）、隐藏覆盖层；app/canvas/context 保留，
  //   下次切回来直接复用（只重建纹理，比 new Application 便宜得多）。
  if (st.app) {
    try { if (st.model) { st.app.stage.removeChild(st.model); } } catch { /* 忽略 */ }
    try { if (st.model) st.model.destroy({ children: true, texture: true, baseTexture: true }); } catch { /* 忽略 */ }
    try { if (typeof st.app.stop === 'function') st.app.stop(); } catch { /* 忽略 */ }
    // 释放纹理缓存（PIXI 的内存大头）；拿不到就跳过，不影响正确性
    try {
      const r = st.app.renderer;
      if (r && r.textureGC && typeof r.textureGC.run === 'function') r.textureGC.run();
    } catch { /* 忽略 */ }
    try { if (st.overlay && typeof st.overlay.style === 'object') st.overlay.style.display = 'none'; } catch { /* 忽略 */ }
  }
  // 覆盖层 DOM 保留（app 常驻 ⇒ 它的 canvas 还得留着，摘掉就是旧坑"容器在、canvas 不在"）
  st.overlay = (d && d.getElementById) ? (d.getElementById(OVERLAY_ID) || st.overlay) : st.overlay;
  st.libsReady = null;
  st.model = null;
  st.modelId = null;
  st.meta = null;
  st.motionMap = new Map();
  st.vfsStats = null;
  st.active = false;

  const did = hadApp || hadOverlay;
  if (did && typeof note === 'function') note('Live2D 已释放（纹理释放、渲染停止、覆盖层隐藏；app 常驻复用）');
  return did;
}
