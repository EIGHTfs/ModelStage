#!/usr/bin/env node
// ============================================================================
// rebuild-from-slices.mjs — 区间表回填 + 逐字节等价校验（P2 关键纪律的执行体）
//
// 核心约定（请先读完再改）：
//   构建真相 = **「app-shell 原文区间表」**（本文件顶部的 SLICES），不是 src/engine.js！
//   src/engine.js 只是「阅读视图」：原文片段 + 头部注释 + 少量可逆改名（mt→SpineEngine）。
//   因此产物必须由「原文区间」重建，而 engine.js 的作用是**证明切出可逆**：
//     ① engine.js 反重命名后必须逐字节等于原文区间 → 证明切出没丢字/没越界/改名对称
//     ② 把该片段按原偏移塞回原文副本 → 必须逐字节等于原文 → 证明回填偏移正确
//   这两个断言一旦通过，「切出—阅读—回填」三步就是可审计、可复现的。
//
// 为什么需要「原文副本」：
//   ① 回填要以「未被后续步骤改动过的原文」为基准，直接读 src/app-shell.html 也可以，
//      但一旦将来真的把区间从 app-shell.html 里删掉，副本就是唯一基准；
//   ② 副本存在也让「基准是否被改动」可判（第一步就比对两者 sha256）。
//
// 用法：
//   node tool/rebuild-from-slices.mjs                     # 只校验（默认），不落盘
//   node tool/rebuild-from-slices.mjs --extract           # 由区间表重新生成 src/engine.js（幂等）
//   node tool/rebuild-from-slices.mjs --out <路径>        # 落盘回填产物（UTF-8）
//   node tool/rebuild-from-slices.mjs --out <路径> --inject-runtimes
//                                                        # 额外内联 Spine 运行时（冒烟用；
//                                                        #   **永不写 dist/**，见下方 guard）
//   node tool/rebuild-from-slices.mjs --self-test         # 反向自检：故意改 1 字符必须报不等
//
// 依赖：node 内置 + 同项目 tool/lib/js-mask.mjs（词法掩码，代码位改名用）+ tool/resolve-runtimes.mjs
// 零第三方依赖；不修改 dist/、不提交 git。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { buildCodeMask, balanceCheck, renameInCode } from './lib/js-mask.mjs';
import { stripMods, listMods, applyModManifest } from './lib/mods.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHELL = path.join(ROOT, 'src', 'app-shell.html');          // 当前外壳（含待切区间）
const ORIG = path.join(ROOT, 'src', '.app-shell.orig.html');     // 原文副本（回填基准）
const ENGINE = path.join(ROOT, 'src', 'engine.js');              // 阅读视图（切出的片段）
const DIST = path.join(ROOT, 'dist', 'index.html');              // 生产产物（本脚本永不写）
const PLACEHOLDER = '/*__SPINE_RUNTIME_SOURCES_PLACEHOLDER__*/';
const RUNTIME_KEY = 'window.__SPINE_RUNTIME_SOURCES__';

// ---------------------------------------------------------------------------
// 区间表（唯一权威）：tool/slices.json 是**数据**来源，这里的代码只负责：
//   ① 读表 + 校验（首尾相接、order 与偏移一致、kind 合法）
//   ② 给 kind='renamed' 的片挂上「头部注释 + 可逆改名」规则（改名规则属代码，不属数据）
// ---------------------------------------------------------------------------
const SLICES_JSON = path.join(ROOT, 'tool', 'slices.json');

/** engine 片的可逆改名与头部标记（代码侧常量；数据表只记 kind='renamed'）。 */
const RENAMED_RULES = {
  engine: {
    renamesForward: [
      ['mt', 'SpineEngine'],
      ['Xd', 'SpineEngineAlias'],
    ],
    renamesReverse: [
      ['SpineEngineAlias', 'Xd'],
      ['SpineEngine', 'mt'],
    ],
    headerBegin: '/* >>> ENGINE-SLICE-HEADER-BEGIN',
    headerEnd: 'ENGINE-SLICE-HEADER-END <<< */',
  },
};

/** 读取并校验 tool/slices.json；返回按 order 排序、并挂好改名规则的区间数组。 */
function loadSliceTable() {
  if (!fs.existsSync(SLICES_JSON)) throw new Error(`缺少区间表 ${SLICES_JSON}`);
  const raw = JSON.parse(fs.readFileSync(SLICES_JSON, 'utf8'));
  const body = raw.moduleBody;
  const list = (raw.slices || []).slice().sort((a, b) => a.order - b.order);
  if (!list.length) throw new Error('区间表为空');
  const problems = [];
  if (list[0].start !== body[0]) problems.push(`首片(${list[0].id}) 起点 ${list[0].start} ≠ moduleBody 起点 ${body[0]}`);
  if (list[list.length - 1].end !== body[1]) problems.push(`末片(${list[list.length - 1].id}) 终点 ${list[list.length - 1].end} ≠ moduleBody 终点 ${body[1]}`);
  for (let i = 0; i < list.length; i++) {
    const cur = list[i];
    if (!(cur.start < cur.end)) problems.push(`${cur.id}: start >= end`);
    if (!['verbatim', 'renamed'].includes(cur.kind)) problems.push(`${cur.id}: 未知 kind=${cur.kind}`);
    if (cur.kind === 'renamed' && !RENAMED_RULES[cur.id]) problems.push(`${cur.id}: kind=renamed 但缺少改名规则`);
    if (i > 0 && list[i - 1].end !== cur.start) problems.push(`${list[i - 1].id}[…,${list[i - 1].end}) 与 ${cur.id}[${cur.start},…) 不相接`);
  }
  if (problems.length) throw new Error(`区间表自检失败：\n  - ${problems.join('\n  - ')}`);
  return list.map((s) => ({
    ...s,
    file: path.resolve(ROOT, s.file),
    fileRel: s.file,
    chars: s.end - s.start,
    ...(s.kind === 'renamed' ? RENAMED_RULES[s.id] : {}),
  }));
}

export const SLICES = loadSliceTable();
export const MODULE_BODY = JSON.parse(fs.readFileSync(SLICES_JSON, 'utf8')).moduleBody;

// 12 个外部符号（原样保留，仅登记；供 engine.js 头部注释与人工核对用）
const ENGINE_EXTERNAL_SYMBOLS = [
  ['de', 134747, 'bundle 前导 V0（src/js/runtime-boot.js）：私有字段助手 de(this,"x",v)'],
  ['Yd', 521938, 'Spine 运行时管理器（let Yd=Is）'],
  ['Ep', 522383, '日志器'],
  ['Tp', 522394, 'atlas 预处理'],
  ['xw', 522496, '贴图文件归一化'],
  ['rk', 525184, '贴图批量加载'],
  ['sk', 526101, 'PMA 探测'],
  ['lk', 527450, '像素/贴图变换'],
  ['Io', 531820, 'atlas 解析'],
  ['Od', 532009, '骨架解析'],
  ['Fm', 534446, '默认滤镜 id'],
  ['yk', 534461, '滤镜校验'],
  ['vk', 534504, '滤镜着色器表'],
];

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

/** 首个不同字符的位置（相同返回 -1）。 */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/** 取某区间整段的代码位掩码（区间外不关心）。 */
function maskOf(text, start, end) {
  const { mask, regexLog } = buildCodeMask(text, 0, text.length);
  const balance = balanceCheck(text, mask, start, end);
  return { mask, regexLog, balance };
}

/** 生成 engine.js 的头部注释块（含来源区间、改名对照表、12 个外部符号清单）。 */
function buildHeader(slice) {
  const lines = [];
  lines.push(`${slice.headerBegin}
 * src/engine.js — Spine 渲染引擎块（P2 机械切出；**构建回填真源不是本文件**）
 * ===========================================================================
 * 来源：src/app-shell.html 字符区间 [${slice.start}, ${slice.end})
 *       （= doc/bundle-map.md 的 A3 引擎辅助区 + E1 mt 引擎类 + E2 静态字段/别名）
 * 形态：本文件 = 本头部注释 + 原始压缩片段；除下方「改名对照表」外**逐字节未改**
 * 构建真相：「app-shell 原文区间表」（tool/rebuild-from-slices.mjs 的 SLICES）——
 *           本文件是「阅读视图」，改这里不会自动改变产物；要改行为须改区间表/可读源码树
 *           （架构决策见 doc/2026-10-14解压原版为可读源码-完整步骤.MD「双真相」一节）。
 * 校验：① 反重命名后本文件的片段必须逐字节等于原文区间
 *       ② 按原偏移塞回原文副本必须逐字节等于原文
 *       命令：node tool/rebuild-from-slices.mjs --check  /  node tool/build-byte-equal.mjs
 * ===========================================================================
 * 改名对照表（只动类名/绑定名；31 个方法名与 de(this,"字段") 字段名一律未动）
 *   原名                        新名
 *   const mt=class mt{      →   const SpineEngine=class SpineEngine{
 *   let Xd=mt;              →   let SpineEngineAlias=SpineEngine;
 *   de(mt,"XXX",…) ×8       →   de(SpineEngine,"XXX",…)   （静态字段引用）
 *   mt.SOFTWARE_RE 等 ×17   →   SpineEngine.SOFTWARE_RE …
 *   反重命名（回填）：先 SpineEngineAlias→Xd，再 SpineEngine→mt（**长名优先**，
 *   否则 SpineEngineAlias 会被先替换成 mtAlias）
 * ===========================================================================
 * 13 个外部符号（= de + 12 个引擎辅助符号；除 de 外全部定义在本区间内，原样保留、仅登记）：
${ENGINE_EXTERNAL_SYMBOLS.map(([n, at, why]) => ` *   ${n.padEnd(4)} @${String(at).padEnd(7)} ${why}`).join('\n')}
 * ===========================================================================
 * 只读提示：prettier 格式化**只作本地阅读**（不落盘、不作构建输入）——格式化产物
 *           不可能逐字节回填，落盘会诱发「两份真相」漂移。
 * 重新生成：node tool/rebuild-from-slices.mjs --extract（幂等）
${slice.headerEnd}`);
  return lines.join('\n');
}

/** 从 engine.js 文本里剥掉头部注释块，返回片段正文。 */
function stripHeader(text, slice) {
  const beginIdx = text.indexOf(slice.headerBegin);
  const endMarker = slice.headerEnd;
  const endIdx = text.indexOf(endMarker);
  if (beginIdx !== 0 || endIdx < 0) {
    throw new Error(`engine.js 头部注释块标记缺失（begin@${beginIdx}, end@${endIdx}）`);
  }
  let body = text.slice(endIdx + endMarker.length);
  // 头部块后允许一个换行（生成时写入），剥离它以免影响逐字节比对
  if (body.startsWith('\n')) body = body.slice(1);
  return body;
}

/** 切出：按区间表 + forward 改名生成阅读视图文本。
 *
 * 实现要点（踩过的坑）：
 *   改名会改变字符串长度（mt→SpineEngine 变长），所以**不能**先在全文上改名、再用原偏移切片——
 *   必须先切出片段，再在片段自己的偏移空间（0..len）上改名并获得该片段的独立掩码。
 *   独立掩码与全文掩码在区间内必须一致（否则说明区间边界切进了字符串/正则），此处显式断言。
 */
export function extractSlice(origText, slice) {
  const raw = origText.slice(slice.start, slice.end);
  // ① 片段独立掩码（偏移 0..raw.length）
  const standalone = maskOf(raw, 0, raw.length);
  if (!standalone.balance.ok) {
    throw new Error(`片段独立掩码括号不配平 @${standalone.balance.at}（期望 ${standalone.balance.expect}）`);
  }
  // ② 与全文掩码交叉核对：区间内每个字符的代码位归属必须一致
  const full = maskOf(origText, slice.start, slice.end);
  if (!full.balance.ok) {
    throw new Error(`原文区间括号不配平 @${full.balance.at}（期望 ${full.balance.expect}）`);
  }
  let maskMismatch = -1;
  for (let i = 0; i < raw.length; i++) {
    if (standalone.mask[i] !== full.mask[slice.start + i]) {
      maskMismatch = i;
      break;
    }
  }
  if (maskMismatch >= 0) {
    throw new Error(
      `区间 [${slice.start}, ${slice.end}) 的独立掩码与全文掩码不一致 @片段偏移 ${maskMismatch}` +
        `（说明边界切进了字符串/正则/注释，需调整区间）`,
    );
  }
  // ③ 只在片段偏移空间上改名
  const { text: renamed, changed } = renameInCode(raw, standalone.mask, slice.renamesForward, 0, raw.length);
  return { raw, renamed, changed };
}

/** 回填：把 engine.js（阅读视图）还原成原文片段（反重命名），并做可逆性断言。 */
export function restoreSlice(origText, engineText, slice) {
  const body = stripHeader(engineText, slice);
  const raw = origText.slice(slice.start, slice.end);
  // 反重命名需要掩码：在「片段正文」上单独建掩码（偏移从 0 开始）
  const { mask, balance } = maskOf(body, 0, body.length);
  if (!balance.ok) throw new Error(`engine.js 正文括号不配平 @${balance.at}（期望 ${balance.expect}）`);
  const { text: restored, changed } = renameInCode(body, mask, slice.renamesReverse, 0, body.length);
  return { restored, raw, body, changed };
}

/**
 * 通用：从「片文件」还原它对应的原文片段。
 *   kind='verbatim' → 文件内容就是原文片段（无头、无改名），直接返回；
 *   kind='renamed'  → 剥头部注释 + 反重命名（engine 片），见 restoreSlice。
 *
 * P4a 起支持 MOD 标记块（tool/lib/mods.mjs）：
 *   默认（基线模式，opts.withMods 假）= 先 stripMods() 剥掉改动块，再还原 —— 结果必须 ≡ 原版区间；
 *   opts.withMods 真（产物模式）= 保留改动块，装配出「原版 + 改动」的页面。
 */
/**
 * 声明式切片级 MOD：把「现片段」反向替换回「原版片段」，供基线模式逐字节比对。
 *
 * 为什么需要它（而不是 MOD 块标记）：MOD 块标记要求标记单独成行（见 tool/lib/mods.mjs 的
 *   OPEN/CLOSE 正则），而本项目的多数切片是**压缩过的单行代码**，无法在表达式中间插入整行标记。
 *   声明式清单与代码形态无关：把「原片段 / 现片段 / 预期净增字符」写进 tool/mods/app-shell.json，
 *   基线比对前按声明反替换即可。
 *
 * 门禁强度（刻意从严，任何一条不满足都抛错）：
 *   · 声明的「现片段」在该片文件里必须**恰好出现 1 次**（0 次说明声明过期，≥2 次说明改动不唯一）；
 *   · 声明的「原片段」此时必须**已经不存在**（否则说明代码其实没改，声明是多余的）；
 *   · 声明的净增字符数必须与两个片段之差**完全一致**（防止声明与实际改动脱节）。
 *   替换后仍要与原文区间逐字节相等 —— 未声明的任何差异一律报错，不存在"忽略该文件/跳过长度检查"。
 */
const MODS_MANIFEST = (() => {
  try {
    const p = path.join(ROOT, 'tool', 'mods', 'app-shell.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { mods: [] };
  } catch (e) {
    throw new Error(`读取 tool/mods/app-shell.json 失败: ${e.message}`);
  }
})();

function applyBaselineMods(text, fileRel) {
  const mods = (MODS_MANIFEST.mods || []).filter((m) => m.file === fileRel);
  if (!mods.length) return text;
  // 严格校验（恰好命中 1 次 / 原片段不存在 / 净增字符一致）与反替换都在 tool/lib/mods.mjs，
  //   与产物侧（tool/verify.mjs 的「基线 ≡ 产物（剥 MOD）」）共用同一实现，避免两份真相源。
  return applyModManifest(text, mods);
}

export function sliceRawFromFile(origText, slice, opts = {}) {
  const fileText = readIf(slice.file);
  if (fileText === null) throw new Error(`缺少片文件 ${slice.fileRel}（先跑 node tool/rebuild-from-slices.mjs --extract）`);
  const mods = listMods(fileText);
  // 基线模式：先剥 MOD 块标记，再按声明式清单反替换，之后必须逐字节等于原版区间
  const text = opts.withMods ? fileText : applyBaselineMods(stripMods(fileText), slice.fileRel);
  const raw = origText.slice(slice.start, slice.end);
  if (slice.kind === 'verbatim') {
    return { raw, restored: text, changed: 0, text, mods };
  }
  // 引擎片：剥头部注释后反重命名（可逆）
  const body = stripHeader(text, slice);
  const { mask, balance } = maskOf(body, 0, body.length);
  if (!balance.ok) throw new Error(`${slice.fileRel} 正文括号不配平 @${balance.at}（期望 ${balance.expect}）`);
  const { text: restored, changed } = renameInCode(body, mask, slice.renamesReverse, 0, body.length);
  return { raw, restored, changed, text, mods, body };
}

/**
 * 完整校验链（多片）；返回结构化结果（供 build-byte-equal.mjs 复用与 CLI 打印）。
 *
 * 断言内容：
 *   ⓪ 原文副本 ≡ src/app-shell.html（回填基准可信）
 *   ① 每片文件还原后 ≡ 原文对应区间（verbatim 片 = 逐字节；engine 片 = 反重命名后可逆）
 *   ② 每片自身括号配平（= 该片由完整顶层语句组成，切点没有切进语句中间）
 *   ③ 按 order 拼接所有片 ≡ 原文 moduleBody 整段（816818-134565 = 682253 chars）
 *   ④ 反向自检：**逐片**篡改 1 字符，重建结果必须 ≠ 原文（校验有区分力）
 */
export function checkChain() {
  const result = { slices: [], ok: true, notes: [] };
  const shellText = readIf(SHELL);
  const origText = readIf(ORIG);
  if (!shellText) throw new Error(`读不到 ${SHELL}`);
  if (!origText) throw new Error(`读不到 ${ORIG}（原文副本）`);

  // ⓪ 原文副本必须与当前外壳逐字节一致（否则回填基准不可信）
  const copyEqual = shellText === origText;
  result.copyEqual = copyEqual;
  result.copySha = { shell: sha256(shellText), orig: sha256(origText) };
  if (!copyEqual) result.ok = false;

  const concat = [];
  for (const slice of SLICES) {
    const entry = { order: slice.order, id: slice.id, kind: slice.kind, file: slice.fileRel, start: slice.start, end: slice.end, chars: slice.chars, lib: slice.lib, conf: slice.conf };
    const text = readIf(slice.file);
    entry.exists = Boolean(text);
    if (text === null) {
      result.ok = false;
      result.slices.push(entry);
      continue;
    }
    // ① 还原 ≡ 原文区间（默认基线模式：先剥 MOD 改动块，故片段仍须逐字节等于原版区间）
    const { raw, restored, changed, mods } = sliceRawFromFile(origText, slice);
    entry.mods = (mods || []).map((x) => x.id);
    for (const id of entry.mods) {
      (result.modsById || (result.modsById = {}))[id] = (result.modsById[id] || 0) + 1;
      result.modCount = (result.modCount || 0) + 1;
    }
    entry.restoreChanged = changed;
    entry.restoreEqual = restored === raw;
    if (!entry.restoreEqual) {
      result.ok = false;
      entry.restoreDiffAt = firstDiff(restored, raw);
      entry.restoreDiffCtx = JSON.stringify(restored.slice(Math.max(0, entry.restoreDiffAt - 60), entry.restoreDiffAt + 60));
      entry.rawDiffCtx = JSON.stringify(raw.slice(Math.max(0, entry.restoreDiffAt - 60), entry.restoreDiffAt + 60));
    }
    // ② 该片自身括号配平（片 = 完整顶层语句 ⇒ 必然配平；不配平说明切点切进了语句中间）
    const bal = maskOf(restored, 0, restored.length).balance;
    entry.balanced = bal.ok;
    if (!bal.ok) {
      result.ok = false;
      entry.balanceAt = bal.at;
      entry.balanceExpect = bal.expect;
    }
    // ④ 反向自检（片级）：本片内容改 1 字符后必须不等于原片
    //   （整段级的「改任一片 ⇒ 拼接必不等」在下面 ④' 统一做）
    if (restored.length > 10) {
      const mutated = `${restored.slice(0, 5)}${restored[5] === 'x' ? 'y' : 'x'}${restored.slice(6)}`;
      entry.negativeTestDetects = mutated !== restored;
      if (!entry.negativeTestDetects) result.ok = false;
    }
    concat.push(restored);
    result.slices.push(entry);
  }

  // ③ 拼接 ≡ 原文 moduleBody
  const joined = concat.join('');
  const body = origText.slice(MODULE_BODY[0], MODULE_BODY[1]);
  result.join = {
    chars: joined.length,
    bodyChars: body.length,
    equal: joined === body,
    sha256: sha256(joined),
    bodySha256: sha256(body),
  };
  if (!result.join.equal) {
    result.ok = false;
    result.join.diffAt = firstDiff(joined, body);
  }

  // ④' 整段级反向自检：任取一片改 1 字符 ⇒ 拼接结果必不等于原文 moduleBody
  const worst = [];
  for (let i = 0; i < SLICES.length; i++) {
    const restored = concat[i];
    if (!restored || restored.length < 12) continue;
    const mutated = `${restored.slice(0, 5)}${restored[5] === 'x' ? 'y' : 'x'}${restored.slice(6)}`;
    const alt = concat.slice(0, i).concat([mutated], concat.slice(i + 1)).join('');
    if (alt === body) worst.push(SLICES[i].id);
  }
  result.negativePerSlice = { checked: SLICES.length, undetected: worst, ok: worst.length === 0 };
  if (worst.length) result.ok = false;
  return result;
}

/** 组装回填产物（可选内联运行时，供冒烟；绝不写 dist/）。
 *
 *  多片形态：moduleBody 之前的原文 + 所有片（按 order 还原）拼接 + moduleBody 之后的原文。
 *  因为区间表首尾相接，拼接结果就等于「按原偏移把每片回填」的产物。 */
export async function buildArtifact({ injectRuntimes = false } = {}) {
  const chain = checkChain();
  if (!chain.ok) throw new Error('区间回填校验未通过，拒绝产出产物');
  const origText = readIf(ORIG);
  const parts = [origText.slice(0, MODULE_BODY[0])];
  for (const slice of SLICES) {
    const { restored } = sliceRawFromFile(origText, slice);
    parts.push(restored);
  }
  parts.push(origText.slice(MODULE_BODY[1]));
  let out = parts.join('');
  if (!out.includes(PLACEHOLDER) && injectRuntimes) {
    throw new Error(`回填产物里找不到运行时占位符 ${PLACEHOLDER}`);
  }
  if (injectRuntimes) {
    const { resolveRuntimes } = await import('./resolve-runtimes.mjs');
    const rt = resolveRuntimes();
    const versions = Object.keys(rt.sources).sort((a, b) => {
      const va = a.split('.').map(Number);
      const vb = b.split('.').map(Number);
      return va[0] - vb[0] || va[1] - vb[1];
    });
    if (!versions.length) throw new Error('探测到的 Spine 运行时为空');
    out = out.replace(PLACEHOLDER, `${RUNTIME_KEY} = ${JSON.stringify(rt.sources)};`);
  }
  return { text: out, chain };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function printChain(chain) {
  const line = (b) => (b ? '✅' : '❌');
  console.log(`原文副本 src/.app-shell.orig.html ≡ src/app-shell.html：${line(chain.copyEqual)}`);
  console.log(`  shell sha256=${chain.copySha.shell}`);
  console.log(`  orig  sha256=${chain.copySha.orig}`);
  console.log(`分片表：${chain.slices.length} 片（源自 tool/slices.json）`);
  console.log('  order 文件                                    区间                        字符数  形态      还原≡原文  配平');
  for (const s of chain.slices) {
    const range = `[${s.start}, ${s.end})`;
    console.log(
      `  ${String(s.order).padStart(3)}   ${s.file.padEnd(38)} ${range.padEnd(26)} ${String(s.chars).padStart(7)}  ` +
        `${s.kind.padEnd(9)} ${line(s.exists && s.restoreEqual)}${s.kind === 'renamed' ? `(反改名 ${s.restoreChanged} 处)` : ''}      ${line(s.balanced)}`,
    );
    if (s.exists && !s.restoreEqual) {
      console.log(`        首个差异 @片段偏移 ${s.restoreDiffAt}`);
      console.log(`        片文件: ${s.restoreDiffCtx}`);
      console.log(`        原文  : ${s.rawDiffCtx}`);
    }
    if (s.exists && !s.balanced) console.log(`        ❌ 该片括号不配平 @${s.balanceAt}（期望 ${s.balanceExpect}）—— 切点切进了语句中间`);
  }
  console.log(`${line(chain.join.equal)} 按 order 拼接 ${chain.join.chars} chars ≡ 原文 moduleBody ${chain.join.bodyChars} chars（sha256=${chain.join.sha256}）`);
  if (!chain.join.equal) console.log(`    首个差异 @整段偏移 ${chain.join.diffAt}`);
  console.log(`${line(chain.negativePerSlice.ok)} 反向自检：逐片改 1 字符（${chain.negativePerSlice.checked} 片）→ 拼接结果全部被检出不等`);
  if (!chain.negativePerSlice.ok) console.log(`    未检出（校验无效）: ${chain.negativePerSlice.undetected.join(', ')}`);
  // MOD 改动块：基线模式下已被剥离（故上面的逐字节断言仍然成立），这里只做登记
  const modIds = Object.keys(chain.modsById || {});
  if (modIds.length) {
    console.log(`ℹ️  MOD 改动块（已从基线剥离，产物模式才生效）：${chain.modCount} 处 —— ${modIds.map((k) => `${k}×${chain.modsById[k]}`).join(', ')}`);
  } else {
    console.log('ℹ️  MOD 改动块：无（纯原版基线）');
  }
  console.log(chain.ok ? '✅ 区间回填校验（多片）全部通过' : '❌ 区间回填校验（多片）失败');
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
    for (const slice of SLICES) {
      let text;
      let extra = '';
      if (slice.kind === 'verbatim') {
        // 逐字节原文：**不加任何头部注释**（文件即原文片段），保证「片文件 = 构建真源」一一对应
        text = origText.slice(slice.start, slice.end);
        extra = '逐字节原文（无头部、无改名）';
      } else {
        const { renamed, changed } = extractSlice(origText, slice);
        text = `${buildHeader(slice)}\n${renamed}`;
        extra = `头部注释 + 改名 ${changed} 处（可逆）`;
      }
      fs.mkdirSync(path.dirname(slice.file), { recursive: true });
      fs.writeFileSync(slice.file, text, 'utf8');
      // 权限规范化：源文件一律 0644（历史上曾被误设为 755，源文件不应带可执行位）
      fs.chmodSync(slice.file, 0o644);
      console.log(`✅ ${slice.fileRel}  [${slice.start}, ${slice.end}) ${slice.chars} chars  ${extra}`);
    }
    const chain = checkChain();
    printChain(chain);
    process.exit(chain.ok ? 0 : 1);
  }

  if (has('--self-test')) {
    const origText = readIf(ORIG);
    // 逐片自检：任取一片改 1 字符，拼接结果必须被检出
    const chain = checkChain();
    const okAll = chain.ok;
    console.log(`${okAll ? '✅' : '❌'} --self-test：多片校验链（含逐片改 1 字符的区分力自检）${okAll ? '全部通过' : '存在失败项'}`);
    console.log(`   片数=${chain.slices.length}，拼接 ${chain.join.chars} chars ≡ 原文 moduleBody：${chain.join.equal ? '✅' : '❌'}`);
    console.log(`   逐片反向自检：${chain.negativePerSlice.ok ? `✅ ${chain.negativePerSlice.checked} 片全部检出` : `❌ 未检出: ${chain.negativePerSlice.undetected.join(', ')}`}`);
    process.exit(okAll ? 0 : 1);
  }

  const chain = checkChain();
  printChain(chain);

  const outArg = valueOf('--out');
  if (outArg) {
    const outPath = path.resolve(ROOT, outArg);
    // guard：绝不写 dist/（8803 生产产物保持不动，冒烟一律用临时目录）
    if (outPath === path.resolve(DIST) || outPath.startsWith(path.resolve(ROOT, 'dist') + path.sep)) {
      console.error('❌ 拒绝写入 dist/（生产产物保持不动；请用临时目录，如 /tmp/p2-smoke/index.html）');
      process.exit(2);
    }
    const { text } = await buildArtifact({ injectRuntimes: has('--inject-runtimes') });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, text, 'utf8');
    console.log(`✅ 回填产物已写出：${outPath}（${text.length} chars${has('--inject-runtimes') ? '，已内联运行时' : ''}）`);
    if (has('--inject-runtimes')) {
      const distText = readIf(DIST);
      if (distText) {
        console.log(`${text === distText ? '✅' : '❌'} 回填产物 + 内联运行时 ≡ dist/index.html（${sha256(text)}）`);
      }
    }
  }
  process.exit(chain.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}
