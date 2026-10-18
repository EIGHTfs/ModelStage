// ============================================================================
// public/diag.js —— 前端内置诊断探针（window.__DIAG__）
//
// 目的：把「出问题时临时注入 console 探针」变成页面自带的能力 —— 前端自证、AI 直接读文件取证，
//   不再依赖「浏览器会话还开着」这个前提。
//
// 采集面（只收错误 / 警告 / 关键事件，**不做每帧采样**，避免探针本身变成性能问题）：
//   · window.onerror、unhandledrejection、资源加载失败（capture 阶段，覆盖 img/script/link）
//   · 包装 console.error / warn / info：幂等（重复注入只生效一次）、保留原引用、
//     内部日志不再触发采集（防自激递归）
//   · 关键事件：plugin.load / bundle.parse / model.mount / motion.fail / interaction
//     （前三个由补丁脚本主动调用 __DIAG__.event()；motion.fail 从框架告警自动结构化）
//
// 出口（三条并行，互不影响）：
//   · 内存环形缓冲：容量默认 500，见 __DIAG_CONFIG__ 配置点；满了丢最旧
//   · 落盘：批量 POST /api/diag → 服务端追加写 data/diag.jsonl（一行一条 JSON）
//     落盘失败静默降级为仅内存 —— 探针永远不能影响页面本身
//   · 面板：右栏「调试日志」开关开启时，把条目喂给原版日志面板（store.addLog）；
//     关闭时只停面板渲染，**采集与落盘继续**（避免出问题时没证据）
//
// 读取：window.__DIAG__.dump() / errors() / warnings() / timeline() / tail(n) / clear() / size()
// ============================================================================

'use strict';

// 脚本顶层用「带标签的块 + break」代替 IIFE 里的 return：
//   裸块内 return 属非法语法（IIFE 展开后必须改写早退路径），break 出标签块等价于提前结束安装。
diagInstall: {
  // 已注入过就直接跳出：补丁脚本可能被重复注入（服务端缓存策略变化/手工注入），必须幂等
  if (window.__DIAG__ && window.__DIAG__.__installed) break diagInstall;

  // ---------------------------------------------------------------------------
  // 配置点：容量与落盘节奏。页面可在 diag.js 之前设置 window.__DIAG_CONFIG__ 覆盖
  // ---------------------------------------------------------------------------
  const CONFIG = Object.assign({
    capacity: 500,        // 内存环形缓冲条数上限
    flushEveryMs: 1500,   // 落盘批量节奏
    flushBatchMax: 40,    // 单次最多提交多少条
    strMax: 200,          // 字符串截断长度
    arrMax: 8,            // 数组只留前 N 项摘要
    panelMaxPerSec: 5,    // 面板每秒最多新增条数（防止刷屏影响原版日志可读性）
    interactionMinMs: 500 // 交互事件低频采样阈值
  }, window.__DIAG_CONFIG__ || {});

  const T0 = Date.now();
  const buf = [];         // 环形缓冲（数组 + 超限 shift）
  let pending = [];       // 待落盘队列
  let flushTimer = null;
  let internal = false;   // 防自激：探针内部产生的 console 调用不再被采集
  let panelWindow = { sec: 0, n: 0 };
  let lastInteraction = 0;

  // ---------------------------------------------------------------------------
  // 值摘要：探针要能长期运行，任何大对象都不能原样塞进缓冲（否则内存会被日志吃掉）
  // ---------------------------------------------------------------------------
  function summarize(v, depth) {
    const d = depth || 0;
    try {
      if (v === null || v === undefined) return v;
      const t = typeof v;
      if (t === 'string') return v.length > CONFIG.strMax ? v.slice(0, CONFIG.strMax) + `…(+${v.length - CONFIG.strMax})` : v;
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
      if (v instanceof Error) return { name: v.name, message: summarize(v.message, d + 1), stack: v.stack ? summarize(String(v.stack).split('\n').slice(0, 4).join(' | '), d + 1) : null };
      // 普通对象：只保留浅层可读字段，避免循环引用与深树
      const out = {};
      const keys = Object.keys(v).slice(0, 16);
      for (const k of keys) {
        const val = v[k];
        if (typeof val === 'object' && val !== null && d + 1 >= 3) { out[k] = Array.isArray(val) ? `[Array(${val.length})]` : '[Object]'; continue; }
        out[k] = summarize(val, d + 1);
      }
      if (Object.keys(v).length > keys.length) out['…'] = `(+${Object.keys(v).length - keys.length} 键)`;
      return out;
    } catch (e) { return '[unserializable]'; }
  }

  function textOf(args) {
    try { return args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(summarize(a, 0)); } catch (e) { return String(a); } })())).join(' '); }
    catch (e) { return '[args]'; }
  }

  // ---------------------------------------------------------------------------
  // 条目与缓冲
  // ---------------------------------------------------------------------------
  function push(level, src, event, data, extra) {
    const e = Object.assign({
      t: new Date().toISOString(),
      tRel: Date.now() - T0,
      level, src, event,
      data: summarize(data, 0),
      model: null, plugin: null
    }, extra || {});
    buf.push(e);
    if (buf.length > CONFIG.capacity) buf.splice(0, buf.length - CONFIG.capacity);
    pending.push(e);
    if (pending.length > 400) pending.splice(0, pending.length - 400); // 极端情况下丢最旧，避免无限增长
    scheduleFlush();
    panelPush(e);
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
        keepalive: true
      }).catch(() => {}).finally(() => { internal = false; });
    } catch (e) { internal = false; }
  }

  // ---------------------------------------------------------------------------
  // 面板：复用原版日志面板（store.addLog），只在其开关开启时喂
  //   为什么用 store.addLog 而不是自己插 DOM：原版面板有自己的折叠/清空/条数逻辑，
  //   走它的入口才能与原有日志共存且不破坏其行为。
  // ---------------------------------------------------------------------------
  function panelPush(e) {
    try {
      const st = window.__SPINE_STORE__ && window.__SPINE_STORE__.getState ? window.__SPINE_STORE__.getState() : null;
      if (!st || !st.debugLogEnabled || typeof st.addLog !== 'function') return;
      const sec = Math.floor(Date.now() / 1000);
      if (panelWindow.sec !== sec) panelWindow = { sec, n: 0 };
      if (panelWindow.n >= CONFIG.panelMaxPerSec) return;   // 每秒上限，避免探针刷屏挤掉原版日志
      panelWindow.n += 1;
      const lvl = e.level === 'error' ? 'error' : (e.level === 'warn' ? 'warn' : 'info');
      const tag = e.event || e.src || 'diag';
      const msg = `${e.src}${e.event ? ' · ' + e.event : ''}${e.data ? ' · ' + (typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) : ''}`;
      internal = true;
      st.addLog(lvl, msg.slice(0, 300), tag);
      internal = false;
    } catch (err) { internal = false; }
  }

  // ---------------------------------------------------------------------------
  // 全局错误采集
  // ---------------------------------------------------------------------------
  window.addEventListener('error', (ev) => {
    try {
      const tg = ev && ev.target;
      // 资源加载失败：error 事件在目标元素上触发（capture 阶段才收得到），没有 message
      if (tg && tg !== window && (tg.tagName === 'IMG' || tg.tagName === 'SCRIPT' || tg.tagName === 'LINK' || tg.tagName === 'VIDEO' || tg.tagName === 'AUDIO')) {
        push('error', 'resource', 'resource.fail', { tag: tg.tagName, url: tg.currentSrc || tg.src || tg.href || '' });
        return;
      }
      push('error', 'window', 'error', { message: ev && ev.message, source: ev && ev.filename, line: ev && ev.lineno, col: ev && ev.colno, stack: ev && ev.error && ev.error.stack ? String(ev.error.stack).split('\n').slice(0, 5).join(' | ') : null });
    } catch (e) {}
  }, true);

  window.addEventListener('unhandledrejection', (ev) => {
    try {
      const r = ev && ev.reason;
      push('error', 'window', 'rejection', { reason: r instanceof Error ? { name: r.name, message: r.message, stack: r.stack ? String(r.stack).split('\n').slice(0, 5).join(' | ') : null } : r });
    } catch (e) {}
  });

  // ---------------------------------------------------------------------------
  // console 包装：幂等 + 保留原引用 + 防递归
  // ---------------------------------------------------------------------------
  const ORIG = { error: console.error, warn: console.warn, info: console.info };

  // 框架告警结构化：Cubism 的 MotionManager 在动作装载失败时打这条告警，
  //   它是「动作坏了」的第一现场信号，比事后看画面更可靠，故单独抽成 motion.fail 事件。
  const MOTION_FAIL_RE = /\[MotionManager\]\s*Failed to load motion/i;

  // 插件解析汇总日志结构化：unity-live2d-bundle 解析完成后会打一条自检摘要，形如
  //   「已解析 <名>：容器 v6/6.0，节点 N，对象 M，moc3 X B，physics3 Y B，纹理 …，动作 N 个/分组 …（clips C，…），
  //     曲线 输出 E/T（未知名哈希 …，不在参数表 …，单点补成两点 …，参数表白名单 …，…），Blob URL Z 个」
  // 把它抽成 bundle.parse 事件，省去人工读长日志；抓不到关键字段时保留 raw 原文，信息不丢。
  const BUNDLE_PARSE_RE = /已解析 .*?容器 v\d+/;
  function maybeBundleParse(text) {
    if (!BUNDLE_PARSE_RE.test(text)) return false;
    const one = (re) => { const m = text.match(re); return m ? m[1] : null; };
    const int = (re) => { const v = one(re); return v === null ? null : Number(v); };
    push('info', 'bundle', 'bundle.parse', {
      container: one(/容器 v(\d+\/[\d.]+)/),
      nodes: int(/节点 (\d+)/),
      objects: int(/对象 (\d+)/),
      moc3Bytes: int(/moc3 (\d+) B/),
      physicsBytes: int(/physics3 (\d+) B/),
      textures: one(/纹理 (.*?)，动作 /),
      motions: int(/动作 (\d+) 个/),
      motionGroups: one(/动作 \d+ 个\/分组 ([^（]+)/),
      clips: int(/clips (\d+)/),
      curves: one(/曲线 输出 (\d+\/\d+)/),
      whitelist: one(/参数表白名单 ([^，]+)/),
      blobUrls: int(/Blob URL (\d+) 个/),
      raw: text
    });
    return true;
  }

  function wrap(level) {
    return function (...args) {
      if (!internal) {
        try {
          const text = textOf(args);
          if (level === 'warn' && MOTION_FAIL_RE.test(text)) {
            // 例：Failed to load motion: <motion> for <url> / Cannot read properties of undefined ...
            const m = text.match(/Failed to load motion[:\s]*([^\s]+)/i);
            push('error', 'motion', 'motion.fail', {
              motion: m ? m[1] : null,
              url: (text.match(/https?:\/\/[^\s)]+/) || [null])[0],
              raw: text
            });
          } else if (level === 'info' && maybeBundleParse(text)) {
            // 已结构化成 bundle.parse，不再重复记一条裸 console
          } else {
            push(level, 'console', 'console', { text });
          }
        } catch (e) {}
      }
      return ORIG[level].apply(console, args);
    };
  }

  try {
    console.error = wrap('error');
    console.warn = wrap('warn');
    console.info = wrap('info');
  } catch (e) {}

  // ---------------------------------------------------------------------------
  // 交互低频采样：缩放/拖动只记「发生了什么」，不记每帧
  // ---------------------------------------------------------------------------
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
  window.addEventListener('pagehide', () => { try { flush(); } catch (e) {} });

  // ---------------------------------------------------------------------------
  // 对外接口
  // ---------------------------------------------------------------------------
  const api = {
    __installed: true,
    config: CONFIG,
    /** 补丁脚本主动上报事件（plugin.load / bundle.parse / model.mount 等） */
    event(event, data, extra) { return push((extra && extra.level) || 'info', (extra && extra.src) || 'app', event, data, extra); },
    dump() { return buf.slice(); },
    errors() { return buf.filter((e) => e.level === 'error'); },
    warnings() { return buf.filter((e) => e.level === 'warn'); },
    timeline() { return buf.map((e) => `${e.t} [${e.level}] ${e.src}${e.event ? '/' + e.event : ''}`); },
    tail(n) { return buf.slice(-(Number(n) || 20)); },
    clear() { buf.length = 0; pending = []; return true; },
    size() { return { buffered: buf.length, capacity: CONFIG.capacity, pendingFlush: pending.length, sinceMs: Date.now() - T0 }; },
    /** 供排查用：把当前缓冲整段落盘一次 */
    flushNow() { flush(); return true; }
  };
  window.__DIAG__ = api;

  push('info', 'diag', 'diag.ready', { capacity: CONFIG.capacity, href: location.href });
}
