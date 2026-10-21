// engine/engine-state.js —— 引擎实例的字段初值与少量只读派生
//
// 为什么单独放：SpineEngine 的字段有 40 多个（画布/上下文/相机/动画/外观/统计），
//   全部堆在 constructor 里会让主类读起来找不到"装载流程"这条主线。
//   初值集中在这里，字段含义一处可见，player 只负责行为。

/**
 * 引擎初值（不含 callbacks，由 player 合并）。
 * @returns {object}
 */
export function engineDefaults() {
  return {
    canvas: null,
    gl: null,
    mode: 'none',
    // —— 运行时与能力
    spine: null,
    runtimeVersion: null,
    caps: null,
    adapters: null,
    supportsStraightAlpha: true,
    // —— 模型内容
    atlas: null,
    textures: [],
    skeletonData: null,
    skeleton: null,
    stateData: null,
    state: null,
    currentModel: null,
    premultiplied: true,
    // —— 渲染器与相机
    renderer: null,
    renderTarget: null,
    rendererKind: 'none',
    rendererRuntime: null,
    camera: null,
    baseZoom: 1,
    userScale: 1,
    logicalW: 0,
    logicalH: 0,
    // —— fit / 外观档位
    fitMode: 'subject',          // subject | all | animation
    fitWarnedSubject: false,
    pmaMode: 'auto',             // auto | premultiplied | straight | upload
    pmaInfo: null,
    pmaDetection: null,
    gpuUnpack: false,
    textureFilter: 'linear',     // linear | nearest
    filterId: 'original',        // 12 个预设之一
    filterState: { saved: null, active: null },
    activeSkins: [],
    slotFilterKeywords: [],
    // 绘制期间被临时摘掉的插槽附件（画完立刻挂回；不销毁，保证可恢复）
    slotHiddenBackup: [],
    debugDraw: { bones: false, meshes: false, boundingBoxes: false, paths: false, points: false, regions: false, clipping: false, hulls: false },
    // —— 动画
    animationName: '',
    animDuration: 0,
    animTime: 0,
    loop: true,
    speed: 1,
    mixTime: 0.2,
    durations: {},
    // —— 循环与统计
    isPlaying: false,
    animationId: null,
    lastTime: 0,
    fpsFrames: 0,
    fpsLastTime: 0,
    currentFps: 0,
    fpsLimit: 60,
    dprMode: 'auto',
    isSoftware: false,
    rendererStr: '',
    antialias: false,
    pendingPresent: false,
    loadingModel: false,
    renderWarned: false,
  };
}

/**
 * 合并调试绘制开关（每次只传变化的键）。
 * @param {object} engine
 * @param {object} patch
 * @returns {object} 合并后的开关表
 */
export function mergeDebugDraw(engine, patch) {
  engine.debugDraw = { ...engine.debugDraw, ...(patch || {}) };
  return engine.debugDraw;
}

/**
 * 渲染器信息（含能力矩阵，便于排查"某能力在该运行时不可用"）。
 * @param {object} engine
 * @returns {object}
 */
export function rendererInfo(engine) {
  return {
    isSoftware: engine.isSoftware,
    rendererStr: engine.rendererStr,
    antialias: engine.antialias,
    // 运行时画不出来的调试绘制项（如 3.8/4.1 都没有 drawPoints）：如实暴露，别让面板假装能用。
    //   走确定性探测（探测调试渲染器实例上有没有对应属性），不依赖"是否已经画过帧"
    debugUnsupported: (() => {
      try {
        const rd = engine.adapters && engine.adapters.renderer;
        const sup = rd && typeof rd.debugSupport === 'function' ? rd.debugSupport(engine.renderTarget) : null;
        return sup && Array.isArray(sup.missing) ? sup.missing : [];
      } catch { return []; }
    })(),
    dpr: engine.getEffectiveDpr(window.devicePixelRatio || 1),
    runtimeVersion: engine.runtimeVersion,        // 仅展示，不参与行为
    capabilities: engine.caps ? engine.caps.matrix() : null,
    capabilityWarns: engine.caps ? engine.caps.warns.slice() : [],
    pma: engine.pmaInfo ? { mode: engine.pmaMode, effective: engine.pmaInfo.effectiveMode, blend: engine.pmaInfo.blendMode, degraded: engine.pmaInfo.degraded } : null,
    pmaDetection: engine.pmaDetection || null,
    gpuUnpack: !!engine.gpuUnpack,
    filter: engine.filterId,
    textureFilter: engine.textureFilter,
  };
}
