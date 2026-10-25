// http/atomic-json.mjs —— JSON 落盘的原子写法 + 串行队列 + 备份轮转
//
// ⚠️ 本项目还有另一处**非原子**的 JSON 写（`http/backgrounds.mjs` 的背景图索引；
//    以及 config 的写盘路径），尚未迁过来。**新增写盘一律用本模块**，
//    不要再手写 `writeFileSync` + `rename` —— 少一步 fsync 就可能出现
//    "rename 成功但内容还是空洞"（断电/崩溃时 rename 先落盘、数据块没落盘）。
//
// 为什么需要 fsync：rename 的原子性只保证"看到的是旧文件或新文件"，
//   不保证新文件的内容已经落盘。崩溃窗口里 rename 已生效而数据块仍在页缓存 ⇒ 得到 0 字节文件。
//   顺序必须是：写 tmp → fsync(tmp) → rename(tmp→target)。（目录项本身要不要 fsync，见下说明）
//
// 零依赖：只用 node:fs。

import fs from 'node:fs';
import path from 'node:path';

/** 新建文件的默认权限（其他可读；项目 check-perms 前置检查要求 go+r） */
const FILE_MODE = 0o644;

/** 新建目录的默认权限（其他可进出） */
const DIR_MODE = 0o755;

/**
 * 确保目录存在（首次使用时创建，权限 0755）。
 * @param {string} dir
 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

/**
 * 原子写 JSON：写临时文件 → fsync → rename 覆盖。
 *
 * 目录项本身不额外 fsync：目标场景是"进程崩溃/被 kill"，此时 rename 已由内核记录；
 *   只有"整机掉电"才需要连目录一起 fsync，而本项目是家用 NAS 上的预览器，
 *   不为此引入 `open(dir)` 平台差异（Windows 上目录 fsync 会直接失败）。
 *
 * @param {string} file 目标文件绝对路径
 * @param {any} value 要写入的 JS 值（JSON 序列化，2 空格缩进）
 * @returns {{bytes:number}} 写入字节数（便于调用方做"内容是否变化"的判断与日志）
 */
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', FILE_MODE);
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);          // ← 关键：数据落盘后再 rename
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  // rename 之后补一次 chmod：某些文件系统/umask 会让 openSync 的 mode 被削弱
  try { fs.chmodSync(file, FILE_MODE); } catch { /* 已存在且权限正确时可能失败，忽略 */ }
  return { bytes: Buffer.byteLength(text) };
}

/**
 * 串行队列：把"读-改-写"整段排进队列，避免两次并发修改互相覆盖。
 *
 * 为什么不是锁：单进程单事件循环下，队列已经足够（并且没有任何"进程崩了锁不释放"的风险）。
 *   跨进程/多实例共享同一目录**不保证**顺序 —— 见 doc/契约/纯色预设API.md 的说明。
 * @returns {(fn: () => any) => Promise<any>}
 */
export function createSerialQueue() {
  let chain = Promise.resolve();
  return function enqueue(fn) {
    const next = chain.then(fn, fn);
    // 队列自身不能被失败拖死：吞掉拒绝，只把结果（或异常）交给调用方
    chain = next.then(() => undefined, () => undefined);
    return next;
  };
}

/**
 * 备份轮转：同名前缀的备份文件只保留最近 keep 份，更早的删除。
 *
 * 为什么必须轮转：`reset` 与"损坏自愈"都会留备份，用户多点几次就会堆出几十个文件，
 *   而这些都是**运行数据**（不入库），堆着只会占空间、还会让 `ls` 失去可读性。
 *
 * @param {string} dir 备份所在目录
 * @param {string} prefix 文件名前缀（如 'solids.bak-'）
 * @param {number} keep 保留份数（默认 5）
 * @returns {{kept:string[], removed:string[]}}
 */
export function rotateBackups(dir, prefix, keep = 5) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { kept: [], removed: [] }; }
  // 文件名形如 solids.bak-1750000000000.json：按前缀筛，按名字倒序（时间戳是定长的 ⇒ 字典序=时间序）
  const hits = names.filter((n) => n.startsWith(prefix)).sort().reverse();
  const kept = hits.slice(0, keep);
  const removed = [];
  for (const n of hits.slice(keep)) {
    try { fs.rmSync(path.join(dir, n), { force: true }); removed.push(n); } catch { /* 删不掉不影响主流程 */ }
  }
  return { kept, removed };
}

/**
 * 备份一份文件（用于"损坏文件留证"与"reset 前存档"）。
 * @param {string} src 源文件
 * @param {string} dir 备份目录
 * @param {string} prefix 备份名前缀（含结尾的 '-'，如 'solids.corrupt-'）
 * @param {number} at epoch ms（同毫秒多次备份时自动加序号，避免互相覆盖）
 * @param {number} keep 轮转保留份数
 * @returns {string|null} 备份文件名（失败返回 null）
 */
export function backupFile(src, dir, prefix, at = Date.now(), keep = 5) {
  let name = `${prefix}${at}.json`;
  try {
    if (fs.existsSync(path.join(dir, name))) name = `${prefix}${at}-${process.pid}.json`;
    fs.copyFileSync(src, path.join(dir, name));
    rotateBackups(dir, prefix, keep);
    return name;
  } catch {
    return null;
  }
}
