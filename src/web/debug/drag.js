import * as uiState from '../app/ui-state.js';

// debug/drag.js —— 调试日志浮层的「可拖动 + 记住位置」
//
// 只做移动，不做缩放（缩放手柄不在需求内）。
//
// 六条设计要点：
//   1. 节流：pointermove 只累积目标坐标，真正写样式在 rAF 里做一次
//      （结构与 render/interaction.js 的 createPanScheduler 一致：累积 → 单帧 flush → flushNow）。
//   2. 跟手：拖动期间写 `transform: translate3d()`（只合成、不触发布局），
//      松手时才把最终位置落到 left/top。若每帧都改 left/top，浏览器要重排整页
//      （本页有 1920×1080 的舞台画布），手感会明显发滞。
//   3. 记忆：pointerup 时把最终 left/top 写 localStorage；下次挂载时恢复。
//      没有记录就保持 CSS 里写死的默认位置（right/bottom），不改默认外观。
//   4. 边界：按**当前形态**尺寸夹取（收起=胶囊尺寸，展开=面板尺寸），整块留在视口内。
//      不能拿展开尺寸去夹胶囊 —— 那会让胶囊只能在右上角一小块区域活动。
//      拖出屏幕找不回来是最烦的坏状态（这个浮层没有 reset 入口）。
//   5. 多手柄：展开态拖标题栏、收起态拖胶囊（收起后标题栏高度为 0，只剩胶囊可抓）。
//   6. 点击/拖拽区分：位移 ≤ DRAG_THRESHOLD 视为点击，不开始拖动、不 preventDefault，
//      否则点一下胶囊想展开会变成"轻微抖动但没反应"。
//   7. 展开方向自适应：面板永远朝视口中心展开（靠右向左长、靠下向上长）。
//      写死方向必然有一半位置放不下（胶囊在右下角时向下展开直接出屏）。
//      存盘只存**锚点**（收起态胶囊盒子的位置），展开位置由锚点+方向算出。

/**
 * 位置存储统一走 app/ui-state 工厂（偏好键的 debug.panelPos 段）。
 * 旧键 `spine-viewer-debug-panel-pos` 不再被读取，只由工厂的清理入口发现后删除（避免旧数据永久占用）。
 * 本文件不直接读写它 —— 原来的键常量与 storageKey 参数已无使用方，已删除。
 */

/** 超过这个位移（px）才算拖动；之内视为点击/手抖 */
const DRAG_THRESHOLD = 4;

/** 拖动时不该被当作拖拽起点的元素（标题栏里的按钮/下拉等交互控件） */
const NO_DRAG_SELECTOR = 'button, select, input, textarea, option, a';

/**
 * 读保存的位置。
 * @param {string} [key] 存储键
 * @returns {{left:number, top:number}|null} 无记录或数据损坏时返回 null
 */
export function readSavedPos() {
  // S3：唯一真相源 = 工厂（旧键由工厂在启动时迁移，这里不再直读 localStorage）
  try { return uiState.getPanelPos(); } catch { return null; }
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
 * 给面板装上拖动能力（支持多个手柄：标题栏 + 收起态胶囊）。
 * @param {{root: HTMLElement, head: HTMLElement|HTMLElement[]}} opts
 *   head：单个元素或元素数组；数组里为空的值会被过滤掉（调用方不必自己判空）
 * @returns {{restore:Function, dispose:Function, clampIntoView:Function, stats:Function, resetStats:Function}} 句柄
 */
export function createPanelDrag({ root, head }) {
  const handles = (Array.isArray(head) ? head : [head]).filter(Boolean);
  let moves = 0;
  let dragFrom = null;
  /** 拖动开始时缓存的尺寸/视口：拖动过程中面板尺寸不变，逐帧读 offsetWidth 会强制重排 */
  let dragBox = null;
  /** 拖动起点的 left/top（transform 是相对它算的） */
  let basePos = null;

  /** 读一个尺寸常量（px）；取不到就用兜底值 */
  function cssPx(name, fallback) {
    try {
      const v = parseFloat(getComputedStyle(root).getPropertyValue(name));
      if (Number.isFinite(v)) return v;
    } catch { /* 忽略 */ }
    return fallback;
  }

  /** 边框厚度（常量是内容尺寸，盒子还要加边框；不加会差 2px 冒到视口外） */
  function borderBox() {
    try {
      const cs = getComputedStyle(root);
      return {
        x: (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0),
        y: (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0),
      };
    } catch { return { x: 0, y: 0 }; }
  }

  /** 当前形态（以 root 的 data-collapsed 为准） */
  function currentForm() {
    return root.dataset.collapsed === 'true' ? 'collapsed' : 'expanded';
  }

  /**
   * 某个形态的盒子尺寸与视口。
   *
   * **按形态取尺寸**（不是永远按展开尺寸）：展开方向自适应后，从任何位置都能找到
   *   放得下的朝向 ⇒ 不需要"提前预留展开空间"，拿展开尺寸去夹胶囊只会把可拖范围
   *   压成右上角一小块。
   *
   * **不读 offsetWidth/offsetHeight**：宽度有 220ms 过渡，形态切换瞬间读到的是中间值。
   *   统一从 CSS 常量算，随时可读且与目标尺寸一致。
   * @param {'collapsed'|'expanded'} form
   */
  function boxFor(form) {
    const b = borderBox();
    if (form === 'collapsed') {
      return {
        w: cssPx('--dbg-pill-w', root.offsetWidth) + b.x,
        h: cssPx('--dbg-pill-hbox', root.offsetHeight) + b.y,
        vw: window.innerWidth, vh: window.innerHeight,
      };
    }
    return {
      w: cssPx('--dbg-w', root.offsetWidth) + b.x,
      h: cssPx('--dbg-h', root.offsetHeight) + b.y,
      vw: window.innerWidth, vh: window.innerHeight,
    };
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
    const next = clampPos(pos, box || boxFor(currentForm()));
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
    const next = clampPos(pos, box || dragBox || boxFor(currentForm()));
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

  /** 当前展开方向（由最近一次展开决定） */
  function openDir() {
    const dir = String(root.dataset.openDir || 'up-left');
    return { up: dir.includes('up'), left: dir.includes('left') };
  }

  /**
   * 把"当前形态的盒子位置"换算成**锚点**（收起态胶囊盒子的位置）。
   * 展开态要按方向反算：向左长 ⇒ 胶囊贴在面板右边缘；向上长 ⇒ 贴在面板下边缘。
   * @param {{left:number, top:number}} pos
   * @param {'collapsed'|'expanded'} form
   */
  function toAnchor(pos, form) {
    if (form === 'collapsed') return { left: pos.left, top: pos.top };
    const pBox = boxFor('expanded');
    const cBox = boxFor('collapsed');
    const dir = openDir();
    return {
      left: dir.left ? pos.left + pBox.w - cBox.w : pos.left,
      top: dir.up ? pos.top + pBox.h - cBox.h : pos.top,
    };
  }

  /** 落盘：只存锚点（走工厂的同一条写路径） */
  function persistPos(anchor) {
    try { uiState.setPanelPos({ left: anchor.left, top: anchor.top }); } catch { /* 隐私模式忽略 */ }
  }

  /** 应用一次位置（当前形态）并可选落盘 */
  function applyPos(pos, { persist = false } = {}) {
    const next = writeStyle(pos);
    if (persist) persistPos(toAnchor(next, currentForm()));
    return next;
  }

  /**
   * 切到某个形态并重新定位（**每次展开都重新判断方向**：用户可能拖过位置再展开）。
   *
   * 方向自适应让面板永远朝视口中心长 ⇒ 从任何位置展开都放得下。
   * @param {'collapsed'|'expanded'} form 目标形态
   * @returns {{left:number, top:number}} 落到的位置
   */
  function placeForForm(form) {
    const saved = readSavedPos();
    // 锚点来源：有记录就用记录；否则用当前盒子按当前方向反算（首次运行）
    const anchor = saved || toAnchor(currentPos(), currentForm());
    const cBox = boxFor('collapsed');
    const pBox = boxFor('expanded');

    if (form === 'collapsed') {
      // 收起：胶囊盒子的 left/top 直接就是锚点
      return writeStyle({ left: anchor.left, top: anchor.top }, cBox);
    }

    // 展开：按锚点中心相对视口中心的象限定方向
    const cx = anchor.left + cBox.w / 2;
    const cy = anchor.top + cBox.h / 2;
    const openLeft = cx >= window.innerWidth / 2;
    const openUp = cy >= window.innerHeight / 2;
    root.dataset.openDir = `${openUp ? 'up' : 'down'}-${openLeft ? 'left' : 'right'}`;

    const anchorX = openLeft ? anchor.left + cBox.w : anchor.left;
    const anchorY = openUp ? anchor.top + cBox.h : anchor.top;
    const wantLeft = openLeft ? anchorX - pBox.w : anchorX;
    const wantTop = openUp ? anchorY - pBox.h : anchorY;
    // 兜底：视口比面板还小的极端情况贴左上，允许溢出右/下
    const safeLeft = Math.max(0, Math.min(wantLeft, Math.max(0, window.innerWidth - pBox.w)));
    const safeTop = Math.max(0, Math.min(wantTop, Math.max(0, window.innerHeight - pBox.h)));
    return writeStyle({ left: safeLeft, top: safeTop }, pBox);
  }

  /** 视口变化时重新夹一次，避免窗口变小后面板被挤出屏幕 */
  function onResize() {
    if (root.hidden || dragFrom) return;
    applyPos(currentPos());
  }

  /**
   * 按下：只记录起点，**先不进入拖动**。
   *   进入拖动由第一次超过阈值的 pointermove 触发 —— 这样轻点胶囊仍然是一次正常 click。
   * @param {PointerEvent} ev
   */
  function onPointerDown(ev) {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    // 手柄本身可能就是按钮（收起态胶囊）：它自己要能拖，所以对它跳过"按钮不拖"的过滤
    const selfHandle = ev.currentTarget && ev.currentTarget.dataset
      && ev.currentTarget.dataset.dragHandle === 'self';
    if (!selfHandle && ev.target && ev.target.closest && ev.target.closest(NO_DRAG_SELECTOR)) return;
    basePos = currentPos();
    dragBox = boxFor(currentForm());                 // 只在按下时读一次尺寸
    dragFrom = { px: ev.clientX, py: ev.clientY, id: ev.pointerId, active: false };
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* 老浏览器忽略 */ }
  }

  function onPointerMove(ev) {
    if (!dragFrom || ev.pointerId !== dragFrom.id) return;
    moves += 1;                          // 计数不过阈值也记（节流门禁按真实 move 次数核对）
    if (!dragFrom.active) {
      const dist = Math.abs(ev.clientX - dragFrom.px) + Math.abs(ev.clientY - dragFrom.py);
      if (dist <= DRAG_THRESHOLD) return; // 还在"手抖/点击"范围
      dragFrom.active = true;
      writer = writeTransform;           // 拖动期间走 transform
      root.classList.add('is-dragging');
      if (ev.cancelable) ev.preventDefault();
    }
    // 只累积目标坐标：真正的写入交给 rAF（同一帧多次 move 只写一次）
    scheduler.queue({
      left: basePos.left + (ev.clientX - dragFrom.px),
      top: basePos.top + (ev.clientY - dragFrom.py),
    });
    root.dataset.dragMoves = String(moves);
  }

  function endDrag() {
    if (!dragFrom) return;
    const wasActive = dragFrom.active;
    dragFrom = null;
    root.classList.remove('is-dragging');
    // 没超过阈值 ⇒ 这是一次点击（例如点胶囊展开）：不写位置、不落盘，
    //   且因为全程没 preventDefault，button 的 click 会照常触发。
    if (!wasActive) { writer = writeStyle; return; }
    scheduler.flushNow();               // 最后一帧不能丢
    writer = writeStyle;                // 松手后回到 left/top 真值
    // 用 transform 期间的目标位置在 dataset 里；按它提交，视觉上不跳动
    const left = Number(root.dataset.dragLeft);
    const top = Number(root.dataset.dragTop);
    if (Number.isFinite(left) && Number.isFinite(top)) applyPos({ left, top }, { persist: true });
    else applyPos(currentPos(), { persist: true });
  }

  for (const h of handles) {
    h.addEventListener('pointerdown', onPointerDown);
    h.addEventListener('pointermove', onPointerMove);
    h.addEventListener('pointerup', endDrag);
    h.addEventListener('pointercancel', endDrag);
  }
  window.addEventListener('resize', onResize);

  return {
    /** 按存储的锚点恢复位置（当前形态由 root 的 data-collapsed 决定；展开会重判方向） */
    restore() {
      return placeForForm(currentForm());
    },
    /** 形态切换后重新定位（同时重新判断展开方向） */
    applyForm(form) {
      return placeForForm(form);
    },
    /** 窗口缩放等场景下重新夹一次，避免撑出视口 */
    clampIntoView() {
      if (root.hidden || dragFrom) return null;
      return applyPos(currentPos());
    },
    dispose() {
      for (const h of handles) {
        h.removeEventListener('pointerdown', onPointerDown);
        h.removeEventListener('pointermove', onPointerMove);
        h.removeEventListener('pointerup', endDrag);
        h.removeEventListener('pointercancel', endDrag);
      }
      window.removeEventListener('resize', onResize);
      scheduler.flushNow();
    },
    /** 节流证据：move 次数 vs 样式写入次数 */
    stats: () => ({
      moves, ...scheduler.stats(),
      left: root.dataset.dragLeft || null,
      top: root.dataset.dragTop || null,
      openDir: root.dataset.openDir || null,
      // 落盘存的是"锚点"（收起态胶囊盒子的位置）；这里把它换算出来供门禁核对
      anchor: toAnchor(currentPos(), currentForm()),
    }),
    resetStats: () => { moves = 0; scheduler.resetStats(); },
  };
}
