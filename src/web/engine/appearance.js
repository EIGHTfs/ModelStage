// engine/appearance.js —— 外观装配：滤镜着色器、混合钩子、PMA 档位切换（rebuildTextures）
//
// 本文件承担"外观层"的三个易错点，全部照抄旧引擎语义：
//   ① 滤镜：换 batcherShader + 保存/还原默认着色器（filters.js 提供纯函数）
//   ② 混合：给 gl 装 blendFuncSeparate 钩子（straight 档没有它就是错的画面）
//   ③ rebuildTextures：PMA 档位必须走"释放→重载贴图→重放动画/皮肤→首帧"的完整顺序
//
// 关于失败是否回滚档位：旧引擎原文（行 205 @25827 起的 async rebuildTextures）的 catch 只做
//   `this.pendingPresent=!1; this.log("error", "重建纹理失败: …")`，finally 里 `loadingModel=!1`
//   —— **不回滚 pmaMode**。本实现照抄不回滚（回滚是旧引擎没有的行为，会造成"面板显示与实际口径"另一种分裂）。

import { reconcileFilter, hasFilter, DEFAULT_FILTER } from './filters.js';
import { installBlendHooks } from './blend.js';
import { buildModel } from './loader.js';
import { applyTextureFilter } from './textures.js';
import { pickClass } from './runtime.js';

/** 给 gl 装混合钩子（幂等，钩子内部读 engine.pmaInfo） */
export function installBlend(engine) {
  return installBlendHooks(engine.gl, engine);
}

/**
 * 应用当前滤镜档位（编译/换/还原）。
 * @param {object} engine
 * @returns {boolean} 是否真的改了着色器
 */
export function applyFilter(engine) {
  const ShaderCtor = engine.spine ? pickClass(engine.spine, 'Shader') : null;
  const target = engine.renderTarget && engine.renderTarget.renderer ? engine.renderTarget.renderer : engine.renderer;
  const result = reconcileFilter({
    renderer: target,
    gl: engine.gl,
    ShaderCtor,
    filterId: engine.filterId,
    state: engine.filterState || { saved: null, active: null },
    log: (l, m, s) => engine.log(l, m, s),
  });
  engine.filterState = { saved: result.saved, active: result.active };
  return result.changed;
}

/**
 * 设滤镜 id（非法值回落 original），并立即生效。
 * @param {object} engine
 * @param {string} id
 */
export function setFilter(engine, id) {
  const next = hasFilter(id) ? id : DEFAULT_FILTER;
  if (engine.filterId === next) return next;
  engine.filterId = next;
  applyFilter(engine);
  return next;
}

/**
 * 设纹理过滤并重挂已有纹理（旧引擎 setTextureFilter 的行为）。
 * @param {object} engine
 * @param {string} mode 'linear' | 'nearest'
 */
export function setTextureFilter(engine, mode) {
  engine.textureFilter = mode === 'nearest' ? 'nearest' : 'linear';
  const gl = engine.gl;
  if (!gl) return engine.textureFilter;
  for (const tex of engine.textures || []) applyTextureFilter(gl, tex, engine.textureFilter);
  for (const page of (engine.atlas && engine.atlas.pages) || []) applyTextureFilter(gl, page.texture, engine.textureFilter);
  return engine.textureFilter;
}

/**
 * 切 PMA 档位：重建纹理并重放动画/皮肤（顺序照抄旧引擎）。
 * @param {object} engine
 * @param {string} mode auto | premultiplied | straight | upload
 * @returns {Promise<boolean>}
 */
export async function rebuildTextures(engine, mode) {
  const descriptor = engine.currentModel;
  if (!descriptor || !engine.spine || !engine.gl) return false;
  engine.pmaMode = mode;
  engine.loadingModel = true;
  engine.pendingPresent = true;
  try {
    engine.stop();
    engine.disposeContent();
    engine.skeletonData = null;
    const model = await buildModel({
      adapters: engine.adapters,
      spine: engine.spine,
      gl: engine.gl,
      descriptor,
      pmaMode: mode,
      textureFilter: engine.textureFilter,
      supportsStraight: engine.supportsStraightAlpha !== false,
      log: (l, m, s) => engine.log(l, m, s),
    });
    engine.bindModel(model);
    // 旧引擎在重建里也会重跑 initRenderer（换纹理后批处理器状态要干净）
    engine.disposeRenderer();
    engine.createRenderer();
    engine.resetCamera();
    if (engine.animationName) engine.setAnimation(engine.animationName, engine.loop);
    if (engine.activeSkins && engine.activeSkins.length) engine.setSkins(engine.activeSkins);
    engine.presentFirstFrame();
    engine.log('info', `PMA 模式已切换为 ${mode}（生效: ${model.pmaInfo.effectiveMode}）`, 'pma');
    return true;
  } catch (e) {
    engine.pendingPresent = false;
    engine.log('error', `重建纹理失败: ${e && e.message ? e.message : e}`, 'pma');
    return false;
  } finally {
    engine.loadingModel = false;
  }
}
