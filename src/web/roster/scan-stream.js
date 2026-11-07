// roster/scan-stream.js —— 扫描进度：NDJSON 流读取 + 状态机 + 状态行文案（纯逻辑，不碰 DOM）
//
// 为什么单独成模块：
//   ① 流读取（逐行切帧）与"什么时候算卡住"是可以脱离 DOM 单测的纯逻辑；
//   ② 视图层只做"把文案贴到游戏行的状态位上"，两者分开才好测（有 node 单测，见 test/scan-stream.test.mjs）。
//
// 数据形状（设计 §5.2，一帧一行 NDJSON）：
//   start    { kind, rootId, rootPath, startedAt }
//   progress { scanned, dirs, currentPath, elapsedMs }
//   done     { count, cached:false, elapsedMs }
//   cached   { count, ts }
//   error    { message, scanned, currentPath }
//
// 关键点：**P0 的流只带进度，不带模型数据**。拿到 done/cached 之后，模型清单仍走原来的
//   `/api/catalog` 一次请求（那时服务端已落盘，命中缓存很快）。

import { SCAN_STALL_MS, resolveScanStallMs } from '../../shared/scan-limits.mjs';

/** 哪些内容类型有"扫描"这一说（其余类型没有对应端点，直接跳过进度） */
const SCAN_KINDS = new Set(['spine', 'live2d']);

/**
 * 该根要用哪条流式端点；没有对应扫描端点时返回 null（调用方直接走普通 JSON）。
 * @param {{id: string, kind?: string}} root
 * @param {{base?: string}} [opts]
 * @returns {string|null}
 */
export function scanStreamUrl(root, opts = {}) {
  const id = root && root.id ? String(root.id) : '';
  const kind = root && root.kind ? String(root.kind) : '';
  if (!id || !SCAN_KINDS.has(kind)) return null;
  const base = (opts && opts.base) || '';
  return `${base}/api/${kind}/models?root=${encodeURIComponent(id)}&stream=1`;
}

/**
 * 逐帧读 NDJSON。
 *
 * 为什么手写切行而不是 TextDecoderStream 管道：一行可能被任意切在两次 read 之间，
 *   必须自己攒 buffer；手写也只有十几行，行为可控（尾行残缺时不抛错，直接丢弃）。
 *
 * @param {Response} response fetch 的响应（必须是流式的 body）
 * @param {(frame: object) => void} onFrame 每解析出一帧回调一次
 * @returns {Promise<void>} 流结束（正常结束或 body 读空）
 */
export async function readNdjsonStream(response, onFrame) {
  const body = response && response.body;
  if (!body || typeof body.getReader !== 'function') return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const emit = (line) => {
    const text = line.trim();
    if (!text) return;
    let frame;
    try { frame = JSON.parse(text); } catch { return; }   // 坏行丢掉：进度是增强，不能因一行脏数据中断
    if (frame && typeof frame === 'object') onFrame(frame);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf('\n');
    while (cut >= 0) {
      emit(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  emit(buffer);
}

/**
 * 扫描状态机：idle → scanning → (loaded | stalled ⇄ scanning | failed)。
 *
 * 判死规则（设计 §7.3）：收到**任意一帧**就重置计时；超阈值 ⇒ stalled，**只改状态与文案，
 *   不自动取消请求**（服务端可能只是慢；自动取消会把"慢"变成"失败"）。
 * 定时器/时钟都可注入，便于单测（不引入假定时器库）。
 *
 * @param {{stallMs?: number, now?: () => number, setTimer?: Function, clearTimer?: Function,
 *          onChange?: (snap: object) => void}} [opts]
 */
export function createScanMonitor(opts = {}) {
  const stallMs = resolveScanStallMs(opts.stallMs != null ? opts.stallMs : SCAN_STALL_MS);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const setTimer = typeof opts.setTimer === 'function' ? opts.setTimer : ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = typeof opts.clearTimer === 'function' ? opts.clearTimer : ((t) => clearTimeout(t));
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

  const snap = {
    phase: 'idle',       // idle | scanning | stalled | failed | loaded
    scanned: 0,
    dirs: 0,
    currentPath: '',
    stalledFor: 0,       // 已无进展多久（只在 stalled 时有意义）
    message: '',         // failed 的原因
    lastFrameAt: 0,
  };
  let stallTimer = null;
  let tickTimer = null;   // stalled 期间每秒刷新"已 N 秒无进展"
  let phaseBeforeStall = null;

  const emit = () => { try { onChange({ ...snap }); } catch { /* 视图回调出错不影响状态机 */ } };

  const clearTimers = () => {
    if (stallTimer !== null) { clearTimer(stallTimer); stallTimer = null; }
    if (tickTimer !== null) { clearTimer(tickTimer); tickTimer = null; }
  };

  const armStall = () => {
    if (stallTimer !== null) clearTimer(stallTimer);
    stallTimer = setTimer(() => {
      stallTimer = null;
      if (snap.phase !== 'scanning') return;
      phaseBeforeStall = snap.phase;
      snap.phase = 'stalled';
      snap.stalledFor = Math.max(0, now() - snap.lastFrameAt);
      emit();
      // 每秒刷新一次"已 N 秒无进展"，让用户看到时间在走（状态本身不变）
      tickTimer = setTimer(function tick() {
        tickTimer = null;
        if (snap.phase !== 'stalled') return;
        snap.stalledFor = Math.max(0, now() - snap.lastFrameAt);
        emit();
        tickTimer = setTimer(tick, 1000);
      }, 1000);
    }, stallMs);
  };

  /** 收到一帧之前先更新"最后收到帧的时间"并（必要时）从 stalled 回到 scanning */
  const touch = () => {
    snap.lastFrameAt = now();
    if (snap.phase === 'stalled') {
      snap.phase = 'scanning';
      snap.stalledFor = 0;
      if (tickTimer !== null) { clearTimer(tickTimer); tickTimer = null; }
      phaseBeforeStall = null;
    }
    if (snap.phase === 'scanning') armStall();
  };

  return {
    get state() { return { ...snap }; },

    /** 开始一次（或重试一次）扫描：计数清零、状态回 scanning、重新起判死计时 */
    begin() {
      clearTimers();
      snap.phase = 'scanning';
      snap.scanned = 0;
      snap.dirs = 0;
      snap.currentPath = '';
      snap.stalledFor = 0;
      snap.message = '';
      snap.lastFrameAt = now();
      phaseBeforeStall = null;
      armStall();
      emit();
    },

    /** 处理一帧：任何帧都算"还活着"（含 error/done，它们之后的状态由帧类型决定） */
    frame(frame) {
      if (!frame || typeof frame !== 'object') return;
      const type = String(frame.type || '');
      if (type === 'error') {
        // 失败也是"有响应"，先重置计时再落状态，避免刚收到 error 就被判成卡住
        snap.lastFrameAt = now();
        clearTimers();
        snap.phase = 'failed';
        snap.message = String(frame.message || '扫描失败（服务端未给原因）');
        if (Number.isFinite(Number(frame.scanned))) snap.scanned = Number(frame.scanned);
        if (frame.currentPath) snap.currentPath = String(frame.currentPath);
        emit();
        return;
      }
      if (type === 'done' || type === 'cached') {
        snap.lastFrameAt = now();
        clearTimers();
        snap.phase = 'loaded';
        if (Number.isFinite(Number(frame.count))) snap.scanned = Number(frame.count);
        snap.currentPath = '';
        emit();
        return;
      }
      if (type === 'progress') {
        if (Number.isFinite(Number(frame.scanned))) snap.scanned = Number(frame.scanned);
        if (Number.isFinite(Number(frame.dirs))) snap.dirs = Number(frame.dirs);
        if (frame.currentPath) snap.currentPath = String(frame.currentPath);
        touch();
        emit();
        return;
      }
      // start 与未知帧：只算"活着的证据"
      if (type === 'start' && frame.rootId) snap.currentPath = '';
      touch();
      emit();
    },

    /** 请求层失败（非 error 帧：网络断了 / 非 2xx） */
    fail(message) {
      clearTimers();
      snap.phase = 'failed';
      snap.message = String(message || '扫描请求失败');
      emit();
    },

    /** 流结束但没有 done/cached/error（连接被对端关掉）：按失败处理，别假装完成 */
    end() {
      if (snap.phase === 'loaded' || snap.phase === 'failed') return;
      clearTimers();
      snap.phase = 'failed';
      snap.message = '进度流提前结束（未收到完成帧）';
      emit();
    },

    /** 主动停止（关流/换游戏）：不产生任何状态变更 */
    abort() { clearTimers(); },
  };
}

/**
 * 把"已完成根的计数"并入基线（单调不减的来源）。
 *
 * 为什么需要基线：同一个游戏挂着多个根时是**逐根扫**的 —— 第一根扫完后它就从活跃集合里消失，
 *   若聚合只统计活跃根，总数会从"135 条"掉回"0 条"，看起来像重来了一次。
 *   所以每根结束时把它的最终计数累加进基线，聚合 = 基线 + 活跃根。
 *
 * @param {{scanned:number, dirs:number}|null} baseline
 * @param {{scanned?:number, dirs?:number}} snap 刚结束那根的最终快照
 * @returns {{scanned:number, dirs:number}}
 */
export function mergeScanBaseline(baseline, snap) {
  const base = baseline || { scanned: 0, dirs: 0 };
  return {
    scanned: (base.scanned || 0) + (Number(snap && snap.scanned) || 0),
    dirs: (base.dirs || 0) + (Number(snap && snap.dirs) || 0),
  };
}

/**
 * 聚合一个游戏下所有**活跃**扫描（多根并行/串行时共用一行状态）。
 *
 * 阶段优先级：scanning > stalled > failed > loaded
 *   —— 只要还有一根在出帧，整体就算"扫描中"；否则才报卡住/失败。
 *      （反过来的话，一根卡住而另一根仍在推进时会误报 stalled，正是设计 §7.3 要避免的误判）
 * 计数：基线（已完成根）+ 所有活跃根之和 ⇒ 对用户而言单调不减。
 *
 * @param {Array<object>} snaps 活跃根的状态快照（createScanMonitor().state）
 * @param {{scanned:number, dirs:number}} [baseline]
 * @returns {object|null} null = 没有活跃扫描（调用方保持现状/交给正常渲染）
 */
export function aggregateScanSnapshots(snaps, baseline) {
  const active = Array.isArray(snaps) ? snaps.filter(Boolean) : [];
  if (!active.length) return null;
  const has = (phase) => active.some((snap) => snap.phase === phase);
  const phase = has('scanning') ? 'scanning' : has('stalled') ? 'stalled' : has('failed') ? 'failed' : 'loaded';
  const base = baseline || { scanned: 0, dirs: 0 };
  // 只累加**还在跑**的根：已 loaded 的根其计数已经并入基线，再算一次会翻倍
  const running = active.filter((snap) => snap.phase !== 'loaded');
  const sum = (key) => running.reduce((n, snap) => n + (Number(snap[key]) || 0), 0);
  const stalledSnap = active.find((snap) => snap.phase === 'stalled') || null;
  const failedSnap = active.find((snap) => snap.phase === 'failed') || null;
  const scanningSnap = active.find((snap) => snap.phase === 'scanning') || null;
  return {
    phase,
    scanned: (base.scanned || 0) + sum('scanned'),
    dirs: (base.dirs || 0) + sum('dirs'),
    currentPath: (stalledSnap && stalledSnap.currentPath) || (failedSnap && failedSnap.currentPath)
      || (scanningSnap && scanningSnap.currentPath) || '',
    stalledFor: Math.max(0, ...active.map((snap) => Number(snap.stalledFor) || 0)),
    message: (failedSnap && failedSnap.message) || '',
  };
}

/**
 * **游戏行状态的唯一判定**（单一真相）。
 *
 * 为什么必须只有一处：曾经行上的状态位来自"扫描监控"，而"加载失败 · 重试"来自 catalog 的 entry.status，
 *   两者各画一套 ⇒ 同一行同时出现「扫描中 · 已读取 89 条」和「加载失败 · 重试」，
 *   用户看到的是"明明还在读却说失败"。这里把两个来源合成一个枚举，视图只认它。
 *
 * 优先级（高 → 低）：
 *   scanning   扫描流活着（未 stalled）⇒ 只能是"扫描中"，**绝不允许同时显示失败**
 *   stalled    流超过阈值无帧 ⇒ 显示"疑似卡住"（可重试）
 *   loading    没有流在跑，但有根正在取清单
 *   error      取清单失败且**没有**活跃扫描（这才是真失败）
 *   ready      至少一个根有数据
 *   idle       从没加载过
 *
 * @param {{scan?: object|null, rootStates?: string[]}} input
 *        scan = aggregateScanSnapshots(...) 的返回值；rootStates = 每个根的 entry.status
 * @returns {'scanning'|'stalled'|'loading'|'error'|'ready'|'idle'}
 */
export function resolveGamePhase({ scan, rootStates } = {}) {
  const states = Array.isArray(rootStates) ? rootStates.filter(Boolean) : [];
  const phase = scan && scan.phase ? String(scan.phase) : '';
  // 流在推进：无论 catalog 那边报什么，行状态只能是扫描中
  if (phase === 'scanning') return 'scanning';
  if (phase === 'stalled') return 'stalled';
  if (states.includes('loading')) return 'loading';
  if (states.length && states.every((state) => state === 'error')) return 'error';
  if (states.includes('error') && !states.includes('ready') && !states.includes('loading')) return 'error';
  if (states.includes('ready')) return 'ready';
  if (phase === 'failed') return 'error';
  if (states.includes('idle') || !states.length) return 'idle';
  return 'ready';
}

/**
 * catalog 失败时该不该"暂缓判死"。
 *
 * 判据只有一条：该根的扫描流**仍在推进**（phase='scanning'）⇒ 清单没回来是"还在扫"，
 *   不是"失败了"；应当保持 loading，等 done 帧后自动补取一次。
 * 流已 stalled（超过阈值无帧）/ failed / 已结束 ⇒ 不再等，按失败处理。
 * @param {string} scanPhase createScanMonitor().state.phase
 * @returns {boolean}
 */
export function shouldDeferCatalogFailure(scanPhase) {
  return String(scanPhase || '') === 'scanning';
}

/**
 * 状态行文案（设计 §7.2）。返回 '' 表示"不显示额外提示"（交给原有渲染）。
 * @param {object} snap createScanMonitor().state
 * @returns {string}
 */
export function formatScanStatus(snap) {
  if (!snap) return '';
  if (snap.phase === 'scanning') {
    return `扫描中 · 已读取 ${snap.scanned} 条 / ${snap.dirs} 个目录`;
  }
  if (snap.phase === 'stalled') {
    const seconds = Math.max(1, Math.round(snap.stalledFor / 1000));
    const where = snap.currentPath ? ` · 当前 ${snap.currentPath}` : '';
    return `疑似卡住 · 已读取 ${snap.scanned} 条 · ${seconds} 秒无进展${where}`;
  }
  if (snap.phase === 'failed') {
    return `扫描失败 · ${snap.message || '未知原因'}`;
  }
  return '';
}

/** 该状态是否需要显示〔重试〕按钮 */
export function scanNeedsRetry(snap) {
  return !!snap && (snap.phase === 'stalled' || snap.phase === 'failed');
}
