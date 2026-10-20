// adapters/index.js —— 适配器装配：能力矩阵 → 各组适配器
//
// 业务层（player / loader / render-frame）只拿这里的对象，不直接摸 spine 库 API；
// 于是"换运行时版本"只影响本目录，业务代码不含任何版本判断。

import { createTextureAdapter } from './texture.js';
import { createAtlasAdapter } from './atlas.js';
import { createSkeletonAdapter } from './skeleton.js';
import { createRendererAdapter } from './renderer.js';

/**
 * @param {{spine: object, caps: object, gl: WebGLRenderingContext, canvas: HTMLCanvasElement,
 *          size: {w: number, h: number}, onWarn?: Function}} ctx
 * @returns {{texture: object, atlas: object, skeleton: object, renderer: object, caps: object}}
 */
export function createAdapters({ spine, caps, gl, canvas, size, onWarn }) {
  const texture = createTextureAdapter({ caps, gl, onWarn });
  const atlas = createAtlasAdapter({ caps, texture, onWarn });
  const skeleton = createSkeletonAdapter({ caps, spine, onWarn });
  const renderer = createRendererAdapter({ caps, canvas, gl, size, onWarn });
  return { texture, atlas, skeleton, renderer, caps };
}
