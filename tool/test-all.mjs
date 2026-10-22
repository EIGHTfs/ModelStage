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
  { name: 'f1-controls', wait: 4500 },
  { name: 'f2-topbar', wait: 4500 },
  { name: 'f3-reveal', wait: 4500 },
  { name: 'f4-roots', wait: 4500, needProbe: true },
  { name: 'spine-actions', wait: 4500 },
  { name: 'panel-actions', wait: 4500 },
  { name: 'roster-actions', wait: 4500 },
];

const argv = process.argv.slice(2);
const keepProfiles = argv.includes('--keep-profiles');
const urlArgIndex = argv.indexOf('--url');
const BASE = urlArgIndex >= 0 && argv[urlArgIndex + 1] ? argv[urlArgIndex + 1] : 'http://127.0.0.1:8804/';

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

function runSuite(suite) {
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
  let result = null;
  try { result = parsed && parsed.scriptResult ? JSON.parse(parsed.scriptResult) : null; } catch { result = null; }
  return {
    name: suite.name,
    failed: result ? result.failed : null,
    total: result ? result.total : null,
    problems: parsed ? parsed.problemCount : null,
    ms: Date.now() - started,
    failing: (result && result.results ? result.results.filter((r) => !r.ok).map((r) => r.name) : []),
    raw: res.stdout,
  };
}

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
for (const suite of SUITES) {
  const r = runSuiteWithRetry(suite);
  report.suites.push(r);
  if (r.missing) { report.ok = false; say(`  ${r.name.padEnd(16)} ❌ 脚本缺失`); continue; }
  const bad = r.failed === null || r.failed > 0;
  if (bad) report.ok = false;
  say(`  ${r.name.padEnd(16)} ${bad ? '❌' : '✅'} failed=${r.failed} total=${r.total} problems=${r.problems} ${r.ms}ms`
    + (r.failing.length ? `\n      未通过：${r.failing.join(' / ')}` : ''));
}

say(`\n[test-all] ${report.ok ? '✅ 全部通过' : '❌ 存在失败'}（${report.suites.length} 套）`);
process.exit(report.ok ? 0 : 1);
