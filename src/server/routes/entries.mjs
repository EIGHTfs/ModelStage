// routes/entries.mjs —— 条目状态的两条接口（契约《条目状态与展示归属》§三）
//
//   POST /api/entries/result        写读一体：上报"最近一次装载尝试"，响应直接带回重算后的三字段
//   GET  /api/entries/result?key=…  单条查询（零扫描、零重建）
//
// 为什么把"写"和"读"做成同一次响应（这是契约 S1/S2 的根治点）：
//   前端装载完成那一刻既要"记下结果"，又要"立刻把这一行画对"。
//   若拆成两次请求，中间必然存在"前端已改行、服务端还没存"的窗口，
//   表现为"当场变了色、刷新又变回去"（或反过来）——两张皮就是这么来的。
//   这里写入与读取用的是**同一个 recompute()**，响应就是存储层算出来的那份数据。
//
// 旁路原则（INV-D3）：本接口出任何错都不得影响装载。前端调用处必须吞掉失败只记日志。

/** 从请求体里挑出 put() 需要的字段（其余一律忽略，不把未知字段写进存储） */
function pickIncoming(body) {
  const b = body && typeof body === 'object' ? body : {};
  const result = b.result === 'ok' ? 'ok' : (b.result === 'failed' ? 'failed' : null);
  if (!result) return null;
  return {
    result,
    reason: b.reason === undefined || b.reason === null ? null : String(b.reason),
    message: b.message === undefined || b.message === null ? null : String(b.message),
    provider: b.provider === undefined || b.provider === null ? null : String(b.provider),
    at: Number.isFinite(b.at) ? Number(b.at) : undefined,
    // source：谁在写。前端上报是 client；服务端解包/探测写是 server。
    //   只影响定序（同一条目两方都写时以更晚的为准），不影响语义。
    source: b.source === 'server' ? 'server' : 'client',
  };
}

/**
 * 处理 /api/entries/result（两种方法共用同一份数据装配）。
 * @param {object} ctx serve.mjs 注入：{ entryStates, providers, candidatesFor, config, sendJson, readBody }
 */
export function handleEntries(req, res, p, url, ctx) {
  if (p !== '/api/entries/result') return false;
  const { entryStates, sendJson, readBody } = ctx;
  if (!entryStates) {
    // 存储没装配（理论上不会）：如实 500，不假装成功——前端会按"上报失败只记日志"处理
    sendJson(res, 500, { ok: false, error: '条目状态存储未就绪' });
    return true;
  }

  if (req.method === 'GET') {
    const key = (url.searchParams.get('key') || '').trim();
    if (!key) {
      sendJson(res, 400, { ok: false, error: '缺少 key 参数（?key=<rootId>/<rel> 或条目 id）' });
      return true;
    }
    // 查询也要走 recompute：否则"存储里有、算出来没有"的字段会让诊断和列表对不上
    const computed = entryStates.recompute(entryStates.get(key), ctx.contextFor(key));
    sendJson(res, 200, { ok: true, key, entry: computed });
    return true;
  }

  if (req.method === 'POST') {
    // readBody 回调给的是**原始字符串**（各路由自己 parse，与 backgrounds/ready 同口径）
    readBody(req, res, (raw) => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        return;
      }
      try {
        const key = String((body && body.key) || '').trim();
        if (!key) {
          sendJson(res, 400, { ok: false, error: '缺少 key（形如 <rootId>/<rel>）' });
          return;
        }
        const incoming = pickIncoming(body);
        if (!incoming) {
          sendJson(res, 400, { ok: false, error: 'result 必须是 ok 或 failed' });
          return;
        }
        // 写读一体：put() 内部先落内存表再 recompute，返回的就是"现在存储的真相"
        const r = entryStates.put(key, incoming, ctx.contextFor(key, body));
        sendJson(res, 200, { ok: true, key, applied: r.applied === true, entry: r.computed });
      } catch (e) {
        // 旁路原则：存储写失败只记日志，绝不升级成"装载失败"
        try { ctx.log && ctx.log.warn && ctx.log.warn('条目状态写入失败', { err: (e && e.message) || String(e) }); } catch { /* 日志本身失败也不能影响响应 */ }
        sendJson(res, 500, { ok: false, error: `条目状态写入失败：${(e && e.message) || e}` });
      }
    });
    return true;
  }

  sendJson(res, 405, { ok: false, error: `不支持的方法：${req.method}` });
  return true;
}

/**
 * 造 contextFor：把"这条目的静态事实"（候选提供者、缺贴图、尺寸）从 catalog 侧喂给 recompute。
 *
 * 为什么放在路由层而不是 entry-states 里：存储层不该知道 catalog 的形状（谁认领这个条目、
 *   目录型缺哪些贴图，都是扫描阶段的事）；它只负责"把状态和上下文合成三字段"。
 * @param {{providers: Function, describe: Function}} deps
 */
export function createContextFor(deps) {
  return function contextFor(key, body) {
    const providers = (deps.providers && deps.providers()) || [];
    const desc = (deps.describe && deps.describe(key)) || {};
    // size 优先取请求体（前端最清楚自己装的是哪个文件），其次取扫描结果
    const size = Number.isFinite(body && body.size) ? Number(body.size) : (Number.isFinite(desc.size) ? desc.size : undefined);
    return {
      providers,
      candidates: Array.isArray(desc.candidates) ? desc.candidates : [],
      missingTextures: Array.isArray(desc.missingTextures) ? desc.missingTextures : undefined,
      assetDependency: desc.assetDependency || null,
      size,
      assetFingerprint: desc.assetFingerprint === undefined ? null : desc.assetFingerprint,
    };
  };
}
