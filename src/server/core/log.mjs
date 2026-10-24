// core/log.mjs —— 服务端统一日志（与前端 infra/log.js 同构的记录形状）
//
// 为什么要有：服务端此前 31 处直接 console.*，靠方法名隐式表达级别、靠 `[前缀]` 人工标来源、
//   结构化数据全拼进文案（"389 个模型"里的数字程序取不到），也没有时间戳。这类日志一旦要
//   机器解析（AI 排障、回归对比），只能靠正则从人话里抠，很容易错。
//
// 记录形状（与前端同一套字段名）：{ at, level, tag, msg, detail }
// 输出格式（单行，人读 + 可解析兼顾）：
//   14:32:07.981 INFO  [models] 已生成清单 models.bd2.json {"count":389}
//   └ 固定宽度前缀 ⇒ 正则 /^(\d{2}:\d{2}:\d{2}\.\d{3}) (\w+)\s+\[(\S+)\] (.*?)(\{.*\})?$/ 可切四段
// 流向：error → stderr（真正的异常），debug/info/warn → stdout。
//   项目启动脚本是 `nohup … >"$LOG_FILE" 2>&1`，两流合并写同一文件，所以分流不丢日志，
//   但能让"只看 stderr"的场景（CI、容器错误通道）只收到真异常。
//
// 零依赖：只用 node 内置能力。

/** 级别权重（数值越大越严重）；阈值按此比较 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** 输出用的大写名：左对齐补齐 5 字符，让 [tag] 起始列对齐 */
const NAMES = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };

/** 阈值缓存：环境变量写了非法值时回落 info（**不能因为写错就让所有日志消失**，那是最难排查的故障） */
let cachedThreshold = null;
function threshold() {
  if (cachedThreshold !== null) return cachedThreshold;
  const raw = String((typeof process !== 'undefined' && process.env && process.env.LOG_LEVEL) || '').toLowerCase();
  cachedThreshold = Number.isFinite(LEVELS[raw]) ? LEVELS[raw] : LEVELS.info;
  return cachedThreshold;
}

/** 时间戳 HH:MM:SS.mmm（本地时区；日志文件本身没时间戳，靠这个补） */
function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * 安全序列化：循环引用/不可序列化值都不能让日志本身崩掉。
 * @param {unknown} v
 * @returns {string} JSON 文本（失败时给固定占位）
 */
function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return '"[unserializable]"';
  }
}

/**
 * 把 detail 转成输出用的尾部文本。
 *
 * 三条规则：
 *   ① 空值 → 返回空串（**不要输出 `{}`**：横幅/简单消息后面挂个 `{}` 是纯噪音）
 *   ② Error → 转成 { name, message, stack(前 3 行) }；否则 JSON.stringify(new Error('x')) 是 `{}`，
 *      日志里出现空对象等于什么都没记
 *   ③ 其它 → safeJson（循环引用不抛）
 * @param {unknown} detail
 * @returns {string} 形如 ` {"count":389}`，或空串
 */
function detailText(detail) {
  if (detail === undefined || detail === null) return '';
  if (detail instanceof Error) {
    const stack = String(detail.stack || '').split('\n').slice(0, 3).join(' | ');
    return ` ${safeJson({ name: detail.name, message: detail.message, stack })}`;
  }
  if (typeof detail === 'object' && Object.keys(detail).length === 0) return '';
  return ` ${safeJson(detail)}`;
}

/**
 * 建一个带来源标签的 logger。
 * @param {string} tag 模块标签（如 'serve' / 'models' / 'plugins'）
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}} 四档，签名 (msg, detail?)
 */
export function createLogger(tag) {
  const name = String(tag || 'app');

  /**
   * 输出一条。
   * @param {'debug'|'info'|'warn'|'error'} level
   * @param {string} msg 人话（不含前缀；前缀由 level/tag 负责）
   * @param {unknown} [detail] 结构化附加数据
   */
  function emit(level, msg, detail) {
    if (LEVELS[level] < threshold()) return;
    const line = `${stamp()} ${NAMES[level]} [${name}] ${String(msg == null ? '' : msg)}${detailText(detail)}`;
    // error 走 stderr，其余走 stdout（见文件头）
    if (level === 'error') console.error(line);
    else console.log(line);
  }

  return {
    debug: (msg, detail) => emit('debug', msg, detail),
    info: (msg, detail) => emit('info', msg, detail),
    warn: (msg, detail) => emit('warn', msg, detail),
    error: (msg, detail) => emit('error', msg, detail),
  };
}

/** 供测试/诊断：当前生效的阈值名（非法 LOG_LEVEL 会回落 info） */
export function levelName() {
  const hit = Object.keys(LEVELS).find((k) => LEVELS[k] === threshold());
  return hit || 'info';
}
