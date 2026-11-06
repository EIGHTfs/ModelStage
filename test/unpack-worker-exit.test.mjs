// test/unpack-worker-exit.test.mjs —— unpack worker「退出 vs 卡住」的失败语义
//
// 这两类必须分开，且都不该让人白等：
//   · worker 已退出（崩溃/被杀/正常结束）⇒ 立即失败，文案带 code/signal
//   · worker 活着但不回应            ⇒ 等到 timeoutMs，文案明确说"无响应"
// 反面教材（本次修的就是这个）：worker 以 code=0 退出时旧代码不 reject，
//   在途请求白等 120s，最后报"timeout" —— 排查方向直接跑偏。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUnpackWorkerClient } from '../src/server/unpack/worker-client.mjs';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
/** 秒级判定阈值：崩溃应在毫秒级失败，留 5s 余量足够区分"立即"与"120s 超时" */
const IMMEDIATE_MS = 5000;

/** 造一个临时数据根（cleanupTmp 会扫它，必须是真实目录） */
function makeRootDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'unpack-exit-'));
}

/** run() 只把 task 转发给 worker；崩溃/挂起夹具不会读它，字段给最小合法值即可 */
function makeTask() {
  return { rootId: 'fixture-root', rel: 'fixture.bundle', absPath: '/nonexistent/fixture.bundle', meta: null, decl: null };
}

test('worker 以非 0 码退出 ⇒ 立即失败，文案含 code 且不是 timeout', async () => {
  const client = createUnpackWorkerClient({
    rootDir: makeRootDir(),
    workerUrl: new URL(`file://${path.join(FIXTURES, 'worker-crash-exit-7.mjs')}`),
  });
  const startedAt = Date.now();
  let caught = null;
  try {
    await client.run(makeTask(), {});
  } catch (error) {
    caught = error;
  }
  const elapsedMs = Date.now() - startedAt;
  await client.close();

  assert.ok(caught, 'worker 崩溃时 run() 必须 reject');
  assert.match(caught.message, /code=7/, `文案要含退出码，实际：${caught.message}`);
  assert.doesNotMatch(caught.message, /timeout|无响应/, `不应该报成超时，实际：${caught.message}`);
  assert.ok(elapsedMs < IMMEDIATE_MS, `应在毫秒级失败，实际耗时 ${elapsedMs}ms（若接近 120000 说明在等超时）`);
});

test('worker 以 code=0 正常退出 ⇒ 同样立即失败（否则在途请求白等 120s）', async () => {
  const client = createUnpackWorkerClient({
    rootDir: makeRootDir(),
    workerUrl: new URL(`file://${path.join(FIXTURES, 'worker-crash-exit-0.mjs')}`),
  });
  const startedAt = Date.now();
  let caught = null;
  try {
    await client.run(makeTask(), {});
  } catch (error) {
    caught = error;
  }
  const elapsedMs = Date.now() - startedAt;
  await client.close();

  assert.ok(caught, 'code=0 退出时在途请求也必须失败（它不会再有回复了）');
  assert.match(caught.message, /code=0/, `文案要含 code=0，实际：${caught.message}`);
  assert.ok(elapsedMs < IMMEDIATE_MS, `应立即失败而不是等超时，实际耗时 ${elapsedMs}ms`);
});

test('worker 活着但不回应 ⇒ 走 timeoutMs，文案与"已退出"明显不同', async () => {
  // timeoutMs 是**工厂级**配置（创建 client 时定），不是每次 run 传 —— 传错地方会静默用默认 120s，
  //   这一点本次实测踩到了（测试里先写错，跑了 120s 才暴露）。400ms 只为让测试快。
  const client = createUnpackWorkerClient({
    rootDir: makeRootDir(),
    workerUrl: new URL(`file://${path.join(FIXTURES, 'worker-hang.mjs')}`),
    timeoutMs: 400,
  });
  const startedAt = Date.now();
  let caught = null;
  try {
    await client.run(makeTask(), {});
  } catch (error) {
    caught = error;
  }
  const elapsedMs = Date.now() - startedAt;
  await client.close();

  assert.ok(caught, '卡住时 run() 必须 reject');
  assert.match(caught.message, /无响应|timeout/, `超时文案要能认出来，实际：${caught.message}`);
  // 断言的是「结论句」而不是「是否出现"已退出"三个字」：
  //   超时文案末尾特意写了"与「worker 已退出」是两类问题"做对照，按关键字断言会误伤。
  assert.doesNotMatch(caught.message, /^unpack worker 已退出/, `超时不能把结论写成"已退出"，实际：${caught.message}`);
  // 400ms 超时 + 终止开销：应在 1s 量级，而不是 5s+
  assert.ok(elapsedMs < IMMEDIATE_MS, `超时应在设定值附近触发，实际耗时 ${elapsedMs}ms`);
});
