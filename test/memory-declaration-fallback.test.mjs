// test/memory-declaration-fallback.test.mjs —— 补声明值那一步的兜底（准入热路径不许崩）
//
// 背景：probe.json 里不存插件声明的 peakBytes，所以缓存命中时 memoryDeclaration 要**现场问一次插件**
//   （详见 src/server/unpack/plugin-store.mjs 的 askDeclaredSafely 注释：为什么现场问、为什么不缓存）。
// 而这一步跑在准入热路径上：插件被卸载/关掉/解析抛错时，**绝不能让整条加载链路崩掉** ——
//   准入判断挂掉比"估得不准"严重得多。问不到就返回缓存值，再退才到 legacy 的源包大小粗估。
//
// 这里用注入的 askFn 覆盖异常路径（不卸载真插件、不动 config/plugins.json ——
//   那个开关文件用户在跑的实例也读，动了会影响真实使用）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { askDeclaredSafely, mergeDeclared } from '../src/server/unpack/plugin-store.mjs';

const REQ = { rootId: 'probe', rel: 'x/y', absPath: '/tmp/does-not-matter' };

test('① 插件抛错 ⇒ 返回 null，绝不向上抛（准入热路径的兜底）', () => {
  const boom = () => { throw new Error('blocksSummary 解析失败'); };
  assert.equal(askDeclaredSafely(REQ, boom), null);
});

test('② 插件不可用 / 返回空 ⇒ 返回 null（视为"问不到声明"）', () => {
  assert.equal(askDeclaredSafely(REQ, () => null), null);
  assert.equal(askDeclaredSafely(REQ, () => undefined), null);
  assert.equal(askDeclaredSafely(REQ, () => ({})), null);
  // decompressedBytes 为 0 等同于算不出来（契约要求声明必须能由块表推出）
  assert.equal(askDeclaredSafely(REQ, () => ({ decompressedBytes: 0, peakBytes: 999 })), null);
});

test('③ 正常拿到声明 ⇒ 原样返回', () => {
  const est = { decompressedBytes: 21 * 1024 * 1024, compressedBytes: 2 * 1024 * 1024, peakBytes: 732 * 1024 * 1024 };
  assert.deepEqual(askDeclaredSafely(REQ, () => est), est);
});

test('④ 真实现路径也走兜底而不是抛：给一个不存在的路径', () => {
  // 不注入 askFn，走真实 estimateMemoryOf（默认参数）——文件不存在时内部会出错，必须被吞掉
  assert.equal(askDeclaredSafely({ rootId: 'probe', rel: 'no-such', absPath: '/nonexistent/definitely-missing' }), null);
});

test('⑤ mergeDeclared：问不到声明 ⇒ 原样返回缓存（准入据此走 legacy 粗估）', () => {
  const cached = { decompressedBytes: 21 * 1024 * 1024, measuredPeakBytes: 225 * 1024 * 1024, samples: 2 };
  assert.equal(mergeDeclared(cached, null), cached, '必须原样返回同一个对象，不得丢字段');
  assert.equal(mergeDeclared(null, null), null, '缓存也没有 ⇒ null（调用方走 legacy）');
});

test('⑥ mergeDeclared：问到时合并 —— 声明值进得来，缓存的实测值不许丢', () => {
  const cached = { decompressedBytes: 1, measuredPeakBytes: 225 * 1024 * 1024, samples: 2, probeAt: 111 };
  const est = { decompressedBytes: 21 * 1024 * 1024, peakBytes: 732 * 1024 * 1024 };
  const merged = mergeDeclared(cached, est);
  assert.equal(merged.peakBytes, 732 * 1024 * 1024, '声明值必须合并进来（否则准入退化成 legacy）');
  assert.equal(merged.measuredPeakBytes, 225 * 1024 * 1024, '缓存的实测峰值必须保留');
  assert.equal(merged.samples, 2, '缓存的采样次数必须保留');
  assert.equal(merged.decompressedBytes, 21 * 1024 * 1024, '解压量以本次探测为准');
  assert.ok(merged.probeAt > 111, 'probeAt 刷新为本次时间');
});
