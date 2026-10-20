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
    this.canvas = null;
    this.gl = null;
    this.mode = 'none';
    this.spine = null;
    this.runtimeVersion = null;
    this.atlas = null;
    this.textures = [];
    this.skeletonData = null;
    this.skeleton = null;
    this.stateData = null;
    this.state = null;
    this.renderer = null;
    this.rendererKind = 'none';
    this.fitMode = 'subject';        // 默认与旧引擎一致（主体适配）
    this.fitWarnedSubject = false;
    this.camera = null;
    this.baseZoom = 1;
    this.userScale = 1;
    this.logicalW = 0;
    this.logicalH = 0;
    this.dprMode = 'auto';
    this.isSoftware = false;
    this.rendererStr = '';
    this.antialias = false;
    this.isPlaying = false;
    this.animationId = null;
    this.lastTime = 0;
    this.fpsFrames = 0;
    this.fpsLastTime = 0;
    this.currentFps = 0;
    this.fpsLimit = 60;
    this.speed = 1;
    this.loop = true;
    this.mixTime = 0.2;
    this.filterId = 'original';
    this.debugDraw = { bones: false, meshes: false, boundingBoxes: false, paths: false, points: false, regions: false, clipping: false, hulls: false };
    this.slotFilterKeywords = [];
    this.pendingPresent = false;
    this.currentModel = null;
    // 运行时管理器：优先显式注入，否则复用页面已装好的单例（canvas.js 会先 installRuntimeManager）
    this.runtimeManager = callbacks.runtimeManager
      || (typeof window !== 'undefined' && window.Is && typeof window.Is.getInstance === 'function'
        ? window.Is.getInstance()
        : null);
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
    return {
      isSoftware: this.isSoftware,
      rendererStr: this.rendererStr,
      antialias: this.antialias,
      dpr: this.getEffectiveDpr(window.devicePixelRatio || 1),
      runtimeVersion: this.runtimeVersion,
      capabilities: this.caps ? this.caps.matrix() : null,
      capabilityWarns: this.caps ? this.caps.warns.slice() : [],
    };
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
    const model = await buildModel({ adapters: this.adapters, descriptor, log: (l, m, s) => this.log(l, m, s) });
    this.atlas = model.atlas;
    this.textures = model.textures;
    this.skeletonData = model.skeletonData;
    this.skeleton = model.skeleton;
    this.stateData = model.stateData;
    this.state = model.state;
    this.premultiplied = model.premultiplied;
    // 渲染器与运行时绑定：换了运行时（3.8 → 4.1）必须重建，否则会用旧版本的绘制器画新骨架（静默不出画）
    if (!this.renderer || this.rendererRuntime !== this.runtimeVersion) {
      this.disposeRenderer();
      this.createRenderer();
      this.rendererRuntime = this.runtimeVersion;
    }
    // fit 前必须先摆好姿态：未 updateWorldTransform 时 getBounds 可能返回空包围盒（4.x 上实测）
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
  }

  /** 建渲染器与相机（版本差异由 loader.buildRenderer 适配） */
  createRenderer() {
    const built = this.adapters.renderer.create();
    this.renderer = built.renderer;
    this.rendererKind = built.kind;
    this.camera = built.camera;
    this.renderTarget = built; // 适配器 draw() 需要的目标对象
    this.syncCameraViewport();
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

  getSkins() {
    const skins = (this.skeletonData && this.skeletonData.skins) || [];
    return skins.map((s) => s.name);
  }

  setSkins(list) {
    if (!this.skeleton || !this.skeletonData || !Array.isArray(list) || !list.length) return;
    try {
      const skin = this.skeletonData.findSkin ? this.skeletonData.findSkin(list[0]) : null;
      if (skin) this.skeleton.setSkin(skin);
      this.skeleton.setSlotsToSetupPose();
    } catch { /* 皮肤不存在时保持原样 */ }
  }

  setSlotFilter(keywords) {
    this.slotFilterKeywords = (Array.isArray(keywords) ? keywords : []).map((k) => String(k).trim().toLowerCase()).filter(Boolean);
  }

  setFilter(id) { this.filterId = String(id || 'original'); }
  getFilter() { return this.filterId; }

  setDebugDraw(patch) {
    this.debugDraw = { ...this.debugDraw, ...(patch || {}) };
  }

  /** B4 落地：现在明确告警而不是静默无操作 */
  rebuildTextures(pmaMode) {
    this.log('warn', `rebuildTextures(${pmaMode}) 在 B1 尚未实现（B4 补齐），当前保持原纹理`, 'loader');
  }

  getRuntimeVersion() { return this.runtimeVersion; }

  /** 释放当前模型内容（不销毁上下文） */
  disposeContent() {
    stopAndNull(this);
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

/** 内部小工具：停止并清空动画/骨架引用（拆出来保持方法体简短） */
function stopAndNull(engine) {
  engine.stop();
  engine.skeleton = null;
  engine.state = null;
}
