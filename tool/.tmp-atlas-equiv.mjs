// tool/.tmp-atlas-equiv.mjs —— prepareAtlas 拆分（A10）的等价验证（临时脚本，不 commit）
//
// 为什么不能用"跑通不报错"当证明：prepareAtlas 的产物是**给渲染器的 descriptor**，
//   结构错了不会抛错，只会画面不对（页序错 → 串页；placeholder 次数变 → 多/少一个 GPU 纹理）。
//
// 两样东西同时记录并逐项比对：
//   A. descriptor：**逐字段**取出来（不是 JSON.stringify 后比文本 —— 键序不同会误报）
//   B. 调用序列：所有副作用按调用顺序追加（解码 / 取样 / 上传 / placeholder / 日志）
//   另单独记：makePlaceholderTexture 次数、resolvePage 被调次数（经 TextureAtlas 桩间接统计）、
//             atlas.pages 的**数组顺序**与每页 texture 是否非空
//
// 下游模块用**真实现**（pma.js 的四个判定 + textures.js 的 parseAtlasPageSizes 都是纯函数，
//   实测可直接在 node 里 import），只把真正有副作用的换桩（解码 / 取样 / 上传 / placeholder / 日志 / canvas）。
//   这样 PMA 判定链与 atlas 解析跑的是真代码，等价性才有意义。
//
// 用法：
//   node tool/.tmp-atlas-equiv.mjs --baseline /tmp/atlas-baseline.json
//   node tool/.tmp-atlas-equiv.mjs --compare  /tmp/atlas-baseline.json

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'src/web/engine/pipeline.js');

// 下游真实现（只取纯函数；有副作用的下面换桩）
const pma = await import('../src/web/engine/pma.js');
const textures = await import('../src/web/engine/textures.js');
const caps = await import('../src/web/engine/runtime-capabilities.js');

/**
 * 从源码加载 prepareAtlas。
 * 做法与 tool/.tmp-switch-equiv.mjs 一致：把 import 整段删掉，改为从 globalThis.__deps 解构，
 *   再把 export 换成挂到 globalThis —— 不改源文件、不需要 ESM loader 钩子。
 */
function loadPrepareAtlas(deps) {
  const src = fs.readFileSync(FILE, 'utf8')
    .replace(/^import \{[\s\S]*?\} from '[^']+';$/gm, '')
    .replace(/export async function prepareAtlas\s*\(/, 'globalThis.__prepareAtlas = async function prepareAtlas(');
  const sandbox = { __deps: deps, TextDecoder, Map, Set, Array, Object, Math, String, Number, Error, Promise, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInNewContext(src, sandbox, { filename: 'pipeline.js' });
  if (typeof sandbox.__prepareAtlas !== 'function') throw new Error('未能从 pipeline.js 取出 prepareAtlas');
  // pipeline.js 的 import 是具名的，删掉后需要逐个补回：这里按源码实际用的名字给齐
  return sandbox.__prepareAtlas;
}

// pipeline.js 用到的全部依赖名（删掉 import 后必须都能从 __deps 解构到）
const DEP_NAMES = [
  'SMALL_PAGE_PX', 'parseAtlasPageSizes', 'decodeImageSource', 'sampleSourceImageData',
  'uploadTextures', 'makePlaceholderTexture',
  'atlasDeclaredPma', 'filenamePmaHint', 'detectPma', 'resolvePmaInfo',
  'pickMember', 'createLogger',
];

/**
 * 真实 pipeline.js 里 import 被删后，源码里的自由变量会去 globalThis 找。
 * 所以要把依赖逐个装到沙箱 globalThis 上（而不是只放 __deps）。
 */
function loadPrepareAtlasWithGlobals(deps) {
  const src = fs.readFileSync(FILE, 'utf8')
    .replace(/^import \{[\s\S]*?\} from '[^']+';$/gm, '')
    .replace(/export async function prepareAtlas\s*\(/, 'globalThis.__prepareAtlas = async function prepareAtlas(');
  const sandbox = { TextDecoder, Map, Set, Array, Object, Math, String, Number, Error, Promise, console };
  for (const name of DEP_NAMES) sandbox[name] = deps[name];
  sandbox.document = deps.document;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInNewContext(src, sandbox, { filename: 'pipeline.js' });
  if (typeof sandbox.__prepareAtlas !== 'function') throw new Error('未能从 pipeline.js 取出 prepareAtlas');
  return sandbox.__prepareAtlas;
}

// ---------------------------------------------------------------- 桩

/** canvas 桩：transparentEntry 需要 document.createElement('canvas') 并设 width/height */
function makeDocumentStub(rec) {
  return {
    createElement(tag) {
      rec('createElement', tag);
      return { tagName: String(tag).toUpperCase(), width: 0, height: 0 };
    },
  };
}

/**
 * 构造一套桩 + 记录器。
 * @param {{sizes?: object, samples?: object, texturesMode?: 'v3'|'v4', noTextureAtlas?: boolean}} opts
 *   sizes: 文件名 → {width,height}（模拟解码结果）
 *   samples: 文件名 → imageData 或 null（模拟取样结果）
 *   texturesMode: v3 = 构造时用 resolver 设 texture；v4 = 构造后靠 page.setTexture
 */
function makeDeps(opts, rec) {
  const sizes = opts.sizes || {};
  const samples = opts.samples || {};
  let placeholderCount = 0;
  let resolverCalls = 0;

  const deps = {
    // —— 真实现（纯函数）——
    SMALL_PAGE_PX: textures.SMALL_PAGE_PX,
    parseAtlasPageSizes: textures.parseAtlasPageSizes,
    atlasDeclaredPma: pma.atlasDeclaredPma,
    filenamePmaHint: pma.filenamePmaHint,
    detectPma: (...args) => {
      rec('detectPma');
      return pma.detectPma(...args);
    },
    resolvePmaInfo: (...args) => {
      rec('resolvePmaInfo');
      return pma.resolvePmaInfo(...args);
    },
    pickMember: (obj, name) => {
      rec('pickMember', name);
      return caps.pickMember(obj, name);
    },

    // —— 桩（副作用）——
    decodeImageSource: async (file) => {
      rec('decodeImageSource', file.name);
      if (opts.decodeFails === file.name) throw new Error(`decode 失败：${file.name}`);
      const s = sizes[file.name] || { width: 2048, height: 2048 };
      return { img: { __img: file.name }, width: s.width, height: s.height };
    },
    sampleSourceImageData: (entry) => {
      rec('sampleSourceImageData', entry.name);
      const s = samples[entry.name];
      if (s === undefined) return null;
      return s;
    },
    uploadTextures: async ({ entries }) => {
      rec('uploadTextures', `${entries.size}页`);
      const out = new Map();
      for (const [pageName] of entries) out.set(pageName, { __tex: pageName });
      return out;
    },
    makePlaceholderTexture: () => {
      placeholderCount += 1;
      rec('makePlaceholderTexture');
      return { __placeholder: true, n: placeholderCount };
    },
    // 真实 createLogger 返回的是**带 debug/info/warn/error 方法的对象**（不是函数）。
    //   注意两种日志形态的签名不同：pmaLog.debug(msg, detail) 两参；ctx.log(level, msg, scope) 三参。
    //   detail 的键集合也记下来 —— 字段漏了/多了/改名了都要能看出来。
    createLogger: (scope) => {
      const at = (level) => (msg, detail) => {
        const detailKeys = detail && typeof detail === 'object' ? Object.keys(detail).sort().join(',') : '';
        rec('log', `${scope}:${level}:${String(msg).slice(0, 24)}${detailKeys ? '|' + detailKeys : ''}`);
      };
      return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
    },
  };
  deps.document = makeDocumentStub(rec);

  /** TextureAtlas 桩：两种运行时行为 */
  function makeSpine(noTextureAtlas) {
    const spine = { GLTexture: function GLTexture() {} };
    if (noTextureAtlas) return spine;
    spine.TextureAtlas = function TextureAtlas(atlasText, resolvePage) {
      rec('new TextureAtlas');
      const pageNames = [...textures.parseAtlasPageSizes(atlasText).keys()];
      this.pages = pageNames.map((name) => ({ name, texture: null }));
      if (opts.texturesMode !== 'v4') {
        // 3.x：构造时就用 resolver 填好
        for (const page of this.pages) {
          resolverCalls += 1;
          page.texture = resolvePage(page.name);
        }
      }
    };
    if (opts.texturesMode === 'v4') {
      // 4.x 的页对象带 setTexture
      const origCtor = spine.TextureAtlas;
      spine.TextureAtlas = function TextureAtlasV4(atlasText, resolvePage) {
        origCtor.call(this, atlasText, resolvePage);
        this.pages = this.pages.map((p) => ({
          name: p.name,
          texture: p.texture,
          setTexture(t) { rec('page.setTexture', p.name); this.texture = t; },
        }));
      };
    }
    return spine;
  }
  return { deps, makeSpine, stats: () => ({ placeholderCount, resolverCalls }) };
}

// ---------------------------------------------------------------- 场景

const SMALL = textures.SMALL_PAGE_PX; // 小页阈值

/** 造一个 imageData 形态的取样结果 */
const imageData = (seed) => ({ data: new Uint8ClampedArray([seed, seed, seed, 255, seed, seed, seed, 255]), width: 2, height: 1 });

/** 由页名列表拼 atlas 文本 */
function atlasTextOf(pages, extra = {}) {
  const lines = [];
  if (extra.pma !== undefined) lines.push(`pma: ${extra.pma}`);
  for (const p of pages) {
    lines.push(`${p.name}`);
    lines.push(`size: ${p.width},${p.height}`);
    lines.push('format: RGBA8888');
    lines.push('filter: Linear,Linear');
    if (p.rotate) lines.push('rotate: 90');
    if (p.xy) lines.push(`orig: ${p.width},${p.height}`, `offset: 0,0`, `xy: ${p.xy}`);
    lines.push('');
  }
  return lines.join('\n');
}

const descriptorOf = (pages, files) => ({
  id: 'test-model',
  rel: 'test/rel',
  name: 'test',
  atlasFile: { name: 'model.atlas', content: new TextEncoder().encode(atlasTextOf(pages)) },
  textureFiles: files.map((f) => ({ name: f })),
});

/**
 * 全部场景。每个场景返回 { name, result | error, seq, counts }。
 * 覆盖 lead 要求的五类：单页 / 多页 / 非 2 次幂 / 翻转旋转页 / 缺页降级，
 * 外加：小页跳过、PMA 四档 × 探测结论、运行时 v3/v4、四条错误路径。
 */
const SCENARIOS = [
  // ① 单页
  {
    name: '单页·auto·无pma声明·2048',
    pages: [{ name: 'page_00.png', width: 2048, height: 2048 }],
    files: ['page_00.png'],
    opts: { samples: { 'page_00.png': imageData(200) } },
    ctx: { pmaMode: 'auto' },
  },
  // ② 多页（页序即 atlas 声明序）
  {
    name: '多页·auto·两页同序',
    pages: [{ name: 'tex_00.png', width: 1024, height: 1024 }, { name: 'tex_01.png', width: 512, height: 512 }],
    files: ['tex_00.png', 'tex_01.png'],
    opts: { samples: { 'tex_00.png': imageData(128) } },
    ctx: { pmaMode: 'auto' },
  },
  // ③ 多页 + textureFiles 顺序与 atlas 页序相反（页序错的典型）
  {
    name: '多页·files顺序与atlas相反',
    pages: [{ name: 'aaa.png', width: 256, height: 256 }, { name: 'zzz.png', width: 256, height: 256 }],
    files: ['zzz.png', 'aaa.png'],
    opts: {},
    ctx: { pmaMode: 'premultiplied' },
  },
  // ④ 非 2 次幂
  {
    name: '非2次幂·1023x767',
    pages: [{ name: 'odd.png', width: 1023, height: 767 }],
    files: ['odd.png'],
    opts: { sizes: { 'odd.png': { width: 1023, height: 767 } }, samples: { 'odd.png': imageData(90) } },
    ctx: { pmaMode: 'auto' },
  },
  // ⑤ 带旋转与 xy 的页
  {
    name: '旋转页·rotate90+xy',
    pages: [{ name: 'rot.png', width: 512, height: 256, rotate: true, xy: '100,200' }],
    files: ['rot.png'],
    opts: { sizes: { 'rot.png': { width: 512, height: 256 } } },
    ctx: { pmaMode: 'straight' },
  },
  // ⑥ 缺页降级（atlas 声明两页，只给一页纹理）
  {
    name: '缺页·atlas两页只给一页',
    pages: [{ name: 'have.png', width: 512, height: 512 }, { name: 'missing.png', width: 512, height: 512 }],
    files: ['have.png'],
    opts: { sizes: { 'have.png': { width: 512, height: 512 } } },
    ctx: { pmaMode: 'premultiplied' },
  },
  // ⑦ 缺页 × v4（补页循环走 page.setTexture 分支）
  {
    name: '缺页·v4补页',
    pages: [{ name: 'a.png', width: 512, height: 512 }, { name: 'b.png', width: 512, height: 512 }],
    files: ['a.png'],
    opts: { sizes: { 'a.png': { width: 512, height: 512 } }, texturesMode: 'v4' },
    ctx: { pmaMode: 'premultiplied' },
  },
  // ⑧ 小页跳过（多页里一页 < SMALL_PAGE_PX）
  {
    name: `多页·小页跳过(${SMALL - 1}px)`,
    pages: [{ name: 'big.png', width: 1024, height: 1024 }, { name: 'tiny.png', width: SMALL - 1, height: SMALL - 1 }],
    files: ['big.png', 'tiny.png'],
    opts: {
      sizes: { 'big.png': { width: 1024, height: 1024 }, 'tiny.png': { width: SMALL - 1, height: SMALL - 1 } },
      samples: { 'big.png': imageData(64) },
    },
    ctx: { pmaMode: 'auto' },
  },
  // ⑨ 单页但解码结果是小页（单页不走小页跳过分支 —— multiPage=false）
  {
    name: '单页·解码为小尺寸(不跳过)',
    pages: [{ name: 'solo.png', width: SMALL - 1, height: SMALL - 1 }],
    files: ['solo.png'],
    opts: { sizes: { 'solo.png': { width: SMALL - 1, height: SMALL - 1 } }, samples: { 'solo.png': imageData(32) } },
    ctx: { pmaMode: 'auto' },
  },
  // ⑩ PMA：atlas 声明 true + 无像素 + filename 无线索
  {
    name: 'PMA·atlas声明true·无像素',
    pages: [{ name: 'p.png', width: 512, height: 512 }],
    files: ['p.png'],
    opts: { sizes: { 'p.png': { width: 512, height: 512 } } },
    ctx: { pmaMode: 'auto' },
    atlasExtra: { pma: true },
  },
  // ⑪ PMA：atlas 声明 false + 像素证明已预乘（冲突 → 以像素为准 + warn）
  {
    name: 'PMA·声明false但像素已预乘(冲突)',
    pages: [{ name: 'p.png', width: 512, height: 512 }],
    files: ['p.png'],
    opts: { sizes: { 'p.png': { width: 512, height: 512 } }, samples: { 'p.png': imageData(255) } },
    ctx: { pmaMode: 'auto' },
    atlasExtra: { pma: false },
  },
  // ⑫ PMA：straight 档 + 运行时不支持直通（降级 → warn）
  {
    name: 'PMA·straight档+不支持直通(降级)',
    pages: [{ name: 'p.png', width: 512, height: 512 }],
    files: ['p.png'],
    opts: { sizes: { 'p.png': { width: 512, height: 512 } } },
    ctx: { pmaMode: 'straight', supportsStraight: false },
  },
  // ⑬ PMA：upload 档
  {
    name: 'PMA·upload档',
    pages: [{ name: 'p.png', width: 512, height: 512 }],
    files: ['p.png'],
    opts: { sizes: { 'p.png': { width: 512, height: 512 } } },
    ctx: { pmaMode: 'upload' },
  },
  // ⑭ PMA：filename 线索 -pma
  {
    name: 'PMA·文件名线索-pma',
    pages: [{ name: 'hero-pma.png', width: 512, height: 512 }],
    files: ['hero-pma.png'],
    opts: { sizes: { 'hero-pma.png': { width: 512, height: 512 } } },
    ctx: { pmaMode: 'auto' },
  },
  // ⑮ 错误：atlas 空
  {
    name: '错误·atlas为空',
    pages: [],
    files: ['x.png'],
    opts: {},
    ctx: {},
    emptyAtlas: true,
  },
  // ⑯ 错误：所有页解码失败
  {
    name: '错误·全部解码失败',
    pages: [{ name: 'f.png', width: 512, height: 512 }],
    files: ['f.png'],
    opts: { decodeFails: 'f.png' },
    ctx: {},
  },
  // ⑰ 错误：没有 TextureAtlas
  {
    name: '错误·运行时无TextureAtlas',
    pages: [{ name: 'p.png', width: 512, height: 512 }],
    files: ['p.png'],
    opts: { sizes: { 'p.png': { width: 512, height: 512 } }, noTextureAtlas: true },
    ctx: {},
  },
];

/** 跑一个场景，返回可比对的结构 */
async function runScenario(sc) {
  const seq = [];
  const rec = (name, arg) => seq.push(arg === undefined ? name : `${name}(${arg})`);
  const built = makeDeps(sc.opts || {}, rec);
  const prepareAtlas = loadPrepareAtlasWithGlobals(built.deps);
  const spine = built.makeSpine(sc.opts && sc.opts.noTextureAtlas);

  const descriptor = descriptorOf(sc.pages, sc.files, sc.atlasExtra);
  if (sc.emptyAtlas) descriptor.atlasFile.content = new Uint8Array(0);

  const ctx = {
    spine,
    gl: { __gl: true },
    descriptor,
    pmaMode: sc.ctx.pmaMode === undefined ? 'auto' : sc.ctx.pmaMode,
    textureFilter: sc.ctx.textureFilter || 'linear',
    supportsStraight: sc.ctx.supportsStraight !== false,
    log: (level, msg) => rec('log', `ctx:${level}:${String(msg).slice(0, 24)}`),
  };

  const out = { name: sc.name };
  try {
    const r = await prepareAtlas(ctx);
    // —— descriptor 逐字段取出（不 JSON.stringify：键序不同会误报）——
    out.result = {
      atlasText: r.atlasText,
      entries: [...r.entries].map(([k, v]) => ({
        key: k, name: v.name, width: v.width, height: v.height,
        transparent: v.transparent, imgIsNull: v.img === null, hasCanvas: !!v.canvas,
      })),
      textures: (r.textures || []).map((t) => (t && t.__tex) || String(t && t.n)),   // 顺序有意义
      pmaInfo: {
        effectiveMode: r.pmaInfo.effectiveMode,
        needPremultiply: r.pmaInfo.needPremultiply,
        blendMode: r.pmaInfo.blendMode,
        runtimeSupportsStraight: r.pmaInfo.runtimeSupportsStraight,
        degraded: r.pmaInfo.degraded,
        keys: Object.keys(r.pmaInfo).sort(),
      },
      pmaDetection: {
        atlasDeclared: r.pmaDetection.atlasDeclared,
        filenameHint: r.pmaDetection.filenameHint,
        pixelDetected: r.pmaDetection.pixelDetected,
        finalIsPremultiplied: r.pmaDetection.finalIsPremultiplied,
        reason: r.pmaDetection.reason,
        keys: Object.keys(r.pmaDetection).sort(),
      },
      resultKeys: Object.keys(r).sort(),
      // atlas.pages 的**数组顺序** + 每页 texture 是否非空（lead 明确要求单独比）
      atlasPages: (r.atlas.pages || []).map((p) => ({
        name: p.name,
        textureNotNull: !!p.texture,
        texTag: p.texture ? (p.texture.__tex || String(p.texture.n) || 'obj') : null,
      })),
    };
  } catch (e) {
    out.error = String(e && e.message ? e.message : e);
  }
  out.seq = seq;
  out.counts = built.stats();
  return out;
}

// ---------------------------------------------------------------- 深比较

/**
 * 逐字段深比较（不用 JSON.stringify：键序不同会误报）。
 * @returns {string|null} 第一处差异路径；null = 相同
 */
function deepDiff(a, b, pathStr = '') {
  if (a === b) return null;
  if (typeof a !== typeof b) return `${pathStr}: 类型不同 (${typeof a} vs ${typeof b})`;
  if (a === null || b === null) return `${pathStr}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (typeof a !== 'object') return `${pathStr}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${pathStr}: 数组/对象不同型`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${pathStr}: 长度 ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i += 1) {
      const d = deepDiff(a[i], b[i], `${pathStr}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join(',') !== kb.join(',')) return `${pathStr}: 键集合不同 [${ka}] vs [${kb}]`;
  for (const k of ka) {
    const d = deepDiff(a[k], b[k], pathStr ? `${pathStr}.${k}` : k);
    if (d) return d;
  }
  return null;
}

// ---------------------------------------------------------------- 主流程

async function collectAll() {
  const out = [];
  for (const sc of SCENARIOS) out.push(await runScenario(sc));
  return out;
}

const argv = process.argv.slice(2);
const mode = argv[0];
const target = argv[1];

if (mode === '--baseline') {
  const data = { generatedAt: new Date().toISOString(), file: 'src/web/engine/pipeline.js', scenarios: await collectAll() };
  fs.writeFileSync(target, JSON.stringify(data, null, 2));
  const n = data.scenarios.length;
  const errs = data.scenarios.filter((s) => s.error).length;
  console.log(`baseline 已写入 ${target}：${n} 个场景（其中 ${errs} 个走错误路径）`);
  for (const s of data.scenarios) {
    console.log(`  · ${s.name} → ${s.error ? 'ERR: ' + s.error.slice(0, 40) : `pages=${s.result.atlasPages.length} placeholder=${s.counts.placeholderCount} resolver=${s.counts.resolverCalls} seq=${s.seq.length}`}`);
  }
} else if (mode === '--compare') {
  const base = JSON.parse(fs.readFileSync(target, 'utf8'));
  const now = { scenarios: await collectAll() };
  let bad = 0;
  for (let i = 0; i < base.scenarios.length; i += 1) {
    const b = base.scenarios[i];
    const n = now.scenarios[i];
    const diffs = [];
    const d1 = deepDiff(b.result, n.result, 'result');
    if (d1) diffs.push(d1);
    const d2 = deepDiff(b.error, n.error, 'error');
    if (d2) diffs.push(d2);
    const d3 = deepDiff(b.seq, n.seq, 'seq');
    if (d3) diffs.push(d3);
    const d4 = deepDiff(b.counts, n.counts, 'counts');
    if (d4) diffs.push(d4);
    if (diffs.length) {
      bad += 1;
      console.log(`❌ ${b.name}`);
      for (const d of diffs) console.log(`     ${d}`);
    } else {
      console.log(`✅ ${b.name}`);
    }
  }
  console.log(`\n=== ${base.scenarios.length - bad} 相同 / ${bad} 不同 ===`);
  process.exit(bad ? 1 : 0);
} else {
  console.log('用法：--baseline <out.json> | --compare <baseline.json>');
  process.exit(2);
}
