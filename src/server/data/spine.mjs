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
  spineManifestFile, spineManifestBase, ensureManifestDir, invalidateManifests,
} from './manifest-cache.mjs';
import path from 'node:path';
import { MIME, encodePath, parseAtlasPages } from '../assets/probe.mjs';
// 进度节流：与单飞层共用同一份实现（P0 起扫描可见进度，节流规则见设计 §5.1）
import { createProgressThrottle } from './scan-progress.mjs';
// P1：清单改 JSONL（边扫边写）+ 双读兼容
import { openManifestWriter, readManifest } from './manifest-jsonl.mjs';



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
export async function indexRootFiles(root, opts = {}) {
  const fileIndex = new Map();
  // 建索引同样是**同步遍历**，在 bd2（431 个目录）上实测占 4.3s。
  //   不在这里让出的话，这段时间里一帧进度都发不出去（前端会以为卡死）。
  //   让出策略与 walk 一致：每 20 个目录 或 每 50ms。
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  let sinceYield = 0;
  let lastYieldAt = Date.now();
  let dirsIndexed = 0;
  async function maybeYield() {
    sinceYield += 1;
    if (sinceYield >= 20 || Date.now() - lastYieldAt >= 50) {
      sinceYield = 0;
      lastYieldAt = Date.now();
      if (onProgress) onProgress({ dirs: dirsIndexed });
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  async function indexDir(absDir, relPath) {
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
        dirsIndexed += 1;
        await indexDir(full, childRel);
        await maybeYield();
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
  }
  await indexDir(root.path, '');
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
 * 分片让出的**异步**实现：`collectDirEntries` / `indexRootFiles` 用的是同步 readdir，
 *   整棵树的遍历会占满一个事件循环切片 —— 期间 res.write 的数据发不出去（实测 433 帧全挤在末尾 2ms）。
 *   所以每 20 个目录或每 50ms `await setImmediate` 让出一次，进度帧才真的能"边扫边到"。
 *   注意：这里**没有**用异步 readdir（fs.promises），因为同步 readdir 单次更快、
 *   且 CIFS 上并发 readdir 收益不明显；分片让出已足够让出 CPU 给 IO 回调。
 */
export async function scanRootServer(root, deps) {
  const models = [];
  // 进度回调是**可选**的：不传就与改动前逐字一致（现有调用方与测试都不传）。
  //   节流放在这里而不是调用方，因为只有这里同时知道"已扫到第几个目录"和"累计多少模型"。
  //   **必须定义在建索引之前** —— indexRootFiles 的 onProgress 要引用它（否则 TDZ ReferenceError）。
  const throttle = deps && typeof deps.onProgress === 'function'
    ? createProgressThrottle({ onProgress: deps.onProgress, kind: 'spine', rootId: root.id })
    : null;
  const fileIndex = await indexRootFiles(root, {
    onProgress: throttle
      ? () => throttle.bump({ scanned: models.length, dirs: 0, currentPath: '(建索引)', dirCompleted: false })
      : undefined,
  });
  let dirsScanned = 0;

  /**
   * 让出事件循环。
   *
   * 为什么必须有：`collectDirEntries` 用的是同步 readdir，整个 walk 会在**一个事件循环切片**里跑完
   *   ⇒ 期间 `res.write` 只进内核缓冲、一帧都发不出去（实测 433 帧全挤在扫描结束后 2ms 内涌出）。
   *   每积累一点工作量就 `await setImmediate`，把控制权还给 IO 回调，帧才真的能"边扫边到"。
   * 为什么用 setImmediate 而不是 setTimeout(0)：setImmediate 在 check 阶段就跑，
   *   没有 setTimeout 的最小 1ms 计时器开销；扫描一次要让出几百次时这个差别不小。
   */
  const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

  // 让出判据：每 20 个目录 **或** 每 50ms，先到就先让出一次。
  //   只看目录数不够 —— 遇到单个巨大目录时目录数不变但耗时在涨；只看时间不够 —— 空目录树会几乎不让出。
  const YIELD_DIRS = 20;
  const YIELD_MS = 50;
  let sinceYieldDirs = 0;
  let lastYieldAt = Date.now();
  async function maybeYield() {
    sinceYieldDirs += 1;
    if (sinceYieldDirs >= YIELD_DIRS || Date.now() - lastYieldAt >= YIELD_MS) {
      sinceYieldDirs = 0;
      lastYieldAt = Date.now();
      await yieldToEventLoop();
    }
  }

  // 边扫边写挂点：每产出一条模型就回调一次（P1）。不传则完全无副作用。
  const onModel = deps && typeof deps.onModel === 'function' ? deps.onModel : null;
  function collectModels(produced) {
    if (!produced.length) return;
    models.push(...produced);
    if (onModel) {
      for (const m of produced) onModel(m);
    }
  }

  async function walk(absDir, relPath) {
    const { files, dirs } = collectDirEntries(absDir, relPath, deps);
    collectModels(groupModelsInDir(root, relPath, files, fileIndex, deps));
    dirsScanned += 1;
    if (throttle) {
      throttle.bump({ scanned: models.length, dirs: dirsScanned, currentPath: relPath, dirCompleted: true });
    }
    await maybeYield();
    for (const d of dirs) {
      await walk(d.full, relPath ? `${relPath}/${d.name}` : d.name);
    }
  }

  await walk(root.path, '');
  // 补发最后一帧：保证前端拿到的最终计数与返回的 models.length 一致，而不是停在某个中间值
  if (throttle) throttle.flush();
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
/**
 * 在跑的扫描：key = `spine:<rootId>` → promise。
 *
 * 为什么单飞要放在**这里**（而不是只放在 stream 路由层）：
 *   非流式请求（`/api/spine/models` 不带 stream）原本各自起一次扫描 ——
 *   实测同一根 30s 内出现 4 次"清单失效重建"，一次 curl 等了 171s。
 *   放到扫描本体这里，**所有调用方**（流式 / 非流式 / catalog / 探测）自然共用同一次扫描。
 * force=1 时若已有扫描在跑也**复用**（用户在 UI 上狂点刷新不该变成 N 次全量扫描）。
 */
const spineInflight = new Map();

export async function getSpineModels(configFile, root, force, deps) {
  const key = `spine:${root.id}`;
  const existing = spineInflight.get(key);
  if (existing) return existing;

  // **先占位，再启动** —— 这一步不能省。
  //   doGetSpineModels 的第一个 await（onStart 后的 setImmediate）会**让出事件循环**；
  //   如果先调它、后 set，那么同一 tick 里进来的并发请求都会看到"没人跑" ⇒ 各起一次扫描
  //   （实测：4 个并发 refresh=1 ⇒ 重建 4 次、总墙钟 334s）。
  //   先塞一个 pending promise 进表，后来者立刻拿到同一个 promise。
  let settleResolve;
  let settleReject;
  const gate = new Promise((resolve, reject) => { settleResolve = resolve; settleReject = reject; });
  spineInflight.set(key, gate);
  doGetSpineModels(configFile, root, force, deps)
    .then(settleResolve, settleReject)
    .finally(() => { if (spineInflight.get(key) === gate) spineInflight.delete(key); });
  return gate;
}

/** 真正干活的实现（单飞包装见上面的 getSpineModels） */
async function doGetSpineModels(configFile, root, force, deps) {
  const base = spineManifestBase(configFile, root.id);
  // 写入格式：**默认 .json（保持原有行为）**；MODELSTAGE_MANIFEST_FORMAT=jsonl 才写 JSONL。
  //   两种格式都可读（readManifest 优先当前格式、缺失回落另一种），切换不需要迁移历史文件。
  const wantJsonl = String(process.env.MODELSTAGE_MANIFEST_FORMAT || 'json').toLowerCase() === 'jsonl';

  if (!force) {
    // 双读：.jsonl 优先，缺则回落 .json（历史格式，视为 complete=true —— 兼容关键）
    const m = readManifest(base);
    if (m.format !== 'none') {
      if (!m.complete) {
        // 第三道门：半成品不当结果（进程被杀 / 写入中断）。先重建，别把半截清单当答案。
        log.info('清单不完整（complete 非 true），重建', { root: root.id, badLines: m.badLines, err: m.error || null });
      } else {
        // 前两道门原样保留（现在从 meta 读）：① 解析器指纹 ② 目录签名
        const gen = generatorFingerprint();
        if (m.meta.generator !== gen) {
          log.info('解析器已变化，清单失效重建', { root: root.id, from: m.meta.generator || null, to: gen });
        } else if (signatureMatches(m.meta.dirStamps, root.path)) {
          return { models: m.models, cached: true, ts: m.meta.ts || Date.now() };
        } else {
          log.info('目录已变化，清单失效重建', { root: root.id });
        }
      }
    }
  }

  // 在真正开始扫描前通知一次 —— 让"首帧到达"不必等 indexRootFiles 那一步（同步建索引，实测 4s+）
  if (deps && typeof deps.onStart === 'function') {
    deps.onStart();
    // **必须紧接着让出一次**：res.write 只是把数据放进 Node 的输出缓冲，
    //   真正写到 socket 要等事件循环的下一个 tick。而下一步 indexRootFiles 是同步的（实测 4.6s），
    //   不让出的话首帧照样要等到扫描启动才到达 —— 那样 onStart 就白加了。
    await new Promise((resolve) => setImmediate(resolve));
  }

  const ts = Date.now();
  const generator = generatorFingerprint();
  // 目录签名在扫描**前**算：它只扫根的一层子目录 mtime（ms 级），不影响首帧；
  //   而且它必须与"这次扫描看到的内容"对应，放扫描后算反而可能记进别人刚改的结果。
  const dirStamps = dirSignature(root.path);

  ensureManifestDir(configFile);   // 清单目录（config/models/）可能还不存在：首次运行或目录被清空

  // 边扫边写：writer 在 run 内创建、与这次扫描同生命周期 —— 单飞保证同一 key 只有一个 writer。
  //   同步 append 是微秒级（几十~几百字节），不会像目录遍历那样长时间占住事件循环。
  const writer = wantJsonl
    ? openManifestWriter(base, { kind: 'spine', rootId: root.id, ts, generator, dirStamps })
    : null;
  const scanDeps = writer ? { ...deps, onModel: (m) => writer.append(m) } : deps;

  let models;
  try {
    models = await scanRootServer(root, scanDeps);
    if (writer) writer.finish(models.length);
  } catch (e) {
    // 失败只 abort：正式 .jsonl 保持上一次的完整版本（tmp 留着供排查）
    if (writer) writer.abort();
    throw e;
  }

  if (wantJsonl) {
    log.info('已生成清单（jsonl）', { file: path.basename(base) + '.jsonl', count: models.length, bytes: writer.bytesWritten });
    return { models, cached: false, ts };
  }

  // 回退：只写 .json（旧格式，一次性序列化 —— 这个分支本来就不支持"边扫边写"）
  const payload = { rootId: root.id, rootName: root.name, rootPath: root.path, ts, count: models.length, dirStamps, generator, models };
  const f = `${base}.json`;
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(payload), 'utf8');
  fs.renameSync(`${f}.tmp`, f);
  log.info('已生成清单（json 回退）', { file: path.basename(f), count: models.length });
  return { models, cached: false, ts };
}

/**
 * 绑定型适配器：把 configFile 与探测函数预先固定，调用方只需 (root, force)。
 * @param {{configFile: string}} p
 * @param {object} deps 探测与名表函数
 */
export function createSpineModels(p, deps) {
  return {
    // 第三个参数是**每次调用的额外 deps**（目前只有 onProgress）：与既有 deps 合并即可，
    //   不传时逐字等同于旧行为。(p.configFile/root/force/deps 都在闭包里)
    getSpineModels: (root, force, extraDeps) => getSpineModels(
      p.configFile, root, force, extraDeps ? { ...deps, ...extraDeps } : deps,
    ),
    spineFile: (rootId) => spineFile(p.configFile, rootId),
    invalidateCaches: (rootId) => invalidateCaches(p.configFile, rootId),
    buildModelServer,
    scanRootServer: (root) => scanRootServer(root, deps),   // 返回 Promise（已 async 化）
    resolveIconUrl,
  };
}
