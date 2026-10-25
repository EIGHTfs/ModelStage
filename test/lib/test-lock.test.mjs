// test/lib/test-lock.test.mjs —— 测试单实例锁的行为（并发互斥，任务 15）
//
// 用临时目录当 repoRoot，不碰真实 runtime/；每条断言都对应一个"必须为真否则互斥失效"的事实。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireTestLock, describeHolder, isAlive, EXIT_SKIPPED, HELD_ENV } from '../../tool/lib/test-lock.mjs';

const LOCK_MOD = new URL('../../tool/lib/test-lock.mjs', import.meta.url).pathname;

// ⚠ 本文件测的是"加锁行为"，必须**不受父进程继承影响**：
//   被 tool/test-all.mjs 拉起时环境里有 DSH_TEST_LOCK_HELD=1（父已持锁），
//   若不清掉，acquireTestLock 会直接返回 inherited，等于所有断言都测了个空气（实测踩过：6 条里 3 条假失败）。
//   继承行为本身由最后一条用例通过**子进程显式设置**该变量来验证。
const HELD_BACKUP = process.env[HELD_ENV];
delete process.env[HELD_ENV];
process.on('exit', () => {
  if (HELD_BACKUP === undefined) delete process.env[HELD_ENV];
  else process.env[HELD_ENV] = HELD_BACKUP;
});

// 测试用的固定样本值（命名常量，避免"魔法数字"散落在断言里）
const DEAD_PID = 999999;        // 基本不可能存在的 PID：模拟"持有者进程已死"的陈旧锁
const FOREIGN_PID = 123456;     // 伪造"别人的锁"时写的 PID（只要求与本进程不同）
const ELAPSED_SAMPLE_MS = 65000; // 伪造"65s 前开始"，用来断言描述里的"已运行 1m0Xs"

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
  return dir;
}

test('第一次获取成功，第二次被别人挡住并给出可读原因', () => {
  const root = tmpRoot();
  const a = acquireTestLock({ root, label: 'first', tool: 'node fake-a.mjs' });
  assert.equal(a.acquired, true, '第一次应当拿到锁');
  assert.ok(fs.existsSync(a.file), '锁文件应当存在');

  // 用本进程 pid 伪造"另一个活着的实例"（进程活着 ⇒ 必须挡住）
  const livePid = process.pid;
  fs.writeFileSync(a.file, JSON.stringify({ pid: livePid, startedAt: new Date().toISOString(), startedAtMs: Date.now() - ELAPSED_SAMPLE_MS, host: os.hostname(), label: 'other', tool: 'node other.mjs' }), 'utf8');

  const b = acquireTestLock({ root, label: 'second', tool: 'node fake-b.mjs' });
  assert.equal(b.acquired, false, '第二次必须被挡住');
  const txt = describeHolder(b.holder);
  assert.match(txt, /PID \d+/, '原因里要有 PID');
  assert.match(txt, /已运行 1m0[56]s/, '原因里要有已运行时长');
  assert.match(txt, /other\.mjs/, '原因里要能看出是谁在跑');
  a.release();
  fs.rmSync(root, { recursive: true, force: true });
});

test('释放后可以再次获取；释放别人的锁无效', () => {
  const root = tmpRoot();
  const a = acquireTestLock({ root, label: 'a' });
  assert.equal(a.acquired, true);
  // 把锁改成"别人的"再 release：不能删掉别人的锁
  fs.writeFileSync(a.file, JSON.stringify({ pid: FOREIGN_PID, startedAt: '', startedAtMs: 0, host: 'x', label: 'other' }), 'utf8');
  a.release();
  assert.ok(fs.existsSync(a.file), '别人的锁不该被删');
  // 恢复成自己的再释放
  fs.writeFileSync(a.file, JSON.stringify({ pid: process.pid, startedAt: '', startedAtMs: Date.now(), host: 'x', label: 'a' }), 'utf8');
  a.release();
  assert.equal(fs.existsSync(a.file), false, '自己的锁应当被删掉');
  const c = acquireTestLock({ root, label: 'c' });
  assert.equal(c.acquired, true, '释放后应能再次获取');
  c.release();
  fs.rmSync(root, { recursive: true, force: true });
});

test('陈旧锁（持有者进程已死）自动接管，不会把项目永久锁死', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  const file = path.join(root, 'runtime', 'test.lock');
  const deadPid = DEAD_PID;
  assert.equal(isAlive(deadPid), false, '测试前提：该 pid 不存活');
  fs.writeFileSync(file, JSON.stringify({ pid: deadPid, startedAt: '2020-01-01T00:00:00.000Z', startedAtMs: 1, host: 'x', label: 'crashed' }), 'utf8');

  const a = acquireTestLock({ root, label: 'after-crash' });
  assert.equal(a.acquired, true, '陈旧锁应被接管');
  assert.equal(a.tookOver, true, '应当标记为接管');
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cur.pid, process.pid, '锁内容应换成新持有者');
  a.release();
  fs.rmSync(root, { recursive: true, force: true });
});

test('锁文件损坏（非 JSON）按陈旧处理', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime', 'test.lock'), 'not-json{{{', 'utf8');
  const a = acquireTestLock({ root, label: 'after-corrupt' });
  assert.equal(a.acquired, true);
  a.release();
  fs.rmSync(root, { recursive: true, force: true });
});

test('子进程继承：父进程持锁时子进程不再加锁（test-all → check-console 不死锁）', () => {
  const root = tmpRoot();
  const parent = acquireTestLock({ root, label: 'parent' });
  assert.equal(parent.acquired, true);
  const code = `
    import('${LOCK_MOD}').then((m) => {
      const r = m.acquireTestLock({ root: ${JSON.stringify(root)}, label: 'child' });
      console.log(JSON.stringify({ acquired: r.acquired, inherited: !!r.inherited }));
    });
  `;
  const out = spawnSync(process.execPath, ['-e', code], {
    env: { ...process.env, [HELD_ENV]: '1' }, encoding: 'utf8',
  });
  const line = (out.stdout || '').trim().split('\n').pop();
  const r = JSON.parse(line);
  assert.equal(r.acquired, true, '子进程应当直接可用');
  assert.equal(r.inherited, true, '子进程应当是继承而非新加锁');
  parent.release();
  fs.rmSync(root, { recursive: true, force: true });
});

test('跳过退出码是 75（与 0 通过 / 1 失败区分）', () => {
  assert.equal(EXIT_SKIPPED, 75);
});
