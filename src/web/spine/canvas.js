// ============================================================================
// src/web/spine/canvas.js —— 舞台适配层（唯一出口）
//
// 定位：上层（名册/面板/播放条/持久化）只通过这里的方法与舞台交互；
//   内部分派给 `src/web/engine/` 的可读实现，调用方不随实现变化。
//
// 为什么用 ESM 直连引擎而不是脚本注入：
//   · 脚本注入（`<script src>`）会覆盖 window.spine，导致 3.8 的 GLTexture 继承 4.1 的
//     spine.Texture 后炸 "Class constructor Texture cannot be invoked without 'new'"。
//   · ESM 静态导入天然按模块隔离，多版本运行时共存不需要额外技巧。
//
// 运行时来源：`/spine-runtimes/index.json` 给出目录里实际存在的版本，
//   客户端按版本取源码文本塞进 window.__SPINE_RUNTIME_SOURCES__，由引擎懒执行。
// ============================================================================

import { getSharedVirtualFS } from '../infra/vfs.js';
import { installRuntimeManager } from './runtimes.js';
import { createStageCamera } from '../render/camera/spine.js';
import { SpineEngine as NextEngine } from '../engine/index.js';

const RUNTIME_BASE = '/spine-runtimes/spine-webgl-';
const RUNTIME_MANIFEST = '/spine-runtimes/index.json';
const ALPHA_THRESHOLD = 8;

/** 取引擎构造器：只有新引擎（可读实现）。旧脚本注入路径已随引擎重写收尾删除。 */
async function pickEngineCtor() {
  return NextEngine;
}

/**
 * 相机视图约定（交互层按此实现，勿改）：
 *   · pan 单位 = 屏幕像素，原点 = 画布中心（即 fit 视图的中心），向右/向下为正；
 *   · zoom = 相对 fit 的倍数，reset 后为 1.0，取值 0.2~8；
 *   · 世界单位 ↔ 屏幕像素的换算只在本文件做：屏幕 = 世界差值 × base.zoom × zoom。
 */

/** 相机视图：缩放范围（相对 fit 的倍数）与取景基准缓存 */
const VIEW_ZOOM_MIN = 0.2;
const VIEW_ZOOM_MAX = 8;
 // alpha 大于它才算"画上了"（背景 clearColor 为全透明）
const DEFAULT_SETTINGS = {
  pma: 'auto', fit: 'subject', textureFilter: 'linear', speed: 1, loop: true, debug: null,
  fpsLimit: 60, dprMode: 'auto', msaa: 'auto', filter: 'original',
};

const runtimeSourceCache = new Map(); // ver -> 源码文本
let manifestPromise = null;
let availableCache = null;

/** '3.8.99' -> '3.8' */
function majorMinor(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : String(v || '');
}

/**
 * 被取代的装载错误：业务错误 + aborted 标记。
 * 为什么单列：调用方必须能区分"装载失败"与"被更新的选择取代"——后者是正常竞态结果，
 *   不该显示成红色故障，也不该被当成"成功"继续读结果字段（曾经因此抛 TypeError 留下空白画面）。
 */
function abortedError(msg = '加载已被新的选择取代', cause) {
  const e = businessError(msg, cause);
  e.aborted = true;
  return e;
}

/** 业务错误：调用方只更新提示，不抛控制台 */
function businessError(msg, cause) {
  const e = new Error(msg);
  e.business = true;
  if (cause) e.cause = cause;
  return e;
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

/**
 * 资源地址解析（VirtualFS 契约 §四）：先问 vfs，命中用虚拟地址，未命中回落原 URL。
 *
 * 为什么只有一个前置、不做第二条通道：vfs.resolve 是"内存资源 / 网络资源"唯一的统一入口，
 *   未命中即回落 ⇒ 没有注册任何前缀时行为与改造前完全一致（可退化）。
 *   注意：这里**不能**改成 patch fetch / 装中间件（契约 §五明令禁止）：那会让"资源从哪来"变成隐式全局状态。
 * @param {string} url
 * @returns {string}
 */
function resolveResource(url) {
  try {
    const hit = getSharedVirtualFS().resolve(url);
    return hit || url;
  } catch {
    return url; // VFS 异常绝不阻断加载
  }
}

/** 取二进制 → engine 需要的 { name, content: ArrayBuffer } */
async function fetchBinary(root, f, signal) {
  // 骨架 / atlas / 贴图页三类资源都从这里取 —— 单一前置点，三类一起接上 VFS
  const r = await fetch(resolveResource(fileUrl(root, f)), { cache: 'no-store', signal });
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

/** 当前相机对象（部分运行时用 scale 而非 zoom） */
function cameraOf(st) {
  return st.engine && st.engine.camera ? st.engine.camera : null;
}

/** 读相机缩放（统一成"越大越放大"的 zoom 语义） */
function cameraZoom(cam) {
  if (!cam) return 1;
  if (cam.zoom !== undefined) return cam.zoom;
  if (cam.scale) return 1 / cam.scale;
  return 1;
}

/** 写相机缩放（与 cameraZoom 的两种字段对应） */
function setCameraZoom(cam, zoom) {
  if (!cam) return;
  if (cam.zoom !== undefined) cam.zoom = zoom;
  else if (cam.scale !== undefined) cam.scale = 1 / zoom;
}

/**
 * 取"fit 后的缩放"作为视图基准。
 * 引擎的 baseZoom 就是 fit 结果；只有在拿不到时才退回当前相机 zoom。
 * （曾经用"调用时的相机 zoom"当基准，导致 reset 之后基准被上一次的缩放污染）
 */

/**
 * 记录视图基准：缩放基准取引擎的 userScale（引擎语义「越大越放大」），平移累计归零。
 * 不在本文件推导相机字段——引擎的 camera.zoom 是 userScale 的倒数，自己算必错。
 */
function captureViewBase(st) {
  const engine = st.engine;
  // 基准 = 当前 userScale（引擎的 getCameraZoom 是唯一真相；resetCamera 之后取一次即可）
  st.viewBaseScale = engine && typeof engine.getCameraZoom === 'function' ? engine.getCameraZoom() : 1;
  st.viewPan = { x: 0, y: 0 };
}
/**
 * 标定「平移输入 1 像素 → 画面位移多少像素」。
 * 为什么要标定：引擎 applyPan 内部有 `×2` 与 flip 系数，直接原样传会让拖动比手指快一倍多。
 * 做法：applyPan(±1) 探测相机世界位移，再乘「每世界单位对应多少屏幕像素」，探测后立即复原（净位移 0）。
 */

/**
 * 视图快照（对外单位约定）。
 *   zoom = 相对 fit 的倍数：engine.getCameraZoom() / 基准 userScale；reset 后为 1；
 *   panX/panY = **屏幕像素**，原点画布中心，向右/向下为正（累计值）。
 */
function viewOf(st) {
  const engine = st.engine;
  const base = st.viewBaseScale || 1;
  const cur = engine && typeof engine.getCameraZoom === 'function' ? engine.getCameraZoom() : base;
  const pan = st.viewPan || { x: 0, y: 0 };
  return {
    zoom: +(cur / base).toFixed(4),
    panX: +pan.x.toFixed(2),
    panY: +pan.y.toFixed(2),
    userScale: +cur.toFixed(6),
    baseUserScale: +base.toFixed(6),
    available: !!engine,
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
    view: viewOf(st),
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
  // 不写死 antialias：交给 ensureStageEngineWith 按 settings.msaa 决定（默认自动=开）
  return ensureStageEngineWith(st, Engine, undefined, canvas);
}

/** 建引擎；antialias 只在此时能生效（换画布重建时传 true） */
function ensureStageEngineWith(st, Engine, antialias, canvasOverride) {
  const canvas = canvasOverride || st.canvas;
  // 未显式指定时按设置走：'auto' = 开抗锯齿（与面板默认一致）
  const wantAA = typeof antialias === 'boolean' ? antialias : st.settings.msaa === 'auto';
  const engine = new Engine({
    log: (level, msg, scope) => { if (level === 'error') st.lastError = `${scope || 'engine'}: ${msg}`; },
    onLoadComplete: (info) => { st.model = info; },
    onError: (msg) => { st.lastError = String(msg); },
  });
  if (!engine.init(canvas, { antialias: wantAA, allowParseOnly: false })) return false;
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
async function loadIntoStage(st, arg) {
  const root = arg && arg.root;
  const model = arg && arg.model;
  if (!root || !model) throw new Error('load 需要 { root, model }');
  const seq = ++st.seq;
  // 每次装载开始都清掉上一次的错误：lastError 语义是"最近一次装载的结果状态"，
  //   成功后若不清，后面每次成功采样都会带着旧的失败原因（实测会污染对照表的每一格）
  st.lastError = null;
  // 切模型：中止上一个在途加载的请求（被中止属预期，不产生控制台报错）
  if (st.abort) st.abort.abort();
  const ctl = new AbortController();
  st.abort = ctl;
  // 上一个模型由 engine.loadModel 内部 stop+disposeTexturesAndAtlas 负责释放，这里只记账
  if (st.model) { st.model = null; st.disposes++; }
  // 先装运行时管理器：引擎取某个版本的运行时源码时要经它（多版本共存的单一入口）
  installRuntimeManager();
  const Engine = await pickEngineCtor();
  const avail = await availableVersions();
  const ver = pickRuntimeVersion(model.version, avail);
  if (!ver) throw businessError('无法确定该模型的 Spine 版本：元数据缺少 version，且运行时清单不可用');
  await ensureRuntimeSource(ver);
  if (seq !== st.seq) throw abortedError();
  const res = await fetchModelResources(root, model, ctl.signal);
  if (seq !== st.seq) throw abortedError();
  if (!ensureStageEngine(st, Engine, st.canvas)) throw businessError('当前环境没有可用的 WebGL，无法渲染 Spine');
  if (!st.runtimeKeys.includes(ver)) st.runtimeKeys.push(ver);
  st.loads++;
  const info = await st.engine.loadModel(buildDescriptor(model, ver, res));
  if (seq !== st.seq) throw abortedError();
  if (!info) throw businessError('模型加载失败（引擎未返回结果）');
  st.lastArg = arg; // 供 MSAA 重建上下文后恢复同一模型
  captureViewBase(st); // 新模型 fit 完成：把当前取景记为视图基准
  const playing = startPlayback(st, info, st.settings.loop);
  return { version: ver, animations: playing.animations, motion: playing.motion };
}

/**
 * 创建舞台（对外契约见 doc/参考-Spine渲染要点.md §14）。
 * @param {{canvas: HTMLCanvasElement, onStatus?: (s:object)=>void}} opts
 */
/**
 * 组装舞台对外 API 的"基础方法"（加载/释放/统计/采样/播放控制）。
 * 拆出来是为了让 createSpineStage 只做编排（单函数过长会被审计拦截）。
 * @param {object} st 舞台状态
 * @param {{status: Function, fail: Function}} ctx 状态回调与失败包装
 */
function buildStageApi(st, ctx) {
  const { status, fail } = ctx;
const api = {
  async load(arg) {
    try {
      const info = await loadIntoStage(st, arg);
      // 被取代时 loadIntoStage 返回 null：必须显式抛 aborted，不能"静默成功"让调用方读到空结果
      if (!info) throw abortedError();
      status({ phase: 'ready', ...info });
      return info;
    } catch (err) {
      if (err && err.business) {
        // 业务错误也要落到状态里（页面提示与遥测都靠 lastError）
        st.lastError = String(err.message || err);
        status({ phase: 'error', error: st.lastError });
        throw err;
      }
      if (err && err.name === 'AbortError') { st.lastError = '加载已被新的选择取代'; throw abortedError(st.lastError, err); }
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
  return api;
}

/**
 * 给舞台 API 挂"可选能力"：PMA 四档、滤镜、皮肤、混合模式、调试绘制、MSAA 重建。
 * 这些方法依赖模块级工具（applySettings / loadIntoStage…），与工厂解耦。
 */
/**
 * 给舞台 API 挂"可选能力"。按职责拆成四段，便于维护与审计（单函数长度）。
 * 依赖模块级工具（applySettings / loadIntoStage…），与工厂解耦。
 */
function attachExtraApi(api, st) {
  attachSettingSetters(api, st);
  attachAssetApi(api, st);
  attachViewApi(api, st);
  attachRenderApi(api, st);
}

/** 通用 setter（fit/纹理过滤/速度/循环/调试/帧率/DPR）与 PMA 四档 */
function attachSettingSetters(api, st) {

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
/**
 * 切换 PMA 模式（auto / premultiplied / straight / upload 四档）。
 * 四档都会重传贴图：auto 需要重新采样像素判断，其余三档要按新口径重上传。
 * @param {string} mode
 */
api.setPma = async (mode) => {
  const m = ['auto', 'premultiplied', 'straight', 'upload'].includes(mode) ? mode : 'auto';
  const prev = (st.settings && st.settings.pma) || 'auto';
  applySettings(st, { pma: m });
  const eng = st.engine;
  if (!eng || typeof eng.rebuildTextures !== 'function') return m;
  // 必须 await：rebuildTextures 是异步的（要重新解包贴图 + 重建骨架），
  //   不 await 会让"同步 try/catch"抓不到失败，UI 以为切换成功而实际没生效。
  let ok = false;
  try {
    ok = await eng.rebuildTextures(m);
  } catch (e) {
    try { eng.log('error', `PMA 切换异常: ${e && e.message ? e.message : e}`, 'pma'); } catch { /* 忽略 */ }
    ok = false;
  }
  if (ok) return m;
  // 失败如实反映：把档位回滚为上一档，面板/持久化读到的就是"实际生效值"
  applySettings(st, { pma: prev });
  try { eng.log('warn', `PMA 切换失败（${m}），已回滚为 ${prev}`, 'pma'); } catch { /* 忽略 */ }
  return prev;
};

/**
 * 调试绘制开关（8 个独立项，可同时开）。
 * 每次只传变化的键，引擎内部会合并；状态同步记到 settings.debug 便于断言。
 * @param {object} patch 形如 { bones: true, meshes: false }
 */
}

/** 资产相关：皮肤列表与切换、混合模式、部件筛除 */
function attachAssetApi(api, st) {
/** 当前模型的皮肤名列表（无皮肤时返回 [default]） */
api.getSkins = () => {
  if (!st.engine || typeof st.engine.getSkins !== 'function') return ['default'];
  try {
    const list = st.engine.getSkins() || [];
    return list.length ? list : ['default'];
  } catch {
    return ['default'];
  }
};

/**
 * 切换皮肤（引擎按名称匹配；找不到时保持原皮肤）。
 * 成功与否必须取引擎返回值：否则面板会记下一个并不存在的皮肤名，
 *   表现为"设置里显示 skin_X、画面还是 default"，且下次重建贴图时又按错名字去设一遍。
 * @param {string} name
 * @returns {boolean} 是否真的切过去了
 */
api.setSkin = (name) => {
  if (!st.engine || typeof st.engine.setSkins !== 'function') return false;
  try {
    const ok = st.engine.setSkins([name]) !== false;
    if (ok) st.settings.skin = name;
    return ok;
  } catch {
    return false;
  }
};

/**
 * 动作清单（名称 + 时长）：时长来自 skeletonData.animations 的 duration。
 * 面板与底栏都读这一份，避免"两处各取一处"导致条数/时长不一致。
 * @returns {Array<{name: string, duration: number|null}>}
 */
api.animationDetails = () => {
  try {
    const e = st.engine; // 与同一 api 里其它方法一致：引擎挂在 st 上
    const anims = (e && e.skeletonData && e.skeletonData.animations) || [];
    return anims.map((a) => {
      const d = Number(a && a.duration);
      return { name: String(a && a.name || ''), duration: Number.isFinite(d) && d > 0 ? d : null };
    }).filter((a) => a.name);
  } catch {
    return [];
  }
};

/** 混合模式：开 = 动画切换交叉淡化 0.2s，关 = 硬切 0 */
api.setMixMode = (on) => {
  const t = on ? 0.2 : 0;
  st.settings.mixTime = t;
  if (st.engine && typeof st.engine.setMixTime === 'function') {
    try { st.engine.setMixTime(t); } catch { /* 版本不支持则只记状态 */ }
  }
  return t;
};

/**
 * 部件筛除：传入 { enabled, keywords }。
 * 引擎侧是 setSlotFilter(keywords) + 每帧 hideFilteredSlots/restoreFilteredSlots；
 * enabled=false 或关键词为空即清空（等价不过滤）。
 */
api.setPartFilter = ({ enabled, keywords }) => {
  const list = enabled ? (Array.isArray(keywords) ? keywords : []) : [];
  st.settings.partFilterEnabled = !!enabled;
  st.settings.partFilterKeywords = Array.isArray(keywords) ? keywords.slice() : [];
  if (st.engine && typeof st.engine.setSlotFilter === "function") {
    try { st.engine.setSlotFilter(list); } catch { /* 版本不支持则只记状态 */ }
  }
  // matched = 当前骨架里"真会被摘掉"的槽数（只读扫一遍，不改骨架）。
  //   与 applied 分开：applied 是关键词条数，若把它当"隐藏了几件"会把"关键词没命中"误读成"隐藏成功"。
  let matched = 0;
  if (st.engine && typeof st.engine.countFilterableSlots === 'function') {
    try { matched = st.engine.countFilterableSlots(list); } catch { matched = 0; }
  }
  return { enabled: !!enabled, applied: list.length, matched };
};
}

/** 相机视图入口：只读读数 + 薄转发（不换算） */
function attachViewApi(api, st) {
/** 相机统一入口（全部委托引擎原生方法，本文件不做任何坐标换算） */
st.camera = createStageCamera({ getEngine: () => st.engine });
api.camera = st.camera;

/** 只读视图读数：zoom 取引擎 userScale 与基准的比值，pan 用入口累计的屏幕位移 */
api.getView = () => viewOf(st);

/**
 * 兼容入口（交互层仍调用 setView）。这里**只转发**，不换算：
 *   · zoom → camera.zoomTo(基准 × 倍数)（倍乘即「相对 fit 的倍数」，clamp 由引擎负责）
 *   · panX/panY → camera.panBy(增量)，单位是屏幕像素，与旧端一致
 */
api.setView = (patch = {}) => {
  const camera = st.camera;
  if (!camera) return viewOf(st);
  if (typeof patch.zoom === 'number' && Number.isFinite(patch.zoom)) {
    const base = st.viewBaseScale || 1;
    camera.zoomTo(base * patch.zoom);
  }
  if (typeof patch.panX === 'number' || typeof patch.panY === 'number') {
    const cur = st.viewPan || { x: 0, y: 0 };
    const nx = typeof patch.panX === 'number' && Number.isFinite(patch.panX) ? patch.panX : cur.x;
    const ny = typeof patch.panY === 'number' && Number.isFinite(patch.panY) ? patch.panY : cur.y;
    if (nx !== cur.x || ny !== cur.y) {
      camera.panBy(nx - cur.x, ny - cur.y);
      st.viewPan = { x: nx, y: ny };
    }
  }
  return viewOf(st);
};

/** 视图复位：交给引擎 resetCamera 重新 fit，然后重取基准 */
  /**
   * 幂等入口：确保引擎实例已创建（只建上下文与相机，不加载模型）。
   * 谁需要：Live2D 分支要接管引擎的 Live2D 态（l2dActive 依赖 l2dModelId + 引擎实例），
   *   而引擎是懒创建的 —— 用户先点 Live2D 时还没有实例。
   * @returns {Promise<object|null>} 引擎实例
   */
  api.ensureEngineReady = async () => {
    if (st.engine) return st.engine;
    try {
      const Engine = await pickEngineCtor();
      if (!ensureStageEngine(st, Engine, st.canvas)) return null;
      return st.engine;
    } catch {
      return null;
    }
  };

api.resetView = () => {
  if (st.camera) st.camera.reset();
  captureViewBase(st);
  return viewOf(st);
};
}

/** 渲染相关：调试绘制、滤镜预设、MSAA 重建 */
function attachRenderApi(api, st) {
api.setDebug = (patch) => {
  const next = { ...(st.settings.debug || {}), ...(patch || {}) };
  st.settings.debug = next;
  if (st.engine && typeof st.engine.setDebugDraw === 'function') {
    try { st.engine.setDebugDraw(patch || {}); } catch { /* 版本不支持则只记状态 */ }
  }
  return next;
};

/** 切换滤镜预设（id 见引擎预设表；未知 id 由引擎回落原画） */
api.setFilter = (id) => {
  if (!st.engine || typeof st.engine.setFilter !== 'function') {
    // 与 applySettings 同一约定：引擎还没建时也要把设置记进快照，
    //   装载时由引擎按 settings.filter 应用 —— 否则启动阶段下发会静默丢失
    st.settings.filter = id;
    return id;
  }
  try {
    st.engine.setFilter(id);
    st.settings.filter = st.engine.getFilter ? st.engine.getFilter() : id;
    return st.settings.filter;
  } catch { return null; }
};

/**
 * 切换 MSAA：GL 的 antialias 只在建上下文时生效，必须换 canvas 节点重建。
 * 流程：换节点 → dispose 旧引擎 → init(antialias) → 重新加载最近一次的模型。
 * @param {boolean} on
 * @returns {Promise<{antialias:boolean, restoreMs:number, restored:boolean}>}
 */
api.rebuildWithAntialias = async (on) => {
  const arg = st.lastArg;
  const old = st.canvas;
  const next = old.cloneNode(false);
  old.replaceWith(next);
  st.canvas = next;
  try { if (st.engine && st.engine.dispose) st.engine.dispose(); } catch { /* 释放失败继续重建 */ }
  st.engine = null;
  st.model = null;
  st.disposes += 1; // 重建也计入释放次数，便于用 loads/disposes 判泄漏
  st.settings.msaa = on ? 'auto' : 'off';
  const t0 = performance.now();
  const Engine = await pickEngineCtor();
  const ok = ensureStageEngineWith(st, Engine, on);
  if (!ok) return { antialias: !!on, restoreMs: 0, restored: false };
  if (arg) await loadIntoStage(st, arg);
  return { antialias: !!on, restoreMs: Math.round(performance.now() - t0), restored: !!arg };
};
}

export function createSpineStage(opts) {
  const o = opts || {};
  if (!o.canvas) throw new Error('createSpineStage 需要 canvas');
  const onStatus = typeof o.onStatus === 'function' ? o.onStatus : () => {};
  const st = {
    canvas: o.canvas, lastArg: null,
    engine: null, seq: 0, loads: 0, disposes: 0, lastError: null,
    runtimeKeys: [], model: null, frames: 0, settings: { ...DEFAULT_SETTINGS },
  };
  const status = (patch) => { try { onStatus({ ...statsOf(st), ...patch }); } catch { /* 回调不影响渲染 */ } };
  const fail = (msg, cause) => {
    st.lastError = String(msg);
    status({ phase: 'error', error: st.lastError });
    return businessError(st.lastError, cause);
  };
  const api = buildStageApi(st, { status, fail });
  attachExtraApi(api, st);
  return api;
}
