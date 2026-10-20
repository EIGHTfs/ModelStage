// engine/runtime.js —— 取 Spine 运行时命名空间（按骨架版本，带降级）
//
// 为什么不在这里自己加载源码：运行时管理已由 `spine/runtimes.js` 负责（版本清单、源码缓存、
//   隔离执行、能力探测）。引擎只消费它的结果，避免出现两套版本选择逻辑。

/**
 * 解析某骨架版本对应的运行时命名空间。
 * @param {object} manager SpineRuntimeManager 实例（由调用方注入，引擎不自己 new）
 * @param {string} version 骨架版本（如 '3.8' / '4.1'）
 * @returns {Promise<{spine: object, version: string, supportsStraightAlpha: boolean}>}
 */
export async function resolveRuntime(manager, version) {
  if (!manager || typeof manager.getRuntimeWithFallback !== 'function') {
    throw new Error('engine: 缺少运行时管理器（需要 getRuntimeWithFallback）');
  }
  const entry = await manager.getRuntimeWithFallback(version);
  if (!entry || !entry.spine) throw new Error(`engine: 运行时 ${version} 不可用`);
  return { spine: entry.spine, version: entry.version, supportsStraightAlpha: entry.supportsStraightAlpha !== false };
}

/**
 * 按名字取运行时里的类。
 * 为什么需要：目录里 7 个版本的命名空间形状不同 ——
 *   · 3.x：核心类（TextureAtlas/SkeletonJson/Skeleton…）在顶层，WebGL 类只挂在 `spine.webgl`；
 *   · 4.x：全部平铺在顶层（没有 `webgl` 子命名空间）。
 *   统一走这个名字解析，避免每处都写一遍兼容分支。
 * @param {object} spine 运行时命名空间
 * @param {string} name 类名
 * @returns {Function|null}
 */
export function pickClass(spine, name) {
  if (!spine) return null;
  if (typeof spine[name] === 'function') return spine[name];
  const w = spine.webgl;
  if (w && typeof w[name] === 'function') return w[name];
  return null;
}
