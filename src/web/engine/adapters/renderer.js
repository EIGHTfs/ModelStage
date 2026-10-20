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

  /** 释放渲染器（有的版本没有 dispose） */
  function dispose(target) {
    const r = target && target.renderer;
    if (r && typeof r.dispose === 'function') {
      try { r.dispose(); } catch { /* 忽略 */ }
    }
  }

  /** 相机视口跟随（缺 setViewport 时静默跳过） */
  function syncViewport(camera, w, h) {
    if (!camera || typeof camera.setViewport !== 'function') return false;
    try { camera.setViewport(w, h); return true; } catch { return false; }
  }

  return { create, draw, dispose, syncViewport };
}
