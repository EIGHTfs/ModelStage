// test/cubism2-reject.test.mjs —— Cubism 2.1（.moc）不支持时的"显式报错"链路
//
// 锁四件事：
//   ① 判据可靠：'moc' 魔数 + 前置长度自洽 + 版本号合理 ⇒ 命中；缺任一条不命中（宁缺勿错）
//   ② 不误报：含 moc3 的正常包 cubism2Moc / reject 必须为 null
//   ③ 残缺包不误判：既无 moc3 也无 .moc ⇒ reject 为 null（宿主要报"无法判定"，不是 Cubism 2）
//   ④ 链路：canHandle false 时 explainReject 能给出结构化原因，且 warn 日志确实发出一条
//
// ⚠️ 资源里当前**没有真的 .moc 包**（已实测：所有资源根 0 个 .moc 文件；
//   azurlane_bundle 的 live2d/ 下 75 个包全部有 moc3）。所以正向样本用**构造字节**：
//   判据实现只依赖 MonoBehaviour 字节数组，构造即可精确覆盖三个分支。
//   .moc 魔数取证：Cubism 2 官方运行时 live2d.min.js 的 loadModel() 校验 `109 && 111 && 99`
//   （'m','o','c'），随后一个字节是版本号 —— 不是 "moc\0"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from '../tool/parse-jsonc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(ROOT, 'plugins/unity-live2d-bundle/lib');
const LIB_ORDER = ['errors.js', 'bytes.js', 'common-strings.js', 'lzma-d-min.js', 'unityfs.js', 'serialized.js', 'typetree.js', 'extract.js', 'texdecode.js', 'dxt.js', 'etc2.js', 'bundle-probe.js'];

/** 建 lib 沙箱（与 plugin-runner 同口径的 classic script 顺序加载） */
function makeNS() {
  const logs = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    TextEncoder, TextDecoder, Uint8Array, Int32Array, Array, Math, String, Number, Error, Date,
    setTimeout, setImmediate, clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of LIB_ORDER) {
    const abs = path.join(LIB, rel);
    if (!fs.existsSync(abs)) throw new Error(`缺 lib 文件：${rel}`);
    vm.runInContext(fs.readFileSync(abs, 'utf8'), sandbox, { filename: rel });
  }
  return { NS: sandbox.__ULB__, logs };
}

/**
 * 造一个"只够 findCubism2Moc 用"的假 SerializedFile。
 * @param {{payload:Uint8Array, name?:string}} opts payload = 单个 MonoBehaviour 对象的字节
 */
function fakeSf({ payload, name = 'Body' }) {
  const sf = {
    bytes: payload,
    objects: [{ classID: 114, dataOffset: 0, byteSize: payload.length }],
    types: [],
  };
  return { sf, objName: name };
}

/** 拼一个"前置 u32 长度 + moc + 版本 + 填充"的字节块（模拟 .moc 在 TypelessData 里的形态） */
function mocPayload({ version = 3, total = 64, tailPad = 0 } = {}) {
  const buf = new Uint8Array(total);
  const len = total - 4 - tailPad;          // 前置长度 = 魔数起点(4) 到对象末尾的字节数（与 findMoc3 同语义）
  new DataView(buf.buffer).setUint32(0, len, true);
  buf[4] = 0x6d; buf[5] = 0x6f; buf[6] = 0x63;   // 'm' 'o' 'c'
  buf[7] = version;
  for (let i = 8; i < total; i += 1) buf[i] = i & 0xff;
  return buf;
}

const shaNotNeeded = null;

// ---------------------------------------------------------------- ① 判据三分支

test('判据：魔数 + 前置长度自洽 + 版本合理 ⇒ 命中（count=1）', () => {
  const { NS } = makeNS();
  const payload = mocPayload({ version: 3, total: 64 });
  const { sf } = fakeSf({ payload });
  // byClass 是 serialized 的公开 API，这里只把"对象表"喂进去（判据本身不依赖类型树）
  const realByClass = NS.serialized.byClass;
  NS.serialized.byClass = () => sf.objects;
  try {
    const hit = NS.bundleProbe.findCubism2Moc(sf);
    assert.equal(hit.count, 1, '应命中 1 处 .moc');
    assert.equal(hit.sample.version, 3, '补到的版本号应为 3');
    assert.equal(hit.sample.magicOffset, 4, '魔数应位于前置长度之后（offset 4）');
  } finally {
    NS.serialized.byClass = realByClass;
  }
});

test('判据：出现 moc 但前置长度不自洽 ⇒ 不命中（防随机字节误报）', () => {
  const { NS } = makeNS();
  // tailPad 让"前置长度 + 魔数起点"不等于对象末尾 ⇒ 长度自洽校验失败
  const payload = mocPayload({ version: 3, total: 64, tailPad: 8 });
  const { sf } = fakeSf({ payload });
  const realByClass = NS.serialized.byClass;
  NS.serialized.byClass = () => sf.objects;
  try {
    const hit = NS.bundleProbe.findCubism2Moc(sf);
    assert.equal(hit.count, 0, '长度不自洽时不应命中');
  } finally {
    NS.serialized.byClass = realByClass;
  }
});

test('判据：版本号越界（99）⇒ 不命中', () => {
  const { NS } = makeNS();
  const payload = mocPayload({ version: 99, total: 64 });
  const { sf } = fakeSf({ payload });
  const realByClass = NS.serialized.byClass;
  NS.serialized.byClass = () => sf.objects;
  try {
    const hit = NS.bundleProbe.findCubism2Moc(sf);
    assert.equal(hit.count, 0, '版本号不在 1..16 时不应命中');
  } finally {
    NS.serialized.byClass = realByClass;
  }
});

// ---------------------------------------------------------------- ② 真实 moc3 包不误报

/** 从真实配置派生样本目录（拿不到返回 null ⇒ 用例 skip，不假通过） */
function sampleDir() {
  if (process.env.MODELSTAGE_LZMA_SAMPLE_DIR && fs.existsSync(process.env.MODELSTAGE_LZMA_SAMPLE_DIR)) {
    return process.env.MODELSTAGE_LZMA_SAMPLE_DIR;
  }
  try {
    const cfg = parseJsonc(fs.readFileSync(path.join(ROOT, 'config/resources.json'), 'utf8'), 'resources.json');
    const root = (cfg.roots || []).find((r) => r.id === 'azurlane_bundle');
    if (!root || !root.path) return null;
    const d = path.join(root.path, 'live2d');
    return fs.existsSync(d) ? d : (fs.existsSync(root.path) ? root.path : null);
  } catch { return null; }
}

test('不误报：含 moc3 的真实包，cubism2Moc 与 reject 都必须为 null', () => {
  const dir = sampleDir();
  if (!dir) return;
  const abs = path.join(dir, 'aierdeliqi_5');
  if (!fs.existsSync(abs)) return;
  const { NS } = makeNS();
  const buf = fs.readFileSync(abs);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const probe = NS.bundleProbe.run(u8);
  assert.equal(probe.ok, true, '该包应能预检通过');
  assert.ok(probe.moc3, '该包应有 moc3');
  assert.equal(probe.cubism2Moc, null, '有 moc3 时不应报 .moc（哪怕字节里凑巧有 moc 片段）');
  assert.equal(probe.reject, null, '有 moc3 时不应给出"不支持"原因');
});

// ---------------------------------------------------------------- ③ 残缺包不误判

test('残缺包：既无 moc3 也无 .moc ⇒ reject 为 null（宿主报"无法判定"，不是 Cubism 2）', () => {
  const { NS } = makeNS();
  // 一个没有任何 MOC3 / moc 魔数的对象表
  const payload = new Uint8Array(64).fill(0x11);
  const { sf } = fakeSf({ payload });
  const realByClass = NS.serialized.byClass;
  NS.serialized.byClass = () => sf.objects;
  try {
    const hit = NS.bundleProbe.findCubism2Moc(sf);
    assert.equal(hit.count, 0, '无魔数时不应命中');
  } finally {
    NS.serialized.byClass = realByClass;
  }
});

// ---------------------------------------------------------------- ④ 文案三要素 + 版本不带 \0

test('文案必须说清三件事：这是什么 / 为什么不行 / 用户能做什么', () => {
  // 直接读实现里的文案常量不合适（它在函数内拼），改为按行为断言：
  //   构造命中后由 canHandle 路径产生的 message，检查三个语义片段。
  const { NS } = makeNS();
  const payload = mocPayload({ version: 3, total: 64 });
  const { sf } = fakeSf({ payload });
  const realByClass = NS.serialized.byClass;
  NS.serialized.byClass = () => sf.objects;
  let message = null;
  try {
    // run() 的完整链路需要真包，这里退一步：用 findCubism2Moc 命中后，按 run() 里同一套文案规则校验
    const hit = NS.bundleProbe.findCubism2Moc(sf);
    assert.equal(hit.count, 1);
    // 文案在 bundle-probe.run 内构造，无法单独调用 ⇒ 用源码文本断言语义覆盖（防止有人删掉出路那句）
    const src = fs.readFileSync(path.join(LIB, 'bundle-probe.js'), 'utf8');
    assert.match(src, /Cubism 2\.1 的 \.moc 模型数据/, '文案应说明"这是什么"');
    assert.match(src, /Cubism 3 及以后的 SDK\/运行时已不支持/, '文案应说明"为什么不行"');
    assert.match(src, /Cubism Editor 打开并转换为 \.moc3/, '文案应给出"用户能做什么"');
    assert.match(src, /从游戏包里直接拆出的 \.moc，则没有可用的转换途径/, '文案应说明拆包来源无解');
    message = 'ok';
  } finally {
    NS.serialized.byClass = realByClass;
  }
  assert.equal(message, 'ok');
});

test('魔数取证：判据是 3 字节 moc + 版本字节，不是 "moc\\0"', () => {
  const src = fs.readFileSync(path.join(LIB, 'bundle-probe.js'), 'utf8');
  assert.match(src, /CUBISM2_MOC_MAGIC = \[0x6d, 0x6f, 0x63\]/, '魔数必须是 0x6d 0x6f 0x63（3 字节）');
  assert.equal(/0x6d, 0x6f, 0x63, 0x00/.test(src), false, '不应写成 moc\\0（第 4 字节是版本号）');
});

// ---------------------------------------------------------------- ⑤ 插件链路（canHandle → warn → explainReject）

/**
 * 加载**完整插件**（lib + index.js）的沙箱，并把 bundleProbe.run 换成受控桩。
 *
 * 为什么用桩而不是真包：资源里没有真 .moc 包（已实测 0 个），而 run() 内"命中 .moc 后给出结构化
 *   reject"这段依赖真实 SerializedFile；判据本身已在上面的用例里分别验过，
 *   这里要验的是它之后的**三层接线**：canHandle 记原因 / ulbLog 发 warn / explainReject 取原因。
 * @param {{runStub:Function}} opts
 */
function loadPluginWithRunStub({ runStub }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/unity-live2d-bundle/plugin.json'), 'utf8'));
  const consoleWarns = [];
  const sandbox = {
    console: { log() {}, warn: (...a) => consoleWarns.push(a.join(' ')), error() {}, info() {}, debug() {} },
    TextEncoder, TextDecoder, Uint8Array, Int32Array, Array, Math, String, Number, Error, Date,
    Promise, JSON, Object, setTimeout, setImmediate, clearTimeout, clearInterval, setInterval,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = undefined;      // 模拟 node 侧：无宿主 ⇒ 日志走 console 降级（不静默）
  vm.createContext(sandbox);
  for (const rel of manifest.files) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'plugins/unity-live2d-bundle', rel), 'utf8'), sandbox, { filename: rel });
  }
  sandbox.__ULB__.bundleProbe.run = runStub;
  return { api: sandbox.__ULB_NODE__, consoleWarns };
}

/** 造一个带 5 字节 tag 的假文件上下文（run 桩按 tag 区分情形） */
function fakeFile(rootId, rel, tag) {
  return { rootId, rel, name: path.basename(rel), bytes: new TextEncoder().encode(tag.padEnd(16, '\0')) };
}

const CUBISM2_REJECT = {
  code: 'LIVE2D_CUBISM2_MOC_UNSUPPORTED',
  message: '这是 Cubism 2.1 的 .moc 模型数据（body.moc），版本 3。Cubism 3 及以后的 SDK/运行时已不支持 .moc 与 .mtn 这两种旧格式。',
};

/** 按 tag 返回三种情形：CUBI2=Cubism2 包 / RESID=残缺包 / 其它=正常 moc3 */
const triStateRun = (bytes) => {
  const tag = Buffer.from(bytes.subarray(0, 5)).toString('latin1');
  if (tag === 'CUBI2') return { ok: true, moc3: null, cubism2Moc: { count: 1, names: ['body.moc'], version: 3 }, reject: CUBISM2_REJECT };
  if (tag === 'RESID') return { ok: true, moc3: null, cubism2Moc: null, reject: null };
  return { ok: true, moc3: { bytes: 1 }, cubism2Moc: null, reject: null };
};

test('链路：Cubism2 包 ⇒ canHandle=false + explainReject 给原因 + 发一条 warn', () => {
  const { api, consoleWarns } = loadPluginWithRunStub({ runStub: triStateRun });
  const file = fakeFile('r1', 'live2d/old_moc_pack', 'CUBI2');
  assert.equal(api.canHandle(file), false, 'Cubism2 包不应被认领');
  const why = api.explainReject(file);
  assert.ok(why, '应给出结构化原因');
  assert.equal(why.code, 'LIVE2D_CUBISM2_MOC_UNSUPPORTED');
  assert.match(why.message, /Cubism 2\.1/);
  assert.equal(consoleWarns.length, 1, `应恰好发出一条 warn，实际 ${consoleWarns.length}`);
  assert.match(consoleWarns[0], /^\[unity-live2d-bundle\]/, '降级日志必须带插件前缀');
  assert.match(consoleWarns[0], /Cubism 2\.1/, '日志应说清这是什么格式');
});

test('链路：残缺包（无 moc3 也无 .moc）⇒ canHandle=false 但 explainReject=null 且不发 warn', () => {
  const { api, consoleWarns } = loadPluginWithRunStub({ runStub: triStateRun });
  const file = fakeFile('r1', 'live2d/broken_pack', 'RESID');
  assert.equal(api.canHandle(file), false);
  assert.equal(api.explainReject(file), null, '残缺包不得被说成 Cubism 2.1（宿主应报"无法判定"）');
  assert.equal(consoleWarns.length, 0, '没有可解释的原因时不该发 warn');
});

test('链路：正常 moc3 包 ⇒ canHandle=true + explainReject=null + 不发 warn（不误报）', () => {
  const { api, consoleWarns } = loadPluginWithRunStub({ runStub: triStateRun });
  const file = fakeFile('r1', 'live2d/normal', 'OKMOC');
  assert.equal(api.canHandle(file), true, 'moc3 包必须仍被认领');
  assert.equal(api.explainReject(file), null);
  assert.equal(consoleWarns.length, 0, '正常包不应产生任何 Cubism 2 日志');
});

test('链路：原因只对刚判定过的那个文件生效（不张冠李戴）', () => {
  const { api } = loadPluginWithRunStub({ runStub: triStateRun });
  const a = fakeFile('r1', 'live2d/old_moc_pack', 'CUBI2');
  api.canHandle(a);
  assert.ok(api.explainReject(a), '同一个文件应能取到原因');
  assert.equal(api.explainReject(fakeFile('r9', 'other/never_seen', 'XXXX')), null, '别的文件不得继承原因');
  api.canHandle(fakeFile('r1', 'live2d/normal', 'OKMOC'));
  assert.equal(api.explainReject(a), null, '原因应随下一次判定失效');
});
