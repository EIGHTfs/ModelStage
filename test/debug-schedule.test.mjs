// test/debug-schedule.test.mjs —— 调试面板调度"统一到 infra/schedule.js"的等价验证
//
// 方法：把 debug/panel.js **改动前**的内联调度骨架原样复制到本文件当基准实现，
//   再用同一组事件序列分别驱动"旧内联"与"新 scheduler"，比对 flush 次数、批内容与顺序。
//   只测新实现的话，一个永远为真的断言也能"全绿"。
//
// 已知且被接受的差异（浏览器里不可观测，写在这里免得下一个人当 bug）：
//   · 无 rAF 环境（node 测试）：旧实现 setTimeout(run, 16) **异步**；新实现 flush() **同步**。
//     浏览器里 requestAnimationFrame 一定存在，所以生产环境不可观测。
//   · 面板传 fallbackMs: 0 ⇒ 只靠 rAF、不挂兜底定时器，与旧实现严格一致
//     （旧版本来就没有兜底；"加兜底"属于行为改进，不在本轮）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../src/web/infra/schedule.js';

/** 装一个可控 rAF：只入队，fire() 才执行。返回卸载函数。 */
function installRaf() {
  const queue = [];
  const saved = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  globalThis.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
  globalThis.cancelAnimationFrame = () => { /* 桩 */ };
  return {
    queue,
    fire() { const q = queue.splice(0); for (const cb of q) cb(0); },
    restore() {
      if (saved.raf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = saved.raf;
      if (saved.caf === undefined) delete globalThis.cancelAnimationFrame; else globalThis.cancelAnimationFrame = saved.caf;
    },
  };
}

/**
 * 旧实现（debug/panel.js 改动前 :379-400 的骨架，逐字搬过来，只把"逐条 append"换成记录回调）。
 * flushBatch(batch) 对应原 run() 里 batch 取走之后的那段内容逻辑。
 */
function legacySchedule(flushBatch, renderAllNow) {
  let pending = [];
  let scheduled = false;
  return {
    append(entry) {
      if (entry === null) { pending = []; renderAllNow(); return; }
      pending.push(entry);
      if (scheduled) return;
      scheduled = true;
      const run = () => {
        scheduled = false;
        const batch = pending;
        pending = [];
        if (!batch.length) return;
        flushBatch(batch);
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else setTimeout(run, 16);
    },
  };
}

/** 新实现（统一到 createScheduler，fallbackMs: 0 = 不挂兜底，与旧实现一致） */
function newSchedule(flushBatch, renderAllNow) {
  let pending = [];
  const scheduler = createScheduler(() => {
    const batch = pending;
    pending = [];
    if (!batch.length) return;          // 与旧 run() 里的空批保护一致
    flushBatch(batch);
  }, { fallbackMs: 0 });
  return {
    append(entry) {
      if (entry === null) { pending = []; renderAllNow(); return; }
      pending.push(entry);
      scheduler.request();
    },
  };
}

/** 造一个记录器：flushBatch 收到什么、renderAll 被调几次，全记下来 */
function makeRecorder() {
  const flushes = [];
  const renderAlls = [];
  return {
    flushBatch: (batch) => { flushes.push(batch.slice()); },
    renderAllNow: () => { renderAlls.push(Date.now()); },
    flushes,
    renderAlls,
  };
}

const IMPLS = [['旧内联实现', legacySchedule], ['新 scheduler', newSchedule]];

for (const [label, factory] of IMPLS) {
  test(`[${label}] ① 同帧 N 条 entry ⇒ 只 flush 一次，批内容与顺序一致`, () => {
    const raf = installRaf();
    const rec = makeRecorder();
    const s = factory(rec.flushBatch, rec.renderAllNow);
    try {
      s.append('a'); s.append('b'); s.append('c');
      assert.equal(rec.flushes.length, 0, '还没到帧，不能提前 flush');
      raf.fire();
      assert.equal(rec.flushes.length, 1, '同帧三条只能 flush 一次');
      assert.deepEqual(rec.flushes[0], ['a', 'b', 'c'], '批内容与顺序必须原样');
    } finally { raf.restore(); }
  });

  test(`[${label}] ② 跨帧：每帧一批，互不混批`, () => {
    const raf = installRaf();
    const rec = makeRecorder();
    const s = factory(rec.flushBatch, rec.renderAllNow);
    try {
      s.append('a1'); s.append('a2');
      raf.fire();
      s.append('b1');
      raf.fire();
      s.append('c1'); s.append('c2'); s.append('c3');
      raf.fire();
      assert.deepEqual(rec.flushes, [['a1', 'a2'], ['b1'], ['c1', 'c2', 'c3']]);
    } finally { raf.restore(); }
  });

  test(`[${label}] ③ rAF 不回调 ⇒ 不 flush（fallbackMs:0 不挂兜底，与旧实现一致）`, async () => {
    const raf = installRaf();
    const rec = makeRecorder();
    const s = factory(rec.flushBatch, rec.renderAllNow);
    try {
      s.append('x');
      // 刻意不 fire()：两边都不该自己刷出来 —— 旧实现没有兜底定时器，
      //   新实现传了 fallbackMs:0 也不挂。若这条变红，说明有人给面板偷偷加了兜底（行为变更）
      await new Promise((r) => setTimeout(r, 220));
      assert.equal(rec.flushes.length, 0, '没有 rAF 也不该有兜底 flush');
      raf.fire();
      assert.equal(rec.flushes.length, 1, 'rAF 到达后才 flush');
    } finally { raf.restore(); }
  });

  test(`[${label}] ④ entry === null ⇒ 立即 renderAll 且清空待刷批次`, () => {
    const raf = installRaf();
    const rec = makeRecorder();
    const s = factory(rec.flushBatch, rec.renderAllNow);
    try {
      s.append('old1'); s.append('old2');
      s.append(null);                                   // 清屏直刷：不走调度
      assert.equal(rec.renderAlls.length, 1, 'null 必须立即 renderAll');
      assert.equal(rec.flushes.length, 0, 'null 不经过 flush');
      raf.fire();                                       // 已排队的 rAF 空跑一次（旧实现就是这样）
      assert.equal(rec.flushes.length, 0, '空批不能 flush（旧实现在 run 里用 batch.length 提前返回）');
      s.append('new1');
      raf.fire();
      assert.deepEqual(rec.flushes, [['new1']], 'null 之前的条目不能漏到后面的批里');
    } finally { raf.restore(); }
  });
}

// ── 已知差异（仅 node 可观测）：无 rAF 时旧实现异步、新实现同步 ──
test('已知差异：无 rAF 时 旧实现异步(16ms) / 新实现同步 —— 浏览器里不可观测', async () => {
  const raf = installRaf();
  raf.restore();                                        // 刻意不提供 rAF

  const recOld = makeRecorder();
  legacySchedule(recOld.flushBatch, recOld.renderAllNow).append('x');
  assert.equal(recOld.flushes.length, 0, '旧实现：无 rAF 时走 setTimeout(16)，append 当场不 flush');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(recOld.flushes.length, 1, '旧实现：16ms 后异步 flush');

  const recNew = makeRecorder();
  newSchedule(recNew.flushBatch, recNew.renderAllNow).append('x');
  assert.equal(recNew.flushes.length, 1, '新实现：无 rAF 时同步 flush（已知差异，浏览器不可观测）');
});
