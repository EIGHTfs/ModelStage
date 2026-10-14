// ============================================================================
// lib/bundle-probe.js —— 资源包「装载前预检」（只做便宜的事）
//
// 目的：不装载、不解码纹理像素，就能回答"这个资源包能不能装 / 装起来会缺什么"。
//   预检内容：容器头 → 对象表 → moc3/physics3 存在性 → 纹理格式是否可解码 → 动画片段数。
//
// 为什么放在 lib 而不是插件/服务端各写一份：
//   浏览器侧（插件的 probe）与 Node 侧（/api/bundle/probe）必须给出**同一口径**的结论，
//   否则"预检说能装、装载却失败"这类漂移会反复出现。这里只依赖 NS.* 里已有的库，
//   两端各自加载同一份文件即可。
//
// 挂载：globalThis.__ULB__.bundleProbe = { run, formatSupport }
// ============================================================================

'use strict';

{
  const NS = (globalThis.__ULB__ = globalThis.__ULB__ || {});

  // 已知但暂未实现的格式：预检要让调用方看到"ASTC"而不是"未知格式 50"，
  //   这样才能据此判断"是这个资源用了新压缩格式"而不是"文件坏了"。
  const KNOWN_UNSUPPORTED = {
    24: 'BC6H', 25: 'BC7',
    30: 'PVRTC_RGB2', 31: 'PVRTC_RGBA2', 32: 'PVRTC_RGB4', 33: 'PVRTC_RGBA4',
    50: 'ASTC_RGBA', 51: 'ASTC_RGBA_HDR', 52: 'ASTC_RGB', 53: 'ASTC_RGB_HDR',
  };

  /** 查某个 Unity TextureFormat 是否可解码（以 texdecode.FORMATS 为唯一真相） */
  function formatSupport(fmt) {
    const table = NS.texdecode && NS.texdecode.FORMATS ? NS.texdecode.FORMATS : null;
    const entry = table ? table[fmt] : null;
    const raw = NS.texdecode && NS.texdecode.formatName ? NS.texdecode.formatName(fmt) : `未知格式 ${fmt}`;
    const name = entry ? raw : (KNOWN_UNSUPPORTED[fmt] || raw);
    return { supported: !!entry, formatName: name };
  }

  /** 从序列化文件里按类名统计对象数（避免为了数动作而跑一遍动画转换） */
  function countByClass(sf, className) {
    try {
      const stats = NS.serialized.typeStats(sf);
      if (!stats) return null;
      for (const k of Object.keys(stats)) {
        if (k.toLowerCase() === String(className).toLowerCase()) return stats[k];
      }
      return 0;
    } catch {
      return null;
    }
  }

  /**
   * 预检一个资源包。
   * @param {Uint8Array} bytes 资源包字节
   * @returns {object} { ok, code?, error?, container?, objects?, moc3?, physics3?, textures?, motions? }
   */
  function run(bytes) {
    const E = NS.errors;
    if (!bytes || !bytes.length) {
      return { ok: false, code: E.CODES.NO_FILE, error: '资源包为空或不存在' };
    }
    // 容器头：只看签名，不合格直接定性（不必进解析）
    let sig = '';
    for (let i = 0; i < Math.min(7, bytes.length); i++) sig += String.fromCharCode(bytes[i]);
    if (sig !== 'UnityFS') {
      const shown = sig.replace(/[^\x20-\x7e]/g, '?');
      return { ok: false, code: E.CODES.NOT_UNITYFS, error: `不是 UnityFS 资源包（signature="${shown}"）` };
    }

    let parsed;
    let sf;
    let got;
    try {
      parsed = NS.unityfs.parse(bytes);
      const cab = parsed.nodes.find((n) => /^CAB-/.test(n.path));
      if (!cab) {
        return { ok: false, code: E.CODES.NO_CAB, error: '资源包里没有 CAB-* 节点（不是资产包）' };
      }
      const resSNode = parsed.nodes.find((n) => /\.resS$/.test(n.path));
      const cabBytes = NS.unityfs.nodeBytes(parsed, cab.path);
      const resSBytes = resSNode ? NS.unityfs.nodeBytes(parsed, resSNode.path) : null;
      sf = NS.serialized.parse(cabBytes);
      got = NS.extract.extractAll({ cabBytes, resSBytes, sf });
    } catch (e) {
      return { ok: false, code: E.CODES.CONTAINER_PARSE, error: e.message };
    }

    // 纹理：只判定格式是否可解码，**不解码像素**（解码是最贵的一步，预检故意跳过）
    const textures = (got.textures || []).map((t) => {
      const s = formatSupport(t.format);
      return {
        name: t.name,
        width: t.width,
        height: t.height,
        format: t.format,
        formatName: s.formatName,
        supported: s.supported,
      };
    });
    const unsupported = textures.filter((t) => !t.supported).map((t) => t.formatName);

    return {
      ok: true,
      container: {
        version: parsed.version,
        engine: parsed.engineVersion,
        player: parsed.playerVersion,
        nodes: parsed.nodes.length,
        bytes: bytes.length,
      },
      objects: (sf.objects || []).length,
      moc3: got.moc3 ? { bytes: got.moc3.length } : null,
      physics3: got.physics3 ? { bytes: got.physics3.length } : null,
      nativeFiles: (got.nativeFiles || []).map((f) => f.name),
      textures,
      // 动作数 = AnimationClip 对象数（与装载时的 motion 数同源，但不跑转换）
      motions: countByClass(sf, 'AnimationClip'),
      // 有纹理格式解不了时不算整体失败，只把结论带出来，交给调用方决定
      warnings: unsupported.length ? [`有纹理格式暂不支持：${[...new Set(unsupported)].join('、')}`] : [],
    };
  }

  NS.bundleProbe = { run, formatSupport };
}
