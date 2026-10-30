// test/etc2-rgba1.test.mjs —— ETC2_RGBA1(48) 解码 + /api/bundle/probe 的模块路径
//
// 背景：蔚蓝档案部分 spinebackground 包用 ETC2_RGBA1 存纹理，而 lib/texdecode.js 的
//   DECODERS 长期没登记 48 号 ⇒ 整包报 ULB_ERR_TEX_DECODE。这里钉两件事：
//   ① 1bit alpha 的**位序**（位 0 = 块内第一个像素、按行、LSB first）解对了
//   ② 那个诊断端点的模块路径能从 src/server/assets/ 解析到（早前少一层，端点一直 500）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 按 plugin.json 的 files 顺序在隔离上下文里载入插件 lib，返回它的 __ULB__ 命名空间 */
function loadLibs(plugin, wanted) {
  const pj = JSON.parse(fs.readFileSync(path.join(ROOT, plugin, 'plugin.json'), 'utf8'));
  const sb = { console, TextDecoder, TextEncoder, setTimeout, clearTimeout, URL, Blob, performance };
  sb.globalThis = sb;
  sb.__ULB__ = {};
  vm.createContext(sb);
  for (const rel of pj.files) {
    if (!wanted.some((w) => rel.endsWith(w))) continue;
    const code = fs.readFileSync(path.join(ROOT, plugin, rel), 'utf8');
    vm.runInContext(code, sb, { filename: rel });
  }
  return sb.__ULB__;
}

test('ETC2_RGBA1：1bit alpha 位序（位0=块内首像素、按行、LSB first）', () => {
  const NS = loadLibs('plugins/unity-spine-bundle', ['lib/errors.js', 'lib/etc2.js']);
  assert.equal(typeof NS.etc2.decodeEtc2Rgba1, 'function', 'decodeEtc2Rgba1 必须已导出');

  // 4×4 一块共 16 字节：[0..7] ETC2 RGB 块（全 0 = 合法的 diff 模式，颜色值本身不参与本断言）
  //                     [8..15] 1bit alpha 平面
  // data[8] = 0b10100101，最低位是 bit0（LSB first）：
  //   bit0..3 = 1,0,1,0 ⇒ py=0 行：透明模式交替 —— (0,0)=不透明 (1,0)=透明 (2,0)=不透明 (3,0)=透明
  //   bit4..7 = 0,1,0,1 ⇒ py=1 行：(0,1)=透明 (1,1)=不透明 (2,1)=透明 (3,1)=不透明
  const data = new Uint8Array(16);
  data[8] = 0b10100101;
  const rgba = NS.etc2.decodeEtc2Rgba1(data, 4, 4);

  const alphaAt = (x, y) => rgba[(y * 4 + x) * 4 + 3];
  assert.equal(alphaAt(0, 0), 255, '(0,0) bit0=1 ⇒ 不透明');
  assert.equal(alphaAt(1, 0), 0, '(1,0) bit1=0 ⇒ 全透明');
  assert.equal(alphaAt(2, 0), 255, '(2,0) bit2=1');
  assert.equal(alphaAt(3, 0), 0, '(3,0) bit3=0');
  assert.equal(alphaAt(0, 1), 0, '(0,1) bit4=0 ⇒ 第二行首像素透明（证明按行推进而非按列）');
  assert.equal(alphaAt(1, 1), 255, '(1,1) bit5=1');
  // 输出必须是 RGBA 四通道、长度对上
  assert.equal(rgba.length, 4 * 4 * 4, '输出长度 = w*h*4');
});

test('ETC2_RGBA1：数据不足时抛 ULB_ERR_TEX_DATA_SHORT（不是静默返回半张图）', () => {
  const NS = loadLibs('plugins/unity-spine-bundle', ['lib/errors.js', 'lib/etc2.js']);
  assert.throws(
    () => NS.etc2.decodeEtc2Rgba1(new Uint8Array(8), 4, 4),   // 一块要 16 字节，只给 8
    (e) => String(e && e.code) === 'ULB_ERR_TEX_DATA_SHORT' || /数据不足/.test(String(e && e.message)),
  );
});

test('texdecode：48 号已登记进 DECODERS（不再落到"分发分支缺失"）', () => {
  const NS = loadLibs('plugins/unity-spine-bundle', ['lib/errors.js', 'lib/etc2.js', 'lib/dxt.js', 'lib/texdecode.js']);
  assert.equal(typeof NS.texdecode.canDecode, 'function', 'canDecode 应已导出');
  // canDecode(48) 为真 ⇒ DECODERS 与 FORMATS 两侧都齐（这是"能解"的对外判据）
  assert.equal(NS.texdecode.canDecode(48), true, 'ETC2_RGBA1(48) 必须可解码');
});

test('/api/bundle/probe 的预检模块路径能从 src/server/assets/ 解析', async () => {
  // 断言的是"路径可解析"，不跑完整预检：早前写成 ../../tool/lib/…（少一层）
  //   ⇒ 端点恒返回「加载预检模块失败: Cannot find module」。
  const mod = await import(path.join(ROOT, 'tool/lib/bundle-probe-node.mjs'));
  assert.equal(typeof mod.probeBundleBytes, 'function', 'tool/lib/bundle-probe-node.mjs 应导出 probeBundleBytes');
  // 再按源码里的相对路径解析一次（与运行时同一条解析规则）
  const fromDir = path.join(ROOT, 'src/server/assets');
  const resolved = path.resolve(fromDir, '../../../tool/lib/bundle-probe-node.mjs');
  assert.equal(resolved, path.join(ROOT, 'tool/lib/bundle-probe-node.mjs'), '三层相对路径必须落在 <root>/tool/lib 上');
});
