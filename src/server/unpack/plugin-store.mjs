// plugin-store.mjs —— 解包产物的落盘缓存（17b 第二步：指纹 / 原子写 / LRU / 并发去重 / stats）
//
// 目录布局（与方案一致）：
//   data/unpacked/<fingerprint>/index.json       元信息 + 文件清单 + 源文件 stat 快照
//   data/unpacked/<fingerprint>/files/<relPath>  插件产物原样落盘
//
// 四条设计要点：
//   1. **指纹用 stat 不用内容 hash**：42MB 每次 sha256 要 ~200ms，而 mtime/size 一变就该弃用；
//      指纹里还含 pluginId + pluginVersion（插件升级后产物可能变，必须自然失效）。
//      index.json 里另存 source 的 size/mtimeMs，读缓存时**再 stat 比对一次**（防指纹碰撞/手工改名）。
//   2. **原子写**：先落到 `data/unpacked/.tmp-<fp>-<pid>-<rand>/`，全部成功再 rename 成 <fp>；
//      中途失败删 tmp。绝不出现"半个目录被当成命中"。
//   3. **并发**：同一 fp 的并发请求共用同一个 Promise（in-flight 去重）+ 全局串行队列（解包吃满一核，
//      串行避免多核抢渲染——首次加载时页面还在渲染，实测单份解包已把 12fps 压到 8fps）。
//   4. **清理直接删，不进 .trash**：这是**可重建缓存**不是用户数据；进回收站等于占双份空间。
//      安全删除纪律针对不可重建的数据，这里破例，理由写在此处以免后人以为是漏了。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runnerInfo, providerFingerprint } from './plugin-runner.mjs';
import { checkUnpackMemory } from './capacity.mjs';
import { estimateMemoryOf } from './plugin-runner.mjs';
// 解包（含 vm 沙盒装载、原子落盘、probe 写入）整段跑在 worker 里 —— 主线程只做准入与索引维护。
//   这四个模块是"单一实现"：worker 与主线程共用，不在两边各写一份。
import { createProbeStore } from './probe-store.mjs';
import { rssNow } from './mem-probe.mjs';
import { createUnpackWorkerClient } from './worker-client.mjs';

/** 1MB 的字节数（下面多处换算用；写成常量避免 1048576 散落） */
const BYTES_PER_MB = 1024 * 1024;

/** 缓存上限（可用 config 覆盖；4GB 可用内存 / 磁盘都在这个量级以内安全） */
const DEFAULT_LIMITS = { maxDirs: 20, maxBytes: 8 * 1024 * 1024 * 1024 };

/** 清理解包的节流间隔：resolve 后最多 10 分钟扫一次目录 */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/** 读单个插件目录的版本号（读不到就用 0，不阻塞） */
function versionOfPluginDir(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8');
    const m = /"version"\s*:\s*("?)([^",\s]+)\1/.exec(text);
    return m ? m[2] : '0';
  } catch {
    return '0';
  }
}

/**
 * 指纹里的 pluginVersion。
 *
 * 为什么可能是"插件根"而不是单个插件目录：解包插件不止一个（live2d / spine 各一个，
 * 都声明 provides:['asset-provider']）。若只读某一个插件的版本，另一个升级时缓存不会失效，
 * 表现是"改了插件但产物还是旧的"——比崩溃更隐蔽。
 * 所以传插件根时把每个子目录的版本汇总成一个串：任一个升级都会让整串变化。
 * @param {string} dir 插件目录，或含多个插件的插件根
 * @returns {string}
 */
function pluginVersion(dir) {
  // 自身就是插件目录（有 plugin.json）⇒ 单个版本，保持既有行为
  if (fs.existsSync(path.join(dir, 'plugin.json'))) return versionOfPluginDir(dir);
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${e.name}@${versionOfPluginDir(path.join(dir, e.name))}`)
      .sort()
      .join('+') || '0';
  } catch {
    return '0';
  }
}

/** 递归统计目录占用（清理时用） */
function dirBytes(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(p);
    else {
      try { total += fs.statSync(p).size; } catch { /* 并发删除中，忽略 */ }
    }
  }
  return total;
}

/**
 * 创建解包缓存。
 * @param {{rootDir: string, pluginDir: string, enqueue?: Function, limits?: object}} opts
 *   enqueue：外部串行队列（serve.mjs 传 backgrounds 的 enqueue，复用同一把锁）；不传则内部自建
 */
/**
 * 安全地问一次「插件声明的峰值」——**任何异常都必须被吞掉**。
 *
 * 为什么必须有这个兜底：这一步跑在**准入热路径**上（每次缓存未带声明时都会走到）。
 *   插件可能被卸载、被开关关掉、版本不匹配、blocksSummary 在中途抛错……
 *   准入判断挂掉比"估得不准"严重得多：前者是**整个加载流程直接失败**，后者只是这一次被拒/放行。
 *   ⇒ 问不到就返回 null，让调用方退回缓存里的值（再退就到 legacy 的源包大小粗估）。
 *
 * 为什么是"现场问"而不是"把 peakBytes 持久化进 probe.json"：
 *   插件峰值表会随版本更新（标定口径、样本都会变），持久化的 peakBytes 会悄悄变陈旧；
 *   而一旦陈旧又没有任何机制去失效它 —— 那就成了"同一事实的第二处表达"，正是项目里反复踩的漂移坑。
 *   现场问的代价是只读块表（P90 < 1ms，实测 P50 0.13ms），完全可接受，
 *   换来的是"声明值永远等于插件当前表"。⇒ 不要"顺手优化成缓存下来"，那会把安全修变回不安全。
 *
 * @param {object} req {rootId, rel, absPath}
 * @param {Function} [askFn] 注入点（默认 estimateMemoryOf；单测用它注入会抛错的实现）
 * @returns {object|null} 插件声明；问不到/抛错都返回 null
 */
export function askDeclaredSafely(req, askFn = estimateMemoryOf) {
  try {
    const declared = askFn(req);
    return declared && declared.decompressedBytes > 0 ? declared : null;
  } catch {
    return null;   // 插件不可用/卸载/解析抛错 ⇒ 兜底，绝不向上抛
  }
}

/**
 * 把"缓存的实测值"与"现场问到的声明值"合成一份准入用的内存声明。
 *
 * 合并方向：cached 在前、est 在后 —— 解压量以本次探测为准，
 *   而 cached 里的 measuredPeakBytes / samples 等字段必须保留（它们是"实测回填"的累积状态）。
 * 问不到声明（est 为空）⇒ **原样返回 cached**，让准入走 legacy 的源包大小粗估。
 *
 * @param {object|null} cached readProbe 的结果
 * @param {object|null} est askDeclaredSafely 的结果
 * @returns {object|null}
 */
export function mergeDeclared(cached, est) {
  if (!est) return cached;
  return { ...(cached || {}), ...est, probeAt: Date.now() };
}

export function createUnpackStore(opts) {
  // 配置错必须在入口崩：否则 undefined 会一路变成下游的 "path argument must be a string"，
  //   堆栈指不到真正的错处（本项目已多次踩过"错在 A、报在 Z"）。
  if (typeof (opts || {}).rootDir !== 'string' || !opts.rootDir) {
    throw new Error('createUnpackStore: rootDir 必填（解包缓存根目录，如 <dataRoot>/unpacked）');
  }
  // pluginDir 只影响指纹里的 pluginVersion；缺省会让"插件升级后缓存不失效"成为静默错误（比崩更糟）
  if (typeof (opts || {}).pluginDir !== 'string' || !opts.pluginDir) {
    throw new Error('createUnpackStore: pluginDir 必填（指纹要含 pluginVersion，否则插件升级后缓存不会失效）');
  }
  const rootDir = opts.rootDir;
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
  const version = pluginVersion(opts.pluginDir);
  const counters = {
    unpackCount: 0, hits: 0, misses: 0, failures: 0, lastUnpackMs: 0, peakRss: 0,
    // miss 的具体原因（验收"改 mtime → 重新解包"时要能看出是 source-changed 而不是别的原因）
    lastMissReason: null,
    peekHits: 0, // 前台只查缓存命中的次数（形态 C 的主指标）
    lastFailReason: null, // 最近一次拒绝/失败的原因（insufficient-memory 等）
  };
  /** fp → Promise（同一包的并发只解一次） */
  const inflight = new Map();
  /** 串行队列：解包是单核密集操作，串行避免抢渲染 */
  let chain = Promise.resolve();
  const enqueue = opts.enqueue || ((fn) => {
    const next = chain.then(fn, fn);
    chain = next.then(() => undefined, () => undefined);
    return next;
  });
  let lastCleanupAt = 0;

  /**
   * 读当前 RSS 与**内核记录的峰值**（/proc/self/status 的 VmHWM）。
   *
   * 为什么用 VmHWM：解包的峰值是**瞬时**的（插件 resolve 里一次性产出整包文件），
   * 300ms 轮询采样会系统性漏掉它——实测采样说 171MB，而内核 VmHWM 是 491MB（差 2.9 倍）。
   * 验收内存必须用内核峰值，不能用抽样最小值。
   * @returns {{rss: number, peak: number, source: 'vmhwm'|'sample'}}
   */
  // rssNow 由 mem-probe.mjs 提供（worker 与主线程同一实现）；这里只保留采样兜底：
  //   非 Linux 上 VmHWM 读不到时，用 counters.peakRss 作为峰值基线，所以调用点要把它传进去。

  /** 采样 RSS 峰值（VMHWM 不可用时的兜底；同时保留抽样序列的最大值） */
  function sampleRss() {
    const rss = process.memoryUsage().rss;
    if (rss > counters.peakRss) counters.peakRss = rss;
    return rss;
  }

  /**
   * 指纹：源文件 stat + 插件身份（详见文件头第 1 条）。
   *
   * 插件身份取 providerFingerprint()（所有可解包插件的集合）而不是写死某个插件名：
   *   单插件时它返回的就是那个插件 id，与历史硬编码值**逐字相同**，所以现有缓存不会因这次通用化失效。
   */
  function fingerprintOf({ rootId, rel, stat }) {
    const raw = [rootId, rel, stat.size, Math.round(stat.mtimeMs), providerFingerprint(), version].join('\0');
    return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
  }

  const fpDir = (fp) => path.join(rootDir, fp);

  // probe.json 的读**与写**都由 probe-store.mjs 提供 —— worker 里解完要写同一份 probe.json
  //   （recordMeasuredPeak 与 writeResult 的"取走旧 probe → rename → 写回"强耦合），
  //   主线程的准入路径也要读它。两边共用一个实现，避免两份逻辑各自漂移。
  const probeStore = createProbeStore({ rootDir });
  const readProbe = (fp) => probeStore.read(fp);

  // 解包 worker 客户端：**常驻 1 个**（与既有串行队列一致，不并发解包）。
  //   硬超时 120s 只用于"防死循环把队列永久堵住"，不是"约束合法解包" ——
  //   锚点包 azurlane_bundle/live2d/z46_2（解压 33.4MB 的 LZMA）实测墙钟 17.83s、unpackMs 9416ms，
  //   120s 有 6.7 倍余量，正常解包一辈子不该触发它。
  const workerClient = createUnpackWorkerClient({
    rootDir,
    timeoutMs: 120000,
    log: (level, message, extra) => {
      // 服务端日志（stdout 会进 runtime/model-stage-web.log）；超时/崩溃这类事件必须留痕，
      //   否则真触发时没人知道发生过。
      const fn = level === 'error' ? console.error : console.warn;
      fn(`[unpack-worker] ${message}`, extra ? JSON.stringify(extra) : '');
    },
  });

  /**
   * 本次准入要用的内存声明：缓存优先，其次现场问插件（轻量，不解压），都没有返回 null。
   * @param {string} fp 指纹
   * @param {{rootId:string, rel:string, absPath:string}} req
   */
  function memoryDeclaration(fp, req) {
    const cached = readProbe(fp);
    // 缓存里只有解压量、实测峰值、采样次数，**不含插件声明的 peakBytes**（字段见 probe-store.mjs）。
    //   所以缓存命中时不能直接返回：那样准入拿到的"声明值"会退化成"源包大小粗估"
    //   （实测：21MB 的 LZMA 包只估到约 200MB，而插件表给 732MB），
    //   再叠加 measured 会被进程状态压低（同一进程连解两个 21MB 包分别报 225MB / 1195MB），
    //   两个低估叠加 ⇒ 准入形同不存在。这里补问一次声明（只读块表，P90 < 1ms）。
    const hasDecl = cached && cached.peakBytes > 0;
    if (hasDecl) return cached;
    return mergeDeclared(cached, askDeclaredSafely(req));
  }

  /**
   * 解包完成后回填**实测峰值**（契约 §2.2 第①段的数据来源）。
   *
   * 计算式：`峰值 = before.rss + max(0, after.peak - before.peak)`（rss=VmRSS，peak=VmHWM 内核峰值）。
   *   本次创了新高 = "起始占用 + 本次顶高的量"；没创新高说明历史上解过更大的包，
   *   此时取 max(历史值, 本次) —— 上包络语义，宁高不低。
   *
   * ⚠️ 这个数**不是这一包自身的成本**，别当包级峰值用：
   *   VmHWM **只增不减**，所以它实际是「本次把峰值顶高了多少 **+ 当时进程已占多少**」。
   *   同进程连续解包时，后续包的 `after.peak - before.peak` 会退化为 0 ⇒ measured 约等于 `before.rss`
   *   （而那时 RSS 已被上一个包撑起来）。
   *   实测：同一进程先后解两个 21MB 包，measured 分别 **225MB** 与 **1195MB**；
   *   干净进程测同类包是 **654MB**。
   *
   *   ⇒ 它只能当**下限兜底**：高于插件声明说明这包真更贵（信它）；低于声明只是进程状态，不能拿它压声明。
   *     取舍实现在 capacity.mjs 的 estimatePeakWithBasis。
   *   ⇒ 想要真正的包级峰值得换口径（子进程解包 / 解包前重置峰值基线），那会动解包主链路，
   *     代价与收益不匹配，故保持现状。
   * @param {string} fp
   * @param {{rss:number, peak:number}} before
   * @param {{rss:number, peak:number}} after
   */
  // recordMeasuredPeak 已随解包一起搬进 worker（unpack-worker.mjs 调 probe-store 的同一实现）。
  //   留在主线程没有调用点；两份实现会在下次只改一处时静默失效，所以这里不保留委托版。
  const indexPath = (fp) => path.join(fpDir(fp), 'index.json');

  /** 读索引（不存在/损坏 → null） */
  function readIndex(fp) {
    try {
      const j = JSON.parse(fs.readFileSync(indexPath(fp), 'utf8'));
      return j && j.v === 1 && Array.isArray(j.files) ? j : null;
    } catch {
      return null;
    }
  }

  /**
   * 命中判定：索引在 + 源 stat 未变 + 清单里每个文件都真的在盘上。
   * @returns {{hit: boolean, reason?: 'no-index'|'source-changed'|'empty-list'|'file-missing'}}
   */
  function hitCheck(index, stat) {
    if (!index || !index.source) return { hit: false, reason: 'no-index' };
    if (index.source.size !== stat.size || Math.round(index.source.mtimeMs) !== Math.round(stat.mtimeMs)) {
      return { hit: false, reason: 'source-changed' };
    }
    if (!index.files.length) return { hit: false, reason: 'empty-list' };
    for (const f of index.files) {
      try {
        if (!fs.statSync(path.join(fpDir(index.fingerprint), 'files', f.path)).isFile()) return { hit: false, reason: 'file-missing' };
      } catch {
        return { hit: false, reason: 'file-missing' };
      }
    }
    return { hit: true };
  }

  /** 命中时更新 lastUsedAt（LRU 依据），失败不影响命中 */
  /**
   * 命中时更新 lastUsedAt（LRU 依据），失败不影响命中。
   *
   * ⚠️ 这是 index.json 的**第二个写者**（第一个是 worker 里的 writeResult，它把 index.json
   *   连同 files/ 一起 rename 成 <fp>/ —— rename 必须带上 index.json 才能保证"产物与索引同时就位"，
   *   所以那份留在 worker，不搬回主线程）。
   *   **两者不会并发**：解包进行中该 fp 一定在 `inflight` Map 里（见 resolve 的 `inflight.set`），
   *   此时任何对同一 fp 的请求都由 `inflight.has(fp)` 直接复用同一个 promise，
   *   不会走到 hit/touch 这条路径；而 worker 的 rename 发生在那个 promise resolve 之前。
   *   ⇒ touch 只可能在"该 fp 没有解包在跑"时执行。改这段前请重新确认这条互斥仍然成立。
   */
  function touch(fp, index) {
    try {
      fs.writeFileSync(indexPath(fp), JSON.stringify({ ...index, lastUsedAt: new Date().toISOString() }, null, 2), 'utf8');
    } catch { /* 只影响 LRU 精度 */ }
  }

  // 原子落盘（writeResult）整段在 write-result.mjs 里，由 worker 调用 —— 主线程**不再有任何
  //   "写产物"的路径**。两份原子写 = 下次只改一处、另一处静默失效，本项目栽过，所以这里不留备用实现。

  /** LRU 清理：超 maxDirs / maxBytes 时删最久未用的（直接删，理由见文件头第 4 条） */
  function cleanup() {
    const now = Date.now();
    if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return { skipped: true };
    lastCleanupAt = now;
    let deleted = 0;
    try {
      const entries = fs.readdirSync(rootDir, { withFileTypes: true }).filter((e) => e.isDirectory());
      const items = [];
      for (const e of entries) {
        const full = path.join(rootDir, e.name);
        if (e.name.startsWith('.tmp-')) { // 半成品残留（上次崩在中途）
          try { fs.rmSync(full, { recursive: true, force: true }); deleted += 1; } catch { /* 忽略 */ }
          continue;
        }
        const idx = readIndex(e.name);
        items.push({ fp: e.name, full, at: Date.parse((idx && idx.lastUsedAt) || 0) || 0, bytes: dirBytes(full) });
      }
      items.sort((a, b) => a.at - b.at); // 最久未用在前
      let total = items.reduce((s, i) => s + i.bytes, 0);
      while (items.length && (items.length > limits.maxDirs || total > limits.maxBytes)) {
        const victim = items.shift();
        try {
          fs.rmSync(victim.full, { recursive: true, force: true });
          total -= victim.bytes;
          deleted += 1;
        } catch { /* 并发删除中，忽略 */ }
      }
    } catch { /* 目录刚建/刚删，忽略 */ }
    return { deleted };
  }

  /**
   * 未命中原因推断（跨目录比对）：指纹里含 mtime/size/pluginVersion，
   * 这三者任一变化都会**指向一个全新的目录**，所以单看本 fp 永远只能报 no-index。
   * 这里扫一遍已有目录里"同一个源文件"的旧记录，把原因说清楚：
   *   · 同源 stat、版本不同 → plugin-version-changed（旧 1 → 新 2）
   *   · 同源 rel、stat 不同   → source-changed（mtime 或 size 变了）
   * @param {{rootId: string, rel: string, stat: fs.Stats}} req
   * @returns {string|null}
   */
  function detectMissCause({ rootId, rel, stat }) {
    try {
      for (const e of fs.readdirSync(rootDir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.tmp-')) continue;
        const idx = readIndex(e.name);
        const src = idx && idx.source;
        if (!src || src.rootId !== rootId || src.rel !== rel) continue;
        const sameStat = src.size === stat.size && Math.round(src.mtimeMs) === Math.round(stat.mtimeMs);
        const sameVersion = String(idx.pluginVersion) === String(version);
        if (sameStat && !sameVersion) return `plugin-version-changed（${idx.pluginVersion} → ${version}）`;
        if (!sameStat) return `source-changed（size ${src.size}→${stat.size}，mtime ${Math.round(src.mtimeMs)}→${Math.round(stat.mtimeMs)}）`;
      }
    } catch { /* 目录未建 */ }
    return null;
  }

  /**
   * 只查缓存、**绝不触发解包**（形态 C 的前台路径用它：miss 就让前端走本地，绝不在这里抢 CPU）。
   * @param {{rootId: string, rel: string, absPath: string}} req
   */
  function peek(req) {
    let stat;
    try {
      stat = fs.statSync(req.absPath);
    } catch {
      return { ok: false, hit: false, reason: 'source-missing' };
    }
    const fp = fingerprintOf({ ...req, stat });
    const idx = readIndex(fp);
    const verdict = hitCheck(idx, stat);
    if (!verdict.hit) return { ok: true, hit: false, fingerprint: fp, reason: verdict.reason || 'no-index' };
    counters.peekHits += 1;
    touch(fp, idx);
    return { ok: true, hit: true, fingerprint: fp, prefix: idx.prefix, entry: idx.entry, files: idx.files, unpackMs: 0 };
  }

  /**
   * 解析一个资源包：命中直接返回清单；未命中则解包落盘（同 fp 并发共用一次解包）。
   * @param {{rootId: string, rel: string, absPath: string}} req
   */
  async function resolve(req) {
    const stat = fs.statSync(req.absPath);
    const fp = fingerprintOf({ ...req, stat });
    const cachedIdx = readIndex(fp);
    const verdict = hitCheck(cachedIdx, stat);
    if (verdict.hit) {
      counters.hits += 1;
      touch(fp, cachedIdx);
      cleanup();
      return { ok: true, hit: true, fingerprint: fp, prefix: cachedIdx.prefix, entry: cachedIdx.entry, files: cachedIdx.files, unpackMs: 0 };
    }
    if (inflight.has(fp)) return inflight.get(fp); // 并发去重：同一 fp 只解一次
    counters.misses += 1;
    // 未命中原因：优先报"插件版本变了"（跨目录比对），否则报 hitCheck 给的具体原因
    counters.lastMissReason = detectMissCause({ ...req, stat }) || verdict.reason || 'no-index';
    const task = enqueue(async () => {
      const t0 = Date.now();
      // 解包前按**当前可用内存**现判（不缓存、不看包大小阈值）：
      //   预估峰值 = 源大小 × 分段倍数（实测上包络），超过"可用内存的一半"就拒绝，
      //   否则一次解包可能把机器拖到换页（42MB 包实测峰值 479MB）。
      // 内存保护开关：默认（不带 allowOverLimit）仍是"超预算就拒"，与既有行为一致；
      //   面板关掉开关后前端带 allowOverLimit ⇒ 放行但保留真实数字（overLimit 标记供上层提示）。
      // 内存声明：缓存优先 → 现场问插件（只读块表，P90 < 1ms）→ 都没有则回落"源包大小分段"
      const decl = memoryDeclaration(fp, req);
      const mem = checkUnpackMemory(stat.size, { allowOverLimit: req.allowOverLimit === true, memory: decl || undefined });
      if (!mem.ok) {
        counters.failures += 1;
        counters.lastFailReason = mem.reason;
        return { ok: false, fingerprint: fp, reason: mem.reason, message: mem.message, budgetMb: mem.budgetMb, peakEstMb: mem.peakEstMb, availMb: mem.availMb };
      }
      sampleRss();
      const memBefore = rssNow(counters.peakRss);
      // 分段打点（先量再改）：解压 / 落盘 / 索引探针 三段分别计时。
      //   为什么要量：服务端解包 10~11s，而前端本地解同一包只要 4s ——
      //   慢的到底是解压还是写盘，不量就只能猜（写盘目标是 SMB 挂载 + 23~39 个小文件，最可疑）。
      // 解包 + 落盘 + 写 probe **整段在 worker 里**（主线程不再碰任何产物文件）：
      //   这是搬 worker 的唯一目的 —— 让这几秒（锚点包实测墙钟 17.8s）不占住事件循环。
      const tUnpack0 = Date.now();
      const reply = await workerClient.run({
        rootId: req.rootId,
        rel: req.rel,
        absPath: req.absPath,
        fp,
        meta: {
          ...req,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          pluginId: runnerInfo().pluginId,
          pluginVersion: version,
        },
        decl,
      });
      const unpackWallMs = Date.now() - tUnpack0;
      if (!reply.ok) {
        counters.failures += 1;
        return { ok: false, fingerprint: fp, reason: reply.reason, message: reply.message };
      }
      const index = reply.index;
      const writeMs = reply.writeMs || 0;
      const probeMs = reply.probeMs || 0;
      counters.unpackCount += 1;
      counters.lastUnpackMs = Date.now() - t0;
      sampleRss();
      // phases 随响应回给调用方（排查与验收要能看到"时间花在哪一段"）
      // 解压段再细分：readMs = 从盘读整包（19MB 走 SMB 可能就要几秒）、pluginResolveMs = 插件真正解压
      const phases = {
        readMs: reply.readMs,
        pluginResolveMs: reply.unpackMs,
        unpackWallMs,
        writeMs,
        probeMs,
        totalMs: Date.now() - t0,
        files: index.files.length,
      };
      return { ok: true, hit: false, fingerprint: fp, prefix: index.prefix, entry: index.entry, files: index.files, unpackMs: index.unpackMs, phases, memBasis: mem.basis, peakEstMb: mem.peakEstMb };
    }).finally(() => inflight.delete(fp));
    inflight.set(fp, task);
    const out = await task;
    cleanup();
    return out;
  }

  /** 单个产物文件的绝对路径（路由用；调用方必须先校验 path 在 index.files 里） */
  function filePathOf(fp, relPath) {
    return path.join(fpDir(fp), 'files', relPath);
  }

  /**
   * 对外暴露"这个包的内存声明"（/api/unpack/capacity 用）。
   * 与准入判断走**同一个来源**：缓存命中 → 插件 estimateMemory（含 peakBytes）→ 都没有返回 null。
   * @param {{rootId:string, rel:string, absPath:string}} req
   */
  function memoryOf(req) {
    try {
      const stat = fs.statSync(req.absPath);
      const fp = fingerprintOf({ ...req, stat });
      return memoryDeclaration(fp, req);
    } catch {
      return null;
    }
  }

  /** 状态（/api/unpack/stats 用；peakRss 给验收与回归看） */
  function stats() {
    const mem = rssNow();
    let dirs = 0;
    let bytes = 0;
    try {
      for (const e of fs.readdirSync(rootDir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.tmp-')) continue;
        dirs += 1;
        if (dirs <= 50) bytes += dirBytes(path.join(rootDir, e.name));
      }
    } catch { /* 目录未建 */ }
    return {
      ...counters,
      // peakRssMb 用内核 VmHWM（真峰值）；sampledPeakRssMb 保留旧抽样值，便于看出"抽样会漏多少"
      peakRssMb: Math.round(mem.peak / BYTES_PER_MB),
      peakSource: mem.source,
      sampledPeakRssMb: Math.round((counters.peakRss || 0) / BYTES_PER_MB),
      rssMb: Math.round(mem.rss / BYTES_PER_MB),
      dirs,
      bytesMb: Math.round(bytes / BYTES_PER_MB),
      inflight: inflight.size,
      limits,
      runner: runnerInfo(),
    };
  }

  /**
   * 把**前端解出来的产物**落盘到同一个缓存键（新增的第二个写入者）。
   *
   * 为什么要有第二个写入者：服务端解包要 11.4s（慢在 vm 沙箱里跑插件，实测解压占 93.6%），
   *   而前端本地解同一个包只要 4.3s。与其把服务端变快（那要动隔离模型），
   *   不如让前台走快的（前端解），解完把产物交给服务端存起来 —— 这样：
   *     首次 4.3s（原来等 11.4s）、第二次 137ms（命中），服务端那条慢路只留给预热/直调。
   *
   * 硬约束：
   *   · **指纹由服务端自己算**（它拿得到源包 absPath + stat）。前端只报 rootId/rel 与产物，
   *     不重复实现 hash —— 否则键一旦不一致，就会出现"存进去了但查不到"。
   *   · 已存在同一指纹的缓存 ⇒ 直接返回 hit（幂等，不重复写盘）。
   *   · 落盘失败**不影响本次加载**：数据在前端内存里已经可用，这里失败只让下次再解一遍。
   *
   * @param {{rootId:string, rel:string, absPath:string, prefix:string, entry:string,
   *          files: Array<{name:string, bytes:Buffer}>, pluginId?:string, pluginVersion?:string}} req
   * @returns {Promise<{ok:boolean, hit?:boolean, fingerprint?:string, files?:number, ms?:number, reason?:string, message?:string}>}
   */


  return { resolve, memoryOf, peek, readIndex, filePathOf, stats, cleanup, fingerprintOf };
}
