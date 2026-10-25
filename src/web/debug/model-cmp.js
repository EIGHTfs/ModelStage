// model-cmp.js —— 逐模型差异采集（诊断专用，不改任何渲染行为）
//
// 依据：docs/设计/相机.md 第 4 节。
// 为什么用 extract 而不是 readPixels：Live2D 的 PIXI 画布是 preserveDrawingBuffer=false，
//   直接 readPixels 全 0，不能当证据；extract.canvas 走离屏渲染，拿到的是"实际画出来的结果"。
//
// 判定思路（本轮核心）：把画布四边内侧与"美术包围盒之外、画布之内"的 alpha 采出来 ——
//   outsideArtAlphaRatio > 0.01 ⇒ 画布被我们涂满了（渲染侧问题）；
//   = 0 ⇒ 边缘本身就是美术内容。

/** 判定「有内容」的 alpha 阈值（0-255） */
const ALPHA_ART = 8;
/** 像素分析的最大边长（降采样上限，控制单次 getImageData 的内存） */
const MAX_ANALYZE = 1024;
/** 四边内侧采样带宽（像素） */
const EDGE_BAND = 2;

/**
 * 把 extract 出来的 canvas 画到离屏 2D 画布上并读像素（extract 的 canvas 可能不可直接 getImageData）。
 * @param {HTMLCanvasElement} cv
 * @returns {{data: Uint8ClampedArray, w: number, h: number}|{error: string}}
 */
function readPixelsOf(cv) {
  const w = Math.max(1, Math.round(cv.width || 0));
  const h = Math.max(1, Math.round(cv.height || 0));
  // 降采样后再读像素：6000×6000 的画布一次 getImageData 就是 144MB，多状态会拖死页面。
  //   只缩不放（≤ MAX_ANALYZE），比值类指标（opaqueRatio / outsideArtAlphaRatio / 四边 alpha）不受影响；
  //   长度类指标按 scaleBack 换回原画布单位，保证不同模型之间可比。
  const scale = Math.min(1, MAX_ANALYZE / Math.max(w, h));
  const aw = Math.max(1, Math.round(w * scale));
  const ah = Math.max(1, Math.round(h * scale));
  try {
    const off = document.createElement('canvas');
    off.width = aw;
    off.height = ah;
    const ctx = off.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, aw, ah);
    ctx.drawImage(cv, 0, 0, w, h, 0, 0, aw, ah);
    const data = ctx.getImageData(0, 0, aw, ah).data;
    // 立刻释放大画布：6000×6000 的 backing store 约 144MB，多模型多状态不释放会拖死标签页
    try { cv.width = 1; cv.height = 1; } catch { /* 忽略 */ }
    return { data, w: aw, h: ah, srcW: w, srcH: h, scaleBack: w / aw };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

/** 不透明像素包围盒 + 不透明占比 */
function measureBBox(data, w, h) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let opaque = 0;
  for (let y = 0; y < h; y += 1) {
    const row = y * w * 4;
    for (let x = 0; x < w; x += 1) {
      if (data[row + x * 4 + 3] > ALPHA_ART) {
        opaque += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const empty = maxX < minX || maxY < minY;
  return {
    bboxX: empty ? 0 : minX,
    bboxY: empty ? 0 : minY,
    bboxW: empty ? 0 : maxX - minX + 1,
    bboxH: empty ? 0 : maxY - minY + 1,
    opaqueRatio: +(opaque / (w * h)).toFixed(4),
  };
}

/** 四边内侧 alpha 均值（判断"边缘是否被涂色"） */
function measureEdges(data, w, h) {
  const avgOf = (x0, x1, y0, y1) => {
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        sum += data[(y * w + x) * 4 + 3];
        n += 1;
      }
    }
    return n ? +(sum / n / 255).toFixed(4) : 0;
  };
  const bx = Math.min(EDGE_BAND, w);
  const by = Math.min(EDGE_BAND, h);
  return {
    top: avgOf(0, w, 0, by),
    bottom: avgOf(0, w, h - by, h),
    left: avgOf(0, bx, 0, h),
    right: avgOf(w - bx, w, 0, h),
  };
}

/** 美术包围盒之外、画布之内的平均 alpha（本轮的关键指标） */
function measureOutsideArt(data, w, h, bbox) {
  const { bboxX, bboxY, bboxW, bboxH } = bbox;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y += 1) {
    const inY = y >= bboxY && y < bboxY + bboxH;
    const row = y * w * 4;
    for (let x = 0; x < w; x += 1) {
      if (inY && x >= bboxX && x < bboxX + bboxW) continue;
      sum += data[row + x * 4 + 3];
      n += 1;
    }
  }
  return n ? +(sum / n / 255).toFixed(4) : 0;
}

/**
 * 分析一张 extract 出来的画布。
 * @param {HTMLCanvasElement} cv
 * @returns {object} { w, h, bboxW, bboxH, bboxX, bboxY, opaqueRatio, edgeAlpha, outsideArtAlphaRatio } 或 { *_error }
 */
export function analyzeExtractCanvas(cv) {
  const px = readPixelsOf(cv);
  if (px.error) return { w: cv.width, h: cv.height, extract_error: px.error };
  const bbox = measureBBox(px.data, px.w, px.h);
  const back = px.scaleBack || 1;
  return {
    w: px.srcW,
    h: px.srcH,
    bboxX: Math.round(bbox.bboxX * back),
    bboxY: Math.round(bbox.bboxY * back),
    bboxW: Math.round(bbox.bboxW * back),
    bboxH: Math.round(bbox.bboxH * back),
    opaqueRatio: bbox.opaqueRatio,
    edgeAlpha: measureEdges(px.data, px.w, px.h),
    outsideArtAlphaRatio: measureOutsideArt(px.data, px.w, px.h, bbox),
    analyzeW: px.w,
    analyzeH: px.h,
  };
}

/** 落盘通道：POST /api/diag，tag=MODELCMP（失败静默，绝不影响页面） */
function postDiag(rec) {
  try {
    fetch('/api/diag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 带上本页 sid：否则这些条目落到 anonymous 会话，GET /api/diag?sid=… 取不到
      body: JSON.stringify({ sid: (typeof window !== 'undefined' && window.__DIAG__ && window.__DIAG__.sid) || undefined, entries: [{ ts: Date.now(), level: 'info', tag: 'MODELCMP', message: JSON.stringify(rec) }] }),
    }).catch(() => {});
  } catch { /* 忽略 */ }
}

/**
 * 写一条采集记录：控制台单行 + `__WEB__.modelCmp` 数组 + diag 落盘。
 * @param {object} rec
 * @returns {object} 同一条记录
 */
export function recordModelCmp(rec) {
  const bag = (window.__WEB__ = window.__WEB__ || {});
  if (!Array.isArray(bag.modelCmp)) bag.modelCmp = [];
  bag.modelCmp.push(rec);
  try { console.log('[MODELCMP] ' + JSON.stringify(rec)); } catch { /* 忽略 */ }
  postDiag(rec);
  return rec;
}

// ---------------------------------------------------------------- 记录构建
// 字段名 / 单位 / 采集时机三处统一，不同模型之间才可比（见 doc 第 4 节）。

/** 安全取值：失败时返回 { <key>_error }，不丢弃整条记录（否则 diff 会误判为"缺失即不同"） */
function safePick(key, fn) {
  try {
    return fn();
  } catch (e) {
    return { [`${key}_error`]: String((e && e.message) || e) };
  }
}

/** Cubism 内部尺寸（模型自身坐标系） */
function cmpInternalSize(internal) {
  if (!internal) return null;
  return { w: internal.width, h: internal.height, originalW: internal.originalWidth, originalH: internal.originalHeight };
}

/** Cubism 画布尺寸（内部单位，不是 CSS 像素） */
function cmpCanvasSize(core) {
  if (!core) return null;
  const w = typeof core.getCanvasWidth === 'function' ? core.getCanvasWidth() : null;
  const h = typeof core.getCanvasHeight === 'function' ? core.getCanvasHeight() : null;
  return { w, h };
}

/** PIXI 显示对象（width/height 是未缩放尺寸，scale 是当前缩放） */
function cmpDisplay(model) {
  return {
    w: model.width,
    h: model.height,
    x: model.x,
    y: model.y,
    scale: model.scale ? model.scale.x : null,
    rotation: model.rotation,
    pivot: model.pivot ? { x: model.pivot.x, y: model.pivot.y } : null,
    anchor: model.anchor ? { x: model.anchor.x, y: model.anchor.y } : null,
  };
}

/** 世界坐标系包围盒（含当前缩放/位移） */
function cmpBounds(model) {
  const b = model.getBounds();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

/** 纹理尺寸（判断是否被压缩/裁剪） */
function cmpTextures(model) {
  return (model.textures || []).map((t) => {
    const bt = t && t.baseTexture ? t.baseTexture : null;
    return { w: bt ? bt.width : (t ? t.width : null), h: bt ? bt.height : (t ? t.height : null) };
  });
}

/**
 * 我们算出来的适配值（纯算术还原，不重置模型）：
 *   basisW/H = 当前包围盒 ÷ 当前缩放（等价于 scale=1 时的包围盒）
 */
function cmpFit(model, size) {
  const b = model.getBounds();
  const scale = model.scale ? model.scale.x || 1 : 1;
  const basisW = b.width / scale;
  const basisH = b.height / scale;
  const W = size ? size.width : null;
  const H = size ? size.height : null;
  const fitScale = W && H && basisW && basisH ? Math.min(W / basisW, H / basisH) : null;
  return {
    basis: 'bounds',
    basisW: +basisW.toFixed(2),
    basisH: +basisH.toFixed(2),
    fitScale: fitScale == null ? null : +(fitScale * 0.98).toFixed(4),
    appliedScale: +Number(scale).toFixed(4),
    offsetX: +Number(model.x).toFixed(2),
    offsetY: +Number(model.y).toFixed(2),
    margin: 0.98,
  };
}

/** model3 结构特征（版本 / 布局 / 动作组 / 物理 / 姿势） */
function cmpModel3(internal, meta) {
  const settings = internal && internal.settings ? internal.settings : null;
  const json = settings && (settings.json || settings) ? (settings.json || settings) : null;
  const refs = json && json.FileReferences ? json.FileReferences : null;
  const motions = refs && refs.Motions ? Object.keys(refs.Motions) : [];
  return {
    version: (internal && internal.cubismVersion) || (meta && meta.cubism) || (settings && settings.version) || null,
    hasLayout: !!(json && json.Layout),
    motionGroups: motions.length,
    physics: !!(refs && refs.Physics) || !!(meta && meta.physics),
    pose: !!(refs && refs.Pose),
    expressions: refs && Array.isArray(refs.Expressions) ? refs.Expressions.length : 0,
  };
}

/**
 * 构建并落盘一条 Live2D 的 MODELCMP 记录（只读；不重置视图）。
 * @param {{app: object, model: object, internal: object, size: object, dpr: number,
 *          meta: object, modelId: string, zoomRatio: number, stageMode: string, tag: string}} ctx
 * @returns {object} 记录
 */
export function collectLive2DModelCmp(ctx) {
  const { app, model, internal, size, dpr, meta, modelId, zoomRatio, stageMode, tag } = ctx || {};
  const rec = { ts: Date.now(), tag, stageMode: stageMode || null };
  if (!model || !app || !app.renderer) {
    rec.collect_error = 'no model/app';
    return recordModelCmp(rec);
  }
  rec.id = modelId;
  rec.name = (meta && meta.name) || modelId;
  rec.internalSize = safePick('internalSize', () => cmpInternalSize(internal));
  rec.canvasSize = safePick('canvasSize', () => cmpCanvasSize(internal && internal.coreModel));
  rec.display = safePick('display', () => cmpDisplay(model));
  rec.bounds = safePick('bounds', () => cmpBounds(model));
  rec.extract = safePick('extract', () => analyzeExtractCanvas(app.renderer.extract.canvas(model)));
  rec.fit = safePick('fit', () => cmpFit(model, size));
  rec.textures = safePick('textures', () => cmpTextures(model));
  rec.model3 = safePick('model3', () => cmpModel3(internal, meta));
  rec.viewport = safePick('viewport', () => ({ w: size ? size.width : null, h: size ? size.height : null, dpr: dpr == null ? null : dpr }));
  rec.camera = { scale: +(Number(zoomRatio) || 1).toFixed(4) };
  return recordModelCmp(rec);
}
