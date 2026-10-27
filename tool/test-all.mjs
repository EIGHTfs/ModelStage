// tool/test-all.mjs —— 回归总入口：清理 → 串行跑全部套件 → 汇总
//
// 为什么要总入口：
//   · 每次手写一串 node tool/check-console.mjs 容易漏套件、参数不一致（f4 需要探针目录）；
//   · 检查脚本会起 chrome-headless-shell，上一轮异常退出会残留进程与 /tmp 用户目录，
//     多轮之后机器上挂着一堆 chrome，既吃内存又可能干扰下一轮（端口/句柄）。
//
// 做什么：
//   1. 清理：结束本工具此前起的 chrome（按 user-data-dir 前缀精确匹配，绝不误杀别的浏览器），
//      再删除 /tmp/check-console-profile-* 目录；
//   2. 自检服务：GET 首页不通就调用项目自带 web.sh start；
//   3. 串行跑 SUITES（一次一套，避免并发争 GPU/端口把结果搅乱）；
//   4. 汇总：每套 failed/total/problems，任一 failed>0 则退出码 1。
//
// 用法：node tool/test-all.mjs [--url http://host:port/] [--keep-profiles]
//       [--all] [--only a,b] [--browser] [--list] [--out <dir>] [--bg]
//   --browser  把浏览器注入套件（test/browser/*.js）也纳入自动门禁；默认只跑 node-test

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { acquireTestLock, releaseOnExit, describeHolder, EXIT_SKIPPED, HELD_ENV } from './lib/test-lock.mjs';
import { findBadPerms, summarizeBadPerms } from './lib/check-perms.mjs';
// 跨文件系统复制：CIFS/SMB 上 fs.copyFileSync 会因 libuv 改权限位而 EPERM（实测踩过两次）
import { copyFilePortable } from '../src/server/core/fs-portable.mjs';
import { checkSingleSource, formatViolations } from './check-single-source.mjs';
import { checkWiring, formatWiringProblems } from './check-wiring.mjs';
import { memAvailableMB, tailLines, classifyOutcome, openRun, writeSuiteResult, updateSummary, finishRun } from './lib/test-report.mjs';

// 必须用 fileURLToPath：项目路径含中文/空格，URL.pathname 是百分号编码，直接当路径会找不到文件
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const PROJECT = path.resolve(HERE, '..');
const PROFILE_PREFIX = '/tmp/check-console-profile-';
/** 单套超时：正常一套 10～60s，180s 足够；超时视为"未产出结果"并重试一次 */
const SUITE_TIMEOUT_MS = Number(process.env.TEST_SUITE_TIMEOUT_MS) > 0
  ? Number(process.env.TEST_SUITE_TIMEOUT_MS)
  : 180000;

/** 套件清单：顺序固定（从"接线自检"到"重交互回归"） */
// 并发互斥（任务 15）：同一项目同时只允许一个测试实例。
//   第二个实例直接**跳过**并说清谁在跑——继续跑只会产出假红，误导修错地方。
//   跳过用退出码 75，与 0=通过 / 1=失败 明确区分，CI 可据此判定"没跑"而不是"挂了"。
// **门禁：源码权限预检**（必须在 test-lock 之前、比任何测试都早）
//   权限不对（600/777）时，Node 服务端读不到模块 ⇒ app 初始化即崩 ⇒ 所有 e2e 无法执行 ⇒
//   超时被杀报一堆"未捕获异常"。那样的红**全是假红**，比不跑更贵（会让人去查业务代码）。
//   所以这里**直接失败退出**，不继续跑出一堆误导性结果。已经反复发生三次，做成硬门禁。
const BAD_PERMS = findBadPerms(PROJECT);
if (BAD_PERMS.files.length || BAD_PERMS.dirs.length) {
  console.error('[test-all] ❌ 源码权限预检失败 —— 不跑测试（否则结果全是假红）：');
  console.error(summarizeBadPerms(BAD_PERMS));
  process.exit(1);
}

// **门禁：前端单一数据源**（静态检查，与权限预检同层：失败即中止，不占回归套件名额）
//   为什么是门禁而不是第 20 套：19 套是回归清单，"19 套全绿"本身是个可读信号；
//   静态约束挂在前面当门禁，红得早、也不会让人误以为"多了一套测试"。
//   规则与例外见 docs/契约/数据与接口.md。
{
  const { ok, violations } = checkSingleSource();
  if (!ok) {
    console.error('[test-all] ❌ 单一数据源门禁失败 —— 不跑测试（改法是确定性的，先修再跑）：');
    console.error(formatViolations(violations));
    process.exit(1);
  }
}

// **门禁：控件声明 ↔ 接线**（静态检查，与上面同层：fail 即中止，warn 只提示）
//   为什么也当门禁而不是第 15 套：它验的是"声明与接线是否对得上"这类静态事实，
//   和"某套用例跑过没过"不是一回事；挂在前面红得早，也不占回归套件名额。
//   规则与自证见 docs/设计/测试脚本结构.md §7.2（W1~W5）。
//   warn（W3/W4）只打印条数、不拦 —— 它们可能是有意为之（如统一 handler + 早退）。
{
  const w = await checkWiring();
  if (w.warns.length) {
    console.log(`[test-all] ⚠ 控件声明↔接线：${w.warns.length} 条警告（不拦，明细见 node tool/check-wiring.mjs）`);
  }
  if (!w.ok) {
    console.error('[test-all] ❌ 控件声明 ↔ 接线 门禁失败 —— 不跑测试（改法是确定性的，先修再跑）：');
    console.error(formatWiringProblems(w.fails));
    process.exit(1);
  }
}

// **--bg 必须在 test-lock 之前分流**：父进程立刻退出，否则它会先拿锁、子进程反而被互斥挡掉(退出 75)。
// 做法：detached 子进程 + 输出重定向到 runtime/test-bg-<时间戳>.log，父进程只回报 PID 与日志路径。
if (process.argv.includes('--bg')) {
  const { spawn } = await import('node:child_process');
  const args = process.argv.slice(2).filter((a) => a !== '--bg');
  const logDir = path.join(PROJECT, 'runtime');
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);   // yyyyMMddHHmmss
  const logPath = path.join(logDir, `test-bg-${stamp}.log`);
  const fd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    cwd: PROJECT, detached: true, stdio: ['ignore', fd, fd],
  });
  child.unref();
  process.stdout.write(`[test-all] 后台启动：PID=${child.pid}\n[test-all] 日志：${logPath}\n`);
  process.stdout.write(`[test-all] 结果：${path.resolve(PROJECT, 'runtime', 'test-results')}/latest.json\n`);
  process.exit(0);
}

const TEST_LOCK = acquireTestLock({ root: REPO_ROOT, label: 'test-all', tool: 'node tool/test-all.mjs' });
if (!TEST_LOCK.acquired) {
  console.error('[test-all] ⏭️  跳过：已有测试实例在跑（并发互斥，退出码 75）');
  console.error(`           持有者：${describeHolder(TEST_LOCK.holder)}`);
  console.error(`           锁文件：${TEST_LOCK.file}`);
  console.error('           如确认对方已死（崩溃残留），删掉该锁文件即可；活着的进程不会被抢占。');
  process.exit(EXIT_SKIPPED);
}
if (TEST_LOCK.tookOver) {
  const why = TEST_LOCK.pidReused ? '  ← 该 PID 已被系统复用给新进程，原持有者早已退出' : '';
  console.warn(`[test-all] ⚠ 接管陈旧锁（原持有者 ${describeHolder(TEST_LOCK.holder)}）${why}`);
}
releaseOnExit(TEST_LOCK);
// 子工具（check-console 等）继承本锁，不再重复加锁
process.env[HELD_ENV] = '1';

const SUITES = [
  // 静态契约套件（node --test + 最小 DOM 垫片，秒级、无需浏览器）：
  //   放最前——契约级回归（卸载语义/画布挂载/分派规则）一旦破了，先在这里红，
  //   不用等到跑完几十分钟的交互套件才发现。
  { name: 'renderer-contract', runner: 'node-test', file: 'test/renderer-contract.test.mjs' },
  { name: 'live2d-lifecycle', runner: 'node-test', file: 'test/live2d-lifecycle.test.mjs' },
  // VirtualFS 纯模块（注册/命中/归一化/revoke/重复注册/懒创建缓存/统计口径）：
  //   它是插件资源进渲染层的唯一通道，纯函数秒级，必须是契约级保护而非交互套件的副产品
  { name: 'vfs', runner: 'node-test', file: 'test/vfs.test.mjs' },
  // 测试单实例锁的回归：锁坏了会让**所有人**跑不了测试，属基础设施，必须有保护
  { name: 'test-lock', runner: 'node-test', file: 'test/lib/test-lock.test.mjs' },
  // api.js 的重试/退避/超时/去重：网络层是所有页面功能的入口，坏了整站都挂
  { name: 'api-retry', runner: 'node-test', file: 'test/api-retry.test.mjs' },
  // 解包产物判型纪律（假成功防线）：服务端解包链路的入口，判错会把"没文件"当"有文件"
  { name: 'unpack-filesview', runner: 'node-test', file: 'test/unpack-filesview.test.mjs' },
  // Spine 资源包插件（UnityFS 容器 → .skel/.atlas/贴图 + entry.json）：
  //   与 live2d 插件共用 fileKinds:['bundle']，判型互斥错了会互相抢单，必须有回归
  { name: 'spine-bundle-plugin', runner: 'node-test', file: 'test/spine-bundle-plugin.test.mjs' },
  // 容器条目列举（递归 / 深度与命中上限 / 多插件时 kind 置 null）：
  //   它决定"资源包能不能出现在列表里"，且 kind 一旦标错，前端会走错渲染分支
  { name: 'catalog-bundle', runner: 'node-test', file: 'test/catalog-bundle.test.mjs' },
  // 统一日志工厂（infra/log.js）的记录形状契约：纯 node、秒级，
  //   它是后续"适配层 → 分 3 批迁 stageStatus"的地基，形状一旦漂了后面全歪
  { name: 'log', runner: 'node-test', file: 'test/log.test.mjs' },
  // 清单签名比对（含「根目录不存在=稳定状态」边界；P0 回归）
  { name: 'manifest-stamp', runner: 'node-test', file: 'test/manifest-stamp.test.mjs' },
  // 插件清单校验器自己的回归（契约 §九 effects / §9.6 同口径）：
  //   检查器"报通过"时没人会再回头看它；一旦它悄悄失去检测能力，所有插件都会"看起来合法"。
  //   样本在 test/fixtures/plugin-effects/，按 A7 行断言（门禁与运行期共用一份实现）。
  { name: 'check-plugin', runner: 'node-test', file: 'test/check-plugin.test.mjs' },
  // model3 动作清单的提取与缺失过滤（bug B 回归）
  { name: 'catalog-motions', runner: 'node-test', file: 'test/catalog-motions.test.mjs' },
  // PMA 判定与兜底三态（检测不出 ⇒ 按已预乘）
  { name: 'pma-detect', runner: 'node-test', file: 'test/pma-detect.test.mjs' },
  // 模型文件抓取的可控断连重试（P0：keep-alive race）
  { name: 'fetch-retry', runner: 'node-test', file: 'test/fetch-retry.test.mjs' },
  // 纯色背景预设（T8 服务端半）：校验/落盘/自愈/备份轮转/权限，全隔离在临时目录，
  //   不起 HTTP、不碰 data/backgrounds/ 里的真实数据
  { name: 'background-solids', runner: 'node-test', file: 'test/background-solids.test.mjs' },
  // 背景来源的统一数据/渲染层（分组数据 + 选中判定 + 同色去重 + 边界）：
  //   纯函数套件、秒级。它是右边栏与底边栏**两处共用**的那一层，
  //   选中态判错会同时影响两端，所以必须有纯函数级保护
  { name: 'bg-source', runner: 'node-test', file: 'test/bg-source.test.mjs' },
  // 引擎冒烟（3.8 ↔ 4.1 版本往返 + samplePixels().ratio + lastError 判据）：
  //   它验证的是"引擎能不能出画"，是所有交互套件的前置
  { name: 'engine-b1', wait: 4500 },
  { name: 'f1-controls', wait: 4500 },
  { name: 'f2-topbar', wait: 4500 },
  { name: 'f3-reveal', wait: 4500 },
  { name: 'f4-roots', wait: 4500, needProbe: true },
  { name: 'debug-drag', wait: 5000 },
  { name: 'spine-actions', wait: 4500 },
  { name: 'panel-actions', wait: 4500 },
  { name: 'roster-actions', wait: 4500 },
  { name: 'anim-list', wait: 4500 },
];

/** 浏览器注入套件：需要真实 chrome + 页面渲染，慢且吃资源。
 *  默认**不进自动门禁** —— 自动门禁只跑 node-test（快、稳定、可在任何环境跑）。
 *  要跑它们：单套 `--only <name>`（开发时最常见的用法），或全部 `--browser`。 */
const BROWSER_SUITES = new Set([
  'engine-b1', 'f1-controls', 'f2-topbar', 'f3-reveal', 'f4-roots', 'debug-drag',
  'spine-actions', 'panel-actions', 'roster-actions', 'anim-list',
]);

/** 单套耗时估计（秒）：只为打印"预计多久"，不参与判定；取自实测均值 */
const EST_SEC = {
  'renderer-contract': 1,
  'live2d-lifecycle': 1,
  'vfs': 1,
  'test-lock': 3,
  'api-retry': 6,
  'unpack-filesview': 8,
  'manifest-stamp': 2,
  'catalog-motions': 2,
  'pma-detect': 2,
  'fetch-retry': 2,
  'background-solids': 2,
  'bg-source': 2,
  'engine-b1': 18,
  'f1-controls': 24, 'f2-topbar': 14, 'f3-reveal': 11, 'f4-roots': 13,
  'spine-actions': 62, 'panel-actions': 17, 'roster-actions': 18, 'anim-list': 34,
};

// ------------------------------------------------------------------ 变动 → 套件
//
// 为什么要按变动选套：全量 188s，其中 spine-actions(62s) + anim-list(34s) 占一半；
//   改一行 CSS 就跑全量太贵，跑太少的套又容易漏。这里按"改动落在哪个目录"选套，
//   并且**规则不确定就退回全量**——宁可多跑，不可漏跑。
//
// 规则的匹配顺序有意义（先匹配先得）：
//   · tool/** 放最前：门禁自身改动不能自己判自己，一律全量；
//   · *.css 在目录规则之前：src/web/panel/panel.css 属"样式改动"，只影响面板类套件，
//     不该因为它在 panel/ 目录下就顺带把 f2-topbar 也拉进来；
//   · 其余目录规则按你给的映射表。
const ALL = '*ALL*';
/** 哨兵：该文件不影响回归（测试脚本不在 SUITES 里时用） */
const IGNORE = '*IGNORE*';
const RULES = [
  { re: /^tool\//, suites: ALL },
  { re: /^src\/web\/main\.js$/, suites: ALL },
  { re: /^src\/web\/index\.html$/, suites: ALL },
  { re: /^src\/web\/[^/]*(?:\/.*)?\.css$/, suites: ['panel-actions', 'f1-controls'] },
  { re: /^src\/server\//, suites: ['background-solids', 'f4-roots', 'panel-actions'] },
  // panel/ 下含两处共用层（bg-source 被右边栏与底边栏同时消费）：改它必须连带跑 bg-source
  { re: /^src\/web\/panel\//, suites: ['bg-source', 'panel-actions', 'f1-controls', 'f2-topbar'] },
  { re: /^src\/web\/app\//, suites: ['f1-controls', 'f2-topbar', 'panel-actions'] },
  { re: /^src\/web\/roster\//, suites: ['roster-actions', 'f3-reveal'] },
  { re: /^src\/web\/engine\//, suites: ['spine-actions'] },
  { re: /^src\/web\/spine\//, suites: ['spine-actions'] },
  // Live2D 生命周期（unmount/dispose/上下文）由 live2d-lifecycle 专测；漏了它就是"改了却没测"
  { re: /^src\/web\/live2d\//, suites: ['live2d-lifecycle', 'anim-list', 'f2-topbar'] },
  // 渲染器契约（能力声明/mount 形状）由 renderer-contract 专测
  { re: /^src\/web\/render\//, suites: ['renderer-contract', 'spine-actions', 'anim-list', 'panel-actions'] },
  { re: /^src\/web\/infra\//, suites: ['vfs', 'spine-actions', 'anim-list', 'panel-actions'] },
  { re: /^src\/web\/debug\//, suites: ['panel-actions'] },
  // 测试脚本本身：改了哪套就跑哪套（名字不在 SUITES 里的按"无法映射"处理）
  // 静态套件的公共垫片：改它等于改两个静态套件
  { re: /^test\/helpers\//, suites: ['renderer-contract', 'live2d-lifecycle'] },
  // test/<名>.js 或 test/<名>.test.mjs：改了哪个套件就只跑哪个（静态套件同样适用）
  { re: /^test\/([^/]+?)(?:\.test)?\.m?js$/, suiteFromName: true },
  // test/manual/：手动采数/诊断脚本，**不是套件**（无断言、无 total/failed）。
  //   改它不影响回归；不忽略的话会判成"无法映射"→ 保守追加全量，白白跑 13 套。
  { re: /^test\/manual\//, suites: [] },
  // test/browser/<名>.js：浏览器注入套件已归档到此（默认不跑，见 BROWSER_SUITES）
  { re: /^test\/browser\/([^/]+?)\.js$/, suiteFromName: true },
];

/** 文档/配置类改动：不影响渲染回归（命中这些就跳过，除非显式 --all） */
const DOC_RE = /^(?:doc\/|config\/|.*\.md$|\.gitignore$|\.editorconfig$|LICENSE)/i;

/**
 * 单个文件 → 套件列表。
 * @returns {string[]|string} 套件名数组；ALL 表示全量；空数组表示"仅文档，忽略"；null 表示无法映射
 */
function mapFile(file) {
  if (DOC_RE.test(file)) return [];
  for (const rule of RULES) {
    const m = rule.re.exec(file);
    if (!m) continue;
    if (rule.suites === ALL) return ALL;
    if (rule.suiteFromName) {
      const name = m[1];
      // 测试脚本改动不影响产品：名字在 SUITES 里就跑那一套，否则**忽略**（不拖成全量）。
      //   将来新增测试脚本不该把门禁拖慢；要跑它，加进 SUITES 或用 --only。
      return EST_SEC[name] !== undefined ? [name] : IGNORE;
    }
    return rule.suites;
  }
  return null;
}

/**
 * 取"工作区未提交 + 已暂存 + 未跟踪"的全部改动文件。
 * 两个来源取并集：git status --porcelain（含 ?? 未跟踪）与 git diff --name-only HEAD。
 */
function changedFiles() {
  const files = new Set();
  // core.quotepath=false：否则中文路径被转义成 "\345\245\221…"，后面的规则全部匹配不上
  //   （本项目路径含中文，这个坑必踩）；-uall 让未跟踪目录展开成具体文件，而不是只给 "dir/"。
  const run = (args) => {
    try { return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: PROJECT, encoding: 'utf8' }); } catch { return ''; }
  };
  for (const raw of run(['status', '--porcelain', '-uall']).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    let file = line.slice(2).trim();
    if (file.includes(' -> ')) file = file.split(' -> ').pop();   // 重命名取新路径
    file = file.replace(/^"(.*)"$/, '$1');
    if (file) files.add(file);
  }
  for (const raw of run(['diff', '--name-only', 'HEAD']).split('\n')) {
    const file = raw.trim().replace(/^"(.*)"$/, '$1');
    if (file) files.add(file);
  }
  return [...files].sort();
}

/**
 * 依据改动文件算出要跑的套件，并产出"为什么这么判"的明细。
 * @param {string[]} files 改动文件（相对仓库根）
 */
function planFromFiles(files) {
  const picked = new Set();
  const rows = [];
  const unmapped = [];
  const ignored = [];
  let sawAll = false;
  for (const file of files) {
    const hit = mapFile(file);
    if (hit === null) {
      unmapped.push(file);
      rows.push({ file, label: '无法映射 → 追加全量' });
      continue;
    }
    if (hit === ALL) { sawAll = true; rows.push({ file, label: '全量' }); continue; }
    if (hit === IGNORE) { ignored.push(file); rows.push({ file, label: '不在 SUITES，忽略' }); continue; }
    if (!hit.length) { rows.push({ file, label: '仅文档/配置，忽略' }); continue; }
    hit.forEach((name) => picked.add(name));
    rows.push({ file, label: hit.join(', ') });
  }
  // --browser 才把浏览器套件纳入自动门禁；否则自动模式只跑 node-test
  const all = SUITES.map((s) => s.name).filter((n) => WANT_BROWSER || !BROWSER_SUITES.has(n));
  const suites = (sawAll || unmapped.length) ? all : all.filter((n) => picked.has(n));
  // 改了浏览器套件、但它们默认不跑 ⇒ 必须说出来。静默跳过等于"改了却没测"，
  //   而这正是本项目最想避免的那类问题（要么跑，要么明确告诉人没跑）。
  const skippedBrowser = [...picked].filter((n) => BROWSER_SUITES.has(n) && !WANT_BROWSER);
  if (skippedBrowser.length) {
    say(`[test-all] ℹ️ 命中浏览器套件但默认不跑：${skippedBrowser.join(', ')}`);
    say('[test-all]    开发时单跑：--only <名字>；要全部纳入：--browser');
  }
  return { suites, rows, unmapped, ignored, sawAll };
}

/** 打印计划（--list 与自动模式共用）：每行"文件 → 套件"，末尾一行计划 + 预计耗时 */
function printPlan(files, plan) {
  say(`[test-all] 变动 ${files.length} 个文件 → 命中 ${plan.suites.length} 套`);
  for (const row of plan.rows) say(`  ${row.file.padEnd(34)} → ${row.label}`);
  for (const f of plan.unmapped) say(`  ⚠ 无法映射：${f}（保守起见追加全量）`);
  for (const f of plan.ignored) say(`  · ${f} 不是已注册套件，忽略（如需跑请加进 SUITES 或 --only）`);
  if (!plan.suites.length) return;      // 0 套时不打空的"计划："行，由调用方给出跳过提示
  const est = plan.suites.reduce((sum, n) => sum + (EST_SEC[n] || 20), 0);
  const full = Object.values(EST_SEC).reduce((a, b) => a + b, 0);
  say(`[test-all] 计划：${plan.suites.join(', ')}（预计 ~${est}s，全量 ${full}s）`);
}

const argv = process.argv.slice(2);
const keepProfiles = argv.includes('--keep-profiles');
// --browser：把 test/browser/*.js 那批浏览器注入套件也纳入（默认不跑，见 BROWSER_SUITES 注释）
const WANT_BROWSER = argv.includes('--browser');
// --out <dir>：结果落盘目录（每套一份 JSON + run-summary.json + latest.json）
const outIdx = argv.indexOf('--out');
const OUT_DIR = outIdx >= 0 && argv[outIdx + 1]
  ? path.resolve(PROJECT, argv[outIdx + 1])
  : path.join(PROJECT, 'runtime', 'test-results');
// --bg：真后台（detached 子进程 + 输出重定向），立即返回 PID
const WANT_BG = argv.includes('--bg');
// 单套超时可用环境变量覆盖（验收"造超时场景"要用；正常不设）
const SUITE_TIMEOUT_OVERRIDE = Number(process.env.TEST_SUITE_TIMEOUT_MS || 0);
const wantAll = argv.includes('--all');
const wantList = argv.includes('--list');
const onlyIndex = argv.indexOf('--only');
const onlyArg = onlyIndex >= 0 ? String(argv[onlyIndex + 1] || '') : null;
const urlArgIndex = argv.indexOf('--url');
// --port <n>：独立测试实例的端口（默认 8899）。
//   **测试默认不走 8804**：那里跑的是用户正在看的实例，验证过程一重启就打断页面加载
//   （实测掐断过 /live2d-lib 的加载，导致渲染失败）。可选的东西没人会用，所以默认就是独立实例。
const portArgIndex = argv.indexOf('--port');
const TEST_PORT = portArgIndex >= 0 && argv[portArgIndex + 1] ? Number(argv[portArgIndex + 1]) : 8899;
/**
 * 独立测试实例的数据根（config/ data/ runtime 三处都在它下面）。
 *
 * 为什么连 config 也要分离：f4-roots 会增删资源根并写 config/resources.json，
 *   与主实例共用同一份配置就会互相覆盖（测试跑完用户的资源根就变了）。
 * 放 runtime/ 下是既有约定（测试产物一律进 runtime/，已在 .gitignore）。
 */
const TEST_DATA_ROOT = path.join(PROJECT, 'runtime', 'test-instance');
// --url 显式给了就完全按它（可指向任意实例）；否则指向独立测试实例
const BASE = urlArgIndex >= 0 && argv[urlArgIndex + 1] ? argv[urlArgIndex + 1] : `http://127.0.0.1:${TEST_PORT}/`;

// --all 与 --only 互斥（同时给等于"既想全量又想只跑几套"，语义冲突，直接拒绝）
if (wantAll && onlyArg !== null) {
  say('[test-all] ❌ --all 与 --only 互斥，请只给一个');
  process.exit(2);
}

/** 解析 --only：逗号分隔的套件名，未知名字直接报错（避免"拼错了却默默跑了别的"） */
function parseOnly(text) {
  const names = String(text).split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) {
    say('[test-all] ❌ --only 需要套件名，如 --only spine-actions,anim-list');
    process.exit(2);
  }
  const known = new Set(SUITES.map((s) => s.name));
  const bad = names.filter((n) => !known.has(n));
  if (bad.length) {
    say(`[test-all] ❌ 未知套件：${bad.join(', ')}（可用：${[...known].join(', ')}）`);
    process.exit(2);
  }
  return SUITES.map((s) => s.name).filter((n) => names.includes(n));
}

/** 决定本次跑哪些套：返回 {suites, why} */
function selectSuites() {
  if (onlyArg !== null) return { suites: parseOnly(onlyArg), why: 'only' };
  // --all = 「全部**自动门禁**套件」（即 node-test）。要连浏览器套件一起跑，再给 --browser。
  //   不加这层过滤的话 --all 会绕过 BROWSER_SUITES ⇒ 无意中跑 22 套（慢且依赖真 chrome）。
  if (wantAll) {
    return {
      suites: SUITES.map((s) => s.name).filter((n) => WANT_BROWSER || !BROWSER_SUITES.has(n)),
      why: 'all',
    };
  }
  const files = changedFiles();
  if (!files.length) return { suites: [], why: 'no-change', files };
  const plan = planFromFiles(files);
  return { suites: plan.suites, why: 'auto', files, plan };
}

function say(line) { process.stdout.write(`${line}\n`); }

/**
 * 结束本工具上一轮起的 chrome 进程。
 * 判据必须"两条同时成立"：可执行名是 chrome 系 + 参数里带我们的 profile 前缀。
 *   （只按命令行子串匹配会误杀任何"参数里恰好提到这个路径"的进程，包括调用它的脚本本身。）
 */
const CHROME_COMM = /^(chrome-headless-shell|chromium|chrome|google-chrome)/i;

function killStaleChrome() {
  let killed = 0;
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,comm=,args='], { encoding: 'utf8' });
    for (const row of out.split('\n')) {
      const m = row.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const comm = m[2] || '';
      const args = m[3] || '';
      if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) continue;
      if (!CHROME_COMM.test(path.basename(comm))) continue;   // 不是浏览器，跳过
      if (!args.includes(PROFILE_PREFIX)) continue;           // 不是我们起的，跳过
      try { process.kill(pid, 'SIGKILL'); killed += 1; } catch { /* 已退出 */ }
    }
  } catch { /* ps 不可用（非 Linux）就跳过 */ }
  return killed;
}

/** 删掉历史 profile 目录（--keep-profiles 时保留，便于事后看崩溃现场） */
function cleanProfiles() {
  let removed = 0;
  let dirs = [];
  try { dirs = fs.readdirSync('/tmp').filter((d) => d.startsWith(path.basename(PROFILE_PREFIX))); } catch { dirs = []; } // dsh-skip-residue
  for (const d of dirs) {
    const full = path.join('/tmp', d);
    if (keepProfiles) continue;
    try { fs.rmSync(full, { recursive: true, force: true }); removed += 1; } catch { /* 占用中跳过 */ } // dsh-skip-residue
  }
  return removed;
}

/** 首页可达性（服务没起就调用项目自带脚本启动） */
/**
 * 首次启动独立实例前，把主项目的 config/resources.json 复制成它的初始配置。
 * 只在目标**不存在**时复制 —— 之后测试随便改自己的 config，不回流主项目。
 * @returns {'exists'|'seeded'|'no-source'} 结果（打进日志，避免"配置哪来的"说不清）
 */
function seedTestConfig() {
  const dst = path.join(TEST_DATA_ROOT, 'config', 'resources.json');
  if (fs.existsSync(dst)) return 'exists';
  const src = path.join(PROJECT, 'config', 'resources.json');
  if (!fs.existsSync(src)) return 'no-source';
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  copyFilePortable(src, dst);
  return 'seeded';
}

async function ensureServer() {
  const probe = async () => {
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(4000) });
      return res.ok || res.status < 500;
    } catch { return false; }
  };
  if (await probe()) return 'already-up';
  if (urlArgIndex >= 0) {
    // 显式 --url：目标由调用方负责，我们只探测，不启动（更不管它）
    say(`[test-all] 服务不可达（--url 指定，不会自动启动）：${BASE}`);
    return 'unreachable';
  }
  const seeded = seedTestConfig();
  say(`[test-all] 服务未就绪，启动独立测试实例：PORT=${TEST_PORT} 数据根=${path.relative(PROJECT, TEST_DATA_ROOT)}（配置 ${seeded}）`);
  try {
    spawnSync('bash', [path.join(PROJECT, 'web.sh'), 'start'], {
      cwd: PROJECT,
      stdio: 'inherit',
      // 端口与数据根一起给：两个实例共用同一份代码，但配置/数据/运行杂物各归各
      env: { ...process.env, PORT: String(TEST_PORT), MODELSTAGE_DATA_ROOT: TEST_DATA_ROOT },
    });
  } catch { /* 交给下面的探测 */ }
  for (let i = 0; i < 20; i += 1) {
    if (await probe()) return 'started';
    await new Promise((r) => setTimeout(r, 500));
  }
  return 'unreachable';
}

/**
 * 收尾：停掉**本测试实例**（8804 上的主实例绝不触碰）。
 *
 * 只认自己的 pid 文件（在测试数据根的 runtime/ 下）：
 *   · 文件不存在 ⇒ 说明 8899 上是别人的进程（或没起过），不动
 *   · 文件存在   ⇒ 是本套起的（含上一轮残留），停掉，保证"跑完不残留"
 * @param {string} serverKind ensureServer() 的返回值
 * @returns {'stopped'|'skipped'|'failed'}
 */
function stopTestServer(serverKind) {
  if (urlArgIndex >= 0) return 'skipped';          // --url 指向外部实例，不归我们管
  if (serverKind === 'unreachable') return 'skipped';
  const pidFile = path.join(TEST_DATA_ROOT, 'runtime', 'model-stage-web.pid');
  if (!fs.existsSync(pidFile)) return 'skipped';   // 不是我们起的
  try {
    const r = spawnSync('bash', [path.join(PROJECT, 'web.sh'), 'stop'], {
      cwd: PROJECT,
      stdio: 'inherit',
      env: { ...process.env, PORT: String(TEST_PORT), MODELSTAGE_DATA_ROOT: TEST_DATA_ROOT },
    });
    return r.status === 0 ? 'stopped' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * 跑一套；"没产出结构化结果"（chrome 冷启动偶发挂住、被上一轮残留影响）时重试一次，
 *   避免把一次环境抖动当成回归失败。
 */
function runSuiteWithRetry(suite) {
  const first = runSuite(suite);
  if (first.missing || first.failed !== null) return first;
  say(`  ${suite.name.padEnd(16)} ⚠ 未产出结果，重试一次（超时/环境抖动）`);
  return runSuite(suite);
}

/**
 * 跑一个 node --test 静态套件，从 TAP 输出里取 pass/fail。
 * @param {{name: string, file: string}} suite
 * @returns {{name: string, failed: number|null, total: number|null, problems: number, ms: number, failing: string[], raw: string}}
 */
function runNodeTestSuite(suite) {
  const file = path.join(PROJECT, suite.file);
  if (!fs.existsSync(file)) return { name: suite.name, missing: true };
  const started = Date.now();
  const res = spawnSync(process.execPath, ['--test', file], {
    cwd: PROJECT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: SUITE_TIMEOUT_MS,
  });
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  const pass = /^# pass (\d+)$/m.exec(out);
  const fail = /^# fail (\d+)$/m.exec(out);
  const total = pass || fail ? Number(pass ? pass[1] : 0) + Number(fail ? fail[1] : 0) : null;
  // 失败用例名：TAP 的 "not ok N - 名字"
  const failing = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  return {
    name: suite.name,
    failed: fail ? Number(fail[1]) : null,
    total,
    problems: 0,
    ms: Date.now() - started,
    failing,
    raw: out,
    stderrTail: (res.stderr || '').trim().split('\n').slice(-3).join(' | ').slice(0, 300),
    status: res.status,
    signal: res.signal || null,
  };
}

function runSuite(suite) {
  // 静态契约套件：`node --test <file>`，从 TAP 汇总行解析 pass/fail（无浏览器、无服务依赖）
  if (suite.runner === 'node-test') return runNodeTestSuite(suite);
  const script = path.join(PROJECT, 'test', 'browser', `${suite.name}.js`);
  if (!fs.existsSync(script)) return { name: suite.name, missing: true };
  let url = BASE;
  if (suite.needProbe) {
    // f4 会真的写资源根：探针目录必须存在（且不用隐藏目录，/api/browse 不列点开头目录）
    const probeDir = path.join(PROJECT, 'runtime', 'f4probe');
    fs.mkdirSync(probeDir, { recursive: true });
    url = `${BASE}?f4probe=${encodeURIComponent(probeDir)}`;
  }
  const started = Date.now();
  // 结果走文件而不是 stdout：本机（SMB 挂载 + 管道捕获）实测 stdout 偶发丢输出 ——
  //   同一条命令连跑四次，两次 0 字节、一次尾部少 3 字节，退出码都是 0，
  //   于是被判成"没产出结构化结果"的假失败。--out 让子进程同步把 JSON 落盘，读文件才确定。
  const outFile = path.join(PROJECT, 'runtime', 'test-results', `.cc-${suite.name}.json`);
  try { fs.rmSync(outFile, { force: true }); } catch { /* 不存在即可 */ }
  const res = spawnSync(process.execPath, [
    path.join(PROJECT, 'tool', 'check-console.mjs'), url,
    '--wait', String(suite.wait), '--json', '--script', script, '--out', outFile,
  ], { cwd: PROJECT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: SUITE_TIMEOUT_MS });

  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { parsed = null; }
  if (!parsed) { try { parsed = JSON.parse(res.stdout); } catch { parsed = null; } }
  try { fs.rmSync(outFile, { force: true }); } catch { /* 清理失败不影响结果 */ }
  // scriptResult 有两种形态：多数套件返回 JSON 字符串，engine-b1 直接返回对象。
  //   只认字符串会让对象形态被判成"没产出结果"（曾经的 failed=null 假失败）。
  let result = null;
  const sr = parsed && parsed.scriptResult;
  if (sr && typeof sr === 'object') result = sr;
  else if (typeof sr === 'string') { try { result = JSON.parse(sr); } catch { result = null; } }
  return {
    name: suite.name,
    failed: result ? result.failed : null,
    total: result ? result.total : null,
    problems: parsed ? parsed.problemCount : null,
    ms: Date.now() - started,
    failing: (result && result.results ? result.results.filter((r) => !r.ok).map((r) => r.name) : []),
    // 失败明细（断言名 + 实际值）：只留断言名时，排障还得再跑一遍才知道 actual 是什么
    failingDetail: (result && result.results
      ? result.results.filter((r) => !r.ok).map((r) => ({ name: r.name, actual: r.actual, expect: r.expect }))
      : []),
    // skip（环境缺数据）与 fail 分开：skip 不计入 failed，但必须在终端/落盘/汇总三处可见，
    //   否则"整套都跳过"会看起来像通过 —— 那是最危险的状态（一条都没验证）
    skipped: (result && typeof result.skipped === 'number')
      ? result.skipped
      : (result && result.results ? result.results.filter((r) => r.skipped === true).length : 0),
    // 各套件的记录字段名不统一（browser 侧用 name/sel/actual，engine-b1 用 step/error）⇒ 两者都认
    skippedDetail: (result && result.results
      ? result.results.filter((r) => r.skipped === true)
        .map((r) => ({ name: r.name || r.step || '(未命名)', reason: r.actual || r.error || '' }))
      : []),
    // 「声明式跳过」：套件自己声明了前置条件（如列表可滚高度不足），并给出原因。
    //   与「意外全跳过」必须分开：前者是环境不达标（算通过但标注未验证），
    //   后者是退化信号（一条都没验证，必须红）。
    declaredSkipReason: (result && result.summary && result.summary.skipReason)
      || (result && result.skipReason) || '',
    raw: res.stdout,
    // 没产出结果时把 stderr 尾巴带出来：否则只看到 failed=null，不知道是 chrome 起不来还是脚本炸了
    stderrTail: (res.stderr || '').trim().split('\n').slice(-4).join(' | ').slice(0, 400),
    status: res.status,
    signal: res.signal || null,
  };
}

// ---------------------------------------------------------------- 先定"跑哪些"，再动手
//
// 顺序很关键：--list 必须**只打印、不产生副作用**（不起 chrome、不启服务、不删 profile），
//   否则"看一眼会跑什么"这件事本身就要花掉几十秒环境准备。
const selection = selectSuites();

if (selection.why === 'auto' && selection.files) printPlan(selection.files, selection.plan);

if (!selection.suites.length) {
  // 无改动 / 仅文档配置改动：不跑任何套，但**退出码 0**（这是正常的"没什么要验"）
  const ignoredOnly = selection.plan && selection.plan.ignored && selection.plan.ignored.length;
  const hint = selection.why === 'no-change'
    ? '工作区无改动，跳过回归（需要时用 --all）'
    : (ignoredOnly ? '仅未注册的测试脚本变动，跳过回归（需要时用 --all 或 --only）'
      : '仅文档/配置变动，跳过回归（需要时用 --all）');
  say(`[test-all] ${hint}`);
  process.exit(0);
}

if (wantList) {
  say(`[test-all] --list：共 ${selection.suites.length} 套（未实际运行）`);
  process.exit(0);
}

const CHOSEN = SUITES.filter((s) => selection.suites.includes(s.name));

const report = {
  base: BASE,
  killedChrome: killStaleChrome(),
  removedProfiles: cleanProfiles(),
  server: null,
  suites: [],
  ok: true,
};

report.server = await ensureServer();
if (report.server === 'unreachable') {
  report.ok = false;
  say(`[test-all] ❌ 服务不可达：${BASE}`);
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 800)); // 刚杀过 chrome，给句柄/锁一点收敛时间
say(`[test-all] 服务=${report.server} · 清理 chrome=${report.killedChrome} 个 · 清理 profile=${report.removedProfiles} 个`);
// 结果落盘：开一轮（写 run-summary.json 且 running=true，跑完置 false）
const runStartedAt = new Date().toISOString();
const RUN = openRun({ outRoot: OUT_DIR, base: BASE, suites: CHOSEN.map((x) => x.name), startedAt: runStartedAt });
say(`[test-all] 结果目录：${RUN.dir}`);

for (const suite of CHOSEN) {
  const memAtStart = memAvailableMB();
  const r = runSuiteWithRetry(suite);
  report.suites.push(r);
  // 结局分类：真失败 / 超时被杀 / 无结果 —— 三者不能混为一谈（超时曾被当"红"报，浪费排查时间）
  const outcome = classifyOutcome({ result: r.failed === null ? null : { failed: r.failed }, status: r.status, signal: r.signal, ms: r.ms, limitMs: SUITE_TIMEOUT_MS });
  r.outcome = outcome.status;
  if (outcome.hint) r.outcomeHint = outcome.hint;
  r.memAtStart = memAtStart;
  r.memAtEnd = memAvailableMB();
  r.limitMs = SUITE_TIMEOUT_MS;
  r.stdoutTail = tailLines(r.raw, 200);
  delete r.raw;                       // 原文进 stdoutTail 就够，避免 JSON 里塞几十 MB
  try {
    writeSuiteResult(RUN.dir, {
      suite: r.name,
      startedAt: new Date(Date.now() - r.ms).toISOString(),
      finishedAt: new Date().toISOString(),
      ms: r.ms, failed: r.failed, total: r.total, problems: r.problems,
      // skip 必须落盘（含每条原因），否则"跳过"在下一次排查时完全不可见
      skipped: Number(r.skipped) || 0,
      skippedDetail: r.skippedDetail || [],
      allSkipped: Number(r.total) > 0 && Number(r.skipped) === Number(r.total),
      failing: r.failing || [], failingDetail: r.failingDetail || [],
      exitCode: r.status, signal: r.signal || null,
      outcome: r.outcome, outcomeHint: r.outcomeHint || '',
      limitMs: r.limitMs, memAtStart: r.memAtStart, memAtEnd: r.memAtEnd,
      stdoutTail: r.stdoutTail,
    });
    updateSummary(RUN.summaryPath, { suites: report.suites.map((x) => ({
      suite: x.name, outcome: x.outcome, ms: x.ms, failed: x.failed, total: x.total,
      skipped: Number(x.skipped) || 0,
      allSkipped: Number(x.total) > 0 && Number(x.skipped) === Number(x.total),
      problems: x.problems, memAtStart: x.memAtStart, memAtEnd: x.memAtEnd,
    })) });
  } catch (e) {
    say(`[test-all] ⚠ 落盘失败（不影响测试结论）：${e && e.message}`);
  }
  if (r.missing) { report.ok = false; say(`  ${r.name.padEnd(16)} ❌ 脚本缺失`); continue; }
  if (r.failed === null) {
    say(`  ${r.name.padEnd(16)} ⚠ 无结构化结果（status=${r.status} stdout=${(r.raw || '').length}B）`
      + ` stdout头=${String(r.raw || '').slice(0, 120).replace(/\n/g, ' ')} stderr: ${r.stderrTail || '（空）'}`);
  }
  // 只有真失败/无结果算"红"；超时被杀单独标注（它也是红，但原因不同，要一眼看出来）
  const bad = r.failed === null || r.failed > 0;
  if (bad) report.ok = false;
  // 「整套都跳过」= 一条都没验证：**不能静默变绿**（曾经 13 条退化成 1 条 skipped 而全场以为通过）
  //   但要区分两种情况，否则会把"环境数据不达标"误判成红：
  //     · 声明式跳过（套件给出 skipReason，如"列表可滚高度 0px，不满足前提"）⇒ 算通过，但必须显式标注未验证
  //     · 意外全跳过（没有原因）⇒ 仍是红，这是退化信号
  const allSkipped = Number(r.total) > 0 && Number(r.skipped) === Number(r.total);
  const declaredSkip = allSkipped && !!r.declaredSkipReason;
  if (allSkipped && !declaredSkip) report.ok = false;
  if (r.outcomeHint) say(`      ⚠ ${r.outcome}：${r.outcomeHint}`);
  const skipTag = allSkipped ? '（全部 skip）' : (r.skipped > 0 ? `（skip ${r.skipped}）` : '');
  say(`  ${r.name.padEnd(16)} ${bad || (allSkipped && !declaredSkip) ? '❌' : (declaredSkip ? '⚠️' : '✅')} failed=${r.failed} total=${r.total} problems=${r.problems} ${r.ms}ms${skipTag}`
    + (r.failing.length ? `\n      未通过：${r.failing.join(' / ')}` : '')
    + ((r.failingDetail || []).map((d) => `\n         · ${d.name}\n           actual: ${String(d.actual).slice(0, 220)}\n           expect: ${String(d.expect).slice(0, 160)}`).join(''))
    + (declaredSkip ? `\n       ⚠️ 未验证（声明式跳过）：${r.declaredSkipReason}` : '')
    + (allSkipped && !declaredSkip ? `\n       🚨 本套件实际未验证：${r.total} 条全部被 skip 且未声明原因（环境缺数据或套件退化，不是代码通过）` : ''));
}

const totalSkipped = report.suites.reduce((n, x) => n + (Number(x.skipped) || 0), 0);
const allSkippedSuites = report.suites
  .filter((x) => Number(x.total) > 0 && Number(x.skipped) === Number(x.total))
  .map((x) => x.name);
if (totalSkipped > 0) {
  say(`[test-all] ⏭ 跳过 ${totalSkipped} 条（环境缺数据，不计失败）`
    + (allSkippedSuites.length ? `；🚨 整套未验证：${allSkippedSuites.join(', ')}` : ''));
}
say(`\n[test-all] ${report.ok ? '✅ 全部通过' : '❌ 存在失败'}（${report.suites.length} 套）`
  + (allSkippedSuites.length ? ` ｜ ⚠ 有 ${allSkippedSuites.length} 套实际未验证` : ''));
finishRun({ outRoot: OUT_DIR, dir: RUN.dir, summaryPath: RUN.summaryPath, exitCode: report.ok ? 0 : 1 });
say(`[test-all] 结果：${path.join(OUT_DIR, 'latest.json')}`);
// 收尾：停掉本次起的测试实例（8804 主实例不在管理范围内）
say(`[test-all] 测试实例收尾：${stopTestServer(report.server)}`);
process.exit(report.ok ? 0 : 1);
