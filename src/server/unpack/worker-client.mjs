// server/unpack/worker-client.mjs —— 主线程侧的 worker 句柄（常驻 1 个、串行、可自愈）
//
// 三条职责，都很窄：
//   ① 常驻复用：Node 起 worker 有几十 ms 开销，而解包本身秒级；每次新建还会让 vm 沙盒/插件
//      lib 重新装载一遍。这里只在"没句柄"时建，进程内一直复用。
//   ② 串行：内部一条 promise 链 —— worker 是单线程，同时 post 两条只会排队；显式串行让
//      "第二个请求在等第一个"这件事在代码里可读，也与上层 store 的 enqueue 语义一致（不并行解包，
//      并行会把进程内存峰值顶穿）。
//   ③ 自愈：卡死（硬超时）或崩溃（error/exit）都要把本次请求变成**可读错误**、把句柄置空，
//      下一次 run 自动重建 —— 绝不能让一个死掉的 worker 把队列永久堵住。
//
// 硬超时语义（写死在注释里，避免被误读成"包太大被拒"）：
//   120s 只用于**防死循环把队列永久堵住**，不是"约束合法解包"。
//   锚点包（azurlane_bundle/live2d/z46_2，解压 33.4MB 的 LZMA）实测墙钟 17.83s、unpackMs 9416ms，
//   120s 有 6.7 倍余量 —— 正常解包一辈子不该触发它。

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./unpack-worker.mjs', import.meta.url);

/**
 * @param {{
 *   rootDir: string,
 *   timeoutMs?: number,
 *   log?: (level: string, message: string, extra?: object) => void,
 * }} opts
 */
export function createUnpackWorkerClient(opts) {
  const rootDir = opts && opts.rootDir;
  if (!rootDir) throw new Error('createUnpackWorkerClient: rootDir 必填');
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120000;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  /** @type {Worker|null} */
  let worker = null;
  let seq = 0;
  /** @type {{id:number, resolve:Function, reject:Function, timer:any}|null} */
  let current = null;
  /** 内部串行链：保证同一时刻只有一条任务在 worker 里 */
  let chain = Promise.resolve();

  /** 只清理该 fp 自己的临时目录（writeResult 的命名规则），不扫整个 rootDir */
  function cleanupTmp(fp) {
    try {
      const prefix = `.tmp-${fp}-`;
      for (const name of fs.readdirSync(rootDir)) {
        if (!name.startsWith(prefix)) continue;
        const full = path.join(rootDir, name);
        try {
          fs.rmSync(full, { recursive: true, force: true });
          log('warn', `清理解包临时目录：${full}（上次 worker 被终止，产物未完成）`);
        } catch (e) {
          // 清理是尽力而为：失败只记日志，不许影响本次请求的错误返回
          log('warn', `清理临时目录失败：${full}（${(e && e.message) || e}）`);
        }
      }
    } catch (e) {
      log('warn', `扫描临时目录失败：${(e && e.message) || e}`);
    }
  }

  function onMessage(msg) {
    const cur = current;
    if (!cur || !msg || msg.id !== cur.id) return;   // 迟到/陌生消息：忽略（重建后可能收到旧 id）
    // 进度消息：**不终结请求** —— worker 后面还会发真正的回复（契约 §四·⑦）。
    //   所以这里 early return，绝不能落到下面的 clearTimeout + resolve。
    if (msg.progress) {
      if (typeof cur.onProgress === 'function') {
        try {
          cur.onProgress(msg.progress);
        } catch (e) {
          // 进度是旁路信息：回调抛错不能影响本次解包
          log('warn', `进度回调抛错（已忽略）：${(e && e.message) || e}`);
        }
      }
      return;
    }
    clearTimeout(cur.timer);
    current = null;
    cur.resolve(msg);
  }

  /** 该 worker 上的所有等待都失败（崩溃/退出路径） */
  function failCurrent(reason, detail) {
    const cur = current;
    if (!cur) return;
    clearTimeout(cur.timer);
    current = null;
    cur.reject(new Error(`${reason}：${detail}`));
  }

  function disposeWorker(reason) {
    const w = worker;
    worker = null;
    if (!w) return Promise.resolve();
    // 先把句柄置空再 terminate：exit 回调据此判断"是我们主动丢掉的"（见 ensureWorker 的 exit）
    return w.terminate().catch(() => undefined);
  }

  function ensureWorker() {
    if (worker) return worker;
    const w = new Worker(WORKER_URL, { workerData: { rootDir } });
    w.on('message', onMessage);
    w.on('error', (e) => {
      // worker 自己抛未捕获异常 ⇒ 该次请求 reject、句柄置空、下次重建
      failCurrent('unpack worker crashed', (e && e.message) || e);
      worker = null;
    });
    w.on('exit', (code) => {
      // 只有"它仍是当前句柄"才算意外退出：超时/close 路径会先把 worker 置空再 terminate，
      //   所以这里判断句柄归属比维护一个全局 terminating 标志更硬 —— 不依赖 exit 与 finally 的先后。
      const wasCurrent = worker === w;
      if (wasCurrent) worker = null;
      if (!wasCurrent) return;
      if (code !== 0) {
        failCurrent('unpack worker exited unexpectedly', `exit code ${code}`);
        log('warn', `解包 worker 异常退出（code ${code}），已丢弃句柄，下次请求将重建`);
      }
    });
    worker = w;
    return w;
  }

  /**
   * 跑一次解包。串行：前一个没完成时，调用方会在这条链上等待。
   * @param {object} task {rootId, rel, absPath, fp, meta, decl}
   * @param {{onProgress?: (p: {phase: string, ms: number|null}) => void}} [opts]
   *   onProgress：worker 线程里 exec 插件上报的进度帧会转成这个回调（可选）。
   *   为什么要回调而不是靠返回值：进度必须**边跑边报**，等 run() 回来就已经晚了。
   * @returns {Promise<object>} worker 的回复（ok:true 带 index，ok:false 带 reason/message）
   */
  function run(task, opts = {}) {
    const go = () => new Promise((resolve, reject) => {
      const w = ensureWorker();
      const id = (seq += 1);
      const fp = task.fp;
      const timer = setTimeout(() => {
        if (!current || current.id !== id) return;
        const waitedMs = timeoutMs;
        current = null;
        log('warn',
          `解包 worker 超时：${task.rootId}/${task.rel} 已等待 ${waitedMs}ms，正在终止并重建 worker`,
          { rootId: task.rootId, rel: task.rel, waitedMs });
        // 先置空句柄再 terminate：exit 回调据"句柄已不是它"判定为主动丢弃，不会再去 reject 已 reject 的请求
        const dead = worker;
        worker = null;
        Promise.resolve(dead && dead.terminate && dead.terminate()).catch(() => undefined);
        // 清理该 fp 的残留临时目录（writeResult 的 .tmp-<fp>-* 命名规则）
        cleanupTmp(fp);
        reject(new Error(`unpack worker timeout after ${timeoutMs}ms（本次解包未完成，已终止并重建 worker）`));
      }, timeoutMs);
      current = { id, resolve, reject, timer, onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null };
      try {
        w.postMessage({
          id,
          rootId: task.rootId,
          rel: task.rel,
          absPath: task.absPath,
          fp,
          meta: task.meta,
          decl: task.decl,
        });
      } catch (e) {
        clearTimeout(timer);
        current = null;
        reject(e);
      }
    });
    const next = chain.then(go, go);
    chain = next.then(() => undefined, () => undefined);
    return next;
  }

  /** 关掉 worker（进程退出/测试清理用） */
  async function close() {
    await disposeWorker('close');
  }

  return { run, close, get worker() { return worker; } };
}

export default createUnpackWorkerClient;
