// roster/bundle-failures.js —— 容器条目的「装载失败」记忆（本地缓存）
//
// 为什么需要：容器条目在列举阶段 kind 为 null（解包前判不出类型），名册上它和能用的资源包长得一样，
//   用户点开才知道不行。这里把"装载失败"按条目记下来，下次渲染名册时直接给一个 ⚠ 标记 ——
//   与目录型条目的「⚠ 缺纹理」同一套展示语义（同一个 tree-variant-warn 徽标）。
//
// 硬约束：
//   · 只记**容器条目**（entry.container 为真）的失败；目录型条目的缺纹理仍走 catalog 的
//     meta.missingTextures，两条来源不重叠。
//   · 只是**提示**：装载路径完全不变，点了仍要如实报错（标记绝不吞错误）。
//
// 存储：localStorage 独立键（不混进 TREE_STATE_KEY）。
//   { "fp": "插件id@version 排序拼接", "items": { "<modelId>": {reason,message,size,at} } }
//
// 过期规则（任一不满足即视为失效）：
//   ① 指纹不符 ⇒ **整批丢弃**（插件集合或版本变了，"不支持"的结论不再可信；
//      否则"修好插件后仍显示不支持"会严重误导）
//   ② 条目 size 变化 ⇒ 该条失效（同名文件被替换）
//   ③ 缓存里没有该 modelId ⇒ 不显示

const FAIL_KEY = 'modelstage-bundle-failures';

// 插件清单走统一 HTTP 层（重试 + 与 plugin-host 的同 URL 去重 + 统一超时/错误归类）
import { getJson } from '../infra/api.js';

/**
 * 失败原因 → 一句人话。
 *
 * **只对真实存在的 reason 做映射**：没把握的一律走 message 兜底。
 *   编一个"看起来合理"的分类比显示原始 message 更危险 —— 用户会以为系统知道原因。
 *   reason 取值来自 infra/plugin-host.js 的 materialize/resolveViaProvider。
 */
const REASON_TEXT = {
  'no-provider': '没有插件能处理这个资源包（该格式暂不支持，或对应插件被禁用/加载失败）',
  'no-resolve': '插件缺少解析实现',
  'resolve-failed': '插件解析这个资源包失败',
  'bad-result': '插件返回的数据不符合约定',
  'lookup-error': '查询解包缓存时出错',
  'server-miss': '服务端没有这个资源包的缓存',
  'memory-guard': '内存不足，已跳过解包',
  prefilter: '按内存准入规则跳过了解包',
  'entry-missing': '包内缺少 entry.json（无法确定这是 spine 还是 Live2D）',
  'kind-undetermined': '包内既没有 spine 清单也没有 Live2D 定义，无法判定类型',
};

/** 当前插件集合的指纹（`id@version` 排序拼接）；空串表示还没取到 */
let currentFp = '';

/** 取插件指纹：与 providerFingerprint 同口径（id@version 排序） */
async function fetchFingerprint() {
  try {
    // 与 plugin-host 的 doLoadAll 同一个 URL ⇒ 走统一层后两处并发会被合并成一次真实请求
    //   （no-store 必须保留：插件升级后指纹要立刻变，读缓存会拿到旧指纹）
    const data = await getJson('/api/plugins', { cache: 'no-store' });
    const list = Array.isArray(data && data.plugins) ? data.plugins : [];
    return list
      .map((p) => `${String((p && p.id) || '')}@${String((p && p.version) == null ? '' : p.version)}`)
      .sort()
      .join('|');
  } catch { return ''; }
}

/** 读整个缓存（结构异常一律当空） */
function readAll() {
  try {
    const raw = localStorage.getItem(FAIL_KEY);
    if (!raw) return { fp: '', items: {} };
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return { fp: '', items: {} };
    const items = (obj.items && typeof obj.items === 'object') ? obj.items : {};
    return { fp: String(obj.fp || ''), items };
  } catch { return { fp: '', items: {} }; }
}

function writeAll(data) {
  try { localStorage.setItem(FAIL_KEY, JSON.stringify(data)); return true; } catch { return false; }
}

/**
 * 初始化指纹（在名册 mount 时 await 一次）。
 * 指纹与缓存里记录的不一致 ⇒ **整批丢弃**（过期规则①）。
 * @returns {Promise<string>} 当前指纹
 */
export async function ensureFingerprint() {
  const fp = await fetchFingerprint();
  currentFp = fp;
  if (!fp) return '';                     // 取不到指纹：本轮不显示标记（保守），也不清缓存
  const data = readAll();
  if (data.fp && data.fp !== fp) {
    writeAll({ fp, items: {} });          // 插件集合/版本变了 ⇒ 旧结论整批作废
  } else if (!data.fp && Object.keys(data.items).length) {
    writeAll({ fp, items: {} });          // 老缓存没有指纹字段 ⇒ 同样不可信
  } else if (!data.fp) {
    writeAll({ fp, items: {} });          // 初始化一份带指纹的空缓存，便于排障时看到结构
  }
  return fp;
}

/**
 * 记录一次装载失败（只在 loadModel 内部调用）。
 * @param {{id?:string, name?:string, size?:number, container?:string, rel?:string}} model 条目
 * @param {string|null} reason 结构化原因；没有就传 null（不编造）
 * @param {string} message 原始 message（reason 为空时作为展示兜底）
 */
export function recordFailure(model, reason, message) {
  const id = String((model && (model.id || model.name)) || '');
  if (!id) return false;
  // 只记容器条目：目录型的失败多数是资产问题，已有 missingTextures 那套，不要混进来
  if (!model || !model.container) return false;
  const data = readAll();
  // 写入时若指纹还没就绪，用当前已取到的（ensureFingerprint 已在 mount 时 await 过）
  const fp = currentFp || data.fp || '';
  const items = { ...data.items };
  items[id] = {
    reason: reason || null,
    message: String(message || '').slice(0, 300),
    size: Number(model.size) || 0,
    at: Date.now(),
  };
  return writeAll({ fp, items });
}

/**
 * 取某条目的失败记录；无记录 / 已失效返回 null。
 * @param {{id?:string, name?:string, size?:number, container?:string}} model
 * @returns {{text:string, reason:string|null}|null}
 */
export function getFailure(model) {
  if (!model || !model.container) return null;      // 只对容器条目生效
  if (!currentFp) return null;                      // 指纹未就绪：不显示（避免用过期结论误导）
  const id = String(model.id || model.name || '');
  if (!id) return null;
  const data = readAll();
  if (data.fp && data.fp !== currentFp) return null; // 过期规则①（ensureFingerprint 通常已清）
  const rec = data.items[id];
  if (!rec) return null;                             // 过期规则③
  // 过期规则②：size 变了说明文件被替换，旧结论不可信
  if (Number(rec.size) && Number(model.size) && Number(rec.size) !== Number(model.size)) return null;
  const mapped = rec.reason ? REASON_TEXT[rec.reason] : null;
  const text = mapped || String(rec.message || '').slice(0, 60) || '该资源包无法装载';
  return { text, reason: rec.reason || null };
}

/** 清空缓存（测试/排障用；也让"人工验证指纹失效"有个干净起点） */
export function clearFailures() {
  return writeAll({ fp: currentFp, items: {} });
}

/**
 * 批量快照：渲染名册前读一次，避免逐行 JSON.parse。
 * 校验规则与 getFailure 一致（指纹不符整批作废、size 变化该条失效）。
 * @returns {Map<string, {text:string, reason:string|null}>} modelId → 失败文案
 */
export function getFailureSnapshot() {
  const out = new Map();
  if (!currentFp) return out;
  const data = readAll();
  if (data.fp && data.fp !== currentFp) return out;
  for (const [id, rec] of Object.entries(data.items)) {
    if (!rec || typeof rec !== 'object') continue;
    const mapped = rec.reason ? REASON_TEXT[rec.reason] : null;
    const text = mapped || String(rec.message || '').slice(0, 60) || '该资源包无法装载';
    out.set(id, { text, reason: rec.reason || null, size: Number(rec.size) || 0 });
  }
  return out;
}

/** 当前指纹（排障用） */
export function currentFingerprint() {
  return currentFp;
}

export { FAIL_KEY };
