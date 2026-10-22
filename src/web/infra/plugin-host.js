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
  /** id → { loaded, error, files, ms } 装载状态（排障用） */
  const loadState = new Map();
  /** /api/plugins 返回的清单快照 */
  let discovered = [];
  let loaded = false;

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
      const rec = { ...plugin, id };
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

  /**
   * 读启用清单并逐个加载。**任何失败都不抛**：宿主是增强项，不能拖垮页面。
   * @returns {Promise<{discovered: number, registered: number}>}
   */
  async function loadAll() {
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
      try { await loadPlugin(pl); } catch (e) { say.warn(`插件 ${pl && pl.id} 装载异常：${(e && e.message) || e}`); }
    }
    loaded = true;
    const ok = [...loadState.values()].filter((s) => s.loaded).length;
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
    report,
    isLoaded: () => loaded,
    host: hostApi,
  };
}
