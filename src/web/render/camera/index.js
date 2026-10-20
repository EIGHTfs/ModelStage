// render/camera/index.js —— 相机统一入口
//
// 设计：外部只看到一套语义（档位 / 范围 / 锚点 / 复位 / 平移单位），差异全部收进 backend。
//   · 共用（本文件唯一实现）：`scale *= (1 + dir*STEP)`、clamp 到 limits、复位归 1、节流入口
//   · backend 只负责「读/写状态 + 怎么落地」：
//       getScale() / setScale(v) / pan(dx, dy) / resetView(keepScale)
//   · fit 是能力差异（Spine 有三种模式，Live2D 只有主体包围盒），因此不进本文件；
//     由 backend 自己暴露 `fit?()`，渲染器在需要时调用。
//
// 数值一律取自 `./constants.js`（本文件不出现裸数字）。

import { CAMERA, limitsFor } from './constants.js';

/**
 * 创建统一相机。
 *
 * @param {{
 *   kind?: 'spine'|'live2d',
 *   backend: {
 *     getScale: () => number|null,
 *     setScale: (v: number) => void,
 *     pan: (dx: number, dy: number) => void,
 *     resetView: (keepScale: boolean) => void,
 *   },
 *   log?: (message: string, level?: 'info'|'warn') => void,
 * }} options
 */
export function createCamera({ kind = 'spine', backend, log } = {}) {
  if (!backend || typeof backend.getScale !== 'function' || typeof backend.setScale !== 'function') {
    throw new Error('createCamera: backend 需要提供 getScale/setScale');
  }
  const limits = limitsFor(kind);

  /** 统一日志出口（缺省静默） */
  let logger = typeof log === 'function' ? log : null;
  function note(message, level = 'info') {
    if (logger) {
      try { logger(message, level); } catch { /* 日志失败不影响相机 */ }
    }
  }

  /** 夹取到 limits（唯一钳制点） */
  function clamp(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(limits.max, Math.max(limits.min, n));
  }

  /** 读当前缩放（backend 是唯一真相） */
  function scale() {
    try {
      const v = backend.getScale();
      return Number.isFinite(v) ? v : null;
    } catch { return null; }
  }

  /** 写缩放（夹取后交给 backend） */
  function zoomTo(value) {
    const v = clamp(value);
    if (v === null) return scale();
    try { backend.setScale(v); } catch (err) { note(`setScale 失败：${err && err.message}`, 'warn'); }
    return scale();
  }

  /**
   * 一档缩放（与引擎 `userScale *= 1 + t*STEP` 完全一致）。
   * @param {number} dir 方向：>0 放大、<0 缩小（只看符号）
   */
  function zoomStep(dir) {
    const cur = scale();
    if (!Number.isFinite(cur)) return null;
    const sign = dir > 0 ? 1 : dir < 0 ? -1 : 0;
    if (sign === 0) return cur;
    const next = clamp(cur * (1 + sign * CAMERA.STEP));
    if (next === null) return cur;
    try { backend.setScale(next); } catch (err) { note(`setScale 失败：${err && err.message}`, 'warn'); }
    note(`zoomStep(${sign}) ${cur.toFixed(4)} → ${next.toFixed(4)}（范围 ${limits.min}~${limits.max}）`);
    return scale();
  }

  /**
   * 平移：参数单位固定为「屏幕像素增量」，内部乘子由 backend 决定。
   * @param {number} dx
   * @param {number} dy
   */
  function panBy(dx, dy) {
    try { backend.pan(Number(dx) || 0, Number(dy) || 0); } catch (err) { note(`pan 失败：${err && err.message}`, 'warn'); }
    return null;
  }

  /**
   * 复位：先归 1（keepScale=false），再让 backend 重新适配。
   * @param {{keepScale?: boolean}} [opts]
   */
  function reset(opts = {}) {
    const keep = !!opts.keepScale;
    if (!keep) {
      try { backend.setScale(1); } catch { /* 忽略 */ }
    }
    try { backend.resetView(keep); } catch (err) { note(`resetView 失败：${err && err.message}`, 'warn'); }
    note(`reset（keepScale=${keep}）→ scale=${scale()}`);
    return scale();
  }

  /** 设置日志出口（交互层在 boot 时挂上） */
  function setLogger(fn) {
    logger = typeof fn === 'function' ? fn : null;
  }

  /** 只读信息（排查/断言用） */
  function info() {
    return { kind, limits: { ...limits }, step: CAMERA.STEP, scale: scale() };
  }

  return { kind, zoomStep, zoomTo, panBy, reset, scale, setLogger, note, info };
}

export default createCamera;
