// app/anim-list.js —— 动作清单的唯一数据源 + 播放 + 循环推进
//
// 契约要求（docs/契约/渲染面.md）：
//   §一 动作清单只能有一处来源：右栏与底栏必须读同一份，不得各取一处；
//   §二 每条 = 动作名 + 时长；取不到时长就不显示（禁止 0s 冒充）；
//   §三 两处入口行为一致（同列表/同顺序/同时长，点任一处都能播，高亮同步）；
//   §四 「单动循环」开启 = 按列表顺序依次播完全部并回到第一条；关闭 = 停留当前动作重复播；
//   §五 Spine 与 Live2D 都要覆盖，Live2D 用 `group / motion` 区分。
//
// 为什么集中在这里：此前右栏读 bridge.readState().motions（该字段不存在）、底栏读装载返回，
//   两处数据源不一致，Live2D 下右栏永远是空的。现在两处都只调 buildAnimationList()。
//
// 当前播放项的唯一真相是底栏下拉（#transport-motion）的值（契约 §七），
//   这里只负责"给出清单 / 播某条 / 按顺序推进"，不自己另存一份"当前动作"。

import { state, stage } from './context.js';
import { setRendererSetting } from './renderer-setting.js';

/** 面板与底栏共用的清单缓存（每次模型变化后重建） */
let cached = [];
/** 循环推进态：只记"从哪条开始、什么时候开始"，当前项仍以下拉为准 */
const cycle = { on: false, timer: null, startedAt: 0, currentId: '' };

/** Live2D 桥（未装载时返回 null） */
function live2dBridge() {
  const l2d = typeof window !== 'undefined' && window.__WEB__ ? window.__WEB__.live2d : null;
  if (!l2d || typeof l2d.isActive !== 'function' || !l2d.isActive()) return null;
  return l2d.bridge || null;
}

/** 时长格式：6.2s；没有时长返回空串（契约禁止显示 0s / —） */
export function durationText(duration) {
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0) return '';
  return `${d.toFixed(1)}s`;
}

/** 列表项的显示文案：`名字 · 6.2s`（无时长就只留名字） */
export function labelWithDuration(item) {
  const t = durationText(item && item.duration);
  return t ? `${item.label} · ${t}` : String((item && item.label) || '');
}

/**
 * 建清单（单一来源）。
 * Spine：舞台 stats().animations 的名称 + api.animationDetails() 的时长；
 * Live2D：bridge.motionItems()（label 已是 `group / motion`）。
 * @returns {Array<{id: string, label: string, duration: number|null}>}
 */
export function buildAnimationList() {
  const bridge = live2dBridge();
  let list = [];
  if (bridge && typeof bridge.motionItems === 'function') {
    list = bridge.motionItems().map((m) => ({ id: m.label, label: m.label, duration: m.duration }));
  } else {
    let details = [];
    try { details = stage && typeof stage.animationDetails === 'function' ? stage.animationDetails() : []; } catch { details = []; }
    if (details.length) {
      list = details.map((a) => ({ id: a.name, label: a.name, duration: a.duration }));
    } else {
      // 兜底：拿不到时长也要能列出来（名称必须显示）
      let names = [];
      try {
        const snap = stage && typeof stage.stats === 'function' ? stage.stats() : null;
        names = (snap && Array.isArray(snap.animations)) ? snap.animations : [];
      } catch { names = []; }
      list = names.map((n) => ({ id: n, label: String(n), duration: null }));
    }
  }
  cached = list;
  return list.slice();
}

/**
 * 预热动作时长（目前只有 Live2D 需要：时长在动作文件里，不在运行时状态里）。
 * 取到后回调刷新一次，面板与底栏一起更新；同一模型只尝试一次。
 * @returns {Promise<number>} 本次新取到条数
 */
export async function primeAnimationDurations() {
  const bridge = live2dBridge();
  if (!bridge || typeof bridge.ensureMotionDurations !== 'function') return 0;
  if (primeAnimationDurations.busy) return 0;
  primeAnimationDurations.busy = true;
  try {
    const filled = await bridge.ensureMotionDurations();
    if (filled > 0) {
      cached = [];
      buildAnimationList();
      if (typeof cycle.onAdvance === 'function') cycle.onAdvance('');
    }
    return filled;
  } catch {
    return 0;
  } finally {
    primeAnimationDurations.busy = false;
  }
}

/** 最近一次构建的清单（不重新取数） */
export function currentList() {
  return cached.slice();
}

/**
 * 用同一份清单重填底栏下拉（同顺序、同文案、同时长）。
 * 放在这里的原因：装载回调、模型切换、循环推进都可能改变清单，
 *   让"填下拉"只有一个出口，就不会出现"右栏有、底栏没有"的错位。
 * @returns {number} 填入条数
 */
export function syncTransportOptions() {
  const transport = state.transport;
  if (!transport || typeof transport.setOptions !== 'function') return 0;
  const list = cached.length ? cached : buildAnimationList();
  if (!list.length) return 0;
  const picker = transport.picker ? transport.picker('transport-motion') : null;
  const curVal = picker && typeof picker.value === 'function' ? picker.value() : (document.getElementById('transport-motion') || {}).value;
  const keep = curVal && list.some((x) => x.id === curVal) ? curVal : list[0].id;
  transport.setOptions('transport-motion', list.map((x) => ({ text: labelWithDuration(x), value: x.id })), keep);
  return list.length;
}

/** 当前播放项 id：唯一真相是底栏下拉的值（契约 §七） */
export function currentAnimationId() {
  // 唯一真相 = state.transportMotion（底栏自绘下拉没有 <select>.value，句柄也可能刚被重建）
  if (state && state.transportMotion) return String(state.transportMotion);
  const transport = state && state.transport;
  if (transport && typeof transport.picker === 'function') {
    const pk = transport.picker('transport-motion');
    if (pk && typeof pk.value === 'function') {
      const v = pk.value();
      if (v) return v;
    }
  }
  const sel = typeof document !== 'undefined' ? document.querySelector('#transport-motion') : null;
  return sel && sel.value ? sel.value : '';
}

/**
 * 播一条动作。
 * @param {string} id 清单里的 id（Live2D 为 `group / motion` 标签，Spine 为动作名）
 * @returns {boolean} 是否被接受
 */
export function playAnimation(id) {
  if (!id) return false;
  // 一律经渲染器下发（INV-01）：Live2D 面走 bridge.playLabel、Spine 面走舞台的 setAnimation，
  //   分流在各自渲染器的 setSetting('animation') 里，这里不再判断"哪一面"。
  const { ok } = setRendererSetting('animation', id);
  if (ok) notePlaying(id);
  return ok;
}

/** 记录"从这条开始播"，供循环推进计算时间 */
export function notePlaying(id) {
  cycle.currentId = String(id || '');
  cycle.startedAt = Date.now();
}

/** 循环开关（契约 §四）：开 = 顺序播完全部并回到第一条；关 = 停留当前动作重复播 */
export function setCycleLoop(on) {
  cycle.on = !!on;
  if (cycle.timer) { clearInterval(cycle.timer); cycle.timer = null; }
  if (!cycle.on) return false;
  cycle.currentId = cycle.currentId || currentAnimationId();
  cycle.startedAt = Date.now();
  cycle.timer = setInterval(stepCycle, 200);
  return true;
}

export function isCycleLoop() {
  return cycle.on;
}

/** 时长未知时的推进间隔：契约要求"依次播完全部"，不能因为没时长就卡住 */
const FALLBACK_ADVANCE_MS = 1200;

/**
 * 推进一拍：当前动作放完就切下一条，末尾回到第一条。
 * 有真实时长就按时长走；没有时长（如空轨道动画）用兜底间隔推进，
 *   否则循环会在第一个"无时长"动作上停死。
 */
function stepCycle() {
  if (!cycle.on) return;
  const list = cached.length ? cached : buildAnimationList();
  if (list.length < 2) return;
  const id = cycle.currentId || currentAnimationId();
  const idx = list.findIndex((x) => x.id === id);
  const cur = idx >= 0 ? list[idx] : null;
  const dur = cur && Number(cur.duration);
  const waitMs = Number.isFinite(dur) && dur > 0 ? dur * 1000 - 80 : FALLBACK_ADVANCE_MS;
  if (Date.now() - cycle.startedAt < waitMs) return;
  const next = list[(idx + 1) % list.length]; // 末尾回到第一条
  if (!next) return;
  const { ok } = setRendererSetting('animation', next.id);
  if (!ok) return;
  notePlaying(next.id);
  if (state.transport) state.transport.setSelectValue('transport-motion', next.id);
  document.documentElement.dataset.transportMotion = next.id;
  // 面板高亮跟随（回调注入，避免面板↔应用双向依赖）
  if (typeof cycle.onAdvance === 'function') cycle.onAdvance(next.id);
}

/** 面板注册"推进后重绘高亮"的回调 */
export function onCycleAdvance(fn) {
  cycle.onAdvance = typeof fn === 'function' ? fn : null;
}
