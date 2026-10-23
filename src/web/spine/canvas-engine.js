// spine/canvas-engine.js —— 引擎生命周期与装载流程
//
// 职责：建引擎（含抗锯齿重建）、装载骨架、启动/停止播放循环、卸载模型。
// 为什么单独成模块：这里是唯一持有/销毁 WebGL 上下文的地方（契约 §五-7 的落点），
//   卸载语义（unload 保留引擎 / dispose 销毁引擎）必须能在一屏内读完。

import { installRuntimeManager } from './runtimes.js';
import { abortedError, buildDescriptor, businessError, resolveDocument } from './canvas-document.js';
import { availableVersions, ensureRuntimeSource, pickEngineCtor, pickRuntimeVersion } from './canvas-runtime.js';
import { captureViewBase } from './canvas-view.js';

/** 应用设置（全部走 engine 的 setter，缺哪个就跳过哪个） */
export function applySettings(st, patch) {
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
export function unloadModel(st) {
  const e = st.engine;
  st.model = null;
  st.seq++; // 让在途加载失效
  if (!e) return;
  try { e.stop(); } catch { /* 已停止 */ }
  try { if (e.clearSkeleton) e.clearSkeleton(); } catch { /* 清理失败不阻塞 */ }
  st.disposes++;
}

/** 首次进入时创建 engine；canvas 尺寸变化由 engine 的 refreshResolution 处理 */
export function ensureStageEngine(st, Engine, canvas) {
  if (st.engine) return true;
  // 不写死 antialias：交给 ensureStageEngineWith 按 settings.msaa 决定（默认自动=开）
  return ensureStageEngineWith(st, Engine, undefined, canvas);
}

/** 建引擎；antialias 只在此时能生效（换画布重建时传 true） */
export function ensureStageEngineWith(st, Engine, antialias, canvasOverride) {
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

/**
 * 帧计数循环（验收口径：stats().frames 必须真实反映"画面在推进"）。
 *
 * 为什么可暂停：暂停后仍每帧跑一遍这条 rAF 纯烧 CPU（部署机无 GPU、纯软件 WebGL），
 *   而它只是计数循环，与引擎是否绘制无关。暂停时**停掉循环本身**，恢复时重启。
 * 单实例保证：用 st.frameRaf 记录句柄，已在跑就直接返回，避免重复排帧。
 * @param {object} st 舞台内部状态
 */
export function startFrameTick(st) {
  if (st.frameRaf) return;               // 已在跑：绝不重复启动
  const tick = () => {
    st.frameRaf = 0;
    if (!st.model || st.model !== st.frameInfo) return;   // 模型已换/卸载：自然结束
    if (st.paused) return;                                // 暂停：不再排帧（resume 时重启）
    st.frames++;
    st.frameRaf = requestAnimationFrame(tick);
  };
  st.frameRaf = requestAnimationFrame(tick);
}

/**
 * 单帧重绘（暂停中按需渲染的唯一入口）。
 * 引擎在 stop() 之后不会自己画，而交互/改设置/切动作都改了状态 ⇒ 必须显式补一帧，
 * 否则"暂停"会变成"点了没反应"。
 * @param {object} st 舞台内部状态
 * @returns {boolean} 是否成功请求到一次绘制
 */
export function repaintOnce(st) {
  const e = st && st.engine;
  if (!e) return false;
  try {
    // 按需渲染也算一帧：frames 的语义是"真的画了一次"，暂停期间的交互/改设置都体现在这里
    if (typeof e.requestRender === 'function') { e.requestRender(); st.frames += 1; return true; }
    if (typeof e.presentFirstFrame === 'function') { e.presentFirstFrame(); st.frames += 1; return true; }
  } catch { /* 引擎不支持就放弃 */ }
  return false;
}

/** 停掉帧计数循环（暂停/卸载时调用） */
export function stopFrameTick(st) {
  if (st.frameRaf) { try { cancelAnimationFrame(st.frameRaf); } catch { /* 忽略 */ } }
  st.frameRaf = 0;
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
  st.frameInfo = info;
  startFrameTick(st);
  return { animations: anims, motion };
}

/** 加载主流程（编排：校验 Document → 选版本 → 注入源码 → 建 engine → 加载 → 起播） */
export async function loadIntoStage(st, arg) {
  // 入参只有一种形状：{ document }（ready）。资源地址与字节都在组装阶段备好，本层不取。
  const doc = resolveDocument(st, arg);
  const model = doc;
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
  // 版本来自 Document 的 meta（Document 形状里没有顶层 version）：
  //   读错会挑到不匹配的运行时 —— 表现为骨架解析报 "Bone name must not be null" 这类怪错
  const ver = pickRuntimeVersion((doc.meta && doc.meta.version) || doc.version, avail);
  if (!ver) throw businessError('无法确定该模型的 Spine 版本：元数据缺少 version，且运行时清单不可用');
  await ensureRuntimeSource(ver);
  if (seq !== st.seq) throw abortedError();
  if (seq !== st.seq) throw abortedError();
  if (!ensureStageEngine(st, Engine, st.canvas)) throw businessError('当前环境没有可用的 WebGL，无法渲染 Spine');
  if (!st.runtimeKeys.includes(ver)) st.runtimeKeys.push(ver);
  st.loads++;
  const info = await st.engine.loadModel(buildDescriptor(doc, ver));
  if (seq !== st.seq) throw abortedError();
  if (!info) throw businessError('模型加载失败（引擎未返回结果）');
  st.lastArg = arg; // 供 MSAA 重建上下文后恢复同一模型
  captureViewBase(st); // 新模型 fit 完成：把当前取景记为视图基准
  const playing = startPlayback(st, info, st.settings.loop);
  return { version: ver, animations: playing.animations, motion: playing.motion };
}
