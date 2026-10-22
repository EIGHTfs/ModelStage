// render/surface-switch.js —— 渲染面切换状态机（last-wins 排队 + 单次切换时序）
//
// 从 surface.js 拆出的原因：切换是"渲染面"最核心也最易错的一段（串行锁、排队、失败回滚、
//   唯一写入 data-stage-mode），单独成文件便于审计与回归；时序与副作用仍全部通过 ctx 回调
//   走 Surface 既有的 setMode / disposeActive / handle，不新增第二条切换入口。
//
// 组装 Document 走 Assets 层（infra/document.js）：本文件只做切换时序，不取模型资源。

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
      // 门禁（契约 D1）：activate 只接受 Document。
      //   传旧形状（catalog entry，没有 state 字段）→ **直接抛错**，不做兜底组装：
      //   兜底一旦留着，忘了组装的调用点就会静默走它，契约形同虚设。
      const doc = document;
      if (!doc || typeof doc.state !== 'string') {
        const got = doc && typeof doc === 'object' ? `普通对象（kind=${doc.kind || '?'}）` : String(doc);
        throw new Error(`surface.activate 只接受 Document（请先 buildDocument 组装），收到：${got}`);
      }
      // ready 之外（如 error）不进入渲染层，但属可预期的用户侧失败：给提示、不抛
      if (doc.state !== 'ready') {
        const why = (doc && (doc.warnings || []).join('；')) || '缺少 Document';
        note(`跳过装载：Document 不可用（${(doc && doc.state) || 'none'}）：${why}`);
        setMode(previous === 'live2d' ? 'live2d' : 'spine');
        return null;
      }
      const kind = doc.kind === 'live2d' ? 'live2d' : 'spine';
      const rendererId = doc.rendererId || kind;
      const entry = renderers.get(rendererId);
      if (!entry) throw new Error(`没有注册渲染器：${rendererId}`);
      measure();
      const info = await entry.mount(doc, handle(rendererId)); // ③ 装载
      state.activeId = rendererId;
      state.document = doc || null;
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
