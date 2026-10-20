// live2d.mjs —— Live2D 模型扫描、清单缓存与运行时库探测
//
// 逻辑逐字搬自 server.mjs（行为等价由 sha256 逐字节比对验证）。
// 与旧实现的差别只在**结构**：把原先套在工厂里的步骤按职责拆开
// （引用构造 / 定义归一 / 表情 / 动作 / 组装），并把清单路径改成显式入参。
//
// 与 Spine 的关键差异：Live2D 定义文件内部用**相对路径**引用同目录文件，
//   因此对外必须给**路径式** URL（/files/<rootId>/<相对路径>）——查询串式会在相对解析时丢掉。
import fs from 'node:fs';
import path from 'node:path';
import { encodePath } from '../assets/probe.mjs';
import { resolveLive2DRuntimes } from '../../../tool/resolve-live2d-runtimes.mjs';

/** Live2D 清单缓存的格式版本（结构变更时 +1，旧缓存自动失效重扫） */
const LIVE2D_MANIFEST_VERSION = 1;
/** 运行时库文件清单缓存（探测一次即复用） */
let live2dRuntimeFilesCache = null;

/** Live2D 清单文件路径（与 Spine 的 models.<id>.json 并列，互不干扰）。 */
export function live2dModelsFile(configFile, rootId) {
  return path.join(path.dirname(configFile), `live2d.${rootId}.json`);
}

/** 构造两个引用工具：对外 URL 与「磁盘上存在才返回」的文件对象。 */
export function makeLive2DRefs(root, relPath) {
  const fileUrl = (name) => `/files/${encodeURIComponent(root.id)}/${encodePath(relPath ? `${relPath}/${name}` : name)}`;
  // 引用可能带子目录（Cubism 4 实测 Textures 为 textures/texture_00.png），
  //   故直接按磁盘相对模型目录判断存在性，而不是只在本目录直接子文件里找
  const fileObj = (name) => {
    if (!name) return null;
    const abs = path.join(root.path, relPath, name);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    return {
      name: path.basename(name),
      path: relPath ? `${relPath}/${name}` : name,
      size: st.size,
      url: fileUrl(name),
    };
  };
  return { fileUrl, fileObj };
}

/**
 * 归一引用字段：**Cubism 4 在 FileReferences 下，Cubism 2 在顶层**，
 * 且两者字段名大小写不同（4 首字母大写、2 小写），这里统一成一套内部表示。
 */
export function normalizeLive2DRefs(cubism, def) {
  const fr = (cubism === 4 && def.FileReferences) ? def.FileReferences : def;
  return {
    rawMoc: cubism === 4 ? fr.Moc : def.model,
    rawTextures: (cubism === 4 ? fr.Textures : def.textures) || [],
    rawExpressions: (cubism === 4 ? fr.Expressions : def.expressions) || [],
    rawMotions: (cubism === 4 ? fr.Motions : def.motions) || {},
  };
}

/** 表情：Cubism 2 用小写 file/name，Cubism 4 用大写 File/Name，两者都要兼容。 */
export function buildExpressions(rawExpressions, fileObj, fileUrl) {
  return (Array.isArray(rawExpressions) ? rawExpressions : [])
    .map((e) => (e ? { name: e.Name || e.name, file: e.File || e.file } : null))
    .filter((e) => e && e.file && fileObj(e.file))
    .map((e) => ({
      name: e.name || path.basename(String(e.file)).replace(/\.[^.]+$/, ''),
      file: e.file,
      url: fileUrl(e.file),
    }));
}

/** 动作：按分组聚合，只保留磁盘上确实存在的文件。 */
export function buildMotions(rawMotions, fileObj, fileUrl) {
  const motions = {};
  for (const [group, list] of Object.entries(rawMotions)) {
    const arr = (Array.isArray(list) ? list : [])
      .map((mo) => (mo ? {
        file: mo.File || mo.file,
        fadeIn: mo.FadeIn !== undefined ? mo.FadeIn : mo.fade_in,
        fadeOut: mo.FadeOut !== undefined ? mo.FadeOut : mo.fade_out,
      } : null))
      .filter((mo) => mo && mo.file && fileObj(mo.file))
      .map((mo) => ({
        name: path.basename(String(mo.file)).replace(/\.[^.]+$/, ''),
        file: mo.file,
        url: fileUrl(mo.file),
        fadeIn: mo.fadeIn,
        fadeOut: mo.fadeOut,
      }));
    if (arr.length) motions[group] = arr;
  }
  return motions;
}

/** 构造 Live2D 模型对象（一个定义文件 = 一个模型）。 */
export function buildLive2DModel(root, relPath, defName, cubism) {
  const absDef = path.join(root.path, relPath, defName);
  let def;
  try {
    def = JSON.parse(fs.readFileSync(absDef, 'utf8'));
  } catch (e) {
    console.warn(`[live2d] 定义文件解析失败 ${relPath}/${defName}: ${e.message}`);
    return null;
  }

  const { rawMoc, rawTextures, rawExpressions, rawMotions } = normalizeLive2DRefs(cubism, def);
  const { fileUrl, fileObj } = makeLive2DRefs(root, relPath);
  const mocName = rawMoc ? String(rawMoc) : '';
  const textures = (Array.isArray(rawTextures) ? rawTextures : []).filter((t) => typeof t === 'string' && fileObj(t));
  const expressions = buildExpressions(rawExpressions, fileObj, fileUrl);
  const motions = buildMotions(rawMotions, fileObj, fileUrl);
  const name = (relPath || '').split('/').pop() || relPath || root.id;

  return {
    id: `live2d-${root.id}-${(relPath || '.').replace(/\//g, '_')}`,
    kind: 'live2d',
    cubism,
    name,
    srcDir: relPath,
    rootId: root.id,
    rootName: root.name,
    // 前端加载入口：**路径式** URL，定义文件里的相对引用才能正确解析
    modelUrl: fileUrl(defName),
    defFile: fileObj(defName),
    mocFile: fileObj(mocName),
    textureFiles: textures.map(fileObj).filter(Boolean),
    expressions,
    motions,
    // 列表缩略图：模型目录里的 icon.png（有则用）
    iconUrl: fileObj('icon.png') ? fileUrl('icon.png') : null,
    fileSize: [defName, mocName, ...textures, ...expressions.map((e) => e.file),
      ...Object.values(motions).flat().map((mo) => mo.file)]
      .map(fileObj).filter(Boolean).reduce((sum, f) => sum + f.size, 0),
  };
}

/** 扫一个目录：识别 Cubism 4（*.model3.json）优先于 Cubism 2（model.json）。 */
function modelsInDir(root, absDir, relPath, entries) {
  const dirs = [];
  const files = new Map(); // 文件名 -> { name, size }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(absDir, e.name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (e.isDirectory()) {
      dirs.push({ name: e.name, full });
      continue;
    }
    files.set(e.name, { name: e.name, size: st.size });
  }
  const out = [];
  const def4 = [...files.keys()].find((n) => /\.model3\.json$/i.test(n)) || null;
  const defName = def4 || (files.has('model.json') ? 'model.json' : null);
  if (defName) {
    const m = buildLive2DModel(root, relPath, defName, def4 ? 4 : 2);
    if (m) out.push(m);
  }
  return { models: out, dirs };
}

/** 扫描一个资源根里的全部 Live2D 模型。 */
export function scanLive2DRootServer(root) {
  const models = [];

  function walk(absDir, relPath) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    const found = modelsInDir(root, absDir, relPath, entries);
    models.push(...found.models);
    for (const d of found.dirs) walk(d.full, relPath ? `${relPath}/${d.name}` : d.name);
  }

  walk(root.path, '');
  return models;
}

/**
 * 取 Live2D 模型列表（带落盘缓存，逻辑与 Spine 的 getModels 一致）。
 * 为什么缓存：天命之子有 2000+ 角色目录，每次刷新全量扫描会明显变慢。
 */
export function getLive2DModels(configFile, cfg, force) {
  const file = live2dModelsFile(configFile, cfg.id);
  if (!force && fs.existsSync(file)) {
    try {
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (payload.version === LIVE2D_MANIFEST_VERSION && Array.isArray(payload.models)) {
        return { models: payload.models, cached: true, ts: payload.ts };
      }
    } catch {
      /* 缓存损坏则重扫 */
    }
  }
  const models = scanLive2DRootServer(cfg);
  const ts = Date.now();
  try {
    fs.writeFileSync(file, JSON.stringify({ version: LIVE2D_MANIFEST_VERSION, rootId: cfg.id, ts, models }), 'utf8');
  } catch (e) {
    console.warn(`[live2d] 清单写入失败（不影响使用）: ${e.message}`);
  }
  return { models, cached: false, ts };
}

/** 探测 Live2D 运行时库（Cubism Core 受专有许可约束不入库，从本地已有副本取）。 */
export function getLive2DRuntimeFiles() {
  if (!live2dRuntimeFilesCache) {
    const r = resolveLive2DRuntimes();
    console.info(`[live2d] 运行时来源: ${r.origin}`);
    console.info(`[live2d] 运行时目录: ${r.dir}`);
    if (r.missingOptional.length) {
      console.info(`[live2d] 缺少可选文件（仅影响 Cubism 4 的 .moc3 模型）: ${r.missingOptional.join(', ')}`);
    }
    live2dRuntimeFilesCache = r.files;
  }
  return live2dRuntimeFilesCache;
}

/**
 * 绑定型适配器：把清单路径固定，调用方只需 (cfg, force)。
 * @param {{configFile: string}} p
 */
export function createLive2d(p) {
  return {
    live2dModelsFile: (rootId) => live2dModelsFile(p.configFile, rootId),
    buildLive2DModel,
    scanLive2DRootServer,
    getLive2DModels: (cfg, force) => getLive2DModels(p.configFile, cfg, force),
    getLive2DRuntimeFiles,
  };
}
