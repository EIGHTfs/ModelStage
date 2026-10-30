// shared/bundle-shape.mjs —— 资源包"形态"的**唯一判据**（前端 plugin-host 与 node 侧 probe 共用这一份）
//
// 回答一个问题：这个 UnityFS 包里到底有没有"模型定义"，还是只有美术资源？
//   · 有模型定义类（TextAsset / SkeletonDataAsset / AtlasAsset / CubismModel / CubismMoc）
//     ⇒ 是模型包，交给对应插件去解
//   · 只有纹理/材质/网格/动画片段、一个模型定义类都没有
//     ⇒ 是**美术依赖包**：它给同批的模型包提供共享资源，本身不可单独装载
//
// 为什么必须共用一份：同一类包在"页面点开"与"直接调 /api/unpack/resolve"两条路径上
//   必须给同一个答案；判据或文案复制两份，早晚会漂。
//
// 铁律：**只看包内 className 构成**，不读文件名、不读目录名、不读角色名 ——
//   按名字判断等于给某几个具体资源开后门，换个游戏就失效。

/** 能"定义模型"的类：出现任一即视为模型包 */
export const MODEL_DEFINING_CLASSES = [
  'TextAsset',          // spine 的 .skel.txt / .atlas.txt；Cubism 的 model3.json / physics3.json
  'SkeletonDataAsset',  // spine-unity 的资产类
  'AtlasAsset',         // spine-unity 的资产类
  'CubismModel',        // Live2D 的资产类
  'CubismMoc',          // Live2D 的资产类
];

/** 纯美术资源类：这些有、上面一个都没有 ⇒ 依赖包 */
export const PURE_ART_CLASSES = [
  'Texture2D', 'Sprite', 'Material', 'Mesh', 'AnimationClip', 'MeshFilter', 'MeshRenderer', 'Shader',
];

/**
 * 从（serialized.parse 的）对象表算 className 直方图。
 * 两侧注入各自"怎么拿到对象表"的方式，但**统计规则就是这一份**。
 * @param {{objects?: object[], types?: object[]}} sf serialized 解析结果
 * @returns {Record<string, number>} className → 数量
 */
export function histogramFromObjects(sf) {
  const objects = (sf && sf.objects) || [];
  const types = (sf && sf.types) || [];
  const byId = new Map();
  for (const t of types) byId.set(t.classID, t.className || t.name);
  const hist = {};
  for (const obj of objects) {
    const name = byId.get(obj.classID) || `ClassID ${obj.classID}`;
    hist[name] = (hist[name] || 0) + 1;
  }
  return hist;
}

/**
 * 这个直方图是否描述"美术依赖包"。
 * @param {Record<string, number>} hist
 * @returns {boolean}
 */
export function isAssetDependencyHistogram(hist) {
  if (!hist) return false;
  if (MODEL_DEFINING_CLASSES.some((k) => (hist[k] || 0) > 0)) return false;
  return PURE_ART_CLASSES.some((k) => (hist[k] || 0) > 0);
}

/**
 * 直方图压成一句可读的类型构成（只报数量最多的前几类，避免文案过长）。
 * 过滤掉 `ClassID 199` 这类占位项：类名没解析出来时对用户没有解释力，
 *   把它们列进文案只会让人以为"这东西有名字但没显示"。
 */
export function describeHistogram(hist) {
  return Object.entries(hist || {})
    .filter(([k]) => !/^ClassID \d+$/.test(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k}×${v}`)
    .join('、');
}

/**
 * 依赖包的统一文案（前端 toast / 日志、服务端 JSON 都引用它，保证逐字一致）。
 * 要求：说清"为什么打不开" + "下一步怎么做"。
 * @param {Record<string, number>} hist
 * @returns {string}
 */
export function dependencyReason(hist) {
  return `这是美术依赖包，不能单独装载：包内只有 ${describeHistogram(hist)}，`
    + '没有任何骨架或模型定义（spine 的 .skel/.atlas、Live2D 的 model3.json 都不在里面）。'
    + '它提供给同批的模型包共用；请改选同一目录下带骨架的那个包。';
}
