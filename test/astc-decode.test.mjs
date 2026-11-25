// test/astc-decode.test.mjs —— 纹理格式表与 ASTC 分发语义（表 + 解码器接入后的判据）
//
// 钉住四件事：
//   ① 48 是 ASTC_RGB_4x4，不是 ETC2_RGBA1（后者是 46）—— 编号错会把 ASTC 当 ETC 解，产花屏
//   ② ASTC 各格式的块边长按表取值，expectedSize 不再按 4x4 硬算
//   ③ ASTC 48~59 两侧都齐（canDecode 为真）；真正没实现的格式才报 FORMAT_UNSUPPORTED，
//      而"ASTC 数据给少了"必须报 TEX_DATA_SHORT（两件事不能混）
//   ④ ETC/BC 这些 4x4 格式的 expectedSize 与改动前完全一致（零回归）
//
// texdecode.js 是浏览器风格脚本（挂 globalThis.__ULB__），必须在 vm 沙箱里加载。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(ROOT, 'plugins', 'unity-spine-bundle', 'lib');

/** 按 plugin.json 的 files[] 顺序加载 lib 到沙箱（与生产装载同源） */
function loadSandbox() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'unity-spine-bundle', 'plugin.json'), 'utf8'));
  const ctx = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    TextDecoder, TextEncoder, setTimeout, clearTimeout,
  };
  ctx.globalThis = ctx; ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  for (const rel of manifest.files.filter((f) => f.startsWith('lib/'))) {
    const abs = path.join(LIB, rel.slice('lib/'.length));
    if (!fs.existsSync(abs)) continue;
    vm.runInContext(fs.readFileSync(abs, 'utf8'), ctx, { filename: rel });
  }
  return ctx.__ULB__;
}

const NS = loadSandbox();
const TD = NS.texdecode;

test('格式编号：48 是 ASTC_RGB_4x4，46 才是 ETC2_RGBA1', () => {
  assert.equal(TD.formatName(48), 'ASTC_RGB_4x4', '48 必须是 ASTC（当作 ETC2_RGBA1 会花屏）');
  assert.equal(TD.formatName(46), 'ETC2_RGBA1', '46 才是真正的 ETC2_RGBA1');
  assert.equal(TD.formatName(45), 'ETC2_RGB');
  assert.equal(TD.formatName(47), 'ETC2_RGBA8');
});

test('格式编号：49~59 是 ASTC 各块尺寸，名称与 bw/bh 一致', () => {
  const expect = {
    49: ['ASTC_RGB_5x5', 5], 50: ['ASTC_RGB_6x6', 6], 51: ['ASTC_RGB_8x8', 8],
    52: ['ASTC_RGB_10x10', 10], 53: ['ASTC_RGB_12x12', 12],
    54: ['ASTC_RGBA_4x4', 4], 55: ['ASTC_RGBA_5x5', 5], 56: ['ASTC_RGBA_6x6', 6],
    57: ['ASTC_RGBA_8x8', 8], 58: ['ASTC_RGBA_10x10', 10], 59: ['ASTC_RGBA_12x12', 12],
  };
  for (const [fmt, [name, bw]] of Object.entries(expect)) {
    const n = Number(fmt);
    assert.equal(TD.formatName(n), name);
    assert.equal(TD.FORMATS[n].bw, bw, `${name} 的 bw 应为 ${bw}`);
    assert.equal(TD.FORMATS[n].bh, bw, `${name} 的 bh 应为 ${bw}`);
    assert.equal(TD.FORMATS[n].block, 16, 'ASTC 每块固定 16 字节');
  }
});

test('expectedSize：ASTC 按块边长算（440x440 的 6x6 ⇒ 87616）', () => {
  // 这条数字来自真实包 char_010_chen.ab 的 m_CompleteImageSize
  assert.equal(TD.expectedSize(50, 440, 440), 74 * 74 * 16);
  assert.equal(TD.expectedSize(50, 440, 440), 87616);
  // 1024x1024 的 5x5 ⇒ 205*205*16 = 672400（char_010_chen.ab 的另一张纹理）
  assert.equal(TD.expectedSize(49, 1024, 1024), 205 * 205 * 16);
  assert.equal(TD.expectedSize(49, 1024, 1024), 672400);
});

test('expectedSize：ETC/BC 走默认 4x4，与改动前一致（零回归）', () => {
  // 这些都是 4x4 块，改动前后必须逐字节相同
  assert.equal(TD.expectedSize(34, 256, 256), 64 * 64 * 8);    // ETC_RGB4 8B/块
  assert.equal(TD.expectedSize(47, 256, 256), 64 * 64 * 16);   // ETC2_RGBA8 16B/块
  assert.equal(TD.expectedSize(10, 512, 512), 128 * 128 * 8);  // DXT1
  assert.equal(TD.expectedSize(4, 100, 50), 100 * 50 * 4);     // RGBA32（非块式）
});

test('ASTC 已接入：48~59 全系列 canDecode 为真（表与解码器两侧都齐）', () => {
  // 这一条取代了"A 批时 ASTC 还没接解码器、decode 报格式未支持"的旧断言：
  //   T4 把 lib/astc.js 接进 DECODERS 之后，"能不能解"的判据从这里往后就是 canDecode。
  for (let fmt = 48; fmt <= 59; fmt++) {
    assert.equal(TD.canDecode(fmt), true, `${TD.formatName(fmt)}（${fmt}）应可解码`);
  }
});

test('报错：真正没实现的格式（PVRTC 30）才报「格式未支持」并带格式号', () => {
  const data = new Uint8Array(1024);
  let err = null;
  try {
    TD.decode({ format: 30, width: 16, height: 16, name: 'probe' }, data);
  } catch (e) { err = e; }
  assert.ok(err, '必须抛错，不能返回图像');
  assert.equal(err.code, 'ULB_ERR_TEX_FORMAT_UNSUPPORTED');
  assert.match(String(err.message), /30/, '文案要带格式号');
});

test('ASTC 数据不足时仍报「数据不足」而不是「格式未支持」', () => {
  // 期望长度 87616（440x440 按 6x6），这里只给 16 字节 ⇒ 应被长度检查拦下
  const data = new Uint8Array(16);
  let err = null;
  try {
    TD.decode({ format: 50, width: 440, height: 440, name: 'probe' }, data);
  } catch (e) { err = e; }
  assert.ok(err);
  assert.equal(err.code, 'ULB_ERR_TEX_DATA_SHORT', `不该是格式未支持：${err && err.message}`);
  assert.match(String(err.message), /87616/, '文案要给出期望字节数');
});

test('46 已登记解码器（ETC2_RGBA1 用真解码器，不是报缺失）', () => {
  assert.equal(typeof NS.etc2.decodeEtc2Rgba1, 'function', 'etc2 库要提供 decodeEtc2Rgba1');
  // 16 字节一个块，给足 1 块数据即可走完解码路径；这里只验"能进入解码器"而不校验像素
  const block = new Uint8Array(16);
  let err = null;
  try {
    const out = TD.decode({ format: 46, width: 4, height: 4, name: 'probe' }, block);
    assert.equal(out.length, 4 * 4 * 4, '应产出 RGBA（4x4 像素 × 4 通道）');
  } catch (e) { err = e; }
  assert.equal(err, null, `46 应能解码，实际抛了：${err && err.code}`);
});
