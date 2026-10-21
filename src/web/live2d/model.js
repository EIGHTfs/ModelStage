// live2d/model.js —— 模型装载与动作表
//
// 装载顺序是有讲究的（历史上踩过 BUG-3）：
//   先 showOverlay 让覆盖层可见 → 再建 PIXI。反过来的话 PIXI 在 display:none 下读到
//   0 尺寸、停在默认 800×600，首次可见时若不重新校准就只剩一块"内容矩形"。
// 动作表来自 model3.json（fetchDefinition），不用接口元数据 —— 那里 motions/expressions 是空的。

/**
 * 创建模型模块。
 * @param {object} ctx 运行时上下文
 * @returns {{fetchDefinition:Function, motionNameOf:Function, motionLabel:Function, buildMotionMap:Function, motionLabels:Function, loadModel:Function}}
 */
export function createModel(ctx) {
  const { st, note, resolveAsset, entryUrlOf, width8, height8 } = ctx;

  async function fetchDefinition(model) {
    const raw = entryUrlOf(model);
    const url = raw ? resolveAsset(raw) : null;
    if (!url) return { motions: {}, expressions: [] };
    try {
      const res = await fetch(url);
      const json = await res.json();
      const ref = json && json.FileReferences ? json.FileReferences : {};
      const motions = ref.Motions || {};
      const expressions = (ref.Expressions || []).map((e, i) => ({ name: (e && e.Name) || `exp${i + 1}` }));
      return { motions, expressions };
    } catch (err) {
      note(`模型定义读取失败（动作列表将为空）：${err && err.message}`, 'warn');
      return { motions: {}, expressions: [] };
    }
  }

  function motionNameOf(mo) {
    if (typeof mo === 'string') return mo;
    if (!mo) return '';
    return String(mo.Name || mo.File || '');
  }

  function motionLabel(group, name) {
    // 后缀可能是 .motion3 / .motion3.json / .json（Cubism3 常见 .motion3.json）
    const base = String(name || '').split('/').pop().replace(/\.motion3(\.json)?$/i, '').replace(/\.json$/i, '');
    return `${group} / ${base}`;
  }

  function buildMotionMap(meta) {
    st.motionMap = new Map();
    const motions = (meta && meta.motions) || {};
    const groups = Object.keys(motions);
    groups.sort((a, b) => (a === 'idle' ? -1 : b === 'idle' ? 1 : 0));
    for (const group of groups) {
      (motions[group] || []).forEach((mo, index) => {
        let label = motionLabel(group, motionNameOf(mo));
        if (st.motionMap.has(label)) label = `${label} #${index + 1}`;
        st.motionMap.set(label, { group: String(group), index });
      });
    }
    return [...st.motionMap.keys()];
  }

  function motionLabels() { return [...st.motionMap.keys()]; }

  async function loadModel(model) {
    await ctx.api.pixiApp.ensureLibs();
    // 顺序关键：必须先让覆盖层可见，再建 PIXI。
    //   否则 PIXI 在 display:none 状态下读到 0 尺寸，会停在默认 800×600，
    //   首次可见时若没有重新校准，画面就只剩一块"内容矩形"（BUG-3 的现象）。
    ctx.api.overlay.showOverlay();
    const app = await ctx.api.pixiApp.ensureApp();
    // 先清掉上一个模型（同一覆盖层只留一个）
    if (st.model) {
      try { app.stage.removeChild(st.model); } catch { /* 忽略 */ }
      try { st.model.destroy({ children: true }); } catch { /* 忽略 */ }
      st.model = null;
    }
    const url = resolveAsset(entryUrlOf(model));
    if (!url) throw new Error(`Live2D 模型缺少入口地址（entry.url）：${model && model.name}`);
    const t0 = performance.now();
    const instance = await PIXI.live2d.Live2DModel.from(url, { autoInteract: false });
    app.stage.addChild(instance);
    st.model = instance;
    st.modelId = model.id;
    st.zoomRatio = 1;
    st.panX = 0;
    st.panY = 0;
    const def = await fetchDefinition(model);
    st.meta = { ...model, motions: def.motions, expressions: def.expressions };
    const labels = buildMotionMap(st.meta);
    if (typeof app.start === 'function') app.start();
    ctx.api.pixiApp.fitAppToOverlay();
    ctx.api.view.applyZoom();
    st.active = true;
    // 断言③：清屏必须透明。若模型以外的区域 alpha>0，说明不透明底色又把 CSS 背景盖住了，
    //   这类回归以前只能靠人眼发现（表现为"内容被框在矩形里"），现在让它自己报出来。
    try {
      const probe = await ctx.api.probe.readCanvasPixels([[8, 8], [width8(), 8], [8, height8()], [Math.floor((size ? size.width : 1920) / 2), 8]]);
      const opaque = (probe || []).filter((p) => p.rgba && p.rgba[3] > 0);
      if (probe && probe.length && opaque.length === probe.length) {
        note(`画布清屏不透明（${opaque.length}/${probe.length} 点 alpha>0），CSS 背景会被遮住`, "warn");
      } else {
        note(`画布清屏自检通过（${probe ? probe.length - opaque.length : 0}/${probe ? probe.length : 0} 点透明）`);
      }
    } catch { /* 自检失败不影响渲染 */ }
    note(`Live2D 已渲染 ${model.name}（Cubism ${model.cubism || '?'}，动作 ${labels.length}，表情 ${def.expressions.length}，`
      + `耗时 ${Math.round(performance.now() - t0)}ms）`);
    // 首帧后采集一次 diff 基线（只采一次，避免污染时序；模型已换则放弃）
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (st.model === instance) {
        try { ctx.api.probe.collectCmp('default'); } catch { /* 采集失败不影响渲染 */ }
      }
    }));
    return { labels, expressions: def.expressions.map((e) => e.name), instance };
  }

  return { fetchDefinition, motionNameOf, motionLabel, buildMotionMap, motionLabels, loadModel };
}