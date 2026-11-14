// test/display-name.test.mjs —— 列表显示名（契约 §1.3 / 设计 列表显示名-displayName.md）
//
// 钉住四件事：
//   ① 缓存读写与失效（size 变即失效；空串写成 null，不留空标题）
//   ② recompute 的第四字段：有 ctx.displayNameFor ⇒ 产出；没有 ⇒ null（旧行为不变）
//   ③ recompute 不因取名字失败而算不出状态（异常被吞成 null）
//   ④ 缓存文件坏了 / 不存在 ⇒ 空表，不抛（展示态缓存不能阻断列表）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  displayNameCacheFile,
  readDisplayNameCache,
  writeDisplayNameCache,
  lookupDisplayName,
  setDisplayNameEntry,
  hasDisplayNameRecord,
} from '../src/server/data/display-name-cache.mjs';
import { createEntryStates } from '../src/server/data/entry-states.mjs';

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'displayname-test-'));
  const configFile = path.join(dir, 'config', 'resources.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, '[]', 'utf8');
  try {
    return fn({ dir, configFile });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('缓存文件路径：与 resources.json 同目录', () => {
  withTmp(({ dir, configFile }) => {
    assert.equal(displayNameCacheFile(configFile), path.join(dir, 'config', 'bundle-display-names.json'));
  });
});

test('缓存：写过能读到；size 变了就失效', () => {
  withTmp(({ configFile }) => {
    const table = {};
    setDisplayNameEntry(table, 'rootA', 'a/b/__data', { displayName: 'char007', mtimeMs: 0, size: 100 });
    writeDisplayNameCache(configFile, table);

    const back = readDisplayNameCache(configFile);
    assert.equal(lookupDisplayName(back, 'rootA', 'a/b/__data', { size: 100 }), 'char007');
    // size 变 ⇒ 视为换了一份文件，不再采信旧名
    assert.equal(lookupDisplayName(back, 'rootA', 'a/b/__data', { size: 200 }), null);
    // 没给 stat ⇒ 无法判失效 ⇒ 采信
    assert.equal(lookupDisplayName(back, 'rootA', 'a/b/__data', undefined), 'char007');
  });
});

test('缓存：空串/全空白写成 null（不留空标题）', () => {
  withTmp(({ configFile }) => {
    const table = {};
    setDisplayNameEntry(table, 'r', 'x', { displayName: '   ', mtimeMs: 0, size: 1 });
    assert.equal(table['r/x'].displayName, null);
    setDisplayNameEntry(table, 'r', 'y', { displayName: '', mtimeMs: 0, size: 1 });
    assert.equal(table['r/y'].displayName, null);
    writeDisplayNameCache(configFile, table);
    assert.equal(lookupDisplayName(readDisplayNameCache(configFile), 'r', 'x', { size: 1 }), null);
  });
});

test('缓存：文件不存在给空表，不抛', () => {
  withTmp(({ configFile }) => {
    assert.deepEqual(readDisplayNameCache(configFile), {});
  });
});

test('缓存：记录为 null 也算"查过"（避免每次都重跑分析）', () => {
  withTmp(({ configFile }) => {
    const table = {};
    // 插件不支持 / 解析失败时写的就是这种记录
    setDisplayNameEntry(table, 'r', 'x', { displayName: null, mtimeMs: 0, size: 7 });
    writeDisplayNameCache(configFile, table);
    const back = readDisplayNameCache(configFile);

    assert.equal(lookupDisplayName(back, 'r', 'x', { size: 7 }), null, '名字仍是 null');
    assert.equal(hasDisplayNameRecord(back, 'r', 'x', { size: 7 }), true, '但"查过"要成立');
    // 文件换了（size 变）⇒ 记录失效，应当重新查
    assert.equal(hasDisplayNameRecord(back, 'r', 'x', { size: 8 }), false);
    // 没记录过的键
    assert.equal(hasDisplayNameRecord(back, 'r', 'never', { size: 7 }), false);
  });
});

test('缓存：文件内容坏了给空表（展示态缓存不能阻断列表）', () => {
  withTmp(({ configFile }) => {
    fs.writeFileSync(displayNameCacheFile(configFile), '{not json', 'utf8');
    assert.deepEqual(readDisplayNameCache(configFile), {});
  });
});

test('缓存：原子写（不留下 .tmp 残留）', () => {
  withTmp(({ configFile }) => {
    writeDisplayNameCache(configFile, { a: 1 });
    const dir = path.dirname(displayNameCacheFile(configFile));
    const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], `不应留下 tmp 文件，实际：${leftovers.join(',')}`);
  });
});

// ── recompute 的第四字段 ──────────────────────────────────────────────

/** 造一个最小的 entry-states 实例（不碰磁盘，纯内存表） */
function makeStates() {
  return createEntryStates({ file: null, now: () => 1700000000000 });
}

test('recompute：没有 ctx.displayNameFor ⇒ displayName 为 null（旧行为不变）', () => {
  const states = makeStates();
  const out = states.recompute(null, { providers: [] });
  assert.equal(out.displayName, null);
  assert.ok('displayName' in out, '字段必须在（调用方不该判断"有没有这个字段"）');
});

test('recompute：ctx.displayNameFor 给了名字 ⇒ 原样带出（不截断不加前后缀）', () => {
  const states = makeStates();
  const out = states.recompute(null, { providers: [], displayNameFor: () => 'cutscene_char000707' });
  assert.equal(out.displayName, 'cutscene_char000707');
});

test('recompute：displayNameFor 给空串/空白 ⇒ null（空串不算"有名字"）', () => {
  const states = makeStates();
  assert.equal(states.recompute(null, { providers: [], displayNameFor: () => '   ' }).displayName, null);
  assert.equal(states.recompute(null, { providers: [], displayNameFor: () => '' }).displayName, null);
  assert.equal(states.recompute(null, { providers: [], displayNameFor: () => null }).displayName, null);
});

test('recompute：displayNameFor 抛错 ⇒ 只让 displayName 变 null，状态照常算出', () => {
  const states = makeStates();
  const out = states.recompute(null, {
    providers: [],
    displayNameFor: () => { throw new Error('缓存读炸了'); },
  });
  assert.equal(out.displayName, null);
  // 其余字段必须还在（否则一条展示态故障会连带让 support/display 全空）
  assert.ok(out.display);
  assert.ok(out.support);
});
