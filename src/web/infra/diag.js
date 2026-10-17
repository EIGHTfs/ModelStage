import { createLogger } from './log.js';

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
// API 名称与语义保持稳定（同一套检查代码可在不同页面复用，不需要为改名改脚本））。
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

// ---------------------------------------------------------------- 适配层（统一日志工厂）
//
// 探针仍然按自己的形状采集与落盘（/api/diag → data/diag.jsonl 那条链路不动），
//   但**每一条事件同时送一份进 infra/log.js 的工厂**。这样"面板展示"和"上传"都能
//   只认工厂这一份数据源，不会出现"面板有、上传缺"的半套日志。
// 事件名归一：探针历史命名是 `category/event` 混 `a.b`，统一成点分（如 window/error → window.error），
//   因为工厂的 debug 级要求点分事件名——机器要按前缀分组过滤。
const logDiag = createLogger('diag');

/** 把 `a/b.c` 这类名字归一成点分的 `a.b.c`（工厂 debug 级要求点分） */
function dottedName(raw) {
  const parts = String(raw || '').split(/[/.]/).filter(Boolean);
  const name = parts.join('.');
  return /^[a-z]/.test(name) ? name : `event.${name || 'unknown'}`;
}

/**
 * 把一条探针事件镜像进统一工厂。
 * 级别语义：debug 走事件名 + 结构化 detail（机器读）；其余三档用事件名当人话 + detail 当上下文。
 * @param {string} level debug/info/warn/error
 * @param {string} event 原始事件名
 * @param {object} data 已摘要过的结构化数据
 */
function mirrorEventToFactory(level, event, data) {
  try {
    const detail = data && typeof data === 'object' ? data : undefined;
    if (level === 'debug') logDiag.debug(dottedName(event), detail || {});
    else if (level === 'warn') logDiag.warn(String(event || '事件'), detail);
    else if (level === 'error') logDiag.error(String(event || '事件'), detail);
    else logDiag.info(String(event || '事件'), detail);
  } catch { /* 适配层异常不得影响探针采集 */ }
}

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
    sinks: new Set(),      // 订阅者（面板等）：push 时同步分发
    seq: 0,                // 条目自增序号：面板"补历史 + 订阅"两条路会拿到同一条，用它去重
    // 页面实例 id：每次加载都不同。服务端按它分组，GET /api/diag?sid=… 只回该实例的条目，
    // 这样"API 条数 == 面板条数"不会被上一轮加载的旧条目污染。
    sid: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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
    id: (st.seq += 1),
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
  notifySinks(st, e);
  // 适配层：同一条事件也进统一工厂（面板/上传的唯一数据源）
  mirrorEventToFactory(level, event, e.data);
  return e;
}

/**
 * 把条目分发给订阅者（面板转发用）。
 * 为什么要 try 逐个兜住：订阅者是 UI 代码，出错不能反过来影响采集。
 * 传出去的是**浅拷贝**：订阅者改了字段不会污染环形缓冲。
 */
function notifySinks(st, entry) {
  for (const fn of st.sinks) {
    try { fn({ ...entry }); } catch { /* 单个订阅者异常不影响其它订阅者 */ }
  }
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
      body: JSON.stringify({ entries: batch, sid: st.sid }),
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

// ---------------------------------------------------------------- 脱敏

/** 敏感 query 键：命中就把值替换成 ***（导出、落盘、面板、API 同源处理） */
const SENSITIVE_KEYS = /^(token|access_token|refresh_token|id_token|api_?key|apikey|secret|password|passwd|pwd|auth|authorization|session|sessionid|sid|code|sign|signature|sig)$/i;

/**
 * URL 脱敏：去掉 user:pass@ 与敏感 query 值，保留路径与其余参数。
 * 为什么要做：日志会进面板、进 API、进磁盘；把 token 抄进去等于把凭据留在截图里。
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeUrl(raw) {
  const text = String(raw == null ? '' : raw);
  if (!text) return text;
  let out = text;
  try {
    const u = new URL(text, typeof location !== 'undefined' ? location.href : 'http://x/');
    if (u.username || u.password) { u.username = '***'; u.password = ''; }
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_KEYS.test(key)) u.searchParams.set(key, '***');
    }
    out = u.toString();
    // 相对地址保持相对（避免把 http://host 前缀写进日志）
    if (/^https?:\/\//i.test(text) === false && out.startsWith(u.origin)) out = out.slice(u.origin.length) || '/';
  } catch {
    out = text.replace(/([?&][^=&]*(?:token|key|secret|password|code|sign)[^=&]*=)[^&]*/gi, '$1***');
  }
  return out;
}

/** 请求体脱敏：只保留键名，值一律 ***（请求体里最可能藏凭据） */
function sanitizeBodyKeys(body) {
  if (!body || typeof body !== 'object') return null;
  try {
    const out = {};
    for (const k of Object.keys(body).slice(0, 20)) out[k] = SENSITIVE_KEYS.test(k) ? '***' : '[omitted]';
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 采集：网络

/** 诊断自身的上报请求不能被采集（否则失败时会自我放大） */
const SELF_URL_RE = /^\/api\/diag(?:[?#]|$)/;

/** 记一条网络失败（状态码或异常） */
function pushNet(st, method, url, status, err) {
  const safe = sanitizeUrl(url);
  if (status >= 400) {
    push(st, 'warn', 'net', 'http.error', { method, status, url: safe });
  } else if (err) {
    push(st, 'error', 'net', 'net.fail', { method, url: safe, error: String(err && err.message || err).slice(0, 200) });
  }
}

/** 采集网络失败：包装 fetch 与 XHR（只记 ≥400 与请求失败，不记成功请求） */
function captureNetwork(st) {
  if (typeof window === 'undefined') return;
  // fetch：保留原引用，异常/状态码都记一条
  if (typeof window.fetch === 'function' && !window.fetch.__diagWrapped) {
    const origin = window.fetch;
    const wrapped = function diagFetch(input, init) {
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const url = typeof input === 'string' ? input : String((input && input.url) || '');
      return origin.apply(this, arguments).then((res) => {
        try {
          if (!st.internal && !SELF_URL_RE.test(url) && res && res.status >= 400) {
            pushNet(st, method, url, res.status, null);
          }
        } catch { /* 忽略 */ }
        return res;
      }, (err) => {
        try { if (!SELF_URL_RE.test(url)) pushNet(st, method, url, 0, err); } catch { /* 忽略 */ }
        throw err;
      });
    };
    wrapped.__diagWrapped = true;
    try { window.fetch = wrapped; } catch { /* 只读环境放弃 */ }
  }
  // XHR：只挂 loadend（status 0 表示网络层失败）
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && !XHR.prototype.__diagWrapped) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    try {
      XHR.prototype.open = function diagOpen(method, url) {
        try { this.__diagMeta = { method: String(method || 'GET').toUpperCase(), url: String(url || '') }; } catch { /* 忽略 */ }
        return open.apply(this, arguments);
      };
      XHR.prototype.send = function diagSend() {
        try {
          const meta = this.__diagMeta;
          if (meta && !SELF_URL_RE.test(meta.url)) {
            this.addEventListener('loadend', () => {
              try {
                const stt = Number(this.status) || 0;
                if (stt >= 400 || stt === 0) pushNet(st, meta.method, meta.url, stt, stt === 0 ? new Error('network error') : null);
              } catch { /* 忽略 */ }
            });
          }
        } catch { /* 忽略 */ }
        return send.apply(this, arguments);
      };
      XHR.prototype.__diagWrapped = true;
    } catch { /* 只读环境放弃 */ }
  }
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
    push(st, 'debug', 'stage', 'interaction', { kind: 'wheel', deltaY: ev.deltaY, ctrl: ev.ctrlKey });
  }), { passive: true });

  window.addEventListener('pointerdown', throttled((ev) => {
    push(st, 'debug', 'stage', 'interaction', { kind: 'pointerdown', x: ev.clientX, y: ev.clientY, button: ev.button });
  }), { passive: true });

  // 页面隐藏时补一次落盘（关标签/切后台时最后一批不至于丢）
  window.addEventListener('pagehide', () => { try { flush(st); } catch { /* 忽略 */ } });
}

// ---------------------------------------------------------------- 对外接口

/** 组装 window.__DIAG__（API 名称稳定，供外部脚本与测试复用） */
function createApi(st) {
  return {
    __installed: true,
    /** 本页会话 id（GET /api/diag?sid=… 用它取"当前这一轮"的条目） */
    get sid() { return st.sid; },
    config: st.config,
    /** 业务主动上报事件（如 model.mount / stage.load） */
    event(event, data, extra) {
      return push(st, (extra && extra.level) || 'info', (extra && extra.src) || 'app', event, data, extra);
    },
    /**
     * 注册订阅者：每产生一条事件就同步收到（面板转发用）。
     * 同一函数重复注册只生效一次（Set 语义）；返回取消订阅函数。
     * @param {(entry: object) => void} fn
     * @returns {() => void}
     */
    addSink(fn) {
      if (typeof fn !== 'function') return () => {};
      st.sinks.add(fn);
      return () => { st.sinks.delete(fn); };
    },
    removeSink(fn) { return st.sinks.delete(fn); },
    /**
     * 从服务端读回**当前这一轮**（本页实例）的条目。
     *
     * 为什么必须带 sid：GET /api/diag 不带 sid 时后端只能兜底"最近活跃会话"，
     *   多标签页/重载过的场景会读到**上一轮**的数据，排查时极易误判。
     * 返回里带 sidSource（query/latest/none）——拿到 latest 就说明本页还没上报过或已过期。
     * @param {{limit?: number}} [options]
     * @returns {Promise<object>} 与 GET /api/diag 同结构
     */
    async readServer(options = {}) {
      const qs = new URLSearchParams();
      qs.set('sid', st.sid);
      if (options.limit) qs.set('limit', String(options.limit));
      // 带超时：这是诊断链路，服务端卡住时不能把调用方的 await 一起拖死（也不该为此起重试风暴）
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(5000)
        : undefined;
      const res = await fetch(`/api/diag?${qs.toString()}`, { headers: { Accept: 'application/json' }, signal });
      if (!res.ok) throw new Error(`GET /api/diag 失败：HTTP ${res.status}`);
      return res.json();
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
  captureNetwork(st);

  const api = createApi(st);
  window.__DIAG__ = api;
  push(st, 'info', 'diag', 'diag.ready', { capacity: st.config.capacity, href: location.href });
  return api;
}
