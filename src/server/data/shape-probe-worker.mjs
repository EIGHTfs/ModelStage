// data/shape-probe-worker.mjs —— 后台形态探测的**解析线程**（契约 §八 的执行者之一）
//
// 为什么要有它：解析一个 40MB 的 UnityFS 包要 ~543ms，纯 CPU。放在主线程里
//   会把事件循环钉住，用户那边就表现成"某个请求莫名慢半秒"（实测 catalog P95 +45ms、max +865ms）。
//   挪进 worker 之后主线程不再被解析占用，探测可以放开节奏跑。
//
// 刻意做得极简（只有"读包 → 出形态"，不搬解包 worker 的那套状态机）：
//   · 入：{ id, abs }（绝对路径）
//   · 出：{ id, ok, assetDependency?, dependencyReason? } 或 { id, ok:false, error }
//   判定仍然复用 tool/lib/bundle-probe-node.mjs（与 /api/unpack、前端同一份实现）。
import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';

import { probeBundleBytes } from '../../../tool/lib/bundle-probe-node.mjs';

parentPort.on('message', async (msg) => {
  const id = msg && msg.id;
  const abs = msg && msg.abs;
  if (typeof id !== 'number' || typeof abs !== 'string' || !abs) return;
  try {
    // 读盘也放在 worker 里：40MB 的 readFile 虽然异步，但落在主线程上仍要排队回调
    const bytes = new Uint8Array(await fs.promises.readFile(abs));
    const shape = probeBundleBytes(bytes);
    parentPort.postMessage({
      id,
      ok: true,
      assetDependency: !!(shape && shape.assetDependency),
      dependencyReason: (shape && shape.dependencyReason) || null,
    });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: (e && e.message) || String(e) });
  }
});
