// engine/gl-driver.js —— 上下文/尺寸/DPR 的驱动逻辑（从 player 拆出，控制单类规模）
//
// 这些方法只操作"引擎实例上的 GL 状态"，与装载/动画无关，放这里便于单独演进。

import { createContext, effectiveDpr, applyPixelSize } from './gl.js';
import * as cameraOps from './camera-adapter.js';

/** 建上下文；失败返回 false（调用方据此判定环境不可渲染） */
export function initEngine(engine, canvas, opts = {}) {
  engine.canvas = canvas;
  engine.antialias = opts.antialias === true;
  const { gl, isSoftware, rendererStr } = createContext(canvas, { antialias: engine.antialias });
  if (!gl) {
    engine.log('error', '当前浏览器不支持 WebGL，无法渲染 Spine 动画。', 'renderer');
    engine.mode = 'none';
    return false;
  }
  engine.gl = gl;
  engine.mode = 'webgl';
  engine.isSoftware = isSoftware;
  engine.rendererStr = rendererStr;
  engine.logicalW = canvas.clientWidth || canvas.width;
  engine.logicalH = canvas.clientHeight || canvas.height;
  refreshResolution(engine);
  engine.log('info', `WebGL 初始化成功 (canvas=${canvas.width}x${canvas.height}, css=${engine.logicalW}x${engine.logicalH})`, 'renderer');
  return true;
}

/** 生效 DPR（auto：软件渲染钳 1、否则上限 2） */
export function effectiveDprOf(engine, deviceDpr) {
  return effectiveDpr(engine.dprMode, engine.isSoftware, deviceDpr);
}

/** 按逻辑尺寸 + DPR 重设 backing store */
export function refreshResolution(engine) {
  if (!engine.canvas) return;
  if (engine.logicalW <= 0 || engine.logicalH <= 0) return;
  const dpr = effectiveDprOf(engine, window.devicePixelRatio || 1);
  applyPixelSize(engine.canvas, engine.gl, { logicalW: engine.logicalW, logicalH: engine.logicalH, dpr });
  cameraOps.syncCamera(engine);
}

/** 纯尺寸更新（画布尺寸由外部改动后调用） */
export function resizeEngine(engine, w, h) {
  if (!engine.canvas) return;
  engine.logicalW = w || engine.canvas.clientWidth;
  engine.logicalH = h || engine.canvas.clientHeight;
  refreshResolution(engine);
}

/** DPR 模式 */
export function setDprMode(engine, mode) {
  engine.dprMode = mode;
  refreshResolution(engine);
  requestAnimationFrame(() => refreshResolution(engine));
}
