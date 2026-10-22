// render/interaction.js —— 舞台相机交互（拖动平移 / 滚轮缩放 / 双指捏合）
//
// 对齐基准：旧前端（dist/index.html）的事件层，逐条对应：
//   · 滚轮   t = (deltaY > 0 ? -1 : 1) → engine.applyZoom(t)    一档 ±10%，锚点=视图中心
//   · 拖动   每次 pointermove 把原始屏幕像素差值交给 engine.applyPan(dx, dy)
//   · 捏合   zoom = 起始userScale × (当前两指距离 / 起始两指距离)，中点位移另走 applyPan
//   · 复位   engine.resetCamera()
//
// 本文件**不做任何坐标换算**：缩放档位、像素倍率、flip、Live2D 委托全部由引擎处理。
// 相机能力统一从 stage.camera 取（见 render/camera/spine.js）；只有缺失该入口时才回退到
// stage.getView/setView（且只做加法累计，仍然不做换算）。
//
// 日志：所有相机动作都通过 camera.note() 汇入同一路 CAMERA 日志，真机操作即可逐条核对：
//   [CAMERA] wheel deltaY=-120 → zoomStep(+1)          （stage-camera 再补 userScale 前后值）
//   [CAMERA] drag dx=+24 dy=0
//   [CAMERA] pinch dist 210→300 ratio=1.429 → zoomTo(1.429)
//   [CAMERA] reset

/** 默认参数：只保留"是否允许单指拖动"这个行为开关；缩放范围由引擎 clamp（0.125~16）负责 */
const DEFAULT_OPTIONS = Object.freeze({
  panWithOnePointer: true,
});

/**
 * 取画布内相对坐标（CSS 像素，原点画布左上角）。
 * @param {HTMLCanvasElement} canvas
 * @param {PointerEvent|WheelEvent} event
 */
function toCanvasPoint(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/**
 * 两指距离。
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 */
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 两指中点。
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 */
function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * 相机桥：把交互动作落到 stage.camera（薄转发），缺失时退到 stage 的兼容入口。
 * @param {object} stage
 */
function createCameraBridge(stage) {
  const camera = stage && stage.camera;

  /** 日志：优先走相机入口的 note（与 stage-camera 同一路 CAMERA 日志） */
  function note(message, data) {
    if (camera && typeof camera.note === 'function') {
      try { camera.note(message, data); } catch { /* 日志失败不影响交互 */ }
    }
  }

  return {
    note,
    /** 缩放一档（dir=±1，由引擎处理 ±10% 与 clamp） */
    zoomStep(dir) {
      if (camera && typeof camera.zoomStep === 'function') return camera.zoomStep(dir);
      return null;
    },
    /** 缩放到绝对 userScale（捏合：起始 userScale × 距离比） */
    zoomTo(scale) {
      if (camera && typeof camera.zoomTo === 'function') return camera.zoomTo(scale);
      return null;
    },
    /** 平移：原始屏幕像素差值 */
    panBy(dx, dy) {
      if (camera && typeof camera.panBy === 'function') return camera.panBy(dx, dy);
      // 回退：仅有 setView 的旧契约，本地累计后按绝对量下发（不做任何换算）
      if (typeof stage.setView === 'function' && typeof stage.getView === 'function') {
        const view = stage.getView() || { panX: 0, panY: 0 };
        return stage.setView({ panX: (view.panX || 0) + dx, panY: (view.panY || 0) + dy });
      }
      return null;
    },
    /** 复位：交给引擎 resetCamera（重新 fit） */
    reset() {
      if (camera && typeof camera.reset === 'function') return camera.reset();
      if (typeof stage.resetView === 'function') return stage.resetView();
      return null;
    },
    /** 当前 userScale（捏合起点用）；拿不到时返回 null */
    scale() {
      if (camera && typeof camera.scale === 'function') return camera.scale();
      return null;
    },
  };
}

/**
 * 把一帧内累积的平移合并成一次相机调用（拖动风暴时每帧最多一次 applyPan）。
 * @param {(dx:number, dy:number) => void} applyPan
 */
function createPanScheduler(applyPan) {
  let shiftX = 0;
  let shiftY = 0;
  let frameId = 0;

  /** 冲刷本帧累积量 */
  function flush() {
    frameId = 0;
    if (!shiftX && !shiftY) return;
    const dx = shiftX;
    const dy = shiftY;
    shiftX = 0;
    shiftY = 0;
    applyPan(dx, dy);
  }

  return {
    queue(dx, dy) {
      if (!dx && !dy) return;
      shiftX += dx;
      shiftY += dy;
      if (frameId) return;
      frameId = requestAnimationFrame(flush);
    },
    flushNow() {
      if (!frameId) return;
      cancelAnimationFrame(frameId);
      flush();
    },
    dispose() {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = 0;
      shiftX = 0;
      shiftY = 0;
    },
  };
}

/**
 * 指针状态机：单指拖动 / 双指捏合。
 * @param {{canvas: HTMLCanvasElement, camera: object, options: object}} ctx
 */
/** 一次拖动的累计位移（抬手时汇总成一条 CAMERA 日志；逐帧记会把面板刷满） */
const dragAcc = { dx: 0, dy: 0, moves: 0 };

function resetDragAcc() {
  dragAcc.dx = 0;
  dragAcc.dy = 0;
  dragAcc.moves = 0;
}

function createPointerHandler(ctx, panScheduler) {
  const active = new Map(); // pointerId → 最近一次画布内坐标
  /** 捏合基线：起始 userScale 与起始两指距离（与旧端一致，绝对式换算，不逐帧累积） */
  let pinchStart = null;
  /** 上一帧两指中点（用于双指平移） */
  let pinchMid = null;

  /** 重建捏合基线（双指齐全时才有） */
  function rebuildPinch() {
    if (active.size !== 2) {
      pinchStart = null;
      pinchMid = null;
      return;
    }
    const [a, b] = [...active.values()];
    const scale = ctx.camera.scale();
    const dist = distance(a, b);
    pinchStart = {
      scale: Number.isFinite(scale) ? scale : null,
      dist,
    };
    pinchMid = midpoint(a, b);
  }

  /** 按下：记录起点、锁定指针捕获；第二指落下时建立捏合基线 */
  function onDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return; // 仅鼠标左键
    active.set(event.pointerId, toCanvasPoint(ctx.canvas, event));
    try { ctx.canvas.setPointerCapture(event.pointerId); } catch { /* 合成事件可能不支持 */ }
    rebuildPinch();
    event.preventDefault();
  }

  /** 移动：单指 → 原始差值平移；双指 → 距离比缩放 + 中点平移 */
  function onMove(event) {
    const previous = active.get(event.pointerId);
    if (!previous) return;
    const point = toCanvasPoint(ctx.canvas, event);
    active.set(event.pointerId, point);

    if (active.size === 1) {
      if (!ctx.options.panWithOnePointer) return;
      const dx = point.x - previous.x;
      const dy = point.y - previous.y;
      if (dx || dy) {
        // 拖动过程不逐帧记日志（一次拖动几十帧会直接把面板刷满）：
        //   累计位移，抬手时汇总成一条；单帧的即时性由相机侧节流日志负责。
        dragAcc.dx += dx;
        dragAcc.dy += dy;
        dragAcc.moves += 1;
        panScheduler.queue(dx, dy);
      }
      event.preventDefault();
      return;
    }

    if (active.size === 2) {
      const [a, b] = [...active.values()];
      const dist = distance(a, b);
      const mid = midpoint(a, b);
      // 缩放：起始 userScale × 距离比（中心锚点，引擎只改缩放不动位置）
      if (pinchStart && pinchStart.dist > 0 && Number.isFinite(pinchStart.scale)) {
        const ratio = dist / pinchStart.dist;
        if (ratio > 0 && Math.abs(ratio - 1) > 0.001) {
          ctx.camera.note(`pinch dist ${Math.round(pinchStart.dist)}→${Math.round(dist)} ratio=${ratio.toFixed(3)} → zoomTo(${(pinchStart.scale * ratio).toFixed(4)})`);
          ctx.camera.zoomTo(pinchStart.scale * ratio);
        }
      }
      // 平移：两指中点位移
      if (pinchMid) {
        const dx = mid.x - pinchMid.x;
        const dy = mid.y - pinchMid.y;
        if (dx || dy) panScheduler.queue(dx, dy);
      }
      pinchMid = mid;
      event.preventDefault();
    }
  }

  /** 抬起/取消：移除指针并按剩余手指数重建基线（双指→单指不跳变） */
  function onUp(event) {
    if (!active.delete(event.pointerId)) return;
    try { ctx.canvas.releasePointerCapture(event.pointerId); } catch { /* 同上 */ }
    rebuildPinch();
    // 拖动结束：有位移才记一条汇总（帧数一并给出，便于判断是"轻点"还是"长拖"）
    if (dragAcc.moves > 0) {
      ctx.camera.note(
        `drag total dx=${Math.round(dragAcc.dx)} dy=${Math.round(dragAcc.dy)}（${dragAcc.moves} 帧）`,
        { dx: Math.round(dragAcc.dx), dy: Math.round(dragAcc.dy), moves: dragAcc.moves },
      );
      resetDragAcc();
    }
    if (active.size === 1) {
      const only = [...active.values()][0];
      if (only) pinchMid = { x: only.x, y: only.y };
    }
  }

  /** 滚轮：只看方向、每次一档（与旧端一致）；锚点是视图中心 */
  function onWheel(event) {
    event.preventDefault();
    const dir = event.deltaY > 0 ? -1 : 1;
    ctx.camera.note(`wheel deltaY=${event.deltaY} → zoomStep(${dir > 0 ? '+1' : '-1'})`);
    ctx.camera.zoomStep(dir);
  }

  return { onDown, onMove, onUp, onWheel };
}

/**
 * 把交互挂到画布上。
 * @param {{canvas: HTMLCanvasElement, stage: object, options?: object}} params
 * @returns {() => void} 解绑函数
 */
export function attachStageInteraction({ canvas, stage, options } = {}) {
  if (!canvas || typeof canvas.addEventListener !== 'function') {
    throw new Error('attachStageInteraction: 需要 canvas 元素');
  }
  if (!stage || (typeof stage.getView !== 'function' && !stage.camera)) {
    throw new Error('attachStageInteraction: 需要提供 camera 入口或 getView/setView 的 stage');
  }

  const camera = createCameraBridge(stage);
  const ctx = {
    canvas,
    camera,
    options: Object.assign({}, DEFAULT_OPTIONS, options || {}),
  };
  const panScheduler = createPanScheduler((dx, dy) => camera.panBy(dx, dy));
  const handler = createPointerHandler(ctx, panScheduler);

  // 触摸设备上禁用浏览器默认手势，否则拖动会被滚动/缩放抢走
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  canvas.addEventListener('pointerdown', handler.onDown);
  canvas.addEventListener('pointermove', handler.onMove);
  canvas.addEventListener('pointerup', handler.onUp);
  canvas.addEventListener('pointercancel', handler.onUp);
  canvas.addEventListener('wheel', handler.onWheel, { passive: false });

  /** 解绑：移除监听、还原样式、冲刷尾帧 */
  function detach() {
    panScheduler.flushNow();
    panScheduler.dispose();
    canvas.removeEventListener('pointerdown', handler.onDown);
    canvas.removeEventListener('pointermove', handler.onMove);
    canvas.removeEventListener('pointerup', handler.onUp);
    canvas.removeEventListener('pointercancel', handler.onUp);
    canvas.removeEventListener('wheel', handler.onWheel);
    canvas.style.touchAction = previousTouchAction;
  }

  return detach;
}

/** 默认参数导出（接线方据此展示/覆盖行为开关） */
export const STAGE_INTERACTION_DEFAULTS = DEFAULT_OPTIONS;
