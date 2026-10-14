// ============================================================================
// tool/lib/export-bundle.mjs —— 把 UnityFS 资源包导出成「标准 Live2D 模型目录」
//
// 产出目录（与 AzurLane-Live2D-Viewer 等第三方查看器认可的形态一致）：
//   <out>/<资源名>/
//     <资源名>.moc3
//     <资源名>.physics3.json          （包里没有就跳过）
//     <资源名>.model3.json            （FileReferences 指向同目录文件）
//     textures/texture_XX.png         （ETC2/DXT 解码 → RGBA → PNG 真压缩）
//     export-report.json              （耗时/字节/跳过/警告，便于批量核对）
//
// 为什么这样组织：
//   · 解析/解码/编码全部复用插件里的 lib（同一份实现，避免第二套解析）
//   · PNG 必须用 encodePngAsync（真 deflate）；encodePng 是 stored 不压缩，4096² 会写 67MB
//   · 先写 .tmp-<name>-<pid>/ 再 rename，失败/断电不留半成品
//   · 阶段 1 **不导出 motion3**：生成 motion3 需要 moc3 的真实参数 Id（Cubism Core），
//     纯 Node 侧拿不到（实测用名字候选建立的 hashLookup 会让 466 条曲线全部 skippedUnknownBinding）
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { getParameterIds, coreInfo } from './cubism-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const LIB_DIR = path.join(ROOT, 'plugins', 'unity-live2d-bundle', 'lib');

// 依赖顺序：errors 最先，model3 最后（组装 model3.json）
const LIB_ORDER = [
  'errors.js', 'bytes.js', 'common-strings.js', 'unityfs.js', 'serialized.js', 'typetree.js',
  'extract.js', 'etc2.js', 'dxt.js', 'texdecode.js', 'png.js', 'anim-to-motion.js', 'model3.js',
];

let sandbox = null;
/** 建（或取缓存的）插件库沙箱；PNG 的 deflate/inflate 用 Node 的 zlib 注入 */
function getLibs() {
  if (sandbox) return sandbox;
  const ctx = { console: { log() {}, info() {}, warn() {}, error() {} }, TextDecoder, TextEncoder, setTimeout, clearTimeout };
  ctx.globalThis = ctx; ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  for (const rel of LIB_ORDER) {
    const abs = path.join(LIB_DIR, rel);
    if (!fs.existsSync(abs)) throw new Error(`导出依赖缺失：${abs}`);
    vm.runInContext(fs.readFileSync(abs, 'utf8'), ctx, { filename: `ulb-lib/${rel}` });
  }
  const NS = ctx.__ULB__;
  if (NS.png && NS.png.setDeflate) NS.png.setDeflate((u8) => new Uint8Array(zlib.deflateSync(Buffer.from(u8))));
  if (NS.png && NS.png.setInflate) NS.png.setInflate((u8) => new Uint8Array(zlib.inflateSync(Buffer.from(u8))));
  sandbox = NS;
  return sandbox;
}

/** 递归汇总目录字节数（报告用） */
function dirBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch { /* 忽略单个文件 */ } }
    }
  };
  walk(dir);
  return total;
}

/**
 * 解析资源包并规划导出（不写盘）。dryRun 也走这一步，保证"将要做什么"与真做一致。
 * @returns {{name, textures:[{name,w,h,format,formatName,supported}], moc3Bytes, physicsBytes, warnings, skippedTextures}}
 */
export function planExport(bundleBytes) {
  const NS = getLibs();
  const E = NS.errors;
  if (!bundleBytes || !bundleBytes.length) throw E.fail(E.CODES.NO_FILE, '资源包为空或不存在');
  let sig = '';
  for (let i = 0; i < Math.min(7, bundleBytes.length); i++) sig += String.fromCharCode(bundleBytes[i]);
  if (sig !== 'UnityFS') throw E.fail(E.CODES.NOT_UNITYFS, `不是 UnityFS 资源包（signature="${sig.replace(/[^\x20-\x7e]/g, '?')}"）`);

  let parsed, sf, got;
  try {
    parsed = NS.unityfs.parse(bundleBytes);
    const cab = parsed.nodes.find((n) => /^CAB-/.test(n.path));
    if (!cab) throw E.fail(E.CODES.NO_CAB, '资源包里没有 CAB-* 节点（不是资产包）');
    const resS = parsed.nodes.find((n) => /\.resS$/.test(n.path));
    const cabBytes = NS.unityfs.nodeBytes(parsed, cab.path);
    const resSBytes = resS ? NS.unityfs.nodeBytes(parsed, resS.path) : null;
    sf = NS.serialized.parse(cabBytes);
    got = NS.extract.extractAll({ cabBytes, resSBytes, sf, resSBytesForTextures: resSBytes });
  } catch (e) {
    if (e && e.code) throw e;
    throw E.fail(E.CODES.CONTAINER_PARSE, `容器解析失败：${e.message}`);
  }
  if (!got.moc3) throw E.fail(E.CODES.MODEL_BUILD, '包里没有 moc3（不是 Live2D 资源包？）');

  const textures = (got.textures || []).map((t) => {
    const f = NS.texdecode.FORMATS[t.format];
    return {
      name: t.name, width: t.width, height: t.height, format: t.format,
      formatName: f ? f.name : `未知格式 ${t.format}`,
      supported: !!f,
    };
  });
  return {
    parsed, sf, got, textures,
    moc3Bytes: got.moc3,
    physicsBytes: got.physics3 || null,
    warnings: [],
    skippedTextures: textures.filter((t) => !t.supported).map((t) => t.formatName),
  };
}

/**
 * 执行导出。
 * @param {object} opts
 *   bundleBytes 资源包字节 | outDir 输出根 | name 资源名 | force 覆盖 | dryRun 只规划
 *   profile 可选（传给 buildModel3，用于 HitAreas 等）
 *   onProgress({stage, ...})
 */

/** 最坏情况产物估算：PNG 压缩后体积 ≤ 原始 RGBA，用它做磁盘检查上界 */
function estimateBytes(plan) {
  let raw = 0;
  for (const t of plan.textures) if (t.supported) raw += t.width * t.height * 4;
  return raw + plan.moc3Bytes.length + (plan.physicsBytes ? plan.physicsBytes.length : 0);
}

/**
 * 磁盘余量检查：剩余 < 预估×1.5 直接抛 ULB_ERR_EXPORT_NO_SPACE；
 * 查不到剩余空间（如跨设备/权限）只记 warning，不阻断导出。
 */
function checkDisk(NS, outRoot, estimate, warnings) {
  try {
    let probeDir = outRoot;
    while (!fs.existsSync(probeDir) && path.dirname(probeDir) !== probeDir) probeDir = path.dirname(probeDir);
    const st = fs.statfsSync(probeDir);
    const free = st.bavail * st.bsize;
    if (free < estimate * 1.5) {
      throw NS.errors.fail(NS.errors.CODES.EXPORT_NO_SPACE, `磁盘空间不足：需要约 ${(estimate * 1.5 / 1048576).toFixed(0)} MB，剩余 ${(free / 1048576).toFixed(0)} MB`);
    }
  } catch (e) {
    if (e && e.code === NS.errors.CODES.EXPORT_NO_SPACE) throw e;
    warnings.push(`磁盘剩余空间检查失败（继续导出）：${e.message}`);
  }
}

/** 纹理：解码 → PNG（真压缩）→ 写盘；单张失败只记 warning，不中断整包 */
async function writeTextures(NS, plan, tmpDir, progress, warnings, written) {
  const rels = [];
  fs.mkdirSync(path.join(tmpDir, 'textures'), { recursive: true });
  const resSNode = plan.parsed.nodes.find((n) => /\.resS$/.test(n.path));
  const resSBytes = resSNode ? NS.unityfs.nodeBytes(plan.parsed, resSNode.path) : null;
  for (const t of plan.textures) {
    if (!t.supported) continue;
    progress({ stage: 'texture', name: t.name, width: t.width, height: t.height });
    let rgba;
    try {
      const texObj = plan.got.textures.find((x) => x.name === t.name);
      rgba = NS.texdecode.decode(texObj, NS.extract.textureCompressedBytes(texObj, resSBytes), { flipY: true });
    } catch (e) {
      warnings.push(`纹理 ${t.name} 解码失败，已跳过：${e.message}`);
      continue;
    }
    const png = await NS.png.encodePngAsync(rgba, t.width, t.height);
    const rel = `textures/${t.name}.png`;
    fs.writeFileSync(path.join(tmpDir, rel), png);
    written.push({ rel, bytes: png.length });
    rels.push(rel);
  }
  return rels;
}

/**
 * motion3：优先直接落包内原生 motion3；否则用 Cubism Core 的真实参数 Id 建白名单后转换。
 *   转换逻辑全部复用 lib/anim-to-motion.js（含单点曲线补两点），不另写一套。
 * @returns {{defs:Array<{name,url,group}>, curves:{total,emitted,skipped}|null, dropped:number, source:'native'|'converted'}}
 */
function writeMotions(NS, arg) {
  const { plan, profile, tmpDir, written, progress } = arg;
  const native = (plan.got.nativeFiles || []).filter((f) => /motion3\.json$/i.test(f.name));
  if (native.length) {
    fs.mkdirSync(path.join(tmpDir, 'motions'), { recursive: true });
    const defs = [];
    for (const f of native) {
      const rel = `motions/${f.name}`;
      fs.writeFileSync(path.join(tmpDir, rel), f.bytes);
      written.push({ rel, bytes: f.bytes.length });
      const base = f.name.replace(/\.motion3\.json$/i, '');
      defs.push({ name: base, url: rel, group: NS.model3.motionGroupOf(base, profile) });
    }
    return { defs, curves: null, dropped: 0, source: 'native' };
  }

  progress({ stage: 'motions' });
  const { ids } = getParameterIds(plan.moc3Bytes);
  const candidates = [...new Set([...NS.extract.moc3NameCandidates(plan.moc3Bytes), ...ids])];
  const opts = { paramWhitelist: new Set(ids), isLoop: (n) => NS.model3.motionLoops(n, profile) };
  if (profile && profile.motion) {
    opts.fadeIn = profile.motion.fadeInTime;
    opts.fadeOut = profile.motion.fadeOutTime;
  }
  const conv = NS.animToMotion.clipsToMotions(plan.sf, candidates, opts);
  fs.mkdirSync(path.join(tmpDir, 'motions'), { recursive: true });
  const defs = [];
  const curves = { total: 0, emitted: 0, skipped: 0 };
  for (const m of conv.motions) {
    const text = JSON.stringify(m.json);
    const rel = `motions/${m.name}.motion3.json`;
    fs.writeFileSync(path.join(tmpDir, rel), text);
    written.push({ rel, bytes: Buffer.byteLength(text) });
    defs.push({ name: m.name, url: rel, group: NS.model3.motionGroupOf(m.name, profile) });
    curves.total += (m.stats.curvesTotal || 0);
    curves.emitted += (m.stats.emitted || 0);
    curves.skipped += (m.stats.skippedUnknownBinding || 0);
  }
  return { defs, curves, dropped: (conv.dropped || []).length, source: 'converted' };
}

/** model3.json：Motions 由 writeMotions 的结果填充；空 Motions 会被删掉（避免部分运行时报错） */
function writeModel3(NS, arg) {
  const { name, textureRels, plan, profile, tmpDir, written, motions } = arg;
  const model3 = NS.model3.buildModel3({
    mocUrl: `${name}.moc3`,
    textureUrls: textureRels,
    physicsUrl: plan.physicsBytes ? `${name}.physics3.json` : null,
    motions: motions || [],
    paramNames: [],
    profile: profile || null,
  });
  const refs = model3.FileReferences;
  if (refs && refs.Motions && !Object.keys(refs.Motions).length) delete refs.Motions;
  const text = JSON.stringify(model3, null, 2);
  fs.writeFileSync(path.join(tmpDir, `${name}.model3.json`), text);
  written.push({ rel: `${name}.model3.json`, bytes: Buffer.byteLength(text) });
}

/** 报告落盘 + 原子落位（先 rename 到最终目录，保证读者永远看不到半成品） */
function finalize(arg) {
  const { name, bundleBytes, t0, written, plan, warnings, tmpDir, finalDir, motions } = arg;
  const report = {
    name, bundleBytes, generatedAt: new Date().toISOString(), tookMs: Date.now() - t0,
    files: written, totalBytes: written.reduce((a, f) => a + f.bytes, 0),
    textures: plan.textures,
    motions: {
      count: (motions.defs || []).length,
      source: motions.source,
      dropped: motions.dropped || 0,
      curves: motions.curves,
      groups: [...new Set((motions.defs || []).map((d) => d.group))],
    },
    cubismCore: coreInfo(),
    warnings,
  };
  const text = JSON.stringify(report, null, 2);
  fs.writeFileSync(path.join(tmpDir, 'export-report.json'), text);
  written.push({ rel: 'export-report.json', bytes: Buffer.byteLength(text) });
  if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true }); // 仅 --force 会走到这
  fs.renameSync(tmpDir, finalDir);
}

/**
 * 执行导出（编排：规划 → 磁盘 → dry-run → 已存在 → 写临时目录 → 原子落位）。
 * 具体写盘工作交给 writeTextures / writeMotions / writeModel3 / finalize。
 */
export async function exportBundle(opts) {
  const NS = getLibs();
  const o = opts || {};
  const t0 = Date.now();
  const progress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const name = String(o.name || '').trim();
  if (!name) throw new Error('缺少资源名（name）');
  const outRoot = path.resolve(o.outDir || path.join(ROOT, 'data', 'export'));
  const finalDir = path.join(outRoot, name);

  progress({ stage: 'plan' });
  const plan = planExport(o.bundleBytes);
  const warnings = [...plan.warnings];
  if (plan.skippedTextures.length) {
    warnings.push(`以下纹理格式暂不支持，已跳过（不整体失败）：${[...new Set(plan.skippedTextures)].join('、')}`);
  }
  const estimate = estimateBytes(plan);
  checkDisk(NS, outRoot, estimate, warnings);
  const textures = plan.textures.map((t) => ({ name: t.name, width: t.width, height: t.height, formatName: t.formatName, supported: t.supported }));

  if (o.dryRun) {
    return {
      ok: true, dryRun: true, name, outDir: finalDir, existed: fs.existsSync(finalDir),
      wouldWrite: [`${name}.moc3`, ...(plan.physicsBytes ? [`${name}.physics3.json`] : []),
        ...plan.textures.filter((t) => t.supported).map((t) => `textures/${t.name}.png`),
        'motions/<动作名>.motion3.json', `${name}.model3.json`, 'export-report.json'],
      textures, estimateBytes: estimate, warnings, ms: Date.now() - t0,
    };
  }
  if (fs.existsSync(finalDir) && !o.force) {
    return { ok: true, skipped: true, reason: '目标目录已存在（加 --force 覆盖）', name, outDir: finalDir, textures, warnings, ms: Date.now() - t0 };
  }

  fs.mkdirSync(outRoot, { recursive: true });
  const tmpDir = path.join(outRoot, `.tmp-${name}-${process.pid}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const written = [];
  try {
    fs.writeFileSync(path.join(tmpDir, `${name}.moc3`), plan.moc3Bytes);
    written.push({ rel: `${name}.moc3`, bytes: plan.moc3Bytes.length });
    if (plan.physicsBytes) {
      fs.writeFileSync(path.join(tmpDir, `${name}.physics3.json`), plan.physicsBytes);
      written.push({ rel: `${name}.physics3.json`, bytes: plan.physicsBytes.length });
    }
    const rels = await writeTextures(NS, plan, tmpDir, progress, warnings, written);
    const motions = writeMotions(NS, { plan, profile: o.profile, tmpDir, written, progress });
    writeModel3(NS, { name, textureRels: rels, plan, profile: o.profile, tmpDir, written, motions: motions.defs });
    finalize({ name, bundleBytes: o.bundleBytes.length, t0, written, plan, warnings, tmpDir, finalDir, motions });
    return {
      ok: true, name, outDir: finalDir, files: written.length, totalBytes: dirBytes(finalDir),
      tookMs: Date.now() - t0, textures, motions: motions.defs.length, curves: motions.curves, warnings,
    };
  } catch (e) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败不掩盖原错误 */ }
    throw e;
  }
}

export const EXPORT_PATHS = { ROOT, LIB_DIR, LIB_ORDER };
