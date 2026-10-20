// stage-surface.js —— 渲染面（StageSurface）：画布与帧时钟的唯一所有者
//
// 职责边界：
//   · Surface **唯一拥有**：#stage-canvas（Spine 面）、覆盖层容器与它的 canvas（Live2D 面）、
//     尺寸计算、DPR、z 序、可见性、`data-stage-mode`、帧调度入口；
//   · Renderer 只拿到 **handle**（canvas / overlay / size / dpr / requestRender / onResize），
//     不许自己建 canvas、不许读 DOM 尺寸、不许自己起 rAF 主循环；
//   · 切换只有一个入口 `activate(document)`：loading → 统一卸载 → 装载 → 切面，串行保护；
//   · 卸载只有 `disposeActive()`：幂等、不关心当前是哪一面。
//
// 为什么这么分：新增渲染面（3D）时只加一个 register()，不必再改画布/尺寸/可见性逻辑。

/** 覆盖层容器 id（Live2D 面用） */

const OVERLAY_ID = 'live2d-overlay';
/** 覆盖层内 canvas id */
const OVERLAY_CANVAS_ID = 'live2d-overlay-canvas';

/**
 * 创建渲染面。
 * @param {{
 *   root?: HTMLElement | (() => HTMLElement|null),
 *   log?: (message: string, level?: 'info'|'warn'|'error') => void,
 * }} [options] root 缺省用 #stage
 */
export function createStageSurface({ root, log } = {}) {
  /** 根容器（#stage） */
  function rootEl() {
    if (typeof root === 'function') return root();
    return root || document.getElementById('stage');
  }

  const renderers = new Map();
  const resizeCbs = new Set();

  const st = {
    /** 当前渲染器 id（null = 未激活） */
    activeId: null,
    /** 当前已装载的 document（便于排查） */
    document: null,
    /** 切换串行锁 */
    swapping: false,
    /** 尺寸与 DPR */
    size: { width: 0, height: 0 },
    backgroundMode: 'checkerboard', // 背景唯一权威（写 data-bg 的唯一入口）
    bgCbs: new Set(),
    dpr: (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
    /** 帧统计 */
    frames: 0,
    fps: 0,
    fpsAt: 0,
    /** rAF 句柄（Surface 的帧调度入口） */
    rafId: 0,
    /** 待渲染标记 */
    dirty: false,
  };

  /** 统一日志出口 */
  function note(message, level = 'info') {
    if (typeof log === 'function') {
      try { log(message, level); } catch { /* 忽略 */ }
    }
  }

  // ---------------------------------------------------------------- 画布所有权
  /** 覆盖层容器（Surface 建、Surface 管） */
  let overlayEl = null;

  /** 确保覆盖层存在（父级 = #stage，绝对定位铺满，不接收指针事件） */
  function ensureOverlay() {
    if (overlayEl && overlayEl.isConnected) return overlayEl;
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = OVERLAY_ID;
      // pointer-events:none ⇒ 事件仍落到 Spine 画布，交互层路径完全不变
      el.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;z-index:5;'
        + 'display:none;pointer-events:none;background:transparent;overflow:hidden';
      const cv = document.createElement('canvas');
      cv.id = OVERLAY_CANVAS_ID;
      cv.style.cssText = 'display:block;width:100%;height:100%';
      el.appendChild(cv);
      (rootEl() || document.body).appendChild(el);
    }
    overlayEl = el;
    return el;
  }

  /** 取覆盖层内的 canvas（Live2D 渲染目标） */
  function overlayCanvas() {
    ensureOverlay();
    return document.getElementById(OVERLAY_CANVAS_ID);
  }

  /** 取 Spine 面 canvas（舞台里已有的那块，Surface 负责尺寸/DPR） */
  function spineCanvas() {
    return document.getElementById('stage-canvas');
  }

  // ---------------------------------------------------------------- 尺寸 / DPR
  /**
   * 量测根容器的 CSS 尺寸，并把「CSS 尺寸 + 期望 DPR」交给当前渲染器。
   * 为什么这里不写 canvas.width：像素尺寸（backing store）只由渲染器/引擎拥有，
   *   Surface 一旦也写，就会与引擎的 getEffectiveDpr 口径打架 ——
   *   像素网格变了而 gl.viewport / camera.viewportWidth 没变 ⇒ 画面整体缩放偏移（BUG-2）。
   */
  function measure() {
    const el = rootEl();
    if (!el) return st.size;
    const rect = el.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || el.clientWidth || 0));
    const height = Math.max(1, Math.round(rect.height || el.clientHeight || 0));
    const changed = width !== st.size.width || height !== st.size.height;
    st.size = { width, height };
    const box = { cssW: width, cssH: height, dpr: st.dpr };
    if (changed) {
      notifyResize(box);
      for (const cb of resizeCbs) {
        try { cb({ ...box }); } catch { /* 回调异常不影响其它订阅者 */ }
      }
    }
    return st.size;
  }

  /**
   * 读取 URL 上的 ?res=N 强制分辨率（对照实验用；缺省/非法返回 null）。
   * 放在 Surface 里：分辨率也是「几何」的一部分，不允许各渲染面自己解析一遍。
   * @returns {number|null}
   */
  function forcedResOverride() {
    try {
      const raw = new URLSearchParams(window.location.search || '').get('res');
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 1 && n <= 4 ? n : null;
    } catch { return null; }
  }

  /**
   * 尺寸唯一来源：渲染器只从这里取几何，不得自己读 DOM 或 devicePixelRatio。
   * 语义：cssW/cssH = 舞台 CSS 像素；dpr = 设备比；res = 期望分辨率。
   *   最终生效的分辨率由各渲染器按自身规则决定（Spine 引擎会再按软件渲染 / dprMode 收口）。
   * 为什么集中在 Surface：同一件事只能有一个负责人，否则两套渲染面会各自算出不同尺寸。
   * @returns {{cssW:number, cssH:number, dpr:number, res:number}}
   */
  function geometry() {
    let width = st.size.width;
    let height = st.size.height;
    // 首次调用可能还没 measure 过：只补一次只读测量，不触发 notifyResize
    if (!width || !height) {
      const el = rootEl();
      if (el) {
        const rect = el.getBoundingClientRect();
        width = Math.max(1, Math.round(rect.width || el.clientWidth || 0));
        height = Math.max(1, Math.round(rect.height || el.clientHeight || 0));
      }
    }
    const dpr = st.dpr > 0 ? st.dpr : 1;
    const forced = forcedResOverride();
    return { cssW: width || 1, cssH: height || 1, dpr, res: forced || dpr };
  }
  /**
   * 把尺寸变化交给当前渲染器（渲染器负责决定 backing store：引擎侧按 getEffectiveDpr 算）。
   * @param {{cssW:number, cssH:number, dpr:number}} box
   */
  function notifyResize(box) {
    const entry = renderers.get(st.activeId);
    if (entry && typeof entry.resize === 'function') {
      try { entry.resize(box); } catch (err) { note(`渲染器 resize 失败：${err && err.message}`, 'warn'); }
    }
  }

  /** 尺寸变化订阅（渲染器在这里拿到最新尺寸，自己不读 DOM） */
  function onResize(cb) {
    if (typeof cb !== 'function') return () => {};
    resizeCbs.add(cb);
    return () => resizeCbs.delete(cb);
  }

  /** ResizeObserver：root 尺寸变化即重算（避免轮询） */
  let observer = null;
  function watchResize() {
    if (observer || typeof ResizeObserver !== 'function') return;
    const el = rootEl();
    if (!el) return;
    observer = new ResizeObserver(() => { measure(); });
    observer.observe(el);
  }

  // ---------------------------------------------------------------- 常驻断言

// ---------------------------------------------------------------- 帧时钟
  /** 调度一次渲染（Surface 的帧入口：渲染器只"请求渲染"，不自己起循环） */
  function requestRender() {
    st.dirty = true;
    if (st.rafId) return;
    st.rafId = requestAnimationFrame(() => {
      st.rafId = 0;
      if (!st.dirty) return;
      st.dirty = false;
      st.frames += 1;
      const now = performance.now();
      if (!st.fpsAt) st.fpsAt = now;
      if (now - st.fpsAt >= 1000) {
        st.fps = Math.round((st.frames * 1000) / (now - st.fpsAt));
        st.frames = 0;
        st.fpsAt = now;
      }
      const entry = renderers.get(st.activeId);
      if (entry && typeof entry.render === 'function') {
        try { entry.render({ width: st.size.width, height: st.size.height, dpr: st.dpr }); } catch { /* 忽略 */ }
      }
    });
  }

  // ---------------------------------------------------------------- 切面（唯一写入点）
  /**
   * 写 data-stage-mode（**本文件是唯一写入点**）。
   * @param {'spine'|'live2d'|'loading'} mode
   */
  function setMode(mode) {
    const el = rootEl();
    const next = mode === 'live2d' ? 'live2d' : (mode === 'loading' ? 'loading' : 'spine');
    if (el) el.dataset.stageMode = next;
    // 覆盖层只在 live2d 面显示；其它面一律隐藏（避免透明画布压在上面）
    const ov = document.getElementById(OVERLAY_ID);
    if (ov) ov.style.display = next === 'live2d' ? 'block' : 'none';
    return next;
  }

  /** 读当前面 */
  function stageMode() {
    const el = rootEl();
    return el ? el.dataset.stageMode || null : null;
  }

  /** 切换断言日志（只读三项状态 + 画布尺寸） */
  function noteSwitch(tag) {
    const cv = spineCanvas();
    const ov = document.getElementById(OVERLAY_ID);
    const entry = renderers.get(st.activeId);
    let active = null;
    try { active = entry && typeof entry.isActive === 'function' ? !!entry.isActive() : null; } catch { active = 'err'; }
    const line = `${tag} → stageMode=${stageMode()} active=${st.activeId} activeState=${active}`
      + ` overlay=${ov ? getComputedStyle(ov).display : 'none'} spineCanvas=${cv ? getComputedStyle(cv).visibility : null}`
      + ` width=${cv ? cv.width : null} size=${st.size.width}x${st.size.height}@${st.dpr}`;
    note(line);
    return line;
  }

  // ---------------------------------------------------------------- 注册与句柄
  /**
   * 注册一个渲染器。
   * @param {{id: string, capabilities: object, mount: Function, dispose?: Function, isActive?: Function, camera?: object, render?: Function}} renderer
   */
  function register(renderer) {
    if (!renderer || !renderer.id) throw new Error('stageSurface.register: 渲染器必须有 id');
    renderers.set(renderer.id, renderer);
    note(`注册渲染器：${renderer.id}`);
    return renderer;
  }

  /**
   * 取渲染资源句柄（渲染器只能通过它碰画布/尺寸）。
   * @param {string} rendererId
   */
  function handle(rendererId) {
    const isLive2D = rendererId === 'live2d';
    return {
      /** 该渲染面独占的 canvas（Spine = 舞台画布；Live2D = 覆盖层 canvas） */
      canvas: isLive2D ? overlayCanvas() : spineCanvas(),
      /** 覆盖层容器（Live2D 用；Spine 面为 null） */
      overlay: isLive2D ? ensureOverlay() : null,
      /** 逻辑尺寸（CSS 像素） */
      get size() { return { ...st.size }; },
      /** 设备像素比 */
      get dpr() { return st.dpr; },
      /** 尺寸唯一来源（cssW/cssH/dpr/res） */
      geometry,
      /** 请求渲染（Surface 调度，渲染器不自己起 rAF） */
      requestRender,
      /** 订阅尺寸变化 */
      onResize,
      /** 背景模式（唯一权威在 Surface；渲染器只读） */
      getBackgroundMode,
      /** 订阅背景变化（mount 时订阅、卸载时退订） */
      onBackgroundChange,
      /** 背景配色（从 CSS 变量集中读取） */
      palette,
    };
  }

  // ---------------------------------------------------------------- 激活状态机
  /**
   * 唯一卸载入口：幂等，不关心当前是哪一面。
   */
  async function disposeActive() {
    const entry = renderers.get(st.activeId);
    if (entry && typeof entry.dispose === 'function') {
      try { await entry.dispose(); } catch { /* 卸载失败也要继续切面 */ }
    }
    st.activeId = null;
    st.document = null;
    setMode('loading');
  }

  /**
   * 唯一切换入口。
   * @param {{kind?: 'spine'|'live2d', id?: string, rendererId?: string}} document
   * @returns {Promise<any>} 装载结果（并发被丢弃时返回 null）
   */
  async function activate(document) {
    if (st.swapping) {
      note('切换进行中，忽略本次请求');
      return null;
    }
    st.swapping = true;
    const previous = st.activeId;
    try {
      setMode('loading');           // ① 先遮住：任何方向都不可能叠加
      await disposeActive();        // ② 统一卸载（幂等）
      const kind = document && document.kind === 'live2d' ? 'live2d' : 'spine';
      const rendererId = (document && document.rendererId) || kind;
      const entry = renderers.get(rendererId);
      if (!entry) throw new Error(`没有注册渲染器：${rendererId}`);
      measure();
      const info = await entry.mount(document, handle(rendererId)); // ③ 装载
      st.activeId = rendererId;
      st.document = document || null;
      setMode(kind);                // ④ 切面（全项目唯一写入点）
      requestRender();
      noteSwitch(`activated:${rendererId}`);
      return info;
    } catch (err) {
      // ⑤ 失败回滚：回到上一个面（没有就回到 spine），并如实记日志
      setMode(previous === 'live2d' ? 'live2d' : 'spine');
      st.activeId = previous;
      noteSwitch(`activate-failed:${(document && document.kind) || '?'}`);
      throw err;
    } finally {
      st.swapping = false;
    }
  }

  /** 当前渲染器的相机（交互层通过它拿到 camera.*，不关心是哪一面） */
  function activeCamera() {
    const entry = renderers.get(st.activeId);
    return entry && entry.camera ? entry.camera : null;
  }

  /** 只读统计 */
  function stats() {
    return {
      active: st.activeId,
      mode: stageMode(),
      size: { ...st.size },
      dpr: st.dpr,
      fps: st.fps,
      swapping: st.swapping,
    };
  }

  /**
   * 设置期望 DPR：只记录并下发给渲染器，**不直接写画布**。
   * 真实生效值由引擎 getEffectiveDpr 决定（它知道软件渲染、dprMode、封顶 2 这些规则）。
   * @param {number|string} value 像素比，或 'auto'
   */
  function setDpr(value) {
    const v = value === 'auto' || value === undefined ? null : Number(value);
    st.dprRequest = v && v > 0 ? v : null;
    st.dpr = st.dprRequest || (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const entry = renderers.get(st.activeId);
    if (entry && typeof entry.setDpr === 'function') {
      try { entry.setDpr(value); } catch (err) { note(`渲染器 setDpr 失败：${err && err.message}`, 'warn'); }
    }
    measure();
    requestRender();
    return st.dpr;
  }

  /**
   * 读当前背景模式（唯一权威在 Surface，渲染器不得自己读 DOM 属性）。
   * @returns {'checkerboard'|'solid'|'transparent'}
   */
  function getBackgroundMode() {
    return st.backgroundMode;
  }

  /**
   * 读背景配色（从 CSS 变量集中读取，渲染器不自己 getComputedStyle）。
   * 为什么集中：棋盘/纯色的具体色值属于"表面"的视觉约定，分散到各渲染器会两套真相。
   * @returns {{solid:string, checkerDark:string, checkerLight:string}}
   */
  function palette() {
    const el = rootEl();
    const read = (name, fallback) => {
      try {
        const v = el ? getComputedStyle(el).getPropertyValue(name).trim() : '';
        return v || fallback;
      } catch { return fallback; }
    };
    return {
      solid: read('--stage-solid', '#2a2a2a'),
      checkerDark: read('--stage-checker-dark', '#2a2a2a'),
      checkerLight: read('--stage-checker-light', '#3a3f45'),
    };
  }

  /**
   * 设置背景模式（**写 data-bg 的唯一入口**）。
   * 副作用顺序：更新权威状态 → 写 data-bg（CSS 兜底）→ 通知所有渲染器与订阅者。
   * @param {'checkerboard'|'solid'|'transparent'} mode
   * @returns {string} 规范化后的模式
   */
  function setBackground(mode) {
    const el = rootEl();
    const next = mode === 'solid' || mode === 'transparent' ? mode : 'checkerboard';
    const changed = next !== st.backgroundMode;
    st.backgroundMode = next;
    if (el) el.dataset.bg = next;
    const pal = palette();
    // 通知所有已注册渲染器（不论当前是否激活：切面后状态必须一致）
    for (const [, entry] of renderers) {
      if (entry && typeof entry.setBackground === 'function') {
        try { entry.setBackground(next, pal); } catch (err) { note(`渲染器 setBackground 失败：${err && err.message}`, 'warn'); }
      }
    }
    if (changed) {
      for (const cb of st.bgCbs) {
        try { cb(next, pal); } catch { /* 订阅者异常不影响其他订阅者 */ }
      }
    }
    return next;
  }

  /**
   * 订阅背景变化（渲染器在 mount 时订阅、卸载时退订）。
   * 回调签名：(mode, palette) => void
   * @param {(mode: string, pal: object) => void} cb
   * @returns {() => void} 退订函数
   */
  function onBackgroundChange(cb) {
    if (typeof cb !== 'function') return () => {};
    st.bgCbs.add(cb);
    return () => st.bgCbs.delete(cb);
  }
  /** 释放整块表面 */
  function dispose() {
    try { disposeActive(); } catch { /* 忽略 */ }
    if (observer) { try { observer.disconnect(); } catch { /* 忽略 */ } observer = null; }
    if (st.rafId) { try { cancelAnimationFrame(st.rafId); } catch { /* 忽略 */ } st.rafId = 0; }
    resizeCbs.clear();
    renderers.clear();
    note('渲染面已释放');
  }

  // 初始化：建覆盖层、量尺寸、开始观察
  try {
    ensureOverlay();
    // 以 DOM 现值作为初始权威（样式表可能已预设 data-bg）
    try {
      const el0 = rootEl();
      st.backgroundMode = (el0 && el0.dataset && el0.dataset.bg) || 'checkerboard';
    } catch { /* 忽略 */ }
    measure();
    watchResize();
  } catch (err) {
    note(`渲染面初始化失败：${err && err.message}`, 'warn');
  }

  return {
    register,
    handle,
    activate,
    dispose,
    disposeActive,
    setDpr,
    stats,
    stageMode,
    setMode,
    activeCamera,
    requestRender,
    onResize,
    measure,
    geometry,
    getBackgroundMode,
    setBackground,
    onBackgroundChange,
    palette,
    /**
     * 交互目标：整个舞台区域（不是某一块画布）。
     * 为什么要暴露它：画布可见性会随渲染面切换而变化（Live2D 面下 Spine 画布
     *   `visibility:hidden` 不参与命中测试），而交互属于"舞台区域"、不属于某块画布；
     * 由 Surface 给出恒定目标，交互层绑定一次即可 —— 切面后无需重绑，也不会双监听。
     */
    get interactionTarget() { return rootEl(); },
    renderers: () => [...renderers.keys()],
  };
}
