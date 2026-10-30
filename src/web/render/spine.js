// render/spine.js —— Spine 渲染器（注册到 StageSurface 的渲染面实现）
//
// 契约（StageSurface.renderer）：
//   { id, capabilities, mount(document, handle) → info, dispose(), isActive(), camera }
// 边界：不碰 DOM 尺寸、不建 canvas —— 只通过 handle 取画布/尺寸/DPR，用 handle.requestRender 请求渲染。

import { createCamera } from './camera/index.js';
import { trackModelStage, markModelFailed } from '../infra/ready.js';
import { buildDocument } from '../infra/document.js';
import { applyFilter } from '../engine/appearance.js';

/** Spine 渲染器支持的设置项 */
// 前 7 项是"引擎参数"，后 4 项是"内容操作"（皮肤/部件筛除/动作混合/动作切换）：
//   它们同样只能经 setSetting 落地（INV-01），否则 Live2D 模式下会打到隐藏的 spine 舞台。
const SETTINGS = ['fps', 'dpr', 'msaa', 'textureFilter', 'presetFilter', 'pma', 'fit', 'skin', 'mixMode', 'mixTime', 'animation', 'speed'];
/** Spine 渲染器支持的调试绘制项
 *  注：不含 points —— 3.8/4.1/4.2/4.3 的 SkeletonDebugRenderer 均无 drawPoints（实测 grep 全为 0），
 *  该项永远画不出来，按「声明即必须可实现」不列入能力声明；运行时若探测到缺失项，
 *  由引擎 getRendererInfo().debugUnsupported 上报。 */
const DEBUG_DRAW = ['bones', 'meshes', 'boundingBoxes', 'paths', 'regions', 'clipping', 'hulls'];

/**
 * 能力键 → 舞台方法名。
 * 为什么这样分：舞台（spine/canvas.js）已有一批经过验收的 setter，渲染 + 转发"，
 *   不自己解释设置语义；面板因此可以完全不知道舞台的存在（契约 INV-01）。
 */
const STAGE_SETTERS = {
  speed: 'setSpeed',
  mixTime: 'setMixTime',
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
/**
 * 画面指纹：对 2D canvas 采样求和，用于断言"截到的是哪一面、内容是否变化"。
 * 采样步长取质数，避免与行宽成整数比导致漏采。
 * @param {HTMLCanvasElement} canvas
 * @returns {number} 指纹（0 表示取不到）
 */
function digestOf(canvas) {
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return 0;
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 997) sum = (sum + data[i]) % 1000003;
    return sum;
  } catch { return 0; }
}

export function createSpineRenderer({ stage, onMsaa } = {}) {
  /** 暂停标记（渲染器自己维护：相机/设置变更后需要判断"是否要补一帧"） */
  let pausedRef = false;
  if (!stage || typeof stage.load !== 'function') {
    throw new Error('createSpineRenderer: 需要提供 load 能力的 stage');
  }
  /**
   * 取当前引擎实例。
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
      if (pausedRef) { try { stage.repaint && stage.repaint(); } catch { /* 忽略 */ } }
    },
    pan(dx, dy) {
      const engine = engineOf();
      try { if (engine && typeof engine.applyPan === 'function') engine.applyPan(dx, dy); } catch { /* 忽略 */ }
      if (pausedRef) { try { stage.repaint && stage.repaint(); } catch { /* 忽略 */ } }
    },
    resetView() {
      // 走舞台的 resetView：它除了相机归位，还会重取"平移基准"(viewBaseScale/viewPan)，
      //   只调 engine.resetCamera() 会让基准停在旧值，复位后一拖就跳。
      try { if (typeof stage.resetView === 'function') { stage.resetView(); return; } } catch { /* 落到下面的兜底 */ }
      const engine = engineOf();
      try { if (engine && typeof engine.resetCamera === 'function') engine.resetCamera(); } catch { /* 忽略 */ }
    },
  };

  // 统一相机：档位 / 范围 / 复位语义与 Live2D 侧完全一致（差异只在 backend）
  const camera = createCamera({ kind: 'spine', backend: cameraBackend });

  return {
    id: 'spine',
    // 声明的 kind 供 surface.register 做面元数据表校验（防"注册了渲染器却忘了加表项"）
    kind: 'spine',
    /**
     * 下发插件效果链（**与 Live2D 同一套语义**：顺序/激活/销毁都在 effect-chain.js，
     * 这里只管"怎么把它挂到 Spine 的 batcherShader 上"）。
     * 参数值变化只更新 uniform；只有链**结构**变化才重编译着色器（热更新判据）。
     * @param {Array<{id:string, fragment:string, uniforms:object}>} chain
     * @returns {boolean} 是否成功应用
     */
    setEffectChain(chain) {
      const eng = engineOf();
      if (!eng) return false;
      eng.effectChain = Array.isArray(chain) ? chain : [];
      applyFilter(eng);
      // 暂停态也要立刻看到变化：效果是"实时预览"用的，不能等下一次自然出帧
      try { if (pausedRef && stage && typeof stage.renderOnce === 'function') stage.renderOnce(); } catch { /* 忽略 */ }
      return true;
    },
    /** 当前生效链的结构签名（断言用：切档位时它不应变化） */
    effectChainSignature() {
      const eng = engineOf();
      return eng && eng.filterState ? String(eng.filterState.signature || '') : '';
    },
    /**
     * 暂停：停掉引擎时间推进（动作与渲染循环都不再走）。
     * 走 stage.pause()：舞台层的暂停是唯一实现（引擎 stopp），渲染器不重复实现一套。
     */
    pause() {
      pausedRef = true;   // 之后相机/设置变化都要显式补帧（引擎自己不再画）
      try { if (stage && typeof stage.pause === 'function') { stage.pause(); return true; } } catch { /* 忽略 */ }
      return false;
    },
    /** 继续：恢复引擎推进 */
    resume() {
      pausedRef = false;
      try { if (stage && typeof stage.play === 'function') { stage.play(); return true; } } catch { /* 忽略 */ }
      return false;
    },

    /**
     * 截图取像素：读 Spine 舞台画布的 WebGL 缓冲（缓冲不保留，只能 readPixels），
     * 逐行翻转后画进一张 2D canvas 返回。
     * 这段逻辑原在 app/topbar-actions.js 里写死 `#stage-canvas`，搬到渲染器后
     * **行为不变**，只是让"当前面是谁"由渲染器自己决定。
     * @returns {{canvas: HTMLCanvasElement, width: number, height: number, nonEmpty: number}|null}
     */
    capture() {
      const canvas = typeof document !== 'undefined' ? document.getElementById('stage-canvas') : null;
      if (!canvas || !canvas.width || !canvas.height) return null;
      const w = canvas.width;
      const h = canvas.height;
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const outCtx = out.getContext('2d');
      if (!outCtx) return null;
      let nonEmpty = 0;
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (gl && typeof gl.readPixels === 'function') {
        try {
          const buf = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          const img = outCtx.createImageData(w, h);
          // WebGL 原点在左下：逐行翻转，否则导出上下颠倒
          for (let y = 0; y < h; y += 1) {
            const src = (h - 1 - y) * w * 4;
            img.data.set(buf.subarray(src, src + w * 4), y * w * 4);
          }
          for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 8) nonEmpty += 1;
          outCtx.putImageData(img, 0, 0);
        } catch { /* 读不到就走 drawImage 兜底 */ }
      }
      if (nonEmpty === 0) {
        try { outCtx.drawImage(canvas, 0, 0); } catch { /* 兜底失败就返回空白 */ }
      }
      return { canvas: out, width: w, height: h, nonEmpty, digest: digestOf(out) };
    },

    /** 显式补一帧（暂停中截图前调用，保证拿到的是最新画面） */
    repaint() {
      try { if (stage && typeof stage.repaint === 'function') { stage.repaint(); return true; } } catch { /* 忽略 */ }
      return false;
    },
    capabilities: {
      settings: SETTINGS.slice(),
      debugDraw: DEBUG_DRAW.slice(),
      camera: 'ortho-2d',
    },
    /** 相机由渲染器提供（统一相机，backend 委托引擎原生方法） */
    /** Assets 层入口（测试/工具用）：catalog entry → ready Document。渲染器自身不取资源 */
    buildDocument,
    camera,
    /**
     * 装载：入口 url 映射成引擎认识的 modelUrl（catalog 只给 entry.url）。
     * @param {object} document
     * @param {object} handle StageSurface 句柄（本渲染器目前不需要使用，保留参数位）
     */
    /**
     * 装载：入参是 **ready 的 Document**（契约 Document契约 §二 / 渲染器契约 §二）。
     * 本层不再把 catalog entry 改写成引擎字段、也不取任何资源 ——
     *   资源地址与字节都已在 infra/document.js 组装时备好。
     * @param {object} document ready 的 Document
     * @returns {Promise<object>} info
     */
    async mount(document, handle) {
      // 只接受 ready 的 Document，**不提供旧形状兜底**：
      //   兜底一旦留着，将来任何新调用点忘了组装就会静默走它，契约就形同虚设
      //   （现存的调用点 surface-switch 与 app/model-actions 都已在调用前 buildDocument）。
      if (!document || document.state !== 'ready') {
        const why = (document && (document.warnings || []).join('；')) || '未提供 Document';
        // 就绪信号：失败要立刻可见（带原因），测试据此直接报错而不是等超时
        markModelFailed(`Document 不可用：${why}`, { kind: 'spine' });
        throw new Error(`spine.mount 只接受 ready 的 Document（请先 buildDocument）：${why}`);
      }
      try {
        const info = await stage.load({ document });
        // 就绪信号（契约 §2.2）：mounted → painted → interactive 由 trackModelStage 逐级推进。
        //   painted 用引擎自己的已绘帧计数（stage.debug().frames），**不用像素采样**：
        //   画布 detach 之后像素采样仍可能"有颜色"，那是弱证据。
        trackModelStage({
          kind: 'spine',
          id: document.id || (document.meta && document.meta.id) || null,
          canvas: handle && handle.canvas,
          getFrames: () => stage.debug().frames,
          getActions: () => ((stage.debug().animations || []).length),
        });
        return info;
      } catch (e) {
        markModelFailed(`装载失败：${(e && e.message) || e}`, { kind: 'spine' });
        throw e;
      }
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
      // 同值短路：animation 例外——重复点同一条动作是"重播"，不能被短路吞掉
      if (key !== 'animation') {
        const cur = this.getSetting(key);
        if (cur !== null && cur !== undefined && String(cur) === String(value)) return true;
      }
      const dbg = /^debug:(.+)$/.exec(String(key || ''));
      if (dbg) {
        if (!DEBUG_DRAW.includes(dbg[1]) || typeof stage.setDebug !== 'function') return false;
        try { stage.setDebug({ [dbg[1]]: !!value }); return true; } catch { return false; }
      }
      // ---- 内容操作四键：返回值语义与改动前一致（皮肤=是否真的切过去；mixMode=是否生效；
      //      animation=舞台是否接受）
      if (key === 'skin') {
        try { return stage.setSkin(String(value)) !== false; } catch { return false; }
      }
      if (key === 'mixMode') {
        try { stage.setMixMode(!!value); } catch { return false; }
        return this.getSetting('mixMode') === !!value;
      }
      if (key === 'animation') {
        // 空值 = "没有要切的动作"：接受但不做事（能力自检会用同值回灌探活，
        //   此刻通常还没装模型，返回 false 会被误判成"声明支持但未实现"）
        const name = value === null || value === undefined ? '' : String(value);
        if (!name) return true;
        try { return stage.setAnimation(name) === true; } catch { return false; }
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
      /** 取引擎实例（多处要用；抽出来避免同一段 IIFE 反复出现在每个分支里） */
      const engineOf = () => { try { return stage.debug ? stage.debug().engine : null; } catch { return null; } };
      if (!st) return null;
      if (dbg) return !!(st.debug && st.debug[dbg[1]]);
      // 内容操作四键：回显**生效值**（INV-08），读舞台/引擎的真实状态，不是请求值
      if (key === 'skin') {
        // 必须读引擎**真正在用**的皮肤（activeSkins），不能只读舞台的 settings.skin：
        //   装载时会自动挑一个"能画出东西"的皮肤（有些资源的 default 是空壳、附件全在具名皮肤里），
        //   那条路径不经过 api.setSkin ⇒ st.skin 会停在旧值/默认值。
        //   拿假值回显会让 setSetting 的"同值短路"误判 —— 表现为"点回 default 完全没反应"
        //   （它以为已经是 default，直接 return true 什么都不做）。实测踩到过。
        const engSkin = engineOf();
        const active = engSkin && Array.isArray(engSkin.activeSkins) && engSkin.activeSkins.length
          ? engSkin.activeSkins[0]
          : null;
        return active || st.skin || 'default';
      }
      if (key === 'mixMode') return (Number(st.mixTime) || 0) > 0;
      // 混合时长：回显生效秒数（0 = 不混合）
      if (key === 'mixTime') return Number(st.mixTime) || 0;
      if (key === 'animation') {
        // 无模型时回显 ''（而不是 null）：null 会让能力自检判成"没有生效值"
        const eng = engineOf();
        return (eng && eng.animationName) || '';
      }
      // 播放速度：回显**生效值**（引擎侧 timeScale 才是真正在用的），舞台设置里的 speed 是请求值
      if (key === 'speed') {
        const eng = engineOf();
        const scale = eng && eng.state && typeof eng.state.timeScale === 'number' ? eng.state.timeScale : null;
        if (scale !== null) return scale;
        return st.speed !== undefined ? st.speed : 1;
      }
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
    /**
     * 卸载：释放当前模型内容并**停掉渲染循环**（不再出帧），引擎与 GL 上下文保留以便快速切回。
     * stage.unload() 内部已做 engine.stop() + clearSkeleton() + 让在途加载失效。
     * 画布可见性由 StageSurface 负责（渲染器不碰 DOM，契约 §一）。
     */
    unmount() {
      try { if (typeof stage.unload === 'function') stage.unload(); } catch { /* 忽略 */ }
    },
    /** 彻底释放：销毁引擎（含 WebGL 上下文）；幂等（Surface 销毁时走这里） */
    dispose() {
      try { if (typeof stage.dispose === 'function') stage.dispose(); } catch { /* 忽略 */ }
    },
    isActive() {
      try { return !!(stage.stats && stage.stats().model); } catch { return false; }
    },
  };
}

export default createSpineRenderer;
