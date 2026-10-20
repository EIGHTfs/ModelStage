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

/**
 * @param {{dataDir: string, diagFile: string}} paths
 */
export function createDiag(paths) {
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
      const lines = take.map(serialize).filter(Boolean);
      if (lines.length) fs.appendFileSync(paths.diagFile, lines.join('\n') + '\n', 'utf8');
      return { ok: true, written: lines.length, dropped: entries.length - take.length };
    } catch (e) {
      console.warn(`[diag] 落盘失败（前端会降级为仅内存）: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  return { appendDiag };
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
