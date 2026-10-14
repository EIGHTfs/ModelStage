// ============================================================================
// plugins/unity-live2d-bundle/lib/serialized.js —— SerializedFile 解析（对象表）
//
// 职责：把 UnityFS 里的 CAB-<hash> 节点（一个 SerializedFile）解析成**对象表**：
//   每个对象 = { pathID, classID, className, typeIndex, dataOffset, byteSize }，
//   加上文件级信息（Unity 版本、目标平台、类型表、脚本类型、外部引用、容器清单）。
//   派生能力：按类名统计（本样本 MonoBehaviour 2167 / AnimationClip 34 / Texture2D 2 …）、
//             按类取对象切片（moc3 在 MonoBehaviour 里、physics3 在 TextAsset 里、纹理在 Texture2D 里）。
//
// 字节序（同一个文件里会变，必须逐段确认）：
//   · 头部前 4 个 u32 与 v22 的追加字段（metadataSize/fileSize/dataOffset/unknown）
//     跟在**容器**后面，用容器端的字节序（UnityFS 是大端）——这一点最容易踩：
//     直接用文件自己的端序去读这 4 个 u32，版本号会变成一个天文数字。
//   · 头部里的 endian 标志字节（0=小端/1=大端）之后的元数据段，才是文件自己的端序。
//
// 版本覆盖：本实现覆盖 v22（Unity 2020.3，本样本）用到的字段；更老/更新的版本按
//   同样的分支条件处理，遇到没实现的字段（v23 的类型树 hash + 长度前缀等）抛可读错误。
//
// 挂载：globalThis.__ULB__.serialized
// ============================================================================

'use strict';

{
  const root = globalThis;   // 原 IIFE 的 root 引用（脚本级裸块内保持同名）
  const NS = (root.__ULB__ = root.__ULB__ || {});
  const B = NS.bytes;

  // Unity 的类 ID → 可读类名（只列本插件会用到/会遇到的；其余用 "ClassID <n>" 表示）
  const CLASS_NAMES = {
    1: 'GameObject', 4: 'Transform', 21: 'Material', 23: 'MeshRenderer', 28: 'Texture2D',
    33: 'MeshFilter', 43: 'Mesh', 48: 'Shader', 49: 'TextAsset', 65: 'BoxCollider',
    74: 'AnimationClip', 82: 'AudioSource', 83: 'AudioClip', 91: 'AnimatorController',
    95: 'Animator', 104: 'RenderSettings', 111: 'Animation', 114: 'MonoBehaviour',
    115: 'MonoScript', 128: 'Font', 142: 'AssetBundle', 213: 'Sprite', 222: 'CanvasRenderer',
    223: 'Canvas', 224: 'RectTransform', 225: 'CanvasGroup',
  };
  const CLASS_IDS = { MonoBehaviour: 114, Texture2D: 28, TextAsset: 49, AssetBundle: 142, AnimationClip: 74 };

  const className = (id) => CLASS_NAMES[id] || `ClassID ${id}`;

  /** 读一个 SerializedType（含类型树，类型树只记偏移/长度，不在此处展开字段） */
  function readType(r, opts) {
    const version = opts.version;
    const isRefType = !!opts.isRefType;
    const t = { classID: r.i32(), scriptTypeIndex: -1, scriptID: null, oldTypeHash: null, typeTree: null };
    if (version >= 16) t.isStripped = r.bool();
    if (version >= 17) t.scriptTypeIndex = r.i16();
    if (version >= 13) {
      if ((isRefType && t.scriptTypeIndex >= 0) || (version < 16 && t.classID < 0) || (version >= 16 && t.classID === 114)) {
        t.scriptID = r.bytes(16, 'scriptID');
      }
      t.oldTypeHash = r.bytes(16, 'oldTypeHash');
    }
    if (opts.enableTypeTree) {
      let treeSizeHint = null;
      if (version >= 23) {
        t.typeTreeContentHash = r.bytes(16, 'typeTreeContentHash');
        treeSizeHint = r.i32();
        t.typeTreeSerializedSize = treeSizeHint;
      }
      // v12+/v10 的类型树是**内联 blob**：i32 节点数 + i32 字符串池长度 + 节点数组 + 字符串池。
      //   节点记录（v19+）32 字节：h(m_Version) B(m_Level) B(m_TypeFlags) I(m_TypeStrOffset)
      //   I(m_NameStrOffset) i(m_ByteSize) i(m_Index) i(m_MetaFlag) Q(m_RefTypeHash)
      //   —— 前面 8 个字段 24 字节，v19 起多 8 字节的 m_RefTypeHash，合计 32。
      //   （这也是本文件的坑之一：把节点记录当 28 字节算，整段类型表就会错位。）
      if (version >= 12 || version === 10) {
        const start = r.pos;
        const nodeCount = r.i32();
        const stringBufferSize = r.i32();
        if (nodeCount < 0 || stringBufferSize < 0) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `类型树长度非法：节点数=${nodeCount} 字符串池=${stringBufferSize}`);
        const nodeStructSize = version >= 19 ? 32 : 24;
        r.skip(nodeCount * nodeStructSize + stringBufferSize);
        t.typeTree = { nodeCount, stringBufferSize, offset: start, size: r.pos - start };
      } else {
        throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `尚未支持 v${version} 的非内联类型树（v12 之前的旧格式）`);
      }
      if (version >= 21) {
        if (isRefType) {
          t.m_ClassName = r.cstring('m_ClassName');
          t.m_NameSpace = r.cstring('m_NameSpace');
          t.m_AssemblyName = r.cstring('m_AssemblyName');
        } else {
          const n = r.i32();
          if (n < 0 || n > 128) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `type_dependencies 长度非法：${n}`);
          const deps = [];
          for (let i = 0; i < n; i++) deps.push(r.i32());
          t.typeDependencies = deps;
        }
      }
    }
    t.className = className(t.classID);
    return t;
  }

  /**
   * 解析 SerializedFile。
   * @param {Uint8Array} u8 CAB 节点字节
   * @returns {object} { version, unityVersion, platform, enableTypeTree, types, objects, scripts, externals, dataOffset, container }
   */
  function parse(u8) {
    // 头部前 4 个 u32 用**容器端**字节序（大端）——它们只是"预览"，真实值在 v22 段重读
    const r = new B.Reader(u8, { endian: '>' });
    const preview = { metadataSize: r.u32(), fileSize: r.u32(), version: r.u32(), dataOffset: r.u32() };
    const fieldOrder = preview.version;
    const endianFlag = r.u8();
    r.skip(3); // reserved
    let metadataSize = preview.metadataSize;
    let fileSize = preview.fileSize;
    let dataOffset = preview.dataOffset;
    let unknown = 0;
    if (fieldOrder >= 22) {
      metadataSize = r.u32();
      fileSize = r.i64('fileSize');
      dataOffset = r.i64('dataOffset');
      unknown = r.i64('unknown');
    }
    if (fieldOrder >= 9 && endianFlag > 1) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `字节序标志非法：${endianFlag}`);
    // 之后的元数据段用文件自己的字节序
    r.le = endianFlag === 0;

    const version = fieldOrder;
    let unityVersion = '';
    let platform = 0;
    let enableTypeTree = true;
    if (version >= 7) unityVersion = r.cstring('unityVersion');
    if (version >= 8) platform = r.i32();
    if (version >= 13) enableTypeTree = r.bool();

    const typeCount = r.i32();
    if (typeCount < 0 || typeCount > 4096) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `类型数非法：${typeCount}`);
    const opt = { version, enableTypeTree, isRefType: false };
    const types = [];
    for (let i = 0; i < typeCount; i++) types.push(readType(r, opt));

    let bigIdEnabled = 0;
    if (version >= 7 && version < 14) bigIdEnabled = r.i32();

    const objectCount = r.i32();
    if (objectCount < 0 || objectCount > 1e6) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `对象数非法：${objectCount}`);
    const objects = [];
    const byPathID = new Map();
    for (let i = 0; i < objectCount; i++) {
      // pathID 是 int64，**实测会超过 2^53**（本样本有 2.8e17 这样的值），
      //   所以用 BigInt 读、以十进制字符串对外（JSON 化安全），同时保留 BigInt 供内部比较。
      let pathIDBig;
      if (bigIdEnabled) pathIDBig = r.i64b('pathID');
      else if (version < 14) pathIDBig = BigInt(r.i32());
      else { r.align(4); pathIDBig = r.i64b('pathID'); }
      let byteStart = version >= 22 ? r.i64('byteStart') : r.u32();
      const byteSize = r.u32();
      const typeIndex = r.i32();
      const type = types[typeIndex];
      if (!type) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `对象 ${pathIDBig} 的 typeIndex 越界：${typeIndex}（类型数 ${types.length}）`);
      byteStart += dataOffset;
      if (byteStart + byteSize > u8.length) {
        throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `对象 ${pathIDBig} 越界：offset=${byteStart} size=${byteSize} 文件=${u8.length}`);
      }
      const obj = {
        pathID: pathIDBig.toString(), pathIDBig, typeIndex, classID: type.classID, className: type.className,
        dataOffset: byteStart, byteSize,
      };
      objects.push(obj);
      byPathID.set(obj.pathID, obj);
    }

    let scripts = [];
    if (version >= 11) {
      const scriptCount = r.i32();
      if (scriptCount < 0 || scriptCount > 1e5) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `脚本类型数非法：${scriptCount}`);
      for (let i = 0; i < scriptCount; i++) {
        const localSerializedFileIndex = r.i32();
        let localIdentifierInFile;
        if (version < 14) localIdentifierInFile = String(r.i32());
        else { r.align(4); localIdentifierInFile = r.i64b('localIdentifierInFile').toString(); }
        scripts.push({ localSerializedFileIndex, localIdentifierInFile });
      }
    }

    const externalCount = r.i32();
    if (externalCount < 0 || externalCount > 1e5) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `外部引用数非法：${externalCount}`);
    const externals = [];
    for (let i = 0; i < externalCount; i++) {
      const e = {};
      if (version >= 6) e.tempEmpty = r.cstring('tempEmpty');
      if (version >= 5) { e.guid = B.toHex(r.bytes(16, 'guid')); e.type = r.i32(); }
      e.path = r.cstring('externalPath');
      externals.push(e);
    }

    let refTypes = [];
    if (version >= 20) {
      const refCount = r.i32();
      if (refCount < 0 || refCount > 1e5) throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `引用类型数非法：${refCount}`);
      const refOpt = { version, enableTypeTree, isRefType: true };
      for (let i = 0; i < refCount; i++) refTypes.push(readType(r, refOpt));
    }

    let userInformation = '';
    if (version >= 5) userInformation = r.cstring('userInformation');

    // 强自检：元数据段必须落在数据区之前（偏移算错时这里会先炸，而不是等到取值阶段）
    if (dataOffset && r.pos > dataOffset) {
      throw NS.errors.fail('ULB_ERR_CONTAINER_PARSE', `元数据段越过了数据区：读到的位置=${r.pos} 但 dataOffset=${dataOffset}（字段布局可能不匹配该版本）`);
    }

    return {
      version, unityVersion, platform, enableTypeTree, metadataSize, fileSize, dataOffset, unknown,
      bigIdEnabled, le: endianFlag === 0, types, objects, byPathID, scripts, externals, refTypes, userInformation,
      metaEnd: r.pos,
      bytes: u8,
    };
  }

  /** 按类统计对象数（M4 的验收口径） */
  function typeStats(sf) {
    const stats = {};
    for (const o of sf.objects) stats[o.className] = (stats[o.className] || 0) + 1;
    return stats;
  }

  /** 取某个类 ID 的全部对象（按文件内出现顺序） */
  function byClass(sf, classID) {
    return sf.objects.filter((o) => o.classID === classID);
  }

  /** 取某个对象的字节切片 */
  function objectBytes(sf, obj) {
    return sf.bytes.subarray(obj.dataOffset, obj.dataOffset + obj.byteSize);
  }

  NS.serialized = { parse, typeStats, byClass, objectBytes, className, CLASS_NAMES, CLASS_IDS };
}
