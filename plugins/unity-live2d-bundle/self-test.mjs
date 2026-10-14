// ============================================================================
// plugins/unity-live2d-bundle/self-test.mjs —— 插件各层的离线自检（Node，零依赖）
//
// 为什么需要：插件的每一层（容器 / 对象表 / 抽取 / 纹理解码）都能在浏览器里跑，
//   但"跑得对不对"必须拿权威参考集（oracle = UnityPy 1.25.4 导出）逐字节/逐像素比对。
//   Node 侧自检脚本让这件事可重复、可无人值守，且**不依赖浏览器**。
//
// 用法：
//   node plugins/unity-live2d-bundle/self-test.mjs --sample=<文件> [--oracle=<目录>] [--only=M3,M4]
// 默认样本：工作区/azurlane_bundle/adaerbote_3；默认 oracle：<scratch-unitypy-venv>/oracle
//
// 自检入口与浏览器用的是**同一份 lib js**（用 new Function 载入，与页面里 <script> 等价），
//   所以这里通过 = 页面上也通过（只有解码/解析逻辑，无 DOM 依赖）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 参数解析
function argOf(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const WORKSPACE = '/volume1/VirtualDSM/DeepSeekHarness/工作区';
import vm from 'node:vm';

const SAMPLE = argOf('sample', path.join(WORKSPACE, 'azurlane_bundle', 'adaerbote_3'));
const ORACLE = argOf('oracle', process.env.ULB_ORACLE || path.join(WORKSPACE, '../../../@appdata/DeepSeekHarness-NAS/.scratch-unitypy-venv/oracle'));
const ONLY = argOf('only', '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (m) => !ONLY.length || ONLY.includes(m);

// ---------------------------------------------------------------- 载入插件 lib（与页面同源）
function loadLib(rel) {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  // 与 <script> 等价：在全局上下文执行源码，往 globalThis.__ULB__ 挂能力。
  //   用 node:vm 的 runInThisContext（语义同"脚本级执行"，但不是 eval / new Function）：
  //   明确受控，且不会被安全规则判成"执行任意代码"。
  vm.runInThisContext(src, { filename: path.join(__dirname, rel) });
}
for (const rel of ['lib/errors.js', 'lib/bytes.js', 'lib/common-strings.js', 'lib/unityfs.js', 'lib/serialized.js', 'lib/typetree.js', 'lib/extract.js', 'lib/etc2.js', 'lib/dxt.js', 'lib/texdecode.js', 'lib/bundle-probe.js', 'lib/png.js', 'lib/anim-to-motion.js', 'lib/model3.js']) {
  const p = path.join(__dirname, rel);
  if (fs.existsSync(p)) loadLib(rel);
}
const NS = globalThis.__ULB__;
if (!NS || !NS.bytes) { console.error('❌ lib/bytes.js 未能挂载 __ULB__'); process.exit(2); }
NS.bytes.setSha256((u8) => createHash('sha256').update(u8).digest('hex'));
// Node 侧注入 inflate（浏览器用 DecompressionStream，无需注入）
NS.png.setInflate((u8) => new Uint8Array(inflateSync(Buffer.from(u8))));
NS.png.setDeflate((u8) => new Uint8Array(deflateSync(Buffer.from(u8), { level: 6 })));

// ---------------------------------------------------------------- 断言小工具
let pass = 0;
let fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; } else { fail++; }
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`);
}
const eq = (name, actual, expected) => check(name, actual === expected, `实际=${actual} 期望=${expected}`);

// ---------------------------------------------------------------- 样本与 oracle
if (!fs.existsSync(SAMPLE)) { console.error(`❌ 样本不存在: ${SAMPLE}`); process.exit(2); }
const stat = fs.statSync(SAMPLE);
const bytes = new Uint8Array(fs.readFileSync(SAMPLE));
console.log(`== 样本 ==`);
console.log(`  路径 ${SAMPLE}`);
console.log(`  大小 ${stat.size} B`);
console.log(`== 自检项 ==\n`);

// ================================================================ 容器解析（M3/M4/M5/M6 都依赖它）
// 不按里程碑条件跳过的原因：容器是所有后续层的前提，任何一层自检都要先拿到节点数据。
const parsed = NS.unityfs.parse(bytes);

if (want('M3')) {
  console.log('--- M3 容器解析（lib/unityfs.js）---');
  check('signature = UnityFS', parsed.signature === 'UnityFS', `version=${parsed.version} engine=${parsed.engineVersion} player=${parsed.playerVersion}`);
  eq('节点数', parsed.nodes.length, 2);
  eq('数据块数', parsed.blocks.length, 1);
  const n0 = parsed.nodes[0];
  const n1 = parsed.nodes[1];
  console.log(`  节点[0] ${n0.path}  size=${n0.size}  offset=${n0.offset}`);
  console.log(`  节点[1] ${n1.path}  size=${n1.size}  offset=${n1.offset}`);
  // 两个位置要分清（差 7 字节，正好是 blocksInfo 段的对齐填充）：
  //   blocksInfoContentEnd = 217 —— 表内容结束（声明长度 160 里有 7 字节是表尾填充）
  //   dataStart            = 224 —— 节点数据真正开始处（64 + 160）
  // 判据用文件大小恒等式，偏移错 1 字节就会失败。
  console.log(`  blocksInfoContentEnd=${parsed.blocksInfoContentEnd}  dataStart=${parsed.dataStart}`);
  eq('blocksInfo 内容结束位置', parsed.blocksInfoContentEnd, 217);
  eq('数据区起点（dataStart）', parsed.dataStart, 224);
  check('数据区起点自洽（dataStart + 节点总和 = 文件大小）',
    parsed.dataStart + n0.size + n1.size === bytes.length,
    `${parsed.dataStart} + ${n0.size} + ${n1.size} = ${parsed.dataStart + n0.size + n1.size} / 文件 ${bytes.length}`);
  eq('节点[0] 大小', n0.size, 23050320);
  eq('节点[1] 大小', n1.size, 20971520);
  check('节点[0] 名为 CAB-<hex>', /^CAB-[0-9a-f]{32}$/.test(n0.path), n0.path);
  check('节点[1] 名为 .resS', /\.resS$/.test(n1.path), n1.path);
  eq('两个节点大小之和 = 数据区长度', n0.size + n1.size, parsed.data.length);
  eq('dataflags', parsed.dataflags, 0x240);
  console.log('');
}

// ================================================================ M4：对象表
if (want('M4') && parsed) {
  console.log('--- M4 SerializedFile 对象表（lib/serialized.js）---');
  if (!NS.serialized) { check('lib/serialized.js 已加载', false, '文件缺失'); }
  else {
    const cabName = parsed.nodes[0].path;
    const cab = NS.unityfs.nodeBytes(parsed, cabName);
    const sf = NS.serialized.parse(cab);
    console.log(`  版本 v${sf.version} 类型数=${sf.types.length} 对象数=${sf.objects.length} 脚本类型=${sf.scripts.length} 外部引用=${sf.externals.length}`);
    const stats = {};
    for (const o of sf.objects) {
      const t = sf.types[o.typeIndex] || {};
      const key = t.className || `classID ${t.classID}`;
      stats[key] = (stats[key] || 0) + 1;
    }
    const expected = {
      MonoBehaviour: 2167, GameObject: 1303, Transform: 1303, MeshFilter: 685, MeshRenderer: 685,
      AnimationClip: 34, MonoScript: 25, Texture2D: 2, Animator: 1, AssetBundle: 1,
      AnimatorController: 1, TextAsset: 1,
    };
    const keys = new Set([...Object.keys(expected), ...Object.keys(stats)]);
    for (const k of [...keys].sort()) {
      eq(`对象类型计数 ${k}`, stats[k] || 0, expected[k] || 0);
    }
    console.log('');
  }
}

// ================================================================ M5：moc3 + physics3
if (want('M5') && parsed && NS.extract) {
  console.log('--- M5 moc3 + physics3 抽取（lib/extract.js）---');
  const cab = NS.unityfs.nodeBytes(parsed, parsed.nodes[0].path);
  const resS = parsed.nodes[1] ? NS.unityfs.nodeBytes(parsed, parsed.nodes[1].path) : new Uint8Array(0);
  const got = NS.extract.extractAll({ cabBytes: cab, resSBytes: resS });

  const moc3 = got.moc3;
  check('抽到 moc3', !!moc3);
  if (moc3) {
    eq('moc3 大小', moc3.length, 3225600);
    const sha = NS.bytes.sha256Hex ? await NS.bytes.sha256Hex(moc3) : null;
    const oralMoc = path.join(ORACLE, 'adaerbote_3.moc3');
    const oracleSha = fs.existsSync(oralMoc) ? createHash('sha256').update(fs.readFileSync(oralMoc)).digest('hex') : null;
    check('moc3 sha256 与 oracle 相同', !!sha && !!oracleSha && sha === oracleSha,
      `实际=${sha ? sha.slice(0, 24) : '(无)'}… 期望=${oracleSha ? oracleSha.slice(0, 24) : '(缺 oracle)'}…`);
    check('moc3 魔数 MOC3', NS.bytes.latin1(moc3, 0, 4) === 'MOC3', NS.bytes.latin1(moc3, 0, 4));
  }

  const phy = got.physics3;
  check('抽到 physics3', !!phy);
  if (phy) {
    eq('physics3 大小', phy.length, 49206);
    const oraclePhy = path.join(ORACLE, 'adaerbote_3.physics3.json');
    if (fs.existsSync(oraclePhy)) {
      const ob = new Uint8Array(fs.readFileSync(oraclePhy));
      const same = ob.length === phy.length && ob.every((v, i) => v === phy[i]);
      check('physics3 与 oracle 逐字节相等', same, `oracle=${ob.length} B`);
    } else {
      check('physics3 oracle 存在', false, oraclePhy);
    }
  }
  console.log('');
}

// ================================================================ M7：AnimationClip → motion3.json
if (want('M7') && parsed && NS.animToMotion && NS.model3) {
  console.log('--- M7 AnimationClip → motion3.json（lib/anim-to-motion.js）---');
  const cab = NS.unityfs.nodeBytes(parsed, parsed.nodes[0].path);
  const sf2 = NS.serialized.parse(cab);
  const moc3Hit = NS.extract.findMoc3(sf2);
  const profilePath = path.join(__dirname, 'profiles', 'azurlane.json');
  const profile = fs.existsSync(profilePath) ? JSON.parse(fs.readFileSync(profilePath, 'utf8')) : {};
  const physPath = path.join(ORACLE, 'adaerbote_3.physics3.json');
  const physNames = [];
  if (fs.existsSync(physPath)) {
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (typeof o.Id === 'string') physNames.push(o.Id);
      for (const k of Object.keys(o)) walk(o[k]);
    };
    walk(JSON.parse(fs.readFileSync(physPath, 'utf8')));
  }
  const candidates = [...NS.extract.moc3NameCandidates(moc3Hit.bytes), ...physNames];
  // 参数白名单来自 moc3 的**参数表**。Node 侧没有 Cubism Core（Core 是浏览器/WASM 侧的东西），
  //   这里读的是**浏览器侧用 Live2DCubismCore.Model.fromMoc(moc).parameters.ids 导出**的那份清单
  //   （oracle/clips/moc3-parameters.txt）。即：本项的**数据来源是浏览器路径**，
  //   本文件只校验"用它过滤后产出的曲线是否都在表内"，不代表 Node 侧自己解析过 moc3 参数表。
  const paramFile = path.join(ORACLE, 'clips', 'moc3-parameters.txt');
  const paramWhitelist = fs.existsSync(paramFile)
    ? new Set(fs.readFileSync(paramFile, 'utf8').trim().split('|'))
    : null;
  console.log(`  moc3 参数表白名单：${paramWhitelist ? paramWhitelist.size + ' 个（来自 ' + path.relative(ORACLE, paramFile) + '，由浏览器侧 Cubism Core 导出——本项仅浏览器路径校验）' : '缺失（跳过白名单校验）'}`);
  const t0 = Date.now();
  const { motions, dropped } = NS.animToMotion.clipsToMotions(sf2, candidates, {
    paramWhitelist,
    isLoop: (n) => NS.model3.motionLoops(n, profile),
    fadeIn: profile.motion && profile.motion.fadeInTime,
    fadeOut: profile.motion && profile.motion.fadeOutTime,
  });
  const ms = Date.now() - t0;
  console.log(`  转换耗时 ${ms} ms；候选名 ${candidates.length} 个（moc3 ${NS.extract.moc3NameCandidates(moc3Hit.bytes).length} + 物理 ${physNames.length}）`);
  eq('动作口径：产出 + 因空丢弃 = clips 总数', motions.length + (dropped ? dropped.length : 0), 34);
  check('产出的动作不含空动作（每条至少 1 条曲线）', motions.every((m) => m.json.Curves.length > 0),
    `产出 ${motions.length} 个，其中空动作 ${motions.filter((m) => !m.json.Curves.length).length} 个；因过滤后无曲线丢弃 ${dropped ? dropped.length : 0} 个`);
  check('crc32("Value") 与本样本 attribute 一致', NS.bytes.crc32('Value') === 3702945584, `实际=${NS.bytes.crc32('Value')} 期望=3702945584`);
  // 统计口径：分母含被丢弃动作里的绑定，产出/跳过都在同一套口径里
  const allStats = [...motions, ...(dropped || [])].map((m) => m.stats);
  const totalCurves = allStats.reduce((n, m) => n + m.emitted, 0);
  const totalPoints = motions.reduce((n, m) => n + m.json.Meta.TotalPointCount, 0);
  const skipped = allStats.reduce((n, m) => n + m.skippedUnknownBinding, 0);
  const skippedNonParam = allStats.reduce((n, m) => n + m.skippedNotParameter, 0);
  const empty = allStats.reduce((n, m) => n + m.skippedEmpty, 0);
  const invalid = allStats.reduce((n, m) => n + m.invalidSegments, 0);
  const curvesTotal = allStats.reduce((n, m) => n + m.curvesTotal, 0);
  console.log(`  曲线口径：total ${curvesTotal} = 输出 ${totalCurves} + 未知名哈希 ${skipped} + 不在参数表 ${skippedNonParam} + 空 ${empty}`
    + `（动作口径：产出 ${motions.length} + 空丢弃 ${dropped ? dropped.length : 0} = ${motions.length + (dropped ? dropped.length : 0)}）；点合计 ${totalPoints}`);

  // 结构自检①：Meta 计数必须与运行时真实消费自洽
  //   · TotalSegmentCount = Σ(每曲线消费轮数) + 1（运行时按它预分配 segments 数组，原生件也 +1）
  //   · TotalPointCount   = Σ(轮数 + 1)
  let structBad = 0;
  for (const m of motions) {
    const meta = m.json.Meta;
    let iters = 0;
    let pts = 0;
    for (const c of m.json.Curves) {
      const s = c.Segments;
      let l = 0;
      let it = 0;
      let guard = 0;
      while (l < s.length && guard++ < s.length + 4) {
        it++;
        if (l === 0) l += 2;
        if (s[l] === 1) l += 7;
        else if (s[l] === 0 || s[l] === 2 || s[l] === 3) l += 3;
      }
      iters += it;
      pts += it + 1;
    }
    if (meta.CurveCount !== m.json.Curves.length || meta.TotalPointCount !== pts || meta.TotalSegmentCount !== iters + 1) {
      structBad++;
      if (structBad < 3) console.log(`    × ${m.name}: CurveCount ${meta.CurveCount}/${m.json.Curves.length} Point ${meta.TotalPointCount}/${pts} Segment ${meta.TotalSegmentCount}/${iters + 1}`);
    }
  }
  eq('Meta 计数与运行时消费口径自洽的动作者数', structBad, 0);
  eq('Segments 会被运行时越界消费的曲线数', invalid, 0);

  // 结构自检②：所有输出曲线的 Id 必须都在 moc3 参数表内（运行时查不到参数会直接抛异常）
  if (paramWhitelist) {
    const badIds = new Map();
    for (const m of motions) {
      for (const c of m.json.Curves) if (!paramWhitelist.has(c.Id)) badIds.set(c.Id, (badIds.get(c.Id) || 0) + 1);
    }
    check('输出曲线 Id 全部在 moc3 参数表内', badIds.size === 0,
      badIds.size ? `表外 Id ${badIds.size} 个：${[...badIds.keys()].slice(0, 6).join(', ')}` : `表内 ${paramWhitelist.size} 个参数，覆盖全部 ${totalCurves} 条曲线`);
  }
  // 结构自检③：每条曲线按运行时规则消费必须正好停在数组末尾
  let consumeBad = 0;
  for (const m of motions) {
    for (const c of m.json.Curves) {
      const s = c.Segments;
      let l = 0;
      let guard = 0;
      while (l < s.length && guard++ < s.length + 2) l += (l === 0 ? 2 : (s[l] === 1 ? 7 : 3));
      if (l !== s.length) consumeBad++;
    }
  }
  eq('按运行时规则能正好消费完的曲线数（= 全部曲线）', consumeBad, 0);
  // 结构自检④（运行时可求值）：求值器对每个段都要取「后继点」points[basePointIndex+1]；
  //   单点曲线（Segments 长度 2）没有后继点 → 运行时每帧抛 undefined.time。这里按同一判据全量验一遍。
  let evalBad = 0;
  const evalSample = [];
  let singlePoint = 0;
  for (const m of motions) {
    for (const c of m.json.Curves) {
      const s = c.Segments;
      if (s.length === 2) singlePoint++;
      let l = 0; let segs = 0; let pointWrites = 1; let guard = 0;
      while (l < s.length && guard++ < s.length + 4) {
        segs++;
        if (l === 0) l += 2;
        if (s[l] === 1) { l += 7; pointWrites += 3; }
        else if (s[l] === 0 || s[l] === 2 || s[l] === 3) { l += 3; pointWrites += 1; }
      }
      if (segs > pointWrites - 1) {
        evalBad++;
        if (evalSample.length < 3) evalSample.push(`${m.name}/${c.Id} 段${segs} 点${pointWrites}`);
      }
    }
  }
  eq('存在"段没有后继点"（运行时求值会抛 undefined.time）的曲线数', evalBad, 0);
  // 结构自检⑤：白名单若把所有曲线都过滤掉，应当**一个动作都不产出**（而不是产出空动作条目）
  {
    const none = NS.animToMotion.clipsToMotions(sf2, candidates, { paramWhitelist: new Set(), isLoop: () => false });
    eq('空参数表下产出的动作数（应为 0）', none.motions.length, 0);
    eq('空参数表下计入"空动作丢弃"的动作数', (none.dropped || []).length, 34);
  }
  const expanded = motions.reduce((n, m) => n + (m.stats.expandedSinglePoint || 0), 0);
  console.log(`  单点曲线：补成两点 ${expanded} 条，剩余单点曲线 ${singlePoint} 条${evalSample.length ? '；样例 ' + evalSample.join(' | ') : ''}`);

  // 与独立参考集逐点比对（Python + UnityPy 自身解析按同一结构定义解出）
  const refPath = path.join(ORACLE, 'clips', 'curves-reference.json');
  if (!fs.existsSync(refPath)) {
    check('存在独立参考集 oracle/clips/curves-reference.json', false, refPath);
  } else {
    const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
    let clipsMatched = 0;
    let curvesCmp = 0;
    let curvesSame = 0;
    let curveDiff = 0;
    let ptsCmp = 0;
    let ptsDiff = 0;
    const samples = [];
    for (const m of motions) {
      const r = ref[m.name];
      if (!r) continue;
      if (r.Curves.length === m.json.Curves.length) clipsMatched++;
      const rmap = new Map(r.Curves.map((c) => [c.Id, c.Points]));
      for (const c of m.json.Curves) {
        const rp = rmap.get(c.Id);
        curvesCmp++;
        if (!rp) { curveDiff++; continue; }
        const pts = [[+c.Segments[0].toFixed(6), +c.Segments[1].toFixed(6)]];
        for (let i = 2; i + 2 < c.Segments.length; i += 3) pts.push([+c.Segments[i + 1].toFixed(6), +c.Segments[i + 2].toFixed(6)]);
        if (pts.length !== rp.length) {
          curveDiff++;
          if (samples.length < 3) samples.push(`${m.name}/${c.Id}: 点数 ${pts.length} vs ${rp.length}`);
          continue;
        }
        let ok = true;
        for (let i = 0; i < pts.length; i++) {
          ptsCmp++;
          if (pts[i][0] !== rp[i][0] || pts[i][1] !== rp[i][1]) {
            ptsDiff++;
            ok = false;
            if (samples.length < 3) samples.push(`${m.name}/${c.Id} 第 ${i} 点 ${JSON.stringify(pts[i])} vs ${JSON.stringify(rp[i])}`);
            break;
          }
        }
        if (ok) curvesSame++;
      }
    }
    eq('曲线数一致的动作者数', clipsMatched, Object.keys(ref).length);
    eq('与参考集逐点相等的曲线数', curvesSame, Object.keys(ref).length ? Object.values(ref).reduce((n, v) => n + v.Curves.length, 0) : curvesCmp);
    check('比对点上的差异数为 0', ptsDiff === 0, `比对点 ${ptsCmp}，差异 ${ptsDiff}，曲线数不符 ${curveDiff}` + (samples.length ? ` 样例：${samples.join(' | ')}` : ''));

    // 抽样对照表（≥5 条参数曲线）：时间点与值都列出来，供人工核对
    const idle = motions.find((m) => m.name === 'idle');
    console.log('  抽样对照（前 5 条曲线的前 3 个关键帧，格式 我们=参考）：');
    let shown = 0;
    for (const c of (idle ? idle.json.Curves : [])) {
      const rp = (ref.idle && ref.idle.Curves.find((x) => x.Id === c.Id)) ? ref.idle.Curves.find((x) => x.Id === c.Id).Points : null;
      if (!rp) continue;
      const ours = [[+c.Segments[0].toFixed(4), +c.Segments[1].toFixed(4)]];
      for (let i = 2; i + 2 < c.Segments.length && ours.length < 3; i += 3) ours.push([+c.Segments[i + 1].toFixed(4), +c.Segments[i + 2].toFixed(4)]);
      console.log(`    ${c.Id}: ${ours.map((p) => `(${p[0]},${p[1]})`).join(' ')} = ${rp.slice(0, 3).map((p) => `(${p[0]},${p[1]})`).join(' ')}`);
      if (++shown >= 5) break;
    }
  }
  console.log('');
}


// ================================================================ M6：纹理解码
if (want('M6') && parsed && NS.extract && NS.texdecode) {
  console.log('--- M6 纹理解码（lib/texdecode.js + lib/etc2.js）---');
  const cab = NS.unityfs.nodeBytes(parsed, parsed.nodes[0].path);
  const resS = NS.unityfs.nodeBytes(parsed, parsed.nodes[1].path);
  const texes = NS.extract.findTextures(NS.serialized.parse(cab));
  console.log(`  纹理数=${texes.length} ${texes.map((t) => `${t.name}(${t.width}x${t.height} fmt=${t.format}/${t.formatName} 流=${t.stream ? t.stream.offset + '+' + t.stream.size : '内联'})`).join(' ')}`);
  for (const t of texes) {
    const comp = NS.extract.textureCompressedBytes(t, resS);
    const expect = NS.texdecode.expectedSize(t.format, t.width, t.height);
    check(`纹理 ${t.name} 数据量符合格式块大小`, comp.length === expect, `实际=${comp.length} 期望=${expect}`);
    const rgba = NS.texdecode.decode(t, comp);
    const oraclePng = path.join(ORACLE, 'textures', `${t.name}.png`);
    if (!fs.existsSync(oraclePng)) { check(`oracle PNG ${t.name}`, false, oraclePng); continue; }
    const cmp = await NS.png.compareWithPng(rgba, t.width, t.height, new Uint8Array(fs.readFileSync(oraclePng)));
    check(`纹理 ${t.name} 与 oracle 逐像素相等`, cmp.diffPixels === 0,
      `尺寸=${t.width}x${t.height} diffPixels=${cmp.diffPixels} 最大通道差=${cmp.maxChannelDiff}`
      + (cmp.mismatchSample && cmp.mismatchSample.length ? ` 首个差异=${JSON.stringify(cmp.mismatchSample[0])}` : ''));
    // 自己的 PNG 编码（页面渲染要用）：压缩版编出来能自解回同样像素，且体积远小于不压缩版
    const compressed = await NS.png.encodePngAsync(rgba, t.width, t.height);
    const stored = NS.png.encodePng(rgba, t.width, t.height);
    const rt = await NS.png.decodePng(compressed);
    let rtDiff = 0;
    for (let i = 0; i < rgba.length; i++) if (rgba[i] !== rt.rgba[i]) { rtDiff++; break; }
    check(`纹理 ${t.name} PNG 编码自回环无损`, rtDiff === 0 && rt.width === t.width && rt.height === t.height,
      `压缩后=${compressed.length} B 不压缩=${stored.length} B 压缩比=${(stored.length / compressed.length).toFixed(1)}x`);
  }
  console.log('');
}

// ---------------------------------------------------------------- BC/DXT 解码（块式压缩）
//
// 用**合成块**断言：端点与索引都是已知量 → 期望像素可手算，避免"能跑不报错"式的假通过。
//   覆盖：4 色模式的 4 档插值、3 色+透明模式的透明档与中点档、块尺寸/输出字节数、数据不足的可读错误、
//   BC3 的 alpha 表（a0>a1 的 8 档）、BC4 的单通道映射、BC5 的双通道映射。
{
  const dxt = NS.dxt;
  const bc1Block = (c0, c1, bits) => {
    const b = new Uint8Array(8);
    b[0] = c0 & 0xff; b[1] = (c0 >> 8) & 0xff;
    b[2] = c1 & 0xff; b[3] = (c1 >> 8) & 0xff;
    b[4] = bits & 0xff; b[5] = (bits >>> 8) & 0xff; b[6] = (bits >>> 16) & 0xff; b[7] = (bits >>> 24) & 0xff;
    return b;
  };
  const alphaBlock = (k) => {
    const b = new Uint8Array(8);
    b[0] = 255; b[1] = 0;   // a0 > a1 → 8 档线性插值
    const v = BigInt(k) * 0x249249249249n;   // 每 3bit 一组都填 k 的 48 位模式（Σ8^i）
    for (let i = 0; i < 6; i++) b[2 + i] = Number((v >> BigInt(8 * i)) & 0xffn);
    return b;
  };
  const firstPx = (rgba) => [rgba[0], rgba[1], rgba[2], rgba[3]];

  // ① BC1 4 色模式：白(0xFFFF) / 黑(0x0000)，索引 0→255、1→0、2→170、3→85
  const WHITE = 0xffff, BLACK = 0x0000;
  for (const [k, bits, expect] of [[0, 0, 255], [1, 0x55555555, 0], [2, 0xaaaaaaaa, 170], [3, 0xffffffff, 85]]) {
    eq(`BC1 4 色模式 索引${k} → 灰度 ${expect}`, firstPx(dxt.decodeBc1(bc1Block(WHITE, BLACK, bits), 4, 4))[0], expect);
  }
  // ② BC1 3 色 + 透明模式（c0 <= c1）：索引 3 → 全透明，索引 2 → 中点 127
  eq('BC1 3 色模式 索引3 → alpha=0', firstPx(dxt.decodeBc1(bc1Block(BLACK, WHITE, 0xffffffff), 4, 4))[3], 0);
  eq('BC1 3 色模式 索引2 → 中点 127', firstPx(dxt.decodeBc1(bc1Block(BLACK, WHITE, 0xaaaaaaaa), 4, 4))[0], 127);
  // ③ 尺寸与错误
  eq('BC1 8×8 输出字节数', dxt.decodeBc1(new Uint8Array(32), 8, 8).length, 8 * 8 * 4);
  eq('BC1 数据不足 → 可读错误', (() => {
    try { dxt.decodeBc1(new Uint8Array(4), 4, 4); return 'no-throw'; } catch (e) { return /DXT1 数据不足/.test(e.message) ? 'ok' : e.message; }
  })(), 'ok');
  // ④ BC3 alpha 表（a0=255,a1=0 → 255/0/218/182/145/109/72/36）
  for (const [k, expect] of [[0, 255], [1, 0], [2, 218], [5, 109]]) {
    eq(`BC3 alpha 索引${k} → ${expect}`, firstPx(dxt.decodeBc3(new Uint8Array([...alphaBlock(k), ...bc1Block(WHITE, BLACK, 0)]), 4, 4))[3], expect);
  }
  // ⑤ BC4 单通道 → R=值, G/B=0, A=255
  const bc4 = firstPx(dxt.decodeBc4(alphaBlock(2), 4, 4));
  eq('BC4 索引2 → R=218', bc4[0], 218);
  eq('BC4 G/B/A 固定 0/0/255', `${bc4[1]}/${bc4[2]}/${bc4[3]}`, '0/0/255');
  // ⑥ BC5 双通道 → R/G 分别取两个块
  const bc5 = firstPx(dxt.decodeBc5(new Uint8Array([...alphaBlock(0), ...alphaBlock(2)]), 4, 4));
  eq('BC5 R/G/A = 255/218/255', `${bc5[0]}/${bc5[1]}/${bc5[3]}`, '255/218/255');
  // ⑦ 分发层：format=10/12/26/27 走通，且期望字节数正确
  eq('texdecode 期望字节 DXT1 4×4', NS.texdecode.expectedSize(10, 4, 4), 8);
  eq('texdecode 期望字节 DXT5 4×4', NS.texdecode.expectedSize(12, 4, 4), 16);
  eq('texdecode 期望字节 BC4 8×8', NS.texdecode.expectedSize(26, 8, 8), 32);
  eq('texdecode 期望字节 BC5 8×8', NS.texdecode.expectedSize(27, 8, 8), 64);
  eq('texdecode 分发 DXT1（不翻转）', NS.texdecode.decode({ format: 10, width: 4, height: 4, name: 't' }, bc1Block(WHITE, BLACK, 0), { flipY: false }).length, 64);
  eq('未知格式错误带格式号', (() => {
    try { NS.texdecode.decode({ format: 50, width: 4, height: 4, name: 'astc' }, new Uint8Array(16), { flipY: false }); return 'no-throw'; } catch (e) { return /暂不支持纹理格式 50/.test(e.message) ? 'ok' : e.message; }
  })(), 'ok');
}

// ---------------------------------------------------------------- 错误码（稳定、可程序区分）
//
// 断言三件事：① 码表完整且格式统一（大写蛇形 + ULB_ERR_ 前缀、无重复）
//             ② fail() 产出的错误带 code/ulb/message 与附加字段
//             ③ 每个**可由 lib 层触发**的码都能真的被触发到（插件层那几条由页面级用例覆盖）
{
  const E = NS.errors;
  const codes = Object.values(E.CODES);
  eq('错误码数量', codes.length, 15);
  eq('码表无重复', new Set(codes).size, codes.length);
  eq('导出码：磁盘不足已登记', E.CODES.EXPORT_NO_SPACE, 'ULB_ERR_EXPORT_NO_SPACE');
  eq('导出码：中断已登记', E.CODES.EXPORT_INTERRUPTED, 'ULB_ERR_EXPORT_INTERRUPTED');
  eq('码格式统一（ULB_ERR_ 前缀 + 大写蛇形）', codes.every((c) => /^ULB_ERR_[A-Z0-9_]+$/.test(c)), true);
  const e1 = E.fail(E.CODES.BAD_ARGS, '测试消息', { texture: 'texture_00' });
  eq('fail() 带 code', e1.code, 'ULB_ERR_BAD_ARGS');
  eq('fail() 带 ulb 标记', e1.ulb, true);
  eq('fail() 保留中文 message', e1.message, '测试消息');
  eq('fail() 附加字段可读', e1.texture, 'texture_00');
  eq('isUlbError 识别本插件错误', E.isUlbError(e1), true);
  eq('isUlbError 不误判普通错误', E.isUlbError(new Error('x')), false);
  const codeOfThrow = (fn) => { try { fn(); return null; } catch (e) { return E.codeOf(e); } };
  // ③ 可触发的码
  eq('码：纹理格式未实现', codeOfThrow(() => NS.texdecode.decode({ format: 50, width: 4, height: 4, name: 'astc' }, new Uint8Array(16), { flipY: false })), 'ULB_ERR_TEX_FORMAT_UNSUPPORTED');
  eq('码：纹理数据不足（BC1）', codeOfThrow(() => NS.dxt.decodeBc1(new Uint8Array(4), 4, 4)), 'ULB_ERR_TEX_DATA_SHORT');
  eq('码：纹理数据不足（ETC2）', codeOfThrow(() => NS.etc2.decodeEtc2Rgba8(new Uint8Array(4), 4, 4)), 'ULB_ERR_TEX_DATA_SHORT');
  // decodePng 是 async：必须 await 才能捕获 reject（否则断言恒为"没抛"）
  try {
    await NS.png.decodePng(new Uint8Array([1, 2, 3, 4]));
    eq('码：PNG 解码失败', 'no-throw', 'ULB_ERR_TEX_DECODE');
  } catch (e) {
    eq('码：PNG 解码失败', NS.errors.codeOf(e), 'ULB_ERR_TEX_DECODE');
  }
  eq('码：容器解析失败（非 UnityFS）', codeOfThrow(() => NS.unityfs.parse(new Uint8Array(16))), 'ULB_ERR_CONTAINER_PARSE');
  eq('码：读取越界（bytes）', codeOfThrow(() => new NS.bytes.Reader(new Uint8Array(2)).u32()), 'ULB_ERR_CONTAINER_PARSE');
}

// ---------------------------------------------------------------- 装载前预检（与 /api/bundle/probe 同一实现）
{
  const BP = NS.bundleProbe;
  eq('预检：空字节 → NO_FILE', BP.run(new Uint8Array(0)).code, 'ULB_ERR_NO_FILE');
  const notUnity = BP.run(new Uint8Array([0x52, 0x61, 0x72, 0x21, 1, 2, 3, 4]));
  eq('预检：非 UnityFS → NOT_UNITYFS', notUnity.code, 'ULB_ERR_NOT_UNITYFS');
  eq('预检：非 UnityFS 不抛异常，只回 ok:false', notUnity.ok, false);
  const etc2 = BP.formatSupport(47);
  eq('预检：格式 47 可解码', etc2.supported, true);
  eq('预检：格式 47 名称', etc2.formatName, 'ETC2_RGBA8');
  const astc = BP.formatSupport(50);
  eq('预检：格式 50（ASTC）标记为不可解码', astc.supported, false);
  eq('预检：格式 50 给出人类可读名（不是“未知格式”', astc.formatName, 'ASTC_RGBA');
}

// ---------------------------------------------------------------- Spine 动作分组/循环规则（能力层数据驱动）
{
  const { loadRules, classify, countHits } = await import('../../tool/lib/spine-motions.mjs');
  const rulesPath = new URL('../../tool/spine-motion-rules.json', import.meta.url);
  const rules = loadRules(rulesPath);
  eq('动作规则：加载并校验通过', rules.families.length > 0, true);
  eq('动作规则：每条族都有实测命中数（>0）', rules.families.every((f) => f.hits >= 1), true);
  eq('动作规则：每条族都写了依据', rules.families.every((f) => typeof f.note === 'string' && f.note.trim().length > 0), true);

  const idle = classify('idle', rules);
  eq('动作规则：idle → 分组', idle.group, 'idle');
  eq('动作规则：idle → 循环', idle.loop, true);
  eq('动作规则：idle → 高置信', idle.confidence, 'high');

  const face = classify('_face3_talk', rules);
  eq('动作规则：表情 → 分组', face.group, 'face');
  eq('动作规则：表情 → 一次性', face.loop, false);

  const blink = classify('zhayan', rules);
  eq('动作规则：override 精确名生效', blink.group, 'blink');

  const unknown = classify('B_soldier', rules);
  eq('动作规则：未知名 → 分组=动作名本身', unknown.group, 'B_soldier');
  eq('动作规则：未知名 → 默认不循环', unknown.loop, false);
  eq('动作规则：未知名 → 低置信', unknown.confidence, 'low');
  eq('动作规则：未知名 → 不标规则来源', unknown.rule, null);

  const hits = countHits(['idle', 'idle1', '_face0', 'loop'], rules);
  const idleHit = hits.find((h) => h.group === 'idle');
  eq('动作规则：命中统计可按名单复算', idleHit.actualHits, 2);
}

// ---------------------------------------------------------------- 汇总
console.log(`== 自检结果：${pass} 通过 / ${fail} 失败 ==`);
if (fail) {
  console.log('失败项：');
  for (const r of results.filter((x) => !x.ok)) console.log(`  · ${r.name} ${r.detail || ''}`);
}
process.exit(fail ? 1 : 0);
