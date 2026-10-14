#!/usr/bin/env node
// ============================================================================
// build-byte-equal.mjs — 「逐字节等价」总校验入口（P2.2 验收脚本）
//
// 一条命令跑完四段校验（任一失败即退出码 1）：
//   ① 原文副本 src/.app-shell.orig.html ≡ src/app-shell.html（回填基准可信）
//   ② 区间回填：src/engine.js 反重命名 → 塞回原偏移 → ≡ 原文（切/回偏移兜底）
//   ③ 回填 + 内联 Spine 运行时 → ≡ dist/index.html（生产产物字节级一致）
//   ④ dist/index.html ≡ baseline/index.html（与 P0 的 verify-byte-equal 同口径）
//
// 为什么 ③ 很关键：它把「源码层回填」与「生产产物」接上了——
//   只要 ③ 过，说明「回填产物 + 运行时注入」这条链与 8803 实际服务的内容完全一致，
//   于是 P2.3 的浏览器冒烟（跑 ③ 的产物）就等价于冒烟生产内容，且全程不碰 dist。
//
// 用法：
//   node tool/build-byte-equal.mjs            # 跑全部四段
//   node tool/build-byte-equal.mjs --skip-dist-runtime   # 跳过 ③（慢，需探测运行时）
//
// 依赖：node 内置 + 同项目 tool/rebuild-from-slices.mjs（区间表回填）+ 其内部的 js-mask / resolve-runtimes
// 纪律：本脚本**只读** dist/ 与 baseline/，任何情况下都不写入（P2 生产不动）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { checkChain, buildArtifact, SLICES } from './rebuild-from-slices.mjs';
import { checkParts, buildArtifactFromParts, CSS_PH, JS_PH } from './build-from-parts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'index.html');
const BASELINE = path.join(ROOT, 'baseline', 'index.html');

const argv = process.argv.slice(2);
const skipDistRuntime = argv.includes('--skip-dist-runtime');

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const mark = (b) => (b === null ? '⏭️ ' : b ? '✅' : '❌');

let failed = 0;
const report = (ok, label, extra = '') => {
  if (ok === false) failed++;
  console.log(`${mark(ok)} ${label}${extra ? `  ${extra}` : ''}`);
};

// ---------------------------------------------------------------------------
// ① + ② 区间回填链（复用 rebuild-from-slices 的 checkChain，含逐片反向自检）
//    P3b 起为多片：每片一个文件（vendor/*.js 逐字节原文 / engine.js 可逆改名）
// ---------------------------------------------------------------------------
console.log('== ① 原文基准 + ② 分片区间回填（tool/slices.json，多片） ==');
const chain = checkChain();
report(chain.copyEqual, '原文副本 ≡ src/app-shell.html', `sha256=${chain.copySha.shell}`);
report(chain.slices.length > 1, `分片表已多片化（${chain.slices.length} 片，源自 tool/slices.json）`);
for (const s of chain.slices) {
  const how = s.kind === 'verbatim' ? '逐字节原文' : `可逆改名（${s.restoreChanged} 处）`;
  report(Boolean(s.exists) && s.restoreEqual, `[${String(s.order).padStart(2)}] ${s.file} ≡ 原文区间 [${s.start}, ${s.end})`, `${s.chars} chars，${how}`);
  report(s.balanced, `    该片自身括号配平（= 由完整顶层语句组成）`);
  report(s.negativeTestDetects, `    该片篡改 1 字符能被检出`);
}
report(chain.join.equal, `按 order 拼接 ${chain.join.chars} chars ≡ 原文 moduleBody 整段`, `sha256=${chain.join.sha256}`);
report(chain.negativePerSlice.ok, `反向自检：逐片改 1 字符（${chain.negativePerSlice.checked} 片）→ 拼接结果全部被检出`);

// ---------------------------------------------------------------------------
// ②b 三件套装配（P3a）：骨架 + styles.css + JS 区间表 → ≡ 原文
// ---------------------------------------------------------------------------
console.log('');
console.log('== ②b 三件套装配（src/index.html 骨架 + src/styles.css + JS 区间表） ==');
const parts = checkParts();
report(parts.files.skeleton, 'src/index.html 骨架存在', parts.skeleton && parts.skeleton.chars ? `${parts.skeleton.chars} chars，占位符 ${CSS_PH}×${parts.skeleton.cssPlaceholders} / ${JS_PH}×${parts.skeleton.jsPlaceholders}` : '');
report(parts.styles.byteEqual, 'src/styles.css 逐字节等于原文 CSS 区间（未格式化）', `${parts.styles.chars} chars，sha256=${parts.styles.sha256}`);
report(parts.skeleton.equalsRegenerated, '骨架 ≡ 由原文重新生成的骨架（占位符位置正确）');
report(parts.assemble.byteEqual, '装配 ≡ 原文（骨架 + CSS + JS 区间）', `${parts.assemble.chars} chars，sha256=${parts.assemble.sha256}`);
report(parts.negativeTestDetects, '反向自检：篡改 CSS 1 字符能被检出');
if (parts.distRuntime) report(parts.distRuntime.sameAsDist, '装配 + 内联运行时 ≡ baseline/index.html（或 dist）', `sha256=${parts.distRuntime.artifactSha}`);

// ---------------------------------------------------------------------------
// ③ 回填 + 内联运行时 ≡ dist/index.html
// ---------------------------------------------------------------------------
console.log('');
console.log('== ③ 基线回填 + 内联运行时 ≡ baseline/index.html ==');
const distText = readIf(DIST);
if (!distText) {
  report(null, 'dist/index.html 不存在，跳过（不视为失败）');
} else if (skipDistRuntime) {
  report(null, '按 --skip-dist-runtime 跳过');
} else {
  try {
    // 口径（P4 起）：基线链路必须 ≡ **baseline/index.html**（原版产物），而不是 dist ——
    //   dist 自 P4 起是「原版 + MOD 产物」，允许与 baseline 不同（部署后必然不同）。
    const baselineText2 = readIf(BASELINE);
    const { text } = await buildArtifact({ injectRuntimes: true });
    if (!baselineText2) {
      report(null, 'baseline/index.html 缺失，跳过「基线回填 ≡ baseline」比对');
    } else {
      report(text === baselineText2, '回填（剥 MOD）+ 运行时注入 ≡ baseline/index.html', `sha256=${sha256(text)}`);
      if (text !== baselineText2) {
        console.log(`    baseline sha256=${sha256(baselineText2)}`);
        console.log(`    长度 baseline=${baselineText2.length}，产物=${text.length}`);
      }
    }
    // ③b：三件套装配（剥 MOD）+ 现场探测运行时 ≡ baseline —— 与 ③ 是两条独立路径，都必须成立
    const partsRt = await buildArtifactFromParts({ injectRuntimes: true, withMods: false });
    if (baselineText2) {
      report(partsRt.text === baselineText2, '三件套装配（剥 MOD）+ 运行时注入 ≡ baseline/index.html', `sha256=${sha256(partsRt.text)}，运行时版本 ${partsRt.versions.join(',')}`);
    } else {
      report(null, '三件套装配（剥 MOD）+ 运行时 ≡ baseline：baseline 缺失，跳过');
    }
  } catch (e) {
    report(false, `基线回填 + 运行时注入失败：${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// ④ dist/index.html 口径（P4 起 dist = 产物，允许 ≠ baseline；本段不参与成败判定）
//    合法状态只有两种：dist ≡ 产物（已部署 P4）或 dist ≡ baseline（尚未部署 P4）。
//    两种都不是时只提示「dist 落后/来源不明」，不算链路失败 —— 链路只保证「源码 → 产物」可复现。
// ---------------------------------------------------------------------------
console.log('');
console.log('== ④ dist/index.html 口径（产物 vs baseline，信息项） ==');
const baselineText = readIf(BASELINE);
if (!distText) {
  report(null, 'dist 缺失，跳过');
} else {
  const productRt = (await buildArtifactFromParts({ injectRuntimes: true, withMods: true })).text;
  const isProduct = distText === productRt;
  const isBaseline = baselineText ? distText === baselineText : false;
  console.log(`    dist      sha256=${sha256(distText)}  ${distText.length} chars`);
  console.log(`    产物(含 MOD) sha256=${sha256(productRt)}  ${productRt.length} chars`);
  if (isProduct) {
    report(true, 'dist ≡ 产物（含 MOD）—— 已部署 P4 产物，符合预期');
  } else if (isBaseline) {
    report(true, 'dist ≡ baseline —— 尚未部署产物（合法状态）');
  } else {
    report(null, 'dist 既 ≠ 当前产物、也 ≠ baseline —— 说明 dist 落后于当前源码，重新执行 '
      + '`node tool/build-product.mjs --out /tmp/p.html && cp /tmp/p.html dist/index.html` 即可；本项不参与成败判定');
  }
}

console.log('');
if (failed === 0) {
  console.log(`✅ 逐字节等价校验全部通过（分片装配链路 + 三件套装配 + 基线回填，均 ≡ 原文/baseline/index.html）`);
} else {
  console.log(`❌ 有 ${failed} 项校验失败`);
}
process.exit(failed === 0 ? 0 : 1);
