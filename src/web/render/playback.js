// render/playback.js —— 「播放/暂停」的唯一入口（与 reset-view.js 同一套收口思路）
//
// 为什么收口：
//   ① 底栏按钮、键盘快捷键、未来的自动暂停都调这一个函数，避免"某处只改图标不改引擎"；
//   ② 暂停必须**落在当前渲染面**上：Spine 停引擎时间推进、Live2D 停 PIXI ticker；
//      以前底栏直连 stage（恒为 Spine 舞台），Live2D 面点了没反应；
//   ③ 调用方不判断"现在是哪一面"，只把意图（暂停/继续）交给当前渲染器。

/**
 * 暂停或继续当前渲染面的播放。
 * @param {object|null} surface 舞台表面（提供 activeRenderer()）
 * @param {boolean} paused true=暂停，false=继续
 * @returns {'renderer.pause'|'renderer.resume'|'none'|'no-renderer'} 实际走的通路（便于断言）
 */
export function setPlaybackPaused(surface, paused) {
  const renderer = surface && typeof surface.activeRenderer === 'function' ? surface.activeRenderer() : null;
  if (!renderer) return 'no-renderer';
  const method = paused ? 'pause' : 'resume';
  if (typeof renderer[method] !== 'function') return 'none';
  try {
    renderer[method]();
    return `renderer.${method}`;
  } catch {
    return 'none';
  }
}
