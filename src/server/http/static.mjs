// serve-static.mjs —— 静态资源类路由（从 serve.mjs 拆出，控制单文件规模）
//
// 负责：/plugins/*、/spine-runtimes/*（含 index.json 版本清单）、/engine.js、以及 src/web 静态托管。
// 与数据无关，故不依赖 createServerData；目录根由调用方注入。
import fs from 'node:fs';
import path from 'node:path';
import { MIME } from '../assets/probe.mjs';

/** 把 URL 解析到某个根目录下的真实文件；越界或不存在返回 null */
export function resolveUnder(baseDir, pathname, prefix) {
  let rel;
  try {
    rel = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
  const abs = path.resolve(baseDir, rel);
  if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) return null;
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/** 流式发送磁盘文件（长度已知、禁缓存） */
export function sendFile(req, res, abs, extraHeaders) {
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404: not found');
  }
  if (!stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404: not found');
  }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, Object.assign({
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  }, extraHeaders || {}));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(abs).pipe(res);
}

/** 扫运行时目录得到版本清单（客户端不写死版本） */
export function listRuntimeVersions(runtimeDir) {
  try {
    return fs.readdirSync(runtimeDir)
      .map((f) => (f.match(/^spine-webgl-(.+)\.js$/) || [])[1])
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

/**
 * 选引擎文件：候选里第一个存在的；落到 legacy 时告警一次。
 * @param {{root: string, engineCandidates: string[], state: {warned: boolean}}} ctx
 */
export function pickEngineFile(ctx) {
  for (const candidate of ctx.engineCandidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        if (candidate.includes(`${path.sep}legacy${path.sep}`) && !ctx.state.warned) {
          ctx.state.warned = true;
          console.warn(`[serve] 未找到 src/engine/engine.js，回落到 ${path.relative(ctx.root, candidate)}（迁移完成后应改走新路径）`);
        }
        return candidate;
      }
    } catch {
      /* 继续找下一个候选 */
    }
  }
  return null;
}

/** /plugins/* 、/spine-runtimes/* 、/engine.js；处理了返回 true */
export function serveAssets(ctx, req, res, p) {
  if (p.startsWith('/plugins/')) {
    const abs = resolveUnder(ctx.pluginsDir, p, '/plugins/');
    if (!abs) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404: ' + p);
      return true;
    }
    sendFile(req, res, abs);
    return true;
  }
  if (p === '/spine-runtimes/index.json') {
    const body = JSON.stringify({ versions: listRuntimeVersions(ctx.runtimeDir) });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
  if (p.startsWith('/spine-runtimes/')) {
    const abs = resolveUnder(ctx.runtimeDir, p, '/spine-runtimes/');
    if (!abs) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404: ' + p);
      return true;
    }
    sendFile(req, res, abs, { 'Content-Type': 'text/javascript; charset=utf-8' });
    return true;
  }
  if (p === '/engine.js') {
    const abs = pickEngineFile(ctx);
    if (!abs) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404: /engine.js');
      return true;
    }
    sendFile(req, res, abs, { 'Content-Type': 'text/javascript; charset=utf-8' });
    return true;
  }
  return false;
}

/** 静态托管 src/web（开发期禁缓存）；处理了返回 true */
export function serveStatic(ctx, req, res, p) {
  let rel;
  try {
    rel = decodeURIComponent(p);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400: bad encoding');
    return true;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.resolve(ctx.webRoot, `.${rel}`);
  if (abs !== ctx.webRoot && !abs.startsWith(ctx.webRoot + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403: forbidden');
    return true;
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404: ${p}`);
    return true;
  }
  sendFile(req, res, abs);
  return true;
}

/**
 * 绑定型适配器：目录与引擎候选固定，调用方只需 (req,res,p)。
 * @param {{root: string, webRoot: string, runtimeDir: string, pluginsDir: string}} opts
 */
export function createStaticRoutes(opts) {
  const ctx = {
    root: opts.root,
    webRoot: opts.webRoot,
    runtimeDir: opts.runtimeDir,
    pluginsDir: opts.pluginsDir,
    engineCandidates: [
      process.env.SPINE_ENGINE_FILE && path.resolve(process.env.SPINE_ENGINE_FILE),
      path.join(opts.root, 'src', 'engine', 'engine.js'),
      path.join(opts.root, 'legacy', 'source', 'engine.js'),
    ].filter(Boolean),
    state: { warned: false },
  };
  return {
    serveAssets: (req, res, p) => serveAssets(ctx, req, res, p),
    serveStatic: (req, res, p) => serveStatic(ctx, req, res, p),
    pickEngineFile: () => pickEngineFile(ctx),
  };
}
