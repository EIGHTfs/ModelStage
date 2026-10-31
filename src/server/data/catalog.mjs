// catalog.mjs —— 模型来源规范化（GET /api/catalog 的数据层）
//
// 背景：Spine 与 Live2D 两路扫描输出的形状不同（入口字段、版本字段、动作字段、私有字段各一套），
//   消费方必须各自适配。这里合并两路结果，统一输出 ModelEntry（见 docs/架构/总览.md 第十节）：
//     { id, kind, rootId, rootName, name, srcDir,
//       entry: { url, name, size },
//       assets: [{ role, name, url, size }],
//       meta: { version, motions, skins, expressions, textureCount, fileSize, extras },
//       iconUrl, warnings }
//
// 三条硬规则：
//   1. kind = 内容类型（spine / live2d），只用于选渲染分支；容器单文件另用 `container` 标记；
//   2. 私有字段一律进 meta.extras，不进公共层；
//   3. 缺陷显式化：动作取不到时进 warnings，不用"空数组"隐式表达。
//
// 扫描不在此重复实现：直接复用 spine.getSpineModels() 与 live2d.getLive2DModels()。
import fs from 'node:fs';
import path from 'node:path';
// 单调时钟：计时口径用它，不能用 Date.now()（会被系统时间校准拉走）
import { performance } from 'node:perf_hooks';
import { encodePath } from '../assets/probe.mjs';
// 扩展名集合复用 tree.mjs 那一份：容器列举与目录浏览必须用同一套「哪些扩展名要探魔数」，
//   两处各写一份会漂移（一处加了新扩展名、另一处没加 ⇒ 某个根莫名列不出容器，且不报错）。
import { KNOWN_FILE_EXT } from './tree.mjs';
// 指纹判据只有一份实现：catalog / 上报路由 / 解包路径三处必须同源（INV-D6）
import { providerFingerprintOf, assetFingerprintOf } from './entry-states.mjs';

/**
 * 路径式文件 URL（Live2D 定义文件内部用相对路径引用，必须用 /files/ 前缀）。
 * @param {string} rootId
 * @param {string} relPath 相对资源根的路径
 */
function filesUrl(rootId, relPath) {
  return `/files/${encodeURIComponent(rootId)}/${encodePath(relPath)}`;
}

/** 版本统一成数字（4.1 / 4）；无法解析时原样返回字符串 */
function toVersionNumber(label) {
  const n = Number(label);
  return Number.isFinite(n) ? n : label;
}

/** 去掉动作文件名里的 .motion3.json / .motion.json / .json 后缀，作为可读动作名 */
function motionName(file) {
  return path.basename(String(file)).replace(/\.(motion3|motion)?\.?json$/i, '') || String(file);
}

// 定义文件解析缓存：absPath → { mtimeMs, size, result }
// 为什么必须缓存：一次 catalog 请求要读 100+ 个 model3.json，逐个读盘会成为主要耗时。
const motionCache = new Map();
/** 纹理存在性缓存：key=定义文件绝对路径，按 mtime/size 失效（避免每次请求上千次 stat） */
const textureCache = new Map();

/**
 * 从 Cubism 定义文件读动作分组，展开成 [{ group, index, name, url, fadeIn, fadeOut }]。
 * Cubism 4 在 FileReferences.Motions，Cubism 2 在顶层 motions —— 两者都支持。
 * @param {string} absDef 定义文件绝对路径
 * @param {(rel: string) => string} toUrl 相对路径 → URL
 * @param {string} [relPrefix] 定义文件所在目录（相对资源根）
 * @returns {{motions: Array, warnings: string[]}}
 */
export function readModel3Motions(absDef, toUrl, relPrefix) {
  const st = statOf(absDef);
  if (!st) return { motions: [], missingMotions: [], warnings: [`motions 不可得：定义文件读取失败（ENOENT）`] };
  const cached = motionCache.get(absDef);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.result;
  const parsedMotions = parseMotionsFile(absDef, toUrl, relPrefix);
  motionCache.set(absDef, { mtimeMs: st.mtimeMs, size: st.size, result: parsedMotions });
  return parsedMotions;
}

/**
 * 读并解析定义文件，产出 {motions, missingMotions, warnings}。
 * 只做"解析 + 汇总"，具体提取与过滤各由下面两个小函数负责。
 * @param {string} absDef 定义文件绝对路径
 * @param {(rel: string) => string} toUrl 相对路径 → URL
 * @param {string|null} relPrefix 模型目录前缀
 */
function parseMotionsFile(absDef, toUrl, relPrefix) {
  let def;
  try {
    def = JSON.parse(fs.readFileSync(absDef, 'utf8'));
  } catch (e) {
    return { motions: [], missingMotions: [], warnings: [`motions 不可得：定义文件解析失败（${e.message}）`] };
  }
  const groups = (def.FileReferences && def.FileReferences.Motions) || def.motions || {};
  const refs = listMotionRefs(groups);
  const { existing, missing } = splitByExistence(refs, path.dirname(absDef));
  const motions = existing.map((ref) => buildMotionItem(ref, toUrl, relPrefix));
  if (!motions.length && !missing.length) {
    return { motions: [], missingMotions: [], warnings: ['motions 不可得：定义文件未声明 FileReferences.Motions'] };
  }
  return { motions, missingMotions: missing.map(toMissingItem), warnings: [] };
}

/**
 * 从 model3.json 的 Motions 提取引用清单（**不碰磁盘**）。
 * @param {object} groups 形如 { idle: [{ File, FadeIn }] }
 * @returns {Array<{group: string, index: number, file: string, raw: object}>}
 */
export function listMotionRefs(groups) {
  const out = [];
  for (const [group, list] of Object.entries(groups || {})) {
    if (!Array.isArray(list)) continue;
    list.forEach((raw, index) => {
      const file = raw ? (raw.File || raw.file) : null;
      if (file) out.push({ group, index, file: String(file), raw });
    });
  }
  return out;
}

/**
 * 按"文件是否真的在磁盘上"把引用分成两堆（bug B 的核心）。
 *
 * 为什么要有这一步：定义文件**声明了**但磁盘**不存在**的动作文件，如果照原样下发，
 *   前端就会去请求它 ⇒ 404 进 problems（每次加载这类模型都红）。
 *   这里直接把它们分出去，前端不会请求；缺失项单独返回，让上层以 warn 级说明"为什么少个动作"。
 *   注意：这属于**资产残缺**，不是路径拼错——所以是"过滤 + 记录"，不是改路径。
 *
 * @param {Array<{group: string, index: number, file: string, raw: object}>} refs
 * @param {string} baseDir 定义文件所在目录
 * @returns {{existing: Array, missing: Array}}
 */
export function splitByExistence(refs, baseDir) {
  const existing = [];
  const missing = [];
  for (const ref of (Array.isArray(refs) ? refs : [])) {
    if (fs.existsSync(path.join(baseDir, ref.file))) existing.push(ref);
    else missing.push(ref);
  }
  return { existing, missing };
}

/** 单条可用动作 → 前端动作清单项（含 URL 与淡入淡出） */
function buildMotionItem(ref, toUrl, relPrefix) {
  const rel = relPrefix ? `${relPrefix}/${ref.file}` : ref.file;
  const raw = ref.raw || {};
  return {
    group: ref.group,
    index: ref.index,
    name: motionName(ref.file),
    url: toUrl(rel),
    fadeIn: raw.FadeIn !== undefined ? raw.FadeIn : raw.fade_in,
    fadeOut: raw.FadeOut !== undefined ? raw.FadeOut : raw.fade_out,
  };
}

/** 单条缺失动作 → 缺件记录（供上层 warn 级暴露） */
function toMissingItem(ref) {
  return { group: ref.group, index: ref.index, name: motionName(ref.file), file: ref.file };
}

/** stat 封装：拿不到返回 null（调用方据此给出"读取失败"的结论） */
function statOf(absPath) {
  try {
    return fs.statSync(absPath);
  } catch {
    return null;
  }
}

/**
 * Spine 条目 → ModelEntry。
 * @param {object} cfg 资源根配置
 * @param {object} m 扫描结果条目
 */
export function toSpineEntry(cfg, m) {
  const fileUrl = (p) => filesUrl(cfg.id, p);
  const assets = [{
    role: 'atlas',
    name: m.atlasFile.name,
    url: fileUrl(m.atlasFile.path),
    size: m.atlasFile.size,
  }];
  for (const t of m.textureFiles || []) {
    assets.push({ role: 'texture', name: t.name, url: fileUrl(t.path), size: t.size });
  }
  const motions = Array.isArray(m.animations) ? m.animations : [];
  const warnings = [];
  // 扫描阶段只认骨架/图集，不解析动画表，因此这里如实说明"需运行时枚举"（而不是假装 0 个动作）
  if (!motions.length) warnings.push('motions 需运行时枚举：扫描阶段未解析动画列表，可由 /api/model-meta 或渲染器补齐');
  if (!Array.isArray(m.skins) || !m.skins.length) warnings.push('skins 需运行时枚举：扫描阶段未解析皮肤列表');

  return {
    id: m.id,
    kind: 'spine',
    source: 'files',
    rootId: cfg.id,
    rootName: cfg.name,
    name: m.name,
    srcDir: m.srcDir,
    entry: { url: fileUrl(m.skeletonFile.path), name: m.skeletonFile.name, size: m.skeletonFile.size },
    assets,
    // ---- 渲染器兼容字段 ----
    // 为什么补：/api/spine/models 的条目带 skeletonFile / atlasFile / textureFiles，渲染器直接读这三组；
    //   catalog 条目原本只有 entry / assets，拿它直接 mount 会 404。
    // 只补字段：entry / assets 的内容与含义保持不变，已用它们的调用方不受影响。
    skeletonFile: { name: m.skeletonFile.name, path: m.skeletonFile.path, url: fileUrl(m.skeletonFile.path), size: m.skeletonFile.size },
    atlasFile: { name: m.atlasFile.name, path: m.atlasFile.path, url: fileUrl(m.atlasFile.path), size: m.atlasFile.size },
    textureFiles: (m.textureFiles || []).map((t) => ({ name: t.name, path: t.path, url: fileUrl(t.path), size: t.size })),
    // 顶层 version / format：渲染器按顶层 version 选运行时（meta.version 是数字，不适合做匹配键），
    //   缺这两个字段会让运行时选错版本，进而报 "Bone name must not be null"。
    version: m.version,
    format: m.format,
    meta: {
      version: toVersionNumber(m.version),
      motions,
      skins: m.skins || [],
      expressions: [],
      textureCount: m.textureCount,
      fileSize: m.fileSize,
      extras: {
        versionLabel: m.version,
        format: m.format,
        boneCount: m.boneCount,
        slotCount: m.slotCount,
        atlasPma: m.atlasPma,
        directory: m.directory,
        dirPath: m.dirPath,
        importedAt: m.importedAt,
        source: m.source,
        localRoot: m.localRoot,
      },
    },
    iconUrl: m.iconUrl || null,
    warnings,
  };
}

/**
 * 读取 model3.json 声明的纹理并核对磁盘是否存在（按定义文件 mtime/size 缓存）。
 *
 * 为什么要做：扫描阶段只列**磁盘上有的**文件，不会发现"定义了但缺文件"的情况；
 *   现场实例：aijier_3 的 Textures 声明 texture_00+texture_01，磁盘只有 texture_01
 *   ⇒ 渲染时抛 "Texture loading error"（用户只看到这个，看不出是资产缺文件）。
 *   这里提前判定，让上层能"预判 + 换源 + 给可执行提示"，而不是等渲染炸。
 *
 * @param {string} absDef 定义文件绝对路径
 * @returns {{declared: string[], missing: string[]}}
 */
export function readModel3Textures(absDef) {
  let st;
  try {
    st = fs.statSync(absDef);
  } catch {
    return { declared: [], missing: [] };
  }
  const cached = textureCache.get(absDef);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.result;
  let textureState = { declared: [], missing: [] };
  try {
    const def = JSON.parse(fs.readFileSync(absDef, 'utf8'));
    const declared = ((def.FileReferences && def.FileReferences.Textures) || []).map(String);
    const dir = path.dirname(absDef);
    textureState = { declared, missing: declared.filter((rel) => !fs.existsSync(path.join(dir, rel))) };
  } catch { /* 解析失败按"无声明"处理，不制造噪音 */ }
  textureCache.set(absDef, { mtimeMs: st.mtimeMs, size: st.size, result: textureState });
  return textureState;
}

/**
 * Live2D 条目 → ModelEntry。
 * @param {object} cfg 资源根配置
 * @param {object} lm 扫描结果条目
 */
export function toLive2DEntry(cfg, lm) {
  const fileUrl = (p) => filesUrl(cfg.id, p);
  const absDef = lm.defFile ? path.join(cfg.path, lm.defFile.path) : null;
  const fromDef = absDef
    ? readModel3Motions(absDef, fileUrl, lm.srcDir)
    : { motions: [], missingMotions: [], warnings: ['motions 不可得：缺少定义文件路径'] };
  const textureCheck = absDef ? readModel3Textures(absDef) : { declared: [], missing: [] };

  return {
    id: lm.id,
    kind: 'live2d',
    source: 'files',
    rootId: cfg.id,
    rootName: cfg.name,
    name: lm.name,
    srcDir: lm.srcDir,
    entry: { url: lm.modelUrl, name: lm.defFile.name, size: lm.defFile.size },
    assets: buildLive2DAssets(lm, fileUrl),
    meta: buildLive2DMeta(lm, fromDef, textureCheck),
    iconUrl: lm.iconUrl || null,
    warnings: buildLive2DWarnings(fromDef, textureCheck),
  };
}

/** Live2D 资产清单（moc3 + 磁盘上实际存在的纹理页） */
function buildLive2DAssets(lm, fileUrl) {
  const assets = [];
  if (lm.mocFile) {
    assets.push({ role: 'moc3', name: lm.mocFile.name, url: fileUrl(lm.mocFile.path), size: lm.mocFile.size });
  }
  for (const page of lm.textureFiles || []) {
    assets.push({ role: 'texture', name: page.name, url: fileUrl(page.path), size: page.size });
  }
  return assets;
}

/**
 * Live2D 元信息：动作清单 + 资产残缺标记。
 * @param {object} lm 扫描结果条目
 * @param {{motions: Array, missingMotions?: Array}} fromDef 定义文件解析结果
 * @param {{missing: string[]}} textureCheck 纹理核对结果
 */
function buildLive2DMeta(lm, fromDef, textureCheck) {
  return {
    version: toVersionNumber(lm.cubism),
    motions: fromDef.motions,
    missingMotions: fromDef.missingMotions || [],
    skins: [],
    expressions: lm.expressions || [],
    textureCount: (lm.textureFiles || []).length,
    // 声明了但磁盘缺失的纹理（前端据此预判并给出明确提示，不必等渲染报错）
    missingTextures: textureCheck.missing,
    fileSize: lm.fileSize,
    extras: { cubism: lm.cubism, defFile: lm.defFile, mocFile: lm.mocFile },
  };
}

/**
 * Live2D 告警：只收「真缺陷」（动作取不到、资产残缺）。
 * iconUrl 缺失是这批资源的共性（Live2D 目录普遍没有 icon.png），不作为逐条告警刷屏。
 */
function buildLive2DWarnings(fromDef, textureCheck) {
  const warnings = [...(fromDef.warnings || [])];
  if (textureCheck.missing.length) {
    warnings.push(`纹理文件缺失（资产残缺，渲染会失败）：${textureCheck.missing.join('、')}——建议改用资源包版本或补齐文件`);
  }
  const missingMotions = fromDef.missingMotions || [];
  if (missingMotions.length) {
    warnings.push(`动作文件缺失（资产残缺，已跳过 ${missingMotions.length} 个）：${
      missingMotions.map((ref) => `${ref.group}/${ref.name}`).join('、')}`);
  }
  return warnings;
}

/**
 * 解析资源包提供者：取「已启用的、声明了 fileKinds 含 bundle」的插件。
 * kind 一律取插件 produces.kind —— 不在 catalog 里写死内容类型，
 *   将来出现 Spine 资源包只要插件改声明即可，无需改本文件。
 *
 * 多于一个 bundle 插件时，**kind 与 id 都必须留空**：
 *   解包前无法知道某个容器属于哪个插件（要看包内到底有 moc3 还是 .skel），
 *   取第一个是错的 —— 实测会返回 unity-live2d-bundle/live2d，于是 spine 包被标成 live2d，
 *   前端据 kind 选渲染分支 ⇒ 点开必然失败，而现场表现是"这个包坏了"，极难定位。
 *   内容类型由**解包产物**确定（有 entry.json 且含 skeletonFile ⇒ spine；有 model3.json ⇒ live2d），
 *   那是确定性的、且解包本来就要做，不需要在列举阶段额外 probe 一遍（每包 116ms × N）。
 * @returns {{id: string|null, kind: string|null, warning: string|null}}
 */
export function resolveBundleProvider(plugins) {
  const list = plugins.readPlugins()
    .filter((p) => Array.isArray(p.fileKinds) && p.fileKinds.includes('bundle'))
    // 优先级只决定**候选列表的先后**（提示用），不决定装载、也不决定颜色：
    //   解包前谁也判不出一个包该归哪个插件，颜色只认"已解包过的实际 pluginId"。
    .sort((a, b) => (Number(b.matchPriority) || 0) - (Number(a.matchPriority) || 0));
  /** 展示用候选（按 matchPriority 降序）：前端拿它拼"归属待解包确定（候选：A、B）" */
  const candidates = list.map((p) => ({ id: p.id, accent: p.accent || null, matchPriority: Number(p.matchPriority) || 0 }));
  if (!list.length) {
    return { id: null, kind: null, candidates, reason: 'no-provider', warning: '未找到能解包资源包的插件：条目 kind 无法确定' };
  }
  if (list.length > 1) {
    return {
      id: null,
      kind: null,
      candidates,
      reason: 'multi-provider',
      warning: `有 ${list.length} 个能解包资源包的插件（${list.map((p) => p.id).join('、')}）：`
        + '解包前无法确定内容类型，条目 kind 置空，由解包产物（entry.json 的 skeletonFile / model3.json）判定',
    };
  }
  const provider = list[0];
  const declared = provider.produces && provider.produces.kind ? String(provider.produces.kind) : null;
  return {
    id: provider.id,
    kind: declared,
    candidates,
    reason: declared ? null : 'undeclared-kind',
    warning: declared ? null : `提供者 ${provider.id} 未声明产出类型（produces.kind）：kind 置空，由渲染层拒绝装载`,
  };
}

/**
 * 资源包条目 → ModelEntry。
 * 解包前拿不到内部资产，故 assets 为空、meta 只填容器信息与大小。
 * @param {{id: string, name: string}} cfg 资源根
 * @param {{rel?: string, name: string, size?: number, container?: string}} file 容器文件
 * @param {{id: string|null, kind: string|null, candidates?: object[], reason?: string|null, warning?: string|null}} provider 列举阶段的候选信息
 * @param {{id: string, accent: string|null}|null} [owner] 已解包过的包：**实际解出它的插件**（唯一可信的展示归属）
 */
export function toBundleEntry(cfg, file, provider, owner = null) {
  const rel = file.rel || file.name;
  const warnings = ['motions 需解包后枚举：资源包内部资产在打开时才可读'];
  // kind 为空有两种成因，文案必须区分：否则排障时会去改插件的 produces.kind，
  //   而真正原因是"多个资源包插件并存、解包前判不出类型"。
  if (!provider.kind) {
    warnings.unshift(provider.reason === 'multi-provider'
      ? '内容类型待解包后确定（多个资源包插件并存，列举阶段无法判定）'
      : '提供者未声明产出类型');
  }
  return {
    // id 必须含**根内相对路径**，不能只用文件名：
    //   资源包里不同子目录常有同名文件（如各角色目录下都叫 `c200_01_...`），只用 file.name
    //   会让它们得到同一个 id ⇒ 名册按 id 匹配选中态 ⇒ 点一个、多个一起高亮，
    //   而且"上次选择记忆"也会指到错的那一个。
    //   与同族实现保持一致：live2d 用 relPath.replace(/\//g,'_')、spine 用 idPath.replace(/\//g,'_')。
    id: `bundle-${cfg.id}-${String(rel).replace(/\//g, '_')}`,
    kind: provider.kind, // 可能为 null：宁可显式空，也不按插件 id 猜
    container: file.container || 'unityfs',   // 装载层据此决定先解包（不是内容类型）
    provider: provider.id,
    rootId: cfg.id,
    rootName: cfg.name,
    name: file.name,
    // rel 是容器在根内的相对路径：装载时要凭它让插件去解包（缺了插件无从定位）
    rel,
    size: file.size,          // 顶层 size：插件解包前据此判断是否超限/是否需要流式处理
    srcDir: '',
    entry: { url: filesUrl(cfg.id, rel), name: file.name, size: file.size },
    assets: [],
    meta: {
      version: null,
      motions: [],
      skins: [],
      expressions: [],
      textureCount: 0,
      fileSize: file.size,
      extras: { container: file.container || null },
    },
    iconUrl: null,
    warnings,
    // ---- 展示归属的**原始输入**（契约 §二 的三字段由 listCatalog 末尾统一 recompute 产出）----
    // 这里只放"扫描阶段知道的事实"，不自己拼 display/support/loadResult：
    //   那三个字段的唯一产出点是 entry-states 的 recompute()，多拼一处就会多一套口径。
    /** 容器在根内的相对路径（entry-states 的键 = `${rootId}/${rel}`） */
    rel,
    /** 已解包过的包：index.json 里真实记录的 pluginId（null = 没解过，归属未定） */
    ownerProvider: owner && owner.id ? owner.id : null,
    /** 声明可认领该类资源的提供者（按 matchPriority 降序） */
    candidates: Array.isArray(provider.candidates) ? provider.candidates.map((c) => c.id) : [],
  };
}

/**
 * 容器列举的规模上限 —— 值来自**实测**，不是拍脑袋。
 *
 * 实测 6 个 enabled 资源根（2026-10 现场）：
 *   文件最大深度 3（bd2）｜目录数 max 535（azurlane）｜容器命中最多 19（azurlane_bundle，全在根层）
 *   nikke_2 的 3 个容器在**第二层**（`<角色名>/<包>`）—— 这正是"只扫根层"会漏掉的那类。
 * 深度取「实测 max + 1」，给未来更深的 Mod 类根留一层余量。
 *
 * 超限**绝不静默截断**：stopped 带回原因，由调用方写进 warnings
 *   （静默截断的表现是"某些根莫名其妙列不出包"，是最难查的一类故障）。
 */
const BUNDLE_SCAN_MAX_DEPTH = 4;
const BUNDLE_SCAN_MAX_DIRS = 3000;
const BUNDLE_SCAN_MAX_HITS = 500;

/**
 * 递归找容器单文件（纯 readdir，**不读已知扩展名的文件头**）。
 *
 * 为什么不复用 `tree.listTree`（实测驱动的决定，别改回去）：
 *   listTree 除 readdir 外还会对每个 `.skel` 调 `detectSkelVersion`、对 `.atlas` 调 `detectAtlasKey`,
 *   那是"给前端浏览展示元信息"才需要的。拿它做容器列举实测 12.5s（热）/ 31s（冷）；
 *   换成纯 readdir 后 1.36s（冷 1.46s），快 9 倍。
 *   两者**职责不同**（一个要完整元信息、一个只想快速找到容器），不是重复实现。
 *   "顺手统一成 listTree"会把冷启动拖回 31 秒 —— 这条注释就是防这个的。
 *
 * 只对**未知扩展名**的文件读 8 字节魔数，扩展名集合复用 tree 的 `KNOWN_FILE_EXT`（同一份真相）：
 *   实测 bd2 / azurlane / azurlane_spine 三个大根的未知扩展名文件数都是 **0**，
 *   即这三个根一次文件打开都不需要，成本全在 readdir 本身。
 *
 * 返回 `byDir`（按目录聚合）是为将来「按 dirSignature 缓存」留的钩子：
 *   要缓存时可按目录粒度判断哪一层失效，不必整根重扫。当前不缓存（实测冷启动 1.46s 可接受）。
 *
 * @param {string} rootPath 资源根绝对路径
 * @param {(abs: string) => (string|null)} detectContainer 魔数判定（返回 'unityfs' 或 null）
 * @param {{maxDepth?: number, maxDirs?: number, maxHits?: number}} [opts] 上限覆盖（测试用）
 * @returns {{files: Array<{name: string, rel: string, container: string, size: number}>,
 *            byDir: Record<string, Array<object>>, stopped: string|null,
 *            stats: {dirs: number, unknownFiles: number, hits: number}}}
 */
export function findContainerFiles(rootPath, detectContainer, opts = {}) {
  const maxDepth = opts.maxDepth ?? BUNDLE_SCAN_MAX_DEPTH;
  const maxDirs = opts.maxDirs ?? BUNDLE_SCAN_MAX_DIRS;
  const maxHits = opts.maxHits ?? BUNDLE_SCAN_MAX_HITS;
  const files = [];
  const byDir = {};
  const stats = { dirs: 0, unknownFiles: 0, depthSkipped: 0, hits: 0 };
  // stopped 只表示「列举被资源上限硬中断」（目录数 / 命中数）——那两种必须整体停手。
  //   深度超限**不算硬中断**：它只意味着"不再往这一支深入"，同层与其它兄弟目录必须继续扫。
  //   曾经把深度超限也写进 stopped，结果 DFS 一碰到深支就整体 return，
  //   同层还没处理的容器全被跳过（实测「上限 2 层」时命中数变成 0），属于过度截断。
  let stopped = null;

  function walk(abs, rel, depth) {
    if (stopped) return;
    if (depth > maxDepth) { stats.depthSkipped += 1; return; }
    if (stats.dirs >= maxDirs) { stopped = `目录数上限 ${maxDirs} 个`; return; }
    stats.dirs += 1;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;   // 读不了的目录跳过（权限不足 / 并发删除），不阻断整根
    }
    for (const entry of entries) {
      if (stopped) return;
      const full = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(full, childRel, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext && KNOWN_FILE_EXT.has(ext)) continue;   // 已知普通文件：不打开、不探魔数
      stats.unknownFiles += 1;
      const container = detectContainer(full);
      if (!container) continue;
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* 并发删除：按 0 记，不阻断 */ }
      const containerFile = { name: entry.name, rel: childRel, container, size };
      files.push(containerFile);
      if (!byDir[rel]) byDir[rel] = [];
      byDir[rel].push(containerFile);
      stats.hits += 1;
      if (stats.hits >= maxHits) { stopped = `容器命中上限 ${maxHits} 个`; return; }
    }
  }

  walk(rootPath, '', 0);
  return { files, byDir, stopped, stats };
}

/**
 * 列资源包根下的条目（递归，不再只看根层）。
 *
 * 为什么必须递归：资源包的实际摆法不统一 —— 有的根把包平铺在根层
 *   （azurlane_bundle：19 个包全在 L0），有的按 `<角色名>/<包>` 分目录
 *   （nikke_2：3 个包都在 L1）。只看根层时后者 catalog 条目为 0，
 *   表现是"资源包明明在盘上，模型列表里却没有"。
 *
 * @returns {{entries: Array, warnings: string[], skipped: number}}
 */
export function listBundleEntries(cfg, { plugins, unpack = null }) {
  const provider = resolveBundleProvider(plugins);
  const warnings = provider.warning ? [provider.warning] : [];
  // 已解包过的包 → 实际解出它的插件（展示归属的唯一可信来源）。每次列举只扫一遍缓存目录。
  const accentById = new Map(plugins.readPlugins().map((p) => [p.id, p.accent || null]));
  const owned = unpack && typeof unpack.cachedProviders === 'function' ? unpack.cachedProviders() : new Map();

  const found = findContainerFiles(cfg.path, plugins.detectBundleContainer);
  if (found.stopped) {
    warnings.push(`容器列举在「${found.stopped}」处停止，可能有未列出的资源包（已列出 ${found.files.length} 个）`);
  }
  if (found.stats.depthSkipped) {
    warnings.push(`有 ${found.stats.depthSkipped} 个目录超过深度上限 ${BUNDLE_SCAN_MAX_DEPTH} 层未扫描，`
      + '更深的资源包不会被列出');
  }

  const entries = found.files.map((f) => {
    const ownerId = owned.get(`${cfg.id}/${f.rel || f.name}`) || null;
    return toBundleEntry(cfg, f, provider, ownerId ? { id: ownerId, accent: accentById.get(ownerId) || null } : null);
  });
  // skipped 保持旧语义：**根层**「有文件但没探到容器魔数」的数量，不因递归而改变含义
  const rootLevelContainers = found.files.filter((f) => !f.rel.includes('/')).length;
  return { entries, warnings, skipped: countSkippedFiles(cfg.path, rootLevelContainers) };
}

/** 目录里「没有容器魔数、因此未列出」的文件数（只做计数，不解析文件头） */
function countSkippedFiles(rootPath, listed) {
  try {
    const total = fs.readdirSync(rootPath, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.')).length;
    return Math.max(0, total - listed);
  } catch {
    return 0;
  }
}

/**
 * 资源根路径体检：返回问题类型码（null = 正常）。
 *
 * 为什么单独体检而不是靠扫描结果判断：扫不到条目的原因有三类，
 *   文案必须不同（"路径没了" / "路径不是目录" / "目录正常但真没模型"），
 *   否则前端只能笼统显示"该游戏没有可加载模型"，用户拿不到任何线索。
 * 只看本地文件系统、不抛错：体检失败本身不该让接口 500。
 * @param {string} rootPath 配置里的根路径
 * @returns {'missing'|'not-dir'|'unreadable'|null}
 */
/**
 * 这条 warning 是"通用能力说明"还是"这一根的具体问题"（契约 §四 的分轨判据）。
 *
 * 判据只看**语义类别**，不看具体文案措辞：能力说明讲的是"整体扫描/插件能力边界"
 * （深度上限、插件数量、插件未声明类型…），根级问题讲的是"这一根哪里不对"
 * （路径没了、扫描抛错、某文件缺失、列举被截断）。
 * 宁严勿宽：拿不准的一律算根级问题（`rootIssues`）—— 混进 capabilityNotes 会让用户看不到该看的那条。
 * @param {string} text
 * @returns {boolean}
 */
function isCapabilityNote(text) {
  const s = String(text || '');
  return /超过深度上限|未扫描|插件|提供者|未声明|需要运行时枚举|需运行时枚举/.test(s);
}

/**
 * 目录型条目的"形态"键（契约 §一·五：目录型是 spine-dir / live2d-dir）。
 *
 * 为什么放模块级：它是"内容类型 ↔ 提供者 fileKinds"的固定映射，与任何一次请求无关；
 *   放在装配函数里会变成每次调用重建一个闭包，也让那个函数更难读。
 * @param {string|null} kind 内容类型（spine / live2d）
 * @returns {string|null} 未知类型返回 null（不猜）
 */
function dirKindOf(kind) {
  if (kind === 'live2d') return 'live2d-dir';
  if (kind === 'spine') return 'spine-dir';
  return null;
}

function inspectRootPath(rootPath) {
  let stat = null;
  try {
    stat = fs.statSync(rootPath);
  } catch {
    return 'missing';
  }
  if (!stat.isDirectory()) return 'not-dir';
  try {
    fs.accessSync(rootPath, fs.constants.R_OK);
  } catch {
    return 'unreadable';
  }
  return null;
}

/**
 * 根级问题的用户可见文案（**不带绝对路径**：那是排障信息，只进日志/diag）。
 * 只写"哪根出了什么问题"，让前端能直接展示。
 */
const ROOT_PATH_PROBLEM_TEXT = {
  missing: '资源根路径不存在（目录被移动或磁盘未挂载）',
  'not-dir': '资源根路径不是目录（配置里填的可能是文件）',  unreadable: '资源根目录不可读（权限不足）',
};

/**
 * 装配模型目录（合并该资源根下的 Spine 与 Live2D 两路扫描）。
 * @param {{config: object, spine: object, live2d: object}} deps
 */
export function createCatalog({ config, spine, live2d, tree, plugins, unpack = null, entryStates = null }) {
  /**
   * 解包缓存句柄（只读用途：查"这个包被哪个插件解出来过"）。
   * 装配顺序上 store 在 data 之后创建（serve.mjs），所以留 setter 注入，
   *   不去改启动顺序 —— 那会牵动一批初始化依赖。
   * 没注入时一切照旧：容器条目 badgeAccent=null（前端中性色）。
   */
  let unpackRef = unpack;
  function setUnpackStore(store) { unpackRef = store || null; }
  /**
   * 最近一次**各根** catalog 构建的服务端耗时（只保留最近一次，不做历史数组）。
   *
   * 为什么需要：`/api/catalog` 的耗时在「清单缓存命中」与「真扫盘重建」之间差一个数量级，
   *   前端只能看到"总共多久"，看不出是哪一根慢、慢在命中还是重建。
   * 零副作用：只在这里记账；`getCatalogStats()` 只读这份内存，绝不触发任何重建。
   */
  const stats = { at: null, totalMs: 0, roots: [] };

  /**
   * 条目描述缓存：key（`${rootId}/${rel}`）→ 该条目的静态事实
   * （候选提供者 / size / 缺贴图）。供 `/api/entries/result` 写读一体时喂 recompute。
   *
   * 为什么在 catalog 里记：这些事实来自扫描（谁认领这个形态、缺哪些贴图），
   *   只有 catalog 知道；entry-states 只管"状态 + 上下文 → 三字段"。
   * 容量上限：按最后访问顺序淘汰，避免长跑进程无限增长（条目数万级时也就几 MB）。
   */
  const ENTRY_DESC_MAX = 60000;
  const entryDesc = new Map();
  /**
   * 待探测条目（§八 触发判据 a/b）：读路径只**登记**，由后台任务消费。
   *
   * 为什么用 Set 且允许重复登记：同一根会在每次 /api/catalog 时重新遍历一遍，
   *   探测还没跑完（或刚好被限速卡住）时这些条目会再次被登记 —— 去重靠 Set 天然做到，
   *   重复登记不产生额外代价（不读盘、不排队多份）。
   */
  const probeQueue = new Set();
  /**
   * 探测触发钩子（§八 判据 a：清单重建后）。
   *
   * 为什么用"可注入的钩子"而不是让 catalog 直接 import 探测模块：
   *   catalog 是纯读路径、且被测试大量直接构造；一旦反向依赖后台任务，
   *   单测就会连带起定时器/读盘。由装配层（index.mjs）把 kick 注进来，依赖方向保持单向。
   * @type {null | ((rootId: string) => void)}
   */
  let probeNotifier = null;
  /** 装配层注入触发钩子（传 null 可摘掉） */
  function setProbeNotifier(fn) {
    probeNotifier = typeof fn === 'function' ? fn : null;
  }
  function rememberEntry(key, desc) {
    entryDesc.delete(key);
    entryDesc.set(key, desc);
    if (entryDesc.size > ENTRY_DESC_MAX) {
      const oldest = entryDesc.keys().next();
      if (!oldest.done) entryDesc.delete(oldest.value);
    }
  }

  /**
   * 查一条目的静态事实（没扫过这一根时返回空对象：调用方按"未知"处理，不编造）。
   * @param {string} key `${rootId}/${rel}`
   * @returns {{candidates?: string[], size?: number, missingTextures?: string[], assetDependency?: object|null}}
   */
  function describeEntry(key) {
    return entryDesc.get(String(key || '')) || {};
  }

  /**
   * 取走当前待探测队列（取走即清空，由探测任务持有，避免两边各跑一遍）。
   *
   * 为什么"取走"而不是"只读"：探测任务按根串行、逐包限速，可能跨多次调用才跑完；
   *   只要 key 还留在队列里，下一次 /api/catalog 就会再登记一次，队列永远清不空。
   * @param {number} [max] 一次最多取多少（限速用）
   * @returns {string[]} `${rootId}/${rel}` 列表
   */
  function takeProbeKeys(max = Infinity) {
    const out = [];
    for (const key of probeQueue) {
      out.push(key);
      probeQueue.delete(key);
      if (out.length >= max) break;
    }
    return out;
  }

  /** 探测没跑完就中止时把 key 放回队列（不丢，下一轮继续） */
  function requeueProbeKey(key) {
    const k = String(key || '');
    if (k) probeQueue.add(k);
  }

  /** 队列长度（自检/日志用：S10 要能证明"指纹没变时没有待探测项"） */
  function probeQueueSize() {
    return probeQueue.size;
  }

  /** 记一条根的耗时（同一根只留最新一条；totalMs 按各根最新值求和） */
  function recordRootStat(one) {
    const i = stats.roots.findIndex((r) => r.rootId === one.rootId);
    if (i >= 0) stats.roots[i] = one; else stats.roots.push(one);
    stats.at = one.at;
    stats.totalMs = stats.roots.reduce((s, r) => s + (Number(r.ms) || 0), 0);
  }

  /**
   * @param {string} rootId
   * @returns {{status: number, body: object}}
   */
  /**
   * 第①段·扫描：把一个根扫成条目数组（普通模型 + 容器单文件）+ 这一根的诊断素材。
   *
   * 为什么拆出来：原 listCatalog 两百行、审计按"函数过长"拦过提交；按
   *   「扫描 / 组装三字段 / 包装响应」三段切开后每段只做一件事，也便于各自单独验证。
   *   **行为零变化**：只是把原来线性排下来的代码按职责分成三段。
   * @param {{id: string, name?: string, path: string}} cfg 资源根配置
   * @returns {{entries: Array, warnings: string[], scanErrors: Error[],
   *            cachedAll: boolean, pathProblem: string|null}}
   */
  function scanRootEntries(cfg) {
    const entries = [];
    const warnings = [];
    /** 扫描过程中抛的错（用于判断 rootWarning 该说"扫不动"还是"真的空"） */
    const scanErrors = [];
    /** 两根扫描器是否都走了清单缓存（决定 source 报 cache 还是 built） */
    let cachedAll = true;
    // 根路径体检放在扫描之前：路径都没了就不要再问扫描器"里面有什么"
    const pathProblem = inspectRootPath(cfg.path);

    try {
      const scan = spine.getSpineModels(cfg, false);
      for (const m of scan.models) entries.push(toSpineEntry(cfg, m));
      if (scan.cached !== true) cachedAll = false;
    } catch (e) {
      scanErrors.push(e);
      warnings.push(`spine 扫描失败：${e.message}`);
    }
    try {
      const scan = live2d.getLive2DModels(cfg, false);
      for (const lm of scan.models) entries.push(toLive2DEntry(cfg, lm));
      if (scan.cached !== true) cachedAll = false;
    } catch (e) {
      scanErrors.push(e);
      warnings.push(`live2d 扫描失败：${e.message}`);
    }

    // 容器单文件（资源包本质是打包来的模型）：与普通模型一起出现在同一份清单里，
    //   所以"同一个根里既有普通模型又有容器"能被同时识别。
    //   条目 kind 取插件声明的 produces.kind（内容类型），容器标记另行保留给装载层解包用。
    const bundle = listBundleEntries(cfg, { tree, plugins, unpack: unpackRef });
    entries.push(...bundle.entries);
    if (bundle.warnings.length) warnings.push(...bundle.warnings);

    return { entries, warnings, scanErrors, cachedAll, pathProblem, skipped: bundle.skipped };
  }

  function listCatalog(rootId) {
    const t0 = performance.now();
    const cfg = config.readConfig().find((r) => r.id === rootId);
    if (!cfg) {
      // 形状与其它接口的错误体保持一致；按约定这里用 404（资源根不存在）
      return { status: 404, body: { error: `未找到资源根: ${rootId}` } };
    }
    const { entries, warnings, scanErrors, cachedAll, pathProblem, skipped } = scanRootEntries(cfg);
    const { sawStale } = assembleEntryStates(cfg, entries);
    // §八 触发来源（三选一，别混成一条）：这一根里只要有一条是"旧结论作废"排进来的，
    //   就说明这轮探测是**能力变化**引起的（fingerprint）；否则是清单重建引起的（catalog）。
    const probeTrigger = sawStale ? 'fingerprint' : 'catalog';
    return buildCatalogResponse({
      cfg, t0, entries, warnings, scanErrors, cachedAll, pathProblem, skipped, probeTrigger,
    });
  }

  /**
   * 第②段·组装三字段：给扫描出来的条目补 candidates / ownerProvider / display / support / loadResult。
   *
   * 这是"展示归属"的唯一装配点（契约 §一 INV-D1/D4）：颜色、可装载性、最近一次结果
   *   全部由 entry-states 的 recompute 产出，这里只负责把上下文喂对。
   * @param {{id: string}} cfg 资源根
   * @param {Array} entries 扫描产物（就地写入三字段）
   */
  function assembleEntryStates(cfg, entries) {
    // ---- 展示归属：聚合键是 **fileKinds**，不是 produces.kind ----
    //
    // 为什么必须用 fileKinds（改错这里所有散目录条目会一起掉成中性色）：
    //   内置装载器（builtin-spine/builtin-live2d）与插件**同时**声明了 produces.kind='spine'/'live2d'，
    //   若按 produces.kind 反查"谁认领"，每个目录型条目都会得到两个候选 ⇒ 判不出 ⇒ accent=null。
    //   而 fileKinds 是**互斥**的：内置项是 'spine-dir'/'live2d-dir'，资源包插件是 'bundle'。
    //   ⇒ 目录型条目只匹配到 builtin-*，容器条目只匹配到 bundle 插件。
    const providers = plugins.readPlugins();
    // 提供者指纹：**一次算一次**，喂给每条记录的规则①判定（INV-D6）。
    //   不传的后果实测过：recompute 里判不了"能力是否变过" ⇒ 规则①整段跳过 ⇒
    //   插件升级后旧的"不支持"结论永远挂着（这正是本次要修的断链）。
    const providerFp = providerFingerprintOf(providers);
    const byFileKind = buildFileKindIndex(providers);
    // sawStale = 这一根里是否有条目因"旧结论作废"而进了待探测队列（决定 §八 的触发来源）
    let sawStale = false;
    for (const e of entries) {
      const computed = applyEntryStateTo(cfg, e, { providers, providerFp, byFileKind });
      if (computed && computed.pendingProbe) sawStale = true;
    }
    return { sawStale };
  }

  /**
   * 建"条目形态 → 能认领它的提供者"索引（按 matchPriority 降序，同分按 id 稳定排序）。
   *
   * 单独成函数的原因：这张表只与注册表有关、与条目无关，一条目录几万条目也只该建一次。
   * @param {Array<{id: string, fileKinds?: string[], matchPriority?: number}>} providers
   * @returns {Map<string, Array>}
   */
  function buildFileKindIndex(providers) {
    const byFileKind = new Map();
    for (const p of providers) {
      for (const fk of (Array.isArray(p.fileKinds) ? p.fileKinds : [])) {
        const k = String(fk);
        if (!byFileKind.has(k)) byFileKind.set(k, []);
        byFileKind.get(k).push(p);
      }
    }
    for (const list of byFileKind.values()) {
      list.sort((a, b) => (Number(b.matchPriority) || 0) - (Number(a.matchPriority) || 0)
        || String(a.id).localeCompare(String(b.id)));
    }
    return byFileKind;
  }

  /**
   * 给**一个**条目组三字段（assembleEntryStates 的循环体）。
   * 只做"把算好的结果写到条目上 + 归属兜底"，判断逻辑都在下面两个函数里。
   * @param {{id: string}} cfg 资源根
   * @param {object} e 条目（就地写入）
   * @param {{providers: Array, providerFp: string, byFileKind: Map}} common 每条共享的上下文
   */
  function applyEntryStateTo(cfg, e, common) {
    e.candidates = candidatesFor(e, common.byFileKind);
    if (!e.container) {
      // 目录型：唯一候选 ⇒ 归属确定；多候选/零候选 ⇒ null（中性色，不猜）
      e.ownerProvider = e.candidates.length === 1 ? e.candidates[0] : null;
    }
    const computed = computeEntryStateFor(cfg, e, common);
    e.display = computed.display;
    e.support = computed.support;
    e.loadResult = computed.loadResult;
    applyOwnerFallback(e, common.providers);
    // 回报给调用方：assembleEntryStates 要靠 pendingProbe 判断"这轮探测是不是能力变化引起的"
    return computed;
  }

  /**
   * 这条目能被哪些提供者认领（顺序即 matchPriority 顺序）。
   * @param {object} e 条目
   * @param {Map<string, Array>} byFileKind 形态 → 提供者
   * @returns {string[]} 提供者 id 列表（可能是空数组 = 没人认领）
   */
  function candidatesFor(e, byFileKind) {
    const fileKind = e.container ? 'bundle' : dirKindOf(e.kind);
    const cands = (fileKind && byFileKind.get(fileKind)) || [];
    // 容器条目在 toBundleEntry 里已经带过一份候选，这里用 fileKinds 的结论覆盖（更全、口径统一）
    return cands.map((p) => String(p.id));
  }

  /**
   * 取这一条的静态事实 + 存储状态 ⇒ recompute 出三字段（顺带登记待探测）。
   * @param {{id: string}} cfg 资源根
   * @param {object} e 条目
   * @param {{providers: Array, providerFp: string}} common
   * @returns {{display: object, support: object, loadResult: object|null, pendingProbe: boolean}}
   */
  function computeEntryStateFor(cfg, e, common) {
    const { providers, providerFp } = common;
    const key = `${cfg.id}/${e.rel || e.name}`;
    e.stateKey = key;
    // 条目的静态事实（谁认领 / 尺寸 / 缺哪些贴图）——**只写一次**：
    //   既记进 describeEntry 供 /api/entries/result 写读一体复用，也喂本行的 recompute。
    //   两处各写一份字面量就是"改一处漏一处"的经典漂移源；
    //   不含 providers：消费方（contextFor）自己取注册表，存进缓存只会白占内存。
    const entryFacts = {
      candidates: e.candidates,
      size: Number.isFinite(e.size) ? Number(e.size) : undefined,
      // 目录型条目没有"未解包"这一说 ⇒ 传 undefined 表示"没做资产检查"→ unknown，
      //   有 missingTextures（含空数组）时才由 recompute 判 ready/unsupported
      missingTextures: e.meta && Array.isArray(e.meta.missingTextures) ? e.meta.missingTextures : undefined,
      assetDependency: null,
    };
    rememberEntry(key, entryFacts);
    const state = entryStates ? entryStates.get(key) : null;
    // 规则①（能力变了 ⇒ 结论作废）与规则②（文件换了 ⇒ 该条失效）的判据都在这里接上：
    //   providerFingerprint 缺了规则①形同虚设；assetFingerprint 缺了规则②永远不触发。
    const computed = entryStates
      ? entryStates.recompute(state, {
        providers,
        ...entryFacts,
        providerFingerprint: providerFp,
        assetFingerprint: assetFingerprintOf(e.size),
      })
      : { display: { accent: null, provider: null, candidates: e.candidates }, support: { state: 'unknown', detail: null }, loadResult: null, pendingProbe: false };
    // 待探测登记（§八 判据 a/b）：**同步路径只登记**，绝不在这次请求里解析包体。
    //   · 容器条目：从没结论，或旧结论因能力/文件变化作废 ⇒ 都要排
    //   · 目录型条目：support 来自资产检查（缺贴图），与包内形态无关 ⇒ 不排
    if (e.container && (!state || computed.pendingProbe)) probeQueue.add(key);
    return computed;
  }

  /**
   * 归属兜底：唯一认领者明确时补上 provider/accent。
   *
   * 只在"还没有归属"时补 —— `loadResult.ok` 时 recompute 已经给对了（一致性约束：
   *   ok 的 loadResult 说了算），这里覆盖它就是拿声明色去盖事实色。
   * @param {object} e 条目（就地写入 display）
   * @param {Array} providers 提供者注册表
   */
  function applyOwnerFallback(e, providers) {
    if (!e.ownerProvider || e.display.provider) return;
    const hit = providers.find((p) => String(p.id) === String(e.ownerProvider));
    if (!hit) return;
    e.display.provider = String(hit.id);
    e.display.accent = hit.accent ? String(hit.accent) : null;
  }

  /**
   * 第③段·包装响应：根级诊断（rootWarning / rootIssues / capabilityNotes）+ 耗时记账 + 返回体。
   * 只做"把前两段的产物翻译成 HTTP 响应"，不再碰条目本身（想知道字段怎么来的看第②段）。
   * @param {{cfg: object, t0: number, entries: Array, warnings: string[],
   *          scanErrors: Error[], cachedAll: boolean, pathProblem: string|null, skipped?: number,
   *          probeTrigger?: 'catalog'|'fingerprint'|'manual'}} p
   * @returns {{status: number, body: object}}
   */
  function buildCatalogResponse({ cfg, t0, entries, warnings, scanErrors, cachedAll, pathProblem, skipped, probeTrigger }) {
    const rootWarning = computeRootWarning({ cfg, pathProblem, scanErrors, entries });

    // 记账（只此一处写）：耗时口径 = 本次 listCatalog 从入口到末尾的墙钟时间，
    //   source 只有两种：两根扫描器都命中清单缓存 ⇒ cache；任一重建（或抛错）⇒ built。
    //   容器列举本身没有清单缓存、每次都要 readdir，所以它不计入 cache/built 的判定
    //   （这一点必须写清：否则"cache 却也慢"会被当成 bug 去查）。
    recordRootStat({
      rootId: cfg.id,
      ms: Math.round(performance.now() - t0),
      count: entries.length,
      source: cachedAll ? 'cache' : 'built',
      at: Date.now(),
    });

    const { rootIssues, capabilityNotes } = splitWarnings(warnings, rootWarning, cfg.id);

    // "还剩多少容器没探" —— **纯附加字段**，只读快照，不触发任何扫描/解析。
    //   为什么要它：将来面板要显示探测进度时，不必再改服务端（前端拿这一次请求就够了）。
    //   口径：此刻**排队中**的条目数；不含本轮即将被取走的那一批（触发在下面，取值在之前）。
    const probeRemaining = probeQueue.size;

    // 喊一声"这一根扫完了"（§八 触发判据 a）：同步路径只负责触发，不等待、不读包。
    //   没有待探测项时探测器内部会立刻返回，等于零开销（S10）。
    //   触发来源一起传下去：catalog（清单重建）/ fingerprint（旧结论作废）/ manual（手动 POST）
    if (probeNotifier) {
      try { probeNotifier(cfg.id, probeTrigger || 'catalog'); } catch { /* 触发失败不影响列表本身 */ }
    }

    return {
      status: 200,
      body: {
        root: { id: cfg.id, name: cfg.name },
        count: entries.length,
        // 这一根的清单来源：两根扫描器都命中缓存 ⇒ cache；任一重建 ⇒ built。
        //   给前端名册计时用（perRoot 要能看出"哪根慢在命中还是重建"），纯附加字段，
        //   不改变任何缓存行为。
        source: cachedAll ? 'cache' : 'built',
        entries,
        rootWarning,
        rootIssues,
        capabilityNotes,
        // 后台探测进度（本次不做 UI，数据先就绪）：剩多少条待探。旧字段一个没动。
        probeRemaining,
        ...(skipped ? { skipped } : {}),
        // 兼容期已结束：能力说明去 capabilityNotes、根级问题去 rootIssues/rootWarning，
        //   warnings 不再承载任何内容 —— 仍保留成空数组而不是删字段，
        //   是为了让"读 warnings 后直接 .map/.join"的旧消费方拿到 [] 而不是 undefined。
        warnings: [],
      },
    };
  }

  /**
   * 根级诊断：**这根本身有没有问题**（与"这根确实没有模型"要能区分）。
   *
   * 为什么单开一个字段而不是塞进 warnings：warnings 里混着通用能力说明
   *   （例如「有 N 个能解包资源包的插件…」），前端拿它拼用户提示会得出
   *   「因为有两个插件所以没模型」这种错误因果（前端实测踩过）。
   * 现状：拆分已完成 —— 对外 `warnings` 恒为空数组，根级问题只走本字段 / `rootIssues`。
   *   上面说的"混着"指**扫描汇总的中间数组**，不是响应体里的 warnings（别按旧行为读它）。
   * 文案一律**不带绝对路径**（那是排障信息，进日志），只带 rootId 便于对照配置。
   * 优先级：路径问题 > 扫描抛错 > 扫描成功但 0 条目。
   * @param {{cfg: {id: string}, pathProblem: string|null, scanErrors: Error[], entries: Array}} p
   * @returns {string|null}
   */
  function computeRootWarning({ cfg, pathProblem, scanErrors, entries }) {
    // 三种根级问题的文案都以它结尾：格式只在这里定义一次（改样式不用改三处）
    const rootTag = `（rootId=${cfg.id}）`;
    if (pathProblem) return `${ROOT_PATH_PROBLEM_TEXT[pathProblem]}${rootTag}`;
    if (scanErrors.length) return `资源根扫描失败${rootTag}：具体原因见 warnings`;
    if (!entries.length) return `扫描完成但没有任何模型条目${rootTag}`;
    return null;
  }

  /**
   * warnings 分轨（契约 §四）：
   *   rootIssues[]      = "这一根怎么了"（可拼用户提示，带 rootId、不带绝对路径）
   *   capabilityNotes[] = 通用能力说明（"有几个插件能解包"这类），**不许**拿来拼因果
   *
   * 为什么必须拆：两者混在一起时，前端拿 warnings 拼提示会得出
   *   "因为有两个插件所以没有模型" 这种错误因果（实测踩过）。
   * 现状：拆分已落地，响应里的 `warnings` 恒为空数组；本函数只负责把**中间数组**分到两轨。
   * @param {string[]} warnings 扫描汇总
   * @param {string|null} rootWarning 根级结论（可能为 null）
   * @param {string} rootId 资源根 id
   * @returns {{rootIssues: Array<{rootId: string, text: string}>, capabilityNotes: string[]}}
   */
  function splitWarnings(warnings, rootWarning, rootId) {
    const capabilityNotes = warnings.filter((w) => isCapabilityNote(w));
    const inlineRootIssues = warnings.filter((w) => !isCapabilityNote(w))
      .map((text) => ({ rootId, text }));
    return {
      rootIssues: [
        ...(rootWarning ? [{ rootId, text: rootWarning }] : []),
        ...inlineRootIssues,
      ],
      capabilityNotes,
    };
  }

  /**
   * 只读快照：最近一次各根 catalog 构建的服务端耗时。
   * **零副作用** —— 绝不在请求时触发重建，只把内存里记下的数拷一份出来。
   * @returns {{at: number|null, totalMs: number, roots: Array<{rootId: string, ms: number, count: number, source: 'cache'|'built', at: number}>}}
   */
  function getCatalogStats() {
    return { at: stats.at, totalMs: stats.totalMs, roots: stats.roots.map((r) => ({ ...r })) };
  }

  return {
    listCatalog, getCatalogStats, setUnpackStore, describeEntry,
    // §八 后台探测的取件口（只登记与取件，判定与写回在 data/shape-probe.mjs）
    takeProbeKeys, requeueProbeKey, probeQueueSize, setProbeNotifier,
  };
}
