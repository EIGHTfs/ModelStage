// http/ready.mjs —— 就绪信号通道（服务端状态机 + SSE）
//
// 契约：doc/契约/就绪信号契约.md（实现以它为准）。要点：
//   · 与 diag 完全分离：这里存**状态机**（每阶段只保留最新值），不是流水，也不进调试面板；
//   · 每阶段只前进不后退（failed 可覆盖任何状态，且必须带 reason）；
//   · rev 单调递增：测试据此判断快照是否过期；
//   · GET /api/ready 幂等（任何时刻都返回完整快照，不依赖是否连过流）；
//   · GET /api/ready/stream 连上时**先推全量 snapshot，再推增量 update**
//     —— 只推增量会让"页面早就绪之后才连上"的测试永远等不到（死锁），这是契约 §5.3 的重点。
//
// 结构：状态放在一个普通 store 里，读写都是模块级函数（不塞进工厂闭包）——
//   每个函数都能单独读、单独测，也不会被"单函数 100+ 行"的门禁拦下。

/** 阶段清单（契约 §三：新增阶段必须先登记，不允许随手加字符串） */
export const STAGES = [
  'shell', 'topbar', 'sidebarLeft', 'sidebarRight', 'panel',
  'bottombar', 'debugPanel', 'renderer', 'model',
];

// 合法状态（契约 §四）：
//   pending = 尚未上报（等级最低，任何真实状态都能覆盖它；不用 unknown，契约里没有这个值）
//   painted = 模型专属中间级（§2.2）——漏进白名单会让它被静默丢弃（实测踩过）
export const STATES = ['pending', 'mounted', 'painted', 'settled', 'interactive', 'failed'];

/** 前进顺序：同一阶段不得退回低等级（failed 例外）；painted 与 settled 同档 */
const RANK = { pending: 0, mounted: 1, painted: 2, settled: 2, interactive: 3 };

/** SSE 心跳间隔：反代/浏览器会掐掉长时间静默的连接 */
const HEARTBEAT_MS = 15000;

/** 校验阶段名与状态；非法输入返回 { ignore: 原因 } */
function validateUpdate(u) {
  const name = String((u && u.stage) || '');
  const state = String((u && u.state) || '');
  if (!STAGES.includes(name)) return { ignore: `${name || '(空)'}: 未登记的阶段` };
  if (!STATES.includes(state)) return { ignore: `${name}: 非法状态 ${state}` };
  return { name, state };
}

/** 由一条上报构造记录（detail 可选；failed 必带 reason） */
function buildRecord(u, state) {
  const rec = { state, at: Number(u.at) || Date.now() };
  if (u.detail && typeof u.detail === 'object') rec.detail = u.detail;
  if (state === 'failed') rec.reason = String(u.reason || '未提供原因');
  return rec;
}

/** 把一条上报解析成记录；非法输入返回 { ignore: 原因 } */
function toRecord(u) {
  const v = validateUpdate(u);
  if (v.ignore) return v;
  return { name: v.name, state: v.state, rec: buildRecord(u, v.state), reset: u.reset === true };
}

/** 该不该接受这次变更：只前进不后退，failed 可覆盖任何状态，reset 后从零起算 */
function shouldAdvance(state, prev) {
  if (state === 'failed' || !prev || prev.state === 'failed') return true;
  return (RANK[state] || 0) > (RANK[prev.state] || 1);
}

/** 推增量给所有在线的 SSE 客户端 */
function broadcast(store, items) {
  for (const res of store.clients) {
    for (const it of items) {
      try {
        res.write(`event: update\ndata: ${JSON.stringify(it)}\n\n`);
      } catch {
        store.clients.delete(res);
      }
    }
  }
}

/** 应用一条上报；返回 { change } 或 { ignored } */
function applyOne(store, u) {
  const parsed = toRecord(u);
  if (parsed.ignore) return { ignored: parsed.ignore };
  if (parsed.reset) store.stages.delete(parsed.name);
  const prev = store.stages.get(parsed.name);
  if (!shouldAdvance(parsed.rec.state, prev)) return {};
  store.stages.set(parsed.name, parsed.rec);
  store.rev += 1;
  return { change: { stage: parsed.name, ...parsed.rec, rev: store.rev } };
}

/** clear：页面重载/新实例接入时清空上一轮阶段（rev 继续递增，不回退版本号） */
function clearAll(store) {
  store.stages = new Map();
  store.rev += 1;
  broadcast(store, [{ stage: '*', state: 'cleared', at: Date.now(), rev: store.rev }]);
  return { ok: true, rev: store.rev, changed: 1, ignored: [] };
}

/** 应用一批更新（页面侧上报入口） */
function applyUpdates(store, body) {
  if (body && body.clear === true) return clearAll(store);
  const list = Array.isArray(body && body.updates) ? body.updates : [];
  const changed = [];
  const ignored = [];
  for (const u of list) {
    const r = applyOne(store, u);
    if (r.ignored) ignored.push(r.ignored);
    if (r.change) changed.push(r.change);
  }
  if (changed.length) broadcast(store, changed);
  return { ok: true, rev: store.rev, changed: changed.length, ignored };
}

/** 取快照（幂等）。单阶段：未登记 → ok:false（路由给 400）；已登记未上报 → pending */
function snapshotOf(store, stage) {
  const at = Date.now();
  if (!stage) {
    const out = {};
    for (const [name, rec] of store.stages) out[name] = rec;
    return { at, rev: store.rev, stages: out };
  }
  const name = String(stage);
  if (!STAGES.includes(name)) return { ok: false, error: `未登记的阶段：${name}`, known: STAGES.slice() };
  const rec = store.stages.get(name);
  return rec ? { at, rev: store.rev, stage: name, ...rec } : { at, rev: store.rev, stage: name, state: 'pending' };
}

/** 订阅 SSE：先推全量快照，再推增量（契约 §5.3） */
function subscribeSse(store, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 反代（nginx）默认缓冲响应，SSE 会看起来"一直没数据"
    'X-Accel-Buffering': 'no',
  });
  try {
    res.write('retry: 1000\n\n');
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshotOf(store))}\n\n`);
  } catch {
    try { res.end(); } catch { /* 忽略 */ }
    return;
  }
  store.clients.add(res);
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* 由 close 清理 */ }
  }, HEARTBEAT_MS);
  const bye = () => {
    clearInterval(hb);
    store.clients.delete(res);
    try { res.end(); } catch { /* 已断开 */ }
  };
  if (req && typeof req.on === 'function') {
    req.on('close', bye);
    req.on('error', bye);
  }
}

/**
 * 创建就绪信号状态机。
 * @returns {{apply: Function, snapshot: Function, subscribe: Function, reset: Function}}
 */
export function createReady() {
  const store = { stages: new Map(), rev: 0, clients: new Set() };
  return {
    apply: (body) => applyUpdates(store, body),
    snapshot: (stage) => snapshotOf(store, stage),
    subscribe: (req, res) => subscribeSse(store, req, res),
    /** 清空（测试用；rev 复位） */
    reset: () => { store.stages = new Map(); store.rev = 0; },
  };
}
