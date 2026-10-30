// tool/.tmp-texdecode-equiv.mjs —— texdecode.decode 重构的**字节级等价验证**（临时脚本，不 commit）
//
// 为什么需要它：decode 是纯函数（同样的输入 → 同样的 RGBA），所以"没改坏"不靠人看，
//   靠哈希：对每种受支持格式各造若干组合法输入（块对齐），记录输出 rgba 的 md5 + 尺寸，
//   以及"数据不足"情形的错误码与文案；改前存 baseline，改后逐项比对。
//
// 用法：
//   node tool/.tmp-texdecode-equiv.mjs --baseline /tmp/texdecode-baseline.json
//   node tool/.tmp-texdecode-equiv.mjs --compare  /tmp/texdecode-baseline.json
//
// 注意：脚本会各自独立加载 live2d 与 spine 两份 lib，**两份都必须与 baseline 相符**。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const LIBS = {
  live2d: 'plugins/unity-live2d-bundle/lib',
  spine: 'plugins/unity-spine-bundle/lib',
};
const LOAD_ORDER = ['errors.js', 'etc2.js', 'dxt.js', 'texdecode.js'];

/** 在一个干净的 globalThis 上加载一份 lib（各份互不污染） */
function loadLib(dir) {
  const ctx = vm.createContext({});
  ctx.globalThis = ctx;
  for (const f of LOAD_ORDER) {
    const src = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
    vm.runInContext(src, ctx, { filename: f });
  }
  return ctx.__ULB__;
}

/** 确定性伪随机（同一 seed 每次同样样本；不同 seed 造出不同内容） */
function makeBytes(len, seed) {
  const out = new Uint8Array(len);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < len; i += 1) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = (x >>> 24) & 0xff;
  }
  return out;
}

const md5 = (u8) => crypto.createHash('md5').update(Buffer.from(u8)).digest('hex');

/** 一次 decode 的"指纹"：成功记 md5/w/h，失败记错误码与文案 */
function fingerOf(ns, fmt, w, h, data) {
  try {
    const rgba = ns.texdecode.decode({ format: fmt, width: w, height: h, name: `fmt${fmt}` }, data);
    if (!(rgba instanceof Uint8Array)) return { outcome: 'non-u8', type: typeof rgba };
    return { outcome: 'ok', md5: md5(rgba), len: rgba.length, w, h };
  } catch (e) {
    return { outcome: 'throw', code: e && e.code ? e.code : null, msg: e && e.message ? e.message : String(e) };
  }
}

/** 所有受测格式：FORMATS 里的全部 + 两个明确不支持的（验证同一错误码/文案） */
function formatsOf(ns) {
  const table = ns.texdecode.FORMATS;
  return Object.keys(table).map(Number).sort((a, b) => a - b);
}

/** 为每个格式造样本：4 组合法（不同尺寸/内容）+ 1 组数据不足 */
function samplesFor(ns, fmt) {
  const ns_ = ns.texdecode;
  const cases = [];
  // 尺寸组合：块对齐（4 的倍数）与小尺寸（12x8 这类非方）都覆盖
  const sizes = [[4, 4], [12, 8], [16, 16], [20, 12]];
  sizes.forEach(([w, h], i) => {
    const need = ns_.expectedSize(fmt, w, h);
    cases.push({ kind: 'ok', w, h, data: makeBytes(need, fmt * 100 + i + 1) });
  });
  // 数据不足：need - 1
  const w = 8; const h = 8;
  const need = ns_.expectedSize(fmt, w, h);
  cases.push({ kind: 'short', w, h, data: makeBytes(Math.max(0, need - 1), fmt * 100 + 99) });
  return cases;
}

/** 主流程：产出一份完整指纹表 */
function collect() {
  const out = { libs: {}, meta: {} };
  for (const [label, dir] of Object.entries(LIBS)) {
    const ns = loadLib(dir);
    const table = ns.texdecode.FORMATS;
    // fmt ↔ compress 互斥性：同一 compress 值不得对应多个 fmt（否则"按 fmt 查表"与"按 compress 分组"不再等价）
    const byCompress = new Map();
    for (const [fmt, f] of Object.entries(table)) {
      const key = f.compress || `(none:fmt${fmt})`;
      if (!byCompress.has(key)) byCompress.set(key, []);
      byCompress.get(key).push(Number(fmt));
    }
    const shared = [...byCompress.entries()].filter(([, list]) => list.length > 1);
    const rows = {};
    for (const fmt of formatsOf(ns)) {
      rows[fmt] = samplesFor(ns, fmt).map((c) => ({
        kind: c.kind, w: c.w, h: c.h, bytes: c.data.length,
        fp: fingerOf(ns, fmt, c.w, c.h, c.data),
      }));
    }
    // 不支持的格式（BC7=25 / ASTC=50）：必须抛同一错误码与文案
    for (const fmt of [25, 50]) {
      rows[fmt] = [{ kind: 'unsupported', w: 8, h: 8, bytes: 64, fp: fingerOf(ns, fmt, 8, 8, makeBytes(64, fmt)) }];
    }
    out.libs[label] = { rows, mutex: { byCompress: Object.fromEntries(byCompress), sharedKeys: shared.map(([k]) => k) } };
    out.meta[label] = { formatCount: Object.keys(table).length, totalCases: Object.values(rows).reduce((a, r) => a + r.length, 0) };
  }
  return out;
}

/** 深比较：逐格式逐样本比对（返回差异列表，空 = 完全等价） */
function diff(before, after) {
  const diffs = [];
  for (const lib of Object.keys(before.libs)) {
    const b = before.libs[lib].rows; const a = after.libs[lib] ? after.libs[lib].rows : {};
    for (const fmt of Object.keys(b)) {
      if (!a[fmt]) { diffs.push(`${lib} fmt${fmt}: 改后缺失`); continue; }
      if (b[fmt].length !== a[fmt].length) diffs.push(`${lib} fmt${fmt}: 样本数 ${b[fmt].length} → ${a[fmt].length}`);
      for (let i = 0; i < Math.min(b[fmt].length, a[fmt].length); i += 1) {
        const bj = JSON.stringify(b[fmt][i].fp); const aj = JSON.stringify(a[fmt][i].fp);
        if (bj !== aj) diffs.push(`${lib} fmt${fmt} #${i}(${b[fmt][i].kind} ${b[fmt][i].w}x${b[fmt][i].h}): ${bj} → ${aj}`);
      }
    }
    for (const fmt of Object.keys(a)) if (!b[fmt]) diffs.push(`${lib} fmt${fmt}: 改后新增（原没有）`);
  }
  return diffs;
}

const args = process.argv.slice(2);
const iBase = args.indexOf('--baseline');
const iComp = args.indexOf('--compare');

if (iBase >= 0) {
  const out = args[iBase + 1] || '/tmp/texdecode-baseline.json';
  const data = collect();
  fs.writeFileSync(out, JSON.stringify(data, null, 1));
  const mutexOk = Object.values(data.libs).every((l) => l.mutex.sharedKeys.length === 0);
  console.log(`baseline 已写：${out}`);
  for (const [lib, m] of Object.entries(data.meta)) console.log(`  ${lib}: ${m.formatCount} 格式 / ${m.totalCases} 样本`);
  console.log(`fmt↔compress 互斥：${mutexOk ? '✓ 成立（没有两个 fmt 共享同一 compress）' : '✗ 不成立'}`);
  for (const [lib, l] of Object.entries(data.libs)) {
    console.log(`  ${lib} 表：${JSON.stringify(l.mutex.byCompress)}`);
  }
} else if (iComp >= 0) {
  const base = args[iComp + 1] || '/tmp/texdecode-baseline.json';
  const before = JSON.parse(fs.readFileSync(base, 'utf8'));
  const after = collect();
  const diffs = diff(before, after);
  console.log(`对比：${base}`);
  for (const [lib, m] of Object.entries(after.meta)) console.log(`  ${lib}: ${m.formatCount} 格式 / ${m.totalCases} 样本`);
  if (!diffs.length) {
    console.log('✅ 逐项完全相同（0 差异）');
  } else {
    console.log(`❌ 发现 ${diffs.length} 处差异：`);
    for (const d of diffs.slice(0, 40)) console.log('  ' + d);
    process.exitCode = 1;
  }
} else {
  console.log('用法：--baseline <out.json> | --compare <baseline.json>');
}
