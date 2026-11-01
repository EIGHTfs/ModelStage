// test/bundle-node-name.test.mjs —— 「哪个节点是 serialized file」的判据，四处必须一致且正确
//
// 为什么需要这份测试：UnityFS 包里以 `CAB-` 开头的节点**不止一种**
//   · `CAB-<32位hex>`             ← 真正的 serialized file（对象表在这里）
//   · `CAB-<32位hex>.resS`        ← 裸资源流（贴图/音频字节池）
//   · `CAB-<32位hex>.resource`    ← FMOD 音频银行，魔数 "FSB5"
// 后两者喂给 `serialized.parse` 会读到 2^60 量级的垃圾 `fileSize`（实测过），
// 而错误会传播很远。判据必须是**结构形式**，不能是名字前缀。
//
// 为什么从**源码文本**里提取正则来测，而不是在测试里复制一份：
//   这四处是各自独立的实现（前端一份、两个插件的 lib 各一份、live2d probe 一份），
//   架构上无法共享模块（前端不能 import tool/，插件 lib 是浏览器脚本不是 ESM）。
//   如果测试里另写一份正则，那测的就是"测试自己的副本"，实现改坏了测试照样绿。
//   从源码里提取 ⇒ **改坏任何一处，对应断言立刻红**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 承载该判据的四个文件（每个都是独立的实现副本，故意列全） */
const SOURCES = [
  'src/web/infra/plugin-host-unpack.mjs',
  'plugins/unity-live2d-bundle/lib/bundle-probe.js',
  'plugins/unity-live2d-bundle/lib/unityfs.js',
  'plugins/unity-spine-bundle/lib/unityfs.js',
];

/**
 * 从源码里提取"结构判据"正则的字面写法。
 * 只要实现里出现 `/^CAB-[0-9a-f]{32}$/i`，就能抓到（不依赖周围代码怎么排版）。
 * @param {string} rel 相对项目根的路径
 * @returns {string|null} 正则字面量的文本；找不到返回 null（= 该处没改或写成了别的形式）
 */
function extractPattern(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const hit = /\/\^CAB-\[0-9a-f\]\{32\}\$\/i/.exec(text);
  return hit ? hit[0] : null;
}

/** 判据本身：用**从源码提取到的文本**构造，保证测的是真实实现 */
function makeMatcher(literal) {
  // 字面量形如 "/^CAB-[0-9a-f]{32}$/i"：去掉首尾斜杠与 flag 再构造
  const body = literal.slice(1, literal.lastIndexOf('/'));
  const flags = literal.slice(literal.lastIndexOf('/') + 1);
  return (name) => new RegExp(body, flags).test(name);
}

const HEX32 = '0123456789abcdef0123456789abcdef';

test('四处实现都用了结构判据（不是名字前缀）', () => {
  for (const rel of SOURCES) {
    assert.ok(extractPattern(rel), `${rel} 里没找到 /^CAB-[0-9a-f]{32}$/i —— 判据没改或写成了别的形式`);
  }
});

test('四处的判据文本完全一致（防漂移：一份改了另一份没改）', () => {
  const patterns = SOURCES.map((rel) => ({ rel, p: extractPattern(rel) }));
  const uniq = [...new Set(patterns.map((x) => x.p))];
  assert.equal(uniq.length, 1, `判据出现了 ${uniq.length} 种写法：${JSON.stringify(patterns)}`);
});

test('判据正确性：真 CAB 通过、.resS/.resource/畸形名拒绝', () => {
  const pat = extractPattern(SOURCES[0]);
  assert.ok(pat, '找不到判据正则');
  const isSerialized = makeMatcher(pat);

  // 真 serialized file
  assert.equal(isSerialized(`CAB-${HEX32}`), true, '标准 CAB-<hex32> 必须判为 true');
  // 大小写不敏感（i flag）：Unity 实际输出是小写，但别把判据写死成区分大小写
  assert.equal(isSerialized(`CAB-${HEX32.toUpperCase()}`), true, '十六进制大写也应通过');

  // 裸资源流（贴图/音频字节池）—— 不是 serialized file
  assert.equal(isSerialized(`CAB-${HEX32}.resS`), false, '.resS 必须拒绝');
  assert.equal(isSerialized(`CAB-${HEX32}.ress`), false, '.ress 也该拒绝（大小写变体）');

  // FMOD 音频银行（头是 FSB5）—— 不是 serialized file
  assert.equal(isSerialized(`CAB-${HEX32}.resource`), false, '.resource 必须拒绝');
  assert.equal(isSerialized(`CAB-${HEX32}.Resource`), false, '.Resource 也该拒绝');

  // 长度/字符不对：不能靠"前缀匹配"蒙混过关
  assert.equal(isSerialized('CAB-xyz'), false, '长度不足必须拒绝');
  assert.equal(isSerialized(`CAB-${HEX32}0`), false, '33 位必须拒绝');
  assert.equal(isSerialized(`CAB-${HEX32.slice(1)}`), false, '31 位必须拒绝');
  assert.equal(isSerialized(`CAB-${'g'.repeat(32)}`), false, '非十六进制字符必须拒绝');
  assert.equal(isSerialized(`CAB-${HEX32}.`), false, '尾部多余的点必须拒绝');
  assert.equal(isSerialized(`CAB${HEX32}`), false, '漏掉连字符必须拒绝');

  // 无关节点
  assert.equal(isSerialized('CAB'), false);
  assert.equal(isSerialized(''), false);
  assert.equal(isSerialized(`dir/CAB-${HEX32}`), false, '当前判据要求节点名不带目录前缀（实测样本都如此）');
});
