// live2d/stage.js —— Live2D 渲染（原生 ES 模块，无构建）
//
// 角色：作为「2D 渲染器」的 Live2D 分支实现，与 Spine 共用同一套相机与交互。
//   · 覆盖层 canvas 覆盖在 Spine 画布之上（pointer-events:none）⇒ 指针事件落到舞台区域，
//     由交互层驱动当前渲染器的相机；Live2D 侧的相机动作经本文件的 bridge 落到 PIXI。
//   · bridge 成员（hide / loadForEngine / playLabel / setExpressions /
//     resetView / setZoomRatio / pan / isActive）是 Live2D 渲染器的相机 backend 与播放控制的落地接口。
//   · 资源入口先经 VirtualFS.resolve()（命中用 Blob URL，未命中回落原 URL）——不 patch PIXI 加载器。
//
// 运行时库按需懒加载（顺序不可颠倒），失败时报出具体文件。
import { CAMERA } from '../render/camera/constants.js';
import { installDiagHud } from '../debug/diag-hud.js';
import { collectLive2DModelCmp } from '../debug/model-cmp.js';

/** 覆盖层容器 id（与参考实现区分：这是新前端的独立覆盖层） */
const OVERLAY_ID = 'live2d-overlay';
/** 覆盖层内 canvas 的 id */
const OVERLAY_CANVAS_ID = 'live2d-overlay-canvas';
/** 运行时库（顺序不可颠倒：cubismcore 必须最先，pixi-live2d-display 初始化会检查它） */
const LIBS = [
  '/live2d-lib/live2dcubismcore.min.js',
  '/live2d-lib/live2d.min.js',
  '/live2d-lib/pixi.min.js',
  '/live2d-lib/index.min.js',
];
/** 缩放钳制（与参考实现一致：0.2 ~ 6） */
// 缩放范围唯一来源：render/camera/constants.js（禁止在此写裸数字）
const ZOOM_MIN = CAMERA.MIN;
const ZOOM_MAX = CAMERA.MAX;

/**
 * 创建 Live2D 舞台。
 * @param {{
 *   vfs?: { resolve: (url: string) => string|null },
 *   getOverlayHost?: () => HTMLElement|null,
 *   log?: (message: string, level?: 'info'|'warn'|'error') => void,
 * }} options
 */
export function createLive2DStage({ vfs, getOverlayHost, log } = {}) {
  /** StageSurface 句柄（画布/尺寸/DPR 由 Surface 提供；为空时退回自建覆盖层） */
  let handleRef = null;

  const st = {
    app: null,          // PIXI.Application
    model: null,        // PIXI.live2d.Live2DModel
    libsReady: null,    // 库加载 Promise
    active: false,      // 是否处于激活态（引擎 l2dActive 依赖它）
    zoomRatio: 1,       // 缩放倍数（唯一写入方是 bridge.setZoomRatio）
    panX: 0,
    panY: 0,
    modelId: null,      // 当前模型 id（引擎用它判断复用）
    meta: null,         // 当前模型元数据（motions / expressions）
    motionMap: new Map(), // 标签 -> { group, index }
  };

  /** 统一日志出口（缺省静默） */
  function note(message, level = 'info') {
    if (typeof log === 'function') {
      try { log(message, level); } catch { /* 日志失败不影响渲染 */ }
    }
  }

  /** 资源地址解析：VirtualFS 优先，未命中回落原 URL */
  function resolveAsset(url) {
    if (!url) return null;
    try {
      const hit = vfs && typeof vfs.resolve === 'function' ? vfs.resolve(url) : null;
      if (hit) {
        note(`资源命中 VirtualFS：${url}`);
        return hit;
      }
    } catch { /* 解析失败按原 URL 走 */ }
    return url;
  }

  /**
   * 取模型入口地址：catalog 规范只认 entry.url；兼容旧形状（modelUrl）作为回退。
   * @param {object} doc 模型文档（catalog ModelEntry 或旧条目）
   * @returns {string|null}
   */
  function entryUrlOf(doc) {
    if (!doc) return null;
    if (doc.entry && doc.entry.url) return doc.entry.url;
    if (doc.modelUrl) return doc.modelUrl;
    const asset = Array.isArray(doc.assets) ? doc.assets.find((a) => a && a.role === model) : null;
    return asset && asset.url ? asset.url : null;
  }

  /** 懒加载一个脚本（失败报出具体文件） */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve(src);
      el.onerror = () => reject(new Error(`Live2D 运行时加载失败：${src}`));
      document.head.appendChild(el);
    });
  }

/**
   * 取 Surface 下发的几何（唯一尺寸来源）。拿不到返回 null。
   * 为什么统一走它：渲染面不得自己读 DOM 尺寸或推断设备像素比，否则两套渲染会算出不同结果。
   * @returns {{cssW:number, cssH:number, dpr:number, res:number}|null}
   */
  function surfaceGeometry() {
    try { return handleRef && typeof handleRef.geometry === 'function' ? handleRef.geometry() : null; } catch { return null; }
  }

  /** 取 CSS 尺寸 {width,height}（拿不到返回 null） */
  function surfaceSize() {
    const g = surfaceGeometry();
    return g ? { width: g.cssW, height: g.cssH } : null;
  }
  /** 取当前舞台宽（CSS 像素，缺省 0） */
  function width8() { const g = surfaceGeometry(); return g ? g.cssW : 0; }
  /** 取当前舞台高（CSS 像素，缺省 0） */
  function height8() { const g = surfaceGeometry(); return g ? g.cssH : 0; }

/** 按固定顺序加载全部运行时库（只加载一次） */
  function ensureLibs() {
    if (!st.libsReady) {
      st.libsReady = (async () => {
        note('首次使用 Live2D，按需加载运行时库…');
        for (const src of LIBS) {
          await loadScript(src);
          note(`运行时已加载：${src.split('/').pop()}`);
        }
        if (!(typeof PIXI !== 'undefined' && PIXI.live2d)) {
          throw new Error('PIXI.live2d 不存在：运行时库顺序或版本不匹配（live2dcubismcore 必须最先）');
        }
        note(`Live2D 运行时就绪（PIXI ${PIXI.VERSION || '?'}）`);
      })();
    }
    return st.libsReady;
  }

  /** 覆盖层容器：挂在舞台容器内，绝对定位铺满，不接收指针事件 */
  function buildOverlay() {
    if (st.overlay && st.overlay.isConnected) return st.overlay;
    const host = (typeof getOverlayHost === 'function' ? getOverlayHost() : null)
      || document.getElementById('stage') || document.body;
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = OVERLAY_ID;
      // 关键：pointer-events:none ⇒ 事件下穿到 Spine 画布，交互层与相机路径完全不变
      el.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;z-index:5;'
        + 'display:none;pointer-events:none;background:transparent;overflow:hidden';
      const cv = document.createElement('canvas');
      cv.id = OVERLAY_CANVAS_ID;
      cv.style.cssText = 'display:block;width:100%;height:100%;background:transparent';
      el.appendChild(cv);
      host.appendChild(el);
    }
    st.overlay = el;
    return el;
  }

  /** PIXI 渲染器尺寸对齐覆盖层实际尺寸（覆盖层还没有尺寸时跳过，等 syncRect 再来） */
  /**
   * 按 Surface 下发的几何校准 PIXI 渲染器与背景层尺寸。
   * 尺寸唯一来源 = StageSurface.geometry()（经 handle 传入或这里取一次），
   *   本函数不再读 DOM 尺寸、也不自行推断设备像素比。
   * @param {{cssW:number, cssH:number, dpr:number, res:number}} [geo] 可选几何；缺省时从 handle.geometry() 取
   * @returns {boolean} 是否成功校准
   */
  function fitAppToOverlay(geo) {
    const app = st.app;
    if (!app || !app.renderer) return false;
    let g = geo && geo.cssW ? geo : null;
    if (!g) {
      try { if (handleRef && typeof handleRef.geometry === 'function') g = handleRef.geometry(); } catch { g = null; }
    }
    const w = Math.max(1, Math.round((g && g.cssW) || 0));
    const h = Math.max(1, Math.round((g && g.cssH) || 0));
    if (!w || !h) return false;
    const res = app.renderer.resolution || 1;
    const curW = Math.round((app.renderer.width || 0) / res);
    const curH = Math.round((app.renderer.height || 0) / res);
    // 分辨率覆盖（由 Surface 的 geometry().res 提供）：显式同步画布 backing
    try {
      const cvF = document.getElementById(OVERLAY_CANVAS_ID);
      const forced = (() => { try { return handleRef && handleRef.geometry ? handleRef.geometry().res : null; } catch { return null; } })();
      if (cvF && forced) {
        const needW = Math.max(1, Math.round(w * forced));
        const needH = Math.max(1, Math.round(h * forced));
        if (cvF.width !== needW || cvF.height !== needH) { cvF.width = needW; cvF.height = needH; }
        if (app.renderer.resolution !== forced) app.renderer.resolution = forced;
      }
    } catch { /* 忽略 */ }
    if (curW !== w || curH !== h) app.renderer.resize(w, h);
    return true;
  }

  /** 建（或复用）PIXI Application */
  async function ensureApp() {
    if (st.app) return st.app;
    const el = buildOverlay();
    const canvas = document.getElementById(OVERLAY_CANVAS_ID);
    const opts = {
      view: canvas,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: (handleRef && handleRef.geometry) ? (handleRef.geometry().res || 1) : 1,
    };
    const isModern = typeof PIXI.Application.prototype.init === 'function';
    const app = isModern ? new PIXI.Application() : new PIXI.Application(opts);
    if (isModern) await app.init(opts);
    st.app = app;
    // 强制透明清屏：实测 PIXI 6.5.3 下 opts.backgroundAlpha 未落到 renderer，
    //   canvas 每帧被不透明黑填满（readPixels 得到 [0,0,0,255]），
    //   于是 Live2D 画布整块盖住 #stage 的 CSS 背景，只剩模型区域可见 = 看起来"内容被框在矩形里"。
    try {
      app.renderer.backgroundAlpha = 0;
      app.renderer.backgroundColor = 0x000000;
      app.renderer.clearBeforeRender = true;
    } catch { /* 忽略 */ }
    fitAppToOverlay();
    return app;
  }

  /**
   * 读模型定义（model3.json）拿动作/表情表。
   * 为什么不用接口元数据：/api/live2d/models 的 motions、expressions 字段在现有数据里是空的，
   *   只有模型定义文件才是权威源；这里经 VirtualFS 解析后自己取一次（PIXI 内部另有一份，互不影响）。
   * @param {object} model
   * @returns {Promise<{motions: object, expressions: Array<{name:string}>}>}
   */
  async function fetchDefinition(model) {
    const raw = entryUrlOf(model);
    const url = raw ? resolveAsset(raw) : null;
    if (!url) return { motions: {}, expressions: [] };
    try {
      const res = await fetch(url);
      const json = await res.json();
      const ref = json && json.FileReferences ? json.FileReferences : {};
      const motions = ref.Motions || {};
      const expressions = (ref.Expressions || []).map((e, i) => ({ name: (e && e.Name) || `exp${i + 1}` }));
      return { motions, expressions };
    } catch (err) {
      note(`模型定义读取失败（动作列表将为空）：${err && err.message}`, 'warn');
      return { motions: {}, expressions: [] };
    }
  }

  /** 动作标签：`group / 名称`，idle 组排最前（切过去即待机） */
  /**
   * 动作名归一化：Cubism4 用 { Name }，Cubism3 用 { File } 甚至纯字符串。
   * @param {object|string} mo 动作定义项
   * @returns {string}
   */
  function motionNameOf(mo) {
    if (typeof mo === 'string') return mo;
    if (!mo) return '';
    return String(mo.Name || mo.File || '');
  }

  /** 动作标签：`group / 名称`（去 .motion3 与目录前缀），idle 组排最前 */
  function motionLabel(group, name) {
    // 后缀可能是 .motion3 / .motion3.json / .json（Cubism3 常见 .motion3.json）
    const base = String(name || '').split('/').pop().replace(/\.motion3(\.json)?$/i, '').replace(/\.json$/i, '');
    return `${group} / ${base}`;
  }

  /** 由定义文件重建标签表 */
  function buildMotionMap(meta) {
    st.motionMap = new Map();
    const motions = (meta && meta.motions) || {};
    const groups = Object.keys(motions);
    groups.sort((a, b) => (a === 'idle' ? -1 : b === 'idle' ? 1 : 0));
    for (const group of groups) {
      (motions[group] || []).forEach((mo, index) => {
        let label = motionLabel(group, motionNameOf(mo));
        if (st.motionMap.has(label)) label = `${label} #${index + 1}`;
        st.motionMap.set(label, { group: String(group), index });
      });
    }
    return [...st.motionMap.keys()];
  }

  /** 取模型当前包围盒（先归零缩放/位移，否则包围盒会随缩放算错） */
  function computeFit() {
    const model = st.model;
    if (!model) return null;
    model.scale.set(1);
    model.position.set(0, 0);
    const b = model.getBounds();
    return { x: (b && b.x) || 0, y: (b && b.y) || 0, w: (b && b.width) || model.width || 1, h: (b && b.height) || model.height || 1 };
  }

  /** 按包围盒适配并居中，再叠加缩放与平移（与引擎相机委托共享同一份状态） */
  function applyZoom() {
    const model = st.model;
    if (!model || !st.app) return;
    const res = st.app.renderer.resolution || 1;
    // 尺寸优先取 Surface 句柄（渲染器不自己算画布尺寸）
    const size = surfaceSize();
    const W = size ? size.width : st.app.renderer.width / res;
    const H = size ? size.height : st.app.renderer.height / res;
    const fit = computeFit();
    if (!fit) return;
    const s = Math.min(W / fit.w, H / fit.h) * 0.98 * st.zoomRatio;
    model.scale.set(s);
    model.x = W / 2 - (fit.x + fit.w / 2) * s + st.panX;
    model.y = H / 2 - (fit.y + fit.h / 2) * s + st.panY;
  }

  /** 覆盖层与 Spine 画布几何对齐（rAF 防抖；不接收指针事件，只影响摆放） */
  let syncPending = false;
  function syncRect() {
    // 几何由 StageSurface 负责：有句柄时直接同步尺寸，不再读 DOM
    if (handleRef) { fitAppToOverlay(); applyZoom(); return; }
  }

  /**
   * 显示覆盖层（不改变 active；active 由 loadForEngine 决定）。
   * 要点：**转可见的同一帧内**就按 Surface 句柄的尺寸定尺并校准 PIXI，
   *   不读 DOM（隐藏态 clientWidth=0 是 BUG-3 的根源）。
   */
  function showOverlay() {
    const el = buildOverlay();
    el.style.display = 'block';
    const size = surfaceSize();
    if (size) {
      el.style.left = '0px';
      el.style.top = '0px';
      el.style.width = `${size.width}px`;
      el.style.height = `${size.height}px`;
    }
    // 已有 PIXI 实例（二次显示）：立即按句柄尺寸重校准
    if (st.app) fitAppToOverlay();
    syncRect();
  }

  
  
  /** 隐藏覆盖层并释放模型（切回 Spine 时引擎会主动调它） */
  function hide() {
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.style.display = 'none';
    if (st.model) {
      try { st.app && st.app.stage.removeChild(st.model); } catch { /* 忽略 */ }
      try { st.model.destroy({ children: true }); } catch { /* 忽略 */ }
      st.model = null;
    }
    try { if (st.app && typeof st.app.stop === 'function') st.app.stop(); } catch { /* 忽略 */ }
    st.active = false;
    st.modelId = null;
    note('Live2D 已卸载（覆盖层隐藏、模型销毁、渲染循环停止）');
    return true;
  }

  /**
   * 加载并显示一个 Live2D 模型。
   * @param {object} model 条目（含 id / name / modelUrl）
   */
  async function loadModel(model) {
    await ensureLibs();
    // 顺序关键：必须先让覆盖层可见，再建 PIXI。
    //   否则 PIXI 在 display:none 状态下读到 0 尺寸，会停在默认 800×600，
    //   首次可见时若没有重新校准，画面就只剩一块"内容矩形"（BUG-3 的现象）。
    showOverlay();
    const app = await ensureApp();
    // 先清掉上一个模型（同一覆盖层只留一个）
    if (st.model) {
      try { app.stage.removeChild(st.model); } catch { /* 忽略 */ }
      try { st.model.destroy({ children: true }); } catch { /* 忽略 */ }
      st.model = null;
    }
    const url = resolveAsset(entryUrlOf(model));
    if (!url) throw new Error(`Live2D 模型缺少入口地址（entry.url）：${model && model.name}`);
    const t0 = performance.now();
    const instance = await PIXI.live2d.Live2DModel.from(url, { autoInteract: false });
    app.stage.addChild(instance);
    st.model = instance;
    st.modelId = model.id;
    st.zoomRatio = 1;
    st.panX = 0;
    st.panY = 0;
    const def = await fetchDefinition(model);
    st.meta = { ...model, motions: def.motions, expressions: def.expressions };
    const labels = buildMotionMap(st.meta);
    if (typeof app.start === 'function') app.start();
    fitAppToOverlay();
    applyZoom();
    st.active = true;
    // 断言③：清屏必须透明。若模型以外的区域 alpha>0，说明不透明底色又把 CSS 背景盖住了，
    //   这类回归以前只能靠人眼发现（表现为"内容被框在矩形里"），现在让它自己报出来。
    try {
      const probe = await readCanvasPixels([[8, 8], [width8(), 8], [8, height8()], [Math.floor((size ? size.width : 1920) / 2), 8]]);
      const opaque = (probe || []).filter((p) => p.rgba && p.rgba[3] > 0);
      if (probe && probe.length && opaque.length === probe.length) {
        note(`画布清屏不透明（${opaque.length}/${probe.length} 点 alpha>0），CSS 背景会被遮住`, "warn");
      } else {
        note(`画布清屏自检通过（${probe ? probe.length - opaque.length : 0}/${probe ? probe.length : 0} 点透明）`);
      }
    } catch { /* 自检失败不影响渲染 */ }
    note(`Live2D 已渲染 ${model.name}（Cubism ${model.cubism || '?'}，动作 ${labels.length}，表情 ${def.expressions.length}，`
      + `耗时 ${Math.round(performance.now() - t0)}ms）`);
    // 首帧后采集一次 diff 基线（只采一次，避免污染时序；模型已换则放弃）
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (st.model === instance) {
        try { collectCmp('default'); } catch { /* 采集失败不影响渲染 */ }
      }
    }));
    return { labels, expressions: def.expressions.map((e) => e.name), instance };
  }

  /** 动作标签全集 */
  function motionLabels() { return [...st.motionMap.keys()]; }

  /** 相机 backend 与播放控制的桥：成员语义见文件头 */
  const bridge = {
    isActive: () => st.active,
    hide,
    currentModelId: () => st.modelId,
    labels: () => motionLabels(),
    expressions: () => ((st.meta && st.meta.expressions) || []).map((e) => e.name),
    /**
     * 装载入口：复用或加载，返回与 Spine 同形的摘要。
     * @param {object} model
     * @returns {Promise<{animations: string[], skins: string[], durations: object, version: string}>}
     */
    async loadForEngine(model) {
      const reusable = st.active && st.modelId === model.id && st.model;
      if (!reusable) {
        note(`Live2D 装载：${model.name}`);
        await loadModel(model);
      } else {
        note(`Live2D 复用已加载模型：${model.name}`);
      }
      return {
        animations: motionLabels(),
        skins: ((st.meta && st.meta.expressions) || []).map((e) => e.name),
        durations: {},
        version: `Live2D Cubism ${(model && model.cubism) || 3}`,
      };
    },
    /** 动作切换：标签 → (group, index) */
    playLabel(label) {
      const hit = st.motionMap.get(label);
      if (!hit || !st.model) {
        note(`Live2D 未知动作标签：${label}`, 'warn');
        return false;
      }
      try {
        st.model.motion(hit.group, hit.index);
        note(`Live2D 播动作：${label}`);
        return true;
      } catch (err) {
        note(`Live2D 播动作失败：${err && err.message}`, 'warn');
        return false;
      }
    },
    /** 表情切换：表情名 → expression 下标 */
    setExpressions(names) {
      if (!st.model) return false;
      const list = (names || []).filter(Boolean);
      try {
        if (!list.length) { st.model.expression(); return true; }
        const exprs = (st.meta && st.meta.expressions) || [];
        const idx = exprs.findIndex((e) => e.name === list[0]);
        if (idx >= 0) st.model.expression(idx);
        note(`Live2D 切表情：${list[0]}${idx >= 0 ? '' : '（未找到，保持原表情）'}`, idx >= 0 ? 'info' : 'warn');
        return idx >= 0;
      } catch (err) {
        note(`Live2D 切表情失败：${err && err.message}`, 'warn');
        return false;
      }
    },
    /** 相机复位 */
    resetView() {
      st.zoomRatio = 1;
      st.panX = 0;
      st.panY = 0;
      applyZoom();
      note('Live2D 视图复位');
    },
    /** 相机缩放：值越大模型越大 */
    setZoomRatio(ratio) {
      const v = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(ratio) || 1));
      st.zoomRatio = v;
      applyZoom();
      return v;
    },
    /** 相机平移：屏幕像素增量 */
    pan(dx, dy) {
      st.panX += Number(dx) || 0;
      st.panY += Number(dy) || 0;
      applyZoom();
    },
    /** 只读诊断快照 */
    readState() {
      let motion = null;
      try {
        const mm = st.model && st.model.internalModel && st.model.internalModel.motionManager;
        if (mm) {
          const holder = mm.state && (mm.state.currentGroup !== undefined || mm.state.currentIndex !== undefined) ? mm.state : mm;
          motion = { group: holder.currentGroup ?? null, index: holder.currentIndex ?? null };
        }
      } catch { /* 忽略 */ }
      return {
        active: st.active,
        modelId: st.modelId,
        zoom: st.zoomRatio,
        pan: { x: st.panX, y: st.panY },
        motion,
      };
    },
  };

  async function readCanvasPixels(points = []) {
    const app = st.app;
    if (!app || !app.renderer) return null;
    const gl = app.renderer.gl;
    if (!gl) return null;
    const res = app.renderer.resolution || 1;
    const h = app.renderer.height;
    const buf = new Uint8Array(4);
    const out = [];
    await new Promise((r) => requestAnimationFrame(() => r()));
    try { app.renderer.render(app.stage); } catch { /* 忽略 */ }
    for (const p of points) {
      const px = Math.round(p[0] * res);
      const py = Math.round(h - p[1] * res);
      try {
        gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        out.push({ x: p[0], y: p[1], rgba: [buf[0], buf[1], buf[2], buf[3]] });
      } catch (e) { out.push({ x: p[0], y: p[1], err: String(e && e.message).slice(0, 40) }); }
    }
    return out;
  }

  /** 供渲染器调用的挂载入口（document.kind === 'live2d' 时走这里） */
  async function mount(doc, handle) {
    handleRef = handle || null;
    const model = doc && (doc.model || doc);
    const result = await bridge.loadForEngine(model);
    return result;
  }

  /** 卸载（保留 PIXI app，便于快速再切回） */
  function unmount() {
    return hide();
  }

  /** 彻底释放（销毁 PIXI app 与覆盖层） */
  function dispose() {
    try { if (diagHandle && typeof diagHandle.stop === 'function') diagHandle.stop(); } catch { /* 忽略 */ }
    diagHandle = null;
    hide();
    try { if (st.app) st.app.destroy(true, { children: true }); } catch { /* 忽略 */ }
    st.app = null;
    const el = document.getElementById(OVERLAY_ID);
    if (el && el.parentElement) el.parentElement.removeChild(el);
    st.overlay = null;
    st.libsReady = null;
    note('Live2D 已彻底释放（app 销毁、覆盖层移除）');
  }

  /**
   * 采集一条 MODELCMP 记录（诊断专用：只读，不重置视图、不改渲染）。
   * 记录怎么构建在 debug/model-cmp.js（与渲染实现解耦，便于单独演进）。
   * @param {string} tag 状态标签（default / zoom0.6_pan200 / zoom0.3 / zoom1.5）
   */
  function collectCmp(tag) {
    const rootEl = document.getElementById('stage');
    return collectLive2DModelCmp({
      app: st.app,
      model: st.model,
      internal: st.model && st.model.internalModel ? st.model.internalModel : null,
      size: surfaceSize(),
      dpr: handleRef ? handleRef.dpr : null,
      meta: st.meta,
      modelId: st.modelId,
      zoomRatio: st.zoomRatio,
      stageMode: rootEl ? rootEl.getAttribute('data-stage-mode') : null,
      tag: String(tag || 'default'),
    });
  }

  // 诊断 HUD 延迟到首次模型加载成功后安装（见 loadModel 末尾），此处只声明句柄
  let diagHandle = null;

  // 诊断 HUD：仅在 ?diag=1 时创建；所有取值都延迟到调用时（此处 app 可能为 null）
  diagHandle = installDiagHud({
    getRendererInfo: () => {
      try {
        const w = typeof window !== 'undefined' ? window.__WEB__ : null;
        return w && w.live2d && typeof w.live2d.rendererInfo === 'function' ? w.live2d.rendererInfo() : null;
      } catch { return null; }
    },
    readCanvasPixels: (...args) => readCanvasPixels(...args),
    overlayCanvasId: OVERLAY_CANVAS_ID,
    log: (m) => note(m),
  });
  return {
    id: 'live2d',
    bridge,
    mount,
    unmount,
    dispose,
    show: (m) => bridge.loadForEngine(m),
    hide,
    isActive: () => st.active,
    debug: () => bridge.readState(),
    /** 诊断：按当前状态采一条 MODELCMP（不改渲染） */
    collectCmp,
    syncRect,
    readCanvasPixels,
    /** 只读：取 PIXI app 引用（诊断实验用，不改变渲染逻辑） */
    getApp() { return st.app; },
/**
     * 只读：渲染器清屏状态快照（定位"缩放后清屏变不透明"）
     * @returns {object|null}
     */
    rendererInfo() {
      const app = st.app;
      if (!app || !app.renderer) return null;
      const r = app.renderer;
      const gl = r.gl || null;
      const out = {
        backgroundAlpha: r.backgroundAlpha,
        backgroundColor: r.backgroundColor,
        clearBeforeRender: r.clearBeforeRender,
        resolution: r.resolution,
        width: r.width,
        height: r.height,
        rendererType: r.type,
        dirty: !!r.dirty,
        wrapped: !!(gl && gl.__transparentClearInstalled),
        clearCalls: gl ? gl.__transparentClearCalls : null,
        clearBufferCalls: gl && gl.__clearBufferCalls ? { ...gl.__clearBufferCalls } : null,
        wrappedChained: gl ? !!gl.__transparentClearChained : null,
      };
      if (gl) {
        try { out.contextLost = gl.isContextLost(); } catch { out.contextLost = null; }
        try { out.scissorTest = gl.isEnabled(gl.SCISSOR_TEST); } catch { out.scissorTest = null; }
        try { const b = gl.getParameter(gl.SCISSOR_BOX); out.scissorBox = b ? Array.from(b) : null; } catch { out.scissorBox = null; }
        try { const b = gl.getParameter(gl.COLOR_CLEAR_VALUE); out.clearColor = b ? Array.from(b) : null; } catch { out.clearColor = null; }
        // GL 状态里最可疑的一项：alpha 写入被关掉时，无论清什么都保持旧 alpha ⇒ 会出现'这块透明那块不透明'的诡异分布
        try { const m = gl.getParameter(gl.COLOR_WRITEMASK); out.colorWriteMask = m ? Array.from(m) : null; } catch { out.colorWriteMask = null; }
        try { const a = gl.getContextAttributes ? gl.getContextAttributes() : null; out.contextAlpha = a ? a.alpha : null; out.antialias = a ? a.antialias : null; } catch { /* 忽略 */ }
        try { out.samples = gl.getParameter(gl.SAMPLES); } catch { out.samples = null; }
      }
      return out;
    },
    /**
     * 只读：模型运行时几何（诊断用，**不触发任何重排**）。
     * 为什么需要它：判断 fit 的基准该用 `getBounds()` 还是 Cubism 的画布尺寸，
     *   必须有 displayObject 尺寸、包围盒、coreModel 画布尺寸三组数值对照。
     * @returns {object|null}
     */
    inspectGeometry() {
      const model = st.model;
      if (!model) return null;
      let b = null;
      try { const bb = model.getBounds(); b = bb ? { x: +bb.x.toFixed(2), y: +bb.y.toFixed(2), w: +bb.width.toFixed(2), h: +bb.height.toFixed(2) } : null; } catch { b = null; }
      const internal = model.internalModel || null;
      const core = internal && internal.coreModel;
      const coreW = core && typeof core.getCanvasWidth === "function" ? core.getCanvasWidth() : null;
      const coreH = core && typeof core.getCanvasHeight === "function" ? core.getCanvasHeight() : null;
      const size = surfaceSize();
      const vpW = size ? size.width : null;
      const vpH = size ? size.height : null;
      // 当前 fit 用的值（getBounds 口径），仅做算术，不重置模型
      // 0.98 = 现状值（对照用，待改成 1 - FIT_MARGIN）
      const curFit = b && vpW && vpH ? Math.min(vpW / b.w, vpH / b.h) * 0.98 : null;
      // 期望 fit（Cubism 画布口径，边距取常量）
      const coreFit = coreW && coreH && vpW && vpH ? Math.min(vpW / coreW, vpH / coreH) * (1 - CAMERA.FIT_MARGIN) : null;
      return {
        display: { w: model.width, h: model.height, scale: model.scale ? +model.scale.x.toFixed(4) : null, x: model.x, y: model.y },
        bounds: b,
        coreCanvas: { w: coreW, h: coreH },
        internalSize: internal ? { w: internal.width, h: internal.height, originalW: internal.originalWidth, originalH: internal.originalHeight } : null,
        viewport: { w: vpW, h: vpH },
        fitByBounds: curFit,
        fitByCore: coreFit,
        ratio: curFit && coreFit ? +(curFit / coreFit).toFixed(3) : null,
        // ---- 只读：Cubism 的"画布"到底是哪个量（模型自带小画布假设的取证）----
        // ---- 只读探测：clipping mask 与网格范围（判断"内容被框在矩形里"的成因）----
        clipProbe: (() => {
          try {
            const r = internal && internal.renderer;
            if (!r) return { err: "no renderer" };
            const cm = r._clippingManager || r.clippingManager || null;
            const pickArr = (obj, keys) => {
              for (const k of keys) {
                try { const v = obj && obj[k]; if (v && typeof v.length === "number") return { key: k, len: v.length }; } catch { /* 忽略 */ }
              }
              return null;
            };
            return {
              hasClippingManager: !!cm,
              maskList: cm ? pickArr(cm, ["_clippingContextListForMask", "clippingContextListForMask", "_clippingContextList", "clippingContextList"]) : null,
              drawList: cm ? pickArr(cm, ["_clippingContextListForDraw", "clippingContextListForDraw", "_clippingContextListForDraws"]) : null,
              maskBufferSize: cm && cm._clippingMaskBufferSize != null ? cm._clippingMaskBufferSize : null,
              cmKeys: cm ? Object.keys(cm).filter((k) => /clip|mask/i.test(k)).slice(0, 12) : [],
              rendererClipKeys: Object.keys(r).filter((k) => /clip|mask/i.test(k)).slice(0, 12),
              // 网格/画布范围（判定"绘制网格是否只覆盖画布某一块"）
              meshCount: (() => { try { const dr = r._clippingManager; return null; } catch { return null; } })(),
            };
          } catch (e) { return { err: String(e && e.message).slice(0, 80) }; }
        })(),
        // ---- 只读探测：Cubism drawable / part 的可用性（为 P2 的主体包围盒取证）----
        drawableProbe: (() => {
          try {
            const core = internal && internal.coreModel;
            const raw = core && core._model ? core._model : core;
            if (!raw) return { err: "no coreModel" };
            const has = (k) => typeof raw[k] === "function";
            const count = has("getDrawableCount") ? raw.getDrawableCount() : null;
            const partCount = has("getPartCount") ? raw.getPartCount() : null;
            const partIdOf = (i) => {
              try {
                if (!has("getPartId")) return null;
                const id = raw.getPartId(i);
                if (!id) return null;
                if (typeof id === "string") return id;
                if (typeof id.getString === "function") return id.getString();
                if (id.s !== undefined) return String(id.s);
                return String(id);
              } catch { return null; }
            };
            const items = [];
            const max = Math.min(count || 0, 8);
            for (let i = 0; i < max; i += 1) {
              const item = { i, parentPart: null, partId: null, vertexCount: null, bbox: null };
              try { if (has("getDrawableParentPartIndex")) item.parentPart = raw.getDrawableParentPartIndex(i); } catch { /* 忽略 */ }
              if (item.parentPart != null && item.parentPart >= 0) item.partId = partIdOf(item.parentPart);
              try { if (has("getDrawableVertexCount")) item.vertexCount = raw.getDrawableVertexCount(i); } catch { /* 忽略 */ }
              try {
                if (has("getDrawableVertexPositions") && item.vertexCount > 0) {
                  const v = raw.getDrawableVertexPositions(i);
                  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                  for (let k = 0; k + 1 < v.length; k += 2) {
                    const x = v[k], y = v[k + 1];
                    if (x < minX) minX = x; if (x > maxX) maxX = x;
                    if (y < minY) minY = y; if (y > maxY) maxY = y;
                  }
                  item.bbox = { x: +minX.toFixed(3), y: +minY.toFixed(3), w: +(maxX - minX).toFixed(3), h: +(maxY - minY).toFixed(3) };
                }
              } catch (e) { item.bboxErr = String(e && e.message).slice(0, 40); }
              items.push(item);
            }
            return {
              coreType: raw.constructor ? raw.constructor.name : typeof raw,
              drawableCount: count,
              partCount,
              partIds: (() => { const arr = []; for (let i = 0; i < Math.min(partCount || 0, 12); i += 1) arr.push(partIdOf(i)); return arr; })(),
              api: {
                getDrawableCount: has("getDrawableCount"),
                getDrawableVertexPositions: has("getDrawableVertexPositions"),
                getDrawableVertexCount: has("getDrawableVertexCount"),
                getDrawableParentPartIndex: has("getDrawableParentPartIndex"),
                getPartCount: has("getPartCount"),
                getPartId: has("getPartId"),
              },
              sample: items,
              // ---- A：深钻所有可能的 API 宿主（只读枚举方法名）----
              apiPaths: (() => {
                const out = [];
                const probeObj = (obj, label, depth) => {
                  if (!obj || typeof obj !== "object" || depth > 3) return;
                  const names = [];
                  try { for (const k in obj) { try { if (typeof obj[k] === "function") names.push(k); } catch { /* 忽略 */ } } } catch { /* 忽略 */ }
                  try {
                    let p = Object.getPrototypeOf(obj);
                    let guard = 0;
                    while (p && p !== Object.prototype && guard < 4) {
                      try { Object.getOwnPropertyNames(p).forEach((n) => { try { if (typeof obj[n] === "function") names.push(n); } catch { /* 忽略 */ } }); } catch { /* 忽略 */ }
                      p = Object.getPrototypeOf(p); guard += 1;
                    }
                  } catch { /* 忽略 */ }
                  const hit = [...new Set(names)].filter((n) => /draw|part|texture|vertex|canvas|bounds|geometry/i.test(n));
                  out.push({ label, ctor: obj.constructor ? obj.constructor.name : typeof obj, methodCount: names.length, matched: hit.slice(0, 18) });
                };
                probeObj(core, "coreModel", 0);
                probeObj(core && core._model, "coreModel._model", 1);
                probeObj(core && core._model && core._model._model, "coreModel._model._model", 2);
                probeObj(core && core._model && core._model.drawables, "coreModel._model.drawables", 2);
                probeObj(internal && internal.renderer, "internalModel.renderer", 1);
                return out;
              })(),
            };
          } catch (e) { return { err: String(e && e.message).slice(0, 80) }; }
        })(),
      };
    },
    /**
     * 只读：在 rAF 内直接读 PIXI canvas 像素（WebGL readPixels），
     * 用来判定「canvas 里某处是透明还是被画成了不透明黑」——不依赖页面截图。
     * @param {Array<[number, number]>} points CSS 像素坐标点
     * @returns {Promise<Array<{x:number,y:number,rgba:number[]}>>}
     */

/**
     * 只读：PIXI 渲染器尺寸与目标 CSS 尺寸（断言用，不改状态）。
     * @returns {{w:number,h:number,res:number,cssW:number,cssH:number}|null}
     */
    rendererSize() {
      if (!st.app || !st.app.renderer) return null;
      const r = st.app.renderer;
      const size = surfaceSize() || { width: 0, height: 0 };
      return { w: r.width, h: r.height, res: r.resolution || 1, cssW: size.width, cssH: size.height };
    },
    /**
     * 尺寸同步：Surface 量好尺寸后调用（渲染器不自己读 DOM）。
     * @param {object} handle StageSurface 句柄
     */
    syncSize(handle) {
      handleRef = handle || handleRef;
      try {
        const gSync = surfaceGeometry();
        if (st.app && st.app.renderer && gSync) {
          st.app.renderer.resize(gSync.cssW, gSync.cssH);
        }
        applyZoom();
      } catch { /* 忽略 */ }
    },
    /** 写一条日志（供渲染器记录切换断言） */
    note: (message) => note(message),
  };
}
