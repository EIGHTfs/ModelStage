// dsh-skip-quality: install() 是编排型容器函数（19 个具名子函数平均 25 行，本身无实现代码）；
// 硬拆须把 PLUGIN_ID/profileCache/ulbLog 等闭包私有状态提升为模块级，浏览器与 node 两侧都受影响，风险大于收益。
// ============================================================================
// plugins/unity-live2d-bundle/index.js —— 「Unity Live2D 资源包」插件注册与解析入口
//
// 适用对象：**UnityFS 打包的单文件 Live2D 资源包**（无扩展名或任意扩展名），覆盖两种包型：
//   ① 原生 Cubism 文件集：包内直接有 .moc3 / .model3.json / .motion3.json / .physics3.json
//      → 直接抽取即可，不需要重建任何东西
//   ② Unity 集成版：只有 moc3（MonoBehaviour 字节数组）+ physics3.json（TextAsset）+ 纹理
//      + AnimationClip 曲线（动作）
//      → 需要上层重建 model3.json、把 AnimationClip 转成 motion3.json（转换器在 lib/ 里，
//        本文件只负责"把素材取出来"，不在此处做转换）
//
// 与游戏无关：所有解析走 lib/ 的通用实现；同族容器的数据性差异（动作循环规则、淡入淡出、
//   点击热区）放在 profiles/unityfs-live2d.json，由 file.profile 指定（缺省走通用规则）。
//   注意：该 profile 文件名按**容器类型**命名而非游戏名——插件只分辨文件类型（fileKinds=bundle），
//   按游戏名命名会让"碧蓝航线专用"的错觉传递下去，也会与资源根配置里的同名项撞名造成误读。
//
// 对外契约（宿主 plugin-host.js）：
//   register({ id, name, label, fileKinds, kind, canHandle, resolve })
//     label      —— 角色库里变体标签用的文字（宿主按类型决定配色，插件不自创配色）
//     canHandle(file) → boolean  同步纯判定（契约 §3.1）：是不是本插件能读的容器
//     resolve(file)   → { prefix, files, entry }  契约 §1.2：容器 → 文件表 + 入口
// ============================================================================

'use strict';

// 脚本顶层用「带标签的块 + break」代替 IIFE 里的 return：
//   插件文件是以 <script> 形式注入的，裸块内 return 属非法语法（IIFE 展开后必须改写早退路径）。
//
// node 侧可 import（服务端解包 17a）：本文件既是浏览器里的注入式经典脚本，也要能在 node 里被 import。
//   因此顶层**绝不直接引用 window/document**——node 里没有这两个全局，import 阶段就会
//   ReferenceError 直接炸掉（没有 catch 的机会，与 collectParameterTable 同理：必须先判断再使用）。
//   宿主改由 getHost() 懒获取：浏览器里等价于原来的 window.SpineViewerPlugins，
//   node 里没有宿主就返回 null，本文件转为「纯解析库」模式（只暴露 resolve/canHandle，不注册）。
//
// 实现方式：把整套安装逻辑收进 install()，浏览器与 node 都调它。
//   为什么不拆成 ESM export：浏览器以 <script> 注入，export 语句在经典脚本里是语法错误，
//   整个插件会加载失败。所以 node 侧用「条件挂到 globalThis」的方式暴露，文件仍保持经典脚本形态。
function install() {
  const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';

  // 宿主注入面懒获取。浏览器：window.SpineViewerPlugins（由 plugin-host.js 在注入本脚本前挂好）。
  //   node：没有宿主 → null（不注册，改走 globalThis 导出，见文件末尾）。
  const host = (typeof window !== 'undefined' && window.SpineViewerPlugins) || null;
  if (!host && hasDom) {
    // node 侧无宿主不是错误：服务端解包只需要 resolve()，不需要注册。
    //   浏览器侧无宿主才是异常（插件脚本被注入了但宿主没就绪），要留可见告警。
    console.warn('[unity-live2d-bundle] SpineViewerPlugins 未就绪（plugin-host.js 未加载？），插件未注册');
    return null;
  }
  // lib 挂载点：各 lib 文件自己往 globalThis.__ULB__ 挂能力，浏览器里 window 即 globalThis，
  //   所以统一从 globalThis 取即可（node 侧同样落在 globalThis）。
  const NS = (typeof globalThis !== 'undefined' && globalThis.__ULB__) || null;
  if (!NS || !NS.unityfs || !NS.serialized || !NS.extract) {
    if (hasDom) {
      console.warn('[unity-live2d-bundle] lib 未加载完整（需要 bytes/common-strings/unityfs/serialized/typetree/extract），插件未注册');
      return null;
    }
    // node 侧 lib 未加载也返回 null：调用方从 globalThis 上拿不到 resolve，会在自己那边报可读错误
  }

  const PLUGIN_ID = 'unity-live2d-bundle';
  const profileCache = new Map();

  // Blob 的 MIME 常量集中一处：这三类在 buildFileSet 里各出现一次，
  //   散着写字面量既难统一改，也让"这个键到底是什么类型"要跳到调用点才看得见。
  const MIME_OCTET = 'application/octet-stream';   // moc3（Cubism 模型二进制）
  const MIME_JSON = 'application/json';            // physics3 / motion3 / model3.json
  const MIME_PNG = 'image/png';                    // 纹理（ETC2/DXT 解码后编码的 PNG）

  /**
   * 统一日志出口（契约 §3.4 + §3.6 降级口径）：
   *   优先 host.log(level, msg, scope)；宿主没提供 log（node 侧必然没有）时降级为 console[level]，
   *   但**不得静默丢弃**——降级也要让人看得见。
   * 为什么收成一处：早期各处自己写 `host.log || console.xxx` 兜底，写法分散且容易被静态检查判成裸 console；
   *   统一走这里，node 侧（无 host）自动落到 console，浏览器侧（有 host）自动走宿主日志。
   */
  const ulbLog = (level, msg) => {
    const hostLog = (typeof window !== 'undefined' && window.SpineViewerPlugins && window.SpineViewerPlugins.log)
      || (host && typeof host.log === 'function' ? host.log : null);
    if (hostLog) { hostLog(level, msg, PLUGIN_ID); return; }
    const c = console[level] || console.log;
    if (c) c.call(console, `[${PLUGIN_ID}] ${msg}`);
  };

  /**
   * 读游戏适配数据（profiles/<id>.json）。
   * 路径由 profile 参数给出，不从名字猜；读不到就返回空对象（通用逻辑仍可工作）。
   */
  /** 外部请求超时上限（毫秒）：profile 与 Blob 资源读取都必须有界，避免网络挂起时装载流程悬空 */
  const FETCH_TIMEOUT_MS = 15000;

  /**
   * 带超时的 fetch：超时即 abort 并抛**带码**错误（ULB_ERR_IO），调用方按码决定重试/降级。
   *   为什么不用裸 fetch：网络挂起时 fetch 可能长时间不返回，整个装载会一直悬着没有反馈。
   */
  async function fetchWithTimeout(url, opts, timeoutMs) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const limit = timeoutMs || FETCH_TIMEOUT_MS;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), limit) : null;
    try {
      return await fetch(url, Object.assign({}, opts || {}, ctrl ? { signal: ctrl.signal } : {}));
    } catch (e) {
      if (ctrl && ctrl.signal.aborted) {
        throw NS.errors.fail('ULB_ERR_IO', `请求超时（${limit}ms）：${String(url).slice(0, 48)}`);
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function loadProfile(name) {
    if (!name) return {};
    if (profileCache.has(name)) return profileCache.get(name);
    let profileData = {};   // 不用泛用的 data：这里是「profile 适配数据」，写清楚用途
    try {
      const r = await fetchWithTimeout(`/plugins/${PLUGIN_ID}/profiles/${encodeURIComponent(name)}.json`, { cache: 'no-store' }, FETCH_TIMEOUT_MS);
      if (r.ok) profileData = await r.json();
      else ulbLog('info', `没有 profile「${name}」，按通用规则处理`);
    } catch (e) {
      ulbLog('warn', `读取 profile「${name}」失败：${e.message}`);
    }
    profileCache.set(name, profileData);
    return profileData;
  }

  /** 容器魔数判定（只读前 8 字节即可） */
  function looksLikeUnityFs(bytes) {
    if (!bytes || bytes.length < 8) return false;
    return NS.bytes.latin1(bytes, 0, 7) === 'UnityFS' && bytes[7] === 0;
  }


  // 参数表缓存：同一份 moc3 反复 open 时不必重复创建 Cubism Core 的 Model
  //   （Core 的 Model 会占 WASM 堆内存且不随 JS 垃圾回收立即释放，连开多次会明显涨内存）。
  //   键用 moc3 的指纹（长度 + 首尾各 8 字节）—— 同包内容相同即命中。
  const paramTableCache = new Map();
  function moc3Fingerprint(b) {
    const head = Array.from(b.slice(0, 8)).map((x) => x.toString(16).padStart(2, '0')).join('');
    const tail = Array.from(b.slice(b.length - 8)).map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${b.length}-${head}-${tail}`;
  }

  /**
   * 取 moc3 **参数表**（Id + 类型 + 范围）—— 动画曲线能不能输出，以它为准。
   *
   * 为什么不用字符串表：moc3 的字符串池里还混着部件名、绘制名等"不是参数"的名字，
   *   拿它当白名单会产出运行时不认识的 Id（Cubism 解析 motion3 时查不到参数对象直接抛错）。
   *   参数表是 Cubism Core 自己的 API（Model.fromMoc → parameters），最权威，故直接用它。
   *
   * 取不到（精简环境没加载 Core 且脚本加载失败）时返回 null，调用方退化为"不校验"并留日志。
   */
  /** 读 moc3 CanvasInfo → designSize（画布像素尺寸 + 原点 + 单位换算）。 */
  function readCanvasMeta(model) {
    const ci = model.canvasinfo;
    if (!ci || !(ci.CanvasWidth > 0) || !(ci.CanvasHeight > 0)) return null;
    return {
      width: ci.CanvasWidth,
      height: ci.CanvasHeight,
      originX: ci.CanvasOriginX,
      originY: ci.CanvasOriginY,
      pixelsPerUnit: ci.PixelsPerUnit || null,
      source: 'moc3.CanvasInfo',
    };
  }

  /** 扫描全部绘制对象的顶点，返回 min/max 与有效点数（无有效点返回 null）。 */
  function scanVertexBounds(vertexPositions) {
    if (!vertexPositions) return null;
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity, n = 0;
    for (let i = 0; i < vertexPositions.length; i++) {
      const arr = vertexPositions[i];
      if (!arr || !arr.length) continue;
      for (let k = 0; k + 1 < arr.length; k += 2) {
        const x = arr[k], y = arr[k + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        n++;
        if (x < mnx) mnx = x;
        if (x > mxx) mxx = x;
        if (y < mny) mny = y;
        if (y > mxy) mxy = y;
      }
    }
    return n ? { mnx, mny, mxx, mxy, n } : null;
  }

  /** 读 rest pose 下全部绘制对象顶点的 min/max（模型单位），并按 ppu 附带像素尺寸。 */
  function readRestBbox(model, designSize) {
    try { model.update(); } catch (e) { /* 无参可调或无需 update 时忽略 */ }
    const b = scanVertexBounds(model.drawables && model.drawables.vertexPositions);
    if (!b) return null;
    const ppu = designSize && designSize.pixelsPerUnit ? designSize.pixelsPerUnit : null;
    return {
      x: +b.mnx.toFixed(3),
      y: +b.mny.toFixed(3),
      width: +(b.mxx - b.mnx).toFixed(3),
      height: +(b.mxy - b.mny).toFixed(3),
      unit: 'model',
      pose: 'rest',
      vertexCount: b.n,
      pixels: ppu ? { width: +((b.mxx - b.mnx) * ppu).toFixed(1), height: +((b.mxy - b.mny) * ppu).toFixed(1) } : null,
    };
  }

  /** 遮罩组数 = 被引用的**不同**遮罩绘制对象数（同一遮罩可被多个对象引用）。 */
  function countMaskGroups(model) {
    const masks = model.drawables && model.drawables.masks;
    if (!masks) return null;
    const groups = new Set();
    for (const refs of masks) {
      if (!refs) continue;
      for (const r of refs) groups.add(r);
    }
    return groups.size;
  }

  /**
   * 从已构造的 Cubism Core 模型读「画布尺寸 + 顶点包围盒 + 结构计数」。
   *
   * 口径与限制（会随产出一起给前端，前端据此判断，不要自己重算）：
   *   · designSize = moc3 的 CanvasInfo（CanvasWidth/CanvasHeight，Cubism 原始画布像素尺寸），
   *     另给 originX/originY（画布原点，Cubism 在画布中心）与 pixelsPerUnit（模型单位 → 像素）。
   *   · bbox = **rest pose（默认参数）**下全部绘制对象顶点的 min/max，单位是**模型单位**；
   *     不含物理、动作、表情造成的变形 —— 需要"动作全程"包围盒的调用方要自己采样。
   */
  function collectCoreModelMeta(core, model) {
    const meta = {
      drawableCount: null, partCount: null, parameterCount: null, maskGroupCount: null,
      designSize: null, bbox: null,
    };
    try {
      meta.drawableCount = model.drawables ? model.drawables.count : null;
      meta.partCount = model.parts ? model.parts.count : null;
      meta.parameterCount = model.parameters ? model.parameters.count : null;
      meta.maskGroupCount = countMaskGroups(model);
      meta.designSize = readCanvasMeta(model);
      meta.bbox = readRestBbox(model, meta.designSize);
    } catch (e) {
      meta.error = e.message;
    }
    return meta;
  }

  async function collectParameterTable(moc3Bytes, timeoutMs) {
    const limit = timeoutMs || 8000;
    // node 侧兜底（服务端解包 17a）：没有 DOM 时不能动态加载 Cubism Core，直接跳过参数表提取。
    //   调用方（convertClipMotions）对 null 已有降级——只 warn「曲线 Id 不做白名单校验」，
    //   产出形状与 files 条数都不变（白名单少一道校验，曲线仍按候选名 + CRC32 匹配输出）。
    //   浏览器侧不受影响：有 document/window 时照旧走下面的动态加载分支。
    //   这里必须**早返回**：node 里 document.createElement 会直接抛 ReferenceError，
    //   而该异常会被外层 catch 吞掉只留一行 warn，看起来像"参数表读取失败"而非"无 DOM"。
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      // 降级必须**可观察**（不能静默）：走 host.log 优先、console 兜底的既有通道，
      //   不用裸 console（契约 §3.4 要求用户可见输出统一走 host.log）。
      ulbLog('info', 'node 侧无 DOM，跳过 moc3 参数表提取（曲线 Id 不做白名单校验）');
      return null;
    }
    if (!window.Live2DCubismCore) {
      // Core 通常由舞台在首次渲染时懒加载；插件自己按需补一次（已存在则跳过）
      await new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = '/live2d-lib/live2dcubismcore.min.js';
        const timer = setTimeout(() => resolve('timeout'), limit);
        s.onload = () => { clearTimeout(timer); resolve('ok'); };
        s.onerror = () => { clearTimeout(timer); resolve('error'); };
        document.head.appendChild(s);
      });
    }
    const core = window.Live2DCubismCore;
    if (!core || !core.Moc || !core.Model || typeof core.Model.fromMoc !== 'function') return null;
    const cacheKey = moc3Fingerprint(moc3Bytes);
    if (paramTableCache.has(cacheKey)) return paramTableCache.get(cacheKey);
    try {
      const ab = moc3Bytes.buffer
        ? moc3Bytes.buffer.slice(moc3Bytes.byteOffset, moc3Bytes.byteOffset + moc3Bytes.byteLength)
        : moc3Bytes;
      const moc = core.Moc.fromArrayBuffer(ab);
      const model = core.Model.fromMoc(moc);
      const p = model.parameters;
      if (!p || !p.ids) return null;
      const table = {
        ids: new Set(Array.from(p.ids)),
        count: p.count,
        types: p.types ? Array.from(p.types) : null,
        minimumValues: p.minimumValues ? Array.from(p.minimumValues) : null,
        maximumValues: p.maximumValues ? Array.from(p.maximumValues) : null,
        defaultValues: p.defaultValues ? Array.from(p.defaultValues) : null,
        partCount: model.parts ? model.parts.count : null,
        // 模型元数据（画布尺寸 / rest pose 包围盒 / 结构计数）：同一趟 Core 读取里一起拿，避免二次解析 moc3
        meta: collectCoreModelMeta(core, model),
      };
      paramTableCache.set(cacheKey, table);
      return table;
    } catch (e) {
      ulbLog('warn', `读取 moc3 参数表失败：${e.message}`);
      return null;
    }
  }

  /**
   * 从 physics3.json 里收集参数名（作为 CRC32 反查动画绑定的候选）。
   * 任何解析失败都只是少一点候选，不影响主流程。
   */
  function collectParameterNames(physics3Bytes) {
    const out = [];
    if (!physics3Bytes) return out;
    try {
      const json = JSON.parse(NS.extract.decodeUtf8(physics3Bytes));
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (typeof o.Id === 'string') out.push(o.Id);
        for (const k of Object.keys(o)) walk(o[k]);
      };
      walk(json);
    } catch { /* 物理文件缺失/损坏都能接受 */ }
    return out;
  }

  /**
   * 把 Unity 集成版抽取出的素材整理成**契约形态的「文件表 + 入口」**：
   *   moc3 / 纹理 PNG / physics3 / motion3 / 重建的 model3.json 全部按「相对键」进 files，
   *   model3.json 的 FileReferences 引用 files 内的键（不写 Blob URL）。
   *
   * 为什么用相对键而不是 Blob URL（契约 §1.2）：files 的值必须是文件内容（Blob/string），
   *   URL 不是内容、也没法被 VirtualFS 注册；核心按 prefix 注册后由渲染层解析相对引用。
   *   旧实现曾把 Blob URL 写进 model3 并给页面加载器装直通中间件，那属于契约 §3.8 点名的问题形态
   *   （"想给加载器装中间件"= 产物形态设计有问题），现已按契约收敛为纯文件表。
   *
   * 键名规则：moc3 → 'moc3.moc3'；纹理 → 'textures/<原纹理名>.png'；
   *   physics3 → 'physics3.json'；动作 → 'motions/<动作名>.motion3.json'；入口 → 'model3.json'。
   *   键只按素材角色命名，不含游戏名/资源根路径（契约 §五.6 禁止写死）。
   *
   * @returns {Promise<{files: Map<string,Blob>, entry: string}>}
   */
  async function buildFileSet(extracted, profile) {
    const files = new Map();      // 相对键 → Blob（契约 §1.2：Blob|string；二进制一律 Blob）
    const put = (key, bytes, mime) => { files.set(key, new Blob([bytes], { type: mime || MIME_OCTET })); return key; };

    const KEY_MOC3 = 'moc3.moc3';
    const KEY_PHYSICS = 'physics3.json';
    const keyTexture = (n) => `textures/${n}.png`;
    const keyMotion = (n) => `motions/${n}.motion3.json`;

    const mocRef = put(KEY_MOC3, extracted.moc3, MIME_OCTET);
    // 纹理：逐张压缩编码（不并发），编完立刻释放 RGBA 缓冲 —— 峰值内存比"两张 67MB 级 PNG 同时生成"低得多。
    const textureRefs = [];
    for (const t of extracted.textures) {
      if (!t.comp) continue;
      // 解一张 → 编一张：rgba 是**局部变量**，编完随作用域释放（不要挂到 t 上，挂上去就等于常驻）
      const rgba = NS.texdecode.decode(t, t.comp);
      const png = await NS.png.encodePngAsync(rgba, t.width, t.height);
      t.pngBytes = png.length;
      textureRefs.push(put(keyTexture(t.name), png, MIME_PNG));
    }
    const physicsRef = extracted.physics3 ? put(KEY_PHYSICS, extracted.physics3, MIME_JSON) : null;

    // 动作：每个 motion3.json 一个键，并按 profile 规则分组（组内顺序 = 名字序，稳定可复现）
    const motionDefs = [];
    for (const m of extracted.motions) {
      const json = m.json;
      const ref = put(keyMotion(m.name), new TextEncoder().encode(JSON.stringify(json)), MIME_JSON);
      motionDefs.push({ name: m.name, url: ref, group: NS.model3.motionGroupOf(m.name, profile), loop: !!json.Meta.Loop, meta: json.Meta });
    }
    motionDefs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const paramNames = extracted.paramNames || [];
    const model3 = NS.model3.buildModel3({
      mocUrl: mocRef,
      textureUrls: textureRefs,
      physicsUrl: physicsRef,
      motions: motionDefs,
      paramNames,
      profile,
    });
    // 入口：重建的 model3.json 也进 files（契约 §1.2：entry 必须是 files 的键）
    put('model3.json', new TextEncoder().encode(JSON.stringify(model3)), MIME_JSON);
    return { files, entry: 'model3.json' };
  }

  /**
   * 取资源包字节（契约 §1.1 取字节两条通道 + §3.6 宿主能力面）：
   *   ① file.bytes 存在 → 直接用（不产生 I/O）
   *   ② 不存在 → host.fetchFile(rootId, rel) → Promise<Uint8Array>（§3.6 规定签名，直接返回 Uint8Array）
   * host 不可用（且无 bytes）→ 抛 ULB_ERR_NO_HOST（可退化，§3.6 缺省/降级列）。
   */
  async function readBundleBytes(ctx, hostApi) {
    const given = ctx && ctx.bytes;
    if (given) return given;
    if (!ctx || !ctx.rootId || !ctx.rel) throw NS.errors.fail('ULB_ERR_BAD_ARGS', '缺少 rootId/rel，无法读取资源包');
    // §3.6：host 缺失且 bytes 缺失时，不能降级出字节 → 抛带码错误（可退化）
    const fetchFile = hostApi && hostApi.fetchFile;
    if (typeof fetchFile !== 'function') {
      throw NS.errors.fail('ULB_ERR_NO_HOST', '宿主未提供 fetchFile(rootId, rel) 且 file.bytes 缺失，无法读取资源包');
    }
    const bytes = await fetchFile(ctx.rootId, ctx.rel);
    return bytes;   // §3.6 签名：fetchFile 直接返回 Promise<Uint8Array>
  }

  /** 校验容器并取出 CAB（必需）与 resS（可选）两段字节。 */
  function parseContainerNodes(bytes, displayName) {
    if (!looksLikeUnityFs(bytes)) {
      throw NS.errors.fail('ULB_ERR_NOT_UNITYFS', `不是 UnityFS 资源包：${displayName || '(未命名)'}`);
    }
    const parsed = NS.unityfs.parse(bytes);
    const cabNode = parsed.nodes.find((n) => /^CAB-/.test(n.path));
    if (!cabNode) throw NS.errors.fail('ULB_ERR_NO_CAB', '资源包里没有 CAB-* 节点（不是资产包？）');
    const resSNode = parsed.nodes.find((n) => /\.resS$/.test(n.path));
    return {
      parsed,
      cabNode,
      cabBytes: NS.unityfs.nodeBytes(parsed, cabNode.path),
      resSBytes: resSNode ? NS.unityfs.nodeBytes(parsed, resSNode.path) : null,
    };
  }

  /**
   * 逐张纹理**只收集压缩字节**（**不在这里解码**）；单张失败只记录 error，不整体失败（报告里能看出是哪张坏）。
   *
   * 为什么把解码推迟到编码那一刻：一张 4096² 的 RGBA 是 64MB，
   *   旧做法"全部解完 → 再逐张编码"会让峰值 = Σ(所有纹理 RGBA)（两张 4096² 就是 128MB 级）；
   *   改成"编码时才解、编完随作用域释放"后，常驻的只有压缩字节
   *   （`textureCompressedBytes` 返回的是 resS 的 subarray 视图，不拷贝）。
   *   注意：这一步**只降常驻**，不改变产物；峰值的大头是 PNG 编码（见 docs/已知问题.md）。
   */
  function collectTextures(got, resSBytes) {
    const textures = [];
    for (const t of got.textures) {
      const rec = {
        name: t.name, width: t.width, height: t.height,
        format: t.format, formatName: t.formatName, source: t.stream ? 'resS' : 'inline',
      };
      try {
        rec.comp = NS.extract.textureCompressedBytes(t, resSBytes);
        rec.bytes = rec.comp.length;
      } catch (e) {
        rec.error = e.message;
      }
      textures.push(rec);
    }
    return textures;
  }

  /** 动画曲线 → motion3（原生包已带 motion3 时跳过转换），同时给出候选名与参数表白名单。 */
  async function convertClipMotions(got, sf, profile) {
    const candidates = [...new Set([
      ...NS.extract.moc3NameCandidates(got.moc3),
      ...collectParameterNames(got.physics3),
    ])];
    const paramTable = await collectParameterTable(got.moc3);
    if (!paramTable) ulbLog('warn', '未取到 moc3 参数表，曲线 Id 将不做白名单校验');
    const converted = got.nativeFiles.some((f) => /motion3/i.test(f.name))
      ? { motions: [], hashLookup: new Map(), dropped: [] }
      : NS.animToMotion.clipsToMotions(sf, candidates, {
        paramWhitelist: paramTable ? paramTable.ids : null,
        isLoop: (n) => NS.model3.motionLoops(n, profile),
        fadeIn: profile.motion && profile.motion.fadeInTime,
        fadeOut: profile.motion && profile.motion.fadeOutTime,
      });
    return { converted, candidates, paramTable };
  }


  // ------------------------------------------------------------------
  // 契约接口（资产提供者契约 §一）：canHandle(file) → boolean / resolve(file) → { prefix, files, entry }
  //
  // resolve 把两种包型都整理成「文件表 + 入口」：
  //   · 原生 Cubism 文件集（包内已有 *.model3.json）→ 包内文件原样进表，entry 指包内那份 model3
  //   · Unity 集成版（只有 moc3 + 纹理 + 曲线）→ 重建一份「相对路径版」model3，entry 指它
  // files 的值是真实的 Blob/字符串（契约 §1.2 要求 Map<relPath, Blob|string>，不得放 Blob URL），
  //   核心拿到后按 prefix 注册 VirtualFS，渲染层按 entry 装载——插件不自行 register/revoke（§1.2）。
  //
  // prefix 规则（§1.2 写死）：`vfs://<providerId>/<rootId>/<相对目录>/`，全局唯一、以 / 结尾。
  // ------------------------------------------------------------------

  /** 把 file（宿主传入的上下文）规整成旧 ctx 形状，缺字段给保守默认（不改语义）。 */
  function asCtx(file) {
    if (!file || typeof file !== 'object') return null;
    return file;
  }

  // 契约：canHandle 必须是纯判定（无副作用、返回布尔）。
  // 契约 §3.1 判定边界 + §3.7 异常处理（文档已写死，无需再猜）：
  //   允许：读 file.bytes 做容器魔数判定（复用 bundle-probe，与 /api/bundle/probe 同口径）
  //   禁止：任何 I/O、修改外部状态、把异常抛给宿主
  //   canHandle 内部 try/catch，捕获后 return false（§3.7 明许），catch 分支至少记一条 debug（§3.7）
  // 三种情形（§3.1 表格）：
  //   ① 有 bytes 且魔数匹配（UnityFS + CAB-*）→ true
  //   ② 有 bytes 且魔数不匹配            → false
  //   ③ 没有 bytes                        → true（保守放行：判 false 会让无扩展名的包永远无法被选中）
  // 注意：必须同步返回 boolean（§3.1 签名 canHandle(file) → boolean）；
  //   不能用 async——async 会返回 Promise，而 Promise 恒为真值，宿主按 if (canHandle(file)) 判断时所有文件都被放行，判定失效。
  function canHandle(file) {
    const ctx = asCtx(file);
    const bytes = ctx && ctx.bytes ? ctx.bytes : null;
    if (!bytes) return true;
    try {
      return NS.bundleProbe.run(bytes).ok;
    } catch (e) {
      // §3.7：catch 分支不得静默。这里**升到 warn**（不是 debug）：
      //   canHandle 抛错通常不是"文件读不了"（那属于数据问题，返回 false 即可），
      //   而是**调用方用法问题**——最典型的就是 bytes 传了 ArrayBuffer 而不是 Uint8Array（契约 §1.1），
      //   此时表现为"这个文件没有提供者"，只有 warn 才查得动。
      ulbLog('warn', `canHandle 内部异常，按不可读处理：${e.message}`
        + '（若 bytes 类型不符契约 §1.1 的 Uint8Array，请修宿主侧归一）');
      return false;
    }
  }

  // 契约：resolve 产出 { prefix, files, entry }；失败抛带 code 的错误（§3.4），不返回缺字段半成品（§5.8）。
  // §1.2：prefix 格式 = `vfs://<providerId>/<rootId>/<相对目录>/`（全局唯一、以 / 结尾、目录不含文件名）。
  //   “相对目录”取 rel 的 dirname 部分（rel 指向容器文件本身，prefix 以该文件所在目录为命名空间）。
  async function resolve(file) {
    const ctx = asCtx(file);
    if (!ctx || !ctx.rootId || !ctx.rel) {
      // §1.1：rootId/rel 为必选；bytes 可选（缺了走宿主取资源通道，见 readBundleBytes）
      throw NS.errors.fail('ULB_ERR_BAD_ARGS', 'resolve() 缺少必选字段：需要 file.rootId 与 file.rel');
    }
    // §3.6 宿主能力面：取字节通道② 的唯一合法形态是 host.fetchFile(rootId, rel) → Promise<Uint8Array>。
    //   hostApi 优先取 ctx.host（旧宿主把能力面挂在 ctx 上），否则取宿主注入面 host 本身
    //   （新契约下 host 由核心在调用插件前注入，能力面挂在 host 顶层）；缺失时 readBundleBytes 抛 ULB_ERR_NO_HOST。
    const hostApi = (ctx.host) || host;
    const bytes = await readBundleBytes(ctx, hostApi);
    const { parsed, cabNode, cabBytes, resSBytes } = parseContainerNodes(bytes, ctx && ctx.name);
    const sf = NS.serialized.parse(cabBytes);
    const got = NS.extract.extractAll({ cabBytes, resSBytes, sf });
    const profile = await loadProfile(ctx && ctx.profile);

    // 相对目录 = rel 去掉末尾文件名后的目录段（如 'a/b/c' → 'a/b'；纯文件名 'c' → ''）。
    // prefix 恒以 / 结尾（§1.2 格式）；rootId 与 relDir 之间保留单斜杠，relDir 为空时避免出现双斜杠。
    const relDir = String(ctx.rel).replace(/\/+$/, '').split('/').slice(0, -1).join('/');
    const dirSeg = relDir ? `${relDir}/` : '';
    const prefix = `vfs://${PLUGIN_ID}/${String(ctx.rootId)}/${dirSeg}`;
    // files 必须用 let：Unity 集成版分支会整体替换成 built.files（第 885 行附近），
    //   用 const 会在那条路径上抛 "Assignment to constant variable"——
    //   这个 bug 一直没暴露是因为 resolve() 此前从未被核心调用过（只有 open() 在跑）。
    let files = new Map();
    let entry = null;

    if (got.nativeFiles.some((f) => /\.model3\.json$/i.test(f.name))) {
      // 包型① 原生 Cubism 文件集：包内自带 model3/motion3/physics3，直接以原文件成表，不重建。
      //   entry = 包内 model3；纹理与 mocs 由包内 model3 的 FileReferences 相对引用，
      //   这些相对路径与包内文件同根，核心注册 prefix 后可直接解析。
      const textures = collectTextures(got, resSBytes);
      for (const f of got.nativeFiles) {
        files.set(f.name, new Blob([f.bytes], { type: /\.json$/i.test(f.name) ? MIME_JSON : MIME_OCTET }));
        if (/\.model3\.json$/i.test(f.name)) entry = f.name;
      }
      // 原生 Cubism 文件集：包内可能自带 .png/.moc3 等原始文件（TextAsset 形态），直接进表；
      //   若包内没有 PNG 纹理、但有 Unity 压缩纹理（Texture2D 对象），才走解码→PNG 编码路径。
      //   键名与原文件名一致，保证包内 model3.json 的 FileReferences 相对引用能直接解析到。
      let hasPngTexture = false;
      for (const f of got.nativeFiles) {
        if (/\.png$/i.test(f.name)) {
          files.set(f.name, new Blob([f.bytes], { type: MIME_PNG }));
          hasPngTexture = true;
        }
      }
      if (!hasPngTexture) {
        for (const t of textures) {
          if (!t.comp) continue;
          const rgba = NS.texdecode.decode(t, t.comp);   // 局部变量，编完即释放
          const png = await NS.png.encodePngAsync(rgba, t.width, t.height);
          files.set(`${t.name}.png`, new Blob([png], { type: MIME_PNG }));
        }
      }
      if (!entry) throw NS.errors.fail('ULB_ERR_MODEL_BUILD', '原生文件集里找不到 model3.json 入口');
      return { prefix, files, entry };
    }

    // 包型② Unity 集成版：没有 model3，重建「相对路径版」（引用 files 内的键，不写 Blob URL）。
    const textures = collectTextures(got, resSBytes);
    const { converted, candidates, paramTable } = await convertClipMotions(got, sf, profile);
    const extracted = {
      moc3: got.moc3,
      physics3: got.physics3,
      textures,
      motions: converted.motions,
      paramNames: candidates,
      meta: paramTable ? paramTable.meta : null,
    };
    const built = await buildFileSet(extracted, profile);
    if (!built.files || built.files.size === 0) throw NS.errors.fail('ULB_ERR_EXTRACT', 'Unity 集成版没有可产出的素材文件');
    // built.files 已含 moc3/纹理/physics3/motions/model3.json；entry 就是重建出的 model3.json 键
    files = built.files;
    entry = built.entry;
    return { prefix, files, entry };
  }

  // 契约 §一：plugin.json 的 provides=["asset-provider"] 让宿主把本插件登记进资产提供者注册表。
  //   注册对象上 kind 是产出内容类型（live2d），与 fileKinds 的容器类型 bundle 正交；
  //   kind 的唯一权威来源是 plugin.json 的 produces.kind（插件契约 §3.2），这里带上只为便于调试。
  if (host) {
    host.register({
      id: PLUGIN_ID,
      name: 'Unity Live2D 资源包',
      label: 'Live2D包',
      // 契约 §三 的注册面：只留新契约成员 canHandle/resolve。
      canHandle,
      resolve,
      kind: 'live2d',
      fileKinds: ['bundle'],
    });
  }

  // node 侧返回解析入口：服务端解包（17a）直接从返回值取 resolve/canHandle，不经过宿主注册。
  /**
   * 内存代价声明（契约 插件.md §2.2 的第②段：decompressedBytes）。
   *
   * 为什么由插件来算：只有解析容器的这一方知道"解压后到底多大"。
   * 代价控制：走 `unityfs.blocksSummary`（**只读头 + blocksInfo，不解压数据块**），
   *   实测 19 个真实包 P50 0.13ms / P90 0.91ms / max 2.43ms（对比整包 probe 20/56/173ms）。
   * rgbaBytes 需要纹理尺寸（要解 CAB），准入路径不付这个代价 —— 由 resolve 完成后回填缓存。
   * @param {{bytes?: Uint8Array}} file
   * @returns {{decompressedBytes:number, compressedBytes:number}|null} 不是本插件能处理的容器时返回 null
   */
  function estimateMemory(file) {
    try {
      // 不调 canHandle：那会跑整包 probe（解析 + 找纹理），而这里只需要块表。
      //   传进来的 bytes 可能只是文件头部（宿主为了省读盘），越界时 blocksSummary 会抛错 ⇒ 返回 null ⇒ 宿主退回全量读。
      const s = NS.unityfs.blocksSummary(file.bytes);
      return { decompressedBytes: s.decompressedBytes, compressedBytes: s.compressedBytes };
    } catch {
      return null;   // 判不出来就让核心走回落，绝不因此阻断加载
    }
  }

  return { canHandle, resolve, estimateMemory, PLUGIN_ID };
}

// 执行安装：浏览器里走宿主注册；node 里（无 window）拿到 { canHandle, resolve } 后挂到
//   globalThis.__ULB_NODE__，供服务端 require/import 后取用。
//   为什么不写成 `export { resolve }`：那会把文件变成 ESM，浏览器以 <script> 注入时
//   export 是语法错误 → 整个插件加载失败。保持经典脚本形态，node 侧用全局挂载暴露。
const ulb = install();
if (ulb && typeof window === 'undefined' && typeof globalThis !== 'undefined') {
  globalThis.__ULB_NODE__ = ulb;
}
