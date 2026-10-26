// check-inline-size.mjs —— 「覆盖层尺寸只有一个主人」的静态门禁
//
// 为什么需要它：覆盖层（#live2d-overlay）是 absolute + overflow:hidden，尺寸由内联样式决定。
//   一旦有第二处代码也去写它的 width/height，就会出现"某条路径更新了、另一条没更新"：
//   旋转后容器钉在旧 px、把画布裁掉（真机现象：模型挤在左侧窄带、右侧露出棋盘格）。
//   这类回归靠人眼很难守住，用一条静态检查钉死更划算。
//
// 白名单（唯一允许写尺寸型内联样式的地方）：
//   · src/web/render/surface.js  → setOverlayBox()   覆盖层容器 + 画布（唯一主人）
//   · src/web/live2d/overlay.js  → buildOverlay()    创建元素时的初始 cssText（结构，不是尺寸同步）
//
// 用法：
//   node tool/check-inline-size.mjs            # 扫 src/web（缺省）
//   node tool/check-inline-size.mjs --root src # 指定根
//   node tool/check-inline-size.mjs --json
// 退出码：0 = 无越权写入；1 = 有越权写入；2 = 用法错误
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 允许写尺寸型内联样式的「文件 → 函数」白名单 */
const ALLOW = [
  // 渲染器自治：Live2D 覆盖层的尺寸由 overlay 模块单点写入。
  // setBox 是入口，setContainerBox / setCanvasBox 是它的两个写手（拆开只为降复杂度）
  { file: 'src/web/live2d/overlay.js', fn: 'setBox' },
  { file: 'src/web/live2d/overlay.js', fn: 'setContainerBox' },
  { file: 'src/web/live2d/overlay.js', fn: 'setCanvasBox' },
  // 元素构建时的初始 cssText（结构，不是尺寸同步）
  { file: 'src/web/live2d/overlay.js', fn: 'buildOverlay' },
  // Surface 建元素时的初始 cssText（100% 初值，随后被 setBox 覆盖）
  { file: 'src/web/render/surface.js', fn: 'ensureOverlay' },
];

/** 尺寸型内联样式的写入形态：.style.width = / .style.height = / .style.cssText = */
const PATTERNS = [
  { re: /\.style\.width\s*=/, what: 'style.width =' },
  { re: /\.style\.height\s*=/, what: 'style.height =' },
];

/** 递归收集 .js 文件（跳过 node_modules / .git / 构建产物） */
function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(full, out);
    } else if (e.isFile() && e.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 找某一行所在的函数名（往上找最近的 `function name(` 或 `name(...) {` 方法定义）。
 * 够用即可：本仓库没有压缩产物，缩进可靠。
 */
const CTRL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'else', 'do', 'try', 'with']);

function enclosingFn(lines, idx) {
  for (let i = idx; i >= 0; i -= 1) {
    const m = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i])
      || /^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/.exec(lines[i]);
    if (!m) continue;
    if (CTRL_KEYWORDS.has(m[1])) continue;
    return m[1];
  }
  return null;
}

/** 扫描一个文件，返回违规点 */
function scanFile(abs, rel) {
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split('\n');
  const bad = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (const p of PATTERNS) {
      if (!p.re.test(lines[i])) continue;
      const fn = enclosingFn(lines, i);
      const allowed = ALLOW.some((a) => a.file === rel && a.fn === fn);
      if (!allowed) bad.push({ file: rel, line: i + 1, fn, what: p.what, text: lines[i].trim().slice(0, 100) });
    }
  }
  return bad;
}

function main(argv) {
  const args = argv.slice(2);
  const rootIdx = args.indexOf('--root');
  const root = path.resolve(ROOT, rootIdx >= 0 ? args[rootIdx + 1] : 'src/web');
  const json = args.includes('--json');
  if (!fs.existsSync(root)) {
    console.error(`路径不存在：${root}`);
    return 2;
  }
  const files = walk(root);
  const violations = [];
  const allowedHits = [];
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const bad = scanFile(abs, rel);
    violations.push(...bad);
    // 顺便统计白名单命中（报告里显示"只有这几处"，证明收口有效）
    if (ALLOW.some((a) => a.file === rel)) allowedHits.push(rel);
  }

  if (json) {
    console.log(JSON.stringify({ root: path.relative(ROOT, root), scanned: files.length, violations, allowList: ALLOW }, null, 1));
    return violations.length ? 1 : 0;
  }

  console.log(`扫描 ${files.length} 个 .js（根：${path.relative(ROOT, root) || '.'}）`);
  console.log('白名单（唯一允许写尺寸型内联样式的地方）：');
  for (const a of ALLOW) console.log(`  · ${a.file} → ${a.fn}()`);
  if (violations.length) {
    console.log(`\n❌ 发现 ${violations.length} 处越权写入：`);
    for (const v of violations) {
      console.log(`  ${v.file}:${v.line}  ${v.what}  在 ${v.fn || '(模块顶层)'}() 里`);
      console.log(`      ${v.text}`);
    }
    console.log('\n覆盖层尺寸必须只有一个主人（Live2D 的 overlay.setBox 及其两个写手）。');
    console.log('若确实需要新的写入点，先改白名单并说明理由，不要绕过。');
    return 1;
  }
  console.log(`\n✅ 无越权写入（白名单文件命中 ${allowedHits.length} 个）`);
  return 0;
}

process.exit(main(process.argv));
