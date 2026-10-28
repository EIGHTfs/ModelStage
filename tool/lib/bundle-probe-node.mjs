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
const LIB_DIR = path.join(ROOT, 'plugins', 'unity-live2d-bundle', 'lib');

// 加载顺序即依赖顺序：errors 最先（其余库用它），bundle-probe 最后（它用其余全部）
// ⚠️ 这份清单与 plugins/unity-live2d-bundle/plugin.json 的 files[] 是**同一事实的两处表达**：
//   新增 lib 文件时两边都要加，漏一边的表现是「浏览器能跑、服务端预检报缺依赖」。
//   长期应收敛成「从 plugin.json 派生」（过滤出 lib/ 前缀项），本轮只做 LZMA 接入，故仍手写。
const LIB_ORDER = [
  'errors.js',
  'bytes.js',
  'common-strings.js',
  // LZMA 解码器：必须排在 unityfs.js 之前（unityfs 的 lzmaDecompress 取全局 root.LZMA）
  'lzma-d-min.js',
  'unityfs.js',
  'serialized.js',
  'typetree.js',
  'extract.js',
  'etc2.js',
  'dxt.js',
  'texdecode.js',
  'png.js',
  'bundle-probe.js',
];

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
  for (const rel of LIB_ORDER) {
    const abs = path.join(LIB_DIR, rel);
    if (!fs.existsSync(abs)) throw new Error(`预检依赖缺失：plugins/unity-live2d-bundle/lib/${rel}`);
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

export const PROBE_PATHS = { ROOT, LIB_DIR, LIB_ORDER };
