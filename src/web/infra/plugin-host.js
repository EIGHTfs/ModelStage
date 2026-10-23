// infra/plugin-host.js —— 前端插件宿主（资产提供者 canHandle/resolve 的调用方）
//
// 为什么需要它：插件是**浏览器脚本**（plugins/<id>/index.js 顶层读 window.SpineViewerPlugins），
//   新前端之前完全没有宿主 —— 所以插件产出的资源（bundle 类）根本进不了渲染链路。
//   这个文件补的就是那一层：注入脚本 → 收集 provider → 提供取字节通道 → 供上层 findProvider/resolve。
//
// 与 legacy/patches/plugin-host.js 的关系：那份是旧页面（8803）的实现，这里是按同一形态重写的 ESM 版；
//   插件侧**零改动**（这是方案 B 的核心优点）。
//
// 契约依据：资产提供者契约 §一（canHandle/resolve 形状）、插件契约 §3.1（canHandle 纯判定）、
//   §3.6（取字节通道 = host.fetchFile(rootId, rel)）、§3.7（插件异常隔离）。
//
// 三条硬规则（都在下面落实）：
//   ① 失败隔离：任何一个插件脚本 404/抛错，都只记警告，不影响页面与其它插件
//   ② 只加载启用清单：/api/plugins 已按 config/plugins.json 过滤，被禁用的插件不会出现在清单里
//   ③ canHandle 由宿主调用、宿主兜异常：插件内部抛错一律当"不认这个文件"，不冒泡到调用方

import { getSharedVirtualFS } from './vfs.js';

/** 宿主提示通道：优先用注入的 log（项目调试日志），否则退回 console */
function makeLogger(log) {
  const push = (level, msg) => {
    try {
      if (typeof log === 'function') { log(level, msg); return; }
    } catch { /* 日志失败不影响主流程 */ }
    const line = `[plugin-host] ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    info: (m) => push('info', m),
    warn: (m) => push('warn', m),
    error: (m) => push('error', m),
  };
}

/**
 * 把各种"字节样"入参归一成 Uint8Array（契约 §1.1 要求的类型）。
 *
 * 为什么必须在宿主侧收口：插件 canHandle 内部对类型不符是 try/catch → 返回 false，
 *   调用方只会看到"这个文件没有提供者"，看不到"你传的类型不对"——
 *   典型的静默失败（实测：同一份 44MB bundle 传 ArrayBuffer 判不出，传 Uint8Array 命中）。
 *   所以 ArrayBuffer / 各种 TypedArray / DataView 都在这里转好，调用方不必记类型。
 * @param {any} value
 * @returns {Uint8Array|null} 无法识别返回 null
 */
function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** 类型名（错误提示用） */
function describeType(value) {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  const ctor = value.constructor && value.constructor.name;
  return ctor || Object.prototype.toString.call(value);
}

/** 注入一个 <script> 并等它结束（成功/失败都 resolve，不抛） */
function injectScript(src) {
  return new Promise((resolve) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = false;
    el.onload = () => resolve(true);
    el.onerror = () => resolve(false);
    document.head.appendChild(el);
  });
}

/**
 * 创建插件宿主。
 * @param {{log?: Function, baseUrl?: string}} [opts]
 * @returns {object} 宿主查询面（见文件末尾 return）
 */
export function createPluginHost(opts = {}) {
  const say = makeLogger(opts.log);
  const base = String(opts.baseUrl || '').replace(/\/$/, '');

  /** id → provider（插件 register 上来的对象） */
  const providers = new Map();
  /** id → 清单里声明的角色（provides）——插件自己 register 时不一定带，以清单为准 */
  const manifestProvides = new Map();
  /** id → { loaded, error, files, ms } 装载状态（排障用） */
  const loadState = new Map();
  /** /api/plugins 返回的清单快照 */
  let discovered = [];
  let loaded = false;
  /**
   * 进行中的 loadAll（并发去重）。
   * 为什么需要：启动预热与"用户一打开就点资源包"可能同时触发装载，
   *   两路各发一次 /api/plugins、各评估一遍插件，既浪费也会让提供者注册更晚。
   *   这里让后来者复用同一个 Promise：清单只取一次、插件只装载一次。
   */
  let loadingPromise = null;

  /**
   * 取资源根里的文件字节（契约 §3.6 的唯一取字节通道）。
   * @param {string} rootId 资源根 id
   * @param {string} rel 相对该根的路径（POSIX）
   * @returns {Promise<{bytes: ArrayBuffer, size: number, url: string}>}
   */
  async function fetchFile(rootId, rel) {
    const url = `${base}/api/file?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(rel)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`读文件失败 HTTP ${res.status}: ${rel}`);
    // 契约 §1.1：file.bytes 的类型是 **Uint8Array**（不是 ArrayBuffer）。
    //   宿主在这里就转好，调用方拿到的直接是插件期望的类型。
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, size: bytes.byteLength, url };
  }

  /** 插件侧可见的宿主面（插件脚本顶层会读 window.SpineViewerPlugins） */
  const hostApi = {
    version: 1,
    /** 插件注册自己：只收有 id 的对象；缺 canHandle/resolve 时保留但标注（供排障） */
    register(plugin) {
      if (!plugin || typeof plugin !== 'object') { say.warn('register 收到非对象，已忽略'); return false; }
      const id = String(plugin.id || '').trim();
      if (!id) { say.warn('register 缺少 id，已忽略'); return false; }
      // 契约 PL2：id 重复必须**拒绝**且不覆盖已注册的那个。
      //   静默 providers.set 覆盖会让"后加载的插件顶掉先加载的"，且排障时看不出发生过覆盖。
      //   保留先注册的实例（先到先得）：它可能已经参与过解析，换掉会留下"半新半旧"的对象。
      if (providers.has(id)) {
        say.warn(`插件 ${id} 重复注册，已忽略（保留先注册的实例）`);
        return false;
      }
      // 角色以**清单**为准（契约 插件契约 §二）：register 上来的对象不覆盖它
      const declared = manifestProvides.get(id) || [];
      const rec = { ...plugin, id, provides: declared.slice() };
      providers.set(id, rec);
      const st = loadState.get(id) || { files: 0, ms: 0 };
      loadState.set(id, { ...st, loaded: true, error: null });
      const caps = [];
      if (typeof rec.canHandle === 'function') caps.push('canHandle');
      if (typeof rec.resolve === 'function') caps.push('resolve');
      say.info(`已注册提供者 ${id}（${rec.name || id}）：${caps.join('/') || '无可调用成员'}`);
      try { window.dispatchEvent(new CustomEvent('spineviewer:plugin-registered', { detail: { id } })); } catch { /* 忽略 */ }
      return true;
    },
    fetchFile,
    /** 提示通道：插件不直接操作 DOM，走这里（同时派发事件给页面其它部分） */
    notify(kind, msg) {
      const level = kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'info';
      say[level](`[插件] ${msg}`);
      try { window.dispatchEvent(new CustomEvent('spineviewer:notify', { detail: { kind, msg } })); } catch { /* 忽略 */ }
    },
  };

  /** 按清单串行注入某插件的全部脚本（顺序即 plugin.json 的 files[] 顺序：lib/* 先、index.js 后） */
  async function loadPlugin(pl) {
    const id = String(pl && pl.id ? pl.id : '');
    if (!id) return;
    const t0 = Date.now();
    loadState.set(id, { loaded: false, error: null, files: 0, ms: 0 });
    const files = Array.isArray(pl.files) ? pl.files : [];
    let okCount = 0;
    for (const f of files) {
      const ok = await injectScript(`${base}/plugins/${f}`);
      if (ok) okCount += 1;
      else {
        const st = loadState.get(id);
        if (st && !st.error) st.error = `脚本加载失败: ${f}`;
      }
    }
    const st = loadState.get(id) || {};
    const error = st.error || (providers.has(id) ? null : '脚本已加载但没有调用 register()');
    loadState.set(id, { ...st, loaded: providers.has(id), error, files: okCount, ms: Date.now() - t0 });
    if (error) say.warn(`插件 ${id} 未生效：${error}（其余插件与页面不受影响）`);
  }

  // ---------------------------------------------------------------- 预筛与物化（resolve → VFS）
  //
  // 为什么要预筛：canHandle 必须看**完整容器字节**才能判定（它要解析 UnityFS 的 CAB 节点，
  //   实测只给前 64 字节时连真 bundle 都判 false），而单个包 44MB、单次判定 ~95ms。
  //   对目录里每个文件都这么来一遍是不可接受的，所以先按"根类型 + 后缀 + 大小"筛掉绝大多数，
  //   只对候选包读全量字节。
  //
  // **别把这层去掉**：直接对整目录跑 findProvider 会让一次扫描读几百 MB、卡住主线程。

  /** 普通模型资产的后缀：这些不可能是资源包，别为它们读全量 */
  const ORDINARY_ASSET_EXT = /\.(json|skel|atlas|png|jpe?g|webp|bmp|gif|moc3|motion3|physics3|cdi3|txt|md|bin)$/i;
  /** 单个包大小上限（防御性：超过就不读，避免把内存打爆） */
  const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

  /**
   * 预筛：返回 null 表示"可能是资源包，值得读全量"，否则返回跳过原因。
   * @param {{rootId?:string, rel?:string, name?:string, size?:number, rootKind?:string}} file
   */
  function prefilterReason(file) {
    if (!file || !file.rootId || !file.rel) return '缺少 rootId/rel';
    if (file.rootKind && file.rootKind !== 'bundle') return `资源根类型是 ${file.rootKind}，不是 bundle`;
    const name = String(file.name || file.rel);
    if (ORDINARY_ASSET_EXT.test(name)) return `后缀是普通模型资产（${name.split('.').pop()}），不可能是资源包`;
    if (typeof file.size === 'number' && file.size === 0) return '文件为空';
    if (typeof file.size === 'number' && file.size > MAX_BUNDLE_BYTES) return `文件过大（${file.size}B > 上限 ${MAX_BUNDLE_BYTES}B）`;
    return null;
  }

  /**
   * 校验 provider.resolve 的返回值（契约 §一 / §5.8：不得返回缺字段半成品）。
   * @returns {string|null} null = 合规，否则返回原因
   */
  function validateResolved(res) {
    if (!res || typeof res !== 'object') return '返回值不是对象';
    if (typeof res.prefix !== 'string' || !/^vfs:\/\/.+\/$/.test(res.prefix)) {
      return `prefix 不合契约 §1.2（应形如 vfs://<providerId>/<rootId>/<相对目录>/）：${res.prefix}`;
    }
    const files = res.files;
    const size = files instanceof Map ? files.size
      : (files && typeof files === 'object' ? Object.keys(files).length : 0);
    if (!size) return 'files 为空';
    if (typeof res.entry !== 'string' || !res.entry) return 'entry 缺失';
    const has = files instanceof Map
      ? files.has(res.entry)
      : Object.prototype.hasOwnProperty.call(files, res.entry);
    if (!has) return `entry 不在 files 里：${res.entry}`;
    return null;
  }

  /** 读全量字节（file.bytes 优先；没有就经 /api/file 取） */
  async function bytesOf(file) {
    const given = toUint8Array(file.bytes);
    if (given) return { ok: true, bytes: given };
    try {
      const got = await fetchFile(file.rootId, file.rel);
      return { ok: true, bytes: got.bytes };
    } catch (e) {
      return { ok: false, message: `读文件失败：${(e && e.message) || e}` };
    }
  }

  /** 找提供者并 resolve（含返回值契约校验） */
  async function resolveViaProvider(file, bytes) {
    const provider = findProvider({ ...file, bytes });
    if (!provider) {
      return {
        ok: false,
        reason: 'no-provider',
        message: `没有启用的提供者能处理 ${file.rel}`
          + '（检查 config/plugins.json 是否禁用了对应插件，或插件是否加载失败）',
      };
    }
    if (typeof provider.resolve !== 'function') {
      return { ok: false, reason: 'no-resolve', message: `提供者 ${provider.id} 没有 resolve()` };
    }
    let res = null;
    try {
      res = await provider.resolve({ ...file, bytes, host: hostApi });
    } catch (e) {
      return { ok: false, reason: 'resolve-failed', message: `提供者 ${provider.id} 解析失败：${(e && e.message) || e}` };
    }
    const bad = validateResolved(res);
    if (bad) return { ok: false, reason: 'bad-result', message: `提供者 ${provider.id} 返回不合契约：${bad}` };
    return { ok: true, provider: provider.id, res };
  }

  /** 注册进 VirtualFS；同前缀重复装载时先撤再注册（不泄漏旧 prefix） */
  function registerResolved(vfs, res) {
    try {
      vfs.register(res.prefix, res.files);
      return { ok: true, reRegistered: false };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (!/已注册/.test(msg)) return { ok: false, message: `注册进 VirtualFS 失败：${msg}` };
      try { vfs.revoke(res.prefix); } catch { /* 撤销失败也继续重试 */ }
      try {
        vfs.register(res.prefix, res.files);
        return { ok: true, reRegistered: true };
      } catch (e2) {
        return { ok: false, message: `重新注册失败：${(e2 && e2.message) || e2}` };
      }
    }
  }

  /**
   * 把一个资源包文件"物化"进 VirtualFS：预筛 → 读全量 → findProvider → resolve → register。
   * 本函数**不碰渲染**（接线是下一步），只保证"资源真的进了 VFS 且能解析出入口地址"。
   * @param {object} file { rootId, rel, name?, size?, rootKind?, bytes? }
   * @param {{vfs?: object}} [opts]
   * @returns {Promise<object>} { ok, reason?, message?, provider?, prefix?, entry?, entryUrl?, files? }
   */
  async function materialize(file, opts = {}) {
    const vfs = opts.vfs || getSharedVirtualFS();
    const skip = prefilterReason(file);
    if (skip) return { ok: false, reason: 'prefilter', message: `跳过：${skip}` };

    const read = await bytesOf(file);
    if (!read.ok) return { ok: false, reason: 'read-failed', message: read.message };

    const got = await resolveViaProvider(file, read.bytes);
    if (!got.ok) return got;

    const reg = registerResolved(vfs, got.res);
    if (!reg.ok) return { ok: false, reason: 'register-failed', message: reg.message };

    const entryUrl = vfs.resolve(got.res.prefix + String(got.res.entry).replace(/^\.?\//, ''));
    return {
      ok: true,
      provider: got.provider,
      prefix: got.res.prefix,
      entry: got.res.entry,
      entryUrl,
      files: got.res.files instanceof Map ? got.res.files.size : Object.keys(got.res.files).length,
      reRegistered: reg.reRegistered,
    };
  }

  /**
   * 读启用清单并逐个加载。**任何失败都不抛**：宿主是增强项，不能拖垮页面。
   *
   * 幂等 + 并发去重（装载入口每次都会先调它，热路径必须几乎零成本）：
   *   · 已装载完成 → 直接返回上次结果，不再请求 /api/plugins；
   *   · 正在装载   → 后来者复用同一个 Promise（清单只取一次、插件只评估一次）。
   * 这解决了"页面刚起、插件脚本还在注入时就发起装载"的时序竞争。
   * @returns {Promise<{discovered: number, registered: number}>}
   */
  async function loadAll() {
    if (loaded) return { discovered: discovered.length, registered: countRegistered() };
    if (loadingPromise) return loadingPromise;
    loadingPromise = doLoadAll().finally(() => { loadingPromise = null; });
    return loadingPromise;
  }

  /** 已成功装载（注册提供者）的插件数 */
  function countRegistered() {
    return [...loadState.values()].filter((s) => s.loaded).length;
  }

  /** loadAll 的实际执行体（内部使用；失败只记日志不抛） */
  async function doLoadAll() {
    try {
      const res = await fetch(`${base}/api/plugins`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      discovered = Array.isArray(data && data.plugins) ? data.plugins : [];
    } catch (e) {
      say.warn(`插件清单获取失败（页面其余功能不受影响）：${(e && e.message) || e}`);
      return { discovered: 0, registered: 0 };
    }
    if (!discovered.length) {
      say.info('没有启用任何插件（config/plugins.json 可开关）');
      loaded = true;
      return { discovered: 0, registered: 0 };
    }
    say.info(`发现 ${discovered.length} 个启用插件：${discovered.map((p) => p.id).join(', ')}`);
    for (const pl of discovered) {
      if (pl && pl.id) manifestProvides.set(pl.id, Array.isArray(pl.provides) ? pl.provides.map(String) : []);
      try { await loadPlugin(pl); } catch (e) { say.warn(`插件 ${pl && pl.id} 装载异常：${(e && e.message) || e}`); }
    }
    loaded = true;
    const ok = countRegistered();
    say.info(`插件装载完成：加载 ${discovered.length} 个、注册 ${ok} 个提供者`
      + (ok < discovered.length ? `（${discovered.length - ok} 个未生效，见上方警告）` : ''));
    return { discovered: discovered.length, registered: ok };
  }

  /** 已注册的提供者（可按 fileKinds 过滤，如 ['bundle']） */
  function providersFor(fileKinds) {
    const list = [...providers.values()];
    if (!fileKinds || !fileKinds.length) return list;
    const want = new Set(fileKinds);
    return list.filter((p) => Array.isArray(p.fileKinds) && p.fileKinds.some((k) => want.has(k)));
  }

  /**
   * 找一个能处理该文件的提供者（走插件的 canHandle）。
   * file 形状按契约 §1.1：{ rootId, rel, name?, bytes?, profile? }；host 由这里注入（§3.6）。
   * canHandle 必须是同步布尔（§3.1）；插件内部抛错一律当"不认"，不冒泡。
   * @param {object} file
   * @returns {object|null} 命中的 provider
   */
  function findProvider(file) {
    if (!file || typeof file !== 'object') return null;
    const probe = { ...file, host: hostApi };
    if (file.bytes !== undefined && file.bytes !== null) {
      const normalized = toUint8Array(file.bytes);
      if (normalized) probe.bytes = normalized;
      else say.warn(`findProvider 收到无法识别的 bytes 类型（${describeType(file.bytes)}）：`
        + '契约 §1.1 要求 Uint8Array；插件可能因此判不出容器（表现为"没有提供者"）');
    }
    for (const p of providers.values()) {
      // 只有声明了 asset-provider 角色的插件才参与"这个文件归谁解"（契约 §一/§二）。
      //   其它角色（renderer/editor/exporter/panel）不该在这里被问到。
      if (!Array.isArray(p.provides) || !p.provides.includes('asset-provider')) continue;
      if (typeof p.canHandle !== 'function') continue;
      let hit = false;
      try {
        hit = p.canHandle(probe) === true;
      } catch (e) {
        say.warn(`提供者 ${p.id} 的 canHandle 抛错（按不处理该文件处理）：${(e && e.message) || e}`);
        hit = false;
      }
      if (hit) return p;
    }
    return null;
  }

  /** 排障快照：装载状态 + 已注册提供者 */
  function report() {
    return {
      loaded,
      discovered: discovered.map((p) => p.id),
      providers: [...providers.values()].map((p) => ({
        id: p.id,
        provides: Array.isArray(p.provides) ? p.provides.slice() : [],
        kind: p.kind || null,
        fileKinds: Array.isArray(p.fileKinds) ? p.fileKinds.slice() : [],
        hasCanHandle: typeof p.canHandle === 'function',
        hasResolve: typeof p.resolve === 'function',
      })),
      loadState: [...loadState.entries()].map(([id, s]) => ({ id, ...s })),
    };
  }

  // 插件脚本顶层读的就是它：必须在注入脚本**之前**挂好
  window.SpineViewerPlugins = hostApi;

  return {
    loadAll,
    providersFor,
    findProvider,
    fetchFile,
    /** 资源包 → VirtualFS（预筛 → 读全量 → resolve → register），不碰渲染 */
    materialize,
    /** 预筛判定（排障用：为什么某个文件没被当成资源包） */
    prefilterReason,
    report,
    isLoaded: () => loaded,
    host: hostApi,
  };
}
