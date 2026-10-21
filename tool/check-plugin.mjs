#!/usr/bin/env node
// check-plugin.mjs —— 插件合法性检查（把 `doc/契约/插件契约.md` 的条款变成可执行检查）
//
// 用法：
//   node tool/check-plugin.mjs plugins/unity-live2d-bundle
//   node tool/check-plugin.mjs --all plugins
//   node tool/check-plugin.mjs --all plugins --json     （机器可读）
//
// 输出：每条一行 ✅ / ⚠️ / ❌ + 依据（引用契约章节号）；有 ❌ 时退出码非零，可直接进 CI。
//
// ---------------------------------------------------------------------------
// 边界（重要，别把它当成"能装就能跑"的证明）
//
// · 只验**形态合法性**，不验真实渲染：能不能真的装载一个包，仍必须跑页面
//   （渲染链路、纹理解码、VirtualFS 注册都在浏览器里）。
// · 代码层用 `node:vm` 注入**自写垫片**当宿主，不启浏览器。垫片与真实宿主的偏差
//   就是本工具的盲区；垫片按契约 §3.6 的 host 形状实现（log / fetchFile），
//   且刻意保持"最小能力"——垫片越像真宿主，检查才越有意义。
// · 垫片只实现了契约 §3.6 里的三件能力：register / log / fetchFile。
//   插件若依赖其它宿主能力（例如自定义的 host.xxx、真实 fetchFile 读字节），在垫片下会失败或被误报 ——
//   **这是已知盲区**：本工具不覆盖全部运行时行为，"全绿"不等于"运行期一定没问题"。
// · 解析类检查（B7/B8 的 happy path）需要一份**合法容器样本**才能验证；
//   离线垫片下拿不到时按 ⚠️ 跳过并说明原因，不假装通过。
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, loadIntoContext, badInputs, isThenable } from './check-plugin-host.mjs';
import { parseJsonc } from './parse-jsonc.mjs';

/** 契约 §一 的五类角色（A4 值域） */
const ROLES = ['asset-provider', 'renderer', 'editor', 'exporter', 'panel'];
/** 契约 §四 的内容类型（A5 值域） */
const CONTENT_KINDS = ['spine', 'live2d'];
/** 容器类型：只能出现在 fileKinds，不得进 produces.kind（§四） */
const CONTAINER_KINDS = ['files', 'bundle'];
/** VFS 前缀形状（VirtualFS 契约 §1.2）：vfs://<providerId>/<rootId>/.../ */
const PREFIX_RE = /^vfs:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/(?:.*\/)?$/;

/** 结果收集器：kind ∈ ok|warn|fail */
function createReport() {
  const rows = [];
  const add = (kind, code, msg, clause) => rows.push({ kind, code, msg, clause });
  return {
    rows,
    ok: (code, msg, clause) => add('ok', code, msg, clause),
    warn: (code, msg, clause) => add('warn', code, msg, clause),
    fail: (code, msg, clause) => add('fail', code, msg, clause),
    counts: () => ({
      ok: rows.filter((r) => r.kind === 'ok').length,
      warn: rows.filter((r) => r.kind === 'warn').length,
      fail: rows.filter((r) => r.kind === 'fail').length,
    }),
  };
}

/** 把一个插件目录读成清单（JSONC）+ 入口文件清单 */
function readManifest(dir) {
  const file = path.join(dir, 'plugin.json');
  const text = fs.readFileSync(file, 'utf8');
  const manifest = parseJsonc(text, `${path.basename(dir)}/plugin.json`);
  // 加载顺序按契约 §二：files[] → entry → index.js
  let files = [];
  if (Array.isArray(manifest.files) && manifest.files.length) files = manifest.files.slice();
  else if (typeof manifest.entry === 'string' && manifest.entry) files = [manifest.entry];
  else files = ['index.js'];
  return { manifest, files };
}

/**
 * 检查单个插件目录。
 * @param {string} dir 插件目录（绝对或相对）
 * @returns {{dir: string, rows: Array, counts: object, failed: boolean}}
 */
export async function checkPlugin(dir, options = {}) {
  const abs = path.resolve(dir);
  const name = path.basename(abs);
  const rep = createReport();

  // ---------------- A 清单层 ----------------
  let manifest = null;
  let files = [];
  try {
    const r = readManifest(abs);
    manifest = r.manifest;
    files = r.files;
    rep.ok('A1', 'plugin.json 可解析（JSONC）', '§二');
  } catch (e) {
    rep.fail('A1', `plugin.json 无法解析：${e.message}`, '§二');
    return { dir: abs, rows: rep.rows, counts: rep.counts(), failed: true };
  }

  // A2 必填字段
  const missing = [];
  if (!manifest.id || typeof manifest.id !== 'string') missing.push('id');
  if (!manifest.name || typeof manifest.name !== 'string') missing.push('name');
  // provides / fileKinds：契约 §一「未声明角色的插件视为无效注册」、§二「有解析能力时必填 fileKinds」
  const hasParsing = !!(manifest.produces && manifest.produces.kind) || (Array.isArray(manifest.fileKinds) && manifest.fileKinds.length > 0);
  if (missing.length) rep.fail('A2', `必填字段缺失或类型不对：${missing.join(' / ')}`, '§二');
  else rep.ok('A2', `必填字段齐全（id=${manifest.id}）`, '§二');
  // provides：§二 列为必填，§一 说"未声明角色即无效注册"。
  //   这里必须区分两件事，语义完全不同：
  //     · 字段**缺失** = 没声明 → ❌（只注册的插件也要显式写 "provides": []）
  //     · 空数组 []   = 明确声明"不提供任何角色" → ✅（合法的最小插件）
  if (!Object.prototype.hasOwnProperty.call(manifest, 'provides')) {
    rep.fail('A2a', 'provides 字段缺失：契约 §一 未声明角色即无效注册（不提供角色也要显式写 []）', '§一');
  } else if (!Array.isArray(manifest.provides)) {
    rep.fail('A2a', 'provides 必须是字符串数组', '§二');
  } else {
    rep.ok('A2a', `provides 已声明：${manifest.provides.length ? manifest.provides.join(' / ') : '[]（不提供角色）'}`, '§一');
  }

  // A3 id 与目录名一致
  if (manifest.id && manifest.id !== name) rep.fail('A3', `id(${manifest.id}) 与目录名(${name}) 不一致`, '§二');
  else if (manifest.id) rep.ok('A3', `id 与目录名一致（${name}）`, '§二');

  // A4 provides 值域
  if (Array.isArray(manifest.provides)) {
    const bad = manifest.provides.filter((r) => !ROLES.includes(r));
    if (bad.length) rep.fail('A4', `provides 含未知角色：${bad.join(' / ')}（允许：${ROLES.join(' / ')}）`, '§一');
    else rep.ok('A4', `provides 合法：${manifest.provides.join(' / ') || '(空)'}`, '§一');
  }

  // A5 produces.kind 值域；bundle 不得进 kind
  const pk = manifest.produces && manifest.produces.kind;
  if (pk != null) {
    if (CONTAINER_KINDS.includes(pk)) rep.fail('A5', `produces.kind 不得是容器类型 "${pk}"（容器类型只进 fileKinds）`, '§四');
    else if (!CONTENT_KINDS.includes(pk)) rep.fail('A5', `produces.kind 非法：${pk}（允许：${CONTENT_KINDS.join(' / ')}）`, '§四');
    else rep.ok('A5', `produces.kind 合法：${pk}`, '§四');
  } else if (hasParsing) {
    rep.fail('A5', '声明了解析能力（fileKinds 非空）却没有 produces.kind ⇒ catalog 会得到 kind:null', '§四');
  } else {
    rep.warn('A5', '未声明 produces.kind：条目会以 kind:null 列出并被渲染层拒绝（只注册插件可接受）', '§四');
  }

  // A6 声明了 fileKinds 就必须有 produces.kind
  const fk = Array.isArray(manifest.fileKinds) ? manifest.fileKinds : null;
  // 与 provides 同一口径：字段缺失 ❌、空数组 ✅（空数组 = 只注册不参与解析，§二）
  if (!Object.prototype.hasOwnProperty.call(manifest, 'fileKinds')) {
    rep.fail('A6', 'fileKinds 字段缺失：契约 §二 必填（只注册不解析也要显式写 []）', '§二');
  } else if (!Array.isArray(manifest.fileKinds)) {
    rep.fail('A6', 'fileKinds 必须是字符串数组', '§二');
  } else if (manifest.fileKinds.length > 0 && !pk) {
    rep.fail('A6', 'fileKinds 非空但缺 produces.kind（§2 有解析能力时必填）', '§二');
  } else {
    rep.ok('A6', `fileKinds 已声明：${manifest.fileKinds.length ? manifest.fileKinds.join(' / ') : '[]（不参与解析）'}`, '§二');
  }

  // ---------------- B 代码层（vm 垫片） ----------------
  const { sandbox, registered, logs } = createSandbox();
  let loaded;
  try {
    loaded = loadIntoContext(abs, files, sandbox);
    rep.ok('B1', `vm.Script 编译通过（${files.length} 个文件）`, '§三');
  } catch (e) {
    rep.fail('B1', `代码编译/执行失败：${String(e.message).slice(0, 160)}`, '§三');
    return { dir: abs, rows: rep.rows, counts: rep.counts(), failed: true };
  }
  if (loaded.missing) {
    rep.fail('B1a', `清单里声明的文件不存在：${loaded.missing}`, '§二');
    return { dir: abs, rows: rep.rows, counts: rep.counts(), failed: true };
  }

  // B2 同步调用 register()
  if (!registered.length) {
    rep.fail('B2', '脚本执行完没有调用 host.register()（契约 §三：必须同步注册）', '§三');
    return { dir: abs, rows: rep.rows, counts: rep.counts(), failed: true };
  }
  rep.ok('B2', `同步调用 register() 一次（共 ${registered.length} 次）`, '§三');
  const desc = registered[registered.length - 1];

  // B3 descriptor 必填成员
  const need = ['id', 'name', 'fileKinds', 'canHandle', 'resolve'];
  const lacks = need.filter((k) => desc == null || desc[k] == null);
  const parses = (Array.isArray(desc && desc.fileKinds) && desc.fileKinds.length > 0) || !!pk;
  if (lacks.length) {
    // 只注册不解析的插件（fileKinds 空、无 produces）不需要 canHandle/resolve（§3.3/§3.5）
    const onlyFuncs = lacks.filter((k) => k === 'canHandle' || k === 'resolve');
    const other = lacks.filter((k) => k !== 'canHandle' && k !== 'resolve');
    if (other.length) rep.fail('B3', `descriptor 缺字段：${other.join(' / ')}`, '§3.3');
    if (onlyFuncs.length) {
      if (parses) rep.fail('B3', `声明了解析能力但 descriptor 缺：${onlyFuncs.join(' / ')}（旧 probe/open 不能替代）`, '§3.5');
      else rep.warn('B3', `descriptor 无 ${onlyFuncs.join('/')}：该插件不参与解析，按只注册处理`, '§3.5');
    }
  } else rep.ok('B3', 'descriptor 含 id / name / fileKinds / canHandle / resolve', '§3.3');

  // B4 canHandle 必须同步且返回 boolean（重点：async 会返回 Promise ⇒ 恒真值 ⇒ 全部放行）
  if (typeof desc.canHandle === 'function') {
    const fn = desc.canHandle;
    const ctorName = fn.constructor && fn.constructor.name;
    if (ctorName === 'AsyncFunction') {
      rep.fail('B4', 'canHandle 是 async 函数：返回 Promise 恒为真值，宿主 if (canHandle(f)) 会全部放行（必须同步返回 boolean）', '§3.1');
    } else {
      const inputs = badInputs();
      let nonBool = null;
      let thenable = null;
      for (const it of inputs) {
        let r;
        try { r = fn(it.value); } catch (e) { rep.fail('B5', `canHandle 抛异常（输入 ${it.label}）：${String(e.message).slice(0, 100)}`, '§3.1'); break; }
        if (isThenable(r)) { thenable = it.label; break; }
        if (typeof r !== 'boolean') { nonBool = `${it.label} → ${typeof r}`; break; }
      }
      if (thenable) rep.fail('B4', `canHandle 返回 thenable（输入 ${thenable}）：等价于恒真值`, '§3.1');
      else if (nonBool) rep.fail('B4', `canHandle 返回值不是 boolean：${nonBool}`, '§3.1');
      else rep.ok('B4', 'canHandle 同步返回 boolean（4 种输入全部为布尔）', '§3.1');
      if (!thenable && !nonBool) {
        // B5 不抛异常（上面循环里若抛会记 fail；这里补一条正向结论）
        if (!rep.rows.some((r) => r.code === 'B5')) rep.ok('B5', 'canHandle 对 null / {} / 空字节 / 随机字节均不抛异常', '§3.1');
      }
    }
  } else if (parses) {
    rep.fail('B4', '缺少 canHandle（声明了解析能力）', '§3.1');
  }

  // B6/B7/B8 resolve 形态
  if (typeof desc.resolve === 'function') {
    const rf = desc.resolve;
    // B6：非法入参必须抛带 code 的 Error
    // 注意：契约里 resolve 是 async（§三 示例 `async resolve(file)`），非法入参抛出的
    //   是**被拒绝的 Promise** 而不是同步 throw —— 必须 await 才能看到那个 Error（含 code）。
    let codeErr = null;
    for (const bad of [null, {}, { bytes: null }]) {
      try {
        const r = rf(bad);
        if (isThenable(r)) await r;   // async resolve：等它 reject
        codeErr = `未抛错（输入 ${JSON.stringify(bad)}）`;
        break;
      } catch (e) {
        if (!e || typeof e.code !== 'string' || !e.code) { codeErr = `抛错但没有 code 字段（${String(e && e.message).slice(0, 80)}）`; break; }
      }
    }
    if (codeErr) rep.fail('B6', `resolve 非法入参处理不合契约：${codeErr}`, '§3.4');
    else rep.ok('B6', 'resolve 对非法入参抛带 code 的 Error', '§3.4');

    // B7/B8：happy path 需要一份**合法容器样本**才能验（离线垫片没有真实资源）。
    //   传了 --sample <文件> 就真的跑一次；没有就如实 ⚠️，不假装通过。
    const samplePath = options.samplePath;
    if (samplePath && fs.existsSync(samplePath)) {
      try {
        const bytes = new Uint8Array(fs.readFileSync(samplePath));
        const out = rf({ name: path.basename(samplePath), size: bytes.length, bytes });
        const ret = isThenable(out) ? await out : out;
        const keys = ret && ret.files
          ? (ret.files instanceof Map ? [...ret.files.keys()] : Object.keys(ret.files))
          : null;
        const hasShape = !!(ret && typeof ret === 'object' && ret.prefix && ret.files && ret.entry);
        if (!hasShape) rep.fail('B7', 'resolve 返回值缺 prefix / files / entry 之一', '§3.4');
        else if (!keys || !keys.includes(ret.entry)) rep.fail('B7', `entry(${ret.entry}) 不在 files 的键里（keys=${JSON.stringify((keys || []).slice(0, 5))}…）`, '§3.4');
        else rep.ok('B7', `resolve 返回 { prefix, files(${keys.length} 项), entry(${ret.entry}) }，entry 在 files 内`, '§3.4');
        if (hasShape && PREFIX_RE.test(String(ret.prefix))) rep.ok('B8', `prefix 形状合法：${ret.prefix}`, '§1.2');
        else if (hasShape) rep.fail('B8', `prefix 不符合 vfs://<providerId>/<rootId>/.../ ：${String(ret.prefix).slice(0, 80)}`, '§1.2');
      } catch (e) {
        // 垫片缺 host.fetchFile / 样本本身不合法，都会在这里失败：如实说未验证，不判插件有罪
        rep.warn('B7', `样本解析在垫片下失败（code=${(e && e.code) || '-'}），B7/B8 未验证`, '§3.4');
        rep.warn('B8', 'prefix 形状未验证（同上）', '§1.2');
      }
    } else {
      rep.warn('B7', 'resolve 的 { prefix, files, entry } 形状未离线验证：需要一份合法容器样本（可用 --sample <文件> 提供）', '§3.4');
      rep.warn('B8', `prefix 形状未离线验证：应为 ${PREFIX_RE.source}`, '§1.2');
    }
  } else if (parses) {
    rep.fail('B6', '缺少 resolve（声明了解析能力）', '§3.4');
  }

  // ---------------- C 一致性 ----------------
  if (desc && desc.id && manifest.id) {
    if (desc.id !== manifest.id) rep.fail('C1', `register 的 id(${desc.id}) 与 plugin.json(${manifest.id}) 不一致`, '§3.3');
    else rep.ok('C1', 'register 与 plugin.json 的 id 一致', '§3.3');
  }
  const dfk = Array.isArray(desc && desc.fileKinds) ? desc.fileKinds : null;
  if (dfk && fk) {
    const same = dfk.length === fk.length && dfk.every((v, i) => v === fk[i]);
    if (!same) rep.warn('C2', `fileKinds 两处不一致（plugin.json=${JSON.stringify(fk)} / register=${JSON.stringify(dfk)}）⇒ 以 plugin.json 为准`, '§3.3');
    else rep.ok('C2', 'fileKinds 两处一致', '§3.3');
  }
  const isProvider = Array.isArray(manifest.provides) && manifest.provides.includes('asset-provider');
  if (isProvider) {
    if (typeof desc.canHandle === 'function' && typeof desc.resolve === 'function') rep.ok('C3', 'asset-provider 已实现 canHandle / resolve', '§一');
    else rep.fail('C3', 'provides 含 asset-provider 但缺 canHandle / resolve', '§一');
  }

  // 附注：插件用了裸 console 作为用户可见输出（§3.4 只提示，不判死）
  const naked = logs.filter((l) => l.level.startsWith('console.'));
  if (naked.length) rep.warn('N1', `检测到 ${naked.length} 条裸 console 调用（§3.4 要求走 host.log）`, '§3.4');

  const counts = rep.counts();
  return { dir: abs, rows: rep.rows, counts, failed: counts.fail > 0 };
}

/** 打印一个插件的结果 */
function printResult(res, jsonMode) {
  if (jsonMode) return;
  const icon = { ok: '✅', warn: '⚠️', fail: '❌' };
  console.log(`\n=== ${path.basename(res.dir)} （${res.dir}）`);
  for (const r of res.rows) {
    console.log(`  ${icon[r.kind]} ${r.code.padEnd(4)} ${r.msg}   ${r.clause ? `[${r.clause}]` : ''}`);
  }
  const c = res.counts;
  console.log(`  ── 结果：✅${c.ok} ⚠️${c.warn} ❌${c.fail}  ${c.fail ? '不通过' : '通过'}`);
}

/** 入口 */
async function main(argv) {
  const args = argv.slice(2);
  const jsonMode = args.includes('--json');
  const sampleIdx = args.indexOf('--sample');
  const samplePath = sampleIdx >= 0 ? args[sampleIdx + 1] : null;
  const allIdx = args.indexOf('--all');
  let targets = [];
  if (allIdx >= 0) {
    const root = args[allIdx + 1] || 'plugins';
    const base = path.resolve(root);
    if (!fs.existsSync(base)) { console.error(`目录不存在：${root}`); process.exit(2); }
    targets = fs.readdirSync(base)
      .map((n) => path.join(base, n))
      .filter((p) => fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'plugin.json')));
  } else {
    const t = args.find((a) => !a.startsWith('--'));
    if (!t) {
      console.error('用法：node tool/check-plugin.mjs <插件目录> | --all <plugins 目录> [--json]');
      process.exit(2);
    }
    targets = [path.resolve(t)];
  }
  if (!targets.length) { console.error('没找到任何含 plugin.json 的插件目录'); process.exit(2); }

  const results = [];
  for (const d of targets) results.push(await checkPlugin(d, { samplePath }));
  if (jsonMode) {
    console.log(JSON.stringify({ results: results.map((r) => ({
      dir: r.dir, counts: r.counts, failed: r.failed, rows: r.rows,
      // 未验证项单列，机器消费方也不会把"跳过"当成"通过"
      unverified: r.rows.filter((x) => (x.code === 'B7' || x.code === 'B8') && x.kind === 'warn').map((x) => x.code),
    })) }, null, 1));
  } else {
    results.forEach((r) => printResult(r, jsonMode));
    const fail = results.filter((r) => r.failed).length;
    console.log(`\n总计 ${results.length} 个插件：通过 ${results.length - fail}，不通过 ${fail}`);
    // 别让人以为"全绿就万事大吉"：B7/B8 没样本时只是跳过，不是通过
    const unverified = results.filter((r) => r.rows.some((x) => (x.code === 'B7' || x.code === 'B8') && x.kind === 'warn'));
    if (unverified.length) {
      console.log(`提示：${unverified.length} 个插件的 B7/B8 未验证（缺合法容器样本），可用 --sample <包文件> 补验`);
    }
  }
  process.exit(results.some((r) => r.failed) ? 1 : 0);
}

// 只在直接执行时跑 main（被 import 做单测时不执行）
// 直接执行时才跑 main：用 fileURLToPath 而不是 URL.pathname（后者对中文路径是百分号编码，比不相等）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv);
}
