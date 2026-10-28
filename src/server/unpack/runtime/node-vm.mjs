// src/server/unpack/runtime/node-vm.mjs —— 「node」运行时适配器（原 plugin-runner 的 vm 沙盒）
//
// 职责：把一个纯 JS 的 classic-script 插件装进 vm 沙盒并跑起来，交出统一的 provider 接口。
// 这段逻辑原本直接写在 plugin-runner.mjs 的 loadPlugin() 里；抽出来的唯一目的是让
//   「插件用什么运行时」变成一个可选项（将来接 exec 通道），**行为一个字节都不变**。
//
// 三条硬约束（从原注释原样保留，都是踩过的坑）：
//   1. **跨 realm 禁止 instanceof**：vm 里建出来的 Map/Blob 与宿主各有一套内置构造器，
//      `instanceof Map` 恒 false、`Object.keys(map)` 恒空（Map 没有自有可枚举键）。
//   2. **装载只做一次**：沙盒 0.9ms + lib 41ms + index.js 6.4ms（实测 58ms）；resolve 本体是秒级，
//      真正重要的是别每次请求都重建沙盒（会重复 58ms + 丢掉插件内部的 profile 缓存）。
//   3. **产物不复制**：见 plugin-runner 的 unpackBytes 注释。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

/** 本适配器能处理的 runtime 名（plugin.json 的 runtime 字段） */
export const RUNTIME = 'node';

/**
 * 在 vm 沙盒里装载一个纯 JS 插件。
 *
 * 错误隔离：**绝不抛给上层** —— 一个插件语法错误/装不起来，只让它自己返回 {ok:false,error}，
 *   其它插件与服务启动都不受影响（调用方按 ok 决定跳过）。
 *
 * @param {{files: string[], entry?: string|null}} meta 插件清单（files 是相对 plugins 目录的 POSIX 路径）
 * @param {{pluginsDir: string}} ctx 主进程侧的路径上下文
 * @returns {{ok: boolean, api?: object, error?: string}}
 */
export function loadPluginModule(meta, ctx) {
  try {
    const pluginsDir = ctx && ctx.pluginsDir;
    if (!pluginsDir) throw new Error('node-vm 适配器缺少 pluginsDir');
    const files = Array.isArray(meta && meta.files) ? meta.files : [];
    if (!files.length) throw new Error('插件清单里没有 files[]（node 运行时需要按序加载的脚本清单）');

    const sandbox = {
      globalThis: {},
      console,
      TextEncoder,
      TextDecoder,
      Blob,
      // node 侧不该建 blob URL：插件里有能力判断，真调到就是回归
      URL: { createObjectURL: () => { throw new Error('node 侧不应调用 createObjectURL'); } },
      AbortController,
      // 插件会用 fetch 拉 profile；拿不到就走内置默认规则（与 17a 同口径）
      fetch: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }),
      setTimeout, clearTimeout, setInterval, clearInterval,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    // 加载顺序完全取清单 files[]：lib 的先后 + 入口文件都在 plugin.json 里声明，
    //   runner 不再维护一串写死的 lib 名（加插件/调顺序都不该改代码）
    for (const rel of files) {
      vm.runInContext(fs.readFileSync(path.join(pluginsDir, rel), 'utf8'), sandbox, { filename: rel });
    }
    const NS = sandbox.__ULB__;
    // 清单里有 lib/ 的插件必须把能力挂到 __ULB__（manifest 与代码不一致时要响亮报错）；
    //   没有 lib/ 的插件不建这个命名空间，跳过即可 —— 通用化后不能强制要求它存在
    const hasLibDir = files.some((f) => f.includes('/lib/'));
    if (hasLibDir && (!NS || !NS.bytes)) throw new Error('lib/bytes.js 未能挂载 __ULB__');
    // 以下几块能力在浏览器由 DecompressionStream / 原生 API 提供，node 侧注入等价实现。
    //   均按"插件是否建了该命名空间/该钩子"判空注入：别的插件不一定有 bytes/png。
    if (NS && NS.bytes && typeof NS.bytes.setSha256 === 'function') {
      NS.bytes.setSha256((u8) => crypto.createHash('sha256').update(u8).digest('hex'));
    }
    if (NS && NS.png) {
      NS.png.setInflate((u8) => new Uint8Array(zlib.inflateSync(Buffer.from(u8))));
      NS.png.setDeflate((u8) => new Uint8Array(zlib.deflateSync(Buffer.from(u8), { level: 6 })));
      // 流式版：编码器按 64 行一块喂进来，这里不攒整张、不转 Buffer。
      //   输出与一次性 deflateSync 逐字节相同（deflate 的切分不影响结果，只要不 flush）。
      //   返回**片段数组**（不 concat）：编码器会把片段直接 set 进一次预分配的 PNG 缓冲，
      //   多一次 concat 就是多一份 18MB。
      NS.png.setDeflateStream(async (chunks) => {
        const d = zlib.createDeflate({ level: 6 });
        const out = [];
        d.on('data', (c) => out.push(c));
        const done = new Promise((res, rej) => { d.on('end', res); d.on('error', rej); });
        for (const c of chunks) d.write(c);
        d.end();
        await done;
        return out;
      });
    }
    // 统一契约 __PLUGIN_API__；__ULB_NODE__ 是首版键名，保留兼容（老插件继续能装）
    const api = sandbox.__PLUGIN_API__ || sandbox.__ULB_NODE__;
    if (!api || typeof api.resolve !== 'function' || typeof api.canHandle !== 'function') {
      throw new Error('插件未挂载 __PLUGIN_API__（或兼容键 __ULB_NODE__）的 resolve/canHandle');
    }
    return { ok: true, api };
  } catch (e) {
    // 只记原因、不抛：一个插件坏掉不能带走别的插件，也不能带走服务启动
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * node 运行时的适配器对象（统一接口，见 runtime/index.mjs）。
 * node 运行时的插件是"进程内同步调用"，没有子进程要管，所以 dispose 是空操作。
 */
export default {
  runtime: RUNTIME,
  /** @param {object} meta @param {object} ctx */
  load(meta, ctx) {
    return loadPluginModule(meta, ctx);
  },
  /** 进程内沙盒，没有外部资源可释放（保留接口是为了两种 runtime 同形） */
  dispose() { /* no-op */ },
};
