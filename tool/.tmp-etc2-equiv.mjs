// tool/.tmp-etc2-equiv.mjs —— etc2.decodeRgbBlock 重构的**逐字节等价验证**（临时脚本，不 commit）
//
// 为什么需要比 A5 更严：A5 验"格式分派"，这里验**块解码数学**。
//   "0 差异"可能只是因为某条子模式根本没跑到 —— 所以本脚本除了比对输出，
//   还必须统计**模式命中分布**并断言覆盖率，否则 0 差异毫无意义。
//
// 用法：
//   node tool/.tmp-etc2-equiv.mjs --baseline /tmp/etc2-baseline.json
//   node tool/.tmp-etc2-equiv.mjs --compare  /tmp/etc2-baseline.json
//
// 会各自独立加载 live2d 与 spine 两份 lib，两份都必须与 baseline 相符。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const LIBS = {
  live2d: 'plugins/unity-live2d-bundle/lib',
  spine: 'plugins/unity-spine-bundle/lib',
};
const LOAD_ORDER = ['errors.js', 'etc2.js'];

/** 在一个干净的 globalThis 上加载一份 lib */
function loadLib(dir) {
  const ctx = vm.createContext({});
  ctx.globalThis = ctx;
  for (const f of LOAD_ORDER) {
    const src = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
    vm.runInContext(src, ctx, { filename: f });
  }
  return ctx.__ULB__;
}

const md5 = (u8) => crypto.createHash('md5').update(Buffer.from(u8)).digest('hex');

/**
 * 模式探针：用于**统计样本命中了哪条子模式**（不改任何状态）。
 *
 * ⚠️ 它必须与 decodeRgbBlock 里的判定完全一致，否则覆盖统计会失真。
 *   判定顺序即 ETC2 规范顺序：individual → T(R溢出) → H(G溢出) → Planar(B溢出) → differential。
 *   B 块字节布局：b[o]/b[o+1]/b[o+2] = 两半颜色（高 5 位 + 低 3 位差分），b[o+3] bit1 = diff/individual。
 */
function probeMode(b, o, etc2) {
  if ((b[o + 3] & 2) === 0) return 'individual';
  if (!etc2) return 'differential';
  const r0 = b[o] & 0xf8;
  const g0 = b[o + 1] & 0xf8;
  const bl0 = b[o + 2] & 0xf8;
  const deltaOf = (x) => ((x << 3) & 0x18) - ((x << 3) & 0x20);
  if (r0 + deltaOf(b[o]) < 0 || r0 + deltaOf(b[o]) > 255) return 't';
  if (g0 + deltaOf(b[o + 1]) < 0 || g0 + deltaOf(b[o + 1]) > 255) return 'h';
  if (bl0 + deltaOf(b[o + 2]) < 0 || bl0 + deltaOf(b[o + 2]) > 255) return 'planar';
  return 'differential';
}

/** 确定性伪随机块（8 字节） */
function makeBlock(seed, patch = {}) {
  const b = new Uint8Array(8);
  let x = (seed >>> 0) || 1;
  for (let i = 0; i < 8; i += 1) {
    x = (x * 1664525 + 1013904223) >>> 0;
    b[i] = (x >>> 24) & 0xff;
  }
  for (const [i, v] of Object.entries(patch)) b[Number(i)] = v;
  return b;
}

/**
 * 样本集：按"目标模式"精确构造，保证覆盖。
 *
 * 关键构造依据（实测的低 3 位符号扩展）：
 *   低 3 位 ddd=7 ⇒ delta = ((7<<3)&0x18) - ((7<<3)&0x20) = 24 - 32 = **-8**
 *   ⇒ b[o]=0x07 且 r0=0（高 5 位 0）⇒ 0 + (-8) < 0 ⇒ 命中 T
 *   同理把 0x07 放在 b[o+1] ⇒ 命中 H；放在 b[o+2] ⇒ 命中 Planar
 */
function buildSamples() {
  const samples = [];
  const push = (tag, patch, etc2, note) => samples.push({ tag, block: makeBlock(samples.length + 1, patch), etc2, note });

  // ── individual：b[3] bit1 = 0（把 bit1 清掉）
  for (let i = 0; i < 6; i += 1) {
    push('individual', { 3: (i * 17) & 0xfd }, false, `个体模式随机#${i}`);
  }
  // individual 判定**先于** etc2 开关 ⇒ etc2=true 下也必须能命中它（否则覆盖统计会漏这条分支）
  for (let i = 0; i < 6; i += 1) {
    push('individual', { 3: (i * 29) & 0xfd }, true, `个体模式(etc2=true)#${i}`);
  }
  push('individual', { 0: 0, 1: 0, 2: 0, 3: 0x00, 4: 0, 5: 0, 6: 0, 7: 0 }, false, '全 0 block');
  push('individual', { 0: 0xff, 1: 0xff, 2: 0xff, 3: 0xfd, 4: 0xff, 5: 0xff, 6: 0xff, 7: 0xff }, false, '全 FF block');
  push('individual', { 3: 0x00, 4: 0, 5: 0, 6: 0, 7: 0 }, false, '索引全 0（j=k=0）');
  push('individual', { 3: 0x00, 4: 0xff, 5: 0xff, 6: 0xff, 7: 0xff }, false, '索引全 1（j=k=0xFFFF）');

  // ── T：b[0] 低 3 位 = 7 ⇒ dr=-8 ⇒ r0+dr<0（r0 取 0x00 与 0x08 两个低值）
  for (const r of [0x00, 0x08]) {
    for (const d of [0x07, 0x0f]) {
      push('t', { 0: (r & 0xf8) | (d & 7), 1: 0x00, 2: 0x00, 3: 0x02 }, true, `T r0=${r} ddd=${d & 7}`);
    }
  }
  push('t', { 0: 0x07, 1: 0x00, 2: 0x00, 3: 0x02, 4: 0x00, 5: 0x00, 6: 0x00, 7: 0x00 }, true, 'T + 索引全 0');
  push('t', { 0: 0x07, 1: 0x00, 2: 0x00, 3: 0x02, 4: 0xff, 5: 0xff, 6: 0xff, 7: 0xff }, true, 'T + 索引全 1');

  // ── H：r 不溢出、b[1] 低 3 位 = 7 ⇒ dg=-8
  for (const g of [0x00, 0x08]) {
    push('h', { 0: 0x00, 1: (g & 0xf8) | 7, 2: 0x00, 3: 0x02 }, true, `H g0=${g}`);
  }
  push('h', { 0: 0x00, 1: 0x07, 2: 0x00, 3: 0x02, 4: 0x00, 5: 0x00, 6: 0x00, 7: 0x00 }, true, 'H + 索引全 0');
  push('h', { 0: 0x00, 1: 0x07, 2: 0x00, 3: 0x02, 4: 0xff, 5: 0xff, 6: 0xff, 7: 0xff }, true, 'H + 索引全 1');
  // 补足 H 覆盖：只有 g0=0x00 能让 g0+(-8) 溢出 ⇒ 变化维度换成 flip / code0 / code1 / 索引
  for (const [flip, c0, c1] of [[0, 0, 0], [1, 0, 0], [0, 7, 0], [0, 0, 7], [1, 7, 7], [0, 3, 5]]) {
    push('h', {
      0: 0x00, 1: 0x07, 2: 0x00,
      3: 0x02 | (flip & 1) | ((c0 & 7) << 5) | ((c1 & 7) << 2),
      4: 0xaa, 5: 0x55, 6: 0x33, 7: 0xcc,
    }, true, `H flip=${flip} code=${c0}/${c1}`);
  }

  // ── Planar：r/g 不溢出、b[2] 低 3 位 = 7 ⇒ db=-8
  for (const b2 of [0x07, 0x0f]) {
    push('planar', { 0: 0x00, 1: 0x00, 2: b2, 3: 0x02 }, true, `Planar b2=0x${b2.toString(16)}`);
  }
  push('planar', { 0: 0x00, 1: 0x00, 2: 0x07, 3: 0x02, 4: 0x00, 5: 0x00, 6: 0x00, 7: 0x00 }, true, 'Planar + 索引全 0');
  push('planar', { 0: 0x00, 1: 0x00, 2: 0x07, 3: 0x02, 4: 0xff, 5: 0xff, 6: 0xff, 7: 0xff }, true, 'Planar + 索引全 1');
  // 补足 Planar 覆盖：同理只有 b2 低 5 位 = 0 时 b2+(-8) 才溢出 ⇒ 变化 flip / code / 索引
  for (const [flip, c0, c1] of [[0, 0, 0], [1, 0, 0], [0, 7, 0], [0, 0, 7], [1, 7, 7], [0, 2, 6]]) {
    push('planar', {
      0: 0x00, 1: 0x00, 2: 0x07,
      3: 0x02 | (flip & 1) | ((c0 & 7) << 5) | ((c1 & 7) << 2),
      4: 0x5a, 5: 0xa5, 6: 0x0f, 7: 0xf0,
    }, true, `Planar flip=${flip} code=${c0}/${c1}`);
  }

  // ── differential（ETC2 下走到兜底）：三通道都不溢出
  for (let i = 0; i < 6; i += 1) {
    push('differential', { 0: 0x00 | (i & 7), 1: 0x00, 2: 0x00, 3: 0x02 }, true, `ETC2 差分随机#${i}`);
  }
  push('differential', { 0: 0x00, 1: 0x00, 2: 0x00, 3: 0x02, 4: 0x00, 5: 0x00, 6: 0x00, 7: 0x00 }, true, 'ETC2 差分 + 索引全 0');
  push('differential', { 0: 0x00, 1: 0x00, 2: 0x00, 3: 0x02, 4: 0xff, 5: 0xff, 6: 0xff, 7: 0xff }, true, 'ETC2 差分 + 索引全 1');

  // ── ETC1（etc2=false）：同一份字节必须走 differential，不进 T/H/Planar
  //    乙项专项：取"etc2=true 下命中 T"的那组字节，用 etc2=false 再跑一次
  for (let i = 0; i < 6; i += 1) {
    push('etc1-diff', { 0: 0x00 | (i & 7), 1: 0x00, 2: 0x00, 3: 0x02 }, false, `ETC1 差分随机#${i}`);
  }
  push('etc1-diff', { 0: 0x00, 1: 0x00, 2: 0x00, 3: 0x02, 4: 0x00, 5: 0x00, 6: 0x00, 7: 0x00 }, false, 'ETC1 + 索引全 0');
  push('etc1-diff', { 0: 0x00, 1: 0x00, 2: 0x00, 3: 0x02, 4: 0xff, 5: 0xff, 6: 0xff, 7: 0xff }, false, 'ETC1 + 索引全 1');
  return samples;
}

/** 跑一遍：返回 {rows, hitStats, switchProof} */
function collect() {
  const out = { libs: {} };
  for (const [label, dir] of Object.entries(LIBS)) {
    const ns = loadLib(dir);
    const samples = buildSamples();
    const rows = [];
    const hit = { individual: 0, t: 0, h: 0, planar: 0, differential: 0 };
    for (const s of samples) {
      const mode = probeMode(s.block, 0, s.etc2);
      hit[mode] = (hit[mode] || 0) + 1;
      let fp;
      try {
        const rgba = ns.etc2.decodeRgbBlock(s.block, 0, s.etc2);
        fp = { outcome: 'ok', md5: md5(rgba), len: rgba.length };
      } catch (e) {
        fp = { outcome: 'throw', code: (e && e.code) || null, msg: (e && e.message) || String(e) };
      }
      rows.push({
        tag: s.tag, note: s.note, etc2: s.etc2, mode,
        block: [...s.block].join(','), fp,
      });
    }

    // 乙：etc2 开关专项 —— 同一份"etc2=true 命中 T"的字节，用 etc2=false 再解一次
    const tSample = samples.find((s) => s.etc2 && probeMode(s.block, 0, true) === 't');
    let switchProof = null;
    if (tSample) {
      const asEtc2 = ns.etc2.decodeRgbBlock(tSample.block, 0, true);
      const asEtc1 = ns.etc2.decodeRgbBlock(tSample.block, 0, false);
      switchProof = {
        block: [...tSample.block].join(','),
        etc2Mode: probeMode(tSample.block, 0, true),
        etc1Mode: probeMode(tSample.block, 0, false),
        etc2Md5: md5(asEtc2),
        etc1Md5: md5(asEtc1),
        differ: md5(asEtc2) !== md5(asEtc1),
      };
    }

    out.libs[label] = { rows, hit, switchProof };
  }
  return out;
}

/** 覆盖断言：etc2=true 五模式各 ≥6；etc2=false 只允许 individual/differential 且各 ≥6 */
function coverageErrors(data) {
  const errs = [];
  for (const [lib, l] of Object.entries(data.libs)) {
    const h = l.hit;
    // 样本里 etc2=true 与 false 混在一起，这里按 row 分开统计
    const on = { individual: 0, t: 0, h: 0, planar: 0, differential: 0 };
    const off = { individual: 0, differential: 0, others: 0 };
    for (const r of l.rows) {
      if (r.etc2) on[r.mode] = (on[r.mode] || 0) + 1;
      else {
        if (r.mode === 'individual' || r.mode === 'differential') off[r.mode] += 1;
        else off.others += 1;
      }
    }
    for (const m of ['individual', 't', 'h', 'planar', 'differential']) {
      if (on[m] < 6) errs.push(`${lib}: etc2=true 的 ${m} 只命中 ${on[m]} 组（要求 ≥6）`);
    }
    for (const m of ['individual', 'differential']) {
      if (off[m] < 6) errs.push(`${lib}: etc2=false 的 ${m} 只命中 ${off[m]} 组（要求 ≥6）`);
    }
    if (off.others !== 0) errs.push(`${lib}: etc2=false 时出现 ${off.others} 组落进 T/H/Planar（必须为 0）`);
    const sp = l.switchProof;
    if (!sp) errs.push(`${lib}: 缺少 etc2 开关专项样本`);
    else if (!sp.differ) errs.push(`${lib}: etc2 开关专项未产生差异（etc2 与 etc1 输出相同）—— 开关可能失效`);
    if (h && Object.values(h).every((v) => v === 0)) errs.push(`${lib}: 模式命中统计全为 0（探针失效）`);
  }
  return errs;
}

function diff(before, after) {
  const diffs = [];
  for (const lib of Object.keys(before.libs)) {
    const b = before.libs[lib].rows; const a = after.libs[lib] ? after.libs[lib].rows : [];
    if (b.length !== a.length) diffs.push(`${lib}: 样本数 ${b.length} → ${a.length}`);
    for (let i = 0; i < Math.min(b.length, a.length); i += 1) {
      const bj = JSON.stringify(b[i].fp); const aj = JSON.stringify(a[i].fp);
      if (bj !== aj) diffs.push(`${lib} #${i}(${b[i].tag}/${b[i].note}): ${bj} → ${aj}`);
      if (b[i].mode !== a[i].mode) diffs.push(`${lib} #${i} 模式判定变化 ${b[i].mode} → ${a[i].mode}`);
    }
    const bs = JSON.stringify(before.libs[lib].switchProof);
    const as = JSON.stringify(after.libs[lib].switchProof);
    if (bs !== as) diffs.push(`${lib}: etc2 开关专项结果变化\n   前 ${bs}\n   后 ${as}`);
  }
  return diffs;
}

function report(data) {
  for (const [lib, l] of Object.entries(data.libs)) {
    const on = { individual: 0, t: 0, h: 0, planar: 0, differential: 0 };
    const off = { individual: 0, differential: 0, others: 0 };
    for (const r of l.rows) {
      if (r.etc2) on[r.mode] = (on[r.mode] || 0) + 1;
      else if (r.mode === 'individual' || r.mode === 'differential') off[r.mode] += 1;
      else off.others += 1;
    }
    console.log(`  ${lib}: ${l.rows.length} 样本`);
    console.log(`    etc2=true  命中 ${JSON.stringify(on)}`);
    console.log(`    etc2=false 命中 ${JSON.stringify(off)}`);
    if (l.switchProof) {
      console.log(`    开关专项：etc2→${l.switchProof.etc2Mode}(${l.switchProof.etc2Md5.slice(0, 8)}) `
        + `vs etc1→${l.switchProof.etc1Mode}(${l.switchProof.etc1Md5.slice(0, 8)}) 差异=${l.switchProof.differ}`);
    }
  }
}

const args = process.argv.slice(2);
const iBase = args.indexOf('--baseline');
const iComp = args.indexOf('--compare');

if (iBase >= 0) {
  const out = args[iBase + 1] || '/tmp/etc2-baseline.json';
  const data = collect();
  fs.writeFileSync(out, JSON.stringify(data, null, 1));
  console.log(`baseline 已写：${out}`);
  report(data);
  const errs = coverageErrors(data);
  if (errs.length) { console.log('❌ 覆盖不足：'); errs.forEach((e) => console.log('  ' + e)); process.exitCode = 1; }
  else console.log('✅ 覆盖满足要求');
} else if (iComp >= 0) {
  const base = args[iComp + 1] || '/tmp/etc2-baseline.json';
  const before = JSON.parse(fs.readFileSync(base, 'utf8'));
  const after = collect();
  console.log(`对比：${base}`);
  report(after);
  const errs = coverageErrors(after);
  const diffs = diff(before, after);
  if (errs.length) { console.log('❌ 覆盖不足（0 差异也不算通过）：'); errs.forEach((e) => console.log('  ' + e)); }
  if (!diffs.length) console.log('✅ 逐字节相同（0 差异）');
  else { console.log(`❌ 发现 ${diffs.length} 处差异：`); diffs.slice(0, 40).forEach((d) => console.log('  ' + d)); }
  if (errs.length || diffs.length) process.exitCode = 1;
} else {
  console.log('用法：--baseline <out.json> | --compare <baseline.json>');
}
