// ============================================================================
// lib/dxt.js —— BC/DXT 家族纹理解码（BC1/DXT1、BC3/DXT5、BC4、BC5）
//
// 为什么需要：Unity 的 PC/主机资源包常用 BC 系列（Unity TextureFormat 10=DXT1、12=DXT5、
//   26=BC4、27=BC5），而移动端资源包用 ETC2。两类资源包都可能出现在同一批素材里，
//   缺哪一种都会让"整个模型不可用"（纹理解不出来 → 舞台拿不到贴图）。
//
// 挂载：globalThis.__ULB__.dxt = { decodeBc1, decodeBc3, decodeBc4, decodeBc5 }
//
// 实现要点（都是块式压缩，逐 4×4 块解）：
//   · BC1：每块 8 字节 = 两个 RGB565 端点 + 32 位 2bit 索引；c0>c1 为 4 色模式，
//     否则 3 色 + 透明（用于 1bit alpha）。
//   · BC3：每块 16 字节 = 8 字节 alpha 块（a0/a1 + 48 位 3bit 索引）+ 8 字节颜色块（同 BC1 的 4 色模式）。
//   · BC4：单通道，就是 BC3 的 alpha 块（8 字节）。
//   · BC5：双通道，两个 BC4 alpha 块（16 字节）→ R/G，B 置 0、A 置 255。
//   · 所有解码都按行优先输出 RGBA，边缘块不足 4×4 时只写落在图内的像素。
// ============================================================================

'use strict';

{
  /** 5:6:5 → 8:8:8（按位扩展，与 GPU 的端点插值一致：复制高位） */
  function r5g6b5(v) {
    const r = (v >> 11) & 0x1f;
    const g = (v >> 5) & 0x3f;
    const b = v & 0x1f;
    return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
  }

  function u16(d, o) { return d[o] | (d[o + 1] << 8); }

  /**
   * 解一个 BC1 颜色块（8 字节）到 4×4 的 RGBA 输出。
   * @param {Uint8Array} d 压缩数据
   * @param {number} o 块起始偏移
   * @param {boolean} fourColorOnly true 时强制 4 色模式（BC3 的颜色块用）
   * @returns {{colors:number[][], idx:number[]}} colors 为 4 个 [r,g,b,a]
   */
  function readColorBlock(d, o, fourColorOnly) {
    const c0 = u16(d, o);
    const c1 = u16(d, o + 2);
    const p0 = r5g6b5(c0);
    const p1 = r5g6b5(c1);
    let colors;
    if (fourColorOnly || c0 > c1) {
      // 4 色模式：p2 = (2*p0 + p1)/3，p3 = (p0 + 2*p1)/3
      colors = [
        [p0[0], p0[1], p0[2], 255],
        [p1[0], p1[1], p1[2], 255],
        [(2 * p0[0] + p1[0]) / 3 | 0, (2 * p0[1] + p1[1]) / 3 | 0, (2 * p0[2] + p1[2]) / 3 | 0, 255],
        [(p0[0] + 2 * p1[0]) / 3 | 0, (p0[1] + 2 * p1[1]) / 3 | 0, (p0[2] + 2 * p1[2]) / 3 | 0, 255],
      ];
    } else {
      // 3 色 + 透明模式：p2 = (p0+p1)/2，p3 = 全透明
      colors = [
        [p0[0], p0[1], p0[2], 255],
        [p1[0], p1[1], p1[2], 255],
        [(p0[0] + p1[0]) / 2 | 0, (p0[1] + p1[1]) / 2 | 0, (p0[2] + p1[2]) / 2 | 0, 255],
        [0, 0, 0, 0],
      ];
    }
    const bits = d[o + 4] | (d[o + 5] << 8) | (d[o + 6] << 16) | (d[o + 7] << 24);
    const idx = new Array(16);
    for (let i = 0; i < 16; i++) idx[i] = (bits >>> (i * 2)) & 0x3;
    return { colors, idx };
  }

  /**
   * 解一个 alpha 块（8 字节）到 16 个 0~255 的 alpha 值（BC3/BC4 共用）。
   *   a0 > a1：8 档线性插值；a0 <= a1：6 档插值 + 0 与 255 两个极值。
   */
  function readAlphaBlock(d, o) {
    const a0 = d[o];
    const a1 = d[o + 1];
    const table = new Array(8);
    table[0] = a0;
    table[1] = a1;
    if (a0 > a1) {
      for (let i = 1; i <= 6; i++) table[i + 1] = ((7 - i) * a0 + i * a1) / 7 | 0;
    } else {
      for (let i = 1; i <= 4; i++) table[i + 1] = ((5 - i) * a0 + i * a1) / 5 | 0;
      table[6] = 0;
      table[7] = 255;
    }
    // 48 位、每像素 3bit 的索引（跨 6 字节）
    const out = new Array(16);
    let acc = 0;
    let bits = 0;
    let p = o + 2;
    for (let i = 0; i < 16; i++) {
      while (bits < 3) { acc |= d[p++] << bits; bits += 8; }
      out[i] = table[acc & 7];
      acc >>>= 3;
      bits -= 3;
    }
    return out;
  }

  /** 把 4×4 块的像素写进 RGBA 输出（自动裁剪到图内） */
  function writeBlock(out, width, height, bx, by, pixels) {
    for (let y = 0; y < 4; y++) {
      const py = by * 4 + y;
      if (py >= height) break;
      for (let x = 0; x < 4; x++) {
        const px = bx * 4 + x;
        if (px >= width) break;
        const p = pixels[y * 4 + x];
        const o = (py * width + px) * 4;
        out[o] = p[0];
        out[o + 1] = p[1];
        out[o + 2] = p[2];
        out[o + 3] = p[3];
      }
    }
  }

  /** 解 DXT1/BC1（每块 8 字节） */
  function decodeBc1(data, width, height) {
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    const need = bw * bh * 8;
    if (data.length < need) throw NS.errors.fail('ULB_ERR_TEX_DATA_SHORT', `DXT1 数据不足：需要 ${need} 字节，实际 ${data.length}`);
    const out = new Uint8Array(width * height * 4);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const { colors, idx } = readColorBlock(data, (by * bw + bx) * 8, false);
        const pixels = new Array(16);
        for (let i = 0; i < 16; i++) pixels[i] = colors[idx[i]];
        writeBlock(out, width, height, bx, by, pixels);
      }
    }
    return out;
  }

  /** 解 DXT5/BC3（每块 16 字节 = alpha 块 + 颜色块） */
  function decodeBc3(data, width, height) {
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    const need = bw * bh * 16;
    if (data.length < need) throw NS.errors.fail('ULB_ERR_TEX_DATA_SHORT', `DXT5 数据不足：需要 ${need} 字节，实际 ${data.length}`);
    const out = new Uint8Array(width * height * 4);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const o = (by * bw + bx) * 16;
        const alphas = readAlphaBlock(data, o);
        const { colors, idx } = readColorBlock(data, o + 8, true);
        const pixels = new Array(16);
        for (let i = 0; i < 16; i++) {
          const c = colors[idx[i]];
          pixels[i] = [c[0], c[1], c[2], alphas[i]];
        }
        writeBlock(out, width, height, bx, by, pixels);
      }
    }
    return out;
  }

  /** 解 BC4（单通道，每块 8 字节）：R=通道值，G/B=0，A=255 */
  function decodeBc4(data, width, height) {
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    const need = bw * bh * 8;
    if (data.length < need) throw NS.errors.fail('ULB_ERR_TEX_DATA_SHORT', `BC4 数据不足：需要 ${need} 字节，实际 ${data.length}`);
    const out = new Uint8Array(width * height * 4);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const vals = readAlphaBlock(data, (by * bw + bx) * 8);
        const pixels = vals.map((v) => [v, 0, 0, 255]);
        writeBlock(out, width, height, bx, by, pixels);
      }
    }
    return out;
  }

  /** 解 BC5（双通道，每块 16 字节 = 两个 BC4 块）：R/G=两通道，B=0，A=255 */
  function decodeBc5(data, width, height) {
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    const need = bw * bh * 16;
    if (data.length < need) throw NS.errors.fail('ULB_ERR_TEX_DATA_SHORT', `BC5 数据不足：需要 ${need} 字节，实际 ${data.length}`);
    const out = new Uint8Array(width * height * 4);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const o = (by * bw + bx) * 16;
        const r = readAlphaBlock(data, o);
        const g = readAlphaBlock(data, o + 8);
        const pixels = new Array(16);
        for (let i = 0; i < 16; i++) pixels[i] = [r[i], g[i], 0, 255];
        writeBlock(out, width, height, bx, by, pixels);
      }
    }
    return out;
  }

  const NS = (globalThis.__ULB__ = globalThis.__ULB__ || {});
  NS.dxt = { decodeBc1, decodeBc3, decodeBc4, decodeBc5 };
}
