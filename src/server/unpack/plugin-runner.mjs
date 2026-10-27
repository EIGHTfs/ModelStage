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
// 插件发现复用 registry 的扫描（纪律第二条：禁止相似功能多处实现）
import { readPlugins } from '../plugins/registry.mjs';

// ../../.. ← 本文件在 src/server/unpack/，回退三级才是项目根（少算一级会把 plugins 指到 src/plugins）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');
/** 插件禁用开关（与 registry 同一份配置；被禁用的插件不参与服务端解包） */
const PLUGIN_SWITCH_FILE = path.join(ROOT, 'config', 'plugins.json');
/** 能承担服务端解包的角色：契约 §一 的 asset-provider（"能解析资源、交出资产"） */
const SERVER_UNPACK_ROLE = 'asset-provider';

/**
 * 已装载插件：插件 id → {ok, api?, error?, loadMs?}。
 *
 * 为什么是 Map 而不是单个变量：契约 §一 是「放目录即加能力」，多插件必须能并存；
 *   原来的单例缓存等于把"只支持一个插件"焊死在代码里（加第二个插件就得改代码）。
 * 失败的插件也写进 Map（记原因），避免每次调用都重试同一个坏插件。
 */
const pluginCache = new Map();

/**
 * 发现能承担服务端解包的插件清单。
 *
 * 复用 registry 的扫描（readPlugins）—— 不在这里另写一套目录遍历：
 *   两套扫描必然漂移（一边认 files[] 顺序、一边认 entry，谁都说不清真相）。
 * @returns {Array<{id: string, files: string[], version: unknown}>} files 是相对 plugins 目录的 POSIX 路径
 */
export function listProviderPlugins() {
  return readPlugins(PLUGINS_DIR, PLUGIN_SWITCH_FILE)
    .filter((m) => Array.isArray(m.provides) && m.provides.includes(SERVER_UNPACK_ROLE))
    .map((m) => ({ id: m.id, files: m.files, version: m.version }));
}

/**
 * provider 集合的指纹段（写进解包缓存键，插件升级/增减时缓存自然失效）。
 *
 * 单插件时返回该插件 id —— 与历史硬编码值**逐字相同**，所以现有缓存不会因为这次通用化失效；
 * 多插件时才拼成 `a@1+b@2`（顺序无关，排序后拼）。
 * @returns {string}
 */
export function providerFingerprint() {
  const list = listProviderPlugins();
  if (!list.length) return 'none';
  if (list.length === 1) return list[0].id;
  return list.map((m) => `${m.id}@${m.version === null || m.version === undefined ? '0' : m.version}`).sort().join('+');
}

/**
 * 装载指定插件（同步；按 id 缓存，失败的也缓存原因）。
 *
 * 错误隔离：本函数**绝不抛**给上层 —— 一个插件语法错误/装不起来，只让它自己进
 *   `{ok:false,error}`，其它插件与服务启动都不受影响（上层按 ok 决定跳过）。
 * @param {string} pluginId 插件 id（= plugins/ 下的目录名 = plugin.json 的 id）
 * @returns {{ok: boolean, api?: object, error?: string, loadMs?: number}}
 */
export function ensurePlugin(pluginId) {
  const id = String(pluginId || '');
  if (!id) return { ok: false, error: '缺少 pluginId' };
  const hit = pluginCache.get(id);
  if (hit) return hit;
  let result;
  try {
    result = loadPlugin(id);
  } catch (e) {
    // 二次兜底：loadPlugin 内部已 catch，这里防"catch 里再抛"把整个调用点带崩
    result = { ok: false, error: String((e && e.message) || e) };
  }
  pluginCache.set(id, result);
  return result;
}

/**
 * 真正建沙盒并装载一个插件。
 * 加载顺序完全按清单的 `files[]`（插件自己在 plugin.json 里声明先后，runner 不再写死一串 lib 名）。
 * @param {string} pluginId
 * @returns {{ok: boolean, api?: object, error?: string, loadMs?: number}}
 */
function loadPlugin(pluginId) {
  const t0 = Date.now();
  try {
    const meta = listProviderPlugins().find((m) => m.id === pluginId);
    if (!meta) throw new Error(`未找到可解包的插件：${pluginId}（需要 provides 含 ${SERVER_UNPACK_ROLE}）`);
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
    // 加载顺序完全取清单 files[]：lib 的先后 + 入口文件都在 plugin.json 里声明，
    //   runner 不再维护一串写死的 lib 名（加插件/调顺序都不该改代码）
    for (const rel of meta.files) {
      vm.runInContext(fs.readFileSync(path.join(PLUGINS_DIR, rel), 'utf8'), sandbox, { filename: rel });
    }
    const NS = sandbox.__ULB__;
    // 清单里有 lib/ 的插件必须把能力挂到 __ULB__（manifest 与代码不一致时要响亮报错）；
    //   没有 lib/ 的插件不建这个命名空间，跳过即可 —— 通用化后不能强制要求它存在
    const hasLibDir = meta.files.some((f) => f.includes('/lib/'));
    if (hasLibDir && (!NS || !NS.bytes)) throw new Error('lib/bytes.js 未能挂载 __ULB__');
    // 以下几块能力在浏览器由 DecompressionStream / 原生 API 提供，node 侧注入等价实现。
    //   均按"插件是否建了该命名空间/该钩子"判空注入：别的插件不一定有 bytes/png。
    if (NS && NS.bytes && typeof NS.bytes.setSha256 === 'function') {
      NS.bytes.setSha256((u8) => crypto.createHash('sha256').update(u8).digest('hex'));
    }
    if (NS && NS.png) {
      NS.png.setInflate((u8) => new Uint8Array(zlib.inflateSync(Buffer.from(u8))));
      NS.png.setDeflate((u8) => new Uint8Array(zlib.deflateSync(Buffer.from(u8), { level: 6 })));
      // 流式版：编码器按 64 行一块喂进来，这里不攒整张、不转 Buffer。
      //   输出与一次性 deflateSync 逐字节相同（deflate 的切分不影响结果，只要不 flush）。
      //   返回**片段数组**（不 concat）：编码器会把片段直接 set 进一次预分配的 PNG 缓冲，
      //   多一次 concat 就是多一份 18MB。
      NS.png.setDeflateStream(async (chunks) => {
        const d = zlib.createDeflate({ level: 6 });
        const out = [];
        d.on('data', (c) => out.push(c));
        const done = new Promise((res, rej) => { d.on('end', res); d.on('error', rej); });
        for (const c of chunks) d.write(c);
        d.end();
        await done;
        return out;
      });
    }
    // 统一契约 __PLUGIN_API__；__ULB_NODE__ 是首版键名，保留兼容（老插件继续能装）
    const api = sandbox.__PLUGIN_API__ || sandbox.__ULB_NODE__;
    if (!api || typeof api.resolve !== 'function' || typeof api.canHandle !== 'function') {
      throw new Error('插件未挂载 __PLUGIN_API__（或兼容键 __ULB_NODE__）的 resolve/canHandle');
    }
    return { ok: true, api, loadMs: Date.now() - t0 };
  } catch (e) {
    // 只记原因、不抛：一个插件坏掉不能带走别的插件，也不能带走服务启动
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 挑一个能处理该文件的插件：按清单顺序逐个试 `canHandle`。
 *
 * 返回的 kind 与历史返回值一一对应（单插件时行为逐字不变）：
 *   picked             找到了（api 可用）
 *   not-handled        所有插件都说不处理
 *   canhandle-threw    有插件抛错且无人认领
 *   plugin-unavailable 所有插件都装不起来（附原因）
 * @param {object} file 交给插件判定的上下文（含 bytes）
 * @returns {{kind: string, id?: string, api?: object, message?: string}}
 */
function pickPlugin(file) {
  const candidates = listProviderPlugins();
  if (!candidates.length) {
    return { kind: 'plugin-unavailable', message: `没有可用的解包插件（需要 provides 含 ${SERVER_UNPACK_ROLE}）` };
  }
  const loadErrors = [];
  let firstHandleError = null;
  for (const meta of candidates) {
    const loaded = ensurePlugin(meta.id);
    if (!loaded.ok) {
      loadErrors.push(`${meta.id}: ${loaded.error}`);
      continue;
    }
    try {
      if (loaded.api.canHandle(file)) return { kind: 'picked', id: meta.id, api: loaded.api };
    } catch (e) {
      // 单个插件判定抛错不终止：继续问下一个插件
      if (!firstHandleError) firstHandleError = `${meta.id}: ${String((e && e.message) || e)}`;
    }
  }
  if (loadErrors.length === candidates.length) return { kind: 'plugin-unavailable', message: loadErrors.join('; ') };
  if (firstHandleError) return { kind: 'canhandle-threw', message: firstHandleError };
  return { kind: 'not-handled' };
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
  let bytes;
  const t0 = Date.now();
  try {
    // 零拷贝视图：`new Uint8Array(buf)` 会把 Buffer 的**内容再拷一份**（19MB 包就是 +19MB 峰值），
    //   而这里只需要一段只读字节视图。必须带 byteOffset/byteLength —— 小文件可能来自 Buffer 池，
    //   只写 buf.buffer 会把池里相邻的其它内容也包进来。
    // 只读约束：本文件与插件层都**不原地写**这段字节（grep 确认无 bytes[i]= / set / fill / copy），
    //   因此与 Buffer 共享内存在语义上是安全的。
    const buf = fs.readFileSync(absPath);
    bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (e) {
    return { ok: false, reason: 'read-failed', message: String((e && e.message) || e) };
  }
  const readMs = Date.now() - t0;
  const name = path.basename(String(rel));
  const file = { rootId, rel, name, size: bytes.byteLength, bytes };
  // 按清单顺序逐个试 canHandle：谁认领谁解（多插件并存，不需要改这里）
  const picked = pickPlugin(file);
  if (picked.kind === 'plugin-unavailable') return { ok: false, reason: 'plugin-unavailable', message: picked.message };
  if (picked.kind === 'canhandle-threw') return { ok: false, reason: 'canhandle-threw', message: picked.message };
  if (picked.kind === 'not-handled') return { ok: false, reason: 'not-handled', message: '插件判定不处理该文件' };
  const t1 = Date.now();
  let res;
  try {
    res = await picked.api.resolve(file);
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
  return { ok: true, pluginId: picked.id, prefix: String(res.prefix), entry: String(res.entry), files: view, readMs, unpackMs };
}

/**
 * 问插件"这个容器解包要吃多少内存"（契约 插件.md §2.2 的 decompressedBytes）。
 *
 * 代价控制：插件侧走 blocksSummary（只读头 + blocksInfo，**不解压数据块**），
 *   实测 19 包 P50 0.13ms / P90 0.91ms（整包 probe 是 20/56/173ms）。
 * 拿不到（插件不支持/不是它的格式/解析失败）就返回 null ⇒ 核心走回落，绝不阻断加载。
 * @param {{rootId:string, rel:string, absPath:string}} opts
 * @returns {{decompressedBytes:number, compressedBytes:number}|null}
 */
export function estimateMemoryOf({ rootId, rel, absPath }) {
  const candidates = listProviderPlugins();
  if (!candidates.length) return null;
  const name = path.basename(String(rel));
  /**
   * 只读文件头部：块表（blocksInfo）几乎总在头部，读到 256KB 就能算；
   * 少数把块表放文件尾的包（实测 aijier_3）会解析失败 ⇒ 退回全量读。
   * 头部字节在多个插件间复用（每个插件各读一次纯属浪费）。
   */
  const readHead = () => {
    const fd = fs.openSync(absPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, MEMORY_PROBE_HEAD_BYTES);
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, 0);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } finally {
      fs.closeSync(fd);
    }
  };
  let headBytes = null;
  let fullBytes = null;
  for (const meta of candidates) {
    const loaded = ensurePlugin(meta.id);
    // 插件装不起来 / 不提供内存声明 ⇒ 试下一个（不阻断，核心会走回落）
    if (!loaded.ok || typeof loaded.api.estimateMemory !== 'function') continue;
    try {
      if (!headBytes) headBytes = readHead();
      let declared = null;
      try {
        declared = loaded.api.estimateMemory({ rootId, rel, name, size: 0, bytes: headBytes });
      } catch {
        declared = null;
      }
      if (declared && declared.decompressedBytes > 0) return declared;
      // 头部不够（块表在尾 / 头部信息不足）⇒ 老老实实读全量再算一次
      if (!fullBytes) {
        const buf = fs.readFileSync(absPath);
        fullBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      }
      declared = loaded.api.estimateMemory({ rootId, rel, name, size: fullBytes.byteLength, bytes: fullBytes });
      if (declared && declared.decompressedBytes > 0) return declared;
    } catch {
      // 这个插件算不出来（不是它的格式）：继续问下一个
    }
  }
  return null;
}

/** 内存声明的"只读头部"字节数：块表几乎总在头部，256KB 够绝大部分包 */
const MEMORY_PROBE_HEAD_BYTES = 256 * 1024;

/**
 * 运行器自身的状态（供 /api/unpack/stats 与排障用）。
 *
 * 返回 `plugins[]` 列出每个 provider 插件的装载状态；
 *   顶层仍保留 pluginId/loaded/loadMs/error/pluginDir —— 单插件时与历史值逐字一致，
 *   `/api/unpack/stats` 的消费方不用改。注意：这里**只读缓存状态**，不会触发装载。
 */
export function runnerInfo() {
  const plugins = listProviderPlugins().map((meta) => {
    const state = pluginCache.get(meta.id);
    return {
      pluginId: meta.id,
      loaded: !!(state && state.ok),
      loadMs: (state && state.loadMs) || 0,
      error: state && state.ok === false ? state.error : null,
      pluginDir: path.relative(ROOT, path.join(PLUGINS_DIR, meta.id)),
    };
  });
  const first = plugins[0] || { pluginId: null, loaded: false, loadMs: 0, error: null, pluginDir: null };
  return { ...first, plugins };
}
