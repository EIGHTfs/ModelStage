// app/backgrounds.js —— 自定义背景图的前端数据层（只跟服务端 5 个接口打交道）
//
// 为什么不存 localStorage：背景图要能列表管理、要刷新后仍在、要能换机带走，
//   dataURL 写 localStorage 是"假上传"（换浏览器就丢、单张 4MB 就写爆存储）。
// 服务端落盘在 data/backgrounds/，这里只管取列表 / 传 / 改名 / 删。
//
// 失败原因码（后端 reason）到用户可见文案的映射也放在这里，面板与底栏共用同一套说法。

/** 后端接口根（同源，随页面部署） */
const API = '/api/backgrounds';

/** 允许的图片类型（与服务端白名单一致；前端只用于 file 选择框过滤） */
export const ACCEPT = 'image/png,image/jpeg,image/webp';

/** 单张上限（5MB）：服务端权威判定，这里只用于提前给出人话提示 */
export const MAX_BYTES = 5 * 1024 * 1024;

/** reason → 用户可见文案（后端 error 更具体时优先用后端文案） */
const REASON_TEXT = {
  'too-large': `图片超过 ${MAX_BYTES / 1048576}MB 上限，请先压缩再上传`,
  'bad-type': '只接受 png / jpeg / webp 图片',
  'bad-name': '名称不能为空',
  'not-found': '这张图已经不在了，请刷新列表',
  'empty': '没有收到文件内容',
  'aborted': '上传被中断了，请重试',
  'disk-error': '服务端写盘失败，请稍后重试',
  'server-error': '服务端内部错误',
};

/**
 * 把一次失败响应翻成人话（优先用服务端给的 error，它带具体数值）。
 * @param {object|null} body 响应体（可能是 null）
 * @param {number} status HTTP 状态码
 * @returns {{reason: string, message: string}} 原因码与提示文案
 */
export function describeFailure(body, status) {
  const reason = (body && body.reason) || (status === 413 ? 'too-large' : 'server-error');
  const message = (body && body.error) || REASON_TEXT[reason] || `请求失败（HTTP ${status}）`;
  return { reason, message };
}

/**
 * 统一请求封装：解析 JSON、把失败翻成 {ok:false, reason, message}。
 * @param {string} url 目标地址
 * @param {object} [init] fetch 参数
 * @returns {Promise<object>} 成功时为响应体（含 ok:true），失败时 {ok:false, reason, message}
 */
async function request(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    return { ok: false, reason: 'network', message: `网络请求失败：${(e && e.message) || e}` };
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || !body || body.ok !== true) return { ok: false, ...describeFailure(body, res.status) };
  return body;
}

/**
 * 取列表。
 * @returns {Promise<{ok:boolean, items?:Array, message?:string}>} items 里每项有 {id,name,url,bytes}
 */
export function listBackgrounds() {
  return request(API, { cache: 'no-store' });
}

/**
 * 上传一张图（原始二进制 body + x-filename 头）。
 *
 * 为什么不用 FormData：服务端按原始字节流边读边计上限（multipart 要先落临时文件再解析），
 *   而且这里不需要多字段——文件名走 x-filename（百分号编码，避免中文乱码）。
 * @param {File} file 用户选的文件
 * @returns {Promise<object>} 成功 {ok:true, item}，失败 {ok:false, reason, message}
 */
export function uploadBackground(file) {
  if (!file) return Promise.resolve({ ok: false, reason: 'empty', message: '没有选择文件' });
  if (file.size > MAX_BYTES) {
    // 前端先挡一层：省掉一次 5MB 的无效上传（服务端仍会再判一次）
    return Promise.resolve({
      ok: false, reason: 'too-large',
      message: `图片 ${(file.size / 1048576).toFixed(2)}MB 超过 ${MAX_BYTES / 1048576}MB 上限，请先压缩`,
    });
  }
  return request(API, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'x-filename': encodeURIComponent(file.name || ''),
    },
    body: file,
  });
}

/**
 * 重命名（只改显示名，id 与 url 不变）。
 * @param {string} id 目标 id
 * @param {string} name 新名字
 * @returns {Promise<object>} 成功 {ok:true, item, adjusted}
 */
export function renameBackground(id, name) {
  return request(`${API}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name }),
  });
}

/**
 * 删除（服务端把文件移进 .trash/，可恢复）。
 * @param {string} id 目标 id
 * @returns {Promise<object>} 成功 {ok:true, removed}
 */
export function removeBackground(id) {
  return request(`${API}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}

/** 把索引 id 变成可直接用的图片地址 */
export function urlOf(item) {
  return item && item.url ? item.url : '';
}

/**
 * 选择本地图片：弹系统文件选择框，返回用户选的 File（取消返回 null）。
 * @returns {Promise<File|null>} 选中的文件
 */
export function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT;
    input.style.cssText = 'position:fixed;left:-9999px;';
    document.body.append(input);
    input.addEventListener('change', () => {
      const file = (input.files && input.files[0]) || null;
      input.remove();
      resolve(file);
    }, { once: true });
    input.click();
  });
}
