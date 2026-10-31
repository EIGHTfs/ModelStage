// infra/plugin-host.js —— 前端插件宿主（资产提供者 canHandle/resolve 的调用方）
//
// 为什么需要它：插件是**浏览器脚本**（plugins/<id>/index.js 顶层读 window.SpineViewerPlugins），
//   本实现之前完全没有宿主 —— 所以插件产出的资源（bundle 类）根本进不了渲染链路。
//   这个文件补的就是那一层：注入脚本 → 收集 provider → 提供取字节通道 → 供上层 findProvider/resolve。
//
// 宿主注入面：插件看到的接口形态在页面重写后保持稳定（插件不需要跟着改）的 ESM 版；
//   插件侧**零改动**（这是方案 B 的核心优点）。
//
// 契约依据：资产提供者契约 §一（canHandle/resolve 形状）、插件契约 §3.1（canHandle 纯判定）、
//   §3.6（取字节通道 = host.fetchFile(rootId, rel)）、§3.7（插件异常隔离）。
//
// 三条硬规则（都在下面落实）：
//   ① 失败隔离：任何一个插件脚本 404/抛错，都只记警告，不影响页面与其它插件
//   ② 只加载启用清单：/api/plugins 已按 config/plugins.json 过滤，被禁用的插件不会出现在清单里
//   ③ canHandle 由宿主调用、宿主兜异常：插件内部抛错一律当"不认这个文件"，不冒泡到调用方

// 插槽注册表（DOM-free、可 node 直测）：只登记不渲染，S2 才接渲染
import { createSlotRegistry } from './slot-registry.js';
import { EVENTS } from './events.mjs';
import { createRegistration } from './plugin-host-registration.mjs';
import { createUnpack } from './plugin-host-unpack.mjs';
import { createReport } from './plugin-host-report.mjs';
import { createUnload } from './plugin-host-unload.mjs';
import { createWarmup } from './plugin-host-warmup.mjs';
// 内置分组 id（纯数据，DOM-free）：注册表据此区分"引用内置组"与"插件新建组"
import { PANEL_GROUPS } from '../panel/schema.js';

import { getJson } from './api.js';
// 资源包"形态"判据与文案：与 node 侧 /api/unpack 共用同一份（见 src/shared/bundle-shape.mjs 顶部说明）

/** 宿主提示通道：优先用注入的 log（项目调试日志），否则退回 console */
function makeLogger(log) {
  const push = (level, msg) => {
    try {
      if (typeof log === 'function') { log(level, msg); return; }
    } catch { /* 日志失败不影响主流程 */ }
    const line = `[plugin-host] ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    info: (m) => push('info', m),
    warn: (m) => push('warn', m),
    error: (m) => push('error', m),
  };
}



/** 注入一个 <script> 并等它结束（成功/失败都 resolve，不抛） */
function injectScript(src) {
  return new Promise((resolve) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = false;
    el.onload = () => resolve(true);
    el.onerror = () => resolve(false);
    document.head.appendChild(el);
  });
}

/**
 * 创建插件宿主。
 * @param {{log?: Function, baseUrl?: string}} [opts]
 * @returns {object} 宿主查询面（见文件末尾 return）
 */
// ============================================================================
// 【模块地图】—— 想知道"某个功能在哪个文件"，看这一张表即可（不含行号，因此不用维护）
//
//   plugin-host.js                本体：装配各模块 + 对外 API（hostApi / 返回面）+ 装载编排与插槽表初始化
//   plugin-host-registration.mjs  注册与校验：provider / 效果 / 老接口控件 / 通知（全部拒绝码与校验顺序在这里）
//   plugin-host-unpack.mjs        资源取用与解包：预筛 → 读字节 → worker / 服务端解包 → 注册 VFS（自持 workerPool）
//   plugin-host-unload.mjs        卸载与回收：逆序跑 disposer → 清四张表 → 终止 worker → 派发重建事件
//   plugin-host-warmup.mjs        预热：容量探测 + 在途去重 + 服务端事件流（自持 capCache / warmupInflight）
//   plugin-host-report.mjs        状态报告：只读快照（discovered / providers / loadState）
//   events.mjs                    事件名常量（唯一来源；单测禁止其它前端文件再写字面量）
//
//   下面各区只说明"这一段负责什么、和哪些状态耦合"，不再记录函数行号——
//   要定位具体函数，进对应模块后按名字搜。
//
// ── 分区 R1：基础工具与统计发布 ─────────────────────────────────────────────
//   职责：日志适配、类型转换、事件派发封装、把插槽/效果统计挂到 window（面板与测试读这些数据集）。
//   状态耦合：say / emit（依赖）、slotRegistry / pluginEffects（只读汇总）。
//
// ── 分区 R2：注册入口 hostApi（只剩组装；实现在 plugin-host-registration.mjs）──
//   职责：把 ctx 与各表以"窄视图"注入注册模块，再把返回的方法拼成 hostApi。
//   状态耦合：providers / loadState / registeredEffects（经注册模块写）、slotRegistry（读）、loadingPluginId（读）。
//
// ── 分区 R3：装载与卸载回收（loadPlugin / effectsReport；卸载在 -unload.mjs）────
//   职责：注入脚本 → 登记 loadState；卸载由 -unload.mjs 负责（逆序 dispose → 清表 → 派发事件）。
//   状态耦合：discovered / loaded（**唯一写者**都在这段）、loadingPluginId（窗口开关）、
//            slotRegistry（初始化）、loadState（写）。
//
// ── 分区 R4/R5：资源取用与解包（整体在 plugin-host-unpack.mjs）──────────────
//   职责：把"资源根里的文件"变成"可用字节 / 解包产物 / VFS 前缀"，**不碰 DOM、不碰面板**。
//   状态耦合：discovered（读清单找 provider）、providers（读 provider 表）、say / emit；
//            workerPool 与该区常量由解包模块自持，宿主只拿引用做卸载清理。
//
// ── 分区 R6：装载编排 / provider 查询（report 在 -report.mjs）────────────────
//   职责：发现清单 → 建注册表 → 注入脚本 → 统计结果；以及 provider 查询与回收报告。
//   状态耦合：几乎全部只读（loaded / discovered / providers / pluginEffects /
//            registeredEffects / slotRegistry）。
//

// ── 高频共享状态：已收敛为一个显式 `ctx`（B0 完成）────────────────────────
//   位置：工厂体开头（搜 `const ctx = {`）。**唯一一份定义**，内部函数一律用 `ctx.xxx` 读写；
//   不再有同名的工厂作用域变量（有就是漏改，用 grep `\bc<名字>\b` 自查能发现）。
//   为什么收敛：这 9 个状态被 5~12 个函数跨分区读写，依赖关系原先只能靠通读全文才看得见；
//     收进一个具名对象后，"谁依赖什么"体现在 `ctx.` 前缀上，也是将来把这些函数搬出本文件的前提
//     （B1+ 只需传一个 ctx 参数，不必重连一整片闭包）。
//
//   字段 | 类型 | 谁写 | 谁读 | 时序约束 / 改动时注意
//   ctx.say                 | 日志器（初始化后不变） | 无 | 12 个函数 | 只加不换：换实现会改变全部日志格式
//   ctx.emit                | 派发器（初始化后不变） | 无 | 8 个函数  | 事件名是外部契约（main/panel 订阅）
//   ctx.discovered          | 数组                   | doLoadAll（唯一） | 9 个函数 | 只在装载期整体替换；运行期读到的是最近一次快照
//   ctx.loaded              | 布尔                   | doLoadAll（唯一） | 9 个函数 | 是"已装载"的唯一判定（isLoaded 直接返回它）
//   ctx.providers           | Map                    | register / unloadPlugin | 8 个函数 | 覆盖会被显式拒绝；删要连 disposer 一起
//   ctx.slotRegistry        | 对象或 null            | initSlotRegistry（唯一） | 8 个函数 | **惰性初始化**：脚本注入前必须已建好，否则注册静默丢弃
//   ctx.loadState           | Map                    | register / loadPlugin / unloadPlugin | 7 个函数 | 装载状态与错误文案的唯一来源，卸载要删否则残留
//   ctx.registeredEffects   | Map                    | registerEffect / unloadPlugin | 6 个函数 | 能力键白名单来源；删漏会让控件显示"未注册成功"
//   ctx.pluginEffects       | Map                    | addEffect / unloadPlugin | 5 个函数 | 插件级 disposer 容器；卸载按**逆序**执行，依赖它
//
//   留在闭包（**不**进 ctx，理由：引用数 ≤4，进 ctx 只会把 ctx 变成杂物袋）：
//     base、manifestProvides、manifestEffects、registrationRejects、loadingPluginId、lastLoadedPluginId、
//     pluginSettings、loadingPromise、workerPool、capCache/CAP_TTL_MS、warmupInflight、WARMUP_PHASE_TEXT、
//     ORDINARY_ASSET_EXT、MAX_BUNDLE_BYTES、MAX_FRAGMENT_CHARS、hostApi
//
// ── 与"将来拆分"的关系 ────────────────────────────────────────────────────
//   调研结论（docs/设计/plugin-host拆分调研.md）：**暂不拆文件**。B0（状态收敛）已完成；
//   若继续 B1，就是把 ctx 作为参数把"资源取用/解包"这组（23 个函数、64% 代码）整体搬出去。
// ============================================================================
export function createPluginHost(opts = {}) {
  /**
   * 高频共享状态容器（B0 收敛）。
   *
   * 为什么要有它：这 9 个状态原本是工厂作用域的散装闭包变量，被 5~12 个内部函数直接读写，
   *   依赖关系只能靠通读全文才看得见。收进一个具名对象后，"谁依赖什么"在函数签名与
   *   `ctx.` 前缀上一眼可辨 —— 这是将来把这些函数搬出本文件（B1+）的前提：
   *   届时它们只需要接收一个 ctx 参数，而不是重连一整片闭包。
   *
   * 约定（改这个对象之前先读）：
   *   · 只有**高频**状态进 ctx（引用数 ≥5）；低频状态留在原地，避免 ctx 变成杂物袋
   *   · 全部读写都必须经过 `ctx.`，不许再把名字解构回局部变量（否则又变回隐式闭包）
   *   · 三条时序约束见文件头「9 个高频共享状态」表：slotRegistry 惰性初始化、
   *     loadingPluginId 窗口语义（不在本对象内，仍在闭包）、workerPool 生命周期
   */
  const ctx = {
    /** 日志器（初始化后不变） */
    say: makeLogger(opts.log),
    /** diag 事件通道（由 main.js 注入 app/status.js 的 diagEvent；缺省空函数） */
    emit: typeof opts.diagEvent === 'function' ? opts.diagEvent : () => {},
    /** id → provider（插件 register 上来的对象）；写者：register / unloadPlugin */
    providers: new Map(),
    /** 注册成功的效果（effectId → { pluginId, fragment }）；写者：registerEffect / unloadPlugin */
    registeredEffects: new Map(),
    /** id → { loaded, error, files, ms }（装载状态与错误文案的唯一来源） */
    loadState: new Map(),
    /** 插件级 effect 容器：pluginId → [{ kind, label, dispose }]（注册顺序，回收时逆序执行） */
    pluginEffects: new Map(),
    /** 插槽注册表（**惰性初始化**：必须在注入任何插件脚本之前建好，否则注册会被静默丢弃） */
    slotRegistry: null,
    /** 本次发现的插件清单（装载期整体替换，运行期读到的是最近一次快照） */
    discovered: [],
    /** 是否已完成一次装载（doLoadAll 是唯一写者；卸载时要同步维护，否则 isLoaded 会骗人） */
    loaded: false,
  };

  // 宿主报告：搬到 plugin-host-report.mjs（B1）—— 纯读，只依赖 ctx
  const report = createReport({ ctx });
  // diag 事件通道（由 main.js 注入 app/status.js 的 diagEvent）：解包来源是**验收要读**的事实，
  //   不能只写 console —— 页面上层与测试都靠 diag 取证。
  const base = String(opts.baseUrl || '').replace(/\/$/, '');

  // 解包区（R4）：搬到 plugin-host-unpack.mjs（B4）—— 参数只有 io / state / limits 三个窄视图
  //   workerPool 由该模块**创建并持有**（生命周期归它），这里只拿引用给卸载流程做清理
  const unpack = createUnpack({
    io: { say: ctx.say, emit: ctx.emit },
    state: { providers: ctx.providers, getDiscovered: () => ctx.discovered },
    limits: { base },
  });
  const { materialize, fetchFile, providersFor, findProvider, prefilterReason, pool: workerPool } = unpack;

  /** id → provider（插件 register 上来的对象） */
  /** id → 清单里声明的角色（provides）——插件自己 register 时不一定带，以清单为准 */
  const manifestProvides = new Map();
  // 清单里声明的 effects（pluginId → [{id,label,params}]）：能力键白名单与控件校验的唯一依据。
  //   与 manifestProvides 同一模式 —— 角色/效果都以**清单**为准，注册时不能自说自话。
  const manifestEffects = new Map();

  // 卸载与回收（plugin-host-unload.mjs，B1）：workerPool 由 unpack 模块创建并持有，这里传引用供终止清理
  //   放在 manifestEffects 声明之后：它要在**初始化时**拿到这张表（提前引用会撞 TDZ）
  const { unloadPlugin, unloadAll } = createUnload({
    ctx, manifestEffects, workerPool, publishSlotStats, publishEffectStats,
  });
  // 注册成功的效果（effectId → { pluginId, fragment }）：只有进这里的 id 才进能力键白名单
  /** 当前正在注入脚本的插件 id（register* 靠它认领"这是谁的注册"） */
  let loadingPluginId = '';
  /** 效果表达式长度上限：见 registerEffect 里"超长直接拒"的理由 */
  const MAX_FRAGMENT_CHARS = 2000;
  /** id → { loaded, error, files, ms } 装载状态（排障用） */

  /**
   * 插件级 effect 容器：pluginId → [{ kind, label, dispose }]（**注册顺序**，回收时逆序执行）。
   *
   * 为什么要有它：在此之前 register* 只是往宿主表里塞、从不删除，
   *   插件卸载/禁用没有任何可执行的回收动作 —— 插槽一旦能改界面，残留就只能靠人肉排查。
   * 这里给每个插件一份"我注册了什么"的清单，把回收变成一次可验证的批量操作。
   */

  /**
   * 窗口外注册的显式拒绝记录（最近 50 条，供排障与验收读取）。
   *
   * 为什么单独记：以前异步注册只有一条 warn，既看不出是哪个插件，也没法被判据读取；
   *   典型表现是"插件装了、控件不出现、日志里一句话都搜不到"。
   */
  const registrationRejects = [];

  /** 最近一次装载完成的插件 id：窗口外注册时用它指出"大概是哪个插件的异步回调" */
  let lastLoadedPluginId = '';

  /**
   * 插槽注册表（装载时按 /api/plugins 的 slotCatalog 建）。
   *
   * 为什么在 doLoadAll 里建、而不是构造期建：目录与"每个插件声明了哪些插槽"都来自那一份响应；
   *   构造期建只能用空目录，之后还得重建（重建会把已登记项丢掉）。
   * 阶段口径 openStage='S1'：本阶段所有插槽都未开放 ⇒ 注册一律被 slot-not-open 拒，
   *   这正是 S1 的语义（只搭基础设施，不动界面）。
   */

  /**
   * 每个插件在清单里声明的设置项（`plugin.json` 的 settings[]）。
   * 用途：插件 render(props) 要能看到"自己声明的键当前是多少"——
   *   面板侧据此构造 `props.settings`（当前值 ?? 声明默认值），插件不必再自己去猜键名。
   * 缺省空 Map（老插件没声明 settings 时就是空对象，插件侧应容忍）。
   */
  const pluginSettings = new Map();

  /** 登记一个可回收 effect（同一插件按注册顺序追加） */
  // ── 分区 R1：基础工具与统计发布 ─────────────────────────────────────────────
  // 本区放"其它区都要用的小工具"：效果容器入口（addEffect）、阶段归一（normalizeStage）、
  //   两处 window 统计发布（插槽/效果）。注册拒绝出口与老控件包装已随注册模块搬走。
  // 状态耦合：addEffect / publishEffectStats 写 pluginEffects；publishSlotStats 读 slotRegistry。
  function addEffect(pluginId, effect) {
    const id = String(pluginId || '');
    if (!id || !effect || typeof effect.dispose !== 'function') return false;
    const list = ctx.pluginEffects.get(id) || [];
    list.push(effect);
    ctx.pluginEffects.set(id, list);
    publishEffectStats();
    return true;
  }

  /**
   * 当前阶段：**只信服务端**（`/api/plugins` 的 currentStage，由 slot-catalog 的 CURRENT_STAGE 派生）。
   *
   * 唯一来源原则：阶段是"服务端开放到哪一步"的事实，前端自己存一份必然漂移
   *   （上一轮就埋过一个 CURRENT_SLOT_STAGE 常量，已经删掉）。
   * 回退 'S1' 只是过渡：字段缺失时按最保守处理（所有插槽都未开放）——
   *   宁可全部拒绝并报 slot-not-open，也不要因为读不到就放开。
   * @param {unknown} raw 服务端下发的 currentStage
   * @returns {string}
   */
  function normalizeStage(raw) {
    const text = String(raw == null ? '' : raw).trim().toUpperCase();
    return /^S[1-9]$/.test(text) ? text : 'S1';
  }
  /**
   * 把插槽统计挂到 window.__SLOT_STATS__（测试读它；**不动既有 dataset 字段**）。
   * 为什么用 window 而不是 dataset：dataset 参与 outerHTML 快照比对（测试侧定案），
   *   往里塞会变的统计会让"还原性"断言互相打架。
   */
  function publishSlotStats() {
    try {
      if (typeof window !== 'undefined' && window && typeof window === 'object') {
        window.__SLOT_STATS__ = ctx.slotRegistry ? ctx.slotRegistry.stats() : null;
      }
    } catch { /* 无 window（node 测试）时忽略 */ }
  }

  /** 把 effect 总数写到 dataset（不新增 dataset 字段族，只加一个计数便于验收） */
  function publishEffectStats() {
    try {
      let total = 0;
      for (const list of ctx.pluginEffects.values()) total += list.length;
      document.documentElement.dataset.pluginEffects = String(total);
    } catch { /* 无 DOM（测试环境）时忽略 */ }
  }




  /** /api/plugins 返回的清单快照 */
  /**
   * 进行中的 loadAll（并发去重）。
   * 为什么需要：启动预热与"用户一打开就点资源包"可能同时触发装载，
   *   两路各发一次 /api/plugins、各评估一遍插件，既浪费也会让提供者注册更晚。
   *   这里让后来者复用同一个 Promise：清单只取一次、插件只装载一次。
   */
  let loadingPromise = null;


  /** 插件侧可见的宿主面（插件脚本顶层会读 window.SpineViewerPlugins） */
  // ── 分区 R2：注册入口 hostApi（只剩组装；实现在 plugin-host-registration.mjs）──
  // 本区只做两件事：把 ctx 与各表以"窄视图"注入注册模块，再把返回的方法拼成 hostApi。
  // 共同约束（仍在注册模块里执行）：**只接受装载期同步调用**（loadingPluginId 非空），
  //   异步注册一律显式拒绝并给原因。
  // 状态耦合：providers / loadState / registeredEffects（经注册模块写）；
  //   slotRegistry、manifestEffects、loadingPluginId（读）。
  //   参数刻意用"窄视图"而不是整块 ctx：io（日志/事件）/ tables（它读写的三张表 + 插槽表 getter）/
  //   decls（清单声明与拒绝记录）/ probe（装载期窗口与最后装载者，必须现读）/ sinks（回收登记与统计发布）
  const registration = createRegistration({
    io: { say: ctx.say, emit: ctx.emit },
    tables: {
      providers: ctx.providers,
      loadState: ctx.loadState,
      registeredEffects: ctx.registeredEffects,
      // 惰性初始化：必须用 getter 现取，快照会在"注册表还没建好"时永远拿到 null
      getSlotRegistry: () => ctx.slotRegistry,
    },
    decls: { manifestProvides, manifestEffects, registrationRejects, maxFragmentChars: MAX_FRAGMENT_CHARS },
    probe: {
      getLoadingPluginId: () => loadingPluginId,
      getLastLoadedPluginId: () => lastLoadedPluginId,
      dispatch: (name, detail) => { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* 忽略 */ } },
    },
    sinks: { addEffect, publishSlotStats },
  });

  /**
   * 插件侧可见的宿主面（插件脚本顶层会读 window.SpineViewerPlugins）。
   *
   * B2 之后这里**只剩组装**：注册类方法来自 plugin-host-registration.mjs，
   *   本文件只补"不是注册入口"的成员（version / fetchFile）。
   */
  const hostApi = {
    version: 1,
    fetchFile,
    register: registration.registerProvider,
    registerEffect: registration.registerEffect,
    registerControls: registration.registerControls,
    slots: registration.slots,
    notify: registration.notify,
  };

  /** 按清单串行注入某插件的全部脚本（顺序即 plugin.json 的 files[] 顺序：lib/* 先、index.js 后） */
  // ── 分区 R3：装载与卸载回收（装配 + effectsReport）──────────────────────────
  // 装载：注入脚本 → 登记 loadState；卸载与回收在 plugin-host-unload.mjs（逆序 dispose → 清表 → 派发事件）。
  // 状态耦合：loadState（写）、loaded（读）、providers/registeredEffects/pluginEffects（卸载时删）。
  async function loadPlugin(pl) {
    const id = String(pl && pl.id ? pl.id : '');
    if (!id) return;
    const t0 = Date.now();
    ctx.loadState.set(id, { loaded: false, error: null, files: 0, ms: 0 });
    loadingPluginId = id;   // 让 register* 知道这次注册属于哪个插件
    const files = Array.isArray(pl.files) ? pl.files : [];
    let okCount = 0;
    for (const f of files) {
      const ok = await injectScript(`${base}/plugins/${f}`);
      if (ok) okCount += 1;
      else {
        const st = ctx.loadState.get(id);
        if (st && !st.error) st.error = `脚本加载失败: ${f}`;
      }
    }
    loadingPluginId = '';
    const st = ctx.loadState.get(id) || {};
    // 生效判定要分角色（契约 §一 五类角色）：
    //   asset-provider 必须 register() 交出 canHandle/resolve；
    //   只提供 panel 的插件没有 register() 可言，它交的是 effects/controls ——
    //   拿 register() 当唯一成功标志会把它误判成"加载失败"，进而把它的控件也置灰。
    // 生效判定：交出过插槽控件、或注册过效果，都算"这个插件在工作"
    const slotCount = ctx.slotRegistry ? (ctx.slotRegistry.stats().byPlugin[id] || 0) : 0;
    const didPanelWork = slotCount > 0
      || [...ctx.registeredEffects.values()].some((e) => e.pluginId === id);
    const providerOk = ctx.providers.has(id);
    const error = st.error || (providerOk || didPanelWork ? null : '脚本已加载但没有调用 register()');
    ctx.loadState.set(id, { ...st, loaded: providerOk || didPanelWork, error, files: okCount, ms: Date.now() - t0 });
    lastLoadedPluginId = id;
    if (error) ctx.say.warn(`插件 ${id} 未生效：${error}（其余插件与页面不受影响）`);
  }


  /**
   * 回收清单（可读）：每个插件登记了多少 effect、现在还剩多少控件节/效果/提供者。
   *
   * 为什么需要：本轮界面还没接插槽，但"回收到底发生了没有"必须能被读取（验收与排障都靠它）。
   * @returns {{totalEffects:number, plugins:Array, rejects:Array}}
   */
  function effectsReport() {
    const ids = [...new Set([...ctx.pluginEffects.keys(), ...ctx.loadState.keys(), ...ctx.providers.keys(),
      ...(ctx.slotRegistry ? Object.keys(ctx.slotRegistry.stats().byPlugin) : [])])];
    const plugins = ids.filter(Boolean).map((id) => {
      const list = ctx.pluginEffects.get(id) || [];
      return {
        id,
        effects: list.length,
        kinds: list.map((e) => e.kind),
        slots: ctx.slotRegistry ? (ctx.slotRegistry.stats().byPlugin[id] || 0) : 0,
        effectsRegistered: [...ctx.registeredEffects.values()].filter((e) => e.pluginId === id).length,
        provider: ctx.providers.has(id),
        loaded: !!(ctx.loadState.get(id) || {}).loaded,
      };
    });
    const totalEffects = [...ctx.pluginEffects.values()].reduce((n, l) => n + l.length, 0);
    return { totalEffects, plugins, rejects: registrationRejects.slice() };
  }

  // ---------------------------------------------------------------- 预筛与物化（resolve → VFS）
  //
  // 为什么要预筛：canHandle 必须看**完整容器字节**才能判定（它要解析 UnityFS 的 CAB 节点，
  //   实测只给前 64 字节时连真 bundle 都判 false），而单个包 44MB、单次判定 ~95ms。
  //   对目录里每个文件都这么来一遍是不可接受的，所以先按"根类型 + 后缀 + 大小"筛掉绝大多数，
  //   只对候选包读全量字节。
  //
  // **别把这层去掉**：直接对整目录跑 findProvider 会让一次扫描读几百 MB、卡住主线程。

  /** 普通模型资产的后缀：这些不可能是资源包，别为它们读全量 */


  // 预热：搬到 plugin-host-warmup.mjs（B1）—— 只依赖 ctx.say / ctx.emit + 服务端事件流
  const warmup = createWarmup({ ctx });

  // ── 分区 R4/R5：资源取用与解包（整体在 plugin-host-unpack.mjs）──────────────
  // 解包主流程（缓存命中 → provider 解析 → 产物校验 → 注册 VFS）与预热都在搬出去的模块里，
  //   本区只剩装配那一行。状态耦合（在模块内）：providers / discovered（读）、say / emit。

  /**
   * 读启用清单并逐个加载。**任何失败都不抛**：宿主是增强项，不能拖垮页面。
   *
   * 幂等 + 并发去重（装载入口每次都会先调它，热路径必须几乎零成本）：
   *   · 已装载完成 → 直接返回上次结果，不再请求 /api/plugins；
   *   · 正在装载   → 后来者复用同一个 Promise（清单只取一次、插件只评估一次）。
   * 这解决了"页面刚起、插件脚本还在注入时就发起装载"的时序竞争。
   * @returns {Promise<{discovered: number, registered: number}>}
   */
  // ── 分区 R6：装载编排（loadAll / doLoadAll / initSlotRegistry）──────────────
  // 装载编排与插槽注册表初始化留在这里（它们要驱动脚本注入与窗口开关）；
  //   provider 查询与状态报告分别在 -unpack.mjs / -report.mjs。
  // 状态耦合：discovered / loaded（**唯一写者** doLoadAll）、slotRegistry（唯一写者 initSlotRegistry）。
  async function loadAll() {
    if (ctx.loaded) return { discovered: ctx.discovered.length, registered: countRegistered() };
    if (loadingPromise) return loadingPromise;
    loadingPromise = doLoadAll().finally(() => { loadingPromise = null; });
    return loadingPromise;
  }

  /** 已成功装载（注册提供者）的插件数 */
  function countRegistered() {
    return [...ctx.loadState.values()].filter((s) => s.loaded).length;
  }

  /**
   * 按 `/api/plugins` 的响应建插槽注册表（**必须在注入任何插件脚本之前**）。
   *
   * 为什么单独成函数：它要读四类信息（目录 / 每插件声明 / 当前阶段 / 每插件 settings 键），
   *   塞在 doLoadAll 里会把装载流程读断（也过不了"单函数 50 行"的口径）。
   * @param {object} data /api/plugins 响应
   * @param {Array} discovered 本次发现的插件清单
   */
  function initSlotRegistry(data, discoveredList) {
    const declared = {};
    for (const pl of discoveredList) {
      const pid = String(pl && pl.id ? pl.id : '');
      declared[pid] = Array.isArray(pl && pl.slots) ? pl.slots : [];
      pluginSettings.set(pid, Array.isArray(pl && pl.settings) ? pl.settings : []);
    }
    ctx.slotRegistry = createSlotRegistry({
      catalog: Array.isArray(data && data.slotCatalog) ? data.slotCatalog : [],
      declaredByPlugin: declared,
      // 阶段只信服务端（currentStage）；字段缺失时 normalizeStage 回退 'S1'（过渡兜底）
      openStage: normalizeStage(data && data.currentStage),
      // 内置控件 id：键值插槽（panel.control.*）只能指向它们（替换既有控件，不许静默新建）
      builtinControlIds: new Set(PANEL_GROUPS.flatMap((g) => (g.controls || []).map((c) => String((c && c.id) || '')))),
      // 内置组 id：新建分组必须带 plugin.<pluginId>. 前缀（设计 §七·一）
      groupIds: new Set(PANEL_GROUPS.map((g) => String(g.id || ''))),
      // spec.setting 校验用：该插件清单里声明过的 settings 键
      settingsKeysOf: (pid) => (pluginSettings.get(String(pid || '')) || []).map((s) => String(s && s.key || '')),
      isInLoadWindow: () => !!loadingPluginId,
      onReject: (rej) => {
        ctx.say.warn(`插槽注册被拒（${rej.code}）：${rej.why}`);
        ctx.emit('plugin.slot-rejected', rej);
      },
    });
    publishSlotStats();
  }

  /** loadAll 的实际执行体（内部使用；失败只记日志不抛） */
  async function doLoadAll() {
    try {
      // 幂等 GET ⇒ 走统一层（保留 no-store：改完插件要立刻看到，不能读缓存）。
      //   bundle-failures.js 拉的是同一个 URL，两处并发时会被 api.js 合并成一次真实请求。
      const data = await getJson(`${base}/api/plugins`, { cache: 'no-store' });
      ctx.discovered = Array.isArray(data && data.plugins) ? data.plugins : [];
      // 建插槽注册表（**必须在注入任何插件脚本之前**）：目录与"谁声明了什么"都来自这一份响应，
      //   晚一步建就会出现"插件已经能 register、注册表还不存在"的空窗。
      initSlotRegistry(data, ctx.discovered);
    } catch (e) {
      ctx.say.warn(`插件清单获取失败（页面其余功能不受影响）：${(e && e.message) || e}`);
      return { discovered: 0, registered: 0 };
    }
    if (!ctx.discovered.length) {
      ctx.say.info('没有启用任何插件（config/plugins.json 可开关）');
      ctx.loaded = true;
      return { discovered: 0, registered: 0 };
    }
    // 内置装载器（builtin:true）是**纯声明条目**：它没有 plugin.json 那样的代码文件可注入，
    //   存在的意义是给服务端提供者注册表一份统一的"颜色 / 候选 / 指纹"表（契约 §一·五）。
    //   过去把它们当普通插件走"注入脚本 → 等 register()"的生效判定，files 为空 ⇒ 循环不跑，
    //   必然产出「插件未生效：脚本已加载但没有调用 register()」这种误报（实测 builtin-spine /
    //   builtin-live2d 各一条）。这里把它们从"需要装载"的名单里分出来：只声明、不装载、不算失败。
    // exec 运行时（runtime:"exec"）同理：它的代码在**服务端进程**里（宿主 spawn 一个子进程），
    //   浏览器里没有脚本可注入 —— 前端只消费它解包结果（`/api/unpack/resolve` 那一路）。
    //   files[] 本来就是空的，混进"需要注入脚本"的名单 ⇒ 必然报同样的假告警
    //   （实测 8804：「插件 unitypy-bundle 未生效：脚本已加载但没有调用 register()」）。
    const scripts = ctx.discovered.filter((p) => p && p.builtin !== true && p.runtime !== 'exec');
    const builtinDecls = ctx.discovered.filter((p) => p && p.builtin === true);
    const execDecls = ctx.discovered.filter((p) => p && p.runtime === 'exec');
    ctx.say.info(`发现 ${ctx.discovered.length} 个启用插件：${ctx.discovered.map((p) => p.id).join(', ')}`
      + (builtinDecls.length ? `（其中 ${builtinDecls.length} 个为内置装载器声明，无代码需注入）` : '')
      + (execDecls.length ? `（${execDecls.length} 个为 exec 运行时，代码在服务端进程里跑，前端只登记声明）` : ''));
    // 声明登记对所有提供者都要做（含 exec / 内置）：归属着色与候选名单靠这张表，
    //   跳过它们会让"这个包是谁解的"查不到声明色。
    for (const pl of [...scripts, ...execDecls]) {
      if (pl && pl.id) {
        manifestProvides.set(pl.id, Array.isArray(pl.provides) ? pl.provides.map(String) : []);
        // effects 可选；形状不合法在这里就归一成空数组（服务端已校验过，这里只防脏数据）
        manifestEffects.set(pl.id, Array.isArray(pl.effects) ? pl.effects.filter((e) => e && e.id) : []);
      }
    }
    for (const pl of scripts) {
      try { await loadPlugin(pl); } catch (e) { ctx.say.warn(`插件 ${pl && pl.id} 装载异常：${(e && e.message) || e}`); }
    }
    ctx.loaded = true;
    const ok = countRegistered();
    // "未生效"只对账**需要装载代码的**那些：内置声明不参与 register()，算进分母就又造假告警
    ctx.say.info(`插件装载完成：需装载 ${scripts.length} 个、注册 ${ok} 个提供者`
      + (ok < scripts.length ? `（${scripts.length - ok} 个未生效，见上方警告）` : ''));
    // 面板侧要知道"插件已经交完声明了" —— 它启动时先建面板，插件是之后异步注入的，
    //   不通知就永远看不到插件控件（实测：控件节收到了，但面板不会自己重建）。
    try {
      window.dispatchEvent(new CustomEvent(EVENTS.PLUGINS_LOADED, {
        detail: { discovered: ctx.discovered.length, registered: ok, slots: ctx.slotRegistry ? ctx.slotRegistry.stats().total : 0 },
      }));
    } catch { /* 忽略 */ }
    return { discovered: ctx.discovered.length, registered: ok };
  }



  // 插件脚本顶层读的就是它：必须在注入脚本**之前**挂好
  window.SpineViewerPlugins = hostApi;
  // 设计 §二 的命名收敛：插槽 API 挂在 ModelStagePlugins 命名空间上；
  //   旧的 SpineViewerPlugins 保留（现有插件仍用它），迁移留给 S2 之后
  try {
    window.ModelStagePlugins = Object.assign(window.ModelStagePlugins || {}, { slots: hostApi.slots });
  } catch { /* 无 window 环境忽略 */ }

  return {
    loadAll,
    /** 卸载单个插件（逆序回收它的 effect，并从宿主表移除痕迹） */
    unloadPlugin,
    /** 卸载全部已装载插件 */
    unloadAll,
    /** 回收清单：每插件登记了哪些 effect、还剩多少控件/效果/提供者（验收读它） */
    effectsReport,
    /**
     * 插槽登记明细（含 spec.render）：装配期拿它把"插件声明的控件"合进面板。
     * 返回副本，面板侧改动不会污染注册表。
     */
    slotSections: () => (ctx.slotRegistry ? ctx.slotRegistry.renderEntries() : []),
    /** 某插件在清单里声明的 settings[]（面板侧构造 props.settings 用） */
    pluginSettings: (pluginId) => (pluginSettings.get(String(pluginId || '')) || []).map((s) => ({ ...s })),
    providersFor,
    findProvider,
    fetchFile,
    /** 资源包 → VirtualFS（预筛 → 读全量 → resolve → register），不碰渲染 */
    materialize,
    warmup,
    /** 预筛判定（排障用：为什么某个文件没被当成资源包） */
    prefilterReason,
    report,
    isLoaded: () => ctx.loaded,
    host: hostApi,
    /**
     * 面板层用：插件提交的控件节（含来源插件 id）。
     * 返回副本，避免面板侧改动污染宿主记录。
     */

    /**
     * 面板层用：**注册成功**的效果 id 列表 —— 能力键白名单的唯一来源（契约 §9.3）。
     * 只声明但没注册成功的不在列表里 ⇒ 对应控件会置灰。
     */
    registeredEffectIds: () => [...ctx.registeredEffects.keys()],
    /**
     * 面板层用：已注册效果的完整声明（按**清单 effects[] 声明顺序** = 效果链的叠加顺序）。
     * fragment 给渲染层拼着色器，params 给"档位 → uniform"换算。
     * @returns {Array<{id:string, pluginId:string, fragment:string, label:string, params:Array}>}
     */
    effectDeclarations: () => {
      const out = [];
      for (const [pluginId, list] of manifestEffects.entries()) {
        for (const eff of list || []) {
          const reg = ctx.registeredEffects.get(String(eff.id));
          if (!reg || reg.pluginId !== pluginId) continue;   // 只报注册成功的
          out.push({
            id: String(eff.id),
            pluginId,
            fragment: reg.fragment,
            label: String(eff.label || eff.id),
            params: Array.isArray(eff.params) ? eff.params.map((p) => ({ ...p })) : [],
          });
        }
      }
      return out;
    },
    /** 面板层用：某个 effect id 属于哪个插件（置灰时写原因） */
    effectOwner: (effectId) => {
      const hit = ctx.registeredEffects.get(String(effectId));
      return hit ? hit.pluginId : '';
    },
    /** 面板层用：插件装载失败清单（id → error），控件置灰时给出"为什么" */
    pluginFailures: () => [...ctx.loadState.entries()]
      .filter(([, st]) => st && st.error)
      .map(([id, st]) => ({ id, error: String(st.error) })),
  };
}
