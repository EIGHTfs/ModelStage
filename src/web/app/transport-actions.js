// app/transport-actions.js —— 底栏播放条上的动作实现
//
// 播放条控件（播放/暂停、上/下一条变体、背景切换、动作下拉、皮肤下拉）都只操作"当前内容"，
// 与渲染器实现无关，所以统一放这里。状态一律经 state.transport 的句柄落到 DOM，
// 同时打 dataset 供自动化断言读。

import { dom, stage, state } from './context.js';
import { setPlaybackPaused } from '../render/playback.js';
import { getRendererSetting, setRendererSetting } from './renderer-setting.js';
import { stageLog, stageStatus } from './status.js';
import { buildChars, createNameIndex, mergeNameTable, loadRootNames } from '../roster/list.js';
import { formatError } from '../infra/api.js';
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
/**
 * 判断两个条目是否属于「同一个角色（同一组变体）」。
 *
 * 字段来源不统一：catalog 条目用 `srcDir`（根内相对目录），旧 models 条目用 `directory`（带根名前缀）。
 * 优先比 srcDir，缺失时回落到 directory —— 两边都取不到就判为不同组，宁可不合并也不乱合并。
 * @param {object} m 候选条目
 * @param {object} cur 当前模型
 * @param {string} dir 当前模型的目录（兜底）
 * @returns {boolean}
 */
/**
 * 把条目补成"可装载形态"（**兜底**：树里的条已自带 entry.url）。
 *
 * 为什么需要：/api/catalog 的条目自带 `entry.url`，但历史路径（如从别处传入的裸模型对象）
 *   可能只有 `skeletonFile`；这里统一补齐，避免装载入口报"条目缺少资产地址"。
 * @param {object} m 模型条目
 * @returns {object} 补好 entry 的条目（已有 entry 时原样返回）
 */
function withEntry(m) {
  if (!m || typeof m !== 'object') return m;
  if (m.entry && m.entry.url) return m;
  const url = (m.skeletonFile && m.skeletonFile.url) || m.modelUrl || null;
  return url ? { ...m, entry: { url } } : m;
}

/** 取名册树实例（翻页的池子与"同角色变体"都从它取，见下方说明） */
function rosterApi() {
  const r = state.roster;
  return r && typeof r.listVariants === 'function' && typeof r.variantsOf === 'function' ? r : null;
}

/**
 * 装载并同步左栏（统一入口；装载实现仍然是 model-actions 的 onSelectModel）。
 * @param {object} model
 */
async function applyPicked(model) {
  const { selectModel } = await import('./model-actions.js');
  selectModel(withEntry(model));
}

/**
 * 翻变体（同一角色的不同皮肤/服装）。
 * @param {number} dir -1 上一个 / +1 下一个
 * @param {object[]} [peersArg] 已取到的兄弟列表（调用方复用查询结果时传）
 */
async function stepVariant(dir, peersArg) {
  const cur = state.selectedModel;
  if (!cur) { stageLog('warn', '切换变体失败：当前没有选中的模型', { reason: 'no-current-model' }); return; }
  const api = rosterApi();
  if (!api) { stageLog('warn', '切换变体失败：名册树尚未就绪', { reason: 'no-roster' }); return; }
  const peers = peersArg || (await api.variantsOf(cur.id));
  if (peers.length < 2) { stageLog('warn', '切换变体失败：当前角色只有 1 个变体', { peers: peers.length }); return; }
  const at = peers.findIndex((p) => p.model && p.model.id === cur.id);
  const next = peers[(Math.max(at, 0) + dir + peers.length) % peers.length];
  if (!next || !next.model) return;
  stageStatus(`切换变体 → ${next.model.name}`, 'info');
  await applyPicked(next.model);
}

/**
 * 翻模型（**按左栏树从上到下的顺序**，末尾回绕）。
 *
 * 池子必须是树，不能是某个接口的清单：
 *   树的「游戏」节点是**同名根合并**出来的（例如「碧蓝航线」= azurlane + azurlane_spine + azurlane_bundle），
 *   按单个 rootId 取清单会漏掉同名的其它根 ⇒ 表现为"只能在 live2d 之间翻、翻不到 spine"（实测过的现场）。
 * @param {number} dir -1 上一个 / +1 下一个
 * @param {object[]} [flatArg] 已取到的树序序列
 */
async function stepModel(dir, flatArg) {
  const cur = state.selectedModel;
  if (!cur) { stageLog('warn', '切换模型失败：当前没有选中的模型', { reason: 'no-current-model' }); return; }
  const api = rosterApi();
  if (!api) {
    stageLog('warn', '切换模型失败：名册树尚未就绪', { reason: 'no-roster' });
    stageStatus('切换失败：模型列表尚未就绪', 'warn');
    return;
  }
  let flat = flatArg;
  if (!flat) {
    try { flat = await api.listVariants(); } catch (err) {
      stageLog('error', `切换模型失败：读取模型列表出错（${formatError(err)}）`, { err: formatError(err) });
      stageStatus('切换失败：读取模型列表出错', 'warn');
      return;
    }
  }
  if (!flat || flat.length === 0) {
    stageLog('warn', '切换模型失败：当前没有可切换的模型', { total: 0 });
    stageStatus('当前没有可切换的模型', 'warn');
    return;
  }
  if (flat.length === 1) {
    stageLog('warn', '切换模型失败：库中只有 1 个模型', { total: 1 });
    stageStatus('库中只有 1 个模型，没有可切换的下一个', 'warn');
    return;
  }
  const at = flat.findIndex((p) => p.model && p.model.id === cur.id);
  const from = at < 0 ? (dir > 0 ? -1 : 0) : at;
  const nextAt = (from + dir + flat.length) % flat.length;
  const next = flat[nextAt];
  if (!next || !next.model) return;
  // 回绕提示只在真的"跳过头"时出现：往后翻到第 0 个、往前翻到最后一个
  if (dir > 0 && nextAt === 0 && at !== 0) stageStatus('已返回第一个模型', 'info');
  else if (dir < 0 && nextAt === flat.length - 1 && at !== flat.length - 1) stageStatus('已到最后一个模型（回绕）', 'info');
  else stageStatus(`切换模型 → ${next.model.name}`, 'info');
  await applyPicked(next.model);
}

/**
 * 「上一个 / 下一个」的唯一入口（快捷键 A/S 与底栏两个按钮共用）。
 *
 * 粒度：当前角色有多个变体 ⇒ 翻变体（想看的是同角色另一套衣服）；否则 ⇒ 按树序翻模型。
 * @param {number} dir -1 上一个 / +1 下一个
 */
async function stepUnit(dir) {
  const cur = state.selectedModel;
  if (!cur) { stageLog('warn', '上一个/下一个失败：当前没有选中的模型', { reason: 'no-current-model' }); return; }
  const api = rosterApi();
  if (!api) {
    stageLog('warn', '上一个/下一个失败：名册树尚未就绪', { reason: 'no-roster' });
    stageStatus('切换失败：模型列表尚未就绪', 'warn');
    return;
  }
  const peers = await api.variantsOf(cur.id);
  if (peers.length > 1) { await stepVariant(dir, peers); return; }
  await stepModel(dir);
}


/** 动作下拉选择：切动画并回填 dataset；右栏高亮与下拉互相跟随（同一份清单） */
function applyTransportMotion(id) {
  if (!id) return;
  // ① 先立真相：任何"读当前动作"的地方（面板重绘、底栏回显）都必须先看到新值，
  //    否则播放过程中触发的重绘会用旧值把高亮刷回去（实测过的坑）。
  state.transportMotion = String(id);
  document.documentElement.dataset.transportMotion = String(id);
  // ② 再播放：playAnimation 只负责让引擎播，不碰面板（职责分离）
  const ok = playAnimation(id);
  // 当前动作的唯一真相是底栏下拉（契约 §七）：不管从哪一处触发，都把下拉同步到这条
  if (state.transport) state.transport.setSelectValue('transport-motion', id);
  // 用自定义事件请求重绘，而不是 import 面板模块：
  //   ① 面板句柄在重建瞬间可能是"半成品"（state.panel 尚未挂 refreshAnimations）；
  //   ② app 与 panel 互相 import 会形成**循环依赖**，实测会让页面脚本异常。
  //   事件解耦：谁关心谁监听，app 层不需要知道面板内部结构。
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('panel:refresh-animations'));
  }
  if (ok) stageStatus(`动作 → ${id}`, 'info');
  else stageLog('warn', `动作 → ${id}（引擎拒绝，保持原动作）`, { id, reason: 'renderer-rejected' });
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
 *   两个开关分开、互不同步。
 */
function applyMixMode(on) {
  // 经渲染器下发（INV-01）：混合模式 = 动作切换是否交叉淡化，Spine 面有实现、Live2D 面没有
  const { ok } = setRendererSetting('mixMode', !!on);
  const applied = getRendererSetting('mixMode');
  const value = ok && applied === true ? 0.2 : 0;
  state.mixMode = !!on;
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
  toggleTransportPlay, setPlaying, syncPlayUi, stepVariant, stepModel, stepUnit, applyAnimLoop,
  applyTransportMotion, fillTransportOptions, applyMixMode, applySkinMix, skinSwitchMixTime,
};
