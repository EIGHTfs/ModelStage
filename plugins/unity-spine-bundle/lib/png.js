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

  /**
   * 增量 CRC32：对多个片段**连续**计算（PNG 的 CRC 覆盖 "类型 + 数据"）。
   * 为什么不先拼再算：IDAT 数据动辄 18MB，拼一次就是一次全量拷贝 —— 而 CRC 本身就是流式的。
   * @param {Array<Uint8Array>} parts
   * @returns {number}
   */
  function crc32OfParts(parts) {
    let c = 0xffffffff;
    for (const u8 of parts) {
      for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    }
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
   *   Node 侧由调用方注入（调用方在需要时 setDeflate）。都没有时退回 stored 版本（仍可用，只是更大）。
   */
  let deflateImpl = null;
  function setDeflate(fn) { deflateImpl = fn; }

  /**
   * 流式 deflate 注入（Node 侧注入 zlib.createDeflate 版本）。
   * 为什么不直接用 deflateImpl：那是一次性接口（吃整块、吐整块），
   *   而整块 = 4096² 的"过滤后扫描线"67MB + 一次全量拷贝 67MB（`Buffer.from`）。
   *   给一个**吃块迭代器**的接口，编码器就能按行块喂，全程不造整张。
   * @param {(chunks: Iterable<Uint8Array>) => Promise<Uint8Array>} fn
   */
  let deflateStreamImpl = null;
  function setDeflateStream(fn) { deflateStreamImpl = fn; }

  /** 每块的扫描行数：64 行 ≈ 4096² 时 1MB/块（够大能摊掉调用开销，够小不会造出第二张整图的量级） */
  const STREAM_ROWS = 64;

  /**
   * 把「过滤后的扫描线」切成小块逐个喂给 deflate，返回完整 zlib 流。
   *
   * 关键前提（已实测，见工具输出）：分块 write 与一次性 deflateSync 产出的 zlib 流**逐字节相同**
   *   —— 只要不调 flush()，deflate 的切分对输出无影响（块大小 2B / 64KB / 1MB 都验过）。
   *   所以这条路径不会改变 PNG 产物。
   * @param {Uint8Array} rgba 源像素（整张，LZ4 解码产物，这部分省不掉）
   * @param {number} width
   * @param {number} height
   * @returns {Promise<{chunks: Uint8Array[], length: number}>} zlib 流的**片段**（不拼接：拼接是调用方在一次预分配里做的）
   */
  async function deflateScanlines(rgba, width, height) {
    const stride = width * 4;
    /** 生成"每 64 行一块"的 [0, row..., 0, row...] 缓冲区（过滤方式 None） */
    function* blocks() {
      for (let y0 = 0; y0 < height; y0 += STREAM_ROWS) {
        const rows = Math.min(STREAM_ROWS, height - y0);
        const chunk = new Uint8Array((stride + 1) * rows);
        for (let r = 0; r < rows; r++) {
          const y = y0 + r;
          chunk[r * (stride + 1)] = 0;                                  // 过滤方式 0（None）
          chunk.set(rgba.subarray(y * stride, (y + 1) * stride), r * (stride + 1) + 1);
        }
        yield chunk;
      }
    }

    if (deflateStreamImpl) return normalizeChunks(await deflateStreamImpl(blocks()));

    // 浏览器：CompressionStream 也能流式写（先挂上读取再写，避免背压死锁）
    const CS = root.CompressionStream;
    if (CS) {
      const cs = new CS('deflate');
      const writer = cs.writable.getWriter();
      const collected = new Response(cs.readable).arrayBuffer();   // 先启动读取
      for (const chunk of blocks()) await writer.write(chunk);
      await writer.close();
      // CompressionStream 只给整体缓冲，拿不到分段 ⇒ 单片段返回（内存上仍是"一份"）
      return normalizeChunks([new Uint8Array(await collected)]);
    }

    // 兜底：没有流式能力 ⇒ 退回一次性（拼起来只是为了拿 stored 版本，仍正确）
    const parts = []; let total = 0;
    for (const chunk of blocks()) { parts.push(chunk); total += chunk.length; }
    const raw = new Uint8Array(total);
    let off = 0;
    for (const part of parts) { raw.set(part, off); off += part.length; }
    return normalizeChunks([zlibStored(raw)]);
  }

  /** 统一成「片段数组 + 总长」（注入实现可能返回数组或单块） */
  function normalizeChunks(v) {
    const chunks = Array.isArray(v) ? v : [v];
    let length = 0;
    for (const c of chunks) length += c.length;
    return { chunks, length };
  }

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
    // 流式：按 64 行一块喂 deflate，**不构造整张"过滤后扫描线"**（4096² 时那是 67MB），
    //   也不再把它转成 Buffer（`Buffer.from` 是又一次 67MB 全量拷贝）。
    //   产物与旧实现**逐字节相同**（分块不影响 deflate 输出，已实测三种块大小）。
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { chunks, length } = await deflateScanlines(rgba, width, height);
    return assemblePng(sig, ihdr, chunks, length);
  }

  const IHDR_TAG = new Uint8Array([0x49, 0x48, 0x44, 0x52]);   // 'IHDR'
  const IDAT_TAG = new Uint8Array([0x49, 0x44, 0x41, 0x54]);   // 'IDAT'
  const IEND_TAIL = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]); // 长度0 + 'IEND' + 固定 CRC

  /**
   * 一次分配最终 PNG 并逐段写入。
   *
   * 为什么不再走「chunk() 造 IDAT + concatBytes 汇总」那套：
   *   那会为 IDAT 额外分配两次（chunk 的输出 + CRC 用的 crcBuf）+ 汇总再复制一次，
   *   单张 4096² 的 IDAT 约 18MB ⇒ 白扔 3 份 18MB。
   *   这里总长已知（deflate 片段收完就有 length），所以只分配一次，
   *   单 IDAT 形态**不变** ⇒ 产物逐字节不变。
   * @param {Uint8Array} sig 8 字节签名
   * @param {Uint8Array} ihdr 13 字节图像头
   * @param {Uint8Array[]} chunks deflate 输出片段
   * @param {number} length 片段总长
   */
  function assemblePng(sig, ihdr, chunks, length) {
    // sig(8) + IHDR(4+4+13+4) + IDAT(4+4+length+4) + IEND(12)
    const png = new Uint8Array(8 + 25 + (12 + length) + 12);
    const dv = new DataView(png.buffer);
    let o = 0;
    png.set(sig, o); o += 8;
    // IHDR
    dv.setUint32(o, 13); o += 4;
    png.set(IHDR_TAG, o); o += 4;
    png.set(ihdr, o); o += 13;
    dv.setUint32(o, crc32OfParts([IHDR_TAG, ihdr])); o += 4;
    // IDAT（单块：长度 + 类型 + 数据 + CRC；CRC 对"类型+数据"增量算）
    dv.setUint32(o, length); o += 4;
    png.set(IDAT_TAG, o); o += 4;
    for (const c of chunks) { png.set(c, o); o += c.length; }
    dv.setUint32(o, crc32OfParts([IDAT_TAG, ...chunks])); o += 4;
    // IEND（长度 0 + 'IEND' + 固定 CRC）
    png.set(IEND_TAIL, o);
    return png;
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

  NS.png = { encodePng, encodePngAsync, decodePng, compareWithPng, setInflate, setDeflate, setDeflateStream, crc32, adler32, zlibStored };
}
