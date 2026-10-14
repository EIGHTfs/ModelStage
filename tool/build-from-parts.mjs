#!/usr/bin/env node
// ============================================================================
// build-from-parts.mjs — 三件套装配（P3a：骨架 + CSS + JS 区间表 → 单文件产物）
//
// 三件套与「谁是真源」：
//   src/index.html    HTML 骨架：head/meta/title/body + <style>/<script> 标签 + boot 内联脚本，
//                     两处内容用占位符标记：
//                       /*__STYLES_CSS__*/  ← CSS 内容（在 <style>…</style> 之间）
//                       /*__APP_JS__*/      ← module 脚本内容（在 <script type="module">…</script> 之间）
//                     **骨架里不含任何业务内容，逐字节等于原文（除被替换的两段）**，
//                     因此它不能单独运行（打开是一片空白），只是装配模板。
//   src/styles.css    CSS 原文（133,953 chars）逐字节搬运，**不格式化、不改一个字符**；
//                     阅读版若需要请另出 styles.pretty.css，但装配只用原文。
//   JS（module 脚本）  走「区间表」机制（P3b 起为多片：tool/slices.json，21 片各一个文件）：
//                     整段 JS = 原文 [134565, 816818) 按 slices.json 的 order 逐片拼接，
//                     每片一个文件：src/js/vendor/*.js（第三方库，逐字节原文，无头部注释）
//                                 src/js/app/*.js（应用区，逐字节原文）
//                                 src/js/runtime-boot.js（打包器前导）
//                                 src/engine.js（引擎块，P2 抽出：头部注释 + 可逆改名）
//                     即：片文件 = 构建真源（逐字节），slices.json = 区间权威（P3b 已逐字节验证）。
//
// 装配等式（必须逐字节成立）：
//   skeleton.replace(CSS_PH, styles.css).replace(JS_PH, jsIntervals)  ===  src/.app-shell.orig.html
//   再内联运行时（与 tool/build.mjs 同一步骤/同一 JSON.stringify 形态）   ===  dist/index.html
//
// 为什么用「占位符 + 函数式 replace」：
//   JS/CSS 原文里含大量 `$`（`${…}` 模板串、压缩短名 `$`），
//   String.replace(pat, str) 会把替换串里的 `$&`/`$'` 当成特殊变量 → 必须用 `.replace(ph, () => content)`。
//
// 用法：
//   node tool/build-from-parts.mjs --extract              # 由原文副本生成 src/index.html + src/styles.css（幂等）
//   node tool/build-from-parts.mjs                        # 只校验（默认）
//   node tool/build-from-parts.mjs --out <路径> [--inject-runtimes]
//   node tool/build-from-parts.mjs --self-test            # 反向自检：篡改 CSS 1 字符必须被检出
//
// 纪律：不写 dist/（--out 有 guard）；不提交 git。
// 依赖：node 内置 + ./rebuild-from-slices.mjs（SLICES/还原）+ ./lib/js-mask.mjs（间接）
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { SLICES, sliceRawFromFile } from './rebuild-from-slices.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ORIG = path.join(ROOT, 'src', '.app-shell.orig.html'); // 原文副本（装配基准）
const SKELETON = path.join(ROOT, 'src', 'index.html');       // 三件套①：骨架
const STYLES = path.join(ROOT, 'src', 'styles.css');         // 三件套②：CSS 原文
const DIST = path.join(ROOT, 'dist', 'index.html');          // 生产产物（本脚本只读）
const BASELINE = path.join(ROOT, 'baseline', 'index.html');  // 原版产物（P4 起基线对照物；本脚本只读）
const ENGINE = path.join(ROOT, 'src', 'engine.js');          // 三件套③的阅读视图（构建真相是区间表）

export const CSS_PH = '/*__STYLES_CSS__*/';
export const JS_PH = '/*__APP_JS__*/';
const RUNTIME_PH = '/*__SPINE_RUNTIME_SOURCES_PLACEHOLDER__*/';
const RUNTIME_KEY = 'window.__SPINE_RUNTIME_SOURCES__';

/**
 * 三件套区间表（字符偏移，左闭右开）。
 * 这些偏移由 tool/bundle-map.mjs 的分区扫描给出（见 doc/bundle-map.md §一）：
 *   S2 <style>…</style>（CSS 内容）、S3 boot 内联脚本（留在骨架里，仅 108 chars）、
 *   S4 module 标签、module 体 [134565, 816818)、S5 收尾。
 */
export const PARTS = {
  styles: { start: 417, end: 134370, file: STYLES, note: '<style>…</style> 之间的 CSS 原文（tailwind v4.3.3 产物）' },
  moduleBody: { start: 134565, end: 816818, note: 'module 脚本内容（JS 真相由 rebuild-from-slices 的 SLICES 决定）' },
  skeleton: { file: SKELETON, note: 'HTML 骨架（两处占位符）' },
};

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const countOf = (hay, needle) => hay.split(needle).length - 1;

/** 由原文副本切出 CSS 原文（逐字节，不加不减）。 */
export function cssFromOrig(origText) {
  return origText.slice(PARTS.styles.start, PARTS.styles.end);
}

/**
 * 由原文副本 + 区间表装配 module 脚本内容。
 *
 * P3b 起为**多片**：每片一个文件（vendor/*.js 逐字节原文；engine 片走反重命名还原），
 * 按 order 拼接；区间表首尾相接，故拼接结果 = 原文 moduleBody 整段。
 * 任一片缺失直接抛错（避免「悄悄用原文补上」把缺片掩盖过去）。
 */
export function jsFromOrigAndSlices(origText, opts = {}) {
  const { start, end } = PARTS.moduleBody;
  const pieces = [origText.slice(start, SLICES[0].start)];
  for (const slice of SLICES) {
    const { restored } = sliceRawFromFile(origText, slice, opts);   // 缺文件/还原不符都会抛错
    pieces.push(restored);
  }
  pieces.push(origText.slice(SLICES[SLICES.length - 1].end, end));
  const js = pieces.join('');
  const expect = end - start;
  if (!opts.withMods) {
    // 基线模式：剥掉 MOD 块后必须**逐字节**等于原文 module 体
    if (js.length !== expect) {
      throw new Error(`分片拼接长度 ${js.length} ≠ module 体长度 ${expect}（区间表可能不连续或有重叠）`);
    }
  } else if (js.length < expect) {
    // 产物模式：允许更长（含 MOD 改动块），但不允许更短（那说明有片缺失/被截断）
    throw new Error(`产物分片拼接长度 ${js.length} < 原文 module 体长度 ${expect}，疑似缺片`);
  }
  return js;
}

/** 由原文副本生成骨架（两段内容换成占位符，其余逐字节搬运）。 */
export function skeletonFromOrig(origText, opts = {}) {
  const css = cssFromOrig(origText);
  const js = jsFromOrigAndSlices(origText, opts);
  const head = origText.slice(0, PARTS.styles.start);
  const between = origText.slice(PARTS.styles.end, PARTS.moduleBody.start);
  const tail = origText.slice(PARTS.moduleBody.end);
  const skeleton = `${head}${CSS_PH}${between}${JS_PH}${tail}`;
  // 自检：占位符必须各出现一次，且骨架长度符合预期
  if (countOf(skeleton, CSS_PH) !== 1) throw new Error(`骨架里 ${CSS_PH} 出现 ${countOf(skeleton, CSS_PH)} 次（应为 1）`);
  if (countOf(skeleton, JS_PH) !== 1) throw new Error(`骨架里 ${JS_PH} 出现 ${countOf(skeleton, JS_PH)} 次（应为 1）`);
  const expectLen = origText.length - css.length - js.length + CSS_PH.length + JS_PH.length;
  if (skeleton.length !== expectLen) throw new Error(`骨架长度 ${skeleton.length} ≠ 预期 ${expectLen}`);
  return { skeleton, css, js };
}

/** 三件套装配：骨架 + CSS 文件 + JS 区间表 → 产物文本。 */
export function assemble({ skeletonText, cssText, withMods = false } = {}) {
  const origText = readIf(ORIG);
  if (!origText) throw new Error(`读不到原文副本 ${ORIG}`);
  const skeleton = skeletonText ?? readIf(SKELETON);
  if (!skeleton) throw new Error(`读不到骨架 ${SKELETON}（先跑 --extract）`);
  const css = cssText ?? readIf(STYLES);
  if (!css) throw new Error(`读不到 CSS ${STYLES}（先跑 --extract）`);
  const js = jsFromOrigAndSlices(origText, { withMods });
  // 关键：函数式 replace（替换串含 $ 时字面量 replace 会解释 $&/$' 等）
  let out = skeleton.replace(CSS_PH, () => css);
  out = out.replace(JS_PH, () => js);
  return { text: out, css, js, skeleton, origText };
}

/** 三件套装配 + 可选内联运行时（与 tool/build.mjs 同一步骤：JSON.stringify 转义后塞进 boot 脚本）。 */
export async function buildArtifactFromParts({ injectRuntimes = false, withMods = false } = {}) {
  const { text } = assemble({ withMods });
  if (!injectRuntimes) return { text };
  if (!text.includes(RUNTIME_PH)) throw new Error(`装配产物里找不到运行时占位符 ${RUNTIME_PH}`);
  const { resolveRuntimes } = await import('./resolve-runtimes.mjs');
  const rt = resolveRuntimes();
  const versions = Object.keys(rt.sources);
  if (!versions.length) throw new Error('探测到的 Spine 运行时为空');
  return { text: text.replace(RUNTIME_PH, () => `${RUNTIME_KEY} = ${JSON.stringify(rt.sources)};`), versions };
}

/** 完整校验；返回结构化结果。 */
export function checkParts() {
  const result = { ok: true, notes: [] };
  const origText = readIf(ORIG);
  if (!origText) throw new Error(`读不到原文副本 ${ORIG}`);
  const skeletonText = readIf(SKELETON);
  const cssText = readIf(STYLES);
  result.files = { skeleton: Boolean(skeletonText), styles: Boolean(cssText) };

  // ① styles.css ≡ 原文 CSS 区间（逐字节，未格式化）
  const cssRaw = cssFromOrig(origText);
  result.styles = {
    exists: Boolean(cssText),
    chars: cssText ? cssText.length : 0,
    rawChars: cssRaw.length,
    byteEqual: cssText === cssRaw,
    sha256: cssText ? sha256(cssText) : null,
  };
  if (!result.styles.byteEqual) result.ok = false;

  // ② 骨架：占位符各 1 次、其余逐字节等于原文
  if (skeletonText) {
    const cssCount = countOf(skeletonText, CSS_PH);
    const jsCount = countOf(skeletonText, JS_PH);
    // 把占位符换回原文内容后应 ≡ 原文
    const { skeleton: regenerated } = skeletonFromOrig(origText);
    result.skeleton = {
      chars: skeletonText.length,
      cssPlaceholders: cssCount,
      jsPlaceholders: jsCount,
      equalsRegenerated: skeletonText === regenerated,
      sha256: sha256(skeletonText),
    };
    if (cssCount !== 1 || jsCount !== 1 || skeletonText !== regenerated) result.ok = false;
  } else {
    result.skeleton = { exists: false };
    result.ok = false;
  }

  // ③ 装配 ≡ 原文（逐字节）
  const { text, css, js } = assemble();
  result.assemble = {
    chars: text.length,
    origChars: origText.length,
    byteEqual: text === origText,
    sha256: sha256(text),
    origSha256: sha256(origText),
    cssChars: css.length,
    jsChars: js.length,
  };
  if (!result.assemble.byteEqual) result.ok = false;

  // ④ 反向自检：篡改 CSS 1 个字符，装配结果必须 ≠ 原文
  const mutatedCss = `${css.slice(0, 100)}${css[100] === 'x' ? 'y' : 'x'}${css.slice(101)}`;
  const bad = assemble({ cssText: mutatedCss });
  result.negativeTestDetects = bad.text !== origText;
  if (!result.negativeTestDetects) result.ok = false;

  // ⑤ 内联运行时后 ≡ baseline/index.html（若存在；否则退回与 dist 比）
  //
  // 口径（P4 起）：dist/index.html 已从「基线」变成「原版 + MOD 产物」，
  //   所以基线对照物是 baseline/index.html，本项比对它；dist 只作为「运行时源文本」的来源，
  //   因为它同样内联了 runtimes/ 的全部运行时源码。
  const baseText = readIf(BASELINE);
  const distText = readIf(DIST);
  const cmpText = baseText || distText;
  if (cmpText) {
    const distSources = distRuntimeSources(distText || cmpText);
    if (!distSources) {
      result.notes.push('未能从内联产物中解析出内联运行时对象，跳过 ⑤');
    } else {
      const withRuntime = text.replace(RUNTIME_PH, () => `${RUNTIME_KEY} = ${JSON.stringify(distSources)};`);
      result.distRuntime = {
        sameAsDist: withRuntime === cmpText,
        artifactSha: sha256(withRuntime),
        distSha: sha256(cmpText),
        target: baseText ? 'baseline/index.html' : 'dist/index.html',
      };
      if (withRuntime !== cmpText) result.ok = false;
    }
  }
  return result;
}

/**
 * 从 dist/index.html 里抠出已内联的运行时源对象文本（仅用于本文件的自校验对比）。
 *
 * 为什么不能简单 indexOf(';')：运行时源是 3.4MB 的 JS 源码字符串，**字符串里大量含 `;` 与 `{}`**，
 * 必须按「字符串/转义状态 + 花括号深度」扫到深度归零后的那个 `;` 才是语句结尾。
 */
function distRuntimeSources(distText) {
  const key = `${RUNTIME_KEY} = `;
  const keyIdx = distText.indexOf(key);
  if (keyIdx < 0) return null;
  const start = keyIdx + key.length;
  let depth = 0;
  let inStr = null;
  for (let i = start; i < distText.length; i++) {
    const c = distText[i];
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ';' && depth === 0) return JSON.parse(distText.slice(start, i));
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function printResult(r) {
  const mark = (b) => (b ? '✅' : '❌');
  console.log(`骨架 src/index.html：${mark(r.files.skeleton)} 存在${r.skeleton && r.skeleton.chars ? `（${r.skeleton.chars} chars，占位符 CSS×${r.skeleton.cssPlaceholders} JS×${r.skeleton.jsPlaceholders}）` : ''}`);
  console.log(`CSS src/styles.css：${mark(r.styles.byteEqual)} 逐字节等于原文 CSS 区间（${r.styles.chars} chars，sha256=${r.styles.sha256}）`);
  if (r.skeleton && r.skeleton.chars) {
    console.log(`  ${mark(r.skeleton.equalsRegenerated)} 骨架 ≡ 由原文重新生成的骨架`);
  }
  console.log(`装配 ≡ 原文：${mark(r.assemble.byteEqual)}（产物 ${r.assemble.chars} chars，原文 ${r.assemble.origChars} chars，sha256=${r.assemble.sha256}）`);
  console.log(`  其中 CSS ${r.assemble.cssChars} chars + JS ${r.assemble.jsChars} chars`);
  console.log(`反向自检（篡改 CSS 1 字符必被检出）：${mark(r.negativeTestDetects)}`);
  if (r.distRuntime) {
    console.log(`装配 + 内联运行时 ≡ ${r.distRuntime.target}：${mark(r.distRuntime.sameAsDist)}（产物 sha=${r.distRuntime.artifactSha} / 目标 sha=${r.distRuntime.distSha}）`);
  }
  for (const n of r.notes) console.log(`  注：${n}`);
  console.log(r.ok ? '✅ 三件套装配校验全部通过' : '❌ 三件套装配校验失败');
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const valueOf = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : null;
  };

  if (has('--extract')) {
    const origText = readIf(ORIG);
    if (!origText) throw new Error(`读不到原文副本 ${ORIG}`);
    const { skeleton, css } = skeletonFromOrig(origText);
    fs.writeFileSync(STYLES, css, 'utf8');
    fs.writeFileSync(SKELETON, skeleton, 'utf8');
    console.log(`✅ 已生成 src/styles.css（${css.length} chars，逐字节原文）`);
    console.log(`✅ 已生成 src/index.html（${skeleton.length} chars，占位符 ${CSS_PH} / ${JS_PH}）`);
    printResult(checkParts());
    process.exit(checkParts().ok ? 0 : 1);
  }

  if (has('--self-test')) {
    const origText = readIf(ORIG);
    const { css } = skeletonFromOrig(origText);
    const mutated = `${css.slice(0, 10)}${css[10] === 'x' ? 'y' : 'x'}${css.slice(11)}`;
    const bad = assemble({ cssText: mutated });
    const detected = bad.text !== origText;
    console.log(`${detected ? '✅' : '❌'} --self-test：故意改 CSS 1 字符 → 装配结果 !== 原文（${detected ? '已检出' : '未检出！校验无效'})`);
    process.exit(detected ? 0 : 1);
  }

  const r = checkParts();
  printResult(r);

  const outArg = valueOf('--out');
  if (outArg) {
    const outPath = path.resolve(ROOT, outArg);
    if (outPath === path.resolve(DIST) || outPath.startsWith(path.resolve(ROOT, 'dist') + path.sep)) {
      console.error('❌ 拒绝写入 dist/（生产产物保持不动；请用临时目录，如 /tmp/p3a/serve/index.html）');
      process.exit(2);
    }
    let text = (await buildArtifactFromParts({ injectRuntimes: has('--inject-runtimes') })).text;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, text, 'utf8');
    console.log(`✅ 三件套装配产物已写出：${outPath}（${text.length} chars${has('--inject-runtimes') ? '，已内联运行时' : ''}）`);
    const distText = readIf(DIST);
    if (distText && has('--inject-runtimes')) {
      console.log(`${text === distText ? '✅' : '❌'} 装配产物 ≡ dist/index.html（sha256=${sha256(text)}）`);
    }
  }
  process.exit(r.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}
