// render/live2d.js —— Live2D 渲染器（注册到 StageSurface 的渲染面实现）
//
// 契约（StageSurface.renderer）：
//   { id, capabilities, mount(document, handle) → info, dispose(), isActive(), camera }
// 边界：画布与尺寸由 StageSurface 提供（handle），本文件不读 DOM 尺寸、不建画布。

import { createCamera } from './camera/index.js';
import { createFrameGate } from '../engine/frame-gate.js';
import { buildDocument } from '../infra/document.js';
import { DEFAULT_FILTER, FILTER_PRESETS } from '../engine/filters.js';

/**
 * 创建 Live2D 渲染器。
 * @param {{live2d: object}} options live2d 为覆盖层实现（提供 mount/dispose/isActive/bridge）
 */
export function createLive2DRenderer({ live2d } = {}) {
  if (!live2d) throw new Error('createLive2DRenderer: 需要 live2d 实现');
  /** 当前生效的纹理过滤与限帧（回显用） */
  let filterMode = 'linear';
  /** 暂停标记：暂停期间相机/设置变化后必须自己补一帧（ticker 停着不会自动画） */
  let pausedRef = false;
  /** 立刻画一帧（暂停时的按需渲染） */
  function repaintFrame() {
    try {
      const app = live2d.getApp && live2d.getApp();
      if (app && app.renderer && app.stage) { app.renderer.render(app.stage); return true; }
    } catch { /* 忽略 */ }
    return false;
  }
  let fpsLimit = 60;
  /**
   * 收集舞台上全部 PIXI 纹理（实测挂点是 model.textures 数组，模型对象没有 _texture）。
   * @param {object} app PIXI.Application
   * @returns {Array<object>}
   */
  function texturesOf(app) {
    const out = [];
    const walk = (node, depth) => {
      if (!node || depth > 4) return;
      if (Array.isArray(node.textures)) for (const t of node.textures) if (t) out.push(t);
      if (node.texture) out.push(node.texture);
      for (const child of node.children || []) walk(child, depth + 1);
    };
    try { walk(app.stage, 0); } catch { /* 忽略 */ }
    return out;
  }
  // 相机统一入口：档位/范围/复位语义与 Spine 完全一致，差异只在 backend
  const camera = createCamera({
    kind: 'live2d',
    backend: {
      /** 当前缩放（bridge 是唯一真相） */
      getScale: () => { try { return live2d.bridge.readState().zoom; } catch { return null; } },
      /** 写入缩放（bridge 内部仍会按 CAMERA 常量夹取） */
      setScale: (v) => { try { live2d.bridge.setZoomRatio(v); } catch { /* 忽略 */ } if (pausedRef) repaintFrame(); },
      /** 平移：屏幕像素增量，1:1 交给覆盖层 */
      pan: (dx, dy) => { try { live2d.bridge.pan(dx, dy); } catch { /* 忽略 */ } if (pausedRef) repaintFrame(); },
      /** 复位：bridge 归 1 并重排 */
      resetView: () => { try { live2d.bridge.resetView(); } catch { /* 忽略 */ } },
    },
  });
  let handleRef = null;
  /** 当前滤镜预设 id（original = 不挂滤镜） */
  let presetId = DEFAULT_FILTER;

  // ---------------------------------------------------------------- 帧率门控
  //
  // 为什么不用 PIXI 的 ticker.maxFPS：它按 deltaTime 判断且带容差，90Hz 屏上相位抖动时会放行，
  //   实测 60/30 档经常跑到 90。这里把 ticker 的限帧关掉（maxFPS=0），并把 PIXI 自己的渲染回调
  //   从 ticker 上摘下来，改由本门控决定何时调 app.render()。
  //   ticker 本身继续跑 ⇒ 模型动作/物理仍按真实时间推进，只有**出画**被门控。
  const frameGate = createFrameGate(() => fpsLimit);
  // 实测渲染帧率：只有**真的调了 app.render()** 才计数。
  //   为什么不能拿 app.ticker.FPS 当读数：ticker 是"rAF 触发频率"。把渲染从 ticker 上摘下来门控后，
  //   tick 仍按 rAF 跑（≈屏幕刷新率），用它显示会永远等于刷新率（90Hz 屏上设 60 也可能显示 89）——
  //   那是**读数失真**，与"限帧有没有生效"是两件事，必须分开修、分开说。
  let fpWindowStart = 0;
  let fpWindowFrames = 0;
  let measuredFps = 0;
  let gateApp = null;      // 已装门控的 app（换 app 后重装）
  let gateHandler = null;  // ticker 上的门控回调（换 app 时先摘掉）

  /**
   * 把帧率门控装到给定 PIXI app 上（幂等：同一个 app 不重复装）。
   * @param {object} app PIXI.Application
   * @returns {boolean} 是否装好
   */
  function installFrameGate(app) {
    if (!app || !app.ticker || typeof app.ticker.add !== 'function') return false;
    if (gateApp === app && gateHandler) return true;
    if (gateApp && gateHandler && gateApp.ticker && typeof gateApp.ticker.remove === 'function') {
      try { gateApp.ticker.remove(gateHandler); } catch { /* 旧 app 已销毁 */ }
    }
    try { app.ticker.maxFPS = 0; } catch { /* 老版本无此属性 */ }
    // 摘掉 PIXI 自带的渲染回调（Application.start() 里以 app.render + app 为键挂上去的）
    try {
      if (typeof app.ticker.remove === 'function' && typeof app.render === 'function') app.ticker.remove(app.render, app);
    } catch { /* 忽略 */ }
    frameGate.reset();
    gateHandler = () => {
      // deltaMS 由 PIXI ticker 维护：本次 tick 距上次的真实毫秒间隔
      if (!frameGate.shouldRender(app.ticker.deltaMS)) return;
      try { app.render(); } catch { /* 单帧渲染失败不打断 ticker */ }
      // 实测帧率：每 ≥500ms 结算一次，与实际出画严格同源
      const nowMs = performance.now();
      if (!fpWindowStart) fpWindowStart = nowMs;
      fpWindowFrames += 1;
      const span = nowMs - fpWindowStart;
      if (span >= 500) {
        measuredFps = (fpWindowFrames * 1000) / span;
        fpWindowFrames = 0;
        fpWindowStart = nowMs;
      }
    };
    app.ticker.add(gateHandler);
    gateApp = app;
    return true;
  }
  /** 已挂上的 PIXI.Filter（original 时为 null） */
  let activeFilter = null;

  /**
   * 用引擎那 12 段预设表达式拼一份 PIXI 片元着色器。
   * 为什么能复用：预设表里的 body 都是"对直通色 c 的表达式"，与渲染器无关；
   *   这里只换外壳（PIXI 的 vTextureCoord/uSampler + 预乘还原），效果与 Spine 侧同一套公式。
   */
  function pixiFragmentOf(id) {
    const preset = FILTER_PRESETS.find((x) => x.id === id) || FILTER_PRESETS[0];
    return [
      'precision mediump float;',
      'varying vec2 vTextureCoord;',
      'uniform sampler2D uSampler;',
      'const vec3 LUMA = vec3(0.299, 0.587, 0.114);',
      'vec3 toGray(vec3 c) { return vec3(dot(c, LUMA)); }',
      'vec3 withSat(vec3 c, float s) { float l = dot(c, LUMA); return mix(vec3(l), c, s); }',
      'void main() {',
      '  vec4 texColor = texture2D(uSampler, vTextureCoord);', // PIXI 纹理是预乘的
      '  float a = texColor.a;',
      '  vec3 c = texColor.rgb / max(a, 0.00001);',            // 还原成直通再套预设
      `  vec3 f = ${preset.body};`,
      '  gl_FragColor = vec4(f * a, a);',
      '}',
    ].join('\n');
  }

  /** 把当前 presetId 落到 PIXI stage 上（original ⇒ 摘掉滤镜） */
  function applyPreset() {
    const app = (() => { try { return live2d.getApp ? live2d.getApp() : null; } catch { return null; } })();
    if (!app || !app.stage) return false;
    const PIXI = typeof window !== 'undefined' ? window.PIXI : null;
    try {
      if (presetId === DEFAULT_FILTER) {
        app.stage.filters = null;
        activeFilter = null;
        return true;
      }
      if (!PIXI || typeof PIXI.Filter !== 'function') return false;
      activeFilter = new PIXI.Filter(null, pixiFragmentOf(presetId));
      // filterArea 固定成整屏：否则 PIXI 会按 stage 包围盒裁剪，滤镜边缘会缺一块
      app.stage.filterArea = app.screen;
      app.stage.filters = [activeFilter];
      return true;
    } catch {
      // 着色器编译失败等：保持原渲染，不抛
      activeFilter = null;
      try { app.stage.filters = null; } catch { /* 忽略 */ }
      return false;
    }
  }
  // DPR 档位：'auto' = 跟随 Surface 下发的 res；'1'/'1.5'/'2' = 显式指定档位
  let dprWanted = 'auto';

  /** 几何唯一来源：Surface 句柄（渲染器不自行测量 DOM） */
  function geometryOf() {
    try { return handleRef && handleRef.geometry ? handleRef.geometry() : null; } catch { return null; }
  }

  /**
   * 当前生效 DPR。
   * auto 用 Surface 下发的 res（像素比口径由引擎侧决定，渲染器不自己读 devicePixelRatio）；
   * 显式档直接采用 —— 这正是"用户在面板选了 2 就必须是 2"的落点。
   * @param {number} [fallback] 几何取不到时的兜底值
   */
  function effectiveRes(fallback) {
    const g = geometryOf();
    const base = Math.max(1, (g && (g.res || g.dpr)) || fallback || 1);
    if (dprWanted === 'auto') return base;
    const n = parseFloat(dprWanted);
    return Number.isFinite(n) && n > 0 ? n : base;
  }

  /**
   * 按当前 DPR 重排覆盖层画布与 PIXI 后缓冲。
   * 两处尺寸必须同源（画布宽高 = css × res，renderer.resolution = res），
   *   否则 PIXI 会把画面按错误比例拉伸，表现为"角色变大/模糊"。
   * @returns {boolean} 是否成功落到 PIXI
   */
  function applyResolution() {
    const g = geometryOf();
    const cssW = Math.max(1, Math.round((g && g.cssW) || 0));
    const cssH = Math.max(1, Math.round((g && g.cssH) || 0));
    if (!cssW || !cssH) return false;
    const res = effectiveRes();
    const app = (() => { try { return live2d.getApp ? live2d.getApp() : null; } catch { return null; } })();
    if (!app || !app.renderer) return false;
    try {
      app.renderer.resolution = res;
      app.renderer.resize(cssW, cssH);
    } catch { return false; }
try { if (live2d.syncSize) live2d.syncSize({ size: { width: cssW, height: cssH }, dpr: res }); } catch { /* 忽略 */ }
    return true;
  }

  return {
    id: 'live2d',
    capabilities: {
      // Live2D 不支持 Spine 的插槽/网格类设置项：只声明确实生效的
      // 只声明确实生效的三项：纹理过滤（PIXI scaleMode）、限帧（ticker.maxFPS）、
      //   DPR（PIXI renderer.resolution + 覆盖层画布同源放大）。
      // presetFilter：12 档滤镜预设，经 PIXI.Filter 挂到 overlay stage（复用引擎同一套表达式）
      // msaa / pma / fit 不声明：msaa 要重建 PIXI app（运行期做不到）；
      //   pma 由 PIXI 纹理管线托管、无法按页切直通/转预乘；fit 的"全部部件/动画全程"依赖 Spine 骨架包围盒数据（Live2D 无此数据）。
      // animation：动作切换经 bridge.playLabel 落地（本面唯一的"内容操作"能力）。
      //   skin / partFilter / mixMode 不声明——本面没有对应实现，声明了就是骗面板。
      settings: ['textureFilter', 'fps', 'dpr', 'presetFilter', 'animation'],
      debugDraw: [],
      camera: 'ortho-2d',
    },
    /** Assets 层入口（测试/工具用）：catalog entry → ready Document */
    buildDocument,
    camera,
    /**
     * 装载：把 Surface 句柄透传给覆盖层实现（画布/尺寸/DPR 都从这里来）。
     * @param {object} document
     * @param {object} handle
     */
    async mount(document, handle) {
      // 只接受 ready 的 Document（契约 Document契约 §二 硬规则 1）
      // 只接受 ready 的 Document，**不提供旧形状兜底**（理由同 render/spine.js）
      if (!document || document.state !== 'ready') {
        const why = (document && (document.warnings || []).join('；')) || '未提供 Document';
        throw new Error(`live2d.mount 只接受 ready 的 Document（请先 buildDocument）：${why}`);
      }
      handleRef = handle || null;
      const info = await live2d.mount(document, handle);
      // 每次装载后确保门控装在当前 app 上（unmount 会销毁 app，重建后是新的实例）
      try { installFrameGate(live2d.getApp ? live2d.getApp() : null); } catch { /* 门控装不上不应阻断装载 */ }
      applyPreset(); // 新模型挂上后把当前滤镜补一次（切模型/重建后不断档）
      return info;
    },
    /**
     * 尺寸变化：覆盖层 canvas 的像素尺寸按**引擎同一口径**的 DPR 设置。
     * 不做设备像素比推断（软件渲染 / 封顶 2 / dprMode 只有引擎知道），
     *   统一由 StageSurface 的 geometry().res 下发。
     * @param {{cssW:number, cssH:number}} box
     */
    resize(box) {
      // 尺寸唯一来源：handle.geometry()（Surface 提供）；box 只作兜底
      const g = (() => { try { return handleRef && handleRef.geometry ? handleRef.geometry() : null; } catch { return null; } })();
      const cssW = Math.max(1, Math.round((g && g.cssW) || (box && box.cssW) || 0));
      const cssH = Math.max(1, Math.round((g && g.cssH) || (box && box.cssH) || 0));
      const res = effectiveRes(box && box.dpr);
      if (!cssW || !cssH) return;
if (typeof live2d.syncSize === 'function') {
        try { live2d.syncSize({ size: { width: cssW, height: cssH }, dpr: res }); } catch { /* 忽略 */ }
      }
    },
    /** 按需渲染一帧（暂停中交互/改设置后调用；ticker 停着不会自动画） */
    render() { return repaintFrame(); },
    /** 显式补一帧（统一入口 repaintActive 用） */
    repaint() { return repaintFrame(); },

    /**
     * 暂停：停掉 PIXI ticker。
     * 为什么用 ticker：Live2D 的时间推进完全由 ticker 驱动（模型 update 在 ticker 回调里），
     *   停 ticker 才是"真的不动"；只改标志位模型照样每帧更新。
     * 与 frame-gate 的关系：门控只决定"这帧要不要渲染"，ticker 停了连门控都不会被调用，
     *   恢复时直接 start() 即可，不需要额外补帧。
     */
    pause() {
      pausedRef = true;
      try { const app = live2d.getApp && live2d.getApp(); if (app && app.ticker && app.ticker.stop) { app.ticker.stop(); return true; } } catch { /* 忽略 */ }
      return false;
    },
    /** 继续：重启 ticker */
    resume() {
      pausedRef = false;
      try { const app = live2d.getApp && live2d.getApp(); if (app && app.ticker && app.ticker.start) { app.ticker.start(); return true; } } catch { /* 忽略 */ }
      return false;
    },

    /** DPR 变化：与引擎保持同口径（Live2D 自身不决定像素比） */
    setDpr() { /* 由 resize() 统一按引擎口径同步 */ },


    /**
     * 应用一项设置（契约 renderer/v1）。未知键返回 false 不抛。
     * @param {string} key textureFilter | fps
     * @param {any} value
     * @returns {boolean}
     */
    setSetting(key, value) {
      // animation 例外：重复点同一条动作是"重播"，不能被同值短路吞掉
      if (key !== 'animation') {
        const cur = this.getSetting(key);
        if (cur !== null && cur !== undefined && String(cur) === String(value)) return true;
      }
      if (key === 'animation') {
        // 空值 = 无操作（能力自检同值回灌时会走到这里）
        const label = value === null || value === undefined ? '' : String(value);
        if (!label) return true;
        try { return live2d.bridge.playLabel(label) === true; } catch { return false; }
      }
      // 未声明的三项（skin / partFilter / mixMode）：本面确实不支持，如实返回 false
      if (key === 'skin' || key === 'partFilter' || key === 'mixMode') return false;
      if (key === 'presetFilter') {
        const id = String(value || DEFAULT_FILTER);
        if (!FILTER_PRESETS.some((x) => x.id === id)) return false; // 未知档位不认
        presetId = id;
        // 模型还没挂时 applyPreset 返回 false，但档位已记住：mount 之后会补挂，
        //   所以这里仍算成功（否则能力自检在"没加载模型"时会把已实现的能力误判为不支持）
        applyPreset();
        return true;
      }
      if (key === 'dpr') {
        // 先记档位：即使当前没挂载也接受（下次 mount/resize 生效），这样能力自检不会误报不支持
        const v = String(value);
        if (v === 'auto') dprWanted = 'auto';
        else {
          const n = parseFloat(v);
          if (!Number.isFinite(n) || n <= 0) return false;
          dprWanted = String(n);
        }
        const appDpr = live2d.getApp ? live2d.getApp() : null;
        if (!appDpr) return true;
        return applyResolution();
      }
      const app = live2d.getApp ? live2d.getApp() : null;
      if (!app) return false;
      try {
        if (key === 'textureFilter') {
          const nearest = String(value) === 'nearest';
          // PIXI.SCALE_MODES 由运行时库提供；取不到就判不支持（不猜常量值）
          const modes = window.PIXI && window.PIXI.SCALE_MODES;
          if (!modes) return false;
          const mode = nearest ? modes.NEAREST : modes.LINEAR;
          let touched = 0;
          for (const tex of texturesOf(app)) {
            const bt = tex && tex.baseTexture;
            if (!bt) continue;
            try {
              bt.scaleMode = mode;
              bt.update(); // 让已上传的纹理按新采样方式重传，否则改了属性也不生效
              touched += 1;
            } catch { /* 单张失败继续其它 */ }
          }
          if (!touched) return false;
          filterMode = nearest ? 'nearest' : 'linear';
          return true;
        }
        if (key === 'fps') {
          // 1~120：90 档要能接受（高刷屏）。实际限制由 frameGate 做，PIXI 的 maxFPS 保持 0。
          const n = Math.max(1, Math.min(120, Number(value) || 60));
          fpsLimit = n;
          try { app.ticker.maxFPS = 0; } catch { /* 忽略 */ }
          installFrameGate(app);
          return true;
        }
      } catch { return false; }
      return false;
    },

    /** 回显实际生效值（不是请求值） */
    getSetting(key) {
      if (key === 'dpr') {
        // 回显"实际生效值"：已挂载时读 PIXI 真实分辨率，未挂载时按档位与几何推算
        const app = (() => { try { return live2d.getApp ? live2d.getApp() : null; } catch { return null; } })();
        if (app && app.renderer && app.renderer.resolution) return app.renderer.resolution;
        return effectiveRes();
      }
      if (key === 'animation') {
        // 无模型时回显 ''（不是 null，理由同 spine）
        try { return (live2d.bridge.currentLabel && live2d.bridge.currentLabel()) || ''; } catch { return ''; }
      }
      if (key === 'presetFilter') return presetId;
      if (key === 'textureFilter') return filterMode;
      if (key === 'fps') {
        const app = live2d.getApp ? live2d.getApp() : null;
        // 回显"目标档位"：maxFPS 已被关掉（恒 0），真实限制在我们的门控里
        return fpsLimit;
      }
      return null;
    },
    /**
     * 卸载：释放内容 + 自建 GL 资源（PIXI app）+ 移除覆盖层容器；幂等。
     * 与 dispose 同一释放路径（渲染器实例本身仍存活，下次 mount 全量重建 app 与 DOM）。
     * 为什么不像 spine 那样保留：PIXI 的 destroy(true) 会摘掉 canvas 只留容器，
     *   那个中间态正是"页面空白但 stats 正常"的来源；重建成本低，不值得为此维护两套生命周期。
     */
    /**
     * 实测渲染帧率（每 ≥500ms 结算一次，只统计真正出画的帧）。
     * 面板读数必须用它，不能用 PIXI 的 ticker.FPS（那是 rAF 频率）。
     * @returns {number} 最近窗口的 frames/s；0 表示暂无数据
     */
    getMeasuredFps() { return measuredFps; },
    unmount() {
      try { if (typeof live2d.unmount === 'function') live2d.unmount(); } catch { /* 忽略 */ }
    },
    /** 彻底释放：销毁 PIXI app 与覆盖层 DOM；幂等（Surface 销毁时走这里） */
    dispose() {
      try { if (typeof live2d.dispose === 'function') live2d.dispose(); } catch { /* 忽略 */ }
    },
    isActive() {
      try { return !!live2d.isActive(); } catch { return false; }
    },
    /** Surface 的帧入口（Live2D 由 PIXI 自己的 ticker 驱动，这里只对齐画布尺寸） */
    render(handle) {
      try { if (live2d.syncSize && handle) live2d.syncSize(handle); } catch { /* 忽略 */ }
    },
  };
}

export default createLive2DRenderer;
