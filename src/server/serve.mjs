#!/usr/bin/env node
// serve.mjs —— 新前端自带的完整服务入口（不依赖旧服务）
//
// 与 src/web/dev-server.mjs 的区别：**不再反代上游**。所有请求都由这里处理：
//   · /api/*            数据层：调 src/server/** 的现有函数（与 server.mjs 同一份实现）
//   · /api/file /files  模型资源流式返回（安全路径解析 + MIME 复用 probe.mjs）
//   · /icons/*          头像（资源根配置里的 icons 目录）
//   · /live2d-lib/*     Live2D 运行时库（tool/resolve-live2d-runtimes.mjs 探测结果）
//   · /plugins/*        展示类型插件 js
//   · /spine-runtimes/* Spine 运行时（含 index.json 版本清单）
//   · 引擎模块          src/web/engine/**（ESM，随下面的 src/web 静态托管一起发出；无单独的引擎打包产物）
//   · 其余              静态托管 src/web
//
// 写接口：`POST /api/roots`（资源根增删改名启停）与 `POST /api/config/import`（导入配置）
//   均已开放，共用 http/write.mjs 的管道：校验 → 备份 → 写 → 失效缓存 → 回读自检。
//
// 用法：PORT=8804 node src/server/serve.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerData } from './index.mjs';
import { resolveSafe } from './assets/probe.mjs';
import { browseDir } from './assets/browse.mjs';
import { createStaticRoutes, sendFile } from './http/static.mjs';
import { createDiag } from './http/diag.mjs';
import { createReady } from './http/ready.mjs';
import { createWriteApi, toRootView } from './http/write.mjs';
import { createBackgrounds } from './http/backgrounds.mjs';
import { createUnpackStore } from './unpack/plugin-store.mjs';
import { createUnpackRoutes } from './unpack/routes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = path.join(ROOT, 'src', 'web');
const RUNTIME_DIR = path.join(ROOT, 'src', 'spine-runtimes');
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 8804;

const data = createServerData({ root: ROOT });
// 静态/资源类路由（/plugins、/spine-runtimes、src/web 静态）单独成模块
const staticRoutes = createStaticRoutes({ root: ROOT, webRoot: WEB_ROOT, runtimeDir: RUNTIME_DIR, pluginsDir: PLUGINS_DIR });
const diag = createDiag(data.paths);
// 自定义背景图存储：落盘在 data/backgrounds/（运行时数据，换机/备份需单独带走）
const backgrounds = createBackgrounds(data.paths);

// 服务端解包 + 落盘缓存（17b）：产物在 data/unpacked/<fingerprint>/，前端命中后只 fetch 文件
const unpackStore = createUnpackStore({
  rootDir: path.join(data.paths.dataDir, 'unpacked'),
  pluginDir: path.join(data.paths.pluginsDir, 'unity-live2d-bundle'),
});
const unpackRoutes = createUnpackRoutes({
  store: unpackStore,
  readConfig: () => data.config.readConfig(),
  resolveSafe,
  sendJson,
  readBody,
});
// 就绪信号通道（契约 就绪信号契约.md）：与 diag 完全分离的状态机，不进调试面板
const ready = createReady();
// 写接口（资源根增删改名启停 / 导入配置）：读路径与写路径共用同一份 config/models/names 实例
const writeApi = createWriteApi({
  paths: data.paths, config: data.config, models: data.models, names: data.names,
});

/** 统一的 JSON 响应（与 server.mjs 的 sendJson 同形：无缩进、no-store） */
function sendJson(res, status, body) {
  // 统一守卫：某个 handler 已响应过、但没 return true 让流程继续时，这里直接放弃，
  //   否则会抛 ERR_HTTP_HEADERS_SENT（曾导致日志刷错 + 进程异常退出）。
  if (res.headersSent || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** 简单文本响应 */
function sendText(res, status, text, type) {
  res.writeHead(status, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(text);
}

// ---------------------------------------------------------------- 只读 API

/** 资源根 / 插件 / 品牌 / 前端配置 */
function apiBasics(res, p) {
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
function apiData(res, p, url) {
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
  if (p === '/api/names') return apiNames(res, url);
  if (p === '/api/config/export') {
    try {
      const files = data.config.exportConfigFiles();
      return sendJson(res, 200, { files, count: Object.keys(files).length });
    } catch (e) {
      return sendJson(res, 500, { error: `导出配置失败: ${e.message}` });
    }
  }
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
function apiNames(res, url) {
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
function apiAsync(req, res, p, url) {
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
function serveModelFile(req, res, p, url) {
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
function serveIcon(req, res, p) {
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
function serveLive2DLib(req, res, p) {
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

// ------------------------------------------------------------------ 写接口

/**
 * 读请求体；超限直接断开连接（不截断，避免把半个 JSON 当成完整内容去写盘）。
 *
 * ⚠️ 必须**收齐 Buffer 再统一解码**，不能逐 chunk `body += chunk`：
 *   chunk 是 Buffer，`+=` 会按 utf8 逐段解码；一个多字节字符（中文正好 3 字节）
 *   被切在两个 chunk 边界上时，两半各自解成 U+FFFD ⇒ 内容被写坏。
 *   实测：导入 588KB 名表时「喀琅施塔得」被写成「喀琅��塔得」，文件凭空多 3 字节。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {(body: string) => void} onBody
 * @param {number} [maxBytes] 上限（字节）：默认 2MB；导入配置传 5MB
 */
function readBody(req, res, onBody, maxBytes = 2e6) {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    // 空请求体也要回调（由各接口自己判断"缺少字段"并给出明确错误）
    const body = Buffer.concat(chunks).toString('utf8');
    try {
      onBody(body);
    } catch (e) {
      console.error('[serve] POST 处理异常:', e && e.stack ? e.stack : e);
      sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });
}

// ------------------------------------------------------------------ 入口

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    // 解包缓存三条路由（/api/unpack/*）：与模型资源读取解耦，命中即返回
    if (unpackRoutes(req, res, p, url)) return;
    // 写接口优先拦下（方法敏感，先判）；诊断落盘是只写 data/ 的旁路，按旧规则真实实现
    // 只读：取最近的诊断条目（页面自己记录的那份，供外部/AI 直接读现场）
    if (p === '/api/diag' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit')) || undefined;
      const sid = url.searchParams.get('sid') || undefined;
      return sendJson(res, 200, diag.readDiag({ limit, sid }));
    }
    if (p === '/api/diag' && req.method === 'POST') {
      return readBody(req, res, (body) => sendJson(res, 200, diag.appendDiag(body)));
    }
    // 就绪信号（契约 §五）：快照幂等；SSE 先推全量再推增量；POST 是页面侧上报入口
    if (p === '/api/ready' && req.method === 'GET') {
      const stage = url.searchParams.get('stage') || '';
      const snap = ready.snapshot(stage || undefined);
      // 未登记的阶段名 = 调用方写错（契约 §三：阶段必须先登记）⇒ 400 并回可用清单；
      //   已登记但尚未上报的返回 state:'pending'（200），两者语义不同，别混。
      return sendJson(res, snap && snap.ok === false ? 400 : 200, snap);
    }
    if (p === '/api/ready/stream' && req.method === 'GET') {
      return ready.subscribe(req, res);   // 长连接：先 snapshot 事件，后 update 事件
    }
    if (p === '/api/ready' && req.method === 'POST') {
      // 注意：readBody 给的是**原始字符串**（diag 自己在内部 parse），这里必须自行解析
      return readBody(req, res, (raw) => {
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        }
        return sendJson(res, 200, ready.apply(body));
      });
    }
    // 资源根写操作（增 / 删 / 改名 / 启停）：校验 → 备份 → 写 → 失效缓存
    // 具体管道在 http/write.mjs；这里只负责读请求体与发响应。
    if (p === '/api/roots' && req.method === 'POST') {
      return readBody(req, res, (body) => {
        writeApi.writeRoots(body)
          .then((r) => sendJson(res, r.status, r.body))
          .catch((e) => sendJson(res, 500, { ok: false, error: `写资源根异常: ${(e && e.message) || e}` }));
      });
    }
    if (p === '/api/config/import' && req.method === 'POST') {
      // 导入配置（覆盖 resources.json / names/*.json）：同一套校验 → 备份 → 写 → 回读自检。
      // 请求体上限放宽到 5MB：名表 JSON 可能较大（与旧端一致）。
      return readBody(req, res, (body) => {
        writeApi.writeConfigImport(body)
          .then((r) => sendJson(res, r.status, r.body))
          .catch((e) => sendJson(res, 500, { ok: false, error: `导入配置异常: ${(e && e.message) || e}` }));
      }, 5e6);
    }
    // ---------------------------------------------------------------- 自定义背景图（5 个接口）
    // 上传走原始二进制 + x-filename 头（零依赖，不解析 multipart）；上限与类型在模块内校验。
    if (p === '/api/backgrounds' && req.method === 'GET') {
      return sendJson(res, 200, backgrounds.list());
    }
    if (p === '/api/backgrounds' && req.method === 'POST') {
      // 注意：这条**不能**用 readBody——它会把整个请求体读进内存；
      //   backgrounds 自己边读边计数，超限立刻断开（小内存机 + 5MB×并发会 OOM）。
      return backgrounds.uploadStream(req)
        .then((r) => {
          sendJson(res, r.status, r.body);
          // 超限/中断：响应先落地，再稍微缓一下才断开。
          //   立刻 destroy 会让浏览器 fetch 只看到网络错误（拿不到 413 与 reason，
          //   用户就只能看到笼统的"上传失败"）；缓 800ms 足够响应刷出去，
          //   同时不让一个超大上传一直占着连接。
          if (r.destroy) setTimeout(() => { try { req.destroy(); } catch { /* 已断开 */ } }, 800);
        })
        .catch((e) => sendJson(res, 500, { ok: false, reason: 'server-error', error: String((e && e.message) || e) }));
    }
    if (p === '/api/backgrounds/rename' && req.method === 'POST') {
      return readBody(req, res, (raw) => {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch {
          return sendJson(res, 400, { ok: false, reason: 'bad-json', error: '请求体不是合法 JSON' });
        }
        backgrounds.rename(body.id, body.name)
          .then((r) => sendJson(res, r.status, r.body))
          .catch((e) => sendJson(res, 500, { ok: false, reason: 'server-error', error: String((e && e.message) || e) }));
      });
    }
    if (p === '/api/backgrounds/delete' && req.method === 'POST') {
      return readBody(req, res, (raw) => {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch {
          return sendJson(res, 400, { ok: false, reason: 'bad-json', error: '请求体不是合法 JSON' });
        }
        backgrounds.remove(body.id)
          .then((r) => sendJson(res, r.status, r.body))
          .catch((e) => sendJson(res, 500, { ok: false, reason: 'server-error', error: String((e && e.message) || e) }));
      });
    }
    // GET 与 HEAD 都要接：代理/预取会先发 HEAD 探测，只认 GET 会让它拿到 404 的 JSON 头
    if (p.startsWith('/api/backgrounds/file/') && (req.method === 'GET' || req.method === 'HEAD')) {
      // id 只用于查索引，绝不拼进路径（用户可控输入）
      const id = decodeURIComponent(p.slice('/api/backgrounds/file/'.length));
      const hit = backgrounds.fileOf(id);
      if (!hit) return sendJson(res, 404, { ok: false, reason: 'not-found', error: `没有这张背景图：${id}` });
      return sendFile(req, res, hit.abs, {
        'Content-Type': hit.mime,
        // 同一个 id 的文件内容不会变（重命名只改显示名），可以长缓存
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    }
    if (apiBasics(res, p)) return;
    if (apiData(res, p, url)) return;
    if (apiAsync(req, res, p, url)) return;
    if (serveModelFile(req, res, p, url)) return;
    if (serveIcon(req, res, p)) return;
    if (serveLive2DLib(req, res, p)) return;
    if (staticRoutes.serveAssets(req, res, p)) return;
    if (res.headersSent) return;
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: `未知接口: ${p}` });
    if (req.method === 'GET' || req.method === 'HEAD') return staticRoutes.serveStatic(req, res, p);
    return sendText(res, 405, `405: ${req.method} ${p}`);
  } catch (e) {
    console.error('[serve] 处理异常:', e && e.stack ? e.stack : e);
    try {
      if (!res.headersSent) sendJson(res, 500, { error: `服务内部错误: ${e.message}` });
    } catch {
      try { res.writeHead(500); res.end('internal error'); } catch { /* 忽略 */ }
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[serve] 新端自带服务 on http://0.0.0.0:${PORT}`);
  console.log(`[serve] 静态根 ${WEB_ROOT}`);
  console.log(`[serve] 资源根 ${data.config.readConfig().map((r) => `${r.id}=${r.name}`).join(', ') || '(无)'}`);
});
