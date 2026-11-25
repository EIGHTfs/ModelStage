// test/astc-decoder.test.mjs —— ASTC 解码器（plugins/*/lib/astc.js）的像素级回归
//
// 为什么用"真实资源包里的纹理 + 权威实现导出的参考 PNG"做基准，而不是自造小块：
//   ASTC 的位序/分区哈希/权重插值任何一处错一位，产出的图"看着像图"但每个像素都偏
//   （或局部花屏）。只有和权威实现逐像素比，才能证明"解对了"而不是"解出来了"。
//
// 基准从哪来（可复现，命令见 doc/设计/ASTC解码-JS移植任务书.md）：
//   UnityPy（内部用 Perfare 的 Texture2DDecoder）解包 + PIL 存 PNG ⇒ 参考 PNG 是显示方向。
//   本解码器输出**存储方向**（不做 flipY，由 texdecode.decode 统一翻），所以比对前先竖向翻转。
//
// 为什么既有"PNG 逐像素（容差 ±1）"又有"字节级 md5"：
//   · PNG 那条是人能看懂的验收口径（参考图由 UnityPy 导出，其 PIL 转换会把个别像素取整到 ±1）；
//   · md5 那条钉的是"与 Texture2DDecoder 逐字节一致"——比参考 PNG 更严，任何位序/取整改动都会红。
//   两条一起用：PNG 证明"画面对"，md5 证明"算得一模一样"。
//
// 夹具（test/fixtures/astc）来自 明日方舟 char_010_chen.ab，两种块尺寸各一张：
//   · 6x6 / 440x440（Unity format 50 = ASTC_RGB_6x6）
//   · 5x5 / 1024x1024（Unity format 49 = ASTC_RGB_5x5）

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(ROOT, 'test', 'fixtures', 'astc');
const PLUGIN_IDS = ['unity-spine-bundle', 'unity-live2d-bundle'];

// 与 Texture2DDecoder（BGRA、存储方向）逐字节一致时的 md5 —— 由本解码器产出后核对得来
const FIXTURE_6X6 = {
  astc: path.join(FIXTURE_DIR, 'astc_6x6_440_build_char_010_chen.astc'),
  png: path.join(FIXTURE_DIR, 'astc_6x6_440_build_char_010_chen.png'),
  width: 440,
  height: 440,
  blockSize: 6,
  bgraMd5: '0cfc4f669b2333ceda035d2de4f87a79',
};
const FIXTURE_5X5 = {
  astc: path.join(FIXTURE_DIR, 'astc_5x5_1024_char_010_chen_2b.astc'),
  png: path.join(FIXTURE_DIR, 'astc_5x5_1024_char_010_chen_2b.png'),
  width: 1024,
  height: 1024,
  blockSize: 5,
  bgraMd5: 'e6cb026079f2958830f2014d00bdb9bc',
};

/**
 * 在隔离上下文里加载某个插件 lib 目录下的解码器。
 *
 * 为什么按文件名显式列（errors.js + astc.js）而不是读 plugin.json 的 files[]：
 *   astc.js 本批**故意没进 files[]**（接 texdecode 那一步才登记，避免与同时改 texdecode 的
 *   改动冲突）。这里顺手钉住了"astc.js 只依赖 errors.js、可独立装载"这条性质。
 */
function loadDecoder(pluginId) {
  const libDir = path.join(ROOT, 'plugins', pluginId, 'lib');
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const file of ['errors.js', 'astc.js']) {
    const abs = path.join(libDir, file);
    assert.ok(fs.existsSync(abs), `缺少 ${pluginId}/lib/${file}`);
    vm.runInContext(fs.readFileSync(abs, 'utf8'), sandbox, { filename: `${pluginId}/${file}` });
  }
  assert.ok(sandbox.__ULB__ && sandbox.__ULB__.astc && typeof sandbox.__ULB__.astc.decodeAstc === 'function',
    `${pluginId} 没有挂出 __ULB__.astc.decodeAstc`);
  return sandbox.__ULB__;
}

/**
 * 按 plugin.json 的 files[] 顺序装载一个插件的全部 lib 脚本（跳过 index.js —— 那是插件入口，
 * 需要 window.SpineViewerPlugins 才能注册）。
 *
 * 用它的场景只有一类：验证"分发接线"（texdecode → astc）。这时必须按生产的注入顺序装，
 * 否则测不出"astc.js 排在 texdecode.js 之后"这类顺序错误。
 */
function loadPluginLibs(pluginId) {
  const pluginDir = path.join(ROOT, 'plugins', pluginId);
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    TextDecoder, TextEncoder, setTimeout, clearTimeout, Blob, URL, performance,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const rel of manifest.files) {
    if (!rel.startsWith('lib/')) continue;
    const abs = path.join(pluginDir, rel);
    assert.ok(fs.existsSync(abs), `${pluginId} 的 files[] 里列了 ${rel}，但文件不存在`);
    vm.runInContext(fs.readFileSync(abs, 'utf8'), sandbox, { filename: `${pluginId}/${rel}` });
  }
  assert.ok(sandbox.__ULB__ && sandbox.__ULB__.texdecode, `${pluginId} 没有挂出 __ULB__.texdecode`);
  return sandbox.__ULB__;
}

/**
 * 解 PNG（只支持本测试需要的子集：8 bit、非隔行、RGB/RGBA/灰度）。
 * 为什么要自己解：夹具是 PNG（比裸 RGBA 小一个数量级），用 zlib + 反滤波就能读，
 *   不必为了读一张参考图引入图片库依赖。
 * @returns {{width:number, height:number, rgba:Uint8Array}}
 */
function decodePng(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert.equal(buffer.toString('latin1', 1, 4), 'PNG', `${path.basename(filePath)} 不是 PNG`);

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  assert.equal(bitDepth, 8, `参考 PNG 必须是 8 bit/通道（实际 ${bitDepth}）`);
  assert.equal(interlace, 0, '参考 PNG 不能是隔行扫描');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  assert.ok(channels > 0, `参考 PNG 的 colorType=${colorType} 本测试未支持（只支持 RGB/RGBA/灰度）`);

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let position = 0;
  let previousLine = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const filterType = raw[position++];
    const line = new Uint8Array(raw.subarray(position, position + stride));
    position += stride;
    // 反滤波：必须从左到右原地还原（后面的像素依赖左边已还原的值）
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels] : 0;
      const up = previousLine[x];
      const upLeft = x >= channels ? previousLine[x - channels] : 0;
      let value = line[x];
      if (filterType === 1) {
        value = (value + left) & 0xff;
      } else if (filterType === 2) {
        value = (value + up) & 0xff;
      } else if (filterType === 3) {
        value = (value + ((left + up) >> 1)) & 0xff;
      } else if (filterType === 4) {
        const estimate = left + up - upLeft;
        const distanceLeft = Math.abs(estimate - left);
        const distanceUp = Math.abs(estimate - up);
        const distanceUpLeft = Math.abs(estimate - upLeft);
        const predictor = distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft
          ? left
          : distanceUp <= distanceUpLeft ? up : upLeft;
        value = (value + predictor) & 0xff;
      } else if (filterType !== 0) {
        throw new Error(`未知 PNG 行滤波类型 ${filterType}`);
      }
      line[x] = value;
    }
    for (let x = 0; x < width; x++) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      if (channels === 1) {
        rgba[target] = line[source];
        rgba[target + 1] = line[source];
        rgba[target + 2] = line[source];
        rgba[target + 3] = 0xff;
      } else {
        rgba[target] = line[source];
        rgba[target + 1] = line[source + 1];
        rgba[target + 2] = line[source + 2];
        rgba[target + 3] = channels === 4 ? line[source + 3] : 0xff;
      }
    }
    previousLine = line;
  }
  return { width, height, rgba };
}

/** 把存储方向的 RGBA 竖翻成显示方向（参考 PNG 是显示方向） */
function flipVertically(rgba, width, height) {
  const stride = width * 4;
  const flipped = new Uint8Array(rgba.length);
  for (let y = 0; y < height; y++) {
    flipped.set(rgba.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
  }
  return flipped;
}

/**
 * 逐像素比较，返回差异统计。
 * @returns {{total:number, differing:number, maxChannelDiff:number, firstBad:object|null}}
 */
function comparePixels(actual, expected, width) {
  assert.equal(actual.length, expected.length, '像素数组长度必须相同');
  let differing = 0;
  let maxChannelDiff = 0;
  let firstBad = null;
  for (let i = 0; i < actual.length; i += 4) {
    let worst = 0;
    for (let channel = 0; channel < 4; channel++) {
      const diff = Math.abs(actual[i + channel] - expected[i + channel]);
      if (diff > worst) worst = diff;
    }
    if (worst > 0) {
      differing++;
      if (worst > maxChannelDiff) maxChannelDiff = worst;
      if (firstBad === null) {
        const pixel = i / 4;
        firstBad = {
          x: pixel % width,
          y: Math.floor(pixel / width),
          actual: Array.from(actual.subarray(i, i + 4)),
          expected: Array.from(expected.subarray(i, i + 4)),
        };
      }
    }
  }
  return { total: actual.length / 4, differing, maxChannelDiff, firstBad };
}

/** 断言"与参考图一致（容差 tolerance）"，失败时给出可读定位 */
function assertMatchesReference(decoded, fixture, tolerance) {
  const reference = decodePng(fixture.png);
  assert.equal(reference.width, fixture.width, '参考图宽与夹具声明不一致');
  assert.equal(reference.height, fixture.height, '参考图高与夹具声明不一致');
  const displayOrder = flipVertically(decoded, fixture.width, fixture.height);
  const stats = comparePixels(displayOrder, reference.rgba, fixture.width);
  assert.ok(stats.maxChannelDiff <= tolerance,
    `与参考图不一致：${stats.differing}/${stats.total} 个像素不同，最大通道差 ${stats.maxChannelDiff}`
    + `（容差 ${tolerance}），首个超差点 ${JSON.stringify(stats.firstBad)}`);
  return stats;
}

/** 读出夹具的压缩块数据 */
function readFixtureData(fixture) {
  return new Uint8Array(fs.readFileSync(fixture.astc));
}

/**
 * 把解码结果（RGBA、存储方向）转成参考实现的字节序（BGRA）并算 md5。
 * 这一步只换通道顺序，不改任何像素值，用来和"逐字节一致"的基准对齐。
 */
function bgraMd5(rgba) {
  const bgra = Buffer.alloc(rgba.length);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    bgra[offset] = rgba[offset + 2];
    bgra[offset + 1] = rgba[offset + 1];
    bgra[offset + 2] = rgba[offset];
    bgra[offset + 3] = rgba[offset + 3];
  }
  return crypto.createHash('md5').update(bgra).digest('hex');
}

// ---------------------------------------------------------------- 位操作小工具（构造测试块用）
//
// ASTC 的位号从第 1 个字节的最低位开始（bit 0 = byte0 & 1），与常见的大端位流相反。

function setBits(bytes, low, high, value) {
  for (let index = low; index <= high; index++) {
    const bit = (value >> (index - low)) & 1;
    const byteIndex = index >> 3;
    const mask = 1 << (index & 7);
    bytes[byteIndex] = bit ? (bytes[byteIndex] | mask) : (bytes[byteIndex] & ~mask);
  }
}

function getBits(bytes, low, high) {
  let value = 0;
  for (let index = high; index >= low; index--) {
    value = (value << 1) | ((bytes[index >> 3] >> (index & 7)) & 1);
  }
  return value >>> 0;
}

/**
 * 造一个 void-extent（常数色）块：整块只有一个颜色，合法且与块尺寸无关。
 * 布局：bit0..8 = 0x1FC、bit9 = 0（LDR）、bit12..63 = extent 全 1、bit64..127 = RGBA 各 16 bit。
 */
function makeVoidExtentBlock(red, green, blue, alpha) {
  const block = new Uint8Array(16);
  setBits(block, 0, 8, 0x1fc);
  setBits(block, 9, 9, 0);
  // extent 坐标 52 位全 1（表示"覆盖整块"）。JS 的位移只到 32 位，故逐位写。
  for (let index = 12; index <= 63; index++) {
    const byteIndex = index >> 3;
    block[byteIndex] |= 1 << (index & 7);
  }
  setBits(block, 64, 79, red * 257);      // 16 bit 的 0xRRRR（高字节即 8 bit 值）
  setBits(block, 80, 95, green * 257);
  setBits(block, 96, 111, blue * 257);
  setBits(block, 112, 127, alpha * 257);
  return block;
}

// ---------------------------------------------------------------- 用例

const NS = loadDecoder('unity-spine-bundle');
const { decodeAstc } = NS.astc;
const TEX_DECODE_CODE = NS.errors.CODES.TEXTURE_DECODE;
const UNSUPPORTED_CODE = NS.errors.CODES.TEXTURE_FORMAT_UNSUPPORTED;
const DATA_SHORT_CODE = NS.errors.CODES.TEXTURE_DATA_SHORT;

test('6x6（440x440，ASTC_RGB_6x6）与参考图逐像素一致（容差 ±1），且与参考实现逐字节相同', () => {
  const data = readFixtureData(FIXTURE_6X6);
  const decoded = decodeAstc(data, FIXTURE_6X6.width, FIXTURE_6X6.height, 6, 6);
  assert.equal(decoded.length, FIXTURE_6X6.width * FIXTURE_6X6.height * 4, '输出必须是 RGBA 长度 = w*h*4');
  const stats = assertMatchesReference(decoded, FIXTURE_6X6, 1);
  assert.equal(bgraMd5(decoded), FIXTURE_6X6.bgraMd5,
    `应与参考实现逐字节一致（PNG 对照里 ${stats.differing} 个像素在 ±1 内属参考图取整差）`);
});

test('5x5（1024x1024，ASTC_RGB_5x5）与参考图逐像素一致（容差 ±1），且与参考实现逐字节相同', () => {
  const data = readFixtureData(FIXTURE_5X5);
  const decoded = decodeAstc(data, FIXTURE_5X5.width, FIXTURE_5X5.height, 5, 5);
  assert.equal(decoded.length, FIXTURE_5X5.width * FIXTURE_5X5.height * 4);
  const stats = assertMatchesReference(decoded, FIXTURE_5X5, 1);
  assert.equal(bgraMd5(decoded), FIXTURE_5X5.bgraMd5,
    `应与参考实现逐字节一致（PNG 对照里 ${stats.differing} 个像素在 ±1 内属参考图取整差）`);
});

test('输出是存储方向：不做 flipY（翻转是 texdecode.decode 的职责）', () => {
  const data = readFixtureData(FIXTURE_6X6);
  const decoded = decodeAstc(data, FIXTURE_6X6.width, FIXTURE_6X6.height, 6, 6);
  const reference = decodePng(FIXTURE_6X6.png);
  const width = FIXTURE_6X6.width;
  const height = FIXTURE_6X6.height;
  // 存储方向的第一行 == 参考图（显示方向）的最后一行
  const firstRow = Array.from(decoded.subarray(0, width * 4));
  const lastReferenceRow = Array.from(reference.rgba.subarray((height - 1) * width * 4, height * width * 4));
  const allEqual = firstRow.every((value, index) => Math.abs(value - lastReferenceRow[index]) <= 1);
  assert.ok(allEqual, '第 0 行应当对应参考图的最后一行（说明没多做一次翻转）');
});

test('未支持的块尺寸 → 抛可读错误，不返回半成品', () => {
  const data = readFixtureData(FIXTURE_6X6);
  // 3x3 / 7x7 都是"表里没有的组合"；16x16 超过规格上限；0x5 是非法值
  for (const [blockWidth, blockHeight] of [[3, 3], [7, 7], [0, 5], [16, 16]]) {
    let error = null;
    try {
      decodeAstc(data, 440, 440, blockWidth, blockHeight);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, `块尺寸 ${blockWidth}x${blockHeight} 必须抛错`);
    assert.equal(error.code, UNSUPPORTED_CODE, `块尺寸 ${blockWidth}x${blockHeight} 的错误码`);
    assert.match(String(error.message), /块尺寸/, `错误文案要说清是块尺寸问题：${error.message}`);
  }
});

test('数据不足 → 抛「数据不足」错误，且带上需要/实际的字节数', () => {
  const data = readFixtureData(FIXTURE_6X6);
  const truncated = data.subarray(0, data.length - 16);
  let error = null;
  try {
    decodeAstc(truncated, 440, 440, 6, 6);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, '数据不足必须抛错');
  assert.equal(error.code, DATA_SHORT_CODE);
  assert.match(String(error.message), /87616/, '文案要给出需要的字节数');
  assert.match(String(error.message), new RegExp(String(truncated.length)), '文案要给出实际的字节数');
});

test('保留块模式（全 0 块）→ 抛「解码失败」，绝不静默填错误色', () => {
  // 16 个 0 字节：块模式低 4 位全 0 ⇒ 规格保留值，解码器应视为非法块
  const blocks = new Uint8Array(16 * 4); // 2x2 个 4x4 块
  let error = null;
  try {
    decodeAstc(blocks, 8, 8, 4, 4);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, '非法块必须抛错（不允许返回洋红色/黑色假图）');
  assert.equal(error.code, TEX_DECODE_CODE);
  assert.match(String(error.message), /块坐标 0,0/, '错误要带块坐标，便于定位是哪一格坏了');
});

test('HDR 端点模式 → 抛「格式未支持」并说明只做了 LDR', () => {
  const data = readFixtureData(FIXTURE_6X6);
  // 找一个单分区（bit11..12 = 0）、非 void-extent 的真实块，把端点模式改成 2（HDR 亮度）
  const blockCount = data.length / 16;
  let patchedIndex = -1;
  for (let index = 0; index < blockCount; index++) {
    const offset = index * 16;
    const block = data.subarray(offset, offset + 16);
    if (getBits(block, 0, 8) === 0x1fc) continue;
    if (getBits(block, 11, 12) !== 0) continue;
    patchedIndex = index;
    break;
  }
  assert.ok(patchedIndex >= 0, '夹具里应当能找到单分区块');
  const patched = Uint8Array.from(data);
  setBits(patched.subarray(patchedIndex * 16, patchedIndex * 16 + 16), 13, 16, 2);

  let error = null;
  try {
    decodeAstc(patched, FIXTURE_6X6.width, FIXTURE_6X6.height, 6, 6);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'HDR 端点模式必须抛错');
  assert.equal(error.code, UNSUPPORTED_CODE);
  assert.match(String(error.message), /HDR/, '文案要点明 HDR 未实现');
});

test('void-extent 常数色块：4x4 / 5x5 / 6x6 三种块尺寸都能解（纯色）', () => {
  const colors = [0x12, 0x34, 0x56, 0x78];
  for (const blockSize of [4, 5, 6]) {
    const blocksX = 2;
    const blocksY = 2;
    const data = new Uint8Array(blocksX * blocksY * 16);
    for (let index = 0; index < blocksX * blocksY; index++) {
      data.set(makeVoidExtentBlock(colors[0], colors[1], colors[2], colors[3]), index * 16);
    }
    const width = blockSize * blocksX;
    const height = blockSize * blocksY;
    const decoded = decodeAstc(data, width, height, blockSize, blockSize);
    assert.equal(decoded.length, width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel++) {
      const offset = pixel * 4;
      assert.deepEqual(
        [decoded[offset], decoded[offset + 1], decoded[offset + 2], decoded[offset + 3]],
        colors,
        `块尺寸 ${blockSize} 的常数色块解出来应是 ${colors}（像素 ${pixel}）`,
      );
    }
  }
});

test('两份 astc.js（spine / live2d 插件）逐字节相同', () => {
  const digests = PLUGIN_IDS.map((pluginId) => {
    const filePath = path.join(ROOT, 'plugins', pluginId, 'lib', 'astc.js');
    assert.ok(fs.existsSync(filePath), `缺少 ${pluginId}/lib/astc.js`);
    return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
  });
  assert.equal(digests[0], digests[1],
    `两份 astc.js 必须逐字节相同（${PLUGIN_IDS[0]}=${digests[0]} vs ${PLUGIN_IDS[1]}=${digests[1]}）`);
});

test('live2d 插件那份也能独立装载并解同一份数据（不是只有 spine 那份可用）', () => {
  const live2dNS = loadDecoder('unity-live2d-bundle');
  const data = new Uint8Array(fs.readFileSync(FIXTURE_6X6.astc));
  const decoded = live2dNS.astc.decodeAstc(data, FIXTURE_6X6.width, FIXTURE_6X6.height, 6, 6);
  const spineDecoded = decodeAstc(data, FIXTURE_6X6.width, FIXTURE_6X6.height, 6, 6);
  assert.deepEqual(Array.from(decoded.subarray(0, 4096)), Array.from(spineDecoded.subarray(0, 4096)));
});

test('分发接入：texdecode.decode 对 format 50 / 49 走 ASTC 解码器，产出与参考图一致（含统一 flipY）', () => {
  // 这条钉的是"接线"而不是解码本身：按 plugin.json 的 files[] 顺序装载（astc.js 在 texdecode.js 之前），
  //   再走 decoder 的真实入口 decode()。能过就说明 48~59 的登记、块边长取值、长度检查、统一翻转都通了。
  const NS2 = loadPluginLibs('unity-spine-bundle');
  for (const fixture of [FIXTURE_6X6, FIXTURE_5X5]) {
    const format = fixture.blockSize === 6 ? 50 : 49;
    assert.equal(NS2.texdecode.canDecode(format), true, `${NS2.texdecode.formatName(format)} 应可解码`);
    const data = readFixtureData(fixture);
    const decoded = NS2.texdecode.decode(
      { format, width: fixture.width, height: fixture.height, name: 'fixture' }, data);
    // texdecode 已经做过 flipY ⇒ 直接与"显示方向"的参考 PNG 比
    const reference = decodePng(fixture.png);
    const stats = comparePixels(decoded, reference.rgba, fixture.width);
    assert.ok(stats.maxChannelDiff <= 1,
      `format ${format} 经 texdecode 出图应与参考一致，实际最大通道差 ${stats.maxChannelDiff}`
      + `，首个超差点 ${JSON.stringify(stats.firstBad)}`);
  }
});
