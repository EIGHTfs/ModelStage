// ============================================================================
// tool/lib/bundle-probe-node.mjs —— 在 Node 里跑插件的「装载前预检」
//
// 为什么要这一层：预检实现只有一份（plugins/unity-live2d-bundle/lib/bundle-probe.js），
//   浏览器由插件 index.js 用，服务端由本文件把同一份 js 读进 vm 沙箱执行。
//   这样 /api/bundle/probe 与页面里的 probe 结论必然一致，不存在两份解析逻辑。
//
// 只加载**数据层**需要的库（不加载 index.js / 渲染相关），首次调用时建沙箱并缓存。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/** 预检用哪个插件的 lib（预检实现只有 unity-live2d-bundle 这一份，spine 复用它） */
const PROBE_PLUGIN_ID = 'unity-live2d-bundle';

/**
 * 取某插件的 lib 目录。
 * @param {string} [pluginId]
 * @returns {string}
 */
function libDirFor(pluginId = PROBE_PLUGIN_ID) {
  return path.join(ROOT, 'plugins', pluginId, 'lib');
}

/**
 * 从插件的 `plugin.json` 派生「预检要加载的 lib 文件清单」——**唯一真相是 manifest**。
 *
 * 为什么必须派生：这份清单曾经是手写的，与 plugin.json 的 files[] 构成"同一事实的两处表达"。
 *   漏一边的表现极难定位：**浏览器能跑（按 files[] 加载）、服务端预检报缺依赖（按手写清单加载）**。
 *   所以这里不再保留任何文件名常量，只做一件事：按 files[] 顺序取出 `lib/` 前缀项并去掉前缀。
 *
 * 顺序也来自 manifest：files[] 本身就是依赖顺序（errors 最先、bundle-probe 在后），
 *   派生时**原样保留**，不重排（重排就等于又引入一处人工判断）。
 *
 * @param {string} [pluginId]
 * @returns {string[]} 形如 ['errors.js', 'bytes.js', ...]
 */
export function libOrderFor(pluginId = PROBE_PLUGIN_ID) {
  const manifestPath = path.join(ROOT, 'plugins', pluginId, 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  return files
    .filter((f) => typeof f === 'string' && f.startsWith('lib/'))
    .map((f) => f.slice('lib/'.length));
}

let sandbox = null;

/** 建（或取缓存的）库沙箱。首次调用才读文件 + 执行。 */
function getSandbox() {
  if (sandbox) return sandbox;
  const ctx = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  // 清单在**运行时**从 plugin.json 派生（不是模块加载时算一次）：
  //   这样新增 lib 文件后无需改这里，也不会因进程长期驻留而用上过期清单。
  const libDir = libDirFor(PROBE_PLUGIN_ID);
  for (const rel of libOrderFor(PROBE_PLUGIN_ID)) {
    const abs = path.join(libDir, rel);
    // 报错要能自己说清"该看哪两个地方"：manifest 声明了但磁盘上没有
    if (!fs.existsSync(abs)) throw new Error(`预检依赖缺失：plugins/${PROBE_PLUGIN_ID}/lib/${rel}（plugin.json 的 files[] 里有它，但磁盘上没有）`);
    // 用 vm 执行而非 import：这些库是浏览器风格的脚本（挂 globalThis.__ULB__），不是 ESM
    vm.runInContext(fs.readFileSync(abs, 'utf8'), ctx, { filename: `ulb-lib/${rel}` });
  }
  sandbox = ctx;
  return sandbox;
}

/**
 * 预检一个资源包字节流。
 * @param {Uint8Array} bytes
 * @returns {object} 与插件内 probe 同源的结论
 */
export function probeBundleBytes(bytes) {
  const ctx = getSandbox();
  const NS = ctx.__ULB__;
  if (!NS || !NS.bundleProbe) throw new Error('预检库未能加载（__ULB__.bundleProbe 缺失）');
  return NS.bundleProbe.run(bytes);
}

// 路径与清单都**不再导出成常量**（常量会诱使别人继续手写第二份）；
//   需要自查清单时调 libOrderFor(pluginId) 现取。
export const PROBE_PATHS = { ROOT, libDirFor, libOrderFor };
