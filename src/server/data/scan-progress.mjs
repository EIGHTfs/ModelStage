// data/scan-progress.mjs —— 扫描进度的单飞表 + NDJSON 帧写出（P0）
//
// 解决两个独立问题，放在一起是因为它们共享同一份"扫描生命周期"：
//   ① **单飞**：同一个资源的并发请求不该触发多次扫描（用户狂点刷新 / 两个标签页同时开）
//      —— 设计 §4.6。这张表 P1 的 JSONL 存储会原样复用。
//   ② **进度可见**：一次扫描在 CIFS 上可能要几十秒，没有进度用户只能猜"是不是卡死了"
//      —— 设计 §5/§6。P0 只发**进度**，模型数据仍走原 JSON 接口（不在这里塞数据行）。
//
// 为什么不复用项目的 SSE（/api/ready/stream）：
//   扫描是**一次性、单向、有明确终点**的。SSE 自带重连语义，前端一重连就会重复触发扫描
//   （即便有单飞也会多一次订阅与快照），反而制造问题。NDJSON 读 fetch().body.getReader() 即可，
//   断线就是断线，不会自己重来。

import { EventEmitter } from 'node:events';

/** 进度节流的三个触发条件（设计 §5.1：三者先到先发） */
const PROGRESS_EVERY_MODELS = 50;
const PROGRESS_HEARTBEAT_MS = 2000;
/** 扫描结束后 emitter 的保留期：让"迟到的订阅者"还能拿到 done 帧（设计 §4.6） */
const EMITTER_RETAIN_MS = 5000;

/**
 * 造一个进度节流器。walk 里调用 `bump(...)`，它自己决定这一条要不要真的发出去。
 *
 * 为什么要节流：一个大根有几万个目录，每条都发帧会把连接打满、前端也跟不上；
 *   但**不能只按条数节流** —— 遇到一个"空目录树"可能几十秒不新增模型，那样前端会以为卡死。
 *   所以心跳是独立的一条：即使 scanned 没变，每 2s 也要发一帧证明"还活着"。
 *
 * @param {object} opts
 * @param {(snap: object) => void} opts.onProgress 真正发帧的回调
 * @param {string} opts.kind 'spine' | 'live2d'
 * @param {string} opts.rootId 资源根 id
 * @param {() => number} [opts.now] 取时间（测试可注入）
 * @returns {{bump: (p: {scanned: number, dirs: number, currentPath: string}) => void, flush: () => void, snapshot: () => object}}
 */
export function createProgressThrottle({ onProgress, kind, rootId, now = Date.now }) {
  const startedAt = now();
  let lastSentAt = 0;
  let lastScannedSent = 0;
  let latest = { scanned: 0, dirs: 0, currentPath: '' };

  function buildSnapshot() {
    return {
      kind,
      rootId,
      scanned: latest.scanned,
      dirs: latest.dirs,
      currentPath: latest.currentPath,
      elapsedMs: now() - startedAt,
      phase: 'scan',
    };
  }

  function send() {
    lastSentAt = now();
    lastScannedSent = latest.scanned;
    onProgress(buildSnapshot());
  }

  /**
   * walk 里每完成一个目录 / 每累计若干模型调用一次。
   * @param {{scanned: number, dirs: number, currentPath: string, dirCompleted?: boolean}} p
   */
  function bump(p) {
    latest = { scanned: p.scanned, dirs: p.dirs, currentPath: p.currentPath || latest.currentPath };
    // 三者先到先发：目录完成 / 每 50 条 / 心跳到期
    const byDir = p.dirCompleted === true;
    const byCount = latest.scanned - lastScannedSent >= PROGRESS_EVERY_MODELS;
    const byHeartbeat = now() - lastSentAt >= PROGRESS_HEARTBEAT_MS;
    if (byDir || byCount || byHeartbeat) send();
  }

  /** 扫描结束前补发最后一帧（保证前端拿到最终计数，而不是停在某个中间值） */
  function flush() {
    if (latest.scanned !== lastScannedSent) send();
  }

  return { bump, flush, snapshot: buildSnapshot };
}

/**
 * 扫描单飞表。
 *
 * 语义（设计 §4.6）：
 *   · 第一个请求创建任务并广播事件
 *   · 后续请求**不新建任务**，挂到同一 emitter，并立刻收到一条 progress 快照
 *   · force=1 时若已有扫描在跑 ⇒ 复用（用户在 UI 上重复点重试不该变成双重扫描）
 *   · 任务结束 5s 后从表里摘掉（保留期给迟到订阅者）
 */
export function createScanRunner() {
  /** @type {Map<string, {emitter: EventEmitter, progress: object|null, done: boolean, startedAt: number}>} */
  const inflight = new Map();

  function keyOf(kind, rootId) {
    return `${kind}:${rootId}`;
  }

  /**
   * 加入或启动一次扫描。
   * @param {object} p
   * @param {string} p.kind
   * @param {string} p.rootId
   * @param {(onProgress: (snap: object) => void, onStart: () => void) => Promise<object>} p.run
   *   真正的扫描函数；它拿到的 onProgress 会转发到 emitter
   * @returns {{emitter: EventEmitter, progress: object|null, joined: boolean}}
   */
  function startOrJoin({ kind, rootId, run }) {
    const key = keyOf(kind, rootId);
    const existing = inflight.get(key);
    if (existing && !existing.done) {
      // 加入已有扫描：立刻给一条当前快照，前端不必等下一次节流触发
      return { emitter: existing.emitter, progress: existing.progress, joined: true };
    }

    const emitter = new EventEmitter();
    // 订阅者可能随时来去；默认上限 10 会在大并发时告警，调高避免噪音（真正泄漏由结尾 destroy 兜住）
    emitter.setMaxListeners(64);
    const entry = { emitter, progress: null, done: false, startedAt: Date.now() };
    inflight.set(key, entry);

    Promise.resolve()
      .then(() => run(
        (snap) => {
          entry.progress = snap;
          emitter.emit('progress', snap);
        },
        // onStart：让扫描函数在"确认要扫、但还没开始走目录"时就能把首帧推出去
        () => emitter.emit('start'),
      ))
      .then((result) => {
        entry.done = true;
        emitter.emit('done', result);
      })
      .catch((error) => {
        entry.done = true;
        emitter.emit('error', error);
      })
      .finally(() => {
        // 保留期：让"扫描刚结束才连上来"的订阅者也能拿到 done（否则它会永远等不到结束帧）
        setTimeout(() => {
          if (inflight.get(key) === entry) inflight.delete(key);
          emitter.removeAllListeners();
        }, EMITTER_RETAIN_MS).unref?.();
      });

    return { emitter, progress: null, joined: false };
  }

  /** 仅供测试/诊断：当前在跑的扫描 key 列表 */
  function activeKeys() {
    return [...inflight.keys()].filter((k) => !inflight.get(k).done);
  }

  return { startOrJoin, activeKeys, keyOf };
}

/**
 * 把一次扫描的生命周期写成 NDJSON 帧（设计 §6.2/6.3/6.4）。
 *
 * 三件事按这个顺序做，且都**不能抛错把连接搞崩**：
 *   · 写头（Content-Type: application/x-ndjson）
 *   · 先发 start（或 cached），再转发 progress，最后 done/error
 *   · 客户端断开 ⇒ 停止写帧，但**不取消扫描**（扫描继续跑完并落盘，下次请求就能命中缓存）
 *
 * @param {object} p
 * @param {import('node:http').ServerResponse} p.res
 * @param {object} p.startFrame 首帧（start 或 cached）
 * @param {EventEmitter} p.emitter 扫描事件的 emitter
 * @param {() => object} [p.buildDoneFrame] 把 run 的结果转成 done 帧
 * @returns {Promise<void>} 连接结束（正常写完或客户端断开）时 resolve
 */
export function streamScanFrames({ res, buildStartFrame, emitter, buildDoneFrame, buildCachedFrame }) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    // 进度流不能被任何中间层缓存，否则第二个用户会看到第一个人的旧进度
    'Cache-Control': 'no-store',
    // nginx 一类反代默认会缓冲响应体，缓冲后前端就看不到"逐帧到达"了 —— 显式关掉
    'X-Accel-Buffering': 'no',
  });

  let clientGone = false;
  let settled = false;

  function writeFrame(frame) {
    if (clientGone) return;
    try {
      res.write(`${JSON.stringify(frame)}\n`);
    } catch {
      // 写到已断开的 socket 会抛（EPIPE）——按"客户端走了"处理，静默停写
      clientGone = true;
    }
  }

  function finish(finalFrame) {
    if (settled) return;
    settled = true;
    if (finalFrame) writeFrame(finalFrame);
    if (!clientGone) {
      try { res.end(); } catch { /* 已断开：忽略 */ }
    }
  }

  // 客户端断开：只标记并清理监听，**不动扫描**
  res.on('close', () => {
    clientGone = true;
    emitter.removeListener('start', onStart);
    emitter.removeListener('progress', onProgress);
    emitter.removeListener('done', onDone);
    emitter.removeListener('error', onError);
    // 扫描本身由单飞表驱动，与这条连接无关 ⇒ 这里什么都不做就是"扫描继续"
  });

  // start 帧**不在开头预发**：因为"缓存命中"时根本没有扫描发生，先发 start 再发 cached 会自相矛盾
  //   （设计 §5.3 要求"start 必有 progress 跟随"）。改为在**第一条 progress 到来时**补发 ——
  //   那时扫描一定真的在跑。
  let startSent = false;
  // start 的**首选**触发点：调用方在"确认缓存未命中、马 上要开始扫描"时主动 emit('start')。
  //   为什么不能只靠"第一条 progress 才发"：扫描前还有一步 `indexRootFiles`（建全根索引）是同步的，
  //   在实测 bd2（431 条）上它占了 4.19s —— 那样首帧仍然要等 4s+，达不到"<2s 可见"的目标。
  function onStart() {
    if (startSent) return;
    startSent = true;
    if (buildStartFrame) writeFrame(buildStartFrame());
  }
  function onProgress(snap) {
    if (!startSent) {
      startSent = true;
      if (buildStartFrame) writeFrame(buildStartFrame());
    }
    writeFrame({ type: 'progress', ...snap });
  }
  function onDone(result) {
    // 缓存命中：一条 cached 帧后结束（不逐条发，也不发 start/progress）
    if (result && result.cached) {
      finish(buildCachedFrame ? buildCachedFrame(result) : { type: 'cached', count: result.models ? result.models.length : 0, ts: result.ts });
      return;
    }
    if (!startSent) {
      startSent = true;
      if (buildStartFrame) writeFrame(buildStartFrame());
    }
    finish(buildDoneFrame ? buildDoneFrame(result) : { type: 'done', count: result && result.models ? result.models.length : 0, cached: false });
  }
  function onError(error) {
    finish({
      type: 'error',
      message: (error && error.message) || String(error),
      // 出错时把"扫到哪了"一并带上，便于用户/我们自己判断是卡在某个路径
      scanned: null,
      currentPath: null,
    });
  }

  emitter.on('start', onStart);
  emitter.on('progress', onProgress);
  emitter.on('done', onDone);
  emitter.on('error', onError);

  return new Promise((resolve) => {
    res.on('close', resolve);
    res.on('finish', resolve);
  });
}
