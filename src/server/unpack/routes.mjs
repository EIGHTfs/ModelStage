// unpack/routes.mjs —— 解包缓存的三条路由（17b 第三步）
//
//   POST /api/unpack/resolve  {rootId, rel}   → 命中直接返回清单；未命中解包落盘后返回
//   GET  /api/unpack/file?fp=&path=           → 取单个产物文件（白名单校验 + 强缓存）
//   GET  /api/unpack/stats                    → 计数器 / peakRss / 目录占用（验收与回归用）
//
// 三条纪律：
//   1. **安全**：`path` 必须命中该 fp 的 index.json 清单（白名单），再做一次"解析后仍在目录内"校验 ——
//      不做"拼完就信"的路径拼接（`../` 之类必须被挡在渲染层之外）。
//   2. **强缓存**：文件 URL 里含指纹（内容不可变）⇒ 可以给 `immutable`；这是唯一能安全用长缓存的地方。
//   3. **失败可注入**：`UNPACK_FORCE_FAIL=1` 时 resolve 直接 500，用来验收"前端回落自己解包"。
import fs from 'node:fs';
import path from 'node:path';
import { sendFile } from '../http/static.mjs';
import { capacity } from './capacity.mjs';

/** 强制失败开关（验收"回退可用"用；默认关） */
function forcedFail() {
  return process.env.UNPACK_FORCE_FAIL === '1';
}

/** 产物文件 URL（前端拿到后逐条 fetch） */
function fileUrl(fp, relPath) {
  return `/api/unpack/file?fp=${encodeURIComponent(fp)}&path=${encodeURIComponent(relPath)}`;
}

/**
 * 创建路由处理器。
 * @param {{store: object, readConfig: Function, resolveSafe: Function, sendJson: Function, readBody: Function}} deps
 * @returns {(req, res, p: string, url: URL) => boolean} 返回 true 表示已处理
 */
export function createUnpackRoutes(deps) {
  const { store, readConfig, resolveSafe, sendJson, readBody } = deps;

  /** 资源根 id + 相对路径 → 磁盘绝对路径（越界/不存在一律 null） */
  function resolveRequest(rootId, rel) {
    const cfg = readConfig().find((r) => r.id === rootId);
    if (!cfg) return { error: `未找到资源根: ${rootId}` };
    const abs = resolveSafe(cfg.path, rel);
    if (!abs) return { error: '路径越界' };
    try {
      if (!fs.statSync(abs).isFile()) return { error: '不是文件' };
    } catch {
      return { error: '文件不存在' };
    }
    return { abs };
  }

  /** POST /api/unpack/resolve */
  function handleResolve(req, res) {
    return readBody(req, res, async (raw) => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return sendJson(res, 400, { ok: false, reason: 'bad-json', message: '请求体不是合法 JSON' });
      }
      if (forcedFail()) {
        return sendJson(res, 500, { ok: false, reason: 'forced-fail', message: 'UNPACK_FORCE_FAIL=1（验收注入）' });
      }
      const rootId = String(body.rootId || '');
      const rel = String(body.rel || '');
      if (!rootId || !rel) return sendJson(res, 400, { ok: false, reason: 'bad-args', message: '需要 rootId 与 rel' });
      const r = resolveRequest(rootId, rel);
      if (r.error) return sendJson(res, 404, { ok: false, reason: 'not-found', message: r.error });
      // hitOnly：**只查缓存，绝不在这里解包**（形态 C 的前台路径）。miss 时返回 hit:false，
      //   前端据此走本地解包；真正的解包由「空闲预热」另一次请求触发。
      if (body.hitOnly === true) {
        const p = store.peek({ rootId, rel, absPath: r.abs });
        if (!p.ok) return sendJson(res, 404, { ok: false, reason: p.reason || 'peek-failed' });
        return sendJson(res, 200, {
          ok: true,
          hit: p.hit,
          fingerprint: p.fingerprint,
          missReason: p.hit ? null : (p.reason || 'no-index'),
          prefix: p.prefix || null,
          entry: p.entry || null,
          unpackMs: 0,
          files: (p.files || []).map((f) => ({ path: f.path, size: f.size, url: fileUrl(p.fingerprint, f.path) })),
        });
      }
      try {
        // allowOverLimit：面板「内存保护」开关关闭时前端会带这个标记（默认不带 ⇒ 行为与从前完全一致）
        const out = await store.resolve({ rootId, rel, absPath: r.abs, allowOverLimit: body.allowOverLimit === true });
        if (!out.ok) {
          // 把判据数字一起回给调用方（insufficient-memory 时要能看到 预算/预估峰值/当前可用）
          return sendJson(res, 500, {
            ok: false,
            reason: out.reason || 'unpack-failed',
            message: out.message || '解包失败',
            ...(out.budgetMb !== undefined ? { budgetMb: out.budgetMb, peakEstMb: out.peakEstMb, availMb: out.availMb } : {}),
          });
        }
        return sendJson(res, 200, {
          ok: true,
          hit: out.hit,
          fingerprint: out.fingerprint,
          prefix: out.prefix,
          entry: out.entry,
          unpackMs: out.unpackMs,
          // 判据来源（验收与排障用）：measured / plugin-peak / model-decompressed / legacy-source
          ...(out.memBasis ? { memBasis: out.memBasis, peakEstMb: out.peakEstMb } : {}),
          files: out.files.map((f) => ({ path: f.path, size: f.size, url: fileUrl(out.fingerprint, f.path) })),
        });
      } catch (e) {
        return sendJson(res, 500, { ok: false, reason: 'exception', message: String((e && e.message) || e) });
      }
    });
  }

  /** GET /api/unpack/file?fp=&path= */
  function handleFile(req, res, url) {
    const fp = String(url.searchParams.get('fp') || '');
    const relPath = String(url.searchParams.get('path') || '');
    if (!/^[0-9a-f]{8,40}$/.test(fp) || !relPath) {
      sendJson(res, 400, { ok: false, error: '需要 fp 与 path' });
      return;
    }
    const index = store.readIndex(fp);
    if (!index) {
      sendJson(res, 404, { ok: false, error: '缓存目录不存在或索引损坏' });
      return;
    }
    // 白名单：只发清单里声明过的文件（这条挡掉 ../ 与任意读盘）
    const item = index.files.find((f) => f.path === relPath);
    if (!item) {
      sendJson(res, 404, { ok: false, error: '不在该包的产物清单里' });
      return;
    }
    const abs = store.filePathOf(fp, relPath);
    // 纵深防御：解析后必须仍在 files/ 目录内
    const filesDir = path.dirname(path.dirname(abs));
    if (!path.resolve(abs).startsWith(path.resolve(filesDir) + path.sep) && path.resolve(abs) !== path.resolve(filesDir)) {
      sendJson(res, 403, { ok: false, error: '路径越界' });
      return;
    }
    // 内容不可变（URL 里带指纹）⇒ 可以长缓存 + immutable
    sendFile(req, res, abs, {
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: `"${fp}-${item.size}"`,
      'Access-Control-Allow-Origin': '*', // 纹理走 <img>/WebGL 时需要
    });
  }

  return function handle(req, res, p, url) {
    if (p === '/api/unpack/resolve' && req.method === 'POST') {
      handleResolve(req, res);
      return true;
    }
    if (p === '/api/unpack/file' && req.method === 'GET') {
      handleFile(req, res, url);
      return true;
    }
    if (p === '/api/unpack/capacity' && req.method === 'GET') {
      // 前端读不到 os.totalmem / MemAvailable，容量必须服务端算好下发。
      //   带上 rootId+rel 时服务端自己 stat 源包大小，前端不用传 size（少一处不一致的可能）。
      const rootId = String(url.searchParams.get('rootId') || '');
      const rel = String(url.searchParams.get('rel') || '');
      let sourceMb = 0;
      if (rootId && rel) {
        // 优先用 rootId+rel：服务端自己 stat，前端不用传 size（少一处"两边算得不一样"的可能）
        const r = resolveRequest(rootId, rel);
        if (r.error) {
          sendJson(res, 200, { ...capacity(), sourceMb: null, allowWarmup: true, reason: 'source-unresolved' });
          return true;
        }
        sourceMb = fs.statSync(r.abs).size / 1024 / 1024;
      } else {
        // 只有字节数时（前端只知道包多大、不想暴露路径）：用 sourceMb 直接问
        //   —— 这样"包字节 → 预估峰值"的翻译始终只有服务端这一份权威实现
        const q = Number(url.searchParams.get('sourceMb') || 0);
        if (Number.isFinite(q) && q > 0) sourceMb = q;
      }
      sendJson(res, 200, capacity(sourceMb || undefined));
      return true;
    }
    if (p === '/api/unpack/stats' && req.method === 'GET') {
      sendJson(res, 200, store.stats());
      return true;
    }
    return false;
  };
}
