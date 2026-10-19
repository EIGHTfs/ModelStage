// vfs.js —— 虚拟文件系统（VirtualFS）：内存资源成为一等公民
//
// 做什么：插件把内存里的文件（Blob / 字符串）按「前缀 + 相对路径」注册进来，
//   加载器拿原始 URL 来问 resolve()，命中就返回一个可用的 Blob URL，未命中返回 null。
// 为什么需要：Live2D / 资源包等插件的资源常常不是磁盘文件，以前只能 patch 加载器；
//   有了 VirtualFS，插件只注册文件，加载器保持原样（未命中回落原 URL，天然可退化）。
//
// 设计约束：
//   · 纯模块：不碰 DOM、不 import 任何模块，可在 Node 里直接单测；
//   · Blob URL **懒创建 + 缓存**：第一次 resolve 才建，重复 resolve 复用同一个；
//   · revoke(prefix) 释放该前缀下所有 Blob URL 并注销该前缀（之后 resolve 返回 null）；
//   · prefix 全局唯一：重复注册直接抛错，避免"谁覆盖谁"的隐性 bug；
//   · 路径归一化统一处理 `./`、`../`、查询串、哈希、URL 编码、反斜杠。

/**
 * 把任意写法的路径归一化成「无前导斜杠、无 ./、无 ../、无查询串」的相对路径。
 * @param {string} raw
 * @returns {string|null} 归一化结果；无法解析时返回 null
 */
function normalizePath(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let p = raw.split('#')[0].split('?')[0];
  // 编码可能套了两层（例如 %2520），最多解两层，解不开就保持原样
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(p);
      if (decoded === p) break;
      p = decoded;
    } catch {
      break;
    }
  }
  p = p.replace(/\\/g, '/');
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

/** 取 URL 里可参与匹配的部分：绝对 URL 取 pathname，其余按原样归一化 */
function pathOfUrl(url) {
  try {
    const parsed = new URL(url, 'http://vfs.local/');
    return normalizePath(parsed.pathname);
  } catch {
    return normalizePath(url);
  }
}

/** 字节数：Blob 用 size，字符串按 UTF-8 估算 */
function sizeOf(value) {
  if (typeof value === 'string') {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
    return value.length;
  }
  if (value && typeof value.size === 'number') return value.size;
  return 0;
}

/**
 * 创建虚拟文件系统。
 * @param {{
 *   createObjectURL?: (blob: Blob) => string,
 *   revokeObjectURL?: (url: string) => void,
 * }} [options] 可注入 URL 工厂（Node 环境没有 URL.createObjectURL 时用 fake 单测）
 */
export function createVirtualFS(options = {}) {
  const createObjectURL = typeof options.createObjectURL === 'function'
    ? options.createObjectURL
    : (blob) => URL.createObjectURL(blob);
  const revokeObjectURL = typeof options.revokeObjectURL === 'function'
    ? options.revokeObjectURL
    : (url) => URL.revokeObjectURL(url);

  /** prefix → { files: Map<relPath, Blob|string>, urls: Map<relPath, blobUrl> } */
  const entries = new Map();
  let hits = 0;
  let misses = 0;
  let createdUrls = 0;

  /**
   * 注册一批文件。
   * @param {string} prefix 前缀（全局唯一），如 `/live2d-lib/` 或 `atlas/`
   * @param {Map<string, Blob|string>|Record<string, Blob|string>} files 相对路径 → 内容
   */
  function register(prefix, files) {
    const key = normalizePath(prefix);
    if (!key) throw new Error('VirtualFS.register: prefix 不能为空');
    if (entries.has(key)) throw new Error(`VirtualFS.register: prefix 已注册：${prefix}`);

    const src = files instanceof Map ? files : new Map(Object.entries(files || {}));
    const normalized = new Map();
    for (const [rel, value] of src) {
      const p = normalizePath(rel);
      if (!p) throw new Error(`VirtualFS.register: 非法相对路径：${rel}`);
      if (typeof value !== 'string' && !(value && typeof value === 'object' && typeof value.size === 'number')) {
        throw new Error(`VirtualFS.register: 内容必须是 Blob 或字符串：${rel}`);
      }
      normalized.set(p, value);
    }
    entries.set(key, { files: normalized, urls: new Map() });
  }

  /** 懒创建并缓存某文件的 Blob URL */
  function urlFor(prefix, rel, value) {
    const entry = entries.get(prefix);
    const cached = entry.urls.get(rel);
    if (cached) return cached;
    const blob = typeof value === 'string' ? new Blob([value]) : value;
    const url = createObjectURL(blob);
    entry.urls.set(rel, url);
    createdUrls += 1;
    return url;
  }

  /**
   * 把原始 URL 解析成可用地址。
   * @param {string} url
   * @returns {string|null} 命中返回 Blob URL；未命中返回 null（调用方回落原 URL）
   */
  function resolve(url) {
    const target = pathOfUrl(url);
    if (!target) { misses += 1; return null; }
    for (const [prefix, entry] of entries) {
      if (target !== prefix && !target.startsWith(`${prefix}/`)) continue;
      const rel = target === prefix ? '' : target.slice(prefix.length + 1);
      const value = entry.files.get(rel);
      if (value === undefined) continue;
      hits += 1;
      return urlFor(prefix, rel, value);
    }
    misses += 1;
    return null;
  }

  /**
   * 释放某个前缀下的全部 Blob URL 并注销该前缀（之后 resolve 返回 null）。
   * @param {string} prefix
   * @returns {number} 释放的 URL 数量
   */
  function revoke(prefix) {
    const key = normalizePath(prefix);
    const entry = key ? entries.get(key) : null;
    if (!entry) return 0;
    let count = 0;
    for (const url of entry.urls.values()) {
      try { revokeObjectURL(url); count += 1; } catch { /* 释放失败继续 */ }
    }
    entry.urls.clear();
    entries.delete(key);
    return count;
  }

  /**
   * 统计：前缀数、文件数、字节数、命中/未命中次数（+ 已创建 URL 数，便于验证懒创建）。
   */
  function stats() {
    let files = 0;
    let bytes = 0;
    for (const entry of entries.values()) {
      files += entry.files.size;
      for (const value of entry.files.values()) bytes += sizeOf(value);
    }
    return { prefixes: entries.size, files, bytes, hits, misses, urls: createdUrls };
  }

  return { register, resolve, revoke, stats };
}

export default createVirtualFS;
