// render/camera/constants.js —— 相机唯一常量来源
//
// 为什么单独放一个模块：缩放范围、档位步长、fit 边距这三个数**只允许在这里出现**。
//   任何逻辑文件里再写裸数字（0.125 / 16 / 0.1 / 0.05）都视为违规 ——
//   调范围时只改这一处，两套渲染（Spine / Live2D）才不会各自漂移。
// 数值来源：引擎 `SpineEngine.SCALE_MIN/SCALE_MAX/FIT_MARGIN`（= 0.125 / 16 / 0.05），
//   档位步长 0.1 对应引擎 `userScale *= (1 + t*0.1)` 的一档 ±10%。

// 面 → 相机覆盖值的键由元数据表给（不在这里写 kind 二分）
import { byKind } from '../surfaces.js';

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
 * 各面的相机覆盖值表（键 = 面元数据表的 cameraKind）。
 * 加新面时若要限制它的缩放范围，在这里加一个键 —— 不必改 limitsFor 的判断。
 */
const CAMERA_OVERRIDES = Object.freeze({
  live2d: LIVE2D_OVERRIDE,
});

/**
 * 取某个后端实际生效的 limits（CAMERA 叠加该面的覆盖值）。
 *
 * 覆盖关系查 render/surfaces.js 的 cameraKind，不再写 `kind === 'live2d'`：
 *   未知 kind ⇒ 不叠加覆盖、直接用通用值。这里刻意**不抛错**：
 *   相机范围有通用兜底，不像画布/面模式那样写错就错乱，所以"查不到覆盖表键"等同于"这个面没有特殊限制"。
 * @param {'spine'|'live2d'} kind
 * @returns {{min: number, max: number}}
 */
export function limitsFor(kind) {
  const meta = byKind(kind);
  const override = meta ? (CAMERA_OVERRIDES[meta.cameraKind] || null) : null;
  const min = override && typeof override.MIN === 'number' ? override.MIN : CAMERA.MIN;
  const max = override && typeof override.MAX === 'number' ? override.MAX : CAMERA.MAX;
  return { min, max };
}
