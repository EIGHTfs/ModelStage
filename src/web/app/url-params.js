// app/url-params.js —— 用 URL 参数一次性指定「装载哪个模型 / 用哪个运行时」
//
// 为什么做这个（而不是面板按钮）：排查场景是"同一个模型换运行时看现象变不变"，
//   URL 天然可复制、可脚本化、可进回归用例；面板按钮给人点，测试与复现都用不上。
//
// 硬边界（三条，改这里时不许破）：
//   ① **只影响这一次装载**：覆盖值不落 uiState / localStorage，被消费后立刻清空。
//      默认行为永远是"按骨架版本自动挑运行时"—— 那是正确性保证（骨架 4.1.20 只能用 4.1 运行时）。
//   ② 解析到模型后走 `selectModel`（与点名册点选**同一条装载路径**），不新开装载实现。
//   ③ 指定了非法值要**明确报错**，绝不静默忽略 —— 静默会让排查得出"换了没区别"的错误结论。
//
// 形如：/?model=<rootId>/<rel>&runtime=spine-4.1
//       model   先按条目 id 全等匹配，未命中再按 `rootId/rel` 全等匹配（两种写法都认）
//       runtime 可选；不传 = 自动（现状行为）

import { getJson } from '../infra/api.js';
import { selectModel } from './model-actions.js';
import { setForcedRuntime } from '../spine/canvas-runtime.js';
// 取清单走 roster 的**唯一入口**（失败记 diag warn + 回传 reason），与名册那条路同一份实现
import { fetchRootEntries } from '../roster/list.js';
// 深链准入与运行时类型都查面元数据表（不再写死 spine/live2d 字面量）
import { byKind, knownKinds } from '../render/surfaces.js';

/**
 * 取全量 catalog 条目（跨所有资源根）。
 * 为什么不用名册里的已加载数据：名册按游戏/角色分组且可能未展开，
 *   而这里要"精确匹配任意一条"，直接问服务端最可靠。
 * @returns {Promise<{entries: object[], failures: string[], emptyRoots: string[]}>}
 *   failures   = 清单**取不到**的根（带原因）—— 查询失败，可能要重试
 *   emptyRoots = 清单拿到了但**一条都没有**、且服务端有 warnings 的根 —— 查询成功但有话说
 *   两档分开：前者是"查询失败"，后者是"根配错/根是空的"，处置方向完全不同
 */
async function fetchAllEntries() {
  const roots = await getJson('/api/roots').catch(() => null);
  const list = (roots && (roots.roots || roots.items)) || [];
  const out = [];
  const failures = [];
  const emptyRoots = [];
  for (const r of list) {
    const id = r && (r.id || r.name);
    if (!id) continue;
    const { entries, reason, warnings } = await fetchRootEntries(id);
    if (reason) failures.push(`${id}（${reason}）`);
    // 只在"一条都没有"时才带 warnings：正常根服务端也会给通用提示（例如"有 2 个插件能解包"），
    //   塞进正常提示就是纯噪音
    else if (!entries.length && warnings.length) emptyRoots.push(`${id}（${String(warnings[0]).slice(0, 80)}）`);
    for (const e of entries) out.push({ ...e, rootId: e.rootId || id });
  }
  return { entries: out, failures, emptyRoots };
}

/** 两种写法都认：先 id 全等，再 `rootId/rel` 全等 */
function matchEntry(entries, arg) {
  const want = String(arg || '').trim();
  if (!want) return { hit: null, by: '' };
  const byId = entries.filter((e) => String(e.id || '') === want);
  if (byId.length === 1) return { hit: byId[0], by: 'id' };
  if (byId.length > 1) return { hit: null, by: 'id', ambiguous: byId };
  const byRel = entries.filter((e) => `${e.rootId || ''}/${e.rel || ''}` === want);
  if (byRel.length === 1) return { hit: byRel[0], by: 'rootId/rel' };
  if (byRel.length > 1) return { hit: null, by: 'rootId/rel', ambiguous: byRel };
  return { hit: null, by: '' };
}

/** 解析 runtime 参数：`spine-4.1` 或裸 `4.1`；`live2d-*` 明确不支持 */
function parseRuntime(arg) {
  const raw = String(arg || '').trim();
  if (!raw) return { kind: null, version: null };
  if (/^live2d[-:]/i.test(raw)) return { kind: 'live2d', version: raw.replace(/^live2d[-:]/i, '') };
  if (/^spine[-:]/i.test(raw)) return { kind: 'spine', version: raw.replace(/^spine[-:]/i, '') };
  return { kind: 'spine', version: raw };   // 裸版本号默认按 spine 解释
}

/**
 * 报告一条 URL 参数相关的失败：**状态行（用户可见）+ 日志（面板/上传）** 两条都写。
 *
 * 这里不再自己找 DOM 写文本：`#stage-msg` / `[data-role="stage-msg"]` 在全仓都不存在
 *   （status.js 的状态行由 renderStatusLine 统一渲染），那段是死代码，已删。
 *   统一走 stageStatus ⇒ 同一份文案、同一个渲染入口，不会出现"两处各写一份、样式不一致"。
 */
function report(message, level = 'error') {
  import('./status.js').then((m) => {
    if (level === 'error') m.stageLog('error', message, { source: 'url-params', reason: 'url-params' });
    m.stageStatus(message, level === 'error' ? 'error' : 'warn', { show: true });
  }).catch(() => { /* 状态模块不可用：静默放弃（URL 参数只是增强入口，不该让页面挂掉） */ });
}

/**
 * 应用 URL 参数（在资源根加载完成后调用一次）。
 * 无参数时**完全不动**任何状态（返回 null），保证默认行为零变化。
 * @returns {Promise<{model?:string, runtime?:string}|null>}
 */
export async function applyUrlParams() {
  const q = new URLSearchParams(window.location.search);
  const modelArg = q.get('model');
  const runtimeArg = q.get('runtime');
  if (!modelArg && !runtimeArg) return null;

  if (!modelArg) {
    report('URL 参数 runtime= 需要同时提供 model= 才知道要装载哪个模型（形如 /?model=<rootId>/<rel>&runtime=spine-4.1）');
    return { runtime: runtimeArg };
  }

  const { entries, failures, emptyRoots } = await fetchAllEntries();
  const { hit, by, ambiguous } = matchEntry(entries, modelArg);

  if (!hit) {
    const sample = entries.slice(0, 5)
      .map((e) => `  · id=${e.id || '(无)'}   或   ${e.rootId || ''}/${e.rel || ''}`)
      .join('\n');
    // 把"为什么匹配不到"分两档带进提示（否则深链失效看起来就像"模型不存在"）：
    //   ① 某个根的清单**根本没取到**（路径配错/服务端拒绝）—— 该去查配置或服务
    //   ② 某个根**取到了但一条都没有**、且服务端有话说（典型：path 指到空目录/不存在）
    //   两档措辞刻意不同：把 ② 说成"取不到"会让"要不要重试"这类判断失准。
    const failed = failures.length
      ? `。另外有 ${failures.length} 个根的清单取不到：${failures.slice(0, 3).join('；')}${failures.length > 3 ? ' …' : ''}`
      : '';
    const empty = emptyRoots.length
      ? `。另外有 ${emptyRoots.length} 个根存在但没扫出任何模型：${emptyRoots.slice(0, 2).join('；')}${emptyRoots.length > 2 ? ' …' : ''}`
      : '';
    report(ambiguous && ambiguous.length
      ? `URL 参数 model=${modelArg} 命中 ${ambiguous.length} 条（按 ${by} 匹配），无法确定用哪一条；请改用更精确的写法`
      : `URL 参数 model=${modelArg} 没有匹配到任何条目（两种写法都支持：条目 id，或 rootId/rel）${failed}${empty}。前 5 个候选：\n${sample}`);
    return { model: modelArg };
  }

  const rt = parseRuntime(runtimeArg);
  // 深链准入：只有声明 deepLink 的面才允许通过 ?model= 直接指定。
  //   hit.kind 为空是**正常情况**（容器条目解包前不知道内容类型），交给后面判，不在这里报错。
  const hitMeta = byKind(hit.kind);
  if (hitMeta && hitMeta.deepLink === false) {
    report(`URL 参数 model= 指向的条目类型（${hitMeta.label}）不支持深链直接装载；请在页面里手动选择`);
    return { model: modelArg };
  }
  if (hit.kind && !hitMeta) {
    report(`URL 参数 model= 指向的条目类型「${hit.kind}」不是受支持的渲染面`
      + `（已知：${knownKinds().join(' / ')}）`);
    return { model: modelArg };
  }
  // 运行时类型对应的面查元数据表（不再写死 'live2d' / 'spine' 两个字面量）。
  //   未知 kind 显式拒绝：以前会一路静默什么也不做，排查时只看到"参数没效果"。
  const rtMeta = byKind(rt.kind);
  if (rt.kind && !rtMeta) {
    report(`URL 参数 runtime= 的类型「${rt.kind}」不是受支持的渲染面（已知：${knownKinds().join(' / ')}）`);
    return { model: modelArg, runtime: runtimeArg };
  }

  // Live2D 的运行时由服务端探测决定（/live2d-lib/* 的映射是进程级），按请求切换会变成有状态
  //   ⇒ 明确拒绝而不是静默忽略（忽略会让排查得出"换了没区别"的错误结论）
  if (rtMeta && rtMeta.id === 'live2d') {
    let actual = '未知';
    try {
      const ad = await import('../live2d/runtime-adapter.js');
      const info = ad.runtimeInfo();
      actual = `${info.pixi ? `pixi ${info.pixi}` : ''}${info.settingsCtorName ? ` / ${info.settingsCtorName}` : ''}` || '未知';
    } catch { /* 拿不到就写未知 */ }
    report(`Live2D 运行时由服务端探测决定，暂不支持按请求指定（当前生效：${actual}）；`
      + `去掉 runtime= 让服务端自动选择`);
    return { model: modelArg, runtime: runtimeArg };
  }

  // Spine：把版本作为**本次装载**的覆盖值（canvas-engine 消费一次后立即清空）
  if (rtMeta && rtMeta.id === 'spine' && rt.version) {
    setForcedRuntime(rt.version);
  }

  await selectModel(hit, { syncTree: true });
  return { model: modelArg, runtime: runtimeArg, matchedBy: by };
}
