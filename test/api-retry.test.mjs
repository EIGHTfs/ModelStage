// test/api-retry.test.mjs —— api.js 的重试 / 退避 / 超时 / in-flight 去重（任务 16 的九项验收）
//
// 用本地 http server 造各种故障（503、404、挂死、正常），**不 mock fetch**（除了计数网络错误那一条），
//   以免"测的是 mock 的行为"。所有断言都要求真实请求次数/时间间隔。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getJson, postJson, __clearInflightForTest } from '../src/web/infra/api.js';

/** 起一个临时 server，返回 { url, hits(), close() } */
async function serve(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ at: Date.now(), method: req.method, url: req.url });
    handler(req, res, hits.length);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((r) => server.close(r)),
  };
}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

test('① 5xx 会重试：前 2 次 503、第 3 次 200 → 成功且请求次数 = 3', async () => {
  __clearInflightForTest();
  const s = await serve((req, res, n) => (n < 3 ? json(res, 503, { error: '暂时不可用' }) : json(res, 200, { ok: true, n })));
  try {
    const data = await getJson(`${s.url}/x`);
    assert.deepEqual(data, { ok: true, n: 3 });
    assert.equal(s.hits.length, 3, '应当正好请求 3 次');
  } finally { await s.close(); }
});

test('② 4xx 不重试：404 → 失败且请求次数 = 1', async () => {
  __clearInflightForTest();
  const s = await serve((req, res) => json(res, 404, { error: '没有这个资源' }));
  try {
    await assert.rejects(() => getJson(`${s.url}/y`), /没有这个资源/);
    assert.equal(s.hits.length, 1, '4xx 只许请求 1 次');
  } finally { await s.close(); }
});

test('③ 网络错误会重试到上限：连不上 → 尝试 1 + 2 = 3 次', async () => {
  __clearInflightForTest();
  // 先起再关一个端口，确保没人监听
  const tmp = await serve((req, res) => json(res, 200, {}));
  const deadUrl = tmp.url;
  await tmp.close();
  const realFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (...args) => { attempts += 1; return realFetch(...args); };
  try {
    await assert.rejects(() => getJson(`${deadUrl}/z`), /重试 2 次后仍失败/);
    assert.equal(attempts, 3, '网络错误应当尝试 3 次（首发 + 2 次重试）');
  } finally { globalThis.fetch = realFetch; }
});

test('④ 退避递增：三次重试的间隔应≈100/300/900ms（±20% 抖动 + 定时器误差）', async () => {
  __clearInflightForTest();
  const s = await serve((req, res) => json(res, 503, { error: 'down' }));
  try {
    await assert.rejects(() => getJson(`${s.url}/slow`, { retries: 3 }), /重试 3 次后仍失败/);
    assert.equal(s.hits.length, 4, '首发 + 3 次重试');
    const gaps = s.hits.slice(1).map((h, i) => h.at - s.hits[i].at);
    // 抖动 ±20% ⇒ 下限 0.8x；定时器精度/事件循环延迟只往上偏，故上限放宽到 1.6x
    const base = [100, 300, 900];
    gaps.forEach((g, i) => {
      assert.ok(g >= base[i] * 0.8, `第 ${i + 1} 次重试间隔 ${g}ms 小于下界 ${base[i] * 0.8}`);
      assert.ok(g <= base[i] * 1.6 + 50, `第 ${i + 1} 次重试间隔 ${g}ms 超出上界`);
      if (i > 0) assert.ok(gaps[i] > gaps[i - 1], `间隔应递增：${gaps}`);
    });
    console.log('    退避实测间隔(ms):', gaps.join(' / '), '（基准 100/300/900）');
  } finally { await s.close(); }
});

test('⑤ GET 并发去重：同一 URL 同时 5 次 → 真实请求 = 1，5 个 Promise 拿到同一结果', async () => {
  __clearInflightForTest();
  const s = await serve((req, res) => setTimeout(() => json(res, 200, { v: 42 }), 120));
  try {
    const all = await Promise.all(Array.from({ length: 5 }, () => getJson(`${s.url}/dup`)));
    assert.equal(s.hits.length, 1, '只应有 1 次真实请求');
    assert.deepEqual(all, Array.from({ length: 5 }, () => ({ v: 42 })));
  } finally { await s.close(); }
});

test('⑥ POST 不合并：同一 URL 同时 3 次 POST → 真实请求 = 3', async () => {
  const s = await serve((req, res) => setTimeout(() => json(res, 200, { ok: true }), 80));
  try {
    await Promise.all([1, 2, 3].map((i) => postJson(`${s.url}/write`, { i })));
    assert.equal(s.hits.length, 3, 'POST 有副作用，绝不允许合并');
  } finally { await s.close(); }
});

test('⑦ 超时生效：端点挂死 → 到 timeoutMs 抛错，不无限挂着', async () => {
  __clearInflightForTest();
  const s = await serve(() => { /* 永不响应 */ });
  try {
    const t0 = Date.now();
    await assert.rejects(() => getJson(`${s.url}/hang`, { timeoutMs: 300, retries: 0 }), /失败|timeout|aborted/i);
    const ms = Date.now() - t0;
    assert.ok(ms < 3000, `应在超时附近返回（实测 ${ms}ms）`);
    console.log(`    超时实测 ${ms}ms（timeoutMs=300）`);
  } finally { await s.close().catch(() => {}); }
});

test('⑧ 错误可区分：首次即失败 vs 重试耗尽（文案不同）', async () => {
  __clearInflightForTest();
  const s404 = await serve((req, res) => json(res, 404, { error: '不存在' }));
  const s500 = await serve((req, res) => json(res, 500, { error: '服务端炸了' }));
  try {
    let first = '';
    let exhausted = '';
    await assert.rejects(() => getJson(`${s404.url}/a`), (e) => { first = e.message; return true; });
    await assert.rejects(() => getJson(`${s500.url}/b`), (e) => { exhausted = e.message; return true; });
    console.log('    首次即失败:', first);
    console.log('    重试耗尽  :', exhausted);
    assert.match(first, /失败：不存在/, '首次失败沿用原口径');
    assert.doesNotMatch(first, /重试/);
    assert.match(exhausted, /重试 2 次后仍失败）：HTTP 500/);
    assert.notEqual(first, exhausted);
  } finally { await s404.close(); await s500.close(); }
});

test('⑨ 反向自证：把重试次数设为 0 → 「5xx 会重试」必然变红', async () => {
  __clearInflightForTest();
  const s = await serve((req, res, n) => (n < 3 ? json(res, 503, { error: '暂时不可用' }) : json(res, 200, { ok: true })));
  try {
    // 默认重试时成功（与 ① 同构），retries:0 时应当直接失败 —— 证明"重试"确实是它在起作用
    // 首次即失败沿用原文案（服务端的 error 原文），但 status 仍带在错误对象上，上层可细分
    await assert.rejects(() => getJson(`${s.url}/x`, { retries: 0 }), (e) => {
      assert.equal(e.status, 503, '错误对象应带 status');
      assert.match(e.message, /暂时不可用/, '沿用原文案口径');
      return true;
    });
    assert.equal(s.hits.length, 1, 'retries:0 只允许 1 次请求');
  } finally { await s.close(); }
});
