// diag.js —— 前端内置诊断探针（window.__DIAG__），M4 前置
//
// 目的：把"出问题时临时注入 console 探针"变成页面自带的能力 —— 前端自证、AI/工具直接读文件取证，
//   不再依赖"浏览器会话还开着"这个前提。
//
// 采集面（只收错误 / 警告 / 关键事件，**不做每帧采样**，避免探针本身变成性能问题）：
//   · window.onerror（含资源加载失败，capture 阶段，覆盖 img/script/link/video/audio）
//   · unhandledrejection
//   · 包装 console.error / warn / info：幂等（重复注入只生效一次）、保留原引用、
//     内部日志不再触发采集（防自激递归）
//   · 关键事件：业务代码主动调用 __DIAG__.event(name, data)
//
// 出口（两条并行，互不影响）：
//   · 内存环形缓冲：容量默认 500，满了丢最旧
//   · 落盘：批量 POST /api/diag → 服务端追加写 data/diag.jsonl（一行一条 JSON）
//     落盘失败静默降级为仅内存 —— 探针永远不能影响页面本身
//   · 面板：本阶段不做（等 M6 有「调试日志」开关再喂）
//
// 读取：window.__DIAG__.dump() / errors() / warnings() / timeline() / tail(n) / clear() / size() / flushNow()
//
// 与旧前端 public/diag.js 的关系：**API 名称与语义逐字保持一致**，这样同一套检查代码能同时对
//   旧前端（8803）与新前端（8804）跑。差别只有两点：改 ES module 导出 installDiag()、去掉面板那一路。

/** 配置默认值（页面可在 installDiag 之前设置 window.__DIAG_CONFIG__ 覆盖） */
const DEFAULT_CONFIG = {
  capacity: 500,        // 内存环形缓冲条数上限
  flushEveryMs: 1500,   // 落盘批量节奏
  flushBatchMax: 40,    // 单次最多提交多少条
  strMax: 200,          // 字符串截断长度
  arrMax: 8,            // 数组只留前 N 项摘要
  interactionMinMs: 500, // 交互事件低频采样阈值
};

/** 框架告警结构化：Cubism 的 MotionManager 动作装载失败（Live2D 接入后才有，M5 用） */
const MOTION_FAIL_RE = /\[MotionManager\]\s*Failed to load motion/i;

/**
 * 安装探针（幂等：已安装则直接返回现有实例）。
 * @param {object} [override] 配置覆盖（优先级最高）
 * @returns {object} window.__DIAG__ 实例
 */
export function installDiag(override) {
  // 已注入过就直接返回：脚本可能被重复调用（热重载、手工注入），必须幂等
  if (window.__DIAG__ && window.__DIAG__.__installed) return window.__DIAG__;

  const CONFIG = Object.assign({}, DEFAULT_CONFIG, window.__DIAG_CONFIG__ || {}, override || {});
  const T0 = Date.now();
  const buf = [];       // 环形缓冲（数组 + 超限 splice）
  let pending = [];     // 待落盘队列
  let flushTimer = null;
  let internal = false; // 防自激：探针内部产生的 console 调用不再被采集
  let lastInteraction = 0;

  // ---------------------------------------------------------------- 值摘要

  /** 值摘要：探针要能长期运行，任何大对象都不能原样塞进缓冲（否则内存会被日志吃掉） */
  function summarize(v, depth) {
    const d = depth || 0;
    try {
      if (v === null || v === undefined) return v;
      const t = typeof v;
      if (t === 'string') {
        return v.length > CONFIG.strMax ? `${v.slice(0, CONFIG.strMax)}…(+${v.length - CONFIG.strMax})` : v;
      }
      if (t === 'number' || t === 'boolean') return v;
      if (t === 'function') return `[Function ${v.name || 'anonymous'}]`;
      if (t === 'symbol' || t === 'bigint') return String(v);
      // 二进制：只记字节数（纹理/顶点数据动辄几百 KB~几 MB）
      if (ArrayBuffer.isView(v)) return { bytes: v.byteLength, kind: v.constructor ? v.constructor.name : 'TypedArray' };
      if (v instanceof ArrayBuffer) return { bytes: v.byteLength, kind: 'ArrayBuffer' };
      if (d >= 3) return Array.isArray(v) ? `[Array(${v.length})]` : `{${Object.keys(v).slice(0, 5).join(',')}…}`;
      if (Array.isArray(v)) {
        const head = v.slice(0, CONFIG.arrMax).map((x) => summarize(x, d + 1));
        return v.length > CONFIG.arrMax ? head.concat([`…(+${v.length - CONFIG.arrMax})`]) : head;
      }
      if (v instanceof Error) {
        return {
          name: v.name,
          message: summarize(v.message, d + 1),
          stack: v.stack ? summarize(String(v.stack).split('\n').slice(0, 4).join(' | '), d + 1) : null,
        };
      }
      // 普通对象：只保留浅层可读字段，避免循环引用与深树
      const out = {};
      const keys = Object.keys(v).slice(0, 16);
      for (const k of keys) {
        const val = v[k];
        if (typeof val === 'object' && val !== null && d + 1 >= 3) {
          out[k] = Array.isArray(val) ? `[Array(${val.length})]` : '[Object]';
          continue;
        }
        out[k] = summarize(val, d + 1);
      }
      if (Object.keys(v).length > keys.length) out['…'] = `(+${Object.keys(v).length - keys.length} 键)`;
      return out;
    } catch {
      return '[unserializable]';
    }
  }

  /** 把 console 参数拼成一行文本（对象先摘要再 JSON，避免 [object Object]） */
  function textOf(args) {
    try {
      return args.map((a) => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(summarize(a, 0)); } catch { return String(a); }
      }).join(' ');
    } catch {
      return '[args]';
    }
  }

  // ---------------------------------------------------------------- 缓冲与落盘

  function push(level, src, event, data, extra) {
    const e = Object.assign({
      t: new Date().toISOString(),
      tRel: Date.now() - T0,
      level,
      src,
      event,
      data: summarize(data, 0),
      model: null,
      plugin: null,
    }, extra || {});
    buf.push(e);
    if (buf.length > CONFIG.capacity) buf.splice(0, buf.length - CONFIG.capacity);
    pending.push(e);
    // 极端情况下丢最旧，避免 pending 无限增长（服务端不可用时尤其重要）
    if (pending.length > 400) pending.splice(0, pending.length - 400);
    scheduleFlush();
    return e;
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, CONFIG.flushEveryMs);
  }

  /** 落盘：只追加、失败静默（探针不能因为服务端不可用而影响页面） */
  function flush() {
    if (!pending.length) return;
    const batch = pending.splice(0, CONFIG.flushBatchMax);
    try {
      internal = true;
      fetch('/api/diag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: batch }),
        keepalive: true,
      }).catch(() => {}).finally(() => { internal = false; });
    } catch { internal = false; }
  }

  // ---------------------------------------------------------------- 全局错误采集

  window.addEventListener('error', (ev) => {
    try {
      const tg = ev && ev.target;
      // 资源加载失败：error 事件在目标元素上触发（capture 阶段才收得到），没有 message
      if (tg && tg !== window && ['IMG', 'SCRIPT', 'LINK', 'VIDEO', 'AUDIO'].includes(tg.tagName)) {
        push('error', 'resource', 'resource.fail', {
          tag: tg.tagName,
          url: tg.currentSrc || tg.src || tg.href || '',
        });
        return;
      }
      push('error', 'window', 'error', {
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
      push('error', 'window', 'rejection', {
        reason: r instanceof Error
          ? { name: r.name, message: r.message, stack: r.stack ? String(r.stack).split('\n').slice(0, 5).join(' | ') : null }
          : r,
      });
    } catch { /* 同上 */ }
  });

  // ---------------------------------------------------------------- console 包装

  const ORIG = { error: console.error, warn: console.warn, info: console.info };

  /** 包装：幂等（装过一次就不再套第二层）、保留原引用、内部日志不自激 */
  function wrap(level) {
    const wrapped = function (...args) {
      if (!internal) {
        try {
          const text = textOf(args);
          if (level === 'warn' && MOTION_FAIL_RE.test(text)) {
            // 例：Failed to load motion: <motion> for <url>
            const m = text.match(/Failed to load motion[:\s]*([^\s]+)/i);
            push('error', 'motion', 'motion.fail', {
              motion: m ? m[1] : null,
              url: (text.match(/https?:\/\/[^\s)]+/) || [null])[0],
              raw: text,
            });
          } else {
            push(level, 'console', 'console', { text });
          }
        } catch { /* 采集失败不能影响原日志输出 */ }
      }
      return ORIG[level].apply(console, args);
    };
    wrapped.__diagWrapped = true;
    return wrapped;
  }

  try {
    console.error = wrap('error');
    console.warn = wrap('warn');
    console.info = wrap('info');
  } catch { /* 某些环境 console 只读：放弃包装，其余采集照旧 */ }

  // ---------------------------------------------------------------- 交互低频采样
  // 只记"发生了什么"，不记每帧（滚轮/按下各按 interactionMinMs 节流）

  window.addEventListener('wheel', (ev) => {
    const now = Date.now();
    if (now - lastInteraction < CONFIG.interactionMinMs) return;
    lastInteraction = now;
    push('info', 'stage', 'interaction', { kind: 'wheel', deltaY: ev.deltaY, ctrl: ev.ctrlKey });
  }, { passive: true });

  window.addEventListener('pointerdown', (ev) => {
    const now = Date.now();
    if (now - lastInteraction < CONFIG.interactionMinMs) return;
    lastInteraction = now;
    push('info', 'stage', 'interaction', { kind: 'pointerdown', x: ev.clientX, y: ev.clientY, button: ev.button });
  }, { passive: true });

  // 页面隐藏时补一次落盘（关标签/切后台时最后一批不至于丢）
  window.addEventListener('pagehide', () => { try { flush(); } catch { /* 忽略 */ } });

  // ---------------------------------------------------------------- 对外接口
  // API 名称与旧前端 public/diag.js 完全一致

  const api = {
    __installed: true,
    config: CONFIG,
    /** 业务主动上报事件（如 model.mount / stage.load） */
    event(event, data, extra) {
      return push((extra && extra.level) || 'info', (extra && extra.src) || 'app', event, data, extra);
    },
    dump() { return buf.slice(); },
    errors() { return buf.filter((e) => e.level === 'error'); },
    warnings() { return buf.filter((e) => e.level === 'warn'); },
    timeline() { return buf.map((e) => `${e.t} [${e.level}] ${e.src}${e.event ? `/${e.event}` : ''}`); },
    tail(n) { return buf.slice(-(Number(n) || 20)); },
    clear() { buf.length = 0; pending = []; return true; },
    size() {
      return {
        buffered: buf.length,
        capacity: CONFIG.capacity,
        pendingFlush: pending.length,
        sinceMs: Date.now() - T0,
      };
    },
    /** 供排查用：把当前缓冲整段落盘一次 */
    flushNow() { flush(); return true; },
  };
  window.__DIAG__ = api;

  push('info', 'diag', 'diag.ready', { capacity: CONFIG.capacity, href: location.href });
  return api;
}
