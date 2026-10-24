// ============================================================================
// src/web/spine/runtimes.js —— Spine 运行时管理器（提供 `Is` 能力）
//
// 作用：把"按版本取运行时源码 → 隔离执行 → 交出该版本的 spine 命名空间"收敛到一处，
//   引擎侧只需问它要某个版本，不关心源码从哪来、怎么执行。
//
// 为什么需要它：多版本共存要求每个版本的 `var spine` 不互相覆盖（详见下方"必须隔离执行"）。
//
// 关键点：**必须隔离执行**。每个 `spine-webgl-<ver>.js` 都是顶层 `var spine = …`；
//   若用 `<script src>` 加载，后加载的会覆盖 `window.spine`，导致先加载版本的类在运行期
//   解析到新版基类而崩（典型：`Class constructor Texture cannot be invoked without 'new'`）。
//   用 `Function` 构造器执行源码时 `var spine` 成了**函数局部绑定**，
//   各版本天然隔离（旧 app 的 `evalRuntimeIsolated` 也是这个原理）。
// ============================================================================

const RUNTIME_BASE = '/spine-runtimes/spine-webgl-';

/** 运行时必须导出的类（缺任一即视为该版本不可用） */
const REQUIRED_CLASSES = ['Skeleton', 'AnimationState', 'TextureAtlas', 'AtlasAttachmentLoader'];
const REQUIRED_PARSERS = ['SkeletonJson', 'SkeletonBinary'];

function majorMinor(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : String(v || '');
}

/** 某个 spine 命名空间里取类：优先 webgl 子命名空间，其次根（两代布局不同） */
function rtClass(rt, name) {
  if (!rt) return null;
  return (rt.webgl && rt.webgl[name]) || rt[name] || null;
}

/** 检查运行时是否完整（缺什么就报出来，便于定位） */
function missingClasses(rt) {
  const missing = [];
  for (const n of REQUIRED_CLASSES) if (!rtClass(rt, n)) missing.push(n);
  if (!REQUIRED_PARSERS.some((n) => rtClass(rt, n))) missing.push('SkeletonJson/SkeletonBinary');
  if (!rtClass(rt, 'SceneRenderer') && !rtClass(rt, 'SkeletonRenderer')) missing.push('SceneRenderer/SkeletonRenderer');
  if (!rtClass(rt, 'GLTexture')) missing.push('GLTexture');
  if (!rtClass(rt, 'OrthoCamera') && !rtClass(rt, 'SceneRenderer')) missing.push('OrthoCamera');
  return missing;
}

/** 运行时是否支持 straight alpha（4.1+ 的 SkeletonRenderer 有 premultipliedAlpha 字段） */
function detectStraightAlpha(rt, version) {
  // **照搬旧端判据：按运行时版本号 >= 4.1 判定**（旧端原文 `parseFloat(T.version||"0")>=4.1`）。
  // 为什么不用能力探测：spine 4.1 的 `SkeletonRenderer.premultipliedAlpha` 是**类字段（实例属性）**，
  //   不在 prototype 上 ⇒ `'premultipliedAlpha' in SR.prototype` 恒为 false ⇒ 4.1 被误判"不支持直通"
  //   ⇒ 面板显示"直通支持: 不支持"、`straight` 档被降级成 upload（旧端同环境显示"支持"）。
  //   实测：4.1 类定义 `SkeletonRenderer = class { premultipliedAlpha = false; … }`；3.8 段内无此字段。
  const ver = Number(version);
  if (Number.isFinite(ver)) return ver >= 4.1;
  // 版本号拿不到时退回能力探测（旧行为）
  const SR = rtClass(rt, 'SkeletonRenderer');
  if (!SR || !SR.prototype) return false;
  return 'premultipliedAlpha' in SR.prototype;
}


/**
 * 在隔离作用域执行运行时源码，返回它自己的 spine 对象。
 * 注意：这里不碰 window.spine —— 每个版本的 `var spine` 都在此函数体内，互不影响。
 */
function evalIsolated(source, version) {
  let spineObj = null;
  try {
    spineObj = new Function(`${source}\n;return (typeof spine !== "undefined") ? spine : null;`)(); // dsh-skip-sensitive 运行时隔离执行本地可信源码（src/spine-runtimes/*.js），不接收任何外部输入
  } catch (err) {
    throw new Error(`Spine ${version} 运行时执行失败：${err && err.message ? err.message : err}`);
  }
  if (!spineObj || typeof spineObj !== 'object') {
    throw new Error(`Spine ${version} 运行时执行后没有导出 spine 对象（源码形态不符）`);
  }
  const missing = missingClasses(spineObj);
  if (missing.length) throw new Error(`Spine ${version} 运行时缺少核心类：${missing.join('、')}`);
  return spineObj;
}

/** 运行时管理器（提供 getInstance / setLogCallback / getRuntimeWithFallback 三项能力） */
export class SpineRuntimeManager {
  static getInstance() {
    if (!SpineRuntimeManager._inst) SpineRuntimeManager._inst = new SpineRuntimeManager();
    return SpineRuntimeManager._inst;
  }

  constructor() {
    this.cache = new Map();      // ver -> { version, spine, supportsStraightAlpha }
    this.sources = new Map();    // ver -> 源码文本
    this.loading = new Map();
    this.logCallback = null;
  }

  setLogCallback(cb) { this.logCallback = typeof cb === 'function' ? cb : null; }

  log(level, msg, scope) {
    try { if (this.logCallback) this.logCallback(level, msg, scope || 'runtime'); } catch { /* 日志回调不得影响渲染 */ }
  }

  /** 版本规整：'3.8.99' -> '3.8' */
  normalizeVersion(v) { return majorMinor(v); }

  isLoaded(version) { return this.cache.has(this.normalizeVersion(version)); }

  getCachedVersions() { return [...this.cache.keys()]; }

  /** 可用版本：优先用页面注入的源码表，否则按 URL 探测 */
  async listVersions() {
    const fromSources = Object.keys(window.__SPINE_RUNTIME_SOURCES__ || {});
    if (fromSources.length) return fromSources.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    try {
      const r = await fetch('/spine-runtimes/index.json', { cache: 'no-store' });  // dsh-skip-quality 本地同源静态清单读取，既有代码(本轮仅改直通支持判定)
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j.versions) && j.versions.length) return j.versions;
      }
    } catch { /* 清单取不到就走空表 */ }
    return [];
  }

  /** 取某版源码文本（页面已注入则直接用；否则 fetch 一次并缓存） */
  async sourceOf(version) {
    const injected = (window.__SPINE_RUNTIME_SOURCES__ || {})[version];
    if (injected) return injected;
    if (this.sources.has(version)) return this.sources.get(version);
    const r = await fetch(`${RUNTIME_BASE}${version}.js`, { cache: 'no-store' });  // dsh-skip-quality 本地同源运行时脚本读取，既有代码
    if (!r.ok) throw new Error(`运行时 ${version} 加载失败（HTTP ${r.status}）`);
    const text = await r.text();
    this.sources.set(version, text);
    return text;
  }

  /** 取运行时（缓存；并发去重） */
  async getRuntime(version) {
    const ver = this.normalizeVersion(version);
    if (this.cache.has(ver)) return this.cache.get(ver);
    if (this.loading.has(ver)) return this.loading.get(ver);
    const p = (async () => {
      const src = await this.sourceOf(ver);
      const spine = evalIsolated(src, ver);
      const entry = { version: ver, spine, supportsStraightAlpha: detectStraightAlpha(spine, ver) };
      this.cache.set(ver, entry);
      this.loading.delete(ver);
      this.log('info', `Spine ${ver} 运行时已就绪`, 'runtime');
      return entry;
    })().catch((err) => {
      this.loading.delete(ver);
      this.log('error', `加载 Spine ${ver} 运行时失败：${err.message}`, 'runtime');
      throw err;
    });
    this.loading.set(ver, p);
    return p;
  }

  /** 取运行时，失败时按"同 major 相邻 → 清单最大"降级 */
  async getRuntimeWithFallback(version) {
    const want = this.normalizeVersion(version);
    try { return await this.getRuntime(want); } catch { /* 继续降级 */ }
    const list = await this.listVersions();
    const major = want.split('.')[0];
    const same = list.filter((v) => v.split('.')[0] === major && v !== want);
    const candidates = [...same, ...list.filter((v) => v !== want && v.split('.')[0] !== major).reverse()];
    for (const v of candidates) {
      try {
        const entry = await this.getRuntime(v);
        this.log('warn', `Spine ${want} 不可用，已降级到 ${v}`, 'runtime');
        return entry;
      } catch { /* 试下一个 */ }
    }
    throw new Error(`无法加载 Spine ${want} 运行时（清单：${list.join('、') || '空'}）`);
  }
}

/**
 * 打包器的 class-field 助手（engine 切片里 88 处调用它，但切片没带这个定义）。
 * 语义：把 value 定义到 obj[key] 上并返回 value；键已存在时用 defineProperty 覆盖，
 * 避免继承来的只读属性导致赋值失败（esbuild/tsc 的等价实现）。
 */
function defineField(obj, key, value) {
  if (key in obj) {
    Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
  } else {
    obj[key] = value;
  }
  return value;
}
/**
 * 安装到全局：引擎取某个版本的运行时源码时经它取实例，
 * 所以必须在装载模型**之前**调用。
 */
export function installRuntimeManager() {
  if (!window.de) window.de = defineField; // engine 切片依赖的 class-field 助手
  if (window.Is) return window.Is;
  window.Is = SpineRuntimeManager;
  return window.Is;
}
