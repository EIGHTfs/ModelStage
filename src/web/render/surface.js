// render/surface.js —— 渲染面（StageSurface）：画布与帧时钟的唯一所有者
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

import { createSwitcher } from './surface-switch.js';

/** 覆盖层容器 id（Live2D 面用） */

const OVERLAY_ID = 'live2d-overlay';
/** 覆盖层内 canvas id */
const OVERLAY_CANVAS_ID = 'live2d-overlay-canvas';

/**
 * 旋转后重新挂载的延迟（毫秒）。
 * 手机旋转是一次约 200–300ms 的布局动画：orientationchange 在动画开始时触发，
 *   此刻量到的仍是旧尺寸，所以必须等动画结束再动作。
 */
const ROTATE_RELOAD_DELAY_MS = 320;

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
  /** 切换完成后要通知的订阅者（面板据此重算三态） */
  const switchCbs = new Set();

  const st = {
    /** 当前渲染器 id（null = 未激活） */
    activeId: null,
    /** 当前已装载的 document（便于排查） */
    document: null,
    /** 切换串行锁 */
    swapping: false,
    pending: null,        // 切换进行中收到的最新请求（last-wins，完成后立即消费）
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
    /**
     * 尺寸触发源的命中计数（诊断用）。
     * 真机旋转后画布没重建时，看这一组数就能分清三种情况：
     * 诊断用途：真机旋转后读 stats() 即可判断卡在哪一层：
     *   · 全是 0            → 事件/观察者根本没发（触发源缺失）
     *   · 有计数但 size 没变 → 发了，但 DOM 尺寸确实没变（布局侧问题）
     *   · 有计数且 size 变了 → 尺寸链路通了，问题在下游（渲染器/画布）
     */
    trigger: { resize: 0, orientationchange: 0, visualViewport: 0, resizeObserver: 0 },
    /** 最后一次 measure 的时刻、最后一次"尺寸真的变了"的时刻（performance.now，便于判断冻结多久） */
    lastMeasureAt: 0,
    lastChangeAt: 0,
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
    // 每次量尺寸都顺手确保监听已就位：observer 若因"根容器当时不在 DOM"没建成，这里补建
    // （函数声明会提升，调用顺序上不必担心定义在后面）
    watchResize();
    const el = rootEl();
    if (!el) return st.size;
    const rect = el.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || el.clientWidth || 0));
    const height = Math.max(1, Math.round(rect.height || el.clientHeight || 0));
    const changed = width !== st.size.width || height !== st.size.height;
    st.size = { width, height };
    st.lastMeasureAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const box = { cssW: width, cssH: height, dpr: st.dpr };
    if (changed) {
      st.lastChangeAt = st.lastMeasureAt;
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

  /**
   * 尺寸监听：ResizeObserver 是主触发源，另配三类兜底事件。
   *
   * 为什么必须有兜底（手机旋转错位的成因）：
   *   早期只靠 ResizeObserver 单一触发，且它只在 `activate()` 时创建一次。一旦那一刻
   *   `rootEl()` 还没进 DOM，`watchResize()` 直接 return —— observer 永远不会再建，
   *   此后所有尺寸变化都收不到；而 `geometry()` 优先读 `st.size` 缓存，也不会自救，
   *   于是几何永久停在旧值。实测（视口 777x1035 → 1035x777，ResizeObserver 置空）：
   *   `inner/stageCss` 已变成 1035x777，而 `geometry()` 仍返回 777x1035、
   *   overlay canvas 仍 2137x2846 ⇒ 模型按旧视口渲染，挤在左侧窄带、右侧露出棋盘格。
   *
   * 兜底触发源为什么是这三个：
   *   · `resize`          —— 桌面窗口缩放；
   *   · `orientationchange` —— 手机旋转（部分浏览器只发它，且早于布局更新）；
   *   · `visualViewport.resize` —— 移动端地址栏收起/键盘弹起等"可视视口"变化。
   * 三者都只做一件事：延后一拍再 `measure()`。`measure()` 自带"尺寸没变就不通知"的
   *   去重，所以多路触发不会造成重复 resize。
   */
  let observer = null;
  let fallbacksBound = false;

  /** 绑定兜底事件（幂等；只绑一次） */
  function watchFallbacks() {
    if (fallbacksBound || typeof window === 'undefined') return;
    fallbacksBound = true;
    /**
     * 事件触发 → 计数 → 延后一帧再量。
     * 计数按触发源分开记：真机旋转后看 `stats().trigger` 就知道是哪个源发了、哪个没发。
     */
    const kick = (src) => () => {
      st.trigger[src] += 1;
      // 旋转时 layout viewport 可能在本事件之后才更新，所以延后一帧再量
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { measure(); });
      else measure();
    };
    window.addEventListener('resize', kick('resize'), { passive: true });
    // 旋转：等动画结束再处理，且**重新挂载当前文档**（不是只 resize）。
    //   实测：真机旋转后仅靠 resize 链路，画布会停在旧尺寸（client 与容器不一致），
    //   而"手动重选模型"能恢复 —— 说明完整 activate → mount → resize 这条路是可靠的。
    //   所以这里直接复用那条路：尺寸确实变了就重新激活同一份文档。
    //   代价是一次模型重挂（与手动重载等价），换来确定性恢复。
    let rotateTimer = 0;
    window.addEventListener('orientationchange', () => {
      st.trigger.orientationchange += 1;
      if (rotateTimer) { try { clearTimeout(rotateTimer); } catch { /* 忽略 */ } }
      rotateTimer = setTimeout(() => {
        rotateTimer = 0;
        const before = { w: st.size.width, h: st.size.height };
        try { measure(); } catch { return; }
        const changed = st.size.width !== before.w || st.size.height !== before.h;
        if (!changed || !st.document || st.swapping) return;
        try { activate(st.document); } catch { /* 重挂失败时保留原画面，不打断用户 */ }
      }, ROTATE_RELOAD_DELAY_MS);
    }, { passive: true });
    if (window.visualViewport) {
      try { window.visualViewport.addEventListener('resize', kick('visualViewport'), { passive: true }); } catch { /* 老浏览器忽略 */ }
    }
  }

  /**
   * 建 ResizeObserver（幂等、可迟到补建）。
   * 不再因为"此刻 rootEl() 为空"就永久放弃：`measure()` 每次都会调一次本函数，
   * 一旦根容器进 DOM 就会补建观察者。
   */
  function watchResize() {
    if (!observer && typeof ResizeObserver === 'function') {
      const el = rootEl();
      if (el) {
        observer = new ResizeObserver(() => { st.trigger.resizeObserver += 1; measure(); });
        observer.observe(el);
      }
    }
    watchFallbacks();
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
  // 切换状态机（last-wins 排队 + 失败回滚）拆到 surface-switch.js，本文件只提供回调
  const switcher = createSwitcher({
    renderers,
    state: st,
    setMode,
    disposeActive,
    handle,
    measure,
    requestRender,
    note,
    noteSwitch,
    onSwitched: (activeId) => { for (const cb of switchCbs) { try { cb(activeId, stageMode()); } catch { /* 订阅者异常不影响切换 */ } } },
  });

  /** 切换到一份文档（唯一入口，语义见 surface-switch.js） */
  function activate(document) {
    return switcher.activate(document);
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
      // domSize：实时读一次 DOM，与 size 并排就能判断「DOM 没变（布局侧）」还是「DOM 变了但没同步」
      domSize: (() => {
        const el = rootEl();
        if (!el) return null;
        try {
          const r = el.getBoundingClientRect();
          return { width: Math.round(r.width), height: Math.round(r.height) };
        } catch { return null; }
      })(),
      /** 各尺寸触发源的命中计数（真机旋转排查用，见 st.trigger 注释） */
      trigger: { ...st.trigger },
      lastMeasureAt: Math.round(st.lastMeasureAt),
      lastChangeAt: Math.round(st.lastChangeAt),
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
    // 根容器可能在本函数之后才进 DOM（脚本顺序/异步挂载）：延后一帧再量一次，
    // 让 observer 补建、几何不落后。只补一次，不引入轮询。
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { try { measure(); } catch { /* 忽略 */ } });
    }
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
    /** 订阅渲染面切换（回调收到新的激活 id 与 stageMode） */
    onRendererChange: (cb) => (typeof cb === 'function' ? (switchCbs.add(cb), () => switchCbs.delete(cb)) : () => {}),
    /**
     * 当前生效的能力集合。
     * 取"激活中的渲染器"；还没装载任何内容时用**首个注册者**（默认面），
     *   因为能力是静态声明，与是否已装载模型无关；一个渲染器都没有才返回 null（面板走回落）。
     */
    capabilities() {
      const entry = renderers.get(st.activeId) || renderers.values().next().value;
      return entry && entry.capabilities ? entry.capabilities : null;
    },
    /**
     * 当前激活渲染器（供外壳把设置下发给它，不自己持有舞台引用）。
     * 还没装载任何东西时退回**首个注册者**（默认面）：设置快照要在启动阶段就落到引擎，
     *   等装载时再补会出现"面板显示 A、引擎在 B"的漂移（与上面 capabilities() 同一口径）。
     */
    activeRenderer() {
      return renderers.get(st.activeId) || renderers.values().next().value || null;
    },
    /** 按 id 取渲染器 */
    renderer: (id) => renderers.get(id) || null,
  };
}
