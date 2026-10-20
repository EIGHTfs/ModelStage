// engine/fit.js —— 适配（fit）三模式：subject（默认）/ all / animation
//
// 规则移植自旧引擎（legacy/source/engine.js 的 computeSubjectBounds + resetCamera 的 fit 段）：
//   · NON_SUBJECT_RE 剔除背景/特效，CORE_RE 认主体，FIT_MAX_RATIO=1.15 限制"横向过宽"的包围盒；
//   · subject 结果不可信时回落到整体包围盒；
//   · animation 模式对每个动作采样若干帧取并集。
// 版本差异（computeWorldVertices 的签名）用**参数个数 + 试调**探测，不读版本号。

/** 背景/特效类部件（不参与主体适配） */
export const NON_SUBJECT_RE = /(?:^|[_\s/.-])(backgrounds?|bgs?|backs?|effects?|effs?|efs?|fxs?|efxs?|vfx|particles?|auras?|glows?|halos?|debris|bursts?|shadows?|floors?|grounds?|lights?|(?:bg)|(?:fx)[0-9]*)(?:[_\s/.-]|$|[0-9])|sakura|petal|blossom|bgimage|bg-img|bg_img|(?:^|[/])ref[/]|背景|特效|光效|粒子|光晕|樱花|花瓣|碎片|阴影|地面/i;

/** 主体类部件（优先级最高） */
export const CORE_RE = /(chara|character|body|head|face|hair|arm|leg|skirt|cloth|pelvis|neck|hand|foot|torso|spine|chest|hip|bust|skin|sleeve|glove|shoe|socks|dress|coat|jacket|cape|wing|tail|horn|ear|eye|mouth|nose|身|头|脸|发|手|脚|腿|衣|裙|体|肤)/i;

/** 横向相对高度的上限（超过就当作"背景太宽"，按高度收窄） */
export const FIT_MAX_RATIO = 1.15;

/** 支持的模式（与面板「初始缩放」三个按钮一一对应） */
export const FIT_MODES = ['subject', 'all', 'animation'];

/** 顶点数组 → 包围盒 */
function boxOfPoints(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || maxX <= minX) return null;
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/**
 * 取附件世界顶点包围盒（签名差异用"参数个数 + 试调"探测）。
 * @param {object} skeleton
 * @param {object} slot
 * @returns {{minX: number, minY: number, maxX: number, maxY: number, w: number, h: number}|null}
 */
export function slotWorldBounds(skeleton, slot) {
  const att = slot && slot.attachment;
  if (!att) return null;
  const len = att.worldVerticesLength;
  if (typeof len === 'number' && typeof att.computeWorldVertices === 'function') {
    const verts = new Float32Array(len);
    const deepFirst = att.computeWorldVertices.length >= 6;
    const narrow = () => att.computeWorldVertices(slot, 0, len, verts, 0, 2);
    const deep = () => att.computeWorldVertices(skeleton, slot, 0, len, verts, 0, 2);
    for (const run of (deepFirst ? [deep, narrow] : [narrow, deep])) {
      try { run(); const box = boxOfPoints(verts); if (box) return box; } catch { /* 试下一种签名 */ }
    }
  }
  // 回退：骨骼位置 + 附件宽高（region 类附件）
  const bone = slot && slot.bone;
  if (!bone) return null;
  let sx = Math.abs(bone.scaleX || 1);
  let sy = Math.abs(bone.scaleY || 1);
  for (let p = bone.parent; p; p = p.parent) { sx *= Math.abs(p.scaleX || 1); sy *= Math.abs(p.scaleY || 1); }
  const w = (att.width || 0) * sx;
  const h = (att.height || 0) * sy;
  if (!(w > 0) || !(h > 0)) return null;
  const x = bone.worldX || 0;
  const y = bone.worldY || 0;
  return { minX: x - w / 2, maxX: x + w / 2, minY: y - h / 2, maxY: y + h / 2, w, h };
}

/**
 * 主体包围盒（核心部件为准，剔除背景/特效，远离主体的碎片也剔除）。
 * @param {{skeleton: object, skeletonData: object}} ctx
 * @returns {{x: number, y: number, w: number, h: number}|null}
 */
export function computeSubjectBounds({ skeleton, skeletonData }) {
  const order = (skeleton && skeleton.drawOrder) || [];
  const items = [];
  for (const slot of order) {
    const box = slot && slot.attachment ? slotWorldBounds(skeleton, slot) : null;
    if (!box) continue;
    const slotName = String((slot.data && slot.data.name) || '');
    const attName = String((slot.attachment && slot.attachment.name) || '');
    const core = CORE_RE.test(slotName) || CORE_RE.test(attName);
    const bg = (NON_SUBJECT_RE.test(slotName) || NON_SUBJECT_RE.test(attName)) && !core;
    items.push({ box, bg, core });
  }
  if (!items.length) return null;
  const ref = referenceSize(items, skeletonData);
  const coreBox = unionCore(items);
  const coreSignificant = !!coreBox && coreBox.w >= 0.12 * ref.w && coreBox.h >= 0.12 * ref.h;
  const margin = coreSignificant ? Math.max(0.22 * ref.h, coreBox.h * 0.6) : 0;
  return unionKeep(items, { coreBox, coreSignificant, margin, ref });
}

/** 参考尺寸：优先骨架数据自带，否则全部部件的范围 */
function referenceSize(items, skeletonData) {
  let w = skeletonData && skeletonData.width > 0 ? skeletonData.width : 0;
  let h = skeletonData && skeletonData.height > 0 ? skeletonData.height : 0;
  if (!(w > 0) || !(h > 0)) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const it of items) {
      if (it.box.minX < minX) minX = it.box.minX;
      if (it.box.minY < minY) minY = it.box.minY;
      if (it.box.maxX > maxX) maxX = it.box.maxX;
      if (it.box.maxY > maxY) maxY = it.box.maxY;
    }
    if (Number.isFinite(minX)) { w = maxX - minX; h = maxY - minY; }
  }
  return { w: w > 0 ? w : 1024, h: h > 0 ? h : 1024 };
}

/** 核心部件并集 */
function unionCore(items) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const it of items) {
    if (!it.core) continue;
    if (it.box.minX < minX) minX = it.box.minX;
    if (it.box.minY < minY) minY = it.box.minY;
    if (it.box.maxX > maxX) maxX = it.box.maxX;
    if (it.box.maxY > maxY) maxY = it.box.maxY;
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** 合并：核心必留；非核心剔除背景与远离主体的碎片 */
function unionKeep(items, { coreBox, coreSignificant, margin, ref }) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  let count = 0;
  for (const it of items) {
    const b = it.box;
    if (!it.core) {
      if (it.bg) continue;
      const tooWide = b.w > 1.3 * ref.w || b.h > 1.3 * ref.h;
      const farAway = coreSignificant && (
        b.maxX < coreBox.minX - margin || b.minX > coreBox.maxX + margin
        || b.maxY < coreBox.minY - margin || b.minY > coreBox.maxY + margin
      );
      if (tooWide || farAway) continue;
    }
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
    count += 1;
  }
  if (!count || !Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * 两个包围盒求交（subject 并集 ∩ 整体包围盒）。
 * 为什么需要：并集可能因个别远端附件（如超大挂件）比整体还大，
 *   旧引擎实测的 subject 结果始终落在整体范围内；取交可剔除这类离群部件。
 * @param {{x: number, y: number, w: number, h: number}} a
 * @param {{x: number, y: number, w: number, h: number}} b
 */
export function intersectBox(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (!(right > x) || !(bottom > y)) return b;
  return { x, y, w: right - x, h: bottom - y };
}

/** subject 结果的"横向对称收窄"（旧引擎的 FIT_MAX_RATIO 处理） */
export function clampSubjectBox(box) {
  if (!box) return null;
  const symHalf = Math.max(Math.abs(box.x), Math.abs(box.x + box.w));
  let w = 2 * symHalf;
  const cap = FIT_MAX_RATIO * box.h;
  if (w > cap) w = cap;
  const center = box.x + box.w / 2;
  const keepCenter = Math.abs(center) <= box.w * 0.04 ? 0 : center;
  return { x: keepCenter - w / 2, y: box.y, w, h: box.h };
}

/**
 * 计算视口适配参数（相机 zoom 语义：可见世界宽 = zoom × 视口宽）。
 * @param {{bounds: {x: number, y: number, w: number, h: number}|null, viewW: number, viewH: number}} ctx
 * @returns {{baseZoom: number, centerX: number, centerY: number}|null}
 */
export function computeFit({ bounds, viewW, viewH }) {
  if (!bounds || !(viewW > 0) || !(viewH > 0) || !(bounds.w > 0) || !(bounds.h > 0)) return null;
  const need = Math.max(bounds.w / viewW, bounds.h / viewH);
  if (!Number.isFinite(need) || need <= 0) return null;
  // 与旧引擎一致：baseZoom = max(宽比, 高比)，不再额外除以 (1-FIT_MARGIN)
  const baseZoom = need;
  if (!Number.isFinite(baseZoom) || baseZoom <= 0) return null;
  return { baseZoom, centerX: bounds.x + bounds.w / 2, centerY: bounds.y + bounds.h / 2 };
}
