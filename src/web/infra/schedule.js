// infra/schedule.js —— rAF 合批调度内核（从 roster/view.js 抽出，行为一字不改）
// 三条性质（原实现已验证，抽出来一条都不许丢）：
//   ① 不漏最后一帧：pending 只在真正 run() 之后清除；另有 flush() 强制落地
//   ② 不闪烁：同一帧内多次 request 只执行一次，因此只会更少中间态
//   ③ 后台标签页兜底：rAF 被节流/不触发时用 120ms 定时器兜底，绝不让首屏永久空白
// 零依赖，不碰 DOM，不认识任何业务概念（"跑什么"由调用方决定）。

/** @param {() => void} run 要执行的动作 @param {{onRequest?: () => void}} [opts] onRequest 每次 request 时回调（计"请求次数"，不是"执行次数"） */
export function createScheduler(run, opts = {}) {
  const onRequest = typeof opts.onRequest === 'function' ? opts.onRequest : null;
  let pending = false; let rafId = null; let timer = null;

  /** 清掉已排队的调度：rAF 与兜底定时器都要清，否则会多跑一次 */
  function cancel() {
    if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    if (timer !== null) clearTimeout(timer);
    rafId = null; timer = null; pending = false;
  }

  /** 立刻执行（若有待执行请求）。幂等：没有 pending 时什么都不做 */
  function flush() {
    if (!pending) return;
    cancel();
    run();
  }

  /** 下一帧执行（同帧内多次调用合并为一次） */
  function request() {
    if (onRequest) onRequest();
    if (pending) return;
    pending = true;
    // 没有 rAF 的环境（node 测试 / 极老浏览器）同步跑，不能把请求丢掉
    if (typeof requestAnimationFrame !== 'function') { flush(); return; }
    rafId = requestAnimationFrame(() => { rafId = null; flush(); });
    // 兜底：后台标签页 / 被节流的 rAF 可能长时间不回调，绝不能让首屏永久空白
    timer = setTimeout(() => { timer = null; flush(); }, 120);
  }

  return { request, flush, cancel };
}
