// engine/filters.js —— 滤镜预设表 + 着色器注入/还原
//
// 片元模板的做法：先把预乘色还原成直通 `base`，再走 `__EFFECT_CHAIN__`（预设表达式 +
//   插件效果链，产出 vec3 f），最后乘回 alpha 输出 —— 所以滤镜效果与 PMA 口径解耦，
//   切滤镜不需要重传纹理。链的组装本身在 effect-chain.js（与 Live2D 共用）。

import { buildChainBody, chainSignature, chainUniforms, effectPrelude, uniformDeclarations } from './effect-chain.js';
// 编译失败的诊断必须**不经 engine.log** 落地：那是个外部传入的回调，它若不是函数，
//   在 catch 里再抛一次会把异常传出 reconcileFilter，连 filterState 都来不及赋值
//   （表现就是"签名恒空 + 日志里什么都没有"，实测踩过）。
import { stageLog } from '../app/status.js';

/** 纹理像素步长的兜底近似（1/512）：见 shaderSourceOf 里 u_texel 的说明 */
export const DEFAULT_TEXEL = 1 / 512;

/** 滤镜预设表 */
export const FILTER_PRESETS = [
  { id: 'original', name: '原画', body: 'c' },
  { id: 'bright', name: '亮部增强', body: 'clamp(c * 1.14 + 0.04, 0.0, 1.0)' },
  { id: 'soft', name: '亮部柔和', body: 'c * 0.82' },
  { id: 'mono', name: '黑白', body: 'toGray(c)' },
  { id: 'warm', name: '暖色', body: 'clamp(c * vec3(1.08, 1.01, 0.90) + vec3(0.012, 0.006, 0.0), 0.0, 1.0)' },
  { id: 'cool', name: '冷色', body: 'clamp(c * vec3(0.90, 0.97, 1.10), 0.0, 1.0)' },
  { id: 'fresh', name: '日系清新', body: 'withSat(clamp(c * 1.06 + 0.035, 0.0, 1.0), 0.80) * vec3(0.97, 1.0, 1.05)' },
  { id: 'sepia', name: '棕褐复古', body: 'mix(c, clamp(vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131))), 0.0, 1.0), 0.85)' },
  { id: 'tealorange', name: '青橙电影', body: 'c * mix(vec3(0.72, 1.06, 1.16), vec3(1.14, 0.97, 0.76), smoothstep(0.08, 0.92, dot(c, LUMA)))' },
  { id: 'cyber', name: '赛博朋克', body: 'clamp(withSat((c - 0.5) * 1.18 + 0.5, 1.32) * mix(vec3(0.78, 1.08, 1.22), vec3(1.28, 0.82, 1.18), smoothstep(0.1, 0.9, dot(c, LUMA))), 0.0, 1.0)' },
  { id: 'negative', name: '负片', body: '1.0 - c' },
  { id: 'woodcut', name: '版画二值', body: 'vec3(step(0.52, dot(c, LUMA)))' },
];

/** 缺省滤镜 */
export const DEFAULT_FILTER = 'original';

/** 是否合法滤镜 id */
export function hasFilter(id) {
  return FILTER_PRESETS.some((p) => p.id === id);
}

/** 顶点着色器 */
export const VERTEX_SHADER = `
attribute vec4 a_position;
attribute vec4 a_color;
attribute vec4 a_color2;
attribute vec2 a_texCoords;
uniform mat4 u_projTrans;
varying vec4 v_light;
varying vec4 v_dark;
varying vec2 v_texCoords;

void main() {
  v_light = a_color;
  v_dark = a_color2;
  v_texCoords = a_texCoords;
  gl_Position = u_projTrans * a_position;
}
`;

/** 片元着色器模板（__EFFECT_CHAIN__ 处填入预设表达式 + 插件效果链） */
export const FRAGMENT_TEMPLATE = `
#ifdef GL_ES
  #define LOWP lowp
  precision mediump float;
#else
  #define LOWP
#endif
varying LOWP vec4 v_light;
varying LOWP vec4 v_dark;
varying vec2 v_texCoords;
uniform sampler2D u_texture;
__EFFECT_GLOBALS__

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

vec3 toGray(vec3 c) { return vec3(dot(c, LUMA)); }
vec3 withSat(vec3 c, float s) { float l = dot(c, LUMA); return mix(vec3(l), c, s); }

void main() {
  vec4 texColor = texture2D(u_texture, v_texCoords);
  float a = texColor.a * v_light.a;
  vec3 pma = ((texColor.a - 1.0) * v_dark.a + 1.0 - texColor.rgb) * v_dark.rgb + texColor.rgb * v_light.rgb;
  vec3 base = pma / max(a, 0.00001);
  // 下面是"效果链占位行"：由 shaderSourceOf 注入预设表达式与插件效果链，产出 vec3 f。
  // 注意：模板内注释不许出现占位符字样本身，也不许出现反引号（会终止模板字符串）。
  __EFFECT_CHAIN__
  gl_FragColor = vec4(f * a, a);
}
`;

/** 取某预设的 vs/fs（未知 id 回落 original） */
export function shaderSourceOf(id, effects) {
  // 硬断言：两个注入位在模板里必须**恰好各 1 处**。
  //   为什么需要：模板注释里若也写了这两个 token 字样，replace 只会命中最先出现的那一处
  //   ⇒ 注入内容落进注释、真正的注入行留在原地 ⇒ GLSL 报 '{' / '=' 之类的语法错，
  //   而从渲染层一路查下来完全看不出是"字符串拼接"问题（实测在这上面耗了几轮）。
  //   断言能一次拦住，不用再靠肉眼数。
  const countOf = (hay, token) => hay.split(token).length - 1;
  const nGlobals = countOf(FRAGMENT_TEMPLATE, '__EFFECT_GLOBALS__');
  const nChain = countOf(FRAGMENT_TEMPLATE, '__EFFECT_CHAIN__');
  if (nGlobals !== 1 || nChain !== 1) {
    throw new Error(`滤镜模板注入位数量异常：__EFFECT_GLOBALS__=${nGlobals}、__EFFECT_CHAIN__=${nChain}（各必须恰好 1 次）`);
  }
  const preset = FILTER_PRESETS.find((p) => p.id === id) || FILTER_PRESETS[0];
  const chain = Array.isArray(effects) ? effects : [];
  // 链的组装交给 effect-chain.js（与 Live2D 共用同一份语义），这里只负责
  //   "把链塞进 Spine 的片元模板"—— 这是两条链路唯一该有的差异。
  const body = buildChainBody({ presetBody: preset.body, effects: chain });
  // 前置声明分两段（GLSL 作用域规则）：uniform 与函数定义进全局，局部变量进 main 内。
  //   上一版把两段混在一起塞进 main ⇒ `S'u_texel' : syntax error`（实测编译失败）。
  const pre = effectPrelude({ sampler: 'u_texture', texCoords: 'v_texCoords' });
  const useChain = chain.length > 0;
  const fs = FRAGMENT_TEMPLATE
    // 用 replaceAll：占位符若在模板注释里再出现一次，replace 只会换第一处，
    //   把注入内容吞进注释、真占位行残留 ⇒ 语法错（实测踩过）
    .replaceAll('__EFFECT_GLOBALS__', () => (useChain ? `${pre.global}\n${uniformDeclarations(chain)}` : ''))
    .replaceAll('__EFFECT_CHAIN__', () => (useChain ? `${pre.local}\n  ${body}` : body));
  const uniforms = chainUniforms(chain);
  // u_texel 必须有非零值：GLSL 未赋值的 uniform 默认 0 ⇒ texelSample(uv-0) 取回自己，
  //   锐化类表达式退化成 c + k*(c-c) = c，看起来"开关没反应"（上一轮实测踩过）。
  if (chain.length) uniforms.u_texel = [DEFAULT_TEXEL, DEFAULT_TEXEL];
  return { vs: VERTEX_SHADER, fs, uniforms, signature: chainSignature(chain) };
}

/**
 * 把滤镜着色器装上/还原。
 * 关键约定：
 *   · `savedDefaultBatcherShader` **只在第一次装滤镜时保存一次**，避免把"滤镜着色器"当成默认存进去；
 *   · 编译失败 → warn 并保持原渲染（不置空、不抛）；
 *   · 切回 original 时还原默认着色器并 dispose 滤镜着色器。
 * @param {{renderer: object, gl: WebGLRenderingContext, ShaderCtor: Function,
 *          filterId: string, saved: object|null, active: object|null}} ctx
 * @returns {{saved: object|null, active: object|null, changed: boolean}}
 */
/**
 * 给 shader 实例写 uniform 值。
 *
 * PixiJS 各版本挂点不同：v4 是 `shader.uniforms`，v5+ 是 `shader.uniformGroup.uniforms`。
 * 写不上**不抛**：编译本身已经成功，值缺失最多是"效果强度为 0"，
 *   不该被外层当成编译失败（实测：直接写 `shader.uniforms[key]` 在 v5 上抛
 *   "Cannot set properties of undefined"，被 catch 吞成"编译失败"，
 *   于是 active 永远为 null ⇒ 效果永远不生效，而日志看起来像着色器语法问题）。
 * @param {object} shader
 * @param {object} uniforms
 * @param {Function} log
 * @returns {boolean} 是否写成功
 */
function applyUniforms(shader, uniforms, log = () => {}) {
  if (!shader || typeof shader.bind !== 'function') return false;
  // spine-webgl 的 Shader（src/spine-runtimes/spine-webgl-*.js）**没有 uniforms 属性**，
  //   值只能经 bind() + setUniformf / setUniform2f 下发；Pixi 的 uniformGroup/dirty 那套不适用。
  //   gl.uniform* 只作用于当前 program，所以必须先 bind（batcherShader 自己也是这么用的）。
  try {
    shader.bind();
    for (const [key, value] of Object.entries(uniforms || {})) {
      // 未被表达式使用的 uniform 会被 GLSL 编译器优化掉，getUniformLocation 返回 null，
      //   此时 gl.uniform*(null, v) 静默无效 —— 显式拦一下并留痕，免得"声明了却没生效"。
      const loc = typeof shader.getUniformLocation === 'function' ? shader.getUniformLocation(key) : undefined;
      if (loc === null) {
        try { log('warn', `uniform ${key} 在着色器里未被使用（可能被优化掉），已跳过`, 'filter'); } catch { /* 忽略 */ }
        continue;
      }
      if (Array.isArray(value) && value.length === 2) {
        // vec2 必须用 setUniform2f：setUniformf 走 gl.uniform1f，给 vec2 会丢一半
        if (typeof shader.setUniform2f === 'function') shader.setUniform2f(key, Number(value[0]), Number(value[1]));
      } else if (typeof shader.setUniformf === 'function') {
        shader.setUniformf(key, Number(value));
      }
    }
    return true;
  } catch (e) {
    try { log('warn', `效果参数下发失败: ${e && e.message ? e.message : e}`, 'filter'); } catch { /* 忽略 */ }
    return false;
  }
}

export function reconcileFilter(ctx) {
  const { renderer: r, gl, ShaderCtor, filterId, effects, state, log = () => {} } = ctx;
  if (!r || !gl || !ShaderCtor || !('batcherShader' in r)) return { ...state, changed: false };
  const chain = Array.isArray(effects) ? effects : [];
  if (filterId === DEFAULT_FILTER && !chain.length) {
    if (state.active) {
      if (state.saved) r.batcherShader = state.saved;
      try { state.active.dispose(); } catch { /* 释放失败不影响还原 */ }
      return { saved: state.saved, active: null, changed: true, signature: '' };
    }
    // 链已空 ⇒ 签名就是空串（与 active 是否非 null 无关）。
    //   这句漏了会出大问题：active 为 null（例如上一次编译失败从未挂上）时返回 {...state}
    //   会把**旧签名**又带回去 ⇒ 上层以为链还在（实测：关掉档位后签名不回落）。
    return { ...state, changed: false, signature: '' };
  }
  const saved = state.saved || r.batcherShader;
  // 签名 = 预设 + 链上"结构"（效果增减 / 表达式变化）。**参数值不进签名** ——
  //   参数变化只改 uniform，这是热更新的关键：签名一变就会重建着色器（黑帧抖动）。
  const signature = `${filterId}|${chainSignature(chain)}`;
  if (state.active && state.signature === signature) {
    const { uniforms } = shaderSourceOf(filterId, chain);
    applyUniforms(state.active, uniforms, log);
    return { ...state, changed: false, signature };
  }
  const { vs, fs, uniforms } = shaderSourceOf(filterId, chain);
  let shader = null;
  try {
    shader = new ShaderCtor(gl, vs, fs);
    // 新实例的 uniform 要显式写一遍：模板只给了声明空间，值由宿主负责填
    applyUniforms(shader, uniforms, log);
  } catch (e) {
    const detail = e && e.message ? e.message : String(e);
    // 失败也要带 signature：上层用它区分"没有链"和"链挂了"。
    //   漏了它 ⇒ filterState.signature 存成 '' ⇒ effectChainSignature() 恒空，
    //   看起来像"链根本没建"（这就是上一轮卡住的地方）。
    try { stageLog('warn', `滤镜着色器编译失败，保持原渲染: ${detail}`, { filterId, chainLen: chain.length }); } catch { /* 日志失败不影响还原 */ }
    // 把替换后的片元前若干行打出来：要看的是 __EFFECT_CHAIN__ 到底替成了什么
    try {
      const head = String(fs).split('\n').slice(0, 24).join(' ⏎ ');
      stageLog('info', `[滤镜 fs 片段] ${head}`, { filterId, signature });
    } catch { /* 忽略 */ }
    try { log('warn', `滤镜着色器编译失败，保持原渲染: ${detail}`, 'filter'); } catch { /* log 不是函数时别把异常传出去 */ }
    return { saved, active: state.active, changed: false, signature };
  }
  const prev = state.active;
  r.batcherShader = shader;
  if (prev) { try { prev.dispose(); } catch { /* 忽略 */ } }
  return { saved, active: shader, changed: true, signature };
}
