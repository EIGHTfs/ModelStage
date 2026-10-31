// test/shape-probe.test.mjs —— 后台形态探测的写回语义（契约 §八 / S4 / S10）
//
// 这一层测的是"探完怎么记"：判型本身复用 /api/unpack 的那份实现（另有 bundle-shape 套件），
//   所以这里注入假判型函数，专注验证三条容易写错的语义：
//   ① 没有待探测项 ⇒ **完全不启动**（runs 不增长）—— S10"平时零开销"的最小证明
//   ② 判出美术依赖包 ⇒ 写 probe=unsupported，且 recompute 后 support=unsupported（未点击也带 ⚠）
//   ③ 探不出形态 ⇒ 只记 probe=unknown，support 仍是 unknown（绝不写 unsupported 吓人）
//   另外顺带钉住：探测**不覆盖** loadResult（那是当事端上报的结论）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createShapeProbe } from '../src/server/data/shape-probe.mjs';
import { createEntryStates, providerFingerprintOf } from '../src/server/data/entry-states.mjs';

/**
 * 用完必须关掉探测器的常驻 worker。
 *
 * 为什么非关不可：worker 跨批复用（否则每批重建解析沙箱，一批从 4.5s 涨到 76s），
 *   它会一直挂在进程里；`unref()` 只能让它不单独撑住进程，挡不住 `worker.on('message')`
 *   把事件循环 hold 住 ⇒ 表现为"用例全过、node --test 永不退出"（被超时杀掉，退出码 124）。
 * 这里统一登记 + afterEach 关闭，用例里漏写也不会漏收（比逐个 finally 更稳）。
 */
const openedProbes = [];
function track(probe) {
  openedProbes.push(probe);
  return probe;
}
test.afterEach(async () => {
  while (openedProbes.length) {
    const p = openedProbes.pop();
    try { await p.close(); } catch { /* 关不掉也不该影响用例结论 */ }
  }
});

/** 造一个含单个"包文件"的根目录 */
function makeRoot(fileName = 'pack.unity3d') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-probe-'));
  fs.writeFileSync(path.join(dir, fileName), Buffer.from('not-a-real-bundle'));
  return dir;
}

function makeHarness({ root, keys, probeBytes }) {
  const states = createEntryStates({ file: '', log: () => {} });
  const catalog = {
    takeProbeKeys: () => keys.slice(),
    requeueProbeKey: () => {},
  };
  const probe = track(createShapeProbe({
    catalog,
    entryStates: states,
    providers: () => [],
    readConfig: () => [{ id: 'r', path: root }],
    probeBytes,
    delayMs: 0,
    maxPerRun: 8,
  }));
  return { probe, states };
}

test('没有待探测项 ⇒ 不启动（runs 保持 0，S10）', async () => {
  const root = makeRoot();
  try {
    const { probe } = makeHarness({ root, keys: [], probeBytes: () => ({}) });
    const out = await probe.kick('r');
    assert.deepEqual(out, { probed: 0 });
    assert.equal(probe.stats().runs, 0, '零待探测时连"启动次数"都不该增长');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('判出美术依赖包 ⇒ 写 probe=unsupported，recompute 后 support=unsupported（S4 未点击即有结论）', async () => {
  const root = makeRoot();
  try {
    const key = 'r/pack.unity3d';
    const { probe, states } = makeHarness({
      root,
      keys: [key],
      probeBytes: () => ({ assetDependency: true, dependencyReason: '美术依赖包：包内只有贴图，没有骨架' }),
    });
    await probe.kick('r');

    const rec = states.get(key);
    assert.ok(rec && rec.probe, '必须落一条探测结论');
    assert.equal(rec.probe.result, 'unsupported');
    assert.equal(rec.probe.reason, 'asset-dependency');
    assert.match(rec.probe.message, /没有骨架/, '文案来自判型函数（与装载失败同源）');
    assert.ok(rec.probe.providerFingerprint !== null, '结论必须带当时指纹，否则下次读取又判过期（白探）');

    const computed = states.recompute(rec, {
      providers: [], candidates: [], providerFingerprint: providerFingerprintOf([]),
    });
    assert.equal(computed.support.state, 'unsupported', '未点击的依赖包也要带 ⚠');
    assert.equal(computed.support.detail.reason, 'asset-dependency');
    assert.equal(probe.stats().unsupported, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('探不出形态 ⇒ 只记 unknown，support 保持 unknown（不猜内容）', async () => {
  const root = makeRoot();
  try {
    const key = 'r/pack.unity3d';
    const { probe, states } = makeHarness({
      root,
      keys: [key],
      probeBytes: () => null,        // 读不了头 / 非 UnityFS
    });
    await probe.kick('r');

    const rec = states.get(key);
    assert.equal(rec.probe.result, 'unknown', '探过但没结论也要落一条（S10 的零开销判据）');
    const computed = states.recompute(rec, {
      providers: [], candidates: [], providerFingerprint: providerFingerprintOf([]),
    });
    assert.equal(computed.support.state, 'unknown', '探不出形态绝不能写 unsupported');
    assert.equal(probe.stats().unknown, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('超过单包上限 ⇒ 跳过解析，保持 unknown 并计数（第 2 步）', async () => {
  const root = makeRoot('big.unity3d');
  try {
    const key = 'r/big.unity3d';
    const states = createEntryStates({ file: '', log: () => {} });
    const catalog = { takeProbeKeys: () => [key], requeueProbeKey: () => {} };
    const logs = [];
    const probe = track(createShapeProbe({
      catalog, entryStates: states, providers: () => [],
      readConfig: () => [{ id: 'r', path: root }],
      log: (level, msg) => logs.push(String(msg)),
      probeBytes: () => { throw new Error('不该走到解析：超限的包必须跳过'); },
      delayMs: 0, maxPerRun: 4, maxBytes: 4,        // 文件 > 4 字节 ⇒ 必然超限
    }));
    await probe.kick('r');
    const rec = states.get(key);
    assert.equal(rec.probe.result, 'unknown', '超限包必须保持 unknown（不猜、也不写 unsupported）');
    assert.equal(probe.stats().skippedBig, 1, '要能被计数（面板/排障要看得到跳了多少）');
    assert.ok(logs.some((m) => m.includes('包太大')), '必须记一条 info 说明"太大，留待点击验证"');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('真实解析路径（worker）：坏包不崩，结论只会是 unknown 或被跳过', async () => {
  const root = makeRoot('bad.unity3d');
  try {
    const key = 'r/bad.unity3d';
    const states = createEntryStates({ file: '', log: () => {} });
    const catalog = { takeProbeKeys: () => [key], requeueProbeKey: () => {} };
    // 不注入 probeBytes ⇒ 走真实解析（worker 优先，失败回落同步）
    const probe = track(createShapeProbe({
      catalog, entryStates: states, providers: () => [],
      readConfig: () => [{ id: 'r', path: root }], delayMs: 0, maxPerRun: 4,
    }));
    await probe.kick('r');
    const rec = states.get(key);
    assert.equal(probe.stats().runs, 1, '这一轮必须真的跑起来（不是静默跳过）');
    const ok = (rec && rec.probe && rec.probe.result === 'unknown') || probe.stats().skipped === 1;
    assert.ok(ok, '坏包要么被判 unknown（可继续用），要么记为跳过并放回队列；不许写成 unsupported');
    if (rec && rec.probe) assert.notEqual(rec.probe.result, 'unsupported', '解析不出形态时绝不能写 unsupported');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('可用内存不足 ⇒ 跳过解析，保持 unknown 并单独计数（与"太大"区分）', async () => {
  const root = makeRoot('mem.unity3d');
  try {
    const key = 'r/mem.unity3d';
    const states = createEntryStates({ file: '', log: () => {} });
    const catalog = { takeProbeKeys: () => [key], requeueProbeKey: () => {} };
    const logs = [];
    const probe = track(createShapeProbe({
      catalog, entryStates: states, providers: () => [],
      readConfig: () => [{ id: 'r', path: root }],
      log: (level, msg) => logs.push(String(msg)),
      probeBytes: () => { throw new Error('内存不足时必须跳过解析'); },
      availableBytes: () => 10 * 1024 * 1024,                    // 只有 10MB 可用
      readLimits: () => ({ baselineBytes: 256 * 1024 * 1024, factor: 3 }),
      delayMs: 0, maxPerRun: 4, maxBytes: 24 * 1024 * 1024,      // 包本身**没有**超上限
    }));
    await probe.kick('r');
    const rec = states.get(key);
    const st = probe.stats();
    assert.equal(rec.probe.result, 'unknown', '内存不足只说明"没探"，绝不能写 unsupported');
    assert.equal(st.skippedMemory, 1, '要计入 skippedMemory');
    assert.equal(st.skippedBig, 0, 'skippedBig 必须保持不变（区分"太大"与"内存不够"）');
    assert.ok(logs.some((m) => m.includes('可用内存不足') && m.includes('MB')), '日志要带 available 与需要值');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('内存充足 ⇒ 照常解析；取不到内存数据 ⇒ fail-open 放行', async () => {
  const root = makeRoot('mem2.unity3d');
  try {
    const key = 'r/mem2.unity3d';
    const make = (availableBytes) => {
      const states = createEntryStates({ file: '', log: () => {} });
      const catalog = { takeProbeKeys: () => [key], requeueProbeKey: () => {} };
      const probe = track(createShapeProbe({
        catalog, entryStates: states, providers: () => [],
        readConfig: () => [{ id: 'r', path: root }],
        probeBytes: () => ({ assetDependency: true, dependencyReason: '美术依赖包' }),
        availableBytes,
        readLimits: () => ({ baselineBytes: 256 * 1024 * 1024, factor: 3 }),
        delayMs: 0, maxPerRun: 4,
      }));
      return { probe, states };
    };
    // ① 内存充足：正常出结论
    const rich = make(() => 8 * 1024 * 1024 * 1024);
    await rich.probe.kick('r');
    assert.equal(rich.states.get(key).probe.result, 'unsupported', '内存够就该照常探出结论');
    assert.equal(rich.probe.stats().skippedMemory, 0);
    // ② 拿不到内存数据（null）：fail-open，不能因为"读不到 /proc"就停摆
    const blind = make(() => null);
    await blind.probe.kick('r');
    assert.equal(blind.states.get(key).probe.result, 'unsupported', '取不到可用内存时应放行');
    assert.equal(blind.probe.stats().skippedMemory, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('探测不覆盖 loadResult（当事端的装载结论优先保留）', async () => {
  const root = makeRoot();
  try {
    const key = 'r/pack.unity3d';
    const { probe, states } = makeHarness({
      root,
      keys: [key],
      probeBytes: () => ({}),        // 普通包：探不出"装不动"
    });
    const fp = providerFingerprintOf([]);
    // 先有一条真实装载成功的记录
    states.put(key, { result: 'ok', provider: 'builtin-spine' }, { providerFingerprint: fp, assetFingerprint: String(fs.statSync(path.join(root, 'pack.unity3d')).size) });
    await probe.kick('r');

    const rec = states.get(key);
    assert.equal(rec.loadResult.result, 'ok', '探测不得改动 loadResult');
    assert.equal(rec.loadResult.provider, 'builtin-spine');
    assert.equal(rec.probe.result, 'unknown', '探测结论另存一份');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
