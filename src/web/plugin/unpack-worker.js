// src/web/plugin/unpack-worker.js —— 资源包解包 Worker（classic worker，不是 module worker）
//
// 为什么是 classic：插件 lib 全是 **classic script**，它们靠 `globalThis.__ULB__` 逐级挂载、
//   靠 `plugin.json` 的 `files[]` **加载顺序**建立依赖。module worker 的 import 语义与此不符，
//   而 classic worker 的 `importScripts()` 天然按调用顺序同步执行 —— 与浏览器里注入 <script> 等价。
//
// 为什么搬进 worker：LZMA 解压实测 300~620ms/MB（解压后），8.28MB 的包要 3.9 秒。
//   这段是**纯同步 CPU**，留在主线程就是 4 秒白屏冻死；放进 worker 后主线程照常渲染。
//
// 消息协议（只有 4 种，刻意保持最小）：
//   ← {t:'init',    base, files[]}          主线程告诉它插件目录与加载顺序
//   → {t:'ready'}                             lib 载好，provider 已捕获
//   → {t:'progress', phase, detail}          进度（块表 / 开始解压 / 完成）
//   ← {t:'unpack',  id, file:{rootId,rel}, bytes}
//   → {t:'done',    id, res:{prefix,entry,files:[[path, Uint8Array]]}, ms}
//   → {t:'fail',    id, code, message}
//
// 硬约束：
//   · 产物字节**一律归一成 Uint8Array** 再 postMessage（LZMA 解出的中间结果是普通 Array，
//     Array 过通道还是 Array，主线程按字节数组处理就会错位）
//   · 用 transferable 移交 ArrayBuffer（8MB 的包做结构化拷贝会再复制一份，白吃内存与时间）

// 插件 index.js 顶层读 `window.SpineViewerPlugins`（懒获取宿主面）。
// worker 里没有 window ⇒ 用 self 兜上，再挂一个**宽容的 stub**：只捕获 register，
// 其余成员一律 no-op（插件可能调用 log/emit 等非必需能力）。
self.window = self;

let captured = null;      // 插件 register 进来的 provider 记录
let loaded = false;       // lib 是否已载入

function installHostStub() {
  const noop = () => {};
  const stub = {
    // 唯一的真实现：捕获插件注册（我们要的就是它的 resolve）
    register(rec) { captured = rec; return true; },
    // worker 里没有文件系统/网络：插件若真要额外取文件，明确抛错而不是静默返回空
    fetchFile() { throw new Error('unpack-worker：worker 内不提供文件读取（字节随消息传入）'); },
    // 进度回调给主线程（插件若有 post 通道就顺手用上）
    post(msg) { self.postMessage(msg); },
  };
  self.SpineViewerPlugins = new Proxy(stub, {
    get(target, key) { return key in target ? target[key] : noop; },
  });
}

/** 把 Array / ArrayBuffer / TypedArray / **Blob** 统一成 Uint8Array（跨线程前必须做） */
async function toU8(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return Uint8Array.from(v);   // ← LZMA 的普通 Array 走这条
  // 插件产物实际是 **Blob**（vfs.register 只收 Blob/字符串），必须读出字节再传
  if (v && typeof v.arrayBuffer === 'function') return new Uint8Array(await v.arrayBuffer());
  return new Uint8Array(0);
}

// 先挂一次（函数声明提升，此处赋值即可）；载完 lib 后 init 分支里会**再挂一次**（见那里的说明）
self.onmessage = handleMessage;

async function handleMessage(ev) {
  const msg = ev.data || {};
  try {
    if (msg.t === 'init') {
      installHostStub();
      // 按 plugin.json 的 files[] 顺序逐条载入（顺序即依赖，不许自己排）
      for (const rel of msg.files || []) importScripts(new URL(rel, msg.base).href);
      loaded = true;
      // ⚠️ 必须**重新挂 onmessage**：lib/lzma-d-min.js 是上游的 worker 版 IIFE，它检测到
      //   "有 onmessage、没有 window.document" 就把自己的 worker 协议处理器赋给 onmessage
      //   （源文件末尾那段自举）。不重挂，后续 unpack 消息会被它吃掉 ⇒ 表现成
      //   "ready 之后再无消息、解包永远不返回"（这个坑实测踩过一次）。
      self.onmessage = handleMessage;
      self.postMessage({ t: 'ready', hasProvider: !!captured, providerId: captured && captured.id });
      return;
    }

    if (msg.t === 'unpack') {
      if (!loaded || !captured || typeof captured.resolve !== 'function') {
        self.postMessage({ t: 'fail', id: msg.id, code: 'ULB_WORKER_NO_PROVIDER', message: 'worker 里没有可用的 provider.resolve（插件注册失败）' });
        return;
      }
      const bytes = toU8(msg.bytes);
      const t0 = Date.now();

      // 注意：这里**不调 captured.canHandle**。
      //   canHandle 走 bundleProbe.run → unityfs.parse（完整解压）+ serialized 解析；
      //   实测把它放进 worker 会长时间无响应（36 秒未返回，原因未定位），所以回退。
      //   类型判定改由「主线程调用 canHandle 时不传 bytes」解耦：插件对无 bytes 的调用直接返回 true
      //   （插件 index.js 的 canHandle 开头 `if (!bytes) return true`），主线程因此零解析成本；
      //   真正的类型判定交给下面 resolve 的成败 —— 认不了就抛错，由主线程换下一个候选。

      // 进度①：读块表（`blocksSummary` 只解 blocksInfo、不碰数据块，实测 ~5ms）
      try {
        const ufs = self.__ULB__ && self.__ULB__.unityfs;
        if (ufs && typeof ufs.blocksSummary === 'function') {
          const s = ufs.blocksSummary(bytes);
          const head = ufs.readHeader(bytes);
          const algoNames = { 0: 'none', 1: 'LZMA', 2: 'LZ4', 3: 'LZ4HC', 4: 'LZHAM' };
          const algo = [...new Set(head.blocks.map((b) => algoNames[b.flags & 0x3f] || '?'))].join('+');
          self.postMessage({
            t: 'progress', id: msg.id, phase: 'blocks',
            detail: {
              algo,
              blocks: s.blockCount,
              decompressedMB: +(s.decompressedBytes / 1048576).toFixed(2),
              // 经验系数：LZMA 约 470ms/MB（实测 2.76~33.4MB 区间 300~620），用于给用户一个量级预期
              estimateMs: algo.includes('LZMA') ? Math.round((s.decompressedBytes / 1048576) * 470) : 0,
            },
          });
        }
      } catch { /* 读块表失败不影响解压，静默跳过 */ }

      // 进度②：开始解压（块级进度钩不到 —— 那在插件内部循环里，本轮不改插件实现）
      self.postMessage({ t: 'progress', id: msg.id, phase: 'unpacking' });

      const res = await captured.resolve({ ...msg.file, bytes, host: self.SpineViewerPlugins });
      if (!res || typeof res !== 'object' || !res.files) {
        self.postMessage({ t: 'fail', id: msg.id, code: 'ULB_WORKER_BAD_RESULT', message: 'resolve 没有返回 files' });
        return;
      }

      // 出口归一：Blob / Array → Uint8Array，并带上 MIME type（主线程要重建 Blob）
      //   vfs.register 只收 Blob 或字符串，所以这里必须把 type 一起带过去
      const files = [];
      const transfer = [];
      const src = res.files instanceof Map ? res.files : Object.entries(res.files);
      for (const [path, val] of src) {
        const type = (val && typeof val.type === 'string') ? val.type : '';
        const u8 = await toU8(val);
        files.push([path, u8, type]);
        if (u8.buffer instanceof ArrayBuffer) transfer.push(u8.buffer);
      }
      self.postMessage({
        t: 'done', id: msg.id,
        res: { prefix: res.prefix, entry: res.entry, files },
        ms: Date.now() - t0,
      }, transfer);
      return;
    }
  } catch (e) {
    self.postMessage({
      t: 'fail', id: msg.id || 0,
      code: (e && e.code) || 'ULB_WORKER_FAIL',
      message: String((e && e.message) || e).slice(0, 300),
    });
  }
};
