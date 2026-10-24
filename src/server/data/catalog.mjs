// catalog.mjs —— 模型来源规范化（GET /api/catalog 的数据层）
//
// 背景：Spine 与 Live2D 两路扫描输出的形状不同（入口字段、版本字段、动作字段、私有字段各一套），
//   消费方必须各自适配。这里合并两路结果，统一输出 ModelEntry（见 doc/架构-基础能力与插件.md 第十节）：
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
// 扫描不在此重复实现：直接复用 models.getModels() 与 live2d.getLive2DModels()。
import fs from 'node:fs';
import path from 'node:path';
import { encodePath } from '../assets/probe.mjs';

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
  let st;
  try {
    st = fs.statSync(absDef);
  } catch (e) {
    return { motions: [], warnings: [`motions 不可得：定义文件读取失败（${e.code || e.message}）`] };
  }
  const cached = motionCache.get(absDef);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.result;

  let result;
  try {
    const def = JSON.parse(fs.readFileSync(absDef, 'utf8'));
    const groups = (def.FileReferences && def.FileReferences.Motions) || def.motions || {};
    const motions = [];
    const missingMotions = [];
    // 定义文件**声明了**但磁盘上**不存在**的动作文件：不进 motions 清单（前端就不会去请求 ⇒ 不再产生 404），
    //   单独放进 missingMotions 供上层以 warn 级暴露（"这个模型为什么少个动作"能直接看到）。
    //   这类缺失属资产残缺，不是路径拼错——必须与原清单分开记录，别让 404 混在正常请求里。
    const defDir = path.dirname(absDef);
    for (const [group, list] of Object.entries(groups)) {
      (Array.isArray(list) ? list : []).forEach((mo, index) => {
        const file = mo ? (mo.File || mo.file) : null;
        if (!file) return;
        const rel = relPrefix ? `${relPrefix}/${file}` : String(file);
        if (!fs.existsSync(path.join(defDir, String(file)))) {
          missingMotions.push({ group, index, name: motionName(file), file: String(file) });
          return;
        }
        motions.push({
          group,
          index,
          name: motionName(file),
          url: toUrl(rel),
          fadeIn: mo.FadeIn !== undefined ? mo.FadeIn : mo.fade_in,
          fadeOut: mo.FadeOut !== undefined ? mo.FadeOut : mo.fade_out,
        });
      });
    }
    result = motions.length || missingMotions.length
      ? { motions, missingMotions, warnings: [] }
      : { motions: [], missingMotions: [], warnings: ['motions 不可得：定义文件未声明 FileReferences.Motions'] };
  } catch (e) {
    result = { motions: [], warnings: [`motions 不可得：定义文件解析失败（${e.message}）`] };
  }
  motionCache.set(absDef, { mtimeMs: st.mtimeMs, size: st.size, result });
  return result;
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
    // 为什么补：/api/models 的条目带 skeletonFile / atlasFile / textureFiles，渲染器直接读这三组；
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
  let result = { declared: [], missing: [] };
  try {
    const def = JSON.parse(fs.readFileSync(absDef, 'utf8'));
    const declared = ((def.FileReferences && def.FileReferences.Textures) || []).map(String);
    const dir = path.dirname(absDef);
    result = { declared, missing: declared.filter((rel) => !fs.existsSync(path.join(dir, rel))) };
  } catch { /* 解析失败按"无声明"处理，不制造噪音 */ }
  textureCache.set(absDef, { mtimeMs: st.mtimeMs, size: st.size, result });
  return result;
}

/**
 * Live2D 条目 → ModelEntry。
 * @param {object} cfg 资源根配置
 * @param {object} lm 扫描结果条目
 */
export function toLive2DEntry(cfg, lm) {
  const fileUrl = (p) => filesUrl(cfg.id, p);
  const assets = [];
  if (lm.mocFile) {
    assets.push({ role: 'moc3', name: lm.mocFile.name, url: fileUrl(lm.mocFile.path), size: lm.mocFile.size });
  }
  for (const t of lm.textureFiles || []) {
    assets.push({ role: 'texture', name: t.name, url: fileUrl(t.path), size: t.size });
  }

  // 动作以定义文件为准（扫描阶段的 motions 不含 group/index，且可能为空）
  const defRel = lm.defFile ? lm.defFile.path : null;
  const absDef = defRel ? path.join(cfg.path, defRel) : null;
  const fromDef = absDef
    ? readModel3Motions(absDef, fileUrl, lm.srcDir)
    : { motions: [], warnings: ['motions 不可得：缺少定义文件路径'] };
  // 只把「动作取不到」这类真缺陷放进 warnings；
  //   iconUrl 缺失是这批资源的共性（Live2D 目录普遍没有 icon.png），不作为逐条告警刷屏。
  const textureCheck = absDef ? readModel3Textures(absDef) : { declared: [], missing: [] };
  const warnings = [...fromDef.warnings];
  if (textureCheck.missing.length) {
    warnings.push(`纹理文件缺失（资产残缺，渲染会失败）：${textureCheck.missing.join('、')}——建议改用资源包版本或补齐文件`);
  }
  if (fromDef.missingMotions && fromDef.missingMotions.length) {
    warnings.push(`动作文件缺失（资产残缺，已跳过 ${fromDef.missingMotions.length} 个）：${
      fromDef.missingMotions.map((m) => `${m.group}/${m.name}`).join('、')}`);
  }

  return {
    id: lm.id,
    kind: 'live2d',
    source: 'files',
    rootId: cfg.id,
    rootName: cfg.name,
    name: lm.name,
    srcDir: lm.srcDir,
    entry: { url: lm.modelUrl, name: lm.defFile.name, size: lm.defFile.size },
    assets,
    meta: {
      version: toVersionNumber(lm.cubism),
      motions: fromDef.motions,
      missingMotions: fromDef.missingMotions || [],
      skins: [],
      expressions: lm.expressions || [],
      textureCount: (lm.textureFiles || []).length,
      // 声明了但磁盘缺失的纹理（前端据此预判 + 换源 + 提示，不必等渲染报错）
      missingTextures: textureCheck.missing,
      fileSize: lm.fileSize,
      extras: {
        cubism: lm.cubism,
        defFile: lm.defFile,
        mocFile: lm.mocFile,
      },
    },
    iconUrl: lm.iconUrl || null,
    warnings,
  };
}


/**
 * 解析资源包提供者：取「已启用的、声明了 fileKinds 含 bundle」的插件。
 * kind 一律取插件 produces.kind —— 不在 catalog 里写死内容类型，
 *   将来出现 Spine 资源包只要插件改声明即可，无需改本文件。
 * @returns {{id: string|null, kind: string|null, warning: string|null}}
 */
export function resolveBundleProvider(plugins) {
  const list = plugins.readPlugins();
  const provider = list.find((p) => Array.isArray(p.fileKinds) && p.fileKinds.includes('bundle'));
  if (!provider) {
    return { id: null, kind: null, warning: '未找到能解包资源包的插件：条目 kind 无法确定' };
  }
  const declared = provider.produces && provider.produces.kind ? String(provider.produces.kind) : null;
  return {
    id: provider.id,
    kind: declared,
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
  if (!provider.kind) warnings.unshift('提供者未声明产出类型');
  return {
    id: `bundle-${cfg.id}-${file.name}`,
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
 * 列资源包根下的条目：容器判定复用 tree 的结果（不在这里重读文件头）。
 * @returns {{entries: Array, warnings: string[], skipped: number}}
 */
export function listBundleEntries(cfg, { tree, plugins }) {
  const listed = tree.listTree(cfg.id, '');
  if (listed.status !== 200) {
    return { entries: [], warnings: [`目录列举失败：${listed.body.error || listed.status}`], skipped: 0 };
  }
  const provider = resolveBundleProvider(plugins);
  // 容器单文件由列举层用魔数标记（`container`），与根类型无关
  const containers = (listed.body.files || []).filter((f) => f.container);
  const entries = containers.map((f) => toBundleEntry(cfg, f, provider));
  const warnings = provider.warning ? [provider.warning] : [];
  return { entries, warnings, skipped: countSkippedFiles(cfg.path, containers.length) };
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
 * 装配模型目录（合并该资源根下的 Spine 与 Live2D 两路扫描）。
 * @param {{config: object, models: object, live2d: object}} deps
 */
export function createCatalog({ config, models, live2d, tree, plugins }) {
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

    try {
      for (const m of models.getModels(cfg, false).models) entries.push(toSpineEntry(cfg, m));
    } catch (e) {
      warnings.push(`spine 扫描失败：${e.message}`);
    }
    try {
      for (const lm of live2d.getLive2DModels(cfg, false).models) entries.push(toLive2DEntry(cfg, lm));
    } catch (e) {
      warnings.push(`live2d 扫描失败：${e.message}`);
    }

    // 容器单文件（资源包本质是打包来的模型）：与普通模型一起出现在同一份清单里，
    //   所以"同一个根里既有普通模型又有容器"能被同时识别。
    //   条目 kind 取插件声明的 produces.kind（内容类型），容器标记另行保留给装载层解包用。
    const bundle = listBundleEntries(cfg, { tree, plugins });
    entries.push(...bundle.entries);
    if (bundle.warnings.length) warnings.push(...bundle.warnings);

    return {
      status: 200,
      body: {
        root: { id: cfg.id, name: cfg.name },
        count: entries.length,
        entries,
        ...(bundle.skipped ? { skipped: bundle.skipped } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
    };
  }

  return { listCatalog };
}
