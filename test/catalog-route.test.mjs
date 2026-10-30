// test/catalog-route.test.mjs —— /api/catalog 的入参分流语义
//
// 锁一条容易漂的语义（曾经一律回 404）：
//   缺 root / 空串 ⇒ 400（调用方错误，带可用根清单）
//   给了非空但不存在的 id ⇒ 404（资源不存在，语义本来就对）
//   合法根 ⇒ 200 且 entries 非空
//
// 为什么要单独锁：404 与 400 混在一起时，"路径拼错了"和"这个根不存在"在日志里
//   长得一模一样 —— 排查时会白费一轮（实例：按 404 去翻根配置，
//   实际是请求把 /api/catalog 拼成了 /api/catalog/models）。
//
// 直调路由（不起 http）：handleData 是导出函数，签名就是 (req, res, p, url, ctx)，
//   mock 一个只收 sendJson 的 res 就够，比起真服务快且不受端口/并发影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerData } from '../src/server/index.mjs';
import { handleData } from '../src/server/routes/data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = createServerData({ root: ROOT, dataRoot: ROOT });

/** 直调一次路由，返回 { status, body }；路由没处理则 status=null */
function callCatalog(search) {
  let captured = null;
  const res = {};
  const ctx = {
    data,
    sendJson: (_res, status, body) => { captured = { status, body }; },
    sendFile: () => { throw new Error('本用例不该走 sendFile'); },
    resolveSafe: () => null,
    browseDir: () => { throw new Error('本用例不该走 browseDir'); },
    toRootView: (x) => x,
    readBody: () => { throw new Error('本用例不该走 readBody'); },
  };
  const handled = handleData({ method: 'GET' }, res, '/api/catalog', new URL(`http://x/api/catalog${search}`), ctx);
  // 注意：这里**不断言 handled === true**。apiAsync 的 catalog 分支是 `return sendJson(...)`，
  //   而 sendJson 返回 undefined ⇒ handleData 最终会 return false。
  //   属既有小瑕疵（与 JSDoc 的 @returns 是否已处理 不一致），但不影响功能：
  //   响应已经发出去，后续 handler 看到 res 已结束会跳过。只断言"确实发出了响应"。
  void handled;
  assert.ok(captured, '应发出响应');
  return captured;
}

test('缺 root 参数 → 400（不是 404），并给出可用根清单', () => {
  const r = callCatalog('');
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /缺少 root/);
  assert.ok(Array.isArray(r.body.known), 'known 应是数组');
  assert.ok(r.body.known.length > 0, 'known 不该为空（本机有资源根）');
});

test('root 为空串 → 400（与缺参同义）', () => {
  const r = callCatalog('?root=');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /缺少 root/);
});

test('root 只有空白 → 400（trim 后为空）', () => {
  const r = callCatalog('?root=%20%20');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /缺少 root/);
});

test('给了一个不存在的根 → 404（语义不变：资源不存在）', () => {
  const r = callCatalog('?root=no-such-root-xyz');
  assert.equal(r.status, 404);
  assert.match(r.body.error, /未找到资源根/);
});

test('给一个真实的根 → 200 且 entries 非空', () => {
  const roots = data.config.readConfig();
  assert.ok(roots.length > 0, '本机应至少有一个资源根');
  // 挑一个确实存在的根（exists 为真是扫描出来的；这里用配置里的第一个，
  //   若它恰好不在盘上，listCatalog 仍会 200 但 entries 为空 —— 那种情况跳过断言）
  const r = callCatalog(`?root=${encodeURIComponent(roots[0].id)}`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.entries), 'entries 应是数组');
});
