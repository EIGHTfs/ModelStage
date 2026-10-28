// src/server/unpack/runtime/exec.mjs —— 「exec」运行时适配器（**本轮只有契约骨架，不真起子进程**）
//
// 这一档要解决的是"插件用非 JS 语言写"（Go / Rust / Python / shell 都一视同仁）：
//   宿主 spawn 插件目录里的一个可执行文件，双方用「一行一个 JSON」的帧协议通信。
//
// 为什么本轮故意不实现 spawn：
//   ① 协议细节（大 payload 走临时文件还是流、超时怎么杀、僵尸怎么收、并发怎么命名临时文件）
//      需要真实现才能定稿；先做一个"能跑但没想清楚"的半成品，比不做更危险 ——
//      它会让人以为协议已经可用。
//   ② 当前两个插件都是 node 运行时，没有任何"现在就要靠 exec 才能解开的包"。
//   ③ 安全面完全不同（见下），需要产品层面的开关与警告，不能顺手打开。
//
// **安全边界（与 node-vm 有本质区别）**：
//   node-vm 是"进程内造一个隔离对象当全局"——插件再怎么折腾，也只是在一个 JS 对象里；
//   exec 是"让一个陌生可执行文件在你机器上跑"——它能读你所有文件、连你的网络、
//   看你的环境变量，宿主没有任何办法在进程内部约束它。
//   ⇒ 所以本运行时**默认禁用**，必须用户在配置里显式开启（见 runtime/index.mjs 的门禁）。
import path from 'node:path';

/** 本适配器能处理的 runtime 名 */
export const RUNTIME = 'exec';

/** 未实现的统一错误码（调用方据此区分"契约未实现"与"插件坏了"） */
export const NOT_IMPLEMENTED = 'EXEC_RUNTIME_NOT_IMPLEMENTED';

/** 协议版本：exec 插件必须在 plugin.json 声明 frameProtocol，且必须是本版本 */
export const SUPPORTED_FRAME_PROTOCOL = 1;

/**
 * 校验一个 exec 插件的清单是否自洽（**纯校验，不起进程**）。
 * 这一层是有用的：即使 spawn 还没实现，也能在装载期就把"清单写错了"报出来，
 *   而不是等到真实现时才发现一堆清单不合规。
 * @param {object} meta 插件清单
 * @returns {{ok: true} | {ok: false, error: string, code: string}}
 */
export function validateExecManifest(meta) {
  const entry = meta && meta.entry ? String(meta.entry) : '';
  if (!entry) {
    return { ok: false, code: NOT_IMPLEMENTED, error: 'runtime:"exec" 的插件必须在 plugin.json 里声明 entry（相对插件目录的可执行路径）' };
  }
  // entry 必须是相对路径：绝对路径会让插件把"整机任意可执行文件"变成自己的入口（明显越界）
  if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
    return { ok: false, code: NOT_IMPLEMENTED, error: `runtime:"exec" 的 entry 必须是插件目录内的相对路径（不允许绝对路径或 ..）：${entry}` };
  }
  const fp = meta && meta.frameProtocol;
  if (fp === undefined || fp === null) {
    return { ok: false, code: NOT_IMPLEMENTED, error: 'runtime:"exec" 的插件必须声明 frameProtocol（当前支持版本 1）' };
  }
  if (Number(fp) !== SUPPORTED_FRAME_PROTOCOL) {
    return { ok: false, code: NOT_IMPLEMENTED, error: `不支持的 frameProtocol：${fp}（本宿主支持 ${SUPPORTED_FRAME_PROTOCOL}）` };
  }
  return { ok: true };
}

export default {
  runtime: RUNTIME,
  /**
   * 装载 exec 插件 —— **本轮固定抛"未实现"**。
   * 之所以先校验清单再报未实现：清单错误是"用户配错了"，未实现是"宿主还没做"，
   *   两者对使用者是不同性质的问题，不该混成同一句话。
   * @param {object} meta
   * @param {object} ctx
   * @returns {{ok: false, error: string, code: string}}
   */
  load(meta, ctx) {
    const v = validateExecManifest(meta);
    if (!v.ok) return v;
    // 走到这里说明清单是合法的、只是宿主还没实现：报得明确，不要假装插件坏了
    return {
      ok: false,
      code: NOT_IMPLEMENTED,
      error: `runtime:"exec" 的插件装载器尚未实现（清单校验已通过：entry=${meta.entry}, frameProtocol=${meta.frameProtocol}）。`
        + '按当前排期，exec 通道属第 2 步；本步只定契约。',
    };
  },
  dispose() { /* 没有子进程可杀 */ },
};
