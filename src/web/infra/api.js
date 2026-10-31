// api.js —— 同源 HTTP 封装（唯一一层：重试 / 退避+抖动 / 超时 / in-flight 去重）
//
// 做什么：给上层提供 getJson() / postJson()，把「网络失败、超时、非 2xx、非 JSON」四类问题
//   在这一层统一处理，上层调用点的语义保持不变（仍旧是"成功拿数据、失败抛 Error(message)"）��
// ⚠️ **一个刻意的例外：postStream()**（事件流，见文件末尾）。它**不走**重试/退避/固定超时那一套 ——
//   流式响应的判据是"有没有进展"（连续无帧才算停摆），不是"总时长"：套用 8.5s 会重演
//   "慢机器被误判成失败"的老坑。除它以外，本文件所有请求仍统一走 fetchWithRetry。
// 为什么集中在这一层：M2 之后调用点越来越多（tree/models/model-meta/plugins…），
//   重试与超时若各写一遍必然漂移；而网络抖动是全局问题，不是某个接口的个性。
//
// 三条策略要点（都有实测依据，别随手改）：
//   1. **只重试"可能自愈"的失败**：网络错误（Failed to fetch）、超时、5xx。
//      **4xx 一律不重试**——参数错/不存在，重试只是浪费时间并刷日志。
//   2. **退避 + 抖动**：100/300/900ms 基准，±20% 随机抖动，避免大量请求同时重试打成一波。
//   3. **"防抖"= in-flight 去重，不是延迟发送**：同一 GET 并发合并成一个 Promise；
//      **POST 绝不合并**（有副作用，合并会让"点两次"变成"点一次"）。
//
// 已知边界：
//   · 调用方自带 signal 的 GET **不参与去重**（各自可能取消，合并会让一方取消影响另一方）。
//   · 去重键是「method + path」，不含请求头；同路径不同 Accept 会被合并——本项目 API 都是同源 JSON，
//     不存在这种用法。

/** 单次请求默认超时：8.5s（比常见反代 10s 略短，让"卡住"更早暴露成本地超时而非网关 504） */
const DEFAULT_TIMEOUT_MS = 8500;

/** 退避基准（毫秒）：第 1/2/3 次重试前的等待；抖动 ±20% */
const BACKOFF_MS = [100, 300, 900];

/** 默认最多重试次数（即最多尝试 3 次：首发 + 2 次重试） */
const DEFAULT_RETRIES = 2;

/**
 * 幂等方法：失败重发是安全的（服务端不产生副作用）。
 *
 * 非幂等方法（POST/PUT/PATCH/DELETE）**默认 retries: 0** —— 重发写请求就是重复写：
 *   实测过的形态：POST /api/backgrounds/solids 创建成功但响应在网络上丢了 ⇒ 自动重发 ⇒ 建出两个纯色。
 * 需要重试的非幂等调用方必须**显式**传 retries（例如 /api/ready 的阶段上报本身幂等，
 *   它在调用点写了 retries: 2，那是有意为之，不是这里的默认值）。
 */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 解析本次请求的"是否幂等"（决定默认重试次数）。
 * @param {string} method
 * @returns {boolean}
 */
function isIdempotentMethod(method) {
  return IDEMPOTENT_METHODS.has(String(method || 'GET').toUpperCase());
}

/** 抖动比例（±该比例）：避免多请求同一时刻重试打成一波 */
const JITTER_RATIO = 0.2;

/** 按 JITTER_RATIO 加随机抖动 */
function jitter(ms) {
  const delta = ms * JITTER_RATIO;
  return Math.max(0, Math.round(ms - delta + Math.random() * delta * 2));
}

/** 该 HTTP 状态是否值得重试：只有 5xx；4xx 明确不重试 */
function retryableStatus(status) {
  return status >= 500 && status <= 599;
}

/** 是否"网络层失败"（fetch 抛 TypeError，或超时导致的 TimeoutError） */
function retryableNetworkError(err) {
  if (!err) return false;
  const name = String(err.name || '');
  const msg = String(err.message || '');
  if (name === 'TimeoutError') return true;   // AbortSignal.timeout 触发的超时
  if (name === 'AbortError') return false;    // 调用方主动取消：不能重试
  return err instanceof TypeError || /Failed to fetch|network|fetch failed/i.test(msg);
}

/** 单条诊断日志（重试/最终失败各一条，不刷屏） */
function note(message) {
  try {
    console.warn(`[api] ${message}`);
  } catch {
    /* 日志失败不影响请求 */
  }
}

/** 读响应体：空体返回 null；非 JSON 抛带原文片段的错误 */
async function readBody(res, path, method) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
}

/** 单次尝试：返回解析后的 body，或抛出带 status 的错误 */
async function attemptOnce(path, { method, body, headers, timeoutMs, signal, cache }) {
  // 每次尝试都有独立超时（AbortSignal.timeout）：卡死的请求不会无限挂住页面
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const merged = signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeoutSignal])
    : (signal || timeoutSignal);
  const res = await fetch(path, {
    method,
    headers: {
      Accept: MIME_JSON,
      ...(body !== undefined ? { 'Content-Type': MIME_JSON } : {}),
      ...(headers || {}),
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    // cache 必须能透传：插件清单 / 运行时清单这类"改完要立刻看到"的请求带 no-store，
    //   丢掉它会读到浏览器缓存（新增插件在前端看不见）。以前 api.js 不透传，调用方只能裸 fetch。
    ...(cache ? { cache } : {}),
    signal: merged,
  });

  if (res.ok) return readBody(res, path, method);

  // 非 2xx：优先用服务端 JSON 错误体的 error 字段
  let parsed = null;
  let raw = '';
  try {
    raw = await res.text();
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const detail = parsed && typeof parsed.error === 'string' ? parsed.error : `HTTP ${res.status}`;
  const err = new Error(`${method} ${path} 失败：${detail}`);
  err.status = res.status;   // 供重试判定与上层细分（不改变 message 语义）
  err.body = parsed;
  if (raw && !parsed) err.raw = raw.slice(0, 200);
  throw err;
}

/**
 * 抓取统计（**验收核心指标**）：重试是补救，真正要盯的是「首次尝试成功率」。
 * firstTryOk / calls ≥ 99% 才算根因已除；90~99% 有残留 race；<90% 说明重试在掩盖问题。
 */
export const retryStats = {
  calls: 0,        // fetchWithRetry 调用次数
  firstTryOk: 0,   // 第 1 次尝试就成功
  retried: 0,      // 走了重试（且最终成功）
  exhausted: 0,    // 重试耗尽仍失败
  attemptsTotal: 0, // 实际发出的 HTTP 尝试总数（对比 calls 可看出平均重试次数）
  inflight: 0,      // 当前在飞的 fetchWithRetry 数
  maxInflight: 0,   // 峰值并发（验收"解包期间在飞请求 ≤4"）
  slowestMs: 0,     // 单个请求最长耗时（验收"无请求超过 8s"）
  byLabel: {},     // label → {calls, firstTryOk, retried, exhausted}
};

/** 取/建某 label 的计数桶 */
function bucketOf(label) {
  const k = String(label || 'unknown');
  if (!retryStats.byLabel[k]) retryStats.byLabel[k] = { calls: 0, firstTryOk: 0, retried: 0, exhausted: 0 };
  return retryStats.byLabel[k];
}

/** 重置统计（测试/验收开始前调用，保证数字干净） */
/** JSON 的 MIME：请求头与响应头两处都用它（同一个字面量原来写了三遍） */
const MIME_JSON = 'application/json';
export function resetRetryStats() {
  retryStats.calls = 0;
  retryStats.firstTryOk = 0;
  retryStats.retried = 0;
  retryStats.exhausted = 0;
  retryStats.attemptsTotal = 0;
  retryStats.inflight = 0;
  retryStats.maxInflight = 0;
  retryStats.slowestMs = 0;
  retryStats.byLabel = {};
}

/**
 * 并发受限的 map（不引依赖）。
 *
 * 为什么需要：资源包解包后要取 39 个文件，若一次全发会**吃满浏览器同源 6 个连接槽**，
 *   后续请求（Spine 模型文件、/api/ready）全部排队直至超时 ⇒ 现场表现"资源包之后全挂"。
 *   限到 4 个并发可让其它请求始终有槽可用。
 *
 * @param {Array} items
 * @param {number} limit 并发上限
 * @param {(item: any, index: number) => Promise<any>} fn
 * @returns {Promise<Array>} 与 items 同序的结果
 */
export async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  const n = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  let cursor = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const k = cursor;
      cursor += 1;
      if (k >= list.length) return;
      out[k] = await fn(list[k], k);
    }
  }));
  return out;
}

/**
 * 是否输出逐请求明细（默认关，避免刷屏）：URL 带 ?netlog=1 时开启。
 * 用途：区分"同一条请求重试连发"与"多个请求并发"——日志里带 reqId 与 attempt。
 */
let netlogOn = null;
function netlogEnabled() {
  if (netlogOn === null) {
    try { netlogOn = typeof location !== 'undefined' && /[?&]netlog=1/.test(String(location.search || '')); } catch { netlogOn = false; }
    attachRetryStats();
  }
  return netlogOn;
}

let reqSeq = 0;

/** 把统计挂到页面上（验收/排障用）。__WEB__ 可能晚于本模块创建 ⇒ 首次抓取时再挂一次。 */
function attachRetryStats() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.__WEB__ && !globalThis.__WEB__.retryStats) {
      globalThis.__WEB__.retryStats = () => retryStats;
    }
  } catch { /* 忽略 */ }
}
attachRetryStats();

/**
 * 带重试的**原始 fetch**（返回 Response，不解析 body）。
 *
 * 为什么需要它：模型文件（.skel/.atlas/.png）是几十个并发裸 fetch，一旦碰上 HTTP keep-alive race
 *   （客户端复用了服务端已关闭的连接）就直接 Failed to fetch ⇒ Spine 空白。
 *   这类失败**必须重试**，否则一个文件失败整个模型就画不出来。
 *
 * 为什么放在这里而不是各调用点各写一份：重试判定（网络错误/5xx 才重试、4xx 与主动取消不重试）、
 *   退避与抖动必须只有一处实现——两份必然漂移（本项目已吃过"两套实现不一致"的亏）。
 *
 * @param {string} url 同源路径或绝对 URL
 * @param {{method?: string, body?: any, timeoutMs?: number, retries?: number, headers?: object,
 *   signal?: AbortSignal, label?: string, keepalive?: boolean}} [opts]
 * @returns {Promise<Response>} 成功（res.ok）的响应；4xx/重试耗尽会抛错
 */
export async function fetchWithRetry(url, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  // 非幂等方法默认不重试（重发写请求=重复写）；调用方显式给 retries 时以显式为准
  const retries = Number.isInteger(opts.retries)
    ? opts.retries
    : (isIdempotentMethod(opts.method) ? DEFAULT_RETRIES : 0);
  const maxAttempts = Math.max(1, retries + 1);
  const label = opts.label || String(url).split('?')[0].slice(-60);
  let lastErr = null;
  // 统计埋点：验收要看「首次尝试成功率」，不能只看"最终成功"
  const bucket = bucketOf(label);
  retryStats.calls += 1;
  bucket.calls += 1;
  const reqId = (reqSeq += 1);
  const verbose = netlogEnabled();
  attachRetryStats();
  retryStats.inflight += 1;
  if (retryStats.inflight > retryStats.maxInflight) retryStats.maxInflight = retryStats.inflight;
  const startedAt = Date.now();

  for (let i = 0; i < maxAttempts; i += 1) {
    retryStats.attemptsTotal += 1;
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const merged = opts.signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([opts.signal, timeoutSignal])
        : (opts.signal || timeoutSignal);
      const res = await fetch(url, {
        method: opts.method || 'GET',
        headers: opts.headers,
        ...(opts.body !== undefined ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) } : {}),
        ...(opts.keepalive ? { keepalive: true } : {}),
        signal: merged,
      });
      if (res.ok) {
        retryStats.inflight -= 1;
        const okCost = Date.now() - startedAt;
        if (okCost > retryStats.slowestMs) retryStats.slowestMs = okCost;
        if (i === 0) { retryStats.firstTryOk += 1; bucket.firstTryOk += 1; }
        else { retryStats.retried += 1; bucket.retried += 1; }
        if (verbose) note(`net req#${reqId} ${label} attempt=${i + 1}/${maxAttempts} → ${res.status}`);
        return res;
      }
      const err = new Error(`HTTP ${res.status}（${label}）`);
      err.status = res.status;
      throw err;
    } catch (e) {
      lastErr = e;
      const status = e && e.status;
      const worth = status !== undefined ? retryableStatus(status) : retryableNetworkError(e);
      const isLast = i === maxAttempts - 1;
      if (!worth || isLast) break;
      const wait = jitter(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]);
      if (verbose) note(`net req#${reqId} ${label} attempt=${i + 1}/${maxAttempts} 失败：${status ? `HTTP ${status}` : (e && e.name) || '网络错误'}；${wait}ms 后重试`);
      else note(`取文件失败（${label}）第 ${i + 1} 次：${status ? `HTTP ${status}` : (e && e.name) || '网络错误'}；${wait}ms 后重试`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  const status = lastErr && lastErr.status;
  const why = status ? `HTTP ${status}` : ((lastErr && lastErr.message) || '未知错误');
  retryStats.inflight -= 1;
  const costMs = Date.now() - startedAt;
  if (costMs > retryStats.slowestMs) retryStats.slowestMs = costMs;
  if (maxAttempts > 1 && (status === undefined || retryableStatus(status))) { retryStats.exhausted += 1; bucket.exhausted += 1; }
  const err = new Error(`取文件失败（${label}）：${why}${maxAttempts > 1 && (status === undefined || retryableStatus(status)) ? `（重试 ${maxAttempts - 1} 次后仍失败）` : ''}`);
  err.status = status;
  err.cause = lastErr;
  throw err;
}

/**
 * 核心：带重试/退避/超时的 JSON 请求。
 * @param {string} path 同源路径（以 / 开头）
 * @param {{method?: string, body?: any, headers?: object, timeoutMs?: number, retries?: number, signal?: AbortSignal}} opts
 * @returns {Promise<any>}
 */
async function requestJson(path, opts = {}) {
  const method = opts.method || 'GET';
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  // 非幂等方法默认不重试（重发写请求=重复写）；调用方显式给 retries 时以显式为准
  const retries = Number.isInteger(opts.retries)
    ? opts.retries
    : (isIdempotentMethod(method) ? DEFAULT_RETRIES : 0);
  const maxAttempts = Math.max(1, retries + 1);
  let lastErr = null;

  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      return await attemptOnce(path, { method, body: opts.body, headers: opts.headers, timeoutMs, signal: opts.signal, cache: opts.cache });
    } catch (e) {
      lastErr = e;
      const status = e && e.status;
      const worth = status !== undefined ? retryableStatus(status) : retryableNetworkError(e);
      const isLast = i === maxAttempts - 1;
      if (!worth || isLast) break;
      const wait = jitter(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]);
      note(`${method} ${path} 第 ${i + 1} 次失败（${status ? `HTTP ${status}` : (e && e.name) || '网络错误'}），${wait}ms 后重试`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  // 错误信息必须能区分「首次即失败」与「重试耗尽」——否则排障时又得猜
  const status = lastErr && lastErr.status;
  const why = status ? `HTTP ${status}` : ((lastErr && lastErr.message) || '未知错误');
  const exhausted = maxAttempts > 1 && (status === undefined || retryableStatus(status));
  if (exhausted) {
    const err = new Error(`${method} ${path} 失败（重试 ${maxAttempts - 1} 次后仍失败）：${why}`);
    err.status = status;
    err.retries = maxAttempts - 1;
    err.cause = lastErr;
    note(err.message);
    throw err;
  }
  // 首次即失败（4xx / 调用方取消 / 不可重试）：保持原文案口径，上层无需改动
  throw lastErr;
}

/** in-flight 去重表：key = method + path（仅 GET 且调用方未自带 signal 时使用） */
const inflight = new Map();

/**
 * GET JSON。同一 URL 的并发请求会**合并成一个真实请求**（防抖的正解）。
 * @param {string} path
 * @param {{signal?: AbortSignal, timeoutMs?: number, retries?: number, headers?: object}} [options]
 * @returns {Promise<any>}
 */
export function getJson(path, options = {}) {
  const dedupe = !options.signal; // 自带 signal 的调用方各自取消，不参与合并（见文件头"已知边界"）
  const key = `GET ${path}`;
  if (dedupe && inflight.has(key)) return inflight.get(key);
  const p = requestJson(path, { ...options, method: 'GET' }).finally(() => {
    if (dedupe && inflight.get(key) === p) inflight.delete(key);
  });
  if (dedupe) inflight.set(key, p);
  return p;
}

/**
 * POST JSON。**不合并**（有副作用：合并会让"点两次"变成"点一次"）。
 * @param {string} path
 * @param {any} body 会被 JSON.stringify（字符串原样发送）
 * @param {{signal?: AbortSignal, timeoutMs?: number, retries?: number, headers?: object}} [options]
 * @returns {Promise<any>}
 */
export function postJson(path, body, options = {}) {
  return requestJson(path, { ...options, method: 'POST', body });
}

/**
 * 解析一帧 SSE 文本（`event: <name>` + `data: <json>`，帧间以空行分隔）。
 * 只认这两行；其余字段（id:/retry:/注释行）按 SSE 规范忽略。
 * @param {string} frame
 * @returns {{name:string, data:object}|null}
 */
function parseSseFrame(frame) {
  const text = String(frame == null ? '' : frame);
  if (!text.trim()) return null;
  let name = 'message';
  const dataLines = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  let data = {};
  if (dataLines.length) {
    try { data = JSON.parse(dataLines.join('\n')); } catch { data = { raw: dataLines.join('\n') }; }
  }
  return { name, data };
}

/**
 * POST 并按**事件流**增量读取（SSE 风格分帧），供"后台预热 / 等服务端解包"用。
 *
 * 为什么不复用 fetchWithRetry：它按「单次请求 8.5s」判失败并自动重发，而流式响应的正确判据是
 *   **有没有进展**（契约 §四）。重发会把"慢但正常"变成"重复排进串行队列"，总时长上限更是
 *   会把慢机器误判成失败 —— 那正是本设计要消灭的东西。
 *   ⇒ 本函数刻意不设总时长上限，只用「连续无帧」判停摆；命名与文案一律用 stalled/停摆，
 *     绝不出现 timeout/超时（`setTimeout`/`clearTimeout` 是浏览器 API 名，不是文案，无法也不该改）。
 *
 * 兼容（契约 §七 + E10）：服务端不认识 `stream` 时会回一次性 JSON；开流前就失败（400/404）也是 JSON。
 *   两者都靠 **Content-Type** 分辨：不是 text/event-stream ⇒ 整体解析后原样返回，调用方无需分支。
 *
 * @param {string} path
 * @param {any} body
 * @param {{onEvent?:Function, signal?:AbortSignal, idleMs?:number, onStall?:Function, headers?:object}} [opts]
 *   onEvent(name, data) 每帧回调（含 ping）；onStall(info) 停摆时回调一次
 * @returns {Promise<object>} done 的 data（`{ok:true,...}`）/ error 的 `{ok:false,reason,message}` /
 *   停摆的 `{ok:false,reason:'stalled'}` / 一次性 JSON 原样
 */
export async function postStream(path, body, opts = {}) {
  const idleMs = Number(opts.idleMs) > 0 ? Number(opts.idleMs) : 15000;
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const onStall = typeof opts.onStall === 'function' ? opts.onStall : () => {};
  const ctrl = new AbortController();
  const onOuterAbort = () => { try { ctrl.abort(); } catch { /* 已结束 */ } };
  if (opts.signal) {
    if (opts.signal.aborted) onOuterAbort();
    else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  let idleTimer = null;
  let stalled = false;
  const stopIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
  // 每收到任意一帧（含 ping）就重置：ping 每 2s 一条 ⇒ 15s 容忍连丢 7 个心跳，够扛反代抖动
  const bumpIdle = () => {
    stopIdle();
    idleTimer = setTimeout(() => { stalled = true; onOuterAbort(); }, idleMs);
  };
  try {
    bumpIdle();
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': MIME_JSON, ...(opts.headers || {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const ctype = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
    if (!/text\/event-stream/i.test(ctype)) {
      // 老服务端 / 开流前失败：整体解析，形状与服务端 JSON 一致，调用方无需分支
      stopIdle();
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!res.ok) {
        throw new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
      }
      if (data && typeof data === 'object') return { ...data, streamFallback: true };
      throw new Error(`响应既不是事件流也不是 JSON（Content-Type=${ctype || '无'}）`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let last = null;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let cut = buf.indexOf('\n\n');
      while (cut >= 0) {
        const frameText = buf.slice(0, cut);
        buf = buf.slice(cut + 2);          // 不完整帧留在 buffer 等下一块，不丢
        cut = buf.indexOf('\n\n');
        const ev = parseSseFrame(frameText);
        if (!ev) continue;
        bumpIdle();
        if (ev.name === 'done') {
          last = { ok: true, ...(ev.data || {}) };
        } else if (ev.name === 'error') {
          last = {
            ok: false,
            reason: (ev.data && ev.data.reason) || 'unpack-failed',
            message: (ev.data && ev.data.message) || '服务端解包失败',
          };
        }
        onEvent(ev.name, ev.data || {});
      }
    }
    stopIdle();
    if (last) return last;
    return { ok: false, reason: 'stream-ended', message: '事件流已结束但没收到 done/error' };
  } catch (e) {
    stopIdle();
    if (stalled) {
      // 措辞铁律：这里是"停摆"，不是"超时"（见契约 §四）
      const info = { ok: false, reason: 'stalled', message: `服务端停摆（${Math.round(idleMs / 1000)}s 无任何事件），已放弃等待` };
      try { onStall(info); } catch { /* 回调失败不影响结果 */ }
      return info;
    }
    if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')))) {
      return { ok: false, reason: 'aborted', message: '已取消等待' };
    }
    throw e;
  } finally {
    stopIdle();
    if (opts.signal) { try { opts.signal.removeEventListener('abort', onOuterAbort); } catch { /* 忽略 */ } }
  }
}

/**
 * 把错误对象格式化成一行可读文本（界面直接显示，也方便诊断日志落盘）。
 * @param {unknown} err
 * @returns {string}
 */
export function formatError(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 测试用：清空 in-flight 表（生产代码不应调用） */
export function __clearInflightForTest() {
  inflight.clear();
}
