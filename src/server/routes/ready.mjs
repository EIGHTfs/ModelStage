// routes/ready.mjs —— 就绪信号通道（契约 docs/契约/交互与实现约束.md）
//
// 三条同路径不同方法：
//   GET  /api/ready         快照（幂等；未登记阶段名 ⇒ 400，已登记未上报 ⇒ 200 pending）
//   GET  /api/ready/stream  长连接（先推 snapshot，再推 update）
//   POST /api/ready         页面侧上报入口
//
// 为什么与 diag 分开：就绪信号描述"能不能开始渲染"，是状态机；调试日志描述"发生了什么"，是流水。
//   两者混在一起会让"未就绪"被淹没在日志噪音里（契约里明确要求分离，不进调试面板）。

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} p
 * @param {URL} url
 * @param {object} ctx 需要 ready / diag / sendJson / readBody
 * @returns {boolean} 是否已处理
 */
export function handleReady(req, res, p, url, ctx) {
  const { ready, diag, sendJson, readBody } = ctx;

  if (p === '/api/ready' && req.method === 'GET') {
    const stage = url.searchParams.get('stage') || '';
    const snap = ready.snapshot(stage || undefined);
    // 未登记的阶段名 = 调用方写错（契约 §三：阶段必须先登记）⇒ 400 并回可用清单；
    //   已登记但尚未上报的返回 state:'pending'（200），两者语义不同，别混。
    sendJson(res, snap && snap.ok === false ? 400 : 200, snap);
    return true;
  }
  if (p === '/api/ready/stream' && req.method === 'GET') {
    ready.subscribe(req, res);   // 长连接：先 snapshot 事件，后 update 事件
    return true;
  }
  if (p === '/api/ready' && req.method === 'POST') {
    // 注意：readBody 给的是**原始字符串**（diag 自己在内部 parse），这里必须自行解析
    const arrivedAt = Date.now();
    readBody(req, res, (raw) => {
      // **到达日志**：这条通道以前完全不记录 ⇒ 出现 "Failed to fetch" 时无法区分
      //   "请求没到达" / "到达后出错" / "返回了但回不到浏览器"。第一步必须能看见。
      //   只记到达 + 字节数 + 耗时，不记 body 内容（会很吵）。
      const logReady = (ok, extra) => {
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
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch (e) {
        logReady(false, { reason: 'bad-json', msg: String((e && e.message) || e).slice(0, 100) });
        return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      try {
        const out = ready.apply(body);
        logReady(true, { updates: (body && body.updates && body.updates.length) || 0, clear: body && body.clear === true });
        return sendJson(res, 200, out);
      } catch (e) {
        logReady(false, { reason: 'apply-threw', msg: String((e && e.message) || e).slice(0, 120) });
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    });
    return true;
  }
  return false;
}
