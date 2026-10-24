// engine/animation.js —— 动画状态操作（setAnimation / seek / mix / speed / loop / 时长）
//
// 各项语义：
//   · setAnimation：`state.setAnimation(0, name, loop)`，记录 animName/animDuration；
//   · seek：夹到 [0, 当前时长] 后写 track.trackTime，推进一次状态；
//   · setMixTime：0..1，写入 stateData.defaultMix；
//   · setSpeed：夹 0.1–3，写 state.timeScale；
//   · setLoop：同时改当前 track.loop；
//   · 时长缓存：装载时扫一次，读时查表（不每帧遍历 animations）。

/** 取 0 号 track（不同版本方法名不同：getCurrent / getTrack） */
function trackOf(engine) {
  const state = engine.state;
  if (!state) return null;
  try {
    if (typeof state.getCurrent === 'function') return state.getCurrent(0);
    if (typeof state.getTrack === 'function') return state.getTrack(0);
  } catch { /* 忽略 */ }
  return null;
}

/** 装载后缓存"动作名 → 时长"（只扫一次） */
export function cacheDurations(engine) {
  const map = {};
  const anims = (engine.skeletonData && engine.skeletonData.animations) || [];
  for (const a of anims) map[a.name] = Number(a.duration) || 0;
  engine.durations = map;
  return map;
}

/** 当前动作时长（按动作名查缓存，未命中回退到线性查找） */
export function currentDuration(engine) {
  const name = engine.animationName;
  if (!name) return 0;
  if (engine.durations && Object.prototype.hasOwnProperty.call(engine.durations, name)) return engine.durations[name];
  const anims = (engine.skeletonData && engine.skeletonData.animations) || [];
  const found = anims.find((a) => a.name === name);
  return found ? (Number(found.duration) || 0) : 0;
}

/** 全部动作名（顺序与运行时一致） */
export function animations(engine) {
  const anims = (engine.skeletonData && engine.skeletonData.animations) || [];
  return anims.map((a) => a.name);
}

/** 混合时长（0..1 秒） */
export function setMixTime(engine, t) {
  engine.mixTime = Math.max(0, Math.min(1, Number(t) || 0));
  if (engine.stateData) engine.stateData.defaultMix = engine.mixTime;
}

/**
 * 切到指定动作。
 * @param {object} engine
 * @param {string} name
 * @param {boolean} loop
 * @returns {boolean} 是否成功
 */
export function setAnimation(engine, name, loop) {
  if (!engine.state || !name) return false;
  const wantLoop = loop !== false;
  try {
    engine.state.setAnimation(0, String(name), wantLoop);
    engine.loop = wantLoop;
    engine.animationName = String(name);
    engine.animDuration = currentDuration(engine);
    if (engine.stateData) engine.stateData.defaultMix = Math.max(0, Math.min(1, engine.mixTime));
    return true;
  } catch (e) {
    engine.log('warn', `切换动作失败（${name}）：${e.message}`, 'player');
    return false;
  }
}

/** 播放速率（夹 0.1–3） */
export function setSpeed(engine, speed) {
  const v = Math.max(0.1, Math.min(3, Number(speed) || 1));
  engine.speed = v;
  if (engine.state && engine.state.timeScale !== undefined) engine.state.timeScale = v;
}

/** 循环开关（同时改当前 track） */
export function setLoop(engine, loop) {
  engine.loop = loop !== false;
  const track = trackOf(engine);
  if (track) track.loop = engine.loop;
}

/** 跳时间：夹到 [0, 时长] 后写 trackTime 并推进一次状态 */
export function seek(engine, t) {
  if (!engine.state) return;
  try {
    const duration = engine.animDuration || currentDuration(engine);
    const pos = Math.max(0, Math.min(duration, Number(t) || 0));
    const track = trackOf(engine);
    if (track) track.trackTime = pos;
    engine.state.update(0);
    if (engine.skeleton && engine.adapters) engine.adapters.skeleton.updateWorldTransform(engine.skeleton);
    engine.animTime = pos;
    if (!engine.isPlaying) engine.render();
  } catch { /* 忽略 */ }
}

/**
 * 订阅「当前动作播完一次」事件（跨模型轮播的推进源）。
 *
 * 为什么要有这层归一：两个渲染器的原生机制完全不同 ——
 *   · Spine：`AnimationState.addListener({ complete })`，**每个 track 各报一次** ⇒ 必须过滤 trackIndex === 0；
 *   · Live2D（pixi-live2d-display）：模型实例 emit `'motionFinish'`，**model 级一次**，且是 `isFinished()` 为真才报。
 *
 * 归一后的约定（三条，写死在实现里）：
 *   1. **只报主轨/当前动作**（Spine 过滤 trackIndex === 0，与旧端 onAnimationComplete 同款判据）；
 *   2. **循环动作不报**：Spine 的 Loop 条目没有 complete；Live2D 的 isFinished() 在循环动作上永远 false。
 *      两边行为因此天然一致 —— 轮播要的是"播完一次"，循环动作没有这个时刻。
 *   3. **多轨混合态不推进**由调用方判断（旧端用 `T.current` 为真时 return）；本函数只如实上报事件。
 *
 * @param {object} target Spine 的 engine（有 `.state.addListener`）或 Live2D 的模型实例（有 `.on/.off`）
 * @param {(e: {name: string, trackIndex: number, source: 'spine'|'live2d'}) => void} cb 完成回调
 * @returns {() => void} 取消订阅函数（重复调用安全）
 */
export function onMotionComplete(target, cb) {
  const noop = () => {};
  if (!target || typeof cb !== 'function') return noop;

  // ① Spine：AnimationState 的 complete 事件
  if (target.state && typeof target.state.addListener === 'function') {
    const listener = {
      complete(entry) {
        try {
          if (!entry) return;
          if (entry.trackIndex !== 0) return;     // 其它轨道（表情/附加层）不算"当前动作播完"
          if (entry.loop) return;                 // 循环条目没有终点（与 Live2D 的 isFinished 对齐）
          const name = entry.animation && entry.animation.name ? String(entry.animation.name) : '';
          cb({ name, trackIndex: 0, source: 'spine' });
        } catch { /* 回调内部异常不能影响渲染循环 */ }
      },
    };
    try {
      target.state.addListener(listener);
    } catch {
      return noop;
    }
    return () => {
      try { target.state.removeListener(listener); } catch { /* 已移除/引擎已销毁 */ }
    };
  }

  // ② Live2D：模型实例的 motionFinish 事件（库内实现：isFinished() 为真时 emit）
  if (typeof target.on === 'function' && typeof target.off === 'function') {
    const handler = () => {
      try {
        cb({ name: String(target.animationName || ''), trackIndex: 0, source: 'live2d' });
      } catch { /* 同上 */ }
    };
    try {
      target.on('motionFinish', handler);
    } catch {
      return noop;
    }
    return () => {
      try { target.off('motionFinish', handler); } catch { /* 同上 */ }
    };
  }

  return noop;
}

/** 只读快照（对照脚本/诊断用） */
export function snapshot(engine) {
  const track = trackOf(engine);
  const anim = track && track.animation ? track.animation : null;
  return {
    name: anim ? anim.name : (engine.animationName || null),
    duration: anim ? (Number(anim.duration) || 0) : 0,
    trackTime: track && typeof track.trackTime === 'number' ? track.trackTime : null,
    loop: track ? !!track.loop : null,
    timeScale: engine.state && engine.state.timeScale !== undefined ? engine.state.timeScale : null,
    defaultMix: engine.stateData ? engine.stateData.defaultMix : null,
  };
}
