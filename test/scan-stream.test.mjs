// test/scan-stream.test.mjs —— 扫描进度：NDJSON 切帧 + 状态机 + 文案（纯 node，不起浏览器）
//
// 为什么这些能在 node 里测：scan-stream.js 只依赖一个可注入的时钟/定时器与标准 Response 形状，
//   不碰 DOM；视图层只负责"把 formatScanStatus 的字符串贴到状态位上"。
//
// 覆盖：帧解析（含被切开的行、坏行）、五类帧的状态迁移、判死（无进展超阈值）、
//   收到帧后自动从 stalled 回到 scanning、error/提前结束都判失败、文案与阈值常量单一来源。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateScanSnapshots, createScanMonitor, formatScanStatus, mergeScanBaseline,
  readNdjsonStream, resolveGroupPhase, scanNeedsRetry, scanStreamUrl, shouldDeferCatalogFailure,
} from '../src/web/roster/scan-stream.js';
import { SCAN_STALL_MS, resolveScanStallMs } from '../src/shared/scan-limits.mjs';

/** 造一个可控时钟 + 手动触发的定时器（不依赖假定时器库，语义直观） */
function makeClock() {
  let nowMs = 0;
  const timers = new Map();
  let seq = 0;
  return {
    now: () => nowMs,
    setTimer: (fn, ms) => { seq += 1; timers.set(seq, { fn, at: nowMs + ms }); return seq; },
    clearTimer: (id) => { timers.delete(id); },
    /** 推进时间并触发到期定时器（按到期顺序） */
    advance(ms) {
      const target = nowMs + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        nowMs = timer.at;
        timer.fn();
      }
      nowMs = target;
    },
    pending: () => timers.size,
  };
}

/** 用给定文本块造一个流式 Response（模拟被任意切开的 NDJSON） */
function streamResponse(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    body: {
      getReader: () => ({
        read: async () => (index < chunks.length
          ? { value: encoder.encode(chunks[index++]), done: false }
          : { value: undefined, done: true }),
      }),
    },
  };
}

test('scanStreamUrl：只对 spine/live2d 出流地址，其它类型返回 null', () => {
  assert.match(scanStreamUrl({ id: 'bd2', kind: 'spine' }), /\/api\/spine\/models\?root=bd2&stream=1$/);
  assert.match(scanStreamUrl({ id: 'azurlane', kind: 'live2d' }), /\/api\/live2d\/models\?root=azurlane&stream=1$/);
  assert.equal(scanStreamUrl({ id: 'packs', kind: 'bundle' }), null);
  assert.equal(scanStreamUrl({ id: '', kind: 'spine' }), null);
  // 根 id 必须编码（含空格/中文的根名也要能用）
  assert.match(scanStreamUrl({ id: '碧蓝 航线', kind: 'spine' }), /root=%E7%A2%A7%E8%93%9D%20%E8%88%AA%E7%BA%BF/);
});

test('readNdjsonStream：一行被切成两段也能正确解析；坏行丢弃不抛', async () => {
  const frames = [];
  // 故意把第二行切成两半，并在中间夹一行坏 JSON
  await readNdjsonStream(streamResponse([
    '{"type":"start","rootId":"bd2"}\n{"type":"prog',
    'ress","scanned":50,"dirs":3,"currentPath":"a/b"}\n{坏行\n',
    '{"type":"done","count":431}\n',
  ]), (f) => frames.push(f));
  assert.deepEqual(frames.map((f) => f.type), ['start', 'progress', 'done']);
  assert.equal(frames[1].scanned, 50);
  assert.equal(frames[1].currentPath, 'a/b');
});

test('状态机：scanning → 判死 stalled → 收到帧自动回到 scanning → done 收尾', () => {
  const clock = makeClock();
  const states = [];
  const monitor = createScanMonitor({
    stallMs: 1000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onChange: (snap) => states.push(snap.phase),
  });
  monitor.begin();
  monitor.frame({ type: 'progress', scanned: 120, dirs: 8, currentPath: 'chara/x' });
  assert.equal(monitor.state.phase, 'scanning');
  assert.equal(monitor.state.scanned, 120);

  clock.advance(1200);                       // 超过 1000ms 无帧
  assert.equal(monitor.state.phase, 'stalled');
  assert.match(formatScanStatus(monitor.state), /疑似卡住 · 已读取 120 条 · \d+ 秒无进展 · 当前 chara\/x/);
  assert.equal(scanNeedsRetry(monitor.state), true);

  monitor.frame({ type: 'progress', scanned: 240, dirs: 12, currentPath: 'chara/y' });
  assert.equal(monitor.state.phase, 'scanning', '收到帧要自动回到 scanning');
  assert.equal(scanNeedsRetry(monitor.state), false);

  monitor.frame({ type: 'done', count: 431 });
  assert.equal(monitor.state.phase, 'loaded');
  assert.equal(formatScanStatus(monitor.state), '', 'loaded 不额外提示，交回原有渲染');
  assert.equal(clock.pending(), 0, 'loaded 后不应残留定时器');
});

test('状态机：error 帧 ⇒ failed 且带原因；文案含"扫描失败"', () => {
  const clock = makeClock();
  const monitor = createScanMonitor({ stallMs: 5000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  monitor.begin();
  monitor.frame({ type: 'error', message: 'EACCES: permission denied', scanned: 12, currentPath: 'chara/z' });
  assert.equal(monitor.state.phase, 'failed');
  assert.match(formatScanStatus(monitor.state), /扫描失败 · EACCES: permission denied/);
  assert.equal(scanNeedsRetry(monitor.state), true);
});

test('状态机：流提前结束（没有 done/cached/error）⇒ failed，不假装完成', () => {
  const clock = makeClock();
  const monitor = createScanMonitor({ stallMs: 5000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  monitor.begin();
  monitor.frame({ type: 'progress', scanned: 5, dirs: 1, currentPath: 'a' });
  monitor.end();
  assert.equal(monitor.state.phase, 'failed');
  assert.match(monitor.state.message, /提前结束/);
});

test('状态机：cached 帧直接 loaded；stalled 期间文案里的秒数随时间增长', () => {
  const clock = makeClock();
  const monitor = createScanMonitor({ stallMs: 1000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  monitor.begin();
  clock.advance(1100);
  assert.equal(monitor.state.phase, 'stalled');
  const first = formatScanStatus(monitor.state);
  clock.advance(3000);                     // 每秒刷新文案
  const later = formatScanStatus(monitor.state);
  assert.notEqual(first, later, '卡住期间的秒数应该继续走');

  monitor.frame({ type: 'cached', count: 99 });
  assert.equal(monitor.state.phase, 'loaded');
  assert.equal(monitor.state.scanned, 99);
});

test('判死阈值：单一来源在 shared，非法配置回落常量', () => {
  assert.equal(SCAN_STALL_MS, 10000);
  assert.equal(resolveScanStallMs(undefined), SCAN_STALL_MS);
  assert.equal(resolveScanStallMs('abc'), SCAN_STALL_MS);
  assert.equal(resolveScanStallMs(0), SCAN_STALL_MS);
  assert.equal(resolveScanStallMs(2500), 2500);
});

test('多根聚合：已完成根的计数并入基线后，总数单调不减（不会从 135 掉回 0）', () => {
  // 根1 扫到 135 条 / 146 目录结束
  let baseline = mergeScanBaseline(null, { scanned: 135, dirs: 146 });
  let agg = aggregateScanSnapshots([{ phase: 'loaded', scanned: 135, dirs: 146 }], baseline);
  assert.equal(agg.scanned, 135);
  assert.equal(agg.dirs, 146);
  // 根2 刚开始（0 条、大目录）：总数必须仍是 135，而不是掉回 0
  agg = aggregateScanSnapshots([{ phase: 'scanning', scanned: 0, dirs: 986, currentPath: 'chara/nikke_2' }], baseline);
  assert.equal(agg.scanned, 135, '总数不得回退');
  assert.equal(agg.dirs, 146 + 986);
  assert.equal(agg.phase, 'scanning');
  // 根2 推进：总数继续增加
  agg = aggregateScanSnapshots([{ phase: 'scanning', scanned: 40, dirs: 1000, currentPath: 'x' }], baseline);
  assert.equal(agg.scanned, 175);
  // 根2 结束：基线累加第二个根
  baseline = mergeScanBaseline(baseline, { scanned: 40, dirs: 1000 });
  assert.deepEqual(baseline, { scanned: 175, dirs: 1146 });
});

test('多根聚合：只要还有一根在出帧，就不能报 stalled（避免误判）', () => {
  const snapshots = [
    { phase: 'stalled', scanned: 10, dirs: 2, currentPath: 'slow/dir', stalledFor: 12000 },
    { phase: 'scanning', scanned: 30, dirs: 5, currentPath: 'fast/dir', stalledFor: 0 },
  ];
  const agg = aggregateScanSnapshots(snapshots, { scanned: 100, dirs: 50 });
  assert.equal(agg.phase, 'scanning', '有根在出帧 ⇒ 整体仍是 scanning');
  assert.equal(scanNeedsRetry(agg), false);
  // 全部停帧后才报 stalled，并且带上正在卡住的那条路径
  const allStalled = aggregateScanSnapshots([
    { phase: 'stalled', scanned: 10, dirs: 2, currentPath: 'slow/dir', stalledFor: 12000 },
  ], null);
  assert.equal(allStalled.phase, 'stalled');
  assert.match(formatScanStatus(allStalled), /当前 slow\/dir/);
  assert.equal(allStalled.stalledFor, 12000);
});

test('多根聚合：没有活跃扫描时返回 null（交给正常渲染，不残留旧数字）', () => {
  assert.equal(aggregateScanSnapshots([], { scanned: 135, dirs: 146 }), null);
  assert.equal(aggregateScanSnapshots(null, null), null);
});

test('单一真相：扫描还活着时，无论 catalog 那边报什么，行状态只能是 scanning', () => {
  // 现场事故：catalog 超时把 entry 标成 error，而进度流仍在推进 ⇒ 行上同时出现「扫描中」与「加载失败」
  assert.equal(resolveGroupPhase({ scan: { phase: 'scanning', scanned: 89 }, rootStates: ['error'] }), 'scanning');
  assert.equal(resolveGroupPhase({ scan: { phase: 'scanning', scanned: 89 }, rootStates: ['error', 'error'] }), 'scanning');
  assert.equal(resolveGroupPhase({ scan: { phase: 'scanning' }, rootStates: ['loading'] }), 'scanning');
  // 流没在跑时才轮到 catalog 的状态说话
  assert.equal(resolveGroupPhase({ scan: null, rootStates: ['error'] }), 'error');
  assert.equal(resolveGroupPhase({ scan: { phase: 'stalled' }, rootStates: ['error'] }), 'stalled');
  assert.equal(resolveGroupPhase({ scan: { phase: 'failed' }, rootStates: ['error'] }), 'error');
  // 正常态
  assert.equal(resolveGroupPhase({ scan: null, rootStates: ['ready', 'idle'] }), 'ready');
  assert.equal(resolveGroupPhase({ scan: null, rootStates: ['loading'] }), 'loading');
  assert.equal(resolveGroupPhase({ scan: null, rootStates: ['idle'] }), 'idle');
  assert.equal(resolveGroupPhase({ scan: null, rootStates: [] }), 'idle');
});

test('catalog 失败暂缓判死：只有"扫描流仍在推进"才等，stalled/failed/结束都不等', () => {
  assert.equal(shouldDeferCatalogFailure('scanning'), true);
  assert.equal(shouldDeferCatalogFailure('stalled'), false);
  assert.equal(shouldDeferCatalogFailure('failed'), false);
  assert.equal(shouldDeferCatalogFailure('loaded'), false);
  assert.equal(shouldDeferCatalogFailure(undefined), false);
});
