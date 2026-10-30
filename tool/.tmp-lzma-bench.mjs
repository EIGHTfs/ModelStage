// tool/.tmp-lzma-bench.mjs —— 实测 LZMA / LZ4 包的解压耗时与体积（临时脚本，不 commit）
//
// 目的：给"浏览器同步解压冻 UI"这件事一个可复现的数字基础 ——
//   · 解压后多大体积、在浏览器里同步解要多久（决定"用户能忍"的阈值）
//   · 压缩算法是 LZMA 还是 LZ4（只有 LZMA 才慢 20~30 倍）
//
// 用 node 直接跑插件 lib（纯 JS，和浏览器同一个 V8 算法层）：
//   node 侧省掉浏览器启动开销，适合测"算法本身耗时"；"UI 是否冻"另用浏览器验。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const LIB = path.join(ROOT, 'plugins/unity-live2d-bundle/lib');

/** vm 里按顺序加载插件 lib（classic script，靠 globalThis 挂载） */
function loadUnityfs() {
  const ctx = vm.createContext({
    // lzma-d-min.js 里 `tr = typeof setImmediate === 'function' ? setImmediate : setTimeout`
    //   ⇒ 沙箱必须提供其一，否则加载期就 ReferenceError
    setTimeout, clearTimeout, setImmediate, clearImmediate, TextDecoder, TextEncoder,
    console, Date, Math, JSON, Uint8Array, Int8Array, Uint32Array, Int32Array, ArrayBuffer, DataView,
  });
  ctx.globalThis = ctx;
  ctx.self = ctx;
  // lzma-d-min.js 是 IIFE，末尾 this.LZMA = ... ⇒ 在 ctx 里就是 ctx.LZMA
  // 顺序与 plugin.json 的 files[] 一致（classic script 靠加载顺序建立依赖：
  //   unityfs 依赖 errors / bytes / lzma-d-min，缺一个就在运行期报 undefined）
  for (const f of ['errors.js', 'bytes.js', 'common-strings.js', 'lzma-d-min.js', 'unityfs.js']) {
    const src = fs.readFileSync(path.join(LIB, f), 'utf8');
    vm.runInContext(src, ctx, { filename: f });
  }
  return ctx;
}

const COMPRESSION_NAME = { 0: 'none', 1: 'LZMA', 2: 'LZ4', 3: 'LZ4HC', 4: 'LZHAM' };

/** 测一个包：返回压缩/解压体积、算法、耗时 */
function bench(ctx, filePath) {
  const u8 = new Uint8Array(fs.readFileSync(filePath));
  const summary = ctx.__ULB__.unityfs.blocksSummary(u8);
  const head = ctx.__ULB__.unityfs.readHeader(u8);
  const algoSet = [...new Set(head.blocks.map((b) => COMPRESSION_NAME[b.flags & 0x3f] || `?${b.flags & 0x3f}`))];
  const t0 = process.hrtime.bigint();
  let ok = true;
  let err = '';
  try { ctx.__ULB__.unityfs.parse(u8); } catch (e) { ok = false; err = String(e && e.message || e).slice(0, 80); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    file: path.basename(filePath),
    compressedMB: +(u8.length / 1048576).toFixed(2),
    decompressedMB: +(summary.decompressedBytes / 1048576).toFixed(2),
    blocks: summary.blockCount,
    algo: algoSet.join('+'),
    ms: Math.round(ms),
    ok,
    err,
  };
}

const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!targets.length) {
  console.log('用法：node tool/.tmp-lzma-bench.mjs <包文件…>');
  process.exit(1);
}

const ctx = loadUnityfs();
const rows = [];
for (const t of targets) {
  if (!fs.existsSync(t)) { console.log(`跳过（不存在）：${t}`); continue; }
  rows.push(bench(ctx, t));
}
console.log('文件                             压缩MB  解压MB  块数  算法      耗时ms  结果');
for (const r of rows) {
  console.log(`${r.file.padEnd(30)}  ${String(r.compressedMB).padStart(6)}  ${String(r.decompressedMB).padStart(6)}  ${String(r.blocks).padStart(4)}  ${r.algo.padEnd(8)}  ${String(r.ms).padStart(6)}  ${r.ok ? '✓' : '✗ ' + r.err}`);
}
// 机器可读行，便于贴进文档
console.log('\nJSON:');
console.log(JSON.stringify(rows, null, 1));
