// infra/ready.js —— 就绪信号（页面侧）：阶段状态上报 + 页面内直读
//
// 契约：doc/契约/就绪信号契约.md。与 diag 完全分离：
//   · diag 是给人看的追加流水；这里是给机器读的**状态机**（每阶段只留最新值）；
//   · 因此**绝不进调试面板**（不发 diag 事件），也不在渲染循环里每帧写（契约 §六-4）。
//
// 上报策略：变更时**去抖合并**（默认 120ms 内的多次 markStage 合成一条 POST），
//   既保证"最后一个状态不丢"，也不会因为状态机抖动把请求打爆。

/** 阶段清单（与 server/http/ready.mjs 的 STAGES 一致；契约 §三 要求先登记） */
export const STAGES = [
  'shell', 'topbar', 'sidebarLeft', 'sidebarRight', 'panel',
  'bottombar', 'debugPanel', 'renderer', 'model',
];

/** 合法状态（契约 §二） */
// painted 是模型专属的中间级（契约 §2.2），也是合法 state，必须进白名单
//   —— 漏了它会让 painted 上报被当成非法状态静默丢弃（实测踩过）。
// pending = 「还没上报」（契约 §四 的合法 state）；rank 0，任何真实状态都能覆盖它。
//   不用 unknown：契约 §四 没有这个值，且测试要同时处理两个"未就绪"值容易漏判。
export const STATES = ['pending', 'mounted', 'painted', 'settled', 'interactive', 'failed'];

/** 前进顺序：同阶段不后退，failed 例外。painted 是**模型专属**的中间级（契约 §2.2），
 *  必须与 settled 同档，否则会被当成"未前进"静默丢弃（实测踩过：painted 报不上去）。 */
const RANK = { pending: 0, mounted: 1, painted: 2, settled: 2, interactive: 3 };

/** 上报去抖窗口（ms）：同一窗口内的多次变更合成一条请求 */
const FLUSH_DEBOUNCE_MS = 120;

const st = {
  stages: {},          // stage → { state, at, detail?, reason? }
  rev: 0,              // 本地 rev（服务端才是权威；这里供 __WEB__.ready() 立即可读）
  pending: new Map(),  // stage → update[]（待上报，**队列**：同阶段的中间态不能互相覆盖）
  timer: null,
  installed: false,
};

/**
 * 标记某阶段的状态（**只在上报点调用**，不要放进渲染循环）。
 * @param {string} name 阶段名（必须在 STAGES 内）
 * @param {'mounted'|'settled'|'interactive'|'failed'} state
 * @param {object} [detail] 关键计数（动作数、尺寸、帧数…）
 * @param {string} [reason] state==='failed' 时的可读原因
 * @returns {boolean} 是否实际推进了状态
 */
export function markStage(name, state, detail, reason) {
  if (!STAGES.includes(name) || !STATES.includes(state)) return false;
  const prev = st.stages[name];
  if (state !== 'failed' && prev && prev.state !== 'failed'
    && (RANK[state] || 0) <= (RANK[prev.state] || 1)) {
    return false; // 同级/退步：忽略（重复上报是常态）
  }
  const rec = { state, at: Date.now() };
  if (detail && typeof detail === 'object') rec.detail = detail;
  if (state === 'failed') rec.reason = String(reason || '未提供原因');
  st.stages[name] = rec;
  st.rev += 1;
  // 追加而不是覆盖：mounted → painted → interactive 可能都落在同一个去抖窗口内，
  //   若只留最新值，painted 就永远不会出现在流里（测试等 painted 会白等），这是实测踩过的坑。
  const q = st.pending.get(name) || [];
  q.push({ stage: name, ...rec });
  st.pending.set(name, q);
  schedule();
  return true;
}

/**
 * 重置某阶段（换内容时用：新模型/新面板实例要能从 mounted 重新走三级）。
 * 与 markStage 的区别：这会**清掉**已有等级，并显式告知服务端 reset。
 * @param {string} name 阶段名
 * @returns {boolean} 是否执行了重置
 */
export function resetStage(name) {
  if (!STAGES.includes(name)) return false;
  delete st.stages[name];
  st.rev += 1;
  st.pending.set(name, [{ stage: name, state: 'mounted', at: Date.now(), reset: true }]);
  // **立刻上报**：reset 若被去抖窗口里的后续 mark 覆盖，服务端就只见到"最终状态"，
  //   而它相对旧记录是同级/退步 ⇒ 整轮推进被静默丢弃（实测踩过：换模型后 SSE 一条 update 都收不到）。
  flushNow();
  return true;
}

/** 页面内直读快照（契约 §5.1）：ready() 全量，ready('model') 单阶段 */
export function snapshot(stage) {
  const at = Date.now();
  if (stage) {
    const name = String(stage);
    if (!STAGES.includes(name)) return { ok: false, error: `未登记的阶段：${name}`, known: STAGES.slice() };
    const rec = st.stages[name];
    // 还没上报 ⇒ pending（与 HTTP 通道同口径；不用 unknown，契约 §四 没这个值）
    return rec ? { at, rev: st.rev, stage: name, ...rec } : { at, rev: st.rev, stage: name, state: 'pending' };
  }
  return { at, rev: st.rev, stages: { ...st.stages } };
}

/** 去抖调度上报 */
function schedule() {
  if (st.timer) return;
  st.timer = setTimeout(() => {
    st.timer = null;
    flush();
  }, FLUSH_DEBOUNCE_MS);
}

/** 上报待发送的变更（失败静默：就绪通道坏掉不应影响页面） */
function flush() {
  if (!st.pending.size) return;
  const updates = [...st.pending.values()].flat();
  st.pending.clear();
  try {
    fetch('/api/ready', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
      keepalive: true,
      // 就绪通道是旁路信号：服务端卡住不能把页面拖住（5s 超时，超时即放弃本次上报）
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch {
    /* 忽略 */
  }
}

/** 立刻上报（页面隐藏/卸载前调用，避免最后一批状态丢失） */
export function flushNow() {
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  flush();
}

/**
 * 跟踪「模型」阶段的三级状态（契约 §2.2）。
 *
 * 判据（**不用像素采样**）：
 *   · mounted     —— 画布 isConnected 且尺寸非零
 *   · painted     —— 渲染器自己的已绘帧计数 ≥ 1（硬计数；像素采样在画布 detached 时也会"有颜色"）
 *   · interactive —— 动作/动画清单非空
 *
 * @param {{kind: string, id: string|null, canvas: object|null, getFrames: Function, getActions: Function, timeoutMs?: number}} opts
 * @returns {() => void} 停止跟踪
 */
export function trackModelStage(opts) {
  const { kind, id, canvas, getFrames, getActions } = opts || {};
  const timeoutMs = Number(opts && opts.timeoutMs) || 8000;
  const t0 = Date.now();
  let stopped = false;
  const base = { kind: kind || null, id: id || null };
  // 换模型（或第一次装载）时重新起算 model 阶段：
  //   否则上一轮的 interactive 会被新模型继承，"等 painted"在新模型上永远不会重新发生。
  const prevId = st.stages.model && st.stages.model.detail ? st.stages.model.detail.id : null;
  if (prevId !== base.id) resetStage('model');

  const mountedNow = () => {
    const el = canvas || null;
    if (!el || el.isConnected !== true) return false;
    const w = Math.max(el.width || 0, el.clientWidth || 0);
    const h = Math.max(el.height || 0, el.clientHeight || 0);
    return w > 0 && h > 0;
  };
  const frames = () => {
    try { return Number(getFrames && getFrames()) || 0; } catch { return 0; }
  };
  const actions = () => {
    try { return Number(getActions && getActions()) || 0; } catch { return 0; }
  };

  // 严格按 mounted → painted → interactive 推进（契约 §2.2）：
  //   interactive 不得越过 painted —— 动作清单在装载完成瞬间就可能非空，
  //   若不拦住，会在"一帧都还没画"时报 interactive，等于把分级做成了摆设。
  let painted = false;
  const tick = () => {
    if (stopped) return;
    if (mountedNow()) markStage('model', 'mounted', { ...base });
    const f = frames();
    if (!painted && f >= 1) {
      painted = true;
      markStage('model', 'painted', { ...base, frames: f });
    }
    const a = actions();
    if (painted && a > 0) {
      markStage('model', 'interactive', { ...base, frames: f, actions: a });
      stop();
      return;
    }
    if (Date.now() - t0 > timeoutMs) { stop(); return; }
    setTimeout(tick, 80); // 轮询间隔 80ms：只读计数，代价可忽略，且远低频于渲染帧
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    flushNow(); // 阶段推进完立刻落地，别等去抖窗口
  }

  tick();
  return stop;
}

/**
 * 跟踪「某个 DOM 阶段」的三级状态（契约 §2.1）。
 *
 * 判据（三级不是摆设，尤其 settled）：
 *   · mounted     —— 元素已插入文档（isConnected）
 *   · settled     —— **动画/布局稳定**：该元素（含子树）没有正在跑的动画（Web Animations 的
 *                    running/pending），且连续两次采样的包围盒一致。影院模式 header.bottom 48→0
 *                    这类 transition 期间会故意不报 settled。
 *   · interactive —— settled 之后仍稳定，且没有 pointer-events:none、子树里没有 data-pending
 *                    （即"点了不会打偏、也没有待接线控件"）。
 *
 * @param {{name: string, el: Element, detail?: object, timeoutMs?: number}} opts
 * @returns {() => void} 停止跟踪
 */
/** 元素当前包围盒的紧凑表示（两次采样相等 ⇒ 布局稳定） */
function boxOf(node) {
  try {
    const r = node.getBoundingClientRect();
    return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
  } catch { return null; }
}

/** 该元素（含子树）是否还有正在跑/待跑的动画 —— settled 的核心判据 */
function animating(node) {
  try {
    if (typeof node.getAnimations !== 'function') return false;
    return node.getAnimations({ subtree: true }).some((a) => a.playState === 'running' || a.playState === 'pending');
  } catch { return false; }
}

/** 是否还有"不可交互"的迹象：pointer-events:none 或待接线控件 */
function blocked(node) {
  try {
    const cs = getComputedStyle(node);
    if (cs && cs.pointerEvents === 'none') return true;
    return !!node.querySelector('[data-pending="true"]');
  } catch { return false; }
}

export function trackElementStage(opts) {
  const { name, el } = opts || {};
  const timeoutMs = Number(opts && opts.timeoutMs) || 8000;
  const t0 = Date.now();
  let stopped = false;
  let prevBox = null;
  let stableHits = 0;

  const stop = () => { if (!stopped) { stopped = true; flushNow(); } };

  const tick = () => {
    if (stopped) return;
    if (!el || el.isConnected !== true) {
      if (Date.now() - t0 > timeoutMs) stop(); else setTimeout(tick, 80);
      return;
    }
    markStage(name, 'mounted', opts && opts.detail ? { ...opts.detail } : null);
    const box = boxOf(el);
    const busy = animating(el);
    if (!busy && box && box === prevBox) stableHits += 1; else stableHits = 0;
    prevBox = box;
    // 连续两次采样都稳定且无动画 ⇒ 视为布局/动画稳定
    if (stableHits >= 1) {
      markStage(name, 'settled', { ...(opts && opts.detail ? opts.detail : {}), box });
      if (!blocked(el)) {
        markStage(name, 'interactive', { ...(opts && opts.detail ? opts.detail : {}), box });
        stop();
        return;
      }
    }
    if (Date.now() - t0 > timeoutMs) { stop(); return; }
    setTimeout(tick, 120);
  };
  tick();
  return stop;
}

/**
 * 等元素出现后再开始三级跟踪（元素可能由别的模块异步挂载）。
 * @param {{name: string, selector: string, detail?: object, timeoutMs?: number}} opts
 * @returns {() => void} 停止
 */
export function trackElementWhenReady(opts) {
  const { name, selector } = opts || {};
  const timeoutMs = Number(opts && opts.timeoutMs) || 10000;
  const t0 = Date.now();
  let inner = null;
  let stopped = false;
  const tryStart = () => {
    if (stopped || inner) return;
    const el = document.querySelector(selector);
    if (el) { inner = trackElementStage({ ...opts, name, el }); return; }
    if (Date.now() - t0 > timeoutMs) { stopped = true; return; }
    setTimeout(tryStart, 80);
  };
  tryStart();
  return () => { stopped = true; if (inner) inner(); };
}

/** 标记模型阶段失败（带可读原因，测试可立即报错而不必等超时） */
export function markModelFailed(reason, detail) {
  return markStage('model', 'failed', detail || null, reason);
}

/** 装到 window.__WEB__ 上（契约 §5.1） */
export function installReadyApi(web) {
  if (!web || st.installed) return;
  st.installed = true;
  // 新页面实例接入：先让服务端清掉上一轮阶段。
  //   否则"刷新后还没装载模型"的这段时间里，服务端仍报着上一轮模型的 interactive —— 测试会据此误判。
  try {
    fetch('/api/ready', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true }),
      keepalive: true,
      // 就绪通道是旁路信号：服务端卡住不能把页面拖住（5s 超时，超时即放弃本次上报）
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch { /* 忽略 */ }
  web.ready = (stage) => snapshot(stage);
  // 页面要走了：把最后一批状态落地
  try {
    if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { try { flushNow(); } catch { /* 忽略 */ } });
  } catch { /* 忽略 */ }
}
