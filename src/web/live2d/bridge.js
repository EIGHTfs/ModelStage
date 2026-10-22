// live2d/bridge.js —— 相机 backend 与播放控制的落地接口
//
// 这是 Live2D 渲染器对外的"能力面"：引擎与面板只通过它操作 Live2D，
//   不直接碰 PIXI。相机动作（resetView / setZoomRatio / pan）最终都落到 view.applyZoom()，
//   与 Spine 共用同一套相机语义（render/camera）。
// 成员语义见各方法注释；成员集合属于对外契约，增删需同步渲染器与面板。
import { ZOOM_MIN, ZOOM_MAX } from './stage-ctx.js';

/**
 * 创建桥对象。
 * @param {object} ctx 运行时上下文
 * @returns {object} bridge（12 个成员）
 */
/**
 * 动作相关成员（清单 / 时长 / 播放）：单独成工厂，避免 createBridge 过长。
 * 时长为什么要预取：运行时 getDuration 只有把动作播过一次才有值，
 *   照那样做，列表里的时长会"点过才出现"；改为直接读动作文件的 Meta.Duration。
 * @param {object} ctx 运行时上下文（含 st / note / resolveAsset）
 */
function createMotionApi(ctx) {
  const { st, note } = ctx;
  /** label → 秒数（null = 确实取不到） */
  const durationCache = new Map();

  /** 动作文件 URL：model3.json 里的 File 相对模型目录 */
  function motionFileUrl(group, index) {
    const meta = st.meta || {};
    const dir = String(meta.modelUrl || '').replace(/[^/]*$/, '');
    const mo = ((meta.motions && meta.motions[group]) || [])[index] || null;
    const file = mo && (mo.File || mo.Name);
    if (!file) return null;
    const joined = file.startsWith('/') ? file : `${dir}${file}`;
    try { return ctx.resolveAsset(joined); } catch { return joined; }
  }

  return {
    labels: () => ctx.api.model.motionLabels(),
    /** 动作清单（只读）：标签 + group/index + 时长（取不到给 null） */
    motionItems() {
      const items = [];
      for (const [label, hit] of (st.motionMap || new Map())) {
        let duration = durationCache.has(label) ? durationCache.get(label) : null;
        if (duration === null) {
          try {
            const mm = st.model && st.model.internalModel && st.model.internalModel.motionManager;
            const mo = mm && mm.motionGroups && mm.motionGroups[hit.group] && mm.motionGroups[hit.group][hit.index];
            const d = mo && typeof mo.getDuration === 'function' ? mo.getDuration() : null;
            if (typeof d === 'number' && isFinite(d) && d > 0) duration = d;
          } catch { /* 取不到就不给 */ }
        }
        items.push({ label, group: hit.group, index: hit.index, duration });
      }
      return items;
    },
    /** 预热动作时长：并行读每个动作文件的 Meta.Duration；返回新取到条数 */
    async ensureMotionDurations() {
      if (!st.motionMap || !st.motionMap.size) return 0;
      let filled = 0;
      const jobs = [];
      for (const [label, hit] of st.motionMap) {
        if (durationCache.has(label)) continue;
        const url = motionFileUrl(hit.group, hit.index);
        if (!url) { durationCache.set(label, null); continue; }
        jobs.push(fetch(url).then((res) => res.json()).then((json) => {
          const d = Number(json && json.Meta && json.Meta.Duration);
          const ok = Number.isFinite(d) && d > 0;
          durationCache.set(label, ok ? d : null);
          if (ok) filled += 1;
        }).catch(() => { durationCache.set(label, null); }));
      }
      await Promise.all(jobs);
      return filled;
    },
    /** 动作切换：标签 → (group, index) */
    playLabel(label) {
      const hit = st.motionMap.get(label);
      if (!hit || !st.model) {
        note(`Live2D 未知动作标签：${label}`, 'warn');
        return false;
      }
      try {
        st.model.motion(hit.group, hit.index);
        note(`Live2D 播动作：${label}`);
        return true;
      } catch (err) {
        note(`Live2D 播动作失败：${err && err.message}`, 'warn');
        return false;
      }
    },
  };
}

export function createBridge(ctx) {
  const { st, note } = ctx;

  const bridge = {
    isActive: () => st.active,
    hide: () => ctx.api.overlay.hide(),
    currentModelId: () => st.modelId,
    ...createMotionApi(ctx),
    expressions: () => ((st.meta && st.meta.expressions) || []).map((e) => e.name),
    /**
     * 装载入口：复用或加载，返回与 Spine 同形的摘要。
     * @param {object} model
     * @returns {Promise<{animations: string[], skins: string[], durations: object, version: string}>}
     */
    async loadForEngine(model) {
      const reusable = st.active && st.modelId === model.id && st.model;
      if (!reusable) {
        note(`Live2D 装载：${model.name}`);
        await ctx.api.model.loadModel(model);
      } else {
        note(`Live2D 复用已加载模型：${model.name}`);
      }
      return {
        animations: ctx.api.model.motionLabels(),
        skins: ((st.meta && st.meta.expressions) || []).map((e) => e.name),
        durations: {},
        version: `Live2D Cubism ${(model && model.cubism) || 3}`,
      };
    },
    /** 表情切换：表情名 → expression 下标 */
    setExpressions(names) {
      if (!st.model) return false;
      const list = (names || []).filter(Boolean);
      try {
        if (!list.length) { st.model.expression(); return true; }
        const exprs = (st.meta && st.meta.expressions) || [];
        const idx = exprs.findIndex((e) => e.name === list[0]);
        if (idx >= 0) st.model.expression(idx);
        note(`Live2D 切表情：${list[0]}${idx >= 0 ? '' : '（未找到，保持原表情）'}`, idx >= 0 ? 'info' : 'warn');
        return idx >= 0;
      } catch (err) {
        note(`Live2D 切表情失败：${err && err.message}`, 'warn');
        return false;
      }
    },
    /** 相机复位 */
    resetView() {
      st.zoomRatio = 1;
      st.panX = 0;
      st.panY = 0;
      ctx.api.view.applyZoom();
      note('Live2D 视图复位');
    },
    /** 相机缩放：值越大模型越大 */
    setZoomRatio(ratio) {
      const v = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(ratio) || 1));
      st.zoomRatio = v;
      ctx.api.view.applyZoom();
      return v;
    },
    /** 相机平移：屏幕像素增量 */
    pan(dx, dy) {
      st.panX += Number(dx) || 0;
      st.panY += Number(dy) || 0;
      ctx.api.view.applyZoom();
    },
    /** 只读诊断快照 */
    readState() {
      let motion = null;
      try {
        const mm = st.model && st.model.internalModel && st.model.internalModel.motionManager;
        if (mm) {
          const holder = mm.state && (mm.state.currentGroup !== undefined || mm.state.currentIndex !== undefined) ? mm.state : mm;
          motion = { group: holder.currentGroup ?? null, index: holder.currentIndex ?? null };
        }
      } catch { /* 忽略 */ }
      return {
        active: st.active,
        modelId: st.modelId,
        zoom: st.zoomRatio,
        pan: { x: st.panX, y: st.panY },
        motion,
      };
    },
  };

  return bridge;
}