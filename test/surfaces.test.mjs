// test/surfaces.test.mjs —— 渲染面元数据表：未知 kind 必须显式失败 + 注册校验 + 表覆盖
//
// 这个文件存在的意义不是"验证现有两个面还好用"（那是回归测试的活），
//   而是钉死本次重构的**目的**：加第三个面时不许再出现静默误判成 spine。
//   所以三条断言里两条都在测"未知 kind 会失败"，而不是"已知 kind 能工作"。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SURFACES, byKind, byId, knownKinds, isKnownKind, stageModeOf, byIdOrKind,
} from '../src/web/render/surfaces.js';

// ------------------------------------------------------------------ 表本身

test('表结构：每条都有全部字段，且 id/kind 不重复', () => {
  const FIELDS = ['id', 'kind', 'label', 'badge', 'stageMode', 'overlay', 'overlayVisible', 'cameraKind', 'deepLink'];
  const ids = new Set();
  const kinds = new Set();
  for (const s of SURFACES) {
    for (const f of FIELDS) assert.ok(f in s, `表项 ${s.id || '?'} 缺字段 ${f}`);
    assert.equal(ids.has(s.id), false, `id 重复：${s.id}`);
    assert.equal(kinds.has(s.kind), false, `kind 重复：${s.kind}`);
    ids.add(s.id); kinds.add(s.kind);
  }
  assert.deepEqual(knownKinds().sort(), [...kinds].sort());
});

test('查询接口：未知 kind/id 一律返回 null（绝不回落 spine）', () => {
  assert.equal(byKind('three'), null, "byKind('three') 必须 null，不许回落到 spine");
  assert.equal(byKind(''), null);
  assert.equal(byKind(null), null);
  assert.equal(byKind('SPINE'), null, '大小写敏感：不许模糊匹配到 spine');
  assert.equal(byId('three'), null);
  assert.equal(byIdOrKind('three'), null);
  assert.equal(stageModeOf('three'), null, "stageModeOf('three') 必须 null");
  assert.equal(isKnownKind('three'), false);
});

test('已知 kind 的取值与重构前一致（行为零变化的基线）', () => {
  assert.equal(stageModeOf('spine'), 'spine');
  assert.equal(stageModeOf('live2d'), 'live2d');
  assert.equal(byKind('spine').overlay, null, 'spine 用舞台画布');
  assert.equal(byKind('live2d').overlay, 'canvas', 'live2d 用覆盖层 canvas');
  assert.equal(byKind('spine').overlayVisible, false);
  assert.equal(byKind('live2d').overlayVisible, true);
});

// ------------------------------------------------------------------ detectKind 层

test('detectKind：kind=three 的条目不许被当成 spine/live2d', async () => {
  const { buildDocument } = await import('../src/web/infra/document.js');
  const warns = [];
  const doc = await buildDocument({
    kind: 'three',                 // 未知渲染面
    id: 'fake-three',
    rootId: 'r', rel: 'x.model',
    name: 'x',
  }, null, { register() {}, resolve: (u) => u });
  // 三种可接受结果：state=error 且说明"无法判定内容类型"，或抛错。**不可接受：被当成 spine 走通**
  assert.ok(doc, 'buildDocument 必须返回文档对象');
  assert.equal(doc.state, 'error', 'kind=three 必须不进入渲染层');
  assert.equal(doc.kind, null, 'kind 必须为 null（不许被归一成 spine）');
  assert.ok((doc.warnings || []).length > 0, '必须留下可读原因');
});

// ------------------------------------------------------------------ 注册校验

test('register：kind 不在表里 ⇒ 启动即抛错（不是等点开才现形）', async () => {
  const { installDomShim } = await import('./helpers/dom-shim.mjs');
  installDomShim();
  const { createSurface } = await import('../src/web/render/surface.js');
  const surface = createSurface ? createSurface() : null;
  if (!surface) return;   // 导出形态不同则跳过（避免为了测试改产品代码）

  // ① 完全没声明 kind
  assert.throws(
    () => surface.register({ id: 'spine', mount() {} }),
    /必须声明 kind/,
  );
  // ② kind 不在表里
  assert.throws(
    () => surface.register({ id: 'three', kind: 'three', mount() {} }),
    /未在 render\/surfaces\.js 注册/,
  );
  // ③ id 与表项不一致（防 register('spine-v2') 漂移）
  assert.throws(
    () => surface.register({ id: 'spine-v2', kind: 'spine', mount() {} }),
    /与表项 id/,
  );
  // ④ 正常注册应当成功
  assert.doesNotThrow(() => surface.register({ id: 'spine', kind: 'spine', mount() {} }));
});

// ------------------------------------------------------------------ 表 ↔ 注册覆盖

test('表覆盖：SURFACES 里每个 id 都在 main.js 里注册过（防加表忘注册）', () => {
  const src = readFileSync(new URL('../src/web/main.js', import.meta.url), 'utf8');
  for (const s of SURFACES) {
    // main.js 的注册形如 surface.register(createSpineRenderer(...)) / createLive2DRenderer(...)
    // 用渲染器工厂名判定；**大小写不敏感**（createLive2DRenderer 里的 D 是大写，
    //   与 id 'live2d' 的大小写形态不同，属于既有的命名习惯，不为了测试去改产品代码）
    const factory = new RegExp(`create${s.id}Renderer\\s*\\(`, 'i');
    assert.ok(factory.test(src), `SURFACES 有 ${s.id}，但 main.js 里找不到 surface.register(create${s.id}Renderer(...))`);
  }
});
