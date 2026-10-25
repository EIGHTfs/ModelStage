// test/catalog-motions.test.mjs —— model3 动作清单的提取与"缺失过滤"（bug B 的回归守卫）
//
// 背景：模型定义文件里声明的动作，磁盘上可能**不存在**（资产残缺）。
//   若照原样下发，前端就会去请求它 ⇒ 404 进 problems（每次加载这类模型都红）。
//   所以服务端在产出动作清单时就过滤掉不存在的文件，并把它们单独放进 missingMotions。
//   本测试不碰真实模型目录：用临时目录造几个 ref，其中一部分文件不存在。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listMotionRefs, splitByExistence } from '../src/server/data/catalog.mjs';

test('listMotionRefs：从 Motions 提取引用，跳过无 File 的条目与非数组组', () => {
  const groups = {
    idle: [{ File: 'motions/idle_0.motion3.json' }, { File: 'motions/idle_1.motion3.json' }],
    tap: [{ File: 'motions/tap.motion3.json' }],
    broken: 'not-an-array',
    empty: [],
    noFile: [{ FadeIn: 1 }],
  };
  const refs = listMotionRefs(groups);
  assert.equal(refs.length, 3);
  assert.deepEqual(refs.map((r) => r.file), ['motions/idle_0.motion3.json', 'motions/idle_1.motion3.json', 'motions/tap.motion3.json']);
  assert.equal(refs[0].group, 'idle');
  assert.equal(refs[0].index, 0);
  assert.equal(refs[2].group, 'tap');
});

test('listMotionRefs：空/异常输入返回空清单（不抛）', () => {
  assert.deepEqual(listMotionRefs(null), []);
  assert.deepEqual(listMotionRefs(undefined), []);
  assert.deepEqual(listMotionRefs({}), []);
});

test('splitByExistence：磁盘上不存在的引用被分到 missing（bug B 核心）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-motions-'));
  try {
    await fs.mkdir(path.join(dir, 'motions'));
    await fs.writeFile(path.join(dir, 'motions/idle.motion3.json'), '{}');
    const refs = [
      { group: 'idle', index: 0, file: 'motions/idle.motion3.json' },
      { group: 'touch_special', index: 0, file: 'motions/touch_special.motion3.json' }, // 不存在
    ];
    const { existing, missing } = splitByExistence(refs, dir);
    assert.deepEqual(existing.map((r) => r.file), ['motions/idle.motion3.json']);
    assert.deepEqual(missing.map((r) => r.file), ['motions/touch_special.motion3.json'],
      '缺失的动作必须被过滤出来（前端不会请求它 ⇒ 不再产生 404）');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('splitByExistence：全部缺失/全部存在/空清单都正确', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-motions-'));
  try {
    const all = [
      { group: 'g', index: 0, file: 'a.json' },
      { group: 'g', index: 1, file: 'b.json' },
    ];
    const none = splitByExistence(all, dir);
    assert.equal(none.existing.length, 0);
    assert.equal(none.missing.length, 2);

    await fs.writeFile(path.join(dir, 'a.json'), '{}');
    await fs.writeFile(path.join(dir, 'b.json'), '{}');
    const every = splitByExistence(all, dir);
    assert.equal(every.existing.length, 2);
    assert.equal(every.missing.length, 0);

    assert.deepEqual(splitByExistence([], dir), { existing: [], missing: [] });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
