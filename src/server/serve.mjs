#!/usr/bin/env node
// serve.mjs —— 服务入口。所有请求都由这里处理：
//   · /api/*            数据层：调 src/server/** 的实现
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
import { createBackgroundSolids } from './http/background-solids.mjs';
import { createDiagUpload } from './http/diag-upload.mjs';
import { createLogger } from './core/log.mjs';
import { createUnpackStore } from './unpack/plugin-store.mjs';
import { createUnpackRoutes } from './unpack/routes.mjs';
import { handleData } from './routes/data.mjs';
import { handleConfig } from './routes/config.mjs';
import { handleDiag } from './routes/diag.mjs';
import { handleReady } from './routes/ready.mjs';
import { handleBackgrounds } from './routes/backgrounds.mjs';
import { handleBackgroundSolids } from './routes/background-solids.mjs';
import { handleEntries, createContextFor } from './routes/entries.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = path.join(ROOT, 'src', 'web');
const RUNTIME_DIR = path.join(ROOT, 'src', 'spine-runtimes');
const PLUGINS_DIR = path.join(ROOT, 'plugins');
/**
 * 数据根：`MODELSTAGE_DATA_ROOT` 环境变量（缺省空 = 项目根 ⇒ **行为完全不变**）。
 *
 * 只影响 config/ data/ runtime/ 三处；代码目录（plugins/ src/ tool/）始终跟随 ROOT。
 * 为什么需要它：测试与生产共用同一实例时，验证过程中的重启会打断正在加载的页面
 *   （实测把 /live2d-lib 的加载掐断过），且两边同时写 config 会互相覆盖。
 *   有了它，测试可以起第二实例（不同端口 + 不同数据根），互不干扰。
 */
const DATA_ROOT = (process.env.MODELSTAGE_DATA_ROOT || '').trim();
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 8804;

/**
 * 头像根解析：`--avatar-root <dir>` > 环境变量 `MODELSTAGE_AVATAR_ROOT` > `<项目根>/avatars`（默认占位）。
 * 为什么要可配置：头像仓是独立私有仓，而项目根可能在 CIFS/SMB 上（不允许 chmod ⇒ 那里 clone 不出来），
 *   所以头像仓要能放到任意可写位置再指过来（见 docs/设计/名表.md §4.1）。
 */
function resolveAvatarRoot() {
  const i = process.argv.indexOf('--avatar-root');
  const fromArg = i >= 0 ? process.argv[i + 1] : '';
  return fromArg || process.env.MODELSTAGE_AVATAR_ROOT || '';
}

/** 服务端日志（统一形状 {at,level,tag,msg,detail}；error→stderr，其余→stdout） */
const log = createLogger('serve');

/**
 * 请求活跃度探针：给后台任务判断"现在是不是真空闲"（契约 §八 的"不抢装载资源"）。
 *
 * 为什么需要：catalog / 解包这些同步解析会占满主线程（探测单包 ~543ms），
 *   后台任务只要在"有请求在飞"时动 CPU，用户就会看到某个请求莫名慢几百毫秒。
 *   有了这份计数，后台可以主动让路（见 data/shape-probe.mjs 的 waitUntilIdle）。
 *
 * 统计口径：**只算短请求**。SSE（/api/ready/stream）会一直挂着不结束，
 *   把它算进来会得到"永远不空闲"——探测当场饿死。
 */
const activity = {
  inflight: 0,
  lastRequestAt: Date.now(),
  /** 有短请求正在处理（长连接不算） */
  idle() { return this.inflight <= 0; },
  /** 距上一次短请求开始过了多久（ms） */
  msSinceLastRequest() { return Date.now() - this.lastRequestAt; },
};

// log 注入：后台形态探测（§八）要能把"启动/完成/失败"写进同一条服务端日志，
//   否则 S10 的"探测启动次数 = 0"没有可核对的凭据。
// activity 注入：探测据此让路（有请求在飞 / 刚有请求 ⇒ 不推进），避免抢主线程。
const data = createServerData({
  root: ROOT,
  dataRoot: DATA_ROOT || undefined,
  avatarRoot: resolveAvatarRoot() || undefined,
  log,
  activity,
});
// 静态/资源类路由（/plugins、/spine-runtimes、src/web 静态）单独成模块
// dataRuntimesDir = tool/fetch-runtimes.mjs 的下载落点（<dataRoot>/runtimes/spine）。
//   传进去之后 /spine-runtimes/index.json 才列得出它、/spine-runtimes/* 才发得出文件
//   —— 否则"下载成功但前端看不到"（resolver 能找到、清单里没有）。
const staticRoutes = createStaticRoutes({
  root: ROOT,
  webRoot: WEB_ROOT,
  runtimeDir: RUNTIME_DIR,
  pluginsDir: PLUGINS_DIR,
  dataRuntimesDir: path.join(data.paths.dataRoot, 'runtimes', 'spine'),
  live2dRuntimesDir: path.join(data.paths.dataRoot, 'runtimes', 'live2d'),
  dataRoot: data.paths.dataRoot,
});
const diag = createDiag(data.paths);
// 自定义背景图存储：落盘在 data/backgrounds/（运行时数据，换机/备份需单独带走）
const backgrounds = createBackgrounds(data.paths);
// 纯色背景预设：落盘 data/backgrounds/solids.json（运行时数据，与背景图同目录）
const solids = createBackgroundSolids(data.paths);
// 调试日志上传：落盘在 data/logs/（页面把内存里的日志一次性交上来，供 AI 事后读现场）
const diagUpload = createDiagUpload({ dataDir: data.paths.dataDir, configDir: data.paths.configDir });

// 服务端解包 + 落盘缓存（17b）：产物在 data/unpacked/<fingerprint>/，前端命中后只 fetch 文件
const unpackStore = createUnpackStore({
  rootDir: path.join(data.paths.dataDir, 'unpacked'),
  // 传插件根而不是某一个插件目录：解包插件不止一个（live2d / spine 各一个），
  //   只读其中一个的版本会让另一个升级时缓存不失效（产物陈旧但一切"正常"）。
  //   plugin-store 会把根下每个插件的版本汇总进指纹。
  pluginDir: data.paths.pluginsDir,
});
// 只读注入：catalog 用它查"这个包被哪个插件解出来过"（列表徽标的展示归属）。
//   只是读缓存索引，不触发任何解包，也不改变 catalog 的缓存行为。
data.catalog.setUnpackStore(unpackStore);
const unpackRoutes = createUnpackRoutes({
  store: unpackStore,
  readConfig: () => data.config.readConfig(),
  resolveSafe,
  sendJson,
  readBody,
});
// 就绪信号通道（契约 就绪信号契约.md）：与 diag 完全分离的状态机，不进调试面板
const ready = createReady();
// 写接口（资源根增删改名启停 / 导入配置）：读路径与写路径共用同一份 config/spine/names 实例
const writeApi = createWriteApi({
  paths: data.paths, config: data.config, spine: data.spine, names: data.names,
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
      log.error('POST 处理异常', { err: (e && e.stack) ? e.stack : String(e) });
      sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });
}

// ------------------------------------------------------------------ 入口

/**
 * 请求上下文：路由模块只拿它需要的东西（显式依赖，便于单测替换）。
 * 不把 req/res 之外的全局状态藏进模块级变量——之前那个 127 行的大回调就是这种耦合的产物。
 */
const ctx = {
  data, staticRoutes, diag, diagUpload, ready, writeApi, backgrounds, solids, unpackRoutes,
  resolveSafe, browseDir, sendFile, toRootView, sendJson, sendText, readBody, fs, path, log,
  // 条目状态（契约 §三）：写读一体的存储实例与"条目静态事实"查询
  entryStates: data.entryStates,
  // 后台形态探测（契约 §八）：计数/手动重探走 /api/entries/probe（S10 的佐证口）
  shapeProbe: data.shapeProbe,
  catalog: data.catalog,
  contextFor: createContextFor({
    providers: () => data.plugins.readPlugins(),
    describe: (key) => data.catalog.describeEntry(key),
  }),
};

/**
 * 顶层分发：按**前缀归属**依次交给路由模块，谁先认领就结束。
 *
 * 顺序有讲究（与拆分前完全一致，不能随意调换）：
 *   1. unpack 三条（/api/unpack/*，与资源读取解耦，命中即返回）
 *   2. diag（/api/diag、/api/diag/upload|uploads）
 *   3. ready（/api/ready GET/POST、/api/ready/stream）
 *   4. config（/api/config/export|import）
 *   5. backgrounds（/api/backgrounds*）
 *   6. data（/api/roots 写 + 只读数据 API + 二进制资源）
 *   7. 静态资源（/plugins、/spine-runtimes、src/web）
 *   8. 兜底：未匹配的 /api/* ⇒ 404 JSON；GET/HEAD ⇒ 静态；其余 ⇒ 405
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} p
 * @param {URL} url
 */
function dispatch(req, res, p, url) {
  if (unpackRoutes(req, res, p, url)) return true;
  if (handleDiag(req, res, p, url, ctx)) return true;
  if (handleReady(req, res, p, url, ctx)) return true;
  if (handleConfig(req, res, p, ctx)) return true;
  // 注意顺序：/api/backgrounds/solids 是 /api/backgrounds 的**子路径**，
  //   必须先让纯色预设那组认领，否则会被 backgrounds 的 404 分支吃掉
  if (handleBackgroundSolids(req, res, p, ctx)) return true;
  if (handleBackgrounds(req, res, p, ctx)) return true;
  // 条目状态（写读一体）：必须在 handleData 之前认领，否则 /api/ 前缀兜底会当未知接口 404
  if (handleEntries(req, res, p, url, ctx)) return true;
  if (handleData(req, res, p, url, ctx)) return true;
  if (staticRoutes.serveAssets(req, res, p)) return true;
  if (res.headersSent) return true;
  if (p.startsWith('/api/')) {
    sendJson(res, 404, { error: `未知接口: ${p}` });
    return true;
  }
  if (req.method === 'GET' || req.method === 'HEAD') return staticRoutes.serveStatic(req, res, p);
  sendText(res, 405, `405: ${req.method} ${p}`);
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // 长连接（SSE）不计入活跃度：它一挂几分钟，计入就等于"服务永远忙"
  const longLived = url.pathname.includes('/stream');
  if (!longLived) {
    activity.inflight += 1;
    activity.lastRequestAt = Date.now();
    let counted = true;
    const done = () => {
      if (!counted) return;      // close 与 finish 都会来，只减一次
      counted = false;
      activity.inflight -= 1;
      activity.lastRequestAt = Date.now();
    };
    res.on('finish', done);
    res.on('close', done);
  }
  try {
    dispatch(req, res, url.pathname, url);
  } catch (e) {
    log.error('请求处理异常', { err: (e && e.stack) ? e.stack : String(e) });
    try {
      if (!res.headersSent) sendJson(res, 500, { error: `服务内部错误: ${e.message}` });
    } catch {
      try { res.writeHead(500); res.end('internal error'); } catch { /* 忽略 */ }
    }
  }
});

// HTTP keep-alive 超时（消除"客户端复用已被服务端关闭的连接"这类 race）：
//   Node 默认 keepAliveTimeout=5s，浏览器常把空闲连接留着复用 ⇒ 拿到已关闭连接 ⇒ fetch 直接 Failed to fetch。
//   现场表现：加载过很多模型后 Spine 空白（模型文件是几十个并发裸 fetch），而资源包正常（走 blob 不走网络）。
//   注意 headersTimeout **必须严格大于** keepAliveTimeout，否则 Node 会在读 header 阶段就断连。
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0; // 0 = 不主动超时（长请求如大模型文件不被中途砍断）
server.listen(PORT, '0.0.0.0', () => {
  log.info(`内置服务 on http://0.0.0.0:${PORT}`);
  log.info(`静态根 ${WEB_ROOT}`);
  log.info(`数据根 ${data.paths.dataRoot}${DATA_ROOT ? '（MODELSTAGE_DATA_ROOT 覆盖）' : '（默认=项目根）'}`);
  log.info('资源根已登记', { roots: data.config.readConfig().map((r) => `${r.id}=${r.name}`) });
});
