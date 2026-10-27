// ============================================================================
// tool/fetch-runtimes.mjs —— 运行时**唯一**的下载入口（CLI）
//
// 为什么要有它：运行时目录是 gitignore 的（授权与体积），全新 clone / npx 装出来必然缺；
//   而"缺了怎么办"不该让用户猜 —— 这里把「从哪取、校验、放哪、有什么许可约束」一次做完。
//
// 核心逻辑（版本表 / tgz / tar 解析 / integrity / 落盘）在 tool/lib/runtime-package.mjs，
//   本文件只负责参数、交互与退出码 —— 这样核心逻辑能被单测直接调用，不必起 CLI。
//
// 默认不联网：只有显式跑这个 CLI 才会下载；网页侧永不自动下载。
//
// 用法：
//   node tool/fetch-runtimes.mjs --list                 列出可下载的 Spine 版本
//   node tool/fetch-runtimes.mjs --spine 4.1.0          下载并校验落地（会交互确认许可）
//   node tool/fetch-runtimes.mjs --spine 4.1.0 --yes    CI 用，跳过确认（仍打印许可）
//   node tool/fetch-runtimes.mjs --dir <路径>           覆盖落点根（默认 <dataRoot>/runtimes）
// 退出码：0 成功/用户拒绝下载；1 环境或校验失败；2 用法错误
// ============================================================================

import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  MIN_VERSION, compareSemver, fetchMeta, fetchSpine,
  pickDownloadableVersions, runtimesRoot, defaultDataRoot,
} from './lib/runtime-package.mjs';
// 给用户看的文案单独一层（与 resolver 的报错共用同一份）
import { licenseNotice, spine3Guide } from './lib/runtime-guides.mjs';

const USAGE = `用法：
  node tool/fetch-runtimes.mjs --list                 列出可下载的 Spine 版本（>= ${MIN_VERSION}）
  node tool/fetch-runtimes.mjs --spine <版本>          下载该版本并校验落地
  node tool/fetch-runtimes.mjs --spine <版本> --yes    跳过交互确认（CI 用，仍会打印许可提示）
  node tool/fetch-runtimes.mjs --dir <路径>            覆盖落点根（默认 <dataRoot>/runtimes）

退出码：0 成功/用户拒绝下载；1 环境或校验失败；2 用法错误`;

/**
 * 交互确认一次（非 TTY 或没有 --yes 时退回拒绝）。
 * @returns {Promise<boolean>}
 */
function confirmInteractive() {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      console.log('（非交互终端：未带 --yes，视为未确认，不下载。CI 里请显式加 --yes）');
      resolve(false);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('同意上述许可并继续下载？[y/N] ', (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(ans || '').trim()));
    });
  });
}

/**
 * --list 的实现：版本号永远来自 registry，不硬编码。
 * @param {string} dataRoot
 * @returns {Promise<number>} 退出码
 */
async function runList(dataRoot) {
  let meta;
  try {
    meta = await fetchMeta();
  } catch (e) {
    console.error(`✗ ${e.message}`);
    return 1;
  }
  const all = Object.keys(meta.versions || {});
  const list = pickDownloadableVersions(all);
  console.log(`可下载的 Spine 版本（共 ${list.length} 个，registry 里共 ${all.length} 个版本键）：`);
  for (const ver of list) {
    const dist = meta.versions[ver] && meta.versions[ver].dist;
    console.log(`  ${ver.padEnd(10)} ${dist && dist.integrity ? 'integrity ✓' : 'integrity ✗'}  ${(dist && dist.tarball) || ''}`);
  }
  console.log(`\n3.x 不在 npm 上（最早 ${MIN_VERSION}）⇒ 需要自备：`);
  console.log(spine3Guide('3.8', dataRoot));
  return 0;
}

/**
 * --spine 的实现：校验 → 确认许可 → 下载落地。
 * @param {string} ver
 * @param {{dir: string|null, dataRoot: string, yes: boolean}} opts
 * @returns {Promise<number>}
 */
async function runFetch(ver, opts) {
  // 允许 3.8 / 3.8.99 这种两位或三位写法：3.x 用户最可能直接敲 "3.8"，
  //   当成"格式错误"会把人挡在门外（正确反馈应该是"3.x 只能自备"）。
  if (!/^\d+(\.\d+){1,2}$/.test(ver)) {
    console.error(`✗ 版本号格式不对：${ver}（应形如 4.1.0 或 3.8）`);
    return 2;
  }
  if (compareSemver(ver, MIN_VERSION) < 0) {
    console.log(spine3Guide(ver, opts.dataRoot));
    console.log(`\n（本工具只下载 ${MIN_VERSION} 及以上；3.x 请按上面命令自备）`);
    return 1;
  }
  console.log(licenseNotice(ver));
  if (!opts.yes) {
    const ok = await confirmInteractive();
    if (!ok) {
      console.log('已取消，未下载任何文件。');
      return 0;
    }
  }
  try {
    const done = await fetchSpine(ver, {
      dir: opts.dir || undefined,
      dataRoot: opts.dataRoot,
      log: (msg) => console.log(`  ${msg}`),
    });
    console.log(`\n✓ 完成：${done.jsFile}`);
    if (done.licenseFile) console.log(`  LICENSE：${done.licenseFile}`);
    console.log(`  SOURCE.json：${done.sourceFile}`);
    console.log(licenseNotice(ver));
    console.log(`\n引擎会在下次请求时自动发现它（搜索顺序：项目自带 → 环境变量 → ${path.join(runtimesRoot(opts.dataRoot), 'spine')}）`);
    return 0;
  } catch (e) {
    console.error(`✗ ${e.message}`);
    if (e.code === 'integrity' || e.code === 'gunzip' || e.code === 'layout') {
      console.error('  （未落地任何文件；若目录里已有旧版本文件，它们没有被改动）');
    }
    return 1;
  }
}

/**
 * CLI 主体。
 * @param {string[]} argv
 * @returns {Promise<number>} 退出码
 */
export async function main(argv = process.argv.slice(2)) {
  const args = argv.slice();
  const has = (flag) => args.includes(flag);
  const valOf = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };

  if (has('--help') || has('-h') || args.length === 0) {
    console.log(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  const dataRoot = defaultDataRoot();
  const dir = valOf('--dir') || null;

  if (has('--list')) return runList(dataRoot);

  const ver = valOf('--spine');
  if (!ver) {
    console.error(USAGE);
    return 2;
  }
  return runFetch(ver, { dir, dataRoot, yes: has('--yes') });
}

// 直接执行时才跑 main（被单测 import 时不执行）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`✗ 未预期错误：${(e && e.stack) || e}`);
    process.exitCode = 1;
  });
}
