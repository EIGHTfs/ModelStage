// adapters/texture.js —— 纹理适配（创建 / 占位 / 释放 / 上传绑定）
//
// 业务层只调这里，不直接 `new GLTexture(...)`：不同版本可能是 GLTexture 或 Texture，
// 且有 bind()/setFilters() 与否的差异，全部收敛在本文件。

/** 1×1 透明画布（占位纹理的像素源） */
function blankCanvas() {
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = 1;
  const ctx = c.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, 1, 1);
  return c;
}

/**
 * @param {{caps: object, gl: WebGLRenderingContext, onWarn?: Function}} ctx
 */
export function createTextureAdapter({ caps, gl, onWarn }) {
  const Ctor = caps.texture.glTextureCtor || caps.texture.textureCtor;
  if (!Ctor) onWarn && onWarn('texture：运行时没有 GLTexture/Texture，纹理将无法创建');

  /** 由图片源创建纹理 */
  function create(image, premultiplied) {
    if (!Ctor) return null;
    return new Ctor(gl, image, false, premultiplied === true);
  }

  /** 占位纹理（必须是与运行时同源的纹理对象：Spine 批处理器会对它调 bind） */
  function placeholder() {
    if (!Ctor) return null;
    return new Ctor(gl, blankCanvas(), false, false);
  }

  /** 释放纹理（有 dispose 用 dispose，否则直接删 GL 纹理） */
  function dispose(tex) {
    if (!tex) return;
    try {
      if (caps.texture.hasDispose && typeof tex.dispose === 'function') { tex.dispose(); return; }
      const handle = tex.glTexture || tex.texture;
      if (handle && gl) gl.deleteTexture(handle);
    } catch { /* 释放失败不影响后续 */ }
  }

  /** 显式绑定（批处理器内部也会绑；这里给"需要手动绑定"的路径用） */
  function bind(tex) {
    if (!tex || !gl) return false;
    try {
      if (caps.texture.hasBind && typeof tex.bind === 'function') { tex.bind(); return true; }
      const handle = tex.glTexture || tex.texture;
      if (!handle) {
        onWarn && onWarn('texture.bind：纹理既没有 bind() 也没有 GL 句柄，已跳过绑定');
        return false;
      }
      gl.bindTexture(gl.TEXTURE_2D, handle);
      return true;
    } catch (e) {
      onWarn && onWarn(`texture.bind 失败：${e.message}`);
      return false;
    }
  }

  return { create, placeholder, dispose, bind, caps: caps.texture };
}
