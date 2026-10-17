// engine/index.js —— 引擎唯一对外入口
//
// 只暴露 `SpineEngine`与工厂 `createEngine`；
//   `spine/canvas.js` 只依赖本文件，不直接 import 内部模块（分层约束）。
// B1 范围：装载/显示/帧循环/相机读写/动画切换/设置项最小实现；外观类（PMA/滤镜/纹理重建）在 B4。

import { SpineEngine } from './player.js';

export { SpineEngine };

/**
 * 工厂（等价 `new SpineEngine(opts)`，便于测试替换）。
 * @param {object} opts { log, onLoadComplete, onError, runtimeManager? }
 * @returns {SpineEngine}
 */
export function createEngine(opts = {}) {
  return new SpineEngine(opts);
}

export default createEngine;
