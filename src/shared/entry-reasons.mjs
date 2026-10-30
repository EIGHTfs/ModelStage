// shared/entry-reasons.mjs —— 装载结果 reason 的**唯一码表**（服务端存储、接口、前端渲染都从这里取）
//
// 为什么必须收口：同一个失败在四条路上有四套叫法 ——
//   前端 plugin-host 叫 no-provider、服务端 plugin-runner 叫 not-handled、
//   插件 lib 抛 ULB_ERR_TEX_DECODE、解包层还可能冒出 insufficient-memory。
//   契约《条目状态与展示归属》§二 要求 reason 是**结构化码**（"不稳定文案不许进这里"），
//   所以这里定一份枚举 + 一份边界映射，禁止各处再写字面量。
//
// 插件 lib 不改：ULB_ERR_* 是它的内部码，只在边界用 fromUlbError() 映射过来。

/** 契约码枚举（键名给代码用，值是与接口/存储里出现的字符串） */
export const REASONS = Object.freeze({
  // ── 认领层：没人愿意/不能接这个文件
  NO_PROVIDER: 'no-provider',
  ASSET_DEPENDENCY: 'asset-dependency',
  // ── 资产层：目录型散文件缺件
  MISSING_TEXTURES: 'missing-textures',
  ASSET_MISSING: 'asset-missing',
  VERSION_UNREADABLE: 'version-unreadable',
  // ── 容器层
  CONTAINER_PARSE: 'container-parse',
  NOT_UNITYFS: 'not-unityfs',
  NO_CAB: 'no-cab',
  // ── 纹理解码层
  TEX_DECODE: 'tex-decode',
  TEX_FORMAT_UNSUPPORTED: 'tex-format-unsupported',
  TEX_DATA_SHORT: 'tex-data-short',
  // ── 资源/环境层
  INSUFFICIENT_MEMORY: 'insufficient-memory',
  BAD_ARGS: 'bad-args',
  NOT_FOUND: 'not-found',
  UNPACK_FAILED: 'unpack-failed',
  // ── 渲染层（前端上报用）
  RENDER_FAILED: 'render-failed',
  // ── 兜底：宁可说"不知道"，也不要编一个像样的原因
  UNKNOWN: 'unknown',
});

const ALL = new Set(Object.values(REASONS));

/**
 * 契约码 → 中文兜底文案。
 * 注意：这只是**兜底**（调用方没给 message 时用）。真正的可读原因应尽量由判定方给出
 *   （如依赖包用 shared/bundle-shape.mjs 的 dependencyReason()），否则会退化成"只知道码、不知道话"。
 */
export const REASON_TEXT = Object.freeze({
  [REASONS.NO_PROVIDER]: '没有插件能处理这个资源包',
  [REASONS.ASSET_DEPENDENCY]: '这是美术依赖包，不能单独装载',
  [REASONS.MISSING_TEXTURES]: '缺少贴图文件，渲染必然失败',
  [REASONS.ASSET_MISSING]: '资源文件缺失',
  [REASONS.VERSION_UNREADABLE]: '读不出骨架/模型版本',
  [REASONS.CONTAINER_PARSE]: '资源包结构解析失败',
  [REASONS.NOT_UNITYFS]: '不是 UnityFS 资源包',
  [REASONS.NO_CAB]: '资源包里没有资产节点',
  [REASONS.TEX_DECODE]: '纹理解码失败',
  [REASONS.TEX_FORMAT_UNSUPPORTED]: '不支持这种纹理格式',
  [REASONS.TEX_DATA_SHORT]: '纹理数据不完整',
  [REASONS.INSUFFICIENT_MEMORY]: '可用内存不足，已拒绝解包',
  [REASONS.BAD_ARGS]: '请求参数不合法',
  [REASONS.NOT_FOUND]: '路径不存在',
  [REASONS.UNPACK_FAILED]: '解包失败',
  [REASONS.RENDER_FAILED]: '渲染失败',
  [REASONS.UNKNOWN]: '原因未知',
});

/** 插件内部码 → 契约码。插件 lib 的 ULB_ERR_* 不改，只在这里翻译。 */
const ULB_MAP = Object.freeze({
  ULB_ERR_TEX_DECODE: REASONS.TEX_DECODE,
  ULB_ERR_TEX_FORMAT_UNSUPPORTED: REASONS.TEX_FORMAT_UNSUPPORTED,
  ULB_ERR_TEX_DATA_SHORT: REASONS.TEX_DATA_SHORT,
  ULB_ERR_NOT_UNITYFS: REASONS.NOT_UNITYFS,
  ULB_ERR_NO_CAB: REASONS.NO_CAB,
  ULB_ERR_CONTAINER_PARSE: REASONS.CONTAINER_PARSE,
  ULB_ERR_NO_FILE: REASONS.ASSET_MISSING,
  ULB_ERR_BAD_ARGS: REASONS.BAD_ARGS,
});

/**
 * 把任意来源的 reason 归一到契约码。
 *
 * 为什么需要：服务端 plugin-runner 用 `not-handled`，前端 plugin-host 用 `no-provider`，
 *   两者是同一件事（"所有提供者都说不处理"）；不归一会让同一条失败在存储里有两个键，
 *   前端按码查文案时会漏。
 * @param {unknown} raw
 * @returns {string} 契约码（永远落在 REASONS 的值里）
 */
export function normalizeReason(raw) {
  if (raw === null || raw === undefined || raw === '') return REASONS.UNKNOWN;
  const s = String(raw).trim();
  if (ALL.has(s)) return s;
  // 同义合并：服务端 runner 的 not-handled ≡ 前端 host 的 no-provider
  if (s === 'not-handled') return REASONS.NO_PROVIDER;
  // 已经带着 ULB_ 前缀的也认（有些路径会把插件内部码直接透上来）
  if (s.startsWith('ULB_ERR_')) return fromUlbError(s);
  return REASONS.UNKNOWN;
}

/**
 * 插件内部错误码 → 契约码。
 * @param {string|null|undefined} code 形如 ULB_ERR_TEX_DECODE
 * @returns {string} 契约码；未登记的 ULB_ERR_* 一律 unpack-failed（不是 unknown：它确实是解包环节失败的）
 */
export function fromUlbError(code) {
  if (!code) return REASONS.UNKNOWN;
  const s = String(code).trim();
  if (ULB_MAP[s]) return ULB_MAP[s];
  if (s.startsWith('ULB_ERR_')) return REASONS.UNPACK_FAILED;
  return normalizeReason(s);
}

/**
 * 取某个契约码的兜底文案。
 * @param {string} reason 契约码（内部会先归一）
 * @returns {string}
 */
export function reasonText(reason) {
  const code = normalizeReason(reason);
  return REASON_TEXT[code] || REASON_TEXT[REASONS.UNKNOWN];
}
