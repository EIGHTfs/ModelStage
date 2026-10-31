// test/manifest-generator.test.mjs —— 清单的「生成者指纹」失效判据
//
// 锁的回归：**改解析代码后，落盘清单必须自动失效**。
//   以前只有 dirStamps（目录增删），改解析器不失效 ⇒ 现场：修好「atlas 首行 BOM 丢第一页」后
//   界面仍读旧清单（textureCount 还是 1），必须手工删 config/models/spine.<root>.json 才生效。
//
// 做法：清单里存 `generator`（解析器文件内容哈希前 8 位），读清单时先比它、再比 dirStamps。
// 本测试不改任何源码来造指纹变化 —— 直接构造/改写清单里的 generator 即可（那是同一件事，
//   且不会为了测试去污染工作区）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSpineModels } from '../src/server/data/spine.mjs';
import { getLive2DModels } from '../src/server/data/live2d.mjs';
import { generatorFingerprint } from '../src/server/data/manifest-stamp.mjs';

/** 造一个临时环境：假的 configFile + 一个空的资源根目录 */
function makeSandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfgen-'));
  const configFile = path.join(tmp, 'config', 'resources.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const rootDir = path.join(tmp, 'root');
  fs.mkdirSync(rootDir);
  return {
    tmp,
    configFile,
    rootDir,
    cfg: { id: 'r1', name: 'R1', path: rootDir },
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

test('generatorFingerprint：8 位十六进制且可重复', () => {
  const a = generatorFingerprint();
  const b = generatorFingerprint();
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(a, b, '同一份代码两次调用必须一致（否则每次请求都会重建）');
});

test('spine：清单 generator 与当前不一致 ⇒ 判为需重建，并写回当前指纹', () => {
  const s = makeSandbox();
  try {
    const manifestFile = path.join(s.tmp, 'config', 'models', 'spine.r1.json');
    // 先正常生成一份（拿到 dirStamps 的形状），再把 generator 改坏
    getSpineModels(s.configFile, s.cfg, false);
    const seeded = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    assert.equal(seeded.generator, generatorFingerprint(), '首次生成就该写入当前指纹');
    seeded.generator = 'deadbeef';
    fs.writeFileSync(manifestFile, JSON.stringify(seeded));

    const r = getSpineModels(s.configFile, s.cfg, false);
    assert.equal(r.cached, false, 'generator 不一致必须重建，不能命中旧清单');
    const after = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    assert.equal(after.generator, generatorFingerprint(), '重建后要写回当前指纹');
  } finally {
    s.cleanup();
  }
});

test('spine：generator 一致 ⇒ 命中缓存（cached:true）', () => {
  const s = makeSandbox();
  try {
    getSpineModels(s.configFile, s.cfg, false);          // 首次：生成
    const r = getSpineModels(s.configFile, s.cfg, false); // 第二次：应命中
    assert.equal(r.cached, true);
  } finally {
    s.cleanup();
  }
});

test('live2d：清单 generator 不一致 ⇒ 重建并写回当前指纹（两套口径一致）', () => {
  const s = makeSandbox();
  try {
    const manifestFile = path.join(s.tmp, 'config', 'models', 'live2d.r1.json');
    getLive2DModels(s.configFile, s.cfg, false);
    const seeded = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    assert.equal(seeded.generator, generatorFingerprint());
    seeded.generator = 'deadbeef';
    fs.writeFileSync(manifestFile, JSON.stringify(seeded));

    const r = getLive2DModels(s.configFile, s.cfg, false);
    assert.equal(r.cached, false, 'live2d 也必须按同一判据失效');
    const after = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    assert.equal(after.generator, generatorFingerprint());
  } finally {
    s.cleanup();
  }
});

test('live2d：generator 一致 ⇒ 命中缓存（cached:true）', () => {
  const s = makeSandbox();
  try {
    getLive2DModels(s.configFile, s.cfg, false);
    const r = getLive2DModels(s.configFile, s.cfg, false);
    assert.equal(r.cached, true);
  } finally {
    s.cleanup();
  }
});

test('老清单没有 generator 字段 ⇒ 视为不一致（升级后第一次请求自动重建）', () => {
  const s = makeSandbox();
  try {
    const manifestFile = path.join(s.tmp, 'config', 'models', 'spine.r1.json');
    getSpineModels(s.configFile, s.cfg, false);
    const seeded = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    delete seeded.generator;                       // 模拟升级前写下的老清单
    fs.writeFileSync(manifestFile, JSON.stringify(seeded));

    const r = getSpineModels(s.configFile, s.cfg, false);
    assert.equal(r.cached, false, '缺 generator 的老清单必须重建（否则升级后永远读旧数据）');
    assert.equal(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).generator, generatorFingerprint());
  } finally {
    s.cleanup();
  }
});
