// render/live2d.js —— Live2D 渲染器（注册到 StageSurface 的渲染面实现）
//
// 契约（StageSurface.renderer）：
//   { id, capabilities, mount(document, handle) → info, dispose(), isActive(), camera }
// 边界：画布与尺寸由 StageSurface 提供（handle），本文件不读 DOM 尺寸、不建画布。

import { createCamera } from './camera/index.js';
import { DEFAULT_FILTER, FILTER_PRESETS } from '../engine/filters.js';

/**
 * 创建 Live2D 渲染器。
 * @param {{live2d: object}} options live2d 为覆盖层实现（提供 mount/dispose/isActive/bridge）
 */
export function createLive2DRenderer({ live2d } = {}) {
  if (!live2d) throw new Error('createLive2DRenderer: 需要 live2d 实现');
  /** 当前生效的纹理过滤与限帧（回显用） */
  let filterMode = 'linear';
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
      setScale: (v) => { try { live2d.bridge.setZoomRatio(v); } catch { /* 忽略 */ } },
      /** 平移：屏幕像素增量，1:1 交给覆盖层 */
      pan: (dx, dy) => { try { live2d.bridge.pan(dx, dy); } catch { /* 忽略 */ } },
      /** 复位：bridge 归 1 并重排 */
      resetView: () => { try { live2d.bridge.resetView(); } catch { /* 忽略 */ } },
    },
  });
  let handleRef = null;
  /** 当前滤镜预设 id（original = 不挂滤镜） */
  let presetId = DEFAULT_FILTER;
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
      settings: ['textureFilter', 'fps', 'dpr', 'presetFilter'],
      debugDraw: [],
      camera: 'ortho-2d',
    },
    camera,
    /**
     * 装载：把 Surface 句柄透传给覆盖层实现（画布/尺寸/DPR 都从这里来）。
     * @param {object} document
     * @param {object} handle
     */
    async mount(document, handle) {
      handleRef = handle || null;
      const info = await live2d.mount(document, handle);
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
    /** DPR 变化：与引擎保持同口径（Live2D 自身不决定像素比） */
    setDpr() { /* 由 resize() 统一按引擎口径同步 */ },

    /**
     * 应用一项设置（契约 renderer/v1）。未知键返回 false 不抛。
     * @param {string} key textureFilter | fps
     * @param {any} value
     * @returns {boolean}
     */
    setSetting(key, value) {
      const cur = this.getSetting(key);
      if (cur !== null && cur !== undefined && String(cur) === String(value)) return true;
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
          const n = Math.max(1, Math.min(120, Number(value) || 60));
          if (!app.ticker) return false;
          app.ticker.maxFPS = n;   // 0 = 不限帧，故这里只接受 ≥1 的值
          fpsLimit = n;
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
      if (key === 'presetFilter') return presetId;
      if (key === 'textureFilter') return filterMode;
      if (key === 'fps') {
        const app = live2d.getApp ? live2d.getApp() : null;
        return app && app.ticker && app.ticker.maxFPS ? app.ticker.maxFPS : fpsLimit;
      }
      return null;
    },
/** 幂等卸载（覆盖层的隐藏由 StageSurface 负责） */
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
