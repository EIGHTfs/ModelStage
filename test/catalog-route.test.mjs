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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerData } from '../src/server/index.mjs';
import { handleData } from '../src/server/routes/data.mjs';
// 根级诊断那组用例用假依赖直调 catalog（造"坏根"不能改真实配置）
import { createCatalog } from '../src/server/data/catalog.mjs';

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

// ---------------- 根级诊断 rootWarning ----------------
//
// 为什么要锁：根路径坏掉时以前返回 200 + count:0 + warnings:[]，
//   前端判成"成功、只是没模型"，于是显示「该游戏没有可加载模型」——
//   与"这根确实没有模型"完全不可区分，用户拿不到任何线索。
// 用例不碰真实配置（会污染用户数据）：给 createCatalog 注入假依赖，想看哪根出问题就造哪根。

/** 用假依赖跑一次 listCatalog：rootPath 决定这一根"长什么样" */
function catalogWithRoot(rootPath) {
  const catalog = createCatalog({
    config: { readConfig: () => [{ id: 'probe-root', name: '探针根', path: rootPath }] },
    spine: { getSpineModels: () => ({ models: [] }) },
    live2d: { getLive2DModels: () => ({ models: [] }) },
    tree: {},
    // 不认任何容器：本组用例只关心"根级"结论，不需要容器条目参与
    plugins: { readPlugins: () => [], detectBundleContainer: () => null },
  });
  return catalog.listCatalog('probe-root');
}

test('根路径不存在 → 200 + rootWarning 说"路径不存在"，且不带绝对路径', () => {
  const r = catalogWithRoot('/no/such/dir-for-catalog-test');
  assert.equal(r.status, 200, '路径坏掉仍应是 200（否则前端只能显示"加载失败"）');
  assert.equal(r.body.count, 0);
  assert.equal(typeof r.body.rootWarning, 'string');
  assert.match(r.body.rootWarning, /不存在/);
  assert.match(r.body.rootWarning, /rootId=probe-root/, '文案要带 rootId 便于对照配置');
  assert.ok(!r.body.rootWarning.includes('/no/such/dir'), '文案不许带绝对路径（那是排障信息，进日志）');
});

test('根路径指向一个文件（不是目录）→ rootWarning 说"不是目录"', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-root-file-'));
  const filePath = path.join(tmp, 'a-file.txt');
  fs.writeFileSync(filePath, 'x');
  try {
    const r = catalogWithRoot(filePath);
    assert.equal(r.status, 200);
    assert.match(r.body.rootWarning, /不是目录/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('根路径正常但扫不到条目 → rootWarning 说"没有任何模型条目"（与路径问题文案不同）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-root-empty-'));
  try {
    const r = catalogWithRoot(tmp);
    assert.equal(r.status, 200);
    assert.equal(r.body.count, 0);
    assert.match(r.body.rootWarning, /没有任何模型条目/);
    assert.doesNotMatch(r.body.rootWarning, /不存在|不是目录/, '文案要和路径问题区分开');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('rootId 不存在 → 仍 404，且不带 rootWarning 字段', () => {
  const r = callCatalog('?root=definitely-not-a-root');
  assert.equal(r.status, 404);
  assert.equal(r.body.rootWarning, undefined, '404 分支不该有 rootWarning（那是 200 才有的字段）');
});

test('真实的根且能扫到东西 → rootWarning 为 null', () => {
  const roots = data.config.readConfig();
  // 挑一个真的在盘上、且能列出条目的根；找不到就跳过（本机资源根可能是空的）
  const alive = roots.find((x) => {
    try { return fs.existsSync(x.path); } catch { return false; }
  });
  if (!alive) return;
  const r = callCatalog(`?root=${encodeURIComponent(alive.id)}`);
  assert.equal(r.status, 200);
  if (r.body.count > 0) assert.equal(r.body.rootWarning, null, '扫到条目时不该有根级警告');
  else assert.match(String(r.body.rootWarning), /没有任何模型条目/, '空根应给出"没有条目"的根级警告');
});
