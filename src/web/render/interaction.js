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
 * 把一帧内的缩放合并成一次相机调用（与 createPanScheduler 同一套结构）。
 *
 * 为什么需要：一次捏合会派发几十上百个 pointermove，逐个调 camera.zoomTo 等于同一帧
 *   反复重算相机（日志里相邻两次 `pinch dist 159→354` / `159→353` 各调一次 zoomTo）。
 *   平移早就有 scheduler，缩放漏了，这里补齐。
 *
 * 两种语义必须分开累积（同一帧里可能既有捏合又有滚轮）：
 *   · 捏合是**绝对目标值**（pinchStart.scale × 距离比）⇒ 取最后一次，不是相加；
 *   · 滚轮是**步进** ⇒ 把 +1/-1 求和，冲刷后清零。
 * 同一帧两者都有时以绝对目标为准（捏合是手上的直接位移，优先级高于滚轮 tick）。
 * 缩放上下限仍由统一相机（camera 层）钳制，这里不另起一套。
 *
 * @param {(target:number) => void} zoomTo 绝对缩放
 * @param {(steps:number) => void} zoomStep 步进缩放
 */
function createZoomScheduler(zoomTo, zoomStep) {
  let target = null;   // 绝对目标（最后写入者生效）
  let steps = 0;       // 步进累积
  let frameId = 0;
  let calls = 0;       // 真正落到相机的调用次数（验收要贴的数字）
  let flushes = 0;     // 真正产生相机调用的帧数（= calls，但两者分开暴露便于排查）

  /** 冲刷本帧累积量：每帧最多一次相机调用 */
  function flush() {
    frameId = 0;
    if (target === null && !steps) return;
    const pendingTarget = target;
    const pendingSteps = steps;
    target = null;
    steps = 0;
    if (pendingTarget !== null) {
      zoomTo(pendingTarget);
      calls += 1;
      flushes += 1;
      return;
    }
    if (pendingSteps) {
      zoomStep(pendingSteps);
      calls += 1;
      flushes += 1;
    }
  }

  function schedule() {
    if (frameId) return;
    frameId = requestAnimationFrame(flush);
  }

  return {
    /** 排队一个绝对目标（捏合）：只保留最后一次 */
    queueTarget(value) {
      if (!Number.isFinite(value)) return;
      target = value;
      schedule();
    },
    /** 排队一个步进（滚轮）：累加 */
    queueStep(dir) {
      if (!dir) return;
      steps += dir;
      schedule();
    },
    /** 立刻冲刷（抬手/取消时调用，保证最后一次捏合不丢） */
    flushNow() {
      if (!frameId) return;
      cancelAnimationFrame(frameId);
      flush();
    },
    dispose() {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = 0;
      target = null;
      steps = 0;
    },
    /** 验收用：累计相机调用次数 / 冲刷帧数 / 是否还有未冲刷的量 */
    stats: () => ({ calls, flushes, pending: target !== null || steps !== 0 }),
    /** 一轮手势结束后清零（汇总条要报"这次手势"的次数，不是进程累计） */
    resetStats() { calls = 0; flushes = 0; },
  };
}

/**
 * 指针状态机：单指拖动 / 双指捏合。
 * @param {{canvas: HTMLCanvasElement, camera: object, options: object}} ctx
 */
/** 一次拖动的累计位移（抬手时汇总成一条 CAMERA 日志；逐帧记会把面板刷满） */
const dragAcc = { dx: 0, dy: 0, moves: 0 };

/** 清空拖动累计（抬手汇总后调用，避免下一段拖动带上上次的位移） */
function resetDragAcc() {
  dragAcc.dx = 0;
  dragAcc.dy = 0;
  dragAcc.moves = 0;
}

/**
 * 一次缩放手势的累计量（**抬手时汇总成一条**，与 dragAcc 同一套做法）。
 *
 * 为什么要累积：逐帧记日志不仅刷屏，更糟的是会把"排队值"写成"→ zoomTo(x)"，
 *   让人读日志时以为每个 move 都真的调了相机（实测就是这样被误判成"没修好"）。
 *   这里只在手势结束打一条，且带上**真实相机调用次数**（来自 scheduler.stats().calls）。
 */
/**
 * 缩放手势的**汇总上报器**（照 dragAcc「累积 → 抬手一条」的做法）。
 *
 * 为什么必须累积而不是逐帧打：
 *   · 逐帧打会把面板刷满（一次捏合几十上百条）；
 *   · 更糟的是文案容易写成「→ zoomTo(x)」，而那只是**排队请求**，被人读成"每个 move
 *     都真的调了相机"——实测就因此被判"没修好"。
 * 因此这里只在手势结束打一条，且带上 scheduler 的**真实相机调用次数**。
 *
 * @param {{camera: object}} ctx
 * @param {{queueTarget:Function, queueStep:Function, flushNow:Function, stats:Function, resetStats:Function}} scheduler
 */
function createZoomReporter(ctx, scheduler) {
  const acc = { active: false, kind: '', startDist: 0, lastDist: 0, moves: 0, lastTarget: 0, steps: 0, events: 0 };
  let lastReport = null;
  let wheelTimer = 0;

  function reset() {
    acc.active = false;
    acc.kind = '';
    acc.startDist = 0;
    acc.lastDist = 0;
    acc.moves = 0;
    acc.lastTarget = 0;
    acc.steps = 0;
    acc.events = 0;
  }

  /** 捏合的一次 move：只累积 + 排队，不打日志 */
  function onPinchMove(pinchStart, dist, ratio) {
    if (!(ratio > 0)) return;
    if (!acc.active || acc.kind !== 'pinch') {
      reset();
      acc.active = true;
      acc.kind = 'pinch';
      acc.startDist = pinchStart.dist;
    }
    acc.lastDist = dist;
    acc.lastTarget = pinchStart.scale * ratio;
    acc.moves += 1;
    scheduler.queueTarget(acc.lastTarget);
  }

  /** 滚轮的一次 tick：只累积 + 排队；停手 200ms 视为一次手势结束 */
  function onWheelTick(dir) {
    if (!acc.active || acc.kind !== 'wheel') {
      reset();
      acc.active = true;
      acc.kind = 'wheel';
    }
    acc.steps += dir;
    acc.events += 1;
    scheduler.queueStep(dir);
    if (wheelTimer) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { wheelTimer = 0; finish('wheel'); }, 200);
  }

  /** 结束一次手势：冲刷末帧 + 打一条汇总（中间过程一条都不打） */
  function finish(kind) {
    if (!acc.active || acc.kind !== kind) return null;
    scheduler.flushNow();
    const calls = scheduler.stats().calls;
    if (kind === 'pinch') {
      ctx.camera.note(
        `pinch ${Math.round(acc.startDist)}→${Math.round(acc.lastDist)}（${acc.moves} moves, ${calls} 帧）`
        + ` 最终目标 ${acc.lastTarget.toFixed(4)} [camera calls: ${calls}]`,
        { moves: acc.moves, calls, target: Number(acc.lastTarget.toFixed(4)) },
      );
    } else {
      ctx.camera.note(
        `wheel ${acc.events} events → zoomStep(${acc.steps > 0 ? '+' : ''}${acc.steps}) [camera calls: ${calls}]`,
        { events: acc.events, calls, steps: acc.steps },
      );
    }
    lastReport = {
      kind,
      moves: acc.moves,
      events: acc.events,
      calls,
      steps: acc.steps,
      target: Number(acc.lastTarget.toFixed(4)),
      startDist: Math.round(acc.startDist),
      lastDist: Math.round(acc.lastDist),
    };
    scheduler.resetStats();
    reset();
    return lastReport;
  }

  return {
    onPinchMove,
    onWheelTick,
    finish,
    last: () => lastReport,
    /** 面板关掉/解绑时清掉定时器，避免残留回调 */
    dispose() { if (wheelTimer) clearTimeout(wheelTimer); wheelTimer = 0; },
  };
}

/** 单指拖动：累积位移 + 排队平移（逐帧不写日志，抬手时由 reportDrag 汇总） */
function queueDrag(panScheduler, previous, point) {
  const dx = point.x - previous.x;
  const dy = point.y - previous.y;
  if (!dx && !dy) return false;
  dragAcc.dx += dx;
  dragAcc.dy += dy;
  dragAcc.moves += 1;
  panScheduler.queue(dx, dy);
  return true;
}

/** 抬手时把一次拖动汇总成一条（帧数一并给出，便于判断"轻点"还是"长拖"） */
function reportDrag(ctx) {
  if (dragAcc.moves <= 0) return;
  ctx.camera.note(
    `drag total dx=${Math.round(dragAcc.dx)} dy=${Math.round(dragAcc.dy)}（${dragAcc.moves} 帧）`,
    { dx: Math.round(dragAcc.dx), dy: Math.round(dragAcc.dy), moves: dragAcc.moves },
  );
  resetDragAcc();
}

/** 建捏合基线：起始 userScale + 两指距离（与旧端一致，绝对式换算，不逐帧累积） */
function makePinchStart(camera, a, b) {
  const scale = camera.scale();
  return { scale: Number.isFinite(scale) ? scale : null, dist: distance(a, b) };
}

/**
 * 双指：缩放（起始 scale × 距离比，绝对式）+ 中点位移平移。
 * @returns {{x:number, y:number}} 本次的中点，供下层作为下一帧基线
 */
function queuePinch(panScheduler, zoomReporter, pinchStart, pinchMid, a, b) {
  const dist = distance(a, b);
  const mid = midpoint(a, b);
  if (pinchStart && pinchStart.dist > 0 && Number.isFinite(pinchStart.scale)) {
    const ratio = dist / pinchStart.dist;
    if (ratio > 0 && Math.abs(ratio - 1) > 0.001) zoomReporter.onPinchMove(pinchStart, dist, ratio);
  }
  if (pinchMid) {
    const dx = mid.x - pinchMid.x;
    const dy = mid.y - pinchMid.y;
    if (dx || dy) panScheduler.queue(dx, dy);
  }
  return mid;
}

function createPointerHandler(ctx, panScheduler, zoomScheduler, zoomReporter) {
  const active = new Map(); // pointerId → 最近一次画布内坐标
  /** 捏合基线：起始 userScale 与起始两指距离（与旧端一致，绝对式换算，不逐帧累积） */
  let pinchStart = null;
  /** 上一帧两指中点（用于双指平移） */
  let pinchMid = null;

  /** 重建捏合基线（双指齐全时才有） */
  function rebuildPinch() {
    if (active.size !== 2) { pinchStart = null; pinchMid = null; return; }
    const [a, b] = [...active.values()];
    pinchStart = makePinchStart(ctx.camera, a, b);
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
      if (queueDrag(panScheduler, previous, point)) event.preventDefault();
      return;
    }
    if (active.size === 2) {
      const [a, b] = [...active.values()];
      pinchMid = queuePinch(panScheduler, zoomReporter, pinchStart, pinchMid, a, b);
      event.preventDefault();
    }
  }

  /** 抬起/取消：移除指针并按剩余手指数重建基线（双指→单指不跳变） */
  function onUp(event) {
    if (!active.delete(event.pointerId)) return;
    try { ctx.canvas.releasePointerCapture(event.pointerId); } catch { /* 同上 */ }
    rebuildPinch();
    reportDrag(ctx);      // 有位移才记一条汇总
    // 缩放手势收尾：末帧必须落地 + 打一条汇总（中间过程一条都不打）
    if (active.size < 2) zoomReporter.finish('pinch');
    if (active.size === 1) {
      const only = [...active.values()][0];
      if (only) pinchMid = { x: only.x, y: only.y };
    }
  }

  /** 滚轮：只看方向、每次一档（与旧端一致）；锚点是视图中心 */
  function onWheel(event) {
    event.preventDefault();
    zoomReporter.onWheelTick(event.deltaY > 0 ? -1 : 1);
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
  // 缩放同样按帧合并：捏合传绝对目标、滚轮传步进（上限仍由相机层钳制）
  const zoomScheduler = createZoomScheduler(
    (target) => camera.zoomTo(target),
    (steps) => camera.zoomStep(steps),
  );
  // 验收要读"真实相机调用次数"：暴露成函数（每次手势后 reset，读到的就是本次手势的数值）
  if (typeof window !== 'undefined') {
    window.__WEB__ = window.__WEB__ || {};
    window.__WEB__.zoomStats = () => zoomScheduler.stats();
    // 最近一次手势的汇总（含真实 calls）；stats 每轮手势后清零，验收读这个更稳
    window.__WEB__.zoomLast = () => zoomReporter.last();
  }
  const zoomReporter = createZoomReporter(ctx, zoomScheduler);
  const handler = createPointerHandler(ctx, panScheduler, zoomScheduler, zoomReporter);

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
    // 缩放也补一次冲刷：最后一次捏合 / 滚轮不能被丢在未执行的 rAF 里
    zoomScheduler.flushNow();
    zoomScheduler.dispose();
    try { zoomReporter.dispose(); } catch { /* 忽略 */ }
    if (typeof window !== 'undefined' && window.__WEB__) {
      delete window.__WEB__.zoomStats;
      delete window.__WEB__.zoomLast;
    }
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
