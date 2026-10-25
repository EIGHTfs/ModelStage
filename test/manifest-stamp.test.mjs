// test/manifest-stamp.test.mjs —— 清单签名比对（含「根目录不存在也是稳定状态」这条边界）
//
// 背景（P0 现场）：config 里有一个路径写错的根（live2d → …/DestinyChildLive2D/assets/live2d 不存在），
//   旧实现把"stat 不到目录"（null）一律判为"变了" ⇒ 每次请求都重建清单，
//   日志刷「目录已变化，清单失效重建」，白白耗 CPU/磁盘。
//   正确语义：上次也不存在（sig.root === null）⇒ 没变化 ⇒ 命中缓存。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirSignature, signatureMatches } from '../src/server/data/manifest-stamp.mjs';

const missing = path.join(os.tmpdir(), 'ms-probe-not-exist-please');

test('根目录不存在 + 清单里也是 null ⇒ 命中（不重建）', () => {
  const sig = dirSignature(missing);
  assert.equal(sig.root, null, '不存在的目录签名 root 应为 null');
  assert.equal(signatureMatches(sig, missing), true, '「上次也不存在」= 没变化 ⇒ 应命中');
});

test('根目录不存在 + 清单里有 mtime ⇒ 不命中（目录被删了，要重建）', () => {
  assert.equal(signatureMatches({ root: 1234567890, dirs: {} }, missing), false);
});

test('根目录存在且未变 ⇒ 命中；子目录 mtime 变了 ⇒ 不命中', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-probe-'));
  try {
    fs.mkdirSync(path.join(dir, 'm1'));
    const sig = dirSignature(dir);
    assert.equal(signatureMatches(sig, dir), true);
    // 新增一个子目录 ⇒ 应判为变化
    fs.mkdirSync(path.join(dir, 'm2'));
    assert.equal(signatureMatches(sig, dir), false);
    // 用新签名重新比对 ⇒ 命中
    const sig2 = dirSignature(dir);
    assert.equal(signatureMatches(sig2, dir), true);
    // 子目录 mtime 改变 ⇒ 不命中
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 'm1'), t, t);
    assert.equal(signatureMatches(sig2, dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('签名结构非法 ⇒ 不命中（宁重建不误用）', () => {
  assert.equal(signatureMatches(null, missing), false);
  assert.equal(signatureMatches({}, missing), false);
  assert.equal(signatureMatches({ root: null }, missing), false);
  assert.equal(signatureMatches({ root: null, dirs: 'x' }, missing), false);
});
