// unpack/store.mjs —— 解包产物的落盘缓存（17b 第二步：指纹 / 原子写 / LRU / 并发去重 / stats）
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
import { unpackFile, runnerInfo } from './plugin-runner.mjs';
import { checkUnpackMemory } from './capacity.mjs';

/** 1MB 的字节数（下面多处换算用；写成常量避免 1048576 散落） */
const BYTES_PER_MB = 1024 * 1024;

/** 缓存上限（可用 config 覆盖；4GB 可用内存 / 磁盘都在这个量级以内安全） */
const DEFAULT_LIMITS = { maxDirs: 20, maxBytes: 8 * 1024 * 1024 * 1024 };

/** 清理解包的节流间隔：resolve 后最多 10 分钟扫一次目录 */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/** 读 plugin.json 的版本号（指纹的一部分；读不到就用 0，不阻塞） */
function pluginVersion(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8');
    const m = /"version"\s*:\s*("?)([^",\s]+)\1/.exec(text);
    return m ? m[2] : '0';
  } catch {
    return '0';
  }
}

/** 逐层建目录（写文件前确保父目录存在） */
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
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
  function rssNow() {
    try {
      const txt = fs.readFileSync('/proc/self/status', 'utf8');
      const hwm = /VmHWM:\s+(\d+)\s+kB/.exec(txt);
      const rss = /VmRSS:\s+(\d+)\s+kB/.exec(txt);
      if (hwm) return { rss: rss ? Number(rss[1]) * 1024 : process.memoryUsage().rss, peak: Number(hwm[1]) * 1024, source: 'vmhwm' };
    } catch { /* 非 Linux：退回抽样 */ }
    const rss = process.memoryUsage().rss;
    return { rss, peak: Math.max(counters.peakRss, rss), source: 'sample' };
  }

  /** 采样 RSS 峰值（VMHWM 不可用时的兜底；同时保留抽样序列的最大值） */
  function sampleRss() {
    const rss = process.memoryUsage().rss;
    if (rss > counters.peakRss) counters.peakRss = rss;
    return rss;
  }

  /** 指纹：源文件 stat + 插件身份（详见文件头第 1 条） */
  function fingerprintOf({ rootId, rel, stat }) {
    const raw = [rootId, rel, stat.size, Math.round(stat.mtimeMs), 'unity-live2d-bundle', version].join('\0');
    return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
  }

  const fpDir = (fp) => path.join(rootDir, fp);
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
  function touch(fp, index) {
    try {
      fs.writeFileSync(indexPath(fp), JSON.stringify({ ...index, lastUsedAt: new Date().toISOString() }, null, 2), 'utf8');
    } catch { /* 只影响 LRU 精度 */ }
  }

  /** 把一次解包结果原子落盘；返回 { files, unpackMs } */
  async function writeResult(fp, res, meta) {
    const tmpDir = path.join(rootDir, `.tmp-${fp}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
    ensureDir(path.join(tmpDir, 'files'));
    const files = [];
    try {
      for (const { path: relPath } of res.files.entries) {
        const bytes = await res.files.take(relPath);
        if (!bytes) continue;
        const dst = path.join(tmpDir, 'files', relPath);
        ensureDir(path.dirname(dst));
        fs.writeFileSync(dst, bytes);
        files.push({ path: relPath, size: bytes.length });
        // 写完立刻从沙盒 Map 里删掉引用（42MB 包 RSS 增量约 210MB，逐个释放能显著削峰）
        res.files.release(relPath);
        sampleRss();
      }
      const now = new Date().toISOString();
      const index = {
        v: 1,
        fingerprint: fp,
        pluginId: meta.pluginId,
        pluginVersion: meta.pluginVersion,
        source: { rootId: meta.rootId, rel: meta.rel, size: meta.size, mtimeMs: Math.round(meta.mtimeMs) },
        prefix: res.prefix,
        entry: res.entry,
        files,
        createdAt: now,
        lastUsedAt: now,
        unpackMs: res.unpackMs,
      };
      fs.writeFileSync(path.join(tmpDir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
      fs.renameSync(tmpDir, fpDir(fp)); // 同卷 rename：原子替换，读者要么看到旧目录要么看到新目录
      return { index, files };
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败不影响主流程 */ }
      throw e;
    }
  }

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
      const mem = checkUnpackMemory(stat.size);
      if (!mem.ok) {
        counters.failures += 1;
        counters.lastFailReason = mem.reason;
        return { ok: false, fingerprint: fp, reason: mem.reason, message: mem.message, budgetMb: mem.budgetMb, peakEstMb: mem.peakEstMb, availMb: mem.availMb };
      }
      sampleRss();
      const res = await unpackFile({ rootId: req.rootId, rel: req.rel, absPath: req.absPath });
      if (!res.ok) {
        counters.failures += 1;
        return { ok: false, fingerprint: fp, reason: res.reason, message: res.message };
      }
      const { index } = await writeResult(fp, res, { ...req, size: stat.size, mtimeMs: stat.mtimeMs, pluginId: runnerInfo().pluginId, pluginVersion: version });
      counters.unpackCount += 1;
      counters.lastUnpackMs = Date.now() - t0;
      sampleRss();
      return { ok: true, hit: false, fingerprint: fp, prefix: index.prefix, entry: index.entry, files: index.files, unpackMs: index.unpackMs };
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

  return { resolve, peek, readIndex, filePathOf, stats, cleanup, fingerprintOf };
}
