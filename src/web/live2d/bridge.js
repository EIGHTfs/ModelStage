// live2d/bridge.js —— 相机 backend 与播放控制的落地接口
//
// 这是 Live2D 渲染器对外的"能力面"：引擎与面板只通过它操作 Live2D，
//   不直接碰 PIXI。相机动作（resetView / setZoomRatio / pan）最终都落到 view.applyZoom()，
//   与 Spine 共用同一套相机语义（render/camera）。
// 成员语义见各方法注释；成员集合属于对外契约，增删需同步渲染器与面板。
import { ZOOM_MIN, ZOOM_MAX, isAbsoluteRef } from './stage-ctx.js';
import { createViewProbe } from './playback-probe.js';

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

  /** 动作在 model3.json 里的原始 File 值（如 motions/idle.motion3.json） */
  function motionFileOf(group, index) {
    const meta = st.meta || {};
    const mo = ((meta.motions && meta.motions[group]) || [])[index] || null;
    return (mo && (mo.File || mo.Name)) || null;
  }

  /** 动作文件 URL：model3.json 里的 File 相对模型目录 */
  function motionFileUrl(group, index) {
    const meta = st.meta || {};
    const dir = String(meta.modelUrl || '').replace(/[^/]*$/, '');
    const file = motionFileOf(group, index);
    if (!file) return null;
    // 绝对地址（任意 scheme 或 data:）不拼目录：模型定义里允许写绝对 URL，
    //   拼上去会变成 /files/…/http://… 这种无效地址（曾经 14 次 miss 的来源）；
    //   根绝对（/xxx）也原样保留。
    const joined = isAbsoluteRef(file) || file.startsWith('/') ? file : `${dir}${file}`;
    try { return ctx.resolveAsset(joined); } catch { return joined; }
  }

  /**
   * 标签解析：先按规范标签精确匹配；不中再兼容旧格式 `group / name`（历史持久化里存过这种值）。
   * 都查不到返回 null（调用方按"未知标签"处理）。
   * @param {string} label
   * @returns {{label:string, group:string, index:number}|null}
   */
  function resolveLabel(label) {
    const map = st.motionMap || new Map();
    const key = String(label || '');
    if (map.has(key)) {
      const hit = map.get(key);
      return { label: key, group: hit.group, index: hit.index };
    }
    // 旧格式兜底：`group / motionName` → 用 motionName 段匹配（同名多条取第一条）
    const legacyName = key.includes(' / ') ? key.split(' / ').pop() : '';
    if (legacyName && map.has(legacyName)) {
      const hit = map.get(legacyName);
      return { label: legacyName, group: hit.group, index: hit.index };
    }
    return null;
  }

  return {
    labels: () => ctx.api.model.motionLabels(),
    /** 当前播放的动作标签（未播过为 null）；渲染器用它回显 animation 的生效值 */
    currentLabel: () => st.currentLabel || null,
    /** 动作清单（只读）：标签 + group/index + 时长（取不到给 null） */
    motionItems() {
      const items = [];
      for (const [label, hit] of (st.motionMap || new Map())) {
        // 时长优先级：① Document 预取表（Assets 层，全量动作都有）
        //              ② durationCache（本进程补取过的）
        //              ③ 已加载动作的 motionManager（只有被播过的那条有，作最后兜底）
        const prefetched = ((st.meta && st.meta.motionDurations) || {})[motionFileOf(hit.group, hit.index)];
        let duration = Number.isFinite(prefetched) && prefetched > 0
          ? prefetched
          : (durationCache.has(label) ? durationCache.get(label) : null);
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
    /**
     * 预热动作时长（**本版不实现**）。
     *
     * 为什么保留空实现：时长要读动作文件（motion3.json）里的 Meta.Duration，
     *   而"取模型资源"已按契约收到 Assets 层（infra/document.js）——渲染器里不允许再 fetch 动作文件。
     *   恢复正解：让 Document 多带一份 meta.motionDurations（Assets 层算好），这里只读地取用。
     *   在那之前动作时长显示为空，属已知能力缺口，不是 bug。
     * @returns {Promise<number>} 本次补齐条数（恒 0）
     */
    async ensureMotionDurations() {
      return 0;
    },
    /** 动作切换：标签 → (group, index) */
    playLabel(label) {
      const hit = resolveLabel(label);
      if (!hit || !st.model) {
        note(`Live2D 未知动作标签：${label}`, 'warn');
        return false;
      }
      try {
        // Cubism 的动作队列是**顺序播放**语义：直接 motion() 只会把新动作排到队尾，
        //   正在播的那条不结束就不会切过去（引擎侧表现为队列实例不变、时间轴一直推进在旧动作上）。
        //   因此先 stopAllMotions() 清空队列再起新的 —— 这才是"切换即打断"。
        const mm = st.model.internalModel && st.model.internalModel.motionManager;
        if (mm && typeof mm.stopAllMotions === 'function') mm.stopAllMotions();
        st.model.motion(hit.group, hit.index);
        // 回显用解析后的**规范标签**（旧格式 "group / name" 也能落到同一条）
        st.currentLabel = hit.label || label;
        note(`Live2D 播动作：${st.currentLabel}`);
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
  const probe = createViewProbe(st);



  const bridge = {
    isActive: () => st.active,
    /** 引擎侧播放探针（验收用：读引擎真实状态，不拿我们自己的 currentLabel 自证） */
    playbackProbe: probe.playbackProbe,
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
      const motion = probe.currentMotion();
      return {
        active: st.active,
        modelId: st.modelId,
        zoom: st.zoomRatio,
        pan: { x: st.panX, y: st.panY },
        motion,
      };
    },
  };

  // 验收探针挂到页面上（与 lead 共用同一套引擎侧判据）
  try {
    if (typeof globalThis !== 'undefined' && globalThis.__WEB__) globalThis.__WEB__.playbackProbe = () => bridge.playbackProbe();
  } catch { /* 忽略 */ }

  return bridge;
}