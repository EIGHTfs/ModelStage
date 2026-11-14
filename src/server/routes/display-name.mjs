// server/routes/display-name.mjs —— 取列表显示名（POST /api/entries/display-name）
//
// 为什么单独一条路由而不是塞进 /api/analyze：
//   /api/analyze 的语义是"只读分析、不写任何东西"；而这里**要写展示态缓存**。
//   混在一起会让"只读接口"变成有副作用的接口，调用方再也不能假设它只读。
//
// 名字从哪来：插件 analyze() 的 displayName（契约 §1.3）。核心不推导、不认识格式，
//   插件没给就返回 null，调用方回落文件名。
//
// 什么时候调：条目被选中/装载时，前端按需发一次（不批量、不后台预扫）。

import { analyzeFile } from '../analyze/index.mjs';
import { findAnalyzerProvider, libDirFor, libOrderFor } from '../../../tool/lib/bundle-probe-node.mjs';
import fs from 'node:fs';
import {
  readDisplayNameCache,
  writeDisplayNameCache,
  setDisplayNameEntry,
  lookupDisplayName,
  hasDisplayNameRecord,
} from '../data/display-name-cache.mjs';

/**
 * 分析器指纹：当前提供者 `lib/bundle-probe.js` 的 size+mtime。
 *
 * 为什么需要：缓存里会写"这个包取不到名字"（null）。插件后来支持了 displayName 后，
 *   那条旧记录仍会命中 ⇒ 列表永远显示文件名，且没有任何迹象说明原因。
 * 判据取**实现文件**而不是 plugin.json 的 version：版本号未必随 lib 变化更新，
 *   而 size/mtime 一定跟着实现走。
 * @returns {string|null} 没有提供者时 null（此时不参与失效判定）
 */
function analyzerFingerprint() {
  try {
    const provider = findAnalyzerProvider();
    if (!provider) return null;
    const dir = libDirFor(provider);
    const parts = [];
    for (const rel of libOrderFor(provider)) {
      if (!/bundle-probe/i.test(rel)) continue;
      const st = fs.statSync(`${dir}/${rel}`);
      parts.push(`${rel}:${st.size}:${Math.round(st.mtimeMs)}`);
    }
    return parts.length ? `${provider.pluginId}|${parts.join(',')}` : provider.pluginId;
  } catch {
    return null;   // 算不出指纹就不参与失效判定（宁可用旧结论，也不因此报错）
  }
}

/**
 * POST /api/entries/display-name  body: { rootId, rel }
 *
 * 返回 { ok, displayName, cached, reason? }
 *   · 命中缓存：cached=true，不跑分析
 *   · 分析拿到名字：写缓存后返回
 *   · 插件没给名字 / 分析失败：displayName=null（调用方回落文件名），不报错
 *
 * @param {object} req
 * @param {object} res
 * @param {string} p
 * @param {object} ctx 含 data / resolveSafe / readBody / sendJson / log
 * @returns {Promise<boolean>}
 */
export async function handleDisplayName(req, res, p, ctx) {
  const { sendJson, readBody } = ctx;
  if (p !== '/api/entries/display-name') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '只支持 POST' });
    return true;
  }

  // readBody 是**回调式**的（返回 undefined），所以这里必须显式 return true 表示"已认领"，
  //   否则 dispatch 会继续往下走到 /api/ 兜底，表现成"未知接口"。
  readBody(req, res, async (raw) => {
    // readBody 只 catch 同步抛错；本回调是 async，reject 会逃逸成 unhandledRejection ⇒ 自己兜住
    try {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      return;
    }
    const rootId = String(body.rootId || '');
    const rel = String(body.rel || '');
    if (!rootId || !rel) {
      sendJson(res, 400, { ok: false, error: '需要 rootId 与 rel' });
      return;
    }

    const configFile = ctx.data && ctx.data.paths ? ctx.data.paths.configFile : null;
    const cfg = (ctx.data && ctx.data.config ? ctx.data.config.readConfig() : []).find((r) => r.id === rootId);
    if (!cfg) {
      sendJson(res, 404, { ok: false, error: `未找到资源根: ${rootId}` });
      return;
    }
    const absPath = ctx.resolveSafe(cfg.path, rel);
    if (!absPath) {
      sendJson(res, 403, { ok: false, error: '路径越界' });
      return;
    }

    // ① 先查缓存：**有记录就不跑分析**（含"记录为 null"的情况 —— 那表示上次确认过这个包取不到名字）
    const table = readDisplayNameCache(configFile);
    let size = null;
    try {
      size = Number(ctx.fs.statSync(absPath).size);
    } catch {
      sendJson(res, 404, { ok: false, error: `文件不存在：${rel}` });
      return;
    }
    if (hasDisplayNameRecord(table, rootId, rel, { size }, analyzerFingerprint())) {
      const cachedName = lookupDisplayName(table, rootId, rel, { size });
      sendJson(res, 200, { ok: true, displayName: cachedName, cached: true });
      return;
    }

    // ② 跑分析取名字（复用 /api/analyze 的实现，不新写解析）
    const { status, body: analyzed } = await analyzeFile(absPath);
    if (status !== 200 || !analyzed || !analyzed.ok) {
      // 分析失败不是错误：名字拿不到就回落文件名，但把原因带回去便于排查
      sendJson(res, 200, {
        ok: true,
        displayName: null,
        cached: false,
        reason: (analyzed && (analyzed.code || analyzed.error)) || `analyze-status-${status}`,
      });
      return;
    }

    const displayName = typeof analyzed.displayName === 'string' && analyzed.displayName.trim()
      ? analyzed.displayName.trim()
      : null;

    // ③ 无论有没有拿到都写一条（写 null 也是有效结论：下次不再为它重跑一遍分析）
    setDisplayNameEntry(table, rootId, rel, { displayName, mtimeMs: 0, size, analyzerFingerprint: analyzerFingerprint() });
    try {
      writeDisplayNameCache(configFile, table);
    } catch (e) {
      // 缓存写失败不影响本次返回（名字已经拿到了），但要留下可查的痕迹
      if (ctx.log && ctx.log.warn) ctx.log.warn('显示名缓存写入失败', { rootId, rel, err: e.message });
    }

    sendJson(res, 200, {
      ok: true,
      displayName,
      cached: false,
      warnings: Array.isArray(analyzed.warnings) ? analyzed.warnings.slice(0, 3) : [],
    });
    } catch (e) {
      // 这里已经是响应的最后一道：分析/缓存任何一步炸了都要给可读结果，而不是让连接悬着
      try {
        sendJson(res, 200, { ok: true, displayName: null, cached: false, reason: String((e && e.message) || e) });
      } catch { /* 响应已发出，忽略 */ }
    }
  });
  return true;   // 已认领（响应由上面的回调发出）
}
