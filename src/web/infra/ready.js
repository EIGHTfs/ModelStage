// infra/ready.js —— 就绪信号（页面侧）：阶段状态上报 + 页面内直读
//
// 契约：docs/契约/交互与实现约束.md。与 diag 完全分离：
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

/** 模型阶段轮询间隔（ms）：只读帧计数/动作数，代价可忽略，且远低频于渲染帧 */
const MODEL_POLL_MS = 80;
/** DOM 阶段轮询间隔（ms）：读包围盒/动画状态，120ms 足够判断"稳定" */
const ELEMENT_POLL_MS = 120;
/** 上报去抖窗口（ms）：同一窗口内的多次变更合成一条请求 */
// 复用模型文件那条重试实现（用户实测：同一时刻模型文件因有重试而成功、/api/ready 因裸 fetch 而失败）
import { fetchWithRetry } from './api.js';

// 上报合并窗口：模型装载完成会**连续**标记 model/panel/bottombar 三个阶段，
//   窗口太短就会各发一条（现场：模型加载成功后 41ms 内连发 2~3 条 POST，全部 Failed to fetch，
//   因为那一刻模型文件的几十个请求正占满同源连接槽）。400ms 足以把它们合成一条，
//   又不会让就绪信号明显滞后。
const FLUSH_DEBOUNCE_MS = 400;

/** 轮询超时记录的保留条数（环形）：只留最近若干条，长时间运行不堆积 */
const TRACK_STOP_KEEP = 20;
/** 同一阶段同一结局的告警限频（ms）：换模型可能反复超时，不能让同一句话刷屏 */
const TRACK_WARN_WINDOW_MS = 10000;

const st = {
  stages: {},          // stage → { state, at, detail?, reason? }
  rev: 0,              // 本地 rev（服务端才是权威；这里供 __WEB__.ready() 立即可读）
  pending: new Map(),  // stage → update[]（待上报，**队列**：同阶段的中间态不能互相覆盖）
  timer: null,
  installed: false,
  flushes: 0,          // 实际上报次数（每次真正发出 POST 计 1；供"批量重置只报一次"的断言用）
  inflight: false,     // 上一次上报还没回来（并发保护：跳过一次，避免请求堆积）
  dropped: 0,          // 因 in-flight 被跳过的次数（可观测，便于判断"是不是报得太密"）
  fails: 0,            // 上报失败次数（限频记日志，不刷屏）
  lastFailAt: 0,
  lastFail: null,   // {at,name,msg,attempts}：一次失败就能看出是网络层还是超时（排障唯一途径）
  // 轮询跟踪的"结束记录"（环形，最近 TRACK_STOP_KEEP 条）：
  //   超时不再静默——每条都留下 阶段 / 等多久 / 最后观测到什么 / 属于哪种结局，
  //   由 stats().trackStops 暴露（与 lastFail 同一条诊断面，不新造日志体系）。
  trackStops: [],
  trackWarnAt: new Map(),   // `${stage}:${outcome}` → 上次告警时间（限频用）
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
/**
 * 重置的内部实现（**不触发上报**）：清掉已有等级、塞一条 reset 记录进待发队列。
 * @param {string} name 阶段名
 * @returns {boolean} 是否是合法阶段
 */
function resetStageInternal(name) {
  if (!STAGES.includes(name)) return false;
  delete st.stages[name];
  st.rev += 1;
  st.pending.set(name, [{ stage: name, state: 'mounted', at: Date.now(), reset: true }]);
  return true;
}

/**
 * 重置单个阶段并立刻上报。
 * **为什么要立刻上报**：reset 若被去抖窗口里的后续 mark 覆盖，服务端就只见到"最终状态"，
 *   而它相对旧记录是同级/退步 ⇒ 整轮推进被静默丢弃（实测踩过：换模型后 SSE 一条 update 都收不到）。
 * @param {string} name 阶段名
 * @returns {boolean} 是否执行了重置
 */
export function resetStage(name) {
  const ok = resetStageInternal(name);
  if (ok) scheduleFlush();
  return ok;
}

/**
 * 批量重置多个阶段，**整批只上报一次**。
 *
 * 为什么需要：一次交互（如切影院模式）会同时影响顶栏与两侧栏；逐个 resetStage 会各发一次 POST，
 *   在慢机器上这些请求容易在页面关闭/负载高时被 AbortSignal 超时中止，表现为一串
 *   `net::ERR_ABORTED (Fetch)` 噪音（实测：f2-topbar 的 problems 从 10 涨到 47）。
 * @param {string[]} names 阶段名数组（非法项自动跳过）
 * @returns {string[]} 实际被重置的阶段名
 */
export function resetStages(names, opts) {
  const flushNowAfter = !(opts && opts.flush === false);
  const done = [];
  for (const name of Array.isArray(names) ? names : []) {
    if (resetStageInternal(name)) done.push(name);
  }
  // flush:false 时不在这里发：调用方紧接着会重新跟踪，跟踪的第一拍 markStage('mounted')
  //   会把 reset + mounted 一起进同一个去抖窗口 ⇒ 整次交互只发 1 个 POST。
  if (done.length && flushNowAfter) scheduleFlush();
  return done;
}

/**
 * 上报统计（诊断/断言用）。
 * @returns {{flushes: number, pending: number, rev: number, dropped: number, fails: number, inflight: boolean}}
 *   上报次数 / 待发条数 / 本地 rev / 因 in-flight 被跳过的次数 / 失败次数 / 是否在飞
 */
export function stats() {
  return {
    flushes: st.flushes, pending: st.pending.size, rev: st.rev, dropped: st.dropped, fails: st.fails,
    inflight: st.inflight, lastFail: st.lastFail,
    // 轮询跟踪的结束记录（含超时与外部取消）：排障时先看这里，再看阶段本身
    trackStops: st.trackStops.slice()
  };
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

/**
 * 上报待发送的变更（就绪通道是旁路信号，坏掉不影响页面）。
 *
 * `keepalive` **只允许在"页面即将卸载"时用**（flushNow → pagehide），因为浏览器对它有两条硬限制：
 *   ① 所有 in-flight keepalive 请求的 body 总量 ≤ 64KB，超了直接 `Failed to fetch`；
 *   ② 它**占用 fetch 连接槽**（HTTP/1.1 每主机 6 个），普通请求（如模型文件）会被挤出去。
 * 曾经常规上报也带 keepalive：切换模型 → 每次 resetStage('panel') → flush() → keepalive 请求堆积
 *   → 模型文件（几十个并发）被挤出连接池 → **所有模型加载失败、刷新页面才恢复**，日志里刷
 *   `net.fail · POST /api/ready · Failed to fetch`。所以默认值必须是 false。
 *
 * @param {{keepalive?: boolean}} [opts]
 */
function flush(opts) {
  const keepalive = !!(opts && opts.keepalive);
  if (!st.pending.size) return;
  // 并发保护：上一次还没回来就跳过本次（丢一次上报是可接受的——就绪信号是旁路，
  //   下一次会带全量阶段快照；而堆积的请求会挤占连接槽，代价大得多）。
  if (st.inflight) { st.dropped += 1; return; }
  const updates = [...st.pending.values()].flat();
  st.pending.clear();
  st.flushes += 1;
  st.inflight = true;
  const payload = JSON.stringify({ updates });
  const headers = { 'Content-Type': 'application/json' };
  const onFail = (e, attempts) => {
    st.fails += 1;
    // 记最后一次失败的结构化原因（不打印，避免刷屏；由 readyStats() 暴露）
    st.lastFail = {
      at: Date.now(),
      name: (e && e.name) || null,
      msg: String((e && e.message) || e).slice(0, 120),
      attempts: attempts || 1,
    };
    const now = Date.now();
    if (now - st.lastFailAt > 10000) {
      st.lastFailAt = now;
      try {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn(`[ready] 上报失败 ${st.fails} 次（最近）: ${st.lastFail.msg}`);
        }
      } catch { /* 忽略 */ }
    }
  };
  try {
    if (keepalive) {
      // 卸载前：**不重试**（页面已经在走，没时间退避），keepalive 保证尽力送达
      fetch('/api/ready', { method: 'POST', headers, body: payload, keepalive: true, signal: AbortSignal.timeout(5000) })
        .catch((e) => onFail(e, 1))
        .finally(() => { st.inflight = false; });
    } else {
      // 常规上报：与模型文件走同一条重试实现（旁路信号 ⇒ 3s 超时 + 2 次快速重试）
      fetchWithRetry('/api/ready', { method: 'POST', headers, body: payload, timeoutMs: 3000, retries: 2, label: 'ready-flush' })
        .catch((e) => onFail(e, 3))
        .finally(() => { st.inflight = false; });
    }
  } catch {
    st.inflight = false;
  }
}

/**
 * 安排一次合并上报（**常规路径都走这里**）。
 *
 * 为什么不是立刻发：模型装载完成那一刻，14 个 motion3.json + 纹理正占满同源连接槽（6 个），
 *   此刻再发 POST 会**瞬间** Failed to fetch（实测：装载成功后 41ms 内两条同时失败，同一毫秒）。
 *   所以：攒窗口 + 每次新阶段重置计时，等连接池冷下来再发。
 */
export function scheduleFlush() {
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => {
    st.timer = null;
    flush();
  }, FLUSH_DEBOUNCE_MS);
}

/**
 * 立刻上报。**这是唯一允许 keepalive 的路径**（页面隐藏/卸载前调用，避免最后一批状态丢失）。
 * 注意：并发保护在这里不生效（卸载前必须尽力发出），所以显式绕过 inflight 检查。
 */
export function flushNow() {
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  st.inflight = false; // 卸载前不因"上一次还在飞"而丢最后一批
  flush({ keepalive: true });
}

/**
 * 记录一次"跟踪结束"（超时 / 外部取消），并做限频告警。
 *
 * 为什么必须分三种结局（混成一句"超时"会把排错方向带偏）：
 *   · 'no-observation' —— 全程**没有任何观测**（未挂载、帧数恒 0、元素始终不存在）⇒ 这才是真的"没来"
 *   · 'not-interactive' —— 有观测但没到 interactive 门槛（已 painted/settled、动作数 0 等）⇒ "到了但不够"
 *   · 'cancelled' —— 被调用方主动 stop() 取消 ⇒ **不是超时**，不告警、绝不判失败
 *
 * 落点选择：本模块与 diag 分离是既定契约（见文件头），所以这里不发明新日志，
 *   而是把记录挂到**既有诊断面** stats() 上（页面侧 `__WEB__.readyStats()` 可读），
 *   并配一条限频 console.warn 给看控制台的人。
 *
 * @param {{stage:string, outcome:'no-observation'|'not-interactive'|'cancelled',
 *          waitedMs:number, timeoutMs:number, state:string|null, last:object}} rec
 */
function recordTrackStop(rec) {
  const entry = { at: Date.now(), ...rec };
  st.trackStops.push(entry);
  if (st.trackStops.length > TRACK_STOP_KEEP) st.trackStops.shift();
  if (entry.outcome === 'cancelled') return entry;   // 外部取消：不是异常，保持安静
  const key = `${entry.stage}:${entry.outcome}`;
  const lastAt = st.trackWarnAt.get(key) || 0;
  const now = entry.at;
  if (now - lastAt > TRACK_WARN_WINDOW_MS) {
    st.trackWarnAt.set(key, now);
    try {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[ready] ${entry.stage} 阶段 ${entry.waitedMs}ms 未达 interactive（${entry.outcome}）`
          + `：当前 ${entry.state || 'pending'}，最后观测 ${JSON.stringify(entry.last || {})}`);
      }
    } catch { /* 忽略 */ }
  }
  return entry;
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
  const base = { kind: kind || null, id: id || null };
  // 换模型（或第一次装载）时重新起算 model 阶段：
  //   否则上一轮的 interactive 会被新模型继承，"等 painted"在新模型上永远不会重新发生。
  const prevId = st.stages.model && st.stages.model.detail ? st.stages.model.detail.id : null;
  if (prevId !== base.id) resetStage('model');

  const mountedNow = () => canvasMounted(canvas);
  const frames = () => safeCount(getFrames);
  const actions = () => safeCount(getActions);

  // 严格按 mounted → painted → interactive 推进（契约 §2.2）：
  //   interactive 不得越过 painted —— 动作清单在装载完成瞬间就可能非空，
  //   若不拦住，会在"一帧都还没画"时报 interactive，等于把分级做成了摆设。
  let painted = false;
  // 最后一次观测到的值：超时时它是"卡在哪一步"的唯一证据（帧数/动作数/是否挂载）
  const lastSeen = { mounted: false, frames: 0, actions: 0 };
  // 收尾：done=正常达标 / timeout=等到了上限 / cancelled=被调用方主动取消。
  //   判失败的条件 = 全无观测 **且** 阶段还没到 painted（模型画布不该缺席，所以允许判失败）。
  const finisher = createTrackFinisher({
    stage: 'model', t0, timeoutMs,
    last: () => ({ ...base, ...lastSeen, painted }),
    currentState: () => (st.stages.model ? st.stages.model.state : null),
    allowFail: () => (RANK[st.stages.model ? st.stages.model.state : null] || 0) < RANK.painted,
    failDetail: () => ({ ...base, ...lastSeen }),
    failReason: (waitedMs) => `模型 ${timeoutMs}ms 内无任何观测（画布未挂载 / 已绘帧数 0；已等 ${waitedMs}ms）`,
  });
  const finish = finisher.finish;
  const isStopped = finisher.isStopped;
  const tick = () => {
    if (isStopped()) return;
      lastSeen.mounted = mountedNow();
    if (lastSeen.mounted) markStage('model', 'mounted', { ...base });
    const f = frames();
    lastSeen.frames = f;
    if (!painted && f >= 1) {
      painted = true;
      markStage('model', 'painted', { ...base, frames: f });
    }
    const a = actions();
    lastSeen.actions = a;
    if (painted && a > 0) {
      markStage('model', 'interactive', { ...base, frames: f, actions: a });
      finish('done');
      return;
    }
    if (Date.now() - t0 > timeoutMs) { finish('timeout'); return; }
    setTimeout(tick, MODEL_POLL_MS);
  };

  tick();
  return () => finish('cancelled');
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
/** 执行阶段的附加判据；抛错按"未就绪"处理（不能因探针异常就报绿） */
function safeProbe(fn) {
  try {
    const r = fn();
    return r && typeof r === 'object' ? { ok: r.ok === true, detail: r.detail || (r.ok ? {} : { probeError: 'ok=false' }) } : { ok: false, detail: { probeError: '探针无返回值' } };
  } catch (e) {
    return { ok: false, detail: { probeError: String((e && e.message) || e).slice(0, 80) } };
  }
}

/**
 * 造一个"跟踪收尾器"：三个 track* 共用的结局记录逻辑。
 *
 * 抽出来的原因：三段代码的收尾几乎一样（记录 → 是否判失败 → 合并上报），
 *   分开写会让每个 track 函数都超出单函数代码行上限，而且三处判断容易走偏。
 *
 * @param {{stage:string, t0:number, timeoutMs:number, last:()=>object,
 *          currentState:()=>string|null, allowFail:()=>boolean,
 *          failDetail:()=>object, failReason:(waitedMs:number)=>string}} spec
 * @returns {{finish:(kind:'done'|'timeout'|'cancelled')=>void, isStopped:()=>boolean}}
 */
function createTrackFinisher(spec) {
  let stopped = false;
  const finish = (kind) => {
    if (stopped) return;
    stopped = true;
    if (kind !== 'done') {
      const waitedMs = Date.now() - spec.t0;
      const stateNow = spec.currentState();
      const last = spec.last();
      const observed = last && (last.connected === true || last.mounted === true
        || Number(last.frames) > 0 || Number(last.actions) > 0 || last.seen === true);
      const outcome = kind === 'cancelled' ? 'cancelled' : (observed ? 'not-interactive' : 'no-observation');
      recordTrackStop({ stage: spec.stage, outcome, waitedMs, timeoutMs: spec.timeoutMs, state: stateNow, last });
      // 只有"什么都没观测到"且调用方允许判失败时才标 failed —— 已有画面时绝不撒谎
      if (outcome === 'no-observation' && spec.allowFail()) {
        markStage(spec.stage, 'failed', { ...spec.failDetail(), waitedMs }, spec.failReason(waitedMs));
      }
    }
    scheduleFlush();
  };
  return { finish, isStopped: () => stopped };
}

/** 画布是否已挂载且有非零尺寸（模型阶段 mounted 的判据：detached/0 尺寸都不算挂上） */
function canvasMounted(canvas) {
  if (!canvas || canvas.isConnected !== true) return false;
  const w = Math.max(canvas.width || 0, canvas.clientWidth || 0);
  const h = Math.max(canvas.height || 0, canvas.clientHeight || 0);
  return w > 0 && h > 0;
}

/** 读一个计数型探针（抛错按 0 处理：探针异常不能把跟踪器带崩） */
function safeCount(read) {
  try { return Number(read && read()) || 0; } catch { return 0; }
}

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
  let prevBox = null;
  let stableHits = 0;
  // 最后观测：元素是否在文档里、包围盒、是否有动画、是否被挡住、探针结论
  const lastSeen = { connected: false, box: null, animating: null, blocked: null, probeOk: null };

  // DOM 阶段默认**不判失败**：元素不存在可能是正常配置（如未开调试日志时的调试面板），
  //   把它标成失败是另一种撒谎；只留可归因记录。调用方要"缺席即失败"时显式传 failOnNoObservation。
  const finisher = createTrackFinisher({
    stage: name, t0, timeoutMs,
    last: () => ({ ...(opts && opts.detail ? opts.detail : {}), ...lastSeen }),
    currentState: () => (st.stages[name] ? st.stages[name].state : null),
    allowFail: () => opts && opts.failOnNoObservation === true
      && (RANK[st.stages[name] ? st.stages[name].state : null] || 0) < RANK.mounted,
    failDetail: () => ({ ...(opts && opts.detail ? opts.detail : {}), ...lastSeen }),
    failReason: (waitedMs) => `${timeoutMs}ms 内元素未挂载（${name}；已等 ${waitedMs}ms）`,
  });
  const { finish, isStopped } = finisher;

  const tick = () => {
    if (isStopped()) return;
    lastSeen.connected = !!(el && el.isConnected === true);
    if (!el || el.isConnected !== true) {
      if (Date.now() - t0 > timeoutMs) finish('timeout'); else setTimeout(tick, 80);
      return;
    }
    markStage(name, 'mounted', opts && opts.detail ? { ...opts.detail } : null);
    const box = boxOf(el);
    const busy = animating(el);
    lastSeen.box = box;
    lastSeen.animating = busy;
    if (!busy && box && box === prevBox) stableHits += 1; else stableHits = 0;
    prevBox = box;
    // 连续两次采样都稳定且无动画 ⇒ 视为布局/动画稳定
    if (stableHits >= 1) {
      markStage(name, 'settled', { ...(opts && opts.detail ? opts.detail : {}), box });
      // interactive 可在通用判据之外再加该阶段自己的条件（如"声明内的控件都构建了"）：
      //   探针返回 {ok, detail}；不 ok 就继续等，绝不为了"报绿"放宽。
      const probe = opts && typeof opts.interactiveProbe === 'function' ? safeProbe(opts.interactiveProbe) : { ok: true, detail: {} };
      lastSeen.probeOk = probe.ok;
      lastSeen.blocked = blocked(el);
      if (!lastSeen.blocked && probe.ok) {
        markStage(name, 'interactive', { ...(opts && opts.detail ? opts.detail : {}), ...(probe.detail || {}), box });
        finish('done');
        return;
      }
    }
    if (Date.now() - t0 > timeoutMs) { finish('timeout'); return; }
    setTimeout(tick, ELEMENT_POLL_MS);
  };
  tick();
  return () => finish('cancelled');
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
  // 元素是否曾经出现过：没出现过 = 'no-observation'（连跟踪都没开始），
  //   出现过则由内层 trackElementStage 自己记录（它才知道卡在哪一步）。
  let seen = false;

  const finish = (kind) => {
    if (stopped) return;
    stopped = true;
    if (inner) { inner(); return; }   // 交给内层收尾（它会记录自己那份）
    if (kind !== 'done') {
      const stateNow = st.stages[name] ? st.stages[name].state : null;
      const outcome = kind === 'cancelled' ? 'cancelled' : (seen ? 'not-interactive' : 'no-observation');
      recordTrackStop({
        stage: name, outcome, waitedMs: Date.now() - t0, timeoutMs, state: stateNow,
        last: { selector, seen },
      });
      if (outcome === 'no-observation' && opts && opts.failOnNoObservation === true
        && (RANK[stateNow] || 0) < RANK.mounted) {
        markStage(name, 'failed', { ...(opts.detail || {}), selector, waitedMs: Date.now() - t0 },
          `${timeoutMs}ms 内未找到元素 ${selector}（${name}）`);
      }
    }
    scheduleFlush();
  };

  const tryStart = () => {
    if (stopped || inner) return;
    const el = document.querySelector(selector);
    if (el) { seen = true; inner = trackElementStage({ ...opts, name, el }); return; }
    if (Date.now() - t0 > timeoutMs) { finish('timeout'); return; }
    setTimeout(tryStart, MODEL_POLL_MS);
  };
  tryStart();
  return () => { if (inner) { stopped = true; inner(); return; } finish('cancelled'); };
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
      // 这处是**页面加载时**发的（清上一轮阶段），不属于"卸载前送达"场景
      //   ⇒ 刻意不传 keepalive（默认 false）
      // 就绪通道是旁路信号：服务端卡住不能把页面拖住（5s 超时，超时即放弃本次上报）
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch { /* 忽略 */ }
  web.ready = (stage) => snapshot(stage);
  // 上报统计（自动化断言用：flushes / dropped / fails / inflight）
  web.readyStats = () => stats();
  // 页面要走了：把最后一批状态落地
  try {
    if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { try { flushNow(); } catch { /* 忽略 */ } });
  } catch { /* 忽略 */ }
}
