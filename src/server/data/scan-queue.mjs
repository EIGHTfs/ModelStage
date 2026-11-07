// data/scan-queue.mjs —— 扫描的并发上限、FIFO 队列、以及"有交互请求在等"的让路提示（P0 退化修复）
//
// 为什么需要这个模块：
//   P0 把扫描改成 async 分片让出之后，**多个根的扫描从"自然串行"变成了并发** ——
//   页面一次加载会同时对 9 个根发 catalog，于是 9 份扫描一起抢 CIFS/磁盘 IO，
//   事件循环被切碎到连 `/plugins/*.js` 静态文件都拿不到（实测 P95 984ms、最大 6464ms，
//   9 个 catalog 里 6 个 120s 超时）。
//
// 三道闸门（按生效顺序）：
//   ① **并发上限**：全局同时只允许 CONCURRENCY 个根在扫，其余 FIFO 排队。
//      这一条就把"9 倍压力"压回"1 倍"，是 ROI 最高的一步。
//   ② **让路提示**：有 HTTP 请求在途时（`inflight > 0`），扫描把每 tick 的时间预算调小，
//      优先把事件循环还给 HTTP/静态文件。与既有的"后台形态探测让路"同一思路。
//   ③ **排队可见**：排队中的 stream 请求立刻收到一帧 `{type:'queued', position}`，
//      而不是黑着屏等 120s 让人以为死了。

/** 同时允许几个根在扫。1 = 完全串行（最保守，也最能保证交互 P95）。 */
const CONCURRENCY = 1;

/** 在途 HTTP 请求数（由 serve.mjs 在请求开始/结束时同步进来） */
let inflightRequests = 0;

/** 排队表：{ key, resolve }，先进先出 */
const waiting = [];
/** 当前在扫的数量 */
let activeCount = 0;

/** 供 serve.mjs 调用：请求开始 */
export function noteRequestStart() {
  inflightRequests += 1;
}

/** 供 serve.mjs 调用：请求结束（含异常路径，必须成对） */
export function noteRequestEnd() {
  inflightRequests = Math.max(0, inflightRequests - 1);
}

/**
 * 当前是否有交互请求在等 —— 扫描据此决定"每 tick 干多少活"。
 * 为什么用"在途请求数"而不是"距上次请求多久"：在途数是**现在**的事实，
 *   时间差是**过去**的推断；长请求（解包、大文件）期间时间差会误判为"没人"。
 * @returns {boolean}
 */
export function isInteractiveBusy() {
  // **>1 而不是 >0**：触发扫描的那个 HTTP 请求自己就让计数 >=1，用 >0 会恒真 ⇒
  //   扫描永远走"更频繁让出"分支（实测单根从 24s 恶化到 47s）。
  //   >1 的意思才是"除了发起者，还有别的交互请求在等"。
  return inflightRequests > 1;
}

/** 诊断用：当前在扫几个、排队几个、在途请求几个 */
export function scanQueueStats() {
  return { active: activeCount, queued: waiting.length, inflightRequests, concurrency: CONCURRENCY };
}

/**
 * 申请一个扫描槽位。满员时排队（FIFO），轮到时 resolve。
 *
 * @param {string} key 去重键（`spine:<rootId>` / `live2d:<rootId>`）。同一 key 只会排一次。
 * @param {(position: number) => void} [onQueued] 刚被排入队列时回调（用于给 stream 发 queued 帧）
 * @returns {Promise<void>}
 */
export function acquireScanSlot(key, onQueued) {
  // ① 空闲：直接占位
  if (activeCount < CONCURRENCY && waiting.length === 0) {
    activeCount += 1;
    return Promise.resolve();
  }
  // ② 已经在排队：复用同一个位置（同一 kind:rootId 不重复排队）
  const dup = waiting.find((w) => w.key === key);
  if (dup) {
    if (onQueued) onQueued(waiting.indexOf(dup) + 1);
    return dup.promise;
  }
  // ③ 排队
  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  const entry = { key, resolve: resolveFn, promise };
  waiting.push(entry);
  if (onQueued) onQueued(waiting.length);
  return promise;
}

/**
 * 释放扫描槽位并唤醒队首。
 * 必须与 acquireScanSlot 成对（放在 finally 里 —— 扫描抛错不能把槽位永久占死）。
 */
export function releaseScanSlot() {
  activeCount = Math.max(0, activeCount - 1);
  if (activeCount < CONCURRENCY) {
    const next = waiting.shift();
    if (next) {
      activeCount += 1;
      next.resolve();
    }
  }
}

export { CONCURRENCY };
