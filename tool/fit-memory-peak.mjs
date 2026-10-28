// ============================================================================
// tool/fit-memory-peak.mjs —— 标定「解压峰值」表用的**维护期**工具（零依赖，纯 CLI）
//
// 为什么需要它：插件的 peakFromDecompressed 是一张按实测标定的表，而"实测"必须与
//   **准入判断所用的那个进程**同口径 —— 服务端用的是「起始 RSS + 本次 VmHWM 增量」
//   （见 src/server/unpack/plugin-store.mjs 的 rssNow / recordMeasuredPeak）。
//   换机器、升 Node/V8、新增压缩格式后都要重新标一次；没有工具就只能靠临时脚本，
//   而临时脚本每次口径都不一样（上一轮就是这么踩的：子进程增量 vs 进程内增量差 1.34~2 倍）。
//
// 两种基准（**不可混进同一张表**）：
//   --basis inproc  在一个进程里顺序解压（= 服务端真实形态：长驻进程 + 逐包解压）← 标定插件表用这个
//   --basis child   每包一个独立子进程（= "这一包自己的增量成本"，比 inproc 小，适合对比/诊断）
//
// 用法：
//   node tool/fit-memory-peak.mjs --packs runtime/peak-samples.json --basis inproc
//   node tool/fit-memory-peak.mjs --packs list.txt --basis child --out runtime/peak-fit.json --margin 1.15
//
// 输出：① 逐包一行（解压MB / 实测 / 当前声明 / 倍数）② 可直接粘贴的表片段 ③ 有低估则退出码非 0
// 硬边界：**不自动改源码**（这张表在热路径上，必须有人过一眼）；样本清单不入库（runtime/ 已 gitignore）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MB = 1024 * 1024;
/** 默认样本清单（gitignore：样本路径不入库） */
const DEFAULT_PACKS = path.join(ROOT, 'runtime', 'peak-samples.json');

// ---------------- 纯函数（单测直接测这些） ----------------

/**
 * 峰值口径：与服务端 recordMeasuredPeak 逐字相同。
 *   「起始 RSS + 本次 VmHWM 增量」——本次没创新高时等于起始 RSS（上包络语义）。
 * @param {{rss:number, peak:number}} before
 * @param {{rss:number, peak:number}} after
 * @returns {number} 字节
 */
export function peakFormula(before, after) {
  return before.rss + Math.max(0, after.peak - before.peak);
}

/**
 * 中位数（重复测量的抗噪聚合）。
 * 为什么用中位数而不是均值：单次峰值受 GC 时机影响会有 15% 以上抖动
 *   （实测同一包 638/638/734MB），均值会把偶发高值带进表里，中位数更稳。
 * @param {number[]} nums
 * @returns {number}
 */
export function median(nums) {
  const arr = (nums || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/**
 * 重复测量的**最大值**聚合 —— 准入要用这个，不用中位数。
 *
 * 准入要回答的是"这个包最坏会到多少"，不是"典型会到多少"：
 *   中位数 + 固定余量等于在猜抖动幅度（实测同一包 638/638/734，抖动 15%），
 *   而 max 直接对上"最坏情况"这个问题的形状。代价是表值略升、边界包可能被拒 ——
 *   那是真实风险，不是误拒。
 * @param {number[]} nums
 * @returns {number}
 */
export function maxOf(nums) {
  const arr = (nums || []).filter((n) => Number.isFinite(n));
  return arr.length ? Math.max(...arr) : 0;
}

/**
 * 把测量结果整理成行，并判每条是否"低估"。
 * @param {Array<{pack:string, decompressedMb:number, measuredBytes:number, declaredBytes:number}>} samples
 * @returns {Array<{pack:string, decompressedMb:number, measuredMb:number, declaredMb:number, ratio:number, low:boolean}>}
 */
export function buildRows(samples) {
  const cache = new Map();
  const round1 = (n) => Math.round(n * 10) / 10;
  return (samples || []).map((s) => {
    const measuredMb = round1(s.measuredBytes / MB);
    const declaredMb = round1(s.declaredBytes / MB);
    // 倍数 > 1 ⇒ 当前声明比实测小 ⇒ 低估（准入会放行然后真的冲高）
    const ratio = declaredMb > 0 ? Math.round((measuredMb / declaredMb) * 100) / 100 : 0;
    cache.set(s.pack, ratio);
    return {
      pack: s.pack,
      decompressedMb: round1(s.decompressedMb),
      measuredMb,
      declaredMb,
      ratio,
      low: measuredMb > declaredMb,
    };
  });
}

/**
 * 是否有任何一个点低估（决定退出码）。
 * @param {Array<{low:boolean}>} rows
 * @returns {boolean}
 */
export function hasUnderEstimate(rows) {
  return (rows || []).some((r) => r.low === true);
}

/**
 * 由实测点生成"建议表"（解压MB 升序、峰值 = 实测 × 余量、向上取整）。
 *
 * 两条必做的整形（否则表会自相矛盾）：
 *   ① 同一解压量出现多次时取**最大实测**（上包络：宁可高估）；
 *   ② **累进取最大**（单调化）——实测显示峰值不是解压量的纯函数：
 *      9.4MB 的包实测 333MB 却比 8.5MB 的 420MB 更省（纹理数量/块数不同）。
 *      若照原样落表，8.5MB 的声明会比 9.4MB 高 ⇒ 更大的包反而估得更少，准入判断自相矛盾。
 * @param {Array<{decompressedMb:number, measuredMb:number}>} rows
 * @param {{margin?:number}} [opts]
 * @returns {Array<[number, number]>} [[mb, peakMb], …]
 */
export function suggestPoints(rows, opts = {}) {
  const margin = Number(opts.margin) > 0 ? Number(opts.margin) : 1.15;
  const byMb = new Map();
  for (const r of rows || []) {
    const prev = byMb.get(r.decompressedMb) || 0;
    if (r.measuredMb > prev) byMb.set(r.decompressedMb, r.measuredMb);
  }
  // 键保留 2 位小数：只保留 1 位会把 18.69 进位成 18.7，查询（18.69）就落在键下方，
  //   插值结果会比该点实测略低（实测差 1MB 就被自检判成"低估"）。向下取整到 2 位更贴近真实尺寸。
  const rounded = new Map();
  for (const [mb, measured] of byMb) {
    const key = Math.floor(mb * 100) / 100;
    const prev = rounded.get(key) || 0;
    if (measured > prev) rounded.set(key, measured);
  }
  const sorted = [...rounded.entries()].sort((a, b) => a[0] - b[0]);
  const out = [];
  let envelope = 0;   // 累进上包络
  for (const [mb, measured] of sorted) {
    if (measured > envelope) envelope = measured;
    out.push([mb, Math.ceil(envelope * margin)]);
  }
  return out;
}

/**
 * 生成可直接粘贴进插件源码的片段（表 + 说明）。
 * @param {Array<[number, number]>} points
 * @param {{margin?:number, basis?:string}} [opts]
 * @returns {string}
 */
export function suggestSnippet(points, opts = {}) {
  const margin = Number(opts.margin) > 0 ? Number(opts.margin) : 1.15;
  const basis = opts.basis || 'inproc';
  const pts = (points || []).map(([mb, peak]) => `[${mb}, ${peak}]`).join(', ');
  return [
    `  const LZMA_PEAK_POINTS = [${pts}];`,
    `  const PEAK_MARGIN = ${margin};`,
    '',
    '  // 基准：' + (basis === 'inproc'
      ? '服务端进程内（起始 RSS + 本次 VmHWM 增量，与 plugin-store 的 recordMeasuredPeak 同口径）'
      : '独立子进程（每包一个进程；比进程内小，只用于对比，不要拿去标表）'),
  ].join('\n');
}

/**
 * 逐包表格文本。
 * @param {Array} rows
 * @returns {string}
 */
export function formatTable(rows) {
  const head = '  解压MB | 实测峰值 | 当前声明 | 倍数 | 判定';
  const lines = [head];
  for (const r of rows || []) {
    lines.push(
      `  ${String(r.decompressedMb).padStart(6)} | ${String(r.measuredMb).padStart(8)} | `
      + `${String(r.declaredMb).padStart(8)} | ${String(r.ratio).padStart(4)} | `
      + (r.low ? `低估（+${Math.round((r.ratio - 1) * 100)}%）` : 'OK'),
    );
  }
  return lines.join('\n');
}

// ---------------- 进程内/子进程测量 ----------------

/** 读 /proc/self/status（与服务端 rssNow 同口径） */
function selfMem() {
  try {
    const txt = fs.readFileSync('/proc/self/status', 'utf8');
    const hwm = /VmHWM:\s+(\d+)\s+kB/.exec(txt);
    const rss = /VmRSS:\s+(\d+)\s+kB/.exec(txt);
    if (hwm) {
      return { rss: rss ? Number(rss[1]) * 1024 : process.memoryUsage().rss, peak: Number(hwm[1]) * 1024 };
    }
  } catch { /* 非 Linux 落到抽样 */ }
  const rss = process.memoryUsage().rss;
  return { rss, peak: rss };
}

/** 取插件 api（懒加载，只此一处） */
async function pluginApi() {
  const { ensurePlugin } = await import('../src/server/unpack/plugin-runner.mjs');
  const loaded = ensurePlugin('unity-live2d-bundle');
  if (!loaded.ok) throw new Error(`插件装载失败：${loaded.error}`);
  return loaded.api;
}

/**
 * 测一个包（调用方保证 api 已就绪）。
 * @param {object} api
 * @param {string} pack 绝对路径
 * @returns {Promise<{pack:string, decompressedMb:number, measuredBytes:number, declaredBytes:number}>}
 */
async function measureOne(api, pack, repeat = 1) {
  const bytes = new Uint8Array(fs.readFileSync(pack));
  const name = path.basename(pack);
  const decl = api.estimateMemory({ rootId: 'fit', rel: name, name, size: bytes.length, bytes });
  if (!decl || !(decl.decompressedBytes > 0)) throw new Error(`插件读不出块表（不是 UnityFS 容器？）：${pack}`);
  // 注意：这里**只测一次**。重复测量必须由父进程 spawn 多个独立子进程来做 ——
  //   同一个进程里连解同一个包，后几次会被插件/引擎内部的缓存托底（实测 5MB 的包
  //   连测三次中位数只有 171MB，而单次干净进程是 253MB），那样测出来的不是峰值。
  const runs = [];
  for (let i = 0; i < 1; i += 1) {
    const before = selfMem();
    await api.resolve({ rootId: 'fit', rel: name, name, size: bytes.length, bytes });
    const after = selfMem();
    runs.push(peakFormula(before, after));
  }
  return {
    pack,
    decompressedMb: decl.decompressedBytes / MB,
    measuredBytes: median(runs),
    declaredBytes: decl.peakBytes,
    runs: runs.map((b) => Math.round(b / MB)),
  };
}

/** 子进程模式：内部单包入口 */
async function runChildMode(pack, repeat = 1) {
  const api = await pluginApi();
  const r = await measureOne(api, pack, repeat);
  process.stdout.write(`${JSON.stringify(r)}\n`);
  return 0;
}

// ---------------- CLI ----------------

const USAGE = `用法：
  node tool/fit-memory-peak.mjs --packs <清单文件> [--basis inproc|child] [--out <json>] [--margin 1.15]

  --packs   每行一个容器绝对路径（也接受 JSON 数组）；默认 runtime/peak-samples.json（不入库）
  --basis   inproc = 进程内顺序解压（**与旧 LZ4 表同口径，标表用这个**）
            child  = 每包独立子进程（基准更小，只用于对比，别混进同一张表）
  --out     写 JSON 样本；不给则只打 stdout
  --margin  建议表余量，默认 1.15
  --repeat  每包重复测量几次（child 基准下每轮都是独立干净进程），默认 1
  --agg     聚合方式：max=取最大（**准入用这个**，答案对的是"最坏会到多少"）/ median=中位数（诊断用）

退出码：0 全部不低估；1 存在低估（declared < measured）；2 用法/环境错误`;

/**
 * 读清单：支持 JSON 数组，或"每行一个路径"的纯文本（# 开头为注释）。
 * @param {string} file
 * @returns {string[]}
 */
export function readPackList(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const text = raw.trim();
  if (text.startsWith('[')) return JSON.parse(text).map(String).filter(Boolean);
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/**
 * CLI 主体。
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2)) {
  const args = argv.slice();
  const valOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const has = (f) => args.includes(f);

  // 内部模式：子进程只测一个包就退出
  if (has('--child')) return runChildMode(valOf('--child'), Math.max(1, Number(valOf('--repeat')) || 1));

  if (has('--help') || args.length === 0) {
    console.log(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  const packsFile = valOf('--packs') || DEFAULT_PACKS;
  if (!fs.existsSync(packsFile)) {
    console.error(`✗ 样本清单不存在：${packsFile}`);
    console.error('  （样本不入库：请自己准备一份，每行一个容器绝对路径）');
    return 2;
  }
  const basis = (valOf('--basis') || 'inproc').toLowerCase();
  if (basis !== 'inproc' && basis !== 'child') {
    console.error(`✗ --basis 只能是 inproc 或 child（收到 ${basis}）`);
    return 2;
  }
  const margin = Number(valOf('--margin')) || 1.15;
  // 重复测量次数：单次峰值受 GC 时机影响可抖 15%+，多测取中位数更稳
  const repeat = Math.max(1, Number(valOf('--repeat')) || 1);
  // 聚合方式：max（准入要的是"最坏会到多少"，推荐）/ median（典型值，仅诊断用）
  const agg = (valOf('--agg') || 'max').toLowerCase();
  if (agg !== 'max' && agg !== 'median') { console.error('✗ --agg 只能是 max 或 median'); return 2; }
  const outFile = valOf('--out') || null;

  const packs = readPackList(packsFile);
  if (!packs.length) { console.error('✗ 清单里没有路径'); return 2; }

  console.log(`基准：${basis === 'inproc' ? '进程内顺序解压（起始 RSS + VmHWM 增量，与 plugin-store 同口径）' : '独立子进程（基准更小，仅用于对比）'}`);
  console.log(`⚠️ 不同基准的实测值**不可混进同一张表**（同一包可差 1.3~2 倍）。`);

  const samples = [];
  if (basis === 'inproc') {
    const api = await pluginApi();
    for (const pack of packs) {
      try {
        const s = await measureOne(api, pack, repeat);
        samples.push({ ...s, medianBytes: s.measuredBytes, maxBytes: s.measuredBytes });
        console.log(`  ✓ ${path.basename(pack)}（解压 ${(s.decompressedMb).toFixed(2)}MB）`);
      } catch (e) {
        console.error(`  ✗ ${path.basename(pack)}：${(e && e.message) || e}`);
      }
    }
  } else {
    for (const pack of packs) {
      // 反复测量 = 反复 spawn **独立子进程**（同进程连测会被内部缓存托底，测不出峰值）
      const measuredRuns = [];
      let meta = null;
      for (let i = 0; i < repeat; i += 1) {
        const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', pack], { encoding: 'utf8', timeout: 900000 });
        const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
        try {
          const one = JSON.parse(line);
          meta = one;
          measuredRuns.push(one.measuredBytes);
        } catch {
          console.error(`  ✗ ${path.basename(pack)} 第 ${i + 1} 轮失败：${(r.stderr || '').slice(0, 60)}`);
        }
      }
      if (meta && measuredRuns.length) {
        const med = median(measuredRuns);
        const mx = maxOf(measuredRuns);
        const adopted = agg === 'max' ? mx : med;
        samples.push({ ...meta, measuredBytes: adopted, medianBytes: med, maxBytes: mx, runs: measuredRuns.map((b) => Math.round(b / MB)) });
        console.log(`  ✓ ${path.basename(pack)}（${measuredRuns.length} 轮：中位 ${Math.round(med / MB)}MB / 最大 ${Math.round(mx / MB)}MB ⇒ 采纳 ${agg === 'max' ? '最大' : '中位'} ${Math.round(adopted / MB)}MB）`);
      } else {
        console.error(`  ✗ ${path.basename(pack)}：全部轮次失败`);
      }
    }
  }

  if (!samples.length) { console.error('✗ 没有拿到任何样本'); return 2; }

  const rows = buildRows(samples);
  console.log('\n逐包结果：');
  console.log(formatTable(rows));

  const points = suggestPoints(rows, { margin });
  console.log(`\n建议表片段（余量 ${margin}×，可直接粘贴；两处插件必须逐值相同）：`);
  console.log(suggestSnippet(points, { margin, basis }));

  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify({ basis, margin, at: new Date().toISOString(), samples, rows, points }, null, 2)}\n`, 'utf8');
    console.log(`\n样本已写入：${outFile}`);
  }

  // 片段不进源码：这里只提示，不代劳
  console.log('\n（本工具不改源码：请人工审阅上面的片段后粘贴进 plugins/unity-{live2d,spine}-bundle/index.js）');

  const low = rows.filter((r) => r.low);
  if (low.length) {
    console.error(`\n✗ ${low.length}/${rows.length} 个点被低估（declared < measured）：`);
    for (const r of low) console.error(`   ${path.basename(r.pack)}：实测 ${r.measuredMb}MB > 声明 ${r.declaredMb}MB（${r.ratio}×）`);
    return 1;
  }
  console.log(`\n✓ 全部 ${rows.length} 个点 declared ≥ measured`);
  return 0;
}

// 直接执行时才跑 main（被单测 import 时不执行）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`✗ 未预期错误：${(e && e.stack) || e}`);
    process.exitCode = 2;
  });
}
