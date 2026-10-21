// render/spine.js —— Spine 渲染器（注册到 StageSurface 的渲染面实现）
//
// 契约（StageSurface.renderer）：
//   { id, capabilities, mount(document, handle) → info, dispose(), isActive(), camera }
// 边界：不碰 DOM 尺寸、不建 canvas —— 只通过 handle 取画布/尺寸/DPR，用 handle.requestRender 请求渲染。

import { createCamera } from './camera/index.js';

/** Spine 渲染器支持的设置项 */
const SETTINGS = ['fps', 'dpr', 'msaa', 'textureFilter', 'presetFilter', 'pma', 'fit'];
/** Spine 渲染器支持的调试绘制项 */
const DEBUG_DRAW = ['bones', 'meshes', 'boundingBoxes', 'paths', 'points', 'regions', 'clipping', 'hulls'];

/**
 * 能力键 → 舞台方法名。
 * 为什么这样分：舞台（spine/canvas.js）已有一批经过验收的 setter，渲染 + 转发"，
 *   不自己解释设置语义；面板因此可以完全不知道舞台的存在（契约 INV-01）。
 */
const STAGE_SETTERS = {
  fps: 'setFpsLimit',
  dpr: 'setDprMode',
  textureFilter: 'setTextureFilter',
  presetFilter: 'setFilter',
  pma: 'setPma',
  fit: 'setFit',
};

/**
 * 创建 Spine 渲染器。
 * @param {{stage: object}} options stage 为舞台（提供 load/unload/dispose/stats/camera）
 */
export function createSpineRenderer({ stage, onMsaa } = {}) {
  if (!stage || typeof stage.load !== 'function') {
    throw new Error('createSpineRenderer: 需要提供 load 能力的 stage');
  }
  /**
   * 取当前引擎实例（MSAA 重建会换实例，所以每次用都重新取，避免拿到已销毁的旧引擎）。
   * @returns {object|null}
   */
  const engineOf = () => {
    try { return stage.debug ? stage.debug().engine : null; } catch { return null; }
  };

  /**
   * 统一相机的 backend：只做「读/写状态 + 怎么落地」，不做任何坐标换算。
   * 全部委托引擎原生方法：
   *   getScale → getCameraZoom()（引擎的 userScale 是唯一真相）
   *   setScale → setCameraZoom(v)（引擎内部按 SCALE_MIN/MAX 再夹一次）
   *   pan      → applyPan(dx, dy)（dx/dy 为屏幕像素，倍率与 flip 由引擎处理）
   *   resetView→ resetCamera()（重新 fit，userScale 归 1）
   */
  const cameraBackend = {
    getScale() {
      const engine = engineOf();
      try { return engine && typeof engine.getCameraZoom === 'function' ? Number(engine.getCameraZoom()) : null; } catch { return null; }
    },
    setScale(v) {
      const engine = engineOf();
      try { if (engine && typeof engine.setCameraZoom === 'function') engine.setCameraZoom(v); } catch { /* 忽略 */ }
    },
    pan(dx, dy) {
      const engine = engineOf();
      try { if (engine && typeof engine.applyPan === 'function') engine.applyPan(dx, dy); } catch { /* 忽略 */ }
    },
    resetView() {
      const engine = engineOf();
      try { if (engine && typeof engine.resetCamera === 'function') engine.resetCamera(); } catch { /* 忽略 */ }
    },
  };

  // 统一相机：档位 / 范围 / 复位语义与 Live2D 侧完全一致（差异只在 backend）
  const camera = createCamera({ kind: 'spine', backend: cameraBackend });

  return {
    id: 'spine',
    capabilities: {
      settings: SETTINGS.slice(),
      debugDraw: DEBUG_DRAW.slice(),
      camera: 'ortho-2d',
    },
    /** 相机由渲染器提供（统一相机，backend 委托引擎原生方法） */
    camera,
    /**
     * 装载：入口 url 映射成引擎认识的 modelUrl（catalog 只给 entry.url）。
     * @param {object} document
     * @param {object} handle StageSurface 句柄（本渲染器目前不需要使用，保留参数位）
     */
    async mount(document, handle) {
      void handle;
      const doc = document || {};
      const entryUrl = doc.entry && doc.entry.url ? doc.entry.url : (doc.modelUrl || null);
      const adapted = entryUrl ? { ...doc, modelUrl: entryUrl } : doc;
      const rootId = adapted.rootId || (adapted.root && adapted.root.id) || null;
      return stage.load({ root: rootId, model: adapted });
    },
    /**
     * 应用一项设置（面板唯一入口，契约 renderer/v1）。
     * 未知键返回 false 不抛；支持的键全部委托舞台既有 setter（行为与现在完全一致）。
     * @param {string} key 能力键（fps/dpr/msaa/textureFilter/presetFilter/pma/fit 或 debug:<项>）
     * @param {any} value
     * @returns {boolean}
     */
    setSetting(key, value) {
      // 同值短路：生效值没变就不重复应用（msaa 会重建上下文、pma 会重传纹理、fit 会重置取景，
      //   无谓的重复执行既拖慢也破坏现场；能力自检因此可以安全地"同值回灌"）
      const cur = this.getSetting(key);
      if (cur !== null && cur !== undefined && String(cur) === String(value)) return true;
      const dbg = /^debug:(.+)$/.exec(String(key || ''));
      if (dbg) {
        if (!DEBUG_DRAW.includes(dbg[1]) || typeof stage.setDebug !== 'function') return false;
        try { stage.setDebug({ [dbg[1]]: !!value }); return true; } catch { return false; }
      }
      if (key === 'msaa') {
        // 抗锯齿要重建上下文，属外壳职责（applyMsaa）；渲染器只提供入口，不自己重建
        if (typeof onMsaa !== 'function') return false;
        try { onMsaa(value); return true; } catch { return false; }
      }
      const setter = STAGE_SETTERS[key];
      if (!setter || typeof stage[setter] !== 'function') return false;
      try {
        stage[setter](value);
        // 以"回显的生效值"为准判定成功：舞台 setter 的返回值口径不一（有的返回 null 表示未生效），
        //   而设置快照是唯一的真相来源，读它最可靠
        const applied = this.getSetting(key);
        if (applied === null || applied === undefined) return false;
        return String(applied) === String(value) || key === 'msaa';
      } catch { return false; }
    },

    /** 回显实际生效值（读舞台 settings，不是请求值） */
    getSetting(key) {
      const dbg = /^debug:(.+)$/.exec(String(key || ''));
      const st = (() => { try { return stage.stats().settings; } catch { return null; } })();
      if (!st) return null;
      if (dbg) return !!(st.debug && st.debug[dbg[1]]);
      const map = { fps: 'fpsLimit', dpr: 'dprMode', msaa: 'msaa', textureFilter: 'textureFilter', presetFilter: 'filter', pma: 'pma', fit: 'fit' };
      const k = map[key];
      return k && st[k] !== undefined ? st[k] : null;
    },
    /**
     * 尺寸变化：把 CSS 尺寸交给引擎，由引擎按自己的 getEffectiveDpr 决定像素尺寸。
     * 为什么不让 Surface 直接写 canvas.width：引擎的 resize() 会同时更新
     *   gl.viewport / logicalW / camera.viewportWidth 并在尺寸变化时 refit，
     *   绕过它只改 canvas.width 会造成视口与像素网格不一致（BUG-2 根因）。
     * @param {{cssW:number, cssH:number, dpr:number}} box
     */
    resize(box) {
      if (!box) return;
      let engine = null;
      try { engine = stage.debug ? stage.debug().engine : null; } catch { engine = null; }
      // res 由 StageSurface 下发（唯一尺寸来源）；引擎再按软件渲染 / dprMode 收口
      const dpr = box.res && box.res > 0 ? box.res : (box.dpr && box.dpr > 0 ? box.dpr : 1);
      if (engine && typeof engine.getEffectiveDpr === 'function' && typeof engine.resize === 'function') {
        const effective = engine.getEffectiveDpr(dpr);
        const w = Math.max(1, Math.floor(box.cssW * effective));
        const h = Math.max(1, Math.floor(box.cssH * effective));
        engine.resize(w, h);
        return;
      }
      // 引擎还没建：交给舞台的兜底入口（等引擎初始化时自己 refreshResolution）
      try { if (typeof stage.resize === 'function') stage.resize(); } catch { /* 忽略 */ }
    },
    /**
     * 期望 DPR 变化：下发给引擎，由引擎决定实际生效值。
     * @param {number|string} value 像素比或 auto
     */
    setDpr(value) {
      let engine = null;
      try { engine = stage.debug ? stage.debug().engine : null; } catch { engine = null; }
      if (engine && typeof engine.setDprMode === 'function') engine.setDprMode(value === null || value === undefined ? 'auto' : value);
    },
    /** 幂等卸载（画布隐藏由 StageSurface 负责，不在这里碰 DOM） */
    dispose() {
      try { if (typeof stage.unload === 'function') stage.unload(); } catch { /* 忽略 */ }
    },
    isActive() {
      try { return !!(stage.stats && stage.stats().model); } catch { return false; }
    },
  };
}

export default createSpineRenderer;
