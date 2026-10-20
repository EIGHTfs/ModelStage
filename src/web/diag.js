// diag.js —— 前端内置诊断探针（window.__DIAG__）
//
// 目的：把"出问题时临时注入 console 探针"变成页面自带的能力 —— 前端自证、AI/工具直接读文件取证，
//   不再依赖"浏览器会话还开着"这个前提。
//
// 采集面（只收错误 / 警告 / 关键事件，**不做每帧采样**，避免探针本身变成性能问题）：
//   · window.onerror（含资源加载失败，capture 阶段，覆盖 img/script/link/video/audio）
//   · unhandledrejection
//   · 包装 console.error / warn / info：幂等、保留原引用、内部日志不自激递归
//   · 关键事件：业务代码主动调用 __DIAG__.event(name, data)
//
// 出口：内存环形缓冲（默认 500 条）+ 批量 POST /api/diag 落盘（data/diag.jsonl）；
//   落盘失败静默降级为仅内存 —— 探针永远不能影响页面本身。面板显示留到 M6。
//
// 与旧前端 legacy/patches/diag.js 的关系：**API 名称与语义逐字一致**（同一套检查代码可对两端跑）。
// 结构：本文件按职责拆成若干小函数（每函数 ≤50 行，便于审计与维护），installDiag 只做编排。

/** 配置默认值（页面可在 installDiag 之前设置 window.__DIAG_CONFIG__ 覆盖） */
const DEFAULT_CONFIG = {
  capacity: 500,
  flushEveryMs: 1500,
  flushBatchMax: 40,
  strMax: 200,
  arrMax: 8,
  interactionMinMs: 500,
};

/** 框架告警结构化：Cubism 的 MotionManager 动作装载失败（Live2D 接入后才有，M5 用） */
const MOTION_FAIL_RE = /\[MotionManager\]\s*Failed to load motion/i;

/** 资源标签：这些元素的 error 事件代表"资源加载失败" */
const RESOURCE_TAGS = ['IMG', 'SCRIPT', 'LINK', 'VIDEO', 'AUDIO'];

// ---------------------------------------------------------------- 状态

/** 建立探针状态（缓冲、待落盘队列、计时器、配置） */
function createState(override) {
  const config = Object.assign({}, DEFAULT_CONFIG, window.__DIAG_CONFIG__ || {}, override || {});
  return {
    config,
    t0: Date.now(),
    buf: [],              // 环形缓冲
    pending: [],          // 待落盘队列
    flushTimer: null,
    internal: false,      // 防自激：探针内部产生的 console 调用不再被采集
    lastInteraction: 0,
  };
}

// ---------------------------------------------------------------- 值摘要

/** 值摘要：任何大对象都不能原样塞进缓冲（否则内存会被日志吃掉） */
function summarize(v, depth, st) {
  const d = depth || 0;
  const cfg = st.config;
  try {
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t === 'string') {
      return v.length > cfg.strMax ? `${v.slice(0, cfg.strMax)}…(+${v.length - cfg.strMax})` : v;
    }
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'function') return `[Function ${v.name || 'anonymous'}]`;
    if (t === 'symbol' || t === 'bigint') return String(v);
    if (ArrayBuffer.isView(v)) return { bytes: v.byteLength, kind: v.constructor ? v.constructor.name : 'TypedArray' };
    if (v instanceof ArrayBuffer) return { bytes: v.byteLength, kind: 'ArrayBuffer' };
    if (d >= 3) return Array.isArray(v) ? `[Array(${v.length})]` : `{${Object.keys(v).slice(0, 5).join(',')}…}`;
    if (Array.isArray(v)) {
      const head = v.slice(0, cfg.arrMax).map((x) => summarize(x, d + 1, st));
      return v.length > cfg.arrMax ? head.concat([`…(+${v.length - cfg.arrMax})`]) : head;
    }
    if (v instanceof Error) return summarizeError(v, d, st);
    return summarizeObject(v, d, st);
  } catch {
    return '[unserializable]';
  }
}

/** Error 只留名称/消息/前几行栈 */
function summarizeError(err, d, st) {
  return {
    name: err.name,
    message: summarize(err.message, d + 1, st),
    stack: err.stack ? summarize(String(err.stack).split('\n').slice(0, 4).join(' | '), d + 1, st) : null,
  };
}

/** 普通对象只保留浅层可读字段，避免循环引用与深树 */
function summarizeObject(v, d, st) {
  const out = {};
  const keys = Object.keys(v).slice(0, 16);
  for (const k of keys) {
    const val = v[k];
    if (typeof val === 'object' && val !== null && d + 1 >= 3) {
      out[k] = Array.isArray(val) ? `[Array(${val.length})]` : '[Object]';
      continue;
    }
    out[k] = summarize(val, d + 1, st);
  }
  const extra = Object.keys(v).length - keys.length;
  if (extra > 0) out['…'] = `(+${extra} 键)`;
  return out;
}

/** 把 console 参数拼成一行文本（对象先摘要再 JSON，避免 [object Object]） */
function textOf(args, st) {
  try {
    return args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(summarize(a, 0, st)); } catch { return String(a); }
    }).join(' ');
  } catch {
    return '[args]';
  }
}

// ---------------------------------------------------------------- 缓冲与落盘

/** 入队 + 淘汰最旧（环形缓冲）+ 触发落盘 */
function push(st, level, src, event, data, extra) {
  const e = Object.assign({
    t: new Date().toISOString(),
    tRel: Date.now() - st.t0,
    level,
    src,
    event,
    data: summarize(data, 0, st),
    model: null,
    plugin: null,
  }, extra || {});
  st.buf.push(e);
  if (st.buf.length > st.config.capacity) st.buf.splice(0, st.buf.length - st.config.capacity);
  st.pending.push(e);
  // 极端情况下丢最旧，避免 pending 无限增长（服务端不可用时尤其重要）
  if (st.pending.length > 400) st.pending.splice(0, st.pending.length - 400);
  scheduleFlush(st);
  return e;
}

/** 合并 1.5s 内的条目成一批，避免每条一个请求 */
function scheduleFlush(st) {
  if (st.flushTimer) return;
  st.flushTimer = setTimeout(() => { st.flushTimer = null; flush(st); }, st.config.flushEveryMs);
}

/** 落盘：只追加、失败静默（探针不能因为服务端不可用而影响页面） */
function flush(st) {
  if (!st.pending.length) return;
  const batch = st.pending.splice(0, st.config.flushBatchMax);
  try {
    st.internal = true;
    fetch('/api/diag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: batch }),
      keepalive: true,
    }).catch(() => {}).finally(() => { st.internal = false; });
  } catch {
    st.internal = false;
  }
}

// ---------------------------------------------------------------- 采集：全局错误

/** 取资源元素上的 URL（不同标签字段不同） */
function resourceUrl(el) {
  return el.currentSrc || el.src || el.href || '';
}

/** window.onerror + unhandledrejection + 资源加载失败（capture 才能收到资源的 error） */
function captureWindowErrors(st) {
  window.addEventListener('error', (ev) => {
    try {
      const tg = ev && ev.target;
      if (tg && tg !== window && RESOURCE_TAGS.includes(tg.tagName)) {
        push(st, 'error', 'resource', 'resource.fail', { tag: tg.tagName, url: resourceUrl(tg) });
        return;
      }
      push(st, 'error', 'window', 'error', {
        message: ev && ev.message,
        source: ev && ev.filename,
        line: ev && ev.lineno,
        col: ev && ev.colno,
        stack: ev && ev.error && ev.error.stack ? String(ev.error.stack).split('\n').slice(0, 5).join(' | ') : null,
      });
    } catch { /* 采集失败不能影响页面 */ }
  }, true);

  window.addEventListener('unhandledrejection', (ev) => {
    try {
      const r = ev && ev.reason;
      push(st, 'error', 'window', 'rejection', {
        reason: r instanceof Error
          ? { name: r.name, message: r.message, stack: r.stack ? String(r.stack).split('\n').slice(0, 5).join(' | ') : null }
          : r,
      });
    } catch { /* 同上 */ }
  });
}

// ---------------------------------------------------------------- 采集：console

/** 包装 console.error/warn/info：幂等、保留原引用、内部日志不自激 */
function wrapConsole(st) {
  const origin = { error: console.error, warn: console.warn, info: console.info };

  /** 单条 console 调用的采集（motion.fail 单独结构化，其余按 console 记一条） */
  function capture(level, text) {
    if (level === 'warn' && MOTION_FAIL_RE.test(text)) {
      const m = text.match(/Failed to load motion[:\s]*([^\s]+)/i);
      push(st, 'error', 'motion', 'motion.fail', {
        motion: m ? m[1] : null,
        url: (text.match(/https?:\/\/[^\s)]+/) || [null])[0],
        raw: text,
      });
      return;
    }
    push(st, level, 'console', 'console', { text });
  }

  const wrap = (level) => function wrapped(...args) {
    if (!st.internal) {
      try { capture(level, textOf(args, st)); } catch { /* 采集失败不能影响原日志 */ }
    }
    return origin[level].apply(console, args);
  };

  try {
    console.error = wrap('error');
    console.warn = wrap('warn');
    console.info = wrap('info');
  } catch { /* 某些环境 console 只读：放弃包装，其余采集照旧 */ }
}

// ---------------------------------------------------------------- 采集：交互

/** 交互低频采样：只记"发生了什么"，不记每帧（滚轮/按下各按阈值节流） */
function captureInteractions(st) {
  const throttled = (fn) => (ev) => {
    const now = Date.now();
    if (now - st.lastInteraction < st.config.interactionMinMs) return;
    st.lastInteraction = now;
    fn(ev);
  };

  window.addEventListener('wheel', throttled((ev) => {
    push(st, 'info', 'stage', 'interaction', { kind: 'wheel', deltaY: ev.deltaY, ctrl: ev.ctrlKey });
  }), { passive: true });

  window.addEventListener('pointerdown', throttled((ev) => {
    push(st, 'info', 'stage', 'interaction', { kind: 'pointerdown', x: ev.clientX, y: ev.clientY, button: ev.button });
  }), { passive: true });

  // 页面隐藏时补一次落盘（关标签/切后台时最后一批不至于丢）
  window.addEventListener('pagehide', () => { try { flush(st); } catch { /* 忽略 */ } });
}

// ---------------------------------------------------------------- 对外接口

/** 组装 window.__DIAG__（API 名称与旧前端 legacy/patches/diag.js 完全一致） */
function createApi(st) {
  return {
    __installed: true,
    config: st.config,
    /** 业务主动上报事件（如 model.mount / stage.load） */
    event(event, data, extra) {
      return push(st, (extra && extra.level) || 'info', (extra && extra.src) || 'app', event, data, extra);
    },
    dump() { return st.buf.slice(); },
    errors() { return st.buf.filter((e) => e.level === 'error'); },
    warnings() { return st.buf.filter((e) => e.level === 'warn'); },
    timeline() { return st.buf.map((e) => `${e.t} [${e.level}] ${e.src}${e.event ? `/${e.event}` : ''}`); },
    tail(n) { return st.buf.slice(-(Number(n) || 20)); },
    clear() { st.buf.length = 0; st.pending = []; return true; },
    size() {
      return {
        buffered: st.buf.length,
        capacity: st.config.capacity,
        pendingFlush: st.pending.length,
        sinceMs: Date.now() - st.t0,
      };
    },
    flushNow() { flush(st); return true; },
  };
}

/**
 * 安装探针（幂等：已安装则直接返回现有实例）。
 * @param {object} [override] 配置覆盖（优先级最高）
 * @returns {object} window.__DIAG__ 实例
 */
export function installDiag(override) {
  // 已注入过就直接返回：可能被重复调用（热重载、手工注入），必须幂等
  if (window.__DIAG__ && window.__DIAG__.__installed) return window.__DIAG__;

  const st = createState(override);
  captureWindowErrors(st);
  wrapConsole(st);
  captureInteractions(st);

  const api = createApi(st);
  window.__DIAG__ = api;
  push(st, 'info', 'diag', 'diag.ready', { capacity: st.config.capacity, href: location.href });
  return api;
}
