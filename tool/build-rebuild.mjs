#!/usr/bin/env node
// build-rebuild.mjs — 把复刻版前端打包成单文件
//
// 输入：
//   rebuild/app.html        外壳（含三个占位符）
//   rebuild/app.css         从原版基线提取的 Tailwind 产物（保证样式一致）
//   rebuild/js/stage.js     Spine 渲染舞台（自建）
//   rebuild/js/app.js       应用层：工具栏 / 模型库 / 控制栏 / 播放条
//   src/spine-runtimes/*.js Spine 运行时（不入库，由 resolveRuntimes 自动探测）
// 输出：
//   dist-rebuild/index.html 单文件产物（file:// 双击可用）
//
// 与主站构建（tool/build.mjs）的区别：
//   主站内联的是「原版应用外壳 + 运行时」；本脚本内联的是「自建外壳 + 运行时 + 自建脚本」，
//   两者产物互不影响，服务端用 SPINE_DIST_DIR 选择服务哪一份。
//
// 用法：node tool/build-rebuild.mjs
// 运行：SPINE_DIST_DIR=dist-rebuild node server.mjs 8804

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimes } from './resolve-runtimes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'rebuild');
const OUT_DIR = path.join(ROOT, 'dist-rebuild');
const OUT = path.join(OUT_DIR, 'index.html');

const P_CSS = '/*__CSS__*/';
const P_RUNTIME = '/*__RUNTIME__*/';
const P_APP = '/*__APP__*/';

// 内联顺序不可颠倒：stage.js 定义 window.SpineStage，app.js 启动时调用它
const JS_FILES = ['js/stage.js', 'js/app.js'];

function main() {
  const htmlFile = path.join(SRC, 'app.html');
  if (!fs.existsSync(htmlFile)) {
    console.error('找不到 ' + htmlFile);
    process.exit(1);
  }

  const html = fs.readFileSync(htmlFile, 'utf8');
  for (const p of [P_CSS, P_RUNTIME, P_APP]) {
    if (!html.includes(p)) {
      console.error('外壳中未找到占位符 ' + p + '（可能已被替换过）');
      process.exit(1);
    }
  }

  const css = fs.readFileSync(path.join(SRC, 'app.css'), 'utf8');

  let js = '';
  for (const f of JS_FILES) {
    const full = path.join(SRC, f);
    if (!fs.existsSync(full)) {
      console.error('缺少脚本 ' + full);
      process.exit(1);
    }
    js += fs.readFileSync(full, 'utf8') + '\n;\n';
  }

  // 运行时通过自动探测获取（不入库，规避 Spine Runtimes 授权约束）
  let rt;
  try {
    rt = resolveRuntimes();
  } catch (e) {
    console.error('运行时探测失败: ' + e.message);
    process.exit(1);
  }
  const runtime = JSON.stringify(rt.sources);

  // 关键坑：String.prototype.replace 的**替换字符串**里 $ 有特殊含义
  //   （$& 插入匹配、$' 插入后续、$` 插入前置、$1 取分组）。
  //   本项目的 JS 与运行时源码里大量出现 $（jQuery 风格、模板、CSS 变量），
  //   直接传字符串会被错误解释，必须用函数形式返回替换内容。
  let out = html
    .replace(P_CSS, () => css)
    .replace(P_RUNTIME, () => runtime)
    .replace(P_APP, () => js);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, out, 'utf8');

  console.log('运行时来源: ' + rt.origin);
  console.log('运行时版本: ' + Object.keys(rt.sources).sort().join(', '));
  console.log('CSS: ' + (css.length / 1024).toFixed(0) + ' KB');
  console.log('JS:  ' + (js.length / 1024).toFixed(0) + ' KB');
  console.log('产物: ' + (out.length / 1048576).toFixed(2) + ' MB -> dist-rebuild/index.html');
  console.log('');
  console.log('运行：SPINE_DIST_DIR=dist-rebuild node server.mjs 8804');
}

main();
