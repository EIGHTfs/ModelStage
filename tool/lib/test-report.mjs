// tool/lib/test-report.mjs —— 回归结果落盘（每套一份 JSON + 本轮汇总 + latest 指针）
//
// 为什么需要：以前跑完只看终端汇总，跑挂/超时后想回溯"哪套、什么错、当时内存多少"就得整轮重跑。
//   落盘后 AI 只读 `runtime/test-results/latest.json` 一个入口就能拿到全部结果。
//
// 一个关键能力：**把"真失败"和"超时被杀"分开**。
//   套件被 SIGKILL 时 failed/total 都是 null，以前会被报成"红"（假红），
//   实际情况是"跑太久被砍"。这类必须单独标出来，否则会让人去查根本不该查的业务代码。

import fs from 'node:fs';
import path from 'node:path';

/** 读系统可用内存（MB）；拿不到返回 null（非 Linux 或 /proc 不可读） */
export function memAvailableMB() {
  try {
    // dsh-skip-quality 只读 /proc/meminfo（约 1~2KB 的固定格式伪文件），memory-bomb 不适用
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(txt);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

/** 时间戳目录名：yyyyMMdd-HHmmss（本地时区，便于人对号） */
export function runStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${
    p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** 取文本尾巴（行数上限），用于 stdoutTail/stderrTail 诊断 */
export function tailLines(text, maxLines = 200) {
  const lines = String(text || '').split('\n');
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

/**
 * 判定一套的结局。**这是"超时 vs 真失败"的唯一判据**。
 *
 * @param {{result: object|null, status: number|null, signal: string|null, ms: number, limitMs: number}} p
 * @returns {{status: string, hint: string}}
 *   ok                 有结构化结果且 failed=0
 *   failed             有结构化结果且 failed>0（真断言失败）
 *   killed-by-timeout  没结果且被信号杀掉/退出码异常，且耗时≥上限（超时，不是断言失败）
 *   no-result          没结果但不是超时（脚本崩、chrome 起不来、输出不是 JSON…）
 */
export function classifyOutcome({ result, status, signal, ms, limitMs }) {
  if (result && Number.isFinite(result.failed)) {
    return result.failed > 0
      ? { status: 'failed', hint: `${result.failed} 项断言未通过` }
      : { status: 'ok', hint: '' };
  }
  const nearLimit = Number.isFinite(limitMs) && ms >= limitMs * 0.9;
  if (signal === 'SIGKILL' || status === 2 || (nearLimit && !result)) {
    const how = signal ? `被 ${signal} 杀掉` : `退出码 ${status}`;
    return {
      status: 'killed-by-timeout',
      hint: `套件跑了 ${ms}ms，接近/超过上限 ${limitMs}ms，${how} —— 提高超时或查它为什么慢（不是断言失败）`,
    };
  }
  return { status: 'no-result', hint: `没产出结构化结果（exitCode=${status}），看 stdoutTail/stderrTail` };
}

/** 递归建目录并写 JSON（原子写：先写 .tmp 再 rename，避免读到半个文件） */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** 一套的落盘文件名（套件名已限定为 kebab-case，直接当文件名安全） */
function suiteFile(dir, suiteName) {
  return path.join(dir, `${suiteName}.json`);
}

/**
 * 开一轮：建目录、写初始汇总（running=true）。
 * @param {{outRoot: string, base: string, suites: string[], startedAt: string}} p
 * @returns {{dir: string, summaryPath: string}}
 */
export function openRun({ outRoot, base, suites, startedAt }) {
  const dir = path.join(outRoot, runStamp());
  fs.mkdirSync(dir, { recursive: true });
  const summaryPath = path.join(dir, 'run-summary.json');
  writeJson(summaryPath, {
    startedAt,
    finishedAt: null,
    running: true,          // 跑完置 false —— 外部可据此判断"还在跑吗"
    exitCode: null,
    base,
    plannedSuites: suites,
    suites: [],
    env: { memAvailableMBAtStart: memAvailableMB(), node: process.version, pid: process.pid },
  });
  return { dir, summaryPath };
}

/** 单套写盘（每套跑完立刻写，后台跑中途被杀也留得下已跑部分） */
export function writeSuiteResult(dir, entry) {
  writeJson(suiteFile(dir, entry.suite), entry);
}

/** 更新汇总（每套跑完调一次，保证 running=true 期间也能看到进度） */
export function updateSummary(summaryPath, patch) {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); } catch { prev = {}; }
  writeJson(summaryPath, { ...prev, ...patch });
}

/**
 * 收尾：写 finishedAt/exitCode/running=false，并把 `latest.json` 指过来。
 * latest 里只放"去哪读"，避免同一份数据写两处后漂移。
 */
export function finishRun({ outRoot, dir, summaryPath, exitCode }) {
  updateSummary(summaryPath, {
    finishedAt: new Date().toISOString(),
    running: false,
    exitCode,
    env: { ...(readJson(summaryPath, {}).env || {}), memAvailableMBAtEnd: memAvailableMB() },
  });
  writeJson(path.join(outRoot, 'latest.json'), {
    run: path.basename(dir),
    summary: path.relative(outRoot, summaryPath),
    finishedAt: new Date().toISOString(),
  });
}

/** 读 JSON（失败返回默认值） */
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
