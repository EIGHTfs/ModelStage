// routes/data.mjs —— 只读数据 API 与资源文件路由
//
// 覆盖：
//   /api/roots /api/plugins /api/brand /api/web-config   资源根/插件/品牌/前端配置
//   /api/tree /api/models /api/live2d/models /api/names  目录/模型清单/名表
//   /api/browse                                          服务端目录浏览（登记资源根用）
//   /api/catalog /api/bundle/probe /api/model-meta       按需 import 的三条
//   /api/file /files/<rootId>/<rel> /icons/... /live2d-lib/...  二进制资源（含越界防护）
//   POST /api/roots                                      资源根增删改名启停（写路径）
//
// 为什么归一组：它们共享同一份 data.*（config/models/names/live2d/catalog…）实例，
//   读写口径必须一致——资源根视图走 http/write.mjs 的 toRootView，避免读写两处漂移。

/** 资源根 / 插件 / 品牌 / 前端配置 */
function apiBasics(ctx, res, p) {
  const { data, sendJson, toRootView } = ctx;
  if (p === '/api/roots') {
    // 视图映射与写接口共用同一份（http/write.mjs 的 toRootView），避免读写两处口径漂移
    const list = toRootView(data.config.readConfig());
    return sendJson(res, 200, { roots: list, groups: data.config.buildGroups(list) });
  }
  if (p === '/api/plugins') {
    return sendJson(res, 200, {
      ok: true,
      dir: 'plugins',
      plugins: data.plugins.readPlugins(),
      // 角色注册表（角色 → 插件 id）：前端按 provides 决定把插件挂到哪个注册表；
      //   排障时也能一眼看出"某角色有没有插件认领"
      roles: data.plugins.roleIndex(),
    });
  }
  if (p === '/api/brand') {
    const env = data.env.readDotEnv();
    const title = (env.APP_TITLE || '').trim();
    const icon = (env.APP_ICON || '').trim();
    const looksLikeImage = /^(https?:|data:|\/)/i.test(icon) || /\.(png|jpe?g|svg|webp|gif|ico)$/i.test(icon);
    return sendJson(res, 200, { ok: true, title: title || null, icon: icon || null, iconKind: !icon ? null : (looksLikeImage ? 'image' : 'text') });
  }
  if (p === '/api/web-config') {
    const env = data.env.readDotEnv();
    return sendJson(res, 200, {
      ok: true,
      autoRestoreLast: data.env.parseEnvFlag(env.AUTO_RESTORE_LAST),
      debugLog: data.env.parseEnvFlag(env.DEBUG_LOG),
    });
  }
  return false;
}

/** 目录 / 模型清单 / 名表 / 配置导出 / 目录浏览 */
function apiData(ctx, res, p, url) {
  const { data, sendJson, browseDir } = ctx;
  if (p === '/api/tree') {
    const r = data.tree.listTree(url.searchParams.get('root') || '', url.searchParams.get('path') || '');
    return sendJson(res, r.status, r.body);
  }
  if (p === '/api/models' || p === '/api/live2d/models') {
    const rootId = url.searchParams.get('root') || '';
    const force = url.searchParams.get('refresh') === '1';
    const cfg = data.config.readConfig().find((r) => r.id === rootId);
    if (!cfg) return sendJson(res, 400, { error: `未找到资源根: ${rootId}` });
    try {
      const isSpine = p === '/api/models';
      const r = isSpine ? data.models.getModels(cfg, force) : data.live2d.getLive2DModels(cfg, force);
      return sendJson(res, 200, {
        root: { id: cfg.id, name: cfg.name },
        count: r.models.length,
        cached: r.cached,
        scannedAt: new Date(r.ts).toISOString(),
        models: r.models,
      });
    } catch (e) {
      return sendJson(res, 500, { error: `${p === '/api/models' ? '扫描失败' : 'Live2D 扫描失败'}: ${e.message}` });
    }
  }
  if (p === '/api/names') return apiNames(ctx, res, url);
  // /api/config/export 与 /api/config/import 同属配置组，见 routes/config.mjs（此处不重复实现）
  if (p === '/api/browse') {
    const r = browseDir(url.searchParams.get('path') || '/');
    return sendJson(res, r.status, r.body);
  }
  return false;
}

/**
 * 名表：与旧实现完全一致（每次现读、缺文件 404、解析失败 500）。
 * 为什么不复用 getNameTable：那个带进程内缓存且只有两态，会改变对外可观测行为。
 */
function apiNames(ctx, res, url) {
  const { data, fs, path, sendJson } = ctx;
  const rootId = url.searchParams.get('root') || '';
  const cfg = data.config.readConfig().find((r) => r.id === rootId);
  if (!cfg) return sendJson(res, 400, { error: `未找到资源根: ${rootId}` });
  if (!cfg.names) return sendJson(res, 200, { root: rootId, names: null, reason: '该资源根未配置 names 名表' });
  const file = path.join(data.paths.namesDir, `${cfg.names}.json`);
  if (!fs.existsSync(file)) return sendJson(res, 404, { error: `名表文件不存在: config/names/${cfg.names}.json` });
  try {
    const table = JSON.parse(fs.readFileSync(file, 'utf8'));
    return sendJson(res, 200, { root: rootId, tableId: cfg.names, ...table });
  } catch (e) {
    return sendJson(res, 500, { error: `名表解析失败: ${e.message}` });
  }
}

/** 需要按需 import 的三条（catalog / bundle probe / model meta） */
function apiAsync(ctx, req, res, p, url) {
  const { data, sendJson } = ctx;
  const done = (r) => sendJson(res, r.status, r.body);
  const fail = (label) => (e) => sendJson(res, 500, { ok: false, error: `${label}: ${e.message}` });
  if (p === '/api/catalog') return done(data.catalog.listCatalog(url.searchParams.get('root') || ''));
  if (p === '/api/bundle/probe') {
    data.bundleProbe.probeBundle(url.searchParams.get('root') || '', url.searchParams.get('path') || '')
      .then(done).catch(fail('预检失败'));
    return true;
  }
  if (p === '/api/model-meta') {
    data.modelMeta.readModelMeta(url.searchParams.get('root') || '', url.searchParams.get('path') || '')
      .then(done).catch(fail('读取元数据失败'));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- 二进制路由

/** /api/file?root=&path= 与 /files/<rootId>/<rel>：模型资源流（带 CORS，供纹理跨源） */
function serveModelFile(ctx, req, res, p, url) {
  const { data, fs, resolveSafe, sendJson, sendFile } = ctx;
  let rootId;
  let rel;
  let cors = { 'Access-Control-Allow-Origin': '*' };
  if (p === '/api/file') {
    rootId = url.searchParams.get('root') || '';
    rel = url.searchParams.get('path') || '';
  } else if (p.startsWith('/files/')) {
    const rest = decodeURIComponent(p.slice('/files/'.length));
    const slash = rest.indexOf('/');
    rootId = slash < 0 ? rest : rest.slice(0, slash);
    rel = slash < 0 ? '' : rest.slice(slash + 1);
  } else {
    return false;
  }
  const cfg = data.config.readConfig().find((r) => r.id === rootId);
  if (!cfg) {
    if (p === '/api/file') { sendJson(res, 400, { error: `未找到资源根: ${rootId}` }); return true; }
    res.writeHead(404); res.end('root not found');
    return true;
  }
  const abs = resolveSafe(cfg.path, rel);
  if (!abs) {
    if (p === '/api/file') { sendJson(res, 403, { error: '路径越界' }); return true; }
    res.writeHead(403); res.end('forbidden');
    return true;
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    if (p === '/api/file') { sendJson(res, 404, { error: '文件不存在', path: rel }); return true; }
    res.writeHead(404); res.end('file not found');
    return true;
  }
  sendFile(req, res, abs, cors);
  return true;
}

/** /icons/<rootId>/<文件名>：头像目录在资源根之外，单独一条（含越界防护） */
function serveIcon(ctx, req, res, p) {
  const { data, fs, path, sendFile } = ctx;
  if (!p.startsWith('/icons/')) return false;
  const rest = decodeURIComponent(p.slice('/icons/'.length));
  const slash = rest.indexOf('/');
  const rootId = slash < 0 ? rest : rest.slice(0, slash);
  const name = path.basename(slash < 0 ? '' : rest.slice(slash + 1));
  const cfg = data.config.readConfig().find((r) => r.id === rootId);
  if (!cfg || !cfg.icons || !cfg.icons.dir) { res.writeHead(404); res.end('no icons dir'); return true; }
  const base = path.resolve(cfg.icons.dir);
  const abs = path.resolve(base, name);
  if (abs !== base && !abs.startsWith(base + path.sep)) { res.writeHead(403); res.end('forbidden'); return true; }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { res.writeHead(404); res.end('not found'); return true; }
  sendFile(req, res, abs);
  return true;
}

/** /live2d-lib/<文件>：Cubism Core 等运行时库（由 resolver 探测出的映射表） */
function serveLive2DLib(ctx, req, res, p) {
  const { data, path, sendJson, sendFile } = ctx;
  if (!p.startsWith('/live2d-lib/')) return false;
  const name = path.basename(decodeURIComponent(p.slice('/live2d-lib/'.length)));
  let files;
  try {
    files = data.live2d.getLive2DRuntimeFiles();
  } catch (e) {
    sendJson(res, 503, { error: `Live2D 运行时不可用: ${e.message}` });
    return true;
  }
  const abs = files[name];
  if (!abs) {
    sendJson(res, 404, { error: `未找到运行时文件: ${name}` });
    return true;
  }
  sendFile(req, res, abs);
  return true;
}

/**
 * 入口：按顺序尝试本组路由。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} p
 * @param {URL} url
 * @param {object} ctx 需要 data/fs/path/sendJson/sendFile/resolveSafe/browseDir/toRootView/writeApi/readBody
 * @returns {boolean} 是否已处理
 */
export function handleData(req, res, p, url, ctx) {
  const { sendJson, readBody, writeApi } = ctx;

  // 资源根写操作（增 / 删 / 改名 / 启停）：校验 → 备份 → 写 → 失效缓存
  // 具体管道在 http/write.mjs；这里只负责读请求体与发响应。
  if (p === '/api/roots' && req.method === 'POST') {
    readBody(req, res, (body) => {
      writeApi.writeRoots(body)
        .then((r) => sendJson(res, r.status, r.body))
        .catch((e) => sendJson(res, 500, { ok: false, error: `写资源根异常: ${(e && e.message) || e}` }));
    });
    return true;
  }
  if (apiBasics(ctx, res, p)) return true;
  if (apiData(ctx, res, p, url)) return true;
  if (apiAsync(ctx, req, res, p, url)) return true;
  if (serveModelFile(ctx, req, res, p, url)) return true;
  if (serveIcon(ctx, req, res, p)) return true;
  if (serveLive2DLib(ctx, req, res, p)) return true;
  return false;
}
