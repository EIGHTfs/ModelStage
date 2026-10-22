// diag.mjs —— 前端诊断落盘（POST /api/diag 的数据层）
//
// 与旧服务同一套规则（行数/体积/轮转一致），只写 data/ 目录，不触碰用户配置：
//   · 一行一条 JSON，追加写；
//   · 单请求最多 500 条、单条最长 8000 字（防止一次把磁盘写满）；
//   · 文件超过 8MB 时把当前文件改名 diag.jsonl.1（只保留一代）再继续写；
//   · 任何异常都只回 {ok:false}，绝不抛到路由外（否则会打挂进程）。
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES_PER_REQ = 500;
const MAX_LINE_CHARS = 8000;
// 每个缓冲只留最近几个会话（防长期运行内存增长）。
// 必须放在模块级：getSession() 是模块级函数，放在 createDiag() 的闭包里它看不见，
//   走到淘汰分支就抛 ReferenceError，被上层 catch 成「落盘失败（降级为仅内存）」——
//   表现为诊断日志从第 5 个会话起悄悄不再写文件，而页面一切正常。
const SESSION_MAX = 4;

/**
 * @param {{dataDir: string, diagFile: string}} paths
 */
export function createDiag(paths) {
  // 服务端侧的环形缓冲（GET /api/diag 读它，与面板内容同源）。
  // 按会话 id 分组：页面重载会换 sid，旧条目不会混进"当前这一轮"的统计。
  const sessions = new Map();   // sid -> { recent, counts, lastAt }

  /**
   * 追加一批诊断条目。
   * @param {string} body 原始请求体
   * @returns {{ok: boolean, written?: number, dropped?: number, error?: string}}
   */
  function appendDiag(body) {
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      return { ok: false, error: '请求体不是合法 JSON' };
    }
    const entries = payload && Array.isArray(payload.entries) ? payload.entries : null;
    if (!entries) return { ok: false, error: '缺少 entries 数组' };

    const take = entries.slice(0, MAX_ENTRIES_PER_REQ);
    try {
      if (!fs.existsSync(paths.dataDir)) fs.mkdirSync(paths.dataDir, { recursive: true });
      rotateIfNeeded(paths.diagFile);
      const sid = String((payload && payload.sid) || 'anonymous');
      remember(getSession(sessions, sid), take);
      const lines = take.map(serialize).filter(Boolean);
      if (lines.length) fs.appendFileSync(paths.diagFile, lines.join('\n') + '\n', 'utf8');
      return { ok: true, written: lines.length, dropped: entries.length - take.length };
    } catch (e) {
      console.warn(`[diag] 落盘失败（前端会降级为仅内存）: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  /**
   * 读取最近的诊断条目（只读：不接受调用方指定文件/路径）。
   * 返回结构与面板一致：{ t, level, src, event, data }，外加 total 与级别分布。
   * @param {{limit?: number}} [options]
   * @returns {{ok: true, total: number, counts: object, entries: object[]}}
   */
  function readDiag(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || CAPACITY, 1), CAPACITY);
    const picked = pickSession(sessions, options.sid);
    if (!picked) return { ok: true, sid: options.sid || null, total: 0, counts: { info: 0, warn: 0, error: 0, debug: 0 }, entries: [] };
    return {
      ok: true,
      sid: picked.sid,
      total: picked.recent.length,
      counts: { ...picked.counts },
      entries: picked.recent.slice(-limit).map(shapeEntry),
    };
  }

  return { appendDiag, readDiag };
}

/** 服务端环形缓冲容量（与前端 diag 默认容量一致） */
const CAPACITY = 500;

/** 取（或建）一个会话的缓冲；超过上限时淘汰最久未活动的会话 */
function getSession(sessions, sid) {
  let s = sessions.get(sid);
  if (!s) {
    s = { sid, recent: [], counts: { info: 0, warn: 0, error: 0, debug: 0 }, lastAt: Date.now() };
    sessions.set(sid, s);
    if (sessions.size > SESSION_MAX) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, val] of sessions) if (val.lastAt < oldestAt) { oldestAt = val.lastAt; oldestKey = key; }
      if (oldestKey) sessions.delete(oldestKey);
    }
  }
  s.lastAt = Date.now();
  return s;
}

/** 选会话：指定 sid 优先；没指定就取最近活跃的那个 */
function pickSession(sessions, sid) {
  if (sid) return sessions.get(String(sid)) || null;
  let best = null;
  for (const val of sessions.values()) if (!best || val.lastAt > best.lastAt) best = val;
  return best;
}

/** 入环形缓冲 + 累计级别分布（容量满丢最旧；分布只统计当前缓冲内的条目） */
function remember(session, entries) {
  const { recent, counts } = session;
  for (const raw of entries) {
    const level = raw && typeof raw.level === 'string' ? raw.level : 'info';
    recent.push({ level, src: raw && raw.src, event: raw && raw.event, data: raw && raw.data, t: raw && raw.t });
    if (counts[level] === undefined) counts[level] = 0;
    counts[level] += 1;
    if (recent.length > CAPACITY) {
      const dropped = recent.shift();
      const key = dropped && dropped.level;
      if (key && counts[key] !== undefined) counts[key] = Math.max(0, counts[key] - 1);
    }
  }
}

/** 单条对外形状（稳定字段：t/level/src/event/data） */
function shapeEntry(e) {
  return {
    t: e && e.t ? String(e.t) : null,
    level: (e && e.level) || 'info',
    src: (e && e.src) || null,
    event: (e && e.event) || null,
    data: e && e.data !== undefined ? e.data : null,
  };
}

/** 超过上限就把当前文件挪成 .1（只保留一代）；轮转失败不阻断本次写入 */
function rotateIfNeeded(diagFile) {
  try {
    if (fs.existsSync(diagFile) && fs.statSync(diagFile).size > MAX_BYTES) {
      fs.renameSync(diagFile, `${diagFile}.1`);
    }
  } catch {
    /* 忽略 */
  }
}

/** 单条序列化 + 截断；失败返回 null（跳过该条，不影响整批） */
function serialize(entry) {
  try {
    const s = JSON.stringify(entry);
    if (typeof s !== 'string') return null;
    return s.length > MAX_LINE_CHARS ? s.slice(0, MAX_LINE_CHARS) : s;
  } catch {
    return null;
  }
}
