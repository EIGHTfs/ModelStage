// infra/document.js —— Model Document 的组装层（Assets 层，document/v1）
//
// 职责（契约 Document契约 §一/§二）：把 catalog entry 变成 **ready 的 Document**——
//   · 资源地址一律先经 VirtualFS 解析（命中用虚拟地址、未命中回落原 URL，与 M3 的两套前置同一口径）
//   · 取字节/读定义也在这里发生（这是 Assets 层的工作）；渲染器只拿"资源在哪 + 校验结果"
//   · 失败不产半成品：state='error' + warnings 写明可读原因，绝不进入渲染层
//
// 为什么取资源必须在这一层：渲染器目录（spine/、live2d/、render/）里不允许出现模型资源的
//   fetch —— 一旦渲染器自己取资源，就会出现"取失败分支"在渲染层里长出来（契约 D4）。
//   把这件事收到这里，渲染器只消费地址，取不到的情况在进入渲染层之前就已经变成 error 文档。
//
// 说明（M4 阶段的能力边界，已在交付说明里如实登记）：
//   · skeleton.bones / slots 需要 Spine 运行时解析 .skel 才能得到，属引擎职责；
//     本轮只保证**形状齐全**（空数组），animations/skins 能拿到的（Live2D 定义、Spine 条目元数据）照填。
//   · Document 不注册 VFS 前缀（注册由提供者负责），因此 dispose() 只撤销"本层自己注册过的"前缀；
//     当前没有这种前缀 ⇒ dispose 是幂等空操作，绝不会和别处的 revoke 撞车（无双重撤销）。
import { getSharedVirtualFS } from './vfs.js';

/** 默认取共享 VFS 实例（与渲染器、验收脚本同一个） */
function pickVfs(deps) {
  if (deps && deps.vfs) return deps.vfs;
  try {
    return getSharedVirtualFS();
  } catch {
    return null;
  }
}

/** 资源地址解析：命中用虚拟地址，未命中回落原 URL；异常一律回落 */
function resolveUrl(vfs, url) {
  if (!url) return null;
  try {
    const hit = vfs && typeof vfs.resolve === 'function' ? vfs.resolve(url) : null;
    return hit || url;
  } catch {
    return url;
  }
}

/** 读一个资源的字节；失败只记 warning，不抛（由调用方汇总成 error 文档） */
async function readBytes(url, label, warnings) {
  try {
    const res = await fetch(url);
    if (!res || !res.ok) {
      warnings.push(`${label} 读取失败：HTTP ${(res && res.status) || '?'}（${url}）`);
      return null;
    }
    const buf = await res.arrayBuffer();
    if (!buf || !buf.byteLength) {
      warnings.push(`${label} 内容为空（${url}）`);
      return null;
    }
    return buf;
  } catch (e) {
    warnings.push(`${label} 读取失败：${(e && e.message) || e}（${url}）`);
    return null;
  }
}

/** 判定内容类型：显式 kind 优先，其次按条目形状推断 */
function detectKind(entry) {
  if (!entry) return null;
  if (entry.kind === 'spine' || entry.kind === 'live2d') return entry.kind;
  if (entry.skeletonFile) return 'spine';
  if (entry.modelUrl || (entry.entry && entry.entry.url)) return 'live2d';
  return null;
}

/** 组装公共只读字段（kind/source/provider/根信息/state/warnings 等） */
function baseDocument(entry, kind, vfs) {
  return {
    // ── 只读（契约 §一）
    id: entry.id || null,
    kind,
    source: entry.source || (entry.provider ? 'bundle' : 'files'),
    provider: entry.provider || null,
    rootId: entry.rootId || (entry.root && entry.root.id) || null,
    rootName: entry.rootName || (entry.root && entry.root.name) || null,
    name: entry.name || entry.id || null,
    srcDir: entry.srcDir || entry.dir || null,
    assets: { entry: null, textures: [], atlas: null },
    skeleton: { bones: [], slots: [], animations: [], skins: [] },
    meta: { version: entry.version || null, bbox: null, motions: null, expressions: null, motionDurations: {}, extras: {} },
    state: 'ready',
    warnings: [],
    // ── 可写（契约 §六：只留形状，加编辑器时实现）
    params: {},
    dirty: false,
    history: { undo() {}, redo() {} },
  };
}

/** Spine：骨架 / atlas / 贴图页三件套（地址已解析，字节一并带上供引擎消费） */
async function buildSpineAssets(doc, entry, vfs) {
  const warn = doc.warnings;
  const skelUrl = resolveUrl(vfs, entry.skeletonFile && entry.skeletonFile.url);
  const atlasUrl = resolveUrl(vfs, entry.atlasFile && entry.atlasFile.url);
  const texEntries = Array.isArray(entry.textureFiles) ? entry.textureFiles : [];
  if (!skelUrl) warn.push('缺少骨架地址（skeletonFile.url）');
  if (!atlasUrl) warn.push('缺少 atlas 地址（atlasFile.url）');
  if (!texEntries.length) warn.push('缺少贴图页（textureFiles 为空）');

  const [skelBytes, atlasBytes] = await Promise.all([
    skelUrl ? readBytes(skelUrl, '骨架', warn) : null,
    atlasUrl ? readBytes(atlasUrl, 'atlas', warn) : null,
  ]);
  doc.assets.entry = { role: 'skeleton', name: (entry.skeletonFile && entry.skeletonFile.name) || '', url: skelUrl, bytes: skelBytes };
  doc.assets.atlas = { role: 'atlas', name: (entry.atlasFile && entry.atlasFile.name) || '', url: atlasUrl, bytes: atlasBytes };

  for (const tex of texEntries) {
    const url = resolveUrl(vfs, tex && tex.url);
    if (!url) { warn.push(`贴图缺地址：${(tex && tex.name) || '?'}`); continue; }
    const bytes = await readBytes(url, `贴图 ${tex.name || ''}`, warn);
    doc.assets.textures.push({ role: 'texture', name: (tex && tex.name) || '', url, bytes });
  }
  // 动画/皮肤快照：条目里能给的先填（引擎返回的更权威，但 Document 只读部分不应该等运行时）
  const animations = Array.isArray(entry.animations) ? entry.animations : [];
  doc.skeleton.animations = animations.map((a) => (typeof a === 'string' ? a : (a && (a.name || a.Name)) || '')).filter(Boolean);
  doc.skeleton.skins = Array.isArray(entry.skins) ? entry.skins.slice() : [];
  doc.meta.extras = { atlasPma: entry.atlasPma === undefined ? null : entry.atlasPma };
  return doc;
}

/** 动作时长缓存：定义地址 → { 动作文件 → 秒数 }（跨多次组装复用） */
const motionDurationCache = new Map();

/**
 * 预取 Live2D 每个动作文件的时长（Meta.Duration）。
 *
 * 为什么放在 Assets 层：时长要读动作文件，而"取模型资源"是 Assets 层的职责——
 *   渲染器里不允许 fetch（契约 D4）。之前这套逻辑在 live2d/bridge 里，收到本层后
 *   渲染器只读 document.meta.motionDurations，动作时长不会因为"没人预取"而整片消失。
 *
 * 键用**动作文件相对路径**（model3.json 里的 File 原值，如 `motions/idle.motion3.json`）：
 *   动作标签（`group / 文件名`）的拼法只有一处实现（live2d/model.js 的 motionLabel），
 *   这里再写一份必然漂移；桥接层拿标签对应的文件来查即可。
 *
 * 取不到就**不写这个键**（不填 0 冒充），前端自然显示为"无时长"。
 * @param {object} doc Document（就地写 doc.meta.motionDurations）
 * @param {object} ref model3.json 的 FileReferences
 * @param {string} baseRef **解析前**的模型定义地址（vfs:// 或 http://）——
 *   动作文件的相对路径必须以它为基址拼接：拿解析后的 blob 当基址会拼出
 *   `blob:…/motions/x.motion3.json` 这种永不命中的地址（资源包时长整片 null 的真因）。
 * @param {string} entryUrl 定义文件地址（用于把相对 File 拼成可读地址）
 * @param {object} vfs VirtualFS
 */
async function fillMotionDurations(doc, ref, baseRef, vfs) {
  // 同一模型反复组装（切模型来回点、测试反复装载）时不必重复预取：按定义地址缓存一份。
  //   14 个动作文件就是 14 次请求，重复预取既慢又给测试增加时序抖动。
  const cached = motionDurationCache.get(baseRef);
  if (cached) { doc.meta.motionDurations = { ...cached }; return; }
  const base = String(baseRef || '').replace(/[^/]*$/, '');
  const files = [];
  for (const group of Object.keys(ref.Motions || {})) {
    for (const mo of (ref.Motions[group] || [])) {
      const file = mo && (mo.File || mo.Name);
      if (file && !files.includes(file)) files.push(file);
    }
  }
  const out = {};
  const jobs = files.map(async (file) => {
    const abs = /^[a-z][a-z0-9+.-]*:/i.test(file) || file.startsWith('/') ? file : `${base}${file}`;
    const url = resolveUrl(vfs, abs);
    try {
      const res = await fetch(url);
      if (!res || !res.ok) return;
      const json = await res.json();
      const d = Number(json && json.Meta && json.Meta.Duration);
      if (Number.isFinite(d) && d > 0) out[file] = d;
    } catch { /* 单个动作读不到就跳过，不影响其它动作与整体装载 */ }
  });
  await Promise.all(jobs);
  doc.meta.motionDurations = out;
  motionDurationCache.set(baseRef, out);
}

/** Live2D：入口 model3.json 定义（地址已解析；内部引用由 live2d/vfs-settings 在装载时解析） */
async function buildLive2dAssets(doc, entry, vfs) {
  const warn = doc.warnings;
  const raw = (entry.entry && entry.entry.url) || entry.modelUrl || null;
  const url = resolveUrl(vfs, raw);
  if (!url) { warn.push('缺少模型定义地址（entry.url / modelUrl）'); return doc; }
  // ref 保留**解析前**的原始地址：Live2D 内部相对引用要靠它推出 vfs 前缀
  //   （url 是解析后的 blob，blob 不能当基址；vfs-settings 需要 vfs:// 形态才能把
  //    motions/x.motion3.json 这类引用映射回已注册的前缀）。
  doc.assets.entry = { role: 'definition', name: raw.split('/').pop() || '', url, ref: raw, bytes: null };
  try {
    const res = await fetch(url);
    if (!res || !res.ok) {
      warn.push(`模型定义读取失败：HTTP ${(res && res.status) || '?'}（${url}）`);
      return doc;
    }
    const json = await res.json();
    const ref = (json && json.FileReferences) || {};
    const motions = ref.Motions || {};
    doc.meta.version = json && json.Version ? Number(json.Version) : doc.meta.version;
    // meta.motions 必须是**完整映射** { 组: [{ File, ... }] }，不是组名数组：
    //   渲染层要凭 File 去查预取时长表（live2d/bridge.js 的 motionFileOf），
    //   只留组名的话 duration 一律取不到 ⇒ 动作列表时长整片 null（冷缓存下 34/34 全空）。
    doc.meta.motions = motions;
    doc.meta.expressions = (ref.Expressions || []).map((e) => (e && e.Name) || '');
    doc.skeleton.animations = Object.keys(motions);
    doc.meta.extras = { moc: ref.Moc || null, textures: (ref.Textures || []).slice(), json };
    // 传 raw（解析前地址）而不是 url（blob）：相对路径要相对"来源"拼，不是相对 blob
    await fillMotionDurations(doc, ref, raw, vfs);
  } catch (e) {
    warn.push(`模型定义解析失败：${(e && e.message) || e}（${url}）`);
  }
  return doc;
}

/** 给 Document 装上幂等的 dispose（契约 D2） */
function attachDispose(doc, vfs) {
  let disposed = false;
  // 本层不注册前缀（注册是提供者的职责）⇒ 通常没有要撤的前缀；
  //   若将来本层自己注册，把前缀记在 doc._ownedPrefix 上，这里会撤且只撤一次。
  doc.dispose = function dispose() {
    if (disposed) return false;
    disposed = true;
    const prefix = doc._ownedPrefix;
    if (prefix && vfs && typeof vfs.revoke === 'function') {
      try { vfs.revoke(prefix); } catch { /* 撤销失败不影响幂等语义 */ }
    }
    return true;
  };
  return doc;
}

/**
 * 把 catalog entry 变成 ready/error 的 Document。
 * @param {object} entry catalog 条目（可能是模型条目，也可能已带 kind）
 * @param {{vfs?: object, log?: Function}} [deps]
 * @returns {Promise<object>} Document（state 只会是 'ready' 或 'error'）
 */
export async function buildDocument(entry, deps = {}) {
  const vfs = pickVfs(deps);
  const kind = detectKind(entry);
  if (!entry || !kind) {
    const bad = baseDocument(entry || {}, null, vfs);
    bad.state = 'error';
    bad.warnings.push(entry ? `无法判定内容类型（既没有 skeletonFile 也没有 entry.url/modelUrl）` : '缺少 catalog 条目');
    return attachDispose(bad, vfs);
  }
  const doc = baseDocument(entry, kind, vfs);
  try {
    if (kind === 'spine') await buildSpineAssets(doc, entry, vfs);
    else await buildLive2dAssets(doc, entry, vfs);
  } catch (e) {
    doc.warnings.push(`组装异常：${(e && e.message) || e}`);
  }
  // 任何 warning 都意味着"资源不全" ⇒ 不进入渲染层（契约 §二 硬规则 1）
  if (doc.warnings.length) doc.state = 'error';
  return attachDispose(doc, vfs);
}

export default buildDocument;
