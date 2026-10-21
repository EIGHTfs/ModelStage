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
