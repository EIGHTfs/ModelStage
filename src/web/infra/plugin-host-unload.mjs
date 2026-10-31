// src/web/infra/plugin-host-unload.mjs —— 卸载与回收（从 plugin-host.js 抽出，B1）
//
// 为什么单独成模块：卸载是"有明确边界的一组收缩动作"（逆序跑 disposer → 清四张表 → 派发事件），
//   它只**写** ctx 里的集合，不参与装载/解包逻辑；搬出去后 plugin-host 里只剩"谁调它"。
//
// 依赖约定（明确传参，不从 ctx 里取工具）：
//   · ctx                 —— 9 个高频共享状态容器（providers/pluginEffects/registeredEffects/loadState/slotRegistry）
//   · manifestEffects     —— 清单声明的效果表（低频状态，留在宿主，这里按引用注入）
//   · workerPool          —— providerId → worker（低频状态，同上）
//   · publishSlotStats    —— 插槽统计发布（宿主里的工具函数）
//   · publishEffectStats  —— 效果统计发布（同上）
// 日志与事件：say/emit 在 ctx 里，但调用口径与搬迁前完全一致（文案逐字未改）。
//
// ⚠️ 事件名 `spineviewer:plugins-loaded` 是**外部契约**（panel-settings 监听并重建面板），
//   改动它等于"卸载后界面不刷新"——本次搬迁逐字保留。

/**
 * @param {{ctx: object, manifestEffects: Map, workerPool: Map,
 *          publishSlotStats: () => void, publishEffectStats: () => void}} deps
 * @returns {{unloadPlugin: (pluginId: string) => Promise<object>, unloadAll: () => Promise<object[]>}}
 */
export function createUnload({ ctx, manifestEffects, workerPool, publishSlotStats, publishEffectStats }) {
  /**
   * 卸载一个插件：逆序跑它的 disposer，再从各张表里摘干净，最后派发事件让面板重建。
   *
   * 为什么必须派发事件：宿主表清掉、DOM 不会自己变；panel-settings 监听
   *   `spineviewer:plugins-loaded` 后重建，控件才真的从界面上消失（只摘宿主表不改 DOM 等于没卸载）。
   * @param {string} pluginId
   * @returns {{pluginId:string, disposed:number, failures:string[], removedEffects:number, slotsRemoved:number, hadProvider:boolean}}
   */
  async function unloadPlugin(pluginId) {
    const id = String(pluginId || '');
    const list = ctx.pluginEffects.get(id) || [];
    // 先记"卸载前有没有"，再回收：disposer 会把 provider 删掉，之后再查就永远是 false（返回值会误导排障）
    const hadProviderBefore = ctx.providers.has(id);
    let disposed = 0;
    const failures = [];
    for (let i = list.length - 1; i >= 0; i -= 1) {      // 逆序：后注册的先撤
      try { list[i].dispose(); disposed += 1; }
      catch (e) { failures.push(`${list[i].kind}:${list[i].label}: ${(e && e.message) || e}`); }
    }
    ctx.pluginEffects.delete(id);

    let removedEffects = 0;
    for (const [eid, e] of [...ctx.registeredEffects]) {
      if (e && e.pluginId === id) { ctx.registeredEffects.delete(eid); removedEffects += 1; }
    }
    const hadProvider = ctx.providers.delete(id);
    try { manifestEffects.delete(id); } catch { /* 老版本没有这张表 */ }
    const wk = workerPool.get(id);
    if (wk) {
      try { if (wk.worker) wk.worker.terminate(); } catch { /* 已终止 */ }
      workerPool.delete(id);
    }
    // 插槽登记也要回收：disposer 虽已挂在 effect 容器里，这里按 pluginId 再兜一次
    //   （历史数据/异常路径可能留下没登记 disposer 的项）
    const slotsRemoved = ctx.slotRegistry ? ctx.slotRegistry.disposeAll(id) : 0;
    publishSlotStats();
    ctx.loadState.delete(id);
    publishEffectStats();
    ctx.say.info(`插件 ${id} 已卸载：执行 ${disposed} 个 disposer${failures.length ? `（${failures.length} 个失败）` : ''}`
      + `，清掉效果 ${removedEffects} 个、插槽 ${slotsRemoved} 个${hadProvider ? '、提供者 1 个' : ''}`);
    // 让面板重建：只清宿主表不改 DOM 的话，控件会继续挂在界面上（等于没卸载）
    try { window.dispatchEvent(new CustomEvent('spineviewer:plugins-loaded', { detail: { unloaded: id } })); } catch { /* 忽略 */ }
    return { pluginId: id, disposed, failures, removedEffects, slotsRemoved, hadProvider: hadProviderBefore };
  }

  /** 卸载全部已装载插件（测试收尾 / 热重载前清理用） */
  async function unloadAll() {
    const ids = [...new Set([...ctx.pluginEffects.keys(), ...ctx.providers.keys(), ...ctx.loadState.keys()])];
    const out = [];
    for (const id of ids) out.push(await unloadPlugin(id));      // 串行：卸载会改宿主表，别并发
    return out;
  }

  return { unloadPlugin, unloadAll };
}
