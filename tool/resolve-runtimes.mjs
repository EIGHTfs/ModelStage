#!/usr/bin/env node
// resolve-runtimes.mjs — 自动定位 Spine 运行时源码目录（供 build.mjs 使用）
//
// 设计目的：
//   运行时源码不纳入本仓库（规避 Spine Runtimes 的授权约束，见 README 合规说明），
//   因此构建时必须从仓库外部获取。为让"换机器/新克隆"也能构建，这里做**多候选自动探测**，
//   并按优先级依次尝试，最后还有兜底方案，保证构建永不因找不到运行时而失败。
//
// 探测优先级（越靠前越优先；路径不写死，可由环境变量覆盖 —— 见 no-hardcode-config）：
//   1. 环境变量 SPINE_RUNTIME_DIR     显式指定，最高优先
//   2. 项目内 src/spine-runtimes/     本地存在但已 gitignore（不入库）
//   3. 工作区级共享 ../spine-runtimes/ 与同工作区其他项目共享
//   4. 兜底：从 baseline/index.html 现抽（基线本身内联了运行时，永远可用）
//
// 用法（被 build.mjs 调用）：
//   const { resolveRuntimes } = await import('./resolve-runtimes.mjs');
//   const { sources, origin } = resolveRuntimes();

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

/** 判断目录里是否有完整的 7 个版本运行时文件。 */
export function hasRuntimes(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  const need = ['3.6', '3.7', '3.8', '4.0', '4.1', '4.2', '4.3'];
  return need.every((v) => {
    const f = path.join(dir, `spine-${v}.js`);
    return fs.existsSync(f) && fs.statSync(f).size > 1024;
  });
}

/** 从目录读取 7 个版本源码，返回 {版本: 源码}。 */
export function readRuntimesFromDir(dir) {
  const files = fs.readdirSync(dir).filter((f) => /^spine-\d+\.\d+\.js$/.test(f));
  const sources = {};
  for (const f of files) {
    const v = f.match(/spine-(\d+\.\d+)\.js/)[1];
    sources[v] = fs.readFileSync(path.join(dir, f), 'utf8');
  }
  return sources;
}

/** 兜底：从基线 index.html 现抽运行时对象（基线内联了源码，永远可用）。 */
export function extractFromBaseline() {
  const baseline = path.join(ROOT, 'baseline', 'index.html');
  if (!fs.existsSync(baseline)) return null;
  const html = fs.readFileSync(baseline, 'utf8');
  const KEY = 'window.__SPINE_RUNTIME_SOURCES__';
  const keyPos = html.indexOf(KEY);
  if (keyPos < 0) return null;
  const eq = html.indexOf('=', keyPos);
  const start = html.indexOf('{', eq);
  if (start < 0) return null;

  // 花括号配平（跳过字符串与转义）
  let depth = 0, inStr = false, esc = false, end = -1;
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
    if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 主入口：按优先级探测运行时。
 * @returns {{sources: Object, origin: string, dir?: string}}
 */
export function resolveRuntimes() {
  const candidates = [];

  // 1) 环境变量（显式指定，最高优先）
  if (process.env.SPINE_RUNTIME_DIR) {
    candidates.push({ dir: process.env.SPINE_RUNTIME_DIR, tag: '环境变量 SPINE_RUNTIME_DIR' });
  }
  // 2) 项目内（本地存在但 gitignore，不入库）
  candidates.push({ dir: path.join(ROOT, 'src', 'spine-runtimes'), tag: '项目内 src/spine-runtimes/' });
  // 3) 工作区级共享目录
  candidates.push({ dir: path.resolve(ROOT, '..', 'spine-runtimes'), tag: '工作区共享 ../spine-runtimes/' });

  for (const c of candidates) {
    if (hasRuntimes(c.dir)) {
      return { sources: readRuntimesFromDir(c.dir), origin: c.tag, dir: c.dir };
    }
  }

  // 4) 兜底：从基线现抽
  const fromBase = extractFromBaseline();
  if (fromBase) {
    return { sources: fromBase, origin: '兜底：从 baseline/index.html 现抽' };
  }

  throw new Error(
    '未找到 Spine 运行时，且基线也没法抽取。请设置环境变量 SPINE_RUNTIME_DIR 指向含 spine-3.6.js … spine-4.3.js 的目录。'
  );
}

// 直接运行时打印探测结果，便于排查
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { sources, origin, dir } = resolveRuntimes();
    console.log('探测到运行时来源:', origin);
    if (dir) console.log('目录:', dir);
    console.log('版本:', Object.keys(sources).sort().join(', '));
    for (const v of Object.keys(sources).sort()) {
      console.log(`  ${v}: ${(Buffer.byteLength(sources[v], 'utf8') / 1024).toFixed(0)} KB`);
    }
  } catch (e) {
    console.error('探测失败:', e.message);
    process.exit(1);
  }
}
