#!/usr/bin/env node
// ============================================================================
// tool/export-bundle.mjs —— 资源包 → 标准 Live2D 模型目录（CLI）
//
// 用法：
//   node tool/export-bundle.mjs --root azurlane_bundle --path aderbote_3
//   node tool/export-bundle.mjs --root azurlane_bundle --path aderbote_3 --out data/export --force
//   node tool/export-bundle.mjs --root azurlane_bundle --path aderbote_3 --dry-run
//
// 参数：
//   --root <id>     资源根 id（config/resources.json 里的 id）
//   --path <rel>    资源包文件或所在目录（与 /api/bundle/probe 一致：给目录时自动取单个文件）
//   --out <dir>     输出根（默认 <项目>/data/export）
//   --force         目标已存在时覆盖
//   --dry-run       只报"将要写什么"，不落盘
//   --profile <id>  可选：导出 model3 时套用 profiles/<id>.json（影响 HitAreas 等）
//
// 退出码：0 成功；1 失败；2 参数错误
// 中断：SIGINT/SIGTERM 会清理本次的 .tmp-<name>-<pid> 目录后退出（130）
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { exportBundle, EXPORT_PATHS } from './lib/export-bundle.mjs';

const USAGE = `用法: node tool/export-bundle.mjs --root <id> --path <rel> [--out <dir>] [--force] [--dry-run] [--profile <id>]`;

function parseArgs(argv) {
  const out = { out: null, force: false, dryRun: false, profile: null, root: null, path: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} 缺少取值`); return v; };
    if (a === '--root') out.root = next();
    else if (a === '--path') out.path = next();
    else if (a === '--out') out.out = next();
    else if (a === '--profile') out.profile = next();
    else if (a === '--force') out.force = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else throw new Error(`未知参数：${a}`);
  }
  if (!out.root || !out.path) throw new Error('缺少 --root 或 --path');
  return out;
}

/** 读资源根配置（JSONC：允许 // 行注释） */
function readRoots() {
  const file = path.join(EXPORT_PATHS.ROOT, 'config', 'resources.json');
  const text = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const cfg = JSON.parse(text);
  return Array.isArray(cfg) ? cfg : (cfg.roots || []);
}

/** path 支持目录或文件：目录里取单个文件；多个时优先资源包扩展名，仍不唯一就报错（不猜） */
function resolveBundleFile(rootPath, rel) {
  const abs = path.join(rootPath, rel);
  if (!fs.existsSync(abs)) throw new Error(`路径不存在：${rel}`);
  if (fs.statSync(abs).isFile()) return { abs, rel, resolvedFile: path.basename(abs) };
  const files = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!files.length) throw new Error(`目录里没有文件：${rel}`);
  const pick = files.length === 1 ? files[0] : files.find((n) => /\.(unity3d|bundle|assetbundle|bytes|ab)$/i.test(n));
  if (!pick) throw new Error(`目录里有 ${files.length} 个文件且无法判定哪个是资源包，请直接给文件路径`);
  return { abs: path.join(abs, pick), rel: path.join(rel, pick), resolvedFile: pick };
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`✗ ${e.message}\n${USAGE}`); process.exit(2); }

  const roots = readRoots();
  const root = roots.find((r) => r.id === args.root);
  if (!root) { console.error(`✗ 未找到资源根：${args.root}（可用：${roots.map((r) => r.id).join(', ')}）`); process.exit(2); }

  let target;
  try { target = resolveBundleFile(root.path, args.path); }
  catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }
  const outDir = args.out ? path.resolve(args.out) : path.join(EXPORT_PATHS.ROOT, 'data', 'export');
  const name = path.basename(target.resolvedFile).replace(/\.[^.]+$/, '') || target.resolvedFile;

  // 中断清理：本次的临时目录名含 pid，可直接定位
  const killTmp = () => {
    try {
      for (const e of fs.readdirSync(outDir)) {
        if (e.startsWith('.tmp-') && e.endsWith(`-${process.pid}`)) {
          fs.rmSync(path.join(outDir, e), { recursive: true, force: true });
          console.log(`已清理临时目录 ${e}`);
        }
      }
    } catch { /* 目录还不存在就无需清理 */ }
  };
  const onSig = (sig) => { console.log(`\n收到 ${sig}，清理后退出`); killTmp(); process.exit(130); };
  process.on('SIGINT', () => onSig('SIGINT'));
  process.on('SIGTERM', () => onSig('SIGTERM'));

  let profile = null;
  if (args.profile) {
    const pf = path.join(EXPORT_PATHS.ROOT, 'plugins', 'unity-live2d-bundle', 'profiles', `${args.profile}.json`);
    if (!fs.existsSync(pf)) { console.error(`✗ 没有 profile：${pf}`); process.exit(2); }
    profile = JSON.parse(fs.readFileSync(pf, 'utf8'));
  }

  console.log(`资源包: ${target.rel}`);
  console.log(`输出到: ${outDir}${args.dryRun ? '（dry-run，不落盘）' : ''}`);

  const t0 = Date.now();
  const bytes = new Uint8Array(fs.readFileSync(target.abs));
  console.log(`包大小: ${(bytes.length / 1048576).toFixed(2)} MB`);

  return exportBundle({
    bundleBytes: bytes,
    name,
    outDir,
    force: args.force,
    dryRun: args.dryRun,
    profile,
    onProgress: (p) => {
      if (p.stage === 'texture') console.log(`  解码纹理 ${p.name} (${p.width}x${p.height})…`);
    },
  }).then((r) => {
    if (r.skipped) {
      console.log(`↷ 跳过：${r.reason}`);
      process.exit(0);
    }
    if (r.dryRun) {
      console.log('将写入:');
      for (const f of r.wouldWrite) console.log(`  ${f}`);
      console.log(`预估产物: ${(r.estimateBytes / 1048576).toFixed(1)} MB（最坏情况，PNG 压缩后会更小）`);
      if (r.existed) console.log('注意：目标目录已存在，真跑需 --force 才会覆盖');
      if (r.warnings.length) console.log('警告:', r.warnings.join('；'));
      process.exit(0);
    }
    console.log('\n✓ 导出完成');
    console.log(`  目录: ${r.outDir}`);
    console.log(`  文件: ${r.files} 个，合计 ${(r.totalBytes / 1048576).toFixed(2)} MB`);
    console.log(`  耗时: ${r.tookMs} ms（CLI 全程 ${Date.now() - t0} ms）`);
    if (r.motions !== undefined) {
      const c = r.curves;
      const curveText = c ? `（曲线 total=${c.total} / emitted=${c.emitted} / skipped=${c.skipped}）` : '';
      console.log(`  动作: ${r.motions} 条${curveText}`);
    }
    if (r.warnings.length) console.log(`  警告: ${r.warnings.join('；')}`);
    process.exit(0);
  }).catch((e) => {
    console.error(`✗ 导出失败${e && e.code ? `（${e.code}）` : ''}：${e && e.message}`);
    killTmp();
    process.exit(1);
  });
}

main();
