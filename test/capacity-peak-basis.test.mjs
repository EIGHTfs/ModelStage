// test/capacity-peak-basis.test.mjs —— 准入峰值只信插件声明值；measured 仅作观测
//
// 为什么单独立一条门禁：这一科决定"放行还是拒绝"，而且历史上方向写错过一次。
//   历史（搬 worker 之前）：`recordMeasuredPeak` 的实测值是 `before.rss + max(0, VmHWM增量)`，
//     VmHWM 只增不减 ⇒ 它反映"本次把峰值顶高多少 + 当时进程已占多少"，**不是这一包的成本**；
//     当时的方向是"measured 高于声明就信它（取 max）"。
//   现在（解包搬进 worker 后）：起始 RSS 变成含 worker 常驻内存（独立 isolate +
//     预热装载的插件 lib），同一个包从 136.7MB 抬到 212~225MB（+55~65%），预热也只压掉小幅台阶。
//     ⇒ 一个随执行线程/首个包变化的数不能当准入依据，否则同样大小的包"有时过有时不过"。
//     故改为 **declared 单判**，measured 只回传供观测（probe.json / 日志 / 前端提示）。
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

test('② measured > declared ⇒ **仍取 declared**（basis=plugin-peak）；measured 只回传供观测', () => {
  // 口径变更（实测取证）：解包搬进 worker 后 measured 的起始 RSS 含 worker 常驻内存，
  //   同一个包从 136.7MB 抬到 212~225MB（+55~65%），且随"在哪个线程/是不是该线程第一个包"变化。
  //   ⇒ 它不再参与准入，只保留在返回值里供 probe/日志/前端观测。
  const r = estimatePeakWithBasis(1.9, { peakBytes: 654 * MB, measuredPeakBytes: 1195 * MB });
  assert.equal(r.peakEstMb, 654, 'measured 不再抬高准入，准入只信声明值');
  assert.equal(r.basis, 'plugin-peak');
  assert.equal(r.measuredMb, Math.ceil(1195 * 1.05), 'measured 仍回传（观测用，带 5% 波动余量）');
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
