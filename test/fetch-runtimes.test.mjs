// test/fetch-runtimes.test.mjs —— tool/fetch-runtimes.mjs 的解析 / 校验 / 落地
//
// 全部**离线**：tar 字节流在本文件里现拼（不下载真实包、不入库任何二进制），
//   下载链路用本地 http server 冒充 registry + tarball。
// 为什么必须自己造 tar：自研 tar 解析最容易错位的地方（GNU 长名 L、pax x、目录项、512 填充）
//   恰恰是真实包里不一定同时出现的那几种 —— 只测真实包等于赌运气。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {
  walkTar, extractRuntime, verifyIntegrity, stripSourceMapRef,
  compareSemver, pickDownloadableVersions, fetchSpine, runtimesRoot,
} from '../tool/lib/runtime-package.mjs';

// ---------------- 自造 tar ----------------

/** 造一个 512 字节 tar 头 */
function tarHeader({ name, size = 0, type = '0', prefix = '' }) {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100, 'latin1');           // mode
  h.write('0000000\0', 108, 'latin1');           // uid
  h.write('0000000\0', 116, 'latin1');           // gid
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
  h.write('00000000000\0', 136, 'latin1');       // mtime
  h.write('        ', 148, 'latin1');            // checksum 占位（本解析器不校验）
  h.write(type, 156, 'latin1');
  h.write(prefix.slice(0, 155), 345, 'utf8');
  return h;
}

/** 造 tar 条目：文件 / 目录 / GNU 长名 / pax */
function tarBlock({ name, content = '', type = '0' }) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([tarHeader({ name, size: data.length, type }), data, pad]);
}

/** 造一个完整 tar（结尾两个 0 块） */
function makeTar(blocks) {
  return Buffer.concat([...blocks, Buffer.alloc(1024, 0)]);
}

/** 造 tgz */
function makeTgz(blocks) {
  return zlib.gzipSync(makeTar(blocks));
}

/** 现拼一个"像样的" npm 包 tgz */
function makePackageTgz({ withMap = true, withPax = false, withLongName = false } = {}) {
  const iife = 'var spine = (() => { return {}; })();\n//# sourceMappingURL=spine-webgl.js.map\n';
  const blocks = [tarBlock({ name: 'package/', type: '5' })];
  if (withLongName) {
    // GNU 长名：本块是"下一个条目的名字"
    const longName = 'package/dist/iife/' + 'very-long-'.repeat(6) + 'spine-webgl.js';
    blocks.push(tarBlock({ name: '././@LongLink', content: longName + '\0', type: 'L' }));
    blocks.push(tarBlock({ name: 'package/dist/iife/short.js', content: iife }));
    blocks.push(tarBlock({ name: longName, content: iife }));
  } else if (withPax) {
    blocks.push(tarBlock({ name: 'PaxHeader/spine', content: '30 path=package/dist/iife/spine-webgl.js\n', type: 'x' }));
    blocks.push(tarBlock({ name: 'package/dist/iife/truncated.js', content: iife }));
  } else {
    blocks.push(tarBlock({ name: 'package/dist/iife/spine-webgl.js', content: iife }));
  }
  if (withMap) blocks.push(tarBlock({ name: 'package/dist/iife/spine-webgl.js.map', content: '{"version":3}' }));
  blocks.push(tarBlock({ name: 'package/dist/index.js', content: 'export * from "./AssetManager";' }));
  blocks.push(tarBlock({ name: 'package/package.json', content: '{"main":"dist/index.js"}' }));
  blocks.push(tarBlock({ name: 'package/LICENSE', content: 'Spine Runtimes License Agreement\n' }));
  return makeTgz(blocks);
}

// ---------------- tar 解析 ----------------

test('① walkTar：普通文件、目录项、512 填充、结尾 0 块都处理对', () => {
  const tar = makeTar([
    tarBlock({ name: 'a.txt', content: 'hello' }),
    tarBlock({ name: 'dir/', type: '5' }),
    tarBlock({ name: 'b/c.bin', content: Buffer.alloc(700, 7) }),
  ]);
  const got = [];
  walkTar(tar, ({ name, data }) => got.push({ name, len: data.length }));
  assert.deepEqual(got, [
    { name: 'a.txt', len: 5 },
    { name: 'b/c.bin', len: 700 },   // 700 > 512，跨块
  ]);
});

test('② walkTar：GNU 长名（L）覆盖下一个条目的名字，且不错位', () => {
  const longName = 'package/dist/iife/' + 'x'.repeat(150) + '.js';
  const tar = makeTar([
    tarBlock({ name: '././@LongLink', content: longName + '\0', type: 'L' }),
    tarBlock({ name: 'package/dist/iife/tmp.js', content: 'AAA' }),
    tarBlock({ name: 'after.txt', content: 'BBB' }),
  ]);
  const got = [];
  walkTar(tar, ({ name, data }) => got.push([name, data.toString()]));
  assert.equal(got[0][0], longName, 'L 块给出的长名要套用到下一个条目');
  assert.equal(got[0][1], 'AAA');
  assert.deepEqual(got[1], ['after.txt', 'BBB'], 'L 之后必须回到正常解析（不错位）');
});

test('③ walkTar：pax（x）里的 path= 覆盖条目名', () => {
  const tar = makeTar([
    tarBlock({ name: 'PaxHeader/x', content: '42 path=package/dist/iife/spine-webgl.js\n', type: 'x' }),
    tarBlock({ name: 'package/dist/iife/trunc.js', content: 'JS' }),
  ]);
  const got = [];
  walkTar(tar, ({ name }) => got.push(name));
  assert.deepEqual(got, ['package/dist/iife/spine-webgl.js']);
});

// ---------------- 选取与清洗 ----------------

test('④ extractRuntime：选 IIFE 构建、排除 .map、带上 LICENSE', () => {
  const r = extractRuntime(makePackageTgz());
  assert.match(r.js.path, /dist\/iife\/spine-webgl\.js$/, '必须选 dist/iife 里的 IIFE，不是 ESM 的 dist/index.js');
  assert.equal(r.license && r.license.path, 'package/LICENSE');
  assert.ok(r.files.some((n) => n.endsWith('.map')), '包里到底有没有 .map（说明确实被识别出来了）');
  assert.ok(!/class|export/.test(r.js.path));
});

test('⑤ extractRuntime：包结构变了要明确报错（不退回 ESM 的 main）', () => {
  const tgz = makeTgz([
    tarBlock({ name: 'package/package.json', content: '{"main":"dist/index.js"}' }),
    tarBlock({ name: 'package/dist/index.js', content: 'export * from "./A";' }),
  ]);
  assert.throws(() => extractRuntime(tgz), /dist\/iife\/spine-webgl\*?\.js|包结构/, '没有 IIFE 构建时必须报错');
});

test('⑥ stripSourceMapRef：sourceMappingURL 行被剥掉', () => {
  const out = stripSourceMapRef('var spine = 1;\n//# sourceMappingURL=spine-webgl.js.map\n');
  assert.equal(out.includes('sourceMappingURL'), false);
  assert.match(out, /var spine = 1;/);
});

// ---------------- 校验 ----------------

test('⑦ verifyIntegrity：正确的 sha512 通过，错的抛 integrity 类错误', () => {
  const buf = Buffer.from('fake tarball bytes');
  const good = 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');
  verifyIntegrity(buf, good);   // 不抛即通过
  assert.throws(() => verifyIntegrity(buf, 'sha512-AAAA'), (e) => {
    assert.equal(e.code, 'integrity');
    assert.match(e.message, /校验失败/);
    return true;
  });
});

// ---------------- 版本表 ----------------

test('⑧ compareSemver / pickDownloadableVersions：过滤 3.x 且按数值排序', () => {
  assert.ok(compareSemver('4.0.10', '4.0.9') > 0, '4.0.10 必须大于 4.0.9（不能按字符串比）');
  assert.ok(compareSemver('4.1.0', '4.1') > 0 || compareSemver('4.1.0', '4.1') === 0);
  const list = pickDownloadableVersions(['3.6', '3.8', '4.0.1', '4.0.9', '4.0.10', '4.1.0', 'garbage']);
  assert.deepEqual(list, ['4.0.1', '4.0.9', '4.0.10', '4.1.0'], '不含 3.x，且 4.0.10 在 4.0.9 之后');
});

// ---------------- 端到端（本地假 registry） ----------------

test('⑨ fetchSpine 端到端：校验通过 → 落地文件名归一化 + LICENSE + SOURCE.json；integrity 坏 → 不留半成品', async () => {
  const tgz = makePackageTgz();
  const goodIntegrity = 'sha512-' + crypto.createHash('sha512').update(tgz).digest('base64');
  let wrongIntegrity = goodIntegrity;

  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/meta') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        versions: {
          '4.1.0': { version: '4.1.0', dist: { tarball: `http://127.0.0.1:${server.address().port}/pkg.tgz`, integrity: wrongIntegrity } },
        },
      }));
      return;
    }
    if (req.url === '/pkg.tgz') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(tgz);
      return;
    }
    res.writeHead(404); res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-fetch-'));
  try {
    // ① 正常路径
    const out = await fetchSpine('4.1.0', { dir: tmp, metaUrl: `http://127.0.0.1:${port}/meta` });
    assert.equal(path.basename(out.jsFile), 'spine-webgl-4.1.0.js', '落地名必须归一化成 resolver 认的名字');
    const text = fs.readFileSync(out.jsFile, 'utf8');
    assert.equal(text.includes('sourceMappingURL'), false, '落地文件里不许留 sourceMappingURL');
    assert.equal(fs.readdirSync(path.dirname(out.jsFile)).filter((f) => f.endsWith('.map')).length, 0, '不许落 .map');
    assert.ok(fs.existsSync(out.licenseFile), 'LICENSE 要一起落地');
    const src = JSON.parse(fs.readFileSync(out.sourceFile, 'utf8'));
    assert.equal(src.integrity, goodIntegrity);
    assert.match(src.packageFile, /dist\/iife\/spine-webgl\.js$/);

    // ② integrity 坏掉：必须报错且不留半成品
    wrongIntegrity = 'sha512-' + Buffer.alloc(64, 1).toString('base64');
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-bad-'));
    await assert.rejects(() => fetchSpine('4.1.0', { dir: tmp2, metaUrl: `http://127.0.0.1:${port}/meta` }), (e) => {
      assert.equal(e.code, 'integrity');
      return true;
    });
    // 校验在 mkdir 之前 ⇒ 连版本目录都不会被创建（比"留个空目录"更干净）
    const verDir = path.join(tmp2, 'spine', '4.1.0');
    const exists = fs.existsSync(verDir);
    const left = exists ? fs.readdirSync(verDir) : [];
    assert.deepEqual(left, [], `校验失败时不许留任何文件，实际：${exists ? left.join(',') : '(目录都没建)'}`);
    fs.rmSync(tmp2, { recursive: true, force: true });
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('⑩ runtimesRoot 跟随 MODELSTAGE_DATA_ROOT（缺省=项目根）', () => {
  const old = process.env.MODELSTAGE_DATA_ROOT;
  try {
    delete process.env.MODELSTAGE_DATA_ROOT;
    assert.match(runtimesRoot(), /runtimes$/);
    process.env.MODELSTAGE_DATA_ROOT = '/tmp/some-data-root';
    assert.equal(runtimesRoot(), '/tmp/some-data-root/runtimes');
  } finally {
    if (old === undefined) delete process.env.MODELSTAGE_DATA_ROOT;
    else process.env.MODELSTAGE_DATA_ROOT = old;
  }
});
