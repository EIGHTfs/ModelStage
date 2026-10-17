// infra/log.js —— 统一的日志工厂（调试日志整理的第 ① 步）
//
// 解决的问题：现在页面里同时存在四条各写各的通路（diag.push / stageStatus / diagEvent / console 镜像），
//   同一件事可能从两条路进来，级别口径也不一致。这里只定义"一条日志记录长什么样 + 怎么写"，
//   **不接管任何现有调用点**：现有通路改由适配层转调（第 ② 步做），因此本模块可以独立上线、独立测试。
//
// 四档的分界不是"严重程度"，而是"给谁看"：
//   debug  给机器：事件名 + 结构化 detail，字段名稳定可解析（断言/回归对比靠它）
//   info   给人和 AI：一句人话，正常流程（设置回显、操作确认、进度）
//   warn   给人和 AI：人话 + 为什么会这样（预期内的失败、可降级）
//   error  给人和 AI：人话 + 可排查上下文（错误对象、输入）
//
// 记录形状（四档完全一致，只有 level 不同）：
//   { at, level, tag, event?, msg?, detail?, src }
//   可选字段：debug 必须给 event；info/warn/error 必须给 msg。detail 可选，但给了就保持结构化。

/** 允许的级别（顺序即严重度递增，面板按此排序） */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/** 允许的来源：app=本应用主动打的；console=包装原生 console 抓到的（可能混第三方）；server=服务端转发 */
export const LOG_SOURCES = ['app', 'console', 'server'];

/** 内存里保留多少条（够面板展示与测试取用，又不至于无限涨） */
export const LOG_LIMIT = 500;

/** 环形缓冲：最近若干条记录（面板/测试/自检都从这里取，避免各自再存一份） */
const buffer = [];
/** 订阅者：每条新记录都会同步推给他们（面板渲染、测试断言） */
const sinks = new Set();

/**
 * 把 detail 归一成"结构化但可序列化"的值。
 *
 * 关键点：**对象必须原样保留**，绝不能 String() —— 一旦变成 "[object Object]"，机器就没法解析了
 *   （这也是 debug 级存在的唯一理由）。Error 不是普通可枚举对象，单独拆成可读字段。
 * @param {unknown} detail
 * @returns {object|undefined} 归一后的 detail；没给就返回 undefined
 */
function normalizeDetail(detail) {
  if (detail === undefined || detail === null) return undefined;
  if (detail instanceof Error) {
    return { name: detail.name, message: detail.message, stack: detail.stack || '' };
  }
  if (typeof detail === 'object') return detail;      // 保留结构（数组/普通对象都原样带走）
  return { value: detail };                          // 原始值包一层，保证 detail 永远是对象
}

/**
 * 组装一条记录（四档共用，保证形状一致）。
 * @param {string} level 级别（必须在 LOG_LEVELS 内）
 * @param {string} tag 模块标签
 * @param {object} fields { event?, msg?, detail? }
 * @param {'app'|'console'|'server'} src 来源
 * @returns {object} 统一形状的记录
 */
function makeRecord(level, tag, fields, src) {
  const record = { at: Date.now(), level, tag, src };
  if (fields.event) record.event = String(fields.event);
  if (fields.msg !== undefined && fields.msg !== null && fields.msg !== '') record.msg = String(fields.msg);
  const detail = normalizeDetail(fields.detail);
  if (detail !== undefined) record.detail = detail;
  return record;
}

/** 写入一条记录：进环形缓冲 + 推给订阅者（订阅者异常不能反过来影响业务） */
function push(record) {
  buffer.push(record);
  if (buffer.length > LOG_LIMIT) buffer.splice(0, buffer.length - LOG_LIMIT);
  for (const sink of sinks) {
    try { sink(record); } catch { /* 消费方自己出错不该污染日志通路 */ }
  }
  return record;
}

/**
 * 创建一个带模块标签的 logger。
 *
 * @param {string} tag 模块标签（进每条记录，便于按模块过滤；如 'unpack' / 'panel' / 'stage'）
 * @param {{src?: 'app'|'console'|'server'}} [opts] src 缺省为 'app'
 * @returns {{
 *   debug: (event: string, detail?: object) => object,
 *   info: (msg: string, detail?: object) => object,
 *   warn: (msg: string, detail?: object) => object,
 *   error: (msg: string, detail?: object) => object,
 * }}
 */
export function createLogger(tag, opts) {
  if (typeof tag !== 'string' || !tag) throw new TypeError('createLogger: tag 必须是非空字符串');
  const src = (opts && opts.src) || 'app';
  if (!LOG_SOURCES.includes(src)) {
    throw new TypeError(`createLogger: src 必须是 ${LOG_SOURCES.join('/')} 之一（收到 ${String(src)}）`);
  }
  const name = String(tag);

  return {
    /**
     * 机器友好日志：**必须给事件名**（点分命名，如 'unpack.pair'），detail 用固定键。
     * 只给 msg 不给 event 会直接抛错——否则它就退化成了一条"人话日志"，
     *   而 debug 级存在的唯一理由就是"字段名稳定、可被机器解析"。
     */
    debug(event, detail) {
      if (typeof event !== 'string' || !event) {
        throw new TypeError('log.debug: 必须给事件名（点分命名，如 "unpack.pair"），不能只给 msg');
      }
      if (!/^[a-z][\w-]*(\.[\w-]+)+$/i.test(event)) {
        throw new TypeError(`log.debug: 事件名应点分命名（收到 "${event}"）`);
      }
      return push(makeRecord('debug', name, { event, detail }, src));
    },
    /** 一句人话，正常流程（设置回显 / 操作确认 / 进度） */
    info(msg, detail) {
      if (typeof msg !== 'string' || !msg) throw new TypeError('log.info: 必须给一句人话 msg');
      return push(makeRecord('info', name, { msg, detail }, src));
    },
    /** 人话 + 为什么会这样（预期内的失败、可降级的情况） */
    warn(msg, detail) {
      if (typeof msg !== 'string' || !msg) throw new TypeError('log.warn: 必须给一句人话 msg');
      return push(makeRecord('warn', name, { msg, detail }, src));
    },
    /** 人话 + 可排查上下文（非预期失败：错误对象、输入、状态） */
    error(msg, detail) {
      if (typeof msg !== 'string' || !msg) throw new TypeError('log.error: 必须给一句人话 msg');
      return push(makeRecord('error', name, { msg, detail }, src));
    },
  };
}

/**
 * 订阅新记录（面板渲染、测试断言用）。
 * @param {(record: object) => void} sink
 * @returns {() => void} 取消订阅
 */
export function subscribe(sink) {
  if (typeof sink !== 'function') throw new TypeError('subscribe: 必须传函数');
  sinks.add(sink);
  return () => { sinks.delete(sink); };
}

/**
 * 取最近的若干条记录（不传就全取，受 LOG_LIMIT 限制）。
 * @param {number} [n]
 * @returns {object[]} 记录的浅拷贝数组（外部改它不影响内部缓冲）
 */
export function recent(n) {
  if (n === undefined || n === null) return buffer.slice();
  const count = Math.max(0, Math.floor(Number(n) || 0));
  return count ? buffer.slice(-count) : [];
}

/** 清空缓冲区（只清日志，不动订阅者；测试与"清空日志"按钮都用它） */
export function clearLogs() {
  buffer.length = 0;
}
