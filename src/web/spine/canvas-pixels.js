// spine/canvas-pixels.js —— 像素采样与画面签名
//
// 职责：从画布读回像素、算画面签名（自检/回归判据）。
// 注意：preserveDrawingBuffer=false 时直接 readPixels 常读到全 0，判据用 ratio 而不是绝对值；
//   另外「像素非空」不能证明画面可见（存活在游离画布上时照样有像素），可见性请用 DOM 关系判。

const ALPHA_THRESHOLD = 8;

/** 像素签名：对读回的缓冲做一次轻量哈希（验收用"两帧不同"判定，不做加密） */
function pixelSignature(buf) {
  let h = 2166136261;
  for (let i = 0; i < buf.length; i += 97) { // 稀疏采样：覆盖全画面且够快
    h ^= buf[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

/** 同帧采样：非透明像素占比（先渲染一帧再读，避免读到来不及呈现的缓冲） */
export function samplePixels(st) {
  const e = st.engine;
  const gl = e && e.gl;
  if (!gl) return { ratio: 0, w: 0, h: 0, reason: 'no-gl' };
  try {
    if (e.presentFirstFrame) e.presentFirstFrame();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let n = 0;
    for (let i = 3; i < buf.length; i += 4) if (buf[i] > ALPHA_THRESHOLD) n++;
    return { ratio: +(n / (w * h)).toFixed(4), w, h, signature: pixelSignature(buf) };
  } catch (err) {
    return { ratio: 0, w: 0, h: 0, reason: String(err && err.message ? err.message : err) };
  }
}
