// engine/model-info.js —— 装载结果摘要（与旧引擎同形）
//
// 单独成文件的原因：摘要字段（动作/皮肤/骨骼/插槽计数）是"给上层看的形状"，
//   与渲染实现无关，放在 player 里会让主类继续膨胀。

/**
 * 生成装载结果摘要。
 * @param {{engine: object, descriptor: object}} ctx
 * @returns {{name: string, version: string, animations: string[], skins: string[],
 *            boneCount: number, slotCount: number, durations: object}}
 */
export function describeModel({ engine, descriptor }) {
  const data = engine.skeletonData;
  const anims = (data && data.animations) || [];
  const skins = (data && data.skins) || [];
  const skeleton = engine.skeleton;
  return {
    name: descriptor.name,
    version: engine.runtimeVersion || descriptor.version,
    animations: anims.map((a) => a.name),
    skins: skins.map((s) => s.name),
    boneCount: (skeleton && skeleton.bones && skeleton.bones.length) || 0,
    slotCount: (skeleton && skeleton.slots && skeleton.slots.length) || 0,
    durations: {},
  };
}
