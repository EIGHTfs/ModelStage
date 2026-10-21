// adapters/renderer.js —— 渲染器适配（SceneRenderer / SkeletonRenderer + 相机 + 绘制）
//
// 差异点：
//   · 3.x：`new SceneRenderer(canvas, gl)`，自带 camera，绘制走 drawSkeleton(skeleton, premultiplied)
//   · 4.x：可能只有 `SkeletonRenderer(gl)`，相机要自己 `new OrthoCamera(w, h)`，绘制走 draw(skeleton)
// 本适配器用能力矩阵选择，并在运行时校验方法引用（避免"方法存在但签名不同"）。

/**
 * @param {{caps: object, canvas: HTMLCanvasElement, gl: WebGLRenderingContext,
 *          size: {w: number, h: number}, onWarn?: Function}} ctx
 */
export function createRendererAdapter({ caps, canvas, gl, size, onWarn }) {
  const R = caps.renderer;

  /** 建渲染器（同时给出相机） */
  function create() {
    if (R.kind === 'scene') return createScene();
    if (R.kind === 'skeleton') return createSkeleton();
    throw new Error('运行时既没有 SceneRenderer 也没有 SkeletonRenderer');
  }

  function createScene() {
    // 3.x 需要 canvas；个别版本只要 gl —— 用构造参数个数探测，不看版本号
    const renderer = R.sceneArity >= 2 ? new R.sceneCtor(canvas, gl) : new R.sceneCtor(gl);
    const camera = renderer.camera || (R.orthoCtor ? new R.orthoCtor(size.w, size.h) : null);
    if (!renderer.camera && camera) onWarn && onWarn('renderer：SceneRenderer 未自带相机，已改用 OrthoCamera');
    return { renderer, camera, kind: 'scene' };
  }

  function createSkeleton() {
    const renderer = new R.skeletonCtor(gl);
    const camera = R.orthoCtor ? new R.orthoCtor(Math.max(1, size.w), Math.max(1, size.h)) : null;
    if (!camera) onWarn && onWarn('renderer：没有 OrthoCamera，绘制可能不可见');
    return { renderer, camera, kind: 'skeleton' };
  }

  /**
   * 画一帧。
   * @param {{renderer: object, kind: string}} target create() 的返回值
   * @param {object} skeleton
   * @param {boolean} premultiplied
   */
  function draw(target, skeleton, premultiplied) {
    const r = target && target.renderer;
    if (!r || !skeleton) return false;
    try {
      if (typeof r.begin === 'function') r.begin();
      try {
        if (typeof r.drawSkeleton === 'function') {
          // 二参是否被接受用声明参数个数判断（3.x: 2；老版本可能只有 1）
          if (r.drawSkeleton.length >= 2) r.drawSkeleton(skeleton, premultiplied === true);
          else r.drawSkeleton(skeleton);
        } else if (typeof r.draw === 'function') {
          r.draw(skeleton);
        } else {
          onWarn && onWarn('renderer：既没有 drawSkeleton 也没有 draw，无法绘制');
          return false;
        }
      } finally {
        if (typeof r.end === 'function') r.end();
      }
      return true;
    } catch (e) {
      onWarn && onWarn(`renderer.draw 失败：${e.message}`);
      return false;
    }
  }

  /**
   * 取（或首次创建）调试渲染器。
   * 优先用渲染器自带的 skeletonDebugRenderer；否则用能力矩阵探测到的构造器自己建一个。
   * 为什么要缓存：调试渲染器持有 GPU 资源，每帧新建会持续泄漏。
   * @param {{renderer: object, camera?: object}} target create() 的返回值
   */
  function ensureDebugRenderer(target) {
    const r = target && target.renderer;
    if (!r) return null;
    if (r.skeletonDebugRenderer) return r.skeletonDebugRenderer;
    if (target.debugRenderer !== undefined && target.debugRenderer !== null) return target.debugRenderer;
    const Ctor = R.debugCtor;
    if (!Ctor) return null;
    try {
      target.debugRenderer = new Ctor(gl);
      return target.debugRenderer;
    } catch (e) {
      onWarn && onWarn(`调试渲染器创建失败：${e.message}`);
      target.debugRenderer = null;
      return null;
    }
  }

  /**
   * 八类开关 → SkeletonDebugRenderer 的 draw* 属性。
   * 属性名按运行时实际存在才写（不同版本命名有差异），映射口径照旧引擎：
   *   bones→drawBones  regions→drawRegionAttachments  boundingBoxes→drawBoundingBoxes
   *   hulls→drawMeshHull  meshes→drawMeshTriangles  paths→drawPaths
   *   points→drawPoints  clipping→drawClipping
   * @param {object} dbg 调试渲染器
   * @param {object} flags { bones, meshes, ... }
   */
  function applyDebugFlags(dbg, flags) {
    if (!dbg) return [];
    const f = flags || {};
    const map = {
      drawBones: f.bones,
      drawRegionAttachments: f.regions,
      drawBoundingBoxes: f.boundingBoxes,
      drawMeshHull: f.hulls,
      drawMeshTriangles: f.meshes,
      drawPaths: f.paths,
      drawPoints: f.points,
      drawClipping: f.clipping,
    };
    const missing = [];
    for (const [prop, on] of Object.entries(map)) {
      // 属性不存在 = 该运行时的调试渲染器不支持这一类（例如 3.8/4.1 都没有 drawPoints），
      //   记下来交给上层如实上报，而不是静默吞掉让"点了没反应"
      if (prop in dbg) dbg[prop] = !!on;
      else if (on) missing.push(prop);
    }
    return missing;
  }

  /**
   * 调试绘制能力探测（确定性，不依赖"是否已经画过一帧"）。
   * 为什么要它：面板要如实显示哪几类画不出来，若靠绘制时记录，暂停/未出帧时就会误报"都支持"。
   * @param {object} target create() 的返回值
   * @returns {{available: boolean, missing: string[]}} missing 为运行时没有对应属性的项
   */
  function debugSupport(target) {
    const dbg = ensureDebugRenderer(target);
    if (!dbg) return { available: false, missing: [] };
    const props = ['drawBones', 'drawRegionAttachments', 'drawBoundingBoxes',
      'drawMeshHull', 'drawMeshTriangles', 'drawPaths', 'drawPoints', 'drawClipping'];
    return { available: true, missing: props.filter((p) => !(p in dbg)) };
  }

  /**
   * 画一帧调试层。全关时不触碰 GL（避免"开关关了还在画"的假象）。
   * @param {object} target create() 的返回值
   * @param {object} skeleton
   * @param {object} flags 八类开关
   * @param {boolean} premultiplied 与主绘制同口径
   * @returns {boolean} 是否真的画了
   */
  function drawDebug(target, skeleton, flags, premultiplied) {
    const any = !!flags && Object.keys(flags).some((k) => flags[k]);
    if (!any || !skeleton) return false;
    const r = target && target.renderer;
    if (!r) return false;
    const dbg = ensureDebugRenderer(target);
    if (!dbg) return false;
    const missing = applyDebugFlags(dbg, flags);
    if (missing.length) {
      // 同一个缺失项只告警一次（每帧都刷会把日志冲爆）
      target.debugMissing = missing;
      if (!target.debugMissingWarned) {
        target.debugMissingWarned = {};
      }
      for (const prop of missing) {
        if (target.debugMissingWarned[prop]) continue;
        target.debugMissingWarned[prop] = true;
        onWarn && onWarn(`调试渲染器没有 ${prop}：该运行时画不出这一类调试绘制`);
      }
    }
    try {
      if (typeof r.begin === 'function') r.begin();
      try {
        if (typeof r.drawSkeletonDebug === 'function') {
          // 渲染器自带调试绘制入口（3.x/4.x 都是这个名），二参是是否预乘
          if (r.drawSkeletonDebug.length >= 2) r.drawSkeletonDebug(skeleton, premultiplied === true);
          else r.drawSkeletonDebug(skeleton);
        } else if (typeof dbg.draw === 'function') {
          // 兜底：自己调调试渲染器的 draw，需要把相机的投影矩阵交给它
          const cam = target.camera;
          if (cam && cam.projection && 'projection' in dbg) dbg.projection = cam.projection;
          dbg.draw(skeleton);
        } else {
          onWarn && onWarn('调试渲染器既无 drawSkeletonDebug 也无 draw，调试绘制不可用');
          return false;
        }
      } finally {
        if (typeof r.end === 'function') r.end();
      }
      return true;
    } catch (e) {
      onWarn && onWarn(`renderer.drawDebug 失败：${e.message}`);
      return false;
    }
  }

  /** 释放渲染器（有的版本没有 dispose） */
  function dispose(target) {
    const r = target && target.renderer;
    const own = target && target.debugRenderer;
    // 只释放自己建的（渲染器自带的 skeletonDebugRenderer 由渲染器自己回收）
    if (own && own !== r && typeof own.dispose === 'function') {
      try { own.dispose(); } catch { /* 忽略 */ }
    }
    if (target) target.debugRenderer = null;
    if (r && typeof r.dispose === 'function') {
      try { r.dispose(); } catch { /* 忽略 */ }
    }
  }

  /** 相机视口跟随（缺 setViewport 时静默跳过） */
  function syncViewport(camera, w, h) {
    if (!camera || typeof camera.setViewport !== 'function') return false;
    try { camera.setViewport(w, h); return true; } catch { return false; }
  }

  return { create, draw, drawDebug, debugSupport, dispose, syncViewport };
}
