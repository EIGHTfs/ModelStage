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
//   · /engine.js        渲染引擎（优先 src/engine/engine.js，缺失回落 legacy 并告警）
//   · 其余              静态托管 src/web
//
// 写接口（POST /api/roots、/api/config/import、/api/diag）第一版**不实现**，统一返回 501：
//   写配置必须先「校验 → 备份 → 写」，未经验证不在新入口开放；旧服务仍可写。
//
// 用法：PORT=8804 node src/server/serve.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerData } from './index.mjs';
import { resolveSafe } from './probe.mjs';
import { browseDir } from './browse.mjs';
import { createStaticRoutes, sendFile } from './http/static.mjs';
import { createDiag } from './http/diag.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = path.join(ROOT, 'src', 'web');
const RUNTIME_DIR = path.join(ROOT, 'src', 'spine-runtimes');
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 8804;

const data = createServerData({ root: ROOT });
// 静态/资源类路由（/plugins、/spine-runtimes、/engine.js、src/web 静态）单独成模块
const staticRoutes = createStaticRoutes({ root: ROOT, webRoot: WEB_ROOT, runtimeDir: RUNTIME_DIR, pluginsDir: PLUGINS_DIR });
const diag = createDiag(data.paths);

/** 统一的 JSON 响应（与 server.mjs 的 sendJson 同形：无缩进、no-store） */
function sendJson(res, status, body) {
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
    const list = data.config.readConfig().map((r) => ({
      id: r.id,
      name: r.name,
      path: r.path,
      kind: r.kind || 'spine',
      profile: r.profile || null,
      exists: fs.existsSync(r.path) && fs.statSync(r.path).isDirectory(),
    }));
    return sendJson(res, 200, { roots: list, groups: data.config.buildGroups(list) });
  }
  if (p === '/api/plugins') {
    return sendJson(res, 200, { ok: true, dir: 'plugins', plugins: data.plugins.readPlugins() });
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

/** 读请求体（上限 2MB，与旧服务一致）；超限直接断开 */
function readBody(req, res, onBody) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 2e6) req.destroy();
  });
  req.on('end', () => {
    try {
      onBody(body);
    } catch (e) {
      console.error('[serve] POST 处理异常:', e && e.stack ? e.stack : e);
      sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });
}

/** 写接口第一版不开放：501 + 明确说明（避免未验证就动用户配置） */
function rejectWrite(res, p) {
  sendJson(res, 501, {
    ok: false,
    error: '该实例为新端自带只读服务：写操作（资源根 / 配置导入 / 诊断落盘）暂未开放',
    path: p,
    hint: '需要写入时请使用旧服务实例，或等写路径完成「校验 → 备份 → 写」验证后再开放',
  });
}

// ------------------------------------------------------------------ 入口

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    // 写接口优先拦下（方法敏感，先判）；诊断落盘是只写 data/ 的旁路，按旧规则真实实现
    if (p === '/api/diag' && req.method === 'POST') {
      return readBody(req, res, (body) => sendJson(res, 200, diag.appendDiag(body)));
    }
    if ((p === '/api/roots' || p === '/api/config/import') && req.method === 'POST') {
      return rejectWrite(res, p);
    }
    if (apiBasics(res, p)) return;
    if (apiData(res, p, url)) return;
    if (apiAsync(req, res, p, url)) return;
    if (serveModelFile(req, res, p, url)) return;
    if (serveIcon(req, res, p)) return;
    if (serveLive2DLib(req, res, p)) return;
    if (staticRoutes.serveAssets(req, res, p)) return;
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: `未知接口: ${p}` });
    if (req.method === 'GET' || req.method === 'HEAD') return staticRoutes.serveStatic(req, res, p);
    return sendText(res, 405, `405: ${req.method} ${p}`);
  } catch (e) {
    console.error('[serve] 处理异常:', e && e.stack ? e.stack : e);
    try {
      sendJson(res, 500, { error: `服务内部错误: ${e.message}` });
    } catch {
      try { res.writeHead(500); res.end('internal error'); } catch { /* 忽略 */ }
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[serve] 新端自带服务 on http://0.0.0.0:${PORT}`);
  console.log(`[serve] 静态根 ${WEB_ROOT}`);
  console.log(`[serve] 引擎 ${staticRoutes.pickEngineFile() || '(缺失)'}`);
  console.log(`[serve] 资源根 ${data.config.readConfig().map((r) => `${r.id}=${r.name}`).join(', ') || '(无)'}`);
});
