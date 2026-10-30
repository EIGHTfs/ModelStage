// engine/pma/upload.js —— 上传：按 decision 把贴图传到 GPU（**全项目唯一的纹理上传路径**）
//
// 上传口径只从 resolve.js 的 shouldPremultiplyOnUpload 派生，本文件不自己判断"要不要乘"。
// 关键：预乘要在 texImage2D 那一下由浏览器完成，**不经 2D canvas 中转** ——
//   2D canvas 的后备存储是预乘的，texImage2D(canvas) 在 UNPACK=false 时会把 alpha 除回去
//   （un-premultiply）⇒ "CPU 先乘一遍"白做，上传到 GPU 仍是直通数据。
//   所以要么用 Uint8Array 源、要么用原图 + UNPACK 开关，才能真正控制上传字节。

import { planTextureUpload } from './resolve.js';

/**
 * 按 PMA 口径上传贴图。
 * pma 语义：`pma = true` 表示**这张图（现在）已经是预乘的**。
 * @param {{gl: WebGLRenderingContext, GLTextureCtor: Function|null, entries: Map,
 *          effectiveMode: string, needPremultiply: boolean, textureFilter: string,
 *          log?: Function, onUpload?: Function}} ctx
 * @returns {Promise<Map<string, object>>} 页名 → 纹理对象
 */
export async function uploadTextures(ctx) {
  const { gl, GLTextureCtor, entries, effectiveMode, needPremultiply, textureFilter, log = () => {}, onUpload } = ctx;
  // 上传口径整份来自 decision（不在这里二次判断），见 resolve.js 的 planTextureUpload
  const { unpack, pmaFlag } = planTextureUpload({ effectiveMode, needPremultiply });
  const plan = {
    unpack,
    pmaFlag,
    // 诊断标签用"走的哪条路"（upload / straight / premultiplied），不能拿 pmaFlag 代替它：
    //   pmaFlag 回答的是"上传后数据是不是预乘"（upload 路径也是 true），两者语义不同。
    mode: effectiveMode,
    textureFilter,
    log,
    onUpload,
  };
  const out = new Map();
  for (const [pageName, entry] of (entries || new Map())) {
    const tex = uploadOnePage(gl, GLTextureCtor, pageName, entry, plan);
    if (tex) out.set(pageName, tex);
  }
  if (out.size === 0) throw new Error('没有成功上传任何贴图到 GPU，无法创建 TextureAtlas');
  return out;
}

/**
 * 上传单页（GLTexture 优先，失败回退手动上传）。
 * @returns {object|null} 纹理对象
 */
function uploadOnePage(gl, GLTextureCtor, pageName, entry, plan) {
  const source = entry.img || entry.canvas || null;   // 原图（或透明占位画布）直传
  if (!source) return null;
  if (GLTextureCtor) {
    const viaCtor = uploadViaGLTexture(gl, GLTextureCtor, pageName, entry, source, plan);
    if (viaCtor) return viaCtor;
  }
  return uploadManually(gl, pageName, entry, source, plan);
}

/** 用运行时的 GLTexture 上传（构造期即完成上传） */
function uploadViaGLTexture(gl, GLTextureCtor, pageName, entry, source, plan) {
  const prevUnpack = readUnpack(gl);
  try {
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, plan.unpack);
    const tex = new GLTextureCtor(gl, source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, prevUnpack);
    applyTextureFilterLike(gl, tex, plan.textureFilter);
    notify(plan, { page: pageName, mode: plan.mode,
      unpack: plan.unpack, source: entry.img ? 'img' : 'canvas', path: 'GLTexture', texHasPma: 'pma' in tex });
    return tex;
  } catch (e) {
    plan.log('warn', `创建 GLTexture 失败 ${pageName}: ${(e && e.message) || e}，回退手动上传`, 'loader');
    try { gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, prevUnpack); } catch { /* 忽略 */ }
    return null;
  }
}

/** 回退：手动 createTexture + texImage2D（同样按 plan.unpack 决定是否让浏览器乘） */
function uploadManually(gl, pageName, entry, source, plan) {
  const tex = gl.createTexture();
  if (!tex) return null;
  const prevUnpack = readUnpack(gl);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, plan.unpack);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, prevUnpack);
  const filterMode = plan.textureFilter === 'nearest' ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterMode);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterMode);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  notify(plan, { page: pageName, mode: plan.mode,
    unpack: plan.unpack, source: 'manual', path: 'manual', texHasPma: false });
  return {
    _image: source, getImage() { return this._image; },
    setFilters(min, mag) {
      try {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
      } catch { /* 忽略 */ }
    },
    setWraps() {}, dispose() { try { gl.deleteTexture(tex); } catch { /* 忽略 */ } }, texture: tex,
  };
}

/** 读当前 UNPACK 状态（拿不到返回 false） */
function readUnpack(gl) {
  try { return gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL); } catch { return false; }
}

/** 观测回调（默认打到 debug 日志；不参与逻辑） */
function notify(plan, detail) {
  try {
    if (typeof plan.onUpload === 'function') plan.onUpload(detail);
    else plan.log('debug', 'pma.upload', detail);
  } catch { /* 观测不能影响上传 */ }
}

/** 过滤参数（与 textures.js 的 applyTextureFilter 等价；此处内联以避免循环依赖） */
function applyTextureFilterLike(gl, texture, mode) {
  const filterMode = mode === 'nearest' ? gl.NEAREST : gl.LINEAR;
  try {
    if (typeof texture.setFilters === 'function') texture.setFilters(filterMode, filterMode);
    else {
      gl.bindTexture(gl.TEXTURE_2D, texture.texture || texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterMode);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterMode);
    }
  } catch { /* 过滤设置失败不影响可用性 */ }
}
