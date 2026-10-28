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

  // 关于 BlocksAndDirectoryInfoCombined（0x40）：**不参与解析判断**。
  //
  // 它名义上表示「blocks 与 directoryInfo 合并为一段」，但权威实现（AssetStudio 的
  //   BundleFile.cs → ReadBlocksInfoAndDirectory）的判断链里**从不读这一位**，
  //   实际只按 0x80（BlocksInfoAtTheEnd）区分两种布局。详见 doc/参考/README.md 结论一。
  //
  // 不能拿「0x40 置位」当拒绝/不支持的依据：实测正常包 dataflags = 0x240 本身就含 0x40
  //   （0x240 & 0x40 = 0x40），按它拒绝会把**全部正常包一起拒掉**。
  //   名义语义与实现语义不一致时，以实现的判断链为准。

  const COMPRESSION = { NONE: 0, LZMA: 1, LZ4: 2, LZ4HC: 3, LZHAM: 4 };

  /**
   * LZ4 块解压（LZ4 block format，不含帧头）。
   *
   * 为什么自己实现：容器允许 LZ4 压缩的数据块，浏览器端没有内置 LZ4。
   * 与 UnityPy 的 lz4.block.decompress 对齐：入参是裸块，输出固定为 expectedSize。
   */
  function lz4Decompress(src, expectedSize, target, targetOffset = 0) {
    // target：若调用方已预分配好整段缓冲（多块拼接场景），直接写到它的对应区间，
    //   省掉"每块各分配一份 + 最后 concat 再复制一份"的第二份内存。
    //   安全性：LZ4 block 的匹配段只引用**同一块内**已解出的字节，不跨块 ⇒ 写到大缓冲的任意 offset 都成立。
    const dst = target ? target.subarray(targetOffset, targetOffset + expectedSize) : new Uint8Array(expectedSize);
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

  /**
   * LZMA 块解压。
   *
   * **格式取证（从真实包读出，不是按文档推测）**：UnityFS 的 LZMA 块是
   *   `[5 字节 props][raw LZMA1 流]` —— **没有** .lzma(alone) 那 8 字节未压缩长度。
   *   props 5 字节 = 1 字节 lc/lp/pb + 4 字节 dictSize(LE)，实测全部样本恒为 `5d 00 00 08 00`
   *   （lc=3 / lp=0 / pb=2 / dictSize=512KB，即 LZMA 标准默认值）。
   *
   * 做法：补上那 8 字节长度（用容器给的 uncompressedSize，小端）拼成标准 .lzma(alone)，
   *   再交给 vendored 的 `LZMA.decompress`。这样不必用 raw API —— 任何支持 alone 的解码器都能接。
   *
   * **为什么必须自己校验长度**：实测把 uncompressedSize 传错（误用 blocksInfo 的 91 而非本块的
   *   8677760）时，解码器**不报错**，静默解出 91 字节就返回。不校验会让半截数据流到下游，
   *   表现成"模型损坏"，极难定位。
   *
   * 调用方注意：blocksInfo 传**头的 usz**，block 数据传**该块自己的 uncompressedSize**（两者不同）。
   * @param {Uint8Array} src 原始压缩字节（含开头 5 字节 props）
   * @param {number} uncompressedSize 本段声明解压后大小
   * @param {Uint8Array} [target] 预分配目标缓冲（多块拼接场景）
   * @param {number} [targetOffset]
   * @returns {Uint8Array} 解压后的字节
   */
  function lzmaDecompress(src, uncompressedSize, target, targetOffset = 0) {
    // 解码器由 lib/lzma-d-min.js 挂到全局（classic script，靠 plugin.json 的 files[] 顺序加载）
    const LZMA = root.LZMA;
    if (!LZMA || typeof LZMA.decompress !== 'function') {
      throw NS.errors.fail('ULB_ERR_LZMA_UNAVAILABLE',
        'LZMA 解码器未就绪：lib/lzma-d-min.js 需在 plugin.json 的 files[] 中排在 lib/unityfs.js 之前');
    }
    if (!src || src.length < 6) {
      throw NS.errors.fail('ULB_ERR_LZMA_FAIL',
        `LZMA 块数据过短：${src ? src.length : 0} 字节（至少需 5 字节 props + 压缩数据）`);
    }
    // 拼 13 字节 alone 头：5 props + 8 字节未压缩长度（小端）
    const alone = new Uint8Array(13 + src.length - 5);
    alone.set(src.subarray(0, 5), 0);
    new DataView(alone.buffer, alone.byteOffset).setBigUint64(5, BigInt(uncompressedSize), true);
    alone.set(src.subarray(5), 13);

    let out;
    try {
      out = LZMA.decompress(alone);
    } catch (e) {
      throw NS.errors.fail('ULB_ERR_LZMA_FAIL', `LZMA 解压失败：${(e && e.message) || e}`);
    }
    // 上游返回普通 Array（且跨 realm）⇒ 统一归一成 Uint8Array，调用方只处理一种类型
    const bytes = out instanceof Uint8Array ? out : Uint8Array.from(out || []);
    if (bytes.length !== uncompressedSize) {
      throw NS.errors.fail('ULB_ERR_LZMA_FAIL',
        `LZMA 解压长度不符：声明 ${uncompressedSize}，实际 ${bytes.length}（解码器不校验长度，必须由本层兜住）`);
    }
    if (target) {
      target.set(bytes, targetOffset);
      return target.subarray(targetOffset, targetOffset + bytes.length);
    }
    return bytes;
  }

  /** 按压缩类型解压一段数据（flags 低 6 位） */
  function decompress(bytes, uncompressedSize, flags, where, target, targetOffset = 0) {
    const type = flags & ARCHIVE.CompressionTypeMask;
    if (type === COMPRESSION.NONE) {
      if (bytes.length !== uncompressedSize) {
        throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `${where || '数据块'} 声明未压缩但长度不符：实际 ${bytes.length}，声明 ${uncompressedSize}`);
      }
      // 未压缩块没有"解压"这步，只能拷进目标区间（语义与拼接一致，不再多留一份视图）
      if (target) { target.set(bytes, targetOffset); return target.subarray(targetOffset, targetOffset + bytes.length); }
      return bytes;
    }
    if (type === COMPRESSION.LZ4 || type === COMPRESSION.LZ4HC) {
      return lz4Decompress(bytes, uncompressedSize, target, targetOffset);
    }
    // LZMA 按**每块自己的 flags** 判（Unity 允许 blocksInfo 与 block 用不同压缩：
    //   实测 57 个包 blocksInfo 是 LZ4HC/LZ4/none 而 block 是 LZMA）⇒ 不能按整包类型一刀切
    if (type === COMPRESSION.LZMA) {
      return lzmaDecompress(bytes, uncompressedSize, target, targetOffset);
    }
    const label = type === COMPRESSION.LZHAM ? 'LZHAM' : `未知(${type})`;
    throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `${where || '数据块'} 使用 ${label} 压缩，本插件尚未支持该分支（已支持 none / LZ4 / LZMA）`);
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
  /**
   * 只读容器头 + blocksInfo 表（**不解压任何数据块**）。
   *
   * 为什么单拎出来：准入判断只需要"解压后总共多大"，而解压数据块是全流程最贵的一步
   *   （LZ4 包 19MB→42MB 实测 150ms+）。有了它就能在一份块表上求和，P90 < 5ms。
   * @param {Uint8Array} u8
   * @returns {object} parse 返回里的"头部字段"（不含 data / blockSpans / totalSize）
   */
  function readHeader(u8) {
    // UnityFS 的容器头与 blocksInfo 表都是**大端**（与内嵌 SerializedFile 的小端不同）
    const r = new B.Reader(u8, { endian: '>' });
    const signature = r.cstring('signature');
    if (signature !== 'UnityFS') throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `不是 UnityFS 容器（signature="${signature}"）`);
    const version = r.u32();
    const playerVersion = r.cstring('playerVersion');
    const engineVersion = r.cstring('engineVersion');

    // 逻辑长度：**标准包 == 文件长度**；带尾随数据的包（实测 NIKKE 在 UnityFS 内容后追加 16 字节 trailer）
    //   则小于文件长度。定位 blocksInfo 必须用它，不能用文件长度（见下方 blocksInfoAtEnd 分支）。
    const bundleSize = r.i64('bundleSize');
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
      // 从「逻辑末尾」往前取 blocksInfo，用 bundleSize 而不是文件长度 r.length：
      //   标准包两者相等（行为不变）；但实测 NIKKE 包在 UnityFS 内容之后又追加了 16 字节 trailer
      //   （三样本一致），此时 r.length 会把 trailer 算进来 ⇒ 起点后移 16 字节 ⇒ LZ4 解出垃圾，
      //   报「LZ4 数据损坏：匹配偏移为 0」，与真实原因相距极远。
      // 边界：bundleSize 不合理（非正数 / 超出文件长度）时回退 r.length，
      //   避免坏包让 seek 落到非法位置（那种情况的报错会更难读）。
      const logicalEnd = (bundleSize > 0 && bundleSize <= r.length) ? bundleSize : r.length;
      r.seek(logicalEnd - blocksInfoCompressedSize);
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

    return {
      signature, version, playerVersion, engineVersion, dataflags, blocksInfoAtEnd,
      usesEncryption: false, blocks, nodes, blocksInfoContentEnd,
      blocksInfoBytes: blocksInfoContentEnd - start, dataStart, blocksInfoHash: B.toHex(hash),
      reader: r,   // 游标停在 dataStart，parse 解压数据块时要用；对外返回前剔除
    };
  }

  /**
   * 解析 UnityFS 容器（**含数据块解压**）。头部与块表复用 readHeader。
   * @param {Uint8Array} u8 整个文件字节
   */
  function parse(u8) {
    const h = readHeader(u8);
    const { blocks, dataStart, reader: r } = h;

    // 数据块：**预分配整段**，逐块直接解压到对应 offset。
    //   为什么不再用「每块各解一份 + concat」：那会让峰值 = 解压总量 ×2
    //   （实测 19MB 包：解压 42.1MB + concat 复制 42.1MB = 84.2MB），而块只有一个时又白留一份。
    //   节点的 offset/size 相对这份整段缓冲，语义与拼接完全相同。
    const totalUncompressed = blocks.reduce((a, b) => a + b.uncompressedSize, 0);
    const data = new Uint8Array(totalUncompressed);
    const blockSpans = [];
    let cursor = 0;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const raw = r.bytes(b.compressedSize, `block[${i}]`);
      decompress(raw, b.uncompressedSize, b.flags, `block[${i}]`, data, cursor);
      blockSpans.push({ start: cursor, end: cursor + b.uncompressedSize });
      cursor += b.uncompressedSize;
    }

    const { reader, ...head } = h;   // reader 是内部游标，不对外暴露
    return { ...head, blockSpans, data, totalSize: u8.length };
  }

  /**
   * 轻量摘要：只读头 + blocksInfo，**不解压数据块**。
   * 供准入判断与插件声明内存用（见 docs/设计/解包内存预估.md）。
   * @param {Uint8Array} u8
   * @returns {{decompressedBytes:number, compressedBytes:number, blockCount:number, cabBytes:number, resSBytes:number}}
   */
  function blocksSummary(u8) {
    const h = readHeader(u8);
    let decompressedBytes = 0;
    let compressedBytes = 0;
    for (const b of h.blocks) { decompressedBytes += b.uncompressedSize; compressedBytes += b.compressedSize; }
    const cab = h.nodes.find((n) => /CAB-/.test(n.path) && !/\.resS$/i.test(n.path));
    const resS = h.nodes.find((n) => /\.resS$/i.test(n.path));
    return {
      decompressedBytes, compressedBytes, blockCount: h.blocks.length,
      cabBytes: cab ? cab.size : 0, resSBytes: resS ? resS.size : 0,
    };
  }

  function nodeBytes(parsed, path) {
    const node = parsed.nodes.find((n) => n.path === path);
    if (!node) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `容器内没有节点: ${path}`);
    if (node.offset + node.size > parsed.data.length) {
      throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `节点 ${path} 越界：offset=${node.offset} size=${node.size} 数据区=${parsed.data.length}`);
    }
    return parsed.data.subarray(node.offset, node.offset + node.size);
  }

  NS.unityfs = { parse, readHeader, blocksSummary, nodeBytes, lz4Decompress, ARCHIVE, COMPRESSION };
}
