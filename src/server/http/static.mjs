// serve-static.mjs —— 静态资源类路由（从 serve.mjs 拆出，控制单文件规模）
//
// 负责：/plugins/*、/spine-runtimes/*（含 index.json 版本清单）、以及 src/web 静态托管。
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

// ---------------------------------------------------------------- 插件静态下发（白名单）
//
// 为什么不能像以前那样"plugins/ 目录下有什么就发什么"：
//   插件目录里除了代码还会有笔记、临时产物（历史上出现过自测脚本与卡点清单这类文件），
//   这些既不该对外可读，也不属于插件契约。所以只下发 plugin.json **显式声明**过的文件：
//     · files[]  —— 插件代码（index.js / lib/*.js）
//     · assets[] —— 插件自己的数据文件（如 profiles/<游戏>.json；插件运行时会自己 fetch 它）
//     · entry    —— 入口（通常已在 files[] 里，兜底再收一次）
//
// 待收敛提示：容器判定/解包逻辑现在有三份副本（插件 lib/bundle-probe.js、
//   tool/lib/bundle-probe-node.mjs、src/server/plugins/registry.mjs 的 detectBundleContainer），
//   接线完成后统一收敛到插件一份（本轮不做，见 M5 步骤说明）。

/** 插件白名单缓存：pluginsDir::id → Set<相对路径>；null 表示该插件没有可用清单 */
const pluginWhitelistCache = new Map();

/**
 * 读某插件的可下发白名单（未声明的一律不发）。
 * @returns {Set<string>|null} null = 清单缺失/损坏 ⇒ 该插件不可下发
 */
export function pluginWhitelist(pluginsDir, id) {
  const key = `${pluginsDir}::${id}`;
  if (pluginWhitelistCache.has(key)) return pluginWhitelistCache.get(key);
  let list = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginsDir, id, 'plugin.json'), 'utf8'));
    const declared = [];
    if (Array.isArray(manifest.files)) declared.push(...manifest.files);
    if (Array.isArray(manifest.assets)) declared.push(...manifest.assets);
    if (manifest.entry) declared.push(manifest.entry);
    list = new Set(declared.map((f) => String(f).replace(/^\.?\//, '')));
  } catch {
    list = null;
  }
  pluginWhitelistCache.set(key, list);
  return list;
}

/** 路径段校验：拒绝绝对路径、空段、. 与 ..（穿越） */
function isSafeRelPath(rel) {
  if (!rel || rel.includes('\0')) return false;
  if (path.isAbsolute(rel)) return false;
  const segs = rel.split('/');
  return segs.every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * /plugins/<id>/<file>：白名单下发。处理了返回 true。
 * 语义：未在 plugin.json 声明 ⇒ 403（有清单但该文件不在白名单）；清单缺失/插件不存在 ⇒ 404。
 */
export function servePluginFile(ctx, req, res, p) {
  const deny = (status, msg) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(msg);
  };
  let rel;
  try {
    rel = decodeURIComponent(p.slice('/plugins/'.length));
  } catch {
    return deny(400, `400: bad encoding ${p}`);
  }
  const slash = rel.indexOf('/');
  const id = slash > 0 ? rel.slice(0, slash) : '';
  const sub = slash > 0 ? rel.slice(slash + 1) : '';
  if (!id || !sub) return deny(404, `404: ${p}`);
  if (!isSafeRelPath(id) || !isSafeRelPath(sub)) return deny(403, `403: 路径非法 ${p}`);
  const allow = pluginWhitelist(ctx.pluginsDir, id);
  if (!allow) return deny(404, `404: 插件不存在或清单不可读 ${id}`);
  if (!allow.has(sub)) return deny(403, `403: 未在 plugin.json 声明，拒绝下发 ${sub}`);
  const abs = resolveUnder(ctx.pluginsDir, p, '/plugins/');
  if (!abs) return deny(404, `404: ${p}`);
  sendFile(req, res, abs);
  return true;
}

/** /plugins/* 、/spine-runtimes/*；处理了返回 true */
export function serveAssets(ctx, req, res, p) {
  if (p.startsWith('/plugins/')) return servePluginFile(ctx, req, res, p);
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
 * 绑定型适配器：目录固定，调用方只需 (req,res,p)。
 * @param {{root: string, webRoot: string, runtimeDir: string, pluginsDir: string}} opts
 */
export function createStaticRoutes(opts) {
  const ctx = {
    root: opts.root,
    webRoot: opts.webRoot,
    runtimeDir: opts.runtimeDir,
    pluginsDir: opts.pluginsDir,
  };
  return {
    serveAssets: (req, res, p) => serveAssets(ctx, req, res, p),
    serveStatic: (req, res, p) => serveStatic(ctx, req, res, p),
    pluginWhitelist: (id) => pluginWhitelist(ctx.pluginsDir, id),
  };
}
