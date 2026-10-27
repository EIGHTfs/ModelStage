// spine/canvas-runtime.js —— 运行时源码的获取与版本选择
//
// 职责：向服务端要运行时清单、按语义化版本挑一个、把源码文本缓存起来喂给引擎。
// 为什么单独成模块：这段是唯一做网络请求与版本比较的地方，与舞台装配无关，
//   混在 canvas.js 里时最长的那几个 try/catch 都在这里，出错排查面很窄。

import { SpineEngine as NextEngine } from '../engine/index.js';
// 清单读取走统一 HTTP 层（重试 + 统一超时/错误归类）
import { getJson } from '../infra/api.js';
// 缺运行时时的可读提示（含服务端给的落地目录绝对路径与可复制命令）
import { loadRuntimeHint, spineMissingHint } from './runtime-hint.js';

const RUNTIME_BASE = '/spine-runtimes/spine-webgl-';

const RUNTIME_MANIFEST = '/spine-runtimes/index.json';

const runtimeSourceCache = new Map(); // ver -> 源码文本

let manifestPromise = null;

let availableCache = null;

/** '3.8.99' -> '3.8' */
function majorMinor(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : String(v || '');
}

/** 运行时目录清单（dev-server 扫目录生成；客户端不写死版本列表） */
function fetchManifest() {
  if (manifestPromise) return manifestPromise;
  // 幂等 GET 的小 JSON ⇒ 走统一层（重试 + 统一超时/错误归类）。no-store 保留：新版本要立刻可见。
  const p = getJson(RUNTIME_MANIFEST, { cache: 'no-store' })
    .then((j) => (j && Array.isArray(j.versions) ? j.versions : []))
    .catch(() => []);
  manifestPromise = p;
  p.then((list) => {
    // 空结果多为"服务刚起/网络抖动"，缓存它会让后续加载永久拿不到版本 ⇒ 清掉待下次重试
    if (!list.length && manifestPromise === p) manifestPromise = null;
  });
  return p;
}

/** 本机可用版本：直接采用 dev-server 扫目录生成的清单（不再逐版发 HEAD 探测，
 *  避免并发探测请求在切换/卸载时被中断成 ERR_ABORTED）。 */
export async function availableVersions() {
  if (availableCache && availableCache.length) return availableCache;
  let list = await fetchManifest();
  // 服务刚起/抖动时清单可能一时为空：同一次加载内立即重试一次，避免把"瞬时失败"变成"这次一定失败"
  if (!list.length) {
    await new Promise((r) => setTimeout(r, 150));
    list = await fetchManifest();
  }
  if (list.length) availableCache = list; // 只缓存非空结果
  return list;
}

/**
 * 本次装载的**运行时覆盖值**（来自 URL 的 ?runtime=）。
 *
 * 语义严格限定为"只生效一次"：
 *   · 不落 localStorage / uiState —— 绝不记忆。自动选版本是**正确性保证**
 *     （骨架 4.1.20 只能用 4.1 运行时），一旦记住人工覆盖，
 *     下次打开不兼容的模型会莫名失败，且用户看不出是自己上次设的。
 *   · 由 canvas-engine 在选版时 takeForcedRuntime() 取走并**立刻清空**，
 *     所以"带参数装载成功后去掉参数刷新 ⇒ 回到自动"天然成立。
 * @type {string|null}
 */
let forcedRuntime = null;

/** 设置一次性覆盖值（传 null/'' 表示清除） */
export function setForcedRuntime(version) {
  forcedRuntime = version ? String(version) : null;
}

/** 取走覆盖值（取一次即清空，天然只生效一次） */
export function takeForcedRuntime() {
  const v = forcedRuntime;
  forcedRuntime = null;
  return v;
}

/** 精确命中优先，否则同 major 的最大 minor，最后退清单里最大的 */
export function pickRuntimeVersion(version, available) {
  const want = majorMinor(version);
  if (!available.length) return want || null; // 清单不可用：有版本用版本，没版本交给调用方报错
  if (!want) return available[available.length - 1]; // 模型缺版本号：用清单里最新的一档
  if (available.includes(want)) return want;
  const major = want.split('.')[0];
  const same = available.filter((v) => v.split('.')[0] === major);
  if (same.length) return same[same.length - 1];
  return available[available.length - 1];
}

/** 取运行时源码文本并塞进 engine 的懒加载钩子（隔离执行由 engine 负责） */
export async function ensureRuntimeSource(ver) {
  window.__SPINE_SINGLE_FILE__ = true;
  window.__SPINE_RUNTIME_SOURCES__ = window.__SPINE_RUNTIME_SOURCES__ || {};
  if (window.__SPINE_RUNTIME_SOURCES__[ver]) return;
  let text = runtimeSourceCache.get(ver);
  if (!text) {
    const r = await fetch(`${RUNTIME_BASE}${ver}.js`, { cache: 'no-store' });
    if (!r.ok) {
      // 404 最常见的原因是"这台机器上没放这个版本" ⇒ 附上服务端给的可复制补齐方案，
      //   否则用户只看到一句 HTTP 404，不知道要下什么、放哪里（这条日志会进调试面板）。
      const hint = await loadRuntimeHint();
      throw new Error(spineMissingHint(ver, hint, r.status));
    }
    text = await r.text();
    runtimeSourceCache.set(ver, text);
  }
  window.__SPINE_RUNTIME_SOURCES__[ver] = text;
}

/** 取引擎构造器：只有新引擎（可读实现）。旧脚本注入路径已随引擎重写收尾删除。 */
export async function pickEngineCtor() {
  return NextEngine;
}
