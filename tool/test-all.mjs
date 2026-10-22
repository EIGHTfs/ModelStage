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

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// 必须用 fileURLToPath：项目路径含中文/空格，URL.pathname 是百分号编码，直接当路径会找不到文件
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const PROFILE_PREFIX = '/tmp/check-console-profile-';
/** 单套超时：正常一套 10～60s，180s 足够；超时视为"未产出结果"并重试一次 */
const SUITE_TIMEOUT_MS = 180000;

/** 套件清单：顺序固定（从"接线自检"到"重交互回归"） */
const SUITES = [
  // 静态契约套件（node --test + 最小 DOM 垫片，秒级、无需浏览器）：
  //   放最前——契约级回归（卸载语义/画布挂载/分派规则）一旦破了，先在这里红，
  //   不用等到跑完几十分钟的交互套件才发现。
  { name: 'renderer-contract', runner: 'node-test', file: 'test/renderer-contract.test.mjs' },
  { name: 'live2d-lifecycle', runner: 'node-test', file: 'test/live2d-lifecycle.test.mjs' },
  // 引擎冒烟（3.8 ↔ 4.1 版本往返 + samplePixels().ratio + lastError 判据）：
  //   它验证的是"引擎能不能出画"，是所有交互套件的前置
  { name: 'engine-b1', wait: 4500 },
  { name: 'f1-controls', wait: 4500 },
  { name: 'f2-topbar', wait: 4500 },
  { name: 'f3-reveal', wait: 4500 },
  { name: 'f4-roots', wait: 4500, needProbe: true },
  { name: 'spine-actions', wait: 4500 },
  { name: 'panel-actions', wait: 4500 },
  { name: 'roster-actions', wait: 4500 },
  { name: 'anim-list', wait: 4500 },
];

/** 单套耗时估计（秒）：只为打印"预计多久"，不参与判定；取自实测均值 */
const EST_SEC = {
  'renderer-contract': 1,
  'live2d-lifecycle': 1,
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
  { re: /^src\/server\//, suites: ['f4-roots', 'panel-actions'] },
  { re: /^src\/web\/panel\//, suites: ['panel-actions', 'f1-controls', 'f2-topbar'] },
  { re: /^src\/web\/app\//, suites: ['f1-controls', 'f2-topbar', 'panel-actions'] },
  { re: /^src\/web\/roster\//, suites: ['roster-actions', 'f3-reveal'] },
  { re: /^src\/web\/engine\//, suites: ['spine-actions'] },
  { re: /^src\/web\/spine\//, suites: ['spine-actions'] },
  { re: /^src\/web\/live2d\//, suites: ['anim-list', 'f2-topbar'] },
  { re: /^src\/web\/render\//, suites: ['spine-actions', 'anim-list', 'panel-actions'] },
  { re: /^src\/web\/infra\//, suites: ['spine-actions', 'anim-list', 'panel-actions'] },
  { re: /^src\/web\/debug\//, suites: ['panel-actions'] },
  // 测试脚本本身：改了哪套就跑哪套（名字不在 SUITES 里的按"无法映射"处理）
  // 静态套件的公共垫片：改它等于改两个静态套件
  { re: /^test\/helpers\//, suites: ['renderer-contract', 'live2d-lifecycle'] },
  // test/<名>.js 或 test/<名>.test.mjs：改了哪个套件就只跑哪个（静态套件同样适用）
  { re: /^test\/([^/]+?)(?:\.test)?\.m?js$/, suiteFromName: true },
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
  const all = SUITES.map((s) => s.name);
  const suites = (sawAll || unmapped.length) ? all : all.filter((n) => picked.has(n));
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
const wantAll = argv.includes('--all');
const wantList = argv.includes('--list');
const onlyIndex = argv.indexOf('--only');
const onlyArg = onlyIndex >= 0 ? String(argv[onlyIndex + 1] || '') : null;
const urlArgIndex = argv.indexOf('--url');
const BASE = urlArgIndex >= 0 && argv[urlArgIndex + 1] ? argv[urlArgIndex + 1] : 'http://127.0.0.1:8804/';

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
  if (wantAll) return { suites: SUITES.map((s) => s.name), why: 'all' };
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
  try { dirs = fs.readdirSync('/tmp').filter((d) => d.startsWith(path.basename(PROFILE_PREFIX))); } catch { dirs = []; }
  for (const d of dirs) {
    const full = path.join('/tmp', d);
    if (keepProfiles) continue;
    try { fs.rmSync(full, { recursive: true, force: true }); removed += 1; } catch { /* 占用中跳过 */ }
  }
  return removed;
}

/** 首页可达性（服务没起就调用项目自带脚本启动） */
async function ensureServer() {
  const probe = async () => {
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(4000) });
      return res.ok || res.status < 500;
    } catch { return false; }
  };
  if (await probe()) return 'already-up';
  say(`[test-all] 服务未就绪，调用 web.sh start：${BASE}`);
  try { spawnSync('bash', [path.join(PROJECT, 'web.sh'), 'start'], { cwd: PROJECT, stdio: 'inherit' }); } catch { /* 交给下面的探测 */ }
  for (let i = 0; i < 20; i += 1) {
    if (await probe()) return 'started';
    await new Promise((r) => setTimeout(r, 500));
  }
  return 'unreachable';
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
  };
}

function runSuite(suite) {
  // 静态契约套件：`node --test <file>`，从 TAP 汇总行解析 pass/fail（无浏览器、无服务依赖）
  if (suite.runner === 'node-test') return runNodeTestSuite(suite);
  const script = path.join(PROJECT, 'test', `${suite.name}.js`);
  if (!fs.existsSync(script)) return { name: suite.name, missing: true };
  let url = BASE;
  if (suite.needProbe) {
    // f4 会真的写资源根：探针目录必须存在（且不用隐藏目录，/api/browse 不列点开头目录）
    const probeDir = path.join(PROJECT, 'runtime', 'f4probe');
    fs.mkdirSync(probeDir, { recursive: true });
    url = `${BASE}?f4probe=${encodeURIComponent(probeDir)}`;
  }
  const started = Date.now();
  const res = spawnSync(process.execPath, [
    path.join(PROJECT, 'tool', 'check-console.mjs'), url,
    '--wait', String(suite.wait), '--json', '--script', script,
  ], { cwd: PROJECT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: SUITE_TIMEOUT_MS });

  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch { parsed = null; }
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
    raw: res.stdout,
    // 没产出结果时把 stderr 尾巴带出来：否则只看到 failed=null，不知道是 chrome 起不来还是脚本炸了
    stderrTail: (res.stderr || '').trim().split('\n').slice(-4).join(' | ').slice(0, 400),
    status: res.status,
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
for (const suite of CHOSEN) {
  const r = runSuiteWithRetry(suite);
  report.suites.push(r);
  if (r.missing) { report.ok = false; say(`  ${r.name.padEnd(16)} ❌ 脚本缺失`); continue; }
  if (r.failed === null) {
    say(`  ${r.name.padEnd(16)} ⚠ 无结构化结果（status=${r.status} stdout=${(r.raw || '').length}B）`
      + ` stdout头=${String(r.raw || '').slice(0, 120).replace(/\n/g, ' ')} stderr: ${r.stderrTail || '（空）'}`);
  }
  const bad = r.failed === null || r.failed > 0;
  if (bad) report.ok = false;
  say(`  ${r.name.padEnd(16)} ${bad ? '❌' : '✅'} failed=${r.failed} total=${r.total} problems=${r.problems} ${r.ms}ms`
    + (r.failing.length ? `\n      未通过：${r.failing.join(' / ')}` : ''));
}

say(`\n[test-all] ${report.ok ? '✅ 全部通过' : '❌ 存在失败'}（${report.suites.length} 套）`);
process.exit(report.ok ? 0 : 1);
