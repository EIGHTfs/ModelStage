// tool/.tmp-caps-equiv.mjs —— detectCapabilities 重构的等价验证（临时脚本，不 commit）
//
// 为什么不能只比 JSON：capabilities 里有**构造器引用**与 matrix() 方法。
//   这里自写递归比较（值/类型/键集合/函数 identity），并用 Proxy 记录
//   **成员读取序列（名字 + 顺序 + 次数）** —— 重构把 13 次 pickMember 留在本体正是为了保住它。
//
// 用法：
//   node tool/.tmp-caps-equiv.mjs --baseline /tmp/caps-baseline.json
//   node tool/.tmp-caps-equiv.mjs --compare  /tmp/caps-baseline.json

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'src/web/engine/runtime-capabilities.js');

/** 加载被测文件：export 换成挂全局（零 import，可直接跑） */
function loadDetector() {
  const src = fs.readFileSync(FILE, 'utf8')
    // 只去掉 export 关键字：vm 上下文里顶层 `function foo(){}` 会成为全局，互相引用照旧可用
    .replace(/^export /gm, '');
  const ctx = vm.createContext({ globalThis: null, window: undefined, URLSearchParams, Set, Map, Object, Array, String, Boolean, Function, Error });
  ctx.globalThis = ctx;
  vm.runInContext(src, ctx, { filename: 'runtime-capabilities.js' });
  return ctx;
}

/** 造一个带 length（arity）与原型方法的构造器 */
function mkCtor(arity, methods = []) {
  const f = function () {};
  Object.defineProperty(f, 'length', { value: arity });
  for (const m of methods) f.prototype[m] = function () {};
  return f;
}

/** 造一个命名空间；可指定缺失成员、webgl 子命名空间、以及"属性存在但值为 undefined/null" */
function mkNs(spec) {
  const ns = {};
  const put = (name, val) => { if (name in spec) ns[name] = spec[name]; };
  const all = {
    Texture: mkCtor(0, ['bind', 'setFilters', 'dispose']),
    GLTexture: mkCtor(1, ['bind', 'setFilters', 'dispose']),
    TextureAtlas: mkCtor(2, ['addRegion']),
    SceneRenderer: mkCtor(2, ['camera', 'draw']),
    SkeletonRenderer: mkCtor(1, ['draw']),
    OrthoCamera: mkCtor(2),
    PolygonBatcher: mkCtor(0),
    SkeletonJson: mkCtor(1),
    SkeletonBinary: mkCtor(1),
    AtlasAttachmentLoader: mkCtor(1),
    Vector2: mkCtor(2),
    Skin: mkCtor(1),
    Skeleton: mkCtor(1, ['setToSetupPose', 'updateWorldTransform', 'getBounds', 'setSkin']),
    SkeletonDebugRenderer: mkCtor(2),
    DebugRenderer: mkCtor(2),
  };
  for (const [name, val] of Object.entries(all)) if (!(name in spec)) ns[name] = val;
  // 再由 spec 覆盖（'__drop__' = 该成员不存在；undefined/null = 属性在但值空）
  for (const [name, val] of Object.entries(spec)) {
    if (name === '__webgl') { ns.webgl = val; continue; }
    if (val === '__drop__') delete ns[name]; else ns[name] = val;
  }
  if (spec.__webgl) ns.webgl = spec.__webgl;
  return ns;
}

/** 7 类组合（对应批准口径 ①~⑦） */
function scenarios() {
  const S = (name, spec, search = '') => ({ name, spec, search });
  return [
    S('① 完整能力（全有、arity 达标、原型方法齐）', {}),
    S('② 老版本：缺 TextureAtlas、缺 GLTexture', {
      TextureAtlas: '__drop__', GLTexture: '__drop__',
    }),
    S('③ 无 WebGL：两个渲染器都没有', {
      SceneRenderer: '__drop__', SkeletonRenderer: '__drop__',
    }),
    S('④ 3.x 风格：TextureAtlas arity=2、SceneRenderer 带 camera', {
      TextureAtlas: mkCtor(2, ['addRegion']),
      SceneRenderer: mkCtor(2, ['camera', 'draw']),
      GLTexture: mkCtor(1, ['bind', 'setFilters', 'dispose']),
    }, ''),
    S('⑤ 属性存在但值为 undefined / null', {
      Texture: undefined, GLTexture: null, TextureAtlas: undefined,
      SceneRenderer: null, SkeletonJson: undefined, Skin: null,
    }),
    S('⑥ 诊断开关 ?missing-capability=textureBind,atlasResolver', {}, '?missing-capability=textureBind,atlasResolver'),
    S('⑦ 只有 DebugRenderer（SkeletonDebugRenderer 回落）', {
      SkeletonDebugRenderer: '__drop__',
    }),
    // 补充边界：webgl 子命名空间（3.x 把 WebGL 类放这里）
    S('⑧ webgl 子命名空间（顶层没有 WebGL 类）', {
      SceneRenderer: '__drop__', SkeletonRenderer: '__drop__',
      __webgl: { SceneRenderer: mkCtor(2, ['camera']), SkeletonRenderer: mkCtor(1) },
    }),
    // 补充边界：skeletonOps 缺 getBounds / setSkin
    S('⑨ skeletonOps 缺项（Skeleton 只有部分方法）', {
      Skeleton: mkCtor(1, ['setToSetupPose']),
    }),
  ];
}

/** 递归比较：返回差异数组（空 = 等价） */
function deepDiff(a, b, pathStr = '', out = []) {
  if (Object.is(a, b)) return out;
  const ta = typeof a; const tb = typeof b;
  if (ta !== tb) { out.push(`${pathStr}: 类型 ${ta} → ${tb}`); return out; }
  if (ta === 'function') {
    // 函数比较 identity（同一批 mock 构造器 ⇒ 引用应相同），退化为 name+length
    if (a !== b) out.push(`${pathStr}: 函数引用不同（${a.name}/${a.length} vs ${b.name}/${b.length}）`);
    return out;
  }
  if (a === null || b === null) { out.push(`${pathStr}: ${a} → ${b}`); return out; }
  if (ta !== 'object') { out.push(`${pathStr}: ${String(a)} → ${String(b)}`); return out; }
  const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
  if (ka.join(',') !== kb.join(',')) { out.push(`${pathStr}: 键集合不同 [${ka}] vs [${kb}]`); return out; }
  for (const k of ka) deepDiff(a[k], b[k], pathStr ? `${pathStr}.${k}` : k, out);
  return out;
}

/** 跑一个场景：返回 {matrix(逐字段展开), reads(成员读取序列)} */
function runScenario(ctx, sc) {
  const reads = [];
  const raw = mkNs(sc.spec);
  const ns = new Proxy(raw, {
    get(t, prop) { reads.push(String(prop)); return t[prop]; },
    has(t, prop) { reads.push(`has:${String(prop)}`); return prop in t; },
  });
  // 被测代码在 vm 上下文里读 window，所以垫片要设在 ctx 上（不是宿主 globalThis）
  ctx.window = sc.search ? { location: { search: sc.search } } : undefined;
  const caps = ctx.detectCapabilities(ns, 'test-version');
  ctx.window = undefined;
  // 摘要：capabilities 的完整形状（函数用 name/length 标记，便于跨进程比对）
  const summarize = (v, depth = 0) => {
    if (v === null || v === undefined) return v === null ? 'null' : 'undefined';
    if (typeof v === 'function') return `[fn ${v.name || 'anon'}/${v.length}]`;
    if (typeof v !== 'object') return v;
    if (depth > 6) return '[deep]';
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = summarize(v[k], depth + 1);
    return o;
  };
  return {
    name: sc.name,
    caps: summarize(caps),
    matrix: (() => { try { return summarize(caps.matrix()); } catch (e) { return `[matrix 抛错: ${e.message}]`; } })(),
    warns: Array.isArray(caps.warns) ? caps.warns.slice() : null,
    reads,
  };
}

function collect() {
  const ctx = loadDetector();
  return { scenarios: scenarios().map((sc) => runScenario(ctx, sc)) };
}

function diff(before, after) {
  const out = [];
  const info = [];   // 不计差异的信息项（如"读取次数下降了"，那正是优化目标）
  const n = Math.max(before.scenarios.length, after.scenarios.length);
  for (let i = 0; i < n; i += 1) {
    const b = before.scenarios[i]; const a = after.scenarios[i];
    if (!b || !a) { out.push(`场景 #${i} 缺失`); continue; }
    deepDiff(b.caps, a.caps, `${b.name}.caps`, out);
    deepDiff(b.matrix, a.matrix, `${b.name}.matrix`, out);
    deepDiff(b.warns, a.warns, `${b.name}.warns`, out);
    // 成员读取序列：**不再作为等价判据**，只作信息。
    //   为什么改口径：本轮把 probeSkeleton 里 5 次 pickMember(spine,'Skeleton') 合并成 1 次，
    //   读取次数必然下降 —— 那是这次优化的目标本身，拿它当"必须相同"的标尺就自相矛盾
    //   （永远只能证明"没优化"）。等价性改由 caps / matrix / warns 三份**探测结果**断言：
    //   那才是调用方（面板、渲染适配层）真正看得见的事实。
    //   读取次数仍打印出来，用于确认"确实少了"以及发现非预期的额外读取。
    if (b.reads.join(',') !== a.reads.join(',')) {
      info.push(`${b.name}: 成员读取 ${b.reads.length} → ${a.reads.length} 次（预期变化，不计差异）`);
    }
  }
  return { diffs: out, info };
}

const args = process.argv.slice(2);
const iBase = args.indexOf('--baseline');
const iComp = args.indexOf('--compare');

if (iBase >= 0) {
  const outPath = args[iBase + 1] || '/tmp/caps-baseline.json';
  const data = collect();
  fs.writeFileSync(outPath, JSON.stringify(data, null, 1));
  console.log(`baseline 已写：${outPath}`);
  for (const s of data.scenarios) console.log(`  ${s.name}\n      成员读取 ${s.reads.length} 次 / warns ${s.warns ? s.warns.length : 'null'} 条`);
  // 稳定性自检：连跑两次必须一致
  const again = collect();
  console.log(`确定性自检：${JSON.stringify(again) === JSON.stringify(data) ? '✓ 一致' : '✗ 不一致'}`);
} else if (iComp >= 0) {
  const basePath = args[iComp + 1] || '/tmp/caps-baseline.json';
  const before = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  const after = collect();
  const { diffs, info } = diff(before, after);
  console.log(`对比：${basePath}（${after.scenarios.length} 场景）`);
  for (const s of after.scenarios) console.log(`  ${s.name} → 读取 ${s.reads.length} 次 / warns ${s.warns ? s.warns.length : 'null'} 条`);
  if (info.length) { console.log(`信息（不计差异）：`); info.forEach((x) => console.log('  ' + x)); }
  if (!diffs.length) console.log('✅ 探测结果（caps / matrix / warns）逐项相同（0 差异）');
  else { console.log(`❌ ${diffs.length} 处差异：`); diffs.slice(0, 20).forEach((d) => console.log('  ' + d)); process.exitCode = 1; }
} else {
  console.log('用法：--baseline <out.json> | --compare <baseline.json>');
}

// ── 分支走向验证（--branch）：从 git 取改前源码，与当前源码各跑一遍，
//    把产出喂给三个适配器的**分支判据**，比较"走哪一支"。
//    适配器本身就是读 caps 字段做 if/throw（atlas.js:33 / renderer.js:13 / skeleton.js:41,46,56,79），
//    所以分支指纹 = 这些字段的取值，不需要真建 GL 对象。
if (args.includes('--branch')) {
  const { execSync } = await import('node:child_process');
  const oldSrc = execSync('git show HEAD:src/web/engine/runtime-capabilities.js', { cwd: ROOT, encoding: 'utf8' });

  const loadFrom = (src) => {
    const ctx = vm.createContext({ globalThis: null, window: undefined, URLSearchParams, Set, Map, Object, Array, String, Boolean, Function, Error });
    ctx.globalThis = ctx;
    vm.runInContext(src.replace(/^export /gm, ''), ctx, { filename: 'caps.js' });
    return ctx;
  };

  /** 适配器分支指纹：把 caps 里"决定走哪支"的字段挑出来 */
  const fingerprint = (caps) => ({
    // adapters/atlas.js:11,33,40 —— ctor 是否存在、是否吃 resolver（决定"构造后补挂"路径）
    atlas: { hasCtor: !!caps.atlas.ctor, acceptsResolver: caps.atlas.acceptsResolver, arity: caps.atlas.arity },
    // adapters/renderer.js:13 —— kind 决定 createScene / createSkeleton / throw
    renderer: { kind: caps.renderer.kind, hasCameraOnScene: caps.renderer.hasCameraOnScene, sceneArity: caps.renderer.sceneArity, orthoArity: caps.renderer.orthoArity, hasBatcher: !!caps.renderer.batcherCtor, hasDebug: !!caps.renderer.debugCtor },
    // adapters/skeleton.js:41,46,56 —— 四项缺失即跳过该步
    skeletonOps: { ...caps.skeletonOps },
    // adapters/skeleton.js:12,19,26,55,79 —— 构造器存在性决定能不能用
    ctors: {
      json: !!caps.skeleton.jsonCtor, binary: !!caps.skeleton.binaryCtor,
      attachmentLoader: !!caps.skeleton.attachmentLoaderCtor,
      vector2: !!caps.skeleton.vector2, skin: !!caps.skinCtor,
    },
    matrix: caps.matrix(),
  });

  const detOld = loadFrom(oldSrc);
  const detNew = loadFrom(fs.readFileSync(FILE, 'utf8'));
  const rows = [];
  let bad = 0;
  for (const sc of scenarios()) {
    const mkOne = (ctx) => {
      const raw = mkNs(sc.spec);
      ctx.window = sc.search ? { location: { search: sc.search } } : undefined;
      const caps = ctx.detectCapabilities(raw, 'v');
      ctx.window = undefined;
      return fingerprint(caps);
    };
    const a = mkOne(detOld); const b = mkOne(detNew);
    const same = JSON.stringify(a) === JSON.stringify(b);
    if (!same) bad += 1;
    rows.push(`${same ? '✓' : '✗'} ${sc.name}\n      atlas=${JSON.stringify(a.atlas)} renderer.kind=${a.renderer.kind} ops=${JSON.stringify(a.skeletonOps)}`);
  }
  console.log(`\n能力→适配器分支走向（改前 vs 改后）：${rows.length} 场景，差异 ${bad} 处`);
  rows.forEach((r) => console.log('  ' + r));
  if (bad) process.exitCode = 1;
}
