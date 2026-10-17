// render/reset-view.js —— 「视图复位」的唯一入口
//
// 为什么需要收口：复位以前在调用点直连 `stage.resetView()`，而 stage 恒为 Spine 舞台。
//   于是 Live2D 面点「重置视图」打的是隐藏的 Spine 画布（INV-01 同类问题）：
//   Live2D 的缩放/平移一点没变，Spine 那边白白被复位一次。
//
// 口径：**调用方只认当前渲染器**，不判断"现在是哪一面"。
//   两个渲染器都提供 resetView()（各自落到自己的相机 backend）：
//     Spine  → stage.resetView()  （相机归位 + 重取平移基准）
//     Live2D → bridge.resetView() （zoom 归 1、pan 归 0 并重排）
//   万一某个渲染器没实现顶层 resetView，退一步用它统一相机对象的 reset()。

/**
 * 复位当前渲染面的视图。
 * @param {object|null} renderer 当前渲染器（state.currentRenderer）
 * @returns {'renderer.resetView'|'renderer.camera.reset'|'none'|'no-renderer'} 实际走的通路（便于断言）
 */
export function resetViewViaRenderer(renderer) {
  if (!renderer) return 'no-renderer';
  if (typeof renderer.resetView === 'function') {
    renderer.resetView();
    return 'renderer.resetView';
  }
  if (renderer.camera && typeof renderer.camera.reset === 'function') {
    renderer.camera.reset();
    return 'renderer.camera.reset';
  }
  return 'none';
}
