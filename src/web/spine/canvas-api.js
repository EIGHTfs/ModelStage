// spine/canvas-api.js —— 对外 31 键契约的装配入口
//
// 职责：buildStageApi 组装核心键（load/unload/stats/samplePixels/...），
//   attachExtraApi 按固定顺序挂上四组能力（设置 → 资产 → 视图 → 渲染）。
// 红线：挂载顺序即语义 —— 设置组与渲染组各定义一次 setDebug，后挂的覆盖前者；
//   调换顺序会让调试绘制静默变样（渲染器契约 §2.1）。

import { attachAssetApi, attachRenderApi, attachSettingSetters, attachViewApi } from './canvas-api-groups.js';
import { abortedError } from './canvas-document.js';
import { applySettings, loadIntoStage, unloadModel , startFrameTick, stopFrameTick, repaintOnce } from './canvas-engine.js';
import { samplePixels } from './canvas-pixels.js';
import { statsOf } from './canvas-view.js';

/**
 * 创建舞台（对外契约见 doc/参考-Spine渲染要点.md §14）。
 * @param {{canvas: HTMLCanvasElement, onStatus?: (s:object)=>void}} opts
 */
/**
 * 组装舞台对外 API 的"基础方法"（加载/释放/统计/采样/播放控制）。
 * 拆出来是为了让 createSpineStage 只做编排（单函数过长会被审计拦截）。
 * @param {object} st 舞台状态
 * @param {{status: Function, fail: Function}} ctx 状态回调与失败包装
 */
export function buildStageApi(st, ctx) {
  const { status, fail } = ctx;
const api = {
  async load(arg) {
    try {
      const info = await loadIntoStage(st, arg);
      // 被取代时 loadIntoStage 返回 null：必须显式抛 aborted，不能"静默成功"让调用方读到空结果
      if (!info) throw abortedError();
      status({ phase: 'ready', ...info });
      return info;
    } catch (err) {
      if (err && err.business) {
        // 业务错误也要落到状态里（页面提示与遥测都靠 lastError）
        st.lastError = String(err.message || err);
        status({ phase: 'error', error: st.lastError });
        throw err;
      }
      if (err && err.name === 'AbortError') { st.lastError = '加载已被新的选择取代'; throw abortedError(st.lastError, err); }
      throw fail(`加载失败：${err && err.message ? err.message : err}`, err);
    }
  },
  unload() { unloadModel(st); status({ phase: 'unload' }); },
  stats: () => statsOf(st),
  samplePixels: () => samplePixels(st),
  applySettings: (patch) => applySettings(st, patch),
  play() {
    if (st.engine && st.engine.start) { try { st.engine.start(); } catch { /* 已在播放 */ } }
    st.paused = false;      // 恢复：重启帧计数循环（单实例由 startFrameTick 保证）
    startFrameTick(st);
  },
  pause() {
    if (st.engine && st.engine.stop) { try { st.engine.stop(); } catch { /* 已暂停 */ } }
    st.paused = true;       // 暂停：停掉帧计数循环，避免空转重绘同一张静止画面
    stopFrameTick(st);
    repaintOnce(st);        // 停循环前补一帧，保证"按下瞬间"的画面是最新的
  },
  repaint: () => repaintOnce(st),
  seek(t) { if (st.engine && st.engine.seek) { try { st.engine.seek(t); } catch { /* 越界忽略 */ } } },
  setAnimation(name, loop) {
    if (!st.engine || !name) return false;
    try { st.engine.setAnimation(name, typeof loop === 'boolean' ? loop : st.settings.loop); return true; } catch { return false; }
  },
  resize() {
    if (!st.engine) return;
    try { if (st.engine.refreshResolution) st.engine.refreshResolution(); } catch { /* 忽略 */ }
    try { if (st.engine.resetCamera) st.engine.resetCamera(); } catch { /* 忽略 */ }
  },
  dispose() {
    const e = st.engine;
    st.engine = null; st.model = null; st.seq++;
    if (!e) return;
    try { if (e.dispose) e.dispose(); } catch { /* 忽略 */ }
    st.disposes++;
  },
  // debug 同时给出统计字段（验收脚本从 debug() 读 frames 等）
  debug: () => ({ ...statsOf(st), engine: st.engine }),
};
  return api;
}

/**
 * 给舞台 API 挂"可选能力"：PMA 四档、滤镜、皮肤、混合模式、调试绘制、MSAA 重建。
 * 这些方法依赖模块级工具（applySettings / loadIntoStage…），与工厂解耦。
 */
/**
 * 给舞台 API 挂"可选能力"。按职责拆成四段，便于维护与审计（单函数长度）。
 * 依赖模块级工具（applySettings / loadIntoStage…），与工厂解耦。
 */
export function attachExtraApi(api, st) {
  attachSettingSetters(api, st);
  attachAssetApi(api, st);
  attachViewApi(api, st);
  attachRenderApi(api, st);
}
