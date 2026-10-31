#!/usr/bin/env node
// check-plugin.mjs —— 插件合法性检查（把 `docs/契约/插件.md` 的条款变成可执行检查）
//
// 用法：
//   node tool/check-plugin.mjs plugins/unity-live2d-bundle
//   node tool/check-plugin.mjs --src /tmp/bad/unity-live2d-bundle [--manifest plugins/unity-live2d-bundle/plugin.json]
//   node tool/check-plugin.mjs --all plugins
//   node tool/check-plugin.mjs --src /tmp/bad/unity-live2d-bundle [--manifest plugins/unity-live2d-bundle/plugin.json]
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
import { runContractChecks, printCoverageTable, listContainerCandidates } from './lib/contract-checks.mjs';
import { parseJsonc } from './parse-jsonc.mjs';
// 契约 §9.6：effects 校验与运行期共用同一份实现（禁止两处各写一套）
import { PLUGIN_ROLES, validateEffects } from '../src/server/plugins/registry.mjs';

/** 契约 §一 的五类角色（A4 值域）—— 单一真相在 registry.mjs 的 PLUGIN_ROLES */
const ROLES = PLUGIN_ROLES;
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
function readManifest(dir, manifestPath) {
  // manifestPath：清单不在源码目录旁时指定（典型用法：--src /tmp/pl9/unity-live2d-bundle --manifest 仓库里的原清单）
  //   files[] 仍相对**源码目录**解析，所以副本目录必须保持同样的内部结构。
  const file = manifestPath ? path.resolve(manifestPath) : path.join(dir, 'plugin.json');
  const text = fs.readFileSync(file, 'utf8');
  const manifest = parseJsonc(text, `${path.basename(dir)}/plugin.json`);
  const runtime = String(manifest.runtime || 'node');
  // 加载顺序按契约 §二：files[] → entry → index.js
  let files = [];
  if (runtime === 'exec') {
    // exec 运行时的插件**不是 JS**：宿主 spawn 它的 entry（一个独立进程），不在 vm 里跑脚本。
    //   所以这里不能回落用 entry 当"要编译的脚本" —— 那会把 worker.py 送进 vm.Script，
    //   必然报 "Invalid or unexpected token"（实测踩到）。entry 的存在性由 B1 单独校验。
    files = [];
  } else if (Array.isArray(manifest.files) && manifest.files.length) {
    files = manifest.files.slice();
  } else if (typeof manifest.entry === 'string' && manifest.entry) {
    files = [manifest.entry];
  } else {
    files = ['index.js'];
  }
  return { manifest, files, runtime };
}

/** 默认最多试几个候选容器（可用 SAMPLE_TRY_MAX 覆盖，CI 想更快可设 4） */
const SAMPLE_TRY_MAX_DEFAULT = 8;

/**
 * 取候选上限：环境变量 SAMPLE_TRY_MAX 优先，非法值回落默认。
 * 用**数量**上限而不是时间上限：本项目规矩是"不按秒数改变行为"。
 * @returns {number}
 */
function sampleTryMax() {
  const n = Number(process.env.SAMPLE_TRY_MAX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : SAMPLE_TRY_MAX_DEFAULT;
}

/**
 * 用**插件自己的 canHandle** 反过来挑一个它能处理的容器当样本。
 *
 * 为什么这么挑：样本选择的口径必须与插件判据是同一份 —— 另写一套"按目录名/扩展名猜类型"
 *   必然与 canHandle 不同步（本项目反复栽的坑：两处实现各说各话）。实测过的假红：
 *   spine 插件被喂 live2d 包 ⇒ 报「包里没有 .skel」，插件本身没问题。
 * 读到文件就**复用同一份字节**返回：readFile 是主要成本（20MB 包实测 662ms），
 *   不能让 B7 再读一遍。
 *
 * @param {Function} canHandle 插件注册时给出的判定函数
 * @param {object} rep 报告收集器（挑不到时写 warn，说明试过什么）
 * @returns {Promise<{path: string, bytes: Uint8Array}|null>}
 */
async function pickSampleByCanHandle(canHandle, rep) {
  if (typeof canHandle !== 'function') {
    rep.warn('B7', '插件未提供 canHandle，无法按类型挑样本；B7/B8 未验证（可用 --sample <文件> 指定）', '§3.4');
    return null;
  }
  const limit = sampleTryMax();
  const candidates = listContainerCandidates().slice(0, limit);
  if (!candidates.length) {
    rep.warn('B7', '资源根里没有任何容器候选（UnityFS 文件），B7/B8 未验证：可用 --sample <文件> 指定', '§3.4');
    return null;
  }
  const tried = [];
  for (const candidate of candidates) {
    let bytes;
    try {
      bytes = new Uint8Array(fs.readFileSync(candidate.path));
    } catch {
      tried.push(`${path.basename(candidate.path)}(读失败)`);
      continue;
    }
    let accepted = false;
    try {
      const out = canHandle({ rootId: 'probe-root', rel: path.basename(candidate.path), name: path.basename(candidate.path), size: bytes.length, bytes });
      accepted = !!(isThenable(out) ? await out : out);
    } catch {
      accepted = false;
    }
    if (accepted) return { path: candidate.path, bytes };
    tried.push(`${path.basename(candidate.path)}(${Math.round(candidate.size / 1048576)}MB)`);
  }
  // 挑不到就如实说清楚：试了几个、分别是谁、怎么加大范围。绝不 fallback 到"随便拿一个"
  rep.warn('B7', `已试 ${candidates.length} 个候选（大小升序前 ${candidates.length}），逐个 canHandle 均 false；加大 SAMPLE_TRY_MAX 或 --sample 指定。试过：${tried.join(', ')}`, '§3.4');
  return null;
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
  /**
   * 本次实际使用的样本（B7 段挑定，M 段复用同一份）。
   * 放在函数作用域：样本来源现在要等插件装载后才定（用它的 canHandle 挑），
   *   B7 与 M1–M5 必须看同一个样本，否则两段报告各说各的。
   * @type {{path: string, bytes?: Uint8Array}|null}
   */
  let effectiveSample = null;
  /** 挑样本的失败原因是否已由 pickSampleByCanHandle 写进报告（避免 B7 出现两条重复说明） */
  let samplePickExplained = false;

  // ---------------- A 清单层 ----------------
  let manifest = null;
  let files = [];
  let runtime = 'node';
  try {
    const r = readManifest(abs, options.manifestPath);
    manifest = r.manifest;
    runtime = r.runtime || 'node';
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

  // ---------------- A7 受限扩展点 effects（契约 §九） ----------------
  //   与运行期共用 registry.mjs:validateEffects —— 两处口径必须一致，各写一遍必然漂移。
  //   声明了 effects 才读脚本内容（无 effects 的插件零额外 I/O）。
  {
    let scriptText = null;
    if (Array.isArray(manifest.effects) && manifest.effects.length) {
      try {
        scriptText = files
          .map((f) => fs.readFileSync(path.join(abs, String(f).replace(/^\.?\//, '')), 'utf8'))
          .join('\n');
      } catch {
        // 读不到就按"找不到 registerEffect(" 处理，让 A7 明确变红，而不是跳过
        scriptText = '';
      }
    }
    const effectsError = validateEffects(manifest.effects, {
      provides: Array.isArray(manifest.provides) ? manifest.provides : [],
      scriptText,
      seenIds: options.seenEffectIds || null,
    });
    if (effectsError) {
      rep.fail('A7', effectsError, '§九');
    } else {
      const declared = Array.isArray(manifest.effects) ? manifest.effects : [];
      rep.ok('A7', declared.length ? `effects 合法：${declared.map((x) => x.id).join(' / ')}` : '未声明 effects（无需效果校验）', '§九');
    }
  }

  // ---------------- B 代码层（vm 垫片） ----------------
  // exec 运行时不是 JS：B2~B9 全是「vm 垫片里跑脚本」的语义，对它不适用。
  //   等价的可验判据只有"entry 指向的文件真实存在且非空"（宿主 spawn 它才可能成功）。
  if (runtime === 'exec') {
    const entryRel = String(manifest.entry || '');
    if (!entryRel) {
      rep.fail('B1', 'runtime:"exec" 但清单没声明 entry（宿主不知道要 spawn 什么）', '§三');
      return { dir: abs, rows: rep.rows, counts: rep.counts(), failed: true };
    }
    // entry 必须是插件目录内的相对路径（与 exec 适配器的校验同口径：不许绝对路径 / ..）
    if (path.isAbsolute(entryRel) || entryRel.split(/[\\/]/).includes('..')) {
      rep.fail('B1a', `entry 必须是插件目录内的相对路径（不许绝对路径或 ..）：${entryRel}`, '§二');
      return { dir: abs, rows: rep.rows, counts: rep.counts(), failed: true };
    }
    const entryAbs = path.join(abs, entryRel);
    if (!fs.existsSync(entryAbs)) {
      rep.fail('B1a', `entry 指向的文件不存在：${entryRel}`, '§二');
      return { dir: abs, rows: rep.rows, counts: rep.counts(), failed: true };
    }
    const entrySize = fs.statSync(entryAbs).size;
    if (!entrySize) {
      rep.fail('B1a', `entry 指向的文件是空的：${entryRel}`, '§二');
      return { dir: abs, rows: rep.rows, counts: rep.counts(), failed: true };
    }
    rep.ok('B1', `exec 运行时：entry 存在（${entryRel}，${entrySize} 字节）；不适用 vm 编译检查`, '§三');
    rep.ok('B1b', `fileKinds=${(manifest.fileKinds || []).join('/')}；调度判据由适配器按 frameProtocol=${manifest.frameProtocol} 走帧协议`, '§三');
    return { dir: abs, rows: rep.rows, counts: rep.counts(), failed: rep.counts().fail > 0 };
  }
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
    //   来源优先级：
    //     ① --sample <文件>（显式，最高优先；先问插件认不认，不认就明确报"不是本插件的"，不静默忽略）
    //     ② 默认：用本插件自己的 canHandle 反过来挑（判据只有一份，见 pickSampleByCanHandle）
    //     ③ --no-sample：完全不读样本
    //   挑不到就如实 ⚠️，绝不 fallback 到"随便拿一个"—— 那正是"spine 插件被喂 live2d 包"假红的来源。
    if (options.samplePath && fs.existsSync(options.samplePath)) {
      const sampleBytes = new Uint8Array(fs.readFileSync(options.samplePath));
      let accepted = true;
      if (typeof desc.canHandle === 'function') {
        try {
          const verdict = desc.canHandle({ rootId: 'probe-root', rel: path.basename(options.samplePath), name: path.basename(options.samplePath), size: sampleBytes.length, bytes: sampleBytes });
          accepted = !!(isThenable(verdict) ? await verdict : verdict);
        } catch {
          accepted = false;
        }
      }
      if (accepted) effectiveSample = { path: options.samplePath, bytes: sampleBytes };
      else rep.warn('B7', `该样本不是本插件的（canHandle 返回 false）：${options.samplePath}；B7/B8 未验证`, '§3.4');
    } else if (options.sampleOrigin !== 'none' && options.sampleOrigin !== 'explicit') {
      effectiveSample = await pickSampleByCanHandle(desc.canHandle, rep);
      // 无论挑到没挑到，原因都由 pickSampleByCanHandle 写清楚了 ⇒ 下面不再重复一条 B7
      samplePickExplained = true;
    }
    const samplePath = effectiveSample ? effectiveSample.path : null;
    if (samplePath) {
      try {
        // 优先用挑样本时已读入的字节：同一个包不重复 readFile（20MB 包读一次 662ms）
        const bytes = effectiveSample.bytes || new Uint8Array(fs.readFileSync(samplePath));
        // 插件契约 §3.4：file 至少要有 rootId / rel / name / size / bytes
        //   （缺 rootId/rel 时合规插件会抛 ULB_ERR_BAD_ARGS —— 那不是插件的问题，是调用方漏传）
        const out = rf({ rootId: 'probe-root', rel: path.basename(samplePath), name: path.basename(samplePath), size: bytes.length, bytes });
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
      // 没拿到样本。若上面已按 canHandle 试过候选，失败原因已经写进 B7 了，这里不再重复；
      //   --no-sample 或显式样本失效时才需要补这条通用说明。
      if (!samplePickExplained) {
        rep.warn('B7', 'resolve 的 { prefix, files, entry } 形状未离线验证：需要一份合法容器样本（可用 --sample <文件> 提供）', '§3.4');
      }
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

  // ---------------- M1–M5 内存声明自查（契约 §2.3） ----------------
  //   为什么单独一组：内存声明的错法与解析类错法完全不同（漏声明/单位写错/违反物理下限），
  //   混在 A/B/C 里看结果时容易被当成解析问题。代号统一 M*、条款统一 §2.3。
  //
  //   ★ 取值来源（契约 §2.3）：M2–M4 查「**能拿到的那个值**」——
  //       ① 有静态声明值                → 查静态值
  //       ② 无静态值但有 --sample 样本  → 实跑 estimateMemory()，查**实算返回值**
  //       ③ 两者都没有                  → 跳过，并明确说「跳过」而不是「通过」
  //     为什么必须这样：动态声明（每包算一次）恰恰是最容易把单位写错的地方
  //     （`return { peakBytes: 400 }` 本意是 400MB）。只查静态值的话，这三条对实际插件等于不存在。
  const memDecl = (manifest.produces && manifest.produces.memory) || null;
  if (!parses) {
    rep.ok('M1', '只注册不解析，无需内存声明（跳过）', '§2.3');
  } else if (!memDecl) {
    rep.warn('M1', '参与解析但没有声明 produces.memory ⇒ 准入会回落"源包大小粗估"，偏差由本插件承担', '§2.3');
  } else {
    rep.ok('M1', '已声明 produces.memory（准入可用插件自己的峰值）', '§2.3');
  }

  const MEM_FIELDS = ['decompressedBytes', 'rgbaBytes', 'peakBytes'];
  const MB = 1024 * 1024;
  /** 运行期固定开销下限（19 包实测：峰值 ≈ 固定项 103MB + 容器 + 纹理附加） */
  const FIXED_OVERHEAD_MB = 103;

  /** 采样样本与插件自算入口（M2–M4 与 M5 共用一次采样，避免重复跑） */
  const memSample = effectiveSample ? effectiveSample.path : options.samplePath;
  const memHaveSample = !!(memSample && fs.existsSync(memSample));
  /** 样本来源（契约 §2.3「门禁报告必须可追溯」）：explicit / auto / none */
  const memSampleOrigin = options.sampleOrigin || (memHaveSample ? 'explicit' : 'none');
  /** M2–M5 消息里统一使用的来源标签（带具体路径，读者能复核） */
  const memSampleLabel = !memHaveSample ? '无可用样本'
    : (memSampleOrigin === 'auto' ? `自动挑选（插件 canHandle 命中）: ${memSample}` : `--sample: ${memSample}`);
  const memEstFn = (sandbox && sandbox.__ULB_NODE__ && typeof sandbox.__ULB_NODE__.estimateMemory === 'function')
    ? sandbox.__ULB_NODE__.estimateMemory.bind(sandbox.__ULB_NODE__)
    : (typeof desc.estimateMemory === 'function' ? desc.estimateMemory : null);
  let memEst = null;
  let memEstErr = null;
  if (memHaveSample && memEstFn) {
    try {
      const bytes = new Uint8Array(fs.readFileSync(memSample));
      memEst = memEstFn({
        rootId: 'probe-root', rel: path.basename(memSample), name: path.basename(memSample), size: bytes.length, bytes,
      });
    } catch (e) { memEstErr = String((e && e.message) || e).slice(0, 80); }
  }

  /** 静态值优先；没有静态值就用实算值（这样动态声明也能被实质检查） */
  const memNums = memDecl ? MEM_FIELDS.filter((f) => memDecl[f] !== undefined) : [];
  const hasComputed = !!(memEst && MEM_FIELDS.some((f) => memEst[f] !== undefined));
  let memVals = null;
  let memOrigin = '';
  if (memNums.length) {
    memVals = memDecl;
    memOrigin = '查静态声明值';
  } else if (hasComputed) {
    memVals = memEst;
    memOrigin = `查实算值（${memSampleLabel}）`;
  }

  if (!memVals) {
    // 三种「跳过」原因必须说清，否则读报告的人分不清"没检查"和"检查通过"
    const why = !memDecl ? '未声明 memory'
      : (!memHaveSample ? '无可用样本（--no-sample 或未探测到）'
        : (memEstErr ? `estimateMemory 抛错（${memEstErr}）`
          : 'estimateMemory 未返回任何内存字段'));
    rep.ok('M2', `跳过（无检查对象：${why}）`, '§2.3');
    rep.ok('M3', `跳过（无检查对象：${why}）`, '§2.3');
    rep.ok('M4', `跳过（无检查对象：${why}）`, '§2.3');
  } else {
    // M2：类型/单位。把 MB 当字节写是头号错法（400 而不是 419430400）
    const bad = [];
    const looksLikeMb = [];
    for (const f of MEM_FIELDS) {
      if (memVals[f] === undefined) continue;
      const v = memVals[f];
      if (typeof v !== 'number' || !Number.isFinite(v)) { bad.push(`${f}=${JSON.stringify(v)} 不是数字`); continue; }
      if (!Number.isInteger(v)) { bad.push(`${f}=${v} 不是整数`); continue; }
      if (v <= 0) { bad.push(`${f}=${v} 必须为正`); continue; }
      if (v < MB) looksLikeMb.push(`${f}=${v}`);
    }
    const typeBroken = bad.length > 0 || looksLikeMb.length > 0;
    if (bad.length) rep.fail('M2', `${memOrigin}：字段类型/取值不合法 —— ${bad.join('；')}（三字段都是**字节**正整数）`, '§2.3');
    else if (looksLikeMb.length) rep.fail('M2', `${memOrigin}：${looksLikeMb.join('；')} 看着是 MB 不是字节（契约口径是字节：400MB 应写 ${400 * MB}）`, '§2.3');
    else rep.ok('M2', `${memOrigin}：三字段均为正整数（字节）`, '§2.3');

    if (typeBroken) {
      // 一个单位错不该级联成三条噪音
      rep.ok('M3', 'M2 已判类型/单位不合法，跳过物理下限检查（避免一个错误级联成多条）', '§2.3');
      rep.ok('M4', 'M2 已判类型/单位不合法，跳过固定开销检查', '§2.3');
    } else {
      // M3：物理下限。ΣRGBA 是解码后必然存在的裸像素 ⇒ 峰值不可能小于它（逻辑上不成立，故 fail）
      const phys = [];
      if (memVals.peakBytes > 0 && memVals.rgbaBytes > 0 && memVals.peakBytes < memVals.rgbaBytes) {
        phys.push(`peakBytes(${memVals.peakBytes}) < rgbaBytes(${memVals.rgbaBytes})`);
      }
      if (memVals.decompressedBytes !== undefined && !(memVals.decompressedBytes > 0)) {
        phys.push('decompressedBytes 必须 > 0');
      }
      if (phys.length) rep.fail('M3', `${memOrigin}：违反物理下限 —— ${phys.join('；')}（ΣRGBA 必然占用，峰值不可能更小）`, '§2.3');
      else rep.ok('M3', `${memOrigin}：未违反物理下限`, '§2.3');

      // M4：低于固定开销下限 ⇒ 疑似漏算固定项（warn：插件可能用了更省的做法，不能判死）
      if (memVals.peakBytes > 0 && memVals.peakBytes < FIXED_OVERHEAD_MB * MB) {
        rep.warn('M4', `${memOrigin}：peakBytes=${(memVals.peakBytes / MB).toFixed(1)}MB 低于运行期固定开销下限（≈${FIXED_OVERHEAD_MB}MB）⇒ 疑似漏算固定项`, '§2.3');
      } else if (memVals.peakBytes > 0) {
        rep.ok('M4', `${memOrigin}：peakBytes=${(memVals.peakBytes / MB).toFixed(1)}MB 不低于固定开销下限`, '§2.3');
      } else {
        rep.ok('M4', `${memOrigin}：未给出 peakBytes，跳过固定开销检查`, '§2.3');
      }
    }
  }

  // M5：语义**不变** —— 只在「有静态声明 + 有样本」时比对偏差，不扩大到动态声明
  //   （M2–M4 查"这个值合不合理"，M5 查"静态声明与实算是否一致"，职责分开）
  {
    if (!memDecl) rep.ok('M5', '未声明 memory，跳过实算比对', '§2.3');
    else if (!memHaveSample) rep.ok('M5', '无可用样本（--no-sample 或未探测到），跳过实算比对', '§2.3');
    else if (!memEstFn) rep.warn('M5', '插件没有暴露 estimateMemory，无法实算校验内存声明', '§2.3');
    else if (memEstErr) rep.warn('M5', `estimateMemory 抛错：${memEstErr}`, '§2.3');
    else if (!(memEst && memEst.decompressedBytes > 0)) rep.warn('M5', 'estimateMemory 没有返回 decompressedBytes，无法比对', '§2.3');
    else if (!(memDecl.decompressedBytes > 0)) {
      rep.ok('M5', `${memSampleLabel}：实算 decompressedBytes=${memEst.decompressedBytes}（声明未给静态值，无可比对象）`, '§2.3');
    } else {
      const dev = Math.abs(memEst.decompressedBytes - memDecl.decompressedBytes) / memEst.decompressedBytes;
      if (dev > 0.2) rep.warn('M5', `${memSampleLabel}：声明 decompressedBytes=${memDecl.decompressedBytes} 与实算 ${memEst.decompressedBytes} 偏差 ${(dev * 100).toFixed(0)}%（>20%）⇒ 声明可能已过期`, '§2.3');
      else rep.ok('M5', `${memSampleLabel}：声明与实算一致（偏差 ${(dev * 100).toFixed(1)}%）`, '§2.3');
    }
  }

  // 附注：插件用了裸 console 作为用户可见输出（§3.4 只提示，不判死）
  const naked = logs.filter((l) => l.level.startsWith('console.'));
  if (naked.length) rep.warn('N1', `检测到 ${naked.length} 条裸 console 调用（§3.4 要求走 host.log）`, '§3.4');

  // ---------------- PL1–PL8（契约条目视角，见 tool/lib/contract-checks.mjs） ----------------
  await runContractChecks({ rep, abs, manifest, options });

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
  const noSample = args.includes('--no-sample');
  // 样本来源必须**可追溯**：报告里"查实算值"必须说清用的是哪个文件、从哪来的。
  //   ① 显式 --sample <路径>  → explicit（作者指定的，换机也一致）
  //   ② 自动挑（默认）         → auto（**由插件自己的 canHandle 从候选里挑**，见 pickSampleByCanHandle）
  //   ③ --no-sample           → 不读任何样本（CI / 要求确定性的场景）
  // 注意：这里**不再预先选定某个文件**。以前是"资源根里第一个 UnityFS"，与插件类型无关，
  //   于是 spine 插件会被喂 live2d 包 ⇒ 假红（PL5 报"包里没有 .skel"）。
  //   挑样本必须在插件装载之后（要用它的 canHandle），所以延到 checkPlugin 内部做。
  let samplePath = null;
  let sampleOrigin = 'none';
  if (noSample) {
    samplePath = null;
    sampleOrigin = 'none';
  } else if (sampleIdx >= 0 && args[sampleIdx + 1]) {
    samplePath = args[sampleIdx + 1];
    sampleOrigin = 'explicit';
  } else {
    sampleOrigin = 'auto';
  }
  const allIdx = args.indexOf('--all');
  let targets = [];
  if (allIdx >= 0) {
    const root = args[allIdx + 1] || 'plugins';
    const base = path.resolve(root);
    if (!fs.existsSync(base)) { console.error(`目录不存在：${root}`); process.exit(2); }
    targets = fs.readdirSync(base)
      .map((n) => path.join(base, n))
      .filter((p) => fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'plugin.json')));
  } else if (args.includes('--src')) {
    // 校验**副本**：反向自证（故意改坏源码验检查器）必须走这条，绝不改仓库里的原件。
    //   副本目录名要与插件 id 一致（A3 会比 id 与目录名），例如 /tmp/pl9/unity-live2d-bundle。
    const src = args[args.indexOf('--src') + 1];
    if (!src || !fs.existsSync(src)) { console.error(`--src 目录不存在：${src || '(空)'}`); process.exit(2); }
    targets = [path.resolve(src)];
  } else {
    const t = args.find((a) => !a.startsWith('--'));
    if (!t) {
      console.error('用法：node tool/check-plugin.mjs <插件目录> | --all <plugins 目录> | --src <源码目录> [--sample <包>] [--no-sample] [--manifest <plugin.json>] [--json]');
      process.exit(2);
    }
    targets = [path.resolve(t)];
  }
  if (!targets.length) { console.error('没找到任何含 plugin.json 的插件目录'); process.exit(2); }

  const results = [];
  const manifestPath = args.includes('--manifest') ? args[args.indexOf('--manifest') + 1] : null;
  // 效果 id 必须跨插件全局唯一（契约 §9.1）⇒ 这批插件共用一个已见集合
  const seenEffectIds = new Set();
  for (const d of targets) results.push(await checkPlugin(d, { samplePath, sampleOrigin, manifestPath, seenEffectIds }));
  // 覆盖表每轮都打：让"PL1–PL8 各自被哪项检查覆盖"自证，不靠口头说明
  if (!jsonMode) printCoverageTable();
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
      console.log(`提示：${unverified.length} 个插件的 B7/B8 未验证 —— 具体原因见其 B7 行（缺样本时可用 --sample <包文件> 指定；垫片缺 DOM 时属环境限制）`);
    }
  }
  process.exit(results.some((r) => r.failed) ? 1 : 0);
}

// 只在直接执行时跑 main（被 import 做单测时不执行）
// 直接执行时才跑 main：用 fileURLToPath 而不是 URL.pathname（后者对中文路径是百分号编码，比不相等）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv);
}
