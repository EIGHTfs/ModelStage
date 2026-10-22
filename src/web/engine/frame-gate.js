// engine/frame-gate.js —— 帧率门控（累加器口径，两面共用）。
// 为什么不用 PIXI ticker.maxFPS / 单门限：前者按 deltaTime 判断且带容差（90Hz 屏会放行，实测 60/30 档跑到 90），
//   后者只跟上一帧时间戳比，零头被丢掉导致长期偏低。累加器：够一格才渲，渲后只扣一格（余量留给下一次），
//   并对 debt 做上限钳制（卡顿回来不连爆）。两面共用同一份实现，避免各自再写一套限帧逻辑。

/**
 * 造一个帧率门控。
 * @param {() => number} getTargetFps 目标帧率（每次询问，支持运行期改档位）
 * @returns {{shouldRender: (deltaMs: number) => boolean, reset: () => void, debtMs: number}}
 */
export function createFrameGate(getTargetFps) {
  let debtMs = 0;
  return {
    /**
     * 这一帧该不该渲染。
     * @param {number} deltaMs 距上一次 rAF/ticker 的间隔（毫秒）
     * @returns {boolean} true = 渲染；false = 跳过本帧（只更新状态不出画）
     */
    shouldRender(deltaMs) {
      const target = Math.max(1, Number(getTargetFps()) || 60);
      const interval = 1000 / target;
      const d = Number(deltaMs);
      if (Number.isFinite(d) && d > 0) debtMs += d;
      if (debtMs < interval) return false;
      debtMs -= interval;
      if (debtMs > interval) debtMs = interval; // 防连爆：最多保留一格余量
      return true;
    },
    /** 重置累加器（重新起循环/换 app 时用） */
    reset() { debtMs = 0; },
    get debtMs() { return debtMs; },
  };
}
