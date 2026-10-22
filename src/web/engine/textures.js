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
export function loadImageElement(entry) {
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

/** 取（或建）该贴图的 2D 画布源，用于 CPU 预乘与透明占位 */
export function texSourceCanvas(entry) {
  if (entry.canvas || entry.transparent || !entry.img) return entry.canvas;
  const canvas = document.createElement('canvas');
  canvas.width = entry.width;
  canvas.height = entry.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(entry.img, 0, 0);
  entry.canvas = canvas;
  return canvas;
}

/** 上传源选择：透明页→画布；CPU 预乘过→画布；否则优先 <img> */
export function getUploadSource(entry, cpuPremultiplied) {
  if (entry.transparent) return entry.canvas;
  if (cpuPremultiplied) return texSourceCanvas(entry);
  return entry.img ? entry.img : entry.canvas;
}

/** 把贴图取成 ImageData（供 PMA 像素检测） */
export function sampleSourceImageData(entry) {
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
    return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
}

const CPU_PREMULTIPLY_SOURCE = `
self.onmessage = function (e) {
  var data = new Uint8ClampedArray(e.data.imageData);
  for (var i = 0; i < data.length; i += 4) {
    var a = data[i + 3];
    if (a === 0 || a === 255) continue;
    var alpha = a / 255;
    data[i] = Math.round(data[i] * alpha);
    data[i + 1] = Math.round(data[i + 1] * alpha);
    data[i + 2] = Math.round(data[i + 2] * alpha);
  }
  self.postMessage({ data: data }, [data.buffer]);
};
`;
let premultiplyWorker = null;

/** 主线程 CPU 预乘（Worker 不可用时的回退） */
function premultiplyMainThread(imageData) {
  const data = new Uint8ClampedArray(imageData.data);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0 || a === 255) continue;
    const alpha = a / 255;
    data[i] = Math.round(data[i] * alpha);
    data[i + 1] = Math.round(data[i + 1] * alpha);
    data[i + 2] = Math.round(data[i + 2] * alpha);
  }
  return new ImageData(data, imageData.width, imageData.height);
}

/** 整页 CPU 预乘（Worker 优先） */
export function premultiplyImageData(imageData) {
  return new Promise((resolve) => {
    try {
      if (!premultiplyWorker) {
        const blob = new Blob([CPU_PREMULTIPLY_SOURCE], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        premultiplyWorker = new Worker(url);
        URL.revokeObjectURL(url);
      }
      const onMessage = (e) => {
        premultiplyWorker.removeEventListener('message', onMessage);
        resolve(new ImageData(new Uint8ClampedArray(e.data.data), imageData.width, imageData.height));
      };
      premultiplyWorker.addEventListener('message', onMessage);
      premultiplyWorker.postMessage({ imageData: imageData.data });
    } catch {
      resolve(premultiplyMainThread(imageData));
    }
  });
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

/**
 * 按 PMA 口径把一批页上传成纹理。
 * @param {{gl: WebGLRenderingContext, GLTextureCtor: Function|null, entries: Map,
 *           effectiveMode: string, needPremultiply: boolean, gpuUnpack: boolean,
 *           cpuPremultiplied: boolean, textureFilter: string, log?: Function}} ctx
 * @returns {Promise<Map<string, object>>} 页名 → 纹理对象
 */
export async function uploadTextures(ctx) {
  const { gl, GLTextureCtor, entries, effectiveMode, needPremultiply, gpuUnpack, log = () => {} } = ctx;
  const out = new Map();
  // pma 标志的含义（旧引擎）：gpuUnpack 时上传已预乘 → false；否则按 needPremultiply/effectiveMode
  const pmaFlag = gpuUnpack ? false : (needPremultiply ? true : effectiveMode === 'premultiplied');
  const unpack = gpuUnpack;
  let cpuMode = ctx.cpuPremultiplied;
  for (const [name, entry] of entries) {
    if (cpuMode && !entry.transparent) {
      const canvas = texSourceCanvas(entry);
      if (canvas) {
        const cctx = canvas.getContext('2d', { willReadFrequently: true });
        if (cctx) {
          const img = cctx.getImageData(0, 0, canvas.width, canvas.height);
          cctx.putImageData(await premultiplyImageData(img), 0, 0);
          entry.uploadCanvas = true;
        }
      }
    }
    const source = getUploadSource(entry, cpuMode);
    if (!source) continue;
    const filterMode = ctx.textureFilter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    if (GLTextureCtor) {
      try {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, unpack);
        const tex = new GLTextureCtor(gl, source);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        if ('pma' in tex) {
          if (effectiveMode === 'straight') {
            tex.pma = false;
            try {
              if (typeof tex.bind === 'function') tex.bind(0);
              gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            } catch { /* 重传失败保持已建纹理 */ }
          } else {
            tex.pma = pmaFlag;
            if (typeof tex.update === 'function') { try { tex.update(tex.useMipMaps === true); } catch { /* 忽略 */ } }
          }
        }
        applyTextureFilter(gl, tex, ctx.textureFilter);
        out.set(name, tex);
        continue;
      } catch (e) {
        log('warn', `创建 GLTexture 失败 ${name}: ${e && e.message ? e.message : e}，回退手动上传`, 'loader');
      }
    }
    const manual = manualTexture(gl, source, filterMode);
    if (manual) out.set(name, manual);
  }
  return out;
}
