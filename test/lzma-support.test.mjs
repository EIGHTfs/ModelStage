// test/lzma-support.test.mjs —— UnityFS 的 LZMA 块解码（解码器接入 + 长度校验）
//
// 锁三件事：
//   ① 真实 LZMA 包能解（blocksInfo 用 LZMA 的、block 数据用 LZMA 的，两类各一个样本）
//   ② **长度校验生效**：解码器自身不校验长度（传错也静默返回），必须由 lzmaDecompress 兜住
//   ③ 加载清单与副本一致性：plugin.json 的 files[] 顺序（lzma 在 unityfs 之前）、两份 lib 逐字节相同
//
// 样本不入库：路径从 config/resources.json 真实配置派生（不硬编码绝对路径），
//   或由 MODELSTAGE_LZMA_SAMPLE_DIR 显式指定；两者都拿不到就 skip（不假装通过）。
//   指纹（sha256 + 期望长度）来自实测，见 docs/设计/2026-10-28UnityFS-LZMA支持调研.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from '../tool/parse-jsonc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE2D_LIB = path.join(ROOT, 'plugins/unity-live2d-bundle/lib');
const SPINE_LIB = path.join(ROOT, 'plugins/unity-spine-bundle/lib');

/** 生产同款加载顺序（与 lib/*.js 的依赖序一致：lzma 必须在 unityfs 之前） */
const LIB_ORDER = ['errors.js', 'bytes.js', 'common-strings.js', 'lzma-d-min.js', 'unityfs.js', 'serialized.js'];

/**
 * 建一个 lib 沙箱（复刻 plugin-runner / bundle-probe-node 的 classic script 加载方式）。
 * @param {{stubLzma?: (realDecompress: Function) => Function}} [opts] stubLzma 可替换解码器（测长度校验用）
 */
function makeLibNS(opts = {}) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    TextEncoder, TextDecoder, Uint8Array, Int32Array, Array, Math, String, Number, Error, Date,
    setTimeout, setImmediate, clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of LIB_ORDER) {
    const abs = path.join(LIVE2D_LIB, rel);
    if (!fs.existsSync(abs)) throw new Error(`缺 lib 文件：${rel}`);
    vm.runInContext(fs.readFileSync(abs, 'utf8'), sandbox, { filename: rel });
  }
  if (opts.stubLzma) {
    const real = sandbox.LZMA.decompress;
    sandbox.LZMA.decompress = opts.stubLzma(real);
  }
  return sandbox.__ULB__;
}

const sha256 = (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');

/** 从真实配置派生样本目录（优先环境变量），拿不到返回 null 由调用方 skip */
function resolveSampleDir() {
  const fromEnv = process.env.MODELSTAGE_LZMA_SAMPLE_DIR;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  try {
    const cfgText = fs.readFileSync(path.join(ROOT, 'config/resources.json'), 'utf8');
    const cfg = parseJsonc(cfgText, 'resources.json');
    const root = (cfg.roots || []).find((r) => r.id === 'azurlane_bundle');
    if (!root || !root.path) return null;
    // 该根下包在 `live2d/` 子目录（实测布局）；换了布局就拿不到，用例会 skip 而不是误报
    const dir = path.join(root.path, 'live2d');
    return fs.existsSync(dir) ? dir : (fs.existsSync(root.path) ? root.path : null);
  } catch {
    return null;
  }
}

/** 读 UnityFS 头部字段（不依赖 lib，便于构造被测输入） */
function readHeaderFields(u8) {
  let p = 0;
  const cstr = () => { while (u8[p] !== 0) p += 1; p += 1; };
  cstr(); p += 4; cstr(); cstr(); p += 8;
  const dv = new DataView(u8.buffer, u8.byteOffset);
  return { csz: dv.getUint32(p, false), usz: dv.getUint32(p + 4, false), flags: dv.getUint32(p + 8, false) };
}

// ---------------------------------------------------------------- ① 真实样本解码

test('blocksInfo 用 LZMA 的包能解（longfeng_2，实测指纹比对）', () => {
  const dir = resolveSampleDir();
  if (!dir) return;                          // 样本不在本机：skip
  const abs = path.join(dir, 'longfeng_2');
  if (!fs.existsSync(abs)) return;

  const buf = fs.readFileSync(abs);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const NS = makeLibNS();
  const parsed = NS.unityfs.parse(u8);       // blocksInfo（LZMA）与 block[0]（LZMA）都要解

  // 指纹（实测，见调研文档 §四）：该包 blocksInfo 与 block[0] 都是 LZMA
  assert.equal(buf.length, 2757749, `样本长度变了（${buf.length}），指纹基准需重取`);
  assert.equal(parsed.nodes.length, 1, `longfeng_2 应只有 1 个节点（CAB），实际 ${parsed.nodes.length}`);
  assert.equal(parsed.data.length, 10766187, `解压后数据区应为 10766187，实际 ${parsed.data.length}`);
  assert.equal(
    sha256(parsed.data),
    'cc0bcd40d33117820879eb694e7f428d412d691f54db53254569e4d29fe006c7',
    '解压内容指纹不符（解码路径可能变了）',
  );
});

test('block 数据用 LZMA 的包能解（aierdeliqi_5，长度与指纹比对）', () => {
  const dir = resolveSampleDir();
  if (!dir) return;
  const abs = path.join(dir, 'aierdeliqi_5');
  if (!fs.existsSync(abs)) return;

  const buf = fs.readFileSync(abs);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const NS = makeLibNS();
  const parsed = NS.unityfs.parse(u8);

  assert.equal(buf.length, 2213909, `样本长度变了（${buf.length}），指纹基准需重取`);
  // 实测：block[0] 解压后 8677760B，sha256 = 1b78de4e…
  assert.equal(parsed.data.length, 8677760, `解压后数据区长度应为 8677760，实际 ${parsed.data.length}`);
  assert.equal(
    sha256(parsed.data),
    '1b78de4e343f433551ea0558be3370674214130d97f310dbb7f0f399f9d24ff9',
    '解压内容指纹不符（解码路径可能变了）',
  );
});

// ---------------------------------------------------------------- ② 长度校验（本轮核心）

test('长度校验：解码器返回的长度与声明不符时必须抛 ULB_ERR_LZMA_FAIL', () => {
  const dir = resolveSampleDir();
  if (!dir) return;
  const abs = path.join(dir, 'aierdeliqi_5');
  if (!fs.existsSync(abs)) return;

  // 故意让解码器少返回 1 字节：模拟「uncompressedSize 传错」时上游静默返回截断数据的情形
  const NS = makeLibNS({ stubLzma: (real) => (input) => { const out = real(input); return out.slice(0, out.length - 1); } });
  const buf = fs.readFileSync(abs);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

  assert.throws(() => NS.unityfs.parse(u8), (e) => {
    assert.equal(e.code, 'ULB_ERR_LZMA_FAIL', `应为 ULB_ERR_LZMA_FAIL，实际 ${e.code}`);
    assert.match(String(e.message), /长度不符/, `错误消息应说明长度不符，实际：${e.message}`);
    return true;
  });
});

test('解码器缺失时抛 ULB_ERR_LZMA_UNAVAILABLE（不是静默失败）', () => {
  const dir = resolveSampleDir();
  if (!dir) return;
  const abs = path.join(dir, 'longfeng_2');
  if (!fs.existsSync(abs)) return;

  // 把 LZMA 摘掉：模拟 plugin.json files[] 漏声明 / 加载失败
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    TextEncoder, TextDecoder, Uint8Array, Int32Array, Array, Math, String, Number, Error, Date,
    setTimeout, setImmediate, clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ['errors.js', 'bytes.js', 'common-strings.js', 'unityfs.js']) {
    vm.runInContext(fs.readFileSync(path.join(LIVE2D_LIB, rel), 'utf8'), sandbox, { filename: rel });
  }
  const buf = fs.readFileSync(abs);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  assert.throws(() => sandbox.__ULB__.unityfs.readHeader(u8), (e) => {
    assert.equal(e.code, 'ULB_ERR_LZMA_UNAVAILABLE', `应为 ULB_ERR_LZMA_UNAVAILABLE，实际 ${e.code}`);
    return true;
  });
});

// ---------------------------------------------------------------- ③ 清单与副本一致性

test('plugin.json 的 files[] 把 lzma-d-min.js 排在 unityfs.js 之前（两个插件都要）', () => {
  for (const plugin of ['unity-live2d-bundle', 'unity-spine-bundle']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', plugin, 'plugin.json'), 'utf8'));
    const lzmaAt = manifest.files.indexOf('lib/lzma-d-min.js');
    const unityfsAt = manifest.files.indexOf('lib/unityfs.js');
    assert.ok(lzmaAt >= 0, `${plugin} 的 files[] 缺 lib/lzma-d-min.js`);
    assert.ok(unityfsAt >= 0, `${plugin} 的 files[] 缺 lib/unityfs.js`);
    assert.ok(lzmaAt < unityfsAt, `${plugin}：lzma-d-min.js 必须排在 unityfs.js 之前（unityfs 取全局 LZMA）`);
  }
});

test('两份 lib 的 lzma 解码器逐字节相同（含 LICENSE）', () => {
  for (const name of ['lzma-d-min.js', 'lzma-d-min.LICENSE.txt']) {
    const a = path.join(LIVE2D_LIB, name);
    const b = path.join(SPINE_LIB, name);
    assert.ok(fs.existsSync(a) && fs.existsSync(b), `两份都应存在：${name}`);
    assert.equal(sha256(fs.readFileSync(a)), sha256(fs.readFileSync(b)), `${name} 两份内容不同，必须同步`);
  }
});

test('vendored 解码器保留了 MIT 版权声明（min 版原产物没有，需人工补）', () => {
  const text = fs.readFileSync(path.join(LIVE2D_LIB, 'lzma-d-min.js'), 'utf8');
  assert.match(text, /Nathan Rugg/, '缺少作者署名');
  assert.match(text, /MIT/i, '缺少 MIT 许可声明');
  assert.match(text, /lzma-d-min\.LICENSE\.txt/, '应指向同目录的许可全文');
});
