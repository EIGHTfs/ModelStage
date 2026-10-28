import { markModelFailed } from '../infra/ready.js';
// 面元数据表：kind / rendererId → 面属性一律查表，不在这里写二分判断
import { byIdOrKind, byKind } from './surfaces.js';

/**
 * 回显"切换前的那个面"。previous 是**渲染器 id**（可能为 null）。
 * 查不到就退回 'loading'（遮住）而不是猜一个面：
 *   此刻旧面已经卸载，写错面会让 CSS 布局与覆盖层显隐按错误的面走，比遮住更糟。
 * @param {string|null} previous
 * @returns {string} 可直接交给 setMode 的值
 */
function modeOfPrevious(previous) {
  const s = byIdOrKind(previous);
  return s ? s.stageMode : 'loading';
}
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
   * ① 切换前收尾：算出卸载方式并执行卸载。
   *
   * 分流规则（契约 D1，**最容易在重构里被顺手改错的地方**）：
   *   · 同一渲染器换内容（spine→spine / live2d→live2d）→ unmount：释放内容与自建 GL 资源，
   *     但保留引擎/PIXI 覆盖层，再装载更快
   *   · 换渲染器（spine↔live2d）→ dispose：彻底拆，**不留旧 GL 上下文**
   *     （留着就是契约 §五-7 说的"遗留自建 GL 资源"，且连续切换会累积上下文）
   * @param {object} document 目标文档（用来推断 nextId）
   * @param {string|null} previous 切换前的渲染器 id
   */
  async function unloadPrevious(document, previous) {
    // nextId 推导查表：document.rendererId 优先，否则用 kind 对应的面 id。
    //   查不到（未知 kind）⇒ nextId=null ⇒ 下面按"不同渲染器"处理走 dispose，
    //   即彻底拆掉旧引擎与 GL 资源 —— 这是保守方向（契约 §五-7 禁止遗留旧 GL 上下文）。
    const nextId = (document && (document.rendererId || (byKind(document.kind) || {}).id)) || null;
    const unloadMode = previous && previous === nextId ? 'unmount' : 'dispose';
    note(`卸载模式=${unloadMode}（previous=${previous || 'none'} next=${nextId || 'none'}）`);
    await disposeActive(unloadMode);
  }

  /**
   * ② 装配新渲染器 + 切换后通知。成功返回 {skipped:false, info}；失败**原样抛出**交给 ③ 回滚。
   *
   * 顺序即契约：measure → mount → 写 activeId/document → setMode(kind) → requestRender → noteSwitch。
   *   尤其 activeId 必须**在 mount 成功之后**才写（失败时由 ③ 回滚到 previous）。
   * @param {object} document
   * @param {string|null} previous 切换前的渲染器 id（Document 不可用时用它回显旧面）
   */
  async function assembleAndActivate(document, previous) {
    // 门禁（契约 D1）：activate 只接受 Document。
    //   传旧形状（catalog entry，没有 state 字段）→ **直接抛错**，不做兜底组装：
    //   兜底一旦留着，忘了组装的调用点就会静默走它，契约形同虚设。
    if (!document || typeof document.state !== 'string') {
      const got = document && typeof document === 'object' ? `普通对象（kind=${document.kind || '?'}）` : String(document);
      // 就绪信号：失败必须是显式 failed + 原因（测试当场能报，而不是等超时）
      markModelFailed(`不是 Document：收到 ${got}`);
      throw new Error(`surface.activate 只接受 Document（请先 buildDocument 组装），收到：${got}`);
    }
    // ready 之外（如 error）不进入渲染层，但属可预期的用户侧失败：给提示、不抛
    if (document.state !== 'ready') {
      const why = (document.warnings || []).join('；') || '缺少 Document';
      note(`跳过装载：Document 不可用（${document.state || 'none'}）：${why}`);
      markModelFailed(`Document 不可用（${document.state || 'none'}）：${why}`);
      setMode(modeOfPrevious(previous));
      return { skipped: true, info: null };
    }
    // kind 查表：未知 kind **显式抛错**，不再"不是 live2d 就当 spine"。
    //   二分语义只有两个面时成立；加第三个面时它会把新面标成 spine ⇒ setMode 写错面、
    //   handle() 拿错画布、卸载模式也可能算错，全都无声发生。
    const meta = byKind(document.kind);
    if (!meta) throw new Error(`不支持的渲染面「${document.kind || '?'}」：未在 render/surfaces.js 注册`);
    const kind = meta.kind;
    const rendererId = document.rendererId || kind;
    const entry = renderers.get(rendererId);
    if (!entry) throw new Error(`没有注册渲染器：${rendererId}`);
    measure();
    const info = await entry.mount(document, handle(rendererId)); // ③ 装载
    state.activeId = rendererId; state.document = document || null;
    setMode(kind);              // ④ 切面（全项目唯一写入点）
    requestRender();
    noteSwitch(`activated:${rendererId}`);
    return { skipped: false, info };
  }

  /**
   * ③ 失败回滚：回到上一个面（没有就回到 spine），并如实记日志。
   *
   * 注意顺序：先 setMode 回显旧面，再把 activeId 改回 previous —— 与原实现一致；
   *   顺序颠倒会让"切面"读到已经回滚的 activeId。
   * 若期间已有新请求（state.pending），把失败**吞掉**：以最新那份为准，
   *   旧失败不再外抛（否则用户看到无意义的中间态错误）。
   * @returns {{swallowed:boolean}}
   */
  function rollbackOnFailure(document, previous, err) {
    setMode(modeOfPrevious(previous));
    state.activeId = previous;
    noteSwitch(`activate-failed:${(document && document.kind) || '?'}`);
    if (state.pending) {
      note(`切换已被新的选择取代：${(err && err.message) || err}`);
      return { swallowed: true };
    }
    return { swallowed: false };
  }

  /**
   * 单次切换时序：loading 遮罩 → 收尾 → 装配 → 请求帧。本体只做编排，细节在三段里。
   * @param {object} document
   * @returns {Promise<object|null>} 装载结果；Document 不可用或有新请求取代时返回 null
   */
  async function runSwitch(document) {
    const previous = state.activeId;
    setMode('loading');           // ① 先遮住：任何方向都不可能叠加
    try {
      await unloadPrevious(document, previous);
      const r = await assembleAndActivate(document, previous);
      return r.skipped ? null : r.info;
    } catch (err) {
      const rb = rollbackOnFailure(document, previous, err);
      if (rb.swallowed) return null;
      throw err;
    }
  }

  return { activate };
}
