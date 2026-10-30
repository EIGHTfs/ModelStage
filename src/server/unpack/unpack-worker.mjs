// server/unpack/unpack-worker.mjs —— 解包 worker（常驻、单实例）
//
// 搬进来的**整段**：读包 → vm 沙盒装载插件（复用 runtime/index.mjs 的 loadWithRuntime，
//   由 plugin-runner 内部调用，这里不另写一份）→ 插件 resolve → 原子落盘 → 写 probe。
//
// 为什么落盘也搬进来：落盘是"23~39 个小文件写 SMB"，实测同样是阻塞源；只搬解压等于把一半
//   的卡顿留在主线程。落盘后只回传**清单**（相对路径 + 字节数 + 指纹），不回传 files Buffer
//   —— 那可能是几十 MB，postMessage 复制一份毫无必要。
//
// 内存口径：worker_threads 里 /proc/self 指向同一进程 ⇒ rssNow/recordMeasuredPeak 的口径
//   与搬之前完全一致，测量代码一个字都没改（只是换了执行线程）。

import { parentPort, workerData } from 'node:worker_threads';

import { unpackFile, listProviderPlugins, ensurePlugin } from './plugin-runner.mjs';
import { writeResult } from './write-result.mjs';
import { createProbeStore } from './probe-store.mjs';
import { rssNow } from './mem-probe.mjs';

const rootDir = workerData && workerData.rootDir;
if (!rootDir) throw new Error('unpack-worker: workerData.rootDir 必填');

const probeStore = createProbeStore({ rootDir });
// 非 Linux 兜底峰值（主线程那边是 counters.peakRss，worker 里各自维护一份；VmHWM 可用时用不到）
let localPeak = 0;
function sampleRss() {
  const rss = process.memoryUsage().rss;
  if (rss > localPeak) localPeak = rss;
  return rss;
}

// ── 预热：把 provider 插件在**收到任何请求之前**装好 ─────────────────────────────
// 为什么必须预热：插件 lib（16 个文件 + LZMA 解码器）的装载分配发生在本 worker 首次
//   ensurePlugin 时（由 unpackFile 内部触发）。不预热，这份**一次性开销**会被算进第一个包的
//   measuredPeakBytes —— 实测把锚点包 z46_2 从 136.7MB 顶到 232.6MB（+70%），而该值又被准入
//   当"下限兜底"用 ⇒ 同样大小的包"有时过有时不过"，判据随"是不是第一个包"抖动。
//   worker 常驻、插件本来就要装，预热顺便让第一次解包更快。
// 失败不阻断：ensurePlugin 本身绝不抛（失败进 {ok:false,error}），这里只记 warn，
//   后续 unpackFile 自己会再试 —— 预热的目的只是"移出测量窗口"，不是"保证装成功"。
try {
  for (const meta of listProviderPlugins()) {
    const r = ensurePlugin(meta.id);
    if (r && r.ok) continue;
    console.warn(`[unpack-worker] 预热插件失败（不影响后续解包，届时会重试）：${meta.id} ${(r && r.error) || ''}`);
  }
} catch (e) {
  console.warn(`[unpack-worker] 预热插件异常（不影响后续解包）：${(e && e.message) || e}`);
}

parentPort.on('message', async (msg) => {
  const { id, rootId, rel, absPath, fp, meta, decl } = msg || {};
  try {
    const before = rssNow(localPeak);
    const res = await unpackFile({ rootId, rel, absPath });
    if (!res.ok) {
      parentPort.postMessage({ id, ok: false, reason: res.reason, message: res.message });
      return;
    }
    const tWrite0 = Date.now();
    // pluginId 必须记「**真正解出产物的那个**插件」：store 传进来的 meta.pluginId 来自 runnerInfo()，
    //   它恒为**列表第一个**注册插件（多插件环境下常与真正命中的不是同一个）⇒ 与 prefix 自相矛盾
    //   （prefix 是 picked.id 算出来的，而 index.json 却记了别人，prefix 校验因此 25/25 报不一致）。
    //   这里用 unpackFile 回传的 picked.id 覆盖，不再多写一次盘（方案 B 才需要回写）。
    const { index } = await writeResult({
      rootDir,
      fp,
      res,
      meta: { ...meta, pluginId: res.pluginId || meta.pluginId },
      probeStore,
      sampleRss,
    });
    const writeMs = Date.now() - tWrite0;
    const after = rssNow(localPeak);
    // **顺序不变**：recordMeasuredPeak 必须在 writeResult 之后 ——
    //   它会在 <fp>/ 下 mkdir + 写 probe.json；若在 rename 之前写，目标目录非空 ⇒ rename 报 ENOTEMPTY。
    const tProbe0 = Date.now();
    probeStore.recordMeasuredPeak(fp, before, after, decl);
    const probeMs = Date.now() - tProbe0;
    parentPort.postMessage({
      id,
      ok: true,
      index,
      prefix: res.prefix,
      entry: res.entry,
      unpackMs: res.unpackMs,
      readMs: res.readMs,
      writeMs,
      probeMs,
      measured: { before, after },
    });
  } catch (e) {
    // 落盘/装载抛错：如实回传，主线程据此走原有的失败分支（计数、日志、返回 HTTP）
    parentPort.postMessage({ id, ok: false, reason: 'worker-error', message: String((e && e.message) || e) });
  }
});
