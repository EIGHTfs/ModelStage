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
import { detectPma, resolvePmaInfo, detectPmaFromImageData, shouldPremultiplyOnUpload, planTextureUpload, planBlend } from '../src/web/engine/pma.js';

// 混合口径（premultiplied / straight）同样只从 decision 派生，只回答"按预乘还是直通混合"。
//   "要不要改写 blendFunc"不在这里：那个判断在 blend.js 的 installBlendHooks 内部按 blendMode 做，
//   这里再暴露一个字段就是第二份平行语义（早前版本有过 needHook，已删）。
test('planBlend：三档混合口径 + 热路径零分配', () => {
  assert.equal(planBlend(resolvePmaInfo('auto', { finalIsPremultiplied: true }, false)).premultiplied, true, '源图预乘 ⇒ 预乘混合');
  assert.equal(planBlend(resolvePmaInfo('auto', { finalIsPremultiplied: false }, false)).premultiplied, true, 'upload 路径 ⇒ 也是预乘混合');
  assert.equal(planBlend(resolvePmaInfo('auto', { finalIsPremultiplied: false }, true)).premultiplied, false, 'straight 路径 ⇒ 直通混合');

  assert.deepEqual(Object.keys(planBlend({ blendMode: 'straight' })), ['premultiplied'], '返回值只有 premultiplied 一个字段');

  // planBlend 每帧都被调用 ⇒ 必须返回共享常量，不能每帧 new
  assert.equal(planBlend({ blendMode: 'straight' }), planBlend({ blendMode: 'straight' }), '同档位必须返回同一对象（零分配）');
  assert.equal(planBlend({ blendMode: 'premultiplied' }), planBlend({ blendMode: 'premultiplied' }), '同档位必须返回同一对象（零分配）');
  assert.equal(planBlend(undefined).premultiplied, false, 'pmaInfo 缺失 ⇒ 按直通（与旧表达式 !!(...) 的 false 一致）');
});

// pmaFlag 的语义：**上传完成后 GPU 上的数据是否预乘**（不是"源图是否预乘"）。
//   早前写成 `effectiveMode === 'premultiplied'`，把 upload 路径也标成 false —— 与它其实已乘过自相矛盾。
test('planTextureUpload：unpack 与 pmaFlag 都从 decision 派生，三档各钉一条', () => {
  const pm = planTextureUpload(resolvePmaInfo('auto', { finalIsPremultiplied: true }, false));
  assert.deepEqual(pm, { unpack: false, pmaFlag: true }, '源图已预乘 ⇒ 不乘，上传后仍是预乘');

  const up = planTextureUpload(resolvePmaInfo('auto', { finalIsPremultiplied: false }, false));
  assert.deepEqual(up, { unpack: true, pmaFlag: true }, 'upload 路径 ⇒ 乘一次，乘完就是预乘（pmaFlag 必须是 true）');

  const st = planTextureUpload(resolvePmaInfo('auto', { finalIsPremultiplied: false }, true));
  assert.deepEqual(st, { unpack: false, pmaFlag: false }, 'straight 路径 ⇒ 原样，数据仍是直通');
});

// 上传口径（unpack 与否）必须由 needPremultiply 决定 —— 三种输入各钉一条。
//   这三条直接对应三块真实资产：
//     · Nikke c072_00（atlas pma:true）        —— 源图已预乘，再乘就是黑圈
//     · 碧蓝档案 airi0_home（3.8，不支持直通） —— 源图 straight，必须乘，否则白斑
//     · 棕色尘埃2 / 4.1+ 的 straight 资源      —— 源图 straight，走 straight 混合，不许乘
test('shouldPremultiplyOnUpload：三种输入（源图预乘 / straight+不支持直通 / straight+支持直通）', () => {
  // ① 源图已预乘（atlas pma:true）⇒ 上传必须原样
  const pm = resolvePmaInfo('auto', { finalIsPremultiplied: true }, false);
  assert.equal(pm.effectiveMode, 'premultiplied');
  assert.equal(shouldPremultiplyOnUpload(pm), false, '源图已预乘时上传不许再乘（多乘 = 明显黑圈）');

  // ② 源图 straight + 运行时不支持直通（Spine 3.8）⇒ 必须乘一次
  //    这是本次修的白斑根因：要求预乘却没乘 ⇒ GPU 上是直通数据，却按预乘混合绘制。
  const up = resolvePmaInfo('auto', { finalIsPremultiplied: false }, false);
  assert.equal(up.effectiveMode, 'upload');
  assert.equal(up.needPremultiply, true);
  assert.equal(shouldPremultiplyOnUpload(up), true, 'upload 路径必须真的乘一次，否则直通数据配预乘混合 ⇒ 白斑');

  // ③ 源图 straight + 运行时支持直通（4.1+）⇒ 不许乘
  const st = resolvePmaInfo('auto', { finalIsPremultiplied: false }, true);
  assert.equal(st.effectiveMode, 'straight');
  assert.equal(shouldPremultiplyOnUpload(st), false, 'straight 路径上传必须原样（乘了就和 straight blend 错配）');

  // ④ 显式档位同样遵此口径
  assert.equal(shouldPremultiplyOnUpload(resolvePmaInfo('upload', null, false)), true, '显式 upload 档要乘');
  assert.equal(shouldPremultiplyOnUpload(resolvePmaInfo('premultiplied', { finalIsPremultiplied: false }, false)), false, '显式 premultiplied 档不乘');
  assert.equal(shouldPremultiplyOnUpload(resolvePmaInfo('straight', null, true)), false, '显式 straight 档不乘');

  // ⑤ 字段缺失/类型不对一律不乘 —— 与 auto 兜底同一条"失败代价不对称"：
  //    少乘最多混合略暗，多乘是明显黑圈。
  assert.equal(shouldPremultiplyOnUpload(undefined), false);
  assert.equal(shouldPremultiplyOnUpload(null), false);
  assert.equal(shouldPremultiplyOnUpload({}), false);
  assert.equal(shouldPremultiplyOnUpload({ needPremultiply: 'yes' }), false, '非布尔真值不算"要求预乘"');
});

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

test('resolvePmaInfo：auto+非预乘 且运行时支持直通 ⇒ 与显式 straight 逐字段相同', () => {
  // 这条是本次修的核心：能力允许时，"自动"不该比"用户强制选非预乘"多做一次预乘。
  //   不做的话同一张图两种档位出两种画面（实测：面部/眼周白斑）。
  const auto = resolvePmaInfo('auto', { finalIsPremultiplied: false }, true);
  const forced = resolvePmaInfo('straight', { finalIsPremultiplied: false }, true);
  assert.deepEqual(auto, forced, 'auto 与显式 straight 必须给出同一个对象');
  assert.equal(auto.effectiveMode, 'straight');
  assert.equal(auto.needPremultiply, false);
  assert.equal(auto.blendMode, 'straight');
  assert.equal(auto.degraded, false, '这是正常路径，不是降级');
});

test('resolvePmaInfo：auto+非预乘 但运行时**不支持**直通 ⇒ 仍 upload（与改前逐字段相同）', () => {
  const r = resolvePmaInfo('auto', { finalIsPremultiplied: false }, false);
  assert.deepEqual(r, {
    effectiveMode: 'upload', needPremultiply: true, blendMode: 'premultiplied',
    runtimeSupportsStraight: false, degraded: false,
  });
});

test('resolvePmaInfo：auto+已预乘/检测不出 ⇒ premultiplied 且不预乘（与运行时能力无关）', () => {
  for (const sup of [true, false]) {
    for (const det of [{ finalIsPremultiplied: true }, { finalIsPremultiplied: null }, undefined, null]) {
      const r = resolvePmaInfo('auto', det, sup);
      assert.equal(r.effectiveMode, 'premultiplied', `auto=${JSON.stringify(det)} sup=${sup} 应按已预乘`);
      assert.equal(r.needPremultiply, false, '已预乘/检测不出都不能再乘一次（多乘 = 黑圈）');
    }
  }
});

test('resolvePmaInfo：显式三档在两种能力下逐字段不变（回归）', () => {
  for (const sup of [true, false]) {
    assert.deepEqual(resolvePmaInfo('premultiplied', { finalIsPremultiplied: false }, sup), {
      effectiveMode: 'premultiplied', needPremultiply: false, blendMode: 'premultiplied',
      runtimeSupportsStraight: sup, degraded: false,
    });
    assert.deepEqual(resolvePmaInfo('upload', { finalIsPremultiplied: true }, sup), {
      effectiveMode: 'upload', needPremultiply: true, blendMode: 'premultiplied',
      runtimeSupportsStraight: sup, degraded: false,
    });
    const st = resolvePmaInfo('straight', { finalIsPremultiplied: true }, sup);
    assert.deepEqual(st, sup
      ? { effectiveMode: 'straight', needPremultiply: false, blendMode: 'straight', runtimeSupportsStraight: true, degraded: false }
      : { effectiveMode: 'upload', needPremultiply: true, blendMode: 'premultiplied', runtimeSupportsStraight: false, degraded: true });
  }
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
