// render/capture.js —— 「导出截图」的唯一入口（与 reset-view.js / playback.js 同一口径）
//
// 为什么收口：截图以前在调用点写死 `#stage-canvas`（Spine 画布），
//   Live2D 的画面在覆盖层自己的 canvas 上，结果在 Live2D 面导出的是"上次 Spine 的残留帧"。
// 现在调用方只说"给我当前面的画面"，由渲染器自己知道该从哪取像素。

/**
 * 取当前渲染面的画面。
 * @param {object|null} surface 舞台表面（提供 activeRenderer()）
 * @returns {{canvas: HTMLCanvasElement, width: number, height: number, source: string}|null}
 *   source 标识实际通路：'renderer.capture' / 'none' / 'no-renderer'
 */
export function captureActive(surface) {
  const renderer = surface && typeof surface.activeRenderer === 'function' ? surface.activeRenderer() : null;
  if (!renderer) return null;
  if (typeof renderer.capture !== 'function') return null;
  try {
    const shot = renderer.capture();
    if (!shot || !shot.canvas || !shot.width || !shot.height) return null;
    return {
      canvas: shot.canvas, width: shot.width, height: shot.height,
      source: 'renderer.capture',
      digest: shot.digest || 0,
      // nonEmpty 向后兼容（老断言用它判"不是空白图"）：渲染器给了就用，否则用指纹兜底
      nonEmpty: typeof shot.nonEmpty === 'number' ? shot.nonEmpty : (shot.digest ? 1 : 0),
    };
  } catch {
    return null;
  }
}
