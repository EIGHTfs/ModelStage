// spine.mjs —— Spine 模型扫描与清单缓存（config/models/spine.<rootId>.json）
//   本模块只认 Spine（.skel/.json + 同名 .atlas 配对）；Live2D 走 live2d.mjs。
//   清单路径、目录创建、失效逻辑在 manifest-cache.mjs —— 那是两个扫描器共用的，不属于这里。

const log = createLogger('models');
//
// 逻辑逐字搬自 server.mjs（行为等价由 sha256 逐字节比对验证）。
// 与旧实现的唯一差别是**结构**：原先一个函数里套着全部步骤，这里按阶段拆成
// 「建索引 → 收集目录条目 → 按 base name 分组 → 组装模型」，便于阅读与单独测试；
// 路径依赖（清单文件位置）改成显式入参，模块内不持有全局路径。
import fs from 'node:fs';
import { createLogger } from '../core/log.mjs';
import { dirSignature, signatureMatches, generatorFingerprint } from './manifest-stamp.mjs';
import {
  spineManifestFile, ensureManifestDir, invalidateManifests,
} from './manifest-cache.mjs';
import path from 'node:path';
import { MIME, encodePath, parseAtlasPages } from '../assets/probe.mjs';



/**
 * 头像解析（三条候选路，按优先级）：
 *   ① 头像仓：<avatarRoot>/<names>/<avatar>（v2 主路；avatarRoot 可配置，见 docs/设计/名表.md §4.1）
 *   ② 旧 icons.dir：/icons/<rootId>/<文件名>（v1 兼容，双轨期保留）
 *   ③ 模型目录自带的 icon.png：/files/<rootId>/<相对路径>
 * 都没有 ⇒ null（前端用占位图，不阻塞）。
 *
 * 为什么头像仓要**先 stat 再返回 URL**：头像仓可能与 index 不同步（index 里写了 avatar 文件名，
 *   但 png 还没提取）。不 stat 就给 URL，前端会拿到 404 的 img，比"没有头像"更难看。
 *
 * @param {Function} getNameTable 名表读取函数（由调用方注入，避免本模块依赖项目根）
 * @param {{avatarRoot?: string}} [opts] avatarRoot = 头像仓根（可配置）
 */
export function resolveIconUrl(root, relPath, modelName, dirFiles, getNameTable, opts = {}) {
  // 名表服务端不认识结构（names.mjs 原样透传）：byAsset[key] 是角色 id（字符串），
  //   条目里的头像文件名在 `icon` 字段。只取这两样，不碰 name/costume 等业务字段。
  const t = getNameTable(root);
  const key = String(modelName).toLowerCase();
  const map = (t && t.byAsset) ? t.byAsset[key] : null;
  const id = typeof map === 'string' ? map : (map && map.char) || null;
  const entry = (id && t.characters) ? t.characters[id] : null;
  const avatar = entry ? String(entry.icon || '') : '';
  // ① 头像仓优先
  if (avatar && opts.avatarRoot && root.names) {
    const abs = path.join(opts.avatarRoot, String(root.names), avatar);
    if (fs.existsSync(abs)) {
      return `/avatars/${encodeURIComponent(root.names)}/${encodeURIComponent(avatar)}`;
    }
  }
  // ② 旧路：icons.dir（v1 兼容）
  if (avatar && root.icons && root.icons.dir) {
    return `/icons/${encodeURIComponent(root.id)}/${encodeURIComponent(avatar)}`;
  }
  // ③ 模型目录自带的 icon.png（Live2D）
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
    log.warn('缺贴图页（同目录与全根均未找到）', { dir: relPath || '.', missing });
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
    // avatarRoot 来自 paths（可配置：--avatar-root > MODELSTAGE_AVATAR_ROOT > <root>/avatars）
    iconUrl: resolveIconUrl(root, relPath, assetKey, new Set(dirFiles.map((f) => f.name)), deps.getNameTable, { avatarRoot: deps.avatarRoot }),
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

/** Spine 清单文件路径（实现在 manifest-cache 里，与 Live2D 清单同一目录）。 */
export function spineFile(configFile, rootId) {
  return spineManifestFile(configFile, rootId);
}

/** 失效清单（不传 rootId 则全部）。两套清单一并处理，实现在 manifest-cache。 */
export function invalidateCaches(configFile, rootId) {
  invalidateManifests(configFile, rootId);
}

/** 取模型列表（优先读落盘清单，缺失或 force 时才扫描）。同步实现。 */
export function getSpineModels(configFile, root, force, deps) {
  const f = spineFile(configFile, root.id);

  if (!force && fs.existsSync(f)) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && Array.isArray(j.models)) {
        // 两道判据，缺一不可：
        //   ① 生成者指纹 —— 解析代码变了就该重建（dirStamps 只感知目录增删，感知不到代码改动）
        //   ② 目录签名  —— 资源文件增删后重建，不必等 ?refresh=1
        const gen = generatorFingerprint();
        if (j.generator !== gen) {
          log.info('解析器已变化，清单失效重建', { root: root.id, from: j.generator || null, to: gen });
        } else if (signatureMatches(j.dirStamps, root.path)) {
          return { models: j.models, cached: true, ts: j.ts || Date.now() };
        } else {
          log.info('目录已变化，清单失效重建', { root: root.id });
        }
      }
    } catch (e) {
      log.warn('清单读取失败，将重新扫描', { file: f, err: e.message });
    }
  }

  const models = scanRootServer(root, deps);
  const payload = {
    rootId: root.id,
    rootName: root.name,
    rootPath: root.path,
    ts: Date.now(),
    count: models.length,
    // 生成时的目录签名：下次读清单先比对它，目录增删即自动重建（详见 manifest-stamp.mjs）
    dirStamps: dirSignature(root.path),
    // 生成时的解析器指纹：解析代码一改，这份清单自动失效（无需手工删文件）
    generator: generatorFingerprint(),
    models,
  };
  // 原子写入，避免写到一半被读到损坏内容
  ensureManifestDir(configFile);   // 清单目录（config/models/）可能还不存在：首次运行或目录被清空
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(payload), 'utf8');
  fs.renameSync(`${f}.tmp`, f);
  log.info('已生成清单', { file: path.basename(f), count: models.length });
  return { models, cached: false, ts: payload.ts };
}

/**
 * 绑定型适配器：把 configFile 与探测函数预先固定，调用方只需 (root, force)。
 * @param {{configFile: string}} p
 * @param {object} deps 探测与名表函数
 */
export function createSpineModels(p, deps) {
  return {
    getSpineModels: (root, force) => getSpineModels(p.configFile, root, force, deps),
    spineFile: (rootId) => spineFile(p.configFile, rootId),
    invalidateCaches: (rootId) => invalidateCaches(p.configFile, rootId),
    buildModelServer,
    scanRootServer: (root) => scanRootServer(root, deps),
    resolveIconUrl,
  };
}
