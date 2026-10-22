// app/transport-actions.js —— 底栏播放条上的动作实现
//
// 播放条控件（播放/暂停、单动循环、上/下一条变体、背景切换、动作下拉、皮肤下拉）都只操作"当前内容"，
// 与渲染器实现无关，所以统一放这里。状态一律经 state.transport 的句柄落到 DOM，
// 同时打 dataset 供自动化断言读。

import { dom, stage, state } from './context.js';
import { stageStatus } from './status.js';
import { formatError, getJson } from '../infra/api.js';
import { applyBackground } from './view-settings.js';

/** 播放/暂停：切换引擎播放并同步按钮按下态与 dataset（进 CAMERA 之外的状态日志） */
function toggleTransportPlay() {
  if (!stage) return;
  const stats = stage.stats();
  const playing = !!(stats && stats.playing);
  if (playing) stage.pause(); else stage.play();
  const next = !playing;
  if (state.transport) state.transport.setPressed('transport-play', next);
  document.documentElement.dataset.transportPlaying = next ? 'on' : 'off';
  stageStatus(`transport 播放${next ? '' : '暂停'}`, 'info');
}
/** 单动循环：切换 settings.loop（引擎 setLoop 走通用 setter） */
function toggleTransportLoop() {
  if (!stage) return;
  const stats = stage.stats();
  const cur = !!(stats && stats.settings && stats.settings.loop);
  const next = !cur;
  if (typeof stage.setLoop === 'function') stage.setLoop(next);
  if (state.transport) state.transport.setPressed('transport-loop', next);
  document.documentElement.dataset.transportLoop = next ? 'on' : 'off';
  stageStatus(`transport 单动循环 ${next ? '开' : '关'}`, 'info');
}
/**
 * 上一个/下一个变体：取「当前根下、同一目录」的兄弟变体循环切换。
 * 为什么用 API 取：名册树是懒加载的，兄弟列表不在 state 里，直接查 /api/models 最准。
 */
async function stepVariant(dir) {
  const cur = state.selectedModel;
  if (!cur || !cur.rootId || !cur.directory) { stageStatus('切换变体失败：当前没有可用的兄弟变体', 'warn'); return; }
  try {
    const data = await getJson(`/api/models?root=${encodeURIComponent(cur.rootId)}`);
    const peers = (data.models || []).filter((m) => m.directory === cur.directory);
    if (peers.length < 2) { stageStatus('切换变体失败：当前角色只有 1 个变体', 'warn'); return; }
    const at = peers.findIndex((m) => m.id === cur.id || m.name === cur.name);
    const next = peers[(at + dir + peers.length) % peers.length];
    document.documentElement.dataset.transportVariant = next.name;
    stageStatus(`transport 切换变体 → ${next.name}`, 'info');
    onSelectModel(next);
  } catch (err) {
    stageStatus(`切换变体失败：${formatError(err)}`, 'error');
  }
}
/** 背景：底栏快捷入口，循环切换 棋盘 → 纯色 → 透明（与主题背景组的 bg-mode 同一状态） */
function cycleBackground() {
  const order = ['checkerboard', 'solid', 'transparent'];
  const cur = state.viewBg || 'checkerboard';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  applyBackground(next);
  if (state.panel && state.panel.setValue) state.panel.setValue('ctl-bg-mode', next);
  document.documentElement.dataset.transportBg = next;
  stageStatus(`transport 背景 → ${next}`, 'info');
}
/** 动作下拉选择：切动画并回填 dataset */
function applyTransportMotion(name) {
  if (!stage || !name) return;
  const ok = stage.setAnimation(name);
  document.documentElement.dataset.transportMotion = String(name);
  stageStatus(`transport 动作 → ${name}${ok ? '' : '（引擎拒绝，保持原动作）'}`, ok ? 'info' : 'warn');
}
/** 模型加载完成后填充播放条：动作下拉 + 循环/播放按下态 */
function fillTransportOptions(info) {
  const transport = state.transport;
  if (!transport) return;
  const anims = Array.isArray(info && info.animations) ? info.animations : [];
  if (anims.length) {
    transport.setOptions('transport-motion', anims.map((a) => ({ text: a, value: a })), info.motion || anims[0]);
  }
  const stats = stage ? stage.stats() : null;
  transport.setPressed('transport-loop', !!(stats && stats.settings && stats.settings.loop));
  document.documentElement.dataset.transportPlaying = stats && stats.playing ? 'on' : 'off';
}
/** 混合模式：两处开关指向同一状态，点任一处都要同步另一处的显示 */
/**
 * 混合模式（动作组）：只控制**动画切换**是否交叉淡化（引擎 mixTime 0.2s / 0）。
 * 与「皮肤」组那个开关是两件独立的事：一个管动作过渡、一个管换肤过渡，
 *   旧端也是分开的两个开关，互不同步。
 */
function applyMixMode(on) {
  const value = !!(stage && stage.setMixMode ? stage.setMixMode(on) : 0);
  state.mixMode = !!on;
  if (state.panel) state.panel.setChecked('ctl-mix-mode', !!on);
  document.documentElement.dataset.mixMode = on ? 'on' : 'off';
  return value;
}

/**
 * 混合模式（皮肤组）：只控制**换肤**是否交叉淡化。
 * 引擎没有独立的"皮肤混合"参数，所以实现方式是在换肤的那一刻临时套用 0.2s 混合，
 *   换完立刻还原——这样动作与皮肤两个开关互不影响。
 */
function applySkinMix(on) {
  state.skinMix = !!on;
  if (state.panel) state.panel.setChecked('ctl-skin-mix', !!on);
  document.documentElement.dataset.skinMix = on ? 'on' : 'off';
  return state.skinMix;
}

/** 换肤时按「皮肤混合模式」决定是否临时淡入 */
function skinSwitchMixTime(fn) {
  const want = state.skinMix === true ? 0.2 : 0;
  let prev = null;
  try {
    if (stage && stage.setMixMode) prev = stage.setMixMode(want > 0);
  } catch { prev = null; }
  try { return fn(); } finally {
    try {
      if (stage && stage.setMixMode && state.mixMode !== undefined) stage.setMixMode(state.mixMode === true);
    } catch { /* 还原失败不影响业务 */ }
  }
}

export {
  toggleTransportPlay, toggleTransportLoop, stepVariant, cycleBackground,
  applyTransportMotion, fillTransportOptions, applyMixMode, applySkinMix, skinSwitchMixTime,
};
