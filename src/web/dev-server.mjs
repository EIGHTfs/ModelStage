#!/usr/bin/env node
// dev-server.mjs —— ModelStage 新前端的零依赖开发服务（M1）
//
// 做什么：
//   1. 静态托管本目录（src/web/）：/ → index.html，其余按相对路径取文件；
//   2. 把 /api、/files、/icons、/live2d-lib 反代到上游实例（默认 127.0.0.1:8803），
//      让新前端（8804）与旧前端（8803）读同一份真实数据，页面侧始终同源。
//
// 为什么反代而不是让页面直连上游：
//   /api/roots 等接口没发 Access-Control-Allow-Origin（只有 /files、/api/file 发了），
//   跨源 fetch 会被浏览器拦；反代后新前端全程同源，M2+ 的 /api/tree、/api/models 同样可用。
// 为什么不改 server.mjs：能力层只读消费，8803 保持不动作对照端。
// 为什么这里不做品牌注入：品牌由 GET /api/brand 下发（见 main.js 的 loadBrand），
//   注入 + 接口两套来源会造成口径漂移，只保留接口一条真源。
//
// 用法：
//   PORT=8804 UPSTREAM=http://127.0.0.1:8803 node src/web/dev-server.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = path.dirname(fileURLToPath(import.meta.url));

// 端口与上游一律走环境变量（部署差异单值），不写死在代码里
const PORT = Number(process.env.PORT) || 8804;
const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:8803';
const upstreamUrl = new URL(UPSTREAM);

// 需要反代到能力层的路径前缀：页面侧全部当同源接口用
const PROXY_PREFIXES = ['/api/', '/files/', '/icons/', '/live2d-lib/'];

// Spine 运行时：不在 src/web 下（3.2MB、7 个版本、已被 .gitignore 排除），单独一条静态路由。
// 为什么由本服务托管而不是走 8803：运行时是"前端自己的资源"，且新前端要按模型版本按需加载。
const RUNTIME_DIR = path.resolve(WEB_ROOT, '..', 'spine-runtimes');
const RUNTIME_PREFIX = '/spine-runtimes/';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/**
 * 服务 src/spine-runtimes/<文件名>（只允许该目录下的普通文件，防目录穿越）。
 * @returns {boolean} 是否已处理该请求
 */
function serveRuntime(req, res, pathname) {
  if (!pathname.startsWith(RUNTIME_PREFIX)) return false;
  const name = decodeURIComponent(pathname.slice(RUNTIME_PREFIX.length));
  const abs = path.resolve(RUNTIME_DIR, name);
  // 越界（../ 之类）或不是直接子文件都拒绝
  if (!abs.startsWith(RUNTIME_DIR + path.sep) || path.dirname(abs) !== RUNTIME_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403: forbidden');
    return true;
  }
  let stat;
  try { stat = fs.statSync(abs); } catch { stat = null; }
  if (!stat || !stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404: ${name}`);
    return true;
  }
  res.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Content-Length': stat.size,
    // 运行时按版本固定内容，可以缓存；开发期仍禁缓存避免"改了没生效"的错觉
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(abs).pipe(res);
  return true;
}

/**
 * 把 URL 路径解析到 src/web 内的真实文件；越界或不存在返回 null。
 * 防穿越：解析后必须仍在 WEB_ROOT 之下（/../ 之类不能读到仓库别处）。
 * @param {string} pathname
 * @returns {string|null}
 */
function resolveStatic(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null; // 非法百分号编码
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.resolve(WEB_ROOT, '.' + rel);
  if (abs !== WEB_ROOT && !abs.startsWith(WEB_ROOT + path.sep)) return null;
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return abs;
}

/** 静态响应（开发期禁缓存：改完刷新即见，不出现"改了没生效"的假象） */
function serveStatic(req, res, pathname) {
  const abs = resolveStatic(pathname);
  if (!abs) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`404: ${pathname}`);
  }
  const ext = path.extname(abs).toLowerCase();
  const body = fs.readFileSync(abs);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** 反代到上游能力层（保留方法、请求体、状态码、响应头） */
function proxyToUpstream(req, res) {
  const headers = { ...req.headers, host: upstreamUrl.host };
  const upstreamReq = http.request(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port,
      method: req.method,
      path: req.url,
      headers,
    },
    (upstreamRes) => {
      const outHeaders = { ...upstreamRes.headers };
      // 反代后页面与接口同源；这里只去掉逐跳头，其余原样透传
      delete outHeaders.connection;
      delete outHeaders['transfer-encoding'];
      res.writeHead(upstreamRes.statusCode || 502, outHeaders);
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`502: 上游 ${UPSTREAM} 不可用（${err.message}）`);
  });

  // 请求体原样转发（/api/diag、/api/config/import 等 POST 需要）
  req.pipe(upstreamReq);
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
  // Spine 运行时（src/spine-runtimes/，不在 src/web 下）
  if ((req.method === 'GET' || req.method === 'HEAD') && serveRuntime(req, res, pathname)) return;
  if (PROXY_PREFIXES.some((p) => pathname.startsWith(p))) {
    return proxyToUpstream(req, res);
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, pathname);
  }
  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`405: ${req.method} ${pathname}`);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[src/web] ModelStage 新前端 on http://0.0.0.0:${PORT}  上行 ${UPSTREAM}  静态根 ${WEB_ROOT}`);
});
