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

  /** 计数（S10 的佐证：指纹没变时 runs 必须一直是 0） */
  const stats = { runs: 0, probed: 0, unsupported: 0, unknown: 0, skipped: 0, lastRunAt: null, lastRootId: null };
  /** 进行中的那一轮（同一时刻只允许一轮：串行是硬约束，多个 kick 合并成一个） */
  let running = null;

  /**
   * 触发一次探测（不阻塞调用方：catalog 的读路径只负责"喊一声"）。
   * @param {string} [rootId] 触发来源的根（仅用于日志/计数，队列本身跨根共享）
   * @returns {Promise<{probed: number}>|null} 已在跑时返回那一轮的 promise
   */
  function kick(rootId) {
    if (!catalog || !entryStates) return null;
    if (running) return running;                 // 合并触发：事件驱动，不叠加并发
    running = runOnce(rootId).catch((e) => {
      // 旁路：探测失败绝不能影响任何主流程（INV-D3 同源思想）
      log('warn', '后台形态探测异常（不影响装载）', { err: (e && e.message) || String(e) });
      return { probed: 0 };
    }).finally(() => { running = null; });
    return running;
  }

  /** 一轮：取一批 → 逐个判 → 写回 → 停 */
  async function runOnce(rootId) {
    const keys = catalog.takeProbeKeys(maxPerRun);
    // 零待探测 ⇒ **完全不启动**：不读盘、不加计数、不写日志噪音（S10）
    if (!keys.length) return { probed: 0 };

    stats.runs += 1;
    stats.lastRunAt = Date.now();
    stats.lastRootId = rootId || null;
    log('info', `后台形态探测启动（本轮 ${keys.length} 个包）`, { rootId: rootId || null, runs: stats.runs });

    const fp = providerFingerprintOf(providers());
    const roots = new Map();
    for (const r of readConfig() || []) {
      if (r && r.id && r.path) roots.set(String(r.id), String(r.path));
    }

    let probed = 0;
    for (const key of keys) {
      try {
        if (await probeOne(key, fp, roots)) probed += 1;
      } catch (e) {
        // 单个包出错不能带走整轮：记日志、把 key 放回队列（下一轮再试）
        stats.skipped += 1;
        catalog.requeueProbeKey(key);
        log('warn', '形态探测失败（该条保持原结论）', { key, err: (e && e.message) || String(e) });
      }
      if (delayMs > 0) await sleep(delayMs);     // 包间限速：不顶满 CPU/IO
    }
    stats.probed += probed;
    log('info', `后台形态探测完成（本轮 ${probed}/${keys.length}）`, { runs: stats.runs, unsupported: stats.unsupported, unknown: stats.unknown });
    return { probed };
  }

  /**
   * 探一个包并写回结论。
   * @param {string} key `${rootId}/${rel}`
   * @param {string|null} fp 当前提供者指纹（写回时一起落库，否则下次读取又判过期 —— 白探）
   * @param {Map<string,string>} roots rootId → 绝对路径
   * @returns {Promise<boolean>} 是否真的探了一轮（跳过返回 false）
   */
  async function probeOne(key, fp, roots) {
    const s = String(key || '');
    const i = s.indexOf('/');
    if (i <= 0) return false;
    const rootId = s.slice(0, i);
    const rel = s.slice(i + 1);
    const base = roots.get(rootId);
    if (!base || !rel) return false;

    const abs = path.join(base, rel);
    let size = null;
    try {
      const st = await fs.promises.stat(abs);
      if (!st.isFile()) return false;
      size = st.size;
    } catch {
      // 文件不在了（被移走/改名）：不写结论，也不重排队 —— 下次扫描它就不在列表里了
      return false;
    }
    if (size > maxBytes) {
      // 太大的包不探（内存争用），但**要记一条"探过没结论"**，否则每次启动都会重试它
      entryStates.putProbe(s, { result: 'unknown', message: null }, { providerFingerprint: fp, assetFingerprint: assetFingerprintOf(size) });
      stats.unknown += 1;
      return true;
    }

    // 异步读：本模块跑在服务进程里，同步读 40MB+ 会把事件循环钉住数秒
    //   （表现：探测期间页面所有请求一起卡）。解析仍是同步 CPU，但一次只有一个包。
    const bytes = new Uint8Array(await fs.promises.readFile(abs));
    const shape = probeBytes(bytes);
    const assetFingerprint = assetFingerprintOf(size);

    if (shape && shape.assetDependency) {
      // 判据与文案都来自 src/shared/bundle-shape.mjs（与点击装载失败同源）⇒ S4 的"文案同源"
      entryStates.putProbe(s, {
        result: 'unsupported',
        reason: 'asset-dependency',
        message: shape.dependencyReason,
      }, { providerFingerprint: fp, assetFingerprint });
      stats.unsupported += 1;
      return true;
    }

    // 探不出/正常包 ⇒ **保持 unknown，不写 unsupported**（契约 §八"不猜内容"）。
    //   但必须落一条 result:'unknown'：它既是"探过了"的凭据（S10 零开销），
    //   也保证下一次读取不再把它当"没结论"重复排队。
    entryStates.putProbe(s, { result: 'unknown', message: null }, { providerFingerprint: fp, assetFingerprint });
    stats.unknown += 1;
    return true;
  }

  return {
    kick,
    /** 计数快照（S10 验收：指纹未变时 runs 必须是 0） */
    stats: () => ({ ...stats }),
    /** 是否有一轮在跑（诊断用） */
    isRunning: () => !!running,
  };
}
