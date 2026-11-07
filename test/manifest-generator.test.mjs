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
import { readManifest } from '../src/server/data/manifest-jsonl.mjs';
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


/**
 * 把一份清单"降级"成旧格式 .json（模拟升级前写下的老清单）：
 *   删掉 .jsonl 让读侧回落到 .json，再按需篡改字段。
 * 为什么必须删 .jsonl：读侧优先读 .jsonl，留着它的话写多少 .json 都不会被读到 ——
 *   那样这条用例就变成"永远绿"的假测试了。
 */
function degradeToLegacyJson(base, mutate) {
  const jsonl = `${base}.jsonl`;
  if (fs.existsSync(jsonl)) fs.unlinkSync(jsonl);
  const m = readManifest(base);          // 已删 jsonl ⇒ 会读 .json（若存在）
  const payload = {
    rootId: m.meta ? m.meta.rootId : null,
    ts: m.meta ? m.meta.ts : Date.now(),
    count: m.models.length,
    dirStamps: m.meta ? m.meta.dirStamps : null,
    generator: m.meta ? m.meta.generator : null,
    models: m.models,
  };
  if (mutate) mutate(payload);
  fs.writeFileSync(`${base}.json`, JSON.stringify(payload), 'utf8');
  return payload;
}

test('generatorFingerprint：8 位十六进制且可重复', async () => {
  const a = generatorFingerprint();
  const b = generatorFingerprint();
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(a, b, '同一份代码两次调用必须一致（否则每次请求都会重建）');
});

test('spine：清单 generator 与当前不一致 ⇒ 判为需重建，并写回当前指纹', async () => {
  const s = makeSandbox();
  try {
    const manifestBase = path.join(s.tmp, 'config', 'models', 'spine.r1');
    // 先正常生成一份（拿到 dirStamps 的形状），再降级成"generator 被改坏的老清单"
    await getSpineModels(s.configFile, s.cfg, false);
    const seeded = readManifest(manifestBase);
    assert.equal(seeded.meta.generator, generatorFingerprint(), '首次生成就该写入当前指纹');
    degradeToLegacyJson(manifestBase, (p) => { p.generator = 'deadbeef'; });

    const r = await getSpineModels(s.configFile, s.cfg, false);
    assert.equal(r.cached, false, 'generator 不一致必须重建，不能命中旧清单');
    assert.equal(readManifest(manifestBase).meta.generator, generatorFingerprint(), '重建后要写回当前指纹');
  } finally {
    s.cleanup();
  }
});

test('spine：generator 一致 ⇒ 命中缓存（cached:true）', async () => {
  const s = makeSandbox();
  try {
    await getSpineModels(s.configFile, s.cfg, false);          // 首次：生成
    const r = await getSpineModels(s.configFile, s.cfg, false); // 第二次：应命中
    assert.equal(r.cached, true);
  } finally {
    s.cleanup();
  }
});

test('live2d：清单 generator 不一致 ⇒ 重建并写回当前指纹（两套口径一致）', async () => {
  const s = makeSandbox();
  try {
    const manifestBase = path.join(s.tmp, 'config', 'models', 'live2d.r1');
    await getLive2DModels(s.configFile, s.cfg, false);
    const seeded = readManifest(manifestBase);
    assert.equal(seeded.meta.generator, generatorFingerprint(), '首次生成就该写入当前指纹');
    // 降级成"generator 被改坏的老清单"（与 spine 那条同口径）
    degradeToLegacyJson(manifestBase, (p) => { p.generator = 'deadbeef'; });

    const r = await getLive2DModels(s.configFile, s.cfg, false);
    assert.equal(r.cached, false, 'live2d 也必须按同一判据失效');
    const after = readManifest(manifestBase);
    assert.equal(after.meta.generator, generatorFingerprint());
  } finally {
    s.cleanup();
  }
});

test('live2d：generator 一致 ⇒ 命中缓存（cached:true）', async () => {
  const s = makeSandbox();
  try {
    await getLive2DModels(s.configFile, s.cfg, false);
    const r = await getLive2DModels(s.configFile, s.cfg, false);
    assert.equal(r.cached, true);
  } finally {
    s.cleanup();
  }
});

test('老清单没有 generator 字段 ⇒ 视为不一致（升级后第一次请求自动重建）', async () => {
  const s = makeSandbox();
  try {
    const manifestBase = path.join(s.tmp, 'config', 'models', 'spine.r1');
    await getSpineModels(s.configFile, s.cfg, false);
    // 模拟升级前写下的老清单：没有 generator 字段（顺带验证"仅 .json 也能读"）
    degradeToLegacyJson(manifestBase, (p) => { delete p.generator; });

    const r = await getSpineModels(s.configFile, s.cfg, false);
    assert.equal(r.cached, false, '缺 generator 的老清单必须重建（否则升级后永远读旧数据）');
    assert.equal(readManifest(manifestBase).meta.generator, generatorFingerprint());
  } finally {
    s.cleanup();
  }
});
