// tool/.tmp-switch-equiv.mjs —— createSwitcher（状态机）重构的等价验证（临时脚本，不 commit）
//
// 为什么不能用"跑通不报错"当证明：状态机最容易出的是"最终状态对、中间过程错"。
//   所以这里同时记录两样东西并逐项比对：
//     A. 状态迁移表：每步前后 {activeId, swapping, pending} 的快照
//     B. 调用序列：所有副作用回调按调用顺序追加（含 markModelFailed 的次数与 message）
//
// 注入桩的方式：把源文件里的 `import { markModelFailed }` 换成读全局桩，
//   再把 export 换成挂全局 —— 不改源文件，也不需要 DOM 垫片。
//
// 用法：
//   node tool/.tmp-switch-equiv.mjs --baseline /tmp/switch-baseline.json
//   node tool/.tmp-switch-equiv.mjs --compare  /tmp/switch-baseline.json

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'src/web/render/surface-switch.js');

/** 从源码里取出 createSwitcher（替换 import 为桩、导出挂到沙箱） */
function loadCreateSwitcher(sandbox) {
  const src = fs.readFileSync(FILE, 'utf8')
    .replace(/^import \{[^}]*\} from '\.\.\/infra\/ready\.js';?$/m, 'const markModelFailed = globalThis.__markModelFailed;')
    .replace(/export function createSwitcher/, 'globalThis.__createSwitcher = function createSwitcher');
  vm.runInNewContext(src, sandbox, { filename: 'surface-switch.js' });
  return sandbox.__createSwitcher;
}

const snap = (state) => ({ activeId: state.activeId, swapping: state.swapping, pending: state.pending ? (state.pending.kind || 'obj') : null });

/** 造一个可用的切换器实例：注入 markModelFailed 桩（参与调用序列），再用 ctx 构造 */
function buildSwitcher(ctx, rec) {
  const sandbox = { __markModelFailed: (m) => rec('markModelFailed', String(m).slice(0, 20)) };
  const factory = loadCreateSwitcher(sandbox);
  return factory(ctx);
}

/** 造一套可记录的 ctx；defer 用来把 mount 挂起（模拟"切换进行中再发起"） */
function makeCtx(opts = {}) {
  const seq = [];
  const state = { activeId: null, document: null, swapping: false, pending: null };
  const rec = (name, arg) => seq.push(arg === undefined ? name : `${name}(${arg})`);
  const renderers = new Map();
  const mkRenderer = (id, hook) => ({
    id,
    async mount(doc, handle) {
      rec('mount', `${id}:${doc.kind || '?'}`);
      if (hook) await hook(doc);
      if (opts.mountThrows === id) throw new Error(`mount 失败：${id}`);
      return { rendererId: id, mounted: doc.kind };
    },
  });
  renderers.set('spine', mkRenderer('spine', opts.spineHook));
  renderers.set('live2d', mkRenderer('live2d', opts.live2dHook));
  const ctx = {
    renderers,
    state,
    setMode: (m) => { rec('setMode', m); return m; },
    disposeActive: async (mode) => { rec('disposeActive', mode); },
    handle: (id) => { rec('handle', id); return { id }; },
    measure: () => rec('measure'),
    requestRender: () => rec('requestRender'),
    note: (msg) => rec('note', String(msg).split('（')[0].slice(0, 24)),
    noteSwitch: (tag) => { rec('noteSwitch', tag); return tag; },
    onSwitched: (id) => rec('onSwitched', String(id)),
  };
  return { ctx, state, seq, rec };
}

const doc = (kind, extra = {}) => ({ state: 'ready', kind, ...extra });

/** 等所有微任务排空（切换是异步的） */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** 跑一个场景，返回 {states:[...], seq:[...]} */
async function runScenario(name) {
  const mine = makeCtx();
  const cases = {
    // ① 首次装载
    '① null→spine': async () => {
      await mine.__sw.activate(doc('spine'));
    },
    // ② 同一渲染器重复选
    '② spine→spine': async () => {
      await mine.__sw.activate(doc('spine'));
      await mine.__sw.activate(doc('spine'));
    },
    // ③ 跨渲染器
    '③ spine→live2d': async () => {
      await mine.__sw.activate(doc('spine'));
      await mine.__sw.activate(doc('live2d'));
    },
    // ④ 组合路径：activate(A) → disposeActive() → activate(B)
    '④ 卸载再装另一个面': async () => {
      await mine.__sw.activate(doc('spine'));
      await mine.ctx.disposeActive('dispose');
      await mine.__sw.activate(doc('live2d'));
    },
    // ④b disposeActive 幂等（两次只卸一次）
    '④b disposeActive 幂等': async () => {
      await mine.__sw.activate(doc('spine'));
      mine.ctx.__idem = true;
      await mine.ctx.disposeActive('dispose');
      await mine.ctx.disposeActive('dispose');
    },
    // ⑤ 切换中再发起（mount 挂起期间）
    '⑤ 切换中再发起': async () => {
      let release;
      const gate = new Promise((r) => { release = r; });
      const c2 = makeCtx({ spineHook: () => gate });
      c2.__sw = buildSwitcher(c2.ctx, c2.rec);
      c2.ctx.state2 = c2.state;
      const p1 = c2.__sw.activate(doc('spine'));
      await settle();
      const p2 = c2.__sw.activate(doc('live2d'));   // 应排队
      release();
      const [r1, r2] = await Promise.all([p1, p2]);
      return { seq: c2.seq, states: [snap(c2.state)], extra: { r1: r1 ? 'info' : null, r2: r2 ? 'info' : null } };
    },
    // ⑥ mount 抛错 → 回滚
    '⑥ mount 抛错回滚': async () => {
      const c3 = makeCtx({ mountThrows: 'live2d' });
      c3.__sw = buildSwitcher(c3.ctx, c3.rec);
      await c3.__sw.activate(doc('spine'));
      let threw = 'no';
      try { await c3.__sw.activate(doc('live2d')); } catch { threw = 'yes'; }
      return { seq: c3.seq, states: [snap(c3.state)], extra: { threw } };
    },
    // ⑦ 非 Document（门禁）
    '⑦ 非 Document 抛错': async () => {
      let threw = 'no';
      try { await mine.__sw.activate({ kind: 'spine' }); } catch { threw = 'yes'; }
      return { seq: mine.seq, states: [snap(mine.state)], extra: { threw } };
    },
    // ⑧ Document 非 ready（可预期失败，不抛）
    '⑧ Document 非 ready': async () => {
      const r = await mine.__sw.activate({ state: 'error', kind: 'spine', warnings: ['缺纹理'] });
      return { seq: mine.seq, states: [snap(mine.state)], extra: { ret: r === null ? 'null' : 'non-null' } };
    },
  };

  // 注入 markModelFailed 桩（参与序列）
  mine.__sw = buildSwitcher(mine.ctx, mine.rec);
  // 多数场景不 return ⇒ 缺省给空对象（用 mine 的记录）
  const out = (await cases[name]()) || {};
  return {
    name,
    states: out.states || [snap(mine.state)],
    seq: out.seq || mine.seq,
    extra: out.extra || {},
  };
}

/** unloadMode 组合验证（契约 D1）：同 previous/next 必须产出同一 mode */
async function runUnloadModeMatrix() {
  const out = [];
  for (const previous of [null, 'spine', 'live2d']) {
    for (const next of ['spine', 'live2d']) {
      const mine = makeCtx();
      mine.__sw = buildSwitcher(mine.ctx, mine.rec);
      mine.state.activeId = previous;   // 直接摆好"上一次是哪个面"
      await mine.__sw.activate(doc(next));
      const dispose = mine.seq.find((s) => s.startsWith('disposeActive'));
      out.push(`prev=${previous || 'none'} next=${next} → ${dispose}`);
    }
  }
  return out;
}

const SCENARIOS = ['① null→spine', '② spine→spine', '③ spine→live2d', '④ 卸载再装另一个面',
  '④b disposeActive 幂等', '⑤ 切换中再发起', '⑥ mount 抛错回滚', '⑦ 非 Document 抛错', '⑧ Document 非 ready'];

async function collect() {
  const rows = [];
  for (const name of SCENARIOS) rows.push(await runScenario(name));
  return { scenarios: rows, unloadMatrix: await runUnloadModeMatrix() };
}

/** 逐项比对，报告第一个不同点的上下文（前后各 3 项） */
function diff(before, after) {
  const diffs = [];
  for (let i = 0; i < Math.max(before.scenarios.length, after.scenarios.length); i += 1) {
    const b = before.scenarios[i]; const a = after.scenarios[i];
    if (!b || !a) { diffs.push(`场景 #${i} 缺失`); continue; }
    const bs = JSON.stringify(b.states); const as = JSON.stringify(a.states);
    if (bs !== as) diffs.push(`[${b.name}] 状态迁移表不同：\n    前 ${bs}\n    后 ${as}`);
    if (JSON.stringify(b.extra) !== JSON.stringify(a.extra)) {
      diffs.push(`[${b.name}] extra 不同：前 ${JSON.stringify(b.extra)} 后 ${JSON.stringify(a.extra)}`);
    }
    const bs2 = b.seq; const as2 = a.seq;
    if (bs2.length !== as2.length) {
      diffs.push(`[${b.name}] 调用序列长度不同：${bs2.length} → ${as2.length}`);
    }
    let firstBad = -1;
    for (let k = 0; k < Math.min(bs2.length, as2.length); k += 1) {
      if (bs2[k] !== as2[k]) { firstBad = k; break; }
    }
    if (firstBad >= 0) {
      const ctxOf = (arr) => arr.slice(Math.max(0, firstBad - 3), firstBad + 4).map((s, j) => `      ${Math.max(0, firstBad - 3) + j}: ${s}`).join('\n');
      diffs.push(`[${b.name}] 调用序列第 ${firstBad} 项不同（前: ${bs2[firstBad]} / 后: ${as2[firstBad]}）\n    前:\n${ctxOf(bs2)}\n    后:\n${ctxOf(as2)}`);
    }
  }
  if (JSON.stringify(before.unloadMatrix) !== JSON.stringify(after.unloadMatrix)) {
    diffs.push(`unloadMode 矩阵不同：\n  前 ${JSON.stringify(before.unloadMatrix)}\n  后 ${JSON.stringify(after.unloadMatrix)}`);
  }
  return diffs;
}

/** 稳定性自检：同输入连跑两次，序列必须一致（否则脚本本身有非确定性） */
async function stabilityCheck() {
  const a = await collect(); const b = await collect();
  return JSON.stringify(a) === JSON.stringify(b);
}

const args = process.argv.slice(2);
const iBase = args.indexOf('--baseline');
const iComp = args.indexOf('--compare');

const stable = await stabilityCheck();
console.log(`确定性自检（同输入跑两次）：${stable ? '✓ 一致' : '✗ 不一致 —— 先修脚本再谈比对'}`);
if (!stable) process.exitCode = 1;

if (iBase >= 0 && stable) {
  const out = args[iBase + 1] || '/tmp/switch-baseline.json';
  const data = await collect();
  fs.writeFileSync(out, JSON.stringify(data, null, 1));
  console.log(`baseline 已写：${out}`);
  for (const s of data.scenarios) console.log(`  ${s.name}: ${s.seq.length} 次调用 / 状态 ${JSON.stringify(s.states[0])}`);
  console.log('unloadMode 矩阵：');
  for (const line of data.unloadMatrix) console.log(`  ${line}`);
} else if (iComp >= 0 && stable) {
  const base = args[iComp + 1] || '/tmp/switch-baseline.json';
  const before = JSON.parse(fs.readFileSync(base, 'utf8'));
  const after = await collect();
  const diffs = diff(before, after);
  const totalCalls = after.scenarios.reduce((a, s) => a + s.seq.length, 0);
  console.log(`对比：${base}（${after.scenarios.length} 场景 / ${totalCalls} 次调用）`);
  if (!diffs.length) console.log('✅ 状态迁移表与调用序列逐项相同（0 差异）');
  else { console.log(`❌ ${diffs.length} 处差异：`); diffs.slice(0, 6).forEach((d) => console.log('  ' + d)); }
  console.log('unloadMode 矩阵：');
  for (const line of after.unloadMatrix) console.log(`  ${line}`);
} else {
  console.log('用法：--baseline <out.json> | --compare <baseline.json>');
}
