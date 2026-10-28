// test/unityfs-v6-padding.test.mjs —— version 6 内联 blocksInfo 之后的**对齐填充**解析
//
// 背景（实测三包 aidang_2 / banrenma_2 / xianghe_2 取证）：
//   header 50 字节 + blocksInfo 91 字节 = 141，但数据块实际从 **144** 开始（中间 3 字节填充，144 恰好 16 字节对齐）。
//   这三个包的 node.offset 都写着 **3**，恰等于填充量 ⇒ 节点偏移以「blocksInfo 末尾」为基准记录。
//   不修正则报「节点 CAB-xxx 越界：offset=3 size=18666148 数据区=18666148」。
//   判据不能靠 dataflags（这三包是 0x40，没置 0x200 BlockInfoNeedPaddingAtStart），只能让数据自证：
//   「文件剩余字节 − 各块声明压缩大小之和」= 填充量，且**最小节点偏移必须恰好等于它**（否则是尾部 trailer，不能减）。
//
// 样本不进库（体积几十 MB）：用环境变量指向真实包，未设置则整组跳过并说明原因。
//   ULB_PADDED_BUNDLE=<其中一个包的绝对路径>
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'plugins', 'unity-live2d-bundle', 'lib');

/** 样本路径只从环境读（不硬编码绝对路径，换机器/换目录都不用改测试） */
const FIXTURE = process.env.ULB_PADDED_BUNDLE || '';
const SKIP = FIXTURE && fs.existsSync(FIXTURE)
  ? false
  : '未提供带填充的 version 6 样本（设 ULB_PADDED_BUNDLE=<包绝对路径> 后运行；样本几十 MB，不入库）';

/** 在 vm 沙箱里装载插件的 lib（与运行时同一套 classic script 加载顺序） */
function loadUnityfs() {
  const order = ['errors.js', 'bytes.js', 'common-strings.js', 'lzma-d-min.js', 'unityfs.js'];
  const ctx = { console: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, TextDecoder, TextEncoder, setTimeout, clearTimeout };
  ctx.globalThis = ctx; ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of order) {
    vm.runInContext(fs.readFileSync(path.join(LIB, f), 'utf8'), ctx, { filename: f });
  }
  return ctx.__ULB__.unityfs;
}

test('① 头部：识别出 3 字节对齐填充，且节点偏移被归一到数据起点（0）', { skip: SKIP }, () => {
  const U = unityfsFixture();
  const h = U.readHeader(new Uint8Array(fs.readFileSync(FIXTURE)));
  assert.equal(h.version, 6, '样本应是 version 6');
  assert.equal(h.dataPadding, 3, '这三包的内联 blocksInfo 后有 3 字节填充');
  assert.equal(h.blocks.length, 1, '单块容器');
  assert.equal(h.nodes.length, 1, '单节点容器');
  assert.equal(h.nodes[0].offset, 0, '节点偏移必须归一到 0（原值 3 = 填充量）');
  assert.equal(h.nodes[0].size, h.blocks[0].uncompressedSize, '节点大小 == 块的解压后大小');
  assert.match(h.nodes[0].path, /^CAB-/, '节点应是 CAB- 序列化文件');
});

test('② 数据区算术闭合：数据起点 + 块压缩大小 == 逻辑长度（填充没多算也没少算）', { skip: SKIP }, () => {
  const U = unityfsFixture();
  const u8 = new Uint8Array(fs.readFileSync(FIXTURE));
  const h = U.readHeader(u8);
  const declaredData = h.blocks.reduce((a, b) => a + b.compressedSize, 0);
  assert.equal(h.dataStart + declaredData, u8.length, '数据起点 + 压缩数据 == 文件长度');
  assert.equal(h.dataStart % 16, 0, '数据起点按 16 字节对齐（这正是填充存在的原因）');
});

test('③ 解包：产物非空且含 moc3（不只是头部能读，要真的产出）', { skip: SKIP }, async () => {
  const { ensurePlugin } = await import('../src/server/unpack/plugin-runner.mjs');
  const loaded = ensurePlugin('unity-live2d-bundle');
  assert.ok(loaded.ok, `插件装载失败：${loaded.error}`);
  const name = path.basename(FIXTURE);
  const bytes = new Uint8Array(fs.readFileSync(FIXTURE));
  const r = await loaded.api.resolve({ rootId: 'fixture', rel: name, name, size: bytes.length, bytes });
  // 注意：插件跑在 vm 沙箱里，它返回的 Map 属于**另一个 realm** ⇒ `instanceof Map` 为 false，
  //   必须用鸭子类型判断（有 keys/get 就当 Map 用），否则会拿到空列表误报"没有产物"。
  const f = r && r.files;
  const files = f && typeof f.keys === 'function' && typeof f.get === 'function'
    ? [...f.keys()]
    : Object.keys(f || {});
  assert.ok(files.length > 0, '必须解出产物');
  assert.ok(files.includes('moc3.moc3'), `产物里应有 moc3.moc3，实际：${files.slice(0, 6).join(', ')}`);
});

/** 取插件 unityfs（缓存一份，避免每个用例重复建沙箱） */
let cachedUnityfs = null;
function unityfsFixture() {
  if (!cachedUnityfs) cachedUnityfs = loadUnityfs();
  return cachedUnityfs;
}
