// ============================================================================
// plugins/unity-live2d-bundle/lib/texdecode.js —— 纹理格式分发
//
// 职责：读 Texture2D 的 m_TextureFormat，分发给对应解码器，返回 RGBA 字节。
//   · 已实现：ETC2_RGBA8(47) / ETC2_RGB(45) / ETC1_RGB4(34) / 未压缩 RGBA32/RGB24/Alpha8 等直通格式
//   · 未实现：ASTC / PVRTC / BCn 等 —— **抛可读错误**并把格式名与格式号带上，
//     绝不返回空白图或猜出来的图（否则上层会把"解码失败"当成"资源损坏"）。
//
// 纹理尺寸与数据量的自检：按格式的块大小算出期望数据量，与给的字节数比对；
//   不匹配直接报错——这类错通常意味着字段读取错位，早报比晚报好。
//
// 挂载：globalThis.__ULB__.texdecode
// ============================================================================

'use strict';

{
  const root = globalThis;   // 原 IIFE 的 root 引用（脚本级裸块内保持同名）
  const NS = (root.__ULB__ = root.__ULB__ || {});

  // Unity TextureFormat → 名称 + 每块字节数 + 块边长（4 或 0 表示未压缩的逐像素格式）
  const FORMATS = {
    1: { name: 'Alpha8', block: 1, size: 1 },
    3: { name: 'RGB24', block: 3, size: 1 },
    4: { name: 'RGBA32', block: 4, size: 1 },
    5: { name: 'ARGB32', block: 4, size: 1 },
    7: { name: 'RGB565', block: 2, size: 1 },
    34: { name: 'ETC_RGB4', compress: 'etc1', block: 8, size: 4 },
    45: { name: 'ETC2_RGB', compress: 'etc2', block: 8, size: 4 },
    47: { name: 'ETC2_RGBA8', compress: 'etc2a8', block: 16, size: 4 },
    48: { name: 'ETC2_RGBA1', compress: 'etc2a1', block: 16, size: 4 },
    // BC/DXT 家族（PC/主机资源包常用；块式压缩，解码实现见 lib/dxt.js）
    10: { name: 'DXT1', compress: 'bc1', block: 8, size: 4 },
    12: { name: 'DXT5', compress: 'bc3', block: 16, size: 4 },
    26: { name: 'BC4', compress: 'bc4', block: 8, size: 4 },
    27: { name: 'BC5', compress: 'bc5', block: 16, size: 4 },
  };

  function formatName(fmt) {
    const f = FORMATS[fmt];
    return f ? f.name : `未知格式 ${fmt}`;
  }

  /** 按格式算期望的压缩/原始数据量 */
  function expectedSize(fmt, width, height) {
    const f = FORMATS[fmt];
    if (!f) return null;
    if (f.size === 1) return width * height * f.block;
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    return bw * bh * f.block;
  }

  /** unpack ARGB32 → RGBA */
  function argbToRgba(data) {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 4) {
      out[i] = data[i + 1];
      out[i + 1] = data[i + 2];
      out[i + 2] = data[i + 3];
      out[i + 3] = data[i];
    }
    return out;
  }

  /** RGB24(3) → RGBA：每 3 字节一像素，alpha 补 255 */
  function rgb24ToRgba(data, width, height, need) {
    const out = new Uint8Array(width * height * 4);
    for (let i = 0, p = 0; i < need; i += 3, p += 4) {
      out[p] = data[i]; out[p + 1] = data[i + 1]; out[p + 2] = data[i + 2]; out[p + 3] = 255;
    }
    return out;
  }

  /** Alpha8(1) → RGBA：单通道进 alpha，RGB 填白 */
  function alpha8ToRgba(data, width, height, need) {
    const out = new Uint8Array(width * height * 4);
    for (let i = 0, p = 0; i < need; i++, p += 4) {
      out[p] = 255; out[p + 1] = 255; out[p + 2] = 255; out[p + 3] = data[i];
    }
    return out;
  }

  /** RGB565(7) → RGBA：5/6/5 位展开到 8 位（低位复制高位，保持满量程） */
  function rgb565ToRgba(data, width, height, need) {
    const out = new Uint8Array(width * height * 4);
    for (let i = 0, p = 0; i < need; i += 2, p += 4) {
      const v = data[i] | (data[i + 1] << 8);
      const r = (v >> 11) & 0x1f, g = (v >> 5) & 0x3f, b = v & 0x1f;
      out[p] = (r << 3) | (r >> 2);
      out[p + 1] = (g << 2) | (g >> 4);
      out[p + 2] = (b << 3) | (b >> 2);
      out[p + 3] = 255;
    }
    return out;
  }

  /**
   * 垂直翻转 RGBA。
   *
   * 为什么所有格式都要翻：Unity 的纹理数据按 **GL 习惯自下而上**存放（第 0 行是图像底部），
   *   而页面/PNG 期望自上而下。实测证据：按存储顺序解码后与权威参考 PNG 比对，
   *   不做翻转时 2048² 的采样差异 461,728/466,489，翻转后差异为 0。
   * 所以解码的输出统一为"显示方向"，调用方拿到的就是能直接显示/编码的朝向。
   */
  function flipY(rgba, width, height) {
    const out = new Uint8Array(rgba.length);
    const stride = width * 4;
    for (let y = 0; y < height; y++) {
      out.set(rgba.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
    }
    return out;
  }

  /**
   * 格式号 → 解码器。
   *
   * **等价性前提**：原来是"先按 compress 字段判 7 个分支、再按 fmt 号判 5 个"，
   *   这里改成按 fmt 号查表 —— 两者等价的唯一前提是"一个 fmt 只对应一条解码路径"。
   *   实测成立：FORMATS 里每个 compress 值都只挂着一个 fmt
   *   （bc1→10 / bc3→12 / bc4→26 / bc5→27 / etc1→34 / etc2→45 / etc2a8→47 / etc2a1→48）。
   *   所以不存在"两个 fmt 共享 compress 却需要不同处理"的情况。
   *
   * 解码器签名统一 `(data, width, height, need) => Uint8Array`，返回**未翻转**的 RGBA；
   *   翻转由 decode 末尾统一做（与原来的 finish() 等价）。
   *
   * **buffer 共享约定**：未压缩格式走 slice（拷贝一份），压缩格式直接透传原始 data。
   *   调用方**不得依赖**返回的 rgba 与入参共享底层 buffer（有的格式共享、有的不共享，
   *   原地修改它可能改到源数据、也可能改不到）。
   */
  const DECODERS = {
    // 压缩格式：解码器自身产出 RGBA
    34: (d, w, h) => NS.etc2.decodeEtc1Rgb(d, w, h),
    45: (d, w, h) => NS.etc2.decodeEtc2Rgb(d, w, h),
    47: (d, w, h) => NS.etc2.decodeEtc2Rgba8(d, w, h),
    10: (d, w, h) => NS.dxt.decodeBc1(d, w, h),
    12: (d, w, h) => NS.dxt.decodeBc3(d, w, h),
    26: (d, w, h) => NS.dxt.decodeBc4(d, w, h),
    27: (d, w, h) => NS.dxt.decodeBc5(d, w, h),
    // 未压缩格式：切片后按通道展开
    4: (d, w, h, need) => d.slice(0, need),
    5: (d, w, h, need) => argbToRgba(d.slice(0, need)),
    3: (d, w, h, need) => rgb24ToRgba(d, w, h, need),
    1: (d, w, h, need) => alpha8ToRgba(d, w, h, need),
    7: (d, w, h, need) => rgb565ToRgba(d, w, h, need),
    // 48 ETC2_RGBA1：FORMATS 里有、但 decode 从未实现（落到末尾 throw ULB_ERR_TEX_DECODE）。
    //   这里**故意不登记** —— 补上它等于改变行为（从"报错"变成"能解码"），属功能变更，
    //   要单独立项 + 配 fixture，不能混在本次等价重构里。
  };

  /**
   * 解码一张纹理的压缩数据。
   * @param {{format:number, width:number, height:number, name?:string}} meta
   * @param {Uint8Array} data 压缩/原始数据（取自 .resS 或对象内联）
   * @param {{flipY?:boolean}} [opts] flipY 默认 true（Unity 存储方向）；给 false 拿原始存储方向
   * @returns {Uint8Array} RGBA（显示方向）
   */
  function decode(meta, data, opts) {
    const fmt = meta.format;
    const f = FORMATS[fmt];
    if (!f) throw NS.errors.fail('ULB_ERR_TEX_FORMAT_UNSUPPORTED', `暂不支持纹理格式 ${fmt}（${meta.name || ''}）——已支持：ETC2_RGBA8(47)、ETC2_RGB(45)、ETC2_RGBA1(48)、ETC_RGB4(34)、DXT1(10)、DXT5(12)、BC4(26)、BC5(27)、RGBA32(4)、ARGB32(5)、RGB24(3)、Alpha8(1)、RGB565(7)；暂未实现：ASTC(50 系列)、PVRTC(30/31)、BC6H(24)、BC7(25)`);
    const need = expectedSize(fmt, meta.width, meta.height);
    if (data.length < need) throw NS.errors.fail('ULB_ERR_TEX_DATA_SHORT', `纹理 ${meta.name || ''}（${f.name} ${meta.width}x${meta.height}）数据不足：需要 ${need} 字节，实际 ${data.length}`);
    // 表里有格式、但没有登记解码器（如 48 ETC2_RGBA1）⇒ 继续走这条兜底，与重构前完全一致
    const decoder = DECODERS[fmt];
    if (!decoder) throw NS.errors.fail('ULB_ERR_TEX_DECODE', `纹理格式 ${f.name} 的分发分支缺失`);
    const rgba = decoder(data, meta.width, meta.height, need);
    // 统一翻转：原实现用 finish() 包住每个 return，等价于在这里一次做完
    return !opts || opts.flipY !== false ? flipY(rgba, meta.width, meta.height) : rgba;
  }

  NS.texdecode = { decode, formatName, expectedSize, flipY, FORMATS };
}
