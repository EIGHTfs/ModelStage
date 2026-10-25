// test/lib/wait-ready.mjs —— 就绪信号等待工具（统一入口，别再各文件各写一份 waitFor）
//
// 为什么有两种形态：
//   · 本项目 test/*.js 是**页面内脚本**（tool/check-console.mjs 用 Runtime.evaluate 直跑文本，
//     不能 import），所以真正的等待逻辑必须是"页内源码"——见下方 IN_PAGE 常量；
//   · 同时提供 node 侧函数（waitStage/snapshotOf），给将来的 Playwright 式驱动或 node 断言用。
//
// 单一权威副本：IN_PAGE 这段文本会被 test/lib/apply-wait-ready.mjs 原样注入到各测试脚本的
//   `// [wait-ready] begin/end` 标记块里；test/lib/wait-ready.sync.test.mjs 会比对每个脚本的
//   副本与这里逐字节一致，防止"改了一处忘了另一处"（漂移门禁）。

/** 页内等待工具源码（注入到测试脚本里的唯一权威版本） */
export const IN_PAGE = `// [wait-ready] begin —— 由 test/lib/wait-ready.mjs 生成，勿手改（改源头后跑 apply-wait-ready）
  // 就绪信号等待：等级用 rank 比较（pending 0 < mounted 1 < painted/settled 2 < interactive 3）
  const READY_RANK = { pending: 0, mounted: 1, painted: 2, settled: 2, interactive: 3 };
  const readySnap = (stage) => {
    const w = window.__WEB__;
    if (!w || typeof w.ready !== 'function') return stage ? { stage, state: 'pending' } : { at: 0, rev: 0, stages: {} };
    return w.ready(stage);
  };
  // 等某阶段到达某级别。failed 立即抛（带 reason），绝不等到超时
  const waitStage = async (name, level = 'interactive', opts = {}) => {
    const timeoutMs = opts.timeoutMs || 8000;
    const pollMs = opts.pollMs || 50;
    const sinceAt = opts.sinceAt || 0;      // 传了就等"这一轮新发生的"（边沿等待）
    const want = READY_RANK[level] === undefined ? 3 : READY_RANK[level];
    const t0 = performance.now();
    for (;;) {
      const cur = readySnap(name) || { state: 'pending' };
      if (cur.state === 'failed') {
        throw new Error('等待 ' + name + ' → ' + level + ' 时进入 failed：' + (cur.reason || '(无 reason)') + '；快照=' + JSON.stringify(cur));
      }
      const rank = READY_RANK[cur.state] === undefined ? -1 : READY_RANK[cur.state];
      if (rank >= want && (cur.at || 0) > sinceAt) return cur;
      if (performance.now() - t0 > timeoutMs) {
        throw new Error('等待 ' + name + ' → ' + level + ' 超时(' + timeoutMs + 'ms)；当前 ' + JSON.stringify(cur));
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
  // 多个阶段任一到达（如 shell 或 renderer）
  const waitAny = async (names, level = 'interactive', opts = {}) => {
    const timeoutMs = opts.timeoutMs || 8000;
    const pollMs = opts.pollMs || 50;
    const sinceAt = opts.sinceAt || 0;
    const want = READY_RANK[level] === undefined ? 3 : READY_RANK[level];
    const t0 = performance.now();
    for (;;) {
      for (const n of names) {
        const cur = readySnap(n) || { state: 'pending' };
        if (cur.state === 'failed') throw new Error('等待 ' + n + '(任一) → ' + level + ' 时进入 failed：' + (cur.reason || '(无 reason)'));
        const rank = READY_RANK[cur.state] === undefined ? -1 : READY_RANK[cur.state];
        if (rank >= want && (cur.at || 0) > sinceAt) return { stage: n, ...cur };
      }
      if (performance.now() - t0 > timeoutMs) {
        const all = names.map((n) => { const c = readySnap(n) || { state: 'pending' }; return n + '=' + c.state; }).join(', ');
        throw new Error('等待任一 [' + names.join('/') + '] → ' + level + ' 超时(' + timeoutMs + 'ms)；当前 ' + all);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
  // 整份快照（断言与超时排错用）
  const snapshotOf = () => readySnap();
  /**
   * 等渲染真的又画了 n 帧（帧计数是产品自己的信号，不是猜时间）。
   *   适用：改 DPR / 换皮 / 开关调试层 / 切分区过滤 这类"改完要等下一帧才看得到效果"的场景。
   *   局限：它只证明"循环在跑"，不证明"绘制内容已经反映改动"；需要内容级判据时仍要配像素/状态断言。
   * @param {number} [n] 要等的新增帧数（默认 2 帧）
   * @param {{timeoutMs?: number, label?: string}} [opts]
   */
  const waitFrames = async (n = 2, opts = {}) => {
    const label = opts.label || ('渲染推进 ' + n + ' 帧');
    const web = window.__WEB__;
    const framesNow = () => {
      try { return (web && web.stage && web.stage.debug && web.stage.debug().frames) || 0; } catch (e) { return 0; }
    };
    const start = framesNow();
    return waitFor(() => framesNow() - start >= n, { timeoutMs: opts.timeoutMs || 3000, label });
  };

  /**
   * 「触发一次过渡 → 等若干阶段一起 settled」的包装器。
   *
   * 为什么要包装而不是让调用方自己记时刻：
   *   「const t = Date.now(); click(); waitStage(..., {sinceAt: t})」 这种写法**容易漏记、容易记错位置**，
   *   漏了 sinceAt 就会拿到旧值立刻返回（等于没等）。把触发动作与 sinceAt 绑在同一个调用里，漏不了。
   *
   * 为什么用 allSettled：某个阶段可能**永远等不到 settled**（例如影院模式下某栏不参与过渡），
   *   不能让一个不配合的阶段把整个等待拖死。默认：全部有结果才返回，失败的**不抛**、只回报；
   *   传 「tolerate:false」 才抛（需要严格失败时用）。
   *
   * @param {() => (void|Promise<void>)} trigger 触发动作（点击/切换）
   * @param {string[]} stages 要等的阶段名（topbar / sidebarLeft / sidebarRight …）
   * @param {{timeoutMs?: number, tolerate?: boolean}} [opts]
   * @returns {Promise<{ok: boolean, failed: Array<{name: string, error: string|null}>}>}
   */
  const afterTransition = async (trigger, stages, opts = {}) => {
    const sinceAt = Date.now();
    await trigger();
    const list = Array.isArray(stages) ? stages : [stages];
    const settled = await Promise.allSettled(
      list.map((name) => waitStage(name, 'settled', { sinceAt, timeoutMs: opts.timeoutMs || 3000 })),
    );
    const failed = settled
      .map((r, i) => ({ name: list[i], error: r.status === 'rejected' ? String((r.reason && r.reason.message) || r.reason) : null }))
      .filter((x) => x.error !== null);
    if (failed.length && opts.tolerate === false) {
      throw new Error('过渡等待失败：' + failed.map((f) => f.name + '(' + f.error + ')').join('; '));
    }
    return { ok: failed.length === 0, failed };
  };

  // 等「界面稳定」：连续 quietMs 内签名不变即返回。
  //   用于"点一下 → 等 DOM 重排/重绘落定"这类**没有专门阶段信号**的场景：
  //   它不是盲等（稳定就立刻返回），也不是猜（签名确实没变才放行）。
  const waitStable = async (getSig, opts = {}) => {
    const timeoutMs = opts.timeoutMs || 3000;
    const quietMs = opts.quietMs || 150;
    const pollMs = opts.pollMs || 60;
    const label = opts.label || '界面稳定';
    const t0 = performance.now();
    let last = null;
    let since = performance.now();
    for (;;) {
      let sig = null;
      try { sig = JSON.stringify(getSig()); } catch { sig = null; }
      const now = performance.now();
      if (sig !== null && sig === last) {
        if (now - since >= quietMs) return true;
      } else {
        last = sig;
        since = now;
      }
      if (now - t0 > timeoutMs) throw new Error('等待' + label + '超时(' + timeoutMs + 'ms)；签名一直没稳定');
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
  // 条件轮询（信号覆盖不到的场景：等某个 DOM 事实出现；不是"等固定时长"）
  const waitFor = async (cond, opts = {}) => {
    const timeoutMs = opts.timeoutMs || 4000;
    const pollMs = opts.pollMs || 50;
    const label = opts.label || '条件';
    const t0 = performance.now();
    for (;;) {
      let ok = false;
      // 支持异步条件（await cond()）：早期版本写 !!(cond()) 会把 Promise 恒判真，等于没等
      try { ok = !!(await cond()); } catch { ok = false; }
      if (ok) return true;
      if (performance.now() - t0 > timeoutMs) throw new Error('等待' + label + '超时(' + timeoutMs + 'ms)');
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
  // [wait-ready] end`;

/** 该阶段/级别在 rank 表里的数值（node 侧复用，保持与页内一致） */
export const RANK = { pending: 0, mounted: 1, painted: 2, settled: 2, interactive: 3 };

/**
 * node 侧：等某阶段到达某级别。
 * @param {object|string} page 带 evaluate 的驱动对象（Playwright 等），或直接给页面 URL（走 HTTP 快照）
 */
export async function waitStage(page, name, level = 'interactive', { timeoutMs = 8000, pollMs = 50 } = {}) {
  const want = RANK[level] === undefined ? 3 : RANK[level];
  const get = () => readSnapshot(page, name);
  const t0 = Date.now();
  for (;;) {
    const cur = await get();
    if (cur.state === 'failed') throw new Error(`等待 ${name} → ${level} 时进入 failed：${cur.reason || '(无 reason)'}；快照=${JSON.stringify(cur)}`);
    const rank = RANK[cur.state] === undefined ? -1 : RANK[cur.state];
    if (rank >= want) return cur;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待 ${name} → ${level} 超时(${timeoutMs}ms)；当前 ${JSON.stringify(cur)}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** node 侧：多个阶段任一到达 */
export async function waitAny(page, names, level = 'interactive', opts = {}) {
  for (const n of names) {
    try {
      return { stage: n, ...(await waitStage(page, n, level, opts)) };
    } catch { /* 试下一个 */ }
  }
  throw new Error(`等待任一 [${names.join('/')}] → ${level} 全部未达：${JSON.stringify(await snapshotOf(page))}`);
}

/** node 侧：整份快照 */
export async function snapshotOf(page) {
  if (page && typeof page.evaluate === 'function') {
    return page.evaluate(() => (window.__WEB__ && window.__WEB__.ready ? window.__WEB__.ready() : { stages: {} }));
  }
  const base = String(page || '').replace(/\/+$/, '');
  const res = await fetch(`${base}/api/ready`);
  return res.json();
}

/** 取单个阶段（page 同 waitStage 的两种形态） */
async function readSnapshot(page, name) {
  if (page && typeof page.evaluate === 'function') {
    return page.evaluate((n) => (window.__WEB__ && window.__WEB__.ready ? window.__WEB__.ready(n) : { state: 'pending' }), name);
  }
  const base = String(page || '').replace(/\/+$/, '');
  const res = await fetch(`${base}/api/ready?stage=${encodeURIComponent(name)}`);
  return res.json();
}
