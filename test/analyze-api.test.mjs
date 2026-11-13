// test/analyze-api.test.mjs —— 只读分析接口（/api/analyze）的判定与边界
//
// 这些用例钉住四件事：
//   ① 各类输入（UnityFS / ZIP / JSON / MOC3 / 随机字节 / 不存在）都给出**可读结论**，不抛未捕获异常
//   ② 目录递归：候选筛选、maxFiles 上限写进 warnings（不静默截断）、空目录、深层嵌套
//   ③ 错误路径：不存在 / 目录当文件传 / 文件当目录传
//   ④ **只读性**：分析后被分析文件的 mtime 与内容都不变
//
// 不写死任何真实资源的路径：样本全部用 mkdtemp 现造。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  analyzeFile,
  analyzeDir,
  deriveVerdict,
  MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
} from '../src/server/analyze/index.mjs';

/** 建一个临时目录，退出时删掉。**必须 await fn**：fn 是 async，不 await 会在它跑完前就删目录 */
async function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-test-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 写一个文件并返回路径 */
function write(dir, name, bytes) {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
  return full;
}

const MOC3_HEAD = Buffer.concat([Buffer.from('MOC3', 'latin1'), Buffer.from([0x01, 0x02, 0x03])]);
const ZIP_HEAD = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const RANDOM = crypto.randomBytes(64);

test('单文件：MOC3 头判为 live2d-cubism4', async () => {
  await withTmp(async (dir) => {
    const f = write(dir, 'x.moc3', MOC3_HEAD);
    const { status, body } = await analyzeFile(f);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.verdict, 'live2d-cubism4');
    assert.match(body.summary, /Cubism 4/);
    assert.equal(body.analyzedBy.fallback, true);
  });
});

test('单文件：ZIP 头判为 archive，并提示内部可能加密', async () => {
  await withTmp(async (dir) => {
    const f = write(dir, 'x.lpk', ZIP_HEAD);
    const { status, body } = await analyzeFile(f);
    assert.equal(status, 200);
    assert.equal(body.verdict, 'archive');
    assert.ok(body.warnings.some((w) => /加密/.test(w)), '应提示 ZIP 内部可能加密');
  });
});

test('单文件：model3.json 判为 live2d-cubism4；其它 JSON 判 unknown', async () => {
  await withTmp(async (dir) => {
    const m3 = write(dir, 'x.model3.json', Buffer.from('{"Version":3}', 'utf8'));
    const r1 = await analyzeFile(m3);
    assert.equal(r1.body.verdict, 'live2d-cubism4');

    const plain = write(dir, 'other.json', Buffer.from('{"a":1}', 'utf8'));
    const r2 = await analyzeFile(plain);
    assert.equal(r2.body.verdict, 'unknown');
  });
});

test('单文件：随机字节判 unknown，不抛错', async () => {
  await withTmp(async (dir) => {
    const f = write(dir, 'blob.bin', RANDOM);
    const { status, body } = await analyzeFile(f);
    assert.equal(status, 200);
    assert.equal(body.verdict, 'unknown');
    assert.ok(body.summary.length > 0, 'summary 不能是空串');
  });
});

test('错误路径：不存在的文件给 404 + 结构化 code', async () => {
  const missing = path.join(os.tmpdir(), `analyze-missing-${process.pid}-${Date.now()}`);
  const { status, body } = await analyzeFile(missing);
  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'ANALYZE_NOT_FOUND');
});

test('错误路径：目录当文件传给 400；文件当目录传给 400', async () => {
  await withTmp(async (dir) => {
    const asFile = await analyzeFile(dir);
    assert.equal(asFile.status, 400);
    assert.equal(asFile.body.code, 'ANALYZE_IS_DIR');

    const f = write(dir, 'a.bin', RANDOM);
    const asDir = await analyzeDir(f);
    assert.equal(asDir.status, 400);
    assert.equal(asDir.body.code, 'ANALYZE_NOT_DIR');
  });
});

test('限额：超过 MAX_FILE_BYTES 直接拒绝并说明（不流式解析）', async () => {
  await withTmp(async (dir) => {
    const f = write(dir, 'big.bin', Buffer.alloc(1024));
    // 不真的造 512MB 文件：把上限压到 10 字节来验判定分支
    const { status, body } = await analyzeFile(f, { maxFileBytes: 10 });
    assert.equal(status, 413);
    assert.equal(body.code, 'ANALYZE_TOO_LARGE');
    assert.equal(body.maxFileBytes, 10);
    assert.ok(MAX_FILE_BYTES > 0, '导出的上限常量应存在');
  });
});

test('目录：只挑候选（扩展名/魔数），非候选不计入 items', async () => {
  await withTmp(async (dir) => {
    write(dir, 'a/x.moc3', MOC3_HEAD);
    write(dir, 'a/y.bundle', ZIP_HEAD);
    write(dir, 'a/note.txt', Buffer.from('hello', 'utf8'));
    const { status, body } = await analyzeDir(dir);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const names = body.items.map((i) => path.basename(i.path));
    assert.ok(names.includes('x.moc3'), '应分析 .moc3');
    assert.ok(names.includes('y.bundle'), '应分析 .bundle');
    assert.ok(!names.includes('note.txt'), '.txt 不是候选，不应分析');
  });
});

test('目录：超过 maxFiles 时写进 warnings，不静默截断', async () => {
  await withTmp(async (dir) => {
    for (let i = 0; i < 6; i += 1) write(dir, `m${i}.moc3`, MOC3_HEAD);
    const { body } = await analyzeDir(dir, { maxFiles: 2 });
    assert.equal(body.candidates, 2);
    assert.ok(body.warnings.some((w) => /上限/.test(w)), `应有一条上限提示，实际：${JSON.stringify(body.warnings)}`);
    assert.equal(DEFAULT_MAX_FILES, 500);
  });
});

test('目录：空目录给 0 候选、不报错', async () => {
  await withTmp(async (dir) => {
    const { status, body } = await analyzeDir(dir);
    assert.equal(status, 200);
    assert.equal(body.candidates, 0);
    assert.deepEqual(body.items, []);
  });
});

test('目录：不存在给 404 + 结构化 code', async () => {
  const missing = path.join(os.tmpdir(), `analyze-missing-dir-${process.pid}-${Date.now()}`);
  const { status, body } = await analyzeDir(missing);
  assert.equal(status, 404);
  assert.equal(body.code, 'ANALYZE_NOT_FOUND');
});

test('目录：隐藏目录（.trash 等）不参与递归', async () => {
  await withTmp(async (dir) => {
    write(dir, '.trash/deep/x.moc3', MOC3_HEAD);
    write(dir, 'visible/y.moc3', MOC3_HEAD);
    const { body } = await analyzeDir(dir);
    assert.equal(body.candidates, 1, '只应看到 visible 下的那个');
    assert.ok(body.items[0].path.includes('visible'));
  });
});

test('只读性：分析后文件内容与 mtime 都不变', async () => {
  await withTmp(async (dir) => {
    const f = write(dir, 'ro.bin', RANDOM);
    const before = { hash: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'), mtime: fs.statSync(f).mtimeMs };
    await analyzeFile(f);
    await analyzeDir(dir);
    const after = { hash: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'), mtime: fs.statSync(f).mtimeMs };
    assert.equal(after.hash, before.hash, '内容不能被改');
    assert.equal(after.mtime, before.mtime, 'mtime 不能被改（只读打开不会更新时间）');
  });
});

test('verdict 推导：TextAsset 里有 .skel ⇒ spine；有 moc3 ⇒ cubism4', () => {
  assert.equal(deriveVerdict({ ok: true, textAssets: [{ name: 'a.skel', kind: 'skel' }] }), 'spine');
  assert.equal(deriveVerdict({ ok: true, textAssets: [], moc3: { bytes: 10 } }), 'live2d-cubism4');
  assert.equal(deriveVerdict({ ok: true, textAssets: [], cubism2Moc: { count: 1 } }), 'live2d-cubism2');
  assert.equal(deriveVerdict({ ok: true, textAssets: [] }), 'unity-3d');
  assert.equal(deriveVerdict({ ok: false, magic: 'MOC3' }), 'live2d-cubism4');
  assert.equal(deriveVerdict({ ok: false, magic: 'ZIP' }), 'archive');
  assert.equal(deriveVerdict({ ok: false, magic: 'UnityFS' }), 'bundle-unknown');
  assert.equal(deriveVerdict({ ok: false }), 'unknown');
});
