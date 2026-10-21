// live2d/probe-geometry.js —— 只读诊断：模型运行时几何（inspectGeometry）
//
// 这一段是"取证型"代码：displayObject 尺寸 / 包围盒 / Cubism 画布尺寸 / clipping mask /
//   drawable 与 part 的可用 API 全部列出来，用于判断 fit 口径与"内容被框在矩形里"的成因。
//
// 为什么拆成这么多小函数：早期它是一个 128 行、圈复杂度 95 的大函数，读的人只能顺序扫下来
//   才知道每段在取证什么。现在按「取证哪一类事实」分组，每段只回答一个问题：
//     readBounds           模型包围盒
//     readCoreCanvas       Cubism 画布尺寸（coreModel.getCanvasWidth/Height）
//     readInternalSize     internalModel 的尺寸与原始尺寸
//     readFitRatios        两种 fit 口径的比值（判断该用哪个基准）
//     readClipProbe        clipping mask 相关字段（"内容被框住"的第一嫌疑）
//     readDrawableProbe    drawable / part 的可用 API 与顶点范围
//   inspectGeometry 只做编排与组装，保证**返回结构逐键不变**（它是 handle 上的对外方法）。
import { CAMERA } from '../render/camera/constants.js';

/** 取模型包围盒（getBounds 可能抛，抛了就当没有） */
function readBounds(model) {
  try {
    const bb = model.getBounds();
    if (!bb) return null;
    return { x: +bb.x.toFixed(2), y: +bb.y.toFixed(2), w: +bb.width.toFixed(2), h: +bb.height.toFixed(2) };
  } catch {
    return null;
  }
}

/** 取 Cubism 画布尺寸与 coreModel 引用 */
function readCoreCanvas(internal) {
  const core = internal && internal.coreModel;
  const hasW = core && typeof core.getCanvasWidth === 'function';
  const hasH = core && typeof core.getCanvasHeight === 'function';
  return {
    core,
    coreW: hasW ? core.getCanvasWidth() : null,
    coreH: hasH ? core.getCanvasHeight() : null,
  };
}

/** 取 internalModel 的尺寸（含未缩放的原始尺寸） */
function readInternalSize(internal) {
  if (!internal) return null;
  return { w: internal.width, h: internal.height, originalW: internal.originalWidth, originalH: internal.originalHeight };
}

/**
 * 两种 fit 口径的比值。
 *   当前实现用 getBounds 口径并乘 0.98（历史值，仅做对照，不重置模型）；
 *   期望口径是 Cubism 画布 + 常量边距。ratio 用来判断两者差多少。
 */
function readFitRatios(b, coreW, coreH, vpW, vpH) {
  const curFit = b && vpW && vpH ? Math.min(vpW / b.w, vpH / b.h) * 0.98 : null;
  const coreFit = coreW && coreH && vpW && vpH ? Math.min(vpW / coreW, vpH / coreH) * (1 - CAMERA.FIT_MARGIN) : null;
  return { curFit, coreFit, ratio: curFit && coreFit ? +(curFit / coreFit).toFixed(3) : null };
}

/** 在候选键里找一个"数组状"字段，返回 { key, len }（不同 Cubism 版本字段名不同） */
function pickArrayLike(obj, keys) {
  for (const k of keys) {
    try {
      const v = obj && obj[k];
      if (v && typeof v.length === 'number') return { key: k, len: v.length };
    } catch { /* 不可读字段 */ }
  }
  return null;
}

/** clipping 管理器上的两个"上下文列表"（mask / draw） */
function readClipLists(cm) {
  if (!cm) return { maskList: null, drawList: null };
  return {
    maskList: pickArrayLike(cm, ['_clippingContextListForMask', 'clippingContextListForMask', '_clippingContextList', 'clippingContextList']),
    drawList: pickArrayLike(cm, ['_clippingContextListForDraw', 'clippingContextListForDraw', '_clippingContextListForDraws']),
  };
}

/** 对象上与 clip|mask 有关的键名（判断字段是否换名） */
function clipKeyNames(obj) {
  if (!obj) return [];
  return Object.keys(obj).filter((k) => /clip|mask/i.test(k)).slice(0, 12);
}

/** clipping mask 取证：拿不到就报 err，拿到就只回字段值 */
function readClipProbe(internal) {
  try {
    const r = internal && internal.renderer;
    if (!r) return { err: 'no renderer' };
    const cm = r._clippingManager || r.clippingManager || null;
    const { maskList, drawList } = readClipLists(cm);
    return {
      hasClippingManager: !!cm,
      maskList,
      drawList,
      maskBufferSize: cm && cm._clippingMaskBufferSize != null ? cm._clippingMaskBufferSize : null,
      cmKeys: clipKeyNames(cm),
      rendererClipKeys: clipKeyNames(r),
      // 历史字段：曾想读网格数，目前恒为 null（保留键名不破坏对外结构）
      meshCount: null,
    };
  } catch (e) {
    return { err: String(e && e.message).slice(0, 80) };
  }
}

/** 取 part id（不同版本的返回值类型不同：字符串 / CubismString / 数字） */
function readPartId(raw, i) {
  try {
    if (typeof raw.getPartId !== 'function') return null;
    const id = raw.getPartId(i);
    if (!id) return null;
    if (typeof id === 'string') return id;
    if (typeof id.getString === 'function') return id.getString();
    if (id.s !== undefined) return String(id.s);
    return String(id);
  } catch {
    return null;
  }
}

/** 顶点范围（只算包围盒，用于判断 drawable 是否落在画布某一块） */
function readVertexBbox(raw, i, vertexCount) {
  if (typeof raw.getDrawableVertexPositions !== 'function' || !(vertexCount > 0)) return null;
  const v = raw.getDrawableVertexPositions(i);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let k = 0; k + 1 < v.length; k += 2) {
    const x = v[k], y = v[k + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { x: +minX.toFixed(3), y: +minY.toFixed(3), w: +(maxX - minX).toFixed(3), h: +(maxY - minY).toFixed(3) };
}

/** 读 drawable 的父 part 索引（API 不存在或抛错都当没有） */
function readParentPart(raw, i, has) {
  try {
    if (!has('getDrawableParentPartIndex')) return null;
    return raw.getDrawableParentPartIndex(i);
  } catch {
    return null;
  }
}

/** 单个 drawable 的取证条目 */
function readDrawableItem(raw, i, has) {
  const item = { i, parentPart: null, partId: null, vertexCount: null, bbox: null };
  item.parentPart = readParentPart(raw, i, has);
  if (item.parentPart != null && item.parentPart >= 0) item.partId = readPartId(raw, item.parentPart);
  try { if (has('getDrawableVertexCount')) item.vertexCount = raw.getDrawableVertexCount(i); } catch { /* 忽略 */ }
  try {
    const box = readVertexBbox(raw, i, item.vertexCount);
    if (box) item.bbox = box;
  } catch (e) {
    item.bboxErr = String(e && e.message).slice(0, 40);
  }
  return item;
}

/** coreModel 上哪些 API 可用（决定能取证到什么粒度） */
function readApiAvailability(has) {
  return {
    getDrawableCount: has('getDrawableCount'),
    getDrawableVertexPositions: has('getDrawableVertexPositions'),
    getDrawableVertexCount: has('getDrawableVertexCount'),
    getDrawableParentPartIndex: has('getDrawableParentPartIndex'),
    getPartCount: has('getPartCount'),
    getPartId: has('getPartId'),
  };
}

/** 枚举对象自身可枚举的方法（对象上可能有会抛的 getter，逐个兜住） */
function listOwnMethods(obj) {
  const names = [];
  try {
    for (const k in obj) {
      try { if (typeof obj[k] === 'function') names.push(k); } catch { /* 不可读字段 */ }
    }
  } catch { /* 整体不可枚举 */ }
  return names;
}

/** 收集某一层原型上的方法名（该层不可读就返回空） */
function collectProtoNames(obj, proto) {
  const names = [];
  try {
    Object.getOwnPropertyNames(proto).forEach((n) => {
      try { if (typeof obj[n] === 'function') names.push(n); } catch { /* 不可读字段 */ }
    });
  } catch { /* 该层原型不可读 */ }
  return names;
}

/** 沿原型链追加方法名（层数有上限，避免异常对象拖死） */
function listProtoMethods(obj, names) {
  let proto = null;
  try { proto = Object.getPrototypeOf(obj); } catch { proto = null; }
  let guard = 0;
  while (proto && proto !== Object.prototype && guard < 4) {
    names.push(...collectProtoNames(obj, proto));
    try { proto = Object.getPrototypeOf(proto); } catch { proto = null; }
    guard += 1;
  }
  return names;
}

/** 收集对象自身 + 原型链上的方法名 */
function collectMethodNames(obj) {
  return listProtoMethods(obj, listOwnMethods(obj));
}

/** 枚举一个对象（含原型链）上"看起来与几何相关"的方法名，用于发现未公开的 API */
function probeMethodNames(obj, label, depth) {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  const names = collectMethodNames(obj);
  const hit = [...new Set(names)].filter((n) => /draw|part|texture|vertex|canvas|bounds|geometry/i.test(n));
  return {
    label,
    ctor: obj.constructor ? obj.constructor.name : typeof obj,
    methodCount: names.length,
    matched: hit.slice(0, 18),
  };
}

/** 列出几个可能的 API 宿主对象，逐个枚举方法（只读，用于定位未公开接口） */
function readApiPaths(core, internal) {
  const out = [];
  const targets = [
    [core, 'coreModel', 0],
    [core && core._model, 'coreModel._model', 1],
    [core && core._model && core._model._model, 'coreModel._model._model', 2],
    [core && core._model && core._model.drawables, 'coreModel._model.drawables', 2],
    [internal && internal.renderer, 'internalModel.renderer', 1],
  ];
  for (const [obj, label, depth] of targets) {
    const hit = probeMethodNames(obj, label, depth);
    if (hit) out.push(hit);
  }
  return out;
}

/** 取 coreModel 上真正带 API 的 raw 对象（不同版本挂载层级不同） */
function readRawCore(internal) {
  const core = internal && internal.coreModel;
  if (!core) return null;
  return core._model ? core._model : core;
}

/** part id 列表（上限 12 个，够判断命名风格即可） */
function readPartIds(raw, partCount) {
  const partIds = [];
  const max = Math.min(partCount || 0, 12);
  for (let i = 0; i < max; i += 1) partIds.push(readPartId(raw, i));
  return partIds;
}

/** drawable 取证条目（上限 8 个） */
function readDrawableSamples(raw, count, has) {
  const sample = [];
  const max = Math.min(count || 0, 8);
  for (let i = 0; i < max; i += 1) sample.push(readDrawableItem(raw, i, has));
  return sample;
}

/** drawable / part 取证（主体包围盒问题的第二嫌疑） */
function readDrawableProbe(internal) {
  try {
    const raw = readRawCore(internal);
    if (!raw) return { err: 'no coreModel' };
    const has = (k) => typeof raw[k] === 'function';
    const count = has('getDrawableCount') ? raw.getDrawableCount() : null;
    const partCount = has('getPartCount') ? raw.getPartCount() : null;
    return {
      coreType: raw.constructor ? raw.constructor.name : typeof raw,
      drawableCount: count,
      partCount,
      partIds: readPartIds(raw, partCount),
      api: readApiAvailability(has),
      sample: readDrawableSamples(raw, count, has),
      apiPaths: readApiPaths(internal && internal.coreModel, internal),
    };
  } catch (e) {
    return { err: String(e && e.message).slice(0, 80) };
  }
}

/**
 * 创建几何取证模块。
 * @param {object} ctx 运行时上下文
 * @returns {{inspectGeometry:Function}}
 */
export function createProbeGeometry(ctx) {
  const { st, surfaceSize } = ctx;

  /**
   * 只读：模型运行时几何（**不触发任何重排**）。
   *
   * 返回结构是对外契约（handle.inspectGeometry），键名与嵌套形状不得变化：
   *   display / bounds / coreCanvas / internalSize / viewport /
   *   fitByBounds / fitByCore / ratio / clipProbe / drawableProbe
   * @returns {object|null}
   */
  function inspectGeometry() {
    const model = st.model;
    if (!model) return null;
    const b = readBounds(model);
    const internal = model.internalModel || null;
    const { core, coreW, coreH } = readCoreCanvas(internal);
    const size = surfaceSize();
    const vpW = size ? size.width : null;
    const vpH = size ? size.height : null;
    const { curFit, coreFit, ratio } = readFitRatios(b, coreW, coreH, vpW, vpH);
    void core;
    return {
      display: { w: model.width, h: model.height, scale: model.scale ? +model.scale.x.toFixed(4) : null, x: model.x, y: model.y },
      bounds: b,
      coreCanvas: { w: coreW, h: coreH },
      internalSize: readInternalSize(internal),
      viewport: { w: vpW, h: vpH },
      fitByBounds: curFit,
      fitByCore: coreFit,
      ratio,
      clipProbe: readClipProbe(internal),
      drawableProbe: readDrawableProbe(internal),
    };
  }

  return { inspectGeometry };
}
