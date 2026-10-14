// ============================================================================
// tool/lib/spine-runtime.mjs —— Spine 运行时源码定位 + 在 Node 里受控加载
//
// 为什么要单独一层：Spine 的 .skel/.json 只能由**对应版本**的运行时解析，
//   而运行时代码是浏览器风格的打包体（会摸 document/window）。这里在 Node 的 vm 沙箱里
//   垫一个最小 DOM 垫片把它跑起来，只用来做**数据层解析**（不渲染、不碰 WebGL）。
//
// 源码来源（按优先级，逐条探测，命中即用）：
//   ① src/spine-runtimes/<ver>/spine-webgl-<ver>.js   —— 项目内可维护源码（本机当前为空目录）
//   ② ../spine-runtimes/<ver>/spine-webgl-<ver>.js    —— 工作区共享
//   ③ baseline/index.html 内联的 __SPINE_RUNTIME_SOURCES__  —— 原始基线（兜底）
//   ④ dist/index.html 内联的同一对象                    —— 产物（最后兜底）
//   ③ 优于 ④：baseline 是原始产物，不随重建 dist 变化。
//
// 懒加载：首次真正要解析某版本时才读源码 + 建沙箱，之后按版本缓存；不在服务启动时加载。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const WORKSPACE = path.resolve(ROOT, '..');

/** 运行时源码候选目录（按优先级） */
const RUNTIME_DIRS = [
  path.join(ROOT, 'src', 'spine-runtimes'),
  path.join(WORKSPACE, 'spine-runtimes'),
];

/** 从 HTML 里抽出内联的 __SPINE_RUNTIME_SOURCES__（平衡扫描 + JSON.parse，不执行页面脚本） */
function extractInlineSources(htmlFile) {
  if (!fs.existsSync(htmlFile)) return null;
  const text = fs.readFileSync(htmlFile, 'utf8');
  const at = text.indexOf('__SPINE_RUNTIME_SOURCES__');
  if (at < 0) return null;
  let i = text.indexOf('{', at);
  if (i < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let p = i; p < text.length; p++) {
    const c = text[p];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = p + 1; break; } }
  }
  if (end < 0) return null;
  try { return JSON.parse(text.slice(i, end)); } catch { return null; }
}

let inlineCache = null;
/** 内联运行时（baseline 优先，dist 兜底），结果缓存 */
function getInlineSources() {
  if (inlineCache) return inlineCache;
  inlineCache = extractInlineSources(path.join(ROOT, 'baseline', 'index.html'))
    || extractInlineSources(path.join(ROOT, 'dist', 'index.html'))
    || {};
  return inlineCache;
}

const sourceCache = new Map();   // version → { code, origin }
/**
 * 取某版本的运行时源码。
 * @param {string} version 如 '3.8' / '4.2'
 * @returns {{code:string, origin:string}|null}
 */
export function getRuntimeSource(version) {
  if (sourceCache.has(version)) return sourceCache.get(version);
  let hit = null;
  for (const dir of RUNTIME_DIRS) {
    const p = path.join(dir, `spine-webgl-${version}.js`);
    if (fs.existsSync(p)) { hit = { code: fs.readFileSync(p, 'utf8'), origin: p }; break; }
  }
  if (!hit) {
    const inline = getInlineSources();
    if (inline[version]) {
      const fromBaseline = extractInlineSources(path.join(ROOT, 'baseline', 'index.html'));
      hit = { code: inline[version], origin: `inline:${fromBaseline && fromBaseline[version] ? 'baseline/index.html' : 'dist/index.html'}` };
    }
  }
  sourceCache.set(version, hit);
  return hit;
}

/** 可用版本列表（目录 + 内联合并） */
export function listRuntimeVersions() {
  const out = new Set(Object.keys(getInlineSources()));
  for (const dir of RUNTIME_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^spine-webgl-(.+)\.js$/);
      if (m) out.add(m[1]);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

const sandboxCache = new Map();   // version → { spine, origin }
/**
 * 在 vm 沙箱里加载某版本运行时，返回其导出的 spine 对象（懒加载 + 缓存）。
 *   沙箱只垫数据层需要的最小 DOM 能力：createElement 返回带 getContext()=null 的假 canvas，
 *   足以让运行时完成模块初始化，但任何真正的渲染调用都会失败 —— 这正是我们要的边界。
 */
export function loadRuntime(version) {
  if (sandboxCache.has(version)) return sandboxCache.get(version);
  const src = getRuntimeSource(version);
  if (!src) throw new Error(`没有可用的 Spine ${version} 运行时源码（runtimes 目录与 baseline/dist 内联均未命中）`);
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    performance: { now: () => Date.now() },
    navigator: { userAgent: 'node-spine-meta' },
    setTimeout, clearTimeout, setInterval, clearInterval,
    TextDecoder, TextEncoder,
    URL, Blob,
    document: {
      createElement: () => ({ getContext: () => null, style: {}, addEventListener() {}, width: 0, height: 0 }),
      addEventListener() {}, removeEventListener() {},
    },
    addEventListener() {}, removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src.code, sandbox, { filename: `spine-${version}.js` });
  if (!sandbox.spine) throw new Error(`Spine ${version} 运行时加载后没有导出 spine 对象（源码来源：${src.origin}）`);
  const hit = { spine: sandbox.spine, origin: src.origin };
  sandboxCache.set(version, hit);
  return hit;
}

export const PATHS = { ROOT, WORKSPACE, RUNTIME_DIRS };
