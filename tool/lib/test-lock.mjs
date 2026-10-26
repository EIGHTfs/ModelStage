// tool/lib/test-lock.mjs —— 测试运行的「单实例锁」（同一项目同时只允许一个测试实例）
//
// 为什么需要：两个人（或两个 AI 会话）同时跑 e2e 会互相踩——端口/共享浏览器/DPR/像素采样都会串味，
//   结果是"我这边红你那边绿"扯不清。互斥之后，第二个实例**明确跳过并说清谁在跑**，
//   而不是继续跑出假红（假红比不跑更贵：会误导修错地方）。
//
// 约定：
//   · 锁文件 <repoRoot>/runtime/test.lock，内容 JSON：{ pid, startedAt, startedAtMs, host, label, tool }
//   · 第二次获取失败 → 退出码 75（EX_TEMPFAIL，区别于 0 通过 / 1 失败），并打印持有者与已运行时长
//   · 陈旧锁自动接管：持有者 PID 已不存在 ⇒ 直接接管（崩溃/被 kill 不该永久锁死项目）
//   · 子进程继承：调用方设置 DSH_TEST_LOCK_HELD=1，子工具（如 check-console）不再重复加锁
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** "跳过"专用退出码（BSD EX_TEMPFAIL）：与 0 通过 / 1 失败明确区分 */
export const EXIT_SKIPPED = 75;

/** 子进程继承用的环境变量名 */
export const HELD_ENV = 'DSH_TEST_LOCK_HELD';

/**
 * PID 是否还活着。
 * @param {number} pid
 * @returns {boolean}
 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // 只探测，不发信号
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // 存在但无权限 ⇒ 视为活着
  }
}

/**
 * 进程的真实启动时刻（Linux /proc）。
 * 用来识别 **PID 复用**：操作系统回收 PID 后会把它分配给新进程，此时 `kill(pid,0)` 依然成功，
 * 光看 isAlive 会以为锁还被持有 ⇒ 项目被永久锁死。判据：进程启动时刻**晚于**锁创建时刻 ⇒
 * 它不可能是锁的持有者。
 * @returns {number|null} epoch 毫秒；非 Linux 或读取失败返回 null（退回旧行为）
 */
export function procStartMs(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm 字段可能含空格与括号（形如 (chrome-headless)，也可能含右括号）⇒ 取最后一个 ')' 之后
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTicks = Number(rest[19]); // 第 22 个字段 starttime（pid/comm/state 之后从 0 数）
    const btime = Number((fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)$/m) || [])[1]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) return null;
    const CLK_TCK = 100; // 常见值；仅用于量级比较，不做精确计时
    return btime * 1000 + (startTicks * 1000) / CLK_TCK;
  } catch {
    return null;
  }
}

/**
 * 把锁内容渲染成一句人话（谁在跑 / PID / 开始时间 / 已运行多久）。
 * @param {object} holder
 * @returns {string}
 */
export function describeHolder(holder) {
  if (!holder) return '(未知持有者)';
  const startedMs = Number(holder.startedAtMs) || 0;
  const elapsed = startedMs ? Math.max(0, Math.round((Date.now() - startedMs) / 1000)) : null;
  const dur = elapsed === null ? '时长未知'
    : (elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${String(elapsed % 60).padStart(2, '0')}s`);
  return `PID ${holder.pid} · 开始 ${holder.startedAt || '?'} · 已运行 ${dur} · ${holder.label || '?'} · ${holder.tool || '?'}`;
}

/** 读锁文件；不存在或损坏返回 null */
function readLock(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/** 原子创建：openSync('wx') 成功才算拿到锁（避免两个进程同时判"没有锁"再互相覆盖） */
function createExclusive(file, body) {
  try {
    const fd = fs.openSync(file, 'wx', 0o644);
    fs.writeSync(fd, JSON.stringify(body, null, 2));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    throw e;
  }
}

/**
 * 获取测试单实例锁。
 * @param {{root: string, label?: string, tool?: string}} opts
 * @returns {{acquired: boolean, holder?: object, file: string, tookOver?: boolean, release: Function}}
 */
export function acquireTestLock(opts) {
  const root = opts.root;
  const dir = path.join(root, 'runtime');
  const file = path.join(dir, 'test.lock');
  const body = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    host: os.hostname(),
    label: opts.label || 'test',
    tool: opts.tool || process.argv.slice(1).join(' '),
  };
  const noop = { acquired: true, file, release: () => {} };

  // 子进程：父进程已持锁 ⇒ 不再加锁（否则 test-all → check-console 会自己把自己锁死）
  if (process.env[HELD_ENV] === '1') return { ...noop, inherited: true };

  fs.mkdirSync(dir, { recursive: true });

  if (createExclusive(file, body)) {
    return { acquired: true, file, release: makeRelease(file) };
  }

  // 已被占用：判断持有者是否还活着
  const holder = readLock(file);
  let alive = holder && isAlive(Number(holder.pid));
  let pidReused = false;
  if (alive) {
    // PID 复用检测：进程启动晚于锁创建 ⇒ 抢锁的进程早已退出，这个 PID 是新进程
    const startMs = procStartMs(Number(holder.pid));
    const lockMs = Number(holder.startedAtMs) || 0;
    if (startMs && lockMs && startMs > lockMs + 2000) {
      alive = false;
      pidReused = true;
    }
  }
  if (alive) return { acquired: false, holder, file, release: () => {} };

  // 陈旧锁（进程已死/文件损坏）⇒ 接管；崩溃不该把项目永久锁死
  try {
    fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');
    return { acquired: true, file, tookOver: true, pidReused, holder, release: makeRelease(file) };
  } catch (e) {
    return { acquired: false, holder: holder || { pid: 0, label: `锁文件不可写：${e.message}` }, file, release: () => {} };
  }
}

/** 释放：只删自己的锁（别人的锁不能被误删） */
function makeRelease(file) {
  return () => {
    const cur = readLock(file);
    if (cur && Number(cur.pid) !== process.pid) return; // 已不是我的锁，不动
    try {
      fs.unlinkSync(file);
    } catch {
      /* 已删除 */
    }
  };
}

/** 注册进程退出/中断时的自动释放（含 SIGINT/SIGTERM：Ctrl-C 也要解锁） */
export function releaseOnExit(lock) {
  if (!lock || !lock.acquired) return;
  let done = false;
  const bye = () => {
    if (done) return;
    done = true;
    lock.release();
  };
  process.on('exit', bye);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      bye();
      process.exit(EXIT_SKIPPED);
    });
  }
}
