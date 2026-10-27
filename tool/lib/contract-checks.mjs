// tool/lib/contract-checks.mjs —— 把 `docs/契约/插件.md` 的 PL1–PL9 逐条变成可执行检查
//
// 为什么单独成模块：check-plugin.mjs 已经按 A/B/C 分组验"清单形态 + 代码形态"，
//   而 PL1–PL9 是**契约条目**视角，两者不是一一对应（一条 PL 可能横跨清单、宿主、catalog、静态规范）。
//   混在一起会让"哪条契约被覆盖了"看不出来 —— 用户抱怨的正是这点。
//
// 覆盖口径（每条都必须在输出里出现，不许静默跳过）：
//   auto  = 本模块自动判定
//   unit  = 由 test/check-plugin.test.mjs 覆盖（脚本这里只登记）
//   hand  = 手工项（删除目录这类，脚本不自动增删仓库内容），输出 ⏭️ 并说明原因
//   skip  = 缺前置条件（如没有合法容器样本），输出 ⏭️ + 原因
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 判断"DOM 使用点是否有降级守卫"时向前回看的字符数（够覆盖一个函数开头的早返回） */
const GUARD_LOOKBACK = 1500;

/** 找样本时最多看一个根里多少个顶层文件（资源包根通常只有几个容器，够用且便宜） */
const SAMPLE_PROBE_FILES = 40;
/** 下探子目录时每个根最多看多少个目录（spine 容器在 `<角色>/<包>` 这层，见 listContainerCandidates） */
const SAMPLE_PROBE_DIRS = 40;

/** PL 覆盖表（打印用；改契约时同步改这里，让"覆盖了什么"自证） */
export const PL_TABLE = [
  { clause: 'PL1', title: 'provides 未声明/未知角色 ⇒ 注册失败并给原因', cover: 'auto+unit', items: 'A2a / A4 + test/check-plugin.test.mjs（temp 目录拒绝用例）' },
  { clause: 'PL2', title: 'id 重复被拒绝且不覆盖', cover: 'auto', items: 'PL2（真实宿主 register 连注册两次）' },
  { clause: 'PL3', title: '删除 plugins/<id>/ 后能力消失、条目隐藏、其它不受影响', cover: 'hand', items: 'PL3（手工项：脚本不自动删仓库目录）' },
  { clause: 'PL4', title: '未声明 produces.kind ⇒ kind:null + warning + 渲染层拒绝', cover: 'auto', items: 'PL4（catalog 断言 + 渲染层静态门禁）' },
  { clause: 'PL5', title: 'resolve 抛错 ⇒ 无半成品资产、其它模型仍可加载', cover: 'auto', items: 'PL5（坏包后再解好包）' },
  { clause: 'PL6', title: '静态检查：无 window 赋值 / 无加载器 patch / 无写死路径与游戏名', cover: 'auto', items: 'PL6（插件源码 grep）' },
  { clause: 'PL7', title: '插件可脱离核心单测（喂假 file，断言 files 与 entry）', cover: 'auto', items: 'B7 / B8 + PL7（真实容器样本 happy path）' },
  { clause: 'PL8', title: '禁用插件后不再出现在注册表与 catalog', cover: 'auto', items: 'PL8（disabled 开关断言）' },
  { clause: 'PL9', title: '双环境运行：顶层不得裸引用 window/document，DOM 依赖可降级', cover: 'auto+hand', items: 'PL9-1 静态扫描（括号深度 0）/ PL9-2 typeof 守卫提示 / PL9-3 人工核对' },
];

/** 一次性装好 node 侧的宿主垫片（plugin-host.js 需要 window/document 存在） */
async function loadHostForNode() {
  if (!globalThis.window) {
    globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { search: '' } };
  }
  if (!globalThis.document) {
    const mk = () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} });
    globalThis.document = { createElement: mk, head: mk(), body: mk(), querySelector: () => null };
  }
  const mod = await import('../../src/web/infra/plugin-host.js');
  return mod.createPluginHost({ log: () => {}, baseUrl: '' });
}

/** 读 config/resources.json 里登记的所有资源根路径（正则提取，与历史口径一致） */
function readRootPaths() {
  try {
    const cfgText = fs.readFileSync(path.join(ROOT, 'config/resources.json'), 'utf8');
    return [...cfgText.matchAll(/"path"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  } catch {
    return [];
  }
}

/** 是不是 UnityFS 容器（只读前 8 字节魔数，不读整包） */
function isUnityFsFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8);
    const n = fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    return n === 8 && buf.toString('latin1') === 'UnityFS\0';
  } catch {
    return false;
  }
}

/** 取文件大小；读不到就排到最后（不让坏条目抢先占候选名额） */
function safeSize(file) {
  try { return fs.statSync(file).size; } catch { return Number.MAX_SAFE_INTEGER; }
}

/**
 * 列出资源根里的候选容器（UnityFS 文件），排好序供调用方**逐个试插件的 canHandle**。
 *
 * 为什么要**下探一层子目录**：spine 容器在 `<角色>/<包>` 这层（实测 NIKKE/<角色>/<c200_...>），
 *   而 live2d 包直接躺在根目录第一层。只扫第一层会让 spine 插件**永远挑不到**样本，
 *   症状是「PL5 报包里没有 .skel」这种假红。以后若把这里"优化"成只扫第一层，这个 bug 会原样回来。
 * 为什么**按根轮流**取而不是全局按大小：一个根里可能有一二十个同类型包，纯按大小排序会让
 *   前 N 个候选全来自同一个根，别的类型的插件（样本在别的根）永远轮不到。
 * 为什么**只判 UnityFS 魔数、不判 spine/live2d**：类型判据只有一份 —— 插件自己的 canHandle。
 *   这里再复制一套必然与它不同步（本项目反复栽过的坑：两处实现各说各话）。
 *
 * @param {{maxFilesPerDir?: number, maxDirsPerRoot?: number}} opts 探测上限（成本控制）
 * @returns {Array<{path: string, size: number}>} 按「根轮流 + 同根内 size 升序」排好
 */
export function listContainerCandidates(opts = {}) {
  const maxFilesPerDir = opts.maxFilesPerDir ?? SAMPLE_PROBE_FILES;
  const maxDirsPerRoot = opts.maxDirsPerRoot ?? SAMPLE_PROBE_DIRS;
  const queues = [];
  for (const rootDir of readRootPaths()) {
    let topEntries = [];
    try { topEntries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch { continue; }
    const found = [];
    // ① 第一层文件（live2d 包就在这层）
    for (const entry of topEntries.slice(0, maxFilesPerDir)) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const full = path.join(rootDir, entry.name);
      if (isUnityFsFile(full)) found.push({ path: full, size: safeSize(full) });
    }
    // ② 下探一层子目录（spine 容器在这层 —— 只扫第一层会让 spine 插件永远挑不到样本）
    const subDirs = topEntries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).slice(0, maxDirsPerRoot);
    for (const sub of subDirs) {
      let inner = [];
      try { inner = fs.readdirSync(path.join(rootDir, sub.name), { withFileTypes: true }); } catch { continue; }
      for (const entry of inner.slice(0, maxFilesPerDir)) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        const full = path.join(rootDir, sub.name, entry.name);
        if (isUnityFsFile(full)) found.push({ path: full, size: safeSize(full) });
      }
    }
    if (found.length) queues.push(found.sort((a, b) => a.size - b.size));
  }
  const out = [];
  const longest = queues.reduce((max, q) => Math.max(max, q.length), 0);
  for (let i = 0; i < longest; i += 1) {
    for (const q of queues) if (i < q.length) out.push(q[i]);
  }
  return out;
}

/**
 * 兼容旧调用：返回第一个候选（没有就 null）。
 * 新代码请用 listContainerCandidates() 逐个试插件的 canHandle —— 只拿第一个必然与插件类型不匹配。
 */
export function findDefaultSample() {
  return listContainerCandidates()[0]?.path ?? null;
}

/** 收集插件源码文件（清单里声明的那些），返回 [{file, text}] */
function readPluginSources(abs, manifest) {
  const list = Array.isArray(manifest.files) && manifest.files.length
    ? manifest.files
    : [typeof manifest.entry === 'string' && manifest.entry ? manifest.entry : 'index.js'];
  const out = [];
  for (const rel of list) {
    const file = path.join(abs, rel);
    try { out.push({ file: rel, text: fs.readFileSync(file, 'utf8') }); } catch { /* 缺文件由 B1a 报 */ }
  }
  return out;
}

/**
 * PL 检查的收尾：登记"手工项"。
 * 单独成函数是为了保证**无论前面从哪条提前返回**，PL3 这条都会出现在输出里
 *   （用户抱怨的就是"说明里没覆盖全"，漏打一条等于又回到那个问题）。
 * @param {object} [rep]
 */
function finishPlChecks(rep) {
  if (!rep) return;
  rep.warn('PL3', '⏭️ 手工项（未自动覆盖）：删除 plugins/<id>/ 后刷新页面，该能力消失、条目隐藏、其它能力不受影响', 'PL3');
}

/**
 * 生成"代码掩码"：把注释、字符串（含模板）、正则字面量的**内容与引号**都替换成空格，
 * 保留换行与长度。用于"括号深度 / 顶层裸引用"这类需要真实代码结构的扫描。
 *
 * 为什么要认真做：早期版本只把 `'…'`/`"…"` 抹掉，结果
 *   ① `typeof window !== 'undefined'` 的 'undefined' 被抹 → 守卫永远匹配不到（4 处误报）；
 *   ② 正则字面量里的花括号（`/\{(\d+)\}/`）被算进深度 → 顶层判断全错（反向自证竟然没红）。
 * 这两条都是实测踩出来的，别再简化回去。
 * @param {string} src
 * @returns {string} 与 src 等长的掩码串
 */
function codeOnly(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  let state = 'code';
  let start = 0;
  // 模板插值 `${…}` 里是**代码**：其中的花括号要保留，否则深度会整体偏 1（实测：顶层判断因此全错）
  const stack = [];
  let braceInInterp = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; start = i; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; start = i; i += 2; continue; }
      if (c === "'" || c === '"') { state = c; start = i; i += 1; continue; }
      if (c === '`') { state = 'tpl'; start = i; i += 1; continue; }
      if (c === '/' ) {
        let j = i - 1;
        while (j >= 0 && /\s/.test(src[j])) j -= 1;
        const prev = j >= 0 ? src[j] : '';
        if (prev === '' || '=(,:[!&|?{};+-*%~^<>'.includes(prev)) { state = 'regex'; start = i; }
        i += 1; continue;
      }
      if (stack.length && c === '}') {
        if (braceInInterp === 0) { // 插值结束，回到模板
          out[i] = ' ';
          const top = stack.pop();
          state = 'tpl';
          start = top.start;
          i += 1; continue;
        }
        braceInInterp -= 1; i += 1; continue;
      }
      if (stack.length && c === '{') { braceInInterp += 1; i += 1; continue; }
      i += 1; continue;
    }
    if (state === 'line') { if (c === '\n') { blank(start, i); state = 'code'; } i += 1; continue; }
    if (state === 'block') {
      if (c === '*' && n === '/') { blank(start, i + 2); state = 'code'; i += 2; continue; }
      i += 1; continue;
    }
    if (state === 'regex') {
      if (c === '\\') { i += 2; continue; }
      if (c === '/') { blank(start, i + 1); state = 'code'; i += 1; continue; }
      i += 1; continue;
    }
    // 字符串内部
    if (state === "'" || state === '"') {
      if (c === '\\') { i += 2; continue; }
      if (c === state) { blank(start, i + 1); state = 'code'; i += 1; continue; }
      i += 1; continue;
    }
    // 模板字面量内部：遇到 ${ 进入插值（把前面的字面量部分抹掉）
    if (state === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '$' && n === '{') { blank(start, i + 2); stack.push({ start: i + 2 }); braceInInterp = 0; state = 'code'; i += 2; continue; }
      if (c === '`') { blank(start, i + 1); state = 'code'; i += 1; continue; }
      i += 1; continue;
    }
    i += 1;
  }
  if (state !== 'code') blank(start, src.length);
  return out.join('');
}

/**
 * 跑 PL1–PL9 检查，把结果写进 rep。
 * @param {{rep: object, abs: string, manifest: object, desc: object|null, options: {samplePath?: string|null}}} ctx
 */
export async function runContractChecks({ rep, abs, manifest, options }) {
  const id = String(manifest.id || '');

  // ---------------- PL1：provides 未声明/含未知角色 ⇒ 注册失败（清单层 A2a/A4 已判） ----------------
  {
    const bad = rep.rows.filter((r) => (r.code === 'A2a' || r.code === 'A4') && r.kind === 'fail');
    if (bad.length) rep.fail('PL1', `provides 校验未通过（见 ${bad.map((r) => r.code).join('/')}）`, 'PL1');
    else rep.ok('PL1', 'provides 已声明且角色合法（拒绝路径另由 test/check-plugin.test.mjs 的 temp 目录用例覆盖）', 'PL1');
  }

  // ---------------- PL2：id 重复必须被拒绝且不覆盖（真实宿主，不是垫片） ----------------
  try {
    const host = await loadHostForNode();
    const reg = host.host && host.host.register;
    if (typeof reg !== 'function') {
      rep.warn('PL2', '宿主未暴露 register，重复 id 行为未验证', 'PL2');
    } else {
      const probe = `__pl2_probe_${Date.now()}__`;
      const first = reg({ id: probe, name: 'first' });
      const second = reg({ id: probe, name: 'second' });
      const kept = (host.report().providers || []).filter((p) => p.id === probe);
      const ok = first === true && second === false && kept.length === 1;
      if (ok) rep.ok('PL2', '重复 id 被拒绝且保留先注册实例（连注册两次：true / false，注册表内仍 1 条）', 'PL2');
      else rep.fail('PL2', `重复 id 未被正确拒绝：first=${first} second=${second} 注册表内 ${kept.length} 条`, 'PL2');
    }
  } catch (e) {
    rep.warn('PL2', `宿主垫片加载失败，PL2 未验证：${String(e && e.message).slice(0, 100)}`, 'PL2');
  }

  // ---------------- PL4：kind:null 时 catalog 给 warning + 渲染层拒绝 ----------------
  try {
    const { resolveBundleProvider } = await import('../../src/server/data/catalog.mjs');
    const noKind = resolveBundleProvider({ readPlugins: () => [{ id: 'probe', fileKinds: ['bundle'] }] });
    const withKind = resolveBundleProvider({ readPlugins: () => [{ id: 'probe', fileKinds: ['bundle'], produces: { kind: 'live2d' } }] });
    const catalogOk = noKind.kind === null && !!noKind.warning;
    // 渲染层拒绝：装载入口必须只接受 spine / live2d 两种内容类型（kind:null 因此进不来）
    const loader = fs.readFileSync(path.join(ROOT, 'src/web/app/model-actions.js'), 'utf8');
    const renderRejects = /kind !== 'spine' && kind !== 'live2d'/.test(loader);
    if (catalogOk && renderRejects) {
      const warnText = String(noKind.warning).slice(0, 40);
      rep.ok('PL4', `kind:null 时 catalog 给 warning（"${warnText}…"），且渲染层只接受 spine/live2d`, 'PL4');
    } else {
      rep.fail('PL4', `catalog warning=${catalogOk}（kind=${noKind.kind}），渲染层拒绝=${renderRejects}`, 'PL4');
    }
    if (withKind.kind !== 'live2d') rep.warn('PL4', `声明了 produces.kind 时 catalog 未取到内容类型（得到 ${withKind.kind}）`, 'PL4');
  } catch (e) {
    rep.warn('PL4', `catalog 断言失败，PL4 未验证：${String(e && e.message).slice(0, 100)}`, 'PL4');
  }

  // ---------------- PL5：resolve 抛错后不留半成品，且后续仍能正常解析 ----------------
  try {
    const { createSandbox, loadIntoContext, isThenable } = await import('../check-plugin-host.mjs');
    const { sandbox, registered } = createSandbox();
    loadIntoContext(abs, Array.isArray(manifest.files) && manifest.files.length ? manifest.files : [manifest.entry || 'index.js'], sandbox);
    const desc = registered[registered.length - 1];
    if (!desc || typeof desc.resolve !== 'function') {
      rep.warn('PL5', '插件无 resolve（不参与解析），PL5 不适用', 'PL5');
    } else {
      // 坏包：形状合法（有 bytes/size/name）但内容不是容器
      const bad = new Uint8Array(64).fill(7);
      let threw = null;
      try {
        const r = desc.resolve({ rootId: 'probe-root', rel: 'bad.bin', name: 'bad.bin', size: bad.length, bytes: bad });
        if (isThenable(r)) await r;
      } catch (e) { threw = e; }
      if (!threw) {
        rep.fail('PL5', '坏包未抛错：说明失败时会走"返回半个结果"的路径', 'PL5');
      } else {
        // 坏包之后再用合法样本解析一次：能成功 ⇒ 失败没污染插件内部状态
        const sample = options.samplePath;
        if (!sample || !fs.existsSync(sample)) {
          rep.warn('PL5', `坏包已正确抛错（code=${threw.code || '-'}），但"无半成品/不影响其它模型"需合法样本才能验证 ⏭️ SKIP`, 'PL5');
        } else {
          try {
            const bytes = new Uint8Array(fs.readFileSync(sample));
            const r2 = desc.resolve({ rootId: 'probe-root', rel: path.basename(sample), name: path.basename(sample), size: bytes.length, bytes });
            const ret2 = isThenable(r2) ? await r2 : r2;
            const okShape = !!(ret2 && ret2.prefix && ret2.files && ret2.entry);
            if (okShape) rep.ok('PL5', `坏包抛错（code=${threw.code || '-'}）后仍能正常解析好包（prefix ${String(ret2.prefix).slice(0, 40)}…）⇒ 无残留状态`, 'PL5');
            else rep.fail('PL5', '坏包之后的合法解析返回值不完整（可能残留了半成品状态）', 'PL5');
          } catch (e2) {
            const msg = String(e2 && e2.message);
            // 垫片环境缺 DOM 能力（插件用 document 动态注入 lib）⇒ 这不是"状态残留"，是环境限制：
            //   如实标 SKIP，不把环境问题记成插件的罪。
            const envMissing = /document is not defined|window is not defined|not defined/i.test(msg);
            if (envMissing) {
              rep.warn('PL5', `坏包已正确抛错（code=${threw.code || '-'}）；好包复验受垫片环境限制 SKIP：${msg.slice(0, 80)}`, 'PL5');
            } else {
              rep.fail('PL5', `坏包之后连合法样本也解析失败：${msg.slice(0, 100)}（怀疑状态残留）`, 'PL5');
            }
          }
        }
      }
    }
  } catch (e) {
    rep.warn('PL5', `PL5 未验证：${String(e && e.message).slice(0, 100)}`, 'PL5');
  }

  // ---------------- PL6：插件源码静态检查 ----------------
  const srcs = readPluginSources(abs, manifest);
  const hits = { windowAssign: [], loaderPatch: [], absPath: [], gameName: [] };
  for (const { file, text } of srcs) {
    const code = text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const m of code.matchAll(/window\.[A-Za-z_$][\w$]*\s*=(?!=)/g)) hits.windowAssign.push(`${file}:${m[0]}`);
    for (const m of code.matchAll(/\bmain\.js\b|loaders?\s*\.\s*patch|patchLoader/g)) hits.loaderPatch.push(`${file}:${m[0]}`);
    for (const m of code.matchAll(/['"]\/(volume\d|vol\d|usr|home|opt|var|mnt)\//g)) hits.absPath.push(`${file}:${m[0]}`);
    for (const m of code.matchAll(/azurlane|nikke|destiny[_\s]?child|bd2\b/gi)) hits.gameName.push(`${file}:${m[0]}`);
  }
  const bad6 = hits.windowAssign.length + hits.loaderPatch.length + hits.absPath.length + hits.gameName.length;
  if (!bad6) {
    rep.ok('PL6', `源码静态检查通过（${srcs.length} 个文件）：无 window 赋值 / 无加载器 patch / 无写死绝对路径与游戏名`, 'PL6');
  } else {
    const detail = [
      hits.windowAssign.length ? `window 赋值 ${hits.windowAssign.slice(0, 3).join(',')}` : '',
      hits.loaderPatch.length ? `加载器 patch ${hits.loaderPatch.slice(0, 3).join(',')}` : '',
      hits.absPath.length ? `写死绝对路径 ${hits.absPath.slice(0, 3).join(',')}` : '',
      hits.gameName.length ? `写死游戏名 ${hits.gameName.slice(0, 3).join(',')}（游戏差异应走 profiles）` : '',
    ].filter(Boolean).join('；');
    rep.fail('PL6', `源码静态检查不通过：${detail}`, 'PL6');
  }
  // 附注（不计入 PL6 判定）：插件若碰 document，会把"能否离线单测"卡住 —— PL7 的 SKIP 原因通常就是它
  const docHits = srcs.filter(({ text }) => /\bdocument\s*\./.test(text)).map(({ file }) => file);
  if (docHits.length) {
    rep.warn('PL6', `插件使用 document（${docHits.join(', ')}）：契约未明文禁止，但会导致离线垫片下 happy path 不可执行（PL7 会 SKIP）`, 'PL6');
  }

  // ---------------- PL9：双环境运行（顶层不得裸引用 DOM；DOM 依赖必须可降级） ----------------
  //
  // 与 PL6 的分工（很容易混，写清楚）：
  //   · PL6 查"写"：插件不许污染全局（window.X = …）、不许 patch 加载器；
  //   · PL9 查"读"：插件在**无 DOM 环境**（node 侧 / 解包服务）被 import 时不许直接炸。
  //   典型炸法：顶层 `const host = window.SpineViewerPlugins` —— import 阶段 ReferenceError，
  //   连 catch 的机会都没有，于是"插件能在服务端跑"这件事根本做不到。
  {
    const depthAt = (code, idx) => {
      let d = 0;
      for (let i = 0; i < idx; i += 1) {
        const c = code[i];
        if (c === '{') d += 1;
        else if (c === '}') d -= 1;
      }
      return d;
    };
    const matchBrace = (code, openIdx) => {
      let d = 0;
      for (let i = openIdx; i < code.length; i += 1) {
        if (code[i] === '{') d += 1;
        else if (code[i] === '}') { d -= 1; if (d === 0) return i; }
      }
      return code.length;
    };
    const domRefsOf = (code) => {
      const refs = [];
      const re = /\b(window|document)\s*\./g;
      let m;
      while ((m = re.exec(code))) {
        refs.push({ kind: m[1], index: m.index, depth: Math.max(0, depthAt(code, m.index)), line: code.slice(0, m.index).split('\n').length });
      }
      return refs;
    };

    /** 找出"模块加载时就会被执行"的函数体：顶层 function 定义 + 该名字在顶层被调用（如 const ulb = install()） */
    const eagerSpans = (code) => {
      const fns = [];
      const re = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
      let m;
      while ((m = re.exec(code))) {
        if (depthAt(code, m.index) !== 0) continue;
        const bodyStart = code.indexOf('{', m.index);
        if (bodyStart < 0) continue;
        fns.push({ name: m[1], start: bodyStart, end: matchBrace(code, bodyStart) });
      }
      const calledAtTop = (name) => {
        const callRe = new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\s*\\(' , 'g');
        let c;
        while ((c = callRe.exec(code))) {
          const insideOwn = fns.some((f) => c.index > f.start && c.index < f.end);
          if (!insideOwn && depthAt(code, c.index) === 0) return true;
        }
        return false;
      };
      return fns.filter((f) => calledAtTop(f.name));
    };

    // 找使用点所在函数是否有"无 DOM 降级"的证据（近似）：
    //   · typeof window/document 与 'undefined' 比较；
    //   · 或函数内已有显式能力变量（本项目插件的写法：const hasDom = typeof document !== 'undefined'）。
    // ⚠ 必须用**原文**判断：掩码里 'undefined' 会被抹成空格，守卫就永远匹配不到（实测踩过 → 4 条误报）。
    const GUARD_RE = /typeof\s+(window|document)\s*[!=]==?\s*['"]undefined['"]/;
    // 语句级守卫：从上一个 ; { } 到下一个 ; 之间。**加载期**的判定必须这么严——
    //   回看几百字符会把"函数里另一条语句的 hasDom"误当成本条的守卫，
    //   结果 `const host = window.X` 这种真 bug 反而判绿（实测踩过，反向自证连续两次没红）。
    const statementGuard = (original, index) => {
      const head = original.slice(0, index);
      const cut = Math.max(head.lastIndexOf(';'), head.lastIndexOf('{'), head.lastIndexOf('}'));
      const tailIdx = original.indexOf(';', index);
      const seg = original.slice(Math.max(0, cut + 1), tailIdx < 0 ? Math.min(original.length, index + 200) : tailIdx + 1);
      return GUARD_RE.test(seg) || /\bhasDom\b/.test(seg);
    };
    // 早返回守卫：`if (typeof document === 'undefined' || …) { …; return null; }` 这种写法
    //   函数体开头的早返回同样是真守卫（本项目插件 collectParameterTable 就是这么写的）。
    //   只认"typeof 判断 + 随后 return"，避免把无关的 typeof 当成守护。
    const earlyReturnGuard = (original, index) => {
      const from = Math.max(0, index - GUARD_LOOKBACK);
      const seg = original.slice(from, index);
      return /if\s*\([^)]*typeof\s+(window|document)\s*[!=]==?\s*['"]undefined['"][\s\S]{0,300}?\breturn\b/.test(seg);
    };
    // 宽松守卫：仅用于非加载期（PL9-2 提示级），避免把"函数开头早返回"这类正常写法报成问题
    const looseGuard = (original, index) => {
      const from = Math.max(0, index - GUARD_LOOKBACK);
      const seg = original.slice(from, Math.min(original.length, index + 200));
      return GUARD_RE.test(seg) || /\bhasDom\b/.test(seg);
    };

    /**
     * 所有函数体（不分成败、任意深度）：用来判断某个 DOM 使用点"最近被哪层函数包着"。
     *
     * 为什么必须看嵌套层：插件常见写法是顶层 `function install(host)` 在文件末尾被调用一次，
     *   于是**整个 install 函数体**都算"加载期执行"。但它体内若又声明了 `async function collectParameterTable()`
     *   这类只在需要时才调的辅助函数，那些函数里的 window/document 并不会在 import 阶段执行。
     *   只按"落在顶层被调函数的 span 内"判 eager 会把它们全判成加载期裸用（实测：4 条误报）。
     * 局限（已知）：只识别 `function` 关键字（含 async）；箭头函数体暂不细分，仍按外层判断。
     */
    const allFunctionSpans = (code) => {
      const out = [];
      const re = /\bfunction\b\s*([A-Za-z_$][\w$]*)?\s*\(/g;
      let m;
      while ((m = re.exec(code))) {
        const bodyStart = code.indexOf('{', m.index);
        if (bodyStart < 0) continue;
        out.push({ name: m[1] || '(anonymous)', start: bodyStart, end: matchBrace(code, bodyStart) });
      }
      return out;
    };
    /** 离该位置最近的包裹函数（无则 null） */
    const nearestFn = (spans, idx) => {
      let best = null;
      for (const sp of spans) {
        if (idx > sp.start && idx < sp.end && (!best || sp.start > best.start)) best = sp;
      }
      return best;
    };

    const eagerHits = [];
    const lazyUnguarded = [];
    for (const { file, text } of srcs) {
      const code = codeOnly(text);
      const spans = eagerSpans(code);
      const fnSpans = allFunctionSpans(code);
      for (const r of domRefsOf(code)) {
        // 顶层的裸引用 = 真·加载期；否则看"最近的包裹函数"是不是那个在顶层被调用的函数本体：
        //   若命中点被更内层的函数包着（如 install 里声明的辅助函数），它不在 import 阶段执行。
        const holder = r.depth === 0 ? null : nearestFn(fnSpans, r.index);
        const isEager = r.depth === 0 || (holder != null && spans.some((sp) => sp.start === holder.start));
        if (isEager) {
          if (!statementGuard(text, r.index) && !earlyReturnGuard(text, r.index)) eagerHits.push(`${file}:${r.line} ${r.kind}.`);
        } else if (!looseGuard(text, r.index)) {
          lazyUnguarded.push(`${file}:${r.line} ${r.kind}.`);
        }
      }
    }
    if (eagerHits.length) {
      rep.fail('PL9', `加载时即执行的代码里裸用 DOM（无 DOM 环境 import 阶段直接抛）：${eagerHits.slice(0, 4).join('、')}`, 'PL9');
    } else {
      rep.ok('PL9', `加载期代码（顶层 + 顶层立即调用的函数）无裸 DOM 引用（${srcs.length} 个文件）`, 'PL9');
    }
    if (lazyUnguarded.length) {
      rep.warn('PL9', `非加载期函数内 DOM 使用未见 typeof 守卫，建议确认可降级：${lazyUnguarded.slice(0, 4).join('、')}`, 'PL9');
    } else {
      rep.ok('PL9', '非加载期函数内 DOM 使用点均可见降级守卫', 'PL9');
    }
    rep.warn('PL9', '⏭️ 人工核对（PL9-3）：无 DOM 环境下这些 DOM 分支应输出日志或返回值说明"已跳过"，不能静默', 'PL9');
  }

  // ---------------- PL7：happy path 是否真的跑了 ----------------
  const sample = options.samplePath;
  if (sample && fs.existsSync(sample)) {
    const ran = rep.rows.some((r) => r.code === 'B7' && r.kind === 'ok');
    if (ran) rep.ok('PL7', `已用真实容器样本跑通 resolve happy path（${path.basename(sample)}）`, 'PL7');
    else rep.warn('PL7', '⏭️ SKIP：提供了样本但 B7 未成功（见 B7 行），PL7 未验证', 'PL7');
  } else {
    rep.warn('PL7', '⏭️ SKIP：没有合法容器样本（可用 --sample <文件> 提供），resolve happy path 未验证', 'PL7');
  }

  // ---------------- PL8：禁用后不在注册表 ----------------
  // 前置：PL8 只对**仓库 plugins/ 下**的插件有意义；临时 fixture 不在那里，"禁用后消失"无从谈起
  const pluginsRoot = path.join(ROOT, 'plugins');
  const inRepoPlugins = path.dirname(path.resolve(abs)) === pluginsRoot;
  if (!inRepoPlugins) {
    rep.warn('PL8', '⏭️ SKIP：该插件不在仓库 plugins/ 下（临时 fixture），禁用开关断言不适用', 'PL8');
    finishPlChecks(rep);
    return;
  }
  try {
    const { readPlugins } = await import('../../src/server/plugins/registry.mjs');
    const pluginsDir = pluginsRoot;
    // 临时开关放系统临时目录：不往仓库里写临时文件，也避免"父目录不存在"这类噪音
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl8-switch-'));
    const tmpSwitch = path.join(tmpDir, 'plugins.json');
    fs.mkdirSync(path.dirname(tmpSwitch), { recursive: true });
    fs.writeFileSync(tmpSwitch, JSON.stringify({ disabled: [id] }), 'utf8');
    let off = [];
    try { off = readPlugins(pluginsDir, tmpSwitch).map((p) => p.id); } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
    }
    const enabled = readPlugins(pluginsDir, path.join(ROOT, 'config/plugins.json')).map((p) => p.id);
    const offOk = !off.includes(id);
    const onOk = enabled.includes(id);
    if (offOk && onOk) rep.ok('PL8', `disabled 后注册表不含 ${id}（启用时含）`, 'PL8');
    else rep.fail('PL8', `disabled 行为不符：禁用后仍含=${!offOk}，启用时含=${onOk}`, 'PL8');
  } catch (e) {
    rep.warn('PL8', `PL8 未验证：${String(e && e.message).slice(0, 100)}`, 'PL8');
  }

  finishPlChecks();
}

/** 打印 PL1–PL9 覆盖表（自证：哪条被哪项检查覆盖） */
export function printCoverageTable() {
  console.log('\n=== 契约 PL1–PL9 覆盖表（每轮都打，避免"说明里没覆盖全契约"）');
  const w = (s, n) => String(s).padEnd(n);
  console.log(`  ${w('条款', 6)}${w('覆盖方式', 12)}${w('检查项', 34)}说明`);
  for (const r of PL_TABLE) {
    console.log(`  ${w(r.clause, 6)}${w(r.cover, 12)}${w(r.items, 34)}${r.title}`);
  }
}
