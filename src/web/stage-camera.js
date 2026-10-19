// stage-camera.js —— 相机统一入口（Spine / Live2D 共用，全部委托引擎原生方法）
//
// 设计约束（重要）：
//   1. 本文件**不做任何坐标换算**：没有 ppw、没有 ×2、没有锚点公式、没有 exp 曲线。
//      缩放档位、像素倍率、flip、Live2D 委托全部由引擎内部处理：
//        engine.applyZoom(t)        userScale *= (1 + t*0.1)，clamp [SCALE_MIN, SCALE_MAX]
//        engine.setCameraZoom(s)    直接设 userScale
//        engine.applyPan(dx, dy)    dx/dy 是屏幕像素差值，方向为「内容跟随手指」
//        engine.resetCamera()       重新 fit（受 fitMode 影响）
//        engine.getCameraZoom()     只读当前 userScale
//   2. 本文件**不判断 l2dActive()**：引擎三个方法开头已有 L2D 分支并委托 bridge，
//      在这里再写一份就会出现两套真相。
//   3. 所有动作都输出一条 CAMERA 日志（含输入侧），供真机操作时逐条核对。

/**
 * @param {{getEngine: () => any}} options getEngine 每次调用时取当前引擎（MSAA 重建后引擎实例会换）
 */
export function createStageCamera({ getEngine } = {}) {
  /** 日志输出函数（由宿主注入，缺省静默） */
  let logger = null;

  /** 取可用引擎；没有相机能力时返回 null，调用方据此跳过 */
  function engineOf() {
    const engine = typeof getEngine === 'function' ? getEngine() : null;
    return engine && typeof engine.getCameraZoom === 'function' ? engine : null;
  }

  /** 写一条 CAMERA 日志（日志失败不影响相机） */
  function emit(message, data) {
    if (typeof logger !== 'function') return;
    try { logger(message, data); } catch { /* 忽略 */ }
  }

  /** 读数包装：拿不到引擎时返回 null（而不是抛错） */
  function readScale(engine) {
    try { return Number(engine.getCameraZoom()); } catch { return null; }
  }

  const camera = {
    /** 缩放一档。dir 与旧端一致：滚轮向下 = -1，其余 = +1 */
    zoomStep(dir) {
      const engine = engineOf();
      if (!engine) return null;
      const before = readScale(engine);
      try { engine.applyZoom(dir > 0 ? 1 : -1); } catch { return before; }
      const after = readScale(engine);
      emit(`zoomStep(${dir > 0 ? '+1' : '-1'}) → userScale ${before} → ${after}`, { before, after });
      return after;
    },

    /** 缩放到指定 userScale（捏合：起始 userScale × 距离比） */
    zoomTo(scale) {
      const engine = engineOf();
      if (!engine || !Number.isFinite(scale)) return null;
      const before = readScale(engine);
      try { engine.setCameraZoom(scale); } catch { return before; }
      const after = readScale(engine);
      emit(`zoomTo(${scale}) → userScale ${before} → ${after}`, { before, after });
      return after;
    },

    /** 平移。dx/dy 是屏幕像素差值，原样交给引擎（倍率与 flip 由引擎处理） */
    panBy(dx, dy) {
      const engine = engineOf();
      if (!engine || !Number.isFinite(dx) || !Number.isFinite(dy)) return null;
      let posBefore = null;
      try {
        const cam = engine.camera;
        if (cam && cam.position) posBefore = { x: cam.position.x, y: cam.position.y };
      } catch { /* 读不到位置不影响平移 */ }
      try { engine.applyPan(dx, dy); } catch { return posBefore; }
      let posAfter = null;
      try {
        const cam = engine.camera;
        if (cam && cam.position) posAfter = { x: cam.position.x, y: cam.position.y };
      } catch { /* 同上 */ }
      emit(`panBy(${dx > 0 ? '+' : ''}${dx}, ${dy > 0 ? '+' : ''}${dy}) → position ${posBefore ? `(${posBefore.x.toFixed(2)},${posBefore.y.toFixed(2)})` : '?'} → ${posAfter ? `(${posAfter.x.toFixed(2)},${posAfter.y.toFixed(2)})` : '?'}`, { dx, dy, posBefore, posAfter });
      return posAfter;
    },

    /** 视图复位：交给引擎重新 fit */
    reset() {
      const engine = engineOf();
      if (!engine || typeof engine.resetCamera !== 'function') return null;
      try { engine.resetCamera(); } catch { return readScale(engine); }
      const scale = readScale(engine);
      emit(`reset() → userScale ${scale}, fit 完成`, { scale });
      return scale;
    },

    /** 只读当前 userScale */
    scale() {
      const engine = engineOf();
      return engine ? readScale(engine) : null;
    },

    /** 写一条 CAMERA 日志（供交互层汇报输入侧动作，与上面同一路通道） */
    note(message, data) {
      emit(message, data);
    },

    /** 注入日志输出（宿主把 debug-log 接进来）。传 null 关闭 */
    setLogger(fn) {
      logger = typeof fn === 'function' ? fn : null;
    },
  };

  return camera;
}
