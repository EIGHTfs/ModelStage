// src/server/unpack/runtime/index.mjs —— 运行时适配器的选择器 + 安全门禁
//
// 为什么要有这一层：插件"用什么运行时"从一个硬编码事实（vm 沙盒）变成了清单里的一个字段
//   （plugin.json 的 runtime）。上层（plugin-runner）只认这里的统一接口，不认识具体运行时。
//
// 统一接口（两种 runtime 必须同形，上层无感）：
//   load(meta, ctx) → { ok: true, api } | { ok: false, error, code? }
//   dispose()       → void（进程内沙盒是空操作；exec 通道将来要杀子进程）
// 其中 api 需提供 canHandle(file) / resolve(file)，可选 explainReject(file) / estimateMemory。
//
// **安全门禁（本文件的核心职责）**：
//   runtime:"node" 是"进程内沙盒"，行为与历史一致；runtime:"exec" 是"在你机器上跑一个陌生可执行文件"。
//   两者安全模型完全不同，所以 exec **默认关闭**：必须用户在 config 里显式开启才允许装载。
//   这不是"防君子"的软提示 —— 未开启时装载器会直接拒绝并给出可读原因（不是静默降级）。
import fs from 'node:fs';
import path from 'node:path';
import nodeVm from './node-vm.mjs';
import execRuntime from './exec.mjs';

/** 缺省运行时：插件不写 runtime 时按历史行为走 vm 沙盒 */
export const DEFAULT_RUNTIME = 'node';

/** 已注册的适配器表（加新运行时只需在这里登记） */
const ADAPTERS = new Map([
  [nodeVm.runtime, nodeVm],
  [execRuntime.runtime, execRuntime],
]);

/** 允许出现在清单里的 runtime 名（用于校验，不用于实例化） */
export const KNOWN_RUNTIMES = [...ADAPTERS.keys()];

/**
 * 危险运行时的开关配置文件：与 config/plugins.json 同级，但**独立成文件**。
 * 为什么独立：这个开关决定「是否允许插件在本机执行任意可执行文件」，
 *   让它在部署时是一个显眼、可单独审计与回收的文件，而不是混在大配置里的一个布尔字段。
 * 内容形如：{"allowExecRuntime": true}
 */
export const EXEC_PERMISSION_FILE = 'config/plugin-runtime.json';

/**
 * 读"是否允许 exec 运行时"。
 *
 * 判据顺序：
 *   ① 环境变量 `MODELSTAGE_ALLOW_EXEC_PLUGINS=1`（部署期覆盖，便于容器化）
 *   ② 配置文件 `<root>/config/plugin-runtime.json` 的 allowExecRuntime === true
 *   ③ 都没有 ⇒ **false（默认关闭）**
 * 任何读取/解析失败都按"未开启"处理（失败要保守，不能因为配置坏了就把门打开）。
 * @param {string} root 项目根
 * @returns {{allowed: boolean, source: string, error?: string}}
 */
export function readExecPermission(root) {
  const fromEnv = process.env.MODELSTAGE_ALLOW_EXEC_PLUGINS;
  if (fromEnv === '1' || String(fromEnv).toLowerCase() === 'true') {
    return { allowed: true, source: 'env:MODELSTAGE_ALLOW_EXEC_PLUGINS' };
  }
  const file = path.join(String(root || ''), EXEC_PERMISSION_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // 文件不存在是最常见的正常情况（默认关闭），不算错误
    if (e && e.code === 'ENOENT') return { allowed: false, source: 'default' };
    return { allowed: false, source: 'default', error: `读取 ${EXEC_PERMISSION_FILE} 失败：${e.message}` };
  }
  try {
    const cfg = JSON.parse(text);
    if (cfg && cfg.allowExecRuntime === true) return { allowed: true, source: EXEC_PERMISSION_FILE };
    return { allowed: false, source: EXEC_PERMISSION_FILE };
  } catch (e) {
    // 配置坏了按"未开启"：宁可插件用不了，也不要因为一个笔误把危险通道打开
    return { allowed: false, source: EXEC_PERMISSION_FILE, error: `${EXEC_PERMISSION_FILE} 不是合法 JSON：${e.message}` };
  }
}

/**
 * 取某个插件该用的运行时名（缺省 node；非法值直接报错，不猜）。
 * @param {object} meta 插件清单
 * @returns {{ok: true, runtime: string} | {ok: false, error: string}}
 */
export function resolveRuntimeName(meta) {
  const raw = meta && meta.runtime !== undefined && meta.runtime !== null ? String(meta.runtime) : '';
  if (!raw) return { ok: true, runtime: DEFAULT_RUNTIME };
  if (!ADAPTERS.has(raw)) {
    return { ok: false, error: `未知 runtime："${raw}"（可用：${KNOWN_RUNTIMES.join(' / ')}）` };
  }
  return { ok: true, runtime: raw };
}

/**
 * 按清单选适配器并装载插件（**唯一入口**，plugin-runner 只调这个）。
 *
 * 门禁顺序（先拦后装，任何一步不过都不进适配器）：
 *   ① runtime 名合法？
 *   ② exec ⇒ 用户是否显式开启？（未开启直接拒绝，给出怎么开）
 *   ③ 交给对应适配器装载
 * @param {object} meta 插件清单（含 id / files / runtime? / entry? / frameProtocol?）
 * @param {{pluginsDir: string, root?: string, execAllowed?: {allowed:boolean, source:string}}} ctx
 * @returns {{ok: boolean, api?: object, error?: string, code?: string, runtime: string}}
 */
export function loadWithRuntime(meta, ctx) {
  const rn = resolveRuntimeName(meta);
  if (!rn.ok) return { ok: false, runtime: DEFAULT_RUNTIME, error: rn.error, code: 'UNKNOWN_RUNTIME' };
  const runtime = rn.runtime;

  if (runtime === 'exec') {
    // ctx.execAllowed 允许调用方（测试/上层）注入判定结果，避免这里自己再读一遍盘；
    //   没注入时按默认门禁读配置
    const gate = ctx && ctx.execAllowed ? ctx.execAllowed : readExecPermission(ctx && ctx.root);
    if (!gate.allowed) {
      return {
        ok: false,
        runtime,
        code: 'EXEC_RUNTIME_DISABLED',
        error: `插件「${meta && meta.id}」声明了 runtime:"exec"，但宿主**未开启**该通道，已拒绝装载。`
          + `开启方式（二选一）：① 在 ${EXEC_PERMISSION_FILE} 写 {"allowExecRuntime": true}；`
          + '② 设环境变量 MODELSTAGE_ALLOW_EXEC_PLUGINS=1。'
          + '注意：exec 通道意味着该插件可以执行任意本地命令（读写你的文件、发起网络请求），'
          + '只应对你信任的插件开启。',
      };
    }
  }

  const adapter = ADAPTERS.get(runtime);
  const r = adapter.load(meta, ctx);
  return { ...r, runtime };
}

/** 列出已注册运行时（诊断/自检用） */
export function listRuntimes() {
  return KNOWN_RUNTIMES.map((name) => ({ runtime: name }));
}
