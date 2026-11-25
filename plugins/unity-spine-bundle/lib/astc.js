// ============================================================================
// plugins/unity-spine-bundle/lib/astc.js —— ASTC（Adaptive Scalable Texture Compression）解码器
//
// 职责：把 ASTC 的压缩块（每块固定 16 字节 = 128 bit）解成 RGBA 字节数组。
//
// 为什么需要它：Unity 的 ASTC 纹理是"块压缩 + 显卡直接采样"的格式，浏览器侧拿不到
//   WebGL 的 ASTC 扩展（且现有链路是 CPU 解码成 RGBA → 编码 PNG → 交给 VirtualFS），
//   没有解码器时整张图只能报"格式未支持"，模型就出不了画。
//
// 与块尺寸的关系：ASTC 块内编码（分区 / 端点 / 权重网格）与块边长无关，
//   块边长只影响最后"权重网格 → 纹素"的插值范围。所以同一份解码逻辑天然支持
//   4x4 / 5x5 / 6x6 / 8x8 / 10x10 / 12x12 —— 不必为每种边长写一份。
//
// 来源与授权：
//   解码流程移植自 Android drawElements 测试套件的 ASTC 解码器（Apache-2.0），
//   并经 basis_universal 的整理版（basisu_astc_decomp.cpp）转发；整理版已经删掉 HDR 分支。
//   本文件按原实现逐函数移植，只做了三处与平台相关的等价改写：
//     ① 128 bit 的取值改成直接按字节读（原实现用两个 64 位字，JS 没有原生的 64 位无符号运算）；
//     ② 输出只保留 8 bit/通道通路（原实现另有 float 通路，最终同样是量化到 8 bit）；
//     ③ 出错一律抛带原因的错误，不再填"错误色"（理由见下）。
//
// 为什么出错要抛而不是填洋红色：本项目对纹理失败的要求是"可读错误、不产出半成品"
//   （见 doc/契约 与 ASTC 支持计划）。填错误色会让调用方以为解码成功，
//   把"数据/格式判断错"伪装成"这张图本来就长这样"，排查成本极高。故：
//     · 未实现的特性（HDR 端点模式 / HDR void-extent / 非法块尺寸）→ 抛"格式未支持"
//     · 结构非法（保留块模式、权重位数越界、端点值个数越界）→ 抛"解码失败"
//   两者都带块坐标，能直接定位是哪一格出了问题。
//
// 挂载：globalThis.__ULB__.astc = { decodeAstc }
//   · 返回的字节序是 **RGBA**（每像素 4 字节，依次 R、G、B、A）—— 注意不是参考 C++ 实现
//     直接写给显卡的那个 BGRA 顺序：本项目全部解码器与 VirtualFS/PNG 编码这条链都按 RGBA，
//     所以移植时在这里做了通道还原。做"与参考实现比对"时要把 R/B 换回去才能对齐。
//   · 方向是**存储方向**（第 0 行 = 数据里的第一行），不做 flipY ——
//     竖向翻转由外层 texdecode.decode() 统一做，避免两处翻（翻两次等于没翻）。
//   · 本文件在 unity-spine-bundle 与 unity-live2d-bundle 里**逐字节相同**（parity 用例钉住）。
// ============================================================================

'use strict';

{
  const root = globalThis;
  const NS = (root.__ULB__ = root.__ULB__ || {});

  // ---------------------------------------------------------------- 错误构造
  //
  // 复用插件的错误码表（spine 插件是 SPI_ERR_*，live2d 插件是 ULB_ERR_*）：
  //   这里按**码名**去表里取，取不到才退回本地字面量 —— 两份插件代码因此可以逐字节相同。
  // 需要区分的新情况：
  //   · 未实现的特性 → TEXTURE_FORMAT_UNSUPPORTED（调用方可据此提示"格式不支持"）
  //   · 数据/结构非法 → TEXTURE_DECODE（可能是块尺寸判断错，属于真 bug 类）
  const LOCAL_CODES = {
    BAD_ARGS: 'TEX_ERR_BAD_ARGS',
    TEXTURE_FORMAT_UNSUPPORTED: 'TEX_ERR_FORMAT_UNSUPPORTED',
    TEXTURE_DATA_SHORT: 'TEX_ERR_DATA_SHORT',
    TEXTURE_DECODE: 'TEX_ERR_DECODE',
  };

  /**
   * 构造带稳定错误码的 Error。
   * @param {string} codeKey LOCAL_CODES 的键名（同时用于查插件的 CODES 表）
   * @param {string} message 中文可读说明（要能直接看懂"哪张图、哪一格、为什么"）
   */
  function fail(codeKey, message) {
    const codes = NS.errors && NS.errors.CODES ? NS.errors.CODES : LOCAL_CODES;
    const code = codes[codeKey] || LOCAL_CODES[codeKey] || codeKey;
    if (NS.errors && typeof NS.errors.fail === 'function') {
      return NS.errors.fail(code, message);
    }
    const err = new Error(message);
    err.code = code;
    err.tex = true;
    return err;
  }

  // ---------------------------------------------------------------- 常量
  //
  // ASTC 规定的块边长上限：块内最多 12×12 个纹素（权重网格最大也是 12×12）。
  //   这不是"我们只支持 12 以内"，而是格式本身的上限。
  const MAX_BLOCK_SIDE = 12;

  // 规格允许的全部块尺寸（高度不超过宽度）。Unity 的 ASTC_* 格式只用正方块，
  //   但解码逻辑与块尺寸无关，把整张表都认下来可以顺手支持非正方的 ASTC 数据。
  const ASTC_BLOCK_DIMENSIONS = new Set([
    '4x4', '5x4', '5x5', '6x5', '6x6', '8x5', '8x6',
    '8x8', '10x5', '10x6', '10x8', '10x10', '12x10', '12x12',
  ]);

  // 一个块固定 16 字节。写死成常量而不是算出来，是为了让"块表 / 数据长度"两处口径一眼能对。
  const BLOCK_BYTES = 16;

  // 权重网格里最多 64 个权重（12×12 已是 144，但规格把上限压在 64 —— 双平面时两个平面共享这 64 个槽）
  const MAX_WEIGHTS = 64;

  // 端点值的上限：4 个分区 × 每分区最多 8 个值 = 18（4 分区时 CEM 0/1 只给 2 个值，故 18 是理论上限）
  const MAX_ENDPOINT_VALUES = 18;

  // 三种整数序列编码模式（ASTC 用三进制/五进制/纯二进制打包端点与权重）
  const ISE_MODE_TRIT = 0;
  const ISE_MODE_QUINT = 1;
  const ISE_MODE_PLAIN_BIT = 2;

  // 三进制序列查表：8 bit 的 T 值 → 5 个三进制数。
  //   表是从参考实现原样搬来的（规格附录给出同样内容）；不要手推，推错一格就整片花。
  const TRITS_FROM_T = [
    0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 2, 1, 0, 0, 0, 1, 0, 2, 0, 0,
    0, 2, 0, 0, 0, 1, 2, 0, 0, 0, 2, 2, 0, 0, 0, 2, 0, 2, 0, 0, 0, 2, 2, 0, 0, 1, 2, 2, 0, 0, 2, 2, 2, 0, 0, 2, 0, 2, 0, 0,
    0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 2, 0, 1, 0, 0, 0, 1, 2, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 2, 1, 1, 0, 0, 1, 1, 2, 0, 0,
    0, 2, 1, 0, 0, 1, 2, 1, 0, 0, 2, 2, 1, 0, 0, 2, 1, 2, 0, 0, 0, 0, 0, 2, 2, 1, 0, 0, 2, 2, 2, 0, 0, 2, 2, 0, 0, 2, 2, 2,
    0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 2, 0, 0, 1, 0, 0, 0, 2, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 2, 1, 0, 1, 0, 1, 0, 2, 1, 0,
    0, 2, 0, 1, 0, 1, 2, 0, 1, 0, 2, 2, 0, 1, 0, 2, 0, 2, 1, 0, 0, 2, 2, 1, 0, 1, 2, 2, 1, 0, 2, 2, 2, 1, 0, 2, 0, 2, 1, 0,
    0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 2, 0, 1, 1, 0, 0, 1, 2, 1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 1, 0, 2, 1, 1, 1, 0, 1, 1, 2, 1, 0,
    0, 2, 1, 1, 0, 1, 2, 1, 1, 0, 2, 2, 1, 1, 0, 2, 1, 2, 1, 0, 0, 1, 0, 2, 2, 1, 1, 0, 2, 2, 2, 1, 0, 2, 2, 1, 0, 2, 2, 2,
    0, 0, 0, 2, 0, 1, 0, 0, 2, 0, 2, 0, 0, 2, 0, 0, 0, 2, 2, 0, 0, 1, 0, 2, 0, 1, 1, 0, 2, 0, 2, 1, 0, 2, 0, 1, 0, 2, 2, 0,
    0, 2, 0, 2, 0, 1, 2, 0, 2, 0, 2, 2, 0, 2, 0, 2, 0, 2, 2, 0, 0, 2, 2, 2, 0, 1, 2, 2, 2, 0, 2, 2, 2, 2, 0, 2, 0, 2, 2, 0,
    0, 0, 1, 2, 0, 1, 0, 1, 2, 0, 2, 0, 1, 2, 0, 0, 1, 2, 2, 0, 0, 1, 1, 2, 0, 1, 1, 1, 2, 0, 2, 1, 1, 2, 0, 1, 1, 2, 2, 0,
    0, 2, 1, 2, 0, 1, 2, 1, 2, 0, 2, 2, 1, 2, 0, 2, 1, 2, 2, 0, 0, 2, 0, 2, 2, 1, 2, 0, 2, 2, 2, 2, 0, 2, 2, 2, 0, 2, 2, 2,
    0, 0, 0, 0, 2, 1, 0, 0, 0, 2, 2, 0, 0, 0, 2, 0, 0, 2, 0, 2, 0, 1, 0, 0, 2, 1, 1, 0, 0, 2, 2, 1, 0, 0, 2, 1, 0, 2, 0, 2,
    0, 2, 0, 0, 2, 1, 2, 0, 0, 2, 2, 2, 0, 0, 2, 2, 0, 2, 0, 2, 0, 2, 2, 0, 2, 1, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2, 0, 2, 0, 2,
    0, 0, 1, 0, 2, 1, 0, 1, 0, 2, 2, 0, 1, 0, 2, 0, 1, 2, 0, 2, 0, 1, 1, 0, 2, 1, 1, 1, 0, 2, 2, 1, 1, 0, 2, 1, 1, 2, 0, 2,
    0, 2, 1, 0, 2, 1, 2, 1, 0, 2, 2, 2, 1, 0, 2, 2, 1, 2, 0, 2, 0, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 2, 2, 2,
    0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 2, 0, 0, 0, 1, 0, 0, 2, 0, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 2, 1, 0, 0, 1, 1, 0, 2, 0, 1,
    0, 2, 0, 0, 1, 1, 2, 0, 0, 1, 2, 2, 0, 0, 1, 2, 0, 2, 0, 1, 0, 2, 2, 0, 1, 1, 2, 2, 0, 1, 2, 2, 2, 0, 1, 2, 0, 2, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 1, 0, 1, 2, 0, 1, 0, 1, 0, 1, 2, 0, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 2, 1, 1, 0, 1, 1, 1, 2, 0, 1,
    0, 2, 1, 0, 1, 1, 2, 1, 0, 1, 2, 2, 1, 0, 1, 2, 1, 2, 0, 1, 0, 0, 1, 2, 2, 1, 0, 1, 2, 2, 2, 0, 1, 2, 2, 0, 1, 2, 2, 2,
    0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 2, 0, 0, 1, 1, 0, 0, 2, 1, 1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 1, 2, 1, 0, 1, 1, 1, 0, 2, 1, 1,
    0, 2, 0, 1, 1, 1, 2, 0, 1, 1, 2, 2, 0, 1, 1, 2, 0, 2, 1, 1, 0, 2, 2, 1, 1, 1, 2, 2, 1, 1, 2, 2, 2, 1, 1, 2, 0, 2, 1, 1,
    0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 2, 0, 1, 1, 1, 0, 1, 2, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 2, 1, 1,
    0, 2, 1, 1, 1, 1, 2, 1, 1, 1, 2, 2, 1, 1, 1, 2, 1, 2, 1, 1, 0, 1, 1, 2, 2, 1, 1, 1, 2, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2, 2,
    0, 0, 0, 2, 1, 1, 0, 0, 2, 1, 2, 0, 0, 2, 1, 0, 0, 2, 2, 1, 0, 1, 0, 2, 1, 1, 1, 0, 2, 1, 2, 1, 0, 2, 1, 1, 0, 2, 2, 1,
    0, 2, 0, 2, 1, 1, 2, 0, 2, 1, 2, 2, 0, 2, 1, 2, 0, 2, 2, 1, 0, 2, 2, 2, 1, 1, 2, 2, 2, 1, 2, 2, 2, 2, 1, 2, 0, 2, 2, 1,
    0, 0, 1, 2, 1, 1, 0, 1, 2, 1, 2, 0, 1, 2, 1, 0, 1, 2, 2, 1, 0, 1, 1, 2, 1, 1, 1, 1, 2, 1, 2, 1, 1, 2, 1, 1, 1, 2, 2, 1,
    0, 2, 1, 2, 1, 1, 2, 1, 2, 1, 2, 2, 1, 2, 1, 2, 1, 2, 2, 1, 0, 2, 1, 2, 2, 1, 2, 1, 2, 2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2,
    0, 0, 0, 1, 2, 1, 0, 0, 1, 2, 2, 0, 0, 1, 2, 0, 0, 2, 1, 2, 0, 1, 0, 1, 2, 1, 1, 0, 1, 2, 2, 1, 0, 1, 2, 1, 0, 2, 1, 2,
    0, 2, 0, 1, 2, 1, 2, 0, 1, 2, 2, 2, 0, 1, 2, 2, 0, 2, 1, 2, 0, 2, 2, 1, 2, 1, 2, 2, 1, 2, 2, 2, 2, 1, 2, 2, 0, 2, 1, 2,
    0, 0, 1, 1, 2, 1, 0, 1, 1, 2, 2, 0, 1, 1, 2, 0, 1, 2, 1, 2, 0, 1, 1, 1, 2, 1, 1, 1, 1, 2, 2, 1, 1, 1, 2, 1, 1, 2, 1, 2,
    0, 2, 1, 1, 2, 1, 2, 1, 1, 2, 2, 2, 1, 1, 2, 2, 1, 2, 1, 2, 0, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2,
  ];

  // 五进制序列查表：7 bit 的 Q 值 → 3 个五进制数（Q 只用 7 bit，故 128 行）
  const QUINTS_FROM_Q = [
    0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0, 0, 4, 0, 4, 4, 0, 4, 4, 4,
    0, 1, 0, 1, 1, 0, 2, 1, 0, 3, 1, 0, 4, 1, 0, 1, 4, 0, 4, 4, 1, 4, 4, 4,
    0, 2, 0, 1, 2, 0, 2, 2, 0, 3, 2, 0, 4, 2, 0, 2, 4, 0, 4, 4, 2, 4, 4, 4,
    0, 3, 0, 1, 3, 0, 2, 3, 0, 3, 3, 0, 4, 3, 0, 3, 4, 0, 4, 4, 3, 4, 4, 4,
    0, 0, 1, 1, 0, 1, 2, 0, 1, 3, 0, 1, 4, 0, 1, 0, 4, 1, 4, 0, 4, 0, 4, 4,
    0, 1, 1, 1, 1, 1, 2, 1, 1, 3, 1, 1, 4, 1, 1, 1, 4, 1, 4, 1, 4, 1, 4, 4,
    0, 2, 1, 1, 2, 1, 2, 2, 1, 3, 2, 1, 4, 2, 1, 2, 4, 1, 4, 2, 4, 2, 4, 4,
    0, 3, 1, 1, 3, 1, 2, 3, 1, 3, 3, 1, 4, 3, 1, 3, 4, 1, 4, 3, 4, 3, 4, 4,
    0, 0, 2, 1, 0, 2, 2, 0, 2, 3, 0, 2, 4, 0, 2, 0, 4, 2, 2, 0, 4, 3, 0, 4,
    0, 1, 2, 1, 1, 2, 2, 1, 2, 3, 1, 2, 4, 1, 2, 1, 4, 2, 2, 1, 4, 3, 1, 4,
    0, 2, 2, 1, 2, 2, 2, 2, 2, 3, 2, 2, 4, 2, 2, 2, 4, 2, 2, 2, 4, 3, 2, 4,
    0, 3, 2, 1, 3, 2, 2, 3, 2, 3, 3, 2, 4, 3, 2, 3, 4, 2, 2, 3, 4, 3, 3, 4,
    0, 0, 3, 1, 0, 3, 2, 0, 3, 3, 0, 3, 4, 0, 3, 0, 4, 3, 0, 0, 4, 1, 0, 4,
    0, 1, 3, 1, 1, 3, 2, 1, 3, 3, 1, 3, 4, 1, 3, 1, 4, 3, 0, 1, 4, 1, 1, 4,
    0, 2, 3, 1, 2, 3, 2, 2, 3, 3, 2, 3, 4, 2, 3, 2, 4, 3, 0, 2, 4, 1, 2, 4,
    0, 3, 3, 1, 3, 3, 2, 3, 3, 3, 3, 3, 4, 3, 3, 3, 4, 3, 0, 3, 4, 1, 3, 4,
  ];

  // ---------------------------------------------------------------- 位读取
  //
  // ASTC 的位编号从块的第 1 个字节的最低位开始（bit 0 = byte0 & 1），
  // 与常见的"大端位流"相反 —— 位序弄反的表现是整片花屏，所以这里只提供两个入口，
  // 且都按同一套编号规则实现，避免各处各写一套。

  /** 一个 128 bit 块的位访问器（对应参考实现的 Block128） */
  class BlockBits {
    /**
     * @param {Uint8Array} source 整份纹理数据
     * @param {number} byteOffset 本块在 source 里的起始字节
     */
    constructor(source, byteOffset) {
      this.source = source;
      // 块按 32 位小端拆成 4 个字：位号 i 落在 words[i>>5] 的第 (i&31) 位。
      //   为什么要预拆：解码一个块要取几十次位，按字节逐段拼会在 4 万块规模下成为最大热点
      //   （实测取位占解码总耗时四成以上）。拆成字之后每次取位只是两三次位运算。
      this.words = new Uint32Array(4);
      this.setOffset(byteOffset);
    }

    /** 复用同一个访问器处理下一个块（每块换一次偏移，不重新建对象） */
    setOffset(byteOffset) {
      const source = this.source;
      const words = this.words;
      for (let wordIndex = 0; wordIndex < 4; wordIndex++) {
        const base = byteOffset + wordIndex * 4;
        words[wordIndex] = (source[base]
          | (source[base + 1] << 8)
          | (source[base + 2] << 16)
          | (source[base + 3] << 24)) >>> 0;
      }
    }

    /** 取第 index 位（0 = 最低位） */
    bitAt(index) {
      return (this.words[index >>> 5] >>> (index & 31)) & 1;
    }

    /**
     * 取 [low, high] 闭区间内的位，返回无符号整数（最多 32 位，与 ASTC 单字段宽度上限一致）。
     */
    bits(low, high) {
      return readBits(this.words, low, high);
    }
  }

  /** 把若干位逆序（参考实现的 reverseBits）：从 startNdx 往回读时必须用 */
  function reverseBits(source, numBits) {
    let result = 0;
    for (let i = 0; i < numBits; i++) {
      result |= ((source >> i) & 1) << (numBits - 1 - i);
    }
    return result >>> 0;
  }

  /**
   * 顺序位流（对应参考实现的 BitAccessStream）。
   *
   * 为什么要它：ASTC 把"权重"和"端点"分别放在块的两端、朝相反方向写 ——
   *   权重从 bit 127 往前读，端点从中间往后读。方向记错就是整片乱码。
   */
  class BitStream {
    /**
     * @param {BlockBits} block 块位访问器
     * @param {number} startNdx 起点位号
     * @param {number} length 可用位数（超出部分一律读 0，不是报错）
     * @param {boolean} forward true = 位号递增方向
     */
    constructor(block, startNdx, length, forward) {
      this.block = block;
      this.words = block ? block.words : null;
      this.startNdx = startNdx;
      this.length = length;
      this.forward = forward;
      this.cursor = 0;
    }

    /** 复用同一个位流对象读下一个块（避免每块新建两个对象带来的 GC 抖动） */
    reset(block, startNdx, length, forward) {
      this.block = block;
      // 把四个字直接挂到流上：位流是解码最热的路径（每块几十次取位），
      //   少一层 `this.block.words` 的属性链在 4 万块规模下也是实打实的时间。
      this.words = block.words;
      this.startNdx = startNdx;
      this.length = length;
      this.forward = forward;
      this.cursor = 0;
    }

    /** 取接下来的 num 位；越过 length 的部分按 0 补（与规格一致，不抛错） */
    next(num) {
      if (num === 0 || this.cursor >= this.length) return 0;
      const low = this.cursor;
      const end = low + num;
      // 超出可用长度的部分按 0 补：只读到 length 为止
      const numBitsFromSource = end <= this.length ? num : this.length - low;
      this.cursor = end;
      if (numBitsFromSource <= 0) return 0;
      const high = low + numBitsFromSource - 1;
      const startNdx = this.startNdx;
      const words = this.words;
      if (this.forward) return readBits(words, startNdx + low, startNdx + high);
      return reverseBits(readBits(words, startNdx - high, startNdx - low), numBitsFromSource);
    }
  }

  /**
   * 从预拆好的 4 个 32 位字里取 [low, high] 闭区间的位（最多 32 位）。
   * 独立成自由函数（而不是 BlockBits 的方法）：位流调用它几百万次，自由函数的调用开销更低。
   */
  function readBits(words, low, high) {
    const count = high - low + 1;
    if (count <= 0) return 0;
    const wordIndex = low >>> 5;
    const bitInWord = low & 31;
    const mask = count >= 32 ? 0xffffffff : (0xffffffff >>> (32 - count));
    const firstPart = words[wordIndex] >>> bitInWord;
    if (bitInWord + count <= 32) return (firstPart & mask) >>> 0;
    // 跨字：低字的高位段 + 高字的低位段
    const bitsFromFirst = 32 - bitInWord;
    const restCount = count - bitsFromFirst;
    const restMask = restCount >= 32 ? 0xffffffff : (0xffffffff >>> (32 - restCount));
    return (firstPart | ((words[wordIndex + 1] & restMask) << bitsFromFirst)) >>> 0;
  }

  // ---------------------------------------------------------------- 通用小工具

  /** 向上取整的整除（参考实现的 deDivRoundUp32） */
  function divRoundUp(value, divisor) {
    return Math.floor((value + divisor - 1) / divisor);
  }

  /**
   * 位复制扩展：把 numSrcBits 位的值"重复铺"到 numDstBits 位（ASTC 的端点/权重量化复原）。
   * 例：2 位值 0b10 铺到 8 位 → 0b10101010。取高位重复，等价于乘 (2^n-1)/(2^m-1)。
   */
  function bitReplicationScale(source, numSrcBits, numDstBits) {
    if (numSrcBits <= 0) return 0;
    let destination = 0;
    for (let shift = numDstBits - numSrcBits; shift > -numSrcBits; shift -= numSrcBits) {
      destination |= shift >= 0 ? source << shift : source >> -shift;
    }
    return destination >>> 0;
  }

  /** 取某数的第 index 位（0 起） */
  function bitAt(value, index) {
    return (value >> index) & 1;
  }

  // ---------------------------------------------------------------- 块模式
  //
  // 块模式（bit 0..10）同时编码：权重网格尺寸、是否有第二平面、权重的整数编码方式。
  // 这段的分支形状完全由规格表决定，不能"简化"——每个分支对应一组合法的块形态。

  /**
   * 解析块模式（带缓存）。
   *
   * 块模式只有 11 bit（2048 种取值），而一张大纹理要解几十万块 —— 同一模式会反复出现。
   *   解析本身是十几次分支，缓存后每块只剩一次取位 + 一次查表。
   *   返回的对象**只读**：调用方不得改写（缓存会共享同一份）。
   * @param {BlockBits} block
   * @returns {{isError:boolean, isVoidExtent:boolean, isDualPlane:boolean, weightGridWidth:number,
   *            weightGridHeight:number, weightMode:number, weightBits:number}}
   */
  function readBlockMode(block) {
    const modeValue = block.bits(0, 10);
    const cached = blockModeCache.get(modeValue);
    if (cached !== undefined) return cached;
    const parsed = decodeBlockModeValue(block);
    blockModeCache.set(modeValue, parsed);
    return parsed;
  }

  /** 块模式缓存（键 = 11 bit 的块模式值；内容只依赖它，与块内其它位无关） */
  const blockModeCache = new Map();

  /** 真正解析块模式（每种取值只跑一次） */
  function decodeBlockModeValue(block) {
    const mode = {
      isError: true,
      isVoidExtent: block.bits(0, 8) === 0x1fc,
      isDualPlane: false,
      weightGridWidth: 0,
      weightGridHeight: 0,
      weightMode: ISE_MODE_PLAIN_BIT,
      weightBits: 0,
    };
    if (mode.isVoidExtent) {
      mode.isError = false;
      return mode;
    }

    // 两种"保留"组合：低两位为 0 且 bit6..8 全 1；或低 4 位全 0。规格要求解码器视其为非法块。
    if ((block.bits(0, 1) === 0 && block.bits(6, 8) === 7) || block.bits(0, 3) === 0) {
      return mode;
    }

    let r = -1;
    if (block.bits(0, 1) === 0) {
      const r0 = block.bitAt(4);
      const r1 = block.bitAt(2);
      const r2 = block.bitAt(3);
      const bits78 = block.bits(7, 8);
      r = (r2 << 2) | (r1 << 1) | r0;
      if (bits78 === 3) {
        const bit5 = block.bitAt(5) !== 0;
        mode.weightGridWidth = bit5 ? 10 : 6;
        mode.weightGridHeight = bit5 ? 6 : 10;
      } else {
        const a = block.bits(5, 6);
        if (bits78 === 0) {
          mode.weightGridWidth = 12;
          mode.weightGridHeight = a + 2;
        } else if (bits78 === 1) {
          mode.weightGridWidth = a + 2;
          mode.weightGridHeight = 12;
        } else if (bits78 === 2) {
          mode.weightGridWidth = a + 6;
          mode.weightGridHeight = block.bits(9, 10) + 6;
        } else {
          return mode; // 规格里不存在第 4 种取值，按非法块处理
        }
      }
    } else {
      const r0 = block.bitAt(4);
      const r1 = block.bitAt(0);
      const r2 = block.bitAt(1);
      const bits23 = block.bits(2, 3);
      const a = block.bits(5, 6);
      r = (r2 << 2) | (r1 << 1) | r0;
      if (bits23 === 3) {
        const b = block.bitAt(7);
        const bit8 = block.bitAt(8) !== 0;
        mode.weightGridWidth = bit8 ? b + 2 : a + 2;
        mode.weightGridHeight = bit8 ? a + 2 : b + 6;
      } else {
        const b = block.bits(7, 8);
        if (bits23 === 0) {
          mode.weightGridWidth = b + 4;
          mode.weightGridHeight = a + 2;
        } else if (bits23 === 1) {
          mode.weightGridWidth = b + 8;
          mode.weightGridHeight = a + 2;
        } else if (bits23 === 2) {
          mode.weightGridWidth = a + 2;
          mode.weightGridHeight = b + 8;
        } else {
          return mode;
        }
      }
    }

    // bit 9 = 权重编码是否用"大范围"表（规格称 H 位），bit 10 = 是否有第二平面。
    //   特例：低两位为 0 且 bit7..8 = 2 的组合里，bit9/bit10 不表示这两个含义（规格的 zeroDH）。
    const zeroDH = block.bits(0, 1) === 0 && block.bits(7, 8) === 2;
    const hasLargeRange = zeroDH ? false : block.bitAt(9) !== 0;
    mode.isDualPlane = zeroDH ? false : block.bitAt(10) !== 0;

    mode.weightMode = ISE_MODE_PLAIN_BIT;
    mode.weightBits = 0;
    if (hasLargeRange) {
      switch (r) {
        case 2: mode.weightMode = ISE_MODE_QUINT; mode.weightBits = 1; break;
        case 3: mode.weightMode = ISE_MODE_TRIT; mode.weightBits = 2; break;
        case 4: mode.weightBits = 4; break;
        case 5: mode.weightMode = ISE_MODE_QUINT; mode.weightBits = 2; break;
        case 6: mode.weightMode = ISE_MODE_TRIT; mode.weightBits = 3; break;
        case 7: mode.weightBits = 5; break;
        default: return mode;
      }
    } else {
      switch (r) {
        case 2: mode.weightBits = 1; break;
        case 3: mode.weightMode = ISE_MODE_TRIT; break;
        case 4: mode.weightBits = 2; break;
        case 5: mode.weightMode = ISE_MODE_QUINT; break;
        case 6: mode.weightMode = ISE_MODE_TRIT; mode.weightBits = 1; break;
        case 7: mode.weightBits = 3; break;
        default: return mode;
      }
    }

    mode.isError = false;
    return mode;
  }

  /** 权重网格里有多少个权重值（双平面时两个平面各一套） */
  function computeNumWeights(mode) {
    return mode.weightGridWidth * mode.weightGridHeight * (mode.isDualPlane ? 2 : 1);
  }

  /** 某模式下权重数据占多少位（三进制/五进制还要额外算打包开销） */
  function computeNumRequiredBits(iseMode, iseBits, numValues) {
    if (iseMode === ISE_MODE_TRIT) return divRoundUp(numValues * 8, 5) + numValues * iseBits;
    if (iseMode === ISE_MODE_QUINT) return divRoundUp(numValues * 7, 3) + numValues * iseBits;
    return numValues * iseBits;
  }

  /**
   * 在给定可用位数下，选"能装下 numValues 个值的最宽"整数编码方案。
   * 为什么要选最大的：端点精度直接决定颜色准确度，用窄模式会白丢精度。
   *
   * 结果只由 (可用位数, 值个数) 决定，而这两个数在大纹理里取值很少 ⇒ 缓存起来。
   */
  function computeMaximumRangeISEParams(numAvailableBits, numValuesInSequence) {
    const cacheKey = numAvailableBits * 64 + numValuesInSequence;
    const cached = iseParamsCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const params = computeMaximumRangeISEParamsUncached(numAvailableBits, numValuesInSequence);
    iseParamsCache.set(cacheKey, params);
    return params;
  }

  /** ISE 参数缓存（键 = 可用位数 × 64 + 值个数；值个数上限 18、位数上限 96，不会撞键） */
  const iseParamsCache = new Map();

  function computeMaximumRangeISEParamsUncached(numAvailableBits, numValuesInSequence) {
    let tritBits = 6;
    let quintBits = 5;
    let plainBits = 8;
    for (;;) {
      const tritRange = tritBits > 0 ? (3 << tritBits) - 1 : -1;
      const quintRange = quintBits > 0 ? (5 << quintBits) - 1 : -1;
      const plainRange = plainBits > 0 ? (1 << plainBits) - 1 : -1;
      const maxRange = Math.max(tritRange, quintRange, plainRange);
      if (maxRange === tritRange) {
        if (computeNumRequiredBits(ISE_MODE_TRIT, tritBits, numValuesInSequence) <= numAvailableBits) {
          return { mode: ISE_MODE_TRIT, numBits: tritBits };
        }
        tritBits--;
      } else if (maxRange === quintRange) {
        if (computeNumRequiredBits(ISE_MODE_QUINT, quintBits, numValuesInSequence) <= numAvailableBits) {
          return { mode: ISE_MODE_QUINT, numBits: quintBits };
        }
        quintBits--;
      } else {
        if (computeNumRequiredBits(ISE_MODE_PLAIN_BIT, plainBits, numValuesInSequence) <= numAvailableBits) {
          return { mode: ISE_MODE_PLAIN_BIT, numBits: plainBits };
        }
        plainBits--;
      }
    }
  }

  // ---------------------------------------------------------------- 整数序列（ISE）解码
  //
  // ASTC 把端点/权重当"三进制或五进制的整数序列"打包，压缩率比纯二进制高。
  // 每个值要同时带三样东西：m = 低位原始位，tq = 三进制或五进制数，v = tq 拼在 m 之上的完整值。
  //
  // 为什么用扁平 3 槽数组而不是 {m,tq,v} 对象：一张 1024² 的 5x5 纹理要解约 200 万个这样的值，
  //   每个建一个对象就是 200 万次分配 —— 实测这是解码耗时里最大的一块（远超算术本身）。
  const ISE_STRIDE = 3;
  const ISE_M = 0;
  const ISE_TQ = 1;
  const ISE_V = 2;

  function decodeTritBlock(out, outValueIndex, numValues, stream, numBits) {
    const m = new Array(5);
    m[0] = stream.next(numBits);
    const t01 = stream.next(2);
    m[1] = stream.next(numBits);
    let t23 = stream.next(2);
    m[2] = stream.next(numBits);
    let t4 = stream.next(1);
    m[3] = stream.next(numBits);
    let t56 = stream.next(2);
    m[4] = stream.next(numBits);
    let t7 = stream.next(1);

    // 值不够时，高位三进制数按规格清零（顺序不能乱：后面的依赖前面的清零结果）
    if (numValues <= 4) t7 = 0;
    if (numValues <= 3) t56 = 0;
    if (numValues <= 2) t4 = 0;
    if (numValues <= 1) t23 = 0;

    const t = (t7 << 7) | (t56 << 5) | (t4 << 4) | (t23 << 2) | t01;
    const tableIndex = t * 5;
    for (let i = 0; i < numValues; i++) {
      const trit = TRITS_FROM_T[tableIndex + i];
      const slot = (outValueIndex + i) * ISE_STRIDE;
      out[slot + ISE_M] = m[i];
      out[slot + ISE_TQ] = trit;
      out[slot + ISE_V] = (trit << numBits) + m[i];
    }
  }

  function decodeQuintBlock(out, outValueIndex, numValues, stream, numBits) {
    const m = new Array(3);
    m[0] = stream.next(numBits);
    const q012 = stream.next(3);
    m[1] = stream.next(numBits);
    let q34 = stream.next(2);
    m[2] = stream.next(numBits);
    let q56 = stream.next(2);

    if (numValues <= 2) q56 = 0;
    if (numValues <= 1) q34 = 0;

    const q = (q56 << 5) | (q34 << 3) | q012;
    const tableIndex = q * 3;
    for (let i = 0; i < numValues; i++) {
      const quint = QUINTS_FROM_Q[tableIndex + i];
      const slot = (outValueIndex + i) * ISE_STRIDE;
      out[slot + ISE_M] = m[i];
      out[slot + ISE_TQ] = quint;
      out[slot + ISE_V] = (quint << numBits) + m[i];
    }
  }

  function decodeIESequence(out, numValues, stream, iseMode, numBits) {
    if (iseMode === ISE_MODE_TRIT) {
      const numBlocks = divRoundUp(numValues, 5);
      for (let blockIndex = 0; blockIndex < numBlocks; blockIndex++) {
        const isLast = blockIndex === numBlocks - 1;
        const numValuesInBlock = isLast ? numValues - 5 * (numBlocks - 1) : 5;
        decodeTritBlock(out, 5 * blockIndex, numValuesInBlock, stream, numBits);
      }
    } else if (iseMode === ISE_MODE_QUINT) {
      const numBlocks = divRoundUp(numValues, 3);
      for (let blockIndex = 0; blockIndex < numBlocks; blockIndex++) {
        const isLast = blockIndex === numBlocks - 1;
        const numValuesInBlock = isLast ? numValues - 3 * (numBlocks - 1) : 3;
        decodeQuintBlock(out, 3 * blockIndex, numValuesInBlock, stream, numBits);
      }
    } else {
      for (let i = 0; i < numValues; i++) {
        const value = stream.next(numBits);
        const slot = i * ISE_STRIDE;
        out[slot + ISE_M] = value;
        out[slot + ISE_TQ] = 0;
        out[slot + ISE_V] = value;
      }
    }
  }

  // ---------------------------------------------------------------- 端点解量化
  //
  // 三进制/五进制序列要先"复原"成 8 bit 颜色值：规格给的是查表 + 位拼，
  //   这里的常量 Ca 与 B 的拼法都来自规格表，不能改写。

  const ENDPOINT_UNQUANT_C = [204, 113, 93, 54, 44, 26, 22, 13, 11, 6, 5];

  function unquantizeColorEndpoints(destination, iseResults, numEndpoints, iseMode, iseBits) {
    if (iseMode === ISE_MODE_TRIT || iseMode === ISE_MODE_QUINT) {
      const rangeCase = iseBits * 2 - (iseMode === ISE_MODE_TRIT ? 2 : 1);
      const c = ENDPOINT_UNQUANT_C[rangeCase];
      for (let endpointIndex = 0; endpointIndex < numEndpoints; endpointIndex++) {
        const slot = endpointIndex * ISE_STRIDE;
        const m = iseResults[slot + ISE_M];
        const tq = iseResults[slot + ISE_TQ];
        const a = bitAt(m, 0);
        const b = bitAt(m, 1);
        const cc = bitAt(m, 2);
        const d = bitAt(m, 3);
        const e = bitAt(m, 4);
        const f = bitAt(m, 5);
        const aBits = a === 0 ? 0 : (1 << 9) - 1;
        let bBits;
        switch (rangeCase) {
          case 0: case 1: bBits = 0; break;
          case 2: bBits = (b << 8) | (b << 4) | (b << 2) | (b << 1); break;
          case 3: bBits = (b << 8) | (b << 3) | (b << 2); break;
          case 4: bBits = (cc << 8) | (b << 7) | (cc << 3) | (b << 2) | (cc << 1) | b; break;
          case 5: bBits = (cc << 8) | (b << 7) | (cc << 2) | (b << 1) | cc; break;
          case 6: bBits = (d << 8) | (cc << 7) | (b << 6) | (d << 2) | (cc << 1) | b; break;
          case 7: bBits = (d << 8) | (cc << 7) | (b << 6) | (d << 1) | cc; break;
          case 8: bBits = (e << 8) | (d << 7) | (cc << 6) | (b << 5) | (e << 1) | d; break;
          case 9: bBits = (e << 8) | (d << 7) | (cc << 6) | (b << 5) | e; break;
          case 10: bBits = (f << 8) | (e << 7) | (d << 6) | (cc << 5) | (b << 4) | f; break;
          default: throw fail('TEXTURE_DECODE', `ASTC 端点解量化：非法范围档位 ${rangeCase}`);
        }
        destination[endpointIndex] = (((tq * c + bBits) ^ aBits) >> 2) | (aBits & 0x80);
      }
      return;
    }
    for (let endpointIndex = 0; endpointIndex < numEndpoints; endpointIndex++) {
      destination[endpointIndex] = bitReplicationScale(
        iseResults[endpointIndex * ISE_STRIDE + ISE_V], iseBits, 8);
    }
  }

  // ---------------------------------------------------------------- 颜色端点合成
  //
  // 端点模式（CEM）决定"这两个端点怎么解释成 RGBA"：纯亮度 / 亮度+增量 / RGB / RGB+缩放 …
  //   模式 2/3/7/11/14/15 属 HDR（用 FP16 表示亮度），本解码器不支持 → 抛"格式未支持"。

  const HDR_ENDPOINT_MODES = new Set([2, 3, 7, 11, 14, 15]);

  function isHdrEndpointMode(endpointMode) {
    return HDR_ENDPOINT_MODES.has(endpointMode);
  }

  /**
   * 有符号位转移（规格里的 bit_transfer_signed）：把一个无符号量拆成"符号位 + 幅值"。
   * 注意它成对作用且**参数次序有语义**：第一个参数 a 贡献"符号位(bit7) + 幅值(bit0..5)"，
   *   第二个参数 b 右移后接上符号位成为增量。调用处一律写 `[a, b] = bitTransferSigned(a, b)`，
   *   次序写反（把结果对调赋值）不会报错，只会让"增量型端点模式"整片偏色 —— 实测踩过一次。
   */
  function bitTransferSigned(a, b) {
    let nextB = b >> 1;
    nextB |= a & 0x80;
    let nextA = a >> 1;
    nextA &= 0x3f;
    if (bitAt(nextA, 5)) nextA -= 0x40;
    return [nextA, nextB];
  }

  function clampByte(value) {
    if (value < 0) return 0;
    if (value > 0xff) return 0xff;
    return value;
  }

  function blueContract(r, g, b, a) {
    return [clampByte((r + b) >> 1), clampByte((g + b) >> 1), clampByte(b), clampByte(a)];
  }

  /**
   * 把某分区的两个端点（各 4 通道）按端点模式算出来，写进扁平缓冲。
   *
   * 布局：out[outOffset + 0..3] = 端点 0 的 R,G,B,A；out[outOffset + 4..7] = 端点 1。
   * 用扁平缓冲而不是"每块新建 {e0,e1} 对象"：一张 1024² 的 5x5 纹理有 4 万个块，
   *   每块再乘分区数就是十几万次小数组分配，实测这在总耗时里占了相当一块。
   *
   * @param {number} endpointMode 端点模式（0..15）
   * @param {Array<number>} values 解量化后的端点值序列（复用缓冲，未使用的尾部可能是上一块的残留，
   *                               所以每个模式只许读自己的那 numValues 个）
   * @param {number} valueOffset 本分区第一个端点值在 values 里的下标
   * @param {Int32Array} out 输出缓冲
   * @param {number} outOffset 本分区在输出缓冲里的起点
   */
  function decodeColorEndpointPair(endpointMode, values, valueOffset, out, outOffset) {
    // 取值到局部变量：后面的分支直接读 v0..v7，避免反复算下标
    const v0 = values[valueOffset];
    const v1 = values[valueOffset + 1];
    const v2 = values[valueOffset + 2];
    const v3 = values[valueOffset + 3];
    const v4 = values[valueOffset + 4];
    const v5 = values[valueOffset + 5];
    const v6 = values[valueOffset + 6];
    const v7 = values[valueOffset + 7];

    let e0r;
    let e0g;
    let e0b;
    let e0a;
    let e1r;
    let e1g;
    let e1b;
    let e1a;

    switch (endpointMode) {
      case 0:
        e0r = v0; e0g = v0; e0b = v0; e0a = 0xff;
        e1r = v1; e1g = v1; e1b = v1; e1a = 0xff;
        break;
      case 1: {
        const l0 = (v0 >> 2) | (((v1 >> 6) & 0x3) << 6);
        const l1 = Math.min(0xff, l0 + (v1 & 0x3f));
        e0r = l0; e0g = l0; e0b = l0; e0a = 0xff;
        e1r = l1; e1g = l1; e1b = l1; e1a = 0xff;
        break;
      }
      case 4:
        e0r = v0; e0g = v0; e0b = v0; e0a = v2;
        e1r = v1; e1g = v1; e1b = v1; e1a = v3;
        break;
      case 5: {
        // 参考实现的调用形状是 bitTransferSigned(v1, v0)：第一参数取符号与幅值，第二参数接上符号位后右移。
        //   落地到端点时**第一个端点用的是第二参数（b 结果）**，第二个端点是"b 结果 + a 结果"。
        //   这个对应关系写反不会报错，只会让增量型端点整体偏色（实测踩过一次）。
        const [v1Signed, v0Delta] = bitTransferSigned(v1, v0);
        const [v3Signed, v2Delta] = bitTransferSigned(v3, v2);
        e0r = clampByte(v0Delta); e0g = clampByte(v0Delta); e0b = clampByte(v0Delta); e0a = clampByte(v2Delta);
        const luma1 = clampByte(v0Delta + v1Signed);
        const alpha1 = clampByte(v2Delta + v3Signed);
        e1r = luma1; e1g = luma1; e1b = luma1; e1a = alpha1;
        break;
      }
      case 6:
        e0r = (v0 * v3) >> 8; e0g = (v1 * v3) >> 8; e0b = (v2 * v3) >> 8; e0a = 0xff;
        e1r = v0; e1g = v1; e1b = v2; e1a = 0xff;
        break;
      case 8: {
        if (v1 + v3 + v5 >= v0 + v2 + v4) {
          e0r = v0; e0g = v2; e0b = v4; e0a = 0xff;
          e1r = v1; e1g = v3; e1b = v5; e1a = 0xff;
        } else {
          const first = blueContract(v1, v3, v5, 0xff);
          const second = blueContract(v0, v2, v4, 0xff);
          e0r = first[0]; e0g = first[1]; e0b = first[2]; e0a = first[3];
          e1r = second[0]; e1g = second[1]; e1b = second[2]; e1a = second[3];
        }
        break;
      }
      case 9: {
        const [rSigned, rDelta] = bitTransferSigned(v1, v0);
        const [gSigned, gDelta] = bitTransferSigned(v3, v2);
        const [bSigned, bDelta] = bitTransferSigned(v5, v4);
        if (rSigned + gSigned + bSigned >= 0) {
          e0r = clampByte(rDelta); e0g = clampByte(gDelta); e0b = clampByte(bDelta); e0a = 0xff;
          e1r = clampByte(rDelta + rSigned); e1g = clampByte(gDelta + gSigned);
          e1b = clampByte(bDelta + bSigned); e1a = 0xff;
        } else {
          const first = blueContract(rDelta + rSigned, gDelta + gSigned, bDelta + bSigned, 0xff);
          const second = blueContract(rDelta, gDelta, bDelta, 0xff);
          e0r = first[0]; e0g = first[1]; e0b = first[2]; e0a = first[3];
          e1r = second[0]; e1g = second[1]; e1b = second[2]; e1a = second[3];
        }
        break;
      }
      case 10:
        e0r = (v0 * v3) >> 8; e0g = (v1 * v3) >> 8; e0b = (v2 * v3) >> 8; e0a = v4;
        e1r = v0; e1g = v1; e1b = v2; e1a = v5;
        break;
      case 12: {
        if (v1 + v3 + v5 >= v0 + v2 + v4) {
          e0r = v0; e0g = v2; e0b = v4; e0a = v6;
          e1r = v1; e1g = v3; e1b = v5; e1a = v7;
        } else {
          const first = blueContract(v1, v3, v5, v7);
          const second = blueContract(v0, v2, v4, v6);
          e0r = first[0]; e0g = first[1]; e0b = first[2]; e0a = first[3];
          e1r = second[0]; e1g = second[1]; e1b = second[2]; e1a = second[3];
        }
        break;
      }
      case 13: {
        const [rSigned, rDelta] = bitTransferSigned(v1, v0);
        const [gSigned, gDelta] = bitTransferSigned(v3, v2);
        const [bSigned, bDelta] = bitTransferSigned(v5, v4);
        const [aSigned, aDelta] = bitTransferSigned(v7, v6);
        if (rSigned + gSigned + bSigned >= 0) {
          e0r = clampByte(rDelta); e0g = clampByte(gDelta); e0b = clampByte(bDelta); e0a = clampByte(aDelta);
          e1r = clampByte(rDelta + rSigned); e1g = clampByte(gDelta + gSigned);
          e1b = clampByte(bDelta + bSigned); e1a = clampByte(aDelta + aSigned);
        } else {
          const first = blueContract(rDelta + rSigned, gDelta + gSigned, bDelta + bSigned, aDelta + aSigned);
          const second = blueContract(rDelta, gDelta, bDelta, aDelta);
          e0r = first[0]; e0g = first[1]; e0b = first[2]; e0a = first[3];
          e1r = second[0]; e1g = second[1]; e1b = second[2]; e1a = second[3];
        }
        break;
      }
      default:
        // 2 / 3 / 7 / 11 / 14 / 15 是 HDR 模式（FP16 亮度），本解码器不做；
        //   其余未列举的取值在规格里不存在，同属"数据不对"。
        if (isHdrEndpointMode(endpointMode)) {
          throw fail('TEXTURE_FORMAT_UNSUPPORTED',
            `ASTC 端点模式 ${endpointMode} 属 HDR（FP16 亮度），本解码器只实现 LDR`);
        }
        throw fail('TEXTURE_DECODE', `ASTC 端点模式 ${endpointMode} 非法`);
    }

    out[outOffset + 0] = e0r;
    out[outOffset + 1] = e0g;
    out[outOffset + 2] = e0b;
    out[outOffset + 3] = e0a;
    out[outOffset + 4] = e1r;
    out[outOffset + 5] = e1g;
    out[outOffset + 6] = e1b;
    out[outOffset + 7] = e1a;
  }

  /** 每种端点模式用多少个端点值（模式除以 4 再加 1，再乘 2 —— 两个端点各一套） */
  function computeNumEndpointValuesPerMode(endpointMode) {
    return (Math.floor(endpointMode / 4) + 1) * 2;
  }

  /**
   * 解码各分区的端点模式（CEM）。
   * 单分区直接取 4 bit；多分区时先看"是否所有分区同模式"，不同则按高低位组合出来。
   */
  function decodeColorEndpointModes(block, numPartitions, extraCemBitsStart) {
    const modes = new Array(numPartitions).fill(0);
    if (numPartitions === 1) {
      modes[0] = block.bits(13, 16);
      return modes;
    }
    const highLevelSelector = block.bits(23, 24);
    if (highLevelSelector === 0) {
      const mode = block.bits(25, 28);
      for (let i = 0; i < numPartitions; i++) modes[i] = mode;
      return modes;
    }
    for (let partitionIndex = 0; partitionIndex < numPartitions; partitionIndex++) {
      const cemClass = highLevelSelector - (block.bitAt(25 + partitionIndex) ? 0 : 1);
      const lowBit0Index = numPartitions + 2 * partitionIndex;
      const lowBit1Index = numPartitions + 2 * partitionIndex + 1;
      const lowBit0 = block.bitAt(lowBit0Index < 4 ? 25 + lowBit0Index : extraCemBitsStart + lowBit0Index - 4);
      const lowBit1 = block.bitAt(lowBit1Index < 4 ? 25 + lowBit1Index : extraCemBitsStart + lowBit1Index - 4);
      modes[partitionIndex] = (cemClass << 2) | (lowBit1 << 1) | lowBit0;
    }
    return modes;
  }

  function computeTotalEndpointValues(endpointModes) {
    let total = 0;
    for (const mode of endpointModes) total += computeNumEndpointValuesPerMode(mode);
    return total;
  }

  // ---------------------------------------------------------------- 权重
  //
  // 权重是"每个网格点的混合系数"，量化到 6 bit（0..64）后插值到每个纹素。
  //   末端的 +1 修正（>32 加 1）是规格要求的"把 [0,63] 映射到 [0,64]"的非线性铺展。

  const WEIGHT_UNQUANT_C = [50, 28, 23, 13, 11];

  /**
   * 解量化权重网格。
   * @param {Int32Array} weightGrid 网格上的原始整数序列（扁平 3 槽布局，见 ISE_STRIDE）
   * @param {number} numWeights 网格点数（双平面时含两个平面）
   * @param {number} weightMode 整数序列编码模式
   * @param {number} weightBits 每值额外的原始位数
   * @param {Array<number>} weights 输出（复用调用方的 64 槽缓冲，避免每块新建数组）
   */
  function unquantizeWeights(weightGrid, numWeights, weightMode, weightBits, weights) {
    if (weightMode === ISE_MODE_TRIT || weightMode === ISE_MODE_QUINT) {
      const rangeCase = weightBits * 2 + (weightMode === ISE_MODE_QUINT ? 1 : 0);
      if (rangeCase === 0 || rangeCase === 1) {
        const map0 = [0, 32, 63];
        const map1 = [0, 16, 32, 47, 63];
        const map = rangeCase === 0 ? map0 : map1;
        for (let i = 0; i < numWeights; i++) {
          weights[i] = map[weightGrid[i * ISE_STRIDE + ISE_V]];
        }
      } else {
        const c = WEIGHT_UNQUANT_C[rangeCase - 2];
        for (let i = 0; i < numWeights; i++) {
          const slot = i * ISE_STRIDE;
          const m = weightGrid[slot + ISE_M];
          const tq = weightGrid[slot + ISE_TQ];
          const a = bitAt(m, 0);
          const b = bitAt(m, 1);
          const cc = bitAt(m, 2);
          const aBits = a === 0 ? 0 : (1 << 7) - 1;
          let bBits;
          switch (rangeCase) {
            case 2: case 3: bBits = 0; break;
            case 4: bBits = (b << 6) | (b << 2) | b; break;
            case 5: bBits = (b << 6) | (b << 1); break;
            case 6: bBits = (cc << 6) | (b << 5) | (cc << 1) | b; break;
            default: throw fail('TEXTURE_DECODE', `ASTC 权重解量化：非法范围档位 ${rangeCase}`);
          }
          weights[i] = (((tq * c + bBits) ^ aBits) >> 2) | (aBits & 0x20);
        }
      }
    } else {
      for (let i = 0; i < numWeights; i++) {
        weights[i] = bitReplicationScale(weightGrid[i * ISE_STRIDE + ISE_V], weightBits, 6);
      }
    }
    // 非线性的最后一步：>32 的值整体上抬 1，使 [0,63] 的量化级更均匀地铺到 [0,64]
    for (let i = 0; i < numWeights; i++) weights[i] += weights[i] > 32 ? 1 : 0;
    // 网格之外的槽位填"毒值"（0xFFFFFFFF）：它们**只会**被权重为 0 的系数乘到，
    //   用毒值能让"万一某处系数不该为 0 却为 0"的 bug 变成明显偏差而不是静默正确。
    for (let i = numWeights; i < MAX_WEIGHTS; i++) weights[i] = 0xffffffff;
  }

  /**
   * 把权重网格双线性插值到每个纹素。
   *
   * 关键点：网格点与纹素的映射用整数定点（16 倍分辨率），四舍五入常数 8 与 32 都是规格值；
   *   网格索引可能越界一格（右/下边界），此时对应权重系数必为 0，所以用 & 0x3f 把地址折回数组内
   *   ——越界读必须"折回但系数为 0"，直接越界会读到别的格子的权重，边界纹素就会错。
   */
  function interpolateWeights(blockWidth, blockHeight, mode, weights, texelWeights) {
    const numWeightsPerTexel = mode.isDualPlane ? 2 : 1;
    const scaleX = Math.floor((1024 + blockWidth / 2) / (blockWidth - 1));
    const scaleY = Math.floor((1024 + blockHeight / 2) / (blockHeight - 1));
    for (let texelY = 0; texelY < blockHeight; texelY++) {
      for (let texelX = 0; texelX < blockWidth; texelX++) {
        const gx = (scaleX * texelX * (mode.weightGridWidth - 1) + 32) >> 6;
        const gy = (scaleY * texelY * (mode.weightGridHeight - 1) + 32) >> 6;
        const jx = gx >> 4;
        const jy = gy >> 4;
        const fx = gx & 0xf;
        const fy = gy & 0xf;
        const w11 = (fx * fy + 8) >> 4;
        const w10 = fy - w11;
        const w01 = fx - w11;
        const w00 = 16 - fx - fy + w11;
        const i00 = jy * mode.weightGridWidth + jx;
        const i01 = i00 + 1;
        const i10 = i00 + mode.weightGridWidth;
        const i11 = i00 + mode.weightGridWidth + 1;
        const target = (texelY * blockWidth + texelX) * 2;
        for (let plane = 0; plane < numWeightsPerTexel; plane++) {
          const p00 = weights[(i00 * numWeightsPerTexel + plane) & 0x3f];
          const p01 = weights[(i01 * numWeightsPerTexel + plane) & 0x3f];
          const p10 = weights[(i10 * numWeightsPerTexel + plane) & 0x3f];
          const p11 = weights[(i11 * numWeightsPerTexel + plane) & 0x3f];
          texelWeights[target + plane] = (p00 * w00 + p01 * w01 + p10 * w10 + p11 * w11 + 8) >> 4;
        }
      }
    }
  }

  /**
   * 解出整个块的权重：从 bit 127 往回读，再解量化、插值。
   * @param {Int32Array} texelWeights 输出（每个纹素 2 个槽：平面 0 与平面 1，单平面时只有槽 0 有意义）
   * @param {object} scratch 可复用的临时缓冲（weightGrid / unquantizedWeights / weightStream）
   */
  function computeTexelWeights(block, blockWidth, blockHeight, mode, texelWeights, scratch) {
    const numWeights = computeNumWeights(mode);
    const numWeightBits = computeNumRequiredBits(mode.weightMode, mode.weightBits, numWeights);
    // 权重从块尾往前读，所以方向是 false（位号递减）
    scratch.weightStream.reset(block, 127, numWeightBits, false);
    decodeIESequence(scratch.weightGrid, numWeights, scratch.weightStream, mode.weightMode, mode.weightBits);
    unquantizeWeights(scratch.weightGrid, numWeights, mode.weightMode, mode.weightBits, scratch.unquantizedWeights);
    interpolateWeights(blockWidth, blockHeight, mode, scratch.unquantizedWeights, texelWeights);
  }

  // ---------------------------------------------------------------- 分区
  //
  // 多分区时每个纹素归哪个分区由"哈希"决定（规格用 hash52 制造伪随机但确定的图案）。
  //   必须与规格逐位一致，否则同一块的纹素会被分到别的分区，颜色出现噪点。

  function hash52(value) {
    let p = value >>> 0;
    p = (p ^ (p >>> 15)) >>> 0;
    p = (p - (p << 17)) >>> 0;
    p = (p + (p << 7)) >>> 0;
    p = (p + (p << 4)) >>> 0;
    p = (p ^ (p >>> 5)) >>> 0;
    p = (p + (p << 16)) >>> 0;
    p = (p ^ (p >>> 7)) >>> 0;
    p = (p ^ (p >>> 3)) >>> 0;
    p = (p ^ (p << 6)) >>> 0;
    p = (p ^ (p >>> 17)) >>> 0;
    return p;
  }

  /**
   * 预处理某个块的"分区种子状态"。
   *
   * 为什么要拆成两步：种子只跟分区数、partition_id 有关，**与纹素坐标无关**。
   *   原来每个纹素都重算一遍 hash52 + 12 次平方 + 位移，块内重复 16~144 次；
   *   提到块级只算一次之后，同样的输出快了一倍以上（实测 1024² 5x5：1.6s → 0.4s 级）。
   * @param {number} seedIn 块内 partition_id
   * @param {number} numPartitions 分区数
   */
  function buildPartitionSeedState(seedIn, numPartitions) {
    const seed = (seedIn + 1024 * (numPartitions - 1)) >>> 0;
    const rnum = hash52(seed);

    // 12 个 4 bit 种子：规格把它们分别按不同位移拼出来，再做"平方 + 右移"混洗
    const nibbles = [
      rnum & 0xf,          // seed1
      (rnum >>> 4) & 0xf,  // seed2
      (rnum >>> 8) & 0xf,  // seed3
      (rnum >>> 12) & 0xf, // seed4
      (rnum >>> 16) & 0xf, // seed5
      (rnum >>> 20) & 0xf, // seed6
      (rnum >>> 24) & 0xf, // seed7
      (rnum >>> 28) & 0xf, // seed8
      (rnum >>> 18) & 0xf, // seed9
      (rnum >>> 22) & 0xf, // seed10
      (rnum >>> 26) & 0xf, // seed11
      ((rnum >>> 30) | (rnum << 2)) & 0xf, // seed12（高位绕回）
    ];
    // 平方后截到 8 bit（对应规格里"以字节为单位"的溢出行为）
    const seeds = nibbles.map((nibble) => (nibble * nibble) & 0xff);

    const shiftA = (seed & 2) !== 0 ? 4 : 5;
    const shiftB = numPartitions === 3 ? 6 : 5;
    const shift1 = (seed & 1) !== 0 ? shiftA : shiftB;
    const shift2 = (seed & 1) !== 0 ? shiftB : shiftA;
    const shift3 = (seed & 0x10) !== 0 ? shift1 : shift2;

    // 位移各不相同的四组：seed1..8 交替用 shift1/shift2，seed9..12 统一用 shift3
    const shifts = [shift1, shift2, shift1, shift2, shift1, shift2, shift1, shift2,
      shift3, shift3, shift3, shift3];
    for (let i = 0; i < 12; i++) seeds[i] >>>= shifts[i];

    return {
      seed1: seeds[0], seed2: seeds[1], seed3: seeds[2], seed4: seeds[3],
      seed5: seeds[4], seed6: seeds[5], seed7: seeds[6], seed8: seeds[7],
      seed9: seeds[8], seed10: seeds[9], seed11: seeds[10], seed12: seeds[11],
      rnum14: rnum >>> 14,
      rnum10: rnum >>> 10,
      rnum6: rnum >>> 6,
      rnum2: rnum >>> 2,
      numPartitions,
    };
  }

  /** 算某个纹素属于第几个分区（seed 状态由 buildPartitionSeedState 预算好；小块坐标要左移一位） */
  function partitionIndexForTexel(state, xIn, yIn, smallBlock) {
    const x = smallBlock ? xIn << 1 : xIn;
    const y = smallBlock ? yIn << 1 : yIn;
    const a = (state.seed1 * x + state.seed2 * y + state.rnum14) & 0x3f;
    const b = (state.seed3 * x + state.seed4 * y + state.rnum10) & 0x3f;
    const c = state.numPartitions >= 3 ? (state.seed5 * x + state.seed6 * y + state.rnum6) & 0x3f : 0;
    const d = state.numPartitions >= 4 ? (state.seed7 * x + state.seed8 * y + state.rnum2) & 0x3f : 0;
    if (a >= b && a >= c && a >= d) return 0;
    if (b >= c && b >= d) return 1;
    if (c >= d) return 2;
    return 3;
  }

  // ---------------------------------------------------------------- 块解码主流程

  /**
   * 建一份"跨块复用"的临时缓冲。
   *
   * 为什么不在每块里 new：一张 2048² 的 4x4 纹理有 26 万个块，每块新建十来个对象/小数组
   *   会产生明显的 GC 抖动（实测在 1024² 5x5 上占约三分之一总耗时）。这些缓冲的长度都只与
   *   "块内最大纹素数"有关，与具体图片无关，所以整张图解一次只需一份。
   */
  function createDecodeScratch() {
    return {
      // 每块的端点整数序列（原值 / 解量化后），最多 18 个；原值用扁平 3 槽布局
      endpointValues: new Int32Array(MAX_ENDPOINT_VALUES * ISE_STRIDE),
      unquantizedEndpoints: new Int32Array(MAX_ENDPOINT_VALUES),
      // 每块最多 4 个分区，每分区 8 个端点通道（2 个端点 × RGBA）
      endpointPairs: new Int32Array(4 * 8),
      // 每个纹素 2 个权重槽（平面 0 / 平面 1）
      texelWeights: new Int32Array(MAX_BLOCK_SIDE * MAX_BLOCK_SIDE * 2),
      // 权重网格（最多 64 个，扁平 3 槽布局）与其解量化结果
      weightGrid: new Int32Array(MAX_WEIGHTS * ISE_STRIDE),
      unquantizedWeights: new Array(MAX_WEIGHTS),
      // 两个位流：端点从中间往后读、权重从块尾往前读
      endpointStream: new BitStream(null, 0, 0, true),
      weightStream: new BitStream(null, 0, 0, false),
    };
  }

  /**
   * 解一个块到 dst（RGBA，按块内行优先）。
   *
   * 出错一律抛错（不填错误色），理由见文件头：本项目要求"失败可读、不产出半成品"。
   * @param {Uint8Array} destination 输出缓冲（长度 ≥ blockWidth*blockHeight*4）
   * @param {BlockBits} block 块位访问器
   * @param {number} blockWidth 块宽
   * @param {number} blockHeight 块高
   * @param {object} scratch 跨块复用的临时缓冲（见 createDecodeScratch，避免每块新建十几个小数组）
   */
  function decompressBlock(destination, block, blockWidth, blockHeight, scratch) {
    const mode = readBlockMode(block);
    if (mode.isError) {
      throw fail('TEXTURE_DECODE', 'ASTC 块模式非法（保留取值），数据可能不是 ASTC 或用错了块尺寸');
    }

    if (mode.isVoidExtent) {
      decodeVoidExtentBlock(destination, block, blockWidth, blockHeight);
      return;
    }

    const numWeights = computeNumWeights(mode);
    const numWeightDataBits = computeNumRequiredBits(mode.weightMode, mode.weightBits, numWeights);
    const numPartitions = block.bits(11, 12) + 1;

    // 这几条是规格允许的合法性边界；任何一条越界都说明"数据布局与假设不符"
    //   （最常见原因：块尺寸传错，或者这根本不是 ASTC 数据）
    if (numWeights > MAX_WEIGHTS
      || numWeightDataBits > 96
      || numWeightDataBits < 24
      || mode.weightGridWidth > blockWidth
      || mode.weightGridHeight > blockHeight
      || (numPartitions === 4 && mode.isDualPlane)) {
      throw fail('TEXTURE_DECODE',
        `ASTC 块参数越界（权重 ${numWeights} 个 / 权重位 ${numWeightDataBits} / 网格 `
        + `${mode.weightGridWidth}x${mode.weightGridHeight} / 分区 ${numPartitions} / 双平面 ${mode.isDualPlane}）`);
    }

    // 端点模式与端点数据的位置取决于"分区数"与"是否所有分区同模式"，位段是错开的
    const isSingleUniqueCem = numPartitions === 1 || block.bits(23, 24) === 0;
    const numConfigDataBits = (numPartitions === 1 ? 17 : isSingleUniqueCem ? 29 : 25 + 3 * numPartitions)
      + (mode.isDualPlane ? 2 : 0);
    const numBitsForColorEndpoints = 128 - numWeightDataBits - numConfigDataBits;
    const extraCemBitsStart = 127 - numWeightDataBits - (isSingleUniqueCem ? -1
      : numPartitions === 4 ? 7
        : numPartitions === 3 ? 4
          : numPartitions === 2 ? 1
            : 0);

    const endpointModes = decodeColorEndpointModes(block, numPartitions, extraCemBitsStart);
    const numEndpointValues = computeTotalEndpointValues(endpointModes);
    if (numEndpointValues > MAX_ENDPOINT_VALUES
      || numBitsForColorEndpoints < divRoundUp(13 * numEndpointValues, 5)) {
      throw fail('TEXTURE_DECODE',
        `ASTC 端点数据越界（端点值 ${numEndpointValues} 个，可用位 ${numBitsForColorEndpoints}）`);
    }

    const colorEndpointDataStart = numPartitions === 1 ? 17 : 29;
    scratch.endpointStream.reset(block, colorEndpointDataStart, numBitsForColorEndpoints, true);
    const endpointIseParams = computeMaximumRangeISEParams(numBitsForColorEndpoints, numEndpointValues);
    decodeIESequence(scratch.endpointValues, numEndpointValues, scratch.endpointStream,
      endpointIseParams.mode, endpointIseParams.numBits);

    unquantizeColorEndpoints(scratch.unquantizedEndpoints, scratch.endpointValues, numEndpointValues,
      endpointIseParams.mode, endpointIseParams.numBits);

    // 端点 → 每个分区的一对 RGBA 端点（写进扁平缓冲：分区 n 的 8 个通道在 n*8 起）
    let unquantizedIndex = 0;
    for (let partitionIndex = 0; partitionIndex < numPartitions; partitionIndex++) {
      const endpointMode = endpointModes[partitionIndex];
      const valuesPerMode = computeNumEndpointValuesPerMode(endpointMode);
      decodeColorEndpointPair(endpointMode, scratch.unquantizedEndpoints, unquantizedIndex,
        scratch.endpointPairs, partitionIndex * 8);
      unquantizedIndex += valuesPerMode;
    }

    // 权重：网格 → 每个纹素（扁平缓冲，每个纹素 2 槽对应两个平面）
    computeTexelWeights(block, blockWidth, blockHeight, mode, scratch.texelWeights, scratch);

    // 双平面时，第二平面服务哪一个颜色通道由 extraCemBitsStart 前的两位给出
    const channelOfSecondPlane = mode.isDualPlane
      ? block.bits(extraCemBitsStart - 2, extraCemBitsStart - 1)
      : -1;
    const partitionState = numPartitions > 1
      ? buildPartitionSeedState(block.bits(13, 22), numPartitions)
      : null;
    const smallBlock = blockWidth * blockHeight < 31;
    const texelWeights = scratch.texelWeights;
    const endpointPairs = scratch.endpointPairs;

    for (let texelY = 0; texelY < blockHeight; texelY++) {
      for (let texelX = 0; texelX < blockWidth; texelX++) {
        const texelIndex = texelY * blockWidth + texelX;
        const partitionIndex = partitionState === null
          ? 0
          : partitionIndexForTexel(partitionState, texelX, texelY, smallBlock);
        const endpointBase = partitionIndex * 8;
        const weightBase = texelIndex * 2;
        for (let channel = 0; channel < 4; channel++) {
          const weightValue = texelWeights[weightBase + (channelOfSecondPlane === channel ? 1 : 0)];
          // 端点值（0..0xFF）按权重线性混合后降到 8 bit。
          //
          // 这里的换算次序不是随手写的，是"与权威参考逐像素对齐"的结果：
          //   ① 端点先铺成 16 bit（`v<<8 | v`，即 v*257）——满量程 255 正好对应 65535；
          //   ② 用 (64 - w) 与 w 做线性混合，加 32 是四舍五入位，>>6 落到 16 bit 域；
          //   ③ 最后用 ×255/65536 折回 8 bit（+32768 再整除，等价于四舍五入）。
          // 少了第 ③ 步（直接 >>8）会得到"看着对、整体差 1"的结果：实测 440² 有 1566 个像素
          //   各差 1，肉眼看不出来但逐像素对照就红。端点铺法若用 `| 0x80`（量化桶中点）同理。
          const endpoint0 = endpointPairs[endpointBase + channel];
          const endpoint1 = endpointPairs[endpointBase + 4 + channel];
          const blended16 = (((endpoint0 << 8) | endpoint0) * (64 - weightValue)
            + ((endpoint1 << 8) | endpoint1) * weightValue + 32) >> 6;
          destination[texelIndex * 4 + channel] = Math.floor((blended16 * 255 + 32768) / 65536);
        }
      }
    }
  }

  /**
   * 常数色块（void-extent）：整块只有一个颜色，直接展开。
   * 该块形态里也允许"用 extent 坐标定义实心矩形"，坐标是全 1 时表示覆盖整块 —— 两者都支持。
   */
  function decodeVoidExtentBlock(destination, block, blockWidth, blockHeight) {
    const minS = block.bits(12, 24);
    const maxS = block.bits(25, 37);
    const minT = block.bits(38, 50);
    const maxT = block.bits(51, 63);
    const hasHdrFlag = block.bitAt(9) !== 0;
    if (hasHdrFlag) {
      throw fail('TEXTURE_FORMAT_UNSUPPORTED', 'ASTC 常数色块标记为 HDR（FP16），本解码器只实现 LDR');
    }
    const allExtentsAllOnes = minS === 0x1fff && maxS === 0x1fff && minT === 0x1fff && maxT === 0x1fff;
    if (!allExtentsAllOnes && (minS >= maxS || minT >= maxT)) {
      throw fail('TEXTURE_DECODE', 'ASTC 常数色块的 extent 坐标非法（最小 >= 最大）');
    }
    const red = block.bits(64, 79);
    const green = block.bits(80, 95);
    const blue = block.bits(96, 111);
    const alpha = block.bits(112, 127);
    const rgba = [red, green, blue, alpha].map((value) => (value & 0xff00) >> 8);
    for (let i = 0; i < blockWidth * blockHeight; i++) {
      destination[i * 4 + 0] = rgba[0];
      destination[i * 4 + 1] = rgba[1];
      destination[i * 4 + 2] = rgba[2];
      destination[i * 4 + 3] = rgba[3];
    }
  }

  // ---------------------------------------------------------------- 对外入口

  /**
   * 解码一张 ASTC 纹理。
   *
   * @param {Uint8Array} data 压缩数据（宽高按块向上取整后的块数 × 16 字节）
   * @param {number} width 像素宽
   * @param {number} height 像素高
   * @param {number} blockWidth 块宽（ASTC 规格定义的 14 种之一）
   * @param {number} blockHeight 块高（与 blockWidth 成对取自同一张表）
   * @returns {Uint8Array} RGBA，长度 = width*height*4，**存储方向**（未做 flipY）
   */
  function decodeAstc(data, width, height, blockWidth, blockHeight) {
    if (!data || typeof data.length !== 'number') {
      throw fail('BAD_ARGS', 'ASTC 解码：缺少压缩数据');
    }
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw fail('BAD_ARGS', `ASTC 解码：宽高非法（${width}x${height}）`);
    }
    // 块尺寸必须是规格表里的一对：ASTC 只有这 14 种组合（高度不超过宽度）。
    //   为什么严格校验而不是"≤12 就放行"：3x3、7x7 这类尺寸不存在，放过去只会把
    //   "格式号/块尺寸判断错"混淆成"数据长度不对"或解出一堆噪点，排查成本高得多。
    const blockKey = `${blockWidth}x${blockHeight}`;
    if (!Number.isInteger(blockWidth) || !Number.isInteger(blockHeight)
      || !ASTC_BLOCK_DIMENSIONS.has(blockKey)) {
      throw fail('TEXTURE_FORMAT_UNSUPPORTED',
        `ASTC 解码：块尺寸 ${blockKey} 不是合法组合（规格只定义 ${[...ASTC_BLOCK_DIMENSIONS].join('、')}）`);
    }

    const blocksX = divRoundUp(width, blockWidth);
    const blocksY = divRoundUp(height, blockHeight);
    const requiredBytes = blocksX * blocksY * BLOCK_BYTES;
    if (data.length < requiredBytes) {
      throw fail('TEXTURE_DATA_SHORT',
        `ASTC 数据不足：${width}x${height} 按 ${blockWidth}x${blockHeight} 分块需要 ${requiredBytes} 字节，`
        + `实际 ${data.length} 字节`);
    }

    const output = new Uint8Array(width * height * 4);
    // 单块临时缓冲：块可能超出图像边界（宽高不是块边长的整数倍），逐块裁切拷贝
    const blockPixels = new Uint8Array(blockWidth * blockHeight * 4);
    // 跨块复用的临时缓冲与位访问器：每块新建十几个对象在 4 万块规模下会明显拖慢（实测占 1/3 时间）
    const scratch = createDecodeScratch();
    const block = new BlockBits(data, 0);

    for (let blockY = 0; blockY < blocksY; blockY++) {
      for (let blockX = 0; blockX < blocksX; blockX++) {
        block.setOffset((blockY * blocksX + blockX) * BLOCK_BYTES);
        try {
          decompressBlock(blockPixels, block, blockWidth, blockHeight, scratch);
        } catch (error) {
          // 补上块坐标再抛：一张 1024² 的 5x5 纹理有 4 万多个块，没有坐标等于没线索
          error.message += `（块坐标 ${blockX},${blockY}，块尺寸 ${blockWidth}x${blockHeight}）`;
          throw error;
        }
        const copyWidth = Math.min(blockWidth, width - blockX * blockWidth);
        const copyHeight = Math.min(blockHeight, height - blockY * blockHeight);
        for (let row = 0; row < copyHeight; row++) {
          const sourceStart = row * blockWidth * 4;
          const targetY = blockY * blockHeight + row;
          const targetStart = (targetY * width + blockX * blockWidth) * 4;
          output.set(blockPixels.subarray(sourceStart, sourceStart + copyWidth * 4), targetStart);
        }
      }
    }
    return output;
  }

  NS.astc = { decodeAstc };
}
