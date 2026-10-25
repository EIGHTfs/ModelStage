// vfs.test.mjs —— VirtualFS 纯模块单测（node --test 运行，不依赖浏览器）
//
// 覆盖：注册 / 命中 / 未命中 / 相对路径归一化 / revoke 后失效 / 重复注册报错 /
//       懒创建与缓存 / 统计口径 / 非法输入。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualFS } from '../src/web/infra/vfs.js';

/** 造一个可观测的 URL 工厂（Node 里没有 URL.createObjectURL，这里用假实现） */
function fakeUrlFactory() {
  let seq = 0;
  const created = [];
  const revoked = [];
  return {
    createObjectURL(blob) {
      seq += 1;
      const url = `blob:fake/${seq}`;
      created.push({ url, size: blob && blob.size });
      return url;
    },
    revokeObjectURL(url) { revoked.push(url); },
    created,
    revoked,
  };
}

test('注册后命中：返回 Blob URL，且同一文件复用同一个 URL', () => {
  const f = fakeUrlFactory();
  const vfs = createVirtualFS(f);
  vfs.register('/atlas/', new Map([['a/b.png', 'hello']]));

  const first = vfs.resolve('/atlas/a/b.png');
  const second = vfs.resolve('/atlas/a/b.png');
  assert.equal(first, 'blob:fake/1');
  assert.equal(second, first, '同文件应复用缓存的 Blob URL');
  assert.equal(f.created.length, 1, '懒创建：只创建一次');
  assert.equal(f.created[0].size, 5, 'Blob 大小 = 字符串 UTF-8 字节数');
});

test('未命中返回 null（调用方回落原 URL），并计入 misses', () => {
  const f = fakeUrlFactory();
  const vfs = createVirtualFS(f);
  vfs.register('atlas', { 'a.png': 'x' });
  assert.equal(vfs.resolve('/atlas/missing.png'), null);
  assert.equal(vfs.resolve('/other/a.png'), null);
  assert.equal(vfs.resolve(''), null);
  const s = vfs.stats();
  assert.equal(s.hits, 0);
  assert.equal(s.misses, 3);
  assert.equal(f.created.length, 0, '未命中不应创建任何 URL');
});

test('相对路径归一化：./ 与 ../ 与反斜杠', () => {
  const f = fakeUrlFactory();
  const vfs = createVirtualFS(f);
  vfs.register('/live2d-lib/', { 'model/a.png': 'A' });
  assert.equal(vfs.resolve('/live2d-lib/./model/a.png'), 'blob:fake/1');
  assert.equal(vfs.resolve('/live2d-lib/model/../model/a.png'), 'blob:fake/1');
  assert.equal(vfs.resolve('\\live2d-lib\\model\\a.png'), 'blob:fake/1');
});

test('相对路径归一化：查询串、哈希、URL 编码、绝对 URL', () => {
  const f = fakeUrlFactory();
  const vfs = createVirtualFS(f);
  vfs.register('atlas', { 'a/b.png': 'B', '中 文.png': 'C' });
  assert.equal(vfs.resolve('atlas/a/b.png?v=2'), 'blob:fake/1');
  assert.equal(vfs.resolve('atlas/a/b.png#frag'), 'blob:fake/1');
  assert.equal(vfs.resolve('/atlas/a/b%2Epng'), 'blob:fake/1');
  assert.equal(vfs.resolve('https://example.com/atlas/a/b.png?x=1'), 'blob:fake/1');
  assert.equal(vfs.resolve('/atlas/%E4%B8%AD%20%E6%96%87.png'), 'blob:fake/2');
});

test('revoke：释放该前缀下全部 URL，之后 resolve 返回 null', () => {
  const f = fakeUrlFactory();
  const vfs = createVirtualFS(f);
  vfs.register('atlas', { 'a.png': 'A', 'b.png': 'B' });
  vfs.resolve('atlas/a.png');
  vfs.resolve('atlas/b.png');
  assert.equal(f.created.length, 2);

  const released = vfs.revoke('atlas');
  assert.equal(released, 2, '应逐个释放 2 个 Blob URL');
  assert.deepEqual(f.revoked.sort(), ['blob:fake/1', 'blob:fake/2'].sort());
  assert.equal(vfs.resolve('atlas/a.png'), null, 'revoke 后必须失效');
  assert.equal(vfs.stats().prefixes, 0);
  assert.equal(vfs.revoke('atlas'), 0, '重复 revoke 返回 0 而不是抛错');
});

test('重复注册同一 prefix 抛错（不允许覆盖）', () => {
  const f = fakeUrlFactory();
  const vfs = createVirtualFS(f);
  vfs.register('atlas', { 'a.png': 'A' });
  assert.throws(() => vfs.register('atlas', { 'b.png': 'B' }), /prefix 已注册/);
  // 归一化后等价的前缀也算重复
  assert.throws(() => vfs.register('/atlas/', { 'c.png': 'C' }), /prefix 已注册/);
});

test('非法输入抛错：空 prefix、非法路径、非 Blob/字符串内容', () => {
  const f = fakeUrlFactory();
  const vfs = createVirtualFS(f);
  assert.throws(() => vfs.register('', { 'a.png': 'A' }), /prefix 不能为空/);
  assert.throws(() => vfs.register('x', { '': 'A' }), /非法相对路径/);
  assert.throws(() => vfs.register('y', { 'a.png': 123 }), /必须是 Blob 或字符串/);
});

test('统计口径：prefixes / files / bytes / hits / misses', () => {
  const f = fakeUrlFactory();
  const vfs = createVirtualFS(f);
  vfs.register('one', { 'a.txt': 'abc' });          // 3 字节
  vfs.register('two', { 'b.txt': 'de', 'c.txt': 'f' }); // 2 + 1 字节
  vfs.resolve('one/a.txt');
  vfs.resolve('one/none.txt');
  vfs.resolve('two/b.txt');
  const s = vfs.stats();
  assert.equal(s.prefixes, 2);
  assert.equal(s.files, 3);
  assert.equal(s.bytes, 6);
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
  assert.equal(s.urls, 2, '只有命中过的文件才创建 URL');
});

test('Blob 内容按原样返回（不复制、不改类型）', () => {
  const f = fakeUrlFactory();
  const vfs = createVirtualFS(f);
  const blob = new Blob(['binary'], { type: 'image/png' });
  vfs.register('img', { 'x.png': blob });
  vfs.resolve('img/x.png');
  assert.equal(f.created[0].size, 6);
});
