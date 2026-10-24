// api.js —— 同源 HTTP 封装（唯一一层：重试 / 退避+抖动 / 超时 / in-flight 去重）
//
// 做什么：给上层提供 getJson() / postJson()，把「网络失败、超时、非 2xx、非 JSON」四类问题
//   在这一层统一处理，上层调用点的语义保持不变（仍旧是"成功拿数据、失败抛 Error(message)"）��
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
async function attemptOnce(path, { method, body, headers, timeoutMs, signal }) {
  // 每次尝试都有独立超时（AbortSignal.timeout）：卡死的请求不会无限挂住页面
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const merged = signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeoutSignal])
    : (signal || timeoutSignal);
  const res = await fetch(path, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(headers || {}),
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
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
  const retries = Number.isInteger(opts.retries) ? opts.retries : DEFAULT_RETRIES;
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
  const retries = Number.isInteger(opts.retries) ? opts.retries : DEFAULT_RETRIES;
  const maxAttempts = Math.max(1, retries + 1);
  let lastErr = null;

  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      return await attemptOnce(path, { method, body: opts.body, headers: opts.headers, timeoutMs, signal: opts.signal });
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
