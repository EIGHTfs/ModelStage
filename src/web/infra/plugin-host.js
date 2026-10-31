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

import { getSharedVirtualFS } from './vfs.js';
// 插槽注册表（DOM-free、可 node 直测）：只登记不渲染，S2 才接渲染
import { createSlotRegistry } from './slot-registry.js';
// 内置分组 id（纯数据，DOM-free）：注册表据此区分"引用内置组"与"插件新建组"
import { PANEL_GROUPS } from '../panel/schema.js';

import * as memoryGuard from '../app/memory-guard.js';
import { postJson, postStream, getJson, fetchWithRetry, mapLimit } from './api.js';
// 资源包"形态"判据与文案：与 node 侧 /api/unpack 共用同一份（见 src/shared/bundle-shape.mjs 顶部说明）
import { histogramFromObjects, isAssetDependencyHistogram, dependencyReason } from '../../shared/bundle-shape.mjs';

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
export function createPluginHost(opts = {}) {
  const say = makeLogger(opts.log);
  // diag 事件通道（由 main.js 注入 app/status.js 的 diagEvent）：解包来源是**验收要读**的事实，
  //   不能只写 console —— 页面上层与测试都靠 diag 取证。
  const emit = typeof opts.diagEvent === 'function' ? opts.diagEvent : () => {};
  const base = String(opts.baseUrl || '').replace(/\/$/, '');

  /** id → provider（插件 register 上来的对象） */
  const providers = new Map();
  /** id → 清单里声明的角色（provides）——插件自己 register 时不一定带，以清单为准 */
  const manifestProvides = new Map();
  // 清单里声明的 effects（pluginId → [{id,label,params}]）：能力键白名单与控件校验的唯一依据。
  //   与 manifestProvides 同一模式 —— 角色/效果都以**清单**为准，注册时不能自说自话。
  const manifestEffects = new Map();
  // 注册成功的效果（effectId → { pluginId, fragment }）：只有进这里的 id 才进能力键白名单
  const registeredEffects = new Map();
  /** 当前正在注入脚本的插件 id（register* 靠它认领"这是谁的注册"） */
  let loadingPluginId = '';
  /** 效果表达式长度上限：见 registerEffect 里"超长直接拒"的理由 */
  const MAX_FRAGMENT_CHARS = 2000;
  /** id → { loaded, error, files, ms } 装载状态（排障用） */
  const loadState = new Map();

  /**
   * 插件级 effect 容器：pluginId → [{ kind, label, dispose }]（**注册顺序**，回收时逆序执行）。
   *
   * 为什么要有它：在此之前 register* 只是往宿主表里塞、从不删除，
   *   插件卸载/禁用没有任何可执行的回收动作 —— 插槽一旦能改界面，残留就只能靠人肉排查。
   * 这里给每个插件一份"我注册了什么"的清单，把回收变成一次可验证的批量操作。
   */
  const pluginEffects = new Map();

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
  let slotRegistry = null;

  /**
   * 每个插件在清单里声明的设置项（`plugin.json` 的 settings[]）。
   * 用途：插件 render(props) 要能看到"自己声明的键当前是多少"——
   *   面板侧据此构造 `props.settings`（当前值 ?? 声明默认值），插件不必再自己去猜键名。
   * 缺省空 Map（老插件没声明 settings 时就是空对象，插件侧应容忍）。
   */
  const pluginSettings = new Map();

  /** 登记一个可回收 effect（同一插件按注册顺序追加） */
  function addEffect(pluginId, effect) {
    const id = String(pluginId || '');
    if (!id || !effect || typeof effect.dispose !== 'function') return false;
    const list = pluginEffects.get(id) || [];
    list.push(effect);
    pluginEffects.set(id, list);
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
        window.__SLOT_STATS__ = slotRegistry ? slotRegistry.stats() : null;
      }
    } catch { /* 无 window（node 测试）时忽略 */ }
  }

  /** 把 effect 总数写到 dataset（不新增 dataset 字段族，只加一个计数便于验收） */
  function publishEffectStats() {
    try {
      let total = 0;
      for (const list of pluginEffects.values()) total += list.length;
      document.documentElement.dataset.pluginEffects = String(total);
    } catch { /* 无 DOM（测试环境）时忽略 */ }
  }

  /**
   * 注册被拒：显式记一条 + 可读原因（H2）。
   *
   * 与"静默丢弃"的区别：调用方能拿到 false，日志里能看出**哪个阶段**、**哪个插件**、
   *   **为什么**（异步注册 vs 缺字段），并且 `effectsReport().rejects` 可被测试断言。
   * @param {string} kind register / registerEffect / registerControls
   * @param {string} why 人话原因
   * @param {object} [detail] 附加信息（id / group 等）
   * @returns {false}
   */
  function rejectRegistration(kind, why, detail) {
    const rec = {
      kind, why, at: Date.now(),
      pluginId: loadingPluginId || null,
      likelyOwner: loadingPluginId ? null : (lastLoadedPluginId || null),
      ...(detail || {}),
    };
    registrationRejects.push(rec);
    if (registrationRejects.length > 50) registrationRejects.shift();
    say.warn(`插件注册被拒（${kind}）：${why}${rec.likelyOwner ? `（疑似来自最后装载的插件 ${rec.likelyOwner}）` : ''}`);
    emit('plugin.register-rejected', rec);
    return false;
  }

  /**
   * 内置分组的 title → id 映射（兼容层用）。
   *
   * 为什么从 PANEL_GROUPS 派生而不是写死一张表：老接口传的是**标题**（「设置」），
   *   而插槽名要的是 groupId；写死映射会在加组/改标题时静默失配（这正是本轮要消灭的"两处表达"）。
   * 传进来的本来就是合法 id 时原样返回，方便调用方"标题或 id 都行"。
   * @param {string} name
   * @returns {string|null}
   */
  function groupIdOfTitle(name) {
    const want = String(name || '').trim();
    if (!want) return null;
    if (PANEL_GROUPS.some((g) => String(g.id || '') === want)) return want;
    const hit = PANEL_GROUPS.find((g) => String(g.title || '') === want);
    return hit ? String(hit.id || '') : null;
  }

  /**
   * 老控件声明 → 插槽 spec（兼容层用）。
   *
   * 老接口给的是"数据"，插槽要的是"render 函数"：这里把老形状包成一个返回老形状的 render，
   *   之后统一由 mergeSlotControls → slotSpecToControl 翻译成渲染层 kind（一处翻译，两路共用）。
   * @param {object} raw 老控件声明（{id, kind, label, options, order, ...}）
   * @returns {object|null} 插槽 spec；缺 id 返回 null
   */
  function legacyControlToSlotSpec(raw) {
    const id = String((raw && raw.id) || '').trim();
    if (!id) return null;
    return {
      id,
      label: String((raw && raw.label) || id),
      // 老接口的语义：控件 id 就是个效果 id —— 效果没注册成功时该控件要**置灰 + 给原因**（契约 §9.3）。
      //   转插槽后由 mergeSlotControls 用 registeredEffects 判定，语义与迁移前一致。
      effectId: id,
      // 老接口没有 order 概念：缺省 1000（排在组内内置控件之后），显式给了就尊重
      order: Number.isFinite(Number(raw && raw.order)) ? Number(raw.order) : 1000,
      render: () => ({
        kind: String((raw && raw.kind) || ''),
        options: Array.isArray(raw && raw.options) ? raw.options.slice() : undefined,
        label: String((raw && raw.label) || id),
      }),
    };
  }

  /** /api/plugins 返回的清单快照 */
  let discovered = [];
  let loaded = false;
  /**
   * 进行中的 loadAll（并发去重）。
   * 为什么需要：启动预热与"用户一打开就点资源包"可能同时触发装载，
   *   两路各发一次 /api/plugins、各评估一遍插件，既浪费也会让提供者注册更晚。
   *   这里让后来者复用同一个 Promise：清单只取一次、插件只装载一次。
   */
  let loadingPromise = null;

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

  /** 插件侧可见的宿主面（插件脚本顶层会读 window.SpineViewerPlugins） */
  const hostApi = {
    version: 1,
    /** 插件注册自己：只收有 id 的对象；缺 canHandle/resolve 时保留但标注（供排障） */
    register(plugin) {
      if (!plugin || typeof plugin !== 'object') { say.warn('register 收到非对象，已忽略'); return false; }
      const id = String(plugin.id || '').trim();
      if (!id) { say.warn('register 缺少 id，已忽略'); return false; }
      // 契约 PL2：id 重复必须**拒绝**且不覆盖已注册的那个。
      //   静默 providers.set 覆盖会让"后加载的插件顶掉先加载的"，且排障时看不出发生过覆盖。
      //   保留先注册的实例（先到先得）：它可能已经参与过解析，换掉会留下"半新半旧"的对象。
      if (providers.has(id)) {
        say.warn(`插件 ${id} 重复注册，已忽略（保留先注册的实例）`);
        return false;
      }
      // 角色以**清单**为准（契约 插件契约 §二）：register 上来的对象不覆盖它
      const declared = manifestProvides.get(id) || [];
      const rec = { ...plugin, id, provides: declared.slice() };
      providers.set(id, rec);
      // 登记回收动作：卸载时把 provider 从表里摘掉（只摘自己这一份，别误删后来者）
      addEffect(id, {
        kind: 'provider',
        label: id,
        dispose: () => { if (providers.get(id) === rec) providers.delete(id); },
      });
      const st = loadState.get(id) || { files: 0, ms: 0 };
      loadState.set(id, { ...st, loaded: true, error: null });
      const caps = [];
      if (typeof rec.canHandle === 'function') caps.push('canHandle');
      if (typeof rec.resolve === 'function') caps.push('resolve');
      say.info(`已注册提供者 ${id}（${rec.name || id}）：${caps.join('/') || '无可调用成员'}`);
      try { window.dispatchEvent(new CustomEvent('spineviewer:plugin-registered', { detail: { id } })); } catch { /* 忽略 */ }
      return true;
    },
    fetchFile,
    /**
     * 注册一个渲染效果（契约 §9.2）：只收"作用于当前像素的表达式"，不是完整着色器。
     *
     * 校验三条（任一不满足即注册失败，**不是静默忽略**）：
     *   · id 必须在本插件清单的 effects[].id 里声明过 —— 否则能力键白名单不会认它，
     *     面板能选、渲染层不认，就是"选了没反应"的静默失败；
     *   · fragment 必须是非空字符串；
     *   · id 全局唯一（跨插件也唯一，防两个插件抢同一个 uniform 命名空间）。
     * @param {{id:string, fragment:string}} spec
     * @returns {boolean} 是否注册成功
     */
    registerEffect(spec) {
      const pluginId = loadingPluginId;
      const id = String((spec && spec.id) || '').trim();
      if (!pluginId) {
        return rejectRegistration('registerEffect', '不在脚本装载期（异步注册不被支持：registerEffect 必须在脚本顶层同步调用）', { id });
      }
      if (!id) { say.warn(`registerEffect 缺少 id（插件 ${pluginId}），已忽略`); return false; }
      const declared = (manifestEffects.get(pluginId) || []).some((e) => String(e.id) === id);
      if (!declared) {
        say.warn(`registerEffect(${id}) 未在插件 ${pluginId} 的 effects[] 里声明，已拒绝`);
        return false;
      }
      if (typeof (spec && spec.fragment) !== 'string' || !spec.fragment.trim()) {
        say.warn(`registerEffect(${id}) 的 fragment 为空，已拒绝`);
        return false;
      }
      // 超长直接拒：fragment 会被拼进着色器并在挂载时编译，没有长度闸门就等于
      //   允许插件往渲染链路里塞任意大段代码（编译失败还会连带拖慢首帧）
      if (spec.fragment.length > MAX_FRAGMENT_CHARS) {
        say.warn(`registerEffect(${id}) 的 fragment 过长（${spec.fragment.length} > ${MAX_FRAGMENT_CHARS} 字符），已拒绝`);
        return false;
      }
      if (registeredEffects.has(id)) {
        say.warn(`registerEffect(${id}) 重复注册（已被 ${registeredEffects.get(id).pluginId} 占用），已忽略`);
        return false;
      }
      // uniforms 是插件侧的"参数默认值兜底"（清单 params[].default 的补充口）。
      //   实际每档用哪个值由 effect-chain.uniformsForOption 按档位算，这里只做缺省兜底。
      const uniforms = (spec && spec.uniforms && typeof spec.uniforms === 'object') ? { ...spec.uniforms } : {};
      registeredEffects.set(id, { pluginId, fragment: spec.fragment, uniforms });
      addEffect(pluginId, {
        kind: 'effect',
        label: id,
        dispose: () => registeredEffects.delete(id),
      });
      say.info(`已注册效果 ${id}（插件 ${pluginId}）`);
      return true;
    },
    /**
     * 提交一节面板控件（契约 §9.2）：**只收声明式数据**，宿主负责渲染与存取。
     *
     * 这里只做"收下"，不合并不校验分组/kind —— 那两件事在面板侧合并时统一做
     *   （那里才知道当前有哪些分组、哪些 kind 被允许），拒绝时能记进 diag。
     * @param {{group:string, controls:Array}} section
     * @returns {boolean}
     */
    /**
     * **兼容层**：老接口 `registerControls({group, controls})` —— 内部转成插槽注册。
     *
     * 新插件请直接用 `slots.register('panel.group.<groupId>', { id, render })`；
     *   这里保留是因为它写在契约里（公开面），不能因为"现网没人用"就悄悄删掉。
     *
     * 三条兼容语义（都是老插件能零改动继续工作的前提）：
     *   ① 分组参数是**标题**（「设置」）⇒ 用内置表的 title→id 映射换成 groupId（不写死映射表）
     *   ② 老控件 id **不强制** plugin. 前缀（分组插槽本就不要求前缀）
     *   ③ **隐式声明**：老插件没有 plugin.json 的 slots 字段 ⇒ 视为已声明该分组插槽，
     *      不报 undeclared-slot（否则老插件一升级就全部失效）
     *
     * 迁移后老接口与 slots.register 的控件走**同一条**合并/渲染/回收链路：
     *   登记进同一个 slotRegistry ⇒ disposer 进同一个 effect 容器 ⇒ unloadPlugin 一并回收。
     * @param {{group:string, controls:Array}} section
     * @returns {boolean} 至少成功登记一个控件
     */
    registerControls(section) {
      const pluginId = loadingPluginId;
      if (!pluginId) {
        return rejectRegistration('registerControls', '不在脚本装载期（异步注册不被支持：registerControls 必须在脚本顶层同步调用）', {
          group: String((section && section.group) || ''),
        });
      }
      const groupName = String((section && section.group) || '').trim();
      const controls = Array.isArray(section && section.controls) ? section.controls : null;
      if (!groupName || !controls || !controls.length) {
        say.warn(`registerControls（插件 ${pluginId}）缺少 group 或 controls，已忽略`);
        return false;
      }
      if (!slotRegistry) {
        say.warn(`registerControls（插件 ${pluginId}）失败：插槽注册表尚未就绪`);
        return false;
      }
      // ① 标题 → groupId：内置表派生；传进来的本来就是 id 时原样放过
      const groupId = groupIdOfTitle(groupName) || groupName;
      const slotName = `panel.group.${groupId}`;
      let ok = 0;
      const rejects = [];
      for (const raw of controls) {
        const spec = legacyControlToSlotSpec(raw);
        if (!spec) { rejects.push({ id: (raw && raw.id) || '', reason: '控件缺 id' }); continue; }
        // ②③ 前缀不强制、隐式声明：都靠 implicitDeclare 分支表达
        const dispose = slotRegistry.register(pluginId, slotName, spec, { implicitDeclare: true });
        if (typeof dispose === 'function') {
          // 与 slots.register 完全同一条回收链：disposer 进同一个 effect 容器
          //   （不挂的话 unloadPlugin 只能靠 disposeAll 兜底，统计上会显示"disposed 少、slotsRemoved 多"）
          addEffect(pluginId, { kind: 'slot', label: slotName, dispose });
          ok += 1;
        } else {
          rejects.push({ id: spec.id, reason: '插槽注册被拒（见 stats.rejects）' });
        }
      }
      say.info(`插件 ${pluginId} 提交控件节（兼容层 → 插槽）：分组「${groupName}」→ ${slotName}，成功 ${ok}/${controls.length}`
        + (rejects.length ? `，被拒 ${rejects.length}` : ''));
      publishSlotStats();
      return ok > 0;
    },
    /**
     * 插槽注册（设计 §四）：**只登记、不渲染**（渲染在 S2 接）。
     *
     * 插件侧写法（经典脚本，必须在脚本顶层**同步**调用）：
     *   const dispose = window.ModelStagePlugins.slots.register('panel.group.settings', {
     *     id: 'plugin.<pluginId>.sharpness',  // 必填，必须带插件前缀（设计 §8.2）
     *     order: 100,                          // 可选，列表插槽按它排序（小在前）
     *     label: '清晰度',                      // 必填，诊断与冲突提示都用它
     *     render(props) { return { kind: 'segmented', options: ['关', '轻', '强'] }; },
     *     onAction(action, props) { … },
     *   });
     *
     * 拒绝原因在 stats().rejects 里可读（unknown-slot / slot-not-open / undeclared-slot / risk-mismatch）。
     * @param {string} name 插槽名（见 /api/plugins 的 slotCatalog）
     * @param {object} spec { id, order?, label?, render?, onAction? }
     * @returns {null | (() => void)} disposer（已登记进该插件的 effect 容器，卸载时自动回收）
     */
    slots: {
      register(name, spec) {
        if (!slotRegistry) {
          say.warn('插槽注册失败：注册表尚未就绪（插件清单还没拿到，通常是页面刚启动）');
          return null;
        }
        const dispose = slotRegistry.register(loadingPluginId, name, spec);
        if (typeof dispose === 'function') {
          // 挂进 S1-b1 的 effect 容器 ⇒ unloadPlugin 会连插槽登记一起回收
          addEffect(loadingPluginId, { kind: 'slot', label: String(name), dispose });
        }
        publishSlotStats();
        return dispose;
      },
      /** 只读快照（同时挂到 window.__SLOT_STATS__ 供测试断言） */
      stats: () => (slotRegistry ? slotRegistry.stats() : {
        openStage: 'S1', catalogSize: 0, total: 0, byPlugin: {}, entries: [], rejects: [],
      }),
    },
    /** 提示通道：插件不直接操作 DOM，走这里（同时派发事件给页面其它部分） */
    notify(kind, msg) {
      const level = kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'info';
      say[level](`[插件] ${msg}`);
      try { window.dispatchEvent(new CustomEvent('spineviewer:notify', { detail: { kind, msg } })); } catch { /* 忽略 */ }
    },
  };

  /** 按清单串行注入某插件的全部脚本（顺序即 plugin.json 的 files[] 顺序：lib/* 先、index.js 后） */
  async function loadPlugin(pl) {
    const id = String(pl && pl.id ? pl.id : '');
    if (!id) return;
    const t0 = Date.now();
    loadState.set(id, { loaded: false, error: null, files: 0, ms: 0 });
    loadingPluginId = id;   // 让 register* 知道这次注册属于哪个插件
    const files = Array.isArray(pl.files) ? pl.files : [];
    let okCount = 0;
    for (const f of files) {
      const ok = await injectScript(`${base}/plugins/${f}`);
      if (ok) okCount += 1;
      else {
        const st = loadState.get(id);
        if (st && !st.error) st.error = `脚本加载失败: ${f}`;
      }
    }
    loadingPluginId = '';
    const st = loadState.get(id) || {};
    // 生效判定要分角色（契约 §一 五类角色）：
    //   asset-provider 必须 register() 交出 canHandle/resolve；
    //   只提供 panel 的插件没有 register() 可言，它交的是 effects/controls ——
    //   拿 register() 当唯一成功标志会把它误判成"加载失败"，进而把它的控件也置灰。
    // 生效判定：交出过插槽控件、或注册过效果，都算"这个插件在工作"
    const slotCount = slotRegistry ? (slotRegistry.stats().byPlugin[id] || 0) : 0;
    const didPanelWork = slotCount > 0
      || [...registeredEffects.values()].some((e) => e.pluginId === id);
    const providerOk = providers.has(id);
    const error = st.error || (providerOk || didPanelWork ? null : '脚本已加载但没有调用 register()');
    loadState.set(id, { ...st, loaded: providerOk || didPanelWork, error, files: okCount, ms: Date.now() - t0 });
    lastLoadedPluginId = id;
    if (error) say.warn(`插件 ${id} 未生效：${error}（其余插件与页面不受影响）`);
  }

  /**
   * 卸载一个插件：按**注册逆序**执行它登记的全部 disposer，并把宿主表里的痕迹清干净。
   *
   * 设计取舍：
   *   · disposer 可能抛错（第三方闭包）——单个失败不阻断其余回收，失败项进返回值；
   *   · disposer 之外还有一层兜底清理（控件节按 pluginId 扫一遍、effect/provider 直接删）——
   *     因为"老路径注册的东西没登记 disposer"这种情况在演进期一定存在；
   *   · 结束后派发 `spineviewer:plugins-loaded`，面板侧监听（panel-settings.js:372）会重建，
   *     控件才真的从界面上消失（只摘宿主表不改 DOM 等于没卸载）。
   * @param {string} pluginId
   * @returns {{pluginId:string, disposed:number, failures:string[], removedControls:number, removedEffects:number, hadProvider:boolean}}
   */
  async function unloadPlugin(pluginId) {
    const id = String(pluginId || '');
    const list = pluginEffects.get(id) || [];
    // 先记"卸载前有没有"，再回收：disposer 会把 provider 删掉，之后再查就永远是 false（返回值会误导排障）
    const hadProviderBefore = providers.has(id);
    let disposed = 0;
    const failures = [];
    for (let i = list.length - 1; i >= 0; i -= 1) {      // 逆序：后注册的先撤
      try { list[i].dispose(); disposed += 1; }
      catch (e) { failures.push(`${list[i].kind}:${list[i].label}: ${(e && e.message) || e}`); }
    }
    pluginEffects.delete(id);

    let removedEffects = 0;
    for (const [eid, e] of [...registeredEffects]) {
      if (e && e.pluginId === id) { registeredEffects.delete(eid); removedEffects += 1; }
    }
    const hadProvider = providers.delete(id);
    try { manifestEffects.delete(id); } catch { /* 老版本没有这张表 */ }
    const wk = workerPool.get(id);
    if (wk) {
      try { if (wk.worker) wk.worker.terminate(); } catch { /* 已终止 */ }
      workerPool.delete(id);
    }
    // 插槽登记也要回收：disposer 虽已挂在 effect 容器里，这里按 pluginId 再兜一次
    //   （历史数据/异常路径可能留下没登记 disposer 的项）
    const slotsRemoved = slotRegistry ? slotRegistry.disposeAll(id) : 0;
    publishSlotStats();
    loadState.delete(id);
    publishEffectStats();
    say.info(`插件 ${id} 已卸载：执行 ${disposed} 个 disposer${failures.length ? `（${failures.length} 个失败）` : ''}`
      + `，清掉效果 ${removedEffects} 个、插槽 ${slotsRemoved} 个${hadProvider ? '、提供者 1 个' : ''}`);
    // 让面板重建：只清宿主表不改 DOM 的话，控件会继续挂在界面上（等于没卸载）
    try { window.dispatchEvent(new CustomEvent('spineviewer:plugins-loaded', { detail: { unloaded: id } })); } catch { /* 忽略 */ }
    return { pluginId: id, disposed, failures, removedEffects, slotsRemoved, hadProvider: hadProviderBefore };
  }

  /** 卸载全部已装载插件（测试收尾 / 热重载前清理用） */
  async function unloadAll() {
    const ids = [...new Set([...pluginEffects.keys(), ...providers.keys(), ...loadState.keys()])];
    const out = [];
    for (const id of ids) out.push(await unloadPlugin(id));      // 串行：卸载会改宿主表，别并发
    return out;
  }

  /**
   * 回收清单（可读）：每个插件登记了多少 effect、现在还剩多少控件节/效果/提供者。
   *
   * 为什么需要：本轮界面还没接插槽，但"回收到底发生了没有"必须能被读取（验收与排障都靠它）。
   * @returns {{totalEffects:number, plugins:Array, rejects:Array}}
   */
  function effectsReport() {
    const ids = [...new Set([...pluginEffects.keys(), ...loadState.keys(), ...providers.keys(),
      ...(slotRegistry ? Object.keys(slotRegistry.stats().byPlugin) : [])])];
    const plugins = ids.filter(Boolean).map((id) => {
      const list = pluginEffects.get(id) || [];
      return {
        id,
        effects: list.length,
        kinds: list.map((e) => e.kind),
        slots: slotRegistry ? (slotRegistry.stats().byPlugin[id] || 0) : 0,
        effectsRegistered: [...registeredEffects.values()].filter((e) => e.pluginId === id).length,
        provider: providers.has(id),
        loaded: !!(loadState.get(id) || {}).loaded,
      };
    });
    const totalEffects = [...pluginEffects.values()].reduce((n, l) => n + l.length, 0);
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
    const pl = discovered.find((p) => p && p.id === providerId);
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

  /** 容量探测缓存（60s）；失败时**保守不放行**（reason=fallback），绝不当成"随便解包" */
  let capCache = null;
  const CAP_TTL_MS = 60 * 1000;

  /**
   * 问服务端"这个包现在能预热吗"。判断全在服务端：可用内存**现取** × 0.5 预算 vs 预估峰值，
   * 预热**只看内存**（时间不再是门槛：旧规则"预估 >6s 不预热"会让 15MB 以上的包永远进不了缓存）。\n   * 前端只读 `allowWarmup` 一个布尔，不自己算任何阈值。
   * @param {{rootId: string, rel: string}} file
   * @returns {Promise<{allowWarmup: boolean, reason: string, peakEstMb?: number, budgetMb?: number, estUnpackSec?: number}>}
   */
  async function fetchCapacity(file) {
    const key = `${file.rootId}/${file.rel}`;
    if (capCache && capCache.key === key && Date.now() - capCache.at < CAP_TTL_MS) return capCache.value;
    const fallback = { allowWarmup: false, reason: 'fallback:capacity-unavailable' };
    try {
      const qs = `?rootId=${encodeURIComponent(file.rootId)}&rel=${encodeURIComponent(file.rel)}`;
      const res = await fetch(`/api/unpack/capacity${qs}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(1500) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const value = {
        allowWarmup: j.allowWarmup === true,
        reason: String(j.reason || 'unknown'),
        peakEstMb: j.peakEstMb,
        budgetMb: j.budgetMb,
        estUnpackSec: j.estUnpackSec,
        // 判据显示要贴真实值：可用内存与总内存一起带出来（不在这里重算任何阈值）
        memAvailableMb: j.memAvailableMb,
        memTotalMb: j.memTotalMb,
      };
      capCache = { at: Date.now(), key, value };
      return value;
    } catch {
      capCache = { at: Date.now(), key, value: fallback };
      return fallback;
    }
  }

  /**
   * 预热：**选中即触发**，让服务端把**当前这一个包**解包落盘，供下次命中。
   * 绝不预热整个根（19 个包 × 10s 白烧）。
   *
   * 两条必须：
   *   · 只预热当前包；
   *   · **必打 diag 日志** `unpack.warmup {rootId, rel, sizeMb, skipped?, ms}`，否则"为什么这个包没预热"无从查证。
   * 不加任何时间门槛：能不能预热只由内存准入决定（服务端给 allowWarmup），不看预估耗时、不延迟。
   * @param {{rootId: string, rel: string, size?: number}} file
   */
  function warmup(file) {
    const sizeMb = Number(file && file.size) / 1048576;
    const emitWarm = (extra) => emit('unpack.warmup', { rootId: file && file.rootId, rel: file && file.rel, sizeMb: +sizeMb.toFixed(1), ...extra });
    if (!file || !file.rootId || !file.rel) return;
    // 上限来自服务端（CPU 维度与内存维度取小）；拿不到则保守 12
    fetchCapacity(file).then((cap) => {
      if (!cap.allowWarmup) {
        emitWarm({ skipped: cap.reason, peakEstMb: cap.peakEstMb, budgetMb: cap.budgetMb, estUnpackSec: cap.estUnpackSec });
        say.info(`跳过预热：${file.rel} ${sizeMb.toFixed(1)}MB（${cap.reason}；预估峰值 ${cap.peakEstMb}MB / 预算 ${cap.budgetMb}MB / 预估耗时 ${cap.estUnpackSec}s）`);
        return;
      }
      scheduleWarmup(file, emitWarm, cap);
    }).catch(() => {
      // fetchCapacity 内部已有兜底（allowWarmup=false），这里防御未知异常：保守跳过
      emitWarm({ skipped: 'fallback:capacity-unavailable' });
    });
  }

  /**
   * 在途预热去重：key = `${rootId}/${rel}`。
   *
   * 为什么必须去重：`model-actions` 每次装载都会调 warmup()，同一个模型被装载多次就排多次请求；
   *   而服务端的解包是**串行**的（plugin-store 的 inflight + 队列），后到的那几个全部 join 到
   *   同一个 inflight 上 —— 于是每个都等足同一段时长、每个都被前台的 8.5s 掐断一次、每个再重试一次。
   *   实测（500 条日志那批）：同一个 rel 被重复预热 4~6 次
   *     xukufu_3_hx：ms=1969 / 19933 / 12770 / 18598(hit=true) 四条，全是同一次解包的不同等待者。
   *
   * 为什么"完成即删"而不是"永久记住已预热"：插件版本升级、服务端缓存被清（LRU/手工删目录）之后，
   *   同一个包仍然需要能重新预热 —— 记死就再也不会补了。
   */
  const warmupInflight = new Set();

  /**
   * `phase.name` → 界面措辞（契约 §四 ④：服务端只发 read/resolve/write 三个名字，文案归前端）。
   * 放这一处常量、别散落到各处：措辞变了只改这里，也避免服务端被逼着下发界面文字。
   * 注意**没有百分比**：解压是一次性整段，服务端给不出可信进度，假进度条比没有更糟。
   */
  const WARMUP_PHASE_TEXT = { read: '读盘中', resolve: '解压中', write: '写盘中' };

  /**
   * 真正执行预热：**选中即触发**，不等空闲、不延迟。
   *
   * 为什么删掉了 requestIdleCallback(timeout 3000) + setTimeout(2000)：
   *   那两个限制加起来最坏 5s 后才开始预热，而页面在 9s 就已经要加载同一个包了 ——
   *   首次打开任何新资源，缓存都来不及做好，前端只能自己解一遍（实测 4.3s / 19MB 白花）。
   *   服务端解包是原生能力，不是"抢 CPU 的备选"，不该被推迟到空闲。
   */
  function scheduleWarmup(file, emitWarm, cap) {
    const key = `${file.rootId}/${file.rel}`;
    // 去重命中时**静默返回**（连 diag 也不发）：验收口径是「unpack.warmup 条数 == 不同 rel 个数」，
    //   这里多发一条就等于把噪音从网络层搬到日志层。say 没有 debug 级，所以干脆不说话。
    if (warmupInflight.has(key)) return;
    warmupInflight.add(key);
    (async () => {
      const t0 = performance.now();
      let events = 0;
      try {
        // 预热是**后台**任务，不能借用前台的判失败策略：
        // · 不重试 —— 服务端解包是串行的，重发只会把队列压得更长。postStream 不走 fetchWithRetry，
        //   天生不重试，所以这一条与上一轮定的 `retries: 0` 等价（那条约定的目的不变）。
        // · **不设总时长上限** —— 慢机器解 30s、60s 都属正常。判失败只看「有没有进展」：
        //   postStream 每收到任意一帧（含 ping）就重置停摆计时，连续 15s 无帧才中止（契约 §四）。
        //   上一轮那个 120s 固定上限是"没有进展信号时"的妥协；有了事件流就该撤掉它。
        const j = await postStream('/api/unpack/resolve',
          { rootId: file.rootId, rel: file.rel, allowOverLimit: !memoryGuard.isMemoryGuardOn(), stream: true },
          {
            onEvent: (name, data) => {
              events += 1;
              // 进度只进**现有**日志/状态行，不新造 UI 控件；也不给百分比（服务端给不出可信的）
              if (name === 'queued') say.info(`预热排队中：${file.rel}（前面约 ${Number((data && data.waiting) || 0)} 个）`);
              else if (name === 'start') say.info(`预热开始解包：${file.rel}`);
              else if (name === 'phase') {
                const ph = (data && data.name) || '';
                say.info(`预热${WARMUP_PHASE_TEXT[ph] || `${ph || '进行'}中`}：${file.rel}（${Number((data && data.ms) || 0)}ms）`);
              }
              // ping 不显示：它只用于维持停摆计时（postStream 内部每帧都会重置计时器）
            },
            onStall: () => {
              // 措辞铁律（契约 §四）：这里是"停摆"，不是"超时"
              say.info(`预热停摆（15s 无事件），已放弃等待；服务端仍会解完并写缓存：${file.rel}`);
            },
          });
        emitWarm({
          ok: !!j.ok,
          hit: !!(j && j.hit),
          peakEstMb: cap && cap.peakEstMb,
          ms: Math.round(performance.now() - t0),
          events,
          ...(j && j.reason ? { reason: j.reason } : {}),
        });
        if (j && j.ok) {
          // done 即完成：hit:true（已有缓存）与 hit:false（本次已落盘）都算成功
          say.info(`预热完成：${file.rel}（${j.hit ? '已有缓存' : '已落盘'}，${Math.round(performance.now() - t0)}ms）`);
        } else {
          // 流内 error / 停摆：都只记 info —— 预热失败不是错误，前台装载有自己的路径
          say.info(`后台预热未完成：${file.rel}（${(j && j.message) || (j && j.reason) || '未知原因'}）—— 服务端仍会解完并写缓存，下次命中即可`);
        }
      } catch (e) {
        const why = String((e && e.message) || e).slice(0, 120);
        emitWarm({ ok: false, error: why, events });
        // 预热失败**不是错误**：前台装载有自己的路径（本地解包 / 服务端命中），预热只是"下次更快"。
        //   记 info 不记 error/warn —— 否则每次装载都在日志里刷一条红，把真问题淹掉。
        say.info(`后台预热未完成：${file.rel}（${why}）—— 服务端仍会解完并写缓存，下次命中即可`);
      } finally {
        // 成功/失败/超时都要移除，否则一次失败会让这个 rel 永远不再预热
        warmupInflight.delete(key);
      }
    })();
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

  /**
   * 读启用清单并逐个加载。**任何失败都不抛**：宿主是增强项，不能拖垮页面。
   *
   * 幂等 + 并发去重（装载入口每次都会先调它，热路径必须几乎零成本）：
   *   · 已装载完成 → 直接返回上次结果，不再请求 /api/plugins；
   *   · 正在装载   → 后来者复用同一个 Promise（清单只取一次、插件只评估一次）。
   * 这解决了"页面刚起、插件脚本还在注入时就发起装载"的时序竞争。
   * @returns {Promise<{discovered: number, registered: number}>}
   */
  async function loadAll() {
    if (loaded) return { discovered: discovered.length, registered: countRegistered() };
    if (loadingPromise) return loadingPromise;
    loadingPromise = doLoadAll().finally(() => { loadingPromise = null; });
    return loadingPromise;
  }

  /** 已成功装载（注册提供者）的插件数 */
  function countRegistered() {
    return [...loadState.values()].filter((s) => s.loaded).length;
  }

  /**
   * 按 `/api/plugins` 的响应建插槽注册表（**必须在注入任何插件脚本之前**）。
   *
   * 为什么单独成函数：它要读四类信息（目录 / 每插件声明 / 当前阶段 / 每插件 settings 键），
   *   塞在 doLoadAll 里会把装载流程读断（也过不了"单函数 50 行"的口径）。
   * @param {object} data /api/plugins 响应
   * @param {Array} discovered 本次发现的插件清单
   */
  function initSlotRegistry(data, discovered) {
    const declared = {};
    for (const pl of discovered) {
      const pid = String(pl && pl.id ? pl.id : '');
      declared[pid] = Array.isArray(pl && pl.slots) ? pl.slots : [];
      pluginSettings.set(pid, Array.isArray(pl && pl.settings) ? pl.settings : []);
    }
    slotRegistry = createSlotRegistry({
      catalog: Array.isArray(data && data.slotCatalog) ? data.slotCatalog : [],
      declaredByPlugin: declared,
      // 阶段只信服务端（currentStage）；字段缺失时 normalizeStage 回退 'S1'（过渡兜底）
      openStage: normalizeStage(data && data.currentStage),
      // 内置组 id：新建分组必须带 plugin.<pluginId>. 前缀（设计 §七·一）
      groupIds: new Set(PANEL_GROUPS.map((g) => String(g.id || ''))),
      // spec.setting 校验用：该插件清单里声明过的 settings 键
      settingsKeysOf: (pid) => (pluginSettings.get(String(pid || '')) || []).map((s) => String(s && s.key || '')),
      isInLoadWindow: () => !!loadingPluginId,
      onReject: (rej) => {
        say.warn(`插槽注册被拒（${rej.code}）：${rej.why}`);
        emit('plugin.slot-rejected', rej);
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
      discovered = Array.isArray(data && data.plugins) ? data.plugins : [];
      // 建插槽注册表（**必须在注入任何插件脚本之前**）：目录与"谁声明了什么"都来自这一份响应，
      //   晚一步建就会出现"插件已经能 register、注册表还不存在"的空窗。
      initSlotRegistry(data, discovered);
    } catch (e) {
      say.warn(`插件清单获取失败（页面其余功能不受影响）：${(e && e.message) || e}`);
      return { discovered: 0, registered: 0 };
    }
    if (!discovered.length) {
      say.info('没有启用任何插件（config/plugins.json 可开关）');
      loaded = true;
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
    const scripts = discovered.filter((p) => p && p.builtin !== true && p.runtime !== 'exec');
    const builtinDecls = discovered.filter((p) => p && p.builtin === true);
    const execDecls = discovered.filter((p) => p && p.runtime === 'exec');
    say.info(`发现 ${discovered.length} 个启用插件：${discovered.map((p) => p.id).join(', ')}`
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
      try { await loadPlugin(pl); } catch (e) { say.warn(`插件 ${pl && pl.id} 装载异常：${(e && e.message) || e}`); }
    }
    loaded = true;
    const ok = countRegistered();
    // "未生效"只对账**需要装载代码的**那些：内置声明不参与 register()，算进分母就又造假告警
    say.info(`插件装载完成：需装载 ${scripts.length} 个、注册 ${ok} 个提供者`
      + (ok < scripts.length ? `（${scripts.length - ok} 个未生效，见上方警告）` : ''));
    // 面板侧要知道"插件已经交完声明了" —— 它启动时先建面板，插件是之后异步注入的，
    //   不通知就永远看不到插件控件（实测：控件节收到了，但面板不会自己重建）。
    try {
      window.dispatchEvent(new CustomEvent('spineviewer:plugins-loaded', {
        detail: { discovered: discovered.length, registered: ok, slots: slotRegistry ? slotRegistry.stats().total : 0 },
      }));
    } catch { /* 忽略 */ }
    return { discovered: discovered.length, registered: ok };
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

  /** 排障快照：装载状态 + 已注册提供者 */
  function report() {
    return {
      loaded,
      discovered: discovered.map((p) => p.id),
      providers: [...providers.values()].map((p) => ({
        id: p.id,
        provides: Array.isArray(p.provides) ? p.provides.slice() : [],
        kind: p.kind || null,
        fileKinds: Array.isArray(p.fileKinds) ? p.fileKinds.slice() : [],
        hasCanHandle: typeof p.canHandle === 'function',
        hasResolve: typeof p.resolve === 'function',
      })),
      loadState: [...loadState.entries()].map(([id, s]) => ({ id, ...s })),
    };
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
    slotSections: () => (slotRegistry ? slotRegistry.renderEntries() : []),
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
    isLoaded: () => loaded,
    host: hostApi,
    /**
     * 面板层用：插件提交的控件节（含来源插件 id）。
     * 返回副本，避免面板侧改动污染宿主记录。
     */

    /**
     * 面板层用：**注册成功**的效果 id 列表 —— 能力键白名单的唯一来源（契约 §9.3）。
     * 只声明但没注册成功的不在列表里 ⇒ 对应控件会置灰。
     */
    registeredEffectIds: () => [...registeredEffects.keys()],
    /**
     * 面板层用：已注册效果的完整声明（按**清单 effects[] 声明顺序** = 效果链的叠加顺序）。
     * fragment 给渲染层拼着色器，params 给"档位 → uniform"换算。
     * @returns {Array<{id:string, pluginId:string, fragment:string, label:string, params:Array}>}
     */
    effectDeclarations: () => {
      const out = [];
      for (const [pluginId, list] of manifestEffects.entries()) {
        for (const eff of list || []) {
          const reg = registeredEffects.get(String(eff.id));
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
      const hit = registeredEffects.get(String(effectId));
      return hit ? hit.pluginId : '';
    },
    /** 面板层用：插件装载失败清单（id → error），控件置灰时给出"为什么" */
    pluginFailures: () => [...loadState.entries()]
      .filter(([, st]) => st && st.error)
      .map(([id, st]) => ({ id, error: String(st.error) })),
  };
}
