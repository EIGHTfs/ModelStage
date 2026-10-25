// http/background-solids.mjs —— 纯色背景预设的数据层（读/写/校验/自愈）
//
// 为什么校验放这里而不是路由层：
//   ① 前端会**原样显示**这些错误文案 ⇒ 文案与规则必须在同一处定义，不能两套；
//   ② 校验放数据层后，11 条测试可以全部直接打数据层，**不用起 HTTP、不抢端口**；
//   ③ 路由层保持"读 body → 转发 → 回包"的薄形态（与 http/backgrounds.mjs 的既有做法一致）。
//
// 落盘：`data/backgrounds/solids.json`（运行时数据；.gitignore 已忽略 /data/backgrounds/）。
//   原子写 + fsync + 串行队列全部来自 http/atomic-json.mjs。
//
// 并发约定：**单实例内串行一致；多实例共享同一 dataDir 不保证**（无文件锁）。
//   见 doc/契约/纯色预设API.md §四。

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../core/log.mjs';
import { backupFile, createSerialQueue, ensureDir, writeJsonAtomic } from './atomic-json.mjs';

const log = createLogger('solid-bg');

/** 数据文件名（在 data/backgrounds/ 下） */
const FILE_NAME = 'solids.json';

/** reset 前的存档前缀 */
const BAK_PREFIX = `solids.bak-`;

/** 损坏文件留证前缀 */
const CORRUPT_PREFIX = `solids.corrupt-`;

/** 备份保留份数（bak 与 corrupt 各自轮转，互不挤占） */
const KEEP_BACKUPS = 5;

/** 数量上限：防止被脚本刷爆数据文件 */
const MAX_ITEMS = 50;

/** 名称长度上限（按字符数算，中文一个字算一个） */
const MAX_NAME_LEN = 30;

/** 颜色格式：只接受 6 位十六进制；3 位缩写不接受（避免前端要处理两种形态） */
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * 默认 5 个（旧端原色；用户点名要恢复的是绿幕/蓝幕）。
 * id 用**确定性 slug**：reset 是幂等操作，产出变化的 id 反直觉；确定性 id 也让测试能直接断言。
 */
export const DEFAULT_SOLIDS = [
  { id: 'solid-default-carbon', name: '炭黑', color: '#1a1a1c' },
  { id: 'solid-default-warm-dark', name: '暖暗', color: '#2a2520' },
  { id: 'solid-default-bone-white', name: '骨白', color: '#d6d0c4' },
  { id: 'solid-default-green-screen', name: '绿幕', color: '#3d8f5c' },
  { id: 'solid-default-blue-screen', name: '蓝幕', color: '#2f6aa3' },
];

/** 错误文案（前端原样展示，不要写成 "invalid color" 这种给程序看的话） */
export const MESSAGES = {
  badColor: '颜色格式不对，应为 #RRGGBB 形式（如 #3d8f5c）',
  emptyName: '名称不能为空',
  longName: (n) => `名称太长（最多 ${MAX_NAME_LEN} 个字，当前 ${n} 个）`,
  dupName: (n) => `已经有同名颜色了（"${n}"），换个名字`,
  tooMany: `颜色数量已达上限（最多 ${MAX_ITEMS} 个），先删几个再加`,
  notFound: (id) => `找不到这个颜色（id=${id}），可能已被删除`,
  ioFail: '读取颜色数据失败，本次操作已取消（不会覆盖你的数据）',
};

/** 生成一个新 id（时间 + 随机后缀，够用且无依赖） */
function newId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `solid-${t}-${r}`;
}

/** 归一化颜色：统一小写输出 */
function normColor(c) {
  return String(c || '').trim().toLowerCase();
}

/** 归一化名称：去首尾空格（中文里 "炭黑" 与 "炭黑 " 才算重复） */
function normName(n) {
  return String(n == null ? '' : n).trim();
}

/** 校验颜色（返回 null 表示通过，否则返回错误文案） */
export function checkColor(color) {
  return COLOR_RE.test(String(color || '')) ? null : MESSAGES.badColor;
}

/** 校验名称（返回 null 表示通过，否则返回错误文案） */
export function checkName(name) {
  const n = normName(name);
  if (!n) return MESSAGES.emptyName;
  if ([...n].length > MAX_NAME_LEN) return MESSAGES.longName([...n].length);
  return null;
}

/** 名称是否已被占用（大小写敏感；excludeId 用于改名时排除自身） */
function nameTaken(items, name, excludeId) {
  return items.some((it) => it.id !== excludeId && it.name === name);
}

/** 单条记录的合法形态（缺字段/形态不对 ⇒ 丢弃该条） */
function sanitizeItem(it) {
  if (!it || typeof it !== 'object') return null;
  if (typeof it.id !== 'string' || !it.id) return null;
  if (typeof it.name !== 'string' || !normName(it.name)) return null;
  if (typeof it.color !== 'string' || !COLOR_RE.test(it.color)) return null;
  return {
    id: it.id,
    name: normName(it.name),
    color: normColor(it.color),
    createdAt: Number.isFinite(Number(it.createdAt)) ? Number(it.createdAt) : Date.now(),
  };
}

/** 造一份默认列表（每次初始化/reset 都重新盖 createdAt） */
function makeDefaults(at = Date.now()) {
  return DEFAULT_SOLIDS.map((d) => ({ id: d.id, name: d.name, color: d.color, createdAt: at }));
}

/** 组装内部上下文（目录、文件、串行队列） */
function makeCtx(paths) {
  const dir = path.join(paths.dataDir, 'backgrounds');
  return { dir, file: path.join(dir, FILE_NAME), enqueue: createSerialQueue() };
}

/** reset 存档：把当前文件复制成 solids.bak-<ts>.json（文件不存在返回 null） */
function backupCurrent(ctx, at) {
  if (!fs.existsSync(ctx.file)) return null;
  return backupFile(ctx.file, ctx.dir, BAK_PREFIX, at, KEEP_BACKUPS);
}

/** 原子写盘（tmp → fsync → rename） */
function saveItems(ctx, items) {
  ensureDir(ctx.dir);
  writeJsonAtomic(ctx.file, { version: 1, items });
}

/**
 * 读磁盘并返回条目。**"读失败"与"没有数据"必须分开**（契约 §7.1.1 写入凭证）：
 *   ENOENT ⇒ 首次初始化写默认；其它 IO 错误 ⇒ 返回 error，调用方绝不能拿默认值覆盖；
 *   内容坏了 ⇒ 先留证再重建。
 * @returns {{items:object[]}|{error:{status:number, body:object}}}
 */
function loadItems(ctx) {
  let raw = null;
  try {
    raw = fs.readFileSync(ctx.file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const items = makeDefaults();
      saveItems(ctx, items);
      log.info('初始化默认纯色预设', { file: ctx.file, count: items.length });
      return { items };
    }
    log.error('读取纯色预设失败（不覆盖原数据）', { file: ctx.file, code: e && e.code, error: String((e && e.message) || e) });
    return { error: { status: 500, body: { error: MESSAGES.ioFail } } };
  }

  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : null);
  if (!arr) {
    const bak = backupFile(ctx.file, ctx.dir, CORRUPT_PREFIX, Date.now(), KEEP_BACKUPS);
    const items = makeDefaults();
    saveItems(ctx, items);
    log.warn('纯色预设内容损坏，已备份并重建默认', { file: ctx.file, backup: bak, bytes: raw.length });
    return { items };
  }
  return { items: pickValid(arr, ctx.file) };
}

/** 过滤非法条目（只丢该条，其余保留） */
function pickValid(arr, file) {
  const items = [];
  let dropped = 0;
  for (const it of arr) {
    const ok = sanitizeItem(it);
    if (ok) items.push(ok);
    else dropped += 1;
  }
  if (dropped) log.warn('纯色预设里有非法条目，已丢弃', { file, dropped, kept: items.length });
  return items;
}

/** 串行队列内的"读 → 改 → 写"；fn 返回 {items, extra} 或 {error} */
function mutate(ctx, fn) {
  return ctx.enqueue(() => {
    const loaded = loadItems(ctx);
    if (loaded.error) return loaded.error;
    const out = fn(loaded.items);
    if (out.error) return out.error;
    saveItems(ctx, out.items);
    return { items: out.items, extra: out.extra };
  });
}

/** GET 列表 */
function apiList(ctx) {
  const loaded = loadItems(ctx);
  if (loaded.error) return loaded.error;
  return { status: 200, body: { items: loaded.items } };
}

/** 新增：校验 → 查重 → 追加 */
function apiAdd(ctx, input) {
  return mutate(ctx, (items) => {
    const name = normName(input.name);
    const nameErr = checkName(name);
    if (nameErr) return { error: { status: 400, body: { error: nameErr } } };
    const colorErr = checkColor(input.color);
    if (colorErr) return { error: { status: 400, body: { error: colorErr } } };
    if (items.length >= MAX_ITEMS) return { error: { status: 400, body: { error: MESSAGES.tooMany } } };
    if (nameTaken(items, name, null)) return { error: { status: 400, body: { error: MESSAGES.dupName(name) } } };
    const item = { id: newId(), name, color: normColor(input.color), createdAt: Date.now() };
    return { items: [...items, item], extra: { item } };
  }).then((r) => (r.items ? { status: 200, body: { item: r.extra.item } } : r));
}

/** 改名：id/color/createdAt 不变；同名查重（排除自身） */
function apiRename(ctx, input) {
  return mutate(ctx, (items) => {
    const id = String(input.id || '');
    const idx = items.findIndex((it) => it.id === id);
    if (idx < 0) return { error: { status: 404, body: { error: MESSAGES.notFound(id) } } };
    const name = normName(input.name);
    const nameErr = checkName(name);
    if (nameErr) return { error: { status: 400, body: { error: nameErr } } };
    if (nameTaken(items, name, id)) return { error: { status: 400, body: { error: MESSAGES.dupName(name) } } };
    const next = items.slice();
    next[idx] = { ...next[idx], name };
    return { items: next, extra: { item: next[idx] } };
  }).then((r) => (r.items ? { status: 200, body: { item: r.extra.item } } : r));
}

/** 删除 */
function apiRemove(ctx, input) {
  return mutate(ctx, (items) => {
    const id = String(input.id || '');
    if (!items.some((it) => it.id === id)) return { error: { status: 404, body: { error: MESSAGES.notFound(id) } } };
    return { items: items.filter((it) => it.id !== id), extra: { id } };
  }).then((r) => (r.items ? { status: 200, body: { removed: true, id: r.extra.id } } : r));
}

/** 重置：先备份当前，再重建默认 5 个 */
function apiReset(ctx) {
  return ctx.enqueue(() => {
    const at = Date.now();
    const bak = backupCurrent(ctx, at);   // 备份失败不阻断重置（最多丢一次历史，不丢当前数据）
    const items = makeDefaults(at);
    saveItems(ctx, items);
    log.info('纯色预设已重置为默认', { file: ctx.file, backup: bak, count: items.length });
    return { status: 200, body: { items } };
  });
}

/**
 * 建立纯色预设存储句柄（路由层只跟这个对象打交道）。
 * @param {{dataDir:string}} paths core/paths.mjs 产出的路径集合
 */
export function createBackgroundSolids(paths) {
  const ctx = makeCtx(paths);
  return {
    dir: ctx.dir,
    file: ctx.file,
    list: () => apiList(ctx),
    add: (input = {}) => apiAdd(ctx, input),
    rename: (input = {}) => apiRename(ctx, input),
    remove: (input = {}) => apiRemove(ctx, input),
    reset: () => apiReset(ctx),
  };
}
