// src/web/infra/plugin-host-unpack.mjs —— 资源取用与解包（从 plugin-host.js 抽出，B4）
//
// 这是宿主里体量最大的一块（20 个函数、约 490 代码行）：把"资源根里的文件"变成
//   "可用的字节 / 解包产物 / VFS 前缀"。它**不碰 DOM、不碰面板**，对外只有四个入口：
//   materialize（容器解包）/ fetchFile（取字节）/ providersFor、findProvider（provider 查询）。
//
// 依赖约定（3 个参数，窄视图；不传整块 ctx）：
//   · io     = { say, emit }                 —— 日志与 diag 事件（依赖，不是状态）
//   · state  = { providers, getDiscovered }  —— provider 表（读）、本次发现清单（读，惰性替换故用 getter）
//   · limits = { base }                      —— 服务端基地址（拼 /api/unpack/resolve 与产物 URL）
//
// 本模块**自持**的状态（生命周期归它管）：
//   · workerPool        —— providerId → { worker, ready, seq, pending }：创建、复用、清理都在这里
//   · MIME_BY_EXT / UNPACK_FETCH_CONCURRENCY / ORDINARY_ASSET_EXT / MAX_BUNDLE_BYTES
//   · toUint8Array / describeType        —— 只为本模块服务的类型工具
//   ⇒ 卸载时的 worker 终止由宿主把 `unpack.pool` 交给 unload 模块完成（创建=这里，清理=unload）
//
// 其余依赖一律**直接 import**（它们是模块级依赖，不是宿主状态）：
//   memoryGuard（内存保护开关/预检）、getSharedVirtualFS、fetchWithRetry/postJson/mapLimit、
//   histogramFromObjects / isAssetDependencyHistogram / dependencyReason
//
// ⚠️ 行为契约（逐字保留）：错误码与文案、诊断事件名（unpack.* / container.*）、
//   预筛上限与并发上限、以及"失败不抛、由调用方回落"的降级语义，搬迁时一处未改。

import * as memoryGuard from '../app/memory-guard.js';
import { getSharedVirtualFS } from './vfs.js';
import { fetchWithRetry, postJson, mapLimit } from './api.js';
import { histogramFromObjects, isAssetDependencyHistogram, dependencyReason } from '../../shared/bundle-shape.mjs';

/**
 * @param {{io: object, state: object, limits: object}} deps
 * @returns {{materialize: Function, fetchFile: Function, providersFor: Function,
 *            findProvider: Function, pool: Map}}
 */
export function createUnpack({ io, state, limits }) {
  const { say, emit } = io;
  const { providers, getDiscovered } = state;
  const { base } = limits;

/**
 * 把各种"字节样"入参归一成 Uint8Array（契约 §1.1 要求的类型）。
 *
 * 为什么必须在宿主侧收口：插件 canHandle 内部对类型不符是 try/catch → 返回 false，
 *   调用方只会看到"这个文件没有提供者"，看不到"你传的类型不对"——
 *   典型的静默失败（实测：同一份 44MB bundle 传 ArrayBuffer 判不出，传 Uint8Array 命中）。
 *   所以 ArrayBuffer / 各种 TypedArray / DataView 都在这里转好，调用方不必记类型。
 * @param {any} value
 * @returns {Uint8Array|null} 无法识别返回 null
 */
function toUint8Array(value) {
if (value instanceof Uint8Array) return value;
if (value instanceof ArrayBuffer) return new Uint8Array(value);
if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
return null;
}
/** 类型名（错误提示用） */
function describeType(value) {
if (value === null) return 'null';
if (typeof value !== 'object') return typeof value;
const ctor = value.constructor && value.constructor.name;
return ctor || Object.prototype.toString.call(value);
}
/**
 * 资源根里某个文件的下载 URL（**唯一拼法**）。
 *
 * 为什么单独抽出来：现在有两条路要取同一个文件 —— 主线程读（fetchFile）与
 *   worker 自己按 URL 拉（unpack-worker）。两处各拼一遍就是"改一处漏一处"的漂移，
 *   而且拼错的表现极难查（一边能解、一边 404）。
 * @param {string} rootId
 * @param {string} rel
 * @returns {string}
 */
function fileUrlOf(rootId, rel) {
  return `${base}/api/file?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(rel)}`;
}

/**
 * 取资源根里的文件字节（契约 §3.6 的唯一取字节通道）。
 * @param {string} rootId 资源根 id
 * @param {string} rel 相对该根的路径（POSIX）
 * @returns {Promise<{bytes: ArrayBuffer, size: number, url: string}>}
 */
async function fetchFile(rootId, rel) {
  const url = fileUrlOf(rootId, rel);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();
  // 容器包字节同样走重试：这是"模型文件"主路径，keep-alive race 会打中它
  const res = await fetchWithRetry(url, { timeoutMs: 20000, label: 'plugin-file' });
  // 契约 §1.1：file.bytes 的类型是 **Uint8Array**（不是 ArrayBuffer）。
  //   宿主在这里就转好，调用方拿到的直接是插件期望的类型。
  const bytes = new Uint8Array(await res.arrayBuffer());
  // 打点：这是"主线程整包读入"的唯一入口。方向④ 完成后它**只该在回落路径出现**，
  //   正常装载不该再有这条 ⇒ 验收就看它在不在。
  try {
    emit('unpack.main-read', { rel, bytes: bytes.byteLength, ms: Math.round(now() - t0) });
  } catch { /* 打点失败不影响取字节 */ }
  return { bytes, size: bytes.byteLength, url };
}
const ORDINARY_ASSET_EXT = /\.(json|skel|atlas|png|jpe?g|webp|bmp|gif|moc3|motion3|physics3|cdi3|txt|md|bin)$/i;
/**
 * **绝对兜底**上限（只防"手滑点了一个几 GB 的文件"，不是内存判据）。
 *
 * 为什么从 512MB 改成 2GB 并受开关控制：原来它是"裸字节数"判断 ——
 *   512MB 的包在 8GB 机器上没事、在 2GB 机器上必然炸，而且关掉内存保护它照样拦，
 *   文案还只说"文件过大（536870912B > 上限 536870912B）"（用户不知道该怎么做）。
 * 现在真正的内存判断交给 memory-budget.assess（按可用内存换算预估峰值），
 *   这里只在"明显不可能是有意义的资源包"时兜一下，且**开关关闭时不拦**。
 */
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * 预筛：返回 null 表示"可能是资源包，值得读全量"，否则返回跳过原因。
 * @param {{rootId?:string, rel?:string, name?:string, size?:number, rootKind?:string}} file
 */
// ── 分区 R4：资源取用与解包（主体）────────────────────────────────────────────
// 注意：预热链（fetchCapacity / warmup / scheduleWarmup）已搬到 plugin-host-warmup.mjs（B1）。
// 从"文件能不能读"（prefilterReason/validateResolved）到"worker 解包→失败回落服务端"，
//   再到"内存准入驱动的预热"（fetchCapacity/warmup/scheduleWarmup）。**不碰 DOM**。
// 状态耦合：discovered（读清单）、providers、say、emit、workerPool/warmupInflight/capCache。
function prefilterReason(file) {
  if (!file || !file.rootId || !file.rel) return '缺少 rootId/rel';
  if (file.rootKind && file.rootKind !== 'bundle') return `资源根类型是 ${file.rootKind}，不是 bundle`;
  const name = String(file.name || file.rel);
  if (ORDINARY_ASSET_EXT.test(name)) return `后缀是普通模型资产（${name.split('.').pop()}），不可能是资源包`;
  if (typeof file.size === 'number' && file.size === 0) return '文件为空';
  // 绝对兜底：只在内存保护开着时生效（关掉开关＝用户明示要试，不再拦）
  if (memoryGuard.isMemoryGuardOn() && typeof file.size === 'number' && file.size > MAX_BUNDLE_BYTES) {
    const gb = (n) => `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
    return `包体积 ${gb(file.size)} 超过绝对上限 ${gb(MAX_BUNDLE_BYTES)}（内存保护开启时的兜底；可在面板关闭内存保护后重试）`;
  }
  return null;
}

/**
 * 校验 provider.resolve 的返回值（契约 §一 / §5.8：不得返回缺字段半成品）。
 * @returns {string|null} null = 合规，否则返回原因
 */
function validateResolved(res) {
  if (!res || typeof res !== 'object') return '返回值不是对象';
  if (typeof res.prefix !== 'string' || !/^vfs:\/\/.+\/$/.test(res.prefix)) {
    return `prefix 不合契约 §1.2（应形如 vfs://<providerId>/<rootId>/<相对目录>/）：${res.prefix}`;
  }
  const files = res.files;
  const size = files instanceof Map ? files.size
    : (files && typeof files === 'object' ? Object.keys(files).length : 0);
  if (!size) return 'files 为空';
  if (typeof res.entry !== 'string' || !res.entry) return 'entry 缺失';
  const has = files instanceof Map
    ? files.has(res.entry)
    : Object.prototype.hasOwnProperty.call(files, res.entry);
  if (!has) return `entry 不在 files 里：${res.entry}`;
  return null;
}

/** 读全量字节（file.bytes 优先；没有就经 /api/file 取） */
async function bytesOf(file) {
  const given = toUint8Array(file.bytes);
  if (given) return { ok: true, bytes: given };
  try {
    const got = await fetchFile(file.rootId, file.rel);
    return { ok: true, bytes: got.bytes };
  } catch (e) {
    return { ok: false, message: `读文件失败：${(e && e.message) || e}` };
  }
}

/**
 * 解包 Worker 的单例管理。
 *
 * 为什么需要：LZMA 解压实测 300~620ms/MB（解压后），一个 8.28MB 的包要 3.9 秒纯同步 CPU，
 *   留在主线程就是 4 秒白屏。放进 worker 后主线程照常渲染。
 * 为什么按 provider 建：不同插件的 lib 清单不同（`files[]` 是加载顺序的权威），
 *   一个 worker 只装一个 provider 的那份 lib。
 */
const workerPool = new Map();   // providerId → { worker, ready, seq, pending }

/** 从 `discovered` 找该 provider 的 files[]（按 id 动态找，不硬编码插件名） */
function filesOfProvider(providerId) {
  const pl = getDiscovered().find((p) => p && p.id === providerId);
  return pl && Array.isArray(pl.files) ? pl.files : null;
}

/** worker 的进度事件 → 状态行 + 调试日志（4 秒里不能一点反馈都没有） */
function onWorkerProgress(m) {
  const d = m.detail || {};
  if (m.phase === 'probing') {
    // 判定包类型也要解一遍（插件的 canHandle 会完整解析），所以它同样是"会等数秒"的一段
    say.info('后台解包：正在判定包内容类型…（主线程不阻塞）');
    emit('unpack.worker', { phase: 'probing' });
  } else if (m.phase === 'blocks') {
    const est = d.estimateMs ? `，预计约 ${(d.estimateMs / 1000).toFixed(1)} 秒` : '';
    say.info(`后台解包：${d.algo} / ${d.blocks} 块 / 解压后 ${d.decompressedMB}MB${est}（主线程不阻塞）`);
    emit('unpack.worker', { phase: 'blocks', ...d });
  } else if (m.phase === 'unpacking') {
    emit('unpack.worker', { phase: 'unpacking' });
  }
}

/**
 * 取（或建）某个 provider 的 worker；建不起来返回 null（调用方回落同步解包）。
 * @param {string} providerId
 * @returns {Promise<object|null>}
 */
function ensureUnpackWorker(providerId) {
  if (workerPool.has(providerId)) return workerPool.get(providerId).ready;
  const files = filesOfProvider(providerId);
  const entry = { worker: null, ready: null, seq: 0, pending: new Map() };
  workerPool.set(providerId, entry);
  entry.ready = (async () => {
    if (typeof Worker !== 'function' || !files || !files.length) return null;
    let worker;
    // 静态托管的映射是 src/web/ → 站点根（实测：/app/model-actions.js 可用），
    //   所以 src/web/plugin/unpack-worker.js 的 URL 就是 /plugin/unpack-worker.js
    try { worker = new Worker(new URL('/plugin/unpack-worker.js', import.meta.url)); } catch { return null; }
    entry.worker = worker;
    const ok = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);   // 载 lib 超时 ⇒ 判不可用
      worker.addEventListener('message', (ev) => {
        const m = ev.data || {};
        if (m.t === 'ready') { clearTimeout(timer); resolve(!!m.hasProvider); }
        else if (m.t === 'progress') onWorkerProgress(m);
        else if (m.t === 'done' || m.t === 'fail') {
          const p = entry.pending.get(m.id);
          if (p) { entry.pending.delete(m.id); p(m); }
        }
      });
      worker.addEventListener('error', () => { clearTimeout(timer); resolve(false); });
      // files 元素已带插件目录（unity-live2d-bundle/lib/xxx.js），故 base 到 /plugins/
      worker.postMessage({ t: 'init', base: new URL('/plugins/', import.meta.url).href, files });
    });
    if (!ok) { try { worker.terminate(); } catch { /* 忽略 */ } entry.worker = null; return null; }
    return entry;
  })();
  return entry.ready;
}

/**
 * 用 worker 解包。失败**不抛**，返回 {ok:false} 让调用方回落同步路径（降级不静默，由调用方报）。
 * @param {object} prov 提供者
 * @param {object} file 条目（rootId/rel/name）
 * @param {Uint8Array|null} bytes 已读字节；为 null 时改用 opts.url 让 worker 自己拉
 * @param {{url?: string, size?: number}} [opts] url 模式参数（方向④）
 * @returns {Promise<{ok:boolean, res?:object, src?:string, error?:string}>}
 */
async function resolveViaWorker(prov, file, bytes, opts = {}) {
  const entry = await ensureUnpackWorker(prov.id);
  if (!entry) return { ok: false, unavailable: true, error: `worker 不可用（${prov.id}：CSP / 老浏览器 / 插件 lib 加载失败）` };
  const id = (entry.seq += 1);
  // 两种投喂方式（方向④）：
  //   · bytes 已就绪（调用方本来就要读 / 或 file.bytes 内联给了）⇒ 结构化拷贝给 worker
  //   · 只有 URL ⇒ **worker 自己 fetch**：主线程不再把 19MB 读进来再拷一遍
  //     （实测那一段 "read arrayBuffer + postMessage" 占 3918ms/19.3MB，是首帧最大的单笔开销）
  // 仍然刻意**不**用 transferable：同一份 bytes 可能要依次交给多个 provider 试，
  //   transfer 出去主线程的 buffer 就 detached 了；而 url 模式下这条顾虑从根本上不存在。
  const url = opts && opts.url ? String(opts.url) : '';
  const useUrl = !bytes && !!url;
  const payload = { t: 'unpack', id, file: { rootId: file.rootId, rel: file.rel, name: file.name } };
  if (useUrl) { payload.url = url; payload.size = Number.isFinite(opts.size) ? Number(opts.size) : 0; }
  else { payload.bytes = bytes; }
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const postT0 = nowMs();
  // 注意 Promise 的执行器是**同步**跑的 ⇒ 构造返回时 postMessage 已经调用完毕，
  //   于是 postMs 量到的就纯粹是"投喂"这一步（bytes 模式是结构化拷贝，url 模式只是发个小对象）。
  const waitDone = new Promise((resolve) => {
    const timer = setTimeout(() => { entry.pending.delete(id); resolve({ t: 'fail', message: 'worker 超时（60s）' }); }, 60000);
    entry.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    entry.worker.postMessage(payload);
  });
  const postMs = Math.round(nowMs() - postT0);
  const result = await waitDone;
  // 打点分两个数（别混）：postMs = 投喂；totalMs = 整轮（含 worker 自己拉包 + 解压）
  try {
    emit('unpack.worker-post', {
      rel: file.rel, mode: useUrl ? 'url' : 'bytes', bytes: useUrl ? 0 : (bytes ? bytes.byteLength : 0),
      postMs, totalMs: Math.round(nowMs() - postT0),
    });
  } catch { /* 打点失败不影响解包 */ }
  if (result.t === 'no-handle') return { ok: false, noHandle: true };
  if (result.t !== 'done' || !result.res) {
    return { ok: false, error: `${result.code || 'worker-fail'}: ${result.message || '未知'}` };
  }
  // 产物从「[[path, Blob|Uint8Array, type]]」还原成 Map<path, **Blob**>。
  //   vfs.register 只接受 Blob 或字符串（实测传 Uint8Array 会报"内容必须是 Blob 或字符串"）。
  //   worker 侧现在会把插件的 Blob 原样透传（零拷贝），只有非 Blob 产物才需要我们在这里建；
  //   所以大部分文件走 `val` 直通，一个字节都不用再复制。
  const files = new Map((result.res.files || []).map(([p, val, type]) => [
    p,
    (typeof Blob !== 'undefined' && val instanceof Blob)
      ? val
      : new Blob([val], { type: type || 'application/octet-stream' }),
  ]));
  return {
    ok: true,
    src: 'local-worker',
    workerMs: result.ms,
    res: { prefix: result.res.prefix, entry: result.res.entry, files },
  };
}

/**
 * 解析一个没人认领的容器，统计包内对象类型构成。
 *
 * 只在「所有插件 canHandle 都说不认」的失败路径上跑一次（不进渲染热路径）。
 * 这里只负责"在浏览器里怎么拿到对象表"（走插件注入的 window.__ULB__）；
 *   **怎么统计、怎么判定、文案怎么写，全部在 src/shared/bundle-shape.mjs**，
 *   与 node 侧 /api/unpack 共用同一份，避免两条路径给出两种答案。
 * @param {Uint8Array} bytes 容器字节
 * @returns {Record<string, number>|null} className → 数量；探测不了返回 null
 */
function classHistogramOf(bytes) {
  try {
    const NS = typeof window !== 'undefined' ? window.__ULB__ : null;
    const ufs = NS && NS.unityfs;
    const ser = NS && NS.serialized;
    if (!ufs || !ser || typeof ufs.readHeader !== 'function' || !bytes || !bytes.length) return null;
    const head = ufs.readHeader(bytes);
    const cab = (head.nodes || []).find((n) => /^CAB-/.test(n.path));
    if (!cab) return null;
    const parsed = ufs.parse(bytes);
    return histogramFromObjects(ser.parse(ufs.nodeBytes(parsed, cab.path)));
  } catch { return null; }
}

/** 找提供者并 resolve（含返回值契约校验） */
async function resolveViaProvider(file, bytes) {
  const provider = findProvider({ ...file, bytes });
  if (!provider) {
    // 没人认领时先判形态：美术依赖包要说清楚"为什么打不开 + 下一步怎么做"，
    //   否则用户只会看到泛化的"没有启用的提供者"，误以为插件被禁用或加载失败。
    //   判据与文案来自 src/shared/bundle-shape.mjs（与 node 侧 /api/unpack 同一份）。
    const hist = classHistogramOf(bytes);
    if (isAssetDependencyHistogram(hist)) {
      return {
        ok: false,
        reason: 'asset-dependency',
        message: dependencyReason(hist),
      };
    }
    return {
      ok: false,
      reason: 'no-provider',
      message: `没有启用的提供者能处理 ${file.rel}`
        + '（检查 config/plugins.json 是否禁用了对应插件，或插件是否加载失败）',
    };
  }
  if (typeof provider.resolve !== 'function') {
    return { ok: false, reason: 'no-resolve', message: `提供者 ${provider.id} 没有 resolve()` };
  }
  let res = null;
  try {
    res = await provider.resolve({ ...file, bytes, host: hostApi });
  } catch (e) {
    return { ok: false, reason: 'resolve-failed', message: `提供者 ${provider.id} 解析失败：${(e && e.message) || e}` };
  }
  const bad = validateResolved(res);
  if (bad) return { ok: false, reason: 'bad-result', message: `提供者 ${provider.id} 返回不合契约：${bad}` };
  // 与 worker 候选循环同一把尺子：产物不自洽就当场判定不可用。
  //   不判的后果是错误被推迟到装载阶段，只剩一句 "Network error."，根因完全看不出来。
  //   注：本函数只有一个候选（findProvider 选定的那个），不在这里改试下一个 ——
  //   多候选轮试在 worker 循环里做；这条同步路径只在 ?unpack=0 或 worker 全不可用时才走。
  const usable = await resolvedUsable(res);
  if (!usable.ok) {
    return { ok: false, reason: 'bad-result', message: `提供者 ${provider.id} 的产物不可用：${usable.why}` };
  }
  return { ok: true, provider: provider.id, res };
}

/**
 * 产物可用性校验：**"插件说能解"不等于"产物真能用"**。
 *
 * 为什么必须有：同一个 UnityFS 包可能被多个 bundle 插件都判成"我能处理" ——
 *   它们的判定只看包结构，不看"解出来的东西是否自洽"。
 *   实测（NIKKE 的 spine 资源包）：live2d 插件抢先返回 ok，但它生成的 `model3.json`
 *   里 Moc 指向的 `moc3.moc3` 内容只有 4 字节、字面量 `null`（包里根本没有 moc3）
 *   ⇒ 后续按 live2d 装载必然失败（控制台只有一句 Network error），
 *   而真正能解这个包的 spine 插件永远轮不到 ⇒ 表现为"点一次不出画，
 *   再点一次（服务端缓存选对了插件）才显示"。
 *
 * 判据（对所有 kind 通用，不认包名）：
 *   ① 入口文件必须真实存在于产物里
 *   ② 入口是 JSON 时，它引用的每个文件也必须在产物里，且内容不是空/占位（≤8 字节）
 *   ③ 校验自身出错一律放行（宁可放过一次，不可错杀可用产物）
 * @param {{entry: string, files: Map<string, Blob>}} res 插件产物
 * @returns {Promise<{ok: boolean, why?: string}>}
 */
async function resolvedUsable(res) {
  try {
    const files = res && res.files;
    if (!files || typeof files.keys !== 'function' || !files.size) return { ok: false, why: '产物为空' };
    const norm = (p) => String(p || '').replace(/^\.?\//, '');
    const keys = [...files.keys()];
    const find = (name) => keys.find((k) => norm(k) === norm(name));
    const entryName = norm(res.entry);
    if (!entryName) return { ok: false, why: '没有入口文件' };
    const entryKey = find(entryName);
    if (entryKey === undefined) return { ok: false, why: `入口 ${entryName} 不在产物里` };
    const blob = files.get(entryKey);
    if (!blob || typeof blob.text !== 'function') return { ok: true };
    let meta = null;
    try { meta = JSON.parse(await blob.text()); } catch { return { ok: false, why: '入口不是合法 JSON' }; }
    const fr = (meta && meta.FileReferences) || {};
    const refs = [
      ...(meta && meta.skeletonFile ? [meta.skeletonFile] : []),
      ...(meta && meta.atlasFile ? [meta.atlasFile] : []),
      ...(Array.isArray(meta && meta.textureFiles) ? meta.textureFiles : []),
      ...(fr.Moc ? [fr.Moc] : []),
      ...(Array.isArray(fr.Textures) ? fr.Textures : []),
      ...(fr.Physics ? [fr.Physics] : []),
    ];
    for (const r of refs) {
      const k = find(r);
      if (k === undefined) return { ok: false, why: `引用文件 ${r} 不在产物里` };
      const b = files.get(k);
      if (b && typeof b.size === 'number' && b.size <= 8) {
        return { ok: false, why: `引用文件 ${r} 只有 ${b.size} 字节（空/占位）` };
      }
    }
    return { ok: true };
  } catch { return { ok: true }; }
}

/** 注册进 VirtualFS；同前缀重复装载时先撤再注册（不泄漏旧 prefix） */
function registerResolved(vfs, res) {
  try {
    vfs.register(res.prefix, res.files);
    return { ok: true, reRegistered: false };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!/已注册/.test(msg)) return { ok: false, message: `注册进 VirtualFS 失败：${msg}` };
    try { vfs.revoke(res.prefix); } catch { /* 撤销失败也继续重试 */ }
    try {
      vfs.register(res.prefix, res.files);
      return { ok: true, reRegistered: true };
    } catch (e2) {
      return { ok: false, message: `重新注册失败：${(e2 && e2.message) || e2}` };
    }
  }
}

/**
 * 把一个资源包文件"物化"进 VirtualFS：预筛 → 读全量 → findProvider → resolve → register。
 * 本函数**不碰渲染**（接线是下一步），只保证"资源真的进了 VFS 且能解析出入口地址"。
 * @param {object} file { rootId, rel, name?, size?, rootKind?, bytes? }
 * @param {{vfs?: object}} [opts]
 * @returns {Promise<object>} { ok, reason?, message?, provider?, prefix?, entry?, entryUrl?, files? }
 */
/** 解包产物并发上限：留出槽位给模型文件与就绪上报（同源只有 6 个连接槽） */
const UNPACK_FETCH_CONCURRENCY = 4;

/** 产物文件的 MIME（按扩展名；未知一律 octet-stream） */
const MIME_BY_EXT = {
'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
'.json': 'application/json', '.moc3': 'application/octet-stream', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
};

/** 产物文件数（跨 realm 鸭子类型：Map 看 size，普通对象看键数） */
function filesCount(files) {
  if (!files) return 0;
  if (typeof files.size === 'number') return files.size;
  return Object.keys(files).length;
}

/**
 * 从 VFS 前缀里取出真正解出这份产物的提供者 id。
 *
 * 为什么必须取：服务端命中路径过去把 provider 写死成 `'server'`，而 `'server'` 不是注册表里
 *   任何一个提供者 ⇒ 服务端按 id 反查声明色得到 null ⇒ 徽标掉回中性色。
 *   实测的两个症状都出在这：①"颜色当场变了、切回来又变回中性"②第二次点击（命中缓存）
 *   上报的 provider 是假 id，把存储里的正确记录覆盖坏。
 * 前缀形态与 server/unpack/plugin-store.mjs 的 expectedPrefix 同源（同一套拼接规则）：
 *   `vfs://<providerId>/<rootId>/<相对目录>/`
 * @param {string} prefix VFS 前缀
 * @returns {string|null} 解析不出就返回 null（调用方按"未确定归属"处理，绝不编一个 id）
 */
function providerFromPrefix(prefix) {
  const s = String(prefix || '');
  const m = /^vfs:\/\/([^/]+)\//.exec(s);
  return m ? m[1] : null;
}

/**
 * 竞速取"第一个成功"的（注意：不是第一个 settle 的——先失败的那条不该让我们提前放弃）。
 * @param {Array<Promise<any>>} ps
 * @returns {Promise<any>} 首个 fulfilled 的值；全失败则抛最后一个错误
 */
function firstFulfilled(ps) {
  return new Promise((resolve, reject) => {
    let left = ps.length;
    let lastErr = null;
    for (const p of ps) {
      p.then((v) => resolve(v), (e) => {
        lastErr = lastErr || e;
        left -= 1;
        if (left === 0) reject(lastErr);
      });
    }
  });
}

/**
 * 服务端**命中查询**（形态 C 的前台路径）：`hitOnly` ⇒ 服务端只读索引，**绝不在这里解包**。
 * miss 会抛 reason='server-miss'，调用方据此走本地解包（首次绝不因此变慢）。
 * 真正的解包由 warmup() 在页面空闲时触发。
 * @param {{rootId: string, rel: string}} file
 * @returns {Promise<{prefix: string, entry: string, files: Map<string, Uint8Array>, hit: boolean, provider: string, src: string}>}
 */
async function resolveFromServer(file, { hitOnly = true, mon = null } = {}) {
  // 自定义超时已删：查询只读服务端的缓存索引，本该很快；给它 1.5s 反而会在服务偶尔忙时
  //   超时被误判成"没缓存"，直接导致前端白解一遍（19MB / 4.3s）。用统一的默认超时即可。
  const tLook = performance.now();
  let j;
  try {
    // allowOverLimit：面板「内存保护」关掉时允许服务端越过内存预算（默认开 ⇒ 不带，行为不变）
    // 显式 retries:2 —— 这个 POST 是**幂等**的（同 rootId+rel 解出来的产物相同），失败重发安全。
    //   api.js 对非幂等方法默认不重试（防"创建成功但响应丢了 ⇒ 重发 ⇒ 建两个"），
    //   所以幂等的 POST 必须在调用点显式声明意图，不能指望默认值。
    j = await postJson('/api/unpack/resolve',
      { rootId: file.rootId, rel: file.rel, hitOnly, allowOverLimit: !memoryGuard.isMemoryGuardOn() },
      { retries: 2 });
  } catch (e) {
    // 查询**失败**（超时/网络/连接复用被打断）必须可见：以前这种异常没有 reason，
    //   被 catch 静默当成"未命中"，日志里查不出任何痕迹 —— 这是排查不出来的首因。
    emit('unpack.lookup', { rootId: file.rootId, rel: file.rel, ok: false, error: String((e && e.message) || e).slice(0, 120), ms: Math.round(performance.now() - tLook) });
    say.warn(`命中查询失败：${file.rel}（${(e && e.message) || e}）`);
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { reason: 'lookup-error' });
  }
  if (!j || !j.ok) {
    emit('unpack.lookup', { rootId: file.rootId, rel: file.rel, ok: false, error: (j && (j.reason || j.message)) || 'bad-response', ms: Math.round(performance.now() - tLook) });
    throw Object.assign(new Error((j && (j.message || j.reason)) || '服务端查询失败'), { reason: 'lookup-error' });
  }
  if (!j.hit && hitOnly) {
    // **只有"只查缓存"模式**才把 hit:false 当作未命中。
    //   hitOnly=false 时服务端是**真解包**：解完后返回 hit:false + 完整产物，这是正常成功路径。
    //   早前这里无条件按 !j.hit 抛 server-miss ⇒「请服务端解包」这条路永远走不通，
    //   于是"本地插件解不了的包（如纹理格式 ASTC/50）在页面上永远打不开"。
    emit('unpack.lookup', { rootId: file.rootId, rel: file.rel, ok: true, hit: false, missReason: j.missReason || 'no-index', ms: Math.round(performance.now() - tLook) });
    throw Object.assign(new Error(`未命中（${j.missReason || 'no-index'}）`), { reason: 'server-miss' });
  }
  emit('unpack.lookup', {
    rootId: file.rootId, rel: file.rel, ok: true,
    hit: !!j.hit,
    ...(j.hit ? {} : { unpacked: true }),   // 服务端刚解完（server-unpack），验收要看这一次花了多久
    ms: Math.round(performance.now() - tLook),
  });
  // **并行**取产物：实测 19 个文件顺序 145ms vs 并行 57ms（39 个文件 413ms vs 174ms）。
  //   顺序取会让"命中路径"慢 2.5 倍，从而在竞速里输给本地解包 —— 那 17b 就白做了。
  const list = j.files || [];
  // **限流 4 并发**：39 个文件一次全发会吃满同源 6 个连接槽，
  //   把 Spine 模型文件与 /api/ready 挤到队列里超时（现场："加载资源包之后全挂"）。
  // 路径 C｜长操作监控：39 个文件可能要取几秒，期间堆占用飙升就先停手。
  //   中止只影响"还要不要再取"，已经取到的文件与已落盘的服务端产物都保留。
  const got = await mapLimit(list, UNPACK_FETCH_CONCURRENCY, async (f) => {
    // 每步开头同步采一次（不依赖"是否已跨帧"）：短操作也能被及时发现
    //   mon 由调用方（materialize）传入 —— 它是在那里启动的监控。
    //   曾经这里直接引用 mon 但它在另一个函数作用域里 ⇒ 命中路径一取产物就抛
    //   "mon is not defined"，被上层当成服务端失败，回落到本地重新解一遍（实测 16s）。
    if (mon && mon.checkNow()) throw Object.assign(new Error(mon.reason()), { reason: 'memory-guard' });
    // 服务端解包产物同样属于"模型文件"，失败要重试（keep-alive race 会打中这里）
    const res = await fetchWithRetry(f.url, { timeoutMs: 8000, label: 'unpack-file' });
    // VFS 只接受 Blob/字符串（本地路径上插件给的就是 Blob）→ 这里转成带 MIME 的 Blob，
    //   MIME 影响 blob URL 的消费方（<img>/WebGL 纹理、fetch 后 JSON.parse 都看它）
    const type = MIME_BY_EXT[(/\.[a-z0-9]+$/i.exec(f.path) || [''])[0].toLowerCase()] || 'application/octet-stream';
    return [f.path, new Blob([await res.arrayBuffer()], { type })];
  });
  const files = new Map(got);
  if (!files.size) throw new Error('服务端返回的产物为空');
  // src 区分"命中已有缓存"与"服务端刚解出来"：验收要看 unpack.source 到底走没走重复劳动
  // provider 取**真正解出这份产物的插件 id**（从 VFS 前缀解析，见 providerFromPrefix），
  //   不再写死 'server'：那是个注册表里不存在的假 id，会让服务端反查声明色得到 null
  //   ⇒ 表现为"命中缓存的第二次点击颜色反而掉回中性色"。
  //   解析不出（前缀形态异常）时返回 null，由上层按"归属未定"处理，绝不编一个 id 上去。
  return {
    prefix: j.prefix, entry: j.entry, files, hit: true,
    provider: providerFromPrefix(j.prefix),
    src: hitOnly ? 'server-hit' : 'server-unpack',
  };
}
async function materialize(file, opts = {}) {
  const vfs = opts.vfs || getSharedVirtualFS();
  const skip = prefilterReason(file);
  if (skip) return { ok: false, reason: 'prefilter', message: `跳过：${skip}` };

  // 路径 B｜前端加载前预检：JS 堆占用已超阈值就先别加载（继续加载很可能直接 OOM 崩页面）。
  //   浏览器不暴露 performance.memory 时 preflightLoad 会放行（拿不到真值就不假装保护）。
  // 顺带把"这个包需要多少内存"取回来（面板判据行要显示真实需求，不能只显示可用量）——
  //   不 await：判据读数只是展示，不能拖慢加载。
  memoryGuard.refreshMemoryReadout({ rootId: file.rootId, rel: file.rel }).catch(() => { /* 取不到就维持上次 */ });
  // 解包峰值准入**整个去掉**（曾经在这里判，也在 localPath 里判过，都不对）。
  //   分工口径：服务端内存不够就由浏览器负责解包，而不是拒绝装载。
  //   服务端 capacity 只负责「服务端要不要解 / 面板显示多少」，不参与前端解包准入。
  //   浏览器侧的保护是 preflightLoad（JS 堆预检）+ 长操作监控（越线中止、已完成部分保留）。
  //   实测背景：42MB 包服务端解包峰值 630MB 会被服务端自身拒绝，
  //   而同一台机器的浏览器解同一个包 4.3s 且渲染正常。
  const pre = await memoryGuard.preflightLoad(file.rel);
  if (!pre.ok) {
    say.warn(pre.message);
    emit('memguard.preflight', { rel: file.rel, usedMB: pre.usedMB, limitMB: pre.limitMB, pct: pre.pct });
    return { ok: false, reason: 'memory-guard', message: pre.message };
  }

  // 路径 C｜长操作监控：**覆盖整条装载路径**（服务端取产物 / 本地解包 / 读大包字节都算）。
  //   曾经只挂在"取服务端产物"的循环里 —— 可 cache miss 时走的是本地解包，
  //   那个循环根本不执行，监控等于不存在（端到端实测发现）。
  const mon = memoryGuard.startMemoryMonitor(`装载 ${file.rel}`);
  try {
  const tMat = performance.now();
  // 运行时开关：?unpack=off 关掉服务端命中查询与预热（性能基线用；同一份代码只差开关）
  const unpackOn = (() => {
    try { return new URLSearchParams(location.search).get('unpack') !== '0'; } catch { return true; }
  })();
  if (!unpackOn) emit('unpack.race', { enabled: false, reason: 'URL 参数 unpack=0' });

  // 本地通道：原逻辑一字未改（readFile → 插件 resolve）
  const localPath = async () => {
    // 这里**不做服务端预算准入**。分工口径（用户定）：
    //   服务端内存不够 ⇒ 就由浏览器负责解包，而不是拒绝装载。
    //   服务端 capacity 只决定两件事：① 服务端要不要解（预热 / 直调接口）② 面板上显示多少
    //   浏览器自己的保护是：preflightLoad（JS 堆预检）+ 下面这条长操作监控（越线就中止，
    //   已完成的部分保留）。两者都在，够用。
    // 实测背景：42MB 资源包服务端解包峰值 630MB > 可用预算时会直接拒绝；
    //   但同一台机器的浏览器解同一个包只要 4.3s 且能正常渲染 —— 拒绝是错的。
    // 读整包进内存是这条路径上最吃内存的一步：先查一次，越线就不读
    if (mon.checkNow()) throw Object.assign(new Error(mon.reason()), { reason: 'memory-guard' });
    // ── 方向④：**主线程不再预先读整包** ────────────────────────────────
    //   以前这里先 bytesOf(file) 把 19MB 读进主线程、再 postMessage 拷给 worker，
    //   实测那一段 3918ms/19.3MB，是首帧最大的单笔开销。现在改成：
    //     · 有内联 bytes（调用方已给）⇒ 照旧直接投喂
    //     · 否则只把 **URL + 体积** 交给 worker，由它自己 fetch（主线程只发一条小消息）
    //   懒读兜底：只有"worker 整条路都不成立"时，才真正 bytesOf() 一次（回落到同步解包）。
    let sizeHint = Number.isFinite(file.size) ? Number(file.size) : 0;
    const fileUrl = fileUrlOf(file.rootId, file.rel);
    const inlineBytes = toUint8Array(file.bytes);
    // 调试开关 ?workerFetch=0：强制回"主线程先读整包再投喂"的旧行为。
    //   存在的理由只有一个 —— 让"改造前/后"能在**同一台机器同一次会话**里 A/B 对比，
    //   而不是拿两份不同时间的日志比。平时不设即走 url 模式。
    const forceMainRead = (() => {
      try { return new URLSearchParams(location.search).get('workerFetch') === '0'; } catch { return false; }
    })();
    let readCache = null;
    const ensureBytes = async () => {
      if (readCache) return readCache;
      const r = await bytesOf(file);
      if (!r.ok) throw Object.assign(new Error(r.message), { reason: 'read-failed' });
      readCache = r;
      return r;
    };
    // 条目没带体积时（少数历史条目 / 目录型），进度事件的 bytes 就没法凭空写对。
    //   这时**先读一次**把真实体积拿到 —— 宁可多读这一次，也不要把既有事件语义
    //   从"压缩字节数"降级成 0（下游按它显示"压缩 xMB / 估算耗时"，0 会被当真）。
    if (!inlineBytes && sizeHint <= 0) {
      const r = await ensureBytes();
      sizeHint = r.bytes.length;
    }
    // 同步解压前先把"在等什么"写出去，并**让出一帧**：
    //   插件 resolve 是同步的，LZMA 包实测要 1.7~10 秒（≈300~620ms/MB 解压后体积），
    //   主线程一旦进解压就再没机会渲染这条提示（DOM 已改、但浏览器不会给你帧）。
    //   让帧代价约 16ms，换来"用户知道在解压、不是卡死"。非 LZMA 包几乎不受影响（多一帧）。
    // 体积取自条目元信息（解包前主线程不读包，拿不到就得等读完才知道大小）
    say.info(`本地解包中：${file.rel}（压缩约 ${(sizeHint / 1048576).toFixed(2)}MB，大包可能要数秒）`);
    emit('unpack.local-start', { rootId: file.rootId, rel: file.rel, bytes: sizeHint });
    // **所有压缩类型**都先试 worker：resolve 的成本只看包有多大，与压缩类型无关。
    //   为什么从"只看 canHandle"改成"看 resolve 成本"：
    //     · 旧门禁只看 canHandle 贵不贵（LZMA 的 canHandle 要 5.7s、LZ4 只要毫秒级），
    //       就据此决定 LZ4/none 继续走同步 —— 但 canHandle 那点差异，在 resolve 面前可忽略。
    //     · resolve 要解压**全部数据块** + 抽文件 + 产物归一，实测代价：
    //         aijier_3（LZ4，解压后 44MB）同步 resolve 6.8s，主线程最长 longtask 2.8~3.9s；
    //         live2d/z46_2（LZMA，解压后 35MB）走 worker，主线程最长 longtask 仅 462ms。
    //       两个包大小同级，主线程占用差 8 倍以上 —— 差别只在走不走 worker。
    const bundleCands = providersFor(['bundle']);
    // 「没有任何 bundle 插件」≠「所有候选 worker 都不可用」：
    //   候选为空时下面的循环压根不跑，若照旧写死那句结论，就会把"没有插件能处理这个包"
    //   误报成"worker 不可用"，把排查方向带偏到 CSP / worker 加载。
    //   候选为空就跳过整段，落到同步路径去报正确的"没有插件能处理"。
    if (bundleCands.length) {
      let fellBack = '';
      let anyProbed = false;   // 有没有任何一个 worker 真的判过"不认这个包"
      for (const cand of bundleCands) {
        // 有内联字节就直投；否则把 URL 交给 worker 自己拉（主线程零字节搬运）。
        //   ?workerFetch=0 时故意先读一遍，用来量"改造前"那一段的耗时。
        const wBytes = forceMainRead ? (await ensureBytes()).bytes : inlineBytes;
        const w = await resolveViaWorker(cand, file, wBytes, wBytes ? {} : { url: fileUrl, size: sizeHint });
        if (w.ok) {
          if (mon.checkNow()) throw Object.assign(new Error(mon.reason()), { reason: 'memory-guard' });
          // 「说能解」≠「解出来能用」：产物不自洽就换下一个候选（判据见 resolvedUsable 注释）。
          //   不加这一步：排在前面的插件用伪造产物（例如 moc3 写成 null）抢先成功，
          //   真正能解它的插件永远轮不到 ⇒ 装载阶段才炸，且只留一句 Network error。
          const usable = await resolvedUsable(w.res);
          if (!usable.ok) {
            anyProbed = true;
            say.warn(`候选 ${cand.id} 的产物不可用（${usable.why}）—— 换下一个候选`);
            emit('unpack.candidate-reject', { rootId: file.rootId, rel: file.rel, provider: cand.id, why: usable.why });
            continue;
          }
          return { ...w.res, provider: cand.id, src: 'local-worker' };
        }
        // 「这个 worker 建不起来」≠「这个 provider 不认这个包」：
        //   前者应继续试下一个候选（另一个插件的 worker 可能能用），
        //   后者才该落到同步路径去问它。写反了会让"第一个候选 worker 失败"直接把整条后台路径废掉
        //   —— 实测就是这么误降级的（spine 插件 worker 建不起来 ⇒ 明明 live2d worker 可用却回落到同步）。
        if (w.unavailable) continue;
        if (w.noHandle) { anyProbed = true; continue; }
        fellBack = w.error || '解包失败';
        break;
      }
      // 全都没判成（worker 一个都起不来）才报降级；"有 worker 判过但不认"属正常，
      //   交给下面的同步路径去给出正确的"没有插件能处理"错误，不该谎报成后台不可用
      if (!fellBack && !anyProbed) fellBack = '所有候选插件的 worker 都不可用';
      if (fellBack) {
        // 降级**不静默**：明确告诉用户"后台解包用不了，接下来会卡数秒"
        say.warn(`后台解包不可用（${fellBack}）—— 回落主线程解包，期间界面会卡住数秒`);
        emit('unpack.worker-fallback', { rootId: file.rootId, rel: file.rel, error: fellBack });
      }
    }
    // 同步解压前让出一帧：DOM 改了但主线程随即冻住，浏览器不会给你渲染机会。
    //   代价约 16ms，换来"用户知道在解压、不是卡死"。
    await new Promise((resolve) => {
      const next = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
      next(() => resolve());
    });
    // 走到这里说明 worker 路径没成：**这时候才**把整包读进主线程（懒读兜底）
    const read = await ensureBytes();
    const got = await resolveViaProvider(file, read.bytes);
    if (mon.checkNow()) throw Object.assign(new Error(mon.reason()), { reason: 'memory-guard' });
    if (!got.ok) throw Object.assign(new Error(got.message || '本地解包失败'), { reason: got.reason, passthrough: got });
    return { ...got.res, provider: got.provider, src: 'local' };
  };

  // 前台装载：**命中就取产物；miss 就让服务端解（别自己再解一遍）**。
  //
  // 为什么改（原逻辑是"miss 就本地解包"）：
  //   服务端解包是原生能力、且预热本来就在解同一个包。前台在 miss 时自己再解一遍，
  //   结果就是同一个 19MB 包被解两次（前端 4.3s + 服务端 206ms），纯重复劳动。
  // 回落本地只在「服务端明确说不行」时发生：内存准入拒绝 / 不可解 / 文件不可读。
  //   **不按"等了几秒"判死** —— 超时只记日志并重试一次，不据此改走另一条路。
  let won = null;
  let serverSaidNo = '';

  // 第一个**成功**的结果；全部失败才抛（抛最先失败那条的错误，形状最接近单条路径）。
  //   为什么不用 Promise.race：race 以"第一个 settle"为准 —— 一条线失败就整体失败，
  //   而这里任一成功就算成功（另一条线失败只是"没抢到"，不是结论）。
  //   落败的那条不取消：它的产物由它自己的调用约定处理（本地线只返回、不注册 VFS），
  //   但必须挂上 catch，否则它稍后 reject 会变成 unhandledrejection。
  const firstWon = (ps) => new Promise((resolve, reject) => {
    let left = ps.length;
    let firstErr = null;
    const down = () => { left -= 1; if (left === 0) reject(firstErr || new Error('解包失败：两条通路都没有结果')); };
    for (const p of ps) {
      p.then((v) => { if (v) resolve(v); else down(); }, (e) => { if (!firstErr) firstErr = e; down(); });
    }
  });

  if (unpackOn && !file.bytes && file.rootId && file.rel) {
    // **双端解**：服务端命中查询与本地解包**同时开始**，谁先出结果用谁。
    //   设计口径：miss 时两端都解 —— 前端先解完就先显示（首屏不接受被后端拖住），
    //   后端那条线解完落盘做缓存，供下次点击直接命中（命中路径仍然最快）。
    //
    //   为什么不能串行（先 await 查服务端、miss 再本地解）：
    //     服务端是单进程 Node，它正在跑另一个解包时事件循环被占住，
    //     连"只读缓存索引"的 peek 都得排队 ⇒ 前端本地解包被推迟到后端忙完，
    //     表现为"日志里解包/预热都完成了、画布却不出画，再点一次（后端已落盘）才显示"。
    //     并行之后：服务端慢只影响"能不能省一次解包"，绝不影响首屏。
    //
    //   前台仍然**绝不请求服务端解包**（hitOnly）：解包由本地线或那两条预热线负责。
    const serverP = resolveFromServer(file, { mon }).catch((e) => {
      // 未命中（或查询失败）都交给本地线；查询失败已由 resolveFromServer 记进 diag
      serverSaidNo = (e && (e.reason || e.message)) || 'server-miss';
      return null;
    });
    const localP = localPath();
    try {
      won = await firstWon([serverP, localP]);
    } catch (e) {
      // 内存保护的判定是**结论**，不是"服务端失败"：绝不能回落服务端/本地把它绕过去
      if (e && e.reason === 'memory-guard') {
        return { ok: false, reason: e.reason, message: String((e && e.message) || e) };
      }
      // ── 最后一级兜底：让**服务端真解包**（hitOnly:false）再试一次 ──────────────
      // 为什么需要它：本地线只能跑 JS 插件，而有些包的纹理解码格式它不支持
      //   （实测：ASTC/50、PVRTC/49）⇒ 本地必然失败；但服务端可能还有别的运行时
      //   （exec/Python 插件，能力来自 UnityPy）能解。没有这一级，这类包在页面上永远打不开，
      //   而同一个包用 /api/unpack/resolve 却能解开 —— 那是"两条路两种答案"，不可接受。
      // 代价可控：只在**本地已失败**之后才走，不影响首屏（首屏竞速仍是 server-hit + local）。
      //
      // ⚠️ 这一级必须放在 `passthrough` 之前：本地解包失败时一定带 passthrough
      //   （见 localPath 里 `Object.assign(..., { passthrough: got })`），
      //   先处理它就会直接 return，兜底永远走不到（实测就是这个原因）。
      if (unpackOn && !file.bytes && file.rootId && file.rel) {
        say.warn(`本地解包失败，改请服务端解包：${file.rel}（${(e && e.message) || e}）`);
        emit('unpack.fallback', { rootId: file.rootId, rel: file.rel, localReason: (e && e.reason) || 'local-failed' });
        try {
          won = await resolveFromServer(file, { hitOnly: false, mon });
        } catch (e2) {
          // 兜底也失败：本地失败保持原有返回形状（那是上层认识的形状）
          if (e && e.passthrough) return e.passthrough;
          return {
            ok: false,
            reason: (e2 && e2.reason) || 'unpack-failed',
            message: `本地解包失败（${(e && e.message) || e}），服务端解包也失败（${(e2 && e2.message) || e2}）`,
          };
        }
      } else {
        if (e && e.passthrough) return e.passthrough; // 无可兜底时保持原有返回形状
        return { ok: false, reason: (e && e.reason) || 'unpack-failed', message: String((e && e.message) || e) };
      }
    }
    emit('unpack.race', {
      rootId: file.rootId, rel: file.rel,
      winner: won && won.src,          // server-hit | local-worker | local
      serverMiss: serverSaidNo || null,
    });
  } else {
    try {
      won = await localPath();
    } catch (e) {
      if (e && e.passthrough) return e.passthrough; // 本地失败保持原有返回形状
      // 内存保护的判定是**结论**，不是"服务端失败"：绝不能回落本地解包把它绕过去
      return { ok: false, reason: (e && e.reason) || 'unpack-failed', message: String((e && e.message) || e) };
    }
  }

  const reg = registerResolved(vfs, won);
  if (!reg.ok) return { ok: false, reason: 'register-failed', message: reg.message };

  const entryUrl = vfs.resolve(won.prefix + String(won.entry).replace(/^\.?\//, ''));
  // 三态日志口径：命中缓存 / 服务端解包 / 回落或本地解包
  // 三态 + 落败原因（验收"回落可用"就靠这条能被读到）
  // 三态（验收要求 source 能区分"重复劳动"是否发生）：
  //   解包命中缓存 = 服务端本来就有产物（最快，<500ms）
  //   服务端解包   = miss 后由服务端解出来（前台没自己再解一遍）
  //   回落前端解包 = 服务端明确不能解，才由前端解
  const source = won.src === 'server-hit' ? '解包命中缓存'
    : won.src === 'server-unpack' ? '服务端解包'
      : won.src === 'local-worker' ? '后台解包（Worker，主线程不阻塞）'
        : '回落前端解包';
  const detail = { rootId: file.rootId, rel: file.rel, source, files: filesCount(won.files), ms: Math.round(performance.now() - tMat), ...(serverSaidNo ? { miss: serverSaidNo } : {}) };
  say.info(`${source}：${file.rootId}/${file.rel}（${detail.files} 个文件，${detail.ms}ms）`);
  emit('unpack.source', detail);
  return {
    ok: true,
    provider: won.provider,
    prefix: won.prefix,
    entry: won.entry,
    entryUrl,
    files: filesCount(won.files),
    reRegistered: reg.reRegistered,
    source, // 供上层/诊断断言：解包命中缓存 | 服务端解包 | 回落前端解包
  };
  } finally {
    // 无论正常返回、抛错还是被内存监控中止，都要停采样（否则 requestAnimationFrame 会一直排下去）
    mon.stop();
  }
}
/** 已注册的提供者（可按 fileKinds 过滤，如 ['bundle']） */
function providersFor(fileKinds) {
  const list = [...providers.values()];
  if (!fileKinds || !fileKinds.length) return list;
  const want = new Set(fileKinds);
  return list.filter((p) => Array.isArray(p.fileKinds) && p.fileKinds.some((k) => want.has(k)));
}

/**
 * 找一个能处理该文件的提供者（走插件的 canHandle）。
 * file 形状按契约 §1.1：{ rootId, rel, name?, bytes?, profile? }；host 由这里注入（§3.6）。
 * canHandle 必须是同步布尔（§3.1）；插件内部抛错一律当"不认"，不冒泡。
 * @param {object} file
 * @returns {object|null} 命中的 provider
 */
function findProvider(file) {
  if (!file || typeof file !== 'object') return null;
  const probe = { ...file, host: hostApi };
  if (file.bytes !== undefined && file.bytes !== null) {
    const normalized = toUint8Array(file.bytes);
    if (normalized) probe.bytes = normalized;
    else say.warn(`findProvider 收到无法识别的 bytes 类型（${describeType(file.bytes)}）：`
      + '契约 §1.1 要求 Uint8Array；插件可能因此判不出容器（表现为"没有提供者"）');
  }
  for (const p of providers.values()) {
    // 只有声明了 asset-provider 角色的插件才参与"这个文件归谁解"（契约 §一/§二）。
    //   其它角色（renderer/editor/exporter/panel）不该在这里被问到。
    if (!Array.isArray(p.provides) || !p.provides.includes('asset-provider')) continue;
    if (typeof p.canHandle !== 'function') continue;
    let hit = false;
    try {
      hit = p.canHandle(probe) === true;
    } catch (e) {
      say.warn(`提供者 ${p.id} 的 canHandle 抛错（按不处理该文件处理）：${(e && e.message) || e}`);
      hit = false;
    }
    if (hit) return p;
  }
  return null;
}
  return { materialize, fetchFile, providersFor, findProvider, prefilterReason, pool: workerPool };
}
