// test/pma-detect.test.mjs —— PMA 判定与兜底（口径：检测不出 ⇒ 按已预乘）
//
// 背景：auto 档有三种结论，必须分开处理：
//   · 明确预乘   → premultiplied（不再乘）
//   · 明确非预乘 → upload（上传时预乘一次）
//   · **检测不出** → 按已预乘（init-default / safe-fallback / atlas 未声明三条兜底都为 true）
// 为什么检测不出要选"已预乘"：失败代价不对称——兜成"非预乘"会给已预乘的图**再乘一次**（明显黑圈）；
//   兜成"已预乘"最多是直通图混合略暗。少乘远比多乘可接受。
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPma, resolvePmaInfo, detectPmaFromImageData } from '../src/web/engine/pma.js';

test('resolvePmaInfo：三态分开（明确预乘/明确非预乘/检测不出）', () => {
  assert.equal(resolvePmaInfo('auto', { finalIsPremultiplied: true }, false).effectiveMode, 'premultiplied');
  assert.equal(resolvePmaInfo('auto', { finalIsPremultiplied: true }, false).needPremultiply, false);

  assert.equal(resolvePmaInfo('auto', { finalIsPremultiplied: false }, false).effectiveMode, 'upload');
  assert.equal(resolvePmaInfo('auto', { finalIsPremultiplied: false }, false).needPremultiply, true);

  // 检测不出：undefined / null 字段 都必须按"已预乘"
  for (const det of [undefined, null, { finalIsPremultiplied: null }]) {
    const r = resolvePmaInfo('auto', det, false);
    assert.equal(r.effectiveMode, 'premultiplied', `检测不出（${JSON.stringify(det)}）应按已预乘`);
    assert.equal(r.needPremultiply, false, '检测不出时不能再预乘一次（多乘 = 黑圈）');
  }
});

test('resolvePmaInfo：显式档位不受兜底影响', () => {
  assert.equal(resolvePmaInfo('upload', { finalIsPremultiplied: true }, false).needPremultiply, true);
  assert.equal(resolvePmaInfo('premultiplied', { finalIsPremultiplied: false }, false).needPremultiply, false);
  const degraded = resolvePmaInfo('straight', { finalIsPremultiplied: true }, false);
  assert.equal(degraded.effectiveMode, 'upload', '运行时不支持直通 ⇒ 降级为 upload');
  assert.equal(degraded.degraded, true);
});

test('detectPma：像素不足且 atlas 未声明 ⇒ 按已预乘（safe-fallback）', () => {
  const d = detectPma({ atlasDeclared: null, filenameHint: null, samples: [] });
  assert.equal(d.pixelDetected, null, '没有像素样本 ⇒ 无像素结论');
  assert.equal(d.finalIsPremultiplied, true, '无任何线索时按已预乘');
});

test('detectPma：像素不足但 atlas 声明了 ⇒ 以 atlas 为准', () => {
  assert.equal(detectPma({ atlasDeclared: false, filenameHint: null, samples: [] }).finalIsPremultiplied, false);
  assert.equal(detectPma({ atlasDeclared: true, filenameHint: null, samples: [] }).finalIsPremultiplied, true);
});

test('detectPmaFromImageData：全透明/全不透明都不给结论（两种模式数学上不可区分）', () => {
  const allOpaque = { data: new Uint8ClampedArray(4 * 100).fill(255) };
  assert.equal(detectPmaFromImageData(allOpaque).isPremultiplied, null, '全不透明 ⇒ 无结论');

  const allClear = { data: new Uint8ClampedArray(4 * 100) };   // 全 0：a=0
  assert.equal(detectPmaFromImageData(allClear).isPremultiplied, null, '全透明 ⇒ 无结论');
});

test('detectPmaFromImageData：半透明像素里 r>a 判非预乘，r<=a 判预乘', () => {
  const n = 400;
  const mk = (r, a) => { const d = new Uint8ClampedArray(n * 4); for (let i = 0; i < n; i += 1) { d[i * 4] = r; d[i * 4 + 3] = a; } return { data: d }; };
  // 半透明区里 r 明显大于 a ⇒ 直通 alpha
  assert.equal(detectPmaFromImageData(mk(200, 100)).isPremultiplied, false);
  // r 不超过 a ⇒ 预乘
  assert.equal(detectPmaFromImageData(mk(80, 100)).isPremultiplied, true);
});
