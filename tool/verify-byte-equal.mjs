#!/usr/bin/env node
/**
 * verify-byte-equal.mjs — 重组产物 vs baseline 逐字节等价校验脚本（P0.5 基线验证）
 *
 * 用途：
 *   解压 bundle 过程中，每步回填后需要确认 dist/index.html 与 baseline/index.html
 *   逐字节一致（sha256 相同）。一致则说明解压/回填过程零改动，可继续下一步；
 *   不一致则说明某步切分/回填有偏移，必须先定位修复再继续。
 *
 * 用法：
 *   node tool/verify-byte-equal.mjs
 *
 * 依赖：仅 Node 内置 crypto / fs / path / url，零第三方依赖。
 * 说明：路径以本脚本位置为基准向上一级取项目根（不硬编码绝对路径）。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 以脚本自身位置定位项目根（tool/ 的上一级），避免硬编码绝对路径
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  { name: 'dist/index.html', path: join(ROOT, 'dist', 'index.html') },
  { name: 'baseline/index.html', path: join(ROOT, 'baseline', 'index.html') },
];

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

let failed = false;
const hashes = [];
for (const f of FILES) {
  try {
    const h = sha256(readFileSync(f.path));
    hashes.push({ ...f, hash: h });
    console.log(`  ${f.name}  sha256=${h}`);
  } catch (err) {
    console.error(`❌ 无法读取 ${f.path}\n   ${err.message}`);
    failed = true;
  }
}

if (failed) process.exit(1);

const equal = hashes[0].hash === hashes[1].hash;
if (equal) {
  console.log('✅ dist/index.html 与 baseline/index.html 逐字节一致（sha256 相同）');
} else {
  console.log('❌ 不一致！');
  console.log(`  dist/index.html     = ${hashes[0].hash}`);
  console.log(`  baseline/index.html = ${hashes[1].hash}`);
}
process.exit(equal ? 0 : 1);
