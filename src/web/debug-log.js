// debug-log.js —— 调试日志核心（无 DOM 依赖）
//
// 职责：环形缓冲、分级、订阅、开关。面板（debug-panel.js）只消费这里产出的条目。
//
// 契约（doc/任务-前端重写.md 第二十二节）：
//   const log = createDebugLog({ capacity: 500 });
//   log.log(tag, message, { level = 'info', data } = {});
//   log.entries();      // [{ ts, level, tag, message }] 快照，按时间正序
//   log.subscribe(fn);  // 新条目回调，返回取消订阅函数
//   log.clear(); log.setEnabled(bool); log.getEnabled();
//
// 硬规则（都在代码里落实）：
//   1. 默认开启（与旧端「调试日志」开关的初始态一致）；关闭时 log() 立即返回、不产生任何对象；
//   2. 单条 message ≤ 300 字，超出截断并注明；
//   3. 环形缓冲默认 500 条，超出丢最旧；
//   4. 日志绝不抛异常、不阻塞渲染（订阅者异常各自隔离）。
//
// 结构：本文件按职责拆成小函数（每函数 ≤50 行）：容量规整 / 文本化 / 组装正文 /
//   环形缓冲 / 订阅总线 / 编排，四者互不重叠。

/** 允许的 tag（大写）。调用方只能从这里取，不自造。 */
export const DEBUG_TAGS = Object.freeze([
  'RUNTIME', 'LOADER', 'RENDERER', 'CAMERA', 'ANIMATION', 'SKIN', 'FILTER',
  'PMA', 'ROSTER', 'PANEL', 'TRANSPORT', 'PERSIST', 'CONFIG',
]);

/** 允许的级别 */
export const DEBUG_LEVELS = Object.freeze(['info', 'warn', 'error']);

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
function buildMessage(message, payload) {
  const head = toText(message);
  const tail = payload === undefined ? '' : toText(payload);
  const full = tail ? `${head} · ${tail}` : head;
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
  // 默认开启（旧端开关初始为开）；显式传 { enabled: false } 可关闭
  let enabled = options.enabled === undefined ? true : !!options.enabled;

  /** 记一条日志；关闭时立即返回 undefined */
  function log(tag, message, opts = {}) {
    if (!enabled) return undefined;
    try {
      const entry = {
        ts: Date.now(),
        level: DEBUG_LEVELS.includes(opts.level) ? opts.level : 'info',
        tag: String(tag || '').toUpperCase(),
        message: buildMessage(message, opts.data),
      };
      buffer.add(entry);
      bus.emit(entry);
      return entry;
    } catch {
      return undefined; // 日志绝不能影响业务
    }
  }

  return {
    log,
    entries: () => buffer.snapshot(),
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
