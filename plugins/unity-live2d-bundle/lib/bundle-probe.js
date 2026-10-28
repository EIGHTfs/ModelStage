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

  /**
   * 查某个 Unity TextureFormat 是否**可解码**。
   *
   * 判据只有一个：`texdecode.canDecode(fmt)`（内部只认 DECODERS 表）。
   * 为什么不再用 `!!FORMATS[fmt]`：FORMATS 是格式字典（名称/尺寸/block），含 48 ETC2_RGBA1
   *   这种"有条目但从未实现解码"的格式 ⇒ 预检会报"支持"、真正解包才抛 ULB_ERR_TEX_DECODE，
   *   同一件事两套判据。改名/尺寸仍走 FORMATS，但"能不能解"不再由它决定。
   */
  function formatSupport(fmt) {
    const table = NS.texdecode && NS.texdecode.FORMATS ? NS.texdecode.FORMATS : null;
    const entry = table ? table[fmt] : null;
    const raw = NS.texdecode && NS.texdecode.formatName ? NS.texdecode.formatName(fmt) : `未知格式 ${fmt}`;
    const name = entry ? raw : (KNOWN_UNSUPPORTED[fmt] || raw);
    const canDecode = NS.texdecode && typeof NS.texdecode.canDecode === 'function'
      ? NS.texdecode.canDecode(fmt)
      : false;   // 缺 canDecode 时按"不可解码"处理：宁可早拒绝，也不要报"支持"却在解包时炸
    return { supported: canDecode, formatName: name };
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

  // Cubism 2.1 运行时数据 .moc 的魔数：**小写三字节** 'm' 'o' 'c'，紧随其后的第 4 字节是
  //   **文件版本号**（不是第四位魔数）。取证来源：Cubism 2 官方运行时 live2d.min.js 的
  //   loadModel() 里逐字节校验 `109 && 111 && 99`，随后把下一字节当 version 与 SDK 版本比较。
  //   ⇒ 判据**不能**写成 "moc\0"（第 4 字节是版本号，通常非 0）。
  const CUBISM2_MOC_MAGIC = [0x6d, 0x6f, 0x63];

  /**
   * 在这个包里找 Cubism 2.1 的 .moc 运行时数据（**只判定存在性，不解析**）。
   *
   * 为什么要它：.moc 是 Cubism 2.1 的模型二进制，Cubism 3+ 的 SDK/运行时**完全不支持**它
   *   （官方帮助文档明说不支持 .moc/.mtn）。这类包既没有 moc3、也没有 .skel，两个 asset-provider
   *   都不会认领 ⇒ 用户在界面上只看到一句"插件判定不处理该文件"，无法判断是自己资源有问题、
   *   还是格式超出支持范围。本函数就是为了让上层能说清"这是什么、为什么不行、你能做什么"。
   *
   * 判据（**宁缺勿错**，三条全满足才算命中）：
   *   ① MonoBehaviour（class 114）的字节里出现 'moc' 魔数；
   *   ② 魔数前 4 字节（u32）是有意义的长度 L，且 `魔数起点 + L === 对象末尾`
   *      —— 与 findMoc3 同款自洽校验，把"随机字节里凑巧出现 moc"挡掉；
   *   ③ 魔数后第 4 字节是本文件的版本号，落在合理区间 1..16。
   * 扩展名不参与判定（只用来在文案里报出文件名，供用户核对）。
   *
   * @param {object} sf SerializedFile（NS.serialized.parse 的结果）
   * @returns {{count:number, names:string[], sample:{object:object, magicOffset:number, version:number, bytes:number}|null}}
   */
  function findCubism2Moc(sf) {
    const out = { count: 0, names: [], sample: null };
    if (!sf || !NS.serialized || !NS.extract) return out;
    let monos;
    try {
      monos = NS.serialized.byClass(sf, 114);
    } catch {
      return out;   // 对象表读不出来就当没发现（宁可漏报，也不把别的包误判成 Cubism 2）
    }
    // 第一路（主判据）：MonoBehaviour 内嵌字节里的魔数 + 前置长度自洽 + 版本合理
    for (const obj of monos) {
      const bytes = sf.bytes.subarray(obj.dataOffset, obj.dataOffset + obj.byteSize);
      let from = 0;
      for (;;) {
        const at = NS.extract.indexOfMagic(bytes, CUBISM2_MOC_MAGIC, from);
        if (at < 0) break;
        from = at + 1;
        // ② 前置长度自洽：魔数前 4 字节是小端长度，且「魔数起点 + L」恰好到对象末尾
        //    （与 findMoc3 同款；这一条把"随机字节里凑巧出现 moc"挡掉）
        if (at < 4) continue;
        const len = bytes[at - 4] | (bytes[at - 3] << 8) | (bytes[at - 2] << 16) | (bytes[at - 1] << 24);
        if (!(len > 16) || at + len !== bytes.length) continue;
        // ③ 版本号合理（Cubism 2.1 的 .moc 版本是个小整数，见魔数注释里的取证）
        const end = at + 3;
        if (end >= bytes.length) continue;
        const version = bytes[end];
        if (version < 1 || version > 16) continue;
        out.count += 1;
        const name = readObjectName(sf, obj);
        if (name) out.names.push(name);
        if (!out.sample) out.sample = { object: obj, magicOffset: at, version, bytes: len, by: 'magic' };
        break;         // 一个对象里只认第一处（同一个 .moc 不会被切成两段）
      }
    }
    // 第二路（兜底，只作辅助）：TextAsset 的名字以 .moc 结尾。
    //   为什么要这一路：真 .moc 在包里的形态**没有样本可验**（当前资源 0 个）。
    //   若它是以 TextAsset/独立文件形式存在（而非仿真 moc3 的内嵌 TypelessData），
    //   就不存在"前置 u32 长度"，第一路会漏报。此时扩展名是唯一线索。
    //   安全性：本函数只在 run() 里"已确认没有 moc3"之后才被调用，所以不会把 moc3 包误判成 Cubism 2。
    if (out.count === 0) {
      try {
        for (const ta of NS.extract.findTextAssets(sf)) {
          const nm = ta && ta.name ? String(ta.name) : '';
          if (!/\.moc$/i.test(nm)) continue;
          out.count += 1;
          out.names.push(nm);
          if (!out.sample) out.sample = { object: ta.object, magicOffset: -1, version: null, bytes: ta.bytes ? ta.bytes.length : null, by: 'name' };
          break;
        }
      } catch { /* 类型树读不出来就不兜底，不影响主判据 */ }
    }
    return out;
  }

  /** 读对象名（读不出来返回空串；名字只用于文案，不参与判定） */
  function readObjectName(sf, obj) {
    try {
      const fields = NS.typetree ? NS.typetree.readObject(sf, obj) : null;
      return (fields && (fields.m_Name || fields.m_PathName)) || '';
    } catch {
      return '';
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

    // Cubism 2.1 的 .moc 存在性：**只有"没有 moc3"时才有意义**（有 moc3 的包一律按 moc3 走，
    //   哪怕字节里凑巧有 'moc' 片段也不该被说成 Cubism 2 —— 这是判据可靠性的关键）
    const moc3Hit = !!got.moc3;
    const cubism2 = moc3Hit ? { count: 0, names: [], sample: null } : findCubism2Moc(sf);
    // 结构化"为什么没人认领"，交给上层（宿主/调试日志）原样透出给用户
    let reject = null;
    if (!moc3Hit && cubism2.count > 0) {
      const ver = cubism2.sample ? cubism2.sample.version : null;
      const fileHint = cubism2.names.length ? `（${cubism2.names.join('、')}）` : '';
      reject = {
        code: 'LIVE2D_CUBISM2_MOC_UNSUPPORTED',
        // 三句话缺一不可：这是什么 / 为什么不行 / 用户能做什么
        message: `这是 Cubism 2.1 的 .moc 模型数据${fileHint}${ver ? `，版本 ${ver}` : ''}。`
          + 'Cubism 3 及以后的 SDK/运行时已不支持 .moc 与 .mtn 这两种旧格式，本页面的 Live2D 渲染只支持 .moc3。'
          + '若你手上有该模型的 .cmox 工程文件，可用官方 Cubism Editor 打开并转换为 .moc3 后再放进来；'
          + '如果是从游戏包里直接拆出的 .moc，则没有可用的转换途径（需要原作者提供工程文件）。',
      };
    }

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
      cubism2Moc: cubism2.count > 0 ? { count: cubism2.count, names: cubism2.names, version: cubism2.sample ? cubism2.sample.version : null } : null,
      reject,
      physics3: got.physics3 ? { bytes: got.physics3.length } : null,
      nativeFiles: (got.nativeFiles || []).map((f) => f.name),
      textures,
      // 动作数 = AnimationClip 对象数（与装载时的 motion 数同源，但不跑转换）
      motions: countByClass(sf, 'AnimationClip'),
      // 有纹理格式解不了时不算整体失败，只把结论带出来，交给调用方决定
      warnings: unsupported.length ? [`有纹理格式暂不支持：${[...new Set(unsupported)].join('、')}`] : [],
    };
  }

  NS.bundleProbe = { run, formatSupport, findCubism2Moc };
}
