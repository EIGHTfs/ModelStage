// routes/diag.mjs —— 诊断相关三条：/api/diag（GET 读最近条目 / POST 上报）、/api/diag/upload(s)（落盘与查询）
//
// 为什么单独一组：诊断是"只写 data/ 的旁路"——它不参与资源根/模型读取，
//   出问题时即使模型链路坏了，这条通道也应该还能用（便于事后读现场）。
//
// 约定：handler 返回 true 表示"这个请求我处理了（可能已写响应）"，返回 false 表示没我的事。

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} p 已解析的 pathname
 * @param {URL} url
 * @param {object} ctx 由 serve.mjs 组装的依赖（sendJson / readBody / diag / diagUpload）
 * @returns {boolean} 是否已处理
 */
export function handleDiag(req, res, p, url, ctx) {
  const { diag, diagUpload, sendJson, readBody } = ctx;

  // 只读：取最近的诊断条目（页面自己记录的那份，供外部/AI 直接读现场）
  if (p === '/api/diag' && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit')) || undefined;
    const sid = url.searchParams.get('sid') || undefined;
    sendJson(res, 200, diag.readDiag({ limit, sid }));
    return true;
  }
  if (p === '/api/diag' && req.method === 'POST') {
    readBody(req, res, (body) => sendJson(res, 200, diag.appendDiag(body)));
    return true;
  }
  // 调试日志上传（data/logs/）：先**同步**判命中，再异步处理
  //   （handle 是 async，直接判返回值会恒真、把后续路由整条截断——踩过）。
  if (diagUpload.matches(req.method, p)) {
    diagUpload.handle(req, res, p);
    return true;
  }
  return false;
}
