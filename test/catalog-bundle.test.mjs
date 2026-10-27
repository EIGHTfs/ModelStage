// test/catalog-bundle.test.mjs —— 资源包（容器单文件）在模型列表里的可见性
//
// 锁两类回归：
//   ① **递归**：资源包的摆法不统一 —— 有的根平铺在根层（azurlane_bundle，19 个都在 L0），
//      有的按 `<角色名>/<包>` 分目录（nikke_2，3 个都在 L1）。只扫根层时后者条目为 0，
//      表现是「包明明在盘上、模型列表里却没有」。
//   ② **kind 归属**：多个 asset-provider 插件并存时，解包前无法确定内容类型，
//      必须留 null 交由解包产物判定。取第一个插件会让 spine 包被标成 live2d
//      ⇒ 前端按 kind 选渲染分支 ⇒ 点开必失败，而现场像是"包坏了"。
//
// 样本策略与 test/unpack-filesview.test.mjs 同口径：外部资源不入库，按路径引用 + 缺失即 skip。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerData } from '../src/server/index.mjs';
import { findContainerFiles, resolveBundleProvider, toBundleEntry } from '../src/server/data/catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NIKKE_ROOT = path.resolve(ROOT, '..', 'NIKKE');
const LIVE2D_BUNDLE_ROOT = path.resolve(ROOT, '..', 'live2d');

const data = createServerData({ root: ROOT, dataRoot: ROOT });

/** 造一个假容器文件（detectBundleContainer 只读前 8 字节魔数） */
function writeFakeBundle(abs) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from('UnityFS\0padpadpad', 'latin1'));
}

/** 与生产同一份魔数判定（复刻 registry.detectBundleContainer 的 8 字节判定，测试专用） */
function detectContainer(abs) {
  try {
    const head = Buffer.alloc(8);
    const fd = fs.openSync(abs, 'r');
    try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
    return (head.toString('latin1', 0, 7) === 'UnityFS' && head[7] === 0) ? 'unityfs' : null;
  } catch {
    return null;
  }
}

test('递归：多层目录下的容器也能列出（nikke_2 的包在第二层）', () => {
  if (!fs.existsSync(NIKKE_ROOT)) return;   // 样本不在本机：skip
  const r = data.catalog.listCatalog('nikke_2');
  assert.equal(r.status, 200);
  const entries = r.body.entries || [];
  assert.equal(entries.length, 3, `nikke_2 应列出 3 条容器，实际 ${entries.length}`);

  for (const e of entries) {
    assert.equal(e.container, 'unityfs', '条目必须带 container 标记');
    // rel 是装载时定位容器的唯一依据，必须含目录层级（不能只剩文件名）
    assert.ok(typeof e.rel === 'string' && e.rel.includes('/'), `条目缺多级 rel：${e.rel}`);
    assert.ok(e.size > 0, `条目 size 应为真实体积，实际 ${e.size}`);
  }
});

test('回归：根层平铺的容器仍被全部列出（数量从磁盘现算，不写死）', () => {
  const cfg = data.config.readConfig().find((r) => r.id === 'azurlane_bundle');
  if (!cfg || !fs.existsSync(cfg.path)) return;
  const r = data.catalog.listCatalog('azurlane_bundle');
  const entries = r.body.entries || [];
  // 断言的意图是"根层平铺的包没被递归改动漏掉"，**不是**"总数永远是某个数字"：
  //   用户往这个根里加文件、或放进子目录后，硬编码的数量断言会变成假红（已实际发生过：19 → 94）。
  //   所以从磁盘现算：根层每个文件读 8 字节判 UnityFS，得到的数才是应当被列出的条数。
  const flatContainers = fs.readdirSync(cfg.path, { withFileTypes: true })
    .filter((d) => d.isFile())
    .filter((d) => {
      try {
        const fd = fs.openSync(`${cfg.path}/${d.name}`, 'r');
        const head = Buffer.alloc(8);
        fs.readSync(fd, head, 0, 8, 0);
        fs.closeSync(fd);
        return head.toString('latin1') === 'UnityFS\0';
      } catch { return false; }
    });
  const flatListed = entries.filter((e) => !String(e.rel || e.name || '').includes('/'));
  assert.equal(flatListed.length, flatContainers.length,
    `根层平铺容器应全部列出：磁盘 ${flatContainers.length} 个，列了 ${flatListed.length} 个`);
  assert.ok(flatContainers.length > 0, '该根层至少应有一个 UnityFS 容器才具回归意义');
});

test('多插件时 kind 一律为 null，并在 warnings 说明原因', () => {
  const cfg = data.config.readConfig().find((r) => r.id === 'azurlane_bundle');
  if (!cfg || !fs.existsSync(cfg.path)) return;

  const providers = data.plugins.readPlugins()
    .filter((p) => Array.isArray(p.fileKinds) && p.fileKinds.includes('bundle'));
  if (providers.length < 2) return;   // 只有单插件时不适用本用例

  const r = data.catalog.listCatalog('azurlane_bundle');
  for (const e of r.body.entries || []) {
    assert.equal(e.kind, null, `多插件并存时 kind 必须为 null（否则会被错标成某一类内容），实际 ${e.kind}`);
  }
  assert.ok((r.body.warnings || []).some((w) => w.includes('kind 置空') || w.includes('多个资源包插件')),
    `warnings 应说明 kind 为何为空，实际 ${JSON.stringify(r.body.warnings)}`);
});

test('单插件时 kind 仍取插件声明（live2d 现状零变化）', () => {
  const fakePlugins = {
    readPlugins: () => [{
      id: 'unity-live2d-bundle',
      provides: ['asset-provider'],
      fileKinds: ['bundle'],
      produces: { kind: 'live2d' },
    }],
  };
  const provider = resolveBundleProvider(fakePlugins);
  assert.equal(provider.id, 'unity-live2d-bundle');
  assert.equal(provider.kind, 'live2d', '只有一个 bundle 插件时必须沿用其 produces.kind');
  assert.equal(provider.warning, null);

  const entry = toBundleEntry(
    { id: 'r', name: 'R', path: '/tmp' },
    { name: 'pkg', rel: 'pkg', container: 'unityfs', size: 1 },
    provider,
  );
  assert.equal(entry.kind, 'live2d', '条目 kind 应继承插件声明');
});

test('深度上限：超深目录只停止深入，同层其它容器仍要扫到（不得整体中断）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-depth-'));
  try {
    // 每层各放一个容器：根层 + 6 层子目录
    writeFakeBundle(path.join(tmp, 'pkg-root'));
    let cur = tmp;
    for (let i = 0; i < 6; i += 1) {
      cur = path.join(cur, `d${i}`);
      writeFakeBundle(path.join(cur, `pkg-${i}`));
    }

    const limited = findContainerFiles(tmp, detectContainer, { maxDepth: 2 });
    // maxDepth=2 ⇒ 会扫 depth 0/1/2 三层 ⇒ 找到 3 个（root、d0、d1）
    assert.equal(limited.files.length, 3, `深度上限 2 时应找到 3 个，实际 ${limited.files.length}`);
    assert.equal(limited.stopped, null, '深度超限不该算"列举被硬中断"');
    assert.ok(limited.stats.depthSkipped > 0, '应有目录因超深被跳过并计数（供 warnings 提示）');

    const all = findContainerFiles(tmp, detectContainer, { maxDepth: 10 });
    assert.equal(all.files.length, 7, `不设限时应找到全部 7 个，实际 ${all.files.length}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('命中上限：到顶即停并带回原因（不静默截断）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-hits-'));
  try {
    for (let i = 0; i < 5; i += 1) writeFakeBundle(path.join(tmp, `pkg-${i}`));

    const capped = findContainerFiles(tmp, detectContainer, { maxHits: 3 });
    assert.equal(capped.files.length, 3);
    assert.equal(capped.stopped, '容器命中上限 3 个', `stopped 必须带回原因，实际 ${JSON.stringify(capped.stopped)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('只对未知扩展名读魔数：已知普通文件一次都不打开', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-ext-'));
  try {
    // 这些扩展名都在 KNOWN_FILE_EXT 里 ⇒ 不该被探魔数（哪怕内容伪装成 UnityFS）
    for (const name of ['a.skel', 'b.atlas', 'c.png', 'd.json', 'e.txt']) {
      fs.writeFileSync(path.join(tmp, name), Buffer.from('UnityFS\0fake', 'latin1'));
    }
    writeFakeBundle(path.join(tmp, 'real-pkg'));   // 无扩展名 ⇒ 应被识别

    const found = findContainerFiles(tmp, detectContainer);
    assert.equal(found.stats.unknownFiles, 1, `只应探 1 个未知扩展名文件，实际 ${found.stats.unknownFiles}`);
    assert.equal(found.files.length, 1);
    assert.equal(found.files[0].name, 'real-pkg');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('byDir 按目录聚合（给"按 dirSignature 缓存"留的钩子）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-bydir-'));
  try {
    writeFakeBundle(path.join(tmp, 'root-pkg'));
    writeFakeBundle(path.join(tmp, 'sub', 'nested-pkg'));

    const found = findContainerFiles(tmp, detectContainer);
    assert.equal(found.files.length, 2);
    // 根层的键是空串（相对目录为空），子目录以其相对路径为键
    assert.ok(Array.isArray(found.byDir['']), `应有根层分组，实际键 ${Object.keys(found.byDir).join(',')}`);
    assert.ok(Array.isArray(found.byDir.sub), `应有 sub 分组，实际键 ${Object.keys(found.byDir).join(',')}`);
    assert.equal(found.byDir[''][0].name, 'root-pkg');
    assert.equal(found.byDir.sub[0].name, 'nested-pkg');
    assert.equal(found.byDir.sub[0].rel, 'sub/nested-pkg', 'byDir 里的 rel 必须是相对根的完整路径');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
