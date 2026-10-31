// test/entry-states-wiring.test.mjs —— 指纹**接线**的集成级用例（契约 §六 S6 / §七 INV-D6）
//
// 为什么必须集成级：上一版有 13 个 entry-states 单测全绿，但三处调用里只有一处传了
//   providerFingerprint —— 单测自己构造 ctx，永远测不出"调用方没接上"这种断链。
//   所以这里**不构造 ctx**：直接调 catalog 的读路径与 entries 路由的 contextFor 工厂，
//   用它们自己产出的东西断言。接线断了，这组用例必然红。
//
// 覆盖：
//   ① 结论带指纹 ⇒ 同一版插件下重复读取仍是 unsupported，且不进待探测队列（S4 读侧）
//   ② 插件版本变（指纹变）⇒ 读出来 support 回 unknown，容器条目进待探测队列（S6/INV-D6）
//   ③ 存量 null 指纹（老记录/接线漏过）⇒ 视为过期，不允许永久豁免规则①
//   ④ 上报路由的 contextFor 确实带上了两个指纹（另一条链路的接线）
//
// 注意：目录型条目不进待探测队列 —— 它们的 support 来自资产检查（缺贴图），
//   与"包内形态"无关（契约 §八 只针对容器包）。所以断言队列时用的是容器条目。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCatalog } from '../src/server/data/catalog.mjs';
import { createContextFor } from '../src/server/routes/entries.mjs';
import {
  createEntryStates, providerFingerprintOf, assetFingerprintOf,
} from '../src/server/data/entry-states.mjs';

/** 与生产同一份魔数判定（registry.detectBundleContainer 只读前 8 字节，测试内复刻） */
function detectContainer(abs) {
  try {
    const head = Buffer.alloc(8);
    const fd = fs.openSync(abs, 'r');
    try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
    return (head.toString('latin1', 0, 7) === 'UnityFS' && head[7] === 0) ? 'unityfs' : null;
  } catch {
    return null;
  }
}

/** 造一个真实存在的根目录：内含一条目录型模型（由假扫描器提供）+ 一个假容器包 */
function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-states-wiring-'));
  fs.writeFileSync(path.join(dir, 'pack.unity3d'), Buffer.from('UnityFS\0padpadpad', 'latin1'));
  return dir;
}

/** 目录型（spine）最小模型：字段按 toSpineEntry 的入参形状给 */
function makeModel() {
  return {
    id: 'probe-char',
    name: '探针角色',
    srcDir: 'probe-char',
    skeletonFile: { name: 'probe.skel', path: 'probe-char/probe.skel', size: 100 },
    atlasFile: { name: 'probe.atlas', path: 'probe-char/probe.atlas', size: 200 },
    textureFiles: [{ name: 'probe.png', path: 'probe-char/probe.png', size: 300 }],
    animations: [],
    skins: [],
    meta: {},
  };
}

/**
 * 提供者注册表。两版只差 version —— 这正是"插件升级了、内置判定逻辑也改了"的形态：
 *   id 不变、能力可能变 ⇒ 指纹必须变（INV-D6 的判据就是 providerId@version）。
 */
const PROVIDERS_V1 = [{ id: 'builtin-spine', version: '1', accent: '#2b6cb0', fileKinds: ['spine-dir'], matchPriority: 30 }];
const PROVIDERS_V2 = [{ id: 'builtin-spine', version: '2', accent: '#2b6cb0', fileKinds: ['spine-dir'], matchPriority: 30 }];

/** 装配一个 catalog：提供者注册表可中途替换（模拟插件升级） */
function makeHarness(rootDir, states) {
  let providers = PROVIDERS_V1;
  const catalog = createCatalog({
    config: { readConfig: () => [{ id: 'probe-root', name: '探针根', path: rootDir }] },
    spine: { getSpineModels: () => ({ models: [makeModel()] }) },
    live2d: { getLive2DModels: () => ({ models: [] }) },
    tree: {},
    plugins: { readPlugins: () => providers, detectBundleContainer: detectContainer },
    entryStates: states,
  });
  return {
    catalog,
    setProviders: (next) => { providers = next; },
    read: () => catalog.listCatalog('probe-root').body,
    /** 取走当前待探测队列（取走即清空，用例之间互不影响） */
    queued: () => catalog.takeProbeKeys(),
  };
}

/** 取目录型条目（entries 里第一条非容器） */
function dirEntry(body) {
  const e = (body.entries || []).find((x) => !x.container);
  assert.ok(e, '探针根必须扫出一条目录型条目');
  return e;
}

/** 取容器条目（entries 里第一条容器） */
function containerEntry(body) {
  const e = (body.entries || []).find((x) => x.container);
  assert.ok(e, '探针根必须扫出一条容器条目（pack.unity3d）');
  return e;
}

test('结论带指纹：同一版插件下重复读取仍是 unsupported，且不排队重探（读侧不变）', () => {
  const root = makeRoot();
  try {
    const states = createEntryStates({ file: '', log: () => {} });
    const h = makeHarness(root, states);

    // 第一次读：没有记录 ⇒ unknown
    const e0 = dirEntry(h.read());
    assert.equal(e0.support.state, 'unknown', '从没试过必须是 unknown（不许猜）');
    assert.ok(e0.stateKey, 'catalog 要给条目带 stateKey，供上报侧复用');

    // 当事端上报一次"确定性失败"（美术依赖包），**指纹由生产函数算**
    states.put(e0.stateKey, {
      result: 'failed', reason: 'asset-dependency', message: '美术依赖包：包内没有骨架',
    }, {
      providerFingerprint: providerFingerprintOf(PROVIDERS_V1),
      assetFingerprint: assetFingerprintOf(e0.size),
    });

    const body = h.read();
    const e1 = dirEntry(body);
    assert.equal(e1.support.state, 'unsupported', '确定性失败要在读侧升格成 unsupported（S4 读侧）');
    assert.match(String(e1.support.detail && e1.support.detail.message), /骨架/);
    assert.equal(e1.loadResult.result, 'failed');

    // 结论有效 ⇒ 这条不该进待探测队列（进队列就意味着每次列表都要重探一遍）
    assert.ok(!h.queued().includes(e1.stateKey), '结论仍有效的条目不该进待探测队列');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('插件升级（指纹变）⇒ support 回 unknown + 容器条目进待探测队列（S6 / INV-D6）', () => {
  const root = makeRoot();
  try {
    const states = createEntryStates({ file: '', log: () => {} });
    const h = makeHarness(root, states);
    const e0 = dirEntry(h.read());

    states.put(e0.stateKey, {
      result: 'failed', reason: 'asset-dependency', message: '美术依赖包：包内没有骨架',
    }, {
      providerFingerprint: providerFingerprintOf(PROVIDERS_V1),
      assetFingerprint: assetFingerprintOf(e0.size),
    });
    assert.equal(dirEntry(h.read()).support.state, 'unsupported', '前置：升级前是 unsupported');
    h.queued();   // 清掉前置读取排下的容器项，避免干扰下面的断言

    // 换成 v2 ⇒ 指纹变了（"插件升级"）
    assert.notEqual(providerFingerprintOf(PROVIDERS_V2), providerFingerprintOf(PROVIDERS_V1), '两版指纹必须不同');
    h.setProviders(PROVIDERS_V2);

    const body = h.read();
    const e2 = dirEntry(body);
    assert.equal(e2.support.state, 'unknown', '能力变过 ⇒ 旧结论不再可信，必须回 unknown（S6）');
    assert.equal(e2.loadResult, null, '过期结论不该继续当"最近一次装载结果"展示');

    // 容器条目本来就"没有结论" ⇒ 必须进待探测队列，由 §八 任务补（INV-D6 后半句）
    const q = h.queued();
    assert.ok(q.includes(containerEntry(body).stateKey), '容器条目必须进待探测队列（§八 判据 a/b）');

    // 历史不删：记录仍在表里（只是不再参与展示）
    assert.ok(states.get(e0.stateKey), '作废不等于删除：表里要留着可追溯');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('存量 null 指纹（老记录/接线漏过）⇒ 视为过期，不得永久豁免规则①', () => {
  const root = makeRoot();
  try {
    const states = createEntryStates({ file: '', log: () => {} });
    const h = makeHarness(root, states);
    const e0 = dirEntry(h.read());

    // 模拟"上一版没接指纹"写下的记录：providerFingerprint 为 null
    states.put(e0.stateKey, {
      result: 'failed', reason: 'asset-dependency', message: '美术依赖包：包内没有骨架',
    }, { providerFingerprint: null, assetFingerprint: null });
    assert.equal(states.get(e0.stateKey).loadResult.providerFingerprint, null, '前置：这条记录确实没指纹');

    const body = h.read();
    assert.equal(dirEntry(body).support.state, 'unknown', 'null 指纹 = 过期 ⇒ 回 unknown（不能因为"没记录指纹"就放行）');
    assert.ok(h.queued().includes(containerEntry(body).stateKey), '容器条目必须进待探测队列');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/*
 * S10 的机制级证明（"指纹没变 ⇒ 不再探测"）：
 *   探测写回一条带**当前指纹**的结论之后，再列一次同一根，该条目**不该**再进待探测队列。
 *   这比"跑一轮实测看计数"更可靠：它把判据钉在代码里，任何让 probe 失效的改法都会红。
 */
test('探测结论带上当前指纹后 ⇒ 该容器不再进待探测队列（S10 的机制）', () => {
  const root = makeRoot();
  try {
    const states = createEntryStates({ file: '', log: () => {} });
    const h = makeHarness(root, states);
    const body = h.read();
    const box = containerEntry(body);

    // 第一次列：容器"从没结论" ⇒ 进队列
    assert.ok(h.queued().includes(box.stateKey), '前置：没有结论时应当排队');

    // 探测写回（真实 putProbe，指纹由生产函数算）
    states.putProbe(box.stateKey, { result: 'unknown', message: null }, {
      providerFingerprint: providerFingerprintOf(PROVIDERS_V1),
      assetFingerprint: assetFingerprintOf(box.size),
    });

    // 第二次列：已有匹配指纹的结论 ⇒ 不再排队（否则每次列表都要重探一遍，S10 就失效）
    const again = h.read();
    assert.ok(!h.queued().includes(containerEntry(again).stateKey), '结论有效时不得重复排队');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('上报路由 contextFor 必须带两个指纹（第三条链路的接线）', () => {
  const contextFor = createContextFor({
    providers: () => PROVIDERS_V1,
    // catalog 侧没扫过这根时是空对象，这里按真实行为给空
    describe: () => ({}),
  });
  const ctx = contextFor('probe-root/probe-char', { size: 4096 });
  assert.equal(ctx.providerFingerprint, providerFingerprintOf(PROVIDERS_V1), '上报路径必须带提供者指纹');
  assert.equal(ctx.assetFingerprint, assetFingerprintOf(4096), '上报路径必须带与另两处同源的资源指纹');
  assert.equal(ctx.assetFingerprint, '4096', '资源指纹口径：size 字符串（三处一致，不用 mtime）');
});
