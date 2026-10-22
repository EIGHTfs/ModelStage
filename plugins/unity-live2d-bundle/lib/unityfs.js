// ============================================================================
// plugins/unity-live2d-bundle/lib/unityfs.js —— UnityFS 容器解析
//
// 职责：把 UnityFS（Unity 5+ AssetBundle）容器解开，得到
//   ① 头信息（版本/引擎版本/归档标志）
//   ② blocksInfo：数据块表 + **节点表**（每个节点 = 一个内嵌文件，如 CAB-xxx 与 .resS）
//   ③ 数据区起点（节点数据在整份文件里的绝对偏移）与拼接后的数据字节
//
// 结构（UnityFS，v6+ 的 read_fs 路径）：
//   signature "UnityFS\0" | version u32 | playerVer cstring | engineVer cstring
//   size i64 | blocksInfoCompressedSize u32 | blocksInfoUncompressedSize u32 | dataflags u32
//   [2019.4.15+ 或 version>=7：对齐到 16 字节]      ← 未压缩包里会看到一段填充
//   blocksInfo（长度 = blocksInfoCompressedSize，可能被压缩）：
//       16B hash | i32 blockCount | blockCount×{ u32 uncompressedSize, u32 compressedSize, u16 flags }
//       i32 nodeCount | nodeCount×{ i64 offset, i64 size, u32 flags, cstring path }
//   若 dataflags 带 BlockInfoNeedPaddingAtStart：再对齐到 16 字节
//   blocks：blockCount 段数据（各自按 flags 压缩），拼接后即所有节点的数据源
//
// 压缩分支：flags 低 6 位是压缩类型（0=none，1=LZMA，2=LZ4，3=LZ4HC，4=LZHAM）。
//   本插件实现 none 与 LZ4；其余（LZMA/LZHAM）**抛可读错误**而不是猜，
//   避免解出错数据后被后面几层误当成"模型损坏"。
//
// 挂载：globalThis.__ULB__.unityfs
// ============================================================================

'use strict';

{
  const root = globalThis;   // 原 IIFE 的 root 引用（脚本级裸块内保持同名）
  const NS = (root.__ULB__ = root.__ULB__ || {});
  const B = NS.bytes;

  // 归档标志位（ArchiveFlags，Unity 2020.3 及以后；名字沿用 Unity 源码里的 kArchive*）
  const ARCHIVE = {
    CompressionTypeMask: 0x3f,
    BlocksAndDirectoryInfoCombined: 0x40,
    BlocksInfoAtTheEnd: 0x80,
    OldWebPluginCompatibility: 0x100,
    BlockInfoNeedPaddingAtStart: 0x200,
    UsesAssetBundleEncryption: 0x1400,
  };

  // ⚠️ 已知不支持：BlocksAndDirectoryInfoCombined（0x40）
  //
  // 根因（2026-10-22 实测定位，样本 live2d/aijier_3，19.27MB）：
  //   该样本 dataflags = 0xC2，同时置了 0x40（blocks 与 directoryInfo 合并为一段）
  //   与 0x80（blocksInfo 在文件尾），压缩类型 2（LZ4），Unity 2018.4.34f1 / version 6。
  //   其余 18 个样本（live2d/*）均为 Unity 2020.3.48f1 / version 8 / dataflags 0x240
  //   （comp=0 未压缩、无 0x40、无 0x80），走的是 parse() 已实现的「头部 blocksInfo」路径。
  //
  // 为什么显式拒绝而不是"试着解"：
  //   ARCHIVE 表里 0x40 这一位早已定义，但 parse() 从未实现该布局——它只判 0x80，
  //   于是按「length - csz」从文件尾取固定长度。combined 布局下该位置取到的是错位数据；
  //   而 LZ4 块解压只有"输出长度必须等于 expectedSize"这一道弱自洽检查，
  //   错位数据偶尔能自洽解出（实测解出了 163 字节但 blockCount/nodeCount 是垃圾值），
  //   于是错误一路带到 block 表读取才炸，报 CONTAINER_PARSE，现场看不出真实原因。
  //
  // 正确实现需要权威格式依据（Unity ArchiveStorageData/AssetBundle 的 combined 段布局，
  //   或 UnityPy 对应解析作对照）。在没有权威参考前不猜实现——猜错的解析比明确报错危险得多：
  //   它可能解出"看着能跑"的错数据，把 bug 推到渲染层才暴露。
  //   需要支持时：补 combined 解析 + 用 aijier_3 与正常样本做双向对照自证。

  const COMPRESSION = { NONE: 0, LZMA: 1, LZ4: 2, LZ4HC: 3, LZHAM: 4 };

  /**
   * LZ4 块解压（LZ4 block format，不含帧头）。
   *
   * 为什么自己实现：容器允许 LZ4 压缩的数据块，浏览器端没有内置 LZ4。
   * 与 UnityPy 的 lz4.block.decompress 对齐：入参是裸块，输出固定为 expectedSize。
   */
  function lz4Decompress(src, expectedSize) {
    const dst = new Uint8Array(expectedSize);
    let si = 0;
    let di = 0;
    while (si < src.length) {
      const token = src[si++];
      // ① 字面量段
      let litLen = token >>> 4;
      if (litLen === 15) {
        let b;
        do { b = src[si++]; litLen += b; } while (b === 255);
      }
      for (let i = 0; i < litLen; i++) dst[di++] = src[si++];
      if (si >= src.length) break;   // 末段只有字面量
      // ② 匹配段：2 字节小端偏移，长度 4 + 扩展
      const offset = src[si] | (src[si + 1] << 8);
      si += 2;
      if (offset === 0) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', 'LZ4 数据损坏：匹配偏移为 0');
      let matchLen = token & 15;
      if (matchLen === 15) {
        let b;
        do { b = src[si++]; matchLen += b; } while (b === 255);
      }
      matchLen += 4;
      const start = di - offset;
      if (start < 0) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', 'LZ4 数据损坏：匹配位置越界');
      for (let i = 0; i < matchLen; i++) dst[di++] = dst[start + i];
    }
    if (di !== expectedSize) {
      throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `LZ4 解压长度不符：得到 ${di}，期望 ${expectedSize}`);
    }
    return dst;
  }

  /** 按压缩类型解压一段数据（flags 低 6 位） */
  function decompress(bytes, uncompressedSize, flags, where) {
    const type = flags & ARCHIVE.CompressionTypeMask;
    if (type === COMPRESSION.NONE) {
      if (bytes.length !== uncompressedSize) {
        throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `${where || '数据块'} 声明未压缩但长度不符：实际 ${bytes.length}，声明 ${uncompressedSize}`);
      }
      return bytes;
    }
    if (type === COMPRESSION.LZ4 || type === COMPRESSION.LZ4HC) {
      return lz4Decompress(bytes, uncompressedSize);
    }
    const label = type === COMPRESSION.LZMA ? 'LZMA' : type === COMPRESSION.LZHAM ? 'LZHAM' : `未知(${type})`;
    throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `${where || '数据块'} 使用 ${label} 压缩，本插件尚未支持该分支（已支持 none / LZ4）`);
  }

  /**
   * 解析 UnityFS 容器。
   * @param {Uint8Array} u8 整个文件字节
   * @returns {{
   *   signature:string, version:number, playerVersion:string, engineVersion:string,
   *   dataflags:number, blocksInfoAtEnd:boolean, usesEncryption:boolean,
   *   blocks:{uncompressedSize:number,compressedSize:number,flags:number}[],
   *   nodes:{path:string,offset:number,size:number,flags:number}[],
   *   blocksInfoBytes:number, dataStart:number, data:Uint8Array
   * }}
   */
  function parse(u8) {
    // UnityFS 的容器头与 blocksInfo 表都是**大端**（与内嵌 SerializedFile 的小端不同）
    const r = new B.Reader(u8, { endian: '>' });
    const signature = r.cstring('signature');
    if (signature !== 'UnityFS') throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `不是 UnityFS 容器（signature="${signature}"）`);
    const version = r.u32();
    const playerVersion = r.cstring('playerVersion');
    const engineVersion = r.cstring('engineVersion');

    r.i64('bundleSize');                     // 与文件长度一致，仅作完整性参考
    const blocksInfoCompressedSize = r.u32();
    const blocksInfoUncompressedSize = r.u32();
    const dataflags = r.u32();

    if (dataflags & ARCHIVE.UsesAssetBundleEncryption) {
      throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', '该资源包使用了 AssetBundle 加密（UsesAssetBundleEncryption），本插件无法读取');
    }

    // version>=7（或 2019.4.15+）时，blocksInfo 之前要对齐到 16 字节
    if (version >= 7) r.align(16);

    const blocksInfoAtEnd = (dataflags & ARCHIVE.BlocksInfoAtTheEnd) !== 0;
    const start = r.pos;
    let blocksInfoRaw;
    if (blocksInfoAtEnd) {
      r.seek(r.length - blocksInfoCompressedSize);
      blocksInfoRaw = r.bytes(blocksInfoCompressedSize, 'blocksInfo');
      r.seek(start);
    } else {
      blocksInfoRaw = r.bytes(blocksInfoCompressedSize, 'blocksInfo');
    }
    const blocksInfoBytes = decompress(blocksInfoRaw, blocksInfoUncompressedSize, dataflags & ARCHIVE.CompressionTypeMask, 'blocksInfo');

    const bi = new B.Reader(blocksInfoBytes, { baseOffset: start, endian: '>' });
    const hash = bi.bytes(16, 'blocksInfo.hash');
    const blockCount = bi.i32();
    const blocks = [];
    for (let i = 0; i < blockCount; i++) {
      blocks.push({
        uncompressedSize: bi.u32(),
        compressedSize: bi.u32(),
        flags: bi.u16(),
      });
    }
    const nodeCount = bi.i32();
    const nodes = [];
    for (let i = 0; i < nodeCount; i++) {
      nodes.push({
        offset: bi.i64('node.offset'),
        size: bi.i64('node.size'),
        flags: bi.u32(),
        path: bi.cstring('node.path'),
      });
    }
    const blocksInfoContentEnd = bi.absOffset;   // 表**内容**结束位置（不含表尾填充）
    // 数据区起点（依据 AssetStudio BundleFile.cs ReadBlocksInfoAndDirectory，d158e86）：
    //   · blocksInfo **内联在头部**（未置 0x80）时，该段按**声明长度** blocksInfoCompressedSize
    //     占位——未压缩包的声明长度可能比表内容大，差值即表尾对齐填充
    //     （实测样本 160 - 153 = 7 字节），故需把游标推到 start + compressedSize 才是数据起点。
    //     别把「表内容结束」当成「数据开始」：那会整体错位 7 字节，moc3 的 sha256 立刻不对。
    //   · blocksInfo **在文件尾**（置 0x80）时，数据块紧接 header 之后开始；
    //     上面读 blocksInfo 前已保存 position、读后已 seek 回来，此处**不能再加 declaredEnd**，
    //     否则会把数据起点整体推后 compressedSize 字节 → 数据块错位 → LZ4 解出垃圾
    //     （报"LZ4 数据损坏：匹配位置越界"，与真实原因相距极远，极难排查）。
    //     实测踩坑：live2d/aijier_3（Unity 2018.4 / version 6 / LZ4 / flags 0xC2）正是此情形，
    //     19 个样本里唯一一个 blocksInfo 在尾的包，旧代码一直没覆盖到。
    if (!blocksInfoAtEnd) {
      const declaredEnd = start + blocksInfoCompressedSize;
      if (declaredEnd > r.pos) r.seek(declaredEnd);
    }
    if (dataflags & ARCHIVE.BlockInfoNeedPaddingAtStart) r.align(16);
    const dataStart = r.pos;

    // 数据块：按顺序解压后拼接；节点的 offset/size 都相对这份拼接结果
    const dataParts = [];
    const blockSpans = [];
    let cursor = 0;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const raw = r.bytes(b.compressedSize, `block[${i}]`);
      const out = decompress(raw, b.uncompressedSize, b.flags, `block[${i}]`);
      blockSpans.push({ start: cursor, end: cursor + out.length });
      dataParts.push(out);
      cursor += out.length;
    }
    const data = blockCount === 1 ? dataParts[0] : B.concatBytes(dataParts);

    return {
      signature,
      version,
      playerVersion,
      engineVersion,
      dataflags,
      blocksInfoAtEnd,
      usesEncryption: false,
      blocks,
      nodes,
      blocksInfoContentEnd,
      blocksInfoBytes: blocksInfoContentEnd - start,
      dataStart,
      blockSpans,
      data,
      totalSize: u8.length,
      blocksInfoHash: B.toHex(hash),
    };
  }

  /** 从解析结果里按节点 path 取该节点的数据切片 */
  function nodeBytes(parsed, path) {
    const node = parsed.nodes.find((n) => n.path === path);
    if (!node) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `容器内没有节点: ${path}`);
    if (node.offset + node.size > parsed.data.length) {
      throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `节点 ${path} 越界：offset=${node.offset} size=${node.size} 数据区=${parsed.data.length}`);
    }
    return parsed.data.subarray(node.offset, node.offset + node.size);
  }

  NS.unityfs = { parse, nodeBytes, lz4Decompress, ARCHIVE, COMPRESSION };
}
