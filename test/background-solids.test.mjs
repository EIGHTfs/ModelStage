// test/background-solids.test.mjs —— 纯色背景预设 11 条验收 + 权限 + 备份轮转
//
// 全部隔离在临时目录里跑（os.tmpdir + mkdtempSync），不碰 data/backgrounds/ 里的真实数据
//   —— 那里可能有用户上传过的背景图，测试绝不能依赖、更不能清理它。
//
// 为什么要用例 6 的"逐字节不变"和用例 10 的"corrupt 备份内容等于原文"：
//   这两条钉的是契约 §7.1.1「写入凭证」：**读失败 ≠ 没有数据**，
//   读失败时写默认值回去 = 把用户的列表清空了。只断言"返回 400"还不够，必须证明磁盘没被动过。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createBackgroundSolids, DEFAULT_SOLIDS, MESSAGES,
} from '../src/server/http/background-solids.mjs';

/** 造一个隔离环境：临时 dataDir + 新的存储句柄 */
function sandbox() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solids-test-'));
  const store = createBackgroundSolids({ dataDir });
  return { dataDir, store, file: store.file, dir: store.dir };
}

/** 取文件名列表（用于断言备份/轮转） */
const namesIn = (dir, prefix) => {
  try { return fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort(); } catch { return []; }
};

/** 读磁盘上的原始内容（逐字节比较用） */
const rawOf = (file) => fs.readFileSync(file, 'utf8');

test('1 首次初始化：文件不存在 ⇒ 恰好 5 条，顺序与默认一致', async () => {
  const { store, file } = sandbox();
  assert.equal(fs.existsSync(file), false, '前置：沙盒里本来没有数据文件');
  const r = store.list();
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 5);
  assert.deepEqual(r.body.items.map((x) => x.name), DEFAULT_SOLIDS.map((x) => x.name), '顺序与默认一致');
  assert.deepEqual(r.body.items.map((x) => x.id), DEFAULT_SOLIDS.map((x) => x.id), '默认 id 是确定性 slug');
  assert.equal(fs.existsSync(file), true, '初始化后应已写盘');
  // 每条都要有合法的 createdAt（number）
  for (const it of r.body.items) assert.equal(typeof it.createdAt, 'number');
});

test('2 新增：返回带 id 的 item，GET 里多一条', async () => {
  const { store } = sandbox();
  store.list();
  const r = await store.add({ name: '测试绿', color: '#00FF88' });
  assert.equal(r.status, 200);
  assert.ok(r.body.item.id, 'id 必须存在');
  assert.equal(r.body.item.color, '#00ff88', '颜色输出统一小写');
  assert.equal(typeof r.body.item.createdAt, 'number');
  const list = store.list().body.items;
  assert.equal(list.length, 6);
  assert.ok(list.some((x) => x.id === r.body.item.id));
});

test('3 改名：名字变了，id/color/createdAt 不变', async () => {
  const { store } = sandbox();
  const first = store.list().body.items[0];
  const r = await store.rename({ id: first.id, name: '改名后的炭黑' });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.name, '改名后的炭黑');
  assert.equal(r.body.item.id, first.id, 'id 不变');
  assert.equal(r.body.item.color, first.color, 'color 不变');
  assert.equal(r.body.item.createdAt, first.createdAt, 'createdAt 不变');
  const again = store.list().body.items.find((x) => x.id === first.id);
  assert.equal(again.name, '改名后的炭黑', '落盘后仍是新名字');
});

test('4 删除：少一条，其余 id 不变', async () => {
  const { store } = sandbox();
  const before = store.list().body.items;
  const victim = before[2];
  const r = await store.remove({ id: victim.id });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { removed: true, id: victim.id });
  const after = store.list().body.items;
  assert.equal(after.length, before.length - 1);
  assert.deepEqual(after.map((x) => x.id), before.filter((x) => x.id !== victim.id).map((x) => x.id));
});

test('5 恢复默认：改乱后 reset ⇒ 恰好 5 条默认，并生成 bak 备份', async () => {
  const { store, dir } = sandbox();
  const items = store.list().body.items;
  await store.remove({ id: items[0].id });
  await store.remove({ id: items[1].id });
  await store.add({ name: '临时', color: '#123456' });
  assert.equal(store.list().body.items.length, 4, '前置：已被改乱');

  const r = await store.reset();
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 5);
  assert.deepEqual(r.body.items.map((x) => x.id), DEFAULT_SOLIDS.map((x) => x.id));
  assert.equal(namesIn(dir, 'solids.bak-').length, 1, 'reset 前应有 1 份 bak');
});

test('6 非法 color：400，且数据文件逐字节未被改动', async () => {
  const { store, file } = sandbox();
  store.list();
  const before = rawOf(file);
  for (const bad of ['#abc', 'red', '#12345g', '#1234567', '']) {
    const r = await store.add({ name: '颜色坏', color: bad });
    assert.equal(r.status, 400, `color=${JSON.stringify(bad)} 应 400`);
    assert.equal(r.body.error, MESSAGES.badColor, '文案可直接给用户看');
  }
  assert.equal(rawOf(file), before, '非法输入不得改动数据文件（逐字节比较）');
});

test('7 空名 / 超长名 / 重名：分别 400，文案可读', async () => {
  const { store } = sandbox();
  const items = store.list().body.items;

  const empty = await store.add({ name: '   ', color: '#111111' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, MESSAGES.emptyName);

  const long = await store.add({ name: '字'.repeat(31), color: '#111111' });
  assert.equal(long.status, 400);
  assert.equal(long.body.error, MESSAGES.longName(31));

  const dup = await store.add({ name: items[0].name, color: '#111111' });
  assert.equal(dup.status, 400);
  assert.equal(dup.body.error, MESSAGES.dupName(items[0].name));

  // 改名撞名也要查重（排除自身）
  const self = await store.rename({ id: items[0].id, name: items[0].name });
  assert.equal(self.status, 200, '改成自己原来的名字不算重名');
  const clash = await store.rename({ id: items[1].id, name: items[0].name });
  assert.equal(clash.status, 400);
  assert.equal(clash.body.error, MESSAGES.dupName(items[0].name));
});

test('8 数量上限：50 条后再加 ⇒ 400，条数仍 50', async () => {
  const { store, file } = sandbox();
  store.list();
  // 已有 5 条，补到 50
  for (let i = 5; i < 50; i += 1) {
    const r = await store.add({ name: `填充${i}`, color: `#${String(i).padStart(6, '0')}` });
    assert.equal(r.status, 200, `第 ${i + 1} 条应成功`);
  }
  assert.equal(store.list().body.items.length, 50);
  const before = rawOf(file);
  const over = await store.add({ name: '第51个', color: '#abcdef' });
  assert.equal(over.status, 400);
  assert.equal(over.body.error, MESSAGES.tooMany);
  assert.equal(rawOf(file), before, '被拒绝的写入不得改动文件');
});

test('9 坏 JSON 自愈：GET 仍返回 5 条默认，且生成 solids.corrupt-*', async () => {
  const { store, dir, file } = sandbox();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '{坏的', 'utf8');

  const r = store.list();
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 5, '坏文件应被默认 5 条取代');
  const corrupts = namesIn(dir, 'solids.corrupt-');
  assert.equal(corrupts.length, 1, '应留一份 corrupt 备份');
  assert.equal(rawOf(path.join(dir, corrupts[0])), '{坏的', '备份内容 = 原始坏内容（逐字节）');
  // 自愈后文件本身已是合法 JSON
  assert.doesNotThrow(() => JSON.parse(rawOf(file)));
});

test('10 读失败不覆盖：corrupt 备份里的原文必须还在（不是被静默丢弃）', async () => {
  const { store, dir, file } = sandbox();
  fs.mkdirSync(dir, { recursive: true });
  const original = '{"version":1,"items":[{"id":"keep-me","name":"抢修","color":"#010203","createdAt":1}';
  fs.writeFileSync(file, original, 'utf8');   // 截断的 JSON（真实的"写一半"现场）

  store.list();                                // 触发自愈
  const corrupts = namesIn(dir, 'solids.corrupt-');
  assert.equal(corrupts.length, 1);
  assert.equal(rawOf(path.join(dir, corrupts[0])), original, '原文完整保留在备份里，没有被覆盖或截断');
});

test('11 并发：两个 POST 同时发不丢条目', async () => {
  const { store } = sandbox();
  store.list();
  const [a, b] = await Promise.all([
    await store.add({ name: '并发A', color: '#aa0001' }),
    await store.add({ name: '并发B', color: '#aa0002' }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const items = store.list().body.items;
  assert.equal(items.length, 7, '5 + 2');
  assert.ok(items.some((x) => x.id === a.body.item.id), 'A 必须在');
  assert.ok(items.some((x) => x.id === b.body.item.id), 'B 必须在（串行队列保证）');
});

test('12 权限：数据文件 0644、目录 0755（供 check-perms 前置检查）', async () => {
  const { store, dir, file } = sandbox();
  store.list();
  const fm = fs.statSync(file).mode & 0o777;
  const dm = fs.statSync(dir).mode & 0o777;
  assert.equal(fm, 0o644, `数据文件权限应为 644（实际 ${fm.toString(8)}）`);
  assert.equal(dm, 0o755, `目录权限应为 755（实际 ${dm.toString(8)}）`);
});

test('13 备份轮转：bak 与 corrupt 各自只保留最近 5 份', async () => {
  const { store, dir, file } = sandbox();
  store.list();
  // 造 7 次 reset ⇒ bak 应被轮转到 5 份
  for (let i = 0; i < 7; i += 1) await store.reset();
  assert.equal(namesIn(dir, 'solids.bak-').length, 5, 'bak 只保留最近 5 份');

  // 造 7 次损坏 ⇒ corrupt 也只保留 5 份
  for (let i = 0; i < 7; i += 1) {
    fs.writeFileSync(file, `{坏${i}`, 'utf8');
    store.list();
  }
  assert.equal(namesIn(dir, 'solids.corrupt-').length, 5, 'corrupt 只保留最近 5 份');
});
