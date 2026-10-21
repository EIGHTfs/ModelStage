// models.mjs —— Spine 模型扫描与清单缓存（config/models.<rootId>.json）
//
// 逻辑逐字搬自 server.mjs（行为等价由 sha256 逐字节比对验证）。
// 与旧实现的唯一差别是**结构**：原先一个函数里套着全部步骤，这里按阶段拆成
// 「建索引 → 收集目录条目 → 按 base name 分组 → 组装模型」，便于阅读与单独测试；
// 路径依赖（清单文件位置）改成显式入参，模块内不持有全局路径。
import fs from 'node:fs';
import path from 'node:path';
import { MIME, encodePath, parseAtlasPages } from '../assets/probe.mjs';

/** Live2D 清单路径（与 Spine 清单并列，互不干扰） */
function live2dModelsFile(configFile, rootId) {
  return path.join(path.dirname(configFile), `live2d.${rootId}.json`);
}

/**
 * 头像解析：① 名表记录的文件名（走 /icons/）② 模型目录自带 icon.png（走 /files/）。
 * @param {Function} getNameTable 名表读取函数（由调用方注入，避免本模块依赖项目根）
 */
export function resolveIconUrl(root, relPath, modelName, dirFiles, getNameTable) {
  // ① 名表记录的头像文件名
  const t = getNameTable(root);
  const id = (t && t.byAsset) ? t.byAsset[String(modelName).toLowerCase()] : null;
  const icon = (id && t.characters && t.characters[id]) ? String(t.characters[id].icon || '') : '';
  if (icon && root.icons && root.icons.dir) {
    return `/icons/${encodeURIComponent(root.id)}/${encodeURIComponent(icon)}`;
  }
  // ② 模型目录自带的 icon.png（Live2D）
  if (dirFiles && dirFiles.has('icon.png')) {
    const rel = relPath ? `${relPath}/icon.png` : 'icon.png';
    return `/files/${encodeURIComponent(root.id)}/${encodePath(rel)}`;
  }
  return null;
}

/** 按 atlas 声明的页名收集贴图：同目录优先，找不到再退化为全根按文件名找。 */
export function collectTextures(relPath, atlas, dirFiles, fileIndex) {
  const pages = parseAtlasPages(atlas.full);
  const textures = [];
  const missing = [];
  for (const p of pages) {
    const key = p.toLowerCase();
    let hit = dirFiles.find((f) => f.name.toLowerCase() === key);
    if (!hit && fileIndex) hit = fileIndex.get(key);
    if (hit) textures.push(hit);
    else missing.push(p);
  }
  if (missing.length) {
    console.warn(`[models] ${relPath || '.'} 缺贴图页（同目录与全根均未找到）: ${missing.join(', ')}`);
  }
  return { textures, missing };
}

/** 生成「文件 → 对外引用」的构造函数（每个文件用它自己的 relPath）。 */
export function makeFileRef(rootId, relPath) {
  return (f) => {
    const rel = f.relPath || (relPath ? `${relPath}/${f.name}` : f.name);
    return {
      name: f.name,
      path: rel,
      size: f.size,
      type: MIME[f.ext] || 'application/octet-stream',
      url: `/api/file?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(rel)}`,
    };
  };
}

/**
 * 由一个目录里的「骨架 + 同名图集」构造模型条目。
 * 注意（职责划分）：后端不做任何分组/聚合，只如实提供原始信息；
 *   角色归一是前端显示层的职责（见 public/char-tree.js 的 charKeyOf()）。
 */
export function buildModelServer(root, relPath, baseName, skel, atlas, dirFiles, fileIndex, deps) {
  const rootId = root.id;
  const rootName = root.name;
  const { textures } = collectTextures(relPath, atlas, dirFiles, fileIndex);
  // format：照抄原版实现 —— 文件名含 ".skel" 为 "skel"，否则 "json"
  const format = skel.name.toLowerCase().includes('.skel') ? 'skel' : 'json';
  const mk = makeFileRef(rootId, relPath);
  // 归一 key：atlas 内容首行的贴图名（去扩展名 + 小写）—— 该资源的真实标识
  const assetKey = atlas.assetKey || baseName;
  const dirPath = `${rootId}/${relPath}`;
  const idPath = (relPath ? `${relPath}/` : '') + baseName;

  return {
    id: `local-${rootId}-${idPath.replace(/\//g, '_')}`,
    name: assetKey,
    srcDir: relPath,
    rootId,
    rootName,
    directory: `${rootName}/${relPath}`,
    dirPath,
    version: skel.spineVersion || '4.0',
    format,
    skeletonFile: mk(skel),
    atlasFile: mk(atlas),
    textureFiles: textures.map(mk),
    textureCount: textures.length,
    fileSize: skel.size + atlas.size + textures.reduce((s, t) => s + t.size, 0),
    // atlasPma：true/false/null(未声明=未知)。不可硬编码 false —— 那等于断言"非预乘"
    atlasPma: atlas.atlasPma ?? null,
    iconUrl: resolveIconUrl(root, relPath, assetKey, new Set(dirFiles.map((f) => f.name)), deps.getNameTable),
    animations: [],
    skins: [],
    boneCount: 0,
    slotCount: 0,
    importedAt: Date.now(),
    source: 'user',
    localRoot: true,
  };
}

/**
 * 建全根文件索引（文件名小写 → 文件记录），供跨目录查找图集页。
 * 必须先建完再建模型：某模型的第 2 页可能位于尚未遍历到的兄弟目录里；
 * 同名文件保留先遇到的（与原版匹配顺序一致）。
 */
export function indexRootFiles(root) {
  const fileIndex = new Map();
  (function indexDir(absDir, relPath) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(absDir, e.name);
      const childRel = relPath ? `${relPath}/${e.name}` : e.name;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (e.isDirectory()) {
        indexDir(full, childRel);
        continue;
      }
      const key = e.name.toLowerCase();
      if (!fileIndex.has(key)) {
        fileIndex.set(key, {
          name: e.name,
          full,
          ext: path.extname(e.name).toLowerCase(),
          size: st.size,
          relPath: childRel,
        });
      }
    }
  })(root.path, '');
  return fileIndex;
}

/** 读一个目录的文件与子目录清单（文件附带版本/assetKey/PMA 探测结果）。 */
export function collectDirEntries(absDir, relPath, deps) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return { files: [], dirs: [] };
  }
  const files = [];
  const dirs = [];
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
    const ext = path.extname(e.name).toLowerCase();
    files.push({
      name: e.name,
      full,
      ext,
      size: st.size,
      // 该文件相对资源根的路径（贴图可能来自其他目录，故每个文件各自记录）
      relPath: relPath ? `${relPath}/${e.name}` : e.name,
      spineVersion: ext === '.skel' ? deps.detectSkelVersion(full)
        : ext === '.json' ? deps.detectJsonVersion(full) : null,
      assetKey: ext === '.atlas' ? deps.detectAtlasKey(full) : null,
      atlasPma: ext === '.atlas' ? deps.detectAtlasPma(full) : null,
    });
  }
  return { files, dirs };
}

/** 由目录内文件按 base name 分组，构造该目录下的模型列表。 */
export function groupModelsInDir(root, relPath, files, fileIndex, deps) {
  const models = [];
  const groups = new Map();
  for (const f of files) {
    const base = f.name.replace(/\.[^.]+$/, '');
    if (!groups.has(base)) groups.set(base, {});
    groups.get(base)[f.ext] = f;
  }
  for (const [base, g] of groups) {
    // 同名骨架优先取 .skel：二进制体积约为 .json 的一半，且是运行时标准格式
    const skel = g['.skel'] || g['.json'];
    const atlas = g['.atlas'];
    // 纯 png 目录（缺骨架或图集）不构成可加载模型，跳过
    if (!skel || !atlas) continue;
    models.push(buildModelServer(root, relPath, base, skel, atlas, files, fileIndex, deps));
  }
  return models;
}

/**
 * 递归扫描一个资源根，收集所有可加载模型。
 * 不同资源根层级不统一（BD2 两层、Mod 三层含 char/npc 分类层），
 * 一律递归到「含骨架+图集的目录」为止，不做针对层级的特殊分支。
 * 全同步实现：本地磁盘操作，同步遍历比异步更简单，也避免 HTTP 处理函数需要 async。
 */
export function scanRootServer(root, deps) {
  const models = [];
  const fileIndex = indexRootFiles(root);

  function walk(absDir, relPath) {
    const { files, dirs } = collectDirEntries(absDir, relPath, deps);
    models.push(...groupModelsInDir(root, relPath, files, fileIndex, deps));
    for (const d of dirs) {
      walk(d.full, relPath ? `${relPath}/${d.name}` : d.name);
    }
  }

  walk(root.path, '');
  return models;
}

/** 清单文件路径。 */
export function modelsFile(configFile, rootId) {
  return path.join(path.dirname(configFile), `models.${rootId}.json`);
}

/** 失效某个资源根的清单（不传则失效全部）。Spine 与 Live2D 两套清单一并处理。 */
export function invalidateModelsCache(configFile, rootId) {
  if (rootId) {
    for (const f of [modelsFile(configFile, rootId), live2dModelsFile(configFile, rootId)]) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        /* 忽略 */
      }
    }
    return;
  }
  // 全部失效：删除所有 models.<id>.json 与 live2d.<id>.json。
  //   ⚠️ 必须**要求中间有根 id**，不能只判前缀：`config/live2d.json` 是入库的手工配置
  //   （Live2D 渲染开关，带注释、留着备查），它同样以 "live2d." 开头 ——
  //   早期实现按前缀匹配会把它一起删掉（实测发生过一次，等于顺手删用户配置）。
  try {
    const dir = path.dirname(configFile);
    for (const n of fs.readdirSync(dir)) {
      const m = /^(?:models|live2d)\.(.+)\.json$/.exec(n);
      if (m && m[1] && !m[1].includes('/') && !m[1].includes('\\')) {
        fs.unlinkSync(path.join(dir, n));
      }
    }
  } catch {
    /* 忽略 */
  }
}

/** 取模型列表（优先读落盘清单，缺失或 force 时才扫描）。同步实现。 */
export function getModels(configFile, root, force, deps) {
  const f = modelsFile(configFile, root.id);

  if (!force && fs.existsSync(f)) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && Array.isArray(j.models)) {
        return { models: j.models, cached: true, ts: j.ts || Date.now() };
      }
    } catch (e) {
      console.warn(`[models] 清单 ${f} 读取失败，将重新扫描: ${e.message}`);
    }
  }

  const models = scanRootServer(root, deps);
  const payload = {
    rootId: root.id,
    rootName: root.name,
    rootPath: root.path,
    ts: Date.now(),
    count: models.length,
    models,
  };
  // 原子写入，避免写到一半被读到损坏内容
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(payload), 'utf8');
  fs.renameSync(`${f}.tmp`, f);
  console.log(`[models] 已生成清单 ${path.basename(f)}: ${models.length} 个模型`);
  return { models, cached: false, ts: payload.ts };
}

/**
 * 绑定型适配器：把 configFile 与探测函数预先固定，调用方只需 (root, force)。
 * @param {{configFile: string}} p
 * @param {object} deps 探测与名表函数
 */
export function createModels(p, deps) {
  return {
    getModels: (root, force) => getModels(p.configFile, root, force, deps),
    modelsFile: (rootId) => modelsFile(p.configFile, rootId),
    invalidateModelsCache: (rootId) => invalidateModelsCache(p.configFile, rootId),
    buildModelServer,
    scanRootServer: (root) => scanRootServer(root, deps),
    resolveIconUrl,
  };
}
