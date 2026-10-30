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
import { encodePath } from '../assets/probe.mjs';
// 扩展名集合复用 tree.mjs 那一份：容器列举与目录浏览必须用同一套「哪些扩展名要探魔数」，
//   两处各写一份会漂移（一处加了新扩展名、另一处没加 ⇒ 某个根莫名列不出容器，且不报错）。
import { KNOWN_FILE_EXT } from './tree.mjs';

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
    .filter((p) => Array.isArray(p.fileKinds) && p.fileKinds.includes('bundle'));
  if (!list.length) {
    return { id: null, kind: null, reason: 'no-provider', warning: '未找到能解包资源包的插件：条目 kind 无法确定' };
  }
  if (list.length > 1) {
    return {
      id: null,
      kind: null,
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
    reason: declared ? null : 'undeclared-kind',
    warning: declared ? null : `提供者 ${provider.id} 未声明产出类型（produces.kind）：kind 置空，由渲染层拒绝装载`,
  };
}

/**
 * 资源包条目 → ModelEntry。
 * 解包前拿不到内部资产，故 assets 为空、meta 只填容器信息与大小。
 */
export function toBundleEntry(cfg, file, provider) {
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
export function listBundleEntries(cfg, { plugins }) {
  const provider = resolveBundleProvider(plugins);
  const warnings = provider.warning ? [provider.warning] : [];

  const found = findContainerFiles(cfg.path, plugins.detectBundleContainer);
  if (found.stopped) {
    warnings.push(`容器列举在「${found.stopped}」处停止，可能有未列出的资源包（已列出 ${found.files.length} 个）`);
  }
  if (found.stats.depthSkipped) {
    warnings.push(`有 ${found.stats.depthSkipped} 个目录超过深度上限 ${BUNDLE_SCAN_MAX_DEPTH} 层未扫描，`
      + '更深的资源包不会被列出');
  }

  const entries = found.files.map((f) => toBundleEntry(cfg, f, provider));
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
  'not-dir': '资源根路径不是目录（配置里填的可能是文件）',
  unreadable: '资源根目录不可读（权限不足）',
};

/**
 * 装配模型目录（合并该资源根下的 Spine 与 Live2D 两路扫描）。
 * @param {{config: object, spine: object, live2d: object}} deps
 */
export function createCatalog({ config, spine, live2d, tree, plugins }) {
  /**
   * @param {string} rootId
   * @returns {{status: number, body: object}}
   */
  function listCatalog(rootId) {
    const cfg = config.readConfig().find((r) => r.id === rootId);
    if (!cfg) {
      // 形状与其它接口的错误体保持一致；按约定这里用 404（资源根不存在）
      return { status: 404, body: { error: `未找到资源根: ${rootId}` } };
    }
    const entries = [];
    const warnings = [];
    /** 扫描过程中抛的错（用于判断 rootWarning 该说"扫不动"还是"真的空"） */
    const scanErrors = [];
    // 根路径体检放在扫描之前：路径都没了就不要再问扫描器"里面有什么"
    const pathProblem = inspectRootPath(cfg.path);

    try {
      for (const m of spine.getSpineModels(cfg, false).models) entries.push(toSpineEntry(cfg, m));
    } catch (e) {
      scanErrors.push(e);
      warnings.push(`spine 扫描失败：${e.message}`);
    }
    try {
      for (const lm of live2d.getLive2DModels(cfg, false).models) entries.push(toLive2DEntry(cfg, lm));
    } catch (e) {
      scanErrors.push(e);
      warnings.push(`live2d 扫描失败：${e.message}`);
    }

    // 容器单文件（资源包本质是打包来的模型）：与普通模型一起出现在同一份清单里，
    //   所以"同一个根里既有普通模型又有容器"能被同时识别。
    //   条目 kind 取插件声明的 produces.kind（内容类型），容器标记另行保留给装载层解包用。
    const bundle = listBundleEntries(cfg, { tree, plugins });
    entries.push(...bundle.entries);
    if (bundle.warnings.length) warnings.push(...bundle.warnings);

    /**
     * 根级诊断：**这根本身有没有问题**（与"这根确实没有模型"要能区分）。
     *
     * 为什么单开一个字段而不是塞进 warnings：warnings 里混着通用能力说明
     *   （例如「有 N 个能解包资源包的插件…」），前端拿它拼用户提示会得出
     *   「因为有两个插件所以没模型」这种错误因果（前端实测踩过）。
     * 文案一律**不带绝对路径**（那是排障信息，进日志），只带 rootId 便于对照配置。
     * 优先级：路径问题 > 扫描抛错 > 扫描成功但 0 条目。
     */
    let rootWarning = null;
    // 三种根级问题的文案都以它结尾：格式只在这里定义一次（改样式不用改三处）
    const rootTag = `（rootId=${cfg.id}）`;
    if (pathProblem) {
      rootWarning = `${ROOT_PATH_PROBLEM_TEXT[pathProblem]}${rootTag}`;
    } else if (scanErrors.length) {
      rootWarning = `资源根扫描失败${rootTag}：具体原因见 warnings`;
    } else if (!entries.length) {
      rootWarning = `扫描完成但没有任何模型条目${rootTag}`;
    }

    return {
      status: 200,
      body: {
        root: { id: cfg.id, name: cfg.name },
        count: entries.length,
        entries,
        rootWarning,
        ...(bundle.skipped ? { skipped: bundle.skipped } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
    };
  }

  return { listCatalog };
}
