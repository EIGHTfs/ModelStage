// unpack/plugin-runner.mjs —— 在 node 侧的 vm 沙盒里跑资产插件（17b 的第一步）
//
// 做什么：把"插件在无 DOM 的 node 环境里跑起来"这件事收成一个模块 —— 装载一次插件（lib 14 个 + index.js），
//   之后对任意容器文件调 canHandle / resolve，返回插件的原始产物（prefix / entry / files）。
//
// 为什么独立：沙盒装载细节（注入 sha256/inflate/deflate、把 fetch 打桩到 404 让插件走默认规则）
//   与 17a 的 tool/check-plugin-node.mjs 完全一致；这里抽出来供**服务端常驻**复用，
//   不复制一份逻辑，也不 import 一个 CLI 脚本（那个带主流程副作用）。
//
// 三条硬约束（都是踩过的坑，别改）：
//   1. **跨 realm 禁止 instanceof**：vm 里建出来的 Map/Blob 与宿主各有一套内置构造器，
//      `instanceof Map` 恒 false、`Object.keys(map)` 恒空（Map 没有自有可枚举键）。
//      一律用鸭子类型（有 size 且能 for...of 迭代 / 有 arrayBuffer 方法）；比 size 更硬的判据是 entries 非空。
//   2. **装载只做一次**：沙盒创建 0.9ms、lib 41ms、index.js 6.4ms（实测 58ms）；但 resolve 本体是秒级，
//      所以真正重要的是"别每次请求都重建沙盒"（会重复 58ms + 丢掉插件内部的 profile 缓存）。
//   3. **产物不复制**：resolve 返回的文件值可能是 Blob（插件侧 valueTypes 实测 ["Blob"]）也可能是
//      Uint8Array/Buffer，落盘时逐个取、取完立刻丢引用（详见 unpackBytes 注释）。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ../../.. ← 本文件在 src/server/unpack/，回退三级才是项目根（少算一级会把 plugins 指到 src/plugins）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PLUGIN_ID = 'unity-live2d-bundle';
const PLUGIN_DIR = path.join(ROOT, 'plugins', PLUGIN_ID);

/** 插件 lib 的装载顺序（与 17a 的 runner 完全一致，插件内部有依赖顺序） */
const LIB_FILES = [
  'lib/errors.js', 'lib/bytes.js', 'lib/common-strings.js', 'lib/unityfs.js', 'lib/serialized.js',
  'lib/typetree.js', 'lib/extract.js', 'lib/etc2.js', 'lib/dxt.js', 'lib/texdecode.js',
  'lib/bundle-probe.js', 'lib/png.js', 'lib/anim-to-motion.js', 'lib/model3.js',
];

/** 已装载的插件 API（模块级单例；失败则记下原因，不反复重试） */
let cached = null;
let loadError = null;
let loadMs = 0;

/**
 * 建沙盒并装载插件（内部只调一次）。
 * @returns {{ok: boolean, api?: {resolve: Function, canHandle: Function}, error?: string, loadMs?: number}}
 */
export function ensurePlugin() {
  if (cached) return { ok: true, api: cached, loadMs };
  if (loadError) return { ok: false, error: loadError };
  const t0 = Date.now();
  try {
    const sandbox = {
      globalThis: {},
      console,
      TextEncoder,
      TextDecoder,
      Blob,
      // node 侧不该建 blob URL：插件里有能力判断，真调到就是回归
      URL: { createObjectURL: () => { throw new Error('node 侧不应调用 createObjectURL'); } },
      AbortController,
      // 插件会用 fetch 拉 profile；拿不到就走内置默认规则（与 17a 同口径）
      fetch: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }),
      setTimeout, clearTimeout, setInterval, clearInterval,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const rel of LIB_FILES) {
      vm.runInContext(fs.readFileSync(path.join(PLUGIN_DIR, rel), 'utf8'), sandbox, { filename: rel });
    }
    const NS = sandbox.__ULB__;
    if (!NS || !NS.bytes) throw new Error('lib/bytes.js 未能挂载 __ULB__');
    // 这两块能力在浏览器由 DecompressionStream / 原生 API 提供，node 侧注入等价实现
    NS.bytes.setSha256((u8) => crypto.createHash('sha256').update(u8).digest('hex'));
    NS.png.setInflate((u8) => new Uint8Array(zlib.inflateSync(Buffer.from(u8))));
    NS.png.setDeflate((u8) => new Uint8Array(zlib.deflateSync(Buffer.from(u8), { level: 6 })));
    vm.runInContext(fs.readFileSync(path.join(PLUGIN_DIR, 'index.js'), 'utf8'), sandbox, { filename: 'index.js' });
    const api = sandbox.__ULB_NODE__;
    if (!api || typeof api.resolve !== 'function' || typeof api.canHandle !== 'function') {
      throw new Error('插件未挂载 __UBL_NODE__ 的 resolve/canHandle');
    }
    cached = api;
    loadMs = Date.now() - t0;
    return { ok: true, api, loadMs };
  } catch (e) {
    loadError = String((e && e.message) || e);
    return { ok: false, error: loadError };
  }
}

/** 值是否是"字节/Blob 形状"（跨 realm：一律鸭子类型，不用 instanceof） */
function byteish(v) {
  if (!v) return false;
  if (typeof v.arrayBuffer === 'function') return true;          // Blob / ArrayBuffer 视图（跨 realm 也成立）
  if (typeof v.length === 'number' && typeof v.slice === 'function') return true; // Uint8Array / Buffer
  return false;
}

/** 输入值的人类可读类型（错误信息用：说清"你传进来的到底是什么"） */
function typeName(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'Array';
  return typeof v;
}

/** 普通对象形态 → view（**必须逐值校验形状**，否则任何对象都会被当成路径字典） */
function viewFromObject(files) {
  const keys = Object.keys(files);
  if (!keys.length) {
    return { ok: false, entries: [], take: async () => null, release: () => {}, error: '产物为空（普通对象形态，0 个键）' };
  }
  const bad = keys.filter((k) => !byteish(files[k]));
  if (bad.length) {
    // 关键：这里**不能**降级成"把键当路径"——那会把 {ok,entries,take,release} 解释成 4~5 个"文件"，
    //   产出"看起来成功"的假结果（与 asset-harvester 的 files=0 同类事故）。
    return {
      ok: false,
      entries: [],
      take: async () => null,
      release: () => {},
      error: `产物形状非法：${keys.length} 个键里只有 ${keys.length - bad.length} 个是字节/Blob`
        + `（非法键示例：${bad.slice(0, 5).join(', ')}；收到类型：${typeName(files)}）`,
    };
  }
  return {
    ok: true,
    entries: keys.map((k) => ({ path: k })),
    take: async (k) => toBytes(files[k]),
    release: () => {},
  };
}

/**
 * 取插件产出的"文件集合"视图（**内部工具**；调用方请直接用 `unpackFile(...).files`）。
 *
 * 判型纪律（两条事故换来的）：
 *   · 跨 realm 不用 instanceof（vm 里建出的 Map/Blob 与宿主各有一套构造器）；
 *   · 判型失败**绝不静默换一种解释**：非文件集合一律 ok:false + 说清收到什么类型。
 *     早期版本会把任何对象按 Object.keys 当路径字典，于是把 view 对象本身（{ok,entries,take,release}）
 *     解释成 4~5 个"文件"并报 ok:true —— 假成功比报错危险得多。
 *
 * @param {unknown} files 插件 raw 产物（沙盒 Map / 普通对象 / 已是 view）
 * @returns {{ok: boolean, entries: Array<{path: string}>, take: Function, release: Function, error?: string}}
 */
export function filesView(files) {
  // 已经是 view（鸭子类型）：二次包装是调用方 bug，必须响亮报错，不能"再解释一遍"
  if (files && typeof files.take === 'function' && Array.isArray(files.entries)) {
    throw new Error('filesView: 传入的已经是文件视图（不要二次包装）；请直接用 unpackFile(...).files');
  }
  // Map 形态：有 size 且 forEach 可用
  const isMap = files && typeof files.size === 'number' && typeof files.forEach === 'function';
  if (!isMap) {
    if (files && typeof files === 'object') return viewFromObject(files);
    return {
      ok: false,
      entries: [],
      take: async () => null,
      release: () => {},
      error: `产物不是文件集合：收到 ${typeName(files)}`,
    };
  }
  const entries = [];
  let firstBad = null;
  files.forEach((v, k) => {
    entries.push({ path: String(k) });
    if (firstBad === null && !byteish(v)) firstBad = String(k);
  });
  if (!entries.length) {
    return { ok: false, entries: [], take: async () => null, release: () => {}, error: '产物为空（Map 形态，0 个条目）' };
  }
  if (firstBad !== null) {
    return {
      ok: false,
      entries: [],
      take: async () => null,
      release: () => {},
      error: `产物形状非法：Map 里的值不是字节/Blob（首个非法键：${firstBad}）`,
    };
  }
  return {
    ok: true,
    entries,
    take: async (k) => toBytes(files.get(k)),
    // 写完一个就删掉，让沙盒里的值尽快可回收（42MB 包 RSS 增量约 210MB，逐个释放能显著削峰）
    release: (k) => { try { files.delete(k); } catch { /* 删不掉不影响正确性 */ } },
  };
}

/** 把 Blob / Uint8Array / Buffer 统一成 Uint8Array（跨 realm：只看有没有 arrayBuffer 方法） */
async function toBytes(v) {
  if (!v) return null;
  if (typeof v.arrayBuffer === 'function') return new Uint8Array(await v.arrayBuffer());
  if (typeof v.length === 'number' && typeof v.slice === 'function') return new Uint8Array(v);
  return null;
}

/**
 * 解包一个容器文件（读字节 → canHandle → resolve）。
 * @param {{rootId: string, rel: string, absPath: string}} opts
 * @returns {Promise<{ok: boolean, reason?: string, message?: string,
 *   prefix?: string, entry?: string,
 *   // ⚠ files 是**文件视图**（不是插件 raw Map）：{ok, entries:[{path}], take(path), release(path)}
 *   files?: {ok: boolean, entries: Array<{path: string}>, take: Function, release: Function, error?: string},
 *   readMs?: number, unpackMs?: number}>}
 */
export async function unpackFile({ rootId, rel, absPath }) {
  const p = ensurePlugin();
  if (!p.ok) return { ok: false, reason: 'plugin-unavailable', message: p.error };
  let bytes;
  const t0 = Date.now();
  try {
    bytes = new Uint8Array(fs.readFileSync(absPath));
  } catch (e) {
    return { ok: false, reason: 'read-failed', message: String((e && e.message) || e) };
  }
  const readMs = Date.now() - t0;
  const name = path.basename(String(rel));
  const file = { rootId, rel, name, size: bytes.byteLength, bytes };
  try {
    if (!p.api.canHandle(file)) return { ok: false, reason: 'not-handled', message: '插件判定不处理该文件' };
  } catch (e) {
    return { ok: false, reason: 'canhandle-threw', message: String((e && e.message) || e) };
  }
  const t1 = Date.now();
  let res;
  try {
    res = await p.api.resolve(file);
  } catch (e) {
    return { ok: false, reason: 'resolve-threw', message: String((e && e.message) || e) };
  }
  const unpackMs = Date.now() - t1;
  if (!res || !res.prefix || res.entry === undefined) {
    return { ok: false, reason: 'bad-result', message: '插件返回值缺 prefix/entry' };
  }
  const view = filesView(res.files);
  if (!view.ok) return { ok: false, reason: 'empty-files', message: view.error || '产物为空' };
  // prefix/entry 直取插件返回值：不在这里做任何拼装，避免与前端解包路径产生第二套语义
  return { ok: true, prefix: String(res.prefix), entry: String(res.entry), files: view, readMs, unpackMs };
}

/** 运行器自身的状态（供 /api/unpack/stats 与排障用） */
export function runnerInfo() {
  return {
    pluginId: PLUGIN_ID,
    loaded: !!cached,
    loadMs,
    error: loadError,
    pluginDir: path.relative(ROOT, PLUGIN_DIR),
  };
}
