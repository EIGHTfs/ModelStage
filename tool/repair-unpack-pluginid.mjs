#!/usr/bin/env node
// tool/repair-unpack-pluginid.mjs —— 一次性修复：把 index.json 的 pluginId 改成「真正解出产物的插件」
//
// 背景（真 bug，不是门禁误报）：
//   以前 unpack-worker 写 index.json 时用的是 store 传来的 meta.pluginId，而它来自 runnerInfo()，
//   runnerInfo() 恒返回**列表第一个**注册插件。多插件环境下，真正命中的往往是另一个（例如 spine），
//   于是 index.json 记 live2d、prefix 却是 spine 算的 ⇒ 两者自相矛盾，
//   test/unpack-prefix-check 因此整批报"prefix 与预期不符"（25/25）。
//   代码侧已在 worker 里改用 unpackFile 回传的 picked.id；本脚本负责**存量缓存**。
//
// 判据来源：prefix 形如 `vfs://<pluginId>/<rootId>/<相对目录>/`（契约 §1.2），
//   所以从 prefix 第二段就能反推"这份产物到底是哪个插件解出来的"。
//   注意：**prefix 本身一个字都不改**（它是 VFS 注册的真实依据），只修 pluginId 的记账。
//
// 用法：
//   node tool/repair-unpack-pluginid.mjs                # dry-run，只打印将要改什么
//   node tool/repair-unpack-pluginid.mjs --apply        # 真改（先备份，改完逐份校验）
//   可选 --dir <解包缓存根>（缺省 <项目>/data/unpacked）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFilePortable } from '../src/server/core/fs-portable.mjs';
import { prefixMismatch } from '../src/server/unpack/plugin-store.mjs';
import { listProviderPlugins } from '../src/server/unpack/plugin-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const dirArg = argv.indexOf('--dir');
const UNPACKED = dirArg >= 0 && argv[dirArg + 1] ? path.resolve(argv[dirArg + 1]) : path.join(ROOT, 'data', 'unpacked');

/** 从 prefix 反推 pluginId：`vfs://<pluginId>/<rootId>/...` ⇒ 第二段 */
function pluginIdFromPrefix(prefix) {
  const m = /^vfs:\/\/([^/]+)\//.exec(String(prefix || ''));
  return m ? m[1] : null;
}

/** 原子写：先写临时文件再 rename（缓存目录里绝不留半份 index.json） */
function writeJsonAtomic(abs, obj) {
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, abs);
}

function main() {
  if (!fs.existsSync(UNPACKED)) {
    console.log(`解包缓存目录不存在：${UNPACKED}`);
    return 1;
  }
  const known = new Set(listProviderPlugins().map((p) => p.id));
  const dirents = fs.readdirSync(UNPACKED, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
  const rows = [];
  const skipped = [];

  for (const d of dirents) {
    const idxPath = path.join(UNPACKED, d.name, 'index.json');
    if (!fs.existsSync(idxPath)) continue;
    let idx;
    try {
      idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    } catch (e) {
      skipped.push({ fp: d.name, why: `index.json 读不动：${e.message}` });
      continue;
    }
    const derived = pluginIdFromPrefix(idx.prefix);
    if (!derived) {
      skipped.push({ fp: d.name, why: `prefix 不是 vfs://<id>/… 形态：${String(idx.prefix).slice(0, 40)}` });
      continue;
    }
    if (!known.has(derived)) {
      skipped.push({ fp: d.name, why: `prefix 反推出的插件不在已注册列表里：${derived}` });
      continue;
    }
    if (idx.pluginId === derived) continue;   // 已经正确
    rows.push({ fp: d.name, idxPath, rel: (idx.source && idx.source.rel) || '?', before: idx.pluginId, after: derived, idx });
  }

  console.log(`缓存根：${UNPACKED}`);
  console.log(`扫描 ${dirents.length} 个目录 ｜ 需要修 ${rows.length} 份 ｜ 跳过 ${skipped.length} 份${APPLY ? '' : '（dry-run，未写入）'}`);
  for (const r of rows) {
    console.log(`  ${r.fp}  rel=${r.rel}`);
    console.log(`      pluginId: ${r.before}  →  ${r.after}   （prefix 不动：${String(r.idx.prefix).slice(0, 56)}…）`);
  }
  for (const s of skipped) console.log(`  跳过 ${s.fp}：${s.why}`);
  if (!rows.length) {
    console.log('没有需要修的缓存。');
    return 0;
  }
  if (!APPLY) {
    console.log('\n加 --apply 才会真的写盘（会先备份到 <缓存根>/.pluginid-backup-<时间戳>/）。');
    return 0;
  }

  const backupDir = path.join(UNPACKED, `.pluginid-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(backupDir, { recursive: true });
  let changed = 0;
  for (const r of rows) {
    copyFilePortable(r.idxPath, path.join(backupDir, `${r.fp}.json`));   // CIFS 上必须用 portable 版
    writeJsonAtomic(r.idxPath, { ...r.idx, pluginId: r.after });
    changed += 1;
  }
  console.log(`\n已修 ${changed} 份，原始文件备份在：${path.relative(ROOT, backupDir)}`);

  // 逐份校验：改完 prefixMismatch 必须全部为 null（这是门禁判据，不是自定义标准）
  let bad = 0;
  for (const d of dirents) {
    const idxPath = path.join(UNPACKED, d.name, 'index.json');
    if (!fs.existsSync(idxPath)) continue;
    let idx;
    try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch { continue; }
    const m = prefixMismatch(idx);
    if (m) { bad += 1; console.log(`  ✗ 仍不一致 ${d.name}：缓存=${m.cached} 预期=${m.expect}`); }
  }
  console.log(bad === 0 ? '校验：全部缓存 prefixMismatch 均为 null ✓' : `校验：仍有 ${bad} 份不一致 ✗`);
  return bad === 0 ? 0 : 1;
}

process.exitCode = main();
