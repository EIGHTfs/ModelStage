// test/capacity-peak-basis.test.mjs —— 准入峰值取值：measured 只许抬、不许压
//
// 为什么单独立一条门禁：这一科决定"放行还是拒绝"，而且方向极易写反。
//   背景（实测取证）：`recordMeasuredPeak` 的实测值是 `before.rss + max(0, VmHWM增量)`，
//   而 VmHWM 只增不减 ⇒ 这个数反映"本次把峰值顶高多少 + 当时进程已占多少"，**不是这一包的成本**；
//   同进程连续解包时后续包 delta 退化为 0。实测：同一进程两个 21MB 包分别报 225MB / 1195MB，
//   而干净进程测同一包是 654MB。
//   ⇒ measured 会**低估**，所以它不能替代声明值；但它高于声明时说明这包确实更贵，该信它。
//   方向不对称：低估=放行=OOM；高估=被拒/排队。因此取 max。
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimatePeakWithBasis } from '../src/server/unpack/capacity.mjs';

const MB = 1024 * 1024;

test('① measured < declared ⇒ 取 declared，basis=plugin-peak（实测不得压低声明）', () => {
  // 真实夹具：21MB 包声明 654MB，但某次进程内实测只有 225MB（进程状态造成的低估）
  const r = estimatePeakWithBasis(1.9, { peakBytes: 654 * MB, measuredPeakBytes: 225 * MB });
  assert.equal(r.peakEstMb, 654, '必须取声明值 654，不能被 225 压低');
  assert.equal(r.basis, 'plugin-peak');
});

test('② measured > declared ⇒ 取 measured，basis=measured（实测更高说明这包真更贵）', () => {
  // 真实夹具：同一条目另一次实测 1195MB > 声明 654MB
  const r = estimatePeakWithBasis(1.9, { peakBytes: 654 * MB, measuredPeakBytes: 1195 * MB });
  assert.equal(r.peakEstMb, Math.ceil(1195 * 1.05), 'measured 侧带 5% 环境波动余量');
  assert.equal(r.basis, 'measured');
});

test('③ 没有 measured ⇒ 走 declared，行为与原逻辑一致', () => {
  const r = estimatePeakWithBasis(1.9, { peakBytes: 500 * MB });
  assert.equal(r.peakEstMb, 500);
  assert.equal(r.basis, 'plugin-peak');
});

test('④ 既没有声明也没有实测 ⇒ 退回源包大小分段粗估（basis=legacy-source）', () => {
  const r = estimatePeakWithBasis(42, {});
  assert.equal(r.basis, 'legacy-source');
  assert.ok(r.peakEstMb > 0, '必须给出一个正整数估计');
});

test('⑤ 边界：measured 与 declared 相等时取 declared（basis 不漂成 measured）', () => {
  // ceil(300×1.05)=315 > 300，所以用 measured=285 → ceil(299.25)=300 与 declared 相等
  const r = estimatePeakWithBasis(1, { peakBytes: 300 * MB, measuredPeakBytes: 285 * MB });
  assert.equal(r.peakEstMb, 300);
  assert.equal(r.basis, 'plugin-peak', '相等时不应标成 measured（避免 basis 语义漂移）');
});
