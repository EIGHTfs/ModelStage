// debug-log.js —— 调试日志核心（无 DOM 依赖）
//
// 职责：环形缓冲、分级、订阅、开关。面板（debug-panel.js）只消费这里产出的条目。
//
// 单一真相源（docs/设计/调试日志面板.md）：
//   条目**只从 diag 进来** —— log() 不再直接写缓冲，而是把事件交给 window.__DIAG__，
//   由面板注册的 sink 回调 addExternal() 写回缓冲。这样"应用事件 / 运行时异常 / 网络失败"
//   走的是同一条管道：把 sink 注册注释掉，三类会一起消失（可反向验证"真的接通了"）。
//   没有 diag（独立使用本模块/单测）时退回直接写缓冲，行为与旧版一致。
//
// 契约（docs/README.md 第二十二节）：
//   const log = createDebugLog({ capacity: 500 });
//   log.log(tag, message, { level = 'info', data } = {});
//   log.entries();      // [{ ts, level, tag, message }] 快照，按时间正序
//   log.subscribe(fn);  // 新条目回调，返回取消订阅函数
//   log.clear(); log.setEnabled(bool); log.getEnabled();
//
// 硬规则（都在代码里落实）：
//   1. 默认开启；关闭时 log() 立即返回、不产生任何对象；
//   2. 单条 message ≤ 300 字，超出截断并注明；
//   3. 环形缓冲默认 500 条，超出丢最旧；
//   4. 日志绝不抛异常、不阻塞渲染（订阅者异常各自隔离）。
//
// 结构：本文件按职责拆成小函数（每函数 ≤50 行）：容量规整 / 文本化 / 组装正文 /
//   环形缓冲 / 订阅总线 / 编排，四者互不重叠。

import { sanitizeUrl } from '../infra/diag.js';

/** 允许的 tag（大写）。调用方只能从这里取，不自造。 */
export const DEBUG_TAGS = Object.freeze([
  'RUNTIME', 'LOADER', 'RENDERER', 'CAMERA', 'ANIMATION', 'SKIN', 'FILTER',
  'PMA', 'ROSTER', 'PANEL', 'TRANSPORT', 'PERSIST', 'CONFIG',
]);

/** 允许的级别 */
// debug 是最低档：交互遥测（缩放/拖动）走这一档，默认过滤下不显示，切到低档才看
export const DEBUG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);

/**
 * 条目来源（面板据此加前缀，区分"应用自己说的"和"探针抓到的"）：
 *   app       应用事件（加载/切换/设置变更）
 *   error     运行时异常（window.onerror / unhandledrejection / console.error）
 *   net       网络失败（HTTP ≥400 / 请求失败）
 *   resource  资源加载失败
 *   其它      探针内部来源（diag/stage/console/motion…）原样透传
 */
export const DEBUG_SOURCES = Object.freeze(['app', 'error', 'net', 'resource', 'diag', 'stage', 'console', 'motion', 'window']);

/** 来源归一：未知来源归到 app，避免面板出现奇怪前缀 */
function normalizeSource(src) {
  const v = String(src || '').toLowerCase();
  return DEBUG_SOURCES.includes(v) ? v : (v ? v : 'app');
}

/** 敏感键：data 里这些键的值一律打码（与 infra/diag.js 的 URL 脱敏同一套口径） */
const SENSITIVE_KEY_RE = /^(token|access_token|refresh_token|id_token|api_?key|apikey|secret|password|passwd|pwd|auth|authorization|session|sessionid|sid|code|sign|signature|sig)$/i;

/** 递归深度上限：日志对象可能很深（含 DOM/PIXI 引用），到上限就截断成占位符 */
const SANITIZE_MAX_DEPTH = 6;
/** 单个对象/数组最多看多少个成员（避免大对象被整份遍历） */
const SANITIZE_MAX_KEYS = 40;
/** 深度截断占位符 */
const DEPTH_MARK = '[depth-limit]';
/** 循环引用占位符 */
const CIRCULAR_MARK = '[circular]';

/**
 * 字符串脱敏：**凡带 query 的字符串一律按 URL 清洗**（不看有没有 scheme）。
 *
 * 为什么不能只看 ^https?://：日志里的地址大多是相对路径（/api/x?token=…），
 *   只认绝对地址等于把这类凭据全放过。清洗实现复用 infra/diag.js 的 sanitizeUrl
 *   （网络采集那条路径已经用它处理过相对/绝对两种形态）。
 * @param {string} value
 * @returns {string}
 */
function sanitizeString(value) {
  if (!value.includes('?') || !value.includes('=')) return value;
  try {
    return sanitizeUrl(value);
  } catch {
    return value.replace(/([?&][^=&]*(?:token|key|secret|password|code|sign)[^=&]*=)[^&]*/gi, '$1***');
  }
}

/**
 * 递归脱敏一个值（对象/数组都进）。
 * @param {*} value
 * @param {number} depth 当前层数（0 = data 本身）
 * @param {WeakSet<object>} seen 已访问对象（循环引用保护）
 * @returns {*}
 */
function sanitizeValue(value, depth, seen) {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string') return sanitizeString(value);
  if (type !== 'object') return value;
  if (depth >= SANITIZE_MAX_DEPTH) return DEPTH_MARK;
  if (seen.has(value)) return CIRCULAR_MARK;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, SANITIZE_MAX_KEYS).map((item) => sanitizeValue(item, depth + 1, seen));
    }
    const out = {};
    for (const key of Object.keys(value).slice(0, SANITIZE_MAX_KEYS)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? '***' : sanitizeValue(value[key], depth + 1, seen);
    }
    return out;
  } catch {
    return null; // 抛异常的取值器（getter/DOM）整体放弃，不影响其它条目
  }
}

/**
 * data 脱敏（对外唯一入口）：敏感键整体打码 + 递归清洗 URL 里的凭据。
 *
 * 为什么要递归：日志里的凭据不只出现在顶层，常见形态是 { req: { url: '…?token=…' } }；
 *   只洗一层等于只堵住最显眼的那条路。深度与循环都有上限，脱敏本身不能成为风险。
 * @param {*} data
 * @returns {*}
 */
function sanitizeData(data) {
  if (data === null || data === undefined) return null;
  try {
    return sanitizeValue(data, 0, new WeakSet());
  } catch {
    return null;
  }
}

/** 单条正文上限（字符）与默认容量 */
const MESSAGE_MAX = 300;
const CAPACITY_DEFAULT = 500;

/** 容量规整：非正整数一律回落到默认值 */
function normalizeCapacity(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : CAPACITY_DEFAULT;
}

/** 任意输入压成一行文本：字符串原样，其余尝试 JSON，失败再 String() */
function toText(raw) {
  if (typeof raw === 'string') return raw;
  if (raw === null || raw === undefined) return '';
  try {
    return JSON.stringify(raw);
  } catch {
    try { return String(raw); } catch { return '[unserializable]'; }
  }
}

/**
 * 组装正文：message +（可选）data 以「 · {json}」追加，整体受 300 字上限约束。
 * 为什么把 data 并进 message：条目结构固定为 { ts, level, tag, message }，
 *   面板与外部检查代码都按这 4 个键读，多一个键会让两端解析口径不一致。
 */
function buildMessage(message) {
  // 只保留"发生了什么"这句话本身：级别是自有属性（level 字段 + 图标），
  // 结构化细节是自有属性（data 字段，面板悬停/查看用），都不再拼进正文。
  const full = toText(message);
  if (full.length <= MESSAGE_MAX) return full;
  const note = `…(截断 ${full.length - MESSAGE_MAX} 字)`;
  return full.slice(0, Math.max(0, MESSAGE_MAX - note.length)) + note;
}

/**
 * 环形缓冲：push 到末尾，超出容量从头丢最旧。
 * @param {number} capacity
 */
function createBuffer(capacity) {
  const items = [];
  return {
    /** 追加一条；返回是否发生了淘汰 */
    add(entry) {
      items.push(entry);
      if (items.length <= capacity) return false;
      items.splice(0, items.length - capacity);
      return true;
    },
    /** 快照（浅拷贝，外部改动不影响内部） */
    snapshot() { return items.slice(); },
    /** 清空 */
    reset() { items.length = 0; },
    capacity,
  };
}

/**
 * 订阅总线：两路互不干扰 —— 条目路（新条目 / null=已清空）与开关路（enabled 变化）。
 * 为什么分两路：条目回调的入参约定是「条目|null」，把开关状态塞进去会污染这个约定。
 */
function createNotifier() {
  const subs = new Set();
  const stateSubs = new Set();
  const call = (set, arg) => {
    for (const fn of set) {
      try { fn(arg); } catch { /* 单个订阅者出错不影响其它订阅者 */ }
    }
  };
  return {
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
    onStateChange(fn) {
      if (typeof fn !== 'function') return () => {};
      stateSubs.add(fn);
      return () => { stateSubs.delete(fn); };
    },
    emit(entry) { call(subs, entry); },
    emitState(enabled) { call(stateSubs, enabled); },
  };
}

/**
 * 创建日志实例。
 * @param {{capacity?: number}} [options]
 */
export function createDebugLog(options = {}) {
  const buffer = createBuffer(normalizeCapacity(options.capacity));
  const bus = createNotifier();
  // 默认开启；显式传 { enabled: false } 可关闭
  let enabled = options.enabled === undefined ? true : !!options.enabled;

  /** 组装一条内部条目（唯一构造点，保证字段齐全） */
  function makeEntry(fields) {
    return {
      ts: Number(fields.ts) || Date.now(),
      level: DEBUG_LEVELS.includes(fields.level) ? fields.level : 'info',
      tag: String(fields.tag || '').toUpperCase(),
      message: String(fields.message || ''),
      src: normalizeSource(fields.src),
      event: String(fields.event || fields.tag || ''),
      data: sanitizeData(fields.data),
    };
  }

  /** 写缓冲并广播（**唯一入口**，不转发 —— 转发是 log() 的事，避免自激） */
  function addExternal(fields) {
    try {
      const entry = makeEntry(fields || {});
      buffer.add(entry);
      bus.emit(entry);
      return entry;
    } catch {
      return undefined;
    }
  }

  /**
   * 记一条日志；关闭时立即返回 undefined。
   *
   * 有 window.__DIAG__ 时**只交给探针**（由面板 sink 回调 addExternal 写回缓冲），
   * 这样三类事件共享同一条管道；没有探针（独立使用/单测）时直接写缓冲。
   */
  function log(tag, message, opts = {}) {
    if (!enabled) return undefined;
    try {
      const fields = {
        ts: Date.now(),
        level: opts.level,
        tag,
        message: buildMessage(message, opts.data),
        src: opts.src,
        event: opts.event || tag,
        // 脱敏必须发生在这里（转发之前）：diag 会把它写进缓冲并 POST 给服务端，
        // 只在 addExternal 里脱敏的话，GET /api/diag 与落盘仍是明文。
        data: opts.data === undefined ? null : sanitizeData(opts.data),
      };
      const diag = typeof window !== 'undefined' ? window.__DIAG__ : null;
      if (diag && typeof diag.event === 'function') {
        // message 必须一起送：只送 event+data 的话，正文（如"相机 fit: bbox=…"）会在面板里丢掉，
        //   只剩一个标签名，等于把日志变哑。
        diag.event(fields.event, fields.data, {
          level: fields.level, src: fields.src || 'app', tag: fields.tag, message: fields.message,
        });
        return fields; // 缓冲由 sink 写回；这里只回报"已上报"
      }
      return addExternal(fields);
    } catch {
      return undefined; // 日志绝不能影响业务
    }
  }

  return {
    log,
    /** 外部写入（sink 专用）：不转发，避免"转发→写缓冲→再转发"的自激 */
    addExternal,
    entries: () => buffer.snapshot(),
    /**
     * 稳定导出结构（供 API/自动化断言）：{ t, level, src, event, data }。
     * 与面板同一份缓冲，所以"API 条数 == 面板条数"是结构保证，不靠对账。
     */
    dump: () => buffer.snapshot().map((e) => ({
      t: new Date(e.ts).toISOString(),
      level: e.level,
      src: e.src,
      event: e.event,
      data: e.data,
    })),
    subscribe: (fn) => bus.subscribe(fn),
    clear() {
      buffer.reset();
      bus.emit(null);
    },
    setEnabled(value) {
      const next = !!value;
      if (next !== enabled) {
        enabled = next;
        bus.emitState(enabled);
      }
      return enabled;
    },
    /** 订阅开关变化（入参为新的 enabled 值），返回取消订阅函数 */
    onEnabledChange: (fn) => bus.onStateChange(fn),
    getEnabled: () => enabled,
    capacity: buffer.capacity,
  };
}
