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
import { stripProductMods } from './lib/mods.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(ROOT, 'baseline', 'index.html');
const BUILT = path.join(ROOT, 'dist', 'index.html');

// 声明式 MOD 清单（tool/mods/app-shell.json）：校验 1 用它把产物侧的 MOD 剥掉后再与基线比。
//   与 tool/build-byte-equal.mjs 走的是同一份清单、同一套严格校验（tool/lib/mods.mjs），
//   不另写第二套实现，避免两份真相源。
const MODS_MANIFEST = (() => {
  const p = path.join(ROOT, 'tool', 'mods', 'app-shell.json');
  try {
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { mods: [] };
  } catch (e) {
    throw new Error(`读取 tool/mods/app-shell.json 失败: ${e.message}`);
  }
})();
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

  // 校验 1：基线 ≡ 产物（剥 MOD）——同类对同类
  //
  // 口径：dist 自 P4 起是「原版 + MOD 产物」（不是基线本身），直接比长度没有意义。
  //   这里先用与 tool/build-byte-equal.mjs 相同的能力把产物侧的 MOD 剥掉
  //   （MOD 块标记 + tool/mods/app-shell.json 清单，同一份清单、同一套严格校验），
  //   再与 baseline/index.html **逐字节**比对；剥离后若仍有任何差异 → 报错（拦截力不变）。
  console.log('【校验 1】基线 ≡ 产物（剥 MOD）');
  console.log(`  基线: ${baseBuf.length} 字节`);
  console.log(`  产物: ${builtBuf.length} 字节（含 MOD；dist 自 P4 起为「原版 + MOD 产物」）`);
  const baseHtml = baseBuf.toString('utf8');
  const builtHtml = builtBuf.toString('utf8');
  let strippedHtml = null;
  try {
    strippedHtml = stripProductMods(builtHtml, MODS_MANIFEST.mods);
  } catch (e) {
    console.log(`  ❌ 剥离产物 MOD 失败：${e.message}`);
    fail++;
  }
  if (strippedHtml !== null) {
    const strippedBuf = Buffer.from(strippedHtml, 'utf8');
    console.log(`  剥 MOD 后: ${strippedBuf.length} 字节（清单条目 ${(MODS_MANIFEST.mods || []).length} 条 + MOD 块标记）`);
    if (strippedBuf.length === baseBuf.length && strippedBuf.equals(baseBuf)) {
      console.log('  ✅ 逐字节一致（基线 ≡ 产物剥 MOD）');
    } else {
      console.log(`  ❌ 不一致（长度差 ${strippedBuf.length - baseBuf.length} 字节）`);
      fail++;
    }
  }

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
    console.log('✅ 全部校验通过：产物（剥 MOD 后）与原始基线逐字节等价，运行时对象与基线一致');
    process.exit(0);
  } else {
    console.log(`❌ ${fail} 项未通过，请排查 tool/build.mjs`);
    process.exit(1);
  }
}

main();
