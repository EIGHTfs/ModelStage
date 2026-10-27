// ============================================================================
// plugins/unity-live2d-bundle/lib/etc2.js —— ETC1 / ETC2 / EAC Alpha 解码
//
// 本文件是 GL 系压缩纹理解码的**逐位实现**，覆盖：
//   · ETC1（个体 individual / 差分 differential）
//   · ETC2（在 ETC1 差分基础上，按"差分溢出"选 T / H / 平面 planar 三模式）
//   · ETC2A8（ETC2 RGB + 8 位 EAC Alpha）—— Unity 的 TextureFormat 47 = ETC2_RGBA8 走这条
//
// 两块数据的字节顺序（关键，弄反就整张图错位）：
//   ETC2A8 每个 4x4 块 16 字节 = **前 8 字节是 Alpha，后 8 字节才是 RGB**。
//   判据：本插件与参考实现（UnityPy 导出 oracle 时用的 texture2ddecoder）逐像素比对一致；
//   若把顺序反过来，同一份数据会解出完全不同的图。
//
// 位序约定：块内索引按"最低位对应第一个像素"逐 3/2 位右移取用，
//   像素落位用 WriteOrderTable（RGB）与 WriteOrderTableRev（Alpha）两张表，
//   表值即 4x4 块内的行优先下标（y*4+x）。这两张表来自参考实现，避免自行推导出错。
//
// 挂载：globalThis.__ULB__.etc2
// ============================================================================

'use strict';

{
  const root = globalThis;   // 原 IIFE 的 root 引用（脚本级裸块内保持同名）
  const NS = (root.__ULB__ = root.__ULB__ || {});

  const WriteOrderTable = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
  const WriteOrderTableRev = [15, 11, 7, 3, 14, 10, 6, 2, 13, 9, 5, 1, 12, 8, 4, 0];
  const Etc1ModifierTable = [[2, 8], [5, 17], [9, 29], [13, 42], [18, 60], [24, 80], [33, 106], [47, 183]];
  const Etc1SubblockTable = [
    [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1],
    [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1],
  ];
  const Etc2DistanceTable = [3, 6, 11, 16, 23, 32, 41, 64];
  const Etc2AlphaModTable = [
    [-3, -6, -9, -15, 2, 5, 8, 14], [-3, -7, -10, -13, 2, 6, 9, 12], [-2, -5, -8, -13, 1, 4, 7, 12],
    [-2, -4, -6, -13, 1, 3, 5, 12], [-3, -6, -8, -12, 2, 5, 7, 11], [-3, -7, -9, -11, 2, 6, 8, 10],
    [-4, -7, -8, -11, 3, 6, 7, 10], [-3, -5, -8, -11, 2, 4, 7, 10], [-2, -6, -8, -10, 1, 5, 7, 9],
    [-2, -5, -8, -10, 1, 4, 7, 9], [-2, -4, -8, -10, 1, 3, 7, 9], [-2, -5, -7, -10, 1, 4, 6, 9],
    [-3, -4, -7, -10, 2, 3, 6, 9], [-1, -2, -3, -10, 0, 1, 2, 9], [-4, -6, -8, -9, 3, 5, 7, 8],
    [-3, -5, -7, -9, 2, 4, 6, 8],
  ];

  const clamp = (n) => (n < 0 ? 0 : n > 255 ? 255 : n);

  /** 把 4x4 块的 RGBA 写进整图（block 内下标记为行优先 y*4+x） */
  function writeBlock(rgba, blockRGBA, out, outX, outY, width, height) {
    for (let y = 0; y < 4; y++) {
      const py = outY + y;
      if (py >= height) continue;
      for (let x = 0; x < 4; x++) {
        const px = outX + x;
        if (px >= width) continue;
        const src = (y * 4 + x) * 4;
        const dst = (py * width + px) * 4;
        rgba[dst] = blockRGBA[src];
        rgba[dst + 1] = blockRGBA[src + 1];
        rgba[dst + 2] = blockRGBA[src + 2];
        rgba[dst + 3] = blockRGBA[src + 3];
      }
    }
    void out;
  }

  /** 写块内第 idx 个像素（按 WriteOrderTable 的扫描顺序） */
  function putPixel(out, idx, r, g, bl) {
    const p = WriteOrderTable[idx] * 4;
    out[p] = clamp(r);
    out[p + 1] = clamp(g);
    out[p + 2] = clamp(bl);
    out[p + 3] = 255;
  }

  /** 差分位（低 3 位）的符号扩展，范围 -8..+7。三个通道共用同一个表达式 */
  const deltaOf = (x) => ((x << 3) & 0x18) - ((x << 3) & 0x20);

  /**
   * 选择 RGB 块的子模式。
   *
   * **判定顺序即规范，不可调整**：
   *   individual → T(R 差分溢出) → H(G 差分溢出) → Planar(B 差分溢出) → differential。
   *   顺序一变，同一个 block 会落进不同模式、解码结果就变了 ——
   *   不要为了"看起来整齐"把这些 if 重排或合并。
   * ETC1（etc2 === false）没有 T/H/Planar 三种模式：individual 之后直接进 differential。
   * @returns {'individual'|'t'|'h'|'planar'|'differential'}
   */
  function selectRgbMode(b, o, etc2) {
    if ((b[o + 3] & 2) === 0) return 'individual';
    if (!etc2) return 'differential';
    const r0 = b[o] & 0xf8;
    const g0 = b[o + 1] & 0xf8;
    const bl0 = b[o + 2] & 0xf8;
    if (r0 + deltaOf(b[o]) < 0 || r0 + deltaOf(b[o]) > 255) return 't';
    if (g0 + deltaOf(b[o + 1]) < 0 || g0 + deltaOf(b[o + 1]) > 255) return 'h';
    if (bl0 + deltaOf(b[o + 2]) < 0 || bl0 + deltaOf(b[o + 2]) > 255) return 'planar';
    return 'differential';
  }

  /** ① 个体模式：两半各自 4 位颜色（不做通道差分） */
  function decodeIndividualBlock(b, o, j, k, out) {
    const flip = b[o + 3] & 1;
    const code = [b[o + 3] >> 5, (b[o + 3] >> 2) & 7];
    const subblock = Etc1SubblockTable[flip];
    const c = [[0, 0, 0], [0, 0, 0]];
    c[0][0] = ((b[o] & 0xf0) | (b[o] >> 4)) & 0xff;
    c[1][0] = ((b[o] & 0x0f) | (b[o] << 4)) & 0xff;
    c[0][1] = ((b[o + 1] & 0xf0) | (b[o + 1] >> 4)) & 0xff;
    c[1][1] = ((b[o + 1] & 0x0f) | (b[o + 1] << 4)) & 0xff;
    c[0][2] = ((b[o + 2] & 0xf0) | (b[o + 2] >> 4)) & 0xff;
    c[1][2] = ((b[o + 2] & 0x0f) | (b[o + 2] << 4)) & 0xff;
    for (let i = 0; i < 16; i++, j >>= 1, k >>= 1) {
      const s = subblock[i];
      const m = Etc1ModifierTable[code[s]][j & 1];
      putPixel(out, i, c[s][0] + (k & 1 ? -m : m), c[s][1] + (k & 1 ? -m : m), c[s][2] + (k & 1 ? -m : m));
    }
    return out;
  }

  /** ② T 模式（ETC2）：两个端点色 + 一组距离偏移，索引为 3 bit */
  function decodeTBlock(b, o, j, k, out) {
    const c0 = [
      ((b[o] << 3) & 0xc0) | ((b[o] << 4) & 0x30) | ((b[o] >> 1) & 0xc) | (b[o] & 3),
      ((b[o + 1] & 0xf0) | (b[o + 1] >> 4)) & 0xff,
      ((b[o + 1] & 0x0f) | (b[o + 1] << 4)) & 0xff,
    ];
    const c1 = [
      ((b[o + 2] & 0xf0) | (b[o + 2] >> 4)) & 0xff,
      ((b[o + 2] & 0x0f) | (b[o + 2] << 4)) & 0xff,
      ((b[o + 3] & 0xf0) | (b[o + 3] >> 4)) & 0xff,
    ];
    const d = Etc2DistanceTable[((b[o + 3] >> 1) & 6) | (b[o + 3] & 1)];
    const set = [
      [c0[0], c0[1], c0[2]],
      [c1[0] + d, c1[1] + d, c1[2] + d],
      [c1[0], c1[1], c1[2]],
      [c1[0] - d, c1[1] - d, c1[2] - d],
    ];
    k = (k << 1) >>> 0;
    for (let i = 0; i < 16; i++, j >>= 1, k >>= 1) {
      const sel = ((k & 2) | (j & 1));
      putPixel(out, i, set[sel][0], set[sel][1], set[sel][2]);
    }
    return out;
  }

  /** ③ H 模式（ETC2）：两色 + 距离偏移；d 的档位由两色大小关系决定 */
  function decodeHBlock(b, o, j, k, out) {
    const c0 = [0, 0, 0];
    const c1 = [0, 0, 0];
    c0[0] = ((b[o] << 1) & 0xf0) | ((b[o] >> 3) & 0x0f);
    c0[1] = ((b[o] << 5) & 0xe0) | (b[o + 1] & 0x10);
    c0[1] |= c0[1] >> 4;
    c0[2] = ((b[o + 1] & 8) | ((b[o + 1] << 1) & 6) | (b[o + 2] >> 7)) & 0xff;
    c0[2] |= (c0[2] << 4) & 0xff;
    c1[0] = ((b[o + 2] << 1) & 0xf0) | ((b[o + 2] >> 3) & 0x0f);
    c1[1] = ((b[o + 2] << 5) & 0xe0) | ((b[o + 3] >> 3) & 0x10);
    c1[1] |= c1[1] >> 4;
    c1[2] = ((b[o + 3] << 1) & 0xf0) | ((b[o + 3] >> 3) & 0x0f);
    let d = (b[o + 3] & 4) | ((b[o + 3] << 1) & 2);
    if (c0[0] > c1[0]
      || (c0[0] === c1[0] && (c0[1] > c1[1] || (c0[1] === c1[1] && c0[2] >= c1[2])))) d++;
    d = Etc2DistanceTable[d];
    const set = [
      [c0[0] + d, c0[1] + d, c0[2] + d],
      [c0[0] - d, c0[1] - d, c0[2] - d],
      [c1[0] + d, c1[1] + d, c1[2] + d],
      [c1[0] - d, c1[1] - d, c1[2] - d],
    ];
    k = (k << 1) >>> 0;
    for (let i = 0; i < 16; i++, j >>= 1, k >>= 1) {
      const sel = ((k & 2) | (j & 1));
      putPixel(out, i, set[sel][0], set[sel][1], set[sel][2]);
    }
    return out;
  }

  /** ④ 平面模式（ETC2）：三顶点色做平面插值；**不用索引位**，按 i*4 顺序直接写 */
  function decodePlanarBlock(b, o, j, k, out) {
    void j; void k;   // 平面模式不使用索引位（参数保留只为统一签名）
    const c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    c[0][0] = ((b[o] << 1) & 0xfc) | ((b[o] >> 5) & 3);
    c[0][1] = ((b[o] << 7) & 0x80) | (b[o + 1] & 0x7e) | (b[o] & 1);
    c[0][2] = ((b[o + 1] << 7) & 0x80) | ((b[o + 2] << 2) & 0x60) | ((b[o + 2] << 3) & 0x18) | ((b[o + 3] >> 5) & 4);
    c[0][2] |= c[0][2] >> 6;
    c[1][0] = ((b[o + 3] << 1) & 0xf8) | ((b[o + 3] << 2) & 4) | ((b[o + 3] >> 5) & 3);
    c[1][1] = (b[o + 4] & 0xfe) | (b[o + 4] >> 7);
    c[1][2] = ((b[o + 4] << 7) & 0x80) | ((b[o + 5] >> 1) & 0x7c);
    c[1][2] |= c[1][2] >> 6;
    c[2][0] = ((b[o + 5] << 5) & 0xe0) | ((b[o + 6] >> 3) & 0x1c) | ((b[o + 5] >> 1) & 3);
    c[2][1] = ((b[o + 6] << 3) & 0xf8) | ((b[o + 7] >> 5) & 0x6) | ((b[o + 6] >> 4) & 1);
    c[2][2] = ((b[o + 7] << 2) | ((b[o + 7] >> 4) & 3)) & 0xff;
    for (let y = 0, i = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++, i++) {
        const rr = clamp((x * (c[1][0] - c[0][0]) + y * (c[2][0] - c[0][0]) + 4 * c[0][0] + 2) >> 2);
        const gg = clamp((x * (c[1][1] - c[0][1]) + y * (c[2][1] - c[0][1]) + 4 * c[0][1] + 2) >> 2);
        const bb = clamp((x * (c[1][2] - c[0][2]) + y * (c[2][2] - c[0][2]) + 4 * c[0][2] + 2) >> 2);
        const p = i * 4;
        out[p] = rr; out[p + 1] = gg; out[p + 2] = bb; out[p + 3] = 255;
      }
    }
    return out;
  }

  /** ⑤ 差分模式（ETC1 本体；ETC2 下三通道都不溢出时也走这里） */
  function decodeDifferentialBlock(b, o, j, k, out) {
    const r0 = b[o] & 0xf8;
    const g0 = b[o + 1] & 0xf8;
    const bl0 = b[o + 2] & 0xf8;
    const dr = deltaOf(b[o]);
    const dg = deltaOf(b[o + 1]);
    const db = deltaOf(b[o + 2]);
    const flip = b[o + 3] & 1;
    const code = [b[o + 3] >> 5, (b[o + 3] >> 2) & 7];
    const subblock = Etc1SubblockTable[flip];
    const c = [[0, 0, 0], [0, 0, 0]];
    c[0][0] = r0 | (r0 >> 5);
    c[0][1] = g0 | (g0 >> 5);
    c[0][2] = bl0 | (bl0 >> 5);
    c[1][0] = (r0 + dr) | ((r0 + dr) >> 5);
    c[1][1] = (g0 + dg) | ((g0 + dg) >> 5);
    c[1][2] = (bl0 + db) | ((bl0 + db) >> 5);
    for (let i = 0; i < 16; i++, j >>= 1, k >>= 1) {
      const s = subblock[i];
      const m = Etc1ModifierTable[code[s]][j & 1];
      putPixel(out, i, c[s][0] + (k & 1 ? -m : m), c[s][1] + (k & 1 ? -m : m), c[s][2] + (k & 1 ? -m : m));
    }
    return out;
  }

  /** 模式名 → 解码函数（签名统一 `(b, o, j, k, out) → out`，out 是 16 像素 × RGBA 的块缓冲） */
  const RGB_BLOCK_MODES = {
    individual: decodeIndividualBlock,
    t: decodeTBlock,
    h: decodeHBlock,
    planar: decodePlanarBlock,
    differential: decodeDifferentialBlock,
  };

  /** ETC1/ETC2 的 RGB 块（8 字节）→ 4x4 RGBA（alpha 先填 255） */
  function decodeRgbBlock(data, off, etc2) {
    const out = new Uint8Array(16 * 4);
    // 公共头：索引低半（j）与高半（k）各 16 bit
    const j = (data[off + 6] << 8) | data[off + 7];
    const k = (data[off + 4] << 8) | data[off + 5];
    // 先选子模式（顺序即规范，见 selectRgbMode 的注释），再交给对应的模式函数
    const mode = selectRgbMode(data, off, etc2);
    return RGB_BLOCK_MODES[mode](data, off, j, k, out);
  }

  /** ETC2A8 的 Alpha 块（前 8 字节）→ 写进块缓冲的第 4 通道 */
  function decodeAlphaBlock(data, off, blockRGBA) {
    const base = data[off];
    const mullow = data[off + 1];
    if ((mullow & 0xf0) === 0) {
      for (let i = 0; i < 16; i++) blockRGBA[i * 4 + 3] = base;
      return;
    }
    const multiplier = mullow >> 4;
    const table = Etc2AlphaModTable[mullow & 0x0f];
    // 前 8 字节按大端读取成 64 位，从最低 3 位起每 3 位对应一个像素（落位见 WriteOrderTableRev）
    let l = 0n;
    for (let i = 0; i < 8; i++) l = (l << 8n) | BigInt(data[off + i]);
    for (let i = 0; i < 16; i++, l >>= 3n) {
      const v = base + multiplier * table[Number(l & 7n)];
      blockRGBA[WriteOrderTableRev[i] * 4 + 3] = clamp(v);
    }
  }

  /**
   * 解 ETC2_RGBA8（Unity TextureFormat 47）。
   * @param {Uint8Array} data 压缩数据
   * @param {number} width 宽
   * @param {number} height 高
   * @returns {Uint8Array} RGBA
   */
  function decodeEtc2Rgba8(data, width, height) {
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    const need = bw * bh * 16;
    if (data.length < need) throw NS.errors.fail('ULB_ERR_TEX_DATA_SHORT', `ETC2_RGBA8 数据不足：需要 ${need} 字节，实际 ${data.length}`);
    const rgba = new Uint8Array(width * height * 4);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const off = (by * bw + bx) * 16;
        // 前 8 字节 Alpha，后 8 字节 RGB（顺序来自参考实现的调用：decode_etc2_block(data+8) + decode_etc2a8_block(data)）
        const block = decodeRgbBlock(data, off + 8, true);
        decodeAlphaBlock(data, off, block);
        writeBlock(rgba, block, null, bx * 4, by * 4, width, height);
      }
    }
    return rgba;
  }

  /** 解 ETC1（无 alpha，统一 255）—— 供其他 TextureFormat 复用 */
  function decodeEtc1Rgb(data, width, height) {
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    if (data.length < bw * bh * 8) throw NS.errors.fail('ULB_ERR_TEX_DATA_SHORT', `ETC1 数据不足：需要 ${bw * bh * 8} 字节，实际 ${data.length}`);
    const rgba = new Uint8Array(width * height * 4);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const block = decodeRgbBlock(data, (by * bw + bx) * 8, false);
        writeBlock(rgba, block, null, bx * 4, by * 4, width, height);
      }
    }
    return rgba;
  }

  /** 解 ETC2 RGB（无 alpha，统一 255） */
  function decodeEtc2Rgb(data, width, height) {
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    if (data.length < bw * bh * 8) throw NS.errors.fail('ULB_ERR_TEX_DATA_SHORT', `ETC2 数据不足：需要 ${bw * bh * 8} 字节，实际 ${data.length}`);
    const rgba = new Uint8Array(width * height * 4);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const block = decodeRgbBlock(data, (by * bw + bx) * 8, true);
        writeBlock(rgba, block, null, bx * 4, by * 4, width, height);
      }
    }
    return rgba;
  }

  NS.etc2 = {
    decodeEtc2Rgba8, decodeEtc1Rgb, decodeEtc2Rgb, decodeRgbBlock, decodeAlphaBlock,
    WriteOrderTable, WriteOrderTableRev, Etc1ModifierTable, Etc1SubblockTable,
    Etc2DistanceTable, Etc2AlphaModTable, clamp,
  };
}
