// live2d/playback-probe.js —— 播放/当前动作探针（引擎侧判据）
//
// 为什么单独成模块：
//   ① 验收必须读**引擎真实状态**（motionManager / coreModel 的队列实例、时间轴、参数），
//      而不是我们自己的 currentLabel —— 否则就是"自己证明自己"，测不出真实播放；
//   ② bridge 已经很长，探针属于只读能力，搬出来不改变播放语义。
//
// 约定：入参 st 是 Live2D 阶段状态（model / app / motionMap / currentLabel）。

export function createViewProbe(st) {
  /**
   * 引擎侧播放探针：**直接读 Cubism 的 motionManager / coreModel**，
   * 不用我们自己的 currentLabel 自证（那只能说明"我们以为在播什么"）。
   *
   * 返回字段与验收口径一一对应：
   *   · playing        引擎是否真在播
   *   · queueInstances 队列里 Motion 实例的稳定编号（同一对象恒等 → 可直接判断"是否换成了新动作"）
   *   · timeSec        当前动作时间轴（切换后应从 0 重新推进）
   *   · priority       当前优先级
   *   · paramAngleX    参数快照（最强证据：不同动作的取值轨迹不同）
   * @returns {object}
   */
  function playbackProbe() {
    const found = motionHostModel();
    const mm = found && found.internalModel && found.internalModel.motionManager;
    const core = found && found.internalModel && found.internalModel.coreModel;
    const entries = mm && mm.queueManager && mm.queueManager._motions;
    const list = entries ? Array.from(entries) : null;
    const entry = list && list[0] ? list[0] : null;
    let paramAngleX = null;
    try { paramAngleX = core ? Number(core.getParameterValueById('ParamAngleX')) : null; } catch { /* 忽略 */ }
    // 时间轴：Cubism 4 用「队列条目的 _stateTimeSeconds − 起点」，切换后会从 0 重新推进；
    //   `queueManager._userTimeSeconds` 在本版 pixi 里恒为 0（读它永远看不到推进，这也是上一轮
    //   误判"没播"的原因之一），所以不再用它当判据。
    const started = entry && Number.isFinite(entry._startTimeSeconds) ? entry._startTimeSeconds : null;
    const state = entry && Number.isFinite(entry._stateTimeSeconds) ? entry._stateTimeSeconds : null;
    return {
      playing: mm ? !!mm.playing : null,
      queueLen: list ? list.length : null,
      queueInstances: list ? list.map(instanceTag) : null,
      timeSec: started !== null && state !== null ? Number((state - started).toFixed(3)) : null,
      durationSec: entry && entry._motion && Number.isFinite(entry._motion._loopDurationSeconds) ? entry._motion._loopDurationSeconds : null,
      priority: mm && mm.state ? mm.state.currentPriority : null,
      paramAngleX,
      currentLabel: st.currentLabel || null,
    };
  }

  /** 队列条目 → 稳定编号（WeakMap 记忆同一对象；不改动引擎对象本身） */
  const instanceIds = new WeakMap();
  let instanceSeq = 0;
  function instanceTag(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (!instanceIds.has(entry)) instanceIds.set(entry, `obj#${++instanceSeq}`);
    return instanceIds.get(entry);
  }

  /** 找到带 internalModel 的模型节点（覆盖层里模型可能在 stage 的下一层） */
  function motionHostModel() {
    if (st.model && st.model.internalModel) return st.model;
    const root = st.app && st.app.stage;
    let hit = null;
    const walk = (node, depth) => {
      if (!node || hit || depth > 4) return;
      if (node.internalModel && node.internalModel.motionManager) { hit = node; return; }
      const kids = node.children || [];
      for (const kid of kids) walk(kid, depth + 1);
    };
    walk(root, 0);
    return hit;
  }

  /**
   * 当前动作（唯一真相 = 我们自己的 currentLabel）。
   * 为什么不用 motionManager.currentGroup/currentIndex：本版 pixi-live2d-display 没有这两个字段，
   *   读到的是 mm.state 里的陈旧快照（实测连点三个动作后仍停在第一个），会让人误判"没切过去"。
   * 引擎侧字段仅作兜底（老版本才有）。
   * @returns {{label:string|null, group:string|null, index:number|null}}
   */
  function currentMotionOf() {
    const label = st.currentLabel || null;
    const hit = label && st.motionMap ? st.motionMap.get(label) : null;
    if (hit) return { label, group: hit.group, index: hit.index };
    try {
      const mm = st.model && st.model.internalModel && st.model.internalModel.motionManager;
      if (mm && mm.currentGroup !== undefined) return { label, group: mm.currentGroup, index: mm.currentIndex ?? null };
    } catch { /* 忽略 */ }
    return { label, group: null, index: null };
  }

  return { currentMotion: currentMotionOf, playbackProbe };
}
