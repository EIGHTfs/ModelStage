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
// 与游戏无关：所有解析走 lib/ 的通用实现；游戏差异（命名约定等）从 profiles/<profile>.json 读，
//   由资源根配置里的 profile 字段指定（本仓库测试根指向 azurlane）。
//
// 对外契约（宿主 plugin-host.js）：
//   register({ id, name, label, fileKinds, probe, open })
//     label     —— 角色库里变体标签用的文字（宿主按类型决定配色，插件不自创配色）
//     probe(ctx) —— 返回 0..1 置信度；宿主用它判断"这个文件该不该给本插件读"
//     open(ctx)  —— 真正读取；ctx = { rootId, rel, name, size, profile, host }
// ============================================================================

'use strict';

// 脚本顶层用「带标签的块 + break」代替 IIFE 里的 return：
//   插件文件是以 <script> 形式注入的，裸块内 return 属非法语法（IIFE 展开后必须改写早退路径）。
ulbInstall: {
  const host = window.SpineViewerPlugins;
  if (!host) {
    console.warn('[unity-live2d-bundle] SpineViewerPlugins 未就绪（plugin-host.js 未加载？），插件未注册');
    break ulbInstall;
  }
  const NS = window.__ULB__;
  if (!NS || !NS.unityfs || !NS.serialized || !NS.extract) {
    console.warn('[unity-live2d-bundle] lib 未加载完整（需要 bytes/common-strings/unityfs/serialized/typetree/extract），插件未注册');
    break ulbInstall;
  }

  const PLUGIN_ID = 'unity-live2d-bundle';
  const profileCache = new Map();

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
    let data = {};
    try {
      const r = await fetchWithTimeout(`/plugins/${PLUGIN_ID}/profiles/${encodeURIComponent(name)}.json`, { cache: 'no-store' }, FETCH_TIMEOUT_MS);
      if (r.ok) data = await r.json();
      else console.info(`[${PLUGIN_ID}] 没有 profile「${name}」，按通用规则处理`);
    } catch (e) {
      console.warn(`[${PLUGIN_ID}] 读取 profile「${name}」失败：${e.message}`);
    }
    profileCache.set(name, data);
    return data;
  }

  /** 容器魔数判定（只读前 8 字节即可） */
  function looksLikeUnityFs(bytes) {
    if (!bytes || bytes.length < 8) return false;
    return NS.bytes.latin1(bytes, 0, 7) === 'UnityFS' && bytes[7] === 0;
  }

  /**
   * 置信度：容器签名 +（可选）包内是否有 moc3。
   * 只按"能不能读"打分，不按游戏名判断。
   */
  async function probe(ctx) {
    try {
      const bytes = ctx && ctx.bytes ? ctx.bytes : null;
      // 没给字节时只能按名字/尺寸给个保守值（宿主一般会先给字节）
      if (!bytes) return 0.5;
      // 解析步骤全部委托给 lib/bundle-probe.js —— 与服务端 /api/bundle/probe 共用同一份实现，
      //   避免"预检说能装、装载却失败"这种两份真相造成的漂移
      const r = NS.bundleProbe.run(bytes);
      if (!r.ok) {
        // 有容器但没有 CAB-*（不是资产包）原来给 0.5，保持语义不变；其余不可读一律 0
        return r.code === NS.errors.CODES.NO_CAB ? 0.5 : 0;
      }
      return r.moc3 ? 1 : 0.6;
    } catch (e) {
      console.info(`[${PLUGIN_ID}] probe 失败（按不可读处理）：${e.message}`);
      return 0;
    }
  }

  /**
   * 给页面加载器装两个适配（幂等，只在首次生效）：
   *
   * ① `ModelSettings.resolveURL` 的**绝对 URL 直通**。
   *   页面加载器会把 model3.json 里的每个资源路径都按「相对 model3.json 的 URL」解析
   *   （ModelSettings.resolveURL → url.resolve(base, path)）。本插件给的是内存态的绝对 URL，
   *   经它解析后会被拼坏：实测 `blob:http://127.0.0.1:8803/<uuid>` 变成 `blob:http//127.0.0.1:8803/<uuid>`
   *   （少了冒号），于是贴图/骨架全部取不到（报 "Texture loading error" / XHR status 0）。
   *   这里对**已带协议的 URL**（blob:/data:/http(s):/、以及以 / 开头的站内绝对路径）直接原样返回；
   *   相对路径仍走框架原有解析 —— 对普通资源根模型没有任何行为变化。
   *
   * ② `Live2DLoader.middlewares` 的前置中间件：URL 是 blob:/data: 时自己 fetch，
   *   不让框架的 XHR 去解析（与 ① 互补：① 管"路径不被改坏"，② 管"取回来"）。
   *
   * 两件事都只涉及"资产怎么取"，不涉及渲染与交互（渲染仍走原版舞台与公共管线）。
   */
  function installRuntimeAdapters() {
    const PIXI = window.PIXI;
    const l2d = PIXI && PIXI.live2d;
    if (!l2d) return false;
    let done = true;

    for (const cls of [l2d.ModelSettings, l2d.Cubism4ModelSettings, l2d.Cubism2ModelSettings]) {
      if (!cls || !cls.prototype || cls.prototype.__absUrlPassthrough) continue;
      const proto = cls.prototype;
      const orig = proto.resolveURL;
      if (typeof orig !== 'function') continue;
      proto.__absUrlPassthrough = true;
      proto.resolveURL = function (path) {
        if (typeof path === 'string' && /^(blob:|data:|https?:|\/)/i.test(path)) return path;
        return orig.call(this, path);
      };
    }
    if (!l2d.ModelSettings || !l2d.ModelSettings.prototype.__absUrlPassthrough) done = false;

    const loader = l2d.Live2DLoader;
    if (loader && Array.isArray(loader.middlewares)) {
      if (!loader.__blobMiddlewareInstalled) {
        loader.__blobMiddlewareInstalled = true;
        loader.middlewares.unshift(async (context, next) => {
          const u = context && typeof context.url === 'string' ? context.url : '';
          if (!/^(blob:|data:)/i.test(u)) return next();
          const r = await fetchWithTimeout(u, undefined, FETCH_TIMEOUT_MS);
          if (!r.ok) throw NS.errors.fail('ULB_ERR_IO', `读取内存资源失败 HTTP ${r.status}: ${u.slice(0, 32)}…`);
          if (context.type === 'json') context.result = await r.json();
          else if (context.type === 'text') context.result = await r.text();
          else context.result = await r.arrayBuffer();
          return context.result;
        });
      }
    } else {
      done = false;
    }
    return done;
  }

  /**
   * 后台盯着页面加载器（PIXI.live2d.Live2DLoader）出现就装上 blob 中间件。
   *
   * 为什么是后台轮询而不是 await：Live2D 运行时由舞台**首次 show() 时懒加载**——
   *   插件在 show() 之前若一直等加载器，就会与"先装上中间件再 show"互相等待而死锁（实测踩过）。
   *   轮询每 50 ms 检查一次；舞台把运行时脚本加载完到真正取模型资产之间还有足够时间，中间件必然先就位。
   *   上限 60 秒，超时停止并留一条日志（不无限占着定时器）。
   */
  let blobLoaderTimer = null;
  let loaderReady = null;        // 共享就绪 Promise：后台轮询装好后 resolve，舞台的 prepare() 直接等它
  function startBlobLoaderWatch(timeoutMs) {
    if (loaderReady) return loaderReady;
    const limit = timeoutMs || 60000;
    if (installRuntimeAdapters()) {
      loaderReady = Promise.resolve(true);
      return loaderReady;
    }
    const t0 = Date.now();
    loaderReady = new Promise((resolve) => {
      blobLoaderTimer = setInterval(() => {
        if (installRuntimeAdapters()) {
          clearInterval(blobLoaderTimer);
          blobLoaderTimer = null;
          resolve(true);
        } else if (Date.now() - t0 > limit) {
          clearInterval(blobLoaderTimer);
          blobLoaderTimer = null;
          console.warn(`[${PLUGIN_ID}] 等页面加载器超时（${limit} ms），本次按"未装适配"继续`);
          // 超时不是终态：必须把共享 Promise 清空，下一次装载重新起轮询。
          //   否则这个已 resolve 的 false 会被 startBlobLoaderWatch 首行的 `if (loaderReady) return` 命中，
          //   导致本页会话此后**永久**按"未装适配"装载（实测：页面停留超过超时时间后首次装载必然失败）。
          loaderReady = null;
          resolve(false);
        }
      }, 50);
    });
    return loaderReady;
  }

  /**
   * 等运行时加载器就绪并装上 blob 中间件（由舞台在装载前 await）。
   *
   * 为什么可以在这里等而不会死锁：舞台的 loadAndMountModel 已经先执行过 ensureLibs()，
   *   运行时脚本（含加载器）已经在加载/就绪路上，只是 PIXI.live2d 可能还在初始化。
   *   所以这里是**有限等待**（默认 15 秒），到点返回 false 并留日志，不无限等。
   */
  /**
   * 舞台在装载前 await 的钩子：等「blob: 直通」适配装好。
   *
   * 这里**不自己轮询**，而是等 `startBlobLoaderWatch` 建立的那份共享 Promise —— 它在 open() 时就已启动，
   *   运行时一出现就装好并 resolve。原先各自轮询 15 秒会误报「等页面加载器超时」（实测出现过），
   *   因为页面加载器常常是在框架初始化（cubism4Ready）之后才挂上 PIXI.live2d 的。
   */
  async function prepareLoader() {
    const p = loaderReady || startBlobLoaderWatch(60000);
    const ok = await p;
    if (!ok) console.warn(`[${PLUGIN_ID}] 页面加载器适配未装好，内存资源可能取不到`);
    return ok;
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
      console.warn(`[${PLUGIN_ID}] 读取 moc3 参数表失败：${e.message}`);
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
   * 把抽取出来的素材拼成一个**可渲染的 Live2D 模型**：moc3 / 纹理 PNG / physics3 / motion3 全部转成
   * Blob URL 写进重建的 model3.json，再把 model3.json 也转成 Blob URL。
   *
   * 为什么用 Blob URL 拼绝对路径：页面上的模型加载器（pixi-live2d-display）是按 model3.json 的
   *   所在 URL 解析相对路径的；内存里的资源没有目录，故把每个资源的绝对 URL 直接写进 model3.json。
   *
   * 产出的形状与现有 Live2D 模型一致（id/name/kind/cubism/modelUrl/motions/expressions/textureFiles），
   *   因此可以直接交给现有舞台 show()，复用原版右栏动作区与公共事件层——不新增渲染或事件代码。
   */
  async function buildRenderableModel(extracted, ctx, profile) {
    const urls = [];
    const blobUrl = (bytes, mime) => {
      const u = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
      urls.push(u);
      return u;
    };

    const mocUrl = blobUrl(extracted.moc3, 'application/octet-stream');
    // 纹理：逐张压缩编码（不并发），编完立刻释放 RGBA 缓冲 —— 峰值内存比"两张 67MB 级 PNG 同时生成"低得多。
    const textureUrls = [];
    for (const t of extracted.textures) {
      if (!t.rgba) continue;
      const png = await NS.png.encodePngAsync(t.rgba, t.width, t.height);
      t.pngBytes = png.length;
      textureUrls.push(blobUrl(png, 'image/png'));
      t.rgba = null;   // 释放 4096²×4 ≈ 64MB 级缓冲（模型不再需要它）
    }
    const physicsUrl = extracted.physics3 ? blobUrl(extracted.physics3, 'application/json') : null;

    // 动作：每个 motion3.json 一个 Blob URL，并按 profile 规则分组（组内顺序 = 名字序，稳定可复现）
    const motionDefs = [];
    for (const m of extracted.motions) {
      const json = m.json;
      const url = blobUrl(new TextEncoder().encode(JSON.stringify(json)), 'application/json');
      motionDefs.push({ name: m.name, url, group: NS.model3.motionGroupOf(m.name, profile), loop: !!json.Meta.Loop, meta: json.Meta });
    }
    motionDefs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const paramNames = extracted.paramNames || [];
    const model3 = NS.model3.buildModel3({
      mocUrl,
      textureUrls,
      physicsUrl,
      motions: motionDefs,
      paramNames,
      profile,
    });
    const model3Url = blobUrl(new TextEncoder().encode(JSON.stringify(model3)), 'application/json');

    // 舞台需要 motions 形状：{ 组: [{ name }] }（它按 (组, 下标) 播放，故顺序必须与 model3 一致）
    const motions = {};
    for (const d of motionDefs) {
      if (!motions[d.group]) motions[d.group] = [];
      motions[d.group].push({ name: d.name, file: d.url, loop: d.loop, duration: d.meta.Duration });
    }

    const id = `bundle:${ctx.rootId}:${ctx.rel}`;
    return {
      model: {
        id,
        name: ctx.name,
        kind: 'live2d',
        cubism: 4,
        modelUrl: model3Url,
        motions,
        expressions: [],
        textureFiles: textureUrls,
        bundleProfile: profile.id || null,
        bundleSource: { rootId: ctx.rootId, rel: ctx.rel, size: ctx.size },
        // 能力层元数据：画布尺寸与 rest pose 包围盒（口径见 collectCoreModelMeta 注释）
        designSize: (extracted.meta && extracted.meta.designSize) || null,
        bbox: (extracted.meta && extracted.meta.bbox) || null,
        meta: extracted.meta || null,
        // 装载前把内存资源通道准备好：舞台会在取模型资产之前 await 它（见 live2d-stage.js）。
        prepare: () => prepareLoader(),
        // 释放本模型占用的内存资源（Blob URL）。舞台在切换到下一个模型时调用，
        //   避免每次 open() 都把几十 MB 的贴图/骨架 Blob 留在页面里（实测连开十余次会拖死页面）。
        revoke: () => {
          for (const u of urls) { try { URL.revokeObjectURL(u); } catch { /* 忽略 */ } }
          urls.length = 0;
        },
      },
      model3,
      motionDefs,
      urls,
    };
  }

  /** 取资源包字节：调用方可直接给 bytes，否则按 rootId/rel 走宿主取文件。 */
  async function readBundleBytes(ctx, hostApi) {
    const given = ctx && ctx.bytes;
    if (given) return given;
    if (!ctx || !ctx.rootId || !ctx.rel) throw NS.errors.fail('ULB_ERR_BAD_ARGS', '缺少 rootId/rel，无法读取资源包');
    const got = await hostApi.fetchFile(ctx.rootId, ctx.rel);
    return new Uint8Array(got.bytes);
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

  /** 逐张纹理解码；单张失败只记录 error，不整体失败（报告里能看出是哪张坏）。 */
  function decodeTextures(got, resSBytes) {
    const textures = [];
    for (const t of got.textures) {
      const rec = {
        name: t.name, width: t.width, height: t.height,
        format: t.format, formatName: t.formatName, source: t.stream ? 'resS' : 'inline',
      };
      try {
        const comp = NS.extract.textureCompressedBytes(t, resSBytes);
        rec.rgba = NS.texdecode.decode(t, comp);
        rec.bytes = comp.length;
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
    if (!paramTable) console.warn(`[${PLUGIN_ID}] 未取到 moc3 参数表，曲线 Id 将不做白名单校验`);
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

  /** 每个动作一行的元数据摘要。 */
  function summarizeMotions(converted, profile) {
    return converted.motions.map((m) => ({
      name: m.name,
      duration: m.json.Meta.Duration,
      loop: m.json.Meta.Loop,
      curves: m.json.Meta.CurveCount,
      points: m.json.Meta.TotalPointCount,
      segments: m.json.Meta.TotalSegmentCount,
      group: NS.model3.motionGroupOf(m.name, profile),
      skippedUnknownBinding: m.stats.skippedUnknownBinding,
      skippedNotParameter: m.stats.skippedNotParameter,
    }));
  }

  /**
   * 曲线统计（统一口径：分母 = 全部绑定条数，含被丢弃动作里的绑定）。
   *   未知名哈希与"不在参数表里"分别计数并各给样例；被丢弃的空动作也计入各自的绑定数。
   *   另给"跳过量最多的前 5 个动作"，用于反证 moc3 与 AnimationClip 是否同源。
   */
  function summarizeCurves(converted, paramTable) {
    const allStats = [...converted.motions, ...(converted.dropped || [])].map((m) => m.stats);
    const curvesTotal = allStats.reduce((n, s) => n + s.curvesTotal, 0);
    const skipByMotion = allStats
      .map((s) => ({ name: s.name, skipped: s.skippedUnknownBinding + s.skippedNotParameter, total: s.curvesTotal }))
      .filter((x) => x.skipped > 0)
      .sort((a, b) => b.skipped - a.skipped);
    return {
      total: curvesTotal,
      emitted: allStats.reduce((n, s) => n + s.emitted, 0),
      skippedUnknownBinding: allStats.reduce((n, s) => n + s.skippedUnknownBinding, 0),
      skippedNotParameter: allStats.reduce((n, s) => n + s.skippedNotParameter, 0),
      skippedEmpty: allStats.reduce((n, s) => n + s.skippedEmpty, 0),
      expandedSinglePoint: allStats.reduce((n, s) => n + (s.expandedSinglePoint || 0), 0),
      invalidSegments: allStats.reduce((n, s) => n + s.invalidSegments, 0),
      unknownHashCount: new Set(allStats.flatMap((s) => s.unknownHashes || [])).size,
      notParameterIdCount: new Set(allStats.flatMap((s) => s.notParameterIds || [])).size,
      sampleUnknownHashes: [...new Set(allStats.flatMap((s) => s.unknownHashes || []))].slice(0, 6),
      sampleNotParameterIds: [...new Set(allStats.flatMap((s) => s.notParameterIds || []))].slice(0, 6),
      motionsTotal: allStats.length,
      motionsEmitted: converted.motions.length,
      motionsDroppedEmpty: (converted.dropped || []).length,
      droppedMotions: (converted.dropped || []).map((m) => `${m.name}(${m.stats.curvesTotal} 绑定全被跳过)`),
      skipByMotion: skipByMotion.slice(0, 5).map((x) => `${x.name} ${x.skipped}/${x.total}`),
      skipTop5Share: skipByMotion.length
        ? +(skipByMotion.slice(0, 5).reduce((n, x) => n + x.skipped, 0) * 100 / Math.max(1, skipByMotion.reduce((n, x) => n + x.skipped, 0))).toFixed(1)
        : 0,
      whitelistApplied: !!paramTable,
      whitelistCount: paramTable ? paramTable.count : 0,
    };
  }

  /** 组装素材报告（只放数字摘要，不挂原始字节：整包几十 MB，挂上去会把页面内存吃光）。 */
  function buildBundleReport(d) {
    return {
      kind: 'live2d-bundle',
      container: {
        signature: d.parsed.signature,
        version: d.parsed.version,
        engine: d.parsed.engineVersion,
        player: d.parsed.playerVersion,
        nodes: d.parsed.nodes.map((n) => ({ path: n.path, size: n.size, offset: n.offset })),
        dataStart: d.parsed.dataStart,
        bytes: d.bytesLength,
      },
      serialized: {
        version: d.sf.version,
        unityVersion: d.sf.unityVersion,
        types: d.sf.types.length,
        objects: d.sf.objects.length,
        classStats: NS.serialized.typeStats(d.sf),
      },
      moc3: d.got.moc3 ? { bytes: d.got.moc3.length, magicOffset: d.got.moc3MagicOffset, pathID: d.got.moc3Object.pathID } : null,
      physics3: d.got.physics3 ? { bytes: d.got.physics3.length } : null,
      nativeFiles: d.got.nativeFiles.map((f) => ({ name: f.name, bytes: f.bytes ? f.bytes.length : 0 })),
      textures: d.textures,
      containerPaths: d.got.containerPaths,
      profile: d.profile.id || (d.ctx && d.ctx.profile) || null,
      motions: d.motionsSummary,
      curveStats: d.curveStats,
      paramTable: d.paramTable ? { count: d.paramTable.count, partCount: d.paramTable.partCount, hasTypes: !!d.paramTable.types } : null,
      // 能力层元数据：designSize（moc3 CanvasInfo）/ bbox（rest pose 顶点包围盒）/ 结构计数
      modelMeta: d.meta || null,
      motionGroups: Object.keys(d.built.model.motions),
      model3: d.built.model3,
      model: d.built.model,
      raw: {
        moc3Bytes: d.got.moc3 ? d.got.moc3.length : 0,
        physics3Bytes: d.got.physics3 ? d.got.physics3.length : 0,
        serializedVersion: d.sf.version,
        objects: d.sf.objects.length,
      },
      urls: d.built.urls.length,
    };
  }

  /**
   * 读取资源包：容器 → 对象表 → 抽取（moc3 / physics3 / 纹理 / 原生 Cubism 文件）→ 动画曲线转 motion3
   *   → 拼可渲染模型（Blob URL）。
   * @returns {Promise<object>} 素材报告 + 可交给 Live2D 舞台的 model
   */
  async function open(ctx) {
    const hostApi = (ctx && ctx.host) || host.host;
    const bytes = await readBundleBytes(ctx, hostApi);
    const { parsed, cabNode, cabBytes, resSBytes } = parseContainerNodes(bytes, ctx && ctx.name);
    const sf = NS.serialized.parse(cabBytes);
    const got = NS.extract.extractAll({ cabBytes, resSBytes, sf });
    const profile = await loadProfile(ctx && ctx.profile);
    const textures = decodeTextures(got, resSBytes);
    const { converted, candidates, paramTable } = await convertClipMotions(got, sf, profile);
    const motionsSummary = summarizeMotions(converted, profile);
    const curveStats = summarizeCurves(converted, paramTable);

    // 拼可渲染模型：moc3 / 纹理 / physics3 / motion3 全转 Blob URL，写进重建的 model3.json。
    //   任一素材缺失/解码失败会让 buildRenderableModel 抛可读错误（宁可明确失败，也不产出坏模型）。
    const extracted = {
      moc3: got.moc3,
      physics3: got.physics3,
      textures,
      motions: converted.motions,
      paramNames: candidates,
      // 能力层元数据（designSize / bbox / 计数）：由 Core 在同一趟解析里产出，前端直接用
      meta: paramTable ? paramTable.meta : null,
    };
    installRuntimeAdapters();       // 已加载运行时的情况：立即装
    startBlobLoaderWatch(60000);    // 未加载时：后台盯着，运行时一出现就装
    const built = await buildRenderableModel(extracted, ctx, profile);   // 内含 await（PNG 压缩编码）

    const report = buildBundleReport({
      parsed, sf, got, textures, profile, paramTable,
      motionsSummary, curveStats, built,
      bytesLength: bytes.length, ctx,
      meta: extracted.meta,
    });


    // 自检摘要：把"读到了什么"打进控制台，便于无人值守验证（不需要截图）
    console.info(`[${PLUGIN_ID}] 已解析 ${(ctx && ctx.name) || cabNode.path}`
      + `：容器 v${parsed.version}/${parsed.engineVersion}，节点 ${parsed.nodes.length}，`
      + `对象 ${sf.objects.length}，moc3 ${report.moc3 ? report.moc3.bytes : 0} B，`
      + `physics3 ${report.physics3 ? report.physics3.bytes : 0} B，`
      + `纹理 ${textures.map((t) => `${t.name}(${t.width}x${t.height}${t.error ? ' 解码失败' : ''})`).join('/') || '无'}，`
      + `动作 ${motionsSummary.length} 个/分组 ${report.motionGroups.join('+') || '无'}`
      + `（clips ${curveStats.motionsTotal}，空动作丢弃 ${curveStats.motionsDroppedEmpty}${curveStats.droppedMotions.length ? '：' + curveStats.droppedMotions.join('、') : ''}），`
      + `曲线 输出 ${curveStats.emitted}/${curveStats.total}`
      + `（未知名哈希 ${curveStats.skippedUnknownBinding}，不在参数表 ${curveStats.skippedNotParameter}，`
      + `单点补成两点 ${curveStats.expandedSinglePoint}，`
      + `参数表白名单 ${curveStats.whitelistApplied ? curveStats.whitelistCount + ' 个' : '未应用'}，`
      + `跳过集中度 前5动作占 ${curveStats.skipTop5Share}%，`
      + `越界结构 ${curveStats.invalidSegments}），`
      + `Blob URL ${built.urls.length} 个`);
    return report;
  }

  host.register({
    id: PLUGIN_ID,
    name: 'Unity Live2D 资源包',
    label: 'Live2D包',
    fileKinds: ['bundle'],
    probe,
    open,
  });
}
