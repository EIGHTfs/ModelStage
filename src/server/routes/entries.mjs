// routes/entries.mjs —— 条目状态的两条接口（契约《条目状态与展示归属》§三）
//
//   POST /api/entries/result        写读一体：上报"最近一次装载尝试"，响应直接带回重算后的三字段
//   GET  /api/entries/result?key=…  单条查询（零扫描、零重建）
//   GET  /api/entries/probe         后台探测的计数与队列深度（S10 的佐证口）
//   POST /api/entries/probe?root=…  手动重探一轮（§八 触发判据 c）
//
// 为什么把"写"和"读"做成同一次响应（这是契约 S1/S2 的根治点）：
//   前端装载完成那一刻既要"记下结果"，又要"立刻把这一行画对"。
//   若拆成两次请求，中间必然存在"前端已改行、服务端还没存"的窗口，
//   表现为"当场变了色、刷新又变回去"（或反过来）——两张皮就是这么来的。
//   这里写入与读取用的是**同一个 recompute()**，响应就是存储层算出来的那份数据。
//
// 旁路原则（INV-D3）：本接口出任何错都不得影响装载。前端调用处必须吞掉失败只记日志。

// 指纹判据只有一份实现（INV-D6）：上报路径漏传 providerFingerprint 时，
//   recompute 里规则①会因"没有当前指纹"整段跳过 —— 插件升级后旧结论永远挂着。
import { providerFingerprintOf, assetFingerprintOf } from '../data/entry-states.mjs';

/** 从请求体里挑出 put() 需要的字段（其余一律忽略，不把未知字段写进存储） */
function pickIncoming(body) {
  const src = body && typeof body === 'object' ? body : {};
  const result = src.result === 'ok' ? 'ok' : (src.result === 'failed' ? 'failed' : null);
  if (!result) return null;
  const out = { result };
  if (typeof src.reason === 'string' && src.reason) out.reason = src.reason;
  if (typeof src.message === 'string' && src.message) out.message = src.message;
  if (typeof src.provider === 'string' && src.provider) out.provider = src.provider;
  if (Number.isFinite(src.at)) out.at = Number(src.at);
  if (src.source === 'server' || src.source === 'client') out.source = src.source;
  return out;
}

/**
 * 条目状态这一族的入口：按路径分给两个处理函数（各自再管自己的方法）。
 * @param {object} ctx serve.mjs 注入：{ entryStates, shapeProbe, catalog, contextFor, sendJson, readBody, log }
 */
export function handleEntries(req, res, p, url, ctx) {
  // 解构放函数最前面：两条分支都要用（放在中间会踩 TDZ，实测报
  //   "Cannot access 'sendJson' before initialization"）
  const { sendJson } = ctx;
  if (p === '/api/entries/probe') return handleProbeRoute(req, res, url, ctx);
  if (p !== '/api/entries/result') return false;
  if (!ctx.entryStates) {
    // 存储没装配（理论上不会）：如实 500，不假装成功——前端会按"上报失败只记日志"处理
    sendJson(res, 500, { ok: false, error: '条目状态存储未就绪' });
    return true;
  }
  if (req.method === 'GET') return handleResultGet(req, res, url, ctx);
  if (req.method === 'POST') return handleResultPost(req, res, ctx);
  sendJson(res, 405, { ok: false, error: `不支持的方法：${req.method}` });
  return true;
}

/**
 * GET /api/entries/result?key=…
 *
 * 查询也走 recompute：否则"存储里有、算出来没有"的字段会让诊断和列表对不上。
 * @returns {true} 已处理
 */
function handleResultGet(req, res, url, ctx) {
  const key = (url.searchParams.get('key') || '').trim();
  if (!key) {
    ctx.sendJson(res, 400, { ok: false, error: '缺少 key 参数（?key=<rootId>/<rel> 或条目 id）' });
    return true;
  }
  const computed = ctx.entryStates.recompute(ctx.entryStates.get(key), ctx.contextFor(key));
  ctx.sendJson(res, 200, { ok: true, key, entry: computed });
  return true;
}

/**
 * POST /api/entries/result：写入一次装载结果，响应带回重算后的三字段（写读一体）。
 *
 * readBody 回调给的是**原始字符串**（各路由自己 parse，与 backgrounds/ready 同口径）。
 * @returns {true} 已处理（响应在回调里发出）
 */
function handleResultPost(req, res, ctx) {
  const { sendJson, readBody } = ctx;
  readBody(req, res, (raw) => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      return;
    }
    const key = String((body && body.key) || '').trim();
    if (!key) {
      sendJson(res, 400, { ok: false, error: '缺少 key（形如 <rootId>/<rel>）' });
      return;
    }
    writeResult(key, body, res, ctx);
  });
  return true;
}

/**
 * 真正的写入动作（从 POST 回调里拆出来，单独可读）。
 * 旁路原则：存储写失败只记日志 + 如实 500，绝不升级成"装载失败"。
 */
function writeResult(key, body, res, ctx) {
  const { sendJson, entryStates } = ctx;
  const incoming = pickIncoming(body);
  if (!incoming) {
    sendJson(res, 400, { ok: false, error: 'result 必须是 ok 或 failed' });
    return;
  }
  try {
    // put() 内部先落内存表再 recompute：返回的就是"现在存储的真相"
    const r = entryStates.put(key, incoming, ctx.contextFor(key, body));
    sendJson(res, 200, { ok: true, key, applied: r.applied === true, entry: r.computed });
  } catch (e) {
    try {
      if (ctx.log && ctx.log.warn) ctx.log.warn('条目状态写入失败', { err: (e && e.message) || String(e) });
    } catch { /* 日志本身失败也不能影响响应 */ }
    sendJson(res, 500, { ok: false, error: `条目状态写入失败：${(e && e.message) || e}` });
  }
}

/**
 * /api/entries/probe：后台形态探测的状态（GET）与手动重探（POST）。
 * 与 /result 同属"条目状态"这一族，共用同一份存储，所以放在同一模块。
 */
function handleProbeRoute(req, res, url, ctx) {
  const { sendJson, shapeProbe } = ctx;
  const stats = shapeProbe ? shapeProbe.stats() : null;
  if (req.method === 'GET') {
    const queue = ctx.catalog && typeof ctx.catalog.probeQueueSize === 'function'
      ? ctx.catalog.probeQueueSize() : null;
    sendJson(res, 200, { ok: true, stats, queue, running: shapeProbe ? shapeProbe.isRunning() : false });
    return true;
  }
  if (req.method === 'POST') {
    // 手动重探（调试入口）：不 await —— 探测按根串行、跑完即停，调用方拿到受理回执即可
    const rootId = (url.searchParams.get('root') || '').trim() || undefined;
    const running = shapeProbe ? shapeProbe.kick(rootId) : null;
    sendJson(res, 200, { ok: true, accepted: !!running, stats });
    return true;
  }
  sendJson(res, 405, { ok: false, error: `不支持的方法：${req.method}` });
  return true;
}

/**
 * 造 contextFor：把"这条目的静态事实"（候选提供者、缺贴图、尺寸）从 catalog 侧喂给 recompute。
 *
 * 为什么放在路由层而不是 entry-states 里：存储层不该知道 catalog 的形状（谁认领这个条目、
 *   目录型缺哪些贴图，都是扫描阶段的事）；它只负责"把状态和上下文合成三字段"。
 * @param {{providers: Function, describe: Function}} deps
 */
export function createContextFor(deps) {
  return function contextFor(key, body) {
    const providers = (deps.providers && deps.providers()) || [];
    const desc = (deps.describe && deps.describe(key)) || {};
    // size 优先取请求体（前端最清楚自己装的是哪个文件），其次取扫描结果
    const size = Number.isFinite(body && body.size) ? Number(body.size) : (Number.isFinite(desc.size) ? desc.size : undefined);
    return {
      providers,
      candidates: Array.isArray(desc.candidates) ? desc.candidates : [],
      missingTextures: Array.isArray(desc.missingTextures) ? desc.missingTextures : undefined,
      assetDependency: desc.assetDependency || null,
      size,
      // 三处写入方必须传同源指纹（INV-D6）：
      //   providerFingerprint = 当前注册表指纹（规则①判据），
      //   assetFingerprint    = 同一份 size 派生的字符串（规则②判据，三处同格式）
      providerFingerprint: providerFingerprintOf(providers),
      assetFingerprint: assetFingerprintOf(size),
    };
  };
}
