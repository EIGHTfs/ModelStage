// ============================================================================
// src/web/spine-canvas.js —— 舞台适配层（M4）
//
// 定位：**唯一出口**。上层（名册/面板/播放条/持久化）只通过这里的方法与舞台交互；
//   当前实现复用旧 `src/engine.js` 的 `SpineEngine`（生产已验证），
//   后续可换成可读版渲染器而不改调用方（契约见 doc/Spine渲染要点.md §14）。
//
// 为什么复用 engine.js：
//   · 自包含（无 import/export），运行时管理器在内，且用 `new Function` 做**隔离执行**
//     ——`var spine` 在执行体里成局部绑定，这才是多版本共存的正解；
//     `<script src>` 会覆盖 window.spine，导致 3.8 的 `GLTexture extends spine.Texture`
//     在 4.1 覆盖后炸 "Class constructor Texture cannot be invoked without 'new'"。
//   · PMA / DPR / fitMode 三档 / 纹理过滤 / 调试绘制 / 裁剪 语义齐全，面板接线风险≈0。
//
// 运行时来源：dev-server 的 /spine-runtimes/index.json 给出**目录里实际存在的版本**，
//   客户端按版本取源码文本塞进 window.__SPINE_RUNTIME_SOURCES__，由 engine 懒执行。
// ============================================================================

import { installRuntimeManager } from './spine-runtime-manager.js';

const RUNTIME_BASE = '/spine-runtimes/spine-webgl-';
const RUNTIME_MANIFEST = '/spine-runtimes/index.json';
const ENGINE_SRC = '/engine.js';
const ALPHA_THRESHOLD = 8; // alpha 大于它才算"画上了"（背景 clearColor 为全透明）
const DEFAULT_SETTINGS = {
  pma: 'auto', fit: 'subject', textureFilter: 'linear', speed: 1, loop: true, debug: null,
  fpsLimit: 60, dprMode: 'auto',
};

const runtimeSourceCache = new Map(); // ver -> 源码文本
let enginePromise = null;
let manifestPromise = null;
let availableCache = null;

/** '3.8.99' -> '3.8' */
function majorMinor(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : String(v || '');
}

/** 业务错误：调用方只更新提示，不抛控制台 */
function businessError(msg, cause) {
  const e = new Error(msg);
  e.business = true;
  if (cause) e.cause = cause;
  return e;
}

/**
 * engine.js 把 SpineEngine 声明为脚本级 const（不挂 window）；
 * 必须在全局作用域用 new Function 读，才能拿到该绑定。
 */
function readGlobalEngine() {
  const SRC = 'return typeof SpineEngine !== "undefined" ? SpineEngine : '
    + '(typeof SpineEngineAlias !== "undefined" ? SpineEngineAlias : null);';
  try { return new Function(SRC)(); } catch { return null; } // dsh-skip-sensitive 运行时隔离执行本地可信源码（src/spine-runtimes/*.js），不接收任何外部输入
}

/** 注入 engine.js（只一次；成败都缓存 Promise） */
function ensureEngine() {
  const pre = readGlobalEngine();
  if (pre) return Promise.resolve(pre);
  if (enginePromise) return enginePromise;
  enginePromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = ENGINE_SRC;
    s.async = true;
    s.onload = () => {
      const E = readGlobalEngine();
      if (E) resolve(E);
      else reject(new Error('engine.js 已加载但读不到全局 SpineEngine 绑定'));
    };
    s.onerror = () => reject(new Error(`engine.js 加载失败（${ENGINE_SRC}）`));
    document.head.appendChild(s);
  });
  return enginePromise;
}

/** 运行时目录清单（dev-server 扫目录生成；客户端不写死版本列表） */
function fetchManifest() {
  if (manifestPromise) return manifestPromise;
  const p = fetch(RUNTIME_MANIFEST, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : { versions: [] }))
    .then((j) => (Array.isArray(j.versions) ? j.versions : []))
    .catch(() => []);
  manifestPromise = p;
  p.then((list) => {
    // 空结果多为"服务刚起/网络抖动"，缓存它会让后续加载永久拿不到版本 ⇒ 清掉待下次重试
    if (!list.length && manifestPromise === p) manifestPromise = null;
  });
  return p;
}

/** 本机可用版本：直接采用 dev-server 扫目录生成的清单（不再逐版发 HEAD 探测，
 *  避免并发探测请求在切换/卸载时被中断成 ERR_ABORTED）。 */
async function availableVersions() {
  if (availableCache && availableCache.length) return availableCache;
  let list = await fetchManifest();
  // 服务刚起/抖动时清单可能一时为空：同一次加载内立即重试一次，避免把"瞬时失败"变成"这次一定失败"
  if (!list.length) {
    await new Promise((r) => setTimeout(r, 150));
    list = await fetchManifest();
  }
  if (list.length) availableCache = list; // 只缓存非空结果
  return list;
}

/** 精确命中优先，否则同 major 的最大 minor，最后退清单里最大的 */
function pickRuntimeVersion(version, available) {
  const want = majorMinor(version);
  if (!available.length) return want || null; // 清单不可用：有版本用版本，没版本交给调用方报错
  if (!want) return available[available.length - 1]; // 模型缺版本号：用清单里最新的一档
  if (available.includes(want)) return want;
  const major = want.split('.')[0];
  const same = available.filter((v) => v.split('.')[0] === major);
  if (same.length) return same[same.length - 1];
  return available[available.length - 1];
}

/** 取运行时源码文本并塞进 engine 的懒加载钩子（隔离执行由 engine 负责） */
async function ensureRuntimeSource(ver) {
  window.__SPINE_SINGLE_FILE__ = true;
  window.__SPINE_RUNTIME_SOURCES__ = window.__SPINE_RUNTIME_SOURCES__ || {};
  if (window.__SPINE_RUNTIME_SOURCES__[ver]) return;
  let text = runtimeSourceCache.get(ver);
  if (!text) {
    const r = await fetch(`${RUNTIME_BASE}${ver}.js`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`运行时 ${ver} 加载失败（HTTP ${r.status}）`);
    text = await r.text();
    runtimeSourceCache.set(ver, text);
  }
  window.__SPINE_RUNTIME_SOURCES__[ver] = text;
}

/** 资源 URL：优先用 /api/models 条目自带的 url，否则按 root+path 拼 */
function fileUrl(root, f) {
  if (f && typeof f.url === 'string' && f.url) return f.url;
  const p = encodeURIComponent(f && f.path ? f.path : '');
  return `/api/file?root=${encodeURIComponent(root)}&path=${p}`;
}

/** 取二进制 → engine 需要的 { name, content: ArrayBuffer } */
async function fetchBinary(root, f, signal) {
  const r = await fetch(fileUrl(root, f), { cache: 'no-store', signal });
  if (!r.ok) throw new Error(`资源 ${f && f.name ? f.name : ''} 读取失败（HTTP ${r.status}）`);
  return { name: (f && f.name) || '', content: await r.arrayBuffer() };
}

/** 并发取骨架 / atlas / 所有贴图页 */
async function fetchModelResources(root, model, signal) {
  const [skeleton, atlas, ...textures] = await Promise.all([
    fetchBinary(root, model.skeletonFile, signal),
    fetchBinary(root, model.atlasFile, signal),
    ...(model.textureFiles || []).map((t) => fetchBinary(root, t, signal)),
  ]);
  return { skeleton, atlas, textures };
}

/** engine 的模型描述符（字段名是 engine 的契约，见文档 §14） */
function buildDescriptor(model, ver, res) {
  return {
    name: model.name || model.id,
    version: ver,
    skeletonFile: { name: (model.skeletonFile && model.skeletonFile.name) || '', content: res.skeleton.content },
    atlasFile: { name: (model.atlasFile && model.atlasFile.name) || '', content: res.atlas.content },
    textureFiles: res.textures.map((t, i) => ({
      name: (model.textureFiles && model.textureFiles[i] && model.textureFiles[i].name) || t.name,
      content: t.content,
    })),
    atlasPma: model.atlasPma === true ? true : model.atlasPma === false ? false : null,
  };
}

/** 只读统计（不暴露 engine 内部对象） */
function statsOf(st) {
  const e = st.engine;
  return {
    model: st.model ? { name: st.model.name, version: st.model.version } : null,
    runtimeVersion: e && e.getRuntimeVersion ? e.getRuntimeVersion() : null,
    runtimeKeys: [...st.runtimeKeys],
    contexts: e && e.gl ? 1 : 0,
    frames: st.frames,
    fps: e && e.getCurrentFps ? e.getCurrentFps() : null,
    loads: st.loads,
    disposes: st.disposes,
    lastError: st.lastError,
    animations: e && e.getAnimations ? e.getAnimations() : [],
    settings: { ...st.settings },
  };
}

/** 像素签名：对读回的缓冲做一次轻量哈希（验收用"两帧不同"判定，不做加密） */
function pixelSignature(buf) {
  let h = 2166136261;
  for (let i = 0; i < buf.length; i += 97) { // 稀疏采样：覆盖全画面且够快
    h ^= buf[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

/** 同帧采样：非透明像素占比（先渲染一帧再读，避免读到来不及呈现的缓冲） */
function samplePixels(st) {
  const e = st.engine;
  const gl = e && e.gl;
  if (!gl) return { ratio: 0, w: 0, h: 0, reason: 'no-gl' };
  try {
    if (e.presentFirstFrame) e.presentFirstFrame();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let n = 0;
    for (let i = 3; i < buf.length; i += 4) if (buf[i] > ALPHA_THRESHOLD) n++;
    return { ratio: +(n / (w * h)).toFixed(4), w, h, signature: pixelSignature(buf) };
  } catch (err) {
    return { ratio: 0, w: 0, h: 0, reason: String(err && err.message ? err.message : err) };
  }
}

/** 应用设置（全部走 engine 的 setter，缺哪个就跳过哪个） */
function applySettings(st, patch) {
  if (patch && typeof patch === 'object') Object.assign(st.settings, patch);
  const e = st.engine;
  if (!e) return;
  const s = st.settings;
  const call = (fn, ...args) => { try { if (typeof fn === 'function') fn.apply(e, args); } catch { /* 版本不支持则跳过 */ } };
  if (s.fit) call(e.setFitMode, s.fit);
  if (s.textureFilter) call(e.setTextureFilter, s.textureFilter);
  if (typeof s.fpsLimit === 'number') call(e.setFpsLimit, s.fpsLimit);
  if (s.dprMode !== undefined && s.dprMode !== null) call(e.setDprMode, s.dprMode);
  if (typeof s.speed === 'number') call(e.setSpeed, s.speed);
  if (typeof s.loop === 'boolean') call(e.setLoop, s.loop);
  if (s.debug) call(e.setDebugDraw, s.debug);
}

/** 释放当前模型（保留 engine 实例） */
function unloadModel(st) {
  const e = st.engine;
  st.model = null;
  st.seq++; // 让在途加载失效
  if (!e) return;
  try { e.stop(); } catch { /* 已停止 */ }
  try { if (e.clearSkeleton) e.clearSkeleton(); } catch { /* 清理失败不阻塞 */ }
  st.disposes++;
}

/** 首次进入时创建 engine；canvas 尺寸变化由 engine 的 refreshResolution 处理 */
function ensureStageEngine(st, Engine, canvas) {
  if (st.engine) return true;
  const engine = new Engine({
    log: (level, msg, scope) => { if (level === 'error') st.lastError = `${scope || 'engine'}: ${msg}`; },
    onLoadComplete: (info) => { st.model = info; },
    onError: (msg) => { st.lastError = String(msg); },
  });
  if (!engine.init(canvas, { antialias: false, allowParseOnly: false })) return false;
  st.engine = engine;
  applySettings(st);
  return true;
}

/** 播第一个动作 + 启动渲染循环 + 帧计数（验收用） */
function startPlayback(st, info, loop) {
  const e = st.engine;
  const anims = e.getAnimations ? e.getAnimations() : [];
  const motion = anims.length ? anims[0] : null;
  if (motion) { try { e.setAnimation(motion, loop); } catch { /* 播不了就停首帧 */ } }
  try { e.start(); } catch { /* 循环已在跑 */ }
  try { if (e.presentFirstFrame) e.presentFirstFrame(); } catch { /* 留给下一帧 */ }
  st.frames = 0;
  const tick = () => {
    if (st.model !== info) return;
    st.frames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return { animations: anims, motion };
}

/** 加载主流程（编排：选版本 → 注入源码 → 取资源 → 建 engine → 加载 → 起播） */
async function loadIntoStage(st, canvas, arg) {
  const root = arg && arg.root;
  const model = arg && arg.model;
  if (!root || !model) throw new Error('load 需要 { root, model }');
  const seq = ++st.seq;
  // 切模型：中止上一个在途加载的请求（被中止属预期，不产生控制台报错）
  if (st.abort) st.abort.abort();
  const ctl = new AbortController();
  st.abort = ctl;
  // 上一个模型由 engine.loadModel 内部 stop+disposeTexturesAndAtlas 负责释放，这里只记账
  if (st.model) { st.model = null; st.disposes++; }
  installRuntimeManager(); // engine.js 顶层 `let Yd = Is` 需要它先存在
  const Engine = await ensureEngine();
  const avail = await availableVersions();
  const ver = pickRuntimeVersion(model.version, avail);
  if (!ver) throw businessError('无法确定该模型的 Spine 版本：元数据缺少 version，且运行时清单不可用');
  await ensureRuntimeSource(ver);
  if (seq !== st.seq) throw businessError('加载已被新的选择取代');
  const res = await fetchModelResources(root, model, ctl.signal);
  if (seq !== st.seq) return null;
  if (!ensureStageEngine(st, Engine, canvas)) throw businessError('当前环境没有可用的 WebGL，无法渲染 Spine');
  if (!st.runtimeKeys.includes(ver)) st.runtimeKeys.push(ver);
  st.loads++;
  const info = await st.engine.loadModel(buildDescriptor(model, ver, res));
  if (seq !== st.seq) throw businessError('加载已被新的选择取代');
  if (!info) throw businessError('模型加载失败（引擎未返回结果）');
  const playing = startPlayback(st, info, st.settings.loop);
  return { version: ver, animations: playing.animations, motion: playing.motion };
}

/**
 * 创建舞台（对外契约见 doc/Spine渲染要点.md §14）。
 * @param {{canvas: HTMLCanvasElement, onStatus?: (s:object)=>void}} opts
 */
export function createSpineStage(opts) {
  const o = opts || {};
  if (!o.canvas) throw new Error('createSpineStage 需要 canvas');
  const canvas = o.canvas;
  const onStatus = typeof o.onStatus === 'function' ? o.onStatus : () => {};
  const st = {
    engine: null, seq: 0, loads: 0, disposes: 0, lastError: null,
    runtimeKeys: [], model: null, frames: 0, settings: { ...DEFAULT_SETTINGS },
  };
  const status = (patch) => { try { onStatus({ ...statsOf(st), ...patch }); } catch { /* 回调不影响渲染 */ } };
  const fail = (msg, cause) => {
    st.lastError = String(msg);
    status({ phase: 'error', error: st.lastError });
    return businessError(st.lastError, cause);
  };
  const api = {
    async load(arg) {
      try {
        const info = await loadIntoStage(st, canvas, arg);
        status({ phase: 'ready', ...info });
        return info;
      } catch (err) {
        if (err && err.business) {
          // 业务错误也要落到状态里（页面提示与遥测都靠 lastError）
          st.lastError = String(err.message || err);
          status({ phase: error, error: st.lastError });
          throw err;
        }
        if (err && err.name === 'AbortError') throw fail('加载已被新的选择取代', err);
        throw fail(`加载失败：${err && err.message ? err.message : err}`, err);
      }
    },
    unload() { unloadModel(st); status({ phase: 'unload' }); },
    stats: () => statsOf(st),
    samplePixels: () => samplePixels(st),
    applySettings: (patch) => applySettings(st, patch),
    play() { if (st.engine && st.engine.start) { try { st.engine.start(); } catch { /* 已在播放 */ } } },
    pause() { if (st.engine && st.engine.stop) { try { st.engine.stop(); } catch { /* 已暂停 */ } } },
    seek(t) { if (st.engine && st.engine.seek) { try { st.engine.seek(t); } catch { /* 越界忽略 */ } } },
    setAnimation(name, loop) {
      if (!st.engine || !name) return false;
      try { st.engine.setAnimation(name, typeof loop === 'boolean' ? loop : st.settings.loop); return true; } catch { return false; }
    },
    resize() {
      if (!st.engine) return;
      try { if (st.engine.refreshResolution) st.engine.refreshResolution(); } catch { /* 忽略 */ }
      try { if (st.engine.resetCamera) st.engine.resetCamera(); } catch { /* 忽略 */ }
    },
    dispose() {
      const e = st.engine;
      st.engine = null; st.model = null; st.seq++;
      if (!e) return;
      try { if (e.dispose) e.dispose(); } catch { /* 忽略 */ }
      st.disposes++;
    },
    // debug 同时给出统计字段（验收脚本从 debug() 读 frames 等）
    debug: () => ({ ...statsOf(st), engine: st.engine }),
  };
  // PMA 不走通用 setter：切它必须重传贴图，单列一个方法（见下）
  for (const key of ['fit', 'textureFilter', 'speed', 'loop', 'debug', 'fpsLimit', 'dprMode']) {
    api[`set${key[0].toUpperCase()}${key.slice(1)}`] = (v) => applySettings(
      st, { [key]: key === 'fpsLimit' ? Number(v) : v },
    );
  }
  /**
   * 切换 PMA 模式：true=预乘、false=直通。
   * 为什么单列：引擎没有 setPmaMode，切预乘必须重建贴图纹理（rebuildTextures）。
   */
  api.setPma = (on) => {
    const mode = on ? 'premultiplied' : 'straight';
    applySettings(st, { pma: mode });
    if (st.engine && typeof st.engine.rebuildTextures === 'function') {
      try { st.engine.rebuildTextures(mode); } catch { /* 重建失败保持原贴图 */ }
    }
    return mode;
  };
  return api;
}
