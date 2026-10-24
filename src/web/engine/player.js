// engine/player.js —— 引擎主体：装载 / 帧循环 / 相机 / 动画 / 外观的最小闭环（B1）
//
// 帧调度：**保留渲染器自建 rAF 主循环（方案 A）**，与现状一致。
//   理由：StageSurface 只管尺寸/背景，不接管渲染帧；改成统一调度需要同时改 surface 与 canvas.js，
//   属于 B6 的收尾工作，B1 不做（避免一次改两处导致帧问题无法归因）。
//
// 对外契约与旧 SpineEngine 同名同义（25 个方法），B1 覆盖：init/loadModel/resize/dispose/
//   start/stop/seek/setAnimation/setMixTime/setSkins/getSkins/setDebugDraw/setSlotFilter/
//   setFilter/getFilter/getCameraZoom/setCameraZoom/applyZoom/applyPan/resetCamera/
//   refreshResolution/getEffectiveDpr/setDprMode/getMode/getRendererInfo/getAnimations/
//   getRuntimeVersion/getCurrentFps/presentFirstFrame；rebuildTextures 暂为明确告警的空实现（B4 落地）。

import { createContext, effectiveDpr, applyPixelSize } from './gl.js';
import { resolveRuntime } from './runtime.js';
import { buildModel } from './loader.js';
import { capabilitiesFor } from './runtime-capabilities.js';
import { createAdapters } from './adapters/index.js';
import * as appearance from './appearance.js';
import { getSkins as skinList, setSkins as skinApply, normalizeKeywords, countFilterableSlots } from './skins.js';
import { engineDefaults, mergeDebugDraw, rendererInfo } from './engine-state.js';
import * as cameraOps from './camera-adapter.js';
import { describeModel } from './model-info.js';
import * as anim from './animation.js';
import * as glDriver from './gl-driver.js';
import { renderFrame, presentFirstFrame, startLoop, stopLoop } from './render-frame.js';

/**
 * 引擎（与旧 SpineEngine 同名构造：`new Engine({log, onLoadComplete, onError})`）。
 */
export class SpineEngine {
  constructor(callbacks = {}) {
    this.callbacks = callbacks || {};
    // 运行时上下文与钩子（上下文丢失恢复在 B4b/B6 处理，与现状一致）
    Object.assign(this, engineDefaults());
    this.runtimeManager = callbacks.runtimeManager
      || (typeof window !== 'undefined' && window.Is && typeof window.Is.getInstance === 'function' ? window.Is.getInstance() : null);
  }

  /** 统一日志（语义与旧引擎一致：log(level, msg, scope)） */
  log(level, message, scope = 'player') {
    try {
      if (typeof this.callbacks.log === 'function') this.callbacks.log(level, message, scope);
    } catch { /* 日志失败不得影响渲染 */ }
  }

  /** 当前渲染模式（none / webgl） */
  getMode() {
    return this.mode;
  }

  /** 建上下文（实现见 gl-driver.js）；返回 false 表示当前环境不可渲染 */
  init(canvas, opts = {}) {
    return glDriver.initEngine(this, canvas, opts);
  }

  /** 生效 DPR */
  getEffectiveDpr(deviceDpr) {
    return glDriver.effectiveDprOf(this, deviceDpr);
  }

  /** 按逻辑尺寸 + DPR 重设 backing store */
  refreshResolution() {
    glDriver.refreshResolution(this);
  }

  /** 纯尺寸更新 */
  resize(w, h) {
    glDriver.resizeEngine(this, w, h);
  }

  /** DPR 模式 */
  setDprMode(mode) {
    glDriver.setDprMode(this, mode);
  }

  /**
   * 渲染器信息（含能力矩阵：探测结果 + 告警），便于排查"某能力在旧版本不可用"。
   * @returns {object}
   */
  getRendererInfo() {
    return rendererInfo(this);
  }

  /** 相机视口跟随画布 CSS 尺寸 */
  syncCameraViewport() {
    cameraOps.syncCamera(this);
  }

  /** 装载模型（描述符契约见 loader.js 头部注释） */
  async loadModel(descriptor) {
    if (this.mode !== 'webgl' || !this.gl) throw new Error('当前浏览器不支持 WebGL，无法渲染 Spine 动画。');
    const rt = await resolveRuntime(this.runtimeManager, descriptor.version);
    this.spine = rt.spine;
    this.runtimeVersion = rt.version;
    this.supportsStraightAlpha = rt.supportsStraightAlpha !== false;
    // 能力探测（一次、按版本缓存）：版本号只用于展示，行为全部由探测结果决定
    this.caps = capabilitiesFor(rt.spine, rt.version);
    for (const w of this.caps.warns || []) this.log('warn', `能力缺失 → ${w}`, 'runtime');
    this.adapters = createAdapters({
      spine: rt.spine,
      caps: this.caps,
      gl: this.gl,
      canvas: this.canvas,
      size: { w: this.logicalW, h: this.logicalH },
      onWarn: (m) => this.log('warn', m, 'runtime'),
    });
    this.stop();
    this.disposeContent();
    this.pendingPresent = true;
    const model = await buildModel({
      adapters: this.adapters,
      spine: this.spine,
      gl: this.gl,
      descriptor,
      pmaMode: this.pmaMode,
      textureFilter: this.textureFilter,
      supportsStraight: this.supportsStraightAlpha,
      log: (l, m, s) => this.log(l, m, s),
    });
    this.bindModel(model);
    // 渲染器与运行时绑定：换运行时必须重建，否则用旧版本绘制器画新骨架会静默不出画
    if (!this.renderer || this.rendererRuntime !== this.runtimeVersion) {
      this.disposeRenderer();
      this.createRenderer();
      this.rendererRuntime = this.runtimeVersion;
    }
    // fit 前必须先摆好姿态：未 updateWorldTransform 时 getBounds 可能返回空包围盒（4.x 上实测）
    this.applyAppearance();
    this.poseForFit();
    this.applyFit();
    this.presentFirstFrame();
    // 时长缓存：装载时扫一次（旧引擎同款，避免每帧遍历 animations）
    this.cacheDurations();
    const info = this.describeModel(descriptor);
    this.currentModel = descriptor;
    if (typeof this.callbacks.onLoadComplete === 'function') {
      try { this.callbacks.onLoadComplete(info); } catch { /* 回调异常不影响渲染 */ }
    }
    this.start();
    return info;
  }

  /** 摆到 setup pose 并更新世界变换（fit 取包围盒的前置条件） */
  poseForFit() {
    if (!this.adapters || !this.skeleton) return;
    this.adapters.skeleton.setupPose(this.skeleton);
    this.adapters.skeleton.updateWorldTransform(this.skeleton);
  }

  /** 释放渲染器（换运行时/换上下文时调用） */
  disposeRenderer() {
    try { if (this.adapters && this.renderTarget) this.adapters.renderer.dispose(this.renderTarget); } catch { /* 忽略 */ }
    this.renderer = null;
    this.rendererKind = 'none';
    this.camera = null;
    this.rendererRuntime = null;
    // 默认着色器是渲染器持有的对象，渲染器没了就不能再当成"可还原目标"留着
    this.filterState = { saved: null, active: null };
  }

  /** 建渲染器与相机（版本差异由 loader.buildRenderer 适配） */
  createRenderer() {
    const built = this.adapters.renderer.create();
    this.renderer = built.renderer;
    this.rendererKind = built.kind;
    this.camera = built.camera;
    this.renderTarget = built; // 适配器 draw() 需要的目标对象
    this.syncCameraViewport();
    this.applyAppearance();
  }

  /** 把装载产物挂到引擎上（装载与重建共用） */
  bindModel(model) {
    // PMA 结果随模型一起绑定（rebuildTextures 走这里），否则档位显示与实际口径分裂
    this.pmaInfo = model.pmaInfo || null;
    this.pmaDetection = model.pmaDetection || null;
    this.gpuUnpack = !!model.gpuUnpack;
    this.atlas = model.atlas;
    this.textures = model.textures || [];
    this.skeletonData = model.skeletonData;
    this.skeleton = model.skeleton;
    this.stateData = model.stateData;
    this.state = model.state;
    this.premultiplied = model.premultiplied;
  }

  /** 应用外观（混合钩子 + 滤镜）；必须在渲染器建好之后调用 */
  applyAppearance() {
    appearance.installBlend(this);
    appearance.applyFilter(this);
  }

  /** 装载结果摘要（实现见 model-info.js） */
  describeModel(descriptor) {
    return describeModel({ engine: this, descriptor });
  }

  /** 切换 fit 模式（subject / all / animation） */
  setFitMode(mode) {
    return cameraOps.setFitMode(this, mode);
  }

  /** 读当前 fit 模式 */
  getFitMode() {
    return cameraOps.getFitMode(this);
  }

  /** 按当前 fit 模式重置相机（实现委托 camera-adapter） */
  applyFit() {
    return cameraOps.applyFit(this);
  }

  /** 把 userScale 落到相机 */
  applyUserScale() {
    cameraOps.applyUserScale(this);
  }

  getCameraZoom() {
    return cameraOps.getScale(this);
  }

  setCameraZoom(scale) {
    cameraOps.setScale(this, scale);
  }

  applyZoom(dir) {
    cameraOps.zoomStep(this, dir);
  }

  applyPan(dx, dy) {
    cameraOps.pan(this, dx, dy);
  }

  resetCamera() {
    cameraOps.resetCamera(this);
  }

  /** 首帧：更新一次状态并立即绘制（实现见 render-frame.js） */
  presentFirstFrame() {
    presentFirstFrame(this);
  }

  /** 起主循环（方案 A：引擎自建 rAF） */
  start() {
    startLoop(this);
  }

  /** 停主循环 */
  stop() {
    stopLoop(this);
  }

  update(dt) {
    if (!this.state || !this.skeleton) return;
    this.state.update(dt * this.speed);
    this.state.apply(this.skeleton);
    this.skeleton.updateWorldTransform(2);
  }

  getCurrentFps() { return this.currentFps; }

  setFpsLimit(fps) { this.fpsLimit = Math.max(1, Math.min(120, Number(fps) || 60)); }

  /** 跳到指定时间（实现见 animation.js） */
  seek(t) {
    anim.seek(this, t);
  }

  /** 切换动作 */
  setAnimation(name, loop) {
    return anim.setAnimation(this, name, loop);
  }

  /** 混合时长（0..1 秒） */
  setMixTime(t) {
    anim.setMixTime(this, t);
  }

  /** 播放速率（夹 0.1–3） */
  setSpeed(speed) {
    anim.setSpeed(this, speed);
  }

  /** 循环开关 */
  setLoop(loop) {
    anim.setLoop(this, loop);
  }

  /** 全部动作名 */
  getAnimations() {
    return anim.animations(this);
  }

  /** 当前动作时长 */
  getCurrentDuration() {
    return anim.currentDuration(this);
  }

  /** 装载后缓存时长（不每帧扫） */
  cacheDurations() {
    return anim.cacheDurations(this);
  }

  /** 动画只读快照（对照脚本用） */
  animationSnapshot() {
    return anim.snapshot(this);
  }

  /**
   * 订阅「当前动作播完一次」（跨模型轮播的推进源）。
   * @param {(e: {name: string, source: string}) => void} cb
   * @returns {() => void} 取消订阅
   */
  onMotionComplete(cb) {
    return anim.onMotionComplete(this, cb);
  }

  /** 皮肤名列表 */
  getSkins() {
    return skinList(this);
  }

  /** 应用皮肤（多皮肤会合成临时皮肤，与旧引擎一致） */
  setSkins(list) {
    return skinApply(this, list);
  }

  /** 插槽过滤关键词（绘制侧由 render-frame 的 hide/restore 落地） */
  setSlotFilter(keywords) { this.slotFilterKeywords = normalizeKeywords(keywords); }

  /** 只读：这批关键词会命中多少个"当前有附件的槽"（区分"没匹配"与"隐藏成功"） */
  countFilterableSlots(keywords) { return countFilterableSlots(this, keywords); }

  /** 切滤镜（非法 id 回落 original）；实现在 appearance.js */
  setFilter(id) {
    return appearance.setFilter(this, id);
  }

  getFilter() { return this.filterId; }

  /** 纹理过滤（同时重挂已上传纹理的采样参数） */
  setTextureFilter(mode) {
    return appearance.setTextureFilter(this, mode);
  }

  setDebugDraw(patch) {
    return mergeDebugDraw(this, patch);
  }

  /** 切 PMA 档位（重建贴图与渲染路径；顺序照抄旧引擎） */
  async rebuildTextures(pmaMode) {
    return appearance.rebuildTextures(this, pmaMode);
  }

  getRuntimeVersion() { return this.runtimeVersion; }

  /**
   * 卸载当前骨架（canvas.js 的 unload 走这里）。
   * 与旧引擎同义：停循环 → 释放贴图与图集 → 清引用 → 清屏（不留上一帧残影）。
   */
  clearSkeleton() {
    this.stop();
    this.pendingPresent = false;
    this.disposeContent();
    this.skeleton = null;
    this.skeletonData = null;
    this.state = null;
    this.stateData = null;
    this.currentModel = null;
    this.animationName = '';
    this.durations = {};
    this.activeSkins = [];
    if (this.gl) {
      try {
        this.gl.clearColor(0, 0, 0, 0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
      } catch { /* 上下文丢失时忽略 */ }
    }
  }

  /** 释放当前模型内容（不销毁上下文） */
  disposeContent() {
    this.stop();
    this.skeleton = null;
    this.state = null;
    for (const tex of this.textures) {
      if (this.adapters) this.adapters.texture.dispose(tex);
      else { try { tex.dispose(); } catch { /* 忽略 */ } }
    }
    this.textures = [];
    try { if (this.atlas && this.atlas.dispose) this.atlas.dispose(); } catch { /* 忽略 */ }
    this.atlas = null;
    this.skeletonData = null;
    this.skeleton = null;
    this.stateData = null;
    this.state = null;
  }

  dispose() {
    this.stop();
    this.disposeContent();
    this.disposeRenderer();
    this.gl = null;
    this.mode = 'none';
  }
}
