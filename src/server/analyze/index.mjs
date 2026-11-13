// server/analyze/index.mjs —— 只读分析接口（/api/analyze）
//
// 目标：给任意路径上的容器/模型文件一个「这是什么、能不能用、缺什么」的结论。
// 三条硬约束（写在最前，改这个文件的人先看）：
//   ① **只读**：不写文件、不改配置；打开被分析文件只用读
//   ② **不限路径**：不要求落在某个资源根内（这是这个接口与既有 /api/bundle/probe 的区别）
//   ③ **不设超时**：限量靠"字节上限 / 文件数上限"，不靠时间。产品代码里不出现 AbortSignal.timeout
//
// 实现复用：容器解析走 tool/lib/bundle-probe-node.mjs（它按 provides 找插件，一个都没有时降级为魔数判定），
//   本文件不重复实现 UnityFS/对象表解析。

import fs from 'node:fs';
import path from 'node:path';
import { probeBundleBytes, analyzeByMagicOnly } from '../../../tool/lib/bundle-probe-node.mjs';
import { memAvailableMb } from '../unpack/capacity.mjs';

/**
 * 单文件字节上限。
 * 取值理由：本项目最大的容器样本在 2GB 量级，但"只读分析"只需要读容器头与对象表；
 *   超过 512MB 的输入一律拒绝并说明，而不是边读边解析（那样内存会被拖垮，而且没有时间上限可依赖）。
 */
const MAX_FILE_BYTES = 512 * 1024 * 1024;

/** 目录递归的默认文件数上限；超出的部分写进 warnings，不静默截断。 */
const DEFAULT_MAX_FILES = 500;

/**
 * 目录递归深度上限。
 * 取值理由：真实资源树最深约 8 层（根/游戏/区服/资源类型/角色/皮肤/贴图）；
 *   12 层足够，再深基本是符号链接环或异常目录。
 */
const MAX_DIR_DEPTH = 12;

/**
 * 递归时认作"可能是容器/模型"的扩展名。
 *
 * 与扫描器判据同源（避免两套口径）。**不含普通 `.json`**：
 *   目录里 `config.json` / `package.json` 之类的配置文件远多于模型，把它们都当候选
 *   只会让 items 变成一堆噪音；真正的模型描述是 `.model3.json`（下方单独列出）。
 */
const CANDIDATE_EXT = new Set([
  '.skel', '.atlas', '.moc', '.moc3', '.model3.json', '.lpk', '.unity3d', '.bundle', '.ab',
]);

/** 读前 16 字节判种类（只用于"该不该继续读整份"的初筛） */
function readHead(absPath, n = 16) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 非 UnityFS 输入的判定（moc3 / model3.json / zip / 纯文本）。
 * 这些不走插件（插件只认 UnityFS），但要给出可读结论 —— 否则"分析一个 moc3"会得到"未知"。
 * @param {string} absPath
 * @param {Buffer} head 文件前若干字节
 * @param {number} bytes 文件大小
 * @returns {{verdict: string, summary: string, warnings: string[], extra: object}}
 */
function analyzeNonBundle(absPath, head, bytes) {
  const ascii = head.toString('latin1');
  const base = path.basename(absPath);

  if (ascii.startsWith('MOC3')) {
    // Cubism 4 的 .moc3：头部为 "MOC3" + 版本字节
    return {
      verdict: 'live2d-cubism4',
      summary: `Cubism 4 模型二进制（${bytes} 字节）`,
      warnings: [],
      extra: { moc3VersionByte: head.length > 4 ? head[4] : null },
    };
  }
  if (head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b) {
    // ZIP 容器。LPK 属于这一类，且其内部条目是加密的（元数据 JSON 里有 encrypt 字段）
    return {
      verdict: 'archive',
      summary: `ZIP 容器（${base}，${bytes} 字节）；若内部是加密条目则无法直接解析`,
      warnings: ['ZIP 内部条目可能是加密的（例如 Live2DViewerEX 的 LPK），需要对应密钥才能还原'],
      extra: {},
    };
  }
  if (ascii.trimStart().startsWith('{') || ascii.trimStart().startsWith('[')) {
    // JSON：model3.json 是 Cubism 4 的入口描述
    const isModel3 = /\.model3\.json$/i.test(base);
    return {
      verdict: isModel3 ? 'live2d-cubism4' : 'unknown',
      summary: isModel3
        ? `Cubism 4 模型描述（${base}）`
        : `JSON 文本（${base}，${bytes} 字节）`,
      warnings: [],
      extra: { json: true },
    };
  }
  return {
    verdict: 'unknown',
    summary: `无法从文件头识别（${base}，${bytes} 字节）`,
    warnings: ['不是已知的容器/模型格式；若是加密或自定义格式，需要对应的解析实现'],
    extra: {},
  };
}

/**
 * 从插件分析结论（或降级结论）推导 verdict。
 * 判据只在这里一份：插件只提供事实（TextAsset 名 / moc3 有无 / 对象数），不自己下"是什么"的结论。
 * @param {object} r probeBundleBytes / analyzeByMagicOnly 的结果
 * @returns {string}
 */
function deriveVerdict(r) {
  if (!r || r.ok === false) {
    if (r && r.magic === 'MOC3') return 'live2d-cubism4';
    if (r && r.magic === 'ZIP') return 'archive';
    if (r && r.magic === 'UnityFS') return 'bundle-unknown';   // 是容器但没插件能细看
    return 'unknown';
  }
  const textAssets = Array.isArray(r.textAssets) ? r.textAssets : [];
  if (textAssets.some((t) => t && t.kind === 'skel')) return 'spine';
  if (textAssets.some((t) => t && typeof t.name === 'string' && /\.model3\.json$/i.test(t.name))) {
    return 'live2d-cubism4';
  }
  if (r.moc3) return 'live2d-cubism4';
  if (r.cubism2Moc) return 'live2d-cubism2';
  // 有对象表但没有骨架/moc3：多半是 3D 或纯资源包
  return 'unity-3d';
}

/** 人可读的一句话结论（与 verdict 分开：verdict 给机器，summary 给人） */
function buildSummary(verdict, r, bytes) {
  const ta = Array.isArray(r && r.textAssets) ? r.textAssets : [];
  const skels = ta.filter((t) => t && t.kind === 'skel');
  const textures = Array.isArray(r && r.textures) ? r.textures : [];
  const parts = [];
  switch (verdict) {
    case 'spine':
      parts.push(`Spine 模型包（${skels.length} 个骨架）`);
      if (skels.length) {
        const first = skels[0];
        parts.push(`骨架 ${first.name}${first.spineVersion ? `（版本 ${first.spineVersion}）` : ''}`);
      }
      break;
    case 'live2d-cubism4':
      parts.push('Live2D Cubism 4 模型');
      break;
    case 'live2d-cubism2':
      parts.push('Live2D Cubism 2.1 模型（.moc，运行时已不支持）');
      break;
    case 'unity-3d':
      parts.push('Unity 资源包，未检出骨架/moc3（可能是 3D 或纯美术资源）');
      break;
    case 'bundle-unknown':
      parts.push('Unity 资源包，但当前没有能细看的插件（只识别了文件头）');
      break;
    case 'archive':
      parts.push('归档容器');
      break;
    default:
      parts.push('无法识别');
  }
  if (textures.length) {
    const formats = [...new Set(textures.map((t) => t.formatName || t.format))];
    parts.push(`${textures.length} 张纹理（${formats.slice(0, 3).join(' / ')}）`);
  }
  parts.push(`${bytes} 字节`);
  return parts.join('；');
}

/**
 * 分析一个文件（只读）。
 *
 * @param {string} absPath 绝对路径
 * @param {{maxFileBytes?: number}} [opts]
 * @returns {Promise<{status: number, body: object}>} status 用于路由直接回写
 */
export async function analyzeFile(absPath, opts = {}) {
  const maxFileBytes = opts.maxFileBytes || MAX_FILE_BYTES;

  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return {
      status: 404,
      body: { ok: false, code: 'ANALYZE_NOT_FOUND', error: `路径不存在：${absPath}` },
    };
  }
  if (stat.isDirectory()) {
    return {
      status: 400,
      body: { ok: false, code: 'ANALYZE_IS_DIR', error: `这是一个目录，请用 dir 参数：${absPath}` },
    };
  }
  if (stat.size > maxFileBytes) {
    return {
      status: 413,
      body: {
        ok: false,
        code: 'ANALYZE_TOO_LARGE',
        error: `文件超过单文件上限（${stat.size} > ${maxFileBytes} 字节）；本接口不做流式全解析`,
        bytes: stat.size,
        maxFileBytes,
      },
    };
  }

  const bytes = stat.size;
  let head;
  try {
    head = readHead(absPath, 16);
  } catch (e) {
    return { status: 500, body: { ok: false, code: 'ANALYZE_READ_FAILED', error: `读取失败：${e.message}` } };
  }

  // 非 UnityFS：不值得进插件（插件只认 UnityFS），直接给结论
  if (!head.toString('latin1').startsWith('UnityFS')) {
    const non = analyzeNonBundle(absPath, head, bytes);
    return {
      status: 200,
      body: {
        ok: true,
        path: absPath,
        bytes,
        verdict: non.verdict,
        analyzedBy: { fallback: true, magic: head.toString('latin1').slice(0, 7).replace(/[^\x20-\x7e]/g, '?') },
        container: null,
        nodes: [],
        objects: [],
        textAssets: [],
        textures: [],
        warnings: non.warnings,
        summary: non.summary,
        ...non.extra,
      },
    };
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absPath);
  } catch (e) {
    return { status: 500, body: { ok: false, code: 'ANALYZE_READ_FAILED', error: `读取失败：${e.message}` } };
  }

  let r;
  try {
    r = probeBundleBytes(new Uint8Array(buffer));
  } catch (e) {
    // 插件内部抛错（解析器 bug/损坏包）：降级给魔数结论，不把异常漏给调用方
    r = Object.assign(analyzeByMagicOnly(new Uint8Array(buffer)), { parseError: e.message });
  }

  const verdict = deriveVerdict(r);
  const analyzedBy = (r && r.pluginId)
    ? { pluginId: r.pluginId }
    : (r && r.code === 'ULB_ERR_NO_ANALYZER'
      ? { fallback: true, magic: r.magic || null }
      : { pluginId: null });

  // 纹理：ASTC 等不解码的格式进 warnings（与预检口径一致）
  const textures = Array.isArray(r.textures) ? r.textures : [];
  const warnings = Array.isArray(r.warnings) ? r.warnings.slice() : [];
  if (r.parseError) warnings.push(`插件解析抛错，已降级为文件头判定：${r.parseError}`);

  return {
    status: 200,
    body: {
      ok: true,
      path: absPath,
      bytes,
      verdict,
      analyzedBy,
      container: r.container ? {
        kind: 'UnityFS',
        version: r.container.version,
        engine: r.container.engine,
        nodes: r.container.nodes,
      } : null,
      nodes: Array.isArray(r.nodes) ? r.nodes : [],
      objects: Array.isArray(r.objects) ? r.objects : (typeof r.objects === 'number' ? [{ className: '(合计)', size: null, count: r.objects }] : []),
      textAssets: Array.isArray(r.textAssets) ? r.textAssets : [],
      textures,
      warnings,
      summary: buildSummary(verdict, r, bytes),
    },
  };
}

/**
 * 判断一个文件是否"可能是容器/模型"（用来决定是否值得打开）。
 *
 * 两条判据，任一命中即可：
 *   ① 已知扩展名（见 CANDIDATE_EXT）
 *   ② **魔数**：无扩展名或扩展名不认识的容器（实测 NIKKE 的包就是无扩展名 UnityFS 文件）
 * 为什么扩展名优先：魔数要读盘，大目录里几千个文件逐个读会把 IO 打满；
 *   扩展名匹配的直接判定，只有"看起来不像资源"的才去读文件头。
 *
 * @param {string} absPath
 * @param {string} name
 * @returns {boolean}
 */
function isCandidate(absPath, name) {
  const lower = name.toLowerCase();
  for (const ext of CANDIDATE_EXT) {
    if (lower.endsWith(ext)) return true;
  }
  // 魔数兜底：只读前 8 字节
  let head;
  try {
    head = readHead(absPath, 8);
  } catch {
    return false;
  }
  const ascii = head.toString('latin1');
  if (ascii.startsWith('UnityFS')) return true;
  if (ascii.startsWith('MOC3')) return true;
  if (ascii.startsWith('CAB-')) return true;
  if (head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b) return true;   // PK（zip/lpk）
  return false;
}

/**
 * 递归分析一个目录（只读）。
 *
 * 并发：逐个分析（上限 1）。这个接口与扫描器共用同一条"同时只做一件重活"的纪律，
 *   不另造一套并发控制 —— 分析一个包要解 LZMA + 建对象表，并发会互相拖慢并把事件循环占满。
 *
 * @param {string} absDir
 * @param {{maxFiles?: number, onItem?: Function}} [opts]
 * @returns {Promise<{status: number, body: object}>}
 */
export async function analyzeDir(absDir, opts = {}) {
  const maxFiles = opts.maxFiles || DEFAULT_MAX_FILES;

  let stat;
  try {
    stat = fs.statSync(absDir);
  } catch {
    return {
      status: 404,
      body: { ok: false, code: 'ANALYZE_NOT_FOUND', error: `目录不存在：${absDir}` },
    };
  }
  if (!stat.isDirectory()) {
    return {
      status: 400,
      body: { ok: false, code: 'ANALYZE_NOT_DIR', error: `不是目录，请用 path 参数：${absDir}` },
    };
  }

  const candidates = [];
  const warnings = [];
  let scanned = 0;
  let truncated = false;

  /** 深度优先收集候选（深度上限防环） */
  const walk = (dir, depth) => {
    if (depth > MAX_DIR_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      warnings.push(`目录不可读，已跳过：${dir}（${e.message}）`);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;   // 隐藏目录（.trash 等）不参与
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      scanned += 1;
      if (!isCandidate(full, entry.name)) continue;
      if (candidates.length >= maxFiles) {
        truncated = true;
        return;
      }
      candidates.push(full);
    }
  };
  walk(absDir, 0);

  if (truncated) {
    warnings.push(`候选文件超过上限 ${maxFiles}，只分析了前 ${maxFiles} 个（可用 maxFiles 参数调整）`);
  }

  const items = [];
  const counts = {};
  for (const file of candidates) {
    // 并发上限 1：逐个来（理由见函数头注释）
    const { status, body } = await analyzeFile(file);
    if (status !== 200 || !body.ok) {
      warnings.push(`分析失败：${file}（${body.code || status}）`);
      continue;
    }
    counts[body.verdict] = (counts[body.verdict] || 0) + 1;
    items.push({ path: body.path, bytes: body.bytes, verdict: body.verdict, summary: body.summary });
    if (typeof opts.onItem === 'function') opts.onItem(body);
  }

  return {
    status: 200,
    body: {
      ok: true,
      dir: absDir,
      scanned,
      candidates: candidates.length,
      counts,
      items,
      warnings,
      ...(memAvailableMb() !== null ? { memAvailableMb: memAvailableMb() } : {}),
    },
  };
}

/**
 * 路由：GET /api/analyze?path=<绝对路径> 或 ?dir=<绝对路径>
 *
 * @param {object} req
 * @param {object} res
 * @param {string} p 路径
 * @param {URL} url
 * @param {object} ctx 含 sendJson
 * @returns {Promise<boolean>}
 */
export async function handleAnalyze(req, res, p, url, ctx) {
  const { sendJson } = ctx;
  if (p !== '/api/analyze') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, code: 'ANALYZE_METHOD', error: '只支持 GET' });
    return true;
  }

  const targetPath = url.searchParams.get('path');
  const targetDir = url.searchParams.get('dir');
  if (!targetPath && !targetDir) {
    sendJson(res, 400, {
      ok: false,
      code: 'ANALYZE_BAD_ARGS',
      error: '需要 path（单文件）或 dir（目录）参数；两者给一个即可',
    });
    return true;
  }
  if (targetPath && targetDir) {
    sendJson(res, 400, {
      ok: false,
      code: 'ANALYZE_BAD_ARGS',
      error: 'path 与 dir 只能给一个',
    });
    return true;
  }

  const maxFilesRaw = url.searchParams.get('maxFiles');
  const maxFiles = maxFilesRaw ? Number(maxFilesRaw) : DEFAULT_MAX_FILES;

  const { status, body } = targetPath
    ? await analyzeFile(targetPath)
    : await analyzeDir(targetDir, { maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : DEFAULT_MAX_FILES });

  sendJson(res, status, body);
  return true;
}

export { MAX_FILE_BYTES, DEFAULT_MAX_FILES, MAX_DIR_DEPTH, deriveVerdict };
