// check-plugin-host.mjs —— 检查器用的「最小宿主垫片」（把插件跑在 node:vm 里）
//
// 为什么单独成文件：这是本工具唯一可能与真实宿主不一致的部分，单独放便于对照契约 §3.6 审阅，
//   也便于将来宿主形状变化时只改这一处（检查器的其它部分是纯静态判定）。
//
// 垫片能力刻意保持最小（契约 §3.6）：register / log / fetchFile 三件，不提供任何真实 I/O。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
/**
 * 造一个"最小宿主垫片"（契约 §3.6）。
 *
 * 为什么要 vm 而不是 require：插件是**注入式经典脚本**（非 ESM，§三），
 *   多个文件共享同一个全局作用域、按 files[] 顺序注入；用 vm 建一个共享 context
 *   才能忠实还原这一点（require 会把每个文件当独立模块，全局变量就串不起来了）。
 */
export function createSandbox() {
  const registered = [];
  const logs = [];
  const host = {
    /** 注册入口（§三）：只收集，不执行宿主逻辑 */
    register(desc) { registered.push(desc); },
    /** 日志（§3.6 / §3.4）：插件应走 host.log，不允许裸 console 作为用户可见输出 */
    log(level, msg, scope) { logs.push({ level: String(level), msg: String(msg), scope: scope == null ? null : String(scope) }); },
    /** 取字节（§3.6）：离线垫片没有真实资源，按契约抛可退化错误 */
    fetchFile() {
      const err = new Error('check-plugin 垫片未提供 fetchFile（离线检查不读真实资源）');
      err.code = 'ULB_ERR_NO_HOST';
      return Promise.reject(err);
    },
  };
  const consoleShim = {
    log: (...a) => logs.push({ level: 'console.log', msg: a.map(String).join(' '), scope: null }),
    info: (...a) => logs.push({ level: 'console.info', msg: a.map(String).join(' '), scope: null }),
    warn: (...a) => logs.push({ level: 'console.warn', msg: a.map(String).join(' '), scope: null }),
    error: (...a) => logs.push({ level: 'console.error', msg: a.map(String).join(' '), scope: null }),
    debug: (...a) => logs.push({ level: 'console.debug', msg: a.map(String).join(' '), scope: null }),
  };
  const sandbox = {
    console: consoleShim,
    // 插件解析二进制要用到这些；vm 的新 context 默认没有 Node 的全局，必须显式给
    TextDecoder,
    TextEncoder,
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Int8Array,
    Int16Array,
    Int32Array,
    Float32Array,
    Float64Array,
    ArrayBuffer,
    DataView,
    Promise,
    URL,
    setTimeout: (fn) => { try { fn(); } catch { /* 垫片里同步跑，异常交给插件自己的 try */ } return 0; },
    clearTimeout: () => {},
  };
  // 关键：浏览器里 window === globalThis，插件既可能写 window.X 也可能写全局 X。
  //   垫片若把 window 做成独立对象，像 __ULB__ 这种「挂全局」的插件就会静默不注册
  //   （实测踩到：unity 插件的 lib/*.js 全部挂全局，导致 B2 误报未注册）。
  //   所以这里让沙箱对象本身充当全局，window / self 都指回它。
  sandbox.SpineViewerPlugins = host;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  return { sandbox, host, registered, logs };
}

/** 把插件的 files[] 依次注入同一个 context（还原宿主的注入顺序语义） */
export function loadIntoContext(dir, files, sandbox) {
  const ctx = vm.createContext(sandbox);
  const compiled = [];
  for (const rel of files) {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) return { ctx, compiled, missing: rel };
    const code = fs.readFileSync(abs, 'utf8');
    // B1：编译通过（语法层面）
    compiled.push({ rel, script: new vm.Script(code, { filename: `${path.basename(dir)}/${rel}` }) });
  }
  for (const c of compiled) c.script.runInContext(ctx, { timeout: 5000 });
  return { ctx, compiled, missing: null };
}

/** 判定一个值是不是"可 thenable"（用来抓 async canHandle 这种恒真值陷阱） */
export const isThenable = (v) => !!v && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';

/** 构造 canHandle 的四种"坏输入"（B5） */
export function badInputs() {
  const random = new Uint8Array(16);
  for (let i = 0; i < random.length; i += 1) random[i] = (i * 37 + 11) & 0xff;
  return [
    { label: 'null', value: null },
    { label: '{}', value: {} },
    { label: '空 Uint8Array', value: { name: 'x.bin', bytes: new Uint8Array(0) } },
    { label: '随机字节', value: { name: 'y.bin', bytes: random } },
  ];
}

