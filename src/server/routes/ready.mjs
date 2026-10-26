// routes/ready.mjs —— 就绪信号通道（契约 docs/契约/交互与实现约束.md）
//
// 三条同路径不同方法：
//   GET  /api/ready         快照（幂等；未登记阶段名 ⇒ 400，已登记未上报 ⇒ 200 pending）
//   GET  /api/ready/stream  长连接（先推 snapshot，再推 update）
//   POST /api/ready         页面侧上报入口
//
// 为什么与 diag 分开：就绪信号描述"能不能开始渲染"，是状态机；调试日志描述"发生了什么"，是流水。
//   两者混在一起会让"未就绪"被淹没在日志噪音里（契约里明确要求分离，不进调试面板）。
//
// 拆分口径（原单函数圈复杂度 28）：这个函数不是"采集 + 判定"那种形态，而是**三个独立路由分支**
//   各自带自己的错误处理。所以按「一条路由一个函数」拆，另把"上报体处理"与"到达日志"再各提一层 ——
//   边界按"一条路由的完整处理"划，而不是硬套采集/判定。响应结构、状态码、字段名一字未改。

/**
 * 就绪通道入口：只做**方法 + 路径分发**，具体处理交给下面几个函数。
 */

// 错误消息写进日志前截断的字符上限：避免一条超长异常把日志撑爆。
//   两个值不同（100 / 120）是原样保留的历史取值，不要合并成一个。
const ERR_MSG_MAX_BAD_JSON = 100;
const ERR_MSG_MAX_APPLY = 120;

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} reqPath 请求路径（如 /api/ready）
 * @param {URL} url
 * @param {object} ctx 需要 ready / diag / sendJson / readBody
 * @returns {boolean} 是否已处理
 */
export function handleReady(req, res, reqPath, url, ctx) {
  const { ready, diag, sendJson, readBody } = ctx;

  if (reqPath === '/api/ready' && req.method === 'GET') return sendReadySnapshot(url, res, ready, sendJson);
  if (reqPath === '/api/ready/stream' && req.method === 'GET') {
    ready.subscribe(req, res);   // 长连接：先 snapshot 事件，后 update 事件
    return true;
  }
  if (reqPath === '/api/ready' && req.method === 'POST') return sendReadyPost(req, res, ready, diag, sendJson, readBody);
  return false;
}

/**
 * GET /api/ready —— 返回快照。
 * 未登记的阶段名 = 调用方写错（契约 §三：阶段必须先登记）⇒ 400 并回可用清单；
 *   已登记但尚未上报的返回 state:'pending'（200），两者语义不同，别混。
 */
function sendReadySnapshot(url, res, ready, sendJson) {
  const stage = url.searchParams.get('stage') || '';
  const snap = ready.snapshot(stage || undefined);
  sendJson(res, snap && snap.ok === false ? 400 : 200, snap);
  return true;
}

/** POST /api/ready —— 读请求体后交给 handleReadyBody 处理 */
function sendReadyPost(req, res, ready, diag, sendJson, readBody) {
  const arrivedAt = Date.now();
  readBody(req, res, (raw) => handleReadyBody(raw, res, ready, diag, sendJson, arrivedAt));
  return true;
}

/**
 * 处理上报体（原 readBody 回调体）。
 * 注意：readBody 给的是**原始字符串**（diag 自己在内部 parse），这里必须自行解析。
 */
function handleReadyBody(raw, res, ready, diag, sendJson, arrivedAt) {
  const logReady = makeReadyLog(diag, arrivedAt, raw);
  const parsed = parseReadyBody(raw, logReady);
  if (!parsed.ok) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
  return applyReadyBody(parsed.body, res, ready, logReady, sendJson);
}

/** 解析上报体。失败时写一条到达日志并返回 {ok:false}（状态码由调用方给） */
function parseReadyBody(raw, logReady) {
  try {
    return { ok: true, body: raw ? JSON.parse(raw) : {} };
  } catch (e) {
    logReady(false, { reason: 'bad-json', msg: String((e && e.message) || e).slice(0, ERR_MSG_MAX_BAD_JSON) });
    return { ok: false };
  }
}

/** 成功上报时写进日志的附加字段（updates 条数 / 是否清空） */
function readyLogExtra(body) {
  return { updates: (body && body.updates && body.updates.length) || 0, clear: body && body.clear === true };
}

/** 应用上报体并输出。apply 抛错时写日志并回 500（错误文本原样回给调用方） */
function applyReadyBody(body, res, ready, logReady, sendJson) {
  try {
    const out = ready.apply(body);
    logReady(true, readyLogExtra(body));
    return sendJson(res, 200, out);
  } catch (e) {
    logReady(false, { reason: 'apply-threw', msg: String((e && e.message) || e).slice(0, ERR_MSG_MAX_APPLY) });
    return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

/**
 * 构造「到达日志」写入器。
 *
 * **到达日志**：这条通道以前完全不记录 ⇒ 出现 "Failed to fetch" 时无法区分
 *   "请求没到达" / "到达后出错" / "返回了但回不到浏览器"。第一步必须能看见。
 *   只记到达 + 字节数 + 耗时，不记 body 内容（会很吵）。
 */
function makeReadyLog(diag, arrivedAt, raw) {
  return (ok, extra) => {
    try {
      diag.appendDiag(JSON.stringify({
        sid: 'server',
        entries: [{
          level: ok ? 'info' : 'warn',
          at: arrivedAt,
          event: ok ? 'ready.post' : 'ready.post.error',
          data: { bytes: raw ? raw.length : 0, ms: Date.now() - arrivedAt, ...extra },
        }],
      }));
    } catch { /* 日志失败不影响就绪通道 */ }
  };
}
