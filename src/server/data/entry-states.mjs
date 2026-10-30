// server/data/entry-states.mjs —— 条目状态的**服务端权威存储**（契约《条目状态与展示归属》§三）
//
// 它只干三件事：
//   ① 记住"最近一次真实装载尝试"的结果（loadResult）
//   ② 判定这条记录是否还有效（三条失效规则）
//   ③ 由 ①+② 与调用方给的上下文，**算出** display / support / loadResult 三个字段（recompute）
//
// 刻意不做的事：不读资源包、不扫目录、不知道 catalog 长什么样。
//   ctx 是调用方喂进来的（provider 注册表、候选、缺件列表、依赖包结论…），
//   这样它可以被单测直接构造，也保证"展示三字段只由服务端产出"（INV-D1）不是靠约定。
//
// 键形态（契约 §三 裁定）：统一 `${rootId}/${rel}`
//   目录型 rel = srcDir + 文件名；容器型 rel = 包相对路径。
//   不用条目 id：容器 id 是把 rel 的 / 换成 _ 派生的、不可逆、可能撞键。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeReason, reasonText, REASONS } from '../../shared/entry-reasons.mjs';

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_MAX_KEYS = 5000;

/**
 * 哪些失败原因属于"确定性判定"，可以直接升格成 support=unsupported。
 *
 * 判据：这个原因说明**资源本身**就是这样（换台机器、换个时刻照样失败）；
 *   而 insufficient-memory / bad-args / not-found / unpack-failed 是环境或请求问题，
 *   标成 unsupported 会让用户以为模型坏了（下次环境好了它其实能装）。
 */
const DEFINITE_UNSUPPORTED_REASONS = new Set([
  REASONS.ASSET_DEPENDENCY,        // 美术依赖包：包内就没有骨架，永远装不动
  REASONS.MISSING_TEXTURES,        // 贴图缺件：文件不在就是不在
  REASONS.TEX_FORMAT_UNSUPPORTED,  // 不支持的纹理格式：能力缺口
  REASONS.NOT_UNITYFS,             // 不是 UnityFS：格式不对
  REASONS.NO_CAB,                  // 没有资产节点：不是资产包
]);

/** 把 provider 列表压成失效指纹串（① 用）：按 id 排序 ⇒ 顺序无关、可比对 */
/**
 * @param {Array<{id: string, version?: unknown}>} providers
 * @returns {string} 形如 'builtin-live2d@1|unity-spine-bundle@4.0.1'
 */
export function providerFingerprintOf(providers) {
  return (Array.isArray(providers) ? providers : [])
    .filter((p) => p && p.id)
    .map((p) => `${p.id}@${p.version === undefined || p.version === null ? '?' : String(p.version)}`)
    .sort()
    .join('|');
}

/**
 * 建一个条目状态存储。
 * @param {{file: string, log?: Function, now?: () => number, debounceMs?: number, maxKeys?: number}} opts
 */
export function createEntryStates(opts = {}) {
  const file = String(opts.file || '');
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const debounceMs = Number.isFinite(opts.debounceMs) ? Number(opts.debounceMs) : DEFAULT_DEBOUNCE_MS;
  const maxKeys = Number.isFinite(opts.maxKeys) ? Number(opts.maxKeys) : DEFAULT_MAX_KEYS;

  /** @type {Map<string, any>} key → { key, loadResult, fingerprints, updatedAt } */
  const table = new Map();
  let loaded = false;
  let dirty = false;
  let timer = null;
  let writing = null;
  let lastFlushAt = null;

  /** ③ 服务端重启：从 json 读回；读不回 = 空表（可接受，重测即得） */
  function load() {
    if (loaded) return;
    loaded = true;
    if (!file) return;
    try {
      if (!fs.existsSync(file)) return;
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      const entries = (data && data.entries) || {};
      for (const [key, record] of Object.entries(entries)) {
        if (record && typeof record === 'object') table.set(key, { key, ...record });
      }
      log('info', 'entry-states 已读回', { keys: table.size });
    } catch (e) {
      // 坏文件不当致命：整表按空处理（契约 §三 规则③）
      log('warn', `entry-states 读取失败，按空表处理：${e.message}`, { file });
      table.clear();
    }
  }

  function markDirty() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, debounceMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /** 落盘：合并去抖（CIFS 上禁止一请求一写） */
  async function flush(force = false) {
    if (!file) return false;
    // 上一轮还在写盘：**必须先等它结束再判 dirty**。
    //   早前写成 `if (writing) return writing;` 且放在 `dirty = false` 之后 —— 于是
    //   第二轮请求直接拿到上一轮的 promise 返回，而脏标记已被清掉 ⇒ 新写入的记录
    //   永远不会落盘（实测：连续两次 put，文件里只有第一条）。
    if (writing) {
      try { await writing; } catch { /* 上一轮自己会记日志 */ }
    }
    if (!dirty && !force) return false;
    dirty = false;
    const snapshot = {};
    for (const [key, record] of table) snapshot[key] = record;
    const payload = JSON.stringify({ version: 1, savedAt: now(), entries: snapshot });
    writing = (async () => {
      try {
        // mkdirSync({recursive:true}) 本身幂等：不需要先 existsSync 探一次（那是白多一次 stat，
        //   而且探完到写之间目录仍可能被删，探测并不能保证什么）。
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, payload, 'utf8');
        fs.renameSync(tmp, file);      // 原子替换：写一半崩掉不会留半张表
        lastFlushAt = now();
        return true;
      } catch (e) {
        dirty = true;                   // 写失败 ⇒ 保持脏，下次再试（不丢数据）
        log('warn', `entry-states 写盘失败：${e.message}`, { file });
        return false;
      } finally {
        writing = null;
      }
    })();
    return writing;
  }

  /** 超限淘汰：按 updatedAt 最旧先丢（运行数据，丢了只是"回到未试过"） */
  function evictIfNeeded() {
    if (table.size <= maxKeys) return;
    const list = [...table.values()].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    const drop = table.size - maxKeys;
    for (let i = 0; i < drop; i += 1) table.delete(list[i].key);
    log('info', 'entry-states 超限淘汰', { dropped: drop, maxKeys });
  }

  /**
   * 三条失效规则 + 一致性约束的核心：由「已存记录 + 当前上下文」算出三字段。
   *
   * @param {any|null} state 已存记录（可为 null = 没试过）
   * @param {{providers?: Array, candidates?: string[], missingTextures?: string[],
   *          assetDependency?: {reason?: string, message?: string}|null,
   *          providerFingerprint?: string, assetFingerprint?: string|null}} ctx
   * @returns {{display: {accent: string|null, provider: string|null, candidates: string[]},
   *           support: {state: 'ready'|'unknown'|'unsupported', detail: {reason: string, message: string}|null},
   *           loadResult: {result: 'ok'|'failed', reason: string|null, message: string|null,
   *                        provider: string|null, at: number, source: 'server'|'client'}|null}}
   */
  function recompute(state, ctx = {}) {
    const providers = Array.isArray(ctx.providers) ? ctx.providers : [];
    const accentOf = (id) => {
      const p = providers.find((x) => x && x.id === id);
      return p && p.accent ? String(p.accent) : null;
    };
    const candidates = Array.isArray(ctx.candidates) ? ctx.candidates.slice() : [];

    // ── 规则①：插件集合指纹不符 ⇒ 整条记录作废（"不支持"结论不再可信）
    let live = state || null;
    const fp = ctx.providerFingerprint === undefined ? null : String(ctx.providerFingerprint);
    if (live && fp !== null) {
      const stored = live.fingerprints && live.fingerprints.provider;
      if (stored && stored !== fp) live = null;
    }
    // ── 规则②：条目 size/mtime 变化 ⇒ 该条失效
    const assetFp = ctx.assetFingerprint === undefined ? null : ctx.assetFingerprint;
    if (live && assetFp !== null) {
      const stored = live.fingerprints && live.fingerprints.asset;
      if (stored && stored !== assetFp) live = null;
    }

    let loadResult = live && live.loadResult ? { ...live.loadResult } : null;
    if (loadResult) {
      loadResult.reason = loadResult.reason === null ? null : normalizeReason(loadResult.reason);
      if (!loadResult.message && loadResult.reason) loadResult.message = reasonText(loadResult.reason);
    }

    // ── 一致性约束：ok 的 loadResult 决定归属与颜色（INV-D2：写入路径保证，不在读取时拼装）
    let provider = null;
    let accent = null;
    if (loadResult && loadResult.result === 'ok' && loadResult.provider) {
      provider = loadResult.provider;
      accent = accentOf(provider);   // 该插件没声明色 ⇒ null（中性色），不猜
    }

    // ── support：先由上下文判，再被 loadResult.ok 覆盖（契约：两者不能并存）
    let support = { state: 'unknown', detail: null };
    const missing = Array.isArray(ctx.missingTextures) ? ctx.missingTextures.filter(Boolean) : [];
    if (missing.length) {
      support = {
        state: 'unsupported',
        detail: {
          reason: REASONS.MISSING_TEXTURES,
          message: `缺少贴图：${missing.slice(0, 3).join('、')}${missing.length > 3 ? ` 等 ${missing.length} 个` : ''}`,
        },
      };
    } else if (ctx.assetDependency && ctx.assetDependency.reason) {
      // 容器型形态探测（美术依赖包）：理由与文案由调用方给（与装载失败时同源）
      support = {
        state: 'unsupported',
        detail: {
          reason: normalizeReason(ctx.assetDependency.reason),
          message: String(ctx.assetDependency.message || reasonText(ctx.assetDependency.reason)),
        },
      };
    } else if (Array.isArray(ctx.missingTextures) && ctx.missingTextures.length === 0) {
      // 目录型且明确"没有缺件" ⇒ ready（契约：原 missingTextures 为空即 ready）
      //   判据用"传了数组且为空"，而不是"缺件数 0"：没传这个字段表示"调用方没做资产检查"，
      //   那种情况下必须是 unknown —— 把"没检查"当成"检查通过"是最容易骗人的假 ready。
      support = { state: 'ready', detail: null };
    }

    // 契约：support=unsupported 与 loadResult.ok 不能并存（后者说明"其实装得动"）
    if (loadResult && loadResult.result === 'ok') support = { state: 'ready', detail: null };

    // 未定归属恒为 null（INV-D4）：绝不按候选顺序猜色
    if (!provider) { accent = null; }

    // 失败记录本身就是一条**判定依据**：解包时已经用包内形态判出"这是美术依赖包"，
    //   那么下次列表不必再解析包体（契约 S4 裁定：同步路径禁止解析包体）。
    //   注意只对"确定性判定"生效：环境类失败（内存不足、路径消失）不该让条目永久标 unsupported。
    if (loadResult && loadResult.result === 'failed') {
      const definite = DEFINITE_UNSUPPORTED_REASONS.has(loadResult.reason);
      if (definite && support.state !== 'unsupported') {
        support = {
          state: 'unsupported',
          detail: { reason: loadResult.reason, message: loadResult.message || reasonText(loadResult.reason) },
        };
      }
    }

    return {
      display: { accent, provider, candidates },
      support,
      loadResult,
    };
  }

  /**
   * 写入一次装载结果（定序：at 更晚者胜；不晚于已存 ⇒ 不覆盖）。
   * @param {string} key `${rootId}/${rel}`
   * @param {{result: 'ok'|'failed', reason?: string|null, message?: string|null,
   *          provider?: string|null, at?: number, source?: 'server'|'client'}} incoming
   * @param {object} ctx 同 recompute
   * @returns {{applied: boolean, state: any, computed: object}}
   */
  function put(key, incoming, ctx = {}) {
    load();
    const k = String(key || '');
    if (!k) return { applied: false, state: null, computed: recompute(null, ctx) };

    const at = Number.isFinite(incoming && incoming.at) ? Number(incoming.at) : now();
    const source = incoming && incoming.source === 'server' ? 'server' : 'client';
    const prev = table.get(k) || null;

    // 定序：incoming 不晚于已存 ⇒ 不覆盖，返回当前状态
    if (prev && prev.loadResult && Number(prev.loadResult.at) >= at) {
      return { applied: false, state: prev, computed: recompute(prev, ctx) };
    }

    const result = incoming && incoming.result === 'ok' ? 'ok' : 'failed';
    const reason = result === 'ok' ? null : normalizeReason(incoming && incoming.reason);
    const message = incoming && incoming.message
      ? String(incoming.message)
      : (result === 'ok' ? null : reasonText(reason));
    // ok 但没 provider ⇒ 归属无法确定，按 failed 记（否则会违反"ok ⇒ display.provider 必须有值"）
    let finalResult = result;
    let finalProvider = incoming && incoming.provider ? String(incoming.provider) : null;
    let finalReason = reason;
    let finalMessage = message;
    if (result === 'ok' && !finalProvider) {
      finalResult = 'failed';
      finalReason = REASONS.UNKNOWN;
      finalMessage = '装载成功但未报出提供者，无法确定归属';
    }

    const next = {
      key: k,
      loadResult: {
        result: finalResult,
        reason: finalResult === 'ok' ? null : finalReason,
        message: finalMessage,
        // 契约 §二：provider 是"实际解出/装载它的提供者"，只在成功时有意义。
        //   失败时一律 null —— 否则前端可能拿它去涂色，把"没装成"的条目染成某个插件的颜色。
        provider: finalResult === 'ok' ? finalProvider : null,
        at,
        source,
      },
      fingerprints: {
        provider: ctx.providerFingerprint === undefined ? null : ctx.providerFingerprint,
        asset: ctx.assetFingerprint === undefined ? null : ctx.assetFingerprint,
      },
      updatedAt: at,
    };
    table.set(k, next);
    evictIfNeeded();
    markDirty();
    return { applied: true, state: next, computed: recompute(next, ctx) };
  }

  function get(key) {
    load();
    return table.get(String(key || '')) || null;
  }

  function stats() {
    return { keys: table.size, dirty, lastFlushAt };
  }

  return { load, get, put, recompute, flush, stats };
}

// ============================================================================
// 共享实例（同一进程内**必须只有一个**）
//
// 为什么必须单例：这个存储会被两条路写（服务端 resolve 与前端上报路由）。
//   如果各自 createEntryStates 一个实例，两个实例各持一份内存表、各自 flush，
//   后写的整表覆盖先写的 ⇒ 记录随机丢失。所以统一从这里取。
//
// 路径与 core/paths.mjs 的 dataDir 同口径：<MODELSTAGE_DATA_ROOT || 项目根>/data/entry-states.json
//   —— 测试实例（MODELSTAGE_DATA_ROOT=runtime/test-instance）自然写到它自己的数据根下，
//   不会污染主实例的 data/。
// ============================================================================

/** 项目根（本文件在 src/server/data/ ⇒ 三层） */
// 用 fileURLToPath 而不是 new URL().pathname：后者**不做百分号解码**，
//   项目根含中文目录（工作区）时会变成 %E5%B7%A5… ⇒ 写出一个谁都不认识的路径。
const ENTRY_STATES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * 按与 core/paths.mjs 相同的规则算 entry-states.json 的绝对路径。
 * @param {string} [root] 项目根
 * @returns {string}
 */
export function resolveEntryStatesPath(root = ENTRY_STATES_ROOT) {
  const dataRoot = (process.env.MODELSTAGE_DATA_ROOT || '').trim();
  const data = dataRoot ? path.resolve(dataRoot) : root;
  return path.join(data, 'data', 'entry-states.json');
}

let shared = null;

/**
 * 取（或首次创建）进程内共享的 entry-states 实例。
 * @param {{root?: string, log?: Function}} [opts]
 * @returns {ReturnType<typeof createEntryStates>}
 */
export function getSharedEntryStates(opts = {}) {
  if (shared) return shared;
  const file = resolveEntryStatesPath(opts.root || ENTRY_STATES_ROOT);
  shared = createEntryStates({ file, log: opts.log });
  shared.load();
  return shared;
}

/** 单测/测试实例用：丢掉共享实例（不写盘） */
export function resetSharedEntryStates() {
  shared = null;
}
