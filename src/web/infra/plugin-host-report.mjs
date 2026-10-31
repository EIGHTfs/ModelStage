// src/web/infra/plugin-host-report.mjs —— 宿主报告（从 plugin-host.js 抽出，B1）
//
// 为什么单独成模块：它是"纯读"（只顺着 ctx 读状态，不写、不产生副作用），
//   是所有内部块里依赖最少的一块（只依赖 ctx），也是最安全的第一块搬迁。
//
// 依赖约定：
//   · 只接收 ctx（9 个高频共享状态的容器）；say/emit 也在 ctx 里，但本模块**不用**它们
//   · 不做 IO、不派发事件、不改任何状态 —— 保证"报告"永远不会影响宿主行为

/**
 * @param {{ctx: object}} deps
 * @returns {() => object} report()：装载状态 + 已注册提供者的排障快照
 */
export function createReport({ ctx }) {
  /** 排障快照：装载状态 + 已注册提供者 */
  function report() {
    return {
      loaded: ctx.loaded,
      discovered: ctx.discovered.map((p) => p.id),
      providers: [...ctx.providers.values()].map((p) => ({
        id: p.id,
        provides: Array.isArray(p.provides) ? p.provides.slice() : [],
        kind: p.kind || null,
        fileKinds: Array.isArray(p.fileKinds) ? p.fileKinds.slice() : [],
        hasCanHandle: typeof p.canHandle === 'function',
        hasResolve: typeof p.resolve === 'function',
      })),
      loadState: [...ctx.loadState.entries()].map(([id, s]) => ({ id, ...s })),
    };
  }
  return report;
}
