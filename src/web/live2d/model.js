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
// 模型实例统一经 adapter 建；URL 回落路径的 vfs→blob 转换也在那边（与 spine 侧共用同一套 VFS.resolve）
//   重命名：本文件自己导出一个 createModel(ctx)（对外 API），别与 adapter 的同名函数撞
import { createModel as createModelInstance } from './runtime-adapter.js';

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

/**
 * 动作标签 = **动作名**（文件名去后缀；.motion3 / .motion3.json / .json 都算）。
 *
 * 为什么不带 group 前缀：Cubism 的动作文件名通常与 group 同名，拼出来就是
 *   `idle / idle` 这种自我重复，与 Spine 面的"名称"不一致；group 仍保留在
 *   motionMap 的 value 里用于播放，不丢信息。
 */
function motionLabel(_group, name) {
  return String(name || '').split('/').pop().replace(/\.motion3(\.json)?$/i, '').replace(/\.json$/i, '');
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
  // 定义由 Document 带来（meta.extras.json）：渲染器不再自己读模型定义文件。
  // 没有定义时降级为空动作表（留一条 warn），**不发请求** —— 取资源是 Assets 层的职责。
  const inline = model && model.meta && model.meta.extras && model.meta.extras.json;
  if (!inline) {
    ctx.note('模型定义未随 Document 提供（动作列表为空）', 'warn');
    return { motions: {}, expressions: [], json: null };
  }
  return { ...definitionParts(inline), json: inline };
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
      // 同名动作（不同 group 或同 group 多个 motion）用 _2/_3 区分，**不丢条目**
      const base = motionLabel(group, motionNameOf(mo));
      let label = base;
      let n = 2;
      while (st.motionMap.has(label)) label = `${base}_${n++}`;
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

/** 构造 VFS settings（缺定义 / 缺 vfs / **散目录模型** 时返回 null） */
function buildVfsSettingsOrNull(ctx, def, entryUrl) {
  if (!def || !def.json) return null;
  // 散目录模型（entryUrl 是 http 路径、不是 vfs://）**不装** VFS resolver：
  //   VFS 只登记容器产物（注册点只有 infra/plugin-host.js，prefix 契约 vfs://<provider>/<root>/…），
  //   散目录模型的每个内部文件去查它**必然 miss** —— 白跑一次查找 + 每个文件刷一条 warn，
  //   会把"容器真缺文件"这类真问题淹掉（实测：散目录模型 命中 0 / 回落 3；容器模型 命中 4 / 回落 0）。
  // 返回 null 在这里是**正常状态**、不是异常：调用方看到 null 直接走原生 URL 路径
  //   （对散目录模型来说网络本来就是唯一正确来源），而且不会打 warn ——
  //   warnSettingsUnavailable 只在 via.reason 存在时才说话，null 没有 reason。
  // 真正该 warn 的情况仍会 warn：entryUrl 是 vfs:// 但 vfs 缺失/不可用（由 createVfsSettings 的 reason 报）。
  //
  // ⚠️ 这条路的**已知代价**（接受，别当 bug 去"优化"）：
  //   settings 分支是用**已经 fetch 好的** model3.json 构造的（不再请求入口文件）；
  //   走原生 URL 分支时 `Live2DModel.from(url)` 会让库**自己再取一次 model3.json**。
  //   实测：散目录模型内部资源 18 条（去重后与改前完全一致）+ 多一次入口请求（2308 字节）。
  //   因为 /files/* 带 `Cache-Control: no-store`，这一次是真请求（不是缓存命中），
  //   但同源/局域网、2.3KB、一次装载一次 —— 换来的是少一层"必然 miss 的查找"和一条噪音 warn。
  //   若将来要省掉这次请求，正确做法是**改回 settings 分支并把 warn 降级**，而不是在这里加缓存分支。
  if (!/^vfs:\/\//i.test(String(entryUrl || ''))) return null;
  return createVfsSettings({ json: def.json, entryUrl, vfs: ctx.vfs, log: ctx.note });
}

/** settings 不可用时的 warn（reason 说明为什么没启用） */
function warnSettingsUnavailable(note, via) {
  if (via && via.reason) note(`VFS settings 未启用（${via.reason}），走 URL 路径`, 'warn');
}

/**
 * 把「VFS 命中/回落」发布到 `<html data-vfs-stats>`，供机器读取（api-verifiable-frontend 的落地）。
 *
 * 为什么需要：stats 原本只赋给 `st.vfsStats`，全仓没有任何读取方 ——
 *   唯一的出口是那条 info 日志，排查时只能翻日志。挂 dataset 后
 *   `document.documentElement.dataset.vfsStats` 就是 `{"hit":4,"miss":0}`，脚本/面板都能直接读。
 * 传 null 表示清掉（切模型 / 回落 URL 路径 / 释放）。
 * 命名与既有 dataset 一致（camelCase：transportMotion / memoryGuard / screenshot）。
 */
function publishVfsStats(stats) {
  try {
    const el = typeof document !== 'undefined' ? document.documentElement : null;
    if (!el) return;
    if (!stats) delete el.dataset.vfsStats;
    else el.dataset.vfsStats = JSON.stringify({ hit: stats.hits.length, miss: stats.missing.length });
  } catch { /* dataset 只是可观测性，失败绝不影响装载 */ }
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
    const inst = await createModelInstance(via.settings, { autoInteract: false });
    if (!via.stats.calls) throw new Error('resolveURL 未被调用');
    ctx.st.vfsStats = via.stats;
    publishVfsStats(via.stats);
    ctx.note(`Live2D 内部资源经 VFS：命中 ${via.stats.hits.length} 项，回落 ${via.stats.missing.length} 项`);
    return inst;
  } catch (e) {
    ctx.note(`VFS 装载失败，回落 URL 路径：${(e && e.message) || e}`, 'warn');
    return null;
  }
}

/**
 * 建实例：内部文件优先走 VFS，不可用时回落 URL 路径。
 *
 * 回落路径**也必须**把 vfs:// 换成可 fetch 的 blob：库不认识自定义协议，
 *   直接喂 vfs:// 会 `Failed to construct 'URL': Invalid URL`。
 *   这条是"库版本不支持时的唯一退路"，退路本身不能是坏的。
 *   转换函数注入给 adapter，复用同一个 VFS 句柄（不在这里另建解析器）。
 */
async function createInstance(ctx, def, entryUrl, url) {
  const inst = await tryVfsInstance(ctx, def, entryUrl);
  if (inst) return inst;
  ctx.st.vfsStats = null;
  publishVfsStats(null);   // 回落 URL 路径：清掉上一次的读数，别让 dataset 说谎
  const vfs = ctx.vfs;
  return createModelInstance(url, {
    autoInteract: false,
    resolveVfs: (raw) => {
      const text = String(raw == null ? '' : raw);
      try {
        if (vfs && typeof vfs.resolve === 'function') {
          const hit = vfs.resolve(text);
          if (hit) return hit;
        }
      } catch { /* 解析失败按"不可用"处理，由 adapter 抛明确错误 */ }
      // 不是 vfs:// 的地址（散目录模型的 /files/… 或 http 绝对地址）**本来就是可 fetch 的**，原样交回。
      //   必要性：adapter.createModel 对 URL 形态要求 resolveVfs 返回非空，否则抛
      //   「模型地址无法解析」——散目录模型在 B1 之后正是走这条分支，不原样返回就会卡在 loading。
      //   对 vfs:// 仍返回 null（保持"解析不出来就是坏地址"的原语义，交给 adapter 报错）。
      return /^vfs:\/\//i.test(text) ? null : text;
    },
  });
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
    // 动作时长来自 Document（Assets 层预取）；桥接层按"标签 → 动作文件"查这张表
    motionDurations: (model && model.meta && model.meta.motionDurations) || {},
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
  // 入口地址优先取 Document.assets.entry.url（已由 Assets 层经 VirtualFS 解析）
  // 优先 ref（解析前的原始地址，可能是 vfs://）：settings.url 与内部相对引用都以它为基址，
  //   换成解析后的 blob 会让 url.resolve 拼出 blob:http://…/motions/x 这种无效地址。
  const entryAsset = (model && model.assets && model.assets.entry) || {};
  const entryUrl = entryAsset.ref || entryAsset.url || ctx.entryUrlOf(model);
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
