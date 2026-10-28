// test/memory-peak-parity.test.mjs —— 两个插件的「LZMA 峰值表」必须一致（防漂移门禁）
//
// 为什么需要这条门禁：`LZMA_PEAK_POINTS` 现在是**同一物理事实的两处表达**
//   （unity-live2d-bundle/index.js 与 unity-spine-bundle/index.js 各一份）。
//   只改一边的表现极难定位：同一个包被 live2d 插件判"可解"、被 spine 插件判"超预算"，
//   或反过来——取决于哪个插件先到。按项目的防漂移纪律：**同一事实两处表达 ⇒ 用机器门禁钉死**。
//
// 另外钉住三件事：
//   ① 实测点必须被覆盖（预估 ≥ 实测），否则等于又回到"低估"；
//   ② LZ4 路径的老表**不许被这次改动带跑**（8.55MB 仍是 192MB）；
//   ③ 认不出压缩类型时必须按 LZMA 算（保守），不能退化成 LZ4。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePlugin } from '../src/server/unpack/plugin-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LIVE2D = path.join(ROOT, 'plugins', 'unity-live2d-bundle', 'index.js');
const SPINE = path.join(ROOT, 'plugins', 'unity-spine-bundle', 'index.js');

/** 从插件源码里抠出 LZMA 峰值表与余量常量（表在源码里，是唯一权威） */
function readPeakTable(file) {
  const src = fs.readFileSync(file, 'utf8');
  // 注意：表是嵌套数组（[[mb, peak], …]），所以不能用 [^\]]* —— 那样会在第一个内层 ] 处截断
  const m = /const\s+LZMA_PEAK_POINTS\s*=\s*(\[\s*\[[\s\S]*?\]\s*\])\s*;/.exec(src);
  assert.ok(m, `${path.basename(path.dirname(file))}: 没找到 LZMA_PEAK_POINTS 常量`);
  const margin = /const\s+PEAK_MARGIN\s*=\s*([0-9.]+)/.exec(src);
  assert.ok(margin, `${path.basename(path.dirname(file))}: 没找到 PEAK_MARGIN 常量`);
  return { points: JSON.parse(m[1].replace(/'/g, '"')), margin: Number(margin[1]) };
}

test('① 两个插件的 LZMA 峰值表与余量逐值相同（防漂移）', () => {
  const a = readPeakTable(LIVE2D);
  const b = readPeakTable(SPINE);
  assert.deepEqual(a.points, b.points, 'LZMA_PEAK_POINTS 必须一致（同一物理事实，两处表达）');
  assert.equal(a.margin, b.margin, 'PEAK_MARGIN 必须一致');
  // 表本身要有意义：升序、正数、至少两个实测点（单点无法构成拟合依据，斜率全靠猜）
  assert.ok(a.points.length >= 2, '至少要有两个实测点，否则不构成拟合依据');
  for (let i = 1; i < a.points.length; i += 1) {
    assert.ok(a.points[i][0] > a.points[i - 1][0], '解压量必须递增');
    assert.ok(a.points[i][1] > a.points[i - 1][1], '峰值必须随解压量递增');
  }
});

test('② 两个插件都把 LZMA 路由到同一个实现（而不是各写一套系数）', () => {
  for (const [label, file] of [['live2d', LIVE2D], ['spine', SPINE]]) {
    const src = fs.readFileSync(file, 'utf8');
    assert.match(src, /function\s+peakFromLzma\s*\(/, `${label}: 必须有 peakFromLzma 实现`);
    // 必须有"按压缩类型分流"的实际调用：peakFromLzma 真的被用到，且判据读了压缩类型
    assert.match(src, /peakFromLzma\(\s*decompressedMb\s*\)/, `${label}: 必须实际调用 peakFromLzma`);
    assert.match(src, /compressionType|summary\.compression/, `${label}: 必须读压缩类型来分流`);
  }
});

test('③ 实测点必须被覆盖：预估峰值 ≥ 每个实测值（否则又回到低估）', () => {
  const live = ensurePlugin('unity-live2d-bundle');
  assert.ok(live.ok, 'live2d 插件应能装载');
  const peak = live.api.peakFromDecompressed;
  assert.equal(typeof peak, 'function', '插件 api 应暴露 peakFromDecompressed');
  const { points } = readPeakTable(LIVE2D);
  for (const [mb, measured] of points) {
    const est = peak(mb, 1);
    assert.ok(est >= measured, `${mb}MB: 预估 ${est}MB 必须 ≥ 实测 ${measured}MB`);
  }
});

test('④ LZ4 老表不许被带跑：8.55MB 仍是 192MB（LZ4 路径行为不变）', () => {
  const live = ensurePlugin('unity-live2d-bundle');
  const peak = live.api.peakFromDecompressed;
  assert.equal(peak(8.55, 2), 192, 'LZ4 路径沿用原表');
  assert.equal(peak(2.76, 2), 147, 'LZ4 路径沿用原表（≤5MB 档）');
  // 而 LZMA 必须更高（这就是本次修复的核心）
  assert.ok(peak(8.55, 1) > peak(8.55, 2), 'LZMA 峰值必须高于 LZ4');
});

test('⑤ 认不出压缩类型时按 LZMA（保守）计算，不退化成 LZ4', () => {
  const live = ensurePlugin('unity-live2d-bundle');
  const peak = live.api.peakFromDecompressed;
  const lzma = peak(8.55, 1);
  assert.equal(peak(8.55, undefined), lzma, '不传类型 ⇒ 按 LZMA');
  assert.equal(peak(8.55, null), lzma, 'null ⇒ 按 LZMA');
  assert.equal(peak(8.55, -1), lzma, '混合类型(-1) ⇒ 按最保守的 LZMA');
  assert.equal(peak(8.55, 99), lzma, '未来新增类型 ⇒ 同样按 LZMA');
});

test('⑥ 单调不减：解压量增大，预估峰值不下降', () => {
  const live = ensurePlugin('unity-live2d-bundle');
  const peak = live.api.peakFromDecompressed;
  let prev = 0;
  for (let mb = 0.5; mb <= 60; mb += 0.5) {
    const v = peak(mb, 1);
    assert.ok(v >= prev, `${mb}MB 处峰值 ${v} 不得低于上一档 ${prev}`);
    prev = v;
  }
});
