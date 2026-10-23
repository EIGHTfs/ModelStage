// debug/drag.js —— 调试日志浮层的「可拖动 + 记住位置」
//
// 只做移动，不做缩放（缩放手柄不在需求内）。
//
// 四条设计要点：
//   1. 节流：pointermove 只累积目标坐标，真正写样式在 rAF 里做一次
//      （结构与 render/interaction.js 的 createPanScheduler 一致：累积 → 单帧 flush → flushNow）。
//   2. 跟手：拖动期间写 `transform: translate3d()`（只合成、不触发布局），
//      松手时才把最终位置落到 left/top。若每帧都改 left/top，浏览器要重排整页
//      （本页有 1920×1080 的舞台画布），手感会明显发滞。
//   3. 记忆：pointerup 时把最终 left/top 写 localStorage；下次挂载时恢复。
//      没有记录就保持 CSS 里写死的默认位置（right/bottom），不改默认外观。
//   4. 边界：面板不能被拖出视口——上/左不越 0，右/下至少留出整块面板，
//      保证"永远抓得到标题栏"。

/** 位置存储键（与视图设置分开：这是调试浮层自己的界面状态） */
export const DRAG_STORAGE_KEY = 'spine-viewer-debug-panel-pos';

/** 拖动时不该被当作拖拽起点的元素（按钮/下拉都在标题栏里） */
const NO_DRAG_SELECTOR = 'button, select, input, textarea, option, a';

/**
 * 读保存的位置。
 * @param {string} [key] 存储键
 * @returns {{left:number, top:number}|null} 无记录或数据损坏时返回 null
 */
export function readSavedPos(key = DRAG_STORAGE_KEY) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Number.isFinite(obj.left) || !Number.isFinite(obj.top)) return null;
    return { left: obj.left, top: obj.top };
  } catch {
    return null;
  }
}

/**
 * 把坐标夹到"面板不出视口"的范围内（标题栏因此始终可见）。
 * @param {{left:number, top:number}} pos 期望位置
 * @param {{w:number, h:number, vw:number, vh:number}} box 面板宽高与视口尺寸
 * @returns {{left:number, top:number}} 夹取后的位置
 */
export function clampPos(pos, box) {
  const maxLeft = Math.max(0, box.vw - box.w);
  const maxTop = Math.max(0, box.vh - box.h);
  return {
    left: Math.min(Math.max(0, pos.left), maxLeft),
    top: Math.min(Math.max(0, pos.top), maxTop),
  };
}

/**
 * 单帧只写一次样式的调度器。
 * @param {(pos:{left:number,top:number}) => void} write 真正的写入
 * @returns {{queue:Function, flushNow:Function, stats:Function, resetStats:Function}} 调度器
 */
function createPosScheduler(write) {
  let pending = null;
  let frameId = 0;
  let writes = 0;
  /** 冲刷本帧累积的目标位置（同一帧内多次 queue 只写一次） */
  function flush() {
    frameId = 0;
    if (!pending) return;
    const pos = pending;
    pending = null;
    writes += 1;
    write(pos);
  }
  return {
    queue(pos) { pending = pos; if (!frameId) frameId = requestAnimationFrame(flush); },
    flushNow() { if (frameId) { cancelAnimationFrame(frameId); flush(); } },
    stats: () => ({ writes }),
    resetStats: () => { writes = 0; },
  };
}

/**
 * 给面板标题栏装上拖动能力。
 * @param {{root: HTMLElement, head: HTMLElement, storageKey?: string}} opts
 * @returns {{restore:Function, dispose:Function, stats:Function, resetStats:Function}} 句柄
 */
export function createPanelDrag({ root, head, storageKey = DRAG_STORAGE_KEY }) {
  let moves = 0;
  let dragFrom = null;
  /** 拖动开始时缓存的尺寸/视口：拖动过程中面板尺寸不变，逐帧读 offsetWidth 会强制重排 */
  let dragBox = null;
  /** 拖动起点的 left/top（transform 是相对它算的） */
  let basePos = null;

  /** 面板当前的尺寸与视口 */
  function boxNow() {
    return { w: root.offsetWidth, h: root.offsetHeight, vw: window.innerWidth, vh: window.innerHeight };
  }

  /** 面板当前的 left/top（未定位过时按实际渲染位置换算） */
  function currentPos() {
    const r = root.getBoundingClientRect();
    return { left: r.left, top: r.top };
  }

  /** 记一次写入次数（节流证据：moves vs writes） */
  function countWrite() {
    root.dataset.dragWrites = String(Number(root.dataset.dragWrites || 0) + 1);
  }

  /** 把位置落到 left/top（松手/恢复/窗口变化时用；会触发布局，所以不在拖动中调用） */
  function writeStyle(pos, box) {
    const next = clampPos(pos, box || boxNow());
    root.style.transform = '';
    root.style.left = `${Math.round(next.left)}px`;
    root.style.top = `${Math.round(next.top)}px`;
    // 用 left/top 定位后必须解除 right/bottom，否则两套定位同时生效会打架
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    root.dataset.dragLeft = String(Math.round(next.left));
    root.dataset.dragTop = String(Math.round(next.top));
    countWrite();
    return next;
  }

  /** 拖动中只写 transform（合成层，不重排）——这是"跟手"的关键 */
  function writeTransform(pos, box) {
    const next = clampPos(pos, box || dragBox || boxNow());
    const dx = next.left - (basePos ? basePos.left : next.left);
    const dy = next.top - (basePos ? basePos.top : next.top);
    root.style.transform = `translate3d(${Math.round(dx)}px, ${Math.round(dy)}px, 0)`;
    root.dataset.dragLeft = String(Math.round(next.left));
    root.dataset.dragTop = String(Math.round(next.top));
    countWrite();
    return next;
  }

  /** 当前写入策略：拖动中用 transform，其余时候写 left/top */
  let writer = writeStyle;
  const scheduler = createPosScheduler((pos) => writer(pos));

  /** 应用一次位置并可选落盘 */
  function applyPos(pos, { persist = false } = {}) {
    const next = writeStyle(pos);
    if (persist) {
      try { localStorage.setItem(storageKey, JSON.stringify({ left: Math.round(next.left), top: Math.round(next.top) })); } catch { /* 隐私模式忽略 */ }
    }
    return next;
  }

  /** 视口变化时重新夹一次，避免窗口变小后面板被挤出屏幕 */
  function onResize() {
    if (root.hidden || dragFrom) return;
    applyPos(currentPos());
  }

  function onPointerDown(ev) {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    if (ev.target && ev.target.closest && ev.target.closest(NO_DRAG_SELECTOR)) return;
    basePos = currentPos();
    dragBox = boxNow();                 // 只在按下时读一次尺寸
    dragFrom = { px: ev.clientX, py: ev.clientY, id: ev.pointerId };
    writer = writeTransform;            // 拖动期间走 transform
    root.classList.add('is-dragging');
    try { head.setPointerCapture(ev.pointerId); } catch { /* 老浏览器忽略 */ }
    ev.preventDefault();
  }

  function onPointerMove(ev) {
    if (!dragFrom || ev.pointerId !== dragFrom.id) return;
    moves += 1;
    // 只累积目标坐标：真正的写入交给 rAF（同一帧多次 move 只写一次）
    scheduler.queue({
      left: basePos.left + (ev.clientX - dragFrom.px),
      top: basePos.top + (ev.clientY - dragFrom.py),
    });
    root.dataset.dragMoves = String(moves);
  }

  function endDrag() {
    if (!dragFrom) return;
    dragFrom = null;
    root.classList.remove('is-dragging');
    scheduler.flushNow();               // 最后一帧不能丢
    writer = writeStyle;                // 松手后回到 left/top 真值
    // 用 transform 期间的目标位置在 dataset 里；按它提交，视觉上不跳动
    const left = Number(root.dataset.dragLeft);
    const top = Number(root.dataset.dragTop);
    if (Number.isFinite(left) && Number.isFinite(top)) applyPos({ left, top }, { persist: true });
    else applyPos(currentPos(), { persist: true });
  }

  head.addEventListener('pointerdown', onPointerDown);
  head.addEventListener('pointermove', onPointerMove);
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', onResize);

  return {
    /** 恢复保存的位置（没有记录就保持 CSS 默认位置） */
    restore() {
      const saved = readSavedPos(storageKey);
      if (!saved) return false;
      applyPos(saved);
      return true;
    },
    dispose() {
      head.removeEventListener('pointerdown', onPointerDown);
      head.removeEventListener('pointermove', onPointerMove);
      head.removeEventListener('pointerup', endDrag);
      head.removeEventListener('pointercancel', endDrag);
      window.removeEventListener('resize', onResize);
      scheduler.flushNow();
    },
    /** 节流证据：move 次数 vs 样式写入次数 */
    stats: () => ({ moves, ...scheduler.stats(), left: root.dataset.dragLeft || null, top: root.dataset.dragTop || null }),
    resetStats: () => { moves = 0; scheduler.resetStats(); },
  };
}
