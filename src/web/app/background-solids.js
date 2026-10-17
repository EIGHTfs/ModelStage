// app/background-solids.js —— 「纯色预设」的前端数据层（只管跟服务端 5 个接口打交道）
//
// 为什么不存本地：预设要能列表管理、要跨设备带走（清前端偏好也不该丢），
//   所以权威数据在服务端；localStorage 只保存"当前选中的颜色值"（那属于界面偏好）。
//
// 与 panel/color-picker.js 的分工：
//   调色盘只回一个 '#rrggbb'；命名、增删改、列表刷新**全在这里**，调色盘不认识"预设"这件事。

import { getJson, postJson, formatError } from '../infra/api.js';

/** 接口根（同源） */
const API = '/api/backgrounds/solids';

/**
 * 最近一次成功取到的列表（缓存）。
 * 用途：给"背景色默认值"提供一个**同步可读**的兜底（view-settings 里取默认色时不能 await）。
 * 只读语义：这里不做任何本地持久化，进程内缓存而已。
 */
let cache = [];

/** 内置兜底色：接口没就绪/取不到时，纯色模式仍然有一个合法颜色可用 */
export const FALLBACK_COLOR = '#2a2a2a';

/**
 * 读取缓存中的预设列表（可能为空）。
 * @returns {Array<{id:string,name:string,color:string,createdAt?:string}>}
 */
export function cachedSolids() {
  return cache.slice();
}

/**
 * 默认纯色：预设列表第一条的颜色；没有预设时用内置兜底。
 * @returns {string} '#rrggbb'
 */
export function defaultSolidColor() {
  const first = cache[0];
  return first && first.color ? first.color : FALLBACK_COLOR;
}

/**
 * 归一化一条记录（服务端字段名固定：id / name / color / createdAt）。
 * @param {object} it
 * @returns {{id:string,name:string,color:string,createdAt?:string}}
 */
function normalize(it) {
  const o = it && typeof it === 'object' ? it : {};
  return {
    id: String(o.id || ''),
    name: String(o.name || ''),
    color: String(o.color || '').toLowerCase(),
    createdAt: o.createdAt,
  };
}

/**
 * 把失败响应翻成人话（优先用服务端 error，它带具体原因）。
 * @param {object|null} body
 * @param {number} status
 * @param {string} [fallback]
 * @returns {string}
 */
function failureText(body, status, fallback) {
  if (body && typeof body.error === 'string' && body.error) return body.error;
  return fallback || `请求失败（HTTP ${status}）`;
}

/**
 * 取纯色预设列表。
 * @returns {Promise<{ok:boolean, items:object[], message?:string}>}
 */
export async function listSolids() {
  try {
    const body = await getJson(API);
    const items = (body && Array.isArray(body.items) ? body.items : []).map(normalize);
    cache = items;
    return { ok: true, items };
  } catch (err) {
    const status = (err && err.status) || 0;
    return { ok: false, items: [], message: failureText(err && err.body, status, formatError(err)) };
  }
}

/**
 * 新增一条预设。
 * @param {string} name ≤30 字符（服务端去重/校验，前端不重复实现规则）
 * @param {string} color '#rrggbb'
 * @returns {Promise<{ok:boolean, item?:object, message?:string}>}
 */
export async function addSolid(name, color) {
  try {
    const body = await postJson(API, { name, color });
    const item = body && body.item ? normalize(body.item) : null;
    if (item) cache = [...cache, item];
    return { ok: true, item: item || undefined };
  } catch (err) {
    const status = (err && err.status) || 0;
    return { ok: false, message: failureText(err && err.body, status, formatError(err)) };
  }
}

/**
 * 改名（id 与 color 不变）。
 * @param {string} id
 * @param {string} name
 * @returns {Promise<{ok:boolean, item?:object, message?:string}>}
 */
export async function renameSolid(id, name) {
  try {
    const body = await postJson(`${API}/rename`, { id, name });
    const item = body && body.item ? normalize(body.item) : null;
    if (item) cache = cache.map((x) => (x.id === item.id ? item : x));
    return { ok: true, item: item || undefined };
  } catch (err) {
    const status = (err && err.status) || 0;
    return { ok: false, message: failureText(err && err.body, status, formatError(err)) };
  }
}

/**
 * 删除一条。
 * @param {string} id
 * @returns {Promise<{ok:boolean, removed?:number, id?:string, message?:string}>}
 */
export async function removeSolid(id) {
  try {
    const body = await postJson(`${API}/remove`, { id });
    cache = cache.filter((x) => x.id !== id);
    return { ok: true, removed: body && body.removed, id: (body && body.id) || id };
  } catch (err) {
    const status = (err && err.status) || 0;
    return { ok: false, message: failureText(err && err.body, status, formatError(err)) };
  }
}

/**
 * 恢复默认 5 色（服务端权威：它知道默认是哪 5 条）。
 * @returns {Promise<{ok:boolean, items:object[], message?:string}>}
 */
export async function resetSolids() {
  try {
    const body = await postJson(`${API}/reset`, {});
    const items = (body && Array.isArray(body.items) ? body.items : []).map(normalize);
    cache = items;
    return { ok: true, items };
  } catch (err) {
    const status = (err && err.status) || 0;
    return { ok: false, items: [], message: failureText(err && err.body, status, formatError(err)) };
  }
}
