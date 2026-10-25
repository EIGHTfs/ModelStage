// routes/background-solids.mjs —— 纯色背景预设 5 个接口
//
// 为什么单独一个路由文件而不并进 backgrounds.mjs：
//   backgrounds.mjs 那条链路是**二进制上传**（边读边计数、超限立即断开，文件头已写明
//   "混在总入口里容易被误改成 readBody"）。纯色预设全是小 JSON，用普通 readBody 即可，
//   两者放在一起会让"哪条能 readBody"变成需要读完整文件的判断题。
//
// 这一层只做三件事：认路径 + 读 body + 转发给数据层（校验/落盘/自愈全在
//   http/background-solids.mjs），所以 11 条测试直接打数据层，不必起 HTTP。
//
// 并发约定见 doc/契约/纯色预设API.md §四（单实例串行一致；多实例不保证）。

/** 路由前缀（这组接口的统一前缀，便于一眼看出归属） */
const BASE = '/api/backgrounds/solids';

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} p 路径（不含查询串）
 * @param {object} ctx 需要 solids / sendJson / readBody
 * @returns {boolean} 是否已处理
 */
export function handleBackgroundSolids(req, res, p, ctx) {
  const { solids, sendJson, readBody } = ctx;
  if (!p.startsWith(BASE)) return false;

  // GET：列表
  if (p === BASE && req.method === 'GET') {
    const r = solids.list();
    sendJson(res, r.status || 200, r.body);
    return true;
  }

  if (req.method !== 'POST') return false;

  /** 读 JSON body 后执行一个动作（错误文案原样回给前端显示） */
  const runWithBody = (fn) => {
    readBody(req, res, (raw) => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch {
        return sendJson(res, 400, { error: '请求体不是合法 JSON' });
      }
      fn(body)
        .then((r) => sendJson(res, r.status, r.body))
        .catch((e) => sendJson(res, 500, { error: String((e && e.message) || e) }));
    });
    return true;
  };

  if (p === BASE) return runWithBody((body) => solids.add(body));
  if (p === `${BASE}/rename`) return runWithBody((body) => solids.rename(body));
  if (p === `${BASE}/remove`) return runWithBody((body) => solids.remove(body));
  if (p === `${BASE}/reset`) return runWithBody(() => solids.reset());

  return false;
}
