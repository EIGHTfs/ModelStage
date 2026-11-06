// test/ready-track.test.mjs —— 就绪阶段跟踪的"超时必须开口说话"（纯 node，不起浏览器）
//
// 为什么这条能守在 node 里：trackModelStage 只依赖
//   ① 一个鸭子类型的 canvas（isConnected / width / height）②两个取值函数 ③定时器，
//   整条路径的依赖链（ready.js → api.js）没有 window/document，import 不会炸。
//
// 覆盖（对应本次两处修复中的第一处）：
//   · 正常推进：painted 之后动作数到位 ⇒ **必须真的标 interactive**（曾经漏掉这一行，
//     表现为"跟踪器收尾了、阶段永远停在 painted"，浏览器套件等 20s 才失败）
//   · 有画面但到不了 interactive ⇒ 留下 not-interactive 记录，**不改阶段、不判 failed**
//   · 全程没有任何观测 ⇒ 判 failed 且带可读 reason
//   · 外部 stop() ⇒ 记 cancelled，既不是超时也不判 failed
import test from 'node:test';
import assert from 'node:assert/strict';

// 就绪上报会 POST /api/ready：node 里没有服务端，用桩 fetch 让上报"成功"，
//   避免测试被网络错误干扰（重试逻辑本身由 api-retry.test.mjs 覆盖）。
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const { trackModelStage, resetStage, snapshot, stats } = await import('../src/web/infra/ready.js');

/** 假画布：满足 mountedNow 的判据（已连接 + 非零尺寸） */
const fakeCanvas = { isConnected: true, width: 320, height: 480, clientWidth: 320, clientHeight: 480 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等到条件成立或超时（测试专用：超时即断言失败，用来暴露"事件永远不来"） */
async function waitUntil(predicate, { timeoutMs = 2000, label = '条件' } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await sleep(20);
  }
  throw new Error(`等待${label}超时（${timeoutMs}ms）`);
}

test('模型阶段：painted 之后动作到位 ⇒ 标 interactive（不可只收尾不标记）', async () => {
  let actions = 0;
  trackModelStage({
    kind: 'test', id: 'case-interactive', canvas: fakeCanvas,
    getFrames: () => 3, getActions: () => actions, timeoutMs: 3000,
  });
  await waitUntil(() => snapshot('model').state === 'painted', { label: 'painted' });
  actions = 6;                       // 动作清单到位
  await waitUntil(() => snapshot('model').state === 'interactive', { label: 'interactive' });
  const stage = snapshot('model');
  assert.equal(stage.state, 'interactive');
  assert.equal(stage.detail.actions, 6);
});

test('模型阶段：有画面但到不了 interactive ⇒ 只记录，阶段保持 painted、不判 failed', async () => {
  const before = stats().trackStops.length;
  trackModelStage({
    kind: 'test', id: 'case-stuck', canvas: fakeCanvas,
    getFrames: () => 4, getActions: () => 0, timeoutMs: 120,
  });
  await waitUntil(() => stats().trackStops.length > before, { label: '超时记录' });
  const record = stats().trackStops[stats().trackStops.length - 1];
  assert.equal(record.stage, 'model');
  assert.equal(record.outcome, 'not-interactive');
  assert.equal(record.last.frames, 4);
  assert.equal(record.last.actions, 0);
  const stage = snapshot('model');
  assert.equal(stage.state, 'painted', '已有画面时不能把阶段改成 failed');
  assert.equal(stage.reason, undefined);
});

test('模型阶段：全程没有任何观测 ⇒ 判 failed 且带可读原因', async () => {
  const before = stats().trackStops.length;
  trackModelStage({
    kind: 'test', id: 'case-none', canvas: null,
    getFrames: () => 0, getActions: () => 0, timeoutMs: 120,
  });
  await waitUntil(() => stats().trackStops.length > before, { label: '超时记录' });
  const record = stats().trackStops[stats().trackStops.length - 1];
  assert.equal(record.outcome, 'no-observation');
  const stage = snapshot('model');
  assert.equal(stage.state, 'failed');
  assert.match(String(stage.reason), /无任何观测/);
});

test('模型阶段：外部 stop() ⇒ 记为 cancelled，不报成超时、不判 failed', async () => {
  resetStage('model');
  const before = stats().trackStops.length;
  const stop = trackModelStage({
    kind: 'test', id: 'case-cancel', canvas: fakeCanvas,
    getFrames: () => 2, getActions: () => 0, timeoutMs: 5000,
  });
  await sleep(80);
  stop();
  await waitUntil(() => stats().trackStops.length > before, { label: '取消记录' });
  const record = stats().trackStops[stats().trackStops.length - 1];
  assert.equal(record.outcome, 'cancelled');
  assert.notEqual(snapshot('model').state, 'failed');
});
