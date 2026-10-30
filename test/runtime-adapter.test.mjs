// test/runtime-adapter.test.mjs —— 插件运行时适配器（第 1 步：只定契约，exec 不实现）
//
// 锁四件事：
//   ① node 适配器契约：能装载真实插件，交出 canHandle/resolve；dispose 是空操作
//   ② exec 适配器：清单校验通过后仍明确抛 EXEC_RUNTIME_NOT_IMPLEMENTED（不静默、不假装）
//   ③ 安全门禁：runtime:"exec" 但用户没开启 ⇒ 装载被拒 + 可读原因（含怎么开）
//   ④ 缺省行为：插件不写 runtime 时按 node 处理（历史兼容，零行为变化）
//
// 本轮**不 spawn 任何子进程**：exec 侧只验"拒绝路径"，验完即可。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_RUNTIME, KNOWN_RUNTIMES, EXEC_PERMISSION_FILE,
  resolveRuntimeName, loadWithRuntime, readExecPermission, listRuntimes,
} from '../src/server/unpack/runtime/index.mjs';
import execRuntime, { NOT_IMPLEMENTED, SUPPORTED_FRAME_PROTOCOL, validateExecManifest } from '../src/server/unpack/runtime/exec.mjs';
import nodeVm from '../src/server/unpack/runtime/node-vm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const LIVE2D_DIR = 'unity-live2d-bundle';

/** 读真实插件的清单（用 registry 的生产口径，不自己解析 json） */
async function live2dMeta() {
  const { listProviderPlugins } = await import('../src/server/unpack/plugin-runner.mjs');
  return listProviderPlugins().find((m) => m.id === LIVE2D_DIR) || null;
}

// ---------------------------------------------------------------- ① node 适配器契约

test('node 适配器：能装载真实插件并交出 canHandle/resolve', async () => {
  const meta = await live2dMeta();
  if (!meta) return;                      // 插件不在就 skip，不假通过
  const r = nodeVm.load(meta, { pluginsDir: PLUGINS_DIR });
  assert.equal(r.ok, true, `装载应成功，实际错误：${r.error}`);
  assert.equal(typeof r.api.canHandle, 'function');
  assert.equal(typeof r.api.resolve, 'function');
  // explainReject 是可选扩展（上一条任务加的），有就应该也是函数
  if (r.api.explainReject !== undefined) assert.equal(typeof r.api.explainReject, 'function');
});

test('node 适配器：dispose 是空操作（进程内沙盒没有外部资源）', () => {
  assert.equal(typeof nodeVm.dispose, 'function');
  assert.doesNotThrow(() => nodeVm.dispose());
});

test('plugin.json 的两个真实插件都声明了 runtime:"node"（显式优于缺省）', async () => {
  const { listProviderPlugins } = await import('../src/server/unpack/plugin-runner.mjs');
  const list = listProviderPlugins();
  if (!list.length) return;
  // 内置提供者（builtin-spine / builtin-live2d）也声明 asset-provider 角色、与插件同表返回，
  //   但它们不是 node 插件、没有 runtime 字段（装载器跑在前端）。本用例只管真实插件，
  //   否则"每个提供者都必须有 runtime:node"会把内置项误判成违规。
  const disk = list.filter((m) => m.builtin !== true);
  for (const m of disk) {
    assert.equal(m.runtime, 'node', `${m.id} 应显式声明 runtime:"node"`);
    assert.equal(m.frameProtocol, null, `${m.id} 是 node 运行时，frameProtocol 应为 null`);
  }
  // 内置项必须能被识别（builtin:true），否则上面的过滤会静默漏掉它们；
  //   且它们不能声明成 node 运行时（装载器跑在前端，没有 node 入口）。
  for (const m of list.filter((x) => x.builtin === true)) {
    assert.notEqual(m.runtime, 'node', `${m.id} 是内置提供者，不应声明 node runtime`);
  }
});

// ---------------------------------------------------------------- ② exec 适配器：明确未实现

test('exec 适配器：清单合法时仍明确抛 NOT_IMPLEMENTED（不静默、不假装能跑）', () => {
  const meta = { id: 'demo-exec', runtime: 'exec', entry: 'bin/run.sh', frameProtocol: SUPPORTED_FRAME_PROTOCOL, files: [] };
  const r = execRuntime.load(meta, { pluginsDir: PLUGINS_DIR });
  assert.equal(r.ok, false, '本轮 exec 不应装载成功');
  assert.equal(r.code, NOT_IMPLEMENTED, `应返回 ${NOT_IMPLEMENTED}，实际 ${r.code}`);
  assert.match(r.error, /尚未实现/, '错误消息应说清"未实现"而不是"插件坏了"');
  assert.match(r.error, /清单校验已通过/, '应说明清单本身是合法的（区分两类问题）');
});

test('exec 清单校验：缺 entry / 绝对路径 / .. / 缺 frameProtocol / 版本不对 都要拒', () => {
  const base = { id: 'x', runtime: 'exec', entry: 'bin/run.sh', frameProtocol: SUPPORTED_FRAME_PROTOCOL };
  assert.equal(validateExecManifest(base).ok, true, '合法清单应通过');

  // 用"明显超出支持范围"的协议号构造非法值：不写死具体数字，避免与将来新增的协议版本冲突
  const unsupportedProtocol = SUPPORTED_FRAME_PROTOCOL + 1000;
  const cases = [
    [{ ...base, entry: '' }, /必须.*声明 entry/],
    // 绝对路径：用当前平台的根路径拼出来，不硬编码某个具体可执行文件
    [{ ...base, entry: path.resolve(path.sep, 'anywhere', 'outside.sh') }, /相对路径/],
    [{ ...base, entry: '../outside.sh' }, /相对路径/],
    [{ ...base, frameProtocol: undefined }, /frameProtocol/],
    [{ ...base, frameProtocol: unsupportedProtocol }, /不支持的 frameProtocol/],
  ];
  for (const [meta, pattern] of cases) {
    const v = validateExecManifest(meta);
    assert.equal(v.ok, false, `应拒：${JSON.stringify(meta)}`);
    assert.match(v.error, pattern);
  }
});

// ---------------------------------------------------------------- ③ 安全门禁

test('安全门禁：runtime:"exec" 但未开启 ⇒ 拒绝装载，原因里给出开启方式与风险', () => {
  const meta = { id: 'demo-exec', runtime: 'exec', entry: 'bin/run.sh', frameProtocol: 1, files: [] };
  const r = loadWithRuntime(meta, { pluginsDir: PLUGINS_DIR, root: ROOT, execAllowed: { allowed: false, source: 'default' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXEC_RUNTIME_DISABLED');
  assert.match(r.error, /未开启/, '应说明是门禁拦的');
  assert.match(r.error, /allowExecRuntime/, '应给出配置文件写法');
  assert.match(r.error, /MODELSTAGE_ALLOW_EXEC_PLUGINS/, '应给出环境变量写法');
  assert.match(r.error, /信任/, '应提示风险（只对信任的插件开启）');
});

test('安全门禁：显式开启后才走到适配器（仍报未实现，但不再是"门禁拒绝"）', () => {
  const meta = { id: 'demo-exec', runtime: 'exec', entry: 'bin/run.sh', frameProtocol: 1, files: [] };
  const r = loadWithRuntime(meta, { pluginsDir: PLUGINS_DIR, root: ROOT, execAllowed: { allowed: true, source: 'test' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, NOT_IMPLEMENTED, '开启后应是"未实现"而不是"被禁用"');
});

test('安全门禁默认值：没有配置文件、没有环境变量 ⇒ 关闭', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-gate-'));
  const saved = process.env.MODELSTAGE_ALLOW_EXEC_PLUGINS;
  delete process.env.MODELSTAGE_ALLOW_EXEC_PLUGINS;
  try {
    const g = readExecPermission(tmpRoot);
    assert.equal(g.allowed, false, '默认必须关闭');
    assert.equal(g.source, 'default');
  } finally {
    if (saved !== undefined) process.env.MODELSTAGE_ALLOW_EXEC_PLUGINS = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('安全门禁：配置文件写 true 才放行；写坏 JSON 按"未开启"处理（失败要保守）', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-gate2-'));
  const cfgPath = path.join(tmpRoot, EXEC_PERMISSION_FILE);
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  const saved = process.env.MODELSTAGE_ALLOW_EXEC_PLUGINS;
  delete process.env.MODELSTAGE_ALLOW_EXEC_PLUGINS;
  try {
    fs.writeFileSync(cfgPath, JSON.stringify({ allowExecRuntime: true }));
    assert.equal(readExecPermission(tmpRoot).allowed, true, '写 true 应放行');

    fs.writeFileSync(cfgPath, '{ 这不是 JSON');
    const bad = readExecPermission(tmpRoot);
    assert.equal(bad.allowed, false, '坏 JSON 必须按未开启处理（不能因为笔误把门打开）');
    assert.ok(bad.error, '应带上解析失败原因');
  } finally {
    if (saved !== undefined) process.env.MODELSTAGE_ALLOW_EXEC_PLUGINS = saved;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- ④ 缺省与非法值

test('缺省：插件不写 runtime ⇒ 按 node 处理（历史兼容，零行为变化）', () => {
  assert.equal(DEFAULT_RUNTIME, 'node');
  assert.deepEqual(resolveRuntimeName({ id: 'x' }), { ok: true, runtime: 'node' });
  assert.deepEqual(resolveRuntimeName({ id: 'x', runtime: null }), { ok: true, runtime: 'node' });
  assert.deepEqual(resolveRuntimeName({ id: 'x', runtime: '' }), { ok: true, runtime: 'node' });
});

test('非法 runtime 值 ⇒ 明确报错并列出可用值（不猜、不静默降级）', () => {
  const r = resolveRuntimeName({ id: 'x', runtime: 'python' });
  assert.equal(r.ok, false);
  assert.match(r.error, /未知 runtime/);
  assert.match(r.error, /python/, '错误里应带上用户写的值');
  assert.match(r.error, /node/, '应列出可用值');
});

test('已注册运行时清单（诊断用）：至少含 node 与 exec', () => {
  const names = listRuntimes().map((x) => x.runtime);
  assert.ok(names.includes('node'));
  assert.ok(names.includes('exec'));
  assert.deepEqual(KNOWN_RUNTIMES.sort(), ['exec', 'node']);
});
