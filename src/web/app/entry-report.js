// app/entry-report.js —— 装载结果上报（契约《条目状态与展示归属》§三 的前端侧）
//
// 为什么要有这一层：装载成功/失败都必须写进服务端的条目状态，并且**立刻**把那一行画对。
//   服务端的 POST /api/entries/result 是"写读一体"的：响应里就带回重算后的
//   display/support/loadResult。所以这里一次请求同时完成两件事，不需要再拉 /api/catalog
//   （那是秒级扫描，为一行颜色付这个代价是浪费，而且刚解包时它未必已经能看到）。
//
// 旁路原则（契约 INV-D3）：上报失败**绝不能**影响装载结果 —— 所有异常在这里吞掉只记日志。
import { postJson } from '../infra/api.js';
import { stageLog } from './status.js';
import { state } from './context.js';

/**
 * 条目的状态键：与 VFS 前缀同构，`${rootId}/${rel}`。
 *
 * 为什么不用条目 id：容器 id 是 `bundle-<rootId>-<rel 把 / 换成 _>` 派生的，**不可逆**，
 *   不同 rel 可能撞成同一个键；而 rootId/rel 是解包与存储都天然认得的形态。
 * @param {object} model 名册条目
 * @returns {string} 空串 = 这个条目没有可用的键（调用方应跳过上报）
 */
export function entryStateKey(model) {
  const rootId = String((model && model.rootId) || '');
  const rel = String((model && (model.rel || model.srcDir || model.name)) || '');
  if (!rootId || !rel) return '';
  return `${rootId}/${rel}`;
}

/**
 * 上报一次装载结果，并用响应就地更新名册那一行。
 *
 * @param {object} model 名册条目
 * @param {{result: 'ok'|'failed', reason?: string|null, message?: string|null,
 *          provider?: string|null}} outcome 结果（reason 用契约码，message 是人话）
 * @returns {Promise<object|null>} 服务端重算后的三字段；失败/未上报返回 null
 */
export async function reportEntryResult(model, outcome) {
  const key = entryStateKey(model);
  if (!key) return null;
  const body = {
    key,
    result: outcome.result === 'ok' ? 'ok' : 'failed',
    reason: outcome.reason || null,
    message: outcome.message || null,
    provider: outcome.provider || null,
    size: Number.isFinite(model && model.size) ? Number(model.size) : undefined,
    source: 'client',
  };
  try {
    const res = await postJson('/api/entries/result', body, { retries: 0 });
    const computed = res && res.entry ? res.entry : null;
    if (computed) {
      // 必须走名册的写回入口，不能只刷 DOM：
      //   传进来的 model 是 normalizeEntry 的**副本**（`{ ...entry }`），
      //   改它不会影响名册渲染用的那个对象 ⇒ 下一次 render 就读回旧值，
      //   表现为"当场变了色、一切换/搜索就掉回中性色"（实测的老 bug）。
      //   setEntryState 按 id 找到名册持有的原对象、写回三字段，再重画那一行。
      const roster = state.roster;
      const id = String((model && (model.id || model.name)) || '');
      try {
        if (roster && typeof roster.setEntryState === 'function' && id) roster.setEntryState(id, computed);
      } catch { /* 名册刷新失败不影响装载，也不影响已写入的服务端状态 */ }
    }
    return computed;
  } catch (e) {
    // 旁路：上报失败只记一条 info，绝不升级成装载失败
    try {
      stageLog('info', `装载结果未上报（${(e && e.message) || e}）：${key}`, { key, result: body.result });
    } catch { /* 日志失败也不影响 */ }
    return null;
  }
}
