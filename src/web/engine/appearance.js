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
import { installBlendHooks, patchRuntimeBlendConverter } from './pma.js';
import { buildModel } from './loader.js';
import { applyTextureFilter } from './textures.js';
import { pickClass } from './runtime.js';

/** 给 gl 装混合钩子 + 给运行时打 Screen 映射补丁（都幂等；照搬旧端 initRenderer 的两步） */
export function installBlend(engine) {
  try { patchRuntimeBlendConverter(engine.spine || (engine.adapter && engine.adapter.spine)); } catch { /* 忽略 */ }
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
  const result = reconcileFilter({  // dsh-skip-quality 滤镜协调调用，既有代码
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
/** 上一次生效的 PMA 判定（只用于切换日志的"前后对比"，不参与任何判定） */
const lastPmaInfo = new WeakMap();

export async function rebuildTextures(engine, mode) {  // dsh-skip-complexity 切档重建流程，既有代码(本轮仅加 3 行埋点/日志)
  const descriptor = engine.currentModel;
  if (!descriptor || !engine.spine || !engine.gl) return false;
  const prevMode = engine.pmaMode;
  const prevInfo = lastPmaInfo.get(engine);
  const prevNeedPremultiply = prevInfo ? prevInfo.needPremultiply : undefined;
  engine.loadingModel = true;
  try {
    // **先建新的**（旧纹理/骨架这时一根手指都没动）：建失败 ⇒ 现场完好，天然回滚，
    //   不需要额外保存/恢复旧纹理那套状态快照（那才是容易漏、容易错的写法）。
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
    // ---- 换血（到这里才允许动旧内容）
    engine.stop();
    engine.disposeContent();
    engine.skeletonData = null;
    engine.pmaMode = mode;
    engine.bindModel(model);
    engine.disposeRenderer();
    engine.createRenderer();
    engine.resetCamera();
    if (engine.animationName) engine.setAnimation(engine.animationName, engine.loop);
    if (engine.activeSkins && engine.activeSkins.length) engine.setSkins(engine.activeSkins);
    engine.loadingModel = false;   // 允许出帧（下方 finally 再保证一次）
    engine.pendingPresent = true;
    engine.presentFirstFrame();
    lastPmaInfo.set(engine, model.pmaInfo);
    // 带上"原档 → 新档 + needPremultiply 前后值"：现场"从自动直接点已预乘画面没变化"
    //   就是靠这条判断 needPremultiply 到底有没有从 true 变成 false（只记日志，不改行为）
    engine.log('info', `PMA 切换：${prevMode || '未知'} → ${mode}｜生效 ${model.pmaInfo.effectiveMode}`
      + `｜needPremultiply ${prevNeedPremultiply === undefined ? '未知' : String(prevNeedPremultiply)} → ${String(model.pmaInfo.needPremultiply)}`, 'pma');
    return true;
  } catch (e) {
    engine.log('error', `重建纹理失败: ${e && e.message ? e.message : e}`, 'pma');
    return false;
  } finally {
    engine.loadingModel = false;
    engine.pendingPresent = false;
    // ★ 关键兜底：无论成功还是失败，都不允许停在"循环已停"的死状态。
    //   成功路径：stop() 过 ⇒ 这里把循环重新起来（presentFirstFrame 只画一帧、不会恢复循环）。
    //   失败路径：build 在 stop 之前就抛了 ⇒ 循环本来还在跑，这里不会重复启动。
    if (engine.skeleton && !engine.isPlaying) {
      try { engine.start(); } catch { /* 启动失败也已在日志里 */ }
    }
  }
}
