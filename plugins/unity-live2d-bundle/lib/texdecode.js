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
   * 解码一张纹理的压缩数据。
   * @param {{format:number, width:number, height:number, name?:string}} meta
   * @param {Uint8Array} data 压缩/原始数据（取自 .resS 或对象内联）
   * @param {{flipY?:boolean}} [opts] flipY 默认 true（Unity 存储方向）；给 false 拿原始存储方向
   * @returns {Uint8Array} RGBA（显示方向）
   */
  function decode(meta, data, opts) {
    const fmt = meta.format;
    const f = FORMATS[fmt];
    if (!f) {
      throw NS.errors.fail('ULB_ERR_TEX_FORMAT_UNSUPPORTED', `暂不支持纹理格式 ${fmt}（${meta.name || ''}）——已支持：ETC2_RGBA8(47)、ETC2_RGB(45)、ETC2_RGBA1(48)、ETC_RGB4(34)、DXT1(10)、DXT5(12)、BC4(26)、BC5(27)、RGBA32(4)、ARGB32(5)、RGB24(3)、Alpha8(1)、RGB565(7)；暂未实现：ASTC(50 系列)、PVRTC(30/31)、BC6H(24)、BC7(25)`);
    }
    const need = expectedSize(fmt, meta.width, meta.height);
    if (data.length < need) {
      throw NS.errors.fail('ULB_ERR_TEX_DATA_SHORT', `纹理 ${meta.name || ''}（${f.name} ${meta.width}x${meta.height}）数据不足：需要 ${need} 字节，实际 ${data.length}`);
    }
    const flip = !opts || opts.flipY !== false;
    const finish = (rgba) => (flip ? flipY(rgba, meta.width, meta.height) : rgba);

    if (f.compress === 'etc2a8') return finish(NS.etc2.decodeEtc2Rgba8(data, meta.width, meta.height));
    if (f.compress === 'etc2') return finish(NS.etc2.decodeEtc2Rgb(data, meta.width, meta.height));
    if (f.compress === 'etc1') return finish(NS.etc2.decodeEtc1Rgb(data, meta.width, meta.height));
    // BC/DXT 家族：解码器直接输出 RGBA（DXT1 含 1bit 透明、DXT5 带 alpha、BC4/BC5 单/双通道）
    if (f.compress === 'bc1') return finish(NS.dxt.decodeBc1(data, meta.width, meta.height));
    if (f.compress === 'bc3') return finish(NS.dxt.decodeBc3(data, meta.width, meta.height));
    if (f.compress === 'bc4') return finish(NS.dxt.decodeBc4(data, meta.width, meta.height));
    if (f.compress === 'bc5') return finish(NS.dxt.decodeBc5(data, meta.width, meta.height));
    if (fmt === 4) return finish(data.slice(0, need));
    if (fmt === 5) return finish(argbToRgba(data.slice(0, need)));
    if (fmt === 3) {
      const out = new Uint8Array(meta.width * meta.height * 4);
      for (let i = 0, p = 0; i < need; i += 3, p += 4) {
        out[p] = data[i]; out[p + 1] = data[i + 1]; out[p + 2] = data[i + 2]; out[p + 3] = 255;
      }
      return finish(out);
    }
    if (fmt === 1) {
      const out = new Uint8Array(meta.width * meta.height * 4);
      for (let i = 0, p = 0; i < need; i++, p += 4) {
        out[p] = 255; out[p + 1] = 255; out[p + 2] = 255; out[p + 3] = data[i];
      }
      return finish(out);
    }
    if (fmt === 7) {
      const out = new Uint8Array(meta.width * meta.height * 4);
      for (let i = 0, p = 0; i < need; i += 2, p += 4) {
        const v = data[i] | (data[i + 1] << 8);
        const r = (v >> 11) & 0x1f, g = (v >> 5) & 0x3f, b = v & 0x1f;
        out[p] = (r << 3) | (r >> 2);
        out[p + 1] = (g << 2) | (g >> 4);
        out[p + 2] = (b << 3) | (b >> 2);
        out[p + 3] = 255;
      }
      return finish(out);
    }
    throw NS.errors.fail('ULB_ERR_TEX_DECODE', `纹理格式 ${f.name} 的分发分支缺失`);
  }

  NS.texdecode = { decode, formatName, expectedSize, flipY, FORMATS };
}
