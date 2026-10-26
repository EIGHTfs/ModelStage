// check-plugin.test.mjs —— `tool/check-plugin.mjs` 自己的回归测试
//
// 为什么给检查器写测试：检查器报"通过"时，没人会再去看它；一旦它悄悄失去检测能力
//   （比如 B4 的 async 判定写坏、或垫片与宿主形状漂移导致 register 收不到），
//   所有插件都会"看起来合法"。所以必须有用例证明它**能变红**。
//
// 跑法：node test/check-plugin.test.mjs
// 约定：夹具在系统临时目录里现造现删，不污染仓库；路径全部由本文件位置推导，不写死绝对路径。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tool', 'check-plugin.mjs');

/** 跑一次检查器，返回 { rc, out } */
function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
  return { rc: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** 造一个临时插件目录 */
function fixture(tmp, name, manifest, code) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.js'), code, 'utf8');
  return dir;
}

const results = [];
/** @param {string} name @param {boolean} ok @param {string} actual */
const rec = (name, ok, actual) => results.push({ name, ok: !!ok, actual });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-plugin-'));
try {
  // ---------------- 1. 仓库里的真实插件 ----------------
  // 示例插件 plugins/demo 已删除（它没声明 provides，按 PL1 不注册；示例价值由下面的真实插件覆盖），
  // 所以这里只校验仓库里实际存在的那一个。
  {
    const { rc, out } = run([path.join(ROOT, 'plugins', 'unity-live2d-bundle')]);
    rec('unity-live2d-bundle 通过', rc === 0 && !/❌\s+[A-Z]\d/.test(out), `rc=${rc}`);
    rec('unity 的 canHandle 被判为同步返回布尔', out.includes('B4') && out.includes('同步返回 boolean'), '');
  }

  // ---------------- 2. 反例：必须变红 ----------------
  const mk = (name, manifest, code) => fixture(tmp, name, manifest, code);
  const okBody = (id, canHandle) => `(function () {
  window.SpineViewerPlugins.register({
    id: '${id}', name: 'x', fileKinds: ['bundle'],
    canHandle: ${canHandle},
    async resolve(file) { const e = new Error('bad'); e.code = 'X_ERR_BAD'; throw e; },
  });
})();`;

  {
    const dir = mk('missing-kind',
      { id: 'missing-kind', name: 'n', provides: ['asset-provider'], fileKinds: ['bundle'] },
      okBody('missing-kind', '(file) => true'));
    const { rc, out } = run([dir]);
    rec('缺 produces.kind → ❌ 且退出码非零', rc !== 0 && out.includes('❌ A5'), `rc=${rc}`);
  }
  {
    const dir = mk('nonboolean',
      { id: 'nonboolean', name: 'n', provides: ['asset-provider'], fileKinds: ['bundle'], produces: { kind: 'live2d' } },
      okBody('nonboolean', "(file) => 'yes'"));
    const { rc, out } = run([dir]);
    rec('canHandle 返回非布尔 → ❌ B4', rc !== 0 && out.includes('❌ B4'), `rc=${rc}`);
  }
  {
    // 本轮重点：async canHandle 返回 Promise 恒为真值，必须被抓出来
    const dir = mk('async-canhandle',
      { id: 'async-canhandle', name: 'n', provides: ['asset-provider'], fileKinds: ['bundle'], produces: { kind: 'live2d' } },
      `(function () {
  window.SpineViewerPlugins.register({
    id: 'async-canhandle', name: 'x', fileKinds: ['bundle'],
    async canHandle(file) { return true; },
    async resolve(file) { const e = new Error('bad'); e.code = 'X_ERR_BAD'; throw e; },
  });
})();`);
    const { rc, out } = run([dir]);
    rec('async canHandle → ❌ B4（Promise 恒真值）', rc !== 0 && out.includes('❌ B4') && out.includes('async'), `rc=${rc}`);
  }
  {
    const dir = mk('bundle-in-kind',
      { id: 'bundle-in-kind', name: 'n', provides: ['asset-provider'], fileKinds: ['bundle'], produces: { kind: 'bundle' } },
      okBody('bundle-in-kind', '(file) => true'));
    const { rc, out } = run([dir]);
    rec('produces.kind 用容器类型 bundle → ❌ A5', rc !== 0 && out.includes('❌ A5'), `rc=${rc}`);
  }
  {
    // 清单与目录名不一致
    const dir = mk('id-mismatch',
      { id: 'other-id', name: 'n', provides: ['asset-provider'], fileKinds: ['bundle'], produces: { kind: 'live2d' } },
      okBody('other-id', '(file) => true'));
    const { rc, out } = run([dir]);
    rec('id 与目录名不一致 → ❌ A3', rc !== 0 && out.includes('❌ A3'), `rc=${rc}`);
  }
  {
    // 严格口径：provides 字段缺失 = 未声明角色 ⇒ ❌（空数组 [] 才合法）
    const dir = mk('missing-provides',
      { id: 'missing-provides', name: 'n', fileKinds: [], files: ['index.js'] },
      "(function () { window.SpineViewerPlugins.register({ id: 'missing-provides', name: 'x', fileKinds: [] }); })();");
    const { rc, out } = run([dir]);
    rec('provides 字段缺失 → ❌ A2a', rc !== 0 && out.includes('❌ A2a'), `rc=${rc}`);
  }
  {
    // 同理：fileKinds 字段缺失 ⇒ ❌；空数组 ✅
    const dir = mk('missing-filekinds',
      { id: 'missing-filekinds', name: 'n', provides: [] },
      "(function () { window.SpineViewerPlugins.register({ id: 'missing-filekinds', name: 'x' }); })();");
    const { rc, out } = run([dir]);
    rec('fileKinds 字段缺失 → ❌ A6', rc !== 0 && out.includes('❌ A6'), `rc=${rc}`);
  }
  {
    // 空数组是合法声明：provides: [] + fileKinds: [] 的最小插件必须通过
    const dir = mk('empty-arrays-ok',
      { id: 'empty-arrays-ok', name: 'n', provides: [], fileKinds: [] },
      "(function () { window.SpineViewerPlugins.register({ id: 'empty-arrays-ok', name: 'x', fileKinds: [] }); })();");
    const { rc, out } = run([dir]);
    rec('provides/fileKinds 为空数组 → 通过（合法最小插件）', rc === 0 && !/❌\s+[A-Z]\d/.test(out), `rc=${rc}`);
  }
  {
    // 不注册（脚本什么都没做）→ ❌ B2
    const dir = mk('no-register',
      { id: 'no-register', name: 'n', provides: ['asset-provider'], fileKinds: ['bundle'], produces: { kind: 'live2d' } },
      '(function () { /* 故意不 register */ })();');
    const { rc, out } = run([dir]);
    rec('不调用 register() → ❌ B2', rc !== 0 && out.includes('❌ B2'), `rc=${rc}`);
  }
  {
    // 语法错误 → ❌ B1
    const dir = mk('syntax-error',
      { id: 'syntax-error', name: 'n', provides: ['asset-provider'], fileKinds: ['bundle'], produces: { kind: 'live2d' } },
      '(function () { this is not js });');
    const { rc, out } = run([dir]);
    rec('代码语法错误 → ❌ B1', rc !== 0 && out.includes('❌ B1'), `rc=${rc}`);
  }

  // ---------------- 3. --all 模式 ----------------
  {
    const { rc, out } = run(['--all', path.join(ROOT, 'plugins')]);
    rec('--all plugins 退出码 0（现有两个插件都合规）', rc === 0 && out.includes('总计'), `rc=${rc}`);
  }
  // ---------------- effects 样本（契约 §九）：门禁与运行期必须同口径 ----------------
  //
  // 样本在 test/fixtures/plugin-effects/（不在 plugins/，否则服务端天天扫到非法清单）。
  // 这里一次 --all 跑全部样本，正好覆盖「跨插件 id 重复」这种只能成对验的规则。
  {
    const FX = path.join(HERE, 'fixtures', 'plugin-effects');
    const { out } = run(['--all', FX, '--json', '--no-sample']);
    let parsed = null;
    try {
      parsed = JSON.parse(out.slice(out.indexOf('{')));
    } catch {
      parsed = null;
    }
    /** 取某样本的 A7 行（kind: ok / warn / fail） */
    const a7Of = (dirName) => {
      const r = (parsed && parsed.results || []).find((x) => path.basename(x.dir) === dirName);
      return r ? (r.rows || []).filter((x) => x.code === 'A7') : [];
    };
    // 期望表：目录 → 'ok'（A7 必须通过）或 'fail'（A7 必须报错）
    const EXPECT = [
      ['ok-basic', 'ok'],
      ['bad-no-id', 'fail'],
      ['bad-param-key', 'fail'],
      ['bad-default-range', 'fail'],
      ['bad-panel-no-effects', 'fail'],
      ['bad-no-register-call', 'fail'],
      ['bad-dup-a', 'ok'],       // 先占位，单看合法
      ['bad-dup-b', 'fail'],     // 与 bad-dup-a 撞 id ⇒ 必须报重复
    ];
    if (!parsed) {
      rec('effects 样本可被检查器解析（--json）', false, `输出无法解析：${out.slice(0, 120)}`);
    } else {
      for (const [dirName, want] of EXPECT) {
        const rows = a7Of(dirName);
        const gotFail = rows.some((x) => x.kind === 'fail');
        const gotOk = rows.some((x) => x.kind === 'ok');
        const pass = want === 'fail' ? gotFail : (gotOk && !gotFail);
        rec(`effects/${dirName} 期望 ${want}`, pass, rows.map((x) => `${x.kind}:${x.text}`).join(' | ').slice(0, 120));
      }
    }
  }

} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

// ---------------------------------------------------------------- 汇总
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.actual ? `   (${r.actual})` : ''}`);
console.log(`\n总计 ${results.length} 条：通过 ${results.length - failed.length}，失败 ${failed.length}`);
process.exit(failed.length ? 1 : 0);
