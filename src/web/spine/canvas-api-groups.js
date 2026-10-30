// spine/canvas-api-groups.js —— 各能力组的具体挂载
//
// 四个组：设置（fps/dpr/纹理过滤/PMA/调试绘制）→ 资产（皮肤/混合模式/部件筛除）→
//   视图（相机与取景）→ 渲染（动作/播放/抗锯齿重建）。
// 红线：组内 setDebug 会被渲染组覆盖，两组必须在同一模块内且按此顺序装配。

import { buildDocument } from '../infra/document.js';
import { createStageCamera } from '../render/camera/spine.js';
import { applySettings, ensureStageEngine, ensureStageEngineWith, loadIntoStage } from './canvas-engine.js';
import { pickEngineCtor } from './canvas-runtime.js';
import { captureViewBase, viewOf } from './canvas-view.js';

/** 通用 setter（fit/纹理过滤/速度/循环/调试/帧率/DPR）与 PMA 四档 */
export function attachSettingSetters(api, st) {

// PMA 不走通用 setter：切它必须重传贴图，单列一个方法（见下）
for (const key of ['fit', 'textureFilter', 'speed', 'loop', 'debug', 'fpsLimit', 'dprMode']) {
  api[`set${key[0].toUpperCase()}${key.slice(1)}`] = (v) => applySettings(
    st, { [key]: key === 'fpsLimit' ? Number(v) : v },
  );
}
/**
 * 切换 PMA 模式：true=预乘、false=直通。
 * 为什么单列：引擎没有 setPmaMode，切预乘必须重建贴图纹理（rebuildTextures）。
 */
/**
 * 切换 PMA 模式（auto / premultiplied / straight / upload 四档）。
 * 四档都会重传贴图：auto 需要重新采样像素判断，其余三档要按新口径重上传。
 * @param {string} mode
 */
/**
 * 组装 Document（Assets 层入口，测试/工具用）。
 * 产品路径由 app/model-actions 组装；舞台只消费 ready 的 Document，绝不自己取资源。
 * @param {object} entry catalog 条目（含 kind / rootId / entry.url 等）
 * @returns {Promise<object>} Document（state 可能是 'error'，调用方自行判断）
 */
api.buildDocument = (entry) => buildDocument(entry || {});

api.setPma = async (mode) => {
  const m = ['auto', 'premultiplied', 'straight', 'upload'].includes(mode) ? mode : 'auto';
  const prev = (st.settings && st.settings.pma) || 'auto';
  applySettings(st, { pma: m });
  const eng = st.engine;
  if (!eng || typeof eng.rebuildTextures !== 'function') return m;
  // 必须 await：rebuildTextures 是异步的（要重新解包贴图 + 重建骨架），
  //   不 await 会让"同步 try/catch"抓不到失败，UI 以为切换成功而实际没生效。
  let ok = false;
  try {
    ok = await eng.rebuildTextures(m);
  } catch (e) {
    try { eng.log('error', `PMA 切换异常: ${e && e.message ? e.message : e}`, 'pma'); } catch { /* 忽略 */ }
    ok = false;
  }
  if (ok) return m;
  // 失败如实反映：把档位回滚为上一档，面板/持久化读到的就是"实际生效值"
  applySettings(st, { pma: prev });
  try { eng.log('warn', `PMA 切换失败（${m}），已回滚为 ${prev}`, 'pma'); } catch { /* 忽略 */ }
  return prev;
};

/**
 * 调试绘制开关（8 个独立项，可同时开）。
 * 每次只传变化的键，引擎内部会合并；状态同步记到 settings.debug 便于断言。
 * @param {object} patch 形如 { bones: true, meshes: false }
 */
}

/** 资产相关：皮肤列表与切换、混合模式、部件筛除 */
export function attachAssetApi(api, st) {
/** 当前模型的皮肤名列表（无皮肤时返回 [default]） */
api.getSkins = () => {
  if (!st.engine || typeof st.engine.getSkins !== 'function') return ['default'];
  try {
    const list = st.engine.getSkins() || [];
    return list.length ? list : ['default'];
  } catch {
    return ['default'];
  }
};

/**
 * 当前**实际生效**的皮肤名（引擎侧记账，装载时自动选中的那个也在内）。
 *
 * 为什么需要它：面板刷新时若拿"皮肤列表里有没有 default"去猜当前项，会把
 *   "自动选中了具名皮肤"的资源显示成 default —— 设置里写 A、画面是 B，排查时会被这条假信息带偏。
 * 返回 null 表示引擎还没设过皮肤（调用方自行决定回落成什么）。
 * @returns {string|null}
 */
api.getActiveSkin = () => {
  if (!st.engine) return null;
  const list = st.engine.activeSkins;
  return Array.isArray(list) && list.length ? list[0] : null;
};

/**
 * 切换皮肤（引擎按名称匹配；找不到时保持原皮肤）。
 * 成功与否必须取引擎返回值：否则面板会记下一个并不存在的皮肤名，
 *   表现为"设置里显示 skin_X、画面还是 default"，且下次重建贴图时又按错名字去设一遍。
 * @param {string} name
 * @returns {boolean} 是否真的切过去了
 */
api.setSkin = (name) => {
  if (!st.engine || typeof st.engine.setSkins !== 'function') return false;
  try {
    const ok = st.engine.setSkins([name]) !== false;
    if (ok) st.settings.skin = name;
    return ok;
  } catch {
    return false;
  }
};

/**
 * 动作清单（名称 + 时长）：时长来自 skeletonData.animations 的 duration。
 * 面板与底栏都读这一份，避免"两处各取一处"导致条数/时长不一致。
 * @returns {Array<{name: string, duration: number|null}>}
 */
api.animationDetails = () => {
  try {
    const e = st.engine; // 与同一 api 里其它方法一致：引擎挂在 st 上
    const anims = (e && e.skeletonData && e.skeletonData.animations) || [];
    return anims.map((a) => {
      const d = Number(a && a.duration);
      return { name: String(a && a.name || ''), duration: Number.isFinite(d) && d > 0 ? d : null };
    }).filter((a) => a.name);
  } catch {
    return [];
  }
};

/**
 * 动画切换的交叉淡化时长（秒）：混合模式开 = 用它，关 = 0（硬切）。
 * 提成命名常量：这个值同时被「混合模式开关」与「换肤临时套用」用到，
 *   散落的裸 0.2 一旦改一处忘另一处，动作过渡与换肤过渡就会不一致。
 */
const MIX_TIME_CROSSFADE_SEC = 0.2;

api.setMixMode = (on) => api.setMixTime(on ? MIX_TIME_CROSSFADE_SEC : 0);

/**
 * 混合时长（秒）：0 表示**不混合**（硬切），>0 表示动作/皮肤切换时的交叉淡化秒数。
 * 面板的「混合时长」滑块走这里；原来的「混合模式」开关等价于 setMixMode(0|默认值)。
 * @param {number} t 0~1 秒
 * @returns {number} 生效值
 */
api.setMixTime = (t) => {
  // 范围夹到 0~1：与面板滑块一致，避免外部传入巨大值把过渡拖成几秒
  const v = Math.max(0, Math.min(1, Number(t) || 0));
  st.settings.mixTime = v;
  if (st.engine && typeof st.engine.setMixTime === 'function') {
    try { st.engine.setMixTime(v); } catch { /* 版本不支持则只记状态 */ }
  }
  return v;
};


}

/** 相机视图入口：只读读数 + 薄转发（不换算） */
export function attachViewApi(api, st) {
/** 相机统一入口（全部委托引擎原生方法，本文件不做任何坐标换算） */
st.camera = createStageCamera({ getEngine: () => st.engine });
api.camera = st.camera;

/** 只读视图读数：zoom 取引擎 userScale 与基准的比值，pan 用入口累计的屏幕位移 */
api.getView = () => viewOf(st);

/**
 * 兼容入口（交互层仍调用 setView）。这里**只转发**，不换算：
 *   · zoom → camera.zoomTo(基准 × 倍数)（倍乘即「相对 fit 的倍数」，clamp 由引擎负责）
 *   · panX/panY → camera.panBy(增量)，单位是屏幕像素，
 */
api.setView = (patch = {}) => {
  const camera = st.camera;
  if (!camera) return viewOf(st);
  if (typeof patch.zoom === 'number' && Number.isFinite(patch.zoom)) {
    const base = st.viewBaseScale || 1;
    camera.zoomTo(base * patch.zoom);
  }
  if (typeof patch.panX === 'number' || typeof patch.panY === 'number') {
    const cur = st.viewPan || { x: 0, y: 0 };
    const nx = typeof patch.panX === 'number' && Number.isFinite(patch.panX) ? patch.panX : cur.x;
    const ny = typeof patch.panY === 'number' && Number.isFinite(patch.panY) ? patch.panY : cur.y;
    if (nx !== cur.x || ny !== cur.y) {
      camera.panBy(nx - cur.x, ny - cur.y);
      st.viewPan = { x: nx, y: ny };
    }
  }
  return viewOf(st);
};

/** 视图复位：交给引擎 resetCamera 重新 fit，然后重取基准 */
  /**
   * 幂等入口：确保引擎实例已创建（只建上下文与相机，不加载模型）。
   * 谁需要：Live2D 分支要接管引擎的 Live2D 态（l2dActive 依赖 l2dModelId + 引擎实例），
   *   而引擎是懒创建的 —— 用户先点 Live2D 时还没有实例。
   * @returns {Promise<object|null>} 引擎实例
   */
  api.ensureEngineReady = async () => {
    if (st.engine) return st.engine;
    try {
      const Engine = await pickEngineCtor();
      if (!ensureStageEngine(st, Engine, st.canvas)) return null;
      return st.engine;
    } catch {
      return null;
    }
  };

api.resetView = () => {
  if (st.camera) st.camera.reset();
  captureViewBase(st);
  return viewOf(st);
};
}

/** 渲染相关：调试绘制、滤镜预设、MSAA 重建 */
export function attachRenderApi(api, st) {
api.setDebug = (patch) => {
  const next = { ...(st.settings.debug || {}), ...(patch || {}) };
  st.settings.debug = next;
  if (st.engine && typeof st.engine.setDebugDraw === 'function') {
    try { st.engine.setDebugDraw(patch || {}); } catch { /* 版本不支持则只记状态 */ }
  }
  return next;
};

/** 切换滤镜预设（id 见引擎预设表；未知 id 由引擎回落原画） */
api.setFilter = (id) => {
  if (!st.engine || typeof st.engine.setFilter !== 'function') {
    // 与 applySettings 同一约定：引擎还没建时也要把设置记进快照，
    //   装载时由引擎按 settings.filter 应用 —— 否则启动阶段下发会静默丢失
    st.settings.filter = id;
    return id;
  }
  try {
    st.engine.setFilter(id);
    st.settings.filter = st.engine.getFilter ? st.engine.getFilter() : id;
    return st.settings.filter;
  } catch { return null; }
};

/**
 * 切换 MSAA：GL 的 antialias 只在建上下文时生效，必须换 canvas 节点重建。
 * 流程：换节点 → dispose → init(antialias) → 重新加载最近一次的模型。
 * @param {boolean} on
 * @returns {Promise<{antialias:boolean, restoreMs:number, restored:boolean}>}
 */
api.rebuildWithAntialias = async (on) => {
  const arg = st.lastArg;
  const old = st.canvas;
  const next = old.cloneNode(false);
  old.replaceWith(next);
  st.canvas = next;
  try { if (st.engine && st.engine.dispose) st.engine.dispose(); } catch { /* 释放失败继续重建 */ }
  st.engine = null;
  st.model = null;
  st.disposes += 1; // 重建也计入释放次数，便于用 loads/disposes 判泄漏
  st.settings.msaa = on ? 'auto' : 'off';
  const t0 = performance.now();
  const Engine = await pickEngineCtor();
  const ok = ensureStageEngineWith(st, Engine, on);
  if (!ok) return { antialias: !!on, restoreMs: 0, restored: false };
  if (arg) await loadIntoStage(st, arg);
  return { antialias: !!on, restoreMs: Math.round(performance.now() - t0), restored: !!arg };
};
}
