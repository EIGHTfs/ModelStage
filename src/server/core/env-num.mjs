// core/env-num.mjs —— 数值型 env 的统一读取（含非法值回落 + 告警）
//
// 为什么单独成模块：准入/探测这几处调参都要求"非法值回落缺省 + 一条 warn"，
//   各写一遍就会出现"这处安静回落、那处直接 NaN 传下去"的分歧 ——
//   而 NaN 传进比较表达式不会报错，只会让判据恒为 false（最隐蔽的一类失效）。
//
// 约定（三处调用方一致）：
//   · 缺省（未设 / 空串）⇒ 直接返回 fallback，**不告警**（这是正常部署形态）
//   · 设了但非法（NaN / 越界）⇒ 返回 fallback + **warn 一条**（不许静默用错值）
//   · 合法 ⇒ 返回解析后的数字

/**
 * 读一个非负数值型 env。
 * @param {string} name 变量名
 * @param {number} fallback 缺省值
 * @param {(level: string, msg: string, detail?: object) => void} [log] 日志函数（缺省 console.warn）
 * @returns {number}
 */
export function readNumericEnv(name, fallback, log) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  warnOnce(log, name, raw, fallback, '需要非负数字');
  return fallback;
}

/**
 * 读一个"比例"型 env（必须落在 (0, 1] 区间）。
 * @param {string} name
 * @param {number} fallback 缺省比例（如 0.85 / 0.5）
 * @param {(level: string, msg: string, detail?: object) => void} [log]
 * @returns {number}
 */
export function readRatioEnv(name, fallback, log) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0 && n <= 1) return n;
  warnOnce(log, name, raw, fallback, '需要 (0,1] 区间的小数（例如 0.85）');
  return fallback;
}

/** 告警（带去重：同一次启动里同一个变量只告一次，避免每请求刷屏） */
const warned = new Set();
function warnOnce(log, name, raw, fallback, hint) {
  if (warned.has(name)) return;
  warned.add(name);
  const msg = `环境变量 ${name}=${JSON.stringify(raw)} 非法（${hint}）—— 已回落缺省 ${fallback}`;
  try {
    if (typeof log === 'function') log('warn', msg, { name, raw, fallback });
    else if (log && typeof log.warn === 'function') log.warn(msg, { name, raw, fallback });
    else if (typeof console !== 'undefined' && console.warn) console.warn(msg);
  } catch { /* 日志失败也不能影响取值 */ }
}

/** 测试用：清掉"已告警"记录（同进程多次构造时才能重新告警） */
export function resetEnvWarnings() {
  warned.clear();
}
