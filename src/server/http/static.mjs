// serve-static.mjs —— 静态资源类路由（从 serve.mjs 拆出，控制单文件规模）
//
// 负责：/plugins/*、/spine-runtimes/*（含 index.json 版本清单）、以及 src/web 静态托管。
// 与数据无关，故不依赖 createServerData；目录根由调用方注入。
import fs from 'node:fs';
import path from 'node:path';
import { MIME } from '../assets/probe.mjs';
// 版本排序与工具同口径（语义版本，4.0.10 > 4.0.9）—— 别在这里另写一套比较函数
import { compareSemver } from '../../../tool/lib/runtime-package.mjs';

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
/** 纯文本响应头：原来 9 处各写一遍同一个字面量，集中一处（改 charset 只改这里） */
const MIME_TEXT_PLAIN = 'text/plain; charset=utf-8';
export function sendFile(req, res, abs, extraHeaders) {
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    res.writeHead(404, { 'Content-Type': MIME_TEXT_PLAIN });
    return res.end('404: not found');
  }
  if (!stat.isFile()) {
    res.writeHead(404, { 'Content-Type': MIME_TEXT_PLAIN });
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

/**
 * 扫运行时目录得到版本清单（客户端不写死版本）。
 *
 * 支持传**多个**目录并合并去重：项目自带（src/spine-runtimes）与用户数据根
 *   （<dataRoot>/runtimes/spine，由 tool/fetch-runtimes.mjs 下载）都要算进来 ——
 *   只扫一个目录时会出现"resolver 找得到、前端却列不出来"的假缺失。
 * 排序用语义版本（4.0.10 必须排在 4.0.9 之后），不能靠字符串比较。
 *
 * @param {...(string|string[])} dirs 一个或多个目录
 * @returns {string[]}
 */
export function listRuntimeVersions(...dirs) {
  const flat = dirs.flat().filter(Boolean);
  const found = new Set();
  const addFrom = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const m = /^spine-webgl-(.+)\.js$/.exec(f);
      if (m) found.add(m[1]);
    }
  };
  for (const dir of flat) {
    try {
      addFrom(dir);
      // 分版本子目录（<dir>/<ver>/spine-webgl-<ver>.js）也要列出来 ——
      //   那是 tool/fetch-runtimes.mjs 的下载布局；只扫平铺会让"下载成功但前端列不出来"。
      const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      for (const sub of subs) {
        try { addFrom(path.join(dir, sub)); } catch { /* 读不了就跳过 */ }
      }
    } catch { /* 目录不存在 = 这一路没有版本，继续看下一个 */ }
  }
  return [...found].sort(compareSemver);
}

/**
 * 组装给前端的"缺运行时怎么补"提示。
 *
 * 为什么由服务端出：提示里最有用的一条是**落地目录的绝对路径**，而 dataRoot 只有服务端知道；
 *   前端自己拼只能写相对描述，用户还得猜。
 * 前端用法：把 versions 里没有的版本号代入 templates.spineFetch / templates.spine3Curl。
 *
 * @param {{dataRoot?: string, dataRuntimesDir?: string, live2dRuntimesDir?: string}} ctx
 * @returns {object}
 */
export function buildRuntimeHint(ctx) {
  const dataRoot = (ctx && ctx.dataRoot) || '';
  const spineDir = (ctx && ctx.dataRuntimesDir) || (dataRoot ? path.join(dataRoot, 'runtimes', 'spine') : '');
  const live2dDir = (ctx && ctx.live2dRuntimesDir) || (dataRoot ? path.join(dataRoot, 'runtimes', 'live2d') : '');
  return {
    dataRoot,
    spineDir,
    live2dDir,
    // {ver} 由前端替换成实际缺的版本号
    spineFetch: 'node tool/fetch-runtimes.mjs --spine {ver}',
    spineTarget: spineDir ? path.join(spineDir, '{ver}', 'spine-webgl-{ver}.js') : '',
    spine3Curl: 'curl -L -o "' + (spineDir ? path.join(spineDir, '{ver}', 'spine-webgl-{ver}.js') : 'spine-webgl-{ver}.js')
      + '" https://raw.githubusercontent.com/EsotericSoftware/spine-runtimes/{ver}/spine-ts/build/spine-webgl.js',
    spine3Note: '3.x 官方未发 npm（最早 4.0.1）⇒ 只能用上面这条 curl 自备；4.x 可用 spineFetch 自动下载',
    live2dGuideUrl: 'https://www.live2d.com/en/sdk/download/web/',
    live2dTarget: live2dDir,
    live2dFiles: ['live2dcubismcore.js', 'pixi.min.js', 'index.min.js'],
    live2dNote: 'Live2D Cubism Core 需你本人同意官方专有许可，本项目不代下载',
  };
}

/**
 * 在「项目自带 → 数据根」里找 /spine-runtimes/<file> 对应的实际文件。
 *
 * 数据根侧要兼容两种布局：平铺 <dir>/<file> 与分版本 <dir>/<ver>/<file>（下载布局）。
 * 前端请求的永远是平铺 URL（`/spine-runtimes/spine-webgl-<ver>.js`），所以这里做一次映射。
 * @param {object} ctx
 * @param {string} p URL 路径
 * @returns {string|null}
 */
function resolveRuntimeFile(ctx, p) {
  const fromProject = resolveUnder(ctx.runtimeDir, p, '/spine-runtimes/');
  if (fromProject) return fromProject;
  if (!ctx.dataRuntimesDir) return null;
  const flat = resolveUnder(ctx.dataRuntimesDir, p, '/spine-runtimes/');
  if (flat) return flat;
  // 分版本布局：只处理 spine-webgl-<ver>.js 这一种命名（版本号受正则约束，无法穿越目录）
  const base = path.basename(p);
  const m = /^spine-webgl-([\w.-]+)\.js$/.exec(base);
  if (!m) return null;
  const nested = path.join(ctx.dataRuntimesDir, m[1], base);
  try {
    return fs.statSync(nested).isFile() ? nested : null;
  } catch {
    return null;
  }
}

/** /plugins/* 、/spine-runtimes/*；处理了返回 true */
export function serveAssets(ctx, req, res, p) {
  if (p.startsWith('/plugins/')) return servePluginFile(ctx, req, res, p);
  if (p === '/spine-runtimes/index.json') {
    // 两个目录合并：项目自带优先（同版本以项目自带为准，与 resolver 的选择顺序一致）
    const body = JSON.stringify({
      versions: listRuntimeVersions(ctx.runtimeDir, ctx.dataRuntimesDir),
      runtimeHint: buildRuntimeHint(ctx),
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
  if (p.startsWith('/spine-runtimes/')) {
    const abs = resolveRuntimeFile(ctx, p);
    if (!abs) {
      res.writeHead(404, { 'Content-Type': MIME_TEXT_PLAIN });
      res.end('404: ' + p);
      return true;
    }
    sendFile(req, res, abs, { 'Content-Type': 'text/javascript; charset=utf-8' });
    return true;
  }
  return false;
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
    res.writeHead(status, { 'Content-Type': MIME_TEXT_PLAIN, 'Cache-Control': 'no-store' });
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

/** 静态托管 src/web（开发期禁缓存）；处理了返回 true */
export function serveStatic(ctx, req, res, p) {
  let rel;
  try {
    rel = decodeURIComponent(p);
  } catch {
    res.writeHead(400, { 'Content-Type': MIME_TEXT_PLAIN });
    res.end('400: bad encoding');
    return true;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  // 共享模块：src/shared 与 src/web 平级，前端按 /shared/xxx.mjs 引入。
  //   不加这段会被当成 src/web/shared/... ⇒ 404 ⇒ 引用它的模块整条链路加载失败（页面白屏）。
  if (rel.startsWith('/shared/')) {
    const sharedRoot = path.resolve(ctx.webRoot, '..', 'shared');
    const sub = `.${rel.slice('/shared'.length)}`;
    const sharedAbs = path.resolve(sharedRoot, sub);
    if (sharedAbs !== sharedRoot && !sharedAbs.startsWith(sharedRoot + path.sep)) {
      res.writeHead(403, { 'Content-Type': MIME_TEXT_PLAIN });
      res.end('403: forbidden');
      return true;
    }
    if (!fs.existsSync(sharedAbs) || !fs.statSync(sharedAbs).isFile()) {
      res.writeHead(404, { 'Content-Type': MIME_TEXT_PLAIN });
      res.end(`404: ${p}`);
      return true;
    }
    sendFile(req, res, sharedAbs);
    return true;
  }
  const abs = path.resolve(ctx.webRoot, `.${rel}`);
  if (abs !== ctx.webRoot && !abs.startsWith(ctx.webRoot + path.sep)) {
    res.writeHead(403, { 'Content-Type': MIME_TEXT_PLAIN });
    res.end('403: forbidden');
    return true;
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404, { 'Content-Type': MIME_TEXT_PLAIN });
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
    // 用户数据根下的运行时（tool/fetch-runtimes.mjs 的落点）。缺省为空 = 不参与探测，
    //   行为与"没有这个字段"完全一致。
    dataRuntimesDir: opts.dataRuntimesDir || '',
    live2dRuntimesDir: opts.live2dRuntimesDir || '',
    dataRoot: opts.dataRoot || '',
  };
  return {
    serveAssets: (req, res, p) => serveAssets(ctx, req, res, p),
    serveStatic: (req, res, p) => serveStatic(ctx, req, res, p),
    pluginWhitelist: (id) => pluginWhitelist(ctx.pluginsDir, id),
  };
}
