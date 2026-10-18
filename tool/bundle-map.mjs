#!/usr/bin/env node
/**
 * bundle-map.mjs — P1「bundle 地图扫描」（只读侦察脚本，不修改任何文件）
 *
 * 目标（对应 doc/2026-10-14解压原版为可读源码-完整步骤.MD 阶段一 P1.1~P1.3）：
 *   1) 用「库特征串」定位第三方库（React / react-dom / framer-motion / radix / lucide /
 *      zustand / sonner / tailwind-merge / tailwindcss 产物）的起止锚点；
 *   2) 用「括号配平」精确定位渲染引擎类 `mt` 的起止（不受压缩代码里字符串/模板/正则干扰）；
 *   3) 精确定位事件层（wn 指针 Map / iu 两指距离 / Rf 滚轮 / _f/au/ru 三个 useCallback）区间；
 *   4) 输出 `window.__SPINE_RUNTIME_SOURCES__` 的**占位符位置**与**读取点位置**
 *      （磁盘产物 src/app-shell.html 里没有赋值语句——赋值只在服务端/构建期注入）；
 *   5) 边界抽查断言：任取 3 个区块，切出的字符串「拼接回原位置」后必须 ≡ 原文
 *      （即：把区块抠掉再按原偏移塞回去，结果逐字节等于原文件）。
 *
 * 为什么需要自写词法扫描（而不是朴素 indexOf('}')）：
 *   压缩代码里 `}` 大量出现在字符串、模板串、正则、注释里；直接数花括号必然错位。
 *   本脚本实现一个极简 JS 词法状态机，产出「代码位掩码」（mask[i]=1 表示该字符是真实代码），
 *   括号配平只在掩码为 1 的字符上进行 → 抗字符串/注释/正则干扰。
 *   自检：`<script type="module">` 区间内 `{}`、`()`、`[]` 在掩码上必须各自配平到 0，
 *   否则脚本报错退出（防止掩码失效导致后续所有偏移错）。
 *
 * 掩码只对 module 脚本区间生效（CSS 不是 JS：CSS 里的 `calc(var(--cb)/-2)` 之类会让
 * 朴素括号统计崩掉，且 shell/CSS 区域不需要括号级精度）。
 *
 * 用法：
 *   node tool/bundle-map.mjs                 # 人读报告（Markdown 片段）
 *   node tool/bundle-map.mjs --json          # 结构化 JSON（机器读）
 *   node tool/bundle-map.mjs --file <路径>   # 指定待扫描 HTML（默认 src/app-shell.html）
 *   node tool/bundle-map.mjs --spot          # 只跑「边界抽查」并打印 PASS/FAIL
 *
 * 依赖：仅 Node 内置 fs/path/url，零第三方依赖。
 * 路径纪律：以脚本自身位置定位项目根（tool/ 的上一级），不硬编码绝对路径。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 0. 参数与路径
// ---------------------------------------------------------------------------
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const spotOnly = argv.includes('--spot');
const traceRegex = argv.includes('--trace-regex'); // 掩码排错：打印被判定为正则的字面量（长片段可疑）
const fileArgIdx = argv.indexOf('--file');
const TARGET = fileArgIdx >= 0 ? argv[fileArgIdx + 1] : join(ROOT, 'src', 'app-shell.html');

const src = readFileSync(TARGET, 'utf8');
const N = src.length;

// 通用查找小工具（全脚本共用）
const first = (needle) => src.indexOf(needle);
const last = (needle) => src.lastIndexOf(needle);
const all = (needle, limit = 5000) => {
  const out = [];
  let i = -1;
  while ((i = src.indexOf(needle, i + 1)) !== -1 && out.length < limit) out.push(i);
  return out;
};

// P2.4：词法掩码 / 括号配平 / 代码位改名已拆到 tool/lib/js-mask.mjs（本文件只引用），
//   拆出原因：本文件原本 880 行，超过项目「单文件 ≤ 400 行」的提交要求；
//   且掩码这段与「地图数据 + 报告」职责无关，P2 的 tool/rebuild-from-slices.mjs 也复用同一实现。
import { buildCodeMask, balanceCheck, matchBrace } from './lib/js-mask.mjs';

// --- 外壳三层边界（先算出来，掩码只作用于 module 脚本区间）---
const styleOpen = first('<style>');
const styleClose = first('</style>');
const bootScriptOpen = first('<script>');
const bootScriptClose = src.indexOf('</script>', bootScriptOpen);
const moduleTag = first('<script type="module">');
const moduleBodyStart = moduleTag + '<script type="module">'.length;
const moduleClose = last('</script>');
const moduleBodyEnd = moduleClose; // 不含 </script>

const maskResult = buildCodeMask(src, moduleBodyStart, moduleBodyEnd, { traceRegex });
const mask = maskResult.mask;
const regexLog = maskResult.regexLog;

// ---------------------------------------------------------------------------
// 2. 掩码自检（配平）——防止掩码失效导致后续所有偏移错
//    balanceCheck 实现已拆到 tool/lib/js-mask.mjs（P2.4）
// ---------------------------------------------------------------------------
const balance = balanceCheck(src, mask, moduleBodyStart, moduleBodyEnd);
if (traceRegex) {
  // 掩码/配平排错用：被判定为正则的字面量里，凡「长度 > 12」或「内部含括号」的都可能是误判
  const suspicious = regexLog.filter((r) => r.text.length > 12 || /[{}\[\]()]/.test(r.text));
  console.error(`[--trace-regex] 判定为正则字面量 ${regexLog.length} 个，可疑 ${suspicious.length} 个：`);
  for (const r of suspicious.slice(0, 40)) console.error(`  @${r.start} ${JSON.stringify(r.text.slice(0, 100))}`);
}
if (!balance.ok) {
  console.error(`❌ 词法掩码自检失败：位置 ${balance.at} 括号不匹配（期望 ${balance.expect}）`);
  console.error(`   上下文：${JSON.stringify(src.slice(Math.max(0, balance.at - 120), balance.at + 60))}`);
  if (traceRegex) {
    const before = regexLog.filter((r) => r.start < balance.at).slice(-6);
    console.error('   失败点之前最后 6 个「被判为正则」的字面量：');
    for (const r of before) console.error(`     @${r.start} ${JSON.stringify(r.text.slice(0, 100))}`);
  }
  process.exit(2);
}

// matchBrace 实现已拆到 tool/lib/js-mask.mjs（P2.4）

// ---------------------------------------------------------------------------
// 3. 区块定位
// ---------------------------------------------------------------------------
/** 截取 [start,end) 的首尾摘要（用于地图文档里「内容概述」的证据） */
const brief = (start, end, head = 60, tail = 60) =>
  JSON.stringify(src.slice(start, Math.min(end, start + head))) +
  (end - start > head + tail ? ' … ' + JSON.stringify(src.slice(Math.max(start, end - tail), end)) : '');

// --- 3.2 运行时占位符 / 读取点 ---
const placeholder = first('__SPINE_RUNTIME_SOURCES_PLACEHOLDER__');
const placeholderStmtStart = placeholder >= 0 ? src.lastIndexOf('/*', placeholder) : -1;
const placeholderStmtEnd = placeholder >= 0 ? src.indexOf('*/', placeholder) + 2 : -1;
const runtimeReads = all('__SPINE_RUNTIME_SOURCES__');

// --- 3.3 渲染引擎类 mt：括号配平精确起止 ---
const MT_DECL = 'class mt{';
const mtDeclIdx = first(MT_DECL);
// 声明语句起点：`const mt=class mt{` 里的 `const mt=`（比 class 本体早 9 字符）
const mtStmtStart = src.lastIndexOf('const mt=', mtDeclIdx);
let mt = null;
if (mtDeclIdx >= 0) {
  const openBrace = mtDeclIdx + MT_DECL.length - 1;
  const closeBrace = matchBrace(src, mask, openBrace);
  const end = closeBrace + 1;
  const body = src.slice(mtDeclIdx, end);
  // 方法名清单：压缩类里「可读方法名」是本任务的 31 个方法
  const methodNames = [
    'loadSkeletonFromData', 'render', 'applyZoom', 'setCameraZoom', 'applyPan', 'resetCamera',
    'getCameraZoom', 'refreshResolution', 'dispose',
  ];
  const found = methodNames.filter((m) => body.includes(m + '('));
  const declFields = [...body.matchAll(/de\(this,"([A-Za-z0-9_$]+)"/g)].map((m) => m[1]);
  const methodDefs = [...body.matchAll(/(?:^|[,;}])\s*([A-Za-z_$][\w$]*)\s*\(([^()]|\([^()]*\))*\)\s*\{/g)].length;
  mt = {
    start: mtDeclIdx,
    stmtStart: mtStmtStart,
    end,
    bytes: end - mtDeclIdx,
    openBrace,
    closeBrace,
    nextCharAfter: JSON.stringify(src.slice(end, end + 24)),
    fields: declFields,
    readableMethods: found,
    methodLikeCount: methodDefs,
    tail: JSON.stringify(body.slice(-60)),
    // 类体之后紧跟的静态字段（de(mt,"XXX",...)）与后续 3KB 内的名字
    staticFields: [...src.slice(end, end + 4000).matchAll(/de\(mt,"([A-Za-z0-9_$]+)"/g)].map((m) => m[1]),
  };
}

// --- 3.4 事件层：指针状态 refs + 滚轮/双指/按下/移动/抬起 handlers ---
const evAnchorStart = first('oo=S.useRef(0)');
const evAnchorEnd = first('Ml=S.useCallback(()=>{');
let eventLayer = null;
if (evAnchorStart > 0 && evAnchorEnd > evAnchorStart) {
  // 语义起点：指针 Map 声明（wn=S.useRef(new Map)）所在的声明串开头
  const wnIdx = first('wn=S.useRef(new Map)');
  const declStart = src.lastIndexOf('const ', wnIdx);
  eventLayer = {
    start: declStart >= 0 ? declStart : evAnchorStart,
    end: evAnchorEnd,
    wn: wnIdx,
    iu: first('iu=(M,B)=>Math.sqrt'),
    Rf: first('Rf=S.useCallback('),
    _f: first('_f=S.useCallback('),
    au: first('au=S.useCallback('),
    ru: first('ru=S.useCallback('),
    Ml: evAnchorEnd,
    brief: brief(declStart >= 0 ? declStart : evAnchorStart, evAnchorEnd, 80, 80),
  };
}

/** 找包含 idx 的「最近外层函数/箭头函数块」（用于描述事件层宿主） */
function enclosingFunctionBlock(idx) {
  const re = /(?:function\s+[A-Za-z_$][\w$]*\s*\(|=>\s*\{|[A-Za-z_$][\w$]*\s*\([^(){}]{0,120}\)\s*\{)/g;
  let best = null;
  let m;
  while ((m = re.exec(src))) {
    const bracePos = src.indexOf('{', m.index + m[0].length - 1);
    if (bracePos < 0 || bracePos >= idx) continue;
    if (!mask[bracePos]) continue;
    const end = matchBrace(src, mask, bracePos);
    if (end < 0 || end < idx) continue;
    if (!best || bracePos > best.start) best = { start: m.index, blockStart: bracePos, end: end + 1, head: JSON.stringify(m[0].slice(0, 48)) };
  }
  return best;
}
const eventHost = eventLayer ? enclosingFunctionBlock(eventLayer.wn) : null;

// --- 3.5 第三方库特征锚点 ---
/**
 * 每个库给一组「特征串」；报告每个特征串的出现次数与首末偏移。
 * region 取「所有特征串首末偏移的最小/最大值」——这是**近似边界**（压缩产物无模块分隔符），
 * 但首末特征串之间的区间一定覆盖该库自身代码，可满足 P1「分区扫描」与后续抽取定位的需要。
 */
const LIBS = [
  { name: 'tailwindcss (CSS 产物)', kind: 'css', version: 'v4.3.3', markers: ['tailwindcss v'] },
  { name: 'react-jsx-runtime', kind: 'js', markers: ['react-jsx-runtime.production.js'] },
  { name: 'react', kind: 'js', markers: ['react.production.js', 'react.transitional.element'] },
  { name: 'scheduler', kind: 'js', markers: ['scheduler.production.js'] },
  { name: 'react-dom', kind: 'js', markers: ['react-dom.production.js'] },
  { name: 'react-dom-client', kind: 'js', markers: ['react-dom-client.production.js', 'createRoot'] },
  { name: 'zustand（推断）', kind: 'js', infer: true, markers: ['getInitialState:()=>h', 'useSyncExternalStore', 'subscribe:m=>(a.add(m)'] },
  { name: 'sonner', kind: 'js', markers: ['sonner-loading-wrapper', 'data-sonner-toast', 'sonner-spinner'] },
  { name: 'framer-motion（推断，无 license 横幅）', kind: 'js', infer: true, markers: ['framerAppearId', 'data-framer-portal-id'] },
  { name: 'lucide-react', kind: 'js', version: 'v0.468.0', markers: ['lucide-react v0.468.0'] },
  { name: 'tailwind-merge（推断）', kind: 'js', infer: true, markers: ['"color-dodge"', '"saturate"'] },
  { name: 'radix-ui（推断，Primitive 运行时）', kind: 'js', infer: true, markers: ['Symbol.for("radix-ui")', 'data-radix'] },
];

const libReport = LIBS.map((lib) => {
  const found = [];
  for (const mk of lib.markers) {
    const hits = all(mk);
    found.push({ marker: mk, count: hits.length, offsets: hits.slice(0, 8) });
  }
  const offsets = found.flatMap((f) => f.offsets);
  return {
    ...lib,
    markers: found,
    approxStart: offsets.length ? Math.min(...offsets) : null,
    approxEnd: offsets.length ? Math.max(...offsets) : null,
    hitTotal: found.reduce((a, f) => a + f.count, 0),
  };
});

// --- 3.6 license 横幅（最可靠的库起点锚）---
const licenseBanners = [];
{
  const re = /@license/g;
  let m;
  while ((m = re.exec(src))) {
    licenseBanners.push({ offset: m.index, text: JSON.stringify(src.slice(m.index, m.index + 42)) });
  }
}

// --- 3.7 React 应用组件区（判定证据：v.jsx/v.jsxs 调用点）---
const jsxCalls = [...src.matchAll(/v\.jsx{1,2}\(/g)].map((m) => m.index);
const jsxCallsAfterEngine = jsxCalls.filter((o) => o > 516050);

// --- 3.8 mt 是否「纯类」：React 使用扫描 + 候选外部符号表 ---
/**
 * 「纯类」判定 = 类体里不出现任何 React 用法。
 * 证据两路：
 *   a) React 特征串计数（`S.use…` / `he.use…` / `v.jsx` / createElement …）——注意 document.createElement("canvas") 不算 React；
 *   b) 类体里出现的「非本类绑定」的短标识符（候选外部符号），逐个到 bundle 里找定义位置。
 * 注意：这里是无作用域分析的正则粗筛（局部变量也可能被列为候选），文档中必须标注「候选」。
 */
const REACT_PATTERNS = ['S.use', 'he.use', 'v.jsx', 'v.jsxs', 'useState', 'useRef', 'useEffect', 'useCallback', 'useMemo', 'createElement'];
let mtDeps = null;
if (mt) {
  const body = src.slice(mt.start, mt.end);
  const reactHits = REACT_PATTERNS.map((p) => {
    const hits = [];
    let i = -1;
    while ((i = body.indexOf(p, i + 1)) !== -1) hits.push(mt.start + i);
    return { pattern: p, count: hits.length, offsets: hits.slice(0, 6) };
  });
  // 类体里出现的短标识符（去重计数），排除 de(this,"x") 里的字段名与 de(mt,"x") 静态名
  const ownNames = new Set([...body.matchAll(/de\(this,"([A-Za-z0-9_$]+)"/g)].map((m) => m[1]));
  const identCount = new Map();
  for (let i = mt.start; i < mt.end; i++) {
    if (!mask[i]) continue;
    const c = src[i];
    if (!/[A-Za-z_$]/.test(c)) continue;
    if (i > mt.start && /[\w$]/.test(src[i - 1])) continue;
    let j = i;
    while (j < mt.end && /[\w$]/.test(src[j])) j++;
    const name = src.slice(i, j);
    if (i > 0 && src[i - 1] === '.') continue; // 属性名不算
    identCount.set(name, (identCount.get(name) ?? 0) + 1);
    i = j - 1;
  }
  // 排除：本类字段名、方法名片段（含 '.' 访问的已排除）、关键字、浏览器/语言内置
  const KEYWORDS = new Set(['class', 'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'this', 'typeof', 'instanceof', 'in', 'of', 'try', 'catch', 'finally', 'throw', 'delete', 'void', 'yield', 'await', 'async', 'static', 'get', 'set', 'super', 'extends', 'default', 'export', 'import', 'from', 'null', 'undefined', 'true', 'false', 'NaN', 'Infinity', 'skeleton', 'atlas']);
  const GLOBALS = new Set(['Object', 'Math', 'Array', 'Number', 'String', 'Boolean', 'JSON', 'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'RangeError', 'console', 'window', 'document', 'navigator', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array', 'Float32Array', 'Float64Array', 'Uint8ClampedArray', 'ArrayBuffer', 'DataView', 'Blob', 'URL', 'Image', 'ImageData', 'OffscreenCanvas', 'Symbol', 'Proxy', 'Reflect', 'Date', 'RegExp', 'Function', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'atob', 'btoa', 'TextEncoder', 'TextDecoder', 'globalThis', 'structuredClone', 'queueMicrotask', 'DOMParser', 'XMLHttpRequest', 'fetch', 'CustomEvent', 'Event', 'HTMLElement', 'devicePixelRatio', 'location', 'FileReader', 'File', 'FormData', 'self']);
  // 类体内「已声明/已绑定」的名字集合（正则粗集：函数名、var/let/const、catch 参数、
  // 方法参数表、箭头参数、解构/赋值左值）。这是在无解析器情况下能拿到的最接近「作用域」的近似：
  // 只要某个名字在类体里被声明过，就不再当作外部符号候选（宁可漏报外部符号，也不要把局部变量灌进表里）。
  const boundInBody = new Set([...ownNames]);
  const bindPatterns = [
    /function\s+([A-Za-z_$][\w$]*)/g,
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /catch\s*\(\s*([A-Za-z_$][\w$]*)/g,
    /([A-Za-z_$][\w$]*)\s*=>/g,
    /\b([A-Za-z_$][\w$]*)\s*\(([^()]{0,200})\)\s*\{/g, // 方法/函数参数表
    /,\s*([A-Za-z_$][\w$]*)\s*=/g, // 连续声明 a=1,b=2
  ];
  for (const re of bindPatterns) {
    let mm;
    while ((mm = re.exec(body))) {
      if (mm.length === 3 && mm[2] !== undefined) {
        // 参数表：拆逗号，去掉解构括号/默认值后取左侧标识符
        for (const raw of mm[2].split(',')) {
          const nm = raw
            .replace(/[{}[\]]/g, '')
            .replace(/^\.\.\./, '')
            .split(/[=:]/)[0]
            .trim();
          if (/^[A-Za-z_$][\w$]*$/.test(nm)) boundInBody.add(nm);
        }
      } else {
        boundInBody.add(mm[1]);
      }
    }
  }
  boundInBody.add('mt'); // 类自身引用不算外部符号
  const candidates = [...identCount.entries()]
    .filter(([n]) => !boundInBody.has(n) && !KEYWORDS.has(n) && !GLOBALS.has(n) && n.length <= 3 && !/^\d/.test(n))
    .sort((a, b) => b[1] - a[1]);
  // 给每个候选找定义位置（function X( / const X= / var X= / let X= / ,X= ）
  const resolveDef = (name) => {
    const pats = [`function ${name}(`, `const ${name}=`, `let ${name}=`, `var ${name}=`, `,${name}=`, `;${name}=`];
    const hits = [];
    for (const p of pats) {
      let i = -1;
      while ((i = src.indexOf(p, i + 1)) !== -1 && hits.length < 4) hits.push({ at: i, pat: p });
    }
    return hits;
  };
  mtDeps = {
    reactHits,
    // 「纯类」判定：除 document.createElement("canvas")（WebGL 画布，非 React）外，
    // 任何 React 特征串命中都算不纯。
    reactFree: reactHits.every((h) => h.count === 0 || h.pattern === 'createElement'),
    canvasCreateElement: [...body.matchAll(/document\.createElement\("canvas"\)/g)].length,
    candidates: candidates.slice(0, 30).map(([name, count]) => ({ name, count, defs: resolveDef(name).slice(0, 3) })),
  };
}

// ---------------------------------------------------------------------------
// 3.9 人工核定分区表（P1 地图主体）
// ---------------------------------------------------------------------------
/**
 * 压缩产物没有模块分隔符，所以「vendors 边界」只能给近似值；
 * 本表把每个区块的 [start, end) 与置信度、依据锚点全部写死，并做**锚点自校验**：
 * 每个区块的 anchor 必须恰好出现在 start 偏移处，否则报 ❌（防止手抄偏移出错）。
 * confidence: 精确 = 由 license 横幅/括号配平/语句边界给出；近似 = 由特征串推定。
 */
const REGIONS = [
  // ---- 外壳（HTML 层，非 JS）----
  { id: 'S1', name: 'HTML head 前缀', start: 0, end: 410, kind: 'shell', conf: '精确', deps: '无', note: '版权注释 + DOCTYPE/meta/title', anchor: '<!-- Vibed by Souling & 豆包 -->' },
  { id: 'S2', name: 'tailwindcss v4.3.3 CSS 产物 + 自定义 CSS', start: 410, end: 134378, kind: 'shell', conf: '精确', deps: '无（纯 CSS）', note: '`<style>` 到 `</style>`，含 radix/sonner 选择器', anchor: '<style>' },
  { id: 'S3', name: 'boot 内联脚本（SINGLE_FILE + 运行时占位符）', start: 134380, end: 134543, kind: 'shell', conf: '精确', deps: '无', note: '含 /*__SPINE_RUNTIME_SOURCES_PLACEHOLDER__*/ @134426', anchor: '<script>' },
  { id: 'S4', name: 'module script 开标签', start: 134543, end: 134565, kind: 'shell', conf: '精确', deps: '无', note: '<script type="module">', anchor: '<script type="module">' },
  { id: 'S5', name: 'module 脚本收尾 + HTML 尾', start: 816818, end: 816875, kind: 'shell', conf: '精确', deps: '无', note: '</script></body></html> + 版权注释', anchor: '</script></body>' },
  // ---- module 体：vendor ----
  { id: 'V0', name: '打包器前导（CJS interop / 私有字段助手 de/dn/db/gm）', start: 134565, end: 136282, kind: 'vendor', conf: '精确', deps: '无', note: 'mt 用到的 de() 就在这里；起点是 module 体首换行 + `/* banner */`', anchor: '\n/* 6LGG5YyFICYgU291bGluZw== */' },
  { id: 'V1', name: 'react-jsx-runtime.production.js', start: 136282, end: 137006, kind: 'vendor', conf: '精确', deps: 'react', note: 'license 横幅 @136289', anchor: '/**\n * @license React\n * react-jsx-runtime' },
  { id: 'V2', name: 'react.production.js', start: 137006, end: 145132, kind: 'vendor', conf: '精确', deps: '无', note: 'license 横幅 @137013', anchor: '/**\n * @license React\n * react.production.js' },
  { id: 'V3', name: 'scheduler.production.js', start: 145132, end: 149006, kind: 'vendor', conf: '精确', deps: '无', note: 'license 横幅 @145139', anchor: '/**\n * @license React\n * scheduler.production.js' },
  { id: 'V4', name: 'react-dom.production.js', start: 149006, end: 152847, kind: 'vendor', conf: '精确', deps: 'react', note: 'license 横幅 @149013', anchor: '/**\n * @license React\n * react-dom.production.js' },
  { id: 'V5', name: 'react-dom-client.production.js（React DOM 客户端主体）', start: 152847, end: 331154, kind: 'vendor', conf: '近似', deps: 'react/scheduler', note: 'license 横幅 @152854；主体为 173.6KB 的 CJS 包装语句 [153099, 330859)；end 由 zustand 起点界定', anchor: '/**\n * @license React\n * react-dom-client' },
  { id: 'V6', name: 'zustand（createStore/useStore）', start: 331154, end: 333523, kind: 'vendor', conf: '近似', deps: 'react(useSyncExternalStore)', note: '`const wb=n=>{` createStore + `yT`/`Mb`', anchor: 'const wb=n=>{let t;const a=new Set' },
  { id: 'V7', name: 'sonner（Toast 组件 + 样式注入）', start: 333523, end: 366680, kind: 'vendor', conf: '近似', deps: 'react', note: '含注入 `:where(html[dir="ltr"])…` 的样式字符串 @339671', anchor: 'var wT=n=>{switch(n){' },
  // ---- module 体：应用层（原版 业务）----
  { id: 'A1', name: '应用 store（zustand hook Fe）+ 模型源判定工具', start: 366680, end: 382123, kind: 'app', conf: '近似', deps: 'zustand', note: '`const Fe=vT((n,t)=>({models:[]…` [367348, 382146)；末声明 `,qp=…` 属 framer（同一 const 语句）', anchor: 'function pd(n){return n.source==="mock"' },
  { id: 'V8', name: 'framer-motion（含 motion-dom / motion-utils）', start: 382123, end: 496774, kind: 'vendor', conf: '近似', deps: 'react', note: '无 license 横幅；特征串 framerAppearId@389671；起点是 `qp=S.createContext({})`（与 A1 同一条 const 语句 → declarator 级边界）', anchor: 'qp=S.createContext({})' },
  { id: 'V9', name: 'lucide-react v0.468.0 图标体', start: 496774, end: 515981, kind: 'vendor', conf: '精确', deps: 'react', note: '47 个 license 横幅（首个 @496781）；图标用 _e(name, shapes) 生成', anchor: '/**\n * @license lucide-react v0.468.0' },
  { id: 'A2', name: 'lucide 尾部图标 + 应用常量（同一条 const 语句）', start: 515981, end: 521938, kind: 'app', conf: '精确', deps: 'lucide', note: '`bw=_e("X",…)`, `Sd=["3.6",…]`, `WD={"/spine-runtimes/…"}` 同一 const 语句 → 语句级无边界', anchor: 'const bw=_e("X",' },
  { id: 'A3', name: '引擎辅助区（运行时/贴图/滤镜/着色器）', start: 521938, end: 534612, kind: 'app', conf: '近似', deps: '无（自包含）', note: 'mt 的 12 个外部符号全在这里定义（Yd/Tp/Ep/xw/rk/sk/lk/Io/Od/Fm/yk/vk）', anchor: 'let Yd=' },
  { id: 'E1', name: '★ mt 渲染引擎类（const mt=class mt{…}）', start: 534612, end: 588577, kind: 'engine', conf: '精确', deps: 'V0(的 de)、A3(12 个符号)', note: '类体 [534621, 588576) 53955 chars；76 私有字段；31 方法；无 React', anchor: 'const mt=class mt{' },
  { id: 'E2', name: 'mt 静态字段（de(mt,"NON_SUBJECT_RE",…) 等 8 个）', start: 588577, end: 589360, kind: 'engine', conf: '精确', deps: 'E1', note: '正则/阈值常量', anchor: 'de(mt,"NON_SUBJECT_RE"' },
  { id: 'A4', name: '内联 ZIP worker 源码字符串（const bk=`…`）', start: 589360, end: 595123, kind: 'app', conf: '精确', deps: '无', note: '字符串里是独立 worker 脚本（ZIP 解包）', anchor: 'const bk=`' },
  { id: 'A5', name: '引擎/应用其余工具（导出、GL 特效等）', start: 595123, end: 607391, kind: 'app', conf: '近似', deps: 'E1', note: '起点 `let Xa=null,kc=null,aa=!1;function xk(){`', anchor: 'let Xa=null,kc=null,aa=!1;' },
  { id: 'V10', name: 'tailwind-merge（类名冲突合并）', start: 607391, end: 623920, kind: 'vendor', conf: '近似', deps: '无', note: '`const xt=n=>{…isThemeGetter…}`；`"color-dodge"` @609313', anchor: 'const xt=n=>{' },
  { id: 'A6', name: 'shadcn UI 基础组件（cn/pn=twMerge+clsx、Button 等）', start: 623920, end: 638730, kind: 'app', conf: '近似', deps: 'V10, radix', note: '`function pn(...n){return uj(Pw(n))}`；Button @624800', anchor: 'function pn(...n){return uj(Pw(n))}' },
  { id: 'V11', name: 'radix-ui primitives（Primitive/Slider/Dialog/Menu…）', start: 638730, end: 720789, kind: 'vendor', conf: '近似', deps: 'react', note: '`window[Symbol.for("radix-ui")]=!0` @631246（在 A6 内）；末尾 data-radix @717906', anchor: 'var Lj=Object.defineProperty,Je=(n,t)=>' },
  { id: 'A7', name: '应用 UI 组件（右栏/工具栏等，含 radix 封装）', start: 720789, end: 739199, kind: 'app', conf: '近似', deps: 'V11, A6', note: '起点 `function EM(n){return n?"open":"closed"}`', anchor: 'function EM(n){return n?' },
  { id: 'A8', name: '★ 主应用组件 function AL(...)（含事件层）', start: 739199, end: 810874, kind: 'app', conf: '精确', deps: 'E1, A1, A6, V11', note: '70KB；事件层 [746389, 748274) 在其中', anchor: 'function AL({bootPhase:' },
  { id: 'A9', name: '收尾：demo 模型模块（jL/kL）', start: 810874, end: 816818, kind: 'app', conf: '精确', deps: 'A1', note: '起点 `function RL(){const{loadSettings:n}=Fe(),…`', anchor: 'function RL(){const{loadSettings:n}=Fe()' },
];

/** 锚点自校验：anchor 必须恰好出现在记录的 start 处 */
const regionCheck = REGIONS.map((r) => {
  const ok = src.startsWith(r.anchor, r.start);
  return { id: r.id, ok, note: ok ? '' : `锚点不在 @${r.start}：期望 ${JSON.stringify(r.anchor)}，实际 ${JSON.stringify(src.slice(r.start, r.start + r.anchor.length))}` };
});
/** 分区表自检：module 体各区块必须首尾相接、无缝覆盖 [134565, 816818) */
const moduleRegions = REGIONS.filter((r) => r.kind !== 'shell').sort((a, b) => a.start - b.start);
const coverNotes = [];
for (let i = 0; i < moduleRegions.length; i++) {
  const prev = moduleRegions[i - 1];
  const r = moduleRegions[i];
  if (i === 0) {
    if (r.start !== 134565) coverNotes.push(`首块 ${r.id} start=${r.start} ≠ 134565`);
  } else if (prev.end !== r.start) {
    coverNotes.push(`${prev.id}[${prev.start},${prev.end}) → ${r.id} start=${r.start}：不连续`);
  }
}
const lastR = moduleRegions[moduleRegions.length - 1];
if (lastR.end !== 816818) coverNotes.push(`末块 ${lastR.id} end=${lastR.end} ≠ 816818`);


// ---------------------------------------------------------------------------
// 4. 边界抽查（V1 硬性验收）
// ---------------------------------------------------------------------------
/**
 * 做法：取 3 个区块 [start,end]，先把它们从原文中「抠掉」，再把抠出的字符串
 * 按原偏移「塞回」，结果必须逐字节 ≡ 原文。
 * 这同时验证了三件事：
 *   a) 记录的三元组 (start,end) 与原文一致（切片内容可复现）；
 *   b) 区块互不重叠、可被独立切出与回填（不破坏上下文）；
 *   c) 切分方案覆盖完整（拼回后长度、内容一致）。
 */
function spotCheck(blocks) {
  // a) 逐块内容复现
  const perBlock = blocks.map((b) => {
    const slice = src.slice(b.start, b.end);
    const again = src.slice(b.start, b.end);
    return { name: b.name, start: b.start, end: b.end, bytes: b.end - b.start, identical: slice === again, head: JSON.stringify(slice.slice(0, 40)), tail: JSON.stringify(slice.slice(-40)) };
  });
  // b) 抠掉 → 回填 ≡ 原文
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  let rest = '';
  let cursor = 0;
  for (const b of sorted) {
    rest += src.slice(cursor, b.start);
    cursor = b.end;
  }
  rest += src.slice(cursor);
  let rebuilt = '';
  let pos = 0;
  let idx = 0;
  for (const b of sorted) {
    // 在 rest 中定位到下个区块原文应在的位置：用「原文偏移 - 已抠走长度」换算
    const target = b.start - idx;
    rebuilt += rest.slice(pos, target);
    rebuilt += src.slice(b.start, b.end);
    pos = target;
    idx += b.end - b.start;
  }
  rebuilt += rest.slice(pos);
  const identical = rebuilt === src;
  // c) 定位首个不一致处（便于失败时排错）
  let diffAt = -1;
  if (!identical) {
    const min = Math.min(rebuilt.length, src.length);
    for (let i = 0; i < min; i++) {
      if (rebuilt[i] !== src[i]) {
        diffAt = i;
        break;
      }
    }
    if (diffAt < 0) diffAt = min;
  }
  return { perBlock, rebuiltIdentical: identical, rebuiltLen: rebuilt.length, srcLen: N, diffAt };
}

const checkBlocks = [];
if (mt) checkBlocks.push({ name: 'mt 渲染引擎类', start: mt.start, end: mt.end });
if (eventLayer) checkBlocks.push({ name: '事件层（指针+缩放）', start: eventLayer.start, end: eventLayer.end });
// 第三个区块：react-dom-client license 横幅所在区块（第三方库锚点区块，固定取横幅后 4096 字符）
{
  const b = licenseBanners.find((x) => x.text.includes('react-dom-client'));
  if (b) checkBlocks.push({ name: 'react-dom-client 横幅区块', start: b.offset, end: Math.min(N, b.offset + 4096) });
}
const spot = spotCheck(checkBlocks);

// ---------------------------------------------------------------------------
// 4b. 可选：用真实 JS 解析器（acorn）交叉验证词法掩码
// ---------------------------------------------------------------------------
/**
 * 默认零依赖；若给出 `--cross-check <含 acorn 的 node_modules 目录>`（或环境变量 ACORN_DIR），
 * 则用 acorn 解析 module 脚本，把「字面量 / 注释 / 模板串定界符」视作非代码位，
 * 与掩码逐字符比对括号归属。分歧应为 0；不为 0 说明掩码有误，必须修脚本再出图。
 * 注意：acorn 只是开发期校验工具，不写进项目依赖。
 */
async function crossCheckAcorn(dir) {
  const { createRequire } = await import('node:module');
  const req = createRequire(dir.endsWith('/') ? dir : dir + '/');
  const acorn = req('acorn');
  const code = src.slice(moduleBodyStart, moduleBodyEnd);
  const litRanges = [];
  const comments = [];
  const templateDelims = new Set();
  let templateCount = 0;
  const ast = acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    locations: false,
    onComment: (isBlock, text, start, end) => comments.push([start, end]),
  });
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node.type === 'string') {
      if (node.type === 'Literal' && (node.regex || typeof node.value === 'string')) litRanges.push([node.start, node.end]);
      else if (node.type === 'TemplateElement') litRanges.push([node.start, node.end]);
      else if (node.type === 'JSXText') litRanges.push([node.start, node.end]);
      else if (node.type === 'TemplateLiteral') {
        templateCount++;
        for (let i = node.start; i < node.end - 1; i++) if (code[i] === '$' && code[i + 1] === '{') templateDelims.add(i + 1);
        for (const e of node.expressions) templateDelims.add(e.end);
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'start' || k === 'end' || k === 'loc') continue;
      walk(node[k]);
    }
  })(ast);
  const truth = new Uint8Array(code.length).fill(1);
  for (const [a, b] of litRanges) for (let i = a; i < b; i++) truth[i] = 0;
  for (const [a, b] of comments) for (let i = a; i < b; i++) truth[i] = 0;
  for (const d of templateDelims) truth[d] = 0;
  let diff = 0;
  let bracketTotal = 0;
  const samples = [];
  for (let i = 0; i < code.length; i++) {
    if (!'{}()[]'.includes(code[i])) continue;
    bracketTotal++;
    const m = mask[moduleBodyStart + i] ? 1 : 0;
    const t = truth[i] ? 1 : 0;
    if (m !== t) {
      diff++;
      if (samples.length < 5) samples.push({ at: moduleBodyStart + i, ch: code[i], mask: m, truth: t });
    }
  }
  return { bracketTotal, diff, samples, literals: litRanges.length, comments: comments.length, templates: templateCount, templateDelims: templateDelims.size };
}
const crossCheckDir = (() => {
  const i = argv.indexOf('--cross-check');
  if (i >= 0) return argv[i + 1];
  return process.env.ACORN_DIR || null;
})();
let crossCheck = null;
if (crossCheckDir) {
  try {
    crossCheck = await crossCheckAcorn(crossCheckDir);
  } catch (err) {
    crossCheck = { error: err.message };
  }
}

// ---------------------------------------------------------------------------
// 5. 输出
// ---------------------------------------------------------------------------
const report = {
  target: TARGET,
  chars: N,
  bytes: Buffer.byteLength(src, 'utf8'),
  balance: balance.counts,
  shell: {
    style: [styleOpen, styleClose + '</style>'.length],
    bootScript: [bootScriptOpen, bootScriptClose + '</script>'.length],
    moduleTag: [moduleTag, moduleBodyStart],
    moduleBody: [moduleBodyStart, moduleBodyEnd],
    moduleClose: [moduleClose, moduleClose + '</script>'.length],
  },
  runtimePlaceholder: { start: placeholderStmtStart, end: placeholderStmtEnd, raw: placeholder },
  runtimeReads,
  mt,
  mtDeps,
  eventLayer,
  eventHost,
  regions: REGIONS,
  regionCheck,
  coverNotes,
  libs: libReport,
  licenseBanners,
  jsx: { total: jsxCalls.length, first: jsxCalls[0], last: jsxCalls[jsxCalls.length - 1], firstAfterEngine: jsxCallsAfterEngine[0], lastAfterEngine: jsxCallsAfterEngine[jsxCallsAfterEngine.length - 1] },
  crossCheck,
  spot,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(spot.rebuiltIdentical && regionCheck.every((r) => r.ok) ? 0 : 1);
}

if (spotOnly) {
  for (const b of spot.perBlock) console.log(`${b.identical ? '✅' : '❌'} ${b.name} [${b.start}, ${b.end}) ${b.bytes} chars`);
  console.log(`${spot.rebuiltIdentical ? '✅' : '❌'} 抠掉→回填 ≡ 原文（${spot.rebuiltLen} / ${N} chars）`);
  process.exit(spot.rebuiltIdentical ? 0 : 1);
}

const L = [];
L.push('# bundle-map.mjs 扫描结果（自动生成，勿手改）');
L.push('');
L.push(`- 目标：\`${TARGET}\``);
L.push(`- 长度：${N} chars / ${report.bytes} bytes`);
L.push(`- 掩码自检（代码位括号计数）：{} ${balance.counts['{']}/${balance.counts['}']}，() ${balance.counts['(']}/${balance.counts[')']}，[] ${balance.counts['[']}/${balance.counts[']']}`);
L.push(`- 分区表锚点自检：${regionCheck.every((r) => r.ok) ? '✅ 全部通过' : '❌ ' + regionCheck.filter((r) => !r.ok).map((r) => r.id).join(',')}`);
L.push(`- 分区表覆盖自检：${coverNotes.length === 0 ? '✅ 模块体 [134565, 816818) 首尾相接、无缝覆盖' : '❌ ' + coverNotes.join(' | ')}`);
L.push('');
L.push('## 人工核定分区表');
L.push('| id | 区间 | 大小 | 类别 | 置信 | 名称 | 依赖 | 依据/备注 |');
L.push('|----|------|------|------|------|------|------|-----------|');
for (const r of REGIONS) {
  const check = regionCheck.find((x) => x.id === r.id);
  L.push(`| ${r.id}${check.ok ? '' : ' ⚠️'} | [${r.start}, ${r.end}) | ${((r.end - r.start) / 1024).toFixed(1)}KB | ${r.kind} | ${r.conf} | ${r.name} | ${r.deps} | ${r.note} |`);
}
L.push('');
L.push('## 外壳（HTML 层）');
for (const [k, v] of Object.entries(report.shell)) L.push(`- ${k}: [${v[0]}, ${v[1]})`);
L.push('');
L.push('## 运行时占位符 / 读取点');
L.push(`- 占位符注释: [${placeholderStmtStart}, ${placeholderStmtEnd})`);
L.push(`- 读取点 (__SPINE_RUNTIME_SOURCES__): ${runtimeReads.join(', ')}`);
L.push('');
L.push('## mt 渲染引擎类');
if (mt) {
  L.push(`- 声明语句: [${mt.stmtStart}, ${mt.end})（const mt=class mt{…}）`);
  L.push(`- 类体: [${mt.start}, ${mt.end}) 共 ${mt.bytes} chars`);
  L.push(`- 括号: { @${mt.openBrace} → } @${mt.closeBrace}`);
  L.push(`- 紧随其后: ${mt.nextCharAfter}`);
  L.push(`- 静态字段(${mt.staticFields.length}): ${mt.staticFields.join(', ')}`);
  L.push(`- de(this,...) 字段(${mt.fields.length}): ${mt.fields.join(', ')}`);
  L.push(`- 可读方法命中: ${mt.readableMethods.join(', ')}`);
  L.push(`- 尾部: ${mt.tail}`);
}
L.push('');
L.push('## mt 依赖判定（是否纯类）');
if (mtDeps) {
  L.push(`- React 特征串命中：${mtDeps.reactHits.map((h) => `${h.pattern}×${h.count}`).join('，')} → ${mtDeps.reactFree ? '✅ 全部为 0（类体内无 React）' : '❌ 有命中，需人工核对'}`);
  L.push(`- document.createElement("canvas") ×${mtDeps.canvasCreateElement}（WebGL 画布，不属于 React 用法）`);
  L.push('- 候选外部符号（类体内出现的短标识符，粗筛；含定义位置）：');
  for (const c of mtDeps.candidates) L.push(`    - ${c.name} ×${c.count} → ${c.defs.map((d) => `${d.pat}@${d.at}`).join(' / ') || '(未定位)'}`);
}
L.push('');
L.push('## 事件层');
if (eventLayer) {
  L.push(`- 区间: [${eventLayer.start}, ${eventLayer.end})`);
  L.push(`- wn=${eventLayer.wn} iu=${eventLayer.iu} Rf=${eventLayer.Rf} _f=${eventLayer._f} au=${eventLayer.au} ru=${eventLayer.ru} Ml=${eventLayer.Ml}`);
}
if (eventHost) L.push(`- 宿主函数块: [${eventHost.start}, ${eventHost.end}) head=${eventHost.head}`);
L.push('');
L.push('## 第三方库锚点');
for (const lib of libReport) {
  L.push(`- ${lib.name}: approx [${lib.approxStart}, ${lib.approxEnd}] hits=${lib.hitTotal}`);
  for (const m of lib.markers) L.push(`    - ${m.marker} × ${m.count} @ ${m.offsets.join(', ')}`);
}
L.push('');
L.push('## license 横幅');
for (const b of licenseBanners) L.push(`- @${b.offset} ${b.text}`);
L.push('');
L.push('## JSX 调用');
L.push(`- v.jsx/v.jsxs 总数 ${report.jsx.total}；首个 @${report.jsx.first}，末个 @${report.jsx.last}`);
L.push(`- 引擎区(>516050)之后：首个 @${report.jsx.firstAfterEngine}，末个 @${report.jsx.lastAfterEngine}`);
L.push('');
L.push('## acorn 交叉验证（可选）');
if (!crossCheck) L.push('- 未启用（加 `--cross-check <acorn 所在 node_modules 目录>` 或设 ACORN_DIR）');
else if (crossCheck.error) L.push(`- ❌ 失败：${crossCheck.error}`);
else {
  L.push(`- 对比括号字符 ${crossCheck.bracketTotal} 个：字面量 ${crossCheck.literals} / 注释 ${crossCheck.comments} / 模板串 ${crossCheck.templates} / 模板定界符 ${crossCheck.templateDelims}`);
  L.push(`- ${crossCheck.diff === 0 ? '✅' : '❌'} 与 acorn AST 判定不一致的括号：${crossCheck.diff} 处`);
  for (const s of crossCheck.samples) L.push(`    - 分歧 @${s.at} '${s.ch}' 掩码=${s.mask} 真值=${s.truth}`);
}
L.push('');
L.push('## 边界抽查（V1）');
for (const b of spot.perBlock) L.push(`- ${b.identical ? '✅' : '❌'} ${b.name} [${b.start}, ${b.end}) ${b.bytes} chars`);
L.push(`- ${spot.rebuiltIdentical ? '✅' : '❌'} 抠掉→回填 ≡ 原文（${spot.rebuiltLen} / ${N} chars${spot.rebuiltIdentical ? '' : `，首个差异 @${spot.diffAt}`}）`);
console.log(L.join('\n'));
process.exit(spot.rebuiltIdentical && regionCheck.every((r) => r.ok) ? 0 : 1);
