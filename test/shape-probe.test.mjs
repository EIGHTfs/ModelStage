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
  const probe = createShapeProbe({
    catalog,
    entryStates: states,
    providers: () => [],
    readConfig: () => [{ id: 'r', path: root }],
    probeBytes,
    delayMs: 0,
    maxPerRun: 8,
  });
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
