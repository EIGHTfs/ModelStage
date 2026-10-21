// render/surface-switch.js —— 渲染面切换状态机（last-wins 排队 + 单次切换时序）
//
// 从 surface.js 拆出的原因：切换是"渲染面"最核心也最易错的一段（串行锁、排队、失败回滚、
//   唯一写入 data-stage-mode），单独成文件便于审计与回归；时序与副作用仍全部通过 ctx 回调
//   走 Surface 既有的 setMode / disposeActive / handle，不新增第二条切换入口。

/**
 * 创建切换器。
 * @param {{
 *   renderers: Map,
 *   state: {activeId: string|null, document: object|null, swapping: boolean, pending: object|null},
 *   setMode: (mode: string) => string,
 *   disposeActive: () => Promise<void>,
 *   handle: (id: string) => object,
 *   measure: () => void,
 *   requestRender: () => void,
 *   note: (message: string, level?: string) => void,
 *   noteSwitch: (tag: string) => string,
 *   onSwitched: (activeId: string|null) => void,
 * }} ctx
 */
export function createSwitcher(ctx) {
  const { renderers, state, setMode, disposeActive, handle, measure, requestRender, note, noteSwitch, onSwitched } = ctx;

  /**
   * 切换到一份文档（全项目唯一的渲染面切换入口）。
   * 竞态语义（last-wins）：切换进行中再次点击时**不丢弃**，记成 pending，
   *   本轮完成后立刻继续切到最新那份 —— 避免出现"旧面内容已释放 + 新面没装"的空白中间态。
   * @param {object} document 舞台文档
   * @returns {Promise<object|null>} 装载结果；null 表示本次请求被排队（由后面那次切换生效）
   */
  async function activate(document) {
    if (state.swapping) {
      state.pending = document;
      note(`切换进行中，本次请求排队（${(document && document.kind) || '?'}）`);
      return null;
    }
    let current = document;
    state.swapping = true;
    try {
      for (;;) {
        state.pending = null;
        const info = await runSwitch(current);
        onSwitched(state.activeId);
        if (!state.pending) return info;
        current = state.pending;
      }
    } finally {
      state.swapping = false;
      state.pending = null;
    }
  }

  /**
   * 单次切换时序：loading 遮罩 → 统一卸载 → 装载 → 切面 → 请求帧。
   * 失败回滚到上一个面；若期间已有新请求，则把失败"吞掉"改切新的那份（不留下中间态）。
   * @param {object} document
   * @returns {Promise<object>}
   */
  async function runSwitch(document) {
    const previous = state.activeId;
    setMode('loading');           // ① 先遮住：任何方向都不可能叠加
    try {
      await disposeActive();      // ② 统一卸载（幂等）
      const kind = document && document.kind === 'live2d' ? 'live2d' : 'spine';
      const rendererId = (document && document.rendererId) || kind;
      const entry = renderers.get(rendererId);
      if (!entry) throw new Error(`没有注册渲染器：${rendererId}`);
      measure();
      const info = await entry.mount(document, handle(rendererId)); // ③ 装载
      state.activeId = rendererId;
      state.document = document || null;
      setMode(kind);              // ④ 切面（全项目唯一写入点）
      requestRender();
      noteSwitch(`activated:${rendererId}`);
      return info;
    } catch (err) {
      // ⑤ 失败回滚：回到上一个面（没有就回到 spine），并如实记日志
      setMode(previous === 'live2d' ? 'live2d' : 'spine');
      state.activeId = previous;
      noteSwitch(`activate-failed:${(document && document.kind) || '?'}`);
      if (state.pending) {
        // 期间又来了新的选择：以最新那份为准，旧失败不再外抛（否则用户看到无意义的中间态错误）
        note(`切换已被新的选择取代：${(err && err.message) || err}`);
        return null;
      }
      throw err;
    }
  }

  return { activate };
}
