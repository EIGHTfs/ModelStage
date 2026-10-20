#!/usr/bin/env node
// split-app.mjs — 从基线 index.html 中剥离内联的 Spine 运行时对象，生成「应用外壳」模板
//
// 上游：legacy/baseline/index.html（原版 4.17MB 单文件，只读参考）
// 产物：legacy/source/app-shell.html —— 除运行时对象外的全部内容，运行时位置用占位符标记
//
// 为什么这么做：
//   原版 把 7 个 Spine 版本运行时以 JSON 转义字符串内联在
//   window.__SPINE_RUNTIME_SOURCES__ = {...}（占 81%，3.39MB）。
//   剥离后应用代码只剩约 0.8MB，可读性与可维护性大幅提升；
//   发布时由 build.mjs 再把 src/spine-runtimes/*.js 内联回占位符，还原单文件。
//
// 关键约束：占位符替换必须保持「JSON 转义字符串」形态（原逻辑用 eval 执行该字符串），
//   不能改成外链 <script src>——file:// 协议下会被 CORS 拦截，破坏「双击即用」。
//
// 用法：node tool/split-app.mjs
// 安全：只读 legacy/baseline/index.html，只写 legacy/source/app-shell.html

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(ROOT, 'baseline', 'index.html');
const OUT = path.join(ROOT, 'src', 'app-shell.html');

const KEY = 'window.__SPINE_RUNTIME_SOURCES__';
const PLACEHOLDER = '/*__SPINE_RUNTIME_SOURCES_PLACEHOLDER__*/';

/** 从 keyPos 起找到赋值对象的起止（花括号配平，跳过字符串与转义）。 */
function findObjectRange(html, keyPos) {
  const eq = html.indexOf('=', keyPos);
  if (eq < 0) return null;
  const start = html.indexOf('{', eq);
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
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
      if (depth === 0) return { start, end: i };
    }
  }
  return null;
}

function main() {
  if (!fs.existsSync(BASELINE)) {
    console.error(`找不到基线 ${BASELINE}`);
    process.exit(1);
  }

  const html = fs.readFileSync(BASELINE, 'utf8');
  const keyPos = html.indexOf(KEY);
  if (keyPos < 0) {
    console.error(`基线中未找到 ${KEY}，结构可能已变化`);
    process.exit(1);
  }

  const range = findObjectRange(html, keyPos);
  if (!range) {
    console.error('未定位到运行时对象范围（花括号未配平）');
    process.exit(1);
  }

  const objText = html.slice(range.start, range.end + 1);
  // 连同赋值语句一起替换：window.__SPINE_RUNTIME_SOURCES__ = {...};
  const stmtStart = keyPos;
  let stmtEnd = range.end + 1;
  if (html[stmtEnd] === ';') stmtEnd++;

  const shell = html.slice(0, stmtStart) + PLACEHOLDER + html.slice(stmtEnd);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, shell, 'utf8');

  console.log(`基线字节:     ${html.length} (${(html.length / 1048576).toFixed(2)} MB)`);
  console.log(`剥离对象字节: ${objText.length} (${(objText.length / 1048576).toFixed(2)} MB)`);
  console.log(`外壳字节:     ${shell.length} (${(shell.length / 1024).toFixed(0)} KB) -> legacy/source/app-shell.html`);
  console.log('');
  console.log(`瘦身: ${(html.length / 1048576).toFixed(2)} MB -> ${(shell.length / 1024).toFixed(0)} KB`);
  console.log('占位符:', PLACEHOLDER);
  console.log('');
  console.log('下一步：tool/build.mjs 会把 src/spine-runtimes/*.js 内联回占位符。');
}

main();
