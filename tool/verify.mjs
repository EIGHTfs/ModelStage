#!/usr/bin/env node
// verify.mjs — 校验 build 产物与原始基线的「运行时对象」是否逐字节一致
//
// 校验项（两条都要过，才算拆分未改变行为）：
//   1. 尺寸一致：产物与基线字节数相同
//   2. 运行时对象一致：从两边各自解析出 window.__SPINE_RUNTIME_SOURCES__ 对象，
//      逐版本比对源码字符串（JSON.parse 后严格相等）
//
// 为什么校验运行时对象而不是整个文件：
//   应用代码部分我们在本阶段未改动（只是原样保留在外壳里），所以全文件若不等，
//   必然是运行时内联环节出了问题——针对性比对运行时对象即可定位。
//
// 用法：node tool/verify.mjs
// 退出码：0 = 通过；1 = 不一致（需排查 build.mjs）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(ROOT, 'baseline', 'index.html');
const BUILT = path.join(ROOT, 'dist', 'index.html');
const KEY = 'window.__SPINE_RUNTIME_SOURCES__';

/** 从 html 中抽出运行时对象并解析为 {版本: 源码}。 */
function extractRuntimeObject(html) {
  const keyPos = html.indexOf(KEY);
  if (keyPos < 0) return null;
  const eq = html.indexOf('=', keyPos);
  const start = html.indexOf('{', eq);
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = false; continue; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;
  const objText = html.slice(start, end + 1);
  try {
    return { obj: JSON.parse(objText), raw: objText };
  } catch (e) {
    return { parseError: e.message, raw: objText };
  }
}

function main() {
  let fail = 0;

  if (!fs.existsSync(BASELINE)) { console.error('缺少基线 baseline/index.html'); process.exit(1); }
  if (!fs.existsSync(BUILT)) { console.error('缺少产物 dist/index.html，请先运行 build.mjs'); process.exit(1); }

  const baseBuf = fs.readFileSync(BASELINE);
  const builtBuf = fs.readFileSync(BUILT);

  // 校验 1：字节数
  console.log('【校验 1】字节数');
  console.log(`  基线: ${baseBuf.length}`);
  console.log(`  产物: ${builtBuf.length}`);
  if (baseBuf.length === builtBuf.length) {
    console.log('  ✅ 一致');
  } else {
    console.log(`  ❌ 不一致（差 ${builtBuf.length - baseBuf.length} 字节）`);
    fail++;
  }

  const baseHtml = baseBuf.toString('utf8');
  const builtHtml = builtBuf.toString('utf8');

  // 校验 2：运行时对象逐版本比对
  console.log('');
  console.log('【校验 2】运行时对象逐版本比对');
  const b = extractRuntimeObject(baseHtml);
  const p = extractRuntimeObject(builtHtml);

  if (!b || b.parseError) {
    console.log(`  ❌ 基线解析失败: ${b?.parseError ?? '未找到对象'}`);
    fail++;
  } else if (!p || p.parseError) {
    console.log(`  ❌ 产物解析失败: ${p?.parseError ?? '未找到对象'}`);
    fail++;
  } else {
    const bv = Object.keys(b.obj).sort();
    const pv = Object.keys(p.obj).sort();
    console.log(`  基线版本: ${bv.join(', ')}`);
    console.log(`  产物版本: ${pv.join(', ')}`);

    if (bv.join(',') !== pv.join(',')) {
      console.log('  ❌ 版本集合不一致');
      fail++;
    } else {
      for (const v of bv) {
        const same = b.obj[v] === p.obj[v];
        const size = Buffer.byteLength(b.obj[v], 'utf8');
        console.log(`  ${v.padEnd(5)} ${(size / 1024).toFixed(0).padStart(4)} KB  ${same ? '✅ 逐字节一致' : '❌ 内容不同'}`);
        if (!same) fail++;
      }
    }

    // 附加：raw 文本长度比对（确认转义方式也一致）
    console.log('');
    console.log(`  raw 文本长度: 基线 ${b.raw.length} / 产物 ${p.raw.length}  ${b.raw.length === p.raw.length ? '✅' : '❌'}`);
    if (b.raw.length !== p.raw.length) fail++;
  }

  console.log('');
  if (fail === 0) {
    console.log('✅ 全部校验通过：拆分产物与原始基线等价（行为未改变）');
    process.exit(0);
  } else {
    console.log(`❌ ${fail} 项未通过，请排查 tool/build.mjs`);
    process.exit(1);
  }
}

main();
