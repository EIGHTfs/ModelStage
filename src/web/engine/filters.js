// engine/filters.js —— 滤镜预设表 + 着色器注入/还原（语义照抄旧引擎 qd/pk/gk/vk/reconcileFilter）
//
// 片元模板的做法与旧引擎一致：先把预乘色还原成直通 `c`，套上预设表达式 `__FILTER__`，
//   再乘回 alpha 输出 —— 所以滤镜效果与 PMA 口径解耦，切滤镜不需要重传纹理。

/** 滤镜预设表（12 项，顺序与旧引擎 qd 一致；id 稳定，面板按 id 下发） */
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

/** 顶点着色器（与旧引擎 pk 同结构：透传位置/颜色/UV） */
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

/** 片元着色器模板（__FILTER__ 处填入预设表达式） */
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

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

vec3 toGray(vec3 c) { return vec3(dot(c, LUMA)); }
vec3 withSat(vec3 c, float s) { float l = dot(c, LUMA); return mix(vec3(l), c, s); }

void main() {
  vec4 texColor = texture2D(u_texture, v_texCoords);
  float a = texColor.a * v_light.a;
  vec3 pma = ((texColor.a - 1.0) * v_dark.a + 1.0 - texColor.rgb) * v_dark.rgb + texColor.rgb * v_light.rgb;
  vec3 c = pma / max(a, 0.00001);
  vec3 f = __FILTER__;
  gl_FragColor = vec4(f * a, a);
}
`;

/** 取某预设的 vs/fs（未知 id 回落 original） */
export function shaderSourceOf(id) {
  const preset = FILTER_PRESETS.find((p) => p.id === id) || FILTER_PRESETS[0];
  return { vs: VERTEX_SHADER, fs: FRAGMENT_TEMPLATE.replace('__FILTER__', () => preset.body) };
}

/**
 * 把滤镜着色器装上/还原（旧引擎 reconcileFilter，行 284 @51770）。
 * 关键约定：
 *   · `savedDefaultBatcherShader` **只在第一次装滤镜时保存一次**，避免把"滤镜着色器"当成默认存进去；
 *   · 编译失败 → warn 并保持原渲染（不置空、不抛）；
 *   · 切回 original 时还原默认着色器并 dispose 滤镜着色器。
 * @param {{renderer: object, gl: WebGLRenderingContext, ShaderCtor: Function,
 *          filterId: string, saved: object|null, active: object|null}} ctx
 * @returns {{saved: object|null, active: object|null, changed: boolean}}
 */
export function reconcileFilter(ctx) {
  const { renderer: r, gl, ShaderCtor, filterId, state, log = () => {} } = ctx;
  if (!r || !gl || !ShaderCtor || !('batcherShader' in r)) return { ...state, changed: false };
  if (filterId === DEFAULT_FILTER) {
    if (state.active) {
      if (state.saved) r.batcherShader = state.saved;
      try { state.active.dispose(); } catch { /* 释放失败不影响还原 */ }
      return { saved: state.saved, active: null, changed: true };
    }
    return { ...state, changed: false };
  }
  const saved = state.saved || r.batcherShader;
  const { vs, fs } = shaderSourceOf(filterId);
  let shader = null;
  try {
    shader = new ShaderCtor(gl, vs, fs);
  } catch (e) {
    log('warn', `滤镜着色器编译失败，保持原渲染: ${e && e.message ? e.message : e}`, 'filter');
    return { saved, active: state.active, changed: false };
  }
  const prev = state.active;
  r.batcherShader = shader;
  if (prev) { try { prev.dispose(); } catch { /* 忽略 */ } }
  return { saved, active: shader, changed: true };
}
