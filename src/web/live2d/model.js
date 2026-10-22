// live2d/model.js —— 模型装载与动作表
//
// 装载顺序有讲究（历史上踩过 BUG-3）：
//   先 showOverlay 让覆盖层可见 → 再建 PIXI。反过来的话 PIXI 在 display:none 下读到
//   0 尺寸、停在默认 800×600，首次可见时若不重新校准就只剩一块"内容矩形"。
//
// 动作表来自 model3.json（fetchDefinition），不用接口元数据 —— 那里 motions/expressions 是空的。
//
// 内部文件（moc3 / 贴图 / physics / 动作）优先走 VirtualFS（见 vfs-settings.js），
//   库不支持或语义变化时**回落 URL 路径**（可退化，绝不白屏）。
//
// 结构：所有函数都在模块级、只接收 ctx/显式参数（工厂里不再嵌一堆闭包），
//   这样每个函数都能单独审阅，工厂只做装配。
import { createVfsSettings } from './vfs-settings.js';

// ---------------------------------------------------------------- 纯函数

/** 从 model3.json 里取动作/表情表 */
function definitionParts(json) {
  const ref = (json && json.FileReferences) || {};
  return {
    motions: ref.Motions || {},
    expressions: (ref.Expressions || []).map((e, i) => ({ name: (e && e.Name) || `exp${i + 1}` })),
  };
}

/** 动作条目的名字（兼容字符串 / { Name } / { File } 三种写法） */
function motionNameOf(mo) {
  if (typeof mo === 'string') return mo;
  if (!mo) return '';
  return String(mo.Name || mo.File || '');
}

/** 动作标签：`group / 文件名去后缀`（.motion3 / .motion3.json / .json 都算） */
function motionLabel(group, name) {
  const base = String(name || '').split('/').pop().replace(/\.motion3(\.json)?$/i, '').replace(/\.json$/i, '');
  return `${group} / ${base}`;
}

/** 采样点统计：总数与非透明点数 */
function probeSummary(probe) {
  const list = probe || [];
  return { total: list.length, opaque: list.filter((x) => x.rgba && x.rgba[3] > 0).length };
}

// ---------------------------------------------------------------- 定义 / 动作表

/**
 * 读模型定义（model3.json）：动作表 + 原始 json（后者是 vfs-settings 的原料）。
 * 读失败不抛：动作列表为空但装载仍可继续。
 */
async function fetchDefinition(ctx, model) {
  const raw = ctx.entryUrlOf(model);
  const url = raw ? ctx.resolveAsset(raw) : null;
  if (!url) return { motions: {}, expressions: [], json: null };
  try {
    const json = await (await fetch(url)).json();
    return { ...definitionParts(json), json };
  } catch (err) {
    ctx.note(`模型定义读取失败（动作列表将为空）：${err && err.message}`, 'warn');
    return { motions: {}, expressions: [], json: null };
  }
}

/**
 * 按 meta.motions 重建标签表（idle 排最前；同名追加 #n）。
 * @returns {string[]} 标签列表
 */
function buildMotionMap(st, meta) {
  st.motionMap = new Map();
  const motions = (meta && meta.motions) || {};
  const groups = Object.keys(motions);
  groups.sort((a, b) => (a === 'idle' ? -1 : b === 'idle' ? 1 : 0));
  for (const group of groups) {
    (motions[group] || []).forEach((mo, index) => {
      let label = motionLabel(group, motionNameOf(mo));
      if (st.motionMap.has(label)) label = `${label} #${index + 1}`;
      st.motionMap.set(label, { group: String(group), index });
    });
  }
  return [...st.motionMap.keys()];
}

/** 动作标签全集 */
function motionLabels(st) {
  return [...st.motionMap.keys()];
}

// ---------------------------------------------------------------- 舞台准备

/** 清掉上一个模型（同一覆盖层只留一个） */
function detachPrevious(st, app) {
  if (!st.model) return;
  try { app.stage.removeChild(st.model); } catch { /* 忽略 */ }
  try { st.model.destroy({ children: true }); } catch { /* 忽略 */ }
  st.model = null;
}

/**
 * 准备阶段：运行时库 → 覆盖层可见 → PIXI app（顺序决定 BUG-3 是否复现）。
 * @returns {Promise<object>} PIXI app
 */
async function prepareStage(ctx) {
  await ctx.api.pixiApp.ensureLibs();
  ctx.api.overlay.showOverlay();
  const app = await ctx.api.pixiApp.ensureApp();
  detachPrevious(ctx.st, app);
  return app;
}

// ---------------------------------------------------------------- 实例创建（VFS 优先）

/** 构造 VFS settings（缺定义 / 缺 vfs 时返回 null） */
function buildVfsSettingsOrNull(ctx, def, entryUrl) {
  if (!def || !def.json) return null;
  return createVfsSettings({ json: def.json, entryUrl, vfs: ctx.vfs, log: ctx.note });
}

/** settings 不可用时的 warn（reason 说明为什么没启用） */
function warnSettingsUnavailable(note, via) {
  if (via && via.reason) note(`VFS settings 未启用（${via.reason}），走 URL 路径`, 'warn');
}

/**
 * VFS 分支：建实例成功就返回实例，任何异常都返回 null（交给调用方回落）。
 * **降级语义（防白屏兜底），改这里时不许丢**：
 *   ① settings 构造器 / resolveURL 不存在 → warn + null
 *   ② 库升级导致 resolveURL 一次都没被调用 → 当失败处理 + warn + null
 *   ③ 装载抛错 → warn + null
 * @returns {Promise<object|null>}
 */
async function tryVfsInstance(ctx, def, entryUrl) {
  const via = buildVfsSettingsOrNull(ctx, def, entryUrl);
  if (!via || !via.settings) {
    warnSettingsUnavailable(ctx.note, via);
    return null;
  }
  try {
    const inst = await PIXI.live2d.Live2DModel.from(via.settings, { autoInteract: false });
    if (!via.stats.calls) throw new Error('resolveURL 未被调用');
    ctx.st.vfsStats = via.stats;
    ctx.note(`Live2D 内部资源经 VFS：命中 ${via.stats.hits.length} 项，回落 ${via.stats.missing.length} 项`);
    return inst;
  } catch (e) {
    ctx.note(`VFS 装载失败，回落 URL 路径：${(e && e.message) || e}`, 'warn');
    return null;
  }
}

/** 建实例：内部文件优先走 VFS，不可用时回落 URL 路径（行为与改造前一致） */
async function createInstance(ctx, def, entryUrl, url) {
  const inst = await tryVfsInstance(ctx, def, entryUrl);
  if (inst) return inst;
  ctx.st.vfsStats = null;
  return PIXI.live2d.Live2DModel.from(url, { autoInteract: false });
}

// ---------------------------------------------------------------- 挂载与收尾

/**
 * 挂上实例并写入"当前模型"状态。
 * modelUrl 记成**实际使用的入口**（可能是 vfs://）：动作时长与动作文件的相对路径都以它为基准，
 *   沿用原始 http 目录会让这些引用跑去网络（VFS misses 虚高、动作文件不从内存出）。
 * @returns {string[]} 动作标签
 */
function attachInstance(ctx, instance, app, model, def, entryUrl) {
  const { st } = ctx;
  app.stage.addChild(instance);
  st.model = instance;
  st.modelId = model.id;
  st.zoomRatio = 1;
  st.panX = 0;
  st.panY = 0;
  st.meta = {
    ...model,
    modelUrl: entryUrl || model.modelUrl,
    motions: def.motions,
    expressions: def.expressions,
  };
  return buildMotionMap(st, st.meta);
}

/**
 * 清屏自检：模型以外区域必须透明，否则不透明底色会把 CSS 背景盖住
 *   （真机表现就是"内容被框在矩形里"，以前只能靠人眼发现）。
 */
async function checkClearTransparency(ctx) {
  const size = ctx.surfaceSize ? ctx.surfaceSize() : null;
  const pts = [[8, 8], [ctx.width8(), 8], [8, ctx.height8()], [Math.floor((size ? size.width : 1920) / 2), 8]];
  try {
    const { total, opaque } = probeSummary(await ctx.api.probe.readCanvasPixels(pts));
    if (total && opaque === total) ctx.note(`画布清屏不透明（${opaque}/${total} 点 alpha>0），CSS 背景会被遮住`, 'warn');
    else ctx.note(`画布清屏自检通过（${total - opaque}/${total} 点透明）`);
  } catch { /* 自检失败不影响渲染 */ }
}

/** 首帧后采一次 diff 基线（只采一次，避免污染时序；模型已换则放弃） */
function collectBaseline(ctx, instance) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (ctx.st.model !== instance) return;
    try { ctx.api.probe.collectCmp('default'); } catch { /* 采集失败不影响渲染 */ }
  }));
}

/**
 * 装载并显示一个 Live2D 模型（只做编排）。
 * @param {object} ctx 运行时上下文
 * @param {object} model 条目（含 id / name / entry.url 或 modelUrl）
 * @returns {Promise<{labels:string[], expressions:string[], instance:object}>}
 */
async function loadModel(ctx, model) {
  const app = await prepareStage(ctx);
  const entryUrl = ctx.entryUrlOf(model);
  const url = ctx.resolveAsset(entryUrl);
  if (!url) throw new Error(`Live2D 模型缺少入口地址（entry.url）：${model && model.name}`);
  const t0 = performance.now();
  const def = await fetchDefinition(ctx, model);
  const instance = await createInstance(ctx, def, entryUrl, url);
  const labels = attachInstance(ctx, instance, app, model, def, entryUrl);
  if (typeof app.start === 'function') app.start();
  ctx.api.pixiApp.fitAppToOverlay();
  ctx.api.view.applyZoom();
  ctx.st.active = true;
  await checkClearTransparency(ctx);
  ctx.note(`Live2D 已渲染 ${model.name}（Cubism ${model.cubism || '?'}，动作 ${labels.length}，表情 ${def.expressions.length}，`
    + `耗时 ${Math.round(performance.now() - t0)}ms）`);
  collectBaseline(ctx, instance);
  return { labels, expressions: def.expressions.map((e) => e.name), instance };
}

/**
 * 创建模型模块（只做装配）。
 * @param {object} ctx 运行时上下文
 * @returns {{fetchDefinition:Function, motionNameOf:Function, motionLabel:Function, buildMotionMap:Function, motionLabels:Function, loadModel:Function}}
 */
export function createModel(ctx) {
  return {
    fetchDefinition: (model) => fetchDefinition(ctx, model),
    motionNameOf,
    motionLabel,
    buildMotionMap: (meta) => buildMotionMap(ctx.st, meta),
    motionLabels: () => motionLabels(ctx.st),
    loadModel: (model) => loadModel(ctx, model),
  };
}
