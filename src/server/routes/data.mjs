// routes/data.mjs —— 只读数据 API 与资源文件路由
//
// 覆盖：
//   /api/roots /api/plugins /api/brand /api/web-config   资源根/插件/品牌/前端配置
//   /api/tree /api/spine/models /api/live2d/models /api/names  目录/模型清单/名表
//   /api/browse                                          服务端目录浏览（登记资源根用）
//   /api/catalog /api/bundle/probe /api/model-meta       按需 import 的三条
//   /api/file /files/<rootId>/<rel> /icons/... /live2d-lib/...  二进制资源（含越界防护）
//   POST /api/roots                                      资源根增删改名启停（写路径）
//
// 为什么归一组：它们共享同一份 data.*（config/models/names/live2d/catalog…）实例，
//   读写口径必须一致——资源根视图走 http/write.mjs 的 toRootView，避免读写两处漂移。

// 缺 Live2D 运行时时的引导文案：503（解析器不可用）与 404（单个文件不存在）**共用同一份**，
//   否则两处各说各话（一个说去官网下、另一个只说文件名），用户被堵在门口。
import { live2dGuide } from '../../../tool/lib/runtime-guides.mjs';
import { readRatioEnv } from '../core/env-num.mjs';
// 插槽目录（S1-a）：与校验同源，见 plugins/slot-catalog.mjs
import { SLOT_CATALOG, CURRENT_STAGE } from '../plugins/slot-catalog.mjs';

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
      // 插槽目录全表（S1-a）：前端要在**装之前**知道"有哪些插槽、各自什么风险、开到哪一阶段"，
      //   否则只能等注册失败才知道。与校验同源（都来自 plugins/slot-catalog.mjs），不会漂移。
      // 服务端**当前已开放到哪个阶段**（值与 slotCatalog 同源，都来自 plugins/slot-catalog.mjs）。
      //   为什么单独下发：前端原来自己有一份 CURRENT_SLOT_STAGE 常量 —— 同一事实两处表达，
      //   抬阶段时只改一处就会出现"服务端放行、前端还拒"（或反之）的漂移。
      //   注意它与 slotCatalog[i].stage 是**两个概念**：后者是"该插槽从哪个阶段起开放"（固定），
      //   这里是"现在一共开放到哪"（会随阶段推进变）。别把两者合并。
      currentStage: CURRENT_STAGE,
      slotCatalog: SLOT_CATALOG,
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
      // 准入堆比例：前端读不到 env，所以由服务端下发（env 覆盖见 core/env-num.mjs）。
      //   非法值在服务端就回落缺省并 warn，不透传脏值给浏览器。
      admitHeapRatio: readRatioEnv('MODELSTAGE_ADMIT_HEAP_RATIO', 0.85),
      // 容量系数一并下发，只为"面板/排障能看到当前实际生效值"，不参与前端判定
      admitCapacityRatio: readRatioEnv('MODELSTAGE_ADMIT_CAPACITY_RATIO', 0.5),
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
  // /api/spine/models 与 /api/live2d/models 是**单路原始扫描**（各自只管一种渲染器，
  //   返回形状也各不相同）。要"某个根下的全部模型"一律走 /api/catalog（它内部复用这两个，
  //   输出统一 ModelEntry）。历史教训：曾叫 /api/models，名字像"所有模型"但实际只返回 Spine，
  //   导致在纯 Live2D 的资源根上翻页/加载拿到 0 个模型而误判为"根目录为空"。
  if (p === '/api/spine/models' || p === '/api/live2d/models') {
    const rootId = url.searchParams.get('root') || '';
    const force = url.searchParams.get('refresh') === '1';
    const cfg = data.config.readConfig().find((r) => r.id === rootId);
    if (!cfg) return sendJson(res, 400, { error: `未找到资源根: ${rootId}` });
    try {
      const isSpine = p === '/api/spine/models';
      const r = isSpine ? data.spine.getSpineModels(cfg, force) : data.live2d.getLive2DModels(cfg, force);
      return sendJson(res, 200, {
        root: { id: cfg.id, name: cfg.name },
        count: r.models.length,
        cached: r.cached,
        scannedAt: new Date(r.ts).toISOString(),
        models: r.models,
      });
    } catch (e) {
      return sendJson(res, 500, { error: `${p === '/api/spine/models' ? 'Spine 扫描失败' : 'Live2D 扫描失败'}: ${e.message}` });
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
 * 名表（v2 index 优先、v1 兜底）：返回**归一化**后的表。
 *
 * 为什么不再每次现读 JSON：名表是纯数据文件（见 docs/设计/名表.md），读取只做「读 + 缓存 + 原样返回」
 *   只在 names.mjs 里存在一份；这里再读一遍就等于复制第二份解析规则。
 *   缓存失效由 names.clearNameCache()（导入配置时）负责，对外行为仍是"导入后立刻生效"。
 *
 * 三种情况必须可区分（不能静默返回空表 —— 那会让整片名字消失且界面无任何提示）：
 *   ① 该根没配 names        → 200 + names:null + reason（不是错误，是配置选择）
 *   ② 配了但两个文件都没有   → 404 + 明确说明"index 与 v1 都不存在"
 *   ③ 文件坏了             → 500 + 解析失败原因
 */
function apiNames(ctx, res, url) {
  const { data, sendJson } = ctx;
  const rootId = url.searchParams.get('root') || '';
  const cfg = data.config.readConfig().find((r) => r.id === rootId);
  if (!cfg) return sendJson(res, 400, { error: `未找到资源根: ${rootId}` });
  if (!cfg.names) return sendJson(res, 200, { root: rootId, names: null, reason: '该资源根未配置 names 名表' });

  const { table, error, detail } = data.names.loadNamesTable(cfg.names);
  if (!table) {
    const status = error === 'BROKEN' ? 500 : 404;
    return sendJson(res, status, { root: rootId, tableId: cfg.names, error: detail, code: error });
  }
  // 原样透传（规范 §二 的唯一出口形状）：多挑一个字段就是"服务端理解结构"，
  //   名表一改形状就得改这里 —— 结构解释全在 src/shared/names.mjs 与前端。
  return sendJson(res, 200, { root: rootId, tableId: cfg.names, ...table });
}

/** 需要按需 import 的三条（catalog / bundle probe / model meta） */
function apiAsync(ctx, req, res, p, url) {
  const { data, sendJson } = ctx;
  const done = (r) => sendJson(res, r.status, r.body);
  const fail = (label) => (e) => sendJson(res, 500, { ok: false, error: `${label}: ${e.message}` });
  // 最近一次各根 catalog 构建的服务端耗时（只读内存，零副作用：不会触发任何重建）。
  //   必须放在 /api/catalog 分支之前：两条件互斥（等值比较），但顺序写清更不会被后来人改错。
  if (p === '/api/catalog/stats') {
    const s = data.catalog.getCatalogStats();
    return sendJson(res, 200, { ok: true, at: s.at, totalMs: s.totalMs, roots: s.roots });
  }
  if (p === '/api/catalog') {
    // 入参分流（只在路由层做，不动 listCatalog 内部报错）：
    //   · 缺 root / 空串 ⇒ 400（调用方错误）。以前一律回 404，于是"路径拼错了"
    //     和"根真的不存在"看起来一模一样，排查时白费一轮。
    //   · 给了非空但找不到的 id ⇒ 仍交 listCatalog 回 404（那才是"资源不存在"）。
    const rootId = (url.searchParams.get('root') || '').trim();
    if (!rootId) {
      const known = data.config.readConfig().map((r) => r.id);
      return sendJson(res, 400, { ok: false, error: '缺少 root 参数（?root=<资源根 id>）', known });
    }
    return done(data.catalog.listCatalog(rootId));
  }
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

/**
 * /avatars/<game>/<文件名>：头像仓（v2 主路）。
 *
 * 与 /icons/ 的区别：`/icons/` 读的是"每个资源根自己配的 icons.dir"（v1 遗留，一个根一套）；
 *   `/avatars/` 读的是**全局可配置的头像根**（`<avatarRoot>/<game>/<file>`），
 *   因为头像仓是独立私有仓、与资源根无关（见 docs/设计/名表.md §4.1）。
 *
 * `<game>` 直接落在文件系统路径里 ⇒ 必须防越界：只接受一层合法目录名 + 一层合法文件名，
 *   两级都做 path.resolve 后的前缀校验（防 `../` 与绝对路径注入）。
 */
function serveAvatar(ctx, req, res, p) {
  const { data, fs, path, sendFile } = ctx;
  if (!p.startsWith('/avatars/')) return false;
  const rest = decodeURIComponent(p.slice('/avatars/'.length));
  const parts = rest.split('/').filter(Boolean);
  if (parts.length !== 2) { res.writeHead(404); res.end('bad avatar path'); return true; }
  const game = path.basename(parts[0]);
  const name = path.basename(parts[1]);
  if (game !== parts[0] || name !== parts[1]) { res.writeHead(403); res.end('forbidden'); return true; }
  const root = path.resolve(data.paths.avatarRoot);
  const abs = path.resolve(root, game, name);
  if (!abs.startsWith(root + path.sep)) { res.writeHead(403); res.end('forbidden'); return true; }
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
    // 404（某个文件缺失）与 503（整套库不可用）用户撞到的概率相当 ⇒ 都给完整引导。
    //   文案复用 live2dGuide（与 503 同源），只补"该往哪放、从哪下、为什么不代下"。
    sendJson(res, 404, { error: `未找到运行时文件: ${name}\n` + live2dGuide(data.paths.dataRoot) });
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
  if (serveAvatar(ctx, req, res, p)) return true;
  if (serveLive2DLib(ctx, req, res, p)) return true;
  return false;
}
