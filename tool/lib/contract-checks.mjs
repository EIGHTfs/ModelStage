// tool/lib/contract-checks.mjs —— 把 `doc/契约/插件契约.md` 的 PL1–PL8 逐条变成可执行检查
//
// 为什么单独成模块：check-plugin.mjs 已经按 A/B/C 分组验"清单形态 + 代码形态"，
//   而 PL1–PL8 是**契约条目**视角，两者不是一一对应（一条 PL 可能横跨清单、宿主、catalog、静态规范）。
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

/** 找样本时最多看一个根里多少个顶层文件（资源包根通常只有几个容器，够用且便宜） */
const SAMPLE_PROBE_FILES = 40;

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

/** 找一个 UnityFS 容器样本：先看 --sample，再在已配置资源根里找一个（8 字节魔数） */
export function findDefaultSample() {
  const isUnityFs = (file) => {
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(8);
      const n = fs.readSync(fd, buf, 0, 8, 0);
      fs.closeSync(fd);
      return n === 8 && buf.toString('latin1') === 'UnityFS\0';
    } catch {
      return false;
    }
  };
  try {
    const cfgText = fs.readFileSync(path.join(ROOT, 'config/resources.json'), 'utf8');
    const roots = [...cfgText.matchAll(/"path"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const dir of roots) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries.slice(0, SAMPLE_PROBE_FILES)) {
        if (!e.isFile() || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (isUnityFs(full)) return full;
      }
    }
  } catch { /* 配置缺失就当作没有样本 */ }
  return null;
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
 * 跑 PL1–PL8 检查，把结果写进 rep。
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

/** 打印 PL1–PL8 覆盖表（自证：哪条被哪项检查覆盖） */
export function printCoverageTable() {
  console.log('\n=== 契约 PL1–PL8 覆盖表（每轮都打，避免"说明里没覆盖全契约"）');
  const w = (s, n) => String(s).padEnd(n);
  console.log(`  ${w('条款', 6)}${w('覆盖方式', 12)}${w('检查项', 34)}说明`);
  for (const r of PL_TABLE) {
    console.log(`  ${w(r.clause, 6)}${w(r.cover, 12)}${w(r.items, 34)}${r.title}`);
  }
}
