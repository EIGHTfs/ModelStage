// test/roots-api.test.mjs —— 资源根 CRUD 的 **HTTP 契约**测试
//
// 迁自 test/browser/f4-roots.js（浏览器注入套件）：那 7 条断言的对象是"HTTP 响应 + 落盘结果"，
//   不是渲染/布局/事件链路，按分级判据属于第 2 级（HTTP 契约）⇒ 不该起浏览器。
//   迁出的收益不是"省一次 chromium"，而是：浏览器套件默认不进自动门禁（要 --browser），
//   这些断言原本**平时根本不执行**；迁到这里后进入默认门禁，每次 node --test 都跑。
//
// 服务怎么起：真模块 import（createServerData / createWriteApi / handleData）+ 本地 http server
//   + 独立数据根（os.tmpdir 下的临时目录，自带 config/resources.json）—— 不起子进程、不起浏览器。
//   传输层是最小垫片（sendJson / readBody 各十余行）：这两个函数在 serve.mjs 里是模块内的局部函数、
//   未导出；被测对象（路由分发 → 写管道 → 配置落盘 → 回读）全部是真实实现。
//
// 覆盖：add / rename（含改名合并语义）/ toggle / remove 四个写操作的成功与失败分支，
//   以及 400（参数缺失或非法）、409（目录重复登记）、404（目标不存在）三类状态码。
//   每条写操作都**再 GET 一次**确认持久化，而不是只信任写接口自己的返回。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServerData } from '../src/server/index.mjs';
import { handleData } from '../src/server/routes/data.mjs';
import { createWriteApi, toRootView } from '../src/server/http/write.mjs';

/** 项目根（代码目录跟随它；数据根用临时目录，绝不碰真实配置） */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 静默 logger：数据层要求 log 是对象（log.info(msg, detail) 形态） */
const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

/** 沙箱：临时数据根 + 本地 http server */
const sandbox = { dataRoot: null, dirA: null, dirB: null, server: null, base: '' };

/** 最小 JSON 响应（与 serve.mjs 的 sendJson 同形：无缩进 + no-store） */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

/** 最小请求体读取（只服务本测试的 JSON 请求，2MB 上限与线上一致） */
function readBody(req, res, onBody, maxBytes = 2e6) {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBytes) { sendJson(res, 413, { ok: false, error: '请求体过大' }); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => onBody(Buffer.concat(chunks).toString('utf8')));
  req.on('error', (e) => sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }));
}

before(async () => {
  sandbox.dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'roots-api-'));
  sandbox.dirA = path.join(sandbox.dataRoot, 'dir-a');
  sandbox.dirB = path.join(sandbox.dataRoot, 'dir-b');
  fs.mkdirSync(sandbox.dirA);
  fs.mkdirSync(sandbox.dirB);
  fs.mkdirSync(path.join(sandbox.dataRoot, 'config'), { recursive: true });
  // 两条真实存在的根：dir-a 用来撞名（改名合并），dir-b 作为"另一个已存在的名字"的载体。
  //   注意配置文件的形状是 { "roots": [...] }（见 core/config.mjs 的 readConfig），不是裸数组。
  fs.writeFileSync(path.join(sandbox.dataRoot, 'config', 'resources.json'), JSON.stringify({
    roots: [
      { id: 'alpha', name: 'Alpha', path: sandbox.dirA, enabled: true },
      { id: 'beta', name: 'Beta', path: sandbox.dirB, enabled: true },
    ],
  }, null, 2));

  const data = createServerData({ root: PROJECT_ROOT, dataRoot: sandbox.dataRoot, log: silentLog });
  const writeApi = createWriteApi({
    paths: data.paths, config: data.config, models: data.spine, names: data.names,
  });
  const ctx = { data, sendJson, readBody, writeApi, toRootView };

  sandbox.server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!handleData(req, res, url.pathname, url, ctx)) {
      // 与 serve.mjs:299 同口径：处理器常把 sendJson() 的返回值（undefined）当返回值，
      //   所以"返回 false"不代表没处理 —— 已经发过响应头就不能再写。
      if (res.headersSent) return;
      sendJson(res, 404, { ok: false, error: `未知接口: ${url.pathname}` });
    }
  });
  await new Promise((resolve) => sandbox.server.listen(0, '127.0.0.1', resolve));
  sandbox.base = `http://127.0.0.1:${sandbox.server.address().port}`;
});

after(async () => {
  if (sandbox.server) await new Promise((resolve) => sandbox.server.close(resolve));
  if (sandbox.dataRoot) fs.rmSync(sandbox.dataRoot, { recursive: true, force: true });
});

/** POST /api/roots → { status, body } */
async function postRoots(payload) {
  const res = await fetch(`${sandbox.base}/api/roots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

/** GET /api/roots → { status, body }（持久化口径：从磁盘重新读出来的结果） */
async function getRoots() {
  const res = await fetch(`${sandbox.base}/api/roots`);
  return { status: res.status, body: await res.json() };
}

/** 从 GET 结果里按 id 找根（找不到返回 null） */
function findRoot(body, id) {
  return (body.rootsAll || body.roots || []).find((r) => r.id === id) || null;
}

test('① add：200 + 启用根 +1 + 落盘可读（GET 复核）', async () => {
  const beforeRoots = (await getRoots()).body.roots;
  const freshDir = path.join(sandbox.dataRoot, 'dir-new');
  fs.mkdirSync(freshDir);
  const added = await postRoots({ action: 'add', path: freshDir, name: '断言A' });
  assert.equal(added.status, 200);
  assert.equal(added.body.ok, true);
  assert.equal(added.body.action, 'add');
  assert.ok(added.body.changed && added.body.changed.root, '应回带 changed.root');
  const newId = added.body.changed.root.id;
  assert.match(newId, /^[a-z0-9_-]+$/i, `新 id 形状应可读，实际 ${newId}`);
  assert.equal(added.body.changed.root.path, path.resolve(freshDir));

  // 落盘可读：换一次 GET（服务端从磁盘重读），不是信任写接口自己的返回
  const afterRoots = (await getRoots()).body.roots;
  assert.equal(afterRoots.length, beforeRoots.length + 1, '启用根数量应 +1');
  assert.ok(afterRoots.some((x) => x.id === newId), 'GET 里应能看到新根');
  sandbox.probeId = newId;                 // 后续用例复用（rename / toggle / remove）
});

test('② rename：200 + merged=false + 落盘可读', async () => {
  const r = await postRoots({ action: 'rename', id: sandbox.probeId, name: '断言A改名' });
  assert.equal(r.status, 200);
  assert.equal(r.body.changed.from, '断言A');
  assert.equal(r.body.changed.to, '断言A改名');
  assert.equal(r.body.changed.merged, false, '改成唯一名字不应 merged');

  const after = (await getRoots()).body;
  assert.equal(findRoot(after, sandbox.probeId).name, '断言A改名', 'GET 应读到新名字');
});

test('③ rename 命中同名：merged=true + 分组数 -1 + 启用根数不变', async () => {
  const before = (await getRoots()).body;
  const groupsBefore = before.groups.length;
  const rootsBefore = before.roots.length;

  const r = await postRoots({ action: 'rename', id: sandbox.probeId, name: 'Alpha' });   // alpha 已叫 Alpha
  assert.equal(r.status, 200);
  assert.equal(r.body.changed.merged, true, '与已有根同名 ⇒ merged=true（既定归并语义，不算冲突）');
  assert.equal(r.body.groups.length, groupsBefore - 1, '同名归并后分组数应 -1');
  assert.equal(r.body.roots.length, rootsBefore, '归并只影响分组，启用根条数不变');

  // 改回唯一名字，避免影响后续用例
  const back = await postRoots({ action: 'rename', id: sandbox.probeId, name: '断言A改名' });
  assert.equal(back.status, 200);
  assert.equal(back.body.changed.merged, false);
});

test('④ toggle：enabled=false 后从 roots 消失、仍留在 rootsAll', async () => {
  const r = await postRoots({ action: 'toggle', id: sandbox.probeId, enabled: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.changed.from, true);
  assert.equal(r.body.changed.to, false);
  // 启停要看得到"刚被停用的那条" ⇒ 只有**写响应**里带 rootsAll（GET /api/roots 只给启用的）
  assert.ok(Array.isArray(r.body.rootsAll), '写响应应带 rootsAll');
  const inAll = r.body.rootsAll.find((x) => x.id === sandbox.probeId);
  assert.ok(inAll, '停用的根必须仍在 rootsAll 里');
  assert.equal(inAll.enabled, false);
  assert.ok(!(r.body.roots || []).some((x) => x.id === sandbox.probeId), '停用后不该出现在"仅启用"的 roots 里');

  // 先恢复启用，再做 GET 复核 —— 保证即使上面某条断言失败，沙箱也回到干净状态（不连带影响后续用例）
  const on = await postRoots({ action: 'toggle', id: sandbox.probeId, enabled: true });
  assert.equal(on.status, 200);
  const after = (await getRoots()).body;
  assert.ok(after.roots.some((x) => x.id === sandbox.probeId), '恢复启用后应回到 roots');
});

test('⑤ 400 族：参数缺失或非法（相对路径 / 目录不存在 / 缺参 / 非布尔）', async () => {
  const rel = await postRoots({ action: 'add', path: 'relative/dir' });
  assert.equal(rel.status, 400);
  assert.match(rel.body.error, /绝对路径/);

  const missingDir = await postRoots({ action: 'add', path: path.join(sandbox.dataRoot, 'not-exist-dir') });
  assert.equal(missingDir.status, 400);
  assert.match(missingDir.body.error, /目录不存在/);

  const noPath = await postRoots({ action: 'add', path: '' });
  assert.equal(noPath.status, 400);
  assert.match(noPath.body.error, /缺少 path/);

  const noId = await postRoots({ action: 'rename', name: 'x' });
  assert.equal(noId.status, 400);
  assert.match(noId.body.error, /缺少 id/);

  const noName = await postRoots({ action: 'rename', id: 'alpha', name: '' });
  assert.equal(noName.status, 400);
  assert.match(noName.body.error, /缺少 name/);

  const badToggle = await postRoots({ action: 'toggle', id: 'alpha', enabled: 'false' });   // 字符串不算布尔
  assert.equal(badToggle.status, 400);
  assert.match(badToggle.body.error, /布尔值/);

  // 失败分支不许改动磁盘：GET 复核 alpha 仍是启用、名字未变
  const after = (await getRoots()).body;
  assert.equal(findRoot(after, 'alpha').name, 'Alpha', '失败请求不该改名');
  assert.equal(findRoot(after, 'alpha').enabled, true, '失败请求不该改启停');
});

test('⑥ 409 重复登记 / 404 目标不存在', async () => {
  const dup = await postRoots({ action: 'add', path: sandbox.dirB });   // dir-b 已是 beta 的路径
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /已登记/);
  // 409 必须带上"已登记的是哪个根"：前端要据此提示，缺了就只能显示一句泛泛的错误。
  //   这条断言防的是「补充字段没从 planChange 透传出来」——曾经 path/existing 恒为 undefined。
  assert.equal(dup.body.path, sandbox.dirB, '409 应回带冲突的 path');
  assert.ok(dup.body.existing && dup.body.existing.id, '409 应回带已登记的 existing.id');
  assert.ok(typeof dup.body.existing.name === 'string', '409 应回带已登记的 existing.name');

  const missRemove = await postRoots({ action: 'remove', id: '__nope__' });
  assert.equal(missRemove.status, 404);
  assert.match(missRemove.body.error, /未找到/);

  const missRename = await postRoots({ action: 'rename', id: '__nope__', name: 'x' });
  assert.equal(missRename.status, 404);
  assert.match(missRename.body.error, /未找到/);

  const missToggle = await postRoots({ action: 'toggle', id: '__nope__', enabled: false });
  assert.equal(missToggle.status, 404);
  assert.match(missToggle.body.error, /未找到/);
});

test('⑦ remove：200 + 回到基线 + 落盘可读（不污染配置）', async () => {
  const before = (await getRoots()).body.roots.length;
  const r = await postRoots({ action: 'remove', id: sandbox.probeId });
  assert.equal(r.status, 200);
  assert.equal(r.body.changed.removed.id, sandbox.probeId);

  const after = (await getRoots()).body;
  assert.equal(after.roots.length, before - 1, '删除后启用根数量应 -1');
  assert.equal(findRoot(after, sandbox.probeId), null, 'GET 里不该再有该根');
  assert.equal(after.roots.length, 2, '应回到沙箱初始的两条根');

  // 再删一次 ⇒ 404（幂等口径：不存在就是不存在，不静默成功）
  const again = await postRoots({ action: 'remove', id: sandbox.probeId });
  assert.equal(again.status, 404);
});
