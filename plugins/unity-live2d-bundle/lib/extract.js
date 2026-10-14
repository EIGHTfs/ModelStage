// ============================================================================
// plugins/unity-live2d-bundle/lib/extract.js —— 从对象表里抽取资源
//
// 这里回答"包里的东西分别在哪、怎么取出来"，与游戏无关（碧蓝只是首个样本）：
//   · moc3        ：MonoBehaviour 对象里的字节数组（TypelessData）。本实现用
//                   「MOC3 魔数 + 前置 u32 长度」定位（实测该方法在本样本上精确成立：
//                   魔数前 4 字节 = 3,225,600，恰好等于该对象内剩余长度）；
//                   同时保留类型树读数作为对照口径。
//   · physics3.json：TextAsset 的 m_Script（UTF-8 字符串 → 字节）。
//   · model3/motion3：**原生 Cubism 包**里直接带的 TextAsset/文件（本样本没有，属另一种包型）。
//   · 纹理元信息  ：Texture2D 的宽高/格式/完整尺寸 + m_StreamData（数据在 .resS 里的偏移与长度），
//                   没有流数据时退回对象内的内联 image data。
//
// 两种包型都必须支持（同一插件要能读不止一个游戏的包）：
//   ① 原生 Cubism 文件集：包内直接有 .moc3 / .model3.json / .motion3.json / .physics3.json
//   ② Unity 集成版：只有 moc3（MonoBehaviour 字节数组）+ physics3.json（TextAsset）+ 纹理 + 动画曲线
//   本文件负责把两种形态都"找出来"，是否需要重建 model3/motion3 由上层按"有没有"决定。
//
// 挂载：globalThis.__ULB__.extract
// ============================================================================

'use strict';

{
  const root = globalThis;   // 原 IIFE 的 root 引用（脚本级裸块内保持同名）
  const NS = (root.__ULB__ = root.__ULB__ || {});
  const B = NS.bytes;

  const MOC3_MAGIC = [0x4d, 0x4f, 0x43, 0x33];   // "MOC3"

  const utf8 = (str) => new TextEncoder().encode(str);
  const decodeUtf8 = (u8) => new TextDecoder('utf-8').decode(u8);

  /** 在字节里找第一个匹配 magic 的位置（-1 表示没有） */
  function indexOfMagic(u8, magic, from) {
    const start = from || 0;
    outer:
    for (let i = start; i <= u8.length - magic.length; i++) {
      for (let k = 0; k < magic.length; k++) if (u8[i + k] !== magic[k]) continue outer;
      return i;
    }
    return -1;
  }

  /**
   * 在 MonoBehaviour 对象里找 moc3。
   * 判据（两条都满足才算命中，宁缺勿错）：
   *   ① 对象里出现 "MOC3" 魔数，且前面 4 字节（小端 u32）是长度 L；
   *   ② L 恰好等于「魔数起点 + L = 对象末尾」（对象里该字段就是最后一段）。
   * @returns {{object:object, magicOffset:number, bytes:Uint8Array}|null}
   */
  function findMoc3(sf) {
    const monos = NS.serialized.byClass(sf, 114);
    const candidates = [];
    for (const obj of monos) {
      const bytes = sf.bytes.subarray(obj.dataOffset, obj.dataOffset + obj.byteSize);
      let from = 0;
      for (;;) {
        const magicOffset = indexOfMagic(bytes, MOC3_MAGIC, from);
        if (magicOffset < 0) break;
        if (magicOffset >= 4) {
          const r = new B.Reader(bytes, { pos: magicOffset - 4 });
          const len = r.u32();
          if (len > 64 && magicOffset + len === bytes.length) {
            candidates.push({
              object: obj,
              magicOffset,
              length: len,
              bytes: bytes.subarray(magicOffset, magicOffset + len),
            });
            break;
          }
        }
        from = magicOffset + 1;
      }
    }
    if (!candidates.length) return null;
    // 多个候选时取最大的那个（moc3 是本插件里最大的嵌入式模型数据）
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0];
  }

  /** 取全部 TextAsset（名 + 字节） */
  function findTextAssets(sf) {
    if (!NS.typetree) return [];
    const out = [];
    for (const obj of NS.serialized.byClass(sf, 49)) {
      let fields;
      try { fields = NS.typetree.readObject(sf, obj); }
      catch (e) { out.push({ object: obj, name: null, bytes: null, error: e.message }); continue; }
      const name = fields.m_Name || '';
      const script = fields.m_Script;
      out.push({
        object: obj,
        name,
        pathName: fields.m_PathName || '',
        bytes: typeof script === 'string' ? utf8(script) : null,
      });
    }
    return out;
  }

  /**
   * 取 Texture2D 元信息（不解码，只给出"数据在哪、什么格式、多大"）。
   * @returns {Array<{object:object,name:string,width:number,height:number,format:number,
   *   completeImageSize:number,mipCount:number,stream:{offset:number,size:number,path:string}|null,
   *   inline:Uint8Array|null, raw:object}>}
   */
  function findTextures(sf) {
    if (!NS.typetree) throw NS.errors.fail('ULB_ERR_EXTRACT', '缺少 lib/typetree.js，无法读取 Texture2D 字段');
    // 字段名在类型树里可能是带空格的可读名（如 "image data"），也可能是 m_ 前缀名；
    //   两种都认，避免因类型树命名差异把"内联图像数据"当成不存在（本样本 texture_00 就是 "image data"）。
    const pick = (obj, names) => {
      for (const n of names) if (obj[n] !== undefined && obj[n] !== null) return obj[n];
      return undefined;
    };
    const out = [];
    for (const obj of NS.serialized.byClass(sf, 28)) {
      const f = NS.typetree.readObject(sf, obj);
      const sd = pick(f, ['m_StreamData', 'StreamData']) || {};
      const rawInline = pick(f, ['m_ImageData', 'image data', 'ImageData']);
      const inline = rawInline && rawInline.byteLength !== undefined && rawInline.byteLength > 0 ? rawInline : null;
      const stream = sd.path
        ? { offset: Number(sd.offset || 0), size: Number(sd.size || 0), path: String(sd.path) }
        : null;
      out.push({
        object: obj,
        name: pick(f, ['m_Name', 'name']) || '',
        width: pick(f, ['m_Width', 'width']) || 0,
        height: pick(f, ['m_Height', 'height']) || 0,
        format: pick(f, ['m_TextureFormat', 'm_Format']),
        formatName: NS.texdecode ? NS.texdecode.formatName(pick(f, ['m_TextureFormat', 'm_Format'])) : '',
        completeImageSize: Number(pick(f, ['m_CompleteImageSize']) || 0),
        mipCount: pick(f, ['m_MipCount', 'm_MipmapCount']) || 0,
        stream,
        inline,
        raw: f,
      });
    }
    // 按名字里的数字排序（texture_00 < texture_01 < …）。
    //   为什么重要：Cubism 的 model3.json 用 **Textures 数组下标** 给绘制对象分配贴图，
    //     Unity 资源包里没有 model3，贴图顺序只能从名字恢复；导出件的命名就是 texture_NN，
    //     顺序即下标。若不排序（按对象表顺序取，实测是 texture_01 在前），
    //     整个模型会用错贴图 —— 表现就是"碎板/花屏"。
    out.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
    return out;
  }

  /**
   * 原生 Cubism 文件集：把包内以 .moc3 / .model3.json / .motion3.json / .physics3.json /
   * .cdi3.json 结尾的 TextAsset 按"文件"收集起来（另一种包型的直接通路，不需要重建）。
   */
  function findNativeCubismFiles(sf) {
    const wanted = ['.moc3', '.model3.json', '.motion3.json', '.physics3.json', '.cdi3.json', '.exp3.json'];
    const files = [];
    for (const ta of findTextAssets(sf)) {
      const lower = String(ta.name || '').toLowerCase();
      if (!wanted.some((w) => lower.endsWith(w))) continue;
      files.push({ name: ta.name, kind: lower.slice(lower.lastIndexOf('.') + 1), bytes: ta.bytes });
    }
    return files;
  }

  /**
   * 从 moc3 里扫出**可作为参数名/部件名候选的字符串**。
   *
   * 为什么要它：Unity 的动画绑定只存 32 位哈希（CRC32），要还原成参数名就得有一份候选名单。
   *   moc3 里带有模型的参数 ID 表与部件名，是最完整的候选来源；这里用「可打印字符串扫描」
   *   而不去解析 moc3 二进制布局——布局随 moc3 版本变化，扫描对版本不敏感，
   *   多余的候选无害（最终按 CRC 精确匹配，撞不上的名字不会被用）。
   *
   * @param {Uint8Array} moc3Bytes
   * @param {number} [minLen] 最短长度（默认 3）
   * @returns {string[]} 去重后的候选字符串
   */
  function moc3NameCandidates(moc3Bytes, minLen) {
    const min = minLen || 3;
    const out = new Set();
    if (!moc3Bytes) return [];
    let start = -1;
    for (let i = 0; i <= moc3Bytes.length; i++) {
      const b = i < moc3Bytes.length ? moc3Bytes[i] : 0;
      const printable = b >= 0x20 && b <= 0x7e;
      if (printable) {
        if (start < 0) start = i;
      } else {
        if (start >= 0) {
          const len = i - start;
          if (len >= min && len <= 64) {
            const s = B.latin1(moc3Bytes, start, i);
            // 只要「像标识符」的字符串：字母或下划线开头，其余为字母数字/下划线
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) out.add(s);
          }
          start = -1;
        }
      }
    }
    return [...out];
  }

  /**
   * 一次抽齐（M5/M6 用）。
   * @param {{cabBytes:Uint8Array, resSBytes:Uint8Array, sf?:object}} input
   */
  function extractAll(input) {
    const sf = input.sf || NS.serialized.parse(input.cabBytes);
    const moc3Hit = findMoc3(sf);
    const textAssets = findTextAssets(sf);
    const physTa = textAssets.find((t) => /\.physics3$/i.test(t.name || ''));
    const textures = findTextures(sf);
    return {
      sf,
      moc3: moc3Hit ? moc3Hit.bytes : null,
      moc3Object: moc3Hit ? moc3Hit.object : null,
      moc3MagicOffset: moc3Hit ? moc3Hit.magicOffset : -1,
      physics3: physTa ? physTa.bytes : null,
      textAssets,
      textures,
      nativeFiles: findNativeCubismFiles(sf),
      containerPaths: sf.externals.map((e) => e.path),
    };
  }

  /** 取某张纹理的压缩数据：优先 m_StreamData 指向的 .resS 切片，其次对象内联数据 */
  function textureCompressedBytes(texture, resSBytes) {
    if (texture.stream) {
      if (!resSBytes) throw NS.errors.fail('ULB_ERR_EXTRACT', `纹理 ${texture.name} 的数据在 .resS 里，但没有提供 .resS 字节`);
      const { offset, size } = texture.stream;
      if (offset + size > resSBytes.length) {
        throw NS.errors.fail('ULB_ERR_EXTRACT', `纹理 ${texture.name} 的流数据越界：offset=${offset} size=${size} .resS=${resSBytes.length}`);
      }
      return resSBytes.subarray(offset, offset + size);
    }
    if (texture.inline) return texture.inline;
    throw NS.errors.fail('ULB_ERR_EXTRACT', `纹理 ${texture.name} 既没有流数据也没有内联数据`);
  }

  NS.extract = {
    findMoc3, findTextAssets, findTextures, findNativeCubismFiles,
    extractAll, textureCompressedBytes, indexOfMagic, decodeUtf8, moc3NameCandidates,
  };
}
