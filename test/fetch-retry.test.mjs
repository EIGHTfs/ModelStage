// test/fetch-retry.test.mjs —— 模型文件抓取的"可控断连重试"（P0 回归）
//
// 现场问题：加载过很多模型后，浏览器复用了一条已被服务端关闭的连接（HTTP keep-alive race）
//   ⇒ 模型文件 fetch 直接 Failed to fetch ⇒ Spine 空白（资源包因走 blob 不受影响）。
//   修法是给模型文件 fetch 加重试。本测试用一个"第一次直接断连、之后正常"的本地服务复现该 race，
//   证明重试确实生效，并钉死"4xx 不重试"。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchWithRetry } from '../src/web/infra/api.js';

/** 起一个本地服务：前 `dropTimes` 次请求直接销毁 socket（模拟 race），之后正常 200 */
function startFlakyServer(dropTimes) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (hits <= dropTimes) {
      req.socket.destroy(); // 等价于"连接已被对端关闭"⇒ 客户端 fetch 抛 TypeError
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits: () => hits }));
  });
}

test('网络断连会重试，并在后续尝试成功', async () => {
  const { server, port, hits } = await startFlakyServer(1);
  try {
    const res = await fetchWithRetry(`http://127.0.0.1:${port}/model.skel`, { timeoutMs: 3000, retries: 2 });
    assert.equal(res.status, 200);
    assert.equal(hits(), 2, `应当重试一次后成功（实际请求 ${hits()} 次）`);
  } finally {
    server.close();
  }
});

test('4xx 不重试（只发 1 次）', async () => {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end('nope'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let hits = 0;
  server.on('request', () => { hits += 1; });
  try {
    await assert.rejects(
      () => fetchWithRetry(`http://127.0.0.1:${port}/missing.png`, { timeoutMs: 2000, retries: 2 }),
      /HTTP 404/,
    );
    assert.equal(hits, 1, `4xx 不能重试（实际请求 ${hits} 次）`);
  } finally {
    server.close();
  }
});

test('5xx 会重试，重试耗尽后报"重试 N 次后仍失败"', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits += 1; res.writeHead(503); res.end('busy'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => fetchWithRetry(`http://127.0.0.1:${port}/a.png`, { timeoutMs: 2000, retries: 1 }),
      /重试 1 次后仍失败/,
    );
    assert.equal(hits, 2, `5xx 应重试一次（实际 ${hits} 次）`);
  } finally {
    server.close();
  }
});
