// infra/mem-stats.js —— 资源与上下文计数（**只读观测**，不改变任何清理/渲染逻辑）
//
// 为什么需要它：现场症状是"加载资源包/切 Live2D 之后画布黑 + 网络失败"，
//   而 `stage.stats().contexts` 只是 `gl ? 1 : 0`（恒 0/1），**验证不了泄漏**。
//   浏览器对 WebGL 上下文有硬上限（约 16 个），超了会丢弃最旧的 ⇒ 画布黑。
//   所以这里自己维护"累计创建 / 已释放 / 仍存活"三档计数，把"累积"变成可读数字。
//
// 实现方式：包装 HTMLCanvasElement.prototype.getContext 与 WEBGL_lose_context.loseContext，
//   只做计数，不改变返回值与行为（幂等安装，重复调用安全）。

const st = {
  installed: false,
  created: 0,      // 累计创建成功的 webgl/webgl2 上下文数（单调递增，泄漏会线性涨）
  lost: 0,         // 观测到的 loseContext 次数
  byType: {},      // 'webgl' / 'webgl2' → 次数
  contexts: [],    // 每条 {type, at, connected}（at=创建时刻，connected=canvas 是否仍在文档里）
};

/** 安装计数钩子（幂等） */
export function installMemStats() {
  if (st.installed || typeof HTMLCanvasElement === 'undefined') return;
  st.installed = true;
  const proto = HTMLCanvasElement.prototype;
  const orig = proto.getContext;
  proto.getContext = function patched(type, ...rest) {
    const ctx = orig.call(this, type, ...rest);
    try {
      if (ctx && /webgl2?$/i.test(String(type))) {
        // ⚠ 只统计**新创建**的上下文：同一 canvas 重复 getContext 会返回同一个上下文，
        //   若按调用次数累加就会把"特征探测/像素读取"误记成泄漏（我第一版就错了，差点误判根因）。
        const already = st.contexts.find((r) => r.canvas === this && r.type === String(type));
        if (already) return ctx;
        st.created += 1;
        st.byType[type] = (st.byType[type] || 0) + 1;
        const rec = { type: String(type), at: Date.now(), canvas: this,
          // 记录身份特征，便于指认"这些 canvas 是谁建的"
          id: this.id || '', cls: (this.className && String(this.className).slice(0, 40)) || '',
          w: this.width, h: this.height };
        st.contexts.push(rec);
        // 包装 loseContext：真被释放了就记一笔（用于算"仍存活"）
        const lose = ctx.getExtension && ctx.getExtension('WEBGL_lose_context');
        if (lose && typeof lose.loseContext === 'function' && !lose.__counted) {
          const origLose = lose.loseContext.bind(lose);
          try {
            lose.loseContext = () => { st.lost += 1; rec.lost = true; return origLose(); };
            lose.__counted = true;
          } catch { /* 只读扩展对象：忽略 */ }
        }
      }
    } catch { /* 计数失败不影响页面 */ }
    return ctx;
  };
}

/**
 * 读当前计数。
 * @returns {{glContexts: number, glContextsLive: number, glContextsLost: number, byType: object,
 *   canvases: number, canvasesWithGl: number, orphanGl: number, jsHeapMB: number|null}}
 *   glContexts   累计创建数（泄漏判据：随切换线性增长）
 *   glContextsLive 创建 − 已释放（近似"同时存活"数）
 *   orphanGl     上下文仍在、但 canvas 已脱离文档（"旧 canvas 没删"）
 *   canvases     DOM 里的 canvas 数
 */
export function memStats() {
  let canvases = 0;
  let canvasesWithGl = 0;
  try {
    const list = [...document.querySelectorAll('canvas')];
    canvases = list.length;
    for (const c of list) {
      st.contexts.forEach((r) => { if (r.canvas === c) canvasesWithGl += 1; });
    }
  } catch { /* 忽略 */ }
  const orphanGl = st.contexts.filter((r) => !r.lost && r.canvas && !r.canvas.isConnected).length;
  let jsHeapMB = null;
  let jsHeapLimitMB = null;
  let jsHeapPct = null;
  try {
    const m = performance && performance.memory;
    if (m && m.usedJSHeapSize) {
      jsHeapMB = Math.round((m.usedJSHeapSize / 1048576) * 10) / 10;
      // 内存保护（T11）需要的是"占上限的比例"，只给 MB 无法判断还剩多少余量。
      //   totalJSHeapSize 是"已分配额度"、jsHeapSizeLimit 才是硬上限 ⇒ 后者才是判据。
      if (m.jsHeapSizeLimit) {
        jsHeapLimitMB = Math.round((m.jsHeapSizeLimit / 1048576) * 10) / 10;
        jsHeapPct = m.usedJSHeapSize / m.jsHeapSizeLimit;
      }
    }
  } catch { /* 非 Chrome：保持 null，调用方按"无法判断"处理 */ }
  return {
    glContexts: st.created,
    glContextsLive: Math.max(0, st.created - st.lost),
    glContextsLost: st.lost,
    byType: { ...st.byType },
    canvases,
    canvasesWithGl,
    orphanGl,
    // 逐条明细（排障用）：哪些 canvas 拿了上下文、是否仍在文档里
    jsHeapLimitMB,
    jsHeapPct,
    records: st.contexts.map((r) => ({
      type: r.type, id: r.id, cls: r.cls, w: r.w, h: r.h,
      lost: !!r.lost, connected: !!(r.canvas && r.canvas.isConnected),
    })),
    jsHeapMB,
  };
}

/** 供测试重置（仅测试用） */
export function __resetMemStatsForTest() {
  st.created = 0; st.lost = 0; st.byType = {}; st.contexts = [];
}
