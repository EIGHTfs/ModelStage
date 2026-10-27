// live2d/runtime-adapter.js —— Live2D 运行时的**唯一入口**
//
// 为什么要有这一层：运行时库换过世代，API 名字与调用形状都变过（settings 类名、
//   Application 的 init 时机等）。如果让业务代码各自判断，加一个版本就要改多处，必漏。
//   这里把"版本差异"收成一张兼容表 + 几个中性函数，业务侧只说"要什么"，不认具体类名。
//
// **允许出现旧类名字样的唯一位置**（grep 门禁）：PIXI.live2d.* / Cubism4ModelSettings 等
//   只在本文件里出现，其它业务文件一律走这里的函数。

// 缺库提示（把服务端给的完整指引拼进错误消息）；与 spine 侧共用同一个组装模块
import { live2dMissingHint } from '../spine/runtime-hint.js';

/** 运行时库（顺序不可颠倒：cubismcore 必须最先，pixi-live2d-display 初始化会检查它） */
export const RUNTIME_LIBS = [
  '/live2d-lib/live2dcubismcore.min.js',
  '/live2d-lib/live2d.min.js',
  '/live2d-lib/pixi.min.js',
  '/live2d-lib/index.min.js',
];

/**
 * 版本差异矩阵 —— **唯一真相**（代码与文档共用）。
 * 一行 = 一个世代；加新版本只需加一行，业务代码零改动。
 *
 *   settings[].  同一能力的候选类名，按"该世代的新名 → 兼容旧名"顺序尝试
 *   appInit      构造 PIXI.Application 的策略：
 *                  'ctor'  = new Application(opts)（6.x 同步构造）
 *                  'async' = new Application() + await app.init(opts)（8.x）
 *                  'auto'  = 运行时探测 prototype.init（未登记世代的兜底）
 *   filter/model 两代的 Filter 构造与 Live2DModel.from 签名一致，这里没有分叉
 */
const VERSION_MATRIX = {
  6: {
    label: 'v6',
    appInit: 'ctor',
    settings: {
      cubism4: ['Cubism4ModelSettings', 'CubismModelSettings'],
      cubism2: ['Cubism2ModelSettings', 'CubismLegacyModelSettings'],
    },
  },
  8: {
    label: 'v8',
    appInit: 'async',
    settings: {
      cubism4: ['CubismModelSettings', 'Cubism4ModelSettings'],
      cubism2: ['CubismLegacyModelSettings', 'Cubism2ModelSettings'],
    },
  },
};

/** 未登记世代的兜底：候选名取并集、appInit 走能力探测（新版本不会立刻挂） */
const FALLBACK_PROFILE = {
  label: 'unknown',
  appInit: 'auto',
  settings: {
    cubism4: ['CubismModelSettings', 'Cubism4ModelSettings'],
    cubism2: ['CubismLegacyModelSettings', 'Cubism2ModelSettings'],
  },
};

/** 按运行时实际 PIXI 主版本取矩阵行（取不到就用兜底） */
function profile() {
  const PIXI = pixiLib();
  const major = PIXI && PIXI.VERSION ? Number(String(PIXI.VERSION).split('.')[0]) : NaN;
  return VERSION_MATRIX[major] || FALLBACK_PROFILE;
}

/** 当前世代的标签（runtimeInfo / 排障用） */
export function runtimeFamily() {
  return profile().label;
}

/** loadRuntime 的单例 Promise：并发调用共用同一次加载 */
let loadingPromise = null;

function pixiLib() {
  return (typeof window !== 'undefined' && window.PIXI) ? window.PIXI : null;
}

/**
 * <script> 加载失败时浏览器只给通用 error —— **读不到响应体**。
 * 而服务端在 404/503 时已经把完整指引（官网 URL、目标目录、"不代下"的原因）写在 JSON error 里，
 * 不取回来那句提示就白给了。所以补一次 fetch 只为接上那段文本（不是重试，不改变加载行为）。
 * @param {string} url
 * @returns {Promise<string>} 服务端 error 文本；取不到返回空串
 */
async function readServerError(url) {
  try {
    // 5s：这一步是在 <script> **已失败**之后补读一次响应体，结果会被 await 进 reject 之前，
    //   所以它自己绝不能挂住 —— 否则"加载失败"永远不 reject，Live2D 激活会一直悬着。
    //   5s 依据：服务端这条是纯本地 JSON（服务端已实测毫秒级返回），5s 只作兜底。
    const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const text = await r.text();
    try {
      const j = JSON.parse(text);
      return (j && j.error) || '';
    } catch {
      return '';
    }
  } catch {
    return '';
  }
}

/** 注入一个 <script>；失败要摘掉标签，否则重试时页面上留着坏标签 */
function injectScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve(src);
    el.onerror = () => {
      el.remove();
      // 把服务端的完整指引拼进错误消息 ⇒ 上层 stageLog 原样打进调试日志窗口
      readServerError(src).then((detail) => {
        reject(new Error(live2dMissingHint(src, detail)));
      });
    };
    document.head.appendChild(el);
  });
}

/**
 * 注入全部运行时脚本（幂等）。
 * 失败**不缓存**：一次瞬时失败（服务重启、网络抖动）若留着 rejected promise，
 *   Live2D 就永久激活不了，只能刷新页面。
 * @param {(msg:string, level?:string)=>void} [note]
 * @returns {Promise<void>}
 */
export async function loadRuntime(note = () => {}) {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    for (const src of RUNTIME_LIBS) {
      await injectScript(src);
      note(`运行时已加载：${src.split('/').pop()}`);
    }
    const PIXI = pixiLib();
    if (!PIXI || !PIXI.live2d) {
      throw new Error('PIXI.live2d 不存在：运行时库顺序或版本不匹配（live2dcubismcore 必须最先）');
    }
    note(`Live2D 运行时就绪（PIXI ${PIXI.VERSION || 'unknown'}）`);
  })().catch((err) => {
    loadingPromise = null;   // 失败不缓存
    throw err;
  });
  return loadingPromise;
}

/** 运行时是否已就绪（同步判断，不触发加载） */
export function isReady() {
  const PIXI = pixiLib();
  return !!(PIXI && PIXI.live2d);
}

/** 等运行时就绪（没加载过就先加载） */
export async function waitReady(note) {
  if (isReady()) return;
  await loadRuntime(note);
}

/**
 * 实际版本与解析结果（排障/验收用）。
 * 抓不到的写 unknown —— 版本写错比 unknown 危险。
 * @returns {{pixi:string, display:string, cubism2:string, settingsCtorName:string|null}}
 */
export function runtimeInfo() {
  const PIXI = pixiLib();
  const lib = PIXI && PIXI.live2d ? PIXI.live2d : null;
  const prof = profile();
  const ctorName = lib ? (prof.settings.cubism4.find((n) => typeof lib[n] === 'function')
    || prof.settings.cubism2.find((n) => typeof lib[n] === 'function')
    || null) : null;
  // cubism core 的版本只能运行时问
  let cubismCore = 'unknown';
  try {
    const ver = window.Live2DCubismCore && window.Live2DCubismCore.Version
      && typeof window.Live2DCubismCore.Version.csmGetVersion === 'function'
      ? window.Live2DCubismCore.Version.csmGetVersion() : null;
    if (ver) cubismCore = String(ver);
  } catch { /* 取不到就 unknown */ }
  return {
    pixi: (PIXI && PIXI.VERSION) || 'unknown',
    display: 'unknown',      // index.min.js 是 UMD 包装，无版本字符串（VERSIONS.json 里人工填）
    cubism2: 'unknown',      // live2d.min.js 混淆代码，无版本字符串
    cubismCore,
    settingsCtorName: ctorName,
  };
}

/**
 * 取设置构造器（版本差异只在这里收敛）。
 *
 * **取不到就抛 version-unsupported，不再 return null 静默降级**：
 *   过去的做法是返回 null、上层 warn 一句然后回落 URL 路径，结果是
 *   "vfs:// 直接交给库 → Invalid URL → 模型对象残缺 → doDrawModel 报 undefined[0]"，
 *   一串症状掩盖了真正原因（类名对不上）。宁可当场报清楚。
 * @param {'cubism4'|'cubism2'} kind
 * @returns {Function}
 */
export function getSettingsCtor(kind) {
  const PIXI = pixiLib();
  const lib = PIXI && PIXI.live2d ? PIXI.live2d : null;
  if (!lib) throw new Error('version-unsupported: PIXI.live2d 不存在（运行时未加载）');
  const names = profile().settings[kind === 'cubism2' ? 'cubism2' : 'cubism4'];
  for (const name of names) {
    if (typeof lib[name] === 'function') return lib[name];
  }
  const available = Object.keys(lib).filter((k) => /Settings$/.test(k));
  throw new Error(`version-unsupported: 找不到 ${kind} 的设置类（试过 ${names.join(' / ')}）`
    + `；库实际导出的 Settings 类有：${available.join(', ') || '(无)'}`);
}

/**
 * 建模型实例（兼容 settings 实例与 URL 两种入参）。
 *
 * **URL 回落路径也要把 vfs:// 换成可 fetch 的 blob**：库不认识自定义协议，
 *   直接喂 vfs:// 会 `Failed to construct 'URL': Invalid URL`。这里是"库版本不支持时的
 *   唯一退路"，退路本身不能是坏的。
 * @param {object|string} source settings 实例，或模型定义地址
 * @param {{autoInteract?:boolean, resolveVfs?:(url:string)=>string|null}} [opts]
 */
export async function createModel(source, opts = {}) {
  const PIXI = pixiLib();
  if (!PIXI || !PIXI.live2d || !PIXI.live2d.Live2DModel) {
    throw new Error('Live2DModel 不可用：运行时未加载或版本不支持');
  }
  let arg = source;
  if (typeof source === 'string') {
    // URL 形态：先换 blob（转换函数由调用方注入，复用它的 VFS 句柄，不在这里另建一个）
    const resolved = typeof opts.resolveVfs === 'function' ? opts.resolveVfs(source) : null;
    if (!resolved) {
      throw new Error(`模型地址无法解析（不是可 fetch 的地址）：${source}`);
    }
    arg = resolved;
  }
  return PIXI.live2d.Live2DModel.from(arg, { autoInteract: opts.autoInteract === true });
}

/**
 * 建 PIXI.Application（8.x 是异步 init，6.x 是构造时给 options）。
 * @param {object} opts 传给 Application 的选项
 * @returns {Promise<object>} 已就绪的 app
 */
export async function createApplication(opts = {}) {
  const PIXI = pixiLib();
  if (!PIXI || typeof PIXI.Application !== 'function') throw new Error('PIXI.Application 不可用');
  // 策略来自版本矩阵；未登记世代（'auto'）按 prototype.init 能力探测兜底
  const mode = profile().appInit;
  const useAsync = mode === 'async'
    || (mode === 'auto' && typeof PIXI.Application.prototype.init === 'function');
  if (!useAsync) return new PIXI.Application(opts);   // 6.x：构造时给 options
  const app = new PIXI.Application();                 // 8.x：先构造再 await init
  await app.init(opts);
  return app;
}

/**
 * 把模型挂到舞台上（挂载方式收在一处，业务侧不关心 addChild 细节）。
 * @param {object} app
 * @param {object} model
 */
export function attachToStage(app, model) {
  if (!app || !app.stage || !model) return false;
  if (typeof app.stage.addChild === 'function') app.stage.addChild(model);
  return true;
}

/**
 * 设/清滤镜（含 filterArea 固定整屏；摘除时只脱引用不 destroy）。
 * @param {object} app
 * @param {object[]|null} filters null/空数组 = 摘掉
 * @returns {boolean}
 */
export function setFilters(app, filters) {
  if (!app || !app.stage) return false;
  if (!filters || !filters.length) {
    app.stage.filters = null;
    return true;
  }
  app.stage.filterArea = app.screen;
  app.stage.filters = filters;
  return true;
}

/** 建一个滤镜实例（Filter 构造签名两代一致，但仍收在这里以满足"业务侧不碰 PIXI.*"） */
export function createFilter(fragmentSrc, uniforms) {
  const PIXI = pixiLib();
  if (!PIXI || typeof PIXI.Filter !== 'function') return null;
  return new PIXI.Filter(null, fragmentSrc, uniforms);
}
