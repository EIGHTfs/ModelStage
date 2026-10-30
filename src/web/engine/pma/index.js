// engine/pma/index.js —— pma 子系统的对外出口
//
// 调用方仍从 `../engine/pma.js` 导入（那个文件只是转发到本目录），导入路径一个字都没变。
// 一条线读完的顺序：detect（源图是不是预乘）→ resolve（唯一决策点）→ upload / blend（两个执行层）。
export { atlasDeclaredPma, filenamePmaHint, detectPmaFromImageData, detectPma } from './detect.js';
export { resolvePmaInfo, shouldPremultiplyOnUpload, planTextureUpload, planBlend } from './resolve.js';
export { installBlendHooks, patchRuntimeBlendConverter, hasBlendHooks } from './blend.js';
export { uploadTextures } from './upload.js';
