// test/unpack-filesview.test.mjs —— filesView 判型纪律（假成功防线）
//
// 背景事故：早期实现里，判型失败（不是 Map）会把**任何对象**按 Object.keys 当路径字典，
//   于是把 view 对象本身 {ok, entries, take, release} 解释成 4~5 个"文件"并返回 ok:true。
//   这与 asset-harvester 的「files=0 但 19/19 成功」同类：假成功比报错危险。
// 本文件锁三条：真实产物正常识别 / view 二次包装必须响亮报错 / 任意对象必须 ok:false。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesView, unpackFile } from '../src/server/unpack/plugin-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_ROOT = path.resolve(ROOT, '..', 'live2d');
const PKG = 'beierfasite_2';

test('真实产物：files 视图 ok=true，entries 非空且 entry 在清单里', async () => {
  const abs = path.join(PKG_ROOT, PKG);
  if (!fs.existsSync(abs)) return; // 资源根不在本机时跳过（不假装通过：下面断言不会执行）
  const r = await unpackFile({ rootId: 'azurlane_bundle', rel: PKG, absPath: abs });
  assert.equal(r.ok, true, `解包应成功：${r.reason || ''} ${r.message || ''}`);
  assert.ok(r.files && Array.isArray(r.files.entries), 'files 必须是视图（entries 数组）');
  assert.equal(r.files.ok, true);
  assert.ok(r.files.entries.length > 0, '产物不能为空');
  const paths = r.files.entries.map((e) => e.path);
  assert.ok(paths.includes(r.entry), `entry(${r.entry}) 必须在产物清单里；实际前 5 个=${paths.slice(0, 5)}`);
  // 比 size 更硬的判据：能真取到字节
  const bytes = await r.files.take(paths[0]);
  assert.ok(bytes && bytes.length > 0, 'take() 必须能取到字节');
});

test('二次包装 view：必须抛错（绝不能把 {ok,entries,take,release} 当成文件路径）', async () => {
  assert.throws(() => filesView({ ok: true, entries: [], take: () => {}, release: () => {} }),
    /已经是文件视图|二次包装/, '传入 view 应当抛错并说明原因');
});

test('任意普通对象：ok=false + 明确原因（不得 ok=true）', () => {
  const v = filesView({ a: 1, b: 'x' });
  assert.equal(v.ok, false, '非字节值对象不能判成功');
  assert.equal(v.entries.length, 0, '不得把键当成文件路径');
  assert.match(v.error, /产物形状非法/, `错误信息应说明形状非法，实际：${v.error}`);
});

test('非对象/空值：ok=false 且原因能区分"不是文件集合"与"空产物"', () => {
  assert.equal(filesView(null).ok, false);
  assert.match(filesView(null).error, /不是文件集合/);
  assert.match(filesView(undefined).error, /不是文件集合/);
  assert.match(filesView('abc').error, /不是文件集合/);
  assert.match(filesView({}).error, /产物为空/);
});

test('真 Map（跨 realm 形状）：鸭子类型识别成功；值非法时 ok=false', () => {
  const good = new Map([['a.json', new Uint8Array([1, 2, 3])], ['b.png', new Uint8Array([4])]]);
  const v = filesView(good);
  assert.equal(v.ok, true);
  assert.equal(v.entries.length, 2);
  const bad = new Map([['a.json', 42]]);
  const v2 = filesView(bad);
  assert.equal(v2.ok, false);
  assert.match(v2.error, /产物形状非法/);
});
