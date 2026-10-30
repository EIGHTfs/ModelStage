// test/spine-bundle-plugin.test.mjs —— spine 资源包插件（unity-spine-bundle）的三条 fixture + 内存声明
//
// 为什么用 ensurePlugin() 而不是自己搭 vm 沙盒：
//   ① 交付纪律第二条（禁止相似功能多处实现）—— 装载逻辑在 src/server/unpack/plugin-runner.mjs 已有一份；
//   ② 更关键：只有生产路径注入了 `setDeflateStream`，自己搭沙盒若漏注入，PNG 编码会回落到
//      "stored（不压缩）"，2048² 得到 16.8MB 的假大文件（实测踩过，见 fixtures/spine-bundle/README.md）。
//      用生产装载路径，正好把这条隐式依赖钉进测试。
//
// 样本策略：外部资源不入库（NIKKE 单包 5.6~6.6MB），按路径引用 + 缺失即 skip，
//   与 test/unpack-filesview.test.mjs 引用 ../live2d 同口径。坏包由正例样本截断构造。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePlugin } from '../src/server/unpack/plugin-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NIKKE_ROOT = path.resolve(ROOT, '..', 'NIKKE', 'Rupee - 露菲');
const LIVE2D_ROOT = path.resolve(ROOT, '..', 'live2d');

const SPINE_PLUGIN = 'unity-spine-bundle';
const LIVE2D_PLUGIN = 'unity-live2d-bundle';

/** 取一个 spine 正例（NIKKE 包：无扩展名的 UnityFS 文件）；无样本返回 null 由调用方 skip */
function pickSpineSample() {
  if (!fs.existsSync(NIKKE_ROOT)) return null;
  const names = fs.readdirSync(NIKKE_ROOT).filter((n) => !n.toLowerCase().endsWith('.7z')).sort();
  return names.length ? path.join(NIKKE_ROOT, names[0]) : null;
}

/** 取一个 live2d 包（互斥反例）；无样本返回 null */
function pickLive2dSample() {
  if (!fs.existsSync(LIVE2D_ROOT)) return null;
  const names = fs.readdirSync(LIVE2D_ROOT)
    .filter((n) => !/\.(rar|7z|zip)$/i.test(n))
    .sort();
  for (const n of names) {
    const abs = path.join(LIVE2D_ROOT, n);
    try {
      if (fs.statSync(abs).isFile()) return abs;
    } catch { /* 读不到就试下一个 */ }
  }
  return null;
}

/** 取插件 API（走生产装载路径：清单 files[] 顺序 + 真实 zlib 注入） */
function apiOf(pluginId) {
  const loaded = ensurePlugin(pluginId);
  assert.ok(loaded.ok, `${pluginId} 装载失败：${loaded.error}`);
  assert.equal(typeof loaded.api.canHandle, 'function', `${pluginId} 缺 canHandle`);
  assert.equal(typeof loaded.api.resolve, 'function', `${pluginId} 缺 resolve`);
  return loaded.api;
}

/** 读成 Uint8Array（契约 §1.1 要求 Uint8Array，不是 Buffer/ArrayBuffer） */
function bytesOf(abs) {
  const buf = fs.readFileSync(abs);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** 构造宿主传进来的 file 上下文（resolve/canHandle 的入参形状） */
function fileOf(abs) {
  const bytes = bytesOf(abs);
  const name = path.basename(abs);
  return { rootId: 'test-root', rel: name, name, size: bytes.length, bytes };
}

/**
 * 取 files 的 [key, Blob] 列表。
 * **跨 realm 不能用 instanceof**：插件在 vm 沙盒里跑，那里的 Map 与宿主的 Map 是两个构造器，
 *   `files instanceof Map` 恒 false，而 `Object.keys(map)` 恒空（Map 没有自有可枚举键）
 *   ⇒ 会得到"产物为空但成功"的假结果（与 plugin-runner.mjs:256-298 filesView 同口径）。
 */
function entriesOf(files) {
  const out = [];
  if (files && typeof files.size === 'number' && typeof files.forEach === 'function') {
    files.forEach((value, key) => out.push([String(key), value]));
  } else if (files && typeof files === 'object') {
    for (const key of Object.keys(files)) out.push([key, files[key]]);
  }
  return out;
}

/** 从 PNG 的 IHDR 读尺寸（PNG 是大端；只看字节，不解码整图） */
function pngSizeOf(buffer) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) if (buffer[i] !== sig[i]) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  // 8 字节签名 + 4 字节长度 + 4 字节 "IHDR" → 宽高在偏移 16 / 20
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// ---------------------------------------------------------------- 正例

test('正例：NIKKE 包被 spine 插件认领，产物齐全且自洽', async () => {
  const abs = pickSpineSample();
  if (!abs) return;   // 样本不在本机：skip（不假装通过）

  const api = apiOf(SPINE_PLUGIN);
  const file = fileOf(abs);

  assert.equal(api.canHandle(file), true, 'spine 插件应认领 NIKKE 包');

  const out = await api.resolve(file);
  assert.equal(typeof out.prefix, 'string');
  assert.ok(out.prefix.startsWith(`vfs://${SPINE_PLUGIN}/`), `prefix 形状不对：${out.prefix}`);
  assert.ok(out.prefix.endsWith('/'), 'prefix 必须以 / 结尾（契约 §4.2）');

  const entries = entriesOf(out.files);
  assert.ok(entries.length >= 4, `产物至少 4 个（skel+atlas+png+entry.json），实际 ${entries.length}`);

  const keys = entries.map(([key]) => key);
  assert.ok(keys.includes('entry.json'), `files 里必须有 entry.json，实际 ${keys.join(',')}`);
  assert.equal(out.entry, 'entry.json', 'resolve 的 entry 必须指向 entry.json');

  // 形状断言（不能只数条数：数量对但内容错同样是假成功）
  const skelKey = keys.find((k) => k.toLowerCase().endsWith('.skel'));
  const atlasKey = keys.find((k) => k.toLowerCase().endsWith('.atlas'));
  const pngKeys = keys.filter((k) => k.toLowerCase().endsWith('.png'));
  assert.ok(skelKey, '缺 .skel');
  assert.ok(atlasKey, '缺 .atlas');
  assert.ok(pngKeys.length >= 1, '缺 .png');

  // skel：必须是 raw 字节（不能用 TextAsset 文本长度的膨胀值——651994 会变成 980446）
  const skelBlob = out.files.get ? out.files.get(skelKey) : out.files[skelKey];
  const skelBuf = Buffer.from(await skelBlob.arrayBuffer());
  assert.ok(skelBuf.length > 1024, `skel 太小：${skelBuf.length}`);
  assert.ok(skelBuf.length < 4 * 1024 * 1024, `skel 异常大（疑似字符串回编码膨胀）：${skelBuf.length}`);
  const skelHead = skelBuf.subarray(0, 64).toString('latin1');
  assert.match(skelHead, /\d+\.\d+\.\d+/, 'skel 头部应含 Spine 版本串');

  // atlas 首行页名必须与某个落盘 png 同名（前端按页名找贴图，错一位就黑图）
  const atlasBlob = out.files.get ? out.files.get(atlasKey) : out.files[atlasKey];
  const atlasText = Buffer.from(await atlasBlob.arrayBuffer()).toString('utf8');
  const firstPage = atlasText.split('\n')[0].trim();
  assert.ok(pngKeys.includes(firstPage), `atlas 首行「${firstPage}」必须等于落盘 png 名，实际 ${pngKeys.join(',')}`);

  // png：真 PNG 且尺寸正确
  for (const pk of pngKeys) {
    const blob = out.files.get ? out.files.get(pk) : out.files[pk];
    const buf = Buffer.from(await blob.arrayBuffer());
    const size = pngSizeOf(buf);
    assert.ok(size, `${pk} 不是合法 PNG（签名不符）`);
    assert.equal(size.width, 2048, `${pk} 宽度应为 2048，实际 ${size.width}`);
    assert.equal(size.height, 2048, `${pk} 高度应为 2048，实际 ${size.height}`);
    // 体积断言：stored 未压缩的 2048² 会是 16.8MB —— 超过 8MB 说明宿主 zlib 注入缺失
    assert.ok(buf.length < 8 * 1024 * 1024, `${pk} 体积 ${(buf.length / 1048576).toFixed(1)}MB 异常，疑似 PNG 走了 stored 未压缩`);
  }

  // entry.json：三字段与实际落盘逐一对上（字段名是与前端约定的，不可改）
  const entryBlob = out.files.get ? out.files.get('entry.json') : out.files['entry.json'];
  const entryJson = JSON.parse(Buffer.from(await entryBlob.arrayBuffer()).toString('utf8'));
  assert.deepEqual(
    Object.keys(entryJson).sort(),
    ['atlasFile', 'skeletonFile', 'textureFiles'],
    `entry.json 字段必须正好是 skeletonFile/atlasFile/textureFiles，实际 ${Object.keys(entryJson).join(',')}`,
  );
  for (const ref of [entryJson.skeletonFile, entryJson.atlasFile, ...entryJson.textureFiles]) {
    assert.ok(keys.includes(ref), `entry.json 引用了未落盘的文件：${ref}`);
  }
});

// ---------------------------------------------------------------- 互斥反例

test('互斥：live2d 包不被 spine 认领，live2d 插件仍认领它', () => {
  const abs = pickLive2dSample();
  if (!abs) return;

  const spine = apiOf(SPINE_PLUGIN);
  const live2d = apiOf(LIVE2D_PLUGIN);
  const file = fileOf(abs);

  // 宿主 pickPlugin 只取第一个返回 true 的插件、不重试 ⇒ 两个插件必须互斥，
  //   否则错认领的一方会在 resolve 阶段报"找不到 moc3/.skel"，现场看起来像包坏了。
  assert.equal(spine.canHandle(file), false, `spine 插件不应认领 live2d 包：${path.basename(abs)}`);
  assert.equal(live2d.canHandle(file), true, `live2d 插件应认领自己的包：${path.basename(abs)}`);
});

test('互斥：spine 包不被 live2d 认领', () => {
  const abs = pickSpineSample();
  if (!abs) return;

  const spine = apiOf(SPINE_PLUGIN);
  const live2d = apiOf(LIVE2D_PLUGIN);
  const file = fileOf(abs);

  assert.equal(spine.canHandle(file), true);
  assert.equal(live2d.canHandle(file), false, `live2d 插件不应认领 spine 包：${path.basename(abs)}`);
});

// ---------------------------------------------------------------- 坏包

test('坏包：随机字节必须抛 SPI_ERR_NOT_UNITYFS', async () => {
  const api = apiOf(SPINE_PLUGIN);
  // 不依赖外部样本：伪造一段非 UnityFS 的字节
  const fake = new Uint8Array(4096);
  for (let i = 0; i < fake.length; i += 1) fake[i] = (i * 31 + 7) & 0xff;
  const file = { rootId: 'test-root', rel: 'fake.bundle', name: 'fake.bundle', size: fake.length, bytes: fake };

  assert.equal(api.canHandle(file), false, 'canHandle 对随机字节应返回 false');
  await assert.rejects(
    () => api.resolve(file),
    (e) => {
      assert.equal(e.code, 'SPI_ERR_NOT_UNITYFS', `应为 SPI_ERR_NOT_UNITYFS，实际 ${e.code}`);
      return true;
    },
  );
});

test('坏包：截断的 UnityFS 必须响亮报错，绝不静默返回空产物', async () => {
  const abs = pickSpineSample();
  if (!abs) return;

  const full = bytesOf(abs);
  // 截到 60%：头部完整、块表（在文件尾）读不到 —— 真实世界最常见的损坏形态（下载中断）
  const truncated = full.subarray(0, Math.floor(full.length * 0.6));
  const file = { rootId: 'test-root', rel: 'truncated.bundle', name: 'truncated.bundle', size: truncated.length, bytes: truncated };

  const api = apiOf(SPINE_PLUGIN);
  // 契约 §五.8：解析失败必须抛带码错误，不能返回缺字段/空产物的"半成品"。
  //   静默返回空 Map 会让宿主判成功，前端拿到 0 个文件后再去渲染，故障点被推到很远。
  await assert.rejects(
    () => api.resolve(file),
    (e) => {
      assert.ok(typeof e.code === 'string' && e.code.startsWith('SPI_ERR_'),
        `错误码必须是本插件声明的 SPI_ERR_* 前缀，实际 ${e.code}`);
      assert.ok(e.message && e.message.length > 0, '错误必须有可读 message');
      return true;
    },
  );
});

// ---------------------------------------------------------------- 内存声明

test('estimateMemory：decompressedBytes 来自块表，peakBytes 不低于固定开销量级', () => {
  const abs = pickSpineSample();
  if (!abs) return;

  const api = apiOf(SPINE_PLUGIN);
  assert.equal(typeof api.estimateMemory, 'function', '插件必须提供 estimateMemory（契约 §2.2）');

  const file = fileOf(abs);
  const mem = api.estimateMemory(file);
  assert.ok(mem, 'estimateMemory 对合法包不应返回 null');
  assert.equal(typeof mem.decompressedBytes, 'number');
  assert.ok(mem.decompressedBytes > 0, 'decompressedBytes 必须为正');
  assert.ok(mem.peakBytes >= mem.decompressedBytes, 'peakBytes 必须 ≥ decompressedBytes（物理下限）');
  // M4 门禁：低于固定项量级（≈103MB）要提示漏算运行期开销
  assert.ok(mem.peakBytes >= 103 * 1024 * 1024, `peakBytes=${(mem.peakBytes / 1048576).toFixed(1)}MB 低于固定开销下限`);
});

test('estimateMemory：只给 256KB 头部时返回 null（块表在尾 ⇒ 让宿主回退全量读）', () => {
  const abs = pickSpineSample();
  if (!abs) return;

  const api = apiOf(SPINE_PLUGIN);
  const full = bytesOf(abs);
  const head = full.subarray(0, Math.min(256 * 1024, full.length));
  const file = { rootId: 'test-root', rel: 'head.bundle', name: 'head.bundle', size: 0, bytes: head };

  // 宿主先拿头部试算（plugin-runner.mjs:388 estimateMemoryOf），失败要返回 null 而不是抛错，
  //   由宿主回退全量读。这块表在文件尾（dataflags 0x80），256KB 里必然没有。
  const mem = api.estimateMemory(file);
  assert.equal(mem, null, '头部不足时应返回 null，不能抛错也不能瞎给一个数');
});

// ── atlas 页名解析：BOM 回归（与服务端 test/atlas-pages.test.mjs 同口径）─────────────
// 插件这份读的是**内存文本**，但规则必须与服务端 probe.mjs 完全一致，否则
//   "插件落盘的 png 文件名" 与 "扫描器去找的页名" 会对不上（本文件上方注释早有此要求）。
// 根因：JS 的 \s 包含 U+FEFF，AssetStudio 导出的 atlas 首行是「BOM + 页名」
//   ⇒ 不剥 BOM 就把第一页当"有前导空白"整行跳过（NIKKE 247 个模型丢第一页贴图）。
const TWO_PAGES_BODY = [
  'size: 2048,2048',
  'format: RGBA8888',
  'filter: Linear,Linear',
  'repeat: none',
  'body',
  '  bounds: 0,0,100,100',
  '',
].join('\n');

/** 用插件的私有解析函数跑一段 atlas 文本（经 __test 钩子：纯函数、无副作用） */
function pluginParseAtlas(text) {
  const api = apiOf(SPINE_PLUGIN);
  assert.equal(typeof (api.__test && api.__test.parseAtlasPages), 'function', '插件应暴露 __test.parseAtlasPages');
  // 摊进本 realm 的数组再比：插件在 vm 沙箱里执行，它返回的数组原型与本文件不同，
  //   assert/strict 的 deepEqual 会因"结构相同但不是同一原型"判失败（踩过）。
  return [...api.__test.parseAtlasPages(new TextEncoder().encode(text))];
}

test('atlas：带 BOM 的首行必须被识别为第一页', () => {
  const pages = pluginParseAtlas(`\uFEFFc010_00.png\n${TWO_PAGES_BODY}c010_00_2.png\n`);
  assert.deepEqual(pages, ['c010_00.png', 'c010_00_2.png']);
});

test('atlas：不带 BOM 的双页行为不变（回归）', () => {
  assert.deepEqual(pluginParseAtlas(`c010_00.png\n${TWO_PAGES_BODY}c010_00_2.png\n`), ['c010_00.png', 'c010_00_2.png']);
});

test('atlas：CRLF 页名不带 \\r；缩进行与注释行不被误吞', () => {
  const text = `\uFEFFc010_00.png\r\n  fake_indented.png\r\n// generated by AssetStudio\r\n${TWO_PAGES_BODY.replace(/\n/g, '\r\n')}c010_00_2.png\r\n`;
  const pages = pluginParseAtlas(text);
  assert.deepEqual(pages, ['c010_00.png', 'c010_00_2.png']);
  assert.ok(pages.every((p) => !p.includes('\r')), '页名里不能残留 \\r');
});
