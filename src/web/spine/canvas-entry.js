// spine/canvas-entry.js —— createSpineStage 入口
//
// 构造期只接受 opts.canvas / opts.onStatus；其余设置一律经 applySettings 或各 setter 下发
//   （构造期塞设置会让"面板设置"与"构造参数"出现两套真相）。

import { attachExtraApi, buildStageApi } from './canvas-api.js';
import { businessError } from './canvas-document.js';
import { DEFAULT_SETTINGS, statsOf } from './canvas-view.js';

export function createSpineStage(opts) {
  const o = opts || {};
  if (!o.canvas) throw new Error('createSpineStage 需要 canvas');
  const onStatus = typeof o.onStatus === 'function' ? o.onStatus : () => {};
  const st = {
    canvas: o.canvas, lastArg: null,
    engine: null, seq: 0, loads: 0, disposes: 0, lastError: null,
    runtimeKeys: [], model: null, frames: 0, settings: { ...DEFAULT_SETTINGS },
  };
  const status = (patch) => { try { onStatus({ ...statsOf(st), ...patch }); } catch { /* 回调不影响渲染 */ } };
  const fail = (msg, cause) => {
    st.lastError = String(msg);
    status({ phase: 'error', error: st.lastError });
    return businessError(st.lastError, cause);
  };
  const api = buildStageApi(st, { status, fail });
  attachExtraApi(api, st);
  return api;
}
