// test/unpack-prefix-check.test.mjs —— 缓存命中时的 prefix 形态校验
//
// 为什么要有这条门禁：缓存命中时 prefix 是**原样返回**的（plugin-store.mjs 的 peek / resolve），
//   一旦插件改了 prefix 算法而指纹没覆盖到，旧产物会带着旧 prefix 注册进前端 VFS；
//   客户端按新形态拼地址 ⇒ 全部 miss ⇒ 静默回落网络（看起来"能打开"，实际每次多几个往返）。
//   这类问题不报错、不掉功能，只悄悄变慢，所以必须让它"可见"。
//
// 本测试锁三件事：
//   ① expectedPrefix 的公式（纯函数：无目录 / 单层 / 带哈希段 / 反斜杠 / 空对象）
//   ② prefixMismatch 的判定（一致 → null；不一致 → 给出缓存值与预期值）
//   ③ 现存全部缓存都不该被判为不一致（正常命中不能变成新噪音）
//
// 为什么不走 peek() 验证 warn：peek 要命中必须先凑齐指纹（含 pluginVersion 字符串），
//   换个环境就对不上，测试会变成"看运气"。判据本身（prefixMismatch）才是要钉住的东西。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedPrefix, prefixMismatch } from '../src/server/unpack/plugin-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('expectedPrefix：rel 无目录 ⇒ prefix 到 rootId 为止', () => {
  const p = expectedPrefix({ pluginId: 'unity-live2d-bundle', source: { rootId: 'azurlane_bundle', rel: 'aijier_3' } });
  assert.equal(p, 'vfs://unity-live2d-bundle/azurlane_bundle/');
});

test('expectedPrefix：rel 单层目录 ⇒ prefix 带该层', () => {
  const p = expectedPrefix({ pluginId: 'unity-live2d-bundle', source: { rootId: 'azurlane_bundle', rel: 'live2d/z46_2' } });
  assert.equal(p, 'vfs://unity-live2d-bundle/azurlane_bundle/live2d/');
});

test('expectedPrefix：rel 带哈希段目录 ⇒ 哈希段也要进 prefix', () => {
  const p = expectedPrefix({ pluginId: 'unity-live2d-bundle', source: { rootId: 'azurlane_bundle', rel: 'live2d_E8ADD23F/boyixi_2' } });
  assert.equal(p, 'vfs://unity-live2d-bundle/azurlane_bundle/live2d_E8ADD23F/');
});

test('expectedPrefix：反斜杠 rel 归一化成 / 再取目录', () => {
  assert.equal(expectedPrefix({ pluginId: 'p', source: { rootId: 'r', rel: 'a\\b_1' } }), 'vfs://p/r/a/');
});

test('expectedPrefix：字段缺失也不抛（异常输入的结果无实际意义，只要不炸）', () => {
  // 这里不断言具体字符串：缺 pluginId/rootId 时拼出来是 'vfs:////' 这种无意义形态，
  //   但这类输入不该出现（index.json 由本模块自己写），只要保证不抛就够了
  assert.equal(typeof expectedPrefix({}), 'string');
  assert.equal(typeof expectedPrefix(null), 'string');
});

test('prefixMismatch：一致 ⇒ null（正常命中不打任何日志）', () => {
  const idx = { pluginId: 'p', prefix: 'vfs://p/r/live2d/', source: { rootId: 'r', rel: 'live2d/x' } };
  assert.equal(prefixMismatch(idx), null);
});

test('prefixMismatch：不一致 ⇒ 给出缓存值与预期值（供 warn 直接拼）', () => {
  const idx = { pluginId: 'p', prefix: 'vfs://old/r/', source: { rootId: 'r', rel: 'live2d/x' } };
  const bad = prefixMismatch(idx);
  assert.ok(bad, '应当判为不一致');
  assert.equal(bad.cached, 'vfs://old/r/');
  assert.equal(bad.expect, 'vfs://p/r/live2d/');
  assert.equal(bad.rel, 'live2d/x', '日志要能带出 rel，便于定位');
});

test('prefixMismatch：prefix 不是字符串 ⇒ 不判（旧缓存缺字段时不该刷屏）', () => {
  assert.equal(prefixMismatch({ pluginId: 'p', source: { rootId: 'r', rel: 'x' } }), null);
  assert.equal(prefixMismatch(null), null);
});

test('现存全部缓存都与预期一致（否则正常命中会变成新噪音）', () => {
  const unpacked = path.join(ROOT, 'data', 'unpacked');
  if (!fs.existsSync(unpacked)) return;   // 本机没有缓存：skip
  const mismatched = [];
  let total = 0;
  for (const dirent of fs.readdirSync(unpacked, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const idxPath = path.join(unpacked, dirent.name, 'index.json');
    if (!fs.existsSync(idxPath)) continue;
    let idx = null;
    try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch { continue; }
    total += 1;
    const bad = prefixMismatch(idx);
    if (bad) mismatched.push({ fp: dirent.name, ...bad });
  }
  assert.deepEqual(mismatched, [], `有 ${mismatched.length}/${total} 份缓存 prefix 与预期不符`);
});
