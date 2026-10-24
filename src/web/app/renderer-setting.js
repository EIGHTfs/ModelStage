// app/renderer-setting.js —— 面板/交互层设置下发的唯一通道（契约 INV-01）
//
// 为什么要有这个模块：设置只能经 `renderer.setSetting(key, value)` 落地，不允许任何调用点
//   直接摸舞台的 set 方法。之前 9 处直连的问题不是"写错"，而是**绕过渲染器**：
//   Live2D 模式下那些调用会打到隐藏的 spine 舞台上（改了没人看的对象），表现为"点了没反应"。
//
// 这个模块集中三件事：
//   ① 只认 state.currentRenderer（当前渲染面），不认 stage
//   ② 三态：渲染器没声明该能力键 ⇒ 记一条 warn 并返回 false（控件由面板置灰，这里兜底）
//   ③ 契约 §六：setSetting 返回 false 时记 warn，并回读 getSetting 的**生效值**供调用方回退
//
// 注意：同一条键只警告一次（Set 去重）。否则"恢复上次偏好"这类路径会在每次装载时刷屏。
import { state } from './context.js';
import { stageLog, stageStatus } from './status.js';
import { repaintActive } from '../render/playback.js';

/** 已警告过的键（避免同一条能力缺失反复刷日志） */
const warned = new Set();

/** 记一次去重后的警告 */
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  stageLog('warn', message, { key: String(key || ''), source: 'renderer-setting' });
}

/** 渲染器是否声明了某能力键（未声明 ⇒ 面板置灰，这里不硬发） */
export function rendererSupports(key) {
  const r = state.currentRenderer;
  const list = (r && r.capabilities && r.capabilities.settings) || [];
  return list.includes(key);
}

/**
 * 经渲染器下发一项设置。
 * @param {string} key 能力键（skin / mixMode / mixTime / animation / fps / speed / pma …）
 * @param {any} value 目标值
 * @returns {{ok: boolean, applied: any}} ok=false 时 applied 是回读到的生效值（可能为 null）
 */
export function setRendererSetting(key, value) {
  const renderer = state.currentRenderer;
  if (!renderer || typeof renderer.setSetting !== 'function') {
    warnOnce(key, `当前渲染器不可用，设置 ${key} 未下发`);
    return { ok: false, applied: null };
  }
  if (!rendererSupports(key)) {
    // 这里**故意不记日志**：能力不支持的控件在 applyCapabilities 阶段就根本不构建，
    //   "该项不可用（面板应置灰）"指向一个用户看不到的东西；同类告警在面板侧也已删除。
    //   能力是否支持属于自检结论（selfCheck 的 checked/violations），不该每次运行时刷一条。
    return { ok: false, applied: null };
  }
  let ok = false;
  try { ok = renderer.setSetting(key, value) === true; } catch { ok = false; }
  // 暂停中改设置：引擎/渲染循环都停着，必须显式补一帧，否则"改了看不见"
  if (state.playing === false) { try { repaintActive(state.surface); } catch { /* 忽略 */ } }
  let applied = null;
  try { applied = renderer.getSetting ? renderer.getSetting(key) : null; } catch { applied = null; }
  if (!ok) {
    // 契约 §六：返回 false 必须留痕，并让调用方拿到生效值做回退
    warnOnce(key, `设置 ${key}=${String(value)} 未被渲染器接受，已回退到生效值 ${String(applied)}`);
  }
  return { ok, applied };
}

/** 回读某键的生效值（不改变任何状态） */
export function getRendererSetting(key) {
  const renderer = state.currentRenderer;
  if (!renderer || typeof renderer.getSetting !== 'function') return null;
  try { return renderer.getSetting(key); } catch { return null; }
}
