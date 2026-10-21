// engine/render-frame.js —— 帧循环与绘制（从 player 抽出，控制单文件规模）
//
// 帧调度选择：**渲染器自建 rAF（方案 A）**，与现状一致；
//   StageSurface 只负责尺寸与背景，不接管渲染帧（统一调度属 B6 收尾，需同时改 surface 与 canvas.js）。

import { hideFilteredSlots, restoreFilteredSlots } from './skins.js';

/** 绘制一帧 */
export function renderFrame(engine) {
  const { gl, skeleton, renderTarget } = engine;
  if (!gl || !skeleton || !renderTarget || !engine.adapters) return;
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  // 与旧引擎一致：批处理器的 premultiplied 参数由 pmaInfo.blendMode 决定（不是纹理是否预乘）
  const blendPma = !!(engine.pmaInfo && engine.pmaInfo.blendMode === 'premultiplied');
  // 部件过滤要在绘制前摘件、绘制后挂回（finally 保证异常路径也不缺件）
  hideFilteredSlots(engine);
  let ok = false;
  try {
    ok = engine.adapters.renderer.draw(renderTarget, skeleton, blendPma);
    // 调试层叠在主绘制之上（全关时 drawDebug 自身直接返回，不碰 GL）
    engine.adapters.renderer.drawDebug(renderTarget, skeleton, engine.debugDraw, blendPma);
  } finally {
    restoreFilteredSlots(engine);
  }
  if (!ok && !engine.renderWarned) {
    engine.renderWarned = true;
    engine.log('error', '渲染失败：适配器未能绘制（详见能力告警）', 'renderer');
  }
}

/** 首帧：更新一次状态并立即绘制 */
export function presentFirstFrame(engine) {
  if (!engine.skeleton || !engine.renderer) {
    engine.pendingPresent = false;
    return;
  }
  try {
    if (engine.state && engine.state.apply) {
      engine.state.update(0);
      engine.state.apply(engine.skeleton);
    }
    if (engine.adapters) engine.adapters.skeleton.updateWorldTransform(engine.skeleton);
    renderFrame(engine);
  } catch { /* 首帧失败留给主循环 */ }
  engine.pendingPresent = false;
}

/** 起主循环（幂等：已在跑则只把 isPlaying 置真） */
export function startLoop(engine) {
  if (engine.animationId !== null) { engine.isPlaying = true; return; }
  engine.isPlaying = true;
  engine.lastTime = performance.now();
  engine.fpsLastTime = engine.lastTime;
  engine.fpsFrames = 0;
  const loop = () => {
    if (!engine.isPlaying) return;
    engine.animationId = requestAnimationFrame(loop);
    const now = performance.now();
    if (now - engine.lastTime < 1000 / engine.fpsLimit) return;
    let dt = (now - engine.lastTime) / 1000;
    engine.lastTime = now;
    dt = Math.min(dt, 0.1);
    engine.fpsFrames += 1;
    if (now - engine.fpsLastTime >= 500) {
      engine.currentFps = (engine.fpsFrames * 1000) / (now - engine.fpsLastTime);
      engine.fpsFrames = 0;
      engine.fpsLastTime = now;
    }
    engine.update(dt);
    renderFrame(engine);
  };
  loop();
}

/** 停主循环 */
export function stopLoop(engine) {
  if (engine.animationId !== null) cancelAnimationFrame(engine.animationId);
  engine.animationId = null;
  engine.isPlaying = false;
}
