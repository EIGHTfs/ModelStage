// test/runtime-adapter.test.mjs —— 插件运行时适配器（node vm 沙盒 / exec 子进程 + 帧协议）
//
// 覆盖两层：
//   · node 适配器：真实插件能装载、能交出 canHandle/resolve；三个插件都显式声明了 runtime
//   · exec 适配器：清单校验 / 真 spawn 往返 / **超时必杀（进程真的没了）** / 崩溃传播 / 僵尸检查
//
// 设计取舍：exec 的进程级用例用**测试自带的最小 python 插件**（临时目录里现写），不依赖 UnityPy ——
//   ① 任何有 python 的机器都能跑（不因缺 UnityPy 整文件变红）
//   ② 能让插件"故意不响应 / 半路退出"，从而精确验证超时与崩溃路径（真插件做不到）
//   ③ 路径全部参数化（临时目录），不写死本机绝对路径
// 真 UnityPy 插件另有一条**可选**用例：依赖目录与解释器都可用、且 `import UnityPy` 成功才跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadWithRuntime, readExecPermission, EXEC_PERMISSION_FILE } from '../src/server/unpack/runtime/index.mjs';
import { MANIFEST_INVALID, SUPPORTED_FRAME_PROTOCOL, validateExecManifest } from '../src/server/unpack/runtime/exec.mjs';
import nodeVm from '../src/server/unpack/runtime/node-vm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');

/**
 * 探测可用的 python 解释器（**不写死路径**：不同机器装法不同）。
 * 找不到返回 null，进程级用例据此 skip —— 缺 python 不该让整文件红。
 */
function probePython() {
  const candidates = [
    process.env.MODELSTAGE_TEST_PYTHON,
    '/usr/local/bin/python3.14',
    '/usr/local/bin/python3.13',
    '/usr/local/bin/python3.12',
    '/usr/local/bin/python3.11',
    '/usr/local/bin/python3.10',
    '/usr/bin/python3',
    'python3',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-V'], { stdio: 'ignore', timeout: 5000 });
      return candidate;
    } catch { /* 换下一个 */ }
  }
  return null;
}

const PYTHON = probePython();

/** python 插件脚本模板：mode 决定"正常应答 / 不响应 / 半路退出" */
function workerSource(mode) {
  return `# -*- coding: utf-8 -*-
import json
import os
import sys
import time

# 先把 pid 落到文件：测试要据此断言"被 kill 之后进程真的没了"
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pid.txt'), 'w', encoding='utf-8') as f:
    f.write(str(os.getpid()))

MODE = ${JSON.stringify(mode)}

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    mid = msg.get('id')
    if MODE == 'hang':
        # 故意不响应：等父进程的超时把它杀掉（验证"超时必须真杀"）
        time.sleep(120)
        continue
    if MODE == 'crash':
        # 半路退出：验证在途请求全部判失败、不挂死
        sys.exit(3)
    if MODE == 'progress':
        # 进度帧专项：真档 + 未知档 + 同档同毫秒重复，最后才是响应
        for frame in (
            {"id": mid, "progress": {"phase": "read", "ms": 5}},
            {"id": mid, "progress": {"phase": "bogus", "ms": 6}},      # 未知档：应被忽略
            {"id": mid, "progress": {"phase": "read", "ms": 5}},       # 同档同毫秒：应被去重
            {"id": mid, "progress": {"phase": "resolve", "ms": 40}},
        ):
            sys.stdout.write(json.dumps(frame) + "\\n")
            sys.stdout.flush()
        sys.stdout.write(json.dumps({"id": mid, "ok": True, "handled": True}) + "\\n")
        sys.stdout.flush()
        continue
    sys.stdout.write(json.dumps({"id": mid, "ok": True, "handled": True}) + "\\n")
    sys.stdout.flush()
`;
}

/**
 * 在临时目录里造一个 exec 插件（pluginsDir/<id>/worker.py）。
 * @param {{mode?: string, timeoutMs?: number, manifest?: object}} opts
 */
function makeFakePlugin(opts = {}) {
  const mode = opts.mode || 'ok';
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-plugin-'));
  const pluginDir = path.join(pluginsDir, 'fake-exec');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'worker.py'), workerSource(mode), 'utf8');
  const meta = {
    id: 'fake-exec',
    runtime: 'exec',
    entry: 'worker.py',
    frameProtocol: SUPPORTED_FRAME_PROTOCOL,
    interpreter: PYTHON,
    requestTimeoutMs: opts.timeoutMs === undefined ? 20000 : opts.timeoutMs,
    files: [],
    ...(opts.manifest || {}),
  };
  return { pluginDir, pluginsDir, meta, pidFile: path.join(pluginDir, 'pid.txt') };
}

/** 读插件自己写的 pid（写文件有极小延迟，轮询一下） */
async function waitPid(pidFile, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(pidFile, 'utf8').trim();
      if (text) return Number(text);
    } catch { /* 还没写 */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/** 进程是否还活着（signal 0 只探测，不发信号） */
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const skipNoPython = PYTHON ? false : '本机没有可用的 python3（可用 MODELSTAGE_TEST_PYTHON 指定）';

// ─────────────────────────── node 适配器 ───────────────────────────

test('node 适配器：能装载真实插件并交出 canHandle/resolve', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, 'unity-spine-bundle', 'plugin.json'), 'utf8'));
  // plugin.json 的 files[] 是**相对插件目录**的（lib/errors.js）；
  //   registry 读清单时会补成 `unity-spine-bundle/lib/errors.js`，适配器按 pluginsDir 拼，
  //   所以这里要自己补那一段（否则会去 plugins/lib/… 找文件）。
  const r = loadWithRuntime(
    { id: 'unity-spine-bundle', runtime: 'node', files: manifest.files.map((f) => `unity-spine-bundle/${f}`) },
    { pluginsDir: PLUGINS_DIR, root: ROOT },
  );
  assert.equal(r.ok, true, `装载应成功：${r.error || ''}`);
  assert.equal(typeof r.api.canHandle, 'function');
  assert.equal(typeof r.api.resolve, 'function');
});

test('node 适配器：dispose 是空操作（进程内沙盒没有外部资源）', () => {
  assert.equal(typeof nodeVm.dispose, 'function');
  assert.doesNotThrow(() => nodeVm.dispose());
});

test('三个真实插件都显式声明了 runtime（显式优于缺省，避免"忘写就落到 node"）', () => {
  for (const id of ['unity-spine-bundle', 'unity-live2d-bundle', 'unitypy-bundle']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, id, 'plugin.json'), 'utf8'));
    assert.equal(typeof manifest.runtime, 'string', `${id} 应显式声明 runtime`);
  }
});

// ─────────────────────────── exec 清单校验 ───────────────────────────

test('exec 清单校验：合法清单通过', () => {
  assert.deepEqual(validateExecManifest({ entry: 'worker.py', frameProtocol: SUPPORTED_FRAME_PROTOCOL }), { ok: true });
});

test('exec 清单校验：缺 entry / 缺 frameProtocol / 协议版本不对 / entry 空串 都要拒', () => {
  const cases = [
    [{ frameProtocol: 1 }, '缺 entry'],
    [{ entry: 'worker.py' }, '缺 frameProtocol'],
    [{ entry: 'worker.py', frameProtocol: 99 }, '协议版本不支持'],
    [{ entry: '', frameProtocol: 1 }, 'entry 为空串'],
  ];
  for (const [manifest, why] of cases) {
    const r = validateExecManifest(manifest);
    assert.equal(r.ok, false, `${why} 应被拒`);
    assert.equal(r.code, MANIFEST_INVALID, `${why} 的错误码应是 ${MANIFEST_INVALID}`);
    assert.ok(r.error && r.error.length > 0, `${why} 必须给出可读原因`);
  }
});

test('exec 清单校验：entry 是绝对路径或含 .. 一律拒（不许把整机任意可执行文件变成入口）', () => {
  for (const bad of ['/bin/sh', '../evil.py', 'a/../../b.py']) {
    const r = validateExecManifest({ entry: bad, frameProtocol: 1 });
    assert.equal(r.ok, false, `${bad} 应被拒`);
    assert.equal(r.code, MANIFEST_INVALID);
  }
});

test('exec 适配器：入口文件不存在 ⇒ 装载期就报错（不等到 spawn 才炸）', () => {
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-missing-'));
  fs.mkdirSync(path.join(pluginsDir, 'ghost'), { recursive: true });
  const r = loadWithRuntime(
    { id: 'ghost', runtime: 'exec', entry: 'nope.py', frameProtocol: 1, interpreter: PYTHON || 'python3', files: [] },
    { pluginsDir, root: ROOT, execAllowed: { allowed: true, source: 'test' } },
  );
  assert.equal(r.ok, false);
  assert.match(String(r.error), /不存在|not exist/i);
  fs.rmSync(pluginsDir, { recursive: true, force: true });
});

// ─────────────────────────── exec 真 spawn ───────────────────────────

test('exec 真 spawn：子进程按帧协议应答，canHandle 返回正确布尔', { skip: skipNoPython }, async () => {
  const { pluginsDir, meta } = makeFakePlugin({ mode: 'ok' });
  const r = loadWithRuntime(meta, { pluginsDir, root: ROOT, execAllowed: { allowed: true, source: 'test' } });
  assert.equal(r.ok, true, `装载应成功：${r.error || ''}`);
  const handled = await r.api.canHandle({ rootId: 'r', rel: 'a/b.bundle', name: 'b.bundle', size: 1, absPath: '/dev/null' });
  assert.equal(handled, true, '插件回 handled:true，适配器应返回 true');
  r.api.dispose?.();
  fs.rmSync(pluginsDir, { recursive: true, force: true });
});

test('exec 真 spawn：**超时必须真杀**（不只是 reject，进程要真没了）', { skip: skipNoPython }, async () => {
  const { pluginsDir, meta, pidFile } = makeFakePlugin({ mode: 'hang', timeoutMs: 800 });
  const r = loadWithRuntime(meta, { pluginsDir, root: ROOT, execAllowed: { allowed: true, source: 'test' } });
  assert.equal(r.ok, true, `装载应成功：${r.error || ''}`);
  // exec 是**惰性 spawn**：进程在第一次请求时才起，所以要先发请求（不 await）再等 pid。
  //   如果先等 pid 会一直等不到（那时进程根本还没起）—— 这是本轮踩到的第一个坑。
  const pending = r.api.canHandle({ rootId: 'r', rel: 'a', name: 'a', size: 1, absPath: '/dev/null' });
  const pid = await waitPid(pidFile);
  assert.ok(pid, '插件应已写出自己的 pid');
  assert.equal(isAlive(pid), true, '超时前进程应活着');

  await assert.rejects(() => pending, /超时|timeout/i, '超时后应 reject（而不是永远挂着）');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isAlive(pid)) await new Promise((res) => setTimeout(res, 100));
  assert.equal(isAlive(pid), false, `超时后进程必须真的被终止（pid=${pid} 仍存活）`);
  fs.rmSync(pluginsDir, { recursive: true, force: true });
});

test('exec 进度帧：不终结请求 + 未知档忽略 + 同档同毫秒去重', { skip: skipNoPython }, async () => {
  const { pluginsDir, meta } = makeFakePlugin({ mode: 'progress' });
  const r = loadWithRuntime(meta, { pluginsDir, root: ROOT, execAllowed: { allowed: true, source: 'test' } });
  assert.equal(r.ok, true, `装载应成功：${r.error || ''}`);
  const seen = [];
  const handled = await r.api.canHandle({
    rootId: 'r', rel: 'a', name: 'a', size: 1, absPath: '/dev/null',
    onProgress: (p) => seen.push(p),
  });
  // ① 进度帧**不终结请求**：插件发完 4 条进度帧才发响应，请求必须仍拿到真正的结果
  assert.equal(handled, true, '进度帧不能把请求提前 settle 掉（否则这里会抛"缺 prefix/entry"或返回假值）');
  // ② 未知档被忽略（bogus 不该出现在回调里）
  assert.deepEqual(seen.map((x) => x.phase), ['read', 'resolve'], '只转发认识的档；未知档忽略');
  // ③ 同档同毫秒去重（两次 read@5 只剩一条）
  assert.equal(seen.filter((x) => x.phase === 'read').length, 1, '同档同毫秒只能转发一次');
  assert.equal(seen[0].ms, 5);
  assert.equal(seen[1].ms, 40);
  r.api.dispose?.();
  fs.rmSync(pluginsDir, { recursive: true, force: true });
});

test('exec 崩溃传播：子进程半路退出时，在途请求全部判失败（不许挂死）', { skip: skipNoPython }, async () => {
  const { pluginsDir, meta } = makeFakePlugin({ mode: 'crash', timeoutMs: 20000 });
  const r = loadWithRuntime(meta, { pluginsDir, root: ROOT, execAllowed: { allowed: true, source: 'test' } });
  assert.equal(r.ok, true, `装载应成功：${r.error || ''}`);
  // 两个并发请求：进程读到第一帧就 exit ⇒ 两个都应 reject，而不是等满 20s 超时
  const t0 = Date.now();
  const both = await Promise.allSettled([
    r.api.canHandle({ rootId: 'r', rel: 'a', name: 'a', size: 1, absPath: '/dev/null' }),
    r.api.canHandle({ rootId: 'r', rel: 'b', name: 'b', size: 1, absPath: '/dev/null' }),
  ]);
  const elapsed = Date.now() - t0;
  assert.equal(both[0].status, 'rejected', '第一个请求应失败（进程已退出）');
  assert.equal(both[1].status, 'rejected', '第二个在途请求也应失败（不能挂死）');
  assert.ok(elapsed < 15000, `应在进程退出时立即失败（实际 ${elapsed}ms，接近超时 20s 说明没传播）`);
  fs.rmSync(pluginsDir, { recursive: true, force: true });
});

test('僵尸检查：跑完多轮请求并 dispose 后，不残留子进程', { skip: skipNoPython }, async () => {
  const { pluginsDir, meta, pidFile } = makeFakePlugin({ mode: 'ok' });
  const r = loadWithRuntime(meta, { pluginsDir, root: ROOT, execAllowed: { allowed: true, source: 'test' } });
  assert.equal(r.ok, true);
  for (let i = 0; i < 3; i += 1) {
    await r.api.canHandle({ rootId: 'r', rel: `x${i}`, name: 'x', size: 1, absPath: '/dev/null' });
  }
  const pid = await waitPid(pidFile);
  assert.ok(pid);
  assert.equal(isAlive(pid), true, '请求期间进程应活着');
  r.api.dispose?.();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isAlive(pid)) await new Promise((res) => setTimeout(res, 100));
  assert.equal(isAlive(pid), false, `dispose 后不得残留进程（pid=${pid} 仍存活）`);
  fs.rmSync(pluginsDir, { recursive: true, force: true });
});

// ─────────────────────────── 真实 UnityPy 插件（可选） ───────────────────────────

test('真实插件 unitypy-bundle：依赖可 import 时能装载并应答 canHandle', async (t) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, 'unitypy-bundle', 'plugin.json'), 'utf8'));
  const depsDir = manifest.depsDir;
  const python = manifest.interpreter;
  if (!depsDir || !fs.existsSync(depsDir)) return t.skip(`依赖目录不存在：${depsDir || '(未声明)'}`);
  if (!python || !fs.existsSync(python)) return t.skip(`解释器不存在：${python || '(未声明)'}`);
  try {
    execFileSync(python, ['-c', 'import UnityPy'], {
      stdio: 'ignore', timeout: 30000, env: { ...process.env, PYTHONPATH: depsDir },
    });
  } catch {
    return t.skip('UnityPy 未能 import（依赖未装或版本不匹配）');
  }
  const r = loadWithRuntime(manifest, { pluginsDir: PLUGINS_DIR, root: ROOT, execAllowed: { allowed: true, source: 'test' } });
  assert.equal(r.ok, true, `装载应成功：${r.error || ''}`);
  // 用插件自己的 README 当"非 UnityFS 文件"：canHandle 只看 8 字节魔数，必须不被认领。
  //   不写死外部样本包路径（缺样本时这条仍然有验证价值）。
  const notBundle = path.join(PLUGINS_DIR, 'unitypy-bundle', 'README.md');
  assert.equal(
    await r.api.canHandle({ rootId: 'r', rel: 'README.md', name: 'README.md', size: 1, absPath: notBundle }),
    false,
    '非 UnityFS 文件必须不被认领（canHandle 只看魔数）',
  );
  r.api.dispose?.();
});

// ─────────────────────────── 安全门禁 ───────────────────────────

test('安全门禁：exec 默认关闭（无配置文件、无环境变量时 allowed=false）', () => {
  const prevEnv = process.env.MODELSTAGE_ALLOW_EXEC_PLUGINS;
  const prevRoot = process.env.MODELSTAGE_DATA_ROOT;
  delete process.env.MODELSTAGE_ALLOW_EXEC_PLUGINS;
  process.env.MODELSTAGE_DATA_ROOT = path.join(os.tmpdir(), 'no-such-data-root-xyz');
  try {
    assert.equal(readExecPermission(ROOT).allowed, false, '缺省必须关闭');
  } finally {
    if (prevEnv === undefined) delete process.env.MODELSTAGE_ALLOW_EXEC_PLUGINS;
    else process.env.MODELSTAGE_ALLOW_EXEC_PLUGINS = prevEnv;
    if (prevRoot === undefined) delete process.env.MODELSTAGE_DATA_ROOT;
    else process.env.MODELSTAGE_DATA_ROOT = prevRoot;
  }
});

test('安全门禁：未开启时装载被拒，原因里给出开启方式（不是静默跳过）', () => {
  const { pluginsDir, meta } = makeFakePlugin({ mode: 'ok' });
  const r = loadWithRuntime(meta, { pluginsDir, root: ROOT, execAllowed: { allowed: false, source: 'default' } });
  assert.equal(r.ok, false, '未开启 exec 时必须拒绝');
  assert.match(String(r.error), /allowExecRuntime|MODELSTAGE_ALLOW_EXEC_PLUGINS/, '错误信息要告诉用户怎么开');
  fs.rmSync(pluginsDir, { recursive: true, force: true });
});

test('安全门禁：权限文件固定在 <数据根>/config 下（测试实例与主实例互不影响）', () => {
  assert.equal(EXEC_PERMISSION_FILE, 'config/plugin-runtime.json');
});
