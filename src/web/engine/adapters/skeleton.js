// adapters/skeleton.js —— 骨架数据与骨架操作适配
//
// 差异点：JSON/Binary 读取器、AttachmentLoader、以及 skeleton 的世界变换/包围盒方法；
// 缺失的能力通过能力矩阵降级并 warn（不静默）。

/**
 * @param {{caps: object, spine: object, onWarn?: Function}} ctx
 */
export function createSkeletonAdapter({ caps, spine, onWarn }) {
  /** 附件装载器（把图集区域绑到附件上） */
  function attachmentLoader(atlas) {
    const Ctor = caps.skeleton.attachmentLoaderCtor;
    if (!Ctor) throw new Error('运行时缺少 AtlasAttachmentLoader');
    return new Ctor(atlas);
  }

  /** 读二进制骨架 */
  function readBinary(loader, bytes) {
    const Ctor = caps.skeleton.binaryCtor;
    if (!Ctor) throw new Error('运行时缺少 SkeletonBinary');
    return new Ctor(loader).readSkeletonData(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  /** 读 JSON 骨架 */
  function readJson(loader, json) {
    const Ctor = caps.skeleton.jsonCtor;
    if (!Ctor) throw new Error('运行时缺少 SkeletonJson');
    return new Ctor(loader).readSkeletonData(json);
  }

  /** 建骨架 + 动画状态机 */
  function createRuntime(data) {
    const skeleton = new spine.Skeleton(data);
    const stateData = new spine.AnimationStateData(data);
    const state = new spine.AnimationState(stateData);
    return { skeleton, stateData, state };
  }

  /** 摆到 setup pose（fit 取包围盒前必须做） */
  function setupPose(skeleton) {
    try { if (caps.skeletonOps.setToSetupPose) skeleton.setToSetupPose(); } catch { /* 忽略 */ }
  }

  /** 更新世界变换（2 = 物理模式；缺能力时退回无参调用） */
  function updateWorldTransform(skeleton) {
    if (!skeleton || !caps.skeletonOps.updateWorldTransform) return;
    try {
      if (skeleton.updateWorldTransform.length >= 1) skeleton.updateWorldTransform(2);
      else skeleton.updateWorldTransform();
    } catch { /* 忽略 */ }
  }

  /** 取骨架包围盒（用运行时的 Vector2；缺能力返回 null） */
  function bounds(skeleton) {
    const V = caps.skeleton.vector2;
    if (!skeleton || !caps.skeletonOps.getBounds || !V) return null;
    try {
      const offset = new V();
      const size = new V();
      skeleton.getBounds(offset, size, []);
      const w = Number(size.x);
      const h = Number(size.y);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
      return { x: Number(offset.x) || 0, y: Number(offset.y) || 0, w, h };
    } catch (e) {
      onWarn && onWarn(`skeleton.bounds 失败：${e.message}`);
      return null;
    }
  }

  /**
   * 在"全部皮肤合并"的形态下取一次值，然后还原原皮肤与 setup pose。
   * 为什么要合并：算 fit 包围盒前会把所有皮肤合成一个临时 skin，
   *   否则只按默认皮肤测量，多皮肤模型的包围盒会偏小（实测 7 动作模型 reset 后 zoom 差 0.18%）。
   * @param {object} ctx {skeleton, skeletonData}
   * @param {Function} fn 测量回调
   */
  function withAllSkins({ skeleton, skeletonData }, fn) {
    const Skin = caps.skinCtor;
    const skins = (skeletonData && skeletonData.skins) || [];
    if (!Skin || !skeleton || skins.length <= 1) return fn();
    let prev = null;
    try {
      prev = skeleton.skin;
      const merged = new Skin('_all_skins_bounds');
      for (const sk of skins) {
        try { merged.addSkin(sk); } catch { /* 单个皮肤合并不了不影响其它 */ }
      }
      skeleton.setSkin(merged);
      setupPose(skeleton);
      updateWorldTransform(skeleton);
      return fn();
    } catch {
      return fn();
    } finally {
      try {
        skeleton.setSkin(prev || null);
        setupPose(skeleton);
        updateWorldTransform(skeleton);
      } catch { /* 还原失败不影响结果 */ }
    }
  }

  return { attachmentLoader, readBinary, readJson, createRuntime, setupPose, updateWorldTransform, bounds, withAllSkins };
}
