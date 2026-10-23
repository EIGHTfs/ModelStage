// http/backgrounds.mjs —— 舞台「自定义背景图」的存储与五个接口
//
// 为什么要服务端存：背景图要跟"换机/备份"一起走、要在刷新后仍在、要能被重命名与删除。
//   只写 localStorage 的 dataURL 是假上传（换浏览器就没了、无法列表管理、单张 4MB 写爆存储），
//   所以这里落盘到 data/backgrounds/（运行时数据目录，与 data/export/ 同类，不入库）。
//
// 五个接口（路由在 serve.mjs 里挂，这里只做数据与校验）：
//   GET  /api/backgrounds              列表
//   POST /api/backgrounds              上传（原始二进制 + x-filename 头）
//   POST /api/backgrounds/rename       重命名（只改显示名，id/file 不变）
//   POST /api/backgrounds/delete       删除（文件进 .trash/，索引同步移除）
//   GET  /api/backgrounds/file/<id>    出图（id 只查索引，绝不拼路径）
//
// 三条硬约束（本机无 GPU、内存小，且 URL 里的 id 是用户可控输入）：
//   1. 上传边读边计数，超限立刻中断——不允许"先全读进内存再判断"
//   2. 出图只认索引里的 id，索引没有就 404；文件路径永远由索引里的 file 字段拼出并校验前缀
//   3. index.json 走 .tmp + rename 原子写，且用串行队列避免并发写互相覆盖

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 单张背景图上限：5MB（够一张 4K 静图；再大让用户自己压，避免软渲染下贴图上传/解码过慢） */
export const MAX_BG_BYTES = 5 * 1024 * 1024;

/** 允许的图片类型 → 落盘扩展名。刻意不收 gif：动画背景会持续重绘，与"暂停不空转"目标冲突 */
const ALLOWED_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** 显示名上限（超出截断，不报错——用户改个名不该被卡住） */
const MAX_NAME_LEN = 60;

/** 索引文件名与回收目录名 */
const INDEX_FILE = 'index.json';
const TRASH_DIR = '.trash';

// ------------------------------------------------------------------ 纯工具

/**
 * 净化显示名：去掉控制字符与首尾空白，压缩连续空白，截断到上限。
 * 只影响"展示"，永远不参与文件路径（落盘名由服务端生成）。
 * @param {unknown} raw 原始输入
 * @returns {string} 净化后的名字（可能为空串，由调用方兜底）
 */
function sanitizeName(raw) {
  const s = String(raw == null ? '' : raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > MAX_NAME_LEN ? s.slice(0, MAX_NAME_LEN) : s;
}

/**
 * 还原请求头里的非 ASCII 文本（中文文件名）。
 *
 * 为什么需要两步：HTTP 头按规范是 latin-1，浏览器若不百分号编码就会把 UTF-8 字节
 *   直接塞进去，Node 读出来是乱码（"我的背景" → "æçèæ¯"）；
 *   前端约定用 encodeURIComponent 传，所以先试百分号解码，失败再按 latin-1→utf-8 还原。
 * @param {unknown} raw 请求头原值
 * @returns {string} 可读文本
 */
function decodeHeaderText(raw) {
  const s = String(raw == null ? '' : raw);
  if (!s) return '';
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    try { return decodeURIComponent(s); } catch { /* 落到下面的字节还原 */ }
  }
  try {
    const restored = Buffer.from(s, 'latin1').toString('utf8');
    // 还原后若出现替换符说明本来就不是 UTF-8 字节（真 latin-1 名字），保持原样
    return restored.includes('\ufffd') ? s : restored;
  } catch {
    return s;
  }
}

/**
 * 从 x-filename 里取一个"基名"当显示名（仅展示用；绝不进落盘路径）。
 * @param {string|undefined} raw 请求头原值
 * @returns {string} 去掉扩展名与目录部分的基名
 */
function displayNameFromHeader(raw) {
  const text = decodeHeaderText(raw);
  const base = text.replace(/\\/g, '/').split('/').pop() || '';
  return sanitizeName(base.replace(/\.[A-Za-z0-9]{1,8}$/, ''));
}

/**
 * 按文件头判定真实图片类型（不信任 Content-Type 与扩展名）。
 * @param {Buffer} buf 文件开头若干字节
 * @returns {string|null} 命中的 MIME，未识别返回 null
 */
function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // WebP: "RIFF" .... "WEBP"
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * 统一失败响应（前端按 reason 给不同提示，不用笼统"上传失败"）。
 * @param {string} reason 机器可读原因
 * @param {string} message 人类可读说明
 * @param {number} [status] HTTP 状态码
 */
function fail(reason, message, status = 400) {
  return { ok: false, status, body: { ok: false, reason, error: message } };
}

// ------------------------------------------------------------------ 索引读写

/**
 * 索引存储：原子写 + 串行队列。
 * @param {{dir: string, indexFile: string, trashDir: string}} ctx 存储上下文
 */
function createIndexStore(ctx) {
  /** 串行队列：索引读写不并发，避免两次上传把 index.json 互相覆盖 */
  let chain = Promise.resolve();

  /** 确保目录存在（首次使用时创建） */
  function ensureDirs() {
    fs.mkdirSync(ctx.dir, { recursive: true });
    fs.mkdirSync(ctx.trashDir, { recursive: true });
  }

  /** 读索引（文件不存在/损坏都当空索引，不让坏文件把整个列表打挂） */
  function read() {
    try {
      const obj = JSON.parse(fs.readFileSync(ctx.indexFile, 'utf8'));
      const items = Array.isArray(obj && obj.items) ? obj.items : [];
      return items.filter((it) => it && typeof it.id === 'string' && typeof it.file === 'string');
    } catch {
      return [];
    }
  }

  /** 原子写索引：先写 .tmp 再 rename（rename 在单文件上是原子的，不会出现"写一半"） */
  function write(items) {
    ensureDirs();
    const text = JSON.stringify({ version: 1, items }, null, 2);
    const tmp = `${ctx.indexFile}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, ctx.indexFile);
  }

  /**
   * 把一次修改排进串行队列。
   * @template T
   * @param {() => T} fn 要执行的操作
   * @returns {Promise<T>} 操作结果
   */
  function enqueue(fn) {
    const next = chain.then(fn, fn);
    // 队列自身不能被失败拖死：吞掉拒绝，只把结果交给调用方
    chain = next.then(() => undefined, () => undefined);
    return next;
  }

  return { ensureDirs, read, write, enqueue };
}

/** 索引项 → 对外视图（带上可直接用于 <img>/background 的 url） */
function toItemView(it) {
  return {
    id: it.id,
    name: it.name,
    url: `/api/backgrounds/file/${it.id}`,
    bytes: Number(it.bytes) || 0,
    mime: it.mime || '',
    addedAt: it.addedAt || '',
  };
}

/**
 * 把索引项解析成绝对路径，并校验它确实落在 backgrounds 目录内。
 * 双保险：file 字段由服务端生成（不含用户输入），这里再做一次前缀校验，
 *   防止索引文件被外部改坏后变成路径穿越。
 * @param {{dir: string}} ctx 存储上下文
 * @param {{file: string}} it 索引项
 * @returns {string|null} 绝对路径（越界或不存在返回 null）
 */
function resolveFile(ctx, it) {
  const base = path.resolve(ctx.dir);
  const abs = path.resolve(base, String(it.file || ''));
  if (abs !== base && !abs.startsWith(`${base}${path.sep}`)) return null;
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return abs;
}

// ------------------------------------------------------------------ 五个动作

/**
 * 列表：新加的排前面（用户刚上传的最想先看到）。
 * @param {object} store 索引存储
 */
function listItems(store) {
  const items = store.read().slice().reverse();
  return { ok: true, limit: MAX_BG_BYTES, types: Object.keys(ALLOWED_TYPES), items: items.map(toItemView) };
}

/**
 * 校验并落盘一次上传（此时内容已在内存里，且必定 ≤ 上限）。
 * @param {{store: object, ctx: object}} env 存储与上下文
 * @param {Buffer} buf 文件内容
 * @param {object} headers 请求头
 */
function saveUpload(env, buf, headers) {
  const mime = sniffImageType(buf);
  if (!mime || !ALLOWED_TYPES[mime]) {
    const declared = String(headers['content-type'] || '(未声明)');
    return fail('bad-type', `只接受 png / jpeg / webp 且文件内容要与类型相符（收到：${declared}）`, 415);
  }
  const ext = ALLOWED_TYPES[mime];
  const id = crypto.randomBytes(8).toString('hex');
  const file = `bg-${Date.now()}-${id}.${ext}`;
  const abs = path.join(env.ctx.dir, file);
  try {
    env.store.ensureDirs();
    fs.writeFileSync(abs, buf);
  } catch (e) {
    return fail('disk-error', `写入磁盘失败：${(e && e.message) || e}`, 500);
  }
  return env.store.enqueue(() => {
    const items = env.store.read();
    const name = displayNameFromHeader(headers['x-filename']) || `未命名 ${items.length + 1}`;
    const item = { id, name, file, mime, bytes: buf.length, addedAt: new Date().toISOString() };
    items.push(item);
    try {
      env.store.write(items);
    } catch (e) {
      // 索引写失败：把刚落盘的文件清掉，避免产生"看不见的孤儿文件"
      try { fs.unlinkSync(abs); } catch { /* 忽略 */ }
      return fail('disk-error', `索引写入失败：${(e && e.message) || e}`, 500);
    }
    return { ok: true, status: 201, body: { ok: true, item: toItemView(item) } };
  });
}

/**
 * 边读边计数地上传一张图：超限立即中止。
 * @param {{store: object, ctx: object}} env 存储与上下文
 * @param {import('node:http').IncomingMessage} req 原始请求
 * @returns {Promise<{ok:boolean, status:number, body:object, destroy?:boolean}>} 统一响应
 */
function readUpload(env, req) {
  // ① Content-Length 预检：声明就超限的，连读都不读（一个字节都不占内存）
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BG_BYTES) {
    const r = fail('too-large',
      `图片 ${(declared / 1048576).toFixed(2)}MB 超过上限 ${MAX_BG_BYTES / 1048576}MB，请先压缩`, 413);
    r.destroy = true;
    req.resume();          // 丢弃后续数据，避免占着连接不放
    return Promise.resolve(r);
  }
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    /**
     * 中止这次上传并给出原因。
     * 注意顺序：**先把响应交出去、再由路由层断开**——直接 destroy 会让客户端只看到
     *   "连接被重置"，拿不到 413 与具体原因（实测 curl 只收到 100 Continue）。
     */
    const abortWith = (reason, message, status) => {
      if (aborted) return;
      aborted = true;
      const r = fail(reason, message, status);
      r.destroy = true;
      resolve(r);
    };
    req.on('data', (chunk) => {
      if (aborted) return;
      total += chunk.length;
      // ② 流式累加：没有 Content-Length（chunked）时靠这里兜住上限
      if (total > MAX_BG_BYTES) {
        abortWith('too-large', `图片超过上限 ${MAX_BG_BYTES / 1048576}MB，请先压缩`, 413);
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => abortWith('aborted', '上传中断（连接已断开）', 400));
    req.on('end', () => {
      if (aborted) return;
      if (!total) { resolve(fail('empty', '没有收到文件内容', 400)); return; }
      resolve(saveUpload(env, Buffer.concat(chunks), req.headers));
    });
  });
}

/**
 * 重命名：只改显示名，id 与 file 保持不变（URL 因此永远稳定）。
 * 重名不拒绝而是自动加 `(2)`/`(3)` 后缀——用户想保留两份同名图是合理需求，
 *   但列表里出现两个一模一样的名字会分不清谁是谁。
 * @param {object} store 索引存储
 * @param {string} id 目标 id
 * @param {unknown} rawName 新显示名
 */
function renameItem(store, id, rawName) {
  const name = sanitizeName(rawName);
  if (!name) return Promise.resolve(fail('bad-name', '名称不能为空'));
  return store.enqueue(() => {
    const items = store.read();
    const hit = items.find((it) => it.id === id);
    if (!hit) return fail('not-found', `没有这条背景图：${id}`, 404);
    const taken = new Set(items.filter((it) => it.id !== id).map((it) => it.name));
    let final = name;
    let n = 2;
    while (taken.has(final)) { final = `${name} (${n})`; n += 1; }
    hit.name = final;
    try {
      store.write(items);
    } catch (e) {
      return fail('disk-error', `索引写入失败：${(e && e.message) || e}`, 500);
    }
    return { ok: true, status: 200, body: { ok: true, item: toItemView(hit), adjusted: final !== name } };
  });
}

/**
 * 删除：文件移进 .trash/（可恢复），索引同步移除（否则列表会出现点不开的幽灵项）。
 * @param {{store: object, ctx: object}} env 存储与上下文
 * @param {string} id 目标 id
 */
function removeItem(env, id) {
  return env.store.enqueue(() => {
    const items = env.store.read();
    const hit = items.find((it) => it.id === id);
    if (!hit) return fail('not-found', `没有这条背景图：${id}`, 404);
    const abs = resolveFile(env.ctx, hit);
    let trashed = false;
    if (abs) {
      try {
        env.store.ensureDirs();
        fs.renameSync(abs, path.join(env.ctx.trashDir, `${Date.now()}-${path.basename(abs)}`));
        trashed = true;
      } catch {
        // 移动失败不阻断索引移除：留在盘上的文件比"列表里删不掉"危害小
        trashed = false;
      }
    }
    const next = items.filter((it) => it.id !== id);
    try {
      env.store.write(next);
    } catch (e) {
      return fail('disk-error', `索引写入失败：${(e && e.message) || e}`, 500);
    }
    return { ok: true, status: 200, body: { ok: true, removed: id, trashed } };
  });
}

/**
 * 取一张图的落盘信息（出图接口用）：**只按索引查 id**，URL 里的字符串永不参与拼路径。
 * @param {{store: object, ctx: object}} env 存储与上下文
 * @param {string} id 索引 id
 * @returns {{abs: string, mime: string, name: string}|null} 命中返回路径与类型
 */
function findFile(env, id) {
  const hit = env.store.read().find((it) => it.id === id);
  if (!hit) return null;
  const abs = resolveFile(env.ctx, hit);
  if (!abs) return null;
  return { abs, mime: hit.mime || 'application/octet-stream', name: hit.name };
}

// ------------------------------------------------------------------ 对外句柄

/**
 * 建立背景图存储句柄（路由层只跟这个对象打交道）。
 * @param {{dataDir: string}} paths 项目路径集合（core/paths.mjs 产出）
 */
export function createBackgrounds(paths) {
  const ctx = {
    dir: path.join(paths.dataDir, 'backgrounds'),
    indexFile: path.join(paths.dataDir, 'backgrounds', INDEX_FILE),
    trashDir: path.join(paths.dataDir, 'backgrounds', TRASH_DIR),
  };
  const env = { ctx, store: createIndexStore(ctx) };
  return {
    dir: ctx.dir,
    list: () => listItems(env.store),
    uploadStream: (req) => readUpload(env, req),
    rename: (id, name) => renameItem(env.store, id, name),
    remove: (id) => removeItem(env, id),
    fileOf: (id) => findFile(env, id),
  };
}
