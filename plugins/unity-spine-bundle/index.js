// dsh-skip-quality: install() 是编排型容器函数（只做注册 / 探测 / 日志，本身无实现代码）；
// 硬拆须把 ulb / profileCache / ulbLog 等闭包私有状态提升为模块级，浏览器与 node 两侧都受影响，
// 与 unity-live2d-bundle 的 install() 同性质同豁免口径。
// ============================================================================
// plugins/unity-spine-bundle/index.js —— 「Unity Spine 资源包」插件注册与解析入口
//
// 适用对象：**UnityFS 打包的 Spine 资源包**（单文件、通常无扩展名），包内是 Spine 原生三件套：
//   · `<base>.skel`  —— TextAsset（**二进制** spine skeleton，含版本串如 "4.1.20"）
//   · `<base>.atlas` —— TextAsset（纯文本，首行是贴图页名）
//   · Texture2D      —— 贴图（常见 2048² RGBA32 内联）
//
// 与 live2d 插件的分工（同族容器，靠包内特征互斥，不靠命名顺序）：
//   · live2d：UnityFS + CAB + **有 moc3**          → 认领
//   · spine ：UnityFS + CAB + **有 .skel TextAsset** → 认领
//   两个 asset-provider 都声明 fileKinds:['bundle']，宿主按清单顺序逐个问 canHandle 并**取第一个 true**
//   （plugin-runner 的 pickPlugin 不重试），所以判定必须互斥 —— 只判"容器头"会让两个插件抢同一个包。
//
// 与游戏无关：解析全部走 lib/ 的通用实现；数据性差异（若有）放 profiles/<profile>.json。
//
// 对外契约（契约 插件.md §四 asset-provider）：
//   register({ id, name, label, fileKinds, kind, canHandle, resolve })
//     canHandle(file) → boolean            同步纯判定（§3.1）：是不是本插件能读的容器
//     resolve(file)   → { prefix, files, entry }   容器 → 文件表 + 入口（§4.2）
// ============================================================================

'use strict';

// node 侧可 import（服务端解包）：本文件既是浏览器里的注入式经典脚本，也要能在 node 里被 import。
//   因此顶层**绝不直接引用 window/document** —— node 里没有这两个全局，import 阶段就会
//   ReferenceError 直接炸掉（没有 catch 的机会）；宿主改由 install() 内懒获取。
function install() {
  const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';

  // 宿主注入面懒获取。浏览器：window.SpineViewerPlugins（plugin-host.js 在注入本脚本前挂好）。
  //   node：没有宿主 → null（不注册，改走 globalThis 导出，见文件末尾）。
  const host = (typeof window !== 'undefined' && window.SpineViewerPlugins) || null;
  if (!host && hasDom) {
    console.warn('[unity-spine-bundle] SpineViewerPlugins 未就绪（plugin-host.js 未加载？），插件未注册');
    return null;
  }
  // lib 挂载点：各 lib 文件自己往 globalThis.__ULB__ 挂能力（浏览器里 window 即 globalThis）。
  const NS = (typeof globalThis !== 'undefined' && globalThis.__ULB__) || null;
  if (!NS || !NS.unityfs || !NS.serialized || !NS.extract) {
    if (hasDom) {
      console.warn('[unity-spine-bundle] lib 未加载完整（需要 bytes/common-strings/unityfs/serialized/typetree/extract），插件未注册');
      return null;
    }
  }

  const PLUGIN_ID = 'unity-spine-bundle';
  // Unity classID：49 = TextAsset（spine 的 .skel/.atlas 都以它承载）、28 = Texture2D（贴图页）。
  //   用 serialized.CLASS_IDS 取而不是写字面量：那两个数字是 Unity 格式常量，散落多处会漂。
  const CLASS_ID_TEXT_ASSET = NS.serialized.CLASS_IDS.TextAsset;
  const CLASS_ID_TEXTURE2D = NS.serialized.CLASS_IDS.Texture2D;
  /** 入口清单的文件名（files 里的键，也是 resolve 返回的 entry）。前端按此键取三件套映射。 */
  const ENTRY_NAME = 'entry.json';

  /**
   * 统一日志出口（契约 §3.4 降级口径）：
   *   优先 host.log(level,msg,scope)；宿主没提供（node 侧必然没有）时降级 console[level]，不静默丢弃。
   * 统一收一处：调用点各写一遍 `host.log || console` 容易被静态检查判成裸 console，且样式会漂。
   */
  const ulbLog = (level, msg) => {
    const hostLog = (typeof window !== 'undefined' && window.SpineViewerPlugins && window.SpineViewerPlugins.log)
      || (host && typeof host.log === 'function' ? host.log : null);
    if (hostLog) { hostLog(level, msg, PLUGIN_ID); return; }
    const fn = console[level] || console.log;
    if (fn) fn.call(console, `[${PLUGIN_ID}] ${msg}`);
  };

  /** 把 file（宿主传入的上下文）规整成内部形状；非对象一律当缺参处理。 */
  function asCtx(file) {
    return (file && typeof file === 'object') ? file : null;
  }

  /**
   * lib 层抛的是 ULB_ERR_*（那些 lib 与 live2d 插件逐字节同源，改成 SPI_ 就不再同源），
   * 但**本插件对外声明的码是 SPI_ERR_***（plugin.json 的 errorCodes 是插件自描述，契约 §二）。
   * 所以在插件边界做一次前缀映射：lib 的内部实现细节不外泄，调用方看到的始终是本插件的码。
   * 映射后若落在本插件没声明的码上（如 live2d 专用的 MODEL_BUILD），收敛成 CONTAINER_PARSE
   * 并把原码写进消息 —— 绝不抛一个没声明过的码出去。
   * @param {Error} e
   * @returns {Error} 带 SPI_ 码的错误（原错误不是带码错误时原样返回）
   */
  function toSpiError(e) {
    const code = e && typeof e.code === 'string' ? e.code : '';
    if (!code.startsWith('ULB_ERR_')) return e;
    const mapped = code.replace(/^ULB_ERR_/, 'SPI_ERR_');
    if (Object.prototype.hasOwnProperty.call(NS.errors.CODES, mapped.replace(/^SPI_ERR_/, ''))) {
      return NS.errors.fail(mapped, e.message);
    }
    return NS.errors.fail(NS.errors.CODES.CONTAINER_PARSE, `${e.message}（原 lib 码 ${code}）`);
  }

  /**
   * 取容器字节（契约 §4.1 两条通道）：① file.bytes 直接用；② 否则 host.fetchFile(rootId, rel)。
   * host 不可用且无 bytes ⇒ SPI_ERR_NO_HOST（可退化，契约 §3.6）。
   */
  async function readBundleBytes(ctx, hostApi) {
    const given = ctx && ctx.bytes;
    if (given) return given;
    const fetchFile = hostApi && hostApi.fetchFile;
    if (typeof fetchFile !== 'function') {
      throw NS.errors.fail(NS.errors.CODES.NO_HOST, '宿主未提供 fetchFile(rootId, rel) 且 file.bytes 缺失，无法读取资源包');
    }
    return fetchFile(ctx.rootId, ctx.rel);
  }

  /**
   * 从对象表取出 TextAsset 的**原始字节**（按 m_Name 后缀分 .skel / .atlas）。
   *
   * 为什么必须用 typetree 的 rawStrings 模式而不是 extract.findTextAssets：
   *   后者把 m_Script 当 UTF-8 字符串再 `utf8()` 编码回去，**二进制字段会被毁**
   *   （实测 .skel：651994 字节 → 641818 字符含 165995 个 U+FFFD → 再编码回来长度都不对）。
   *   spine 的 .skel 正是二进制，所以这里走 raw 分支拿 Uint8Array。
   * @param {object} sf serialized.parse() 结果
   * @returns {{skel: Array<{name:string,bytes:Uint8Array}>, atlas: Array<{name:string,bytes:Uint8Array}>}}
   */
  function extractTextAssetsRaw(sf) {
    const skel = [];
    const atlas = [];
    for (const obj of NS.serialized.byClass(sf, CLASS_ID_TEXT_ASSET)) {
      const fields = NS.typetree.readObject(sf, obj, { rawStrings: true });
      const name = (fields.m_Name && typeof fields.m_Name.text === 'string')
        ? fields.m_Name.text : String(fields.m_Name || '');
      const raw = fields.m_Script && fields.m_Script.bytes;
      if (!raw) continue;
      if (/\.skel$/i.test(name)) skel.push({ name, bytes: raw });
      else if (/\.atlas$/i.test(name)) atlas.push({ name, bytes: raw });
    }
    return { skel, atlas };
  }

  /**
   * 从 atlas 文本里解析贴图页名（页名行**行首无空白**且以图片扩展名结尾）。
   * 规则与服务端 src/server/assets/probe.mjs 的 parseAtlasPages 完全一致（那边读文件，这里读内存文本）：
   *   两边必须同口径，否则"插件落盘的 png 文件名"与"扫描器去找的页名"会对不上。
   * @param {Uint8Array} atlasBytes
   * @returns {string[]} 页名（保持 atlas 中的顺序）
   */
  function parseAtlasPages(atlasBytes) {
    // 先剥一次 BOM：JS 的 \s 包含 U+FEFF，而 AssetStudio 导出的 atlas 首行是「BOM + 页名」，
    //   不剥就会把第一页页名当成"有前导空白"整行跳过（多页图集第一页丢失，画面空白）。
    //   服务端 probe.mjs 同口径（那边读文件后剥），前端 textures.js 靠"先 trim"天然免疫 —— 三份一致。
    const text = new TextDecoder('utf-8').decode(atlasBytes).replace(/^\uFEFF/, '');
    const pages = [];
    for (const line of text.split('\n')) {
      if (/^[^\s].*\.(png|jpg|jpeg|webp)\s*$/i.test(line)) pages.push(line.trim());
    }
    return pages;
  }

  /**
   * 读 spine 二进制头部的版本串（形如 "4.1.20"），用于自检与错误信息。
   * .skel 头 8 字节是 hash，随后是版本串（本项目样本里是明文 ASCII）。
   * 读不到不算失败（不同版本布局可能不同），返回 null 由调用方决定怎么处理。
   * @param {Uint8Array} skelBytes
   * @returns {string|null}
   */
  function readSkelVersion(skelBytes) {
    if (!skelBytes || skelBytes.length < 16) return null;
    const head = NS.bytes.latin1(skelBytes, 0, Math.min(64, skelBytes.length));
    // 用**前瞻**正则在每个位置都试一次（前瞻不消耗字符），因为版本串可能与前一段共享数字：
    //   实测 aim 包头是 "…3.4.1.20…"，顺序匹配只能得到 "3.4.1"，
    //   而真实版本串是 "4.1.20"（起始于 "3." 之后的那个 4）。取最后一个命中。
    const all = [...head.matchAll(/(?=(\d+\.\d+\.\d+))/g)].map((m) => m[1]);
    return all.length ? all[all.length - 1] : null;
  }

  /** 容器魔数判定（只读前 8 字节） */
  function looksLikeUnityFs(bytes) {
    if (!bytes || bytes.length < 8) return false;
    return NS.bytes.latin1(bytes, 0, 7) === 'UnityFS' && bytes[7] === 0;
  }

  /**
   * 容器探测（**不解压数据块**，只读头部 + blocksInfo + 对象表字段名）。
   *
   * 为什么只读块表与类型树就够：判定"是不是 spine 包"只需要看 TextAsset 的 m_Name 后缀，
   *   不需要 m_Script 的内容，也不需要解压 CAB 里的数据块（纹理 16MB 和解压 20MB 都省掉）。
   *
   * @param {Uint8Array} bytes
   * @returns {{ok:boolean, reason?:string, code?:string, skel?:string[], atlas?:string[], texCount?:number}}
   */
  function probeContainer(bytes) {
    if (!bytes || !bytes.length) return { ok: false, code: NS.errors.CODES.NO_FILE, reason: '文件为空' };
    if (!looksLikeUnityFs(bytes)) {
      // 明确区分「不是 UnityFS」与「已加密的原始包」：NIKKE 等游戏的原始 AssetBundle 是加密的，
      //   解密后才是明文 UnityFS。这里只处理明文；加密包在头部就不是 UnityFS 魔数。
      return { ok: false, code: NS.errors.CODES.NOT_UNITYFS, reason: '文件头不是 UnityFS（若来自加密游戏包，需先解密）' };
    }
    let head;
    try {
      head = NS.unityfs.readHeader(bytes);
    } catch (e) {
      return { ok: false, code: NS.errors.CODES.CONTAINER_PARSE, reason: `容器头解析失败：${e.message}` };
    }
    const cab = head.nodes.find((n) => /^CAB-/.test(n.path));
    if (!cab) return { ok: false, code: NS.errors.CODES.NO_CAB, reason: '容器里没有 CAB-* 节点（不是资产包）' };

    // 读 CAB 的 SerializedFile 对象表。注意这里**必须**用 parse 拿数据区：
    //   node 的 offset/size 是相对"解压后拼接数据"的，与文件偏移不同。
    let sf;
    try {
      const parsed = NS.unityfs.parse(bytes);
      const cabBytes = NS.unityfs.nodeBytes(parsed, cab.path);
      sf = NS.serialized.parse(cabBytes);
    } catch (e) {
      return { ok: false, code: NS.errors.CODES.CONTAINER_PARSE, reason: `对象表解析失败：${e.message}` };
    }

    const skel = [];
    const atlas = [];
    let texCount = 0;
    try {
      for (const obj of NS.serialized.byClass(sf, CLASS_ID_TEXT_ASSET)) {
        const fields = NS.typetree.readObject(sf, obj);
        const name = typeof fields.m_Name === 'string' ? fields.m_Name : String(fields.m_Name || '');
        if (/\.skel$/i.test(name)) skel.push(name);
        else if (/\.atlas$/i.test(name)) atlas.push(name);
      }
      texCount = NS.serialized.byClass(sf, CLASS_ID_TEXTURE2D).length;
    } catch (e) {
      return { ok: false, code: NS.errors.CODES.CONTAINER_PARSE, reason: `读取 TextAsset 名称失败：${e.message}` };
    }

    if (!skel.length) {
      return { ok: false, code: NS.errors.CODES.NO_SKEL, reason: '包里没有 .skel（不是 Spine 资源包）', atlas, texCount };
    }
    return { ok: true, skel, atlas, texCount };
  }

  /**
   * 契约 §3.1：canHandle 必须是**同步纯布尔**、无 I/O、不抛异常。
   *
   * 三种情形（§3.1 表格）：
   *   ① 有 bytes 且「UnityFS + CAB + 有 .skel TextAsset」→ true
   *   ② 有 bytes 且上述不成立                        → false
   *   ③ 没有 bytes                                  → true（保守放行：判 false 会让无扩展名的包永远无法被选中）
   *
   * 注意不能写成 async：async 返回 Promise，而 Promise 恒为真值，
   *   宿主按 `if (canHandle(file))` 判断时所有文件都会被放行，判定彻底失效。
   */
  function canHandle(file) {
    const ctx = asCtx(file);
    const bytes = ctx && ctx.bytes ? ctx.bytes : null;
    if (!bytes) return true;
    try {
      return probeContainer(bytes).ok === true;
    } catch (e) {
      // §3.1/§3.7：内部异常必须吞成 false 且**不得静默** —— 但这里 probeContainer 已把所有
      //   已知路径都转成 {ok:false}，走到 catch 说明有未预料的错（如 bytes 类型不符 §1.1）。
      //   用 warn 而非 debug：这种情况通常是调用方用法问题，只有 warn 才查得动。
      ulbLog('warn', `canHandle 内部异常，按不可读处理：${e.message}`
        + '（若 bytes 不是契约 §1.1 要求的 Uint8Array，请修宿主侧归一）');
      return false;
    }
  }

  /**
   * 契约 §4.2：resolve 产出 { prefix, files, entry }；失败抛带 code 的错误，不返回缺字段半成品（§五.8）。
   *
   * 产物（键名全部取自包内真实名称，**不自己拼**）：
   *   · `<base>.skel`   —— TextAsset 原名，值是该字段的**原始字节**（二进制，禁字符串回编码）
   *   · `<base>.atlas`  —— TextAsset 原名，值是该字段的原始字节
   *   · `<页名>`        —— **照 atlas 里声明的页名**（NIKKE 实测 `c200_01.png` ↔ Texture2D 名 `c200_01`）
   *   · `entry.json`    —— { skeletonFile, atlasFile, textureFiles[] }，entry 指向它
   *
   * 为什么 files 的值一律给 Blob 而不给 string：契约 §4.2 两种都允许，但宿主侧字节化实现
   *   （plugin-runner 的 toBytes）对 string 走的是 `new Uint8Array(str)`，会得到"长度对、
   *   内容全 0"的假字节。Blob 是唯一不会在这条路上被误解的形态。
   */
  async function resolve(file) {
    const ctx = asCtx(file);
    if (!ctx || !ctx.rootId || !ctx.rel) {
      throw NS.errors.fail(NS.errors.CODES.BAD_ARGS, 'resolve() 缺少必选字段：需要 file.rootId 与 file.rel');
    }
    try {
      const hostApi = ctx.host || host;
      const bytes = await readBundleBytes(ctx, hostApi);

      // —— 先走一遍探测：容器/对象表/.skel 存在性都在那里判过，错误码已经分好类 ——
      const probe = probeContainer(bytes);
      if (!probe.ok) throw NS.errors.fail(probe.code, probe.reason || '不是可解包的 Spine 资源');

      // —— 容器 → 对象表（probeContainer 内部已 parse 过一次，这里再取一次是为了拿节点字节；
      //      parse 是纯 CPU、单包一次，重复一次比把中间态透出来更简单）——
      const parsed = NS.unityfs.parse(bytes);
      const cabNode = parsed.nodes.find((n) => /^CAB-/.test(n.path));
      const resSNode = parsed.nodes.find((n) => /\.resS$/i.test(n.path));
      const sf = NS.serialized.parse(NS.unityfs.nodeBytes(parsed, cabNode.path));
      const resSBytes = resSNode ? NS.unityfs.nodeBytes(parsed, resSNode.path) : null;

      // —— 素材：skel / atlas 取原始字节 ——
      const { skel, atlas } = extractTextAssetsRaw(sf);
      if (!skel.length) throw NS.errors.fail(NS.errors.CODES.NO_SKEL, '包里没有 .skel TextAsset');

      // 按「去扩展名的同名」配对（c200_01.skel ↔ c200_01.atlas）；配不上就退第一个，不猜内容
      const stemOf = (n) => String(n).replace(/\.[^.\\/]+$/, '');
      const skelPick = skel[0];
      const stem = stemOf(skelPick.name);
      const atlasPick = atlas.find((a) => stemOf(a.name) === stem) || atlas[0];
      if (!atlasPick) throw NS.errors.fail(NS.errors.CODES.NO_ATLAS, `有 ${skelPick.name} 但包里没有 .atlas`);

      // 版本串读不到只记录不失败：不同 Spine 版本的头部布局可能不同，硬失败会误拒可用的包
      const spineVersion = readSkelVersion(skelPick.bytes);
      if (!spineVersion) ulbLog('warn', `.skel 头部未识别出 Spine 版本串（${skelPick.name}），继续解包`);

      // —— 纹理：按 atlas 页名找同名 Texture2D，解码后编 PNG ——
      const pages = parseAtlasPages(atlasPick.bytes);
      if (!pages.length) throw NS.errors.fail(NS.errors.CODES.NO_ATLAS, 'atlas 里没有解析到贴图页名');
      const allTextures = NS.extract.findTextures(sf);

      const files = new Map();
      const textureFiles = [];
      for (const page of pages) {
        const pageStem = stemOf(page);
        const tex = allTextures.find((t) => t.name === pageStem)
          || allTextures.find((t) => String(t.name).toLowerCase() === pageStem.toLowerCase());
        if (!tex) {
          throw NS.errors.fail(NS.errors.CODES.EXTRACT,
            `atlas 声明了贴图页「${page}」，但包里找不到同名 Texture2D（${pageStem}）`);
        }
        // 取压缩数据（.resS 切片或对象内联）→ 解码成 RGBA（flipY: Unity 自下而上存储，
        //   atlas 坐标自上而下，翻过来才是正确朝向）→ 编 PNG
        const compressed = NS.extract.textureCompressedBytes(tex, resSBytes);
        const rgba = NS.texdecode.decode(
          { format: tex.format, width: tex.width, height: tex.height, name: tex.name },
          compressed,
          { flipY: true },
        );
        let pngBytes;
        try {
          pngBytes = await NS.png.encodePngAsync(rgba, tex.width, tex.height);
        } catch (e) {
          throw NS.errors.fail(NS.errors.CODES.PNG_ENCODE,
            `贴图页 ${page} 的 PNG 编码失败：${e.message}`);
        }
        files.set(page, new Blob([pngBytes], { type: 'image/png' }));
        textureFiles.push(page);
      }

      // —— 骨架 / 图集（原始字节，绝不走字符串回编码）——
      files.set(skelPick.name, new Blob([skelPick.bytes], { type: 'application/octet-stream' }));
      files.set(atlasPick.name, new Blob([atlasPick.bytes], { type: 'application/octet-stream' }));

      // —— 入口清单：字段名与前端约定一致（skeletonFile / atlasFile / textureFiles）——
      const entryJson = {
        skeletonFile: skelPick.name,
        atlasFile: atlasPick.name,
        textureFiles,
      };
      const entryBytes = new TextEncoder().encode(JSON.stringify(entryJson, null, 2));
      files.set(ENTRY_NAME, new Blob([entryBytes], { type: 'application/json' }));

      // —— prefix（契约 §4.2）：vfs://<providerId>/<rootId>/<相对目录>/ ——
      const relDir = String(ctx.rel).replace(/\/+$/, '').split('/').slice(0, -1).join('/');
      const dirSeg = relDir ? `${relDir}/` : '';
      const prefix = `vfs://${PLUGIN_ID}/${String(ctx.rootId)}/${dirSeg}`;

      ulbLog('info', `已解包 ${ctx.rel}：${files.size} 个文件（skel=${skelPick.name} `
        + `${skelPick.bytes.length}B${spineVersion ? ' v' + spineVersion : ''}，`
        + `atlas=${atlasPick.name}，贴图=${textureFiles.join('/') || '无'}）`);

      return { prefix, files, entry: ENTRY_NAME };
    } catch (e) {
      // 统一在边界把 lib 的 ULB_ 码映射成本插件的 SPI_ 码（见 toSpiError 注释）
      throw toSpiError(e);
    }
  }

  // ---------------- 内存声明（契约 插件.md §2.2；估得准不准由本插件负责）----------------

  /**
   * 运行期固定开销（MB）：解包之外、与容器大小无关的那部分。
   * 量级依据：项目的内存门禁 M4 认定「固定项 ≈103MB」（低于它要提示漏算），
   *   而 live2d 插件最小档也报 147MB —— 两者同源（同一套宿主/渲染/V8 开销）。
   * 这是本插件的责任项：声明后核心直接采信、不再叠加安全垫（§2.2 规则四）。
   */
  const MEMORY_FIXED_OVERHEAD_MB = 103;

  /**
   * 每 1MB 解压后容器对应的额外峰值（MB）。
   *
   * 实测依据（3 个 NIKKE 包；`--expose-gc` 采样 + 逐项分配量核算）：
   *   构成和 = 源 6.6 + 解压 20.7 + RGBA 16.0 + PNG 3.9 = 47.1MB，÷ 解压 20.7MB ≈ 2.27，取 2.3 留余量。
   *
   * **已知局限（别当成通用公式）**：该比值只对「纹理总量与容器大小相近」的包成立。
   *   若纹理远大于容器（live2d 侧实测 adaerbote_3：解压 42MB 但纹理 RGBA 134MB，比值 4.1），
   *   本式会低估。缓解手段都不在本轮范围：
   *   ① resolve 完成后宿主把 rgbaBytes 回填 probe.json，measuredPeakBytes 会用真值修正；
   *   ② 攒够样本后把线性式换成分段表（live2d 就是 19 个样本标定的分段表）。
   */
  const MEMORY_RATIO_PER_DECOMPRESSED_MB = 2.3;

  /**
   * LZMA 峰值落点：解压后 MB → **峰值**（MB，未乘余量）。
   *
   * 基线：`6bcbb22` 换成"写入预分配 Uint8Array"的解码器之后实测的三个点
   *   `2.8MB → 97.8 ｜ 12.86MB → 131.0 ｜ 33.4MB → 218.1`
   *   ⇒ 新解码器下峰值几乎是平的（不再随解压量近似线性暴涨），与旧记录的 46 倍膨胀不是一回事。
   *
   * 取值原则：**宽松的整数**，不再按密集实测点插值。旧表是旧解码器的实测点（2.8→171 … 33.4→995），
   *   换解码器后高估 1.7~4.6 倍、准入过严会把本来解得动的包挡掉；现只留五个整数落点、严格递增：
   *     2MB→128 ｜ 8MB→192 ｜ 16MB→224 ｜ 32MB→288 ｜ 64MB→416
   *
   * 测量口径（与准入同一个量）：
   *   `峰值 = 起始 RSS + 本次 VmHWM 增量` —— 与 plugin-store 的 rssNow / recordMeasuredPeak 同式，
   *   即"服务端解这个包会记录的峰值"；标定工具 tool/fit-memory-peak.mjs 按"每包独立干净进程"测。
   *
   * ⚠️ 本表与 `unity-live2d-bundle/index.js` 里的同名表**必须逐值相同**（同一物理事实）：
   *   test/memory-peak-parity.test.mjs 会导入两边实现逐值比对，不一致就红。
   * ⚠️ 将来重标时不要把"进程内连续解压"的结果混进来（VmHWM 只增不减，后测会被前测带偏）。
   */
  const LZMA_PEAK_POINTS = [[2, 128], [8, 192], [16, 224], [32, 288], [64, 416]];
  /** 峰值安全垫：1.0 —— 表中已是宽松整数上界，不再叠乘系数 */
  const PEAK_MARGIN = 1.0;

  /**
   * LZMA 路径的峰值（MB）：落点之间线性内插、超出最大落点按最后一段斜率外推。
   * 落点已按整数宽松取值且严格递增，所以查表结果天然单调（包络是空操作，留着只为兜底）。
   * @param {number} decompressedMb
   * @returns {number}
   */
  function peakFromLzma(decompressedMb) {
    if (!(decompressedMb > 0)) return 0;
    // 累进上包络：即使将来有人手工往表里加了下降的点，也保证"更大的包不会估得更少"。
    //   现值表严格递增，这一步因此是空操作。
    const pts = [];
    let env = 0;
    for (const [mb, peak] of LZMA_PEAK_POINTS) {
      if (peak > env) env = peak;
      pts.push([mb, env]);
    }
    // 比最小落点还小：按最小落点算（LZMA 字典/窗口开销固定，小包不会更省）
    if (decompressedMb <= pts[0][0]) return Math.ceil(pts[0][1] * PEAK_MARGIN);
    for (let i = 1; i < pts.length; i += 1) {
      if (decompressedMb <= pts[i][0]) {
        const [m0, v0] = pts[i - 1];
        const [m1, v1] = pts[i];
        const t = (decompressedMb - m0) / (m1 - m0);
        // 线性插值，并钳到不低于下界值（防御：表若被手工改成下降，也不让结果低于更小的包）。
        return Math.ceil(Math.max(v0, v0 + (v1 - v0) * t) * PEAK_MARGIN);
      }
    }
    const [ma, va] = pts[pts.length - 2];
    const [mb, vb] = pts[pts.length - 1];
    const slope = Math.max(0, (vb - va) / (mb - ma));
    return Math.ceil((vb + (decompressedMb - mb) * slope) * PEAK_MARGIN);
  }

  /**
   * 认定某压缩类型是否走 LZMA 表。
   * 认不出（未传 / 混合 -1 / 未来新增类型）⇒ **按 LZMA 算（更保守）**：
   *   低估会放行 → 真冲高 → OOM 或被守护中止；高估只是"这次被拒/排队"，代价不对等。
   * @param {number} t
   * @returns {boolean}
   */
  function isLzmaPeak(t) {
    // 白名单：只有明确已知的非 LZMA 类型（NONE=0 / LZ4=2 / LZ4HC=3）才不用 LZMA 表；
    //   未传 / 混合 -1 / 未来新增类型 一律按 LZMA（保守）。
    return !(t === 0 || t === 2 || t === 3);
  }

  /**
   * 内存代价声明（契约 §2.2 第②段：`decompressedBytes` 必须能从容器块表推出，不许填经验值）。
   *
   * 口径要点：
   *   · `decompressedBytes` 走 `unityfs.blocksSummary` —— **只读头 + blocksInfo，不解压数据块**；
   *   · **不用 TextAsset 的文本长度**：`.skel` 二进制经 UTF-8 往返会膨胀
   *     （实测 651994 字节 → 980446 字节，1.5 倍），拿它估内存会系统性高估。本插件一律 raw 字节口径；
   *   · 宿主可能只给 256KB 头部（`size:0`）：块表在尾部的包（NIKKE 是 0x80 置位）解析会抛错
   *     ⇒ 这里返回 null ⇒ 宿主回退全量读 —— 属正常路径，不是失败。
   *
   * @param {{bytes?: Uint8Array}} file
   * @returns {{decompressedBytes:number, compressedBytes:number, peakBytes:number}|null}
   */
  function estimateMemory(file) {
    try {
      const bytes = file && file.bytes;
      if (!bytes || !bytes.length) return null;
      const summary = NS.unityfs.blocksSummary(bytes);
      if (!(summary.decompressedBytes > 0)) return null;
      const decompressedMb = summary.decompressedBytes / (1024 * 1024);
      // 压缩类型取自块表（blocksSummary 顺手带出，不额外扫包）；LZMA 走实测折线表，
      //   其余走原线性式（那是按 LZ4 包标定的）。
      const peakMb = isLzmaPeak(summary.compression)
        ? peakFromLzma(decompressedMb)
        : MEMORY_FIXED_OVERHEAD_MB + decompressedMb * MEMORY_RATIO_PER_DECOMPRESSED_MB;
      return {
        decompressedBytes: summary.decompressedBytes,
        compressedBytes: summary.compressedBytes,
        compressionType: summary.compression,
        peakBytes: Math.ceil(peakMb * 1024 * 1024),
      };
    } catch {
      return null;   // 算不出来就让核心走「源包大小粗估」回落，绝不因此阻断加载
    }
  }

  if (host) {
    host.register({
      id: PLUGIN_ID,
      name: 'Unity Spine 资源包',
      label: 'Spine包',
      canHandle,
      resolve,
      // 契约 §2.2：让宿主与检查器都能发现"本插件能自己算内存代价"
      estimateMemory,
      // kind 的唯一权威来源是 plugin.json 的 produces.kind（契约 §3.2），这里带上只为调试可读。
      kind: 'spine',
      fileKinds: ['bundle'],
    });
  }

  // node 侧返回解析入口：服务端解包直接从返回值取 canHandle/resolve，不经过宿主注册。
  // __test 只给单测用（纯函数、无副作用、宿主不读它）：parseAtlasPages 是闭包内私有函数，
  //   没有它就无法为"带 BOM 的 atlas 首行"补单测（这正是 NIKKE 根 34 份带 BOM 的 atlas 丢第一页贴图的根因）。
  return { canHandle, resolve, estimateMemory, probeContainer, PLUGIN_ID, __test: { parseAtlasPages } };
}

// 执行安装。为什么不用 `export { canHandle }`：那会把文件变成 ESM，
//   浏览器以 <script> 注入时 export 是语法错误 ⇒ 整个插件加载失败。保持经典脚本形态，
//   node 侧用条件挂载暴露。
//
// 顶层常量必须带插件前缀：多个插件的脚本都注入到**同一个全局作用域**，
//   用 `ulb` / `api` / `ns` 这类通用名会与别的插件撞车，
//   表现为先加载的插件正常、后加载的插件报 Uncaught SyntaxError: Identifier 'x' has already been declared，
//   而且那条错在插件自己的代码之外，插件整个不执行（实测踩过：本插件叫 ulb 时把 live2d 插件整挂了）。
const spiApi = install();
if (spiApi && typeof window === 'undefined' && typeof globalThis !== 'undefined') {
  // node 侧挂载键：__PLUGIN_API__ 是统一契约，__ULB_NODE__ 保留兼容旧 runner
  globalThis.__PLUGIN_API__ = spiApi;
  globalThis.__ULB_NODE__ = spiApi;
}
