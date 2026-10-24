// routes/backgrounds.mjs —— 自定义背景图 5 个接口（列表 / 上传 / 改名 / 删除 / 取文件）
//
// 为什么单独一组：上传走**原始二进制**（零依赖，不解析 multipart），且边读边计数、
//   超限立刻断开——与其它接口"先收齐再处理"的做法相反，混在总入口里容易被误改成 readBody。
//   文件落在 data/backgrounds/（运行时数据，换机/备份需单独带走）。

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} p
 * @param {object} ctx 需要 backgrounds / sendJson / sendFile / readBody
 * @returns {boolean} 是否已处理
 */
export function handleBackgrounds(req, res, p, ctx) {
  const { backgrounds, sendJson, sendFile, readBody } = ctx;

  if (p === '/api/backgrounds' && req.method === 'GET') {
    sendJson(res, 200, backgrounds.list());
    return true;
  }
  if (p === '/api/backgrounds' && req.method === 'POST') {
    // 注意：这条**不能**用 readBody——它会把整个请求体读进内存；
    //   backgrounds 自己边读边计数，超限立刻断开（小内存机 + 5MB×并发会 OOM）。
    backgrounds.uploadStream(req)
      .then((r) => {
        sendJson(res, r.status, r.body);
        // 超限/中断：响应先落地，再稍微缓一下才断开。
        //   立刻 destroy 会让浏览器 fetch 只看到网络错误（拿不到 413 与 reason，
        //   用户就只能看到笼统的"上传失败"）；缓 800ms 足够响应刷出去，
        //   同时不让一个超大上传一直占着连接。
        if (r.destroy) setTimeout(() => { try { req.destroy(); } catch { /* 已断开 */ } }, 800);
      })
      .catch((e) => sendJson(res, 500, { ok: false, reason: 'server-error', error: String((e && e.message) || e) }));
    return true;
  }
  if (p === '/api/backgrounds/rename' && req.method === 'POST') {
    readBody(req, res, (raw) => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch {
        return sendJson(res, 400, { ok: false, reason: 'bad-json', error: '请求体不是合法 JSON' });
      }
      backgrounds.rename(body.id, body.name)
        .then((r) => sendJson(res, r.status, r.body))
        .catch((e) => sendJson(res, 500, { ok: false, reason: 'server-error', error: String((e && e.message) || e) }));
    });
    return true;
  }
  if (p === '/api/backgrounds/delete' && req.method === 'POST') {
    readBody(req, res, (raw) => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch {
        return sendJson(res, 400, { ok: false, reason: 'bad-json', error: '请求体不是合法 JSON' });
      }
      backgrounds.remove(body.id)
        .then((r) => sendJson(res, r.status, r.body))
        .catch((e) => sendJson(res, 500, { ok: false, reason: 'server-error', error: String((e && e.message) || e) }));
    });
    return true;
  }
  // GET 与 HEAD 都要接：代理/预取会先发 HEAD 探测，只认 GET 会让它拿到 404 的 JSON 头
  if (p.startsWith('/api/backgrounds/file/') && (req.method === 'GET' || req.method === 'HEAD')) {
    // id 只用于查索引，绝不拼进路径（用户可控输入）
    const id = decodeURIComponent(p.slice('/api/backgrounds/file/'.length));
    const hit = backgrounds.fileOf(id);
    if (!hit) {
      sendJson(res, 404, { ok: false, reason: 'not-found', error: `没有这张背景图：${id}` });
      return true;
    }
    sendFile(req, res, hit.abs, {
      'Content-Type': hit.mime,
      // 同一个 id 的文件内容不会变（重命名只改显示名），可以长缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    return true;
  }
  return false;
}
