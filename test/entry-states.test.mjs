// test/entry-states.test.mjs —— 条目状态存储（契约《条目状态与展示归属》§三）
//
// 钉三件事：
//   ① 三条失效规则（插件集合指纹变 / 条目 size 变 / 重启读回）
//   ② 一致性约束（loadResult.ok ⇒ display.provider 与 accent 同源、support 不得 unsupported）
//   ③ 写入定序（at 更晚者胜；不晚于已存 ⇒ 不覆盖，返回当前状态）
//
// 全部用注入时钟 + 临时文件，不碰 data/ 真实目录，不起服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEntryStates, providerFingerprintOf } from '../src/server/data/entry-states.mjs';
import { REASONS } from '../src/shared/entry-reasons.mjs';

/** 造一份 provider 注册表（与 readPlugins() 返回形状同） */
function providers(list) {
  return list.map(([id, accent, version]) => ({ id, accent, version: version === undefined ? '1' : version }));
}

const PROV = providers([
  ['unity-spine-bundle', '#2b6cb0', '4.0.1'],
  ['unity-live2d-bundle', '#6d28d9', '1.0.0'],
  ['builtin-spine', '#2b6cb0', 'a625c933'],
]);

/** 每个用例一个临时文件（互不干扰，也顺便验证"文件不存在 ⇒ 空表"） */
function tmpStore(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-states-'));
  const file = path.join(dir, 'entry-states.json');
  const logs = [];
  const store = createEntryStates({
    file,
    log: (lv, msg) => logs.push(`${lv}:${msg}`),
    now: () => 1000,
    debounceMs: 10,
    ...opts,
  });
  return { store, file, dir, logs };
}

const CTX = {
  providers: PROV,
  candidates: ['unity-spine-bundle', 'unity-live2d-bundle'],
  providerFingerprint: providerFingerprintOf(PROV),
  assetFingerprint: 'size-1',
};

test('recompute：没试过 ⇒ support 依上下文，loadResult=null，归属未定 ⇒ accent=null（INV-D4）', () => {
  const { store } = tmpStore();
  const c = store.recompute(null, { ...CTX });
  assert.equal(c.loadResult, null, '没试过 = null');
  assert.equal(c.display.provider, null, '未定归属');
  assert.equal(c.display.accent, null, '未定归属必须中性色，不许按候选猜');
  assert.deepEqual(c.display.candidates, CTX.candidates);
  assert.equal(c.support.state, 'unknown', '容器型未探测 = unknown');
});

test('recompute：容器型依赖包 ⇒ unsupported/asset-dependency，文案来自上下文', () => {
  const { store } = tmpStore();
  const msg = '这是美术依赖包，不能单独装载：包内只有 Transform×276…';
  const c = store.recompute(null, {
    ...CTX,
    assetDependency: { reason: REASONS.ASSET_DEPENDENCY, message: msg },
  });
  assert.equal(c.support.state, 'unsupported');
  assert.equal(c.support.detail.reason, REASONS.ASSET_DEPENDENCY);
  assert.equal(c.support.detail.message, msg, '文案必须与装载失败同源（由调用方给）');
});

test('recompute：目录型缺件 ⇒ unsupported/missing-textures；明确无缺件 ⇒ ready', () => {
  const { store } = tmpStore();
  const bad = store.recompute(null, { ...CTX, missingTextures: ['tex_a.png', 'tex_b.png'] });
  assert.equal(bad.support.state, 'unsupported');
  assert.equal(bad.support.detail.reason, REASONS.MISSING_TEXTURES);
  assert.match(bad.support.detail.message, /tex_a\.png/);

  const ok = store.recompute(null, { ...CTX, missingTextures: [] });
  assert.equal(ok.support.state, 'ready', '目录型资产检查通过 = ready');
});

test('一致性约束：loadResult.ok ⇒ display.provider=该插件、accent=其声明色、support 不得 unsupported', () => {
  const { store } = tmpStore();
  const put = store.put('r/x.bundle', { result: 'ok', provider: 'unity-spine-bundle', at: 1000 }, {
    ...CTX,
    assetDependency: { reason: REASONS.ASSET_DEPENDENCY, message: '依赖包' },   // 故意给一个冲突的上下文
  });
  assert.equal(put.applied, true);
  const c = put.computed;
  assert.equal(c.loadResult.result, 'ok');
  assert.equal(c.display.provider, 'unity-spine-bundle', 'ok 的 provider 决定归属');
  assert.equal(c.display.accent, '#2b6cb0', 'accent 必须等于该插件声明色');
  assert.equal(c.support.state, 'ready', 'ok 与 unsupported 不能并存 ⇒ 以 loadResult 为准');
  assert.equal(c.support.detail, null);
});

test('一致性约束：ok 但没报 provider ⇒ 降级成 failed/unknown（否则会违反 ok⇒provider 必须有值）', () => {
  const { store } = tmpStore();
  const put = store.put('r/y.bundle', { result: 'ok', at: 1000 }, CTX);
  assert.equal(put.computed.loadResult.result, 'failed');
  assert.equal(put.computed.loadResult.reason, REASONS.UNKNOWN);
  assert.equal(put.computed.display.provider, null, '降级后不涂色');
});

test('失败记录升格 support：确定性原因 ⇒ unsupported；环境类原因 ⇒ 保持 unknown', () => {
  const { store } = tmpStore();
  // 确定性：解包时已判出"美术依赖包" ⇒ 列表不必再解析包体就能带 ⚠
  const dep = store.put('r/h1.bundle', { result: 'failed', reason: REASONS.ASSET_DEPENDENCY, message: '这是美术依赖包' }, CTX);
  assert.equal(dep.computed.support.state, 'unsupported', '依赖包必须升格成 unsupported');
  assert.equal(dep.computed.support.detail.reason, REASONS.ASSET_DEPENDENCY);

  // 环境类：内存不足只是这次不行，标 unsupported 会冤枉模型
  const mem = store.put('r/h2.bundle', { result: 'failed', reason: REASONS.INSUFFICIENT_MEMORY, message: '内存不足' }, CTX);
  assert.equal(mem.computed.support.state, 'unknown', '环境类失败不许标 unsupported');

  const nf = store.put('r/h3.bundle', { result: 'failed', reason: REASONS.NOT_FOUND }, CTX);
  assert.equal(nf.computed.support.state, 'unknown', '路径问题不许标 unsupported');
});

test('规则①：插件集合指纹变了 ⇒ 整批失效（旧"不支持"不再可信）', () => {
  const { store } = tmpStore();
  // 先用旧指纹写一条 failed
  store.put('r/a.bundle', { result: 'failed', reason: REASONS.ASSET_DEPENDENCY, at: 1000 }, CTX);

  const newProv = providers([['unity-spine-bundle', '#2b6cb0', '4.0.2']]);   // 插件升级 ⇒ 版本变
  const newCtx = { ...CTX, providers: newProv, providerFingerprint: providerFingerprintOf(newProv) };
  const c = store.recompute(store.get('r/a.bundle'), newCtx);
  assert.equal(c.loadResult, null, '指纹不符 ⇒ 记录作废，回到"未试过"');
  assert.equal(c.display.accent, null);
});

test('规则②：条目 size 变化 ⇒ 该条失效（同名文件被替换）', () => {
  const { store } = tmpStore();
  store.put('r/b.bundle', { result: 'ok', provider: 'unity-spine-bundle', at: 1000 }, CTX);
  const c = store.recompute(store.get('r/b.bundle'), { ...CTX, assetFingerprint: 'size-2' });
  assert.equal(c.loadResult, null, 'size 变了 ⇒ 该条失效');
  assert.equal(c.display.provider, null);
});

test('规则③：重启读回（load 从 json 恢复）；坏文件 ⇒ 空表不炸', async () => {
  const { store, file, dir } = tmpStore();
  store.put('r/c.bundle', { result: 'failed', reason: REASONS.TEX_DECODE, at: 1000 }, CTX);
  await store.flush(true);
  assert.equal(fs.existsSync(file), true, 'flush 应已落盘');

  // 模拟"进程换代"：新建一个 store 实例指向同一文件
  const reopened = createEntryStates({ file, log: () => {}, now: () => 1000 });
  reopened.load();
  assert.equal(reopened.get('r/c.bundle').loadResult.reason, REASONS.TEX_DECODE, '读回后原记录仍在');

  // 坏 JSON ⇒ 空表
  fs.writeFileSync(file, '{ not json', 'utf8');
  const broken = createEntryStates({ file, log: () => {}, now: () => 1000 });
  broken.load();
  assert.equal(broken.stats().keys, 0, '坏文件按空表处理');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('定序：at 更晚者胜；incoming 不晚于已存 ⇒ 不覆盖并返回当前状态', () => {
  const { store } = tmpStore();
  const first = store.put('r/d.bundle', { result: 'failed', reason: REASONS.TEX_DECODE, at: 1000 }, CTX);
  assert.equal(first.applied, true);

  // 更晚 ⇒ 覆盖
  const later = store.put('r/d.bundle', { result: 'ok', provider: 'unity-spine-bundle', at: 2000 }, CTX);
  assert.equal(later.applied, true);
  assert.equal(later.computed.loadResult.result, 'ok');

  // 更早 ⇒ 不覆盖（返回当前状态，仍是 ok）
  const stale = store.put('r/d.bundle', { result: 'failed', reason: REASONS.TEX_DECODE, at: 1500 }, CTX);
  assert.equal(stale.applied, false, 'incoming 不晚于已存 ⇒ 不覆盖');
  assert.equal(stale.computed.loadResult.result, 'ok', '返回的必须是当前状态');
});

test('同义码归一：服务端 not-handled 与前端 no-provider 落到同一个契约码', () => {
  const { store } = tmpStore();
  const a = store.put('r/e.bundle', { result: 'failed', reason: 'not-handled', at: 1000 }, CTX);
  const b = store.put('r/f.bundle', { result: 'failed', reason: 'no-provider', at: 1000 }, CTX);
  assert.equal(a.computed.loadResult.reason, REASONS.NO_PROVIDER);
  assert.equal(b.computed.loadResult.reason, REASONS.NO_PROVIDER);
});

test('flush 竞态：上一轮还在写盘时新写入的记录也必须落盘（回归）', async () => {
  // 实测踩到过：flush 里 `if (writing) return writing;` 放在 `dirty = false` 之后，
  //   第二轮请求拿到上一轮的 promise 就返回、脏标记已被清掉 ⇒ 新记录永不落盘
  //   （现象：连续两次 put，文件里只有第一条）。
  const { store, file, dir } = tmpStore();
  store.put('r/g1.bundle', { result: 'failed', reason: REASONS.TEX_DECODE, at: 1000 }, CTX);
  store.put('r/g2.bundle', { result: 'ok', provider: 'unity-spine-bundle', at: 2000 }, CTX);
  // 连开两次 flush（第二次会撞上第一次正在写）
  await Promise.all([store.flush(true), store.flush(true)]);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(saved.entries).length, 2, '两条记录都必须落盘');
  assert.equal(saved.entries['r/g2.bundle'].loadResult.result, 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('providerFingerprintOf：按 id 排序 ⇒ 顺序无关、内容可比', () => {
  const p1 = providers([['a', '#111', '1'], ['b', '#222', '2']]);
  const p2 = providers([['b', '#222', '2'], ['a', '#111', '1']]);
  assert.equal(providerFingerprintOf(p1), providerFingerprintOf(p2));
  assert.notEqual(providerFingerprintOf(p1), providerFingerprintOf(providers([['a', '#111', '9'], ['b', '#222', '2']])));
});
