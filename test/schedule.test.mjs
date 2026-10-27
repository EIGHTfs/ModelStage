// test/schedule.test.mjs —— infra/schedule.js 的四条行为断言
//
// 为什么要"旧实现对照"这一组：把 schedule.js 和**抽出前 roster 里那段内联代码**跑同样的断言，
//   两边都通过才算"抽取没有改行为"。只测新实现的话，一个永远为真的断言也能"全绿"。
//
// 环境：node 无 DOM/无 rAF ⇒ 用可手动触发的 rAF 桩控制"帧"，测完必须清干净（否则定时器挂着不退进程）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../src/web/infra/schedule.js';

/** 装一个可控 rAF：只入队，fire() 才执行（模拟"到下一帧"）。返回卸载函数。 */
function installRaf() {
  const queue = [];
  const saved = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  globalThis.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
  globalThis.cancelAnimationFrame = () => { /* 桩：不真取消，足够本测试使用 */ };
  return {
    queue,
    fire() { const q = queue.splice(0); for (const cb of q) cb(0); },
    restore() {
      if (saved.raf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = saved.raf;
      if (saved.caf === undefined) delete globalThis.cancelAnimationFrame; else globalThis.cancelAnimationFrame = saved.caf;
    },
  };
}

/** 抽出前 roster/view.js 里的内联实现（逐字搬过来，只把 render 换成计数回调） */
function legacyScheduler(run) {
  let pendingRender = false;
  let rafId = null;
  let fallbackTimer = null;
  function clearScheduled() {
    if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    rafId = null;
    fallbackTimer = null;
    pendingRender = false;
  }
  function flushRender() {
    if (!pendingRender) return;
    clearScheduled();
    run();
  }
  function scheduleRender() {
    if (pendingRender) return;
    pendingRender = true;
    if (typeof requestAnimationFrame !== 'function') { flushRender(); return; }
    rafId = requestAnimationFrame(() => { rafId = null; flushRender(); });
    fallbackTimer = setTimeout(() => { fallbackTimer = null; flushRender(); }, 120);
  }
  return { request: scheduleRender, flush: flushRender, cancel: clearScheduled };
}

const IMPLS = [['schedule.js', createScheduler], ['旧内联实现', legacyScheduler]];

for (const [label, factory] of IMPLS) {
  test(`[${label}] ① 同帧多次 request 只跑一次`, () => {
    const raf = installRaf();
    let n = 0;
    const s = factory(() => { n += 1; });
    try {
      s.request(); s.request(); s.request();
      assert.equal(n, 0, '还没到帧，不能提前跑');
      raf.fire();
      assert.equal(n, 1, '同一帧内三次 request 只能跑一次');
      s.cancel();
    } finally { s.cancel(); raf.restore(); }
  });

  test(`[${label}] ② flush 幂等：没有 pending 时什么都不做`, () => {
    const raf = installRaf();
    let n = 0;
    const s = factory(() => { n += 1; });
    try {
      s.flush();
      assert.equal(n, 0, '没有待执行请求时 flush 不能跑');
      s.request();
      s.flush();
      assert.equal(n, 1, '有 pending 时 flush 要立刻跑');
      s.flush(); s.flush();
      assert.equal(n, 1, '重复 flush 不能重复跑');
      raf.fire();
      assert.equal(n, 1, 'flush 之后到帧不能再跑一次');
    } finally { s.cancel(); raf.restore(); }
  });

  test(`[${label}] ③ 没有 requestAnimationFrame 时同步跑`, () => {
    const raf = installRaf();
    raf.restore();                       // 刻意不提供 rAF（node 默认就没有）
    let n = 0;
    const s = factory(() => { n += 1; });
    try {
      s.request();
      assert.equal(n, 1, '无 rAF 环境必须同步执行，不能把请求丢掉');
    } finally { s.cancel(); }
  });

  test(`[${label}] ④ rAF 不回调时兜底定时器仍会跑`, async () => {
    const raf = installRaf();
    let n = 0;
    const s = factory(() => { n += 1; });
    try {
      s.request();
      // 刻意不 fire()：模拟后台标签页 rAF 被节流 ⇒ 只能靠 120ms 兜底
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(n, 1, 'rAF 不回调时兜底定时器必须把这一帧补上');
      raf.fire();
      assert.equal(n, 1, '兜底跑过之后，迟到的 rAF 不能再跑一次');
    } finally { s.cancel(); raf.restore(); }
  });
}

test('抽取后的计量钩子：onRequest 按"请求次数"计（与旧实现的 renderScheduled 口径一致）', () => {
  const raf = installRaf();
  let requests = 0;
  let runs = 0;
  const s = createScheduler(() => { runs += 1; }, { onRequest: () => { requests += 1; } });
  try {
    s.request(); s.request(); s.request();
    assert.equal(requests, 3, 'onRequest 每次 request 都要计，含被合并的那些');
    raf.fire();
    assert.equal(runs, 1, '被合并的请求只执行一次');
  } finally { s.cancel(); raf.restore(); }
});
