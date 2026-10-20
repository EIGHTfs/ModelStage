// render/camera/constants.js —— 相机唯一常量来源
//
// 为什么单独放一个模块：缩放范围、档位步长、fit 边距这三个数**只允许在这里出现**。
//   任何逻辑文件里再写裸数字（0.125 / 16 / 0.1 / 0.05）都视为违规 ——
//   调范围时只改这一处，两套渲染（Spine / Live2D）才不会各自漂移。
// 数值来源：引擎 `SpineEngine.SCALE_MIN/SCALE_MAX/FIT_MARGIN`（= 0.125 / 16 / 0.05），
//   档位步长 0.1 对应引擎 `userScale *= (1 + t*0.1)` 的一档 ±10%。

/** 相机通用参数（Spine 与 Live2D 共用同一份） */
export const CAMERA = Object.freeze({
  /** 最小缩放（12.5%） */
  MIN: 0.125,
  /** 最大缩放（1600%） */
  MAX: 16,
  /** 一档步长：scale *= 1 + dir * STEP（±10%） */
  STEP: 0.1,
  /** fit 边距：最终系数 = (1 - FIT_MARGIN) */
  FIT_MARGIN: 0.05,
});

/**
 * Live2D 专用覆盖值（默认空 ⇒ 与 CAMERA 完全一致）。
 * 将来若需要为保护画质而限制 Live2D 的放大范围，**只在这里覆盖**，不改任何逻辑。
 * 例：{ MAX: 8 } 表示 Live2D 最多 8×，其余仍用 CAMERA。
 */
export const LIVE2D_OVERRIDE = Object.freeze({});

/**
 * 主体包围盒排除名单（部件名不区分大小写、按子串匹配）。
 * 用途：Live2D 没有骨骼/插槽语义，靠部件名剔除场景板与特效，逼近 Spine 的 `subject` 语义。
 */
export const SUBJECT_EXCLUDE = Object.freeze(['bg', 'back', 'background', 'effect', 'mask', 'scene', 'kazari']);

/**
 * 取某个后端实际生效的 limits（CAMERA 叠加 LIVE2D_OVERRIDE）。
 * @param {'spine'|'live2d'} kind
 * @returns {{min: number, max: number}}
 */
export function limitsFor(kind) {
  const override = kind === 'live2d' ? LIVE2D_OVERRIDE : null;
  const min = override && typeof override.MIN === 'number' ? override.MIN : CAMERA.MIN;
  const max = override && typeof override.MAX === 'number' ? override.MAX : CAMERA.MAX;
  return { min, max };
}
