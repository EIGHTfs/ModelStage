// data/shape-probe.mjs —— 后台形态探测（契约《条目状态与展示归属》§八）
//
// 职责：把"这个容器包到底能不能装"从【点击才知道】变成【不必点击也有结论】。
//   S4 要求"未点击的美术依赖包该行已带 ⚠"，而 catalog 的同步路径**禁止**解析包体
//   （同根数百包会把毫秒级拖成分钟级），所以这件事只能由这里在后台补。
//
// 三条硬约束（写成代码约束，不是靠自觉）：
//   · INV-D7 事件驱动，不是常驻轮询：只有 kick() 被调用时才跑；没有待探测项就**立刻返回**，
//     连计数都不加（S10 的"启动次数 = 0"就是靠这条成立的）。
//   · 跑完即停：一次 kick 处理一批（maxPerRun）就退出，不留任何定时器；剩余条目留在队列里，
//     等下一次触发（下一次 /api/catalog）继续。
//   · 不抢装载资源：同一个进程内**串行**、包里逐个读、包间限速（delayMs），
//     并且单包超过 maxBytes 直接跳过（44MB 级的包解析峰值更高，不能和用户在点的那一发抢内存）。
//
// 写回只填 support（putProbe），绝不覆盖 loadResult —— 那是当事端上报的（INV-D1）。

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

// 与 /api/unpack 的判型**同一份实现**（契约 §八"判定复用"）：
//   本文件在 src/server/data/ ⇒ 项目根要上溯三层
import { probeBundleBytes } from '../../../tool/lib/bundle-probe-node.mjs';
import { providerFingerprintOf, assetFingerprintOf } from './entry-states.mjs';

/** 包间停顿：给装载/解包让路（这些包解析是纯 CPU + IO，连跑会顶满一个核） */
const DEFAULT_DELAY_MS = 250;
/** 单次 kick 最多处理多少个包（跑完即停；余量留给下次触发）。
 *  取小值是为了把"一轮"压到几十秒内 —— 探测是后台补充信息，不该长时间占着 IO。 */
const DEFAULT_MAX_PER_RUN = 8;
/** 单包上限：超过就不探（读进内存 + 解析峰值太高，见文件头"不抢装载资源"） */
const DEFAULT_MAX_BYTES = 96 * 1024 * 1024;
/**
 * 距上一次请求多久算"真空闲"（毫秒），只用于**批次开始**；可用 MODELSTAGE_PROBE_IDLE_GAP_MS 覆盖。
 *
 * 为什么批次开始要保守（2s）：解析已移入 worker（CPU 不占主线程），但它读 40MB 包时
 *   会与 catalog 的 CIFS 扫描抢 IO —— 实测门控太松时 catalog P95 会 +58ms。
 *   批内则改用宽松判据（只要求"没有请求在飞"），否则密集浏览下永远跑不完一批。
 */
const DEFAULT_IDLE_GAP_MS = 2000;
/** 一批最多为"等空闲"耗多久；超时就把剩余条目放回队列，等下次触发（毫秒） */
const DEFAULT_MAX_WAIT_MS = 20000;
/** 等空闲时的轮询步长：越短越容易抢到刚出现的空隙，代价是空转次数更多 */
const WAIT_STEP_MS = 200;

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (typeof t.unref === 'function') t.unref(); });

/**
 * 造一个后台形态探测器。
 *
 * @param {{
 *   catalog: {takeProbeKeys: Function, requeueProbeKey: Function},
 *   entryStates: {putProbe: Function},
 *   providers: () => Array<{id: string, version?: unknown}>,
 *   readConfig: () => Array<{id: string, path: string}>,
 *   log?: Function,
 *   delayMs?: number, maxPerRun?: number, maxBytes?: number,
 * }} opts
 */
export function createShapeProbe(opts = {}) {
  const { catalog, entryStates } = opts;
  const providers = typeof opts.providers === 'function' ? opts.providers : () => [];
  const readConfig = typeof opts.readConfig === 'function' ? opts.readConfig : () => [];
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const delayMs = Number.isFinite(opts.delayMs) ? Number(opts.delayMs) : DEFAULT_DELAY_MS;
  const maxPerRun = Number.isFinite(opts.maxPerRun) ? Number(opts.maxPerRun) : DEFAULT_MAX_PER_RUN;
  const maxBytes = Number.isFinite(opts.maxBytes) ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES;
  // 判型函数可注入：默认用与 /api/unpack 同一份实现；测试里换成假实现就能在
  //   不造真实 UnityFS 包的前提下验证"写回 unsupported / unknown"的分支（契约 §八）。
  const probeBytes = typeof opts.probeBytes === 'function' ? opts.probeBytes : probeBundleBytes;
  // 请求活跃度探针（由 serve.mjs 注入）：{ idle(), msSinceLastRequest() }。
  //   没有它时退化成"永远空闲"（单测/脚本里就是这么用的），行为与从前一致。
  const activity = opts.activity && typeof opts.activity === 'object' ? opts.activity : null;
  const idleGapMs = Number.isFinite(opts.idleGapMs) ? Number(opts.idleGapMs) : DEFAULT_IDLE_GAP_MS;
  const maxWaitMs = Number.isFinite(opts.maxWaitMs) ? Number(opts.maxWaitMs) : DEFAULT_MAX_WAIT_MS;
  // 解析放 worker（第 3 步）：只对"真实解析"生效。测试注入了假判型函数时直接同步跑，
  //   不起线程（既省资源，也让用例保持确定性）。
  const useWorker = opts.worker !== false && typeof opts.probeBytes !== 'function';
  /** worker 句柄：按批创建/销毁（跑完即停，不留常驻线程） */
  let worker = null;
  /** worker 起不来（环境不允许）时置位：之后一律回落同步解析，不再反复尝试 */
  let workerBroken = false;
  let workerSeq = 0;
  /** 待回包的请求：id → {resolve, reject} */
  const workerPending = new Map();

  /**
   * 计数（S10 的佐证：指纹没变时 runs 必须一直是 0）。
   *
   * 后四个字段是给"将来面板显示进度"预留的（本次不做 UI）：
   *   lastTrigger    本轮是谁触发的：catalog（清单重建）/ fingerprint（指纹变了）/ manual（手动）
   *   lastBatchMs    上一轮耗时（ms）
   *   lastQueueAfter 上一轮跑完后仍排队的条目数（>0 说明还要等下次触发）
   * 字段只增不改 ⇒ GET /api/entries/probe 的形状对既有消费方保持兼容。
   */
  const stats = {
    runs: 0, probed: 0, unsupported: 0, unknown: 0, skipped: 0,
    lastRunAt: null, lastRootId: null,
    lastTrigger: null, lastBatchMs: null, lastQueueAfter: null,
    // 空闲门控的观测值（本轮为"不抢主线程"新增）：让路次数 / 累计等待毫秒
    deferred: 0, waitedMs: 0,
    // 超过单包上限而跳过的包数（保持 unknown，留待点击验证）
    skippedBig: 0,
  };
  /** 进行中的那一轮（同一时刻只允许一轮：串行是硬约束，多个 kick 合并成一个） */
  let running = null;
  /** 触发来源白名单（三选一，别混成一条 —— 排查时要能分清"谁让它跑的"） */
  const TRIGGERS = new Set(['catalog', 'fingerprint', 'manual']);

  /**
   * 取（必要时创建）解析 worker。
   * unref() 是必须的：worker 不该阻止进程退出（否则 Ctrl-C 停服务时要多等一轮）。
   * @returns {Worker|null} null = 不可用（调用方回落同步解析）
   */
  function startWorker() {
    if (!useWorker || workerBroken) return null;
    if (worker) return worker;
    try {
      worker = new Worker(new URL('./shape-probe-worker.mjs', import.meta.url));
      if (typeof worker.unref === 'function') worker.unref();
      worker.on('message', (m) => {
        const p = workerPending.get(m && m.id);
        if (!p) return;
        workerPending.delete(m.id);
        if (m.ok) p.resolve(m);
        else p.reject(new Error(m.error || 'worker 解析失败'));
      });
      worker.on('error', (e) => {
        workerBroken = true;                       // 一次失败就永久回落，避免每包都踩一次
        for (const p of workerPending.values()) p.reject(e);
        workerPending.clear();
      });
      worker.on('exit', () => { worker = null; });
    } catch {
      workerBroken = true;
      worker = null;
    }
    return worker;
  }

  /** 收掉 worker（一批结束就销毁：不留常驻线程，也就没有"后台偷偷占 CPU"） */
  async function stopWorker() {
    if (!worker) return;
    const w = worker;
    worker = null;
    for (const p of workerPending.values()) p.reject(new Error('worker 已停止'));
    workerPending.clear();
    try { await w.terminate(); } catch { /* 已经退出，忽略 */ }
  }

  /**
   * 在 worker 里探一个包的形态（主线程只等消息，不做 CPU）。
   * @param {string} abs 绝对路径
   * @returns {Promise<{assetDependency: boolean, dependencyReason: string|null}>}
   */
  function probeInWorker(abs) {
    const w = startWorker();
    if (!w) return Promise.reject(new Error('worker 不可用'));
    const id = (workerSeq += 1);
    return new Promise((resolve, reject) => {
      workerPending.set(id, { resolve, reject });
      try { w.postMessage({ id, abs }); } catch (e) { workerPending.delete(id); reject(e); }
    });
  }

  /**
   * 同步兜底：worker 不可用时在主线程解析（旧行为）。
   * @param {string} abs 绝对路径
   * @returns {{assetDependency: boolean, dependencyReason: string|null}}
   */
  function probeInline(abs) {
    const shape = probeBytes(new Uint8Array(fs.readFileSync(abs)));
    return {
      assetDependency: !!(shape && shape.assetDependency),
      dependencyReason: (shape && shape.dependencyReason) || null,
    };
  }

  /**
   * 批内判据（比 isIdleNow 宽）：**当前没有请求在飞**就继续。
   *
   * 为什么不要求同样的静默间隔：一批 8 个包，若每个包前都等一次完整静默，
   *   遇到"用户每隔几秒点一下"的节奏就永远跑不完一批（实测吞吐掉到旧行为的 40%）。
   *   而"有请求在飞时绝不动手"已经足以避免把 CPU/IO 从用户手里抢走。
   * @returns {boolean}
   */
  function noRequestInFlight() {
    if (!activity) return true;
    try {
      return typeof activity.idle === 'function' ? !!activity.idle() : true;
    } catch {
      return true;
    }
  }

  /**
   * 此刻是否"真空闲"：没有短请求在飞，且距上次请求已过 idleGapMs。
   *
   * 为什么要求"再等一会儿"而不只是"当前空闲"：请求之间常只隔几十毫秒，
   *   解析一开始就正好撞上新请求 —— 那正是用户感到"某个请求莫名慢半秒"的来源。
   * @returns {boolean}
   */
  function isIdleNow() {
    if (!activity) return true;
    try {
      const idle = typeof activity.idle === 'function' ? !!activity.idle() : true;
      const gap = typeof activity.msSinceLastRequest === 'function'
        ? Number(activity.msSinceLastRequest()) : idleGapMs;
      return idle && Number.isFinite(gap) && gap >= idleGapMs;
    } catch {
      // 探针本身出错不该让探测停摆（旁路原则）
      return true;
    }
  }

  /**
   * 等到"真空闲"，最多等 budgetMs。
   * @param {number} budgetMs 预算（ms）
   * @returns {Promise<boolean>} true = 已空闲；false = 预算耗尽（调用方应让路，别硬跑）
   */
  async function waitUntilIdle(budgetMs) {
    if (!activity) return true;
    const deadline = Date.now() + budgetMs;
    while (!isIdleNow()) {
      if (Date.now() >= deadline) return false;
      await sleep(WAIT_STEP_MS);
      stats.waitedMs += WAIT_STEP_MS;
    }
    return true;
  }

  /**
   * 触发一次探测（不阻塞调用方：catalog 的读路径只负责"喊一声"）。
   * @param {string} [rootId] 触发来源的根（仅用于日志/计数，队列本身跨根共享）
   * @param {'catalog'|'fingerprint'|'manual'} [trigger] 触发来源；非法值按 catalog 处理
   * @returns {Promise<{probed: number}>|null} 已在跑时返回那一轮的 promise
   */
  function kick(rootId, trigger = 'catalog') {
    if (!catalog || !entryStates) return null;
    if (running) return running;                 // 合并触发：事件驱动，不叠加并发
    const why = TRIGGERS.has(trigger) ? trigger : 'catalog';
    running = runOnce(rootId, why).catch((e) => {
      // 旁路：探测失败绝不能影响任何主流程（INV-D3 同源思想）
      log('warn', '后台形态探测异常（不影响装载）', { err: (e && e.message) || String(e) });
      return { probed: 0 };
    }).finally(() => { running = null; });
    return running;
  }

  /**
   * 一轮：取一批 → 逐个判 → 写回 → 停（并留下三条可读日志：启动 / 完成 / 仍有剩余）。
   * @param {string} [rootId] 触发来源的根（只用于日志与统计，队列本身跨根共享）
   * @param {'catalog'|'fingerprint'|'manual'} trigger 触发来源（三选一，排查时要能分清）
   */
  async function runOnce(rootId, trigger) {
    // 先看有没有活（纯内存读，零代价）：没活就立刻返回。
    //   顺序很重要 —— 先等空闲再发现"其实没东西可探"，会让 running 白占住 maxWaitMs，
    //   期间所有新的触发都被合并掉（实测：空队列也会显示 running=true 二十秒）。
    const hasWork = typeof catalog.probeQueueSize === 'function' ? catalog.probeQueueSize() > 0 : true;
    if (!hasWork) return { probed: 0 };
    // 空闲门控（第 1 步）：忙的时候**连队列都不取** —— 取走再放回是白折腾，
    //   而且"取了不放"会让条目在下次触发前处于"既不排队也不探"的夹缝里。
    if (activity && !(await waitUntilIdle(maxWaitMs))) {
      stats.deferred += 1;
      log('info', `后台形态探测让路 · 等待 ${maxWaitMs}ms 仍有请求在忙，本轮不启动`, {
        trigger, deferred: stats.deferred, waitedMs: stats.waitedMs,
      });
      return { probed: 0 };
    }
    const keys = catalog.takeProbeKeys(maxPerRun);
    // 零待探测 ⇒ **完全不启动**：不读盘、不加计数、不写日志噪音（S10）
    if (!keys.length) return { probed: 0 };

    const t0 = Date.now();
    // 取走这一批之后还剩多少（"剩余待探"的口径：排队中，不含本轮这 N 个）
    const queueAfterTake = typeof catalog.probeQueueSize === 'function' ? catalog.probeQueueSize() : null;
    stats.runs += 1;
    stats.lastRunAt = t0;
    stats.lastRootId = rootId || null;
    stats.lastTrigger = trigger;
    // ① 启动：触发来源 + 本轮批量 + 排队剩多少（三者分开写，别混成一句）
    log('info', `后台形态探测启动 · 触发=${trigger} · 本轮 ${keys.length} 个包 · 排队剩 ${queueAfterTake ?? '?'}`, {
      rootId: rootId || null, trigger, runs: stats.runs, batch: keys.length, queue: queueAfterTake,
    });

    const fp = providerFingerprintOf(providers());
    const roots = new Map();
    for (const r of readConfig() || []) {
      if (r && r.id && r.path) roots.set(String(r.id), String(r.path));
    }

    const out = await probeBatch(keys, providerFingerprintOf(providers()), rootPathMap(), trigger);

    // 计数在**一处**累加（probeOne 只回报结论种类，不自己改全局计数 —— 免得两处各加一遍）
    stats.probed += out.probed;
    stats.unsupported += out.unsupported;
    stats.unknown += out.unknown;
    const queueLeft = queueSize();
    stats.lastBatchMs = Date.now() - t0;
    stats.lastQueueAfter = queueLeft;

    // ② 完成：本轮结果分类 + 耗时 + 剩余（让路时额外说明"放回了几个"）
    log('info', `后台形态探测完成 · 本轮 ${out.probed}/${keys.length} · unsupported ${out.unsupported} · unknown ${out.unknown} · 跳过 ${stats.skipped} · 排队剩 ${queueLeft ?? '?'} · 耗时 ${stats.lastBatchMs}ms`
      + (out.yielded ? ` · 让路放回 ${out.yielded} 个` : ''), {
      trigger, probed: out.probed, unsupported: out.unsupported, unknown: out.unknown,
      queue: queueLeft, ms: stats.lastBatchMs, yielded: out.yielded,
    });
    // ③ 仍有剩余：明确说明"为什么停了"（跑完即停是设计，不是卡住）
    if (queueLeft) {
      log('info', `后台形态探测暂停 · 排队还剩 ${queueLeft} 个（跑完即停，等下次触发继续）`, { trigger, queue: queueLeft });
    }
    return { probed: out.probed };
  }

  /** 当前待探测队列深度（拿不到给 null，日志显示 '?'） */
  function queueSize() {
    return typeof catalog.probeQueueSize === 'function' ? catalog.probeQueueSize() : null;
  }

  /** rootId → 绝对路径（每批取一次；别塞进逐包循环里） */
  function rootPathMap() {
    const m = new Map();
    for (const r of readConfig() || []) {
      if (r && r.id && r.path) m.set(String(r.id), String(r.path));
    }
    return m;
  }

  /**
   * 解析一批：逐个探 → 累计本轮分类；遇到"有请求在飞"就把剩余放回队列并收手。
   *
   * 为什么单独成函数：runOnce 只管门控/取批/收尾日志，解析循环独立出来
   *   才读得动（也才不会被"函数过长"卡住）。
   * @param {string[]} keys 本批条目
   * @param {string} fp 当前提供者指纹
   * @param {Map<string,string>} roots rootId → 绝对路径
   * @param {'catalog'|'fingerprint'|'manual'} trigger 触发来源（只进日志）
   * @returns {Promise<{probed: number, unsupported: number, unknown: number, yielded: number}>}
   */
  async function probeBatch(keys, fp, roots, trigger) {
    let probed = 0;
    let unsupported = 0;
    let unknown = 0;
    let yielded = 0;
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      // 批内也要让路：一批 8 个包跑十几秒，中途用户来请求了就该停手（已探的结论已写回，不浪费）。
      //   判据用"无请求在飞"（不含静默间隔）—— 否则密集浏览下永远跑不完一批。
      if (activity && !noRequestInFlight()) {
        const rest = keys.slice(i);
        for (const k of rest) catalog.requeueProbeKey(k);
        yielded = rest.length;
        log('info', `后台形态探测让路 · 有请求在忙，剩余 ${rest.length} 个包放回队列`, {
          trigger, yielded, waitedMs: stats.waitedMs,
        });
        break;
      }
      try {
        const kind = await probeOne(key, fp, roots);
        if (kind === 'unsupported') { probed += 1; unsupported += 1; }
        else if (kind === 'unknown') { probed += 1; unknown += 1; }
      } catch (e) {
        // 单个包出错不能带走整轮：记日志、把 key 放回队列（下一轮再试）
        stats.skipped += 1;
        catalog.requeueProbeKey(key);
        log('warn', '形态探测失败（该条保持原结论）', { key, err: (e && e.message) || String(e) });
      }
      if (delayMs > 0) await sleep(delayMs);     // 包间限速：不顶满 CPU/IO
    }
    return { probed, unsupported, unknown, yielded };
  }

  /**
   * 探一个包并写回结论（读盘+解析在 worker，worker 不可用时同步回落）。
   * @param {string} key `${rootId}/${rel}`
   * @param {string|null} fp 当前提供者指纹（写回时一起落库，否则下次读取又判过期 —— 白探）
   * @param {Map<string,string>} roots rootId → 绝对路径
   * @returns {Promise<'unsupported'|'unknown'|null>} 结论种类；null = 没探（文件不在/键不合法）
   */
  async function probeOne(key, fp, roots) {
    const s = String(key || '');
    const i = s.indexOf('/');
    if (i <= 0) return null;
    const rootId = s.slice(0, i);
    const rel = s.slice(i + 1);
    const base = roots.get(rootId);
    if (!base || !rel) return null;

    const abs = path.join(base, rel);
    let size = null;
    try {
      const st = await fs.promises.stat(abs);
      if (!st.isFile()) return null;
      size = st.size;
    } catch {
      // 文件不在了（被移走/改名）：不写结论，也不重排队 —— 下次扫描它就不在列表里了
      return null;
    }
    if (size > maxBytes) {
      // 太大的包不探（内存/阻塞风险），但**要记一条"探过没结论"**，否则每次启动都会重试它。
      //   unknown 是合法状态：点击装载时仍会得到真实结论（探测不是必须给答案）。
      entryStates.putProbe(s, { result: 'unknown', message: null }, { providerFingerprint: fp, assetFingerprint: assetFingerprintOf(size) });
      stats.skippedBig += 1;
      log('info', `形态探测跳过（包太大，留待点击验证）· ${Math.round(size / 1024 / 1024)}MB > 上限 ${Math.round(maxBytes / 1024 / 1024)}MB`, {
        key: s, size, maxBytes,
      });
      return 'unknown';
    }

    // 解析：优先走 worker（主线程不参与 CPU）—— 这是"不阻塞事件循环"的关键一步。
    //   worker 起不来（受限环境）或中途报错时回落同步解析：探测可以慢，但结论不能丢。
    let shape = null;
    if (useWorker && !workerBroken) {
      try {
        shape = await probeInWorker(abs);
      } catch {
        shape = probeInline(abs);
      }
    } else {
      shape = probeInline(abs);
    }
    const assetFingerprint = assetFingerprintOf(size);

    if (shape && shape.assetDependency) {
      // 判据与文案都来自 src/shared/bundle-shape.mjs（与点击装载失败同源）⇒ S4 的"文案同源"
      entryStates.putProbe(s, {
        result: 'unsupported',
        reason: 'asset-dependency',
        message: shape.dependencyReason,
      }, { providerFingerprint: fp, assetFingerprint });
      return 'unsupported';
    }

    // 探不出/正常包 ⇒ **保持 unknown，不写 unsupported**（契约 §八"不猜内容"）。
    //   但必须落一条 result:'unknown'：它既是"探过了"的凭据（S10 零开销），
    //   也保证下一次读取不再把它当"没结论"重复排队。
    entryStates.putProbe(s, { result: 'unknown', message: null }, { providerFingerprint: fp, assetFingerprint });
    return 'unknown';
  }

  return {
    kick,
    /** 计数快照（S10 验收：指纹未变时 runs 必须是 0） */
    stats: () => ({ ...stats }),
    /** 是否有一轮在跑（诊断用） */
    isRunning: () => !!running,
    /**
     * 关闭常驻的解析线程 —— **持有者必须调用**。
     *
     * 为什么必须有它：worker 为了"跨批复用"（否则每批重建解析沙箱，一批从 4.5s 涨到 76s）
     *   会留在进程里。`unref()` 只能让它不单独撑住进程，**挡不住** `worker.on('message')`
     *   这类监听把事件循环 hold 住 —— 实测表现：6 条用例全过、`node --test` 却永不退出
     *   （被超时杀掉，退出码 124）。
     *
     * 三个必须调用的地方（漏一处就留悬挂线程）：
     *   · 服务进程收尾：SIGINT/SIGTERM（serve.mjs 的 registerShutdown）
     *   · 测试用例收尾：finally / t.after
     *   · 临时脚本用完
     * @returns {Promise<void>}
     */
    close: async () => { await stopWorker(); },
  };
}
