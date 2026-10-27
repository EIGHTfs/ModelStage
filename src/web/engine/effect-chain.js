// engine/effect-chain.js —— **效果链的唯一实现**（Spine / Live2D 共用）
//
// 为什么必须共用：两条链路只有"怎么把着色器挂上去"不同（Spine 换 batcherShader、
//   Live2D 挂 PIXI.Filter），而"哪些效果生效 / 按什么顺序叠 / 参数怎么变成 uniform /
//   什么时候该销毁"是同一套语义。各写一遍就是以后改一处漏一处。
//
// 链的顺序（契约 §9.4）：内置 presetFilter 在前，插件效果按清单 effects[] 声明顺序叠加。
// 表达式契约（§9.2）：插件效果是"作用于当前像素的表达式"，可用符号只有
//   c（当前像素）、uv（纹理坐标）、texel（1/纹理尺寸）、u_<param>。

/**
 * 生成插件效果可用的前置声明（两个链路的差异只有采样器名与纹理坐标变量名）。
 *
 * **必须分两段返回**，因为 GLSL 的作用域规则不允许把它们混在一起：
 *   · global：uniform 声明与 texelSample() 函数定义，只能出现在 **main 之外**；
 *   · local ：uv / texel 这些局部变量，只能出现在 **main 之内**（链的前面）。
 *   上一版把它们拼成一段塞进 main 里 ⇒ `0:324: S'u_texel' : syntax error`
 *   （函数内不许声明 uniform、也不许嵌套定义函数），实测编译失败。
 * @param {{sampler:string, texCoords:string}} opts
 * @returns {{global:string, local:string}} 两段 GLSL 片段
 */
export function effectPrelude({ sampler, texCoords }) {
  return {
    global: [
      'uniform vec2 u_texel;',
      `vec3 texelSample(vec2 p) { return texture2D(${sampler}, p).rgb; }`,
    ].join('\n'),
    local: [
      `vec2 uv = ${texCoords};`,
      'vec2 texel = u_texel;',
    ].join('\n  '),
  };
}

/**
 * 生成链上**插件参数 uniform 的声明**（全局作用域）。
 *
 * 为什么必须单独生成：插件的 params[].key 只是"名字 + 区间"，着色器里从来没有它们的声明；
 *   只下发值而不声明 ⇒ `ERROR: 0:10: 'u_amount' : undeclared identifier`（实测踩过）。
 * 类型当前只支持 float（契约 §9.1：params[].type 当前只允许 "float"）。
 * @param {Array<{uniforms:object}>} chain
 * @returns {string} GLSL 声明行（每行一个），无参数时返回空串
 */
export function uniformDeclarations(chain) {
  const keys = new Set();
  for (const eff of chain || []) {
    for (const key of Object.keys(eff.uniforms || {})) keys.add(key);
  }
  return [...keys].map((key) => `uniform float ${key};`).join('\n');
}

/**
 * 档位 → 参数值（第 0 档 = 关闭，不产生 uniform）。
 *
 * 为什么按索引线性映射：契约里插件只声明 options 文本与 params 区间，
 *   没有逐档具体值的位置；线性映射是唯一不要求插件多写一套配置的确定规则。
 * @param {object} effect { params: [{key, min, max}] }
 * @param {number} optionIndex 选中下标（0 = 关）
 * @param {number} optionCount 总档数
 * @returns {{active:boolean, uniforms:object}}
 */
export function uniformsForOption(effect, optionIndex, optionCount) {
  const params = (effect && Array.isArray(effect.params)) ? effect.params : [];
  const idx = Number(optionIndex);
  const count = Number(optionCount);
  // 「关」档（idx=0）也**留在链里**，参数取 min（通常 0）⇒ 表达式退化成恒等、画面等于原图。
  //   这样切档位只改 uniform、链的**结构签名**不变 ⇒ 上层不重建着色器/滤镜实例。
  //   反过来做（关档就把它从链里摘掉）会让每次"关↔开"都触发一次重建 + 着色器编译，
  //   实测卡顿明显。
  const t = count > 1 ? Math.min(1, Math.max(0, idx) / (count - 1)) : 0;
  const uniforms = {};
  for (const p of params) {
    if (!p || !p.key) continue;
    const min = Number.isFinite(Number(p.min)) ? Number(p.min) : 0;
    const max = Number.isFinite(Number(p.max)) ? Number(p.max) : 1;
    uniforms[p.key] = min + (max - min) * t;
  }
  return { active: true, uniforms };
}

/**
 * 按当前设置算出生效的效果链（顺序 = 传入声明顺序 = 清单 effects[] 顺序）。
 * @param {Array<{id:string, fragment:string, params:Array}>} declared
 * @param {(id:string)=>{optionIndex:number, optionCount:number}} readSetting
 * @returns {Array<{id:string, fragment:string, uniforms:object}>}
 */
export function activeChain(declared, readSetting) {
  const out = [];
  for (const eff of declared || []) {
    if (!eff || !eff.id || !eff.fragment) continue;
    const sel = (typeof readSetting === 'function' ? readSetting(eff.id) : null) || { optionIndex: 0, optionCount: 1 };
    const { active, uniforms } = uniformsForOption(eff, sel.optionIndex, sel.optionCount);
    if (!active) continue;
    out.push({ id: eff.id, fragment: eff.fragment, uniforms });
  }
  return out;
}

/**
 * 生成链的着色器主体：`vec3 c = base; c = (预设); c = (效果1); …; vec3 f = c;`
 *
 * 为什么"反复改写 c"而不是嵌套表达式：插件表达式里写的就是 c，
 *   嵌套就得改写它内部的标识符（脆且不可靠）；顺序赋值让每段自然看到上一段输出。
 * @param {{presetBody:string, effects:Array<{fragment:string}>}} opts
 * @returns {string}
 */
export function buildChainBody({ presetBody, effects }) {
  const lines = ['vec3 c = base;', `c = (${presetBody || 'c'});`];
  for (const eff of effects || []) {
    if (!eff || !eff.fragment) continue;
    lines.push(`c = (${eff.fragment});`);
  }
  lines.push('vec3 f = c;');
  return lines.join('\n  ');
}

/**
 * 汇总链上所有 uniform 值。
 * @param {Array<{uniforms:object}>} chain
 * @returns {object}
 */
export function chainUniforms(chain) {
  const out = {};
  for (const eff of chain || []) {
    for (const [k, v] of Object.entries(eff.uniforms || {})) out[k] = v;
  }
  return out;
}

/**
 * 链的**结构**签名：只含"效果 id + 表达式"，**不含参数值**。
 * 参数变化只改 uniform；签名一变才允许重建着色器/滤镜实例（热更新的判据）。
 * @param {Array<{id:string, fragment:string}>} chain
 * @returns {string}
 */
export function chainSignature(chain) {
  return (chain || []).map((e) => `${e.id}:${e.fragment}`).join('|');
}
