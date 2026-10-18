#!/usr/bin/env node
// build.mjs — 把拆分后的源码重新打包成单个 index.html（还原 原版「双击即用」形态）
//
// 输入：
//   src/app-shell.html        应用外壳（含占位符，798 KB）
//   src/spine-runtimes/*.js   7 个 Spine 版本运行时源码（可读、可维护）
// 输出：
//   dist/index.html           单文件产物，等价于原版基线
//
// 为什么必须"打包回单文件"：
//   原版 核心特性是 file:// 双击即用。运行时若改成外链 <script src> 或 fetch，
//   file:// 协议下会被浏览器 CORS 拦截（与 8792 站点"双击打不开"同一坑）。
//   所以：开发态拆分成多文件（好维护），发布态内联回单文件（保特性）。
//
// 内联形态（关键）：
//   原逻辑 evalRuntimeIsolated() 用 new Function 执行「源码字符串」并取 globalThis.spine，
//   因此这里必须用 JSON.stringify 把源码转成**转义字符串**塞回
//   window.__SPINE_RUNTIME_SOURCES__ = {...}，不能原样粘贴代码。
//
// 用法：node tool/build.mjs
// 校验：node tool/verify.mjs（对比产物与基线的运行时对象是否一致）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimes } from './resolve-runtimes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHELL = path.join(ROOT, 'src', 'app-shell.html');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT = path.join(OUT_DIR, 'index.html');

const PLACEHOLDER = '/*__SPINE_RUNTIME_SOURCES_PLACEHOLDER__*/';
const KEY = 'window.__SPINE_RUNTIME_SOURCES__';

function main() {
  if (!fs.existsSync(SHELL)) {
    console.error(`找不到外壳 ${SHELL}，请先运行 tool/split-app.mjs`);
    process.exit(1);
  }

  // 运行时通过自动探测获取（不入库，规避 Spine Runtimes 授权约束）
  let rt;
  try {
    rt = resolveRuntimes();
  } catch (e) {
    console.error(`运行时探测失败: ${e.message}`);
    process.exit(1);
  }
  console.log(`运行时来源: ${rt.origin}`);
  if (rt.dir) console.log(`运行时目录: ${rt.dir}`);

  const shell = fs.readFileSync(SHELL, 'utf8');
  if (!shell.includes(PLACEHOLDER)) {
    console.error(`外壳中未找到占位符 ${PLACEHOLDER}，可能已被替换过`);
    process.exit(1);
  }

  // 版本排序输出（3.6 -> 4.3）；源码已由 resolveRuntimes 提供
  const sources = rt.sources;
  const versions = Object.keys(sources).sort((a, b) => {
    const va = a.split('.').map(Number);
    const vb = b.split('.').map(Number);
    return va[0] - vb[0] || va[1] - vb[1];
  });

  if (versions.length === 0) {
    console.error('探测到的运行时为空');
    process.exit(1);
  }
  console.log(`内联版本: ${versions.join(', ')}`);

  // 关键：JSON.stringify 转义为字符串（原逻辑 eval 该字符串）
  const objText = JSON.stringify(sources);
  const stmt = `${KEY} = ${objText};`;

  const built = shell.replace(PLACEHOLDER, stmt);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, built, 'utf8');

  console.log(`产物字节: ${built.length} (${(built.length / 1048576).toFixed(2)} MB) -> dist/index.html`);
  console.log('');
  console.log('下一步：运行 tool/verify.mjs 校验产物与基线运行时一致。');
}

main();
