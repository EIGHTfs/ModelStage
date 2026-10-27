// ============================================================================
// tool/lib/spine-runtime.mjs —— Spine 运行时源码定位 + 在 Node 里受控加载
//
// 为什么要单独一层：Spine 的 .skel/.json 只能由**对应版本**的运行时解析，
//   而运行时代码是浏览器风格的打包体（会摸 document/window）。这里在 Node 的 vm 沙箱里
//   垫一个最小 DOM 垫片把它跑起来，只用来做**数据层解析**（不渲染、不碰 WebGL）。
//
// 源码来源（按优先级，逐条探测，命中即用）：
//   ① src/spine-runtimes/spine-webgl-<ver>.js        —— 项目内（该目录不入库）
//   ② ../spine-runtimes/spine-webgl-<ver>.js         —— 工作区共享
//   ③ 环境变量 SPINE_RUNTIME_DIR 指定的目录
//
// 没有内联兜底：运行时源码必须由外部提供，找不到时显式报错并给修复指引。
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

/**
 * 数据根：与 web.sh / serve.mjs 同一口径（MODELSTAGE_DATA_ROOT 覆盖，缺省项目根）。
 * 下载物落在 <dataRoot>/runtimes/spine/<ver>/spine-webgl-<ver>.js。
 * @returns {string}
 */
function dataRootDir() {
  const env = (process.env.MODELSTAGE_DATA_ROOT || '').trim();
  return env ? path.resolve(env) : ROOT;
}

/** 运行时源码候选目录（按优先级） */
const RUNTIME_DIRS = [
  path.join(ROOT, 'src', 'spine-runtimes'),
  path.join(WORKSPACE, 'spine-runtimes'),
  // **末尾追加**（上面两条的既有优先次序不动）：tool/fetch-runtimes.mjs 的下载落点。
  //   必须放最后 —— "项目自带优先"不能因为引入下载功能而静默失效。
  path.join(dataRootDir(), 'runtimes', 'spine'),
];



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
    // 两种布局都要认：
    //   平铺  <dir>/spine-webgl-<ver>.js            —— 项目自带 / 环境变量目录的既有布局
    //   分版本 <dir>/<ver>/spine-webgl-<ver>.js      —— tool/fetch-runtimes.mjs 的下载布局
    //      （分版本目录是为了让每个版本各自带 LICENSE 与 SOURCE.json）
    for (const p of [path.join(dir, `spine-webgl-${version}.js`), path.join(dir, version, `spine-webgl-${version}.js`)]) {
      if (fs.existsSync(p)) { hit = { code: fs.readFileSync(p, 'utf8'), origin: p }; break; }
    }
    if (hit) break;
  }
  if (!hit && process.env.SPINE_RUNTIME_DIR) {
    const p = path.join(process.env.SPINE_RUNTIME_DIR, `spine-webgl-${version}.js`);
    if (fs.existsSync(p)) hit = { code: fs.readFileSync(p, 'utf8'), origin: p };
  }
  sourceCache.set(version, hit);
  return hit;
}

/** 可用版本列表（扫描候选目录；平铺与分版本两种布局都算） */
export function listRuntimeVersions() {
  const out = new Set();
  const addFrom = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^spine-webgl-(.+)\.js$/);
      if (m) out.add(m[1]);
    }
  };
  for (const dir of RUNTIME_DIRS) {
    if (!fs.existsSync(dir)) continue;
    addFrom(dir);
    // 分版本子目录（下载布局）也要列出来
    let subs = [];
    try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* 跳过 */ }
    for (const sub of subs) {
      try { addFrom(path.join(dir, sub)); } catch { /* 跳过读不了的子目录 */ }
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
  if (!src) throw new Error(`没有可用的 Spine ${version} 运行时源码。请任选一种方式提供：SPINE_RUNTIME_DIR 环境变量 / src/spine-runtimes/ / 工作区共享 ../spine-runtimes/`);
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
