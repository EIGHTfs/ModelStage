// http/diag-upload.mjs —— 「上传调试日志」的落盘与两条接口
//
// 为什么要有：页面里的调试日志只在内存（刷新即丢），出问题时用户描述不清、AI 又读不到浏览器。
//   这里提供一个"用户点一下、日志落到服务端"的出口，之后 AI 靠 GET /api/diag/uploads 就能
//   自己查到"文件在哪、多大、几条"，不必再问用户。
//
// 两条接口（路由在 serve.mjs 里挂，这里只做数据与校验）：
//   POST /api/diag/upload   收 { logs, meta } → 落盘 data/logs/diag-<yyyyMMdd-HHmmss>.json
//   GET  /api/diag/uploads  按时间倒序列出已上传文件 [{ file, at, bytes, count, truncated }]
//
// 四条硬约束：
//   1. **文件名一律服务端生成**：客户端即使传了 file/path 也直接忽略（防路径穿越）；
//      落盘路径只用 path.join(LOGS_DIR, basename)，并校验最终路径确实在 LOGS_DIR 之内
//   2. **边读边计数**：请求体超过上限立刻中断并返回 413，不允许"先全读进内存再判"
//   3. **条数/体积上限走配置**（config/diag-upload.json），不写死；超条数时截断并在文件里标 truncated
//   4. **索引 index.json 走 tmp+rename 原子写 + 串行队列**，并发上传不会互相覆盖

import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc } from '../../../tool/parse-jsonc.mjs';

/** 默认上限（配置文件缺失时用它）：条数与请求体积分开限，前者防日志爆炸、后者防内存 */
const DEFAULTS = {
  maxCount: 5000,              // 单次上传最多保留多少条（超出即截断，文件里标 truncated）
  maxBytes: 5 * 1024 * 1024,   // 单次请求体上限 5MB（约 5000 条中等日志的 3~5 倍余量）
};

/** 索引文件名（放 data/logs/ 里，与日志文件同目录，便于一起带走） */
const INDEX_FILE = 'index.json';

/** 时间戳：文件名里的 yyyyMMdd-HHmmss（本地时区，给人看的） */
function stampFile(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 读上传上限配置（JSONC，与 config/resources.json 同一套解析）。
 * 文件不存在/损坏就用 DEFAULTS —— 配置只是"允许调"，不是"必须存在"。
 * @param {string} configFile
 * @returns {{maxCount: number, maxBytes: number}}
 */
function readLimits(configFile) {
  try {
    const raw = fs.readFileSync(configFile, 'utf8');
    const cfg = parseJsonc(raw, 'config/diag-upload.json');
    const maxCount = Number(cfg.maxCount);
    const maxBytes = Number(cfg.maxBytes);
    return {
      maxCount: Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : DEFAULTS.maxCount,
      maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULTS.maxBytes,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 吐 JSON（与 serve.mjs 的 sendJson 同口径；这里自带一份避免跨模块耦合） */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/**
 * 限制体积地读完整请求体。
 * 超限时**立刻**回 413 并停止累计（不清空缓冲区也会被 GC 回收，不会 OOM）。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {number} maxBytes
 * @returns {Promise<Buffer|null>} 超限/出错返回 null（调用方已收到响应）
 */
function readBodyLimited(req, res, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        sendJson(res, 413, { ok: false, error: `请求体超过上限（${maxBytes} 字节）`, maxBytes });
        // 多余数据丢弃：继续 drain 会白占内存，destroy 前给响应一点时间发出去
        setTimeout(() => { try { req.destroy(); } catch { /* 已断开 */ } }, 300);
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => {
      sendJson(res, 400, { ok: false, error: '读取请求体失败' });
      finish(null);
    });
  });
}

/**
 * 同步判定这两条路由是否命中。
 *
 * 为什么必须有同步的 matches：真正的处理要异步读请求体（handle 是 async），而 serve.mjs 里
 *   写的是 `if (xxx.handle(...)) return;` —— 直接判 async 函数会**恒真**（返回 Promise），
 *   把后面所有路由都截断掉（实测：挂上后整站 404）。所以拆成"同步匹配 + 异步执行"两步。
 * @param {string} method
 * @param {string} p 路径
 * @returns {boolean} 是否命中
 */
export function matches(method, p) {
  if (p === '/api/diag/upload') return method === 'POST';
  if (p === '/api/diag/uploads') return method === 'GET';
  return false;
}

/**
 * 建"落盘仓库"：只管文件的读写与索引，不关心 HTTP。
 * @param {{logsDir: string}} opts
 * @returns {{logsDir: string, save: Function, list: Function, makeFileName: Function}}
 */
function createStore({ logsDir }) {
  const indexPath = path.join(logsDir, INDEX_FILE);
  // 串行队列：索引是"读-改-写"，并发写会丢条目（背景图那边同样的坑）
  let queue = Promise.resolve();
  fs.mkdirSync(logsDir, { recursive: true });

  /** 读索引（缺失/损坏都当空表） */
  function readIndex() {
    try {
      const arr = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  /** 原子写索引（tmp + rename），并串行化，避免并发上传互相覆盖 */
  function appendIndex(entry) {
    queue = queue.then(() => {
      const list = readIndex();
      list.push(entry);
      const tmp = `${indexPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
      fs.renameSync(tmp, indexPath);
    }, () => { /* 上一次失败不影响这一次 */ });
    return queue;
  }

  /**
   * 生成不冲突的文件名（同一秒内多次上传时追加序号）。
   * 名字**完全由服务端决定**，客户端给什么都不参与。
   * @returns {string} 形如 diag-20261024-143000.json
   */
  function makeFileName() {
    const base = `diag-${stampFile()}`;
    let candidate = `${base}.json`;
    let n = 1;
    while (fs.existsSync(path.join(logsDir, candidate))) {
      n += 1;
      candidate = `${base}-${n}.json`;
    }
    return candidate;
  }

  /**
   * 落盘一次上传（条数超限只保留最新的 N 条并标记截断）。
   * @param {object} payload 客户端请求体 { logs, meta }
   * @param {{maxCount:number,maxBytes:number}} limits
   * @returns {{ok:true, file:string, path:string, count:number, bytes:number, truncated:boolean}}
   */
  function save(payload, limits) {
    const all = Array.isArray(payload && payload.logs) ? payload.logs : null;
    if (!all) {
      const err = new Error('logs 必须是数组');
      err.status = 400;
      throw err;
    }
    // 条数上限：只保留**最新的** N 条（日志尾部才有现场价值），并显式标记截断
    const truncated = all.length > limits.maxCount;
    const logs = truncated ? all.slice(-limits.maxCount) : all;
    const file = makeFileName();
    // 二次防线：即便文件名生成逻辑被改坏，也不允许落到 logsDir 之外
    const fullPath = path.join(logsDir, path.basename(file));
    if (path.dirname(fullPath) !== logsDir) throw new Error('落盘路径越界');

    const doc = {
      meta: (payload && payload.meta && typeof payload.meta === 'object') ? payload.meta : {},
      count: logs.length,
      truncated,
      received: all.length,
      uploadedAt: new Date().toISOString(),
      logs,
    };
    const text = JSON.stringify(doc, null, 1);
    const tmp = `${fullPath}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, fullPath);          // 原子可见：不会读到写了一半的文件

    const bytes = Buffer.byteLength(text);
    appendIndex({ file, at: Date.now(), bytes, count: logs.length, truncated });
    return { ok: true, file, path: fullPath, count: logs.length, bytes, truncated };
  }

  /** 列表：按时间倒序（最新的在前），带绝对路径供工具直接读 */
  function list() {
    return readIndex()
      .filter((e) => e && typeof e.file === 'string')
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .map((e) => ({
        file: e.file,
        at: e.at,
        bytes: e.bytes,
        count: e.count,
        truncated: e.truncated === true,
        path: path.join(logsDir, path.basename(e.file)),
      }));
  }

  return { logsDir, save, list, makeFileName };
}

/**
 * 创建"上传调试日志"模块（路由在 serve.mjs 里挂）。
 * @param {{dataDir: string, configDir?: string}} paths 服务端数据目录与配置目录
 * @returns {{matches: Function, handle: Function, listUploads: Function, logsDir: string, configFile: string}}
 */
export function createDiagUpload(paths) {
  const logsDir = path.join(paths.dataDir, 'logs');
  const configFile = path.join(paths.configDir || path.join(path.dirname(paths.dataDir), 'config'), 'diag-upload.json');
  const store = createStore({ logsDir });

  /**
   * 异步执行（只在 matches 命中后调用；调用方不要 await，让它自己写完响应）。
   * @returns {Promise<void>}
   */
  async function handle(req, res, p) {
    if (p === '/api/diag/uploads') {
      sendJson(res, 200, { ok: true, uploads: store.list() });
      return;
    }
    const limits = readLimits(configFile);
    const raw = await readBodyLimited(req, res, limits.maxBytes);
    if (raw === null) return;                        // 已回 413/400
    let payload = null;
    try {
      payload = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      return;
    }
    try {
      sendJson(res, 200, store.save(payload, limits));
    } catch (e) {
      sendJson(res, e.status || 500, { ok: false, error: e.message || '上传失败' });
    }
  }

  return { matches, handle, listUploads: store.list, logsDir, configFile };
}

export { DEFAULTS as DIAG_UPLOAD_DEFAULTS, stampFile };
