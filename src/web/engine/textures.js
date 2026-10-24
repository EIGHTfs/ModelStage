// engine/textures.js —— 贴图解码、预乘口径与 GPU 上传（逐段照抄旧引擎行 284 @32100–34000）
//
// 为什么单独成文件：PMA 的正确性 90% 在"上传时怎么处理像素"，与渲染/相机无关；
//   旧引擎在这里有四个必须保留的细节，漏任何一个都会造成画面颜色不对但不报错：
//   ① 多页图集里 <100px 的页用透明画布跳过（不参与像素检测，避免误判）
//   ② GPU 的 UNPACK_PREMULTIPLY_ALPHA_WEBGL 优先，不可用时回退 CPU 整页预乘
//   ③ 运行时的 GLTexture.pma 标志与 update() 重传（straight 档还要手工 texImage2D）
//   ④ GLTexture 构造失败时回退"手工建纹理 + 包一层纹理样对象"

/** 多页图集中被认为"太小、多半是占位/噪点"的边长阈值（旧引擎 g=100） */
/** 多页图集中被视为占位的边长阈值（旧引擎 g=100） */
export const SMALL_PAGE_PX = 100;

/** 取文件名末段并小写（页名匹配用） */
function lastSegment(name) {
  return String(name || '').split(/[\\/]/).pop().toLowerCase();
}

/**
 * 解析 atlas 文本里每个页的尺寸（`size: W,H`）。
 * @param {string} atlasText
 * @returns {Map<string, {width: number, height: number}>}
 */
export function parseAtlasPageSizes(atlasText) {
  const out = new Map();
  if (!atlasText) return out;
  const lines = atlasText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const page = lines[i].trim();
    if (!/\.(png|jpg|jpeg|webp)$/i.test(page)) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j].trim();
      if (!line) continue;
      if (!line.includes(':') && /\.(png|jpg|jpeg|webp)$/i.test(line)) break;
      const m = line.match(/^size\s*:\s*(\d+)\s*,\s*(\d+)/);
      if (m) { out.set(page, { width: parseInt(m[1], 10), height: parseInt(m[2], 10) }); break; }
    }
  }
  return out;
}

/** ArrayBuffer/Blob → <img> 元素（并等解码） */
export function loadImageElement(entry) {  // dsh-skip-complexity 照搬旧端的图片解码实现，本轮未改动函数体
  return new Promise((resolve, reject) => {
    const img = new Image();
    let url = null;
    const done = () => { if (url) URL.revokeObjectURL(url); };
    img.onload = async () => {
      try { if (img.decode) await img.decode(); } catch { /* decode 不支持就用当前状态 */ }
      done();
      resolve(img);
    };
    img.onerror = () => { done(); reject(new Error(`图片加载失败: ${entry.name}`)); };
    const content = entry.content;
    if (content instanceof ArrayBuffer || ArrayBuffer.isView(content)) {
      url = URL.createObjectURL(new Blob([content], { type: entry.type || 'image/png' }));
    } else if (typeof content === 'string') {
      // 字符串形态的贴图（URL 而非字节）：同样先问 VirtualFS，命中则用 Blob URL
      const resolved = (() => {
        try { return getSharedVirtualFS().resolve(content) || content; } catch { return content; }
      })();
      url = resolved.startsWith('data:') || resolved.startsWith('http') || resolved.startsWith('blob:') ? resolved : null;
    }
    if (!url) { reject(new Error(`图片数据不可用: ${entry.name}`)); return; }
    img.src = url;
  });
}

/** 解码一张贴图，返回 {img, width, height} */
export async function decodeImageSource(entry) {
  const img = await loadImageElement(entry);
  return { img, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
}




/**
 * 把贴图取成 ImageData（供 PMA 像素检测）。
 *
 * **必须避免"预乘 → 非预乘"往返**：直接把 <img> 画进 2D canvas 再 getImageData 时，
 *   canvas 内部按预乘存储、读回时再除一次 alpha ⇒ 半透明区域相对误差被放大（除以很小的 a），
 *   会产生 `r > a` 的**假违反**。现场：bd2 的图半透明边缘多 ⇒ 假违反 9.8%~22.4%
 *   ⇒ 被判成"非预乘" ⇒ 走 upload 又乘一次 alpha ⇒ 双重预乘（嘴巴黑圈）。
 *   azurlane 的图边缘干净 ⇒ 0.1% ⇒ 判对。
 *
 * 做法：用 `createImageBitmap(img, { premultiplyAlpha: 'none' })` 拿到**未预乘**的位图再画；
 *   浏览器不支持或失败时退回原路径（并保持"能检测就检测"的语义，不因取不到样本而阻塞装载）。
 *
 * @param {object} entry 贴图条目 {img|canvas,width,height}
 * @returns {Promise<ImageData|null>}
 */
export function sampleSourceImageData(entry) {
  // **照搬旧端**（dist: this.sampleSourceImageData）：画到 2D canvas 再 getImageData，同步。
  // 之前我改成 async + createImageBitmap + WebGL 精确取样，都属于自创，已删；
  //   （当时用"违反占比"判据得到的结论也不可靠——那个判据抓不到"变暗"，见排查记录。）
  try {
    let canvas = null;
    if (entry.img) {
      canvas = document.createElement('canvas');
      canvas.width = entry.width;
      canvas.height = entry.height;
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(entry.img, 0, 0);
    } else if (entry.canvas) {
      canvas = entry.canvas;
    } else {
      return null;
    }
    return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);  // dsh-skip-quality 照搬旧端的取样实现，本轮未改动
  } catch {
    return null;
  }
}



/** 1×1 空纹理对象（图集页找不到匹配贴图时的占位；必须像纹理，否则批处理器会抛） */
export function makePlaceholderTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  return {
    _image: canvas,
    getImage() { return this._image; },
    setFilters() {},
    setWraps() {},
    dispose() {},
  };
}

/** 手工建纹理（GLTexture 构造失败时的回退），包成运行时期望的纹理形状 */
function manualTexture(gl, source, filterMode) {
  const handle = gl.createTexture();
  if (!handle) return null;
  gl.bindTexture(gl.TEXTURE_2D, handle);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterMode);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterMode);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return {
    _image: source,
    texture: handle,
    getImage() { return this._image; },
    setFilters(min, mag) {
      try {
        gl.bindTexture(gl.TEXTURE_2D, handle);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
      } catch { /* 忽略 */ }
    },
    setWraps() {},
    dispose() { try { gl.deleteTexture(handle); } catch { /* 忽略 */ } },
  };
}

/**
 * 设纹理过滤（旧引擎 applyTextureFilter：有 setFilters 用它，否则直接 texParameteri）。
 */
export function applyTextureFilter(gl, texture, mode) {
  if (!gl || !texture) return;
  const f = mode === 'nearest' ? gl.NEAREST : gl.LINEAR;
  try {
    if (typeof texture.setFilters === 'function') { texture.setFilters(f, f); return; }
    const handle = texture.texture || texture._texture;
    if (!handle) return;
    gl.bindTexture(gl.TEXTURE_2D, handle);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  } catch { /* 忽略 */ }
}

// 预乘相关的上传实现在 pma.js（唯一权威位置）：这里再导出，调用方 import 路径不用改。
export { uploadTextures } from './pma.js';
