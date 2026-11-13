// test/bundle-analyzer-registry.test.mjs —— 分析能力按 provides 分派（契约 插件.md §1.1 / §1.2）
//
// 这些用例钉住三件事：
//   ① 核心不从代码里认插件名 —— 提供者由 plugin.json 的 provides 决定
//   ② 一个提供者都没有时**降级**（按文件头判定），不抛错、不静默
//   ③ 两个插件各带一份 bundle-probe.js，内容必须逐字节一致（否则两端结论会漂）
//
// 不写死任何插件 id：需要 id 的地方都从 findAnalyzerProvider() 的返回值或 plugin.json 取。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  findAnalyzerProvider,
  analyzeByMagicOnly,
  ANALYZER_ROLE,
  PROBE_PATHS,
} from '../tool/lib/bundle-probe-node.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');

/** UnityFS 头的假字节（只满足魔数判定，不需要是合法包） */
function unityFsHead() {
  return new Uint8Array(Buffer.from('UnityFS\0\0\0\0\0\0', 'latin1'));
}

test('分派：能找到声明 bundle-analyzer 的提供者，且它确实在清单里声明了该角色', () => {
  const provider = findAnalyzerProvider();
  assert.ok(provider, '项目里至少有一个插件应声明 bundle-analyzer（两个 unity bundle 插件都声明了）');
  assert.equal(typeof provider.pluginId, 'string');
  assert.ok(provider.libFiles.length > 0, '提供者的 lib 清单不应为空（从 plugin.json 的 files[] 派生）');

  // 反查清单确认角色声明（不信任"函数说它有"，去看清单里到底写了什么）
  const manifestPath = path.join(PLUGINS_DIR, provider.pluginId, 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(
    Array.isArray(manifest.provides) && manifest.provides.includes(ANALYZER_ROLE),
    `${provider.pluginId} 的 plugin.json 应声明 ${ANALYZER_ROLE}`,
  );
});

test('分派：两个 unity bundle 插件都声明了 bundle-analyzer（任一被单独装上都能分析）', () => {
  const declared = [];
  for (const name of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const manifestPath = path.join(PLUGINS_DIR, name.name, 'plugin.json');
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    if (Array.isArray(manifest.provides) && manifest.provides.includes(ANALYZER_ROLE)) {
      declared.push({ id: manifest.id || name.name, dir: name.name });
    }
  }
  assert.ok(declared.length >= 2, `应至少有两个提供者（实际 ${declared.length}）：${declared.map((d) => d.id).join(' / ')}`);
  // 每个声明者都必须有 lib 目录且非空 —— 否则"声明了却执行不了"
  for (const d of declared) {
    const libDir = path.join(PLUGINS_DIR, d.dir, 'lib');
    assert.ok(fs.existsSync(libDir), `${d.id} 声明了 ${ANALYZER_ROLE} 但没有 lib 目录`);
  }
});

test('分派：插件目录为空时返回 null（没有任何提供者）', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-empty-'));
  try {
    assert.equal(findAnalyzerProvider(emptyDir), null);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('分派：插件目录不存在时返回 null，不抛错', () => {
  const missing = path.join(os.tmpdir(), `analyzer-missing-${process.pid}-${Date.now()}`);
  assert.equal(findAnalyzerProvider(missing), null);
});

test('分派：`.` 开头的目录不是插件 —— 回收站里的历史副本不得参与分派', () => {
  // 判据与 src/server/plugins/registry.mjs 一致。回收站（.trash）与 .bak-* 里常有完整插件副本，
  //   若参与分派，分析结论可能来自已被删除的旧版本。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-dotdir-'));
  try {
    // 造一个"合法"的提供者，但放在 . 开头的目录里
    const hidden = path.join(dir, '.trash-20260101-000000-demo');
    fs.mkdirSync(path.join(hidden, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(hidden, 'plugin.json'), JSON.stringify({
      id: 'hidden-provider', provides: [ANALYZER_ROLE], files: ['lib/bundle-probe.js'],
    }), 'utf8');
    fs.writeFileSync(path.join(hidden, 'lib', 'bundle-probe.js'), '// 占位', 'utf8');
    assert.equal(findAnalyzerProvider(dir), null, '`.` 开头的目录必须被跳过');

    // 同名目录去掉点前缀后应当能被找到（证明上面失败的原因是"点前缀"，不是"找不到清单"）
    const visible = path.join(dir, 'visible-provider');
    fs.renameSync(hidden, visible);
    const found = findAnalyzerProvider(dir);
    assert.ok(found, '非点开头的同名目录应能被找到');
    assert.equal(found.pluginId, 'hidden-provider');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('降级：无提供者时按文件头判定 UnityFS，并给出装机提示（不抛错）', () => {
  const r = analyzeByMagicOnly(unityFsHead());
  assert.equal(r.ok, false, '降级结论的 ok 必须是 false（没做真正的解析）');
  assert.equal(r.code, 'ULB_ERR_NO_ANALYZER');
  assert.equal(r.magic, 'UnityFS');
  assert.equal(r.container, null);
  assert.equal(r.objects, null);
  assert.ok(Array.isArray(r.warnings) && r.warnings.length >= 2, '要有"是什么 + 装哪个插件"两句提示');
  assert.ok(
    r.warnings.some((w) => w.includes(ANALYZER_ROLE)),
    `提示里应出现角色名 ${ANALYZER_ROLE}（告诉调用方该装什么能力的插件）`,
  );
});

test('降级：认不出的字节给 unknown，但依然不抛错', () => {
  const r = analyzeByMagicOnly(new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]));
  assert.equal(r.magic, 'unknown');
  assert.equal(r.code, 'ULB_ERR_NO_ANALYZER');
});

test('降级：ZIP / JSON / MOC3 / CAB- 的头都能认出来', () => {
  assert.equal(analyzeByMagicOnly(new Uint8Array([0x50, 0x4b, 0x03, 0x04])).magic, 'ZIP');
  assert.equal(analyzeByMagicOnly(new Uint8Array([0x7b, 0x7d])).magic, 'JSON');
  assert.equal(analyzeByMagicOnly(new Uint8Array(Buffer.from('MOC3xxxx', 'latin1'))).magic, 'MOC3');
  assert.equal(analyzeByMagicOnly(new Uint8Array(Buffer.from('CAB-xxxx', 'latin1'))).magic, 'CAB-');
});

test('parity：两个插件的 bundle-probe.js 必须逐字节相同（否则两端结论会漂）', () => {
  const declared = [];
  for (const name of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const manifestPath = path.join(PLUGINS_DIR, name.name, 'plugin.json');
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    const provides = Array.isArray(manifest.provides) ? manifest.provides : [];
    if (!provides.includes(ANALYZER_ROLE)) continue;
    const probeFile = path.join(PLUGINS_DIR, name.name, 'lib', 'bundle-probe.js');
    if (fs.existsSync(probeFile)) declared.push({ id: manifest.id || name.name, file: probeFile });
  }
  assert.ok(declared.length >= 2, '至少两个提供者应各自带一份 bundle-probe.js');
  const hashes = declared.map((d) => ({
    id: d.id,
    sha: crypto.createHash('sha256').update(fs.readFileSync(d.file)).digest('hex'),
  }));
  const uniq = new Set(hashes.map((h) => h.sha));
  assert.equal(
    uniq.size,
    1,
    `各份 bundle-probe.js 内容不一致：${hashes.map((h) => `${h.id}=${h.sha.slice(0, 12)}`).join(' / ')}`,
  );
});

test('契约面：PROBE_PATHS 暴露 findAnalyzerProvider（不再暴露插件 id 常量）', () => {
  assert.equal(typeof PROBE_PATHS.findAnalyzerProvider, 'function');
  assert.equal(typeof PROBE_PATHS.libDirFor, 'function');
  assert.equal(typeof PROBE_PATHS.libOrderFor, 'function');
  // 反证：旧实现导出过 PROBE_PLUGIN_ID 这类"写死插件名"的常量，现在不该再有
  assert.equal(PROBE_PATHS.PROBE_PLUGIN_ID, undefined);
});
