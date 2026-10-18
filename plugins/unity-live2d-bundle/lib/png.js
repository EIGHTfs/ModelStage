// ============================================================================
// plugins/unity-live2d-bundle/lib/png.js —— RGBA ⇄ PNG（编码 + 解码/比对）
//
// 两个用途：
//   ① 编码：把解出的 RGBA 写成 PNG（给页面 <img> 或下载用）。**零依赖**实现：
//      zlib 流用「stored（未压缩）deflate 块」拼出来，只算 adler32/crc32，不需要压缩库。
//   ② 解码 + 比对：把参考 PNG 读成 RGBA，与本地解码结果逐像素比对（自检用）。
//      inflate 不可自带，按环境注入：Node 用 node:zlib（setInflate），
//      浏览器用 DecompressionStream('deflate')（现代 Chrome 自带），两处都不可用则抛可读错误。
//
// 支持范围（够用即可，不做通用图片库）：8 位深、颜色类型 0/2/4/6、过滤方式 0..4，隔行扫描不支持（抛错）。
//
// 挂载：globalThis.__ULB__.png
// ============================================================================

'use strict';

{
  const root = globalThis;   // 原 IIFE 的 root 引用（脚本级裸块内保持同名）
  const NS = (root.__ULB__ = root.__ULB__ || {});
  const B = NS.bytes;

  // ---------------------------------------------------------------- CRC32 / Adler32
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function adler32(u8) {
    let a = 1;
    let b = 0;
    for (let i = 0; i < u8.length; i++) {
      a = (a + u8[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  // ---------------------------------------------------------------- 编码
  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    const crcBuf = new Uint8Array(4 + data.length);
    crcBuf.set(out.subarray(4, 8), 0);
    crcBuf.set(data, 4);
    dv.setUint32(8 + data.length, crc32(crcBuf));
    return out;
  }

  /** deflate 的 stored（无压缩）块序列 + zlib 头/adler32 */
  function zlibStored(u8) {
    const MAX = 65535;
    const blocks = Math.max(1, Math.ceil(u8.length / MAX));
    const parts = [new Uint8Array([0x78, 0x01])];
    for (let i = 0; i < blocks; i++) {
      const slice = u8.subarray(i * MAX, Math.min(u8.length, (i + 1) * MAX));
      const last = i === blocks - 1 ? 1 : 0;
      const head = new Uint8Array(5);
      head[0] = last;
      const len = slice.length;
      head[1] = len & 0xff;
      head[2] = (len >> 8) & 0xff;
      head[3] = (~len) & 0xff;
      head[4] = ((~len) >> 8) & 0xff;
      parts.push(head, slice);
    }
    const ad = new Uint8Array(4);
    new DataView(ad.buffer).setUint32(0, adler32(u8));
    parts.push(ad);
    return B.concatBytes(parts);
  }

  /**
   * RGBA → PNG 字节。
   * @param {Uint8Array} rgba
   * @param {number} width
   * @param {number} height
   */
  function encodePng(rgba, width, height) {
    const stride = width * 4;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = 0;   // 过滤方式 0（None）
      raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8;    // 位深
    ihdr[9] = 6;    // 颜色类型 RGBA
    ihdr[10] = 0;   // 压缩方式
    ihdr[11] = 0;   // 过滤方式
    ihdr[12] = 0;   // 非隔行
    const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return B.concatBytes([sig, chunk('IHDR', ihdr), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0))]);
  }

  /**
   * RGBA → PNG 字节（**压缩**版，异步）。
   *
   * 为什么需要压缩版：stored（不压缩）的 PNG 会膨胀到 67 MB（4096² 的 RGBA），
   *   页面在「解码 ETC2 → 64MB RGBA → 67MB PNG」之间会同时占用上百兆，
   *   实测会触发浏览器图像解码失败（表现为加载器的 "Texture loading error"）。
   *   压缩后约 6 MB（与参考导出件同量级），内存与解码耗时都降一个数量级。
   *
   * deflate 来源：浏览器用 CompressionStream('deflate')（产出 zlib 流，正好是 IDAT 需要的格式）；
   *   Node 侧由调用方注入（setDeflate，见 self-test）。都没有时退回 stored 版本（仍可用，只是更大）。
   */
  let deflateImpl = null;
  function setDeflate(fn) { deflateImpl = fn; }

  async function deflateCompress(u8) {
    if (deflateImpl) return deflateImpl(u8);
    const CS = root.CompressionStream;
    if (CS) {
      const cs = new CS('deflate');
      const stream = new Blob([u8]).stream().pipeThrough(cs);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return zlibStored(u8);
  }

  async function encodePngAsync(rgba, width, height) {
    const stride = width * 4;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = 0;
      raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const idat = await deflateCompress(raw);
    return B.concatBytes([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]);
  }

  // ---------------------------------------------------------------- 解码
  let inflateImpl = null;
  /** 注入 inflate（Node：node:zlib 的 inflateSync） */
  function setInflate(fn) { inflateImpl = fn; }

  async function inflate(zlibBytes) {
    if (inflateImpl) return inflateImpl(zlibBytes);
    const DS = root.DecompressionStream;
    if (DS) {
      const ds = new DS('deflate');
      const stream = new Blob([zlibBytes]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    }
    throw NS.errors.fail('ULB_ERR_TEX_DECODE', '当前环境没有 inflate 实现（Node 请注入 node:zlib；浏览器需支持 DecompressionStream）');
  }

  /**
   * 解 PNG → { rgba, width, height }。
   * @param {Uint8Array} u8 PNG 字节
   */
  async function decodePng(u8) {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < 8; i++) if (u8[i] !== sig[i]) throw NS.errors.fail('ULB_ERR_TEX_DECODE', '不是 PNG（签名不符）');
    // PNG 的块长度与字段都是**大端**（与 Unity 的小端相反，这里必须换读法）
    const r = new B.Reader(u8, { pos: 8, endian: '>' });
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idat = [];
    let palette = null;
    for (;;) {
      const len = r.u32();
      const type = B.latin1(r.bytes(4), 0, 4);
      const data = r.bytes(len);
      r.skip(4); // CRC
      if (type === 'IHDR') {
        width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
        height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
        bitDepth = data[8];
        colorType = data[9];
        interlace = data[12];
      } else if (type === 'PLTE') {
        palette = data;
      } else if (type === 'IDAT') {
        idat.push(data);
      } else if (type === 'IEND') {
        break;
      }
    }
    if (bitDepth !== 8) throw NS.errors.fail('ULB_ERR_TEX_DECODE', `暂只支持 8 位深 PNG，实际 ${bitDepth}`);
    if (interlace !== 0) throw NS.errors.fail('ULB_ERR_TEX_DECODE', '暂不支持隔行扫描 PNG');
    const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
    if (!channels && colorType !== 3) throw NS.errors.fail('ULB_ERR_TEX_DECODE', `暂不支持的颜色类型 ${colorType}`);
    const raw = await inflate(B.concatBytes(idat));
    const bpp = colorType === 3 ? 1 : channels;
    const stride = width * bpp;
    const img = new Uint8Array(height * stride);
    let pos = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[pos++];
      const line = raw.subarray(pos, pos + stride);
      pos += stride;
      const out = img.subarray(y * stride, (y + 1) * stride);
      const prev = y > 0 ? img.subarray((y - 1) * stride, y * stride) : null;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? out[i - bpp] : 0;
        const b = prev ? prev[i] : 0;
        const c = prev && i >= bpp ? prev[i - bpp] : 0;
        let v = line[i];
        if (filter === 1) v += a;
        else if (filter === 2) v += b;
        else if (filter === 3) v += (a + b) >> 1;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        }
        out[i] = v & 0xff;
      }
    }
    // 统一成 RGBA
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const di = (y * width + x) * 4;
        if (colorType === 6) {
          const si = y * stride + x * 4;
          rgba[di] = img[si]; rgba[di + 1] = img[si + 1]; rgba[di + 2] = img[si + 2]; rgba[di + 3] = img[si + 3];
        } else if (colorType === 2) {
          const si = y * stride + x * 3;
          rgba[di] = img[si]; rgba[di + 1] = img[si + 1]; rgba[di + 2] = img[si + 2]; rgba[di + 3] = 255;
        } else if (colorType === 0) {
          const v = img[y * stride + x];
          rgba[di] = v; rgba[di + 1] = v; rgba[di + 2] = v; rgba[di + 3] = 255;
        } else if (colorType === 4) {
          const si = y * stride + x * 2;
          const v = img[si];
          rgba[di] = v; rgba[di + 1] = v; rgba[di + 2] = v; rgba[di + 3] = img[si + 1];
        } else {   // 调色板
          const idx = img[y * stride + x];
          rgba[di] = palette[idx * 3]; rgba[di + 1] = palette[idx * 3 + 1]; rgba[di + 2] = palette[idx * 3 + 2];
          rgba[di + 3] = palette.length > idx * 3 + 3 ? palette[idx * 3 + 3] : 255;
        }
      }
    }
    return { rgba, width, height, colorType, bitDepth };
  }

  /**
   * 与一张参考 PNG 逐像素比对。
   * @returns {Promise<{diffPixels:number, maxChannelDiff:number, expectedWidth:number, expectedHeight:number, mismatchSample:Array}>}
   */
  async function compareWithPng(rgba, width, height, pngBytes) {
    const ref = await decodePng(pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes));
    if (ref.width !== width || ref.height !== height) {
      return { diffPixels: width * height, maxChannelDiff: 255, expectedWidth: ref.width, expectedHeight: ref.height, sizeMismatch: true, mismatchSample: [] };
    }
    let diff = 0;
    let maxDiff = 0;
    const sample = [];
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      const d0 = Math.abs(rgba[o] - ref.rgba[o]);
      const d1 = Math.abs(rgba[o + 1] - ref.rgba[o + 1]);
      const d2 = Math.abs(rgba[o + 2] - ref.rgba[o + 2]);
      const d3 = Math.abs(rgba[o + 3] - ref.rgba[o + 3]);
      const m = Math.max(d0, d1, d2, d3);
      if (m > 0) {
        diff++;
        if (m > maxDiff) maxDiff = m;
        if (sample.length < 8) {
          sample.push({
            pixel: i, xy: [i % width, Math.floor(i / width)],
            ours: [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]],
            ref: [ref.rgba[o], ref.rgba[o + 1], ref.rgba[o + 2], ref.rgba[o + 3]],
          });
        }
      }
    }
    return { diffPixels: diff, maxChannelDiff: maxDiff, expectedWidth: ref.width, expectedHeight: ref.height, mismatchSample: sample };
  }

  NS.png = { encodePng, encodePngAsync, decodePng, compareWithPng, setInflate, setDeflate, crc32, adler32, zlibStored };
}
