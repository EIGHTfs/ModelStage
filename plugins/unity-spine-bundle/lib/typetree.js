// ============================================================================
// plugins/unity-live2d-bundle/lib/typetree.js —— 类型树解析 + 按字段名取值
//
// 为什么需要它：SerializedFile 里的对象是"裸字节"，字段边界只存在于**类型树**里。
//   有了类型树，才能按字段名取到 m_Width / m_TextureFormat / m_StreamData / m_Script / 曲线数组……
//   没有它就只能靠魔数/长度前缀猜（本插件把它作为兜底，而不是主路径）。
//
// 类型树 blob（v12+/v10，内联在 SerializedType 里）：
//   i32 节点数 | i32 字符串池长度 | 节点记录×N | 字符串池
//   节点记录（v19+，32 字节）：
//     u16 m_Version | u8 m_Level | u8 m_TypeFlags | u32 m_TypeStrOffset | u32 m_NameStrOffset
//     i32 m_ByteSize | i32 m_Index | i32 m_MetaFlag | u64 m_RefTypeHash
//   字符串引用：最高位为 0 → 指向字符串池的偏移（读到 NUL 结束）；
//               最高位为 1 → Unity 内置公共字符串表的下标（本插件遇到时抛可读错误，
//               不猜名字，避免把字段名张冠李戴）。
//
// 取值规则（与 Unity 的序列化规则一致，两处最容易错）：
//   · 每个节点自己的 m_MetaFlag 带 0x4000（kAlignBytes）时，读完该节点要 4 字节对齐；
//   · 变长数组是「i32 长度 + 元素」，且当**容器节点**或 Array 子节点带对齐标志时，读完数组也要对齐。
//
// 挂载：globalThis.__ULB__.typetree
// ============================================================================

'use strict';

{
  const root = globalThis;   // 原 IIFE 的 root 引用（脚本级裸块内保持同名）
  const NS = (root.__ULB__ = root.__ULB__ || {});
  const B = NS.bytes;

  const ALIGN_BYTES = 0x4000;

  const isAligned = (metaFlag) => ((metaFlag || 0) & ALIGN_BYTES) !== 0;

  /** 解析类型树 blob → 根节点（含 children 树） */
  function parseBlob(blob, version) {
    const r = new B.Reader(blob);
    if (version >= 23) {
      const magic = B.latin1(r.bytes(4), 0, 4);
      if (magic !== 'mhtt') throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `类型树 blob 魔数不是 mhtt：${magic}`);
      const fmt = r.i32();
      if (fmt !== version) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `类型树格式版本不一致：${fmt} vs ${version}`);
    }
    const nodeCount = r.i32();
    const stringBufferSize = r.i32();
    if (nodeCount <= 0 || stringBufferSize < 0) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `类型树长度非法：节点数=${nodeCount} 字符串池=${stringBufferSize}`);
    const recordSize = version >= 19 ? 32 : 24;

    const raw = [];
    for (let i = 0; i < nodeCount; i++) {
      const start = r.pos;
      const rec = {
        m_Version: r.u16(),
        m_Level: r.u8(),
        m_TypeFlags: r.u8(),
        m_TypeStrOffset: r.u32(),
        m_NameStrOffset: r.u32(),
        m_ByteSize: r.i32(),
        m_Index: r.i32(),
        m_MetaFlag: r.i32(),
      };
      if (version >= 19) rec.m_RefTypeHash = r.i64('m_RefTypeHash');
      if (r.pos - start !== recordSize) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', '类型树节点记录长度与预期不符');
      raw.push(rec);
    }
    const stringBuffer = r.bytes(stringBufferSize, '类型树字符串池');

    // 字符串池就是一个连续字节区，用 NUL 分隔；按偏移直接解出
    const readPoolString = (offset) => {
      let end = offset;
      while (end < stringBuffer.length && stringBuffer[end] !== 0) end++;
      return new TextDecoder('utf-8').decode(stringBuffer.subarray(offset, end));
    };
    const resolveString = (value, kind) => {
      const isOffset = (value & 0x80000000) === 0;
      if (isOffset) return readPoolString(value);
      const idx = value & 0x7fffffff;
      const hit = NS.commonStrings && NS.commonStrings[idx];
      if (hit === undefined) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `公共字符串表里没有下标 ${idx}（${kind}），无法确定字段名`);
      return hit;
    };

    // 用层级栈把平铺的节点还原成树（与 Unity 的类型树遍历顺序一致）
    const fakeRoot = { name: '', type: '', level: -1, metaFlag: 0, byteSize: 0, children: [] };
    const stack = [fakeRoot];
    let parent = fakeRoot;
    let prev = fakeRoot;
    for (const rec of raw) {
      const node = {
        version: rec.m_Version,
        level: rec.m_Level,
        flags: rec.m_TypeFlags,
        byteSize: rec.m_ByteSize,
        index: rec.m_Index,
        metaFlag: rec.m_MetaFlag,
        type: resolveString(rec.m_TypeStrOffset, 'type'),
        name: resolveString(rec.m_NameStrOffset, 'name'),
        children: [],
      };
      if (node.level > prev.level) { stack.push(parent); parent = prev; }
      else if (node.level < prev.level) { while (node.level <= parent.level) parent = stack.pop(); }
      parent.children.push(node);
      prev = node;
    }
    if (!fakeRoot.children.length) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', '类型树为空');
    return fakeRoot.children[0];
  }

  // 64 位字段：能精确表示就返回 Number（好用好 JSON 化），超出安全范围才保留 BigInt。
  // 为什么不直接抛错：对象里本来就有大整数（如 PPtr 的 pathID、哈希），抛错会让整棵树读不出来。
  const readLong = (r) => {
    const v = r.i64b('SInt64');
    const n = Number(v);
    return Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : v;
  };

  // 基本类型的读取函数（与 Unity 的类型名一一对应）
  const PRIMITIVE = {
    SInt8: (r) => r.i8(), UInt8: (r) => r.u8(), char: (r) => r.u8(),
    short: (r) => r.i16(), SInt16: (r) => r.i16(), 'unsigned short': (r) => r.u16(), UInt16: (r) => r.u16(),
    int: (r) => r.i32(), SInt32: (r) => r.i32(), 'unsigned int': (r) => r.u32(), UInt32: (r) => r.u32(),
    'Type*': (r) => r.u32(),
    'long long': readLong, SInt64: readLong,
    'unsigned long long': readLong, UInt64: readLong, FileSize: readLong,
    float: (r) => r.f32(), double: (r) => r.f64(), bool: (r) => r.bool(),
    string: (r) => r.string('string'),
    // TypelessData：i32 长度 + 原始字节（moc3 这类"字节数组"字段就是它）
    TypelessData: (r) => { const n = r.i32(); return r.bytes(n, 'TypelessData'); },
  };

  /**
   * string 的「原始字节」读取：返回 { text, bytes }，而不是只给 text。
   *
   * 为什么需要：Unity 的 `string` 在序列化层是「i32 长度 + 原始字节」，**Unity 自己不校验 UTF-8** ——
   *   TextAsset 允许承载二进制（spine 的 `.skel` 就是二进制，实测 651994 字节）。
   *   而 `bytes.string()` 一律 UTF-8 解码 ⇒ 非法序列被替换成 U+FFFD，**信息永久丢失且不可逆**
   *   （实测某 .skel：641818 字符里 165995 个 U+FFFD，再编码回去长度都不对了）。
   *   所以需要二进制字段时必须走这条，不能事后从 text 反推。
   * 保留 text 是为了同一字段两种用途都能覆盖（`.atlas` 要文本、`.skel` 要字节）。
   * @param {object} r Reader
   */
  function readRawString(r) {
    const len = r.i32();
    if (len === 0) { r.align(4); return { text: '', bytes: new Uint8Array(0) }; }
    if (len < 0 || len > r.remaining) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `字符串长度非法（string.raw）：${len}`);
    const raw = r.bytes(len, 'string.raw');
    r.align(4);
    // text 做成**惰性**：调用方常常只要 bytes（.skel 二进制，实测 651994 字节）或只要 text
    //   （m_Name 几十字节）。不访问就不解码 —— 探测阶段逐字段全量解码会明显拖慢 canHandle。
    // 行为不变：访问 .text 得到的字符串与立即解码完全相同。
    let decoded = null;
    return {
      bytes: raw,
      get text() {
        if (decoded === null) decoded = new TextDecoder('utf-8').decode(raw);
        return decoded;
      },
    };
  }

  /**
   * 按类型树递归取值。
   * @param {object} node 类型树节点
   * @param {object} r Reader
   * @param {boolean} rawStrings true 时 `string` 返回 `{text,bytes}` 而非 `text`（见 readRawString）
   */
  function readValue(node, r, rawStrings) {
    let align = isAligned(node.metaFlag);
    let value;
    const primitive = (rawStrings && node.type === 'string') ? readRawString : PRIMITIVE[node.type];
    if (primitive) {
      value = primitive(r);
    } else if (node.type === 'pair') {
      value = [readValue(node.children[0], r, rawStrings), readValue(node.children[1], r, rawStrings)];
    } else if (node.children.length && node.children[0].type === 'Array') {
      // 变长数组/容器：先读 i32 长度，再读元素
      const arrayNode = node.children[0];
      if (isAligned(arrayNode.metaFlag)) align = true;
      const size = r.i32();
      if (size < 0 || size > 1e7) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `数组长度非法：${size}（字段 ${node.name}）`);
      const subtype = arrayNode.children[1];
      value = [];
      for (let i = 0; i < size; i++) value.push(readValue(subtype, r, rawStrings));
    } else if (node.children.length) {
      // 结构体/类：按子节点顺序取值
      value = {};
      for (const child of node.children) {
        if (child.type === 'ManagedReferencesRegistry') throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', '尚未支持 ManagedReferencesRegistry（Unity 2020.1+ 的引用注册表）');
        value[child.name] = readValue(child, r, rawStrings);
      }
    } else {
      throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `未知类型，无法取值：type=${node.type} name=${node.name}`);
    }
    if (align) r.align(4);
    return value;
  }

  /**
   * 按类型树读取一个对象的全部字段。
   * @param {object} sf serialized.parse() 的结果
   * @param {object} obj serialized 的对象条目
   * @param {{rawStrings?: boolean}} [opts] rawStrings=true 时 `string` 字段返回 `{text,bytes}`（需要二进制时用）
   * @returns {object} 字段名 → 值（结构体为嵌套对象，数组为数组）
   */
  function readObject(sf, obj, opts) {
    const type = sf.types[obj.typeIndex];
    if (!type || !type.typeTree) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `对象 ${obj.pathID} 的类型没有类型树`);
    const blob = sf.bytes.subarray(type.typeTree.offset, type.typeTree.offset + type.typeTree.size);
    const root = parseBlob(blob, sf.version);
    const r = new B.Reader(sf.bytes, { pos: obj.dataOffset, endian: sf.le === false ? '>' : '<' });
    return readValue(root, r, !!(opts && opts.rawStrings));
  }

  NS.typetree = { parseBlob, readValue, readObject, readRawString, isAligned, ALIGN_BYTES };
}
