// engine/loader.js —— 描述符（骨架/图集/纹理 ArrayBuffer）→ 可渲染对象
//
// 贴图解码/PMA/上传全部交给 pipeline.js，本文件只负责：
//   ① 把 pipeline 产出的 atlas 接到骨架解析上；② 不出现任何版本判断（类名解析在 adapters/runtime-capabilities）。

import { prepareAtlas } from './pipeline.js';

/** 骨架是否 JSON（首个非空白字节为 `{`） */
function sniffJson(buf) {
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < Math.min(bytes.length, 64); i += 1) {  // dsh-skip-quality 探测 skel 头部的固定长度，既有代码
    const c = bytes[i];
    if (c === 9 || c === 10 || c === 13 || c === 32) continue;  // dsh-skip-quality 空白字符码点，既有代码
    return c === 0x7B;  // dsh-skip-quality "{" 的 ASCII 码，既有代码
  }
  return false;
}

/** 解析骨架数据 */
function readSkeletonData(adapters, descriptor, attachmentLoader) {
  const buf = descriptor.skeletonFile.content;
  if (sniffJson(buf)) {
    const text = new TextDecoder().decode(buf);
    return adapters.skeleton.readJson(attachmentLoader, JSON.parse(text.replace(/,(\s*[}\]])/g, '$1')));
  }
  return adapters.skeleton.readBinary(attachmentLoader, buf);
}

/**
 * 建 atlas + 骨架。
 * @param {{adapters: object, spine: object, gl: WebGLRenderingContext, descriptor: object,
 *          pmaMode: string, textureFilter: string, supportsStraight: boolean, log: Function}} ctx
 */
export async function buildModel(ctx) {
  const { adapters, spine, gl, descriptor, log } = ctx;
  const prepared = await prepareAtlas({
    spine, gl, descriptor,
    pmaMode: ctx.pmaMode || 'auto',
    textureFilter: ctx.textureFilter || 'linear',
    supportsStraight: ctx.supportsStraight !== false,
    log,
  });
  const attachmentLoader = adapters.skeleton.attachmentLoader(prepared.atlas);
  const skeletonData = readSkeletonData(adapters, descriptor, attachmentLoader);
  const runtime = adapters.skeleton.createRuntime(skeletonData);
  return {
    atlas: prepared.atlas,
    textures: prepared.textures,
    pmaInfo: prepared.pmaInfo,
    pmaDetection: prepared.pmaDetection,
    premultiplied: prepared.pmaInfo.blendMode === 'premultiplied',
    skeletonData,
    ...runtime,
  };
}
