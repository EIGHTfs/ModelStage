// routes/config.mjs —— 配置导出 / 导入
//
// 导出是只读（把 config/resources.json 与 names/*.json 打包成 {files,count}）；
// 导入是写路径，与 /api/roots 共用 http/write.mjs 的"校验 → 备份 → 写 → 回读自检"管道。
//
// 为什么请求体上限单独放宽到 5MB：名表 JSON 可能较大，
//   默认 2MB 会让大名表在中途被断开，用户只看到笼统的失败。

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} p
 * @param {object} ctx 需要 data / writeApi / sendJson / readBody
 * @returns {boolean} 是否已处理
 */
export function handleConfig(req, res, p, ctx) {
  const { data, writeApi, sendJson, readBody } = ctx;

  if (p === '/api/config/export' && req.method === 'GET') {
    try {
      const files = data.config.exportConfigFiles();
      sendJson(res, 200, { files, count: Object.keys(files).length });
    } catch (e) {
      sendJson(res, 500, { error: `导出配置失败: ${e.message}` });
    }
    return true;
  }
  if (p === '/api/config/import' && req.method === 'POST') {
    // 导入配置（覆盖 resources.json / names/*.json）：同一套校验 → 备份 → 写 → 回读自检。
    readBody(req, res, (body) => {
      writeApi.writeConfigImport(body)
        .then((r) => sendJson(res, r.status, r.body))
        .catch((e) => sendJson(res, 500, { ok: false, error: `导入配置异常: ${(e && e.message) || e}` }));
    }, 5e6);
    return true;
  }
  return false;
}
