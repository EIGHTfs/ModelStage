// api.js —— 同源 HTTP 封装
//
// 做什么：给上层模块提供 getJson()，统一处理「非 2xx」「非 JSON」「网络失败」三种错误，
//   并把服务端返回的 JSON 错误体（{error: "..."}）抬成 Error.message。
// 为什么独立成模块：M2 之后要连续调 /api/tree、/api/models、/api/model-meta、/api/bundle/probe，
//   错误处理口径必须一致，不能每个调用点各写一遍 try/catch。

/**
 * 取 JSON。失败一律抛 Error，message 尽量带上服务端给的原文，便于界面直接显示。
 * @param {string} path 同源路径（以 / 开头）
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<any>}
 */
export async function getJson(path, options = {}) {
  const res = await fetch(path, {
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });

  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // 非 JSON（例如服务端 500 打了段 HTML）：把原文前 200 字带进错误，便于定位
      throw new Error(`GET ${path} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
  }

  if (!res.ok) {
    const detail = body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new Error(`GET ${path} 失败：${detail}`);
  }
  return body;
}

/**
 * 把错误对象格式化成一行可读文本（界面直接显示，也方便诊断日志落盘）。
 * @param {unknown} err
 * @returns {string}
 */
export function formatError(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}
