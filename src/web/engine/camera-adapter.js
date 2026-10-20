// engine/camera-adapter.js —— 引擎侧相机适配（只读写引擎状态，不做策略）
//
// 分层约束：**档位/范围/夹取属于 `render/camera/index.js`（唯一钳制点）**；
//   本文件只负责"把数值落到 spine 相机上"，因此这里出现的 MIN/MAX 仅作最后一道保险，
//   正常调用链不会依赖它（旧引擎在 applyZoom 内部夹取，容易与统一入口形成双重钳制）。

import { CAMERA } from '../render/camera/constants.js';
import { computeFit, computeSubjectBounds, clampSubjectBox, intersectBox } from './fit.js';

/** 读当前缩放（userScale，越大越放大） */
export function getScale(engine) {
  return engine.userScale;
}

/**
 * 写缩放。**这里不做夹取**：范围钳制只允许发生在 `render/camera`（唯一钳制点），
 * 引擎再夹一次会与上层形成双重钳制，手感会随调用路径漂移。
 * @param {object} engine
 * @param {number} value
 */
export function setScale(engine, value) {
  const n = Number(value);
  engine.userScale = Number.isFinite(n) && n > 0 ? n : 1;
  applyUserScale(engine);
}

/** 一档缩放：scale *= 1 + dir*STEP */
export function zoomStep(engine, dir) {
  const factor = 1 + (Number(dir) || 0) * CAMERA.STEP;
  setScale(engine, (engine.userScale || 1) * factor);
}

/**
 * 相机收尾：同步视口并重算矩阵。
 * 为什么必须 update：spine 的 OrthoCamera 改了 zoom/viewport 后不会自动重算投影矩阵，
 *   不调用就会用上一次（或默认 800×600）的矩阵渲染 —— 表现为"模型忽大忽小"，且只和旧引擎差几倍。
 * @param {object} engine
 */
export function syncCamera(engine) {
  const cam = engine.camera;
  if (!cam) return;
  try {
    if (typeof cam.setViewport === 'function') cam.setViewport(engine.logicalW, engine.logicalH);
    else {
      if ('viewportWidth' in cam) cam.viewportWidth = engine.logicalW;
      if ('viewportHeight' in cam) cam.viewportHeight = engine.logicalH;
    }
    if (typeof cam.update === 'function') cam.update();
  } catch { /* 相机更新失败不阻断渲染 */ }
}

/** 把 userScale 落到相机（zoom 越小画面越大 ⇒ 取倒数） */
export function applyUserScale(engine) {
  if (!engine.camera) return;
  engine.camera.zoom = engine.baseZoom / (engine.userScale || 1);
  syncCamera(engine);
}

/**
 * 平移：屏幕像素 → 相机世界位移。
 * 公式与旧引擎逐字一致：`s = (camera.zoom ?? camera.scale ?? 1) * 2`，
 *   `position.x -= dx * flipX * s`，`position.y += dy * flipY * s`，随后 update。
 * 为什么必须照抄：这里乘 2 与 flip 处理是已验收手感的一部分，换成"按 DPR 换算"会让拖动速度不同。
 * @param {object} engine
 * @param {number} dx
 * @param {number} dy
 */
export function pan(engine, dx, dy) {
  const cam = engine.camera;
  if (!cam || !cam.position) return;
  const zoom = cam.zoom !== undefined ? cam.zoom : (cam.scale !== undefined ? cam.scale : 1);
  const s = zoom * 2;
  const fx = engine.flipX ? -1 : 1;
  const fy = engine.flipY ? -1 : 1;
  cam.position.x -= (Number(dx) || 0) * fx * s;
  cam.position.y += (Number(dy) || 0) * fy * s;
  if (typeof cam.update === 'function') cam.update();
  if (typeof engine.requestRender === 'function') engine.requestRender();
}

/**
 * 仅当 subject 明显超出 full 时取交（超出判定用相对容差，避免浮点末位抖动触发）。
 * @param {object} subject
 * @param {object} full
 */
function trimOnlyIfOutside(subject, full) {
  if (!full) return subject;
  const epsW = Math.max(1e-6 * Math.abs(subject.w), 1e-9);
  const epsH = Math.max(1e-6 * Math.abs(subject.h), 1e-9);
  const outside = subject.w > full.w + epsW || subject.h > full.h + epsH;
  return outside ? intersectBox(subject, full) : subject;
}

/** 两种包围盒求并集 */
function unionBox(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** 面积（用于 subject 可信度判定） */
function area(b) { return b ? b.w * b.h : 0; }

/** animation 模式：对每个动作采样若干帧取并集（最多 120 帧，避免长时间卡顿） */
export function animationBounds(engine) {
  const anims = (engine.skeletonData && engine.skeletonData.animations) || [];
  let acc = null;
  let budget = 120;
  for (const anim of anims) {
    if (budget <= 0) break;
    const duration = Number(anim.duration) || 0;
    const samples = Math.min(12, Math.max(2, Math.ceil(duration * 6)), budget);
    for (let i = 0; i < samples; i += 1) {
      try {
        if (engine.skeleton.setToSetupPose) engine.skeleton.setToSetupPose();
        if (typeof anim.apply === 'function') anim.apply(engine.skeleton, 0, (duration * (i + 0.5)) / samples, false, null, 1, 0, 0);
        engine.skeleton.updateWorldTransform(2);
      } catch { /* 单个动作采样失败继续 */ }
      acc = unionBox(acc, engine.adapters ? engine.adapters.skeleton.bounds(engine.skeleton) : null);
      budget -= 1;
    }
  }
  return acc;
}

/**
 * 取当前 fit 模式下的包围盒。
 * subject：主体包围盒可信（面积在全量 0.1~8 倍之间）就用它，否则回落全量；
 * all：全量；animation：动作采样并集。
 */
export function pickBounds(engine) {
  const mode = engine.fitMode || 'subject';
  const full = engine.adapters ? engine.adapters.skeleton.bounds(engine.skeleton) : null;
  if (mode === 'all') return full;
  if (mode === 'animation') return animationBounds(engine) || full;
  const rawSubject = computeSubjectBounds({ skeleton: engine.skeleton, skeletonData: engine.skeletonData });
  // 只有"显著超出整体"时才取交：两个包围盒来自不同顶点路径，端点常有 1e-6 量级差异，
  //   无条件求交会把 subject 削掉极小量 → baseZoom 末位与旧引擎不一致（实测 1 ULP）。
  const subject = rawSubject ? trimOnlyIfOutside(rawSubject, full) : null;
  if (!subject) return full;
  const n = area(subject);
  const o = area(full);
  const trustworthy = !(o > 0) || (n >= o * 0.1 && n <= o * 8);
  if (!trustworthy) {
    if (!engine.fitWarnedSubject) {
      engine.fitWarnedSubject = true;
      engine.log('warn', `subject 包围盒不可信（面积比 ${(n / (o || 1)).toFixed(2)}），已回落整体包围盒`, 'camera');
    }
    return full;
  }
  return clampSubjectBox(subject) || full;
}

/** 按当前 fit 模式重新 fit */
export function applyFit(engine) {
  // 与旧引擎同序：先摆 setup pose + 更新世界变换，再在"全部皮肤合并"形态下测量
  if (engine.adapters) {
    engine.adapters.skeleton.setupPose(engine.skeleton);
    engine.adapters.skeleton.updateWorldTransform(engine.skeleton);
  }
  const bounds = engine.adapters && engine.adapters.skeleton.withAllSkins
    ? engine.adapters.skeleton.withAllSkins({ skeleton: engine.skeleton, skeletonData: engine.skeletonData }, () => pickBounds(engine))
    : pickBounds(engine);
  const fit = computeFit({ bounds, viewW: engine.logicalW, viewH: engine.logicalH });
  if (!fit) return null;
  engine.baseZoom = fit.baseZoom;
  if (engine.camera && engine.camera.position) engine.camera.position.set(fit.centerX, fit.centerY, 0);
  applyUserScale(engine);
  syncCamera(engine);
  // 与旧引擎同格式的 fit 日志（便于两边逐项对照 bbox / zoom / viewport）
  try {
    const b = bounds || { x: 0, y: 0, w: 0, h: 0 };
    engine.log('info', `相机 fit[${mode}]: bbox=[${b.x.toFixed(1)}, ${b.y.toFixed(1)}] ${b.w.toFixed(1)}x${b.h.toFixed(1)}, `
      + `center=(${fit.centerX.toFixed(1)}, ${fit.centerY.toFixed(1)}), vw=${engine.logicalW}, vh=${engine.logicalH}, `
      + `zoom=${Number(engine.camera && engine.camera.zoom ? engine.camera.zoom : 0).toFixed(4)}`, 'camera');
  } catch { /* 日志失败不影响相机 */ }
  return fit;
}

/** 复位：缩放归 1 并重新 fit */
export function resetCamera(engine) {
  engine.userScale = 1;
  applyFit(engine);
}

/** 支持的 fit 模式 */
export const FIT_MODES = ['subject', 'all', 'animation'];

/**
 * 切换 fit 模式（切换后立即重新适配）。
 * @param {object} engine
 * @param {string} mode
 * @returns {boolean}
 */
export function setFitMode(engine, mode) {
  const next = String(mode || '').toLowerCase();
  if (!FIT_MODES.includes(next)) {
    engine.log('warn', `未知的 fit 模式：${mode}（支持 ${FIT_MODES.join('/')}）`, 'camera');
    return false;
  }
  if (engine.fitMode === next) return true;
  engine.fitMode = next;
  if (engine.skeleton) resetCamera(engine);
  return true;
}

/** 读当前 fit 模式 */
export function getFitMode(engine) {
  return engine.fitMode || 'subject';
}
