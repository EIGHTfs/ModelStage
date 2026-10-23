// app/transport-actions.js —— 底栏播放条上的动作实现
//
// 播放条控件（播放/暂停、上/下一条变体、背景切换、动作下拉、皮肤下拉）都只操作"当前内容"，
// 与渲染器实现无关，所以统一放这里。状态一律经 state.transport 的句柄落到 DOM，
// 同时打 dataset 供自动化断言读。

import { dom, stage, state } from './context.js';
import { setPlaybackPaused } from '../render/playback.js';
import { getRendererSetting, setRendererSetting } from './renderer-setting.js';
import { stageStatus } from './status.js';
import { formatError, getJson } from '../infra/api.js';
import { applyBackground } from './view-settings.js';
import {
  buildAnimationList, isCycleLoop, labelWithDuration, notePlaying, playAnimation, setCycleLoop,
} from './anim-list.js';

/** 播放/暂停：切换引擎播放并同步按钮按下态与 dataset（进 CAMERA 之外的状态日志） */
/**
 * 播放/暂停统一入口（render/playback.js）：按当前渲染面派发，
 * 调用方不判断"现在是哪一面"，也不直连 stage（stage 恒为 Spine 舞台）。
 * @param {boolean} paused
 */
function applyPlaybackPaused(paused) {
  try { return setPlaybackPaused(state.surface, paused); } catch { return 'none'; }
}

/**
 * 播放状态的唯一真相 = state.playing。
 * UI（图标 / title / aria-pressed / dataset）与引擎状态都由它派生，不各存一份。
 * @param {boolean} on true=播放中，false=已暂停
 * @param {{silent?: boolean}} [opts]
 */
function setPlaying(on, opts = {}) {
  const next = !!on;
  const prev = state.playing === true;
  state.playing = next;
  state.playbackPath = applyPlaybackPaused(!next);   // 记账：便于验收贴"走了哪条通路"
  syncPlayUi();
  if (!opts.silent && prev !== next) stageStatus(next ? '继续播放' : '已暂停（画面与动作都停住）', 'info');
  return next;
}

/** UI 派生：图标（播放中显示"暂停"语义）、title、aria-pressed、dataset 全部跟随 state.playing */
function syncPlayUi() {
  const playing = state.playing !== false;
  if (state.transport) state.transport.setPressed('transport-play', playing);
  if (state.transport && state.transport.setIcon) state.transport.setIcon('transport-play', playing ? 'pause' : 'play');
  document.documentElement.dataset.transportPlaying = playing ? 'on' : 'off';
}

/**
 * 动作混合（过渡渐变）默认开启，且**面板里没有这个开关**（schema 标了 hidden）。
 * 没有开关就没人会去打开它，所以由应用层在首次装载时显式落地一次；
 * 已生效则不重复下发（幂等，避免每次换模型都改一次引擎设置）。
 */
function ensureMixModeOn() {
  if (state.mixModeEnsured === true) return;
  state.mixModeEnsured = true;
  try { setRendererSetting('mixMode', true); } catch { /* 该面不支持就跳过 */ }
  state.mixMode = true;
  document.documentElement.dataset.mixMode = 'on';
}

/** 底栏「播放/暂停」：切换 */
function toggleTransportPlay() {
  setPlaying(state.playing === false);
}
/** 单动循环：切换 settings.loop（引擎 setLoop 走通用 setter） */
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
/** 动作下拉选择：切动画并回填 dataset；右栏高亮与下拉互相跟随（同一份清单） */
function applyTransportMotion(id) {
  if (!id) return;
  const ok = playAnimation(id);
  document.documentElement.dataset.transportMotion = String(id);
  // 当前动作的唯一真相是底栏下拉（契约 §七）：不管从哪一处触发，都把下拉同步到这条
  if (state.transport) state.transport.setSelectValue('transport-motion', id);
  if (typeof state.panel && state.panel.refreshAnimations === 'function') state.panel.refreshAnimations();
  stageStatus(`transport 动作 → ${id}${ok ? '' : '（引擎拒绝，保持原动作）'}`, ok ? 'info' : 'warn');
}
/**
 * 循环播放（右栏「动作」组开关，契约 §四）：
 *   开 = 按列表顺序逐条播完剩余动作、末尾回到第一条并持续；关 = 停留当前动作重复播。
 * 与「混合模式」正交：混合模式只管切换瞬间的过渡（引擎 mixTime），这里只管"播完接谁"，
 *   两者互不调用、互不改写对方状态。
 * @param {boolean} on
 * @returns {boolean} 落地后的状态
 */
function applyAnimLoop(on) {
  setCycleLoop(!!on);
  state.animLoop = !!on;
  document.documentElement.dataset.animLoop = on ? 'on' : 'off';
  if (state.panel && typeof state.panel.setChecked === 'function') state.panel.setChecked('ctl-anim-loop', !!on);
  return !!on;
}

/** 模型加载完成后填充播放条：动作下拉 + 播放状态 */
function fillTransportOptions(info) {
  ensureMixModeOn();   // 混合模式默认开启（面板已隐藏该开关，必须由应用层落地）
  const transport = state.transport;
  if (!transport) return;
  // 首次填充顺带刷一次播放 UI：dataset / 图标 / 文案都由 state.playing 派生（幂等）
  syncPlayUi();
  // 与右栏同一份清单（同顺序、同文案、同时长）：契约 §一/§三
  const list = buildAnimationList();
  if (list.length) {
    const preferred = (info && info.motion) || '';
    const startId = list.some((x) => x.id === preferred) ? preferred : list[0].id;
    transport.setOptions('transport-motion', list.map((x) => ({ text: labelWithDuration(x), value: x.id })), startId);
    notePlaying(startId);
  }
  // 不在这里直读 stage.stats().playing：stage 恒为 Spine 舞台，Live2D 面会被它带偏，
  //   而且暂停状态只能有一个来源（state.playing）→ 统一走 syncPlayUi 派生。
  syncPlayUi();
}
/** 混合模式：两处开关指向同一状态，点任一处都要同步另一处的显示 */
/**
 * 混合模式（动作组）：只控制**动画切换**是否交叉淡化（引擎 mixTime 0.2s / 0）。
 * 与「皮肤」组那个开关是两件独立的事：一个管动作过渡、一个管换肤过渡，
 *   旧端也是分开的两个开关，互不同步。
 */
function applyMixMode(on) {
  // 经渲染器下发（INV-01）：混合模式 = 动作切换是否交叉淡化，Spine 面有实现、Live2D 面没有
  const { ok } = setRendererSetting('mixMode', !!on);
  const applied = getRendererSetting('mixMode');
  const value = ok && applied === true ? 0.2 : 0;
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
  // 换肤那一刻临时套用交叉淡化，换完立刻还原——动作/皮肤两个开关互不影响。
  // 走渲染器（INV-01）；还原放在 finally 里，异常路径也不让皮肤混合状态漏在临时值上。
  const want = state.skinMix === true;
  setRendererSetting('mixMode', want);
  try {
    return fn();
  } finally {
    // 还原到"用户当前选择"（state.mixMode 才是权威），不是还原到临时值
    setRendererSetting('mixMode', state.mixMode === true);
  }
}

export {
  toggleTransportPlay, setPlaying, syncPlayUi, stepVariant, cycleBackground, applyAnimLoop,
  applyTransportMotion, fillTransportOptions, applyMixMode, applySkinMix, skinSwitchMixTime,
};
