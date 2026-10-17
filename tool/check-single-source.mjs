#!/usr/bin/env node
// tool/check-single-source.mjs —— 门禁：前端业务代码禁止直调"单路扫描接口"
//
// 背景（现场证据，不是抽象原则）：
//   左栏「碧蓝航线」是**同名根合并节点** = azurlane(119 live2d) + azurlane_spine(194 spine) + azurlane_bundle(19)
//   ⇒ 树上共 332 个变体
//   ⇒ 任何"按单个 rootId 取清单"的写法（/api/spine/models?root=… 或 /api/live2d/models?root=…）
//     都只能拿到其中一份
//   ⇒ 表现：树上有 332 个变体，翻页却说"这个根没有可用模型"
//
// 规则：src/web 下的**业务代码**只能通过 /api/catalog 拿"某个根/某个游戏下的模型"。
//       /api/catalog 内部已合并 spine + live2d + 容器类条目，是唯一正确来源。
// 例外：诊断探针与测试脚本可以用单路接口 —— 它们的目的正是分别验证两个扫描器
//       （走 catalog 反而看不到单路细节）。所以在下面的排除清单里显式登记。
//
// 为什么不用 grep -v 反向过滤这类做法：
//   它会把**同一行里同时出现新名与旧名**的代码一起放过（我第一版就踩了：一行里既有
//   spine 单路路径也有 live2d 单路路径时，整行被过滤掉 ⇒ 假阴性）。
//   所以这里先做**注释剥离**（保留字符串内容与行号），再用正向匹配逐条报出。
//
// 用法：
//   node tool/check-single-source.mjs            # 检查（失败退出码 1）
//   node tool/check-single-source.mjs --json     # 机器可读输出
// 该脚本也被 tool/test-all.mjs 作为**前置检查**调用（失败即中止，不占回归套件名额）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 项目根：与 tool/test-all.mjs 用同一个推导方式（dirname(本文件)/..），不引入第二套约定
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 扫描根目录（相对项目根） */
const SCAN_ROOT = 'src/web';

/**
 * 排除目录（显式列出，新增必须写理由）：
 *   src/web/debug/** —— 调试面板/HUD 的职责就是看单路细节，允许直调。
 */
const EXCLUDE_DIRS = ['src/web/debug/'];

/**
 * 排除文件（显式列出，新增必须写理由）。
 * 目前为空：当前没有任何业务文件需要直调单路接口。
 */
const EXCLUDE_FILES = [];

/** 被禁止的单路接口 + 已改名的旧路径（旧路径留着是为了让"误用历史名"也报出来） */
const BANNED = [
  { re: /\/api\/spine\/models/g, name: '/api/spine/models' },
  { re: /\/api\/live2d\/models/g, name: '/api/live2d/models' },
  { re: /\/api\/models(?![\/\w-])/g, name: '/api/models（旧名，已改名 /api/spine/models）' },
];

/** 只扫这些后缀 */
const EXT = new Set(['.js', '.mjs']);

/**
 * 把注释替换成空格（保留换行 ⇒ 行号不变），保留字符串内容。
 *
 * 为什么要自己扫而不是正则删注释：'http://x' 这类字符串 里的双斜杠、块注释起始符出现在字符串里，
 *   用正则删会误删真实代码；反过来又会把注释里的路径当代码报出来
 *   —— 而 transport-actions.js 那段注释**故意**写着旧路径作为历史教训，必须豁免。
 * @param {string} src
 * @returns {string} 等长文本（注释字符替换成空格，换行保留）
 */
/** 把 [from, to) 区间抹成空格（保留换行 ⇒ 行号不变） */
function blankRange(chars, from, to) {
  for (let k = from; k < to && k < chars.length; k += 1) if (chars[k] !== '\n') chars[k] = ' ';
}

/** 行注释：抹到行尾（不含换行），返回新的 i */
function skipLineComment(src, chars, i) {
  while (i < src.length && src[i] !== '\n') { blankRange(chars, i, i + 1); i += 1; }
  return i;
}

/** 块注释：抹到块注释结束符之后，返回新的 i（未闭合则抹到文末） */
function skipBlockComment(src, chars, i) {
  while (i < src.length) {
    if (src[i] === '*' && src[i + 1] === '/') { blankRange(chars, i, i + 2); return i + 2; }
    blankRange(chars, i, i + 1); i += 1;
  }
  return i;
}

/** 字符串/模板字面量：跳过转义与结束引号（内容保持原样，路径就在字符串里） */
function skipString(src, i, quote) {
  i += 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

const QUOTE_CHARS = new Set([String.fromCharCode(39), String.fromCharCode(34), String.fromCharCode(96)]);  // 单引号 / 双引号 / 反引号

/**
 * 把注释替换成空格（保留换行 ⇒ 行号不变），保留字符串内容。
 *
 * 为什么要自己扫而不是正则删注释：'http://x' 这类字符串 里的双斜杠、块注释起始符出现在字符串里，
 *   用正则删会误删真实代码；反过来又会把注释里的路径当代码报出来
 *   —— 而 transport-actions.js 那段注释**故意**写着旧路径作为历史教训，必须豁免。
 * @param {string} src
 * @returns {string} 等长文本（注释字符替换成空格，换行保留）
 */
export function stripComments(src) {
  const chars = src.split('');
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = skipLineComment(src, chars, i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = skipBlockComment(src, chars, i); continue; }
    if (QUOTE_CHARS.has(c)) { i = skipString(src, i, c); continue; }
    i += 1;
  }
  return chars.join('');
}

/** 递归收集待检查文件 */
function collect(dir, acc = []) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const it of items) {
    const abs = path.join(dir, it.name);
    const rel = path.relative(PROJECT, abs).split(path.sep).join('/');
    if (it.isDirectory()) {
      if (EXCLUDE_DIRS.some((d) => `${rel}/`.startsWith(d))) continue;
      collect(abs, acc);
    } else if (EXT.has(path.extname(it.name))) {
      if (EXCLUDE_FILES.includes(rel)) continue;
      acc.push({ abs, rel });
    }
  }
  return acc;
}

/**
 * 执行检查。
 * @returns {{ok:boolean, violations:Array<{file:string,line:number,api:string,code:string}>}}
 */
export function checkSingleSource() {
  const files = collect(path.join(PROJECT, SCAN_ROOT));
  const violations = [];
  for (const f of files) {
    let raw = '';
    try { raw = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    const code = stripComments(raw);              // 注释已抹成空格，字符串保留
    const lines = raw.split('\n');
    const codeLines = code.split('\n');
    for (const banned of BANNED) {
      banned.re.lastIndex = 0;
      let m;
      while ((m = banned.re.exec(code)) !== null) {
        const line = code.slice(0, m.index).split('\n').length;
        violations.push({
          file: f.rel,
          line,
          api: banned.name,
          code: (lines[line - 1] || codeLines[line - 1] || '').trim().slice(0, 120),
        });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/** 人类可读输出（失败时给出**可直接照做的解法**） */
export function formatViolations(violations) {
  const out = [];
  out.push('❌ 前端业务代码禁止调用单路扫描接口（只能走 /api/catalog）：');
  for (const v of violations) {
    out.push(`   ${v.file}:${v.line}  调用了 ${v.api}`);
    out.push(`     → ${v.code}`);
    out.push('     → 要"某个根/某个游戏下的全部模型"请用 /api/catalog（内部已合并 spine+live2d+容器）');
    out.push('     → 若确实只需要某一种渲染器，在服务端按 kind 过滤 catalog 结果，不要在客户端选接口');
  }
  out.push(`   共 ${violations.length} 处；诊断探针请放 src/web/debug/（该目录已排除），测试脚本不受此门禁限制`);
  return out.join('\n');
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const { ok, violations } = checkSingleSource();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ok, violations }, null, 1)}\n`);
  } else if (ok) {
    process.stdout.write('✓ 单一数据源门禁通过：src/web 业务代码未直调单路接口\n');
  } else {
    process.stderr.write(`${formatViolations(violations)}\n`);
  }
  process.exit(ok ? 0 : 1);
}
