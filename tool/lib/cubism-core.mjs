// ============================================================================
// tool/lib/cubism-core.mjs —— 在 Node 的 vm 沙箱里跑 Cubism Core（浏览器构建）
//
// 为什么需要：生成 motion3 需要 moc3 的**真实参数 Id**（Core 的 parameters.ids）。
//   纯字符串扫描（moc3NameCandidates）得到的候选名不等于参数 Id：实测用它建 hashLookup
//   会让绑定哈希全部认不出。Core 是浏览器包（Emscripten），所以要垫一个最小浏览器环境。
//
// 沙箱契约（与 spine-runtime.mjs 同思路）：
//   · 提供 document.currentScript / location / atob / 可应答 data: URI 的 XMLHttpRequest
//     —— Core 的 Emscripten 外壳用它们取内嵌 base64 的 WASM 初始化数据
//   · 不提供 process/require：避免它走 Node 分支去 readFileSync 一个 data: URI
//   · 初始化时机：脚本 eval 完即完成（Emscripten 的 run() 在 eval 末尾），随后自检版本
//   · 释放：用完必须 model.release() → moc._release()（顺序固定），本模块在 finally 里保证
//
// 内存：Core 是 WASM 堆，泄漏会累积。getParameterIds 每次调用都成对释放；
//   调用方连续处理多个包时 RSS 应保持平稳（导出 CLI 的实测值见文档）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// Core 的候选路径（项目自带优先；也可用 CUBISM_CORE 指到别处）
const CORE_CANDIDATES = [
  path.join(ROOT, 'tool', 'vendor', 'live2dcubismcore.min.js'),
  process.env.CUBISM_CORE || '',
].filter(Boolean);

let sandboxCache = null;

/** 最小浏览器垫片 + 加载 Core。只做一次（Core 初始化 ~26ms）。 */
function getCore() {
  if (sandboxCache) return sandboxCache;
  const file = CORE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!file) throw new Error(`找不到 Cubism Core（试过：${CORE_CANDIDATES.join('、')}）`);

  // Core 的 WASM 初始化数据内嵌为 data: URI，Emscripten 外壳用 XHR 取；这里给个只认 data: 的桩
  class DataUriXHR {
    open(_method, url) { this.url = url; }
    send() {
      const m = /^data:([^;]*);base64,(.*)$/s.exec(String(this.url));
      if (!m) throw new Error(`Cubism Core 请求了非 data: URI（${String(this.url).slice(0, 60)}），沙箱不提供网络`);
      const buf = Buffer.from(m[2], 'base64');
      this.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      this.responseText = buf.toString('latin1');
      this.status = 200;
      this.readyState = 4;
      if (this.onload) this.onload();
    }
    addEventListener() {}
  }

  const ctx = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    WebAssembly, TextDecoder, TextEncoder, ArrayBuffer, Math, Date,
    setTimeout, clearTimeout,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    document: { currentScript: { src: 'http://localhost/live2dcubismcore.min.js' }, addEventListener() {} },
    XMLHttpRequest: DataUriXHR,
    location: { href: 'http://localhost/live2dcubismcore.min.js' },
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: 'live2dcubismcore.min.js' });

  const L = ctx.Live2DCubismCore;
  if (!L || !L.Moc || !L.Model) throw new Error('Cubism Core 加载后没有 Moc/Model 导出');
  // 自检：csmGetVersion 返回编码版本（如 67239938 = 4.2.0 的编码），拿不到就说明沙箱里没跑起来
  const version = L.Version && L.Version.csmGetVersion ? L.Version.csmGetVersion() : null;
  if (!version) throw new Error('Cubism Core 自检失败：Version.csmGetVersion() 无返回');
  sandboxCache = { L, version, file, coreEvalMs: 0 };
  return sandboxCache;
}

/** Core 版本信息（自检/报告用） */
export function coreInfo() {
  const { version, file } = getCore();
  return { version, file, latestMocVersion: sandboxCache.L.Version.csmGetLatestMocVersion() };
}

/**
 * 从 moc3 字节取**真实参数 Id**（用完立即释放 model 与 moc）。
 * @param {Uint8Array} moc3
 * @returns {{ids:string[], canvas:{width:number,height:number,ppu:number}, count:number}}
 */
export function getParameterIds(moc3) {
  const { L } = getCore();
  if (!moc3 || !moc3.length) throw new Error('moc3 为空');
  // Core 需要 ArrayBuffer（不是 Node Buffer 切片）
  const ab = moc3.buffer.slice(moc3.byteOffset, moc3.byteOffset + moc3.byteLength);
  let moc = null;
  let model = null;
  try {
    moc = L.Moc.fromArrayBuffer(ab);
    if (!moc) throw new Error('Moc.fromArrayBuffer 返回 null（moc3 损坏或版本过新）');
    model = L.Model.fromMoc(moc);
    if (!model) throw new Error('Model.fromMoc 返回 null');
    const ids = Array.from(model.parameters.ids);
    const info = model.canvasinfo;
    return {
      ids,
      count: model.parameters.count,
      canvas: {
        width: info.CanvasWidth / info.PixelsPerUnit,
        height: info.CanvasHeight / info.PixelsPerUnit,
        ppu: info.PixelsPerUnit,
      },
    };
  } finally {
    // 释放顺序固定：先 model 再 moc；任一为 null 就跳过，绝不让异常吃掉释放
    try { if (model) model.release(); } catch { /* 释放失败不掩盖原错误 */ }
    try { if (moc) moc._release(); } catch { /* 同上 */ }
  }
}

export const CORE_PATHS = { ROOT, CORE_CANDIDATES };
