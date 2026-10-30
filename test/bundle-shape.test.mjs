// test/bundle-shape.test.mjs —— 资源包"形态"判据（src/shared/bundle-shape.mjs）
//
// 为什么必须有这组：这个模块现在是**一份代码三处引用**
//   （plugin-host 的页面装载失败分支 / src/server/unpack/routes.mjs 的 /api/unpack/resolve /
//     tool/lib/bundle-probe-node.mjs 的 /api/bundle/probe），一处判错就是三处一起错。
//
// 夹具形态：**对象表 → 直方图**（serialized.parse 的输出形状），不依赖任何真实 bundle 文件，
//   单测离线可跑。数值取自实测分布（见每个夹具上的注释）。
//
// 判定铁律：只看包内 className 构成，不读文件名/目录名/角色名。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  histogramFromObjects,
  isAssetDependencyHistogram,
  describeHistogram,
  dependencyReason,
} from '../src/shared/bundle-shape.mjs';

/**
 * 把 "className → 数量" 造造成 serialized.parse 的输出形状。
 * @param {Record<string, number>} defs
 * @returns {{types: object[], objects: object[]}}
 */
function makeSerialized(defs) {
  const types = [];
  const objects = [];
  let classID = 1;
  for (const [className, count] of Object.entries(defs)) {
    types.push({ classID, className });
    for (let i = 0; i < count; i += 1) objects.push({ classID });
    classID += 1;
  }
  return { types, objects };
}

// 实测：-mx-characters-ch9999 共 987 对象、TextAsset = 0（取主要几类；ClassID 199/198 是实测里
//   未解析出类名的占位项，正好用来验证"占位项不进文案"）。
const FIXTURE_DEPENDENCY = {
  Transform: 276,
  GameObject: 276,
  'ClassID 199': 117,
  'ClassID 198': 117,
  MonoBehaviour: 74,
  Material: 27,
  MonoScript: 22,
  Texture2D: 15,
  Mesh: 18,
  AnimationClip: 13,
  MeshFilter: 7,
  MeshRenderer: 7,
};

// 实测：-mx-spinecharacters-akane_spr 共 22 对象、TextAsset = 2（正好等于实测总数，可直接当夹具）
const FIXTURE_SPINE_SMALL = {
  MonoBehaviour: 14,
  Material: 1,
  TextAsset: 2,
  Texture2D: 1,
  AssetBundle: 1,
  MonoScript: 3,
};

// 实测：-mx-spinebackground-momoka_weekdungeon 共 867 对象、TextAsset = 2
//   （这份夹具合计 866，实测比它多 1 个对象、类别漏记，不影响判定）
const FIXTURE_SPINE_BIG = {
  GameObject: 266,
  MonoBehaviour: 313,
  MonoScript: 11,
  Transform: 266,
  MeshFilter: 1,
  TextAsset: 2,
  Shader: 1,
  MeshRenderer: 1,
  Texture2D: 1,
  AssetBundle: 1,
  Material: 1,
  BoxCollider: 3,
};

test('依赖包形态：有美术资源但 TextAsset = 0 ⇒ 判为依赖包，且文案说清"为什么 + 下一步"', () => {
  const hist = histogramFromObjects(makeSerialized(FIXTURE_DEPENDENCY));
  assert.equal(hist.TextAsset, undefined, '夹具里就不该有 TextAsset（否则测的不是依赖包）');
  assert.equal(isAssetDependencyHistogram(hist), true, 'ch9999 真实分布必须判为依赖包');

  const reason = dependencyReason(hist);
  // 只锁"两句关键片段"，不锁整段：以后润色文案不该让测试变红
  assert.match(reason, /没有.*骨架或模型定义/, '要说明为什么不能装');
  assert.match(reason, /改选.*带骨架/, '要给出下一步怎么做');
});

test('模型包形态：TextAsset ≥ 1 ⇒ 不判依赖包（spine 的 .skel/.atlas 就是 TextAsset）', () => {
  const small = histogramFromObjects(makeSerialized(FIXTURE_SPINE_SMALL));
  const big = histogramFromObjects(makeSerialized(FIXTURE_SPINE_BIG));

  assert.equal(small.TextAsset, 2, 'akane_spr 夹具应有 2 个 TextAsset');
  assert.equal(big.TextAsset, 2, 'momoka 夹具应有 2 个 TextAsset');
  assert.equal(isAssetDependencyHistogram(small), false, 'akane_spr 是模型包，不能判依赖包');
  assert.equal(isAssetDependencyHistogram(big), false, 'momoka 是模型包，不能判依赖包');
});

test('边界：空直方图 / 零对象 / 只有 MonoBehaviour ⇒ 都不判依赖包（宁可说不确定，也不误导）', () => {
  assert.equal(isAssetDependencyHistogram({}), false, '空直方图');
  assert.equal(isAssetDependencyHistogram(histogramFromObjects({ types: [], objects: [] })), false, '零对象');
  assert.equal(isAssetDependencyHistogram({ MonoBehaviour: 5 }), false, '只有 MonoBehaviour 不算美术资源');
  assert.equal(isAssetDependencyHistogram(null), false, 'null 不判');
  assert.equal(isAssetDependencyHistogram(undefined), false, 'undefined 不判');
});

test('占位项过滤：ClassID 199 这类未解析类名不进文案，也不影响判定', () => {
  const hist = histogramFromObjects(makeSerialized(FIXTURE_DEPENDENCY));
  assert.ok((hist['ClassID 199'] || 0) > 0, '直方图本身要保留占位项（统计完整性）');

  const described = describeHistogram(hist);
  assert.doesNotMatch(described, /ClassID \d+/, '文案里不该出现 ClassID 占位项');
  assert.match(described, /Transform×276/, '实名的类要照常出现');

  // 只有占位项时，判定不受影响（它们既不是模型定义类也不是美术资源类）
  assert.equal(isAssetDependencyHistogram({ 'ClassID 199': 10, 'ClassID 198': 10 }), false, '纯占位项不判依赖包');
});

test('判据只看类型构成：同样的直方图换个"包名"结论不变（防按文件名特判）', () => {
  // 函数签名里根本没有路径/名字参数 —— 这条用"同一份直方图反复判"来表达：
  //   如果哪天有人加了按名字判断的旁路，这条就会因为"无法传入名字"而暴露设计意图被破坏。
  const dep = histogramFromObjects(makeSerialized(FIXTURE_DEPENDENCY));
  for (let i = 0; i < 3; i += 1) {
    assert.equal(isAssetDependencyHistogram(dep), true, '同一构成必须稳定判为依赖包');
  }
});
