// src/server/unpack/runtime/exec.mjs —— 「exec」运行时适配器：spawn 插件入口，走「一行一个 JSON」帧协议
//
// 协议（docs/设计/插件运行时与多语言.md §四）：
//   请求  父 → 子  {"id":1,"method":"canHandle","absPath":"…","size":123}
//   响应  子 → 父  {"id":1,"ok":true,"handled":true}
//                  {"id":1,"ok":true,"prefix":"vfs://…","entry":"entry.json",
//                   "files":[{"name":"a.png","tmpPath":"<插件临时目录>/a.png","size":123}]}
//   错误  子 → 父  {"id":1,"ok":false,"code":"ULB_ERR_…","message":"…"}
//
// 四条硬约束（设计稿 §四，逐条落在代码里）：
//   ① 帧 = 一行 JSON（UTF-8）+ \n；解析必须支持跨 chunk 拼行（readline 天然满足）
//   ② 二进制**不进帧**：子进程把产物写到临时目录，帧里只给 {name, tmpPath, size}
//      —— 20MB 包 base64 会又慢又吃内存。产物由父进程按需读取（见 lazyBytes）
//   ③ 超时必须双向：父进程每次请求设超时并 kill；子进程侧也有自己的内部上限（插件责任）
//   ④ 崩溃只重试一次：异常退出后下一次请求重启，仍失败则该插件后续请求直接报错
//
// **安全边界**：exec 是"让一个陌生可执行文件在你机器上跑"——它能读你所有文件、连你的网络。
//   所以本运行时默认禁用，必须 config/plugin-runtime.json 显式开启（门禁在 runtime/index.mjs）。
import fs from 'node:fs';
import path from 'node:path';
// .env 解析复用 core/env.mjs（与 /api/brand 同一份文件、同一套规则，不另写一套）
import { createEnv } from '../../core/env.mjs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { createLogger } from '../../core/log.mjs';

/** 本适配器能处理的 runtime 名 */
export const RUNTIME = 'exec';

/** 协议版本：exec 插件必须在 plugin.json 声明 frameProtocol，且必须是本版本 */
export const SUPPORTED_FRAME_PROTOCOL = 1;

/** 清单不合法时的错误码（与"宿主还没实现"区分开，便于排障） */
export const MANIFEST_INVALID = 'EXEC_MANIFEST_INVALID';

/** 单次请求缺省超时：首帧含 python 启动 + import UnityPy（冷启实测 1~3s），给足余量 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 空闲多久后退出子进程（避免常驻 python 吃内存） */
const DEFAULT_IDLE_MS = 60_000;
/** 单行上限：防止子进程吐超大 JSON 把父进程内存拉爆（产物走 tmpPath，帧里不该有大块） */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** SIGTERM 后等多久改 SIGKILL */
const KILL_GRACE_MS = 3000;
/** 本适配器自己的日志（exec 通道排障：未知进度档、空闲退出等） */
const execLog = createLogger('exec');

/**
 * 进度档白名单 —— **唯一来源**：档名与每档语义都只在这张表里写一次。
 *
 * 契约 §四·⑨：不认识的档名**忽略并记 debug**，不报错、不中断请求 ——
 *   插件可以自由加更细的档（monotonic 名字也行），老主进程只打一条 debug。
 * 为什么不散在别处：这份名单曾同时抄在设计稿里，新增档位若只改一处，
 *   插件发的帧就会被当"未知档"静默忽略（不报错，但也**没有进度**）——
 *   "同一事实两处表达"是本项目反复踩的坑；设计稿现在只解释语义并指向本表。
 * 与 plugin-store 的三段阶段名对齐（read / resolve / write）：档名要转发给前端 / SSE 订阅方，
 *   两处必须是同一套词，否则对不上。
 * `msField`：该档在 plugin-store 的 `phases` 对象里对应的字段名（`read→readMs` 这种**名字不同**的
 *   也必须写明）。SSE 的补发循环靠它派生，**不再手写档名**；新增档位漏配 msField 会被单测拦下
 *   （而不是运行时少发一条、静默少一段进度）。
 */
export const PROGRESS_PHASES = Object.freeze([
  { name: 'read', msField: 'readMs', note: '从盘读整包（容器字节进内存）' },
  { name: 'resolve', msField: 'pluginResolveMs', note: '插件解压/解析（真正吃 CPU 的那一段）' },
  { name: 'write', msField: 'writeMs', note: '产物落盘（写 files/ 与 index.json）' },
]);

/** 快速判定用的集合（由上表派生 —— **不要**在这里另写一份名单） */
const KNOWN_PROGRESS_PHASES = new Set(PROGRESS_PHASES.map((p) => p.name));

/**
 * 校验一个 exec 插件的清单是否自洽（**纯校验，不起进程**）。
 * 这一层在装载期就把"清单写错了"报出来，而不是等第一次解包才发现。
 * @param {object} meta 插件清单
 * @returns {{ok: true} | {ok: false, error: string, code: string}}
 */
export function validateExecManifest(meta) {
  const entry = meta && meta.entry ? String(meta.entry) : '';
  if (!entry) {
    return { ok: false, code: MANIFEST_INVALID, error: 'runtime:"exec" 的插件必须在 plugin.json 里声明 entry（相对插件目录的入口文件，如 worker.py）' };
  }
  // entry 必须是相对路径：绝对路径会让插件把"整机任意可执行文件"变成自己的入口（明显越界）
  if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
    return { ok: false, code: MANIFEST_INVALID, error: `runtime:"exec" 的 entry 必须是插件目录内的相对路径（不允许绝对路径或 ..）：${entry}` };
  }
  const fp = meta && meta.frameProtocol;
  if (fp === undefined || fp === null) {
    return { ok: false, code: MANIFEST_INVALID, error: 'runtime:"exec" 的插件必须声明 frameProtocol（当前支持版本 1）' };
  }
  if (Number(fp) !== SUPPORTED_FRAME_PROTOCOL) {
    return { ok: false, code: MANIFEST_INVALID, error: `不支持的 frameProtocol：${fp}（本宿主支持 ${SUPPORTED_FRAME_PROTOCOL}）` };
  }
  return { ok: true };
}

/**
 * 惰性字节视图：`filesView` 只要求"有 length 和 slice"，真正取用（take）时才读盘。
 *
 * 为什么不做成一次性全读：一个包的产物可能是几十 MB（纹理），而列表/校验路径只看 size；
 *   全读进内存等于把解包的峰值再抬高一份。
 *
 * ⚠️ **必须同时提供 `arrayBuffer()`**：`filesView` 的 toBytes 优先走 Blob 形状
 *   （`typeof v.arrayBuffer === 'function'`），否则会落到 `new Uint8Array(v)` 那条 ——
 *   那是 array-like 分支，对一个普通对象只会产出**长度对、内容全 0** 的假字节。
 *   实测踩到过：entry.json 175 字节全 `0x00`，JSON 解析直接失败。
 *   返回的 ArrayBuffer 必须是**独立拷贝**（`buf.buffer.slice(...)`）：Buffer 常来自共享池，
 *   直接把 buf.buffer 交出去会把池里相邻的其它内容也带上。
 * @param {string} tmpPath 子进程写出的临时文件
 * @param {number} size 字节数
 */
function lazyBytes(tmpPath, size) {
  return {
    length: Number(size) || 0,
    // Blob 形状（优先分支）：filesView → toBytes 会读它
    arrayBuffer: async () => {
      const buf = fs.readFileSync(tmpPath);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    // Uint8Array 形状（备用分支）
    slice: () => fs.readFileSync(tmpPath),
    tmpPath,
  };
}

/**
 * 展开清单里的 `${VAR}` 占位符，返回部署端提供的值。
 *
 * 为什么需要占位符：插件清单是**可分发**的（不能写死本机路径），但依赖目录又是部署差异
 *   （每台机器装的位置不同）—— 用 `${VAR}` 声明"这里要一个由部署端提供的值"，
 *   既不带本机信息、又不用把配置拆到另一个文件。
 * 取值顺序：`process.env` → `<root>/.env`（与 /api/brand 读同一份，改完刷新即生效）。
 * 未设置 ⇒ **返回失败而不是空串**：静默降级成"插件不可用但不说为什么"是最难查的那类故障。
 * @param {string} value 清单里的原始值（可能是 `${VAR}`，也可能就是普通路径）
 * @param {{root?: string}} opts root = 项目根（.env 所在目录）
 */
function expandPlaceholder(value, opts = {}) {
  const raw = String(value == null ? '' : value).trim();
  const hit = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(raw);
  if (!hit) return { ok: true, value: raw };      // 不是占位符：原样返回（绝对/相对路径都走这条）
  const name = hit[1];
  const fromProcess = String(process.env[name] || '').trim();
  if (fromProcess) return { ok: true, value: fromProcess, source: `env:${name}` };
  // 再查 .env：部署端更愿意改这个文件（.env 已 gitignore，不随仓库分发）
  try {
    const root = (opts && opts.root) || process.cwd();
    const env = createEnv({ dotenvFile: path.join(root, '.env') });
    const fromDotenv = String((env.readDotEnv() || {})[name] || '').trim();
    if (fromDotenv) return { ok: true, value: fromDotenv, source: `.env:${name}` };
  } catch { /* 读 .env 失败按未设置处理，下面统一给可读错误 */ }
  return {
    ok: false,
    code: 'EXEC_CONFIG_MISSING',
    error: `插件清单里的 \${${name}} 没有值：请设置环境变量 ${name}，`
      + `或在项目根的 .env 里加一行 ${name}=<路径>（清单不再写死本机路径，改配置即可换机）`,
  };
}

/** 找可用的解释器：清单声明优先，否则按常见路径探**一次并记住**。
 *
 * 为什么缓存：本函数会被每个 worker 的 spawn 调用一次，而探测要对候选路径逐个 statSync；
 *   同一进程里解释器不会换，探一次就够（`repeat-identical-call` 报的正是这一处）。
 *   清单显式声明时直接返回，根本不进探测循环。
 * @param {object} meta 插件清单
 * @returns {string} 解释器路径或命令名
 */
let interpreterProbeCache = null;
function resolveInterpreter(meta) {
  // ① 环境变量最优先（部署期覆盖，便于换机/换版本而不改清单）
  const fromEnv = String(process.env.MODELSTAGE_PYTHON || '').trim();
  if (fromEnv) return fromEnv;
  // ② 清单声明（插件作者指定；本项目已置空，交给③④探测）
  const declared = meta && meta.interpreter ? String(meta.interpreter) : '';
  if (declared) return declared;
  if (interpreterProbeCache) return interpreterProbeCache;
  // 候选按"新到旧"排：新版本装的依赖不保证能在旧版本里 import
  for (const candidate of ['/usr/local/bin/python3.14', '/usr/local/bin/python3.10', '/usr/bin/python3']) {
    try {
      if (fs.existsSync(candidate)) {
        interpreterProbeCache = candidate;
        return candidate;
      }
    } catch { /* 继续下一个 */ }
  }
  // 都没探到 ⇒ 交给 PATH（spawn 会报 ENOENT，错误信息里带命令名，够定位）
  interpreterProbeCache = 'python3';
  return interpreterProbeCache;
}

/**
 * 一个 exec 插件的常驻 worker。
 *
 * 生命周期：装载时**不**启动（避免"装了插件就起进程"）；首个请求才 spawn，空闲后自动退出。
 */
class ExecWorker {
  /**
   * @param {object} meta 插件清单
   * @param {{pluginDir: string, depsDir?: string|null, log?: Function}} opts
   */
  constructor(meta, opts) {
    this.meta = meta;
    this.pluginDir = opts.pluginDir;
    this.depsDir = opts.depsDir || null;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this.proc = null;
    this.pending = new Map();      // id → {resolve, reject, timer, method}
    this.nextId = 1;
    this.dead = false;             // 进程结束后置真；下次请求会尝试重启
    this.restartUsed = false;      // 自动重启只允许一次（设计稿 ④）
    this.idleTimer = null;
    this.outputTail = [];          // 最后若干行 stderr/非 JSON 输出，报错时说清"插件为什么挂"
    this.ready = null;             // spawn 的 Promise（并发首请求共用一次启动）
    this.disposed = false;
  }

  /** 启动子进程（幂等：并发调用共用同一次 spawn） */
  ensureStarted() {
    if (this.disposed) return Promise.reject(new Error('exec worker 已释放'));
    if (this.proc && !this.dead) return Promise.resolve(this.proc);
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const interpreter = resolveInterpreter(this.meta);
      const entryAbs = path.join(this.pluginDir, String(this.meta.entry || 'worker.py'));
      if (!fs.existsSync(entryAbs)) {
        this.ready = null;
        return reject(new Error(`exec 插件入口不存在：${entryAbs}`));
      }
      const env = { ...process.env };
      // 依赖隔离：插件自带依赖目录进 PYTHONPATH，不要求宿主全局装包
      const deps = this.depsDir || path.join(this.pluginDir, '.deps');
      env.PYTHONPATH = [deps, this.pluginDir, env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter);
      // 中文路径：强制 UTF-8 + 不缓冲，否则帧会卡在缓冲区里（本机路径大量中文，踩过）
      env.PYTHONIOENCODING = 'utf-8';
      env.PYTHONUNBUFFERED = '1';
      // 不要继承宿主的 venv：会把插件的依赖解析带到别处去
      delete env.VIRTUAL_ENV;

      let child;
      try {
        child = spawn(interpreter, [entryAbs], {
          cwd: this.pluginDir,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        this.ready = null;
        return reject(new Error(`启动 exec 插件失败（${interpreter} ${entryAbs}）：${e.message}`));
      }
      this.proc = child;
      this.dead = false;

      // 按行读 stdout：readline 自带跨 chunk 拼行（约束 ①）
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => this.onLine(line));
      child.stderr.on('data', (buf) => this.pushTail(String(buf)));
      child.on('error', (e) => this.onExit(`spawn error: ${e.message}`));
      child.on('exit', (code, signal) => this.onExit(`exit code=${code} signal=${signal}`));

      resolve(child);
    });
    return this.ready;
  }

  /** 记录最后若干行插件输出（诊断用） */
  pushTail(text) {
    for (const one of String(text).split('\n')) {
      if (!one.trim()) continue;
      this.outputTail.push(one.slice(0, 500));
      if (this.outputTail.length > 20) this.outputTail.shift();
    }
  }

  /** 收一行：解析 JSON → 按 id 配对；坏行只记日志（插件往 stdout 打调试信息很常见） */
  onLine(line) {
    const text = String(line).trim();
    if (!text) return;
    if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES) {
      this.log('warn', `exec 插件输出超长行（>${MAX_LINE_BYTES}B），已丢弃`, { plugin: this.meta.id });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.pushTail(`stdout(非 JSON): ${text.slice(0, 200)}`);
      return;
    }
    const id = Number(msg && msg.id);
    const waiter = this.pending.get(id);
    if (!waiter) return;            // 迟到的响应（已超时/已判失败）直接丢
    // 进度帧：**不终结请求** —— 同一 id 后面还会有真正的响应/错误帧（契约 §四·⑦）。
    //   所以必须在这里 early return，绝不能落到下面的 settle 分支：
    //   否则一条进度帧会被当成响应，请求提前以"返回值缺 prefix/entry"失败。
    if (msg && msg.progress && typeof msg.progress === 'object') {
      this.deliverProgress(waiter, msg.progress);
      return;
    }
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    waiter.resolve(msg);
  }

  /**
   * 转发一条进度帧（契约 §四·⑦⑧⑨⑩ 的唯一落点）。
   *
   * 三件事都在这里收口，避免散落到调用方：
   *   ⑨ 未知档名 → 忽略 + debug（插件可以自由加分档，主进程不认识不算错）
   *   ⑩ 同档同毫秒的重复 → 丢掉（没有新信息）
   *   ⑧ 没注册回调 → 静默丢弃（进度只是旁路增强，不影响正确性）
   * @param {object} waiter 该请求的挂起记录（含 onProgress / progressSeen）
   * @param {{phase?: string, ms?: number}} progress 子进程上报的内容
   */
  deliverProgress(waiter, progress) {
    const phase = String((progress && progress.phase) || '');
    if (!phase) return;
    if (!KNOWN_PROGRESS_PHASES.has(phase)) {
      // 已知档名从表里现算（不另写一份）：排查"为什么没进度"时，一行日志就能看出
      //   "插件发了个不在名单里的名字"还是"根本没发"。
      this.log('debug', `exec 插件上报了未知进度档「${phase}」，已忽略（已知：${KNOWN_PROGRESS_PHASES.size ? [...KNOWN_PROGRESS_PHASES].join('/') : '无'}）`, { plugin: this.meta.id });
      return;
    }
    const rawMs = Number(progress && progress.ms);
    const ms = Number.isFinite(rawMs) ? Math.max(0, Math.round(rawMs)) : null;
    const key = `${phase}@${ms}`;
    if (waiter.progressSeen.has(key)) return;
    waiter.progressSeen.add(key);
    if (typeof waiter.onProgress !== 'function') return;
    try {
      waiter.onProgress({ phase, ms });
    } catch (e) {
      // 回调抛错不能污染请求本身（它只是旁路信息）
      this.log('warn', `进度回调抛错（已忽略）：${(e && e.message) || e}`, { plugin: this.meta.id });
    }
  }

  /** 子进程退出：把在途请求全部判失败，标记需要重启 */
  onExit(reason) {
    this.dead = true;
    this.proc = null;
    this.ready = null;
    const tail = this.outputTail.slice(-5).join(' | ');
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`exec 插件进程结束（${reason}）${tail ? `；插件输出：${tail}` : ''}`));
    }
    this.pending.clear();
  }

  /**
   * 发一个请求并等响应。
   * @param {string} method canHandle | resolve
   * @param {object} params
   * @param {number} timeoutMs
   * @returns {Promise<object>} 子进程的原始响应帧
   */
  async request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS, opts = {}) {
    await this.ensureStarted();
    const child = this.proc;
    if (!child || this.dead) throw new Error('exec 插件进程不可用');
    const id = this.nextId++;
    const frame = `${JSON.stringify({ id, method, ...params })}\n`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 超时必须真杀：只 reject 不 kill 的话，子进程会继续占着 CPU/内存
        this.kill(`请求超时（${method} > ${timeoutMs}ms）`);
        reject(new Error(`exec 插件请求超时（${method}，${timeoutMs}ms）`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, {
        resolve, reject, timer, method,
        // 进度回调按**请求**绑定，不绑在 worker 实例上：
        //   同一插件可能被两个解包任务同时用，绑实例会让 A 的进度报给 B（契约 §四·⑦ 的并发含义）
        onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null,
        progressSeen: new Set(),   // 同档同毫秒去重（契约 §四·⑩）
      });
      try {
        child.stdin.write(frame, 'utf8');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`写入 exec 插件 stdin 失败：${e.message}`));
      }
      this.touchIdle();
    });
  }

  /** 重置空闲计时（有活动就不退） */
  touchIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.log('debug', 'exec 插件空闲退出', { plugin: this.meta.id });
      this.kill('空闲超时');
    }, DEFAULT_IDLE_MS);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  /**
   * 终止子进程：SIGTERM → 宽限期 → SIGKILL（**必须确认真死**，否则留僵尸）。
   * @param {string} why
   */
  kill(why) {
    const child = this.proc;
    if (!child) return;
    const pid = child.pid;
    this.log('warn', `终止 exec 插件进程（${why}）`, { plugin: this.meta.id, pid });
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
    const hardTimer = setTimeout(() => {
      try {
        // SIGKILL 兜底：插件忽略 SIGTERM 时不能就这么留着
        child.kill('SIGKILL');
      } catch { /* 已退出 */ }
    }, KILL_GRACE_MS);
    if (typeof hardTimer.unref === 'function') hardTimer.unref();
    // exit 事件会走 onExit 清 pending；这里显式再清一次，避免"kill 了但 exit 迟迟不来"时挂住
    this.onExit(`killed: ${why}`);
  }

  /** 关掉（适配器 dispose 调） */
  dispose() {
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.kill('适配器释放');
  }
}

/**
 * 装载一个 exec 插件：**不启动进程**，只校验清单并交出一个按需启动的 api。
 * 这样"装了插件但从不使用"不会在机器上留一个 python。
 * @param {object} meta
 * @param {{pluginsDir: string, log?: Function}} ctx
 */
export function loadExecPlugin(meta, ctx) {
  const v = validateExecManifest(meta);
  if (!v.ok) return v;
  const pluginsDir = (ctx && ctx.pluginsDir) || '';
  // files[] 里形如 "unitypy-bundle/worker.py"：第一段是插件目录名
  const first = Array.isArray(meta.files) && meta.files.length ? String(meta.files[0]) : '';
  const dirName = first.includes('/') ? first.split('/')[0] : String(meta.id || '');
  const pluginDir = path.join(pluginsDir, dirName);
  if (!fs.existsSync(pluginDir)) {
    return { ok: false, code: 'EXEC_PLUGIN_DIR_MISSING', error: `exec 插件目录不存在：${pluginDir}` };
  }
  // 入口文件在**装载期**就校验，不等 spawn 才炸：
  //   spawn 失败只会在第一次请求时暴露，那时错误会混在"插件判定失败"里，很难看出是清单写错。
  //   ——同时这也是"清单声明了什么就必须存在什么"的一致性要求。
  const entryPath = path.join(pluginDir, String(meta.entry));
  if (!fs.existsSync(entryPath)) {
    return { ok: false, code: 'EXEC_ENTRY_MISSING', error: `exec 入口文件不存在：${entryPath}` };
  }
  // depsDir：支持三种写法 —— `${VAR}` 占位符（推荐，清单不带本机信息）、绝对路径、插件内相对路径。
  //   占位符取不到值 ⇒ **装载期就失败并给可读错误**，不要等到 spawn 后才以
  //   "ModuleNotFoundError: No module named 'UnityPy'" 的形式冒出来（那时看不出是配置问题）。
  let resolvedDepsDir = { ok: true, value: null };
  if (meta.depsDir) {
    const expanded = expandPlaceholder(meta.depsDir, { root: ctx && ctx.root });
    if (!expanded.ok) return expanded;
    resolvedDepsDir = {
      ok: true,
      value: path.isAbsolute(expanded.value) ? expanded.value : path.join(pluginDir, expanded.value),
    };
  }
  const worker = new ExecWorker(meta, {
    pluginDir,
    // depsDir 支持两种写法：插件内相对路径（'.deps'）或**绝对路径**。
    //   为什么需要绝对路径：本项目仓库在 CIFS 上（noexec + 不能 utime .so），
    //   带 C 扩展的依赖装进去会 PermissionError；这类依赖只能放到本地盘，
    //   由插件在自己的 README 里写明位置（见 unitypy-bundle 的说明）。
    depsDir: resolvedDepsDir.ok ? resolvedDepsDir.value : null,
    // log 缺省不再退化成空函数：exec 通道的排障信息（尤其"上报了未知进度档「x」"）必须能在
    //   LOG_LEVEL=debug 下真的打出来。此前调用方只传 {pluginsDir, root}，ctx.log 为空
    //   ⇒ 这些 debug 全被静默丢弃 —— "为什么没有进度"根本无从查起。
    log: (ctx && ctx.log) || ((level, msg, detail) => {
      const fn = typeof execLog[level] === 'function' ? execLog[level] : execLog.info;
      fn(msg, detail);
    }),
  });
  const timeoutMs = Number.isFinite(Number(meta.requestTimeoutMs)) ? Number(meta.requestTimeoutMs) : DEFAULT_TIMEOUT_MS;
  const providerId = String(meta.id || dirName);

  const api = {
    /**
     * canHandle 走帧协议（异步）。plugin-runner 已改成 `await` 调用，
     *   所以返回 Promise 与 node 运行时的同步 boolean 在使用上等价。
     */
    async canHandle(file) {
      const resp = await worker.request('canHandle', {
        rootId: file.rootId,
        rel: file.rel,
        name: file.name,
        absPath: file.absPath || null,
        size: file.size,
      }, timeoutMs, { onProgress: file && file.onProgress });
      if (!resp || resp.ok === false) {
        // 插件自报"我不认"与"我出错了"必须分清：后者要抛出去让 runner 记 canhandle-threw
        if (resp && resp.code) throw new Error(`${resp.code}: ${resp.message || ''}`);
        return false;
      }
      return resp.handled === true;
    },

    /**
     * resolve：子进程把产物写到临时目录，这里把 {name,tmpPath,size} 转成
     * `filesView` 能吃的普通对象（值 = 惰性字节视图，take 时才读盘）。
     */
    async resolve(file) {
      const resp = await worker.request('resolve', {
        rootId: file.rootId,
        rel: file.rel,
        name: file.name,
        absPath: file.absPath || null,
        size: file.size,
      }, timeoutMs, { onProgress: file && file.onProgress });
      if (!resp || resp.ok === false) {
        const err = new Error(`${(resp && resp.code) || 'EXEC_RESOLVE_FAILED'}: ${(resp && resp.message) || '插件未返回结果'}`);
        err.code = (resp && resp.code) || 'EXEC_RESOLVE_FAILED';
        throw err;
      }
      const list = Array.isArray(resp.files) ? resp.files : [];
      const out = {};
      for (const f of list) {
        const name = String((f && (f.name || f.path)) || '');
        if (!name) continue;
        const tmp = f && f.tmpPath ? String(f.tmpPath) : '';
        if (!tmp) continue;             // 没有 tmpPath 的条目拿不到字节，宁可少一个也不报假成功
        out[name] = lazyBytes(tmp, f.size);
      }
      return {
        prefix: resp.prefix,
        entry: resp.entry,
        files: out,
        // 诊断用（runner 不读，但日志要能看出"是哪个插件解的"）
        provider: providerId,
        unpackMs: resp.unpackMs,
      };
    },

    /** 释放：拆掉子进程（插件被禁用/热重载时由 runner 调） */
    dispose() { worker.dispose(); },
  };
  return { ok: true, api };
}

export default {
  runtime: RUNTIME,
  /**
   * 统一接口：load(meta, ctx) → {ok, api} | {ok:false, error, code}
   * @param {object} meta
   * @param {object} ctx
   */
  load(meta, ctx) {
    const r = loadExecPlugin(meta, ctx);
    if (!r.ok) return { ok: false, error: r.error, code: r.code };
    return { ok: true, api: r.api };
  },
  /** 适配器级释放：各插件的子进程随其 api.dispose() 关闭（runner 在卸载时调） */
  dispose() { /* 无全局资源 */ },
};
