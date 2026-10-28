// render/surfaces.js —— 渲染面元数据表：**「有哪些面、每个面长什么样」的唯一真相**。
//
// 为什么要有这张表：这个事实原先被十处 `x === 'live2d' ? : 'spine'` 分别表达。
//   只有两个面时那种写法成立（"不是 live2d 就是 spine"），加第三个面时每一处都会
//   **静默误判成 spine** —— 表现为功能错乱而非报错，是最难排的一类缺陷。
//
// 加新面时：① 在这里加一行 ② 写 render/<kind>.js ③ main.js 里 register() 一次。
//   消费方一律查表取值，不再自己写二分判断。
//
// 核心约束：**未知 kind 一律返回 null，绝不"回落到 spine"**。
//   返回 null 会逼调用方显式处理（报错或跳过），比"猜一个默认值"安全得多。

/**
 * 每个字段都对应一处原先的硬编码（加 3D 时按需填，不必再找第 11 个 if）：
 *   id             渲染器 id（= document.rendererId 的缺省值，surface.register 的键）
 *   kind           document.kind 的取值（catalog/document 层的内容类型）
 *   label          名册里显示的类型名（原 roster/list.js 的三元表达式）
 *   badge          名册徽标的 CSS 修饰名（原 roster/rows.js 的 kindClass）
 *   stageMode      写到 data-stage-mode 的值，CSS 据此选布局（原 surface.js setMode）
 *   overlay        'canvas' = 该面用**覆盖层** canvas；null = 用舞台画布（原 isLive2D 判断）
 *   overlayVisible 覆盖层容器是否可见（原 setMode 里的 is-visible 类切换）
 *   cameraKind     相机常量覆盖表的键（原 camera/constants.js limitsFor）
 *   deepLink       深链（?model= 不带 runtime 时）是否接受这个 kind（原 app/url-params.js）
 */
export const SURFACES = [
  { id: 'spine', kind: 'spine', label: 'Spine', badge: 'spine', stageMode: 'spine', overlay: null, overlayVisible: false, cameraKind: 'spine', deepLink: true },
  { id: 'live2d', kind: 'live2d', label: 'Live2D', badge: 'live2d', stageMode: 'live2d', overlay: 'canvas', overlayVisible: true, cameraKind: 'live2d', deepLink: true },
];

/** 按 kind 查（未知 → null） */
export function byKind(kind) {
  if (!kind) return null;
  return SURFACES.find((s) => s.kind === kind) || null;
}

/** 按渲染器 id 查（未知 → null） */
export function byId(id) {
  if (!id) return null;
  return SURFACES.find((s) => s.id === id) || null;
}

/** 已知 kind 列表（document.detectKind 用它判"是不是受支持的内容类型"） */
export function knownKinds() {
  return SURFACES.map((s) => s.kind);
}

/** 是否受支持的 kind */
export function isKnownKind(kind) {
  return byKind(kind) !== null;
}

/**
 * kind → data-stage-mode 的值。**未知 kind 返回 null**，调用方必须显式处理。
 * @param {string} kind
 * @returns {string|null}
 */
export function stageModeOf(kind) {
  const s = byKind(kind);
  return s ? s.stageMode : null;
}

/**
 * 给"手里可能是 rendererId、也可能是 kind"的旧调用点一个统一入口
 * （两个面的 id 与 kind 恰好同名，历史上被混用过；这里一次收敛，不改既有调用语义）。
 * @param {string} value
 * @returns {object|null} 元数据
 */
export function byIdOrKind(value) {
  return byId(value) || byKind(value);
}
