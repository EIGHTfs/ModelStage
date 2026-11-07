// live2d.mjs —— Live2D 模型扫描、清单缓存与运行时库探测

//
// 逻辑逐字搬自 server.mjs（行为等价由 sha256 逐字节比对验证）。
// 与旧实现的差别只在**结构**：把原先套在工厂里的步骤按职责拆开
// （引用构造 / 定义归一 / 表情 / 动作 / 组装），并把清单路径改成显式入参。
//
// 与 Spine 的关键差异：Live2D 定义文件内部用**相对路径**引用同目录文件，
//   因此对外必须给**路径式** URL（/files/<rootId>/<相对路径>）——查询串式会在相对解析时丢掉。
import fs from 'node:fs';
import { createLogger } from '../core/log.mjs';
import { dirSignature, signatureMatches, generatorFingerprint } from './manifest-stamp.mjs';
import { live2dManifestFile, ensureManifestDir, live2dManifestBase } from './manifest-cache.mjs';
import path from 'node:path';
import { encodePath } from '../assets/probe.mjs';
import { resolveLive2DRuntimes } from '../../../tool/resolve-live2d-runtimes.mjs';
// 进度节流：与 Spine 侧共用同一份实现
import { createProgressThrottle } from './scan-progress.mjs';
// P1：清单改 JSONL（边扫边写）+ 双读兼容
import { openManifestWriter, readManifest } from './manifest-jsonl.mjs';
// 并发上限 + 让路提示（同 spine，理由见 scan-queue.mjs 顶部）
import { acquireScanSlot, releaseScanSlot, isInteractiveBusy } from './scan-queue.mjs';

/** 本模块日志（统一形状 {at,level,tag,msg,detail}） */
const log = createLogger('live2d');
/** tool/ 层探测消息单独一个 tag：一眼看出是"运行时库探测"而不是"模型清单" */
const rtLog = createLogger('live2d-runtimes');

/** Live2D 清单缓存的格式版本（结构变更时 +1，旧缓存自动失效重扫） */
/** 运行时库文件清单缓存（探测一次即复用） */
let live2dRuntimeFilesCache = null;

/** Live2D 清单文件路径（与 Spine 的 models.<id>.json 并列，互不干扰）。 */
export function live2dModelsFile(configFile, rootId) {
  return live2dManifestFile(configFile, rootId);
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
    log.warn('定义文件解析失败', { file: `${relPath}/${defName}`, err: e.message });
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
  };
}

/** 扫一个目录：识别 Cubism 4（*.model3.json）优先于 Cubism 2（model.json）。 */
function modelsInDir(root, absDir, relPath, entries) {
  // 同步（回退理由同 spine.collectDirEntries：异步化在 CIFS 上更慢）
  const dirs = [];
  const files = new Map(); // 文件名 -> { name, size }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(absDir, e.name);
    // **不再逐文件 stat**：目录判定用 Dirent（`e.isDirectory()`）；
    //   这里原来的 size 唯一用途是 `model.fileSize`（前端从未读过，死数据）。
    //   注意：`fileObj()` 里的 stat **保留** —— 它要 `st.isFile()` 判「文件真的在不在」，
    //   去掉会让「引用不存在的贴图」从告警变成沉默（缺贴图页数会变多）。
    if (e.isDirectory()) {
      dirs.push({ name: e.name, full });
      continue;
    }
    files.set(e.name, { name: e.name });
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
export async function scanLive2DRootServer(root, opts = {}) {
  const models = [];
  // 进度回调可选：不传时与改动前逐字一致（现有调用方不传）
  const throttle = typeof opts.onProgress === 'function'
    ? createProgressThrottle({ onProgress: opts.onProgress, kind: 'live2d', rootId: root.id })
    : null;
  let dirsScanned = 0;

  // 分片让出：与 spine 侧同一套策略（每 20 个目录或每 50ms），理由见 spine.mjs 里的注释
  // setImmediate 而不是 setTimeout(0)：后者在负载下实际延迟可达几十 ms，扫描让出上千次会累积成数倍劣化（实测 24s→169s）
  const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));
  const YIELD_DIRS = 20;
  const YIELD_MS = 50;
  let sinceYieldDirs = 0;
  let lastYieldAt = Date.now();
  async function maybeYield() {
    sinceYieldDirs += 1;
    // 让路：有交互请求时再多让一点，但幅度有限（理由见 spine.mjs 同处注释）
    const busy = isInteractiveBusy();
    if (sinceYieldDirs >= (busy ? 12 : YIELD_DIRS) || Date.now() - lastYieldAt >= (busy ? 25 : YIELD_MS)) {
      sinceYieldDirs = 0;
      lastYieldAt = Date.now();
      await yieldToEventLoop();
    }
  }

  async function walk(absDir, relPath) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    const found = modelsInDir(root, absDir, relPath, entries);
    // 边扫边写挂点（P1）：不传则完全无副作用
    if (found.models.length) {
      models.push(...found.models);
      if (typeof opts.onModel === 'function') {
        for (const m of found.models) opts.onModel(m);
      }
    }
    dirsScanned += 1;
    if (throttle) {
      throttle.bump({ scanned: models.length, dirs: dirsScanned, currentPath: relPath, dirCompleted: true });
    }
    await maybeYield();
    for (const d of found.dirs) {
      await walk(d.full, relPath ? `${relPath}/${d.name}` : d.name);
    }
  }

  await walk(root.path, '');
  if (throttle) throttle.flush();
  return models;
}

/**
 * 取 Live2D 模型列表（带落盘缓存，逻辑与 Spine 的 getModels 一致）。
 * 为什么缓存：天命之子有 2000+ 角色目录，每次刷新全量扫描会明显变慢。
 */
/**
 * 在跑的扫描：key = `live2d:<rootId>` → promise（与 spine 同口径，理由见 spine.mjs 里的注释）。
 */
const live2dInflight = new Map();

export async function getLive2DModels(configFile, cfg, force, onProgress, onStart, onModel) {
  const key = `live2d:${cfg.id}`;
  const existing = live2dInflight.get(key);
  if (existing) return existing;
  // 先占位再启动（同 spine，理由见其注释）
  let settleResolve;
  let settleReject;
  const gate = new Promise((resolve, reject) => { settleResolve = resolve; settleReject = reject; });
  live2dInflight.set(key, gate);
  doGetLive2DModels(configFile, cfg, force, onProgress, onStart, onModel)
    .then(settleResolve, settleReject)
    .finally(() => { if (live2dInflight.get(key) === gate) live2dInflight.delete(key); });
  return gate;
}

/** 真正干活的实现（单飞包装见上面的 getLive2DModels） */
async function doGetLive2DModels(configFile, cfg, force, onProgress, onStart, onModel) {
  const base = live2dManifestBase(configFile, cfg.id);
  // 与 spine 同口径：默认 .json，env=jsonl 才写 JSONL（两种都能读）
  const wantJsonl = String(process.env.MODELSTAGE_MANIFEST_FORMAT || 'json').toLowerCase() === 'jsonl';

  if (!force) {
    // 双读：.jsonl 优先，缺则回落 .json（视为 complete=true）
    const m = readManifest(base);
    if (m.format !== 'none') {
      if (!m.complete) {
        log.info('清单不完整（complete 非 true），重建', { id: cfg.id, badLines: m.badLines });
      } else {
        const gen = generatorFingerprint();
        if (m.meta.generator !== gen) {
          log.info('解析器已变化，清单失效重建', { id: cfg.id, from: m.meta.generator || null, to: gen });
        } else if (signatureMatches(m.meta.dirStamps, cfg.path)) {
          return { models: m.models, cached: true, ts: m.meta.ts };
        } else {
          log.info('目录已变化，清单失效重建', { id: cfg.id });
        }
      }
    }
  }

  const ts = Date.now();
  const generator = generatorFingerprint();
  const dirStamps = dirSignature(cfg.path);
  ensureManifestDir(configFile);

  const writer = wantJsonl
    ? openManifestWriter(base, { rootId: cfg.id, ts, generator, dirStamps })
    : null;

  // 并发上限（同 spine）：全局只允许 1 个根在扫
  await acquireScanSlot(`live2d:${cfg.id}`);

  let models;
  try {
    models = await scanLive2DRootServer(cfg, {
      ...(onProgress ? { onProgress } : {}),
      ...(typeof onStart === 'function' ? { onStart } : {}),
      ...((writer || typeof onModel === 'function')
        ? {
          onModel: (m) => {
            if (writer) writer.append(m);
            if (typeof onModel === 'function') onModel(m);
          },
        }
        : {}),
    });
    if (writer) writer.finish(models.length);
  } catch (e) {
    if (writer) writer.abort();
    throw e;
  } finally {
    releaseScanSlot();
  }

  if (wantJsonl) {
    log.info('已生成清单（jsonl）', { id: cfg.id, count: models.length, bytes: writer.bytesWritten });
    return { models, cached: false, ts };
  }

  // 回退：只写 .json（旧格式）
  try {
    const file = `${base}.json`;
    // 清单头与 spine 完全一致（见 docs：v 是唯一的格式版本字段；kind 一律不写进清单，
    //   由 catalog 读取时盖章；rootName/rootPath 无消费方已移除）
    const body = JSON.stringify({
      rootId: cfg.id,
      ts,
      count: models.length,
      generator,
      dirStamps,
      models,
    });
    fs.writeFileSync(`${file}.tmp`, body, 'utf8');
    fs.renameSync(`${file}.tmp`, file);
  } catch (e) {
    log.warn('清单写入失败（不影响使用）', { err: e.message });
  }
  return { models, cached: false, ts };
}

/** 探测 Live2D 运行时库（Cubism Core 受专有许可约束不入库，从本地已有副本取）。 */
export function getLive2DRuntimeFiles() {
  if (!live2dRuntimeFilesCache) {
    // 注入本模块的 logger：tool 层只认「有 info/warn 的对象」，不 import server 层
    const r = resolveLive2DRuntimes({ log: rtLog });
    log.info('运行时来源', { origin: r.origin });
    log.info('运行时目录', { dir: r.dir });
    if (r.missingOptional.length) {
      log.warn('缺少可选文件（仅影响 Cubism 4 的 .moc3 模型）', { missing: r.missingOptional });
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
    getLive2DModels: (cfg, force, onProgress, onStart, onModel) => getLive2DModels(p.configFile, cfg, force, onProgress, onStart, onModel),
    getLive2DRuntimeFiles,
  };
}
