#!/usr/bin/env node
// test/lib/apply-wait-ready.mjs —— 把 wait-ready 的页内工具注入测试脚本（幂等）
//
// 用法：node test/lib/apply-wait-ready.mjs            （默认 dry-run，只报将改哪些文件）
//       node test/lib/apply-wait-ready.mjs --write    （真写盘）
// 约定：每个被改造的脚本在 `(async () => {` 之后紧跟一对标记块
//   // [wait-ready] begin ... // [wait-ready] end
// 注入/更新时整块替换，所以改源头（wait-ready.mjs 的 IN_PAGE）后再跑一次即可。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IN_PAGE } from './wait-ready.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BEGIN = '// [wait-ready] begin';
const END = '// [wait-ready] end';
const args = process.argv.slice(2);
const write = args.includes('--write');
const files = args.filter((a) => a.endsWith('.js') && !a.startsWith('--'));

/**
 * 注入块会声明这些名字。若目标文件**自己也**声明了同名 const/let/var/function，
 * 注入后必然 "Identifier 'x' has already been declared" —— 而那种错误只有在**跑到**那个套件时才暴露。
 * 事故：f2-topbar 自带 `const waitFor`，注入块也声明 waitFor，导致该文件从提交起一直是红的，
 *   直到全量跑才发现。所以这里在**注入时就拦下**，并要求人工改名。
 */
const INJECTED_NAMES = ['waitStage', 'waitAny', 'waitFrames', 'afterTransition', 'waitStable', 'waitFor', 'RANK', 'STATES'];

/** 扫出目标文件里与注入块重名的本地声明（忽略注入块自身范围） */
function localConflicts(src) {
  const b = src.indexOf(BEGIN);
  const e = src.indexOf(END);
  const body = b >= 0 && e > b ? src.slice(0, b) + src.slice(e + END.length) : src;
  const hits = [];
  for (const name of INJECTED_NAMES) {
    const re = new RegExp('(?:^|[^.\\w])(?:const|let|var|function)\\s+' + name + '\\b');
    if (re.test(body)) hits.push(name);
  }
  return hits;
}

function injectInto(file) {
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  const src = fs.readFileSync(abs, 'utf8');
  const conflicts = localConflicts(src);
  if (conflicts.length) {
    throw new Error(
      `${file}: 本地已声明 [${conflicts.join(', ')}]，与注入块同名会重复声明（SyntaxError）。`
      + '请先把本地同名 helper 改名（如 waitFor → waitUntil）再注入。',
    );
  }
  const b = src.indexOf(BEGIN);
  const e = src.indexOf(END);
  let next;
  if (b >= 0 && e > b) {
    next = src.slice(0, b) + IN_PAGE + src.slice(e + END.length);
  } else {
    const anchor = src.indexOf('(async () => {');
    if (anchor < 0) throw new Error(`${file}: 找不到 (async () => { 锚点`);
    const at = anchor + '(async () => {'.length;
    next = `${src.slice(0, at)}\n${IN_PAGE}${src.slice(at)}`;
  }
  const changed = next !== src;
  // 建目录必须在 write 分支内：本工具的 --dry-run（write=false）承诺不写盘，
  //   放到 if 外面会让 dry-run 也创建目录（真实副作用）。
  if (changed && write) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, next, 'utf8');
  }
  return { file, changed };
}

// 默认目标：自动发现 test/browser/ 下所有含生成块的脚本。
//   不写死名单 —— 名单会漏（原先只列了 3 个，实际有 9 个都嵌了生成块），
//   漏掉的脚本在源块更新后会静默停在旧版本。浏览器套件已归档到 test/browser/。
const BROWSER_DIR = 'test/browser';
const discovered = fs.existsSync(BROWSER_DIR)
  ? fs.readdirSync(BROWSER_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => `${BROWSER_DIR}/${f}`)
    .filter((f) => fs.readFileSync(f, 'utf8').includes('[wait-ready] begin'))
    .sort()
  : [];
const targets = files.length ? files : discovered;
let n = 0;
for (const t of targets) {
  const r = injectInto(t);
  console.log(`${r.changed ? (write ? '✅ 已写入' : '🔍 将更新') : '＝ 已是最新'}  ${r.file}`);
  if (r.changed) n += 1;
}
console.log(`\n${write ? '写入' : '待写入（dry-run）'} ${n} 个文件；源: test/lib/wait-ready.mjs 的 IN_PAGE`);
