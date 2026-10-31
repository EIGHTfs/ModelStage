#!/usr/bin/env node
// check-wiring.mjs —— 控件的「声明 ↔ 接线」静态门禁（W1~W5）
//
// 两种用法（同一份检查逻辑，不重复实现）：
//   ① 库形态（被 tool/test-all.mjs 在预检阶段调用，失败即中止 —— 门禁必须接进自动流程才有意义）：
//        import { checkWiring, formatWiringProblems } from './check-wiring.mjs';
//        const { ok, fails, warns } = await checkWiring();
//        checkWiring() **不退出进程**，只返回结果，由调用方决定怎么处理。
//   ② CLI 形态（手动排查单个问题）：
//        node tool/check-wiring.mjs          # 人读；有 fail 时退出 1
//        node tool/check-wiring.mjs --json   # 机器读
//
// 为什么需要它：`src/web/panel/schema.js` 是控件的**声明**，代码里是**接线**。
//   同一事实的两处表达一旦漂移，浏览器里的表现就是「点了没反应」「面板重建后控件消失」——
//   而这两类症状恰恰是 f1 / panel 两个浏览器套件在手工验的东西。能在静态阶段钉死，
//   就不必每次都靠跑浏览器套件去撞。
//
// 零依赖：静态 import 只有 node: 内置；另有一条**动态 import 项目自己的 schema.js**
//   （声明侧的权威来源。用正则再解析一遍 schema 等于给同一事实造第二份解析器，
//     而那正是本门禁要防的漂移 —— 所以直接 import 才是单一真相源的做法）。
//
// 退出码（CLI）：有 fail ⇒ 1，否则 0。warn 不影响退出码。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { here } from './lib/paths.mjs';

// 本文件所在目录（写法见 tool/lib/paths.mjs，6 个脚本共用一处实现）
const HERE = here(import.meta.url);
const ROOT = path.resolve(HERE, '..'); // 由脚本自身位置推导，不写死绝对路径
const WEB_DIR = path.join(ROOT, 'src', 'web');
const SCHEMA_FILE = path.join(WEB_DIR, 'panel', 'schema.js');
const SETTINGS_FILE = path.join(WEB_DIR, 'panel', 'panel-settings.js');

/** 规则表：改规则只改这里，不动下面的检查逻辑 */
export const RULES = {
  W1: { level: 'fail', title: '声明了但没有任何接线路径' },
  W2: { level: 'fail', title: '代码里引用了但声明里没有（面板重建会丢它）' },
  W3: { level: 'warn', title: '声明 disabled 但代码里仍有它的处理' },
  W4: { level: 'warn', title: 'data-pending 标记与声明不符' },
  W5: { level: 'fail', title: 'RENDERER_INDEPENDENT 白名单与声明不一致' },
};

/**
 * 「作为控件 id 使用」的上下文。**不用宽匹配**：`ctl-*` 也大量用作 DOM 标记/类名
 * （ctl-seg / ctl-row / ctl-value …），宽匹配会把标记误报成接线。
 * 只认这几种真实用法：data-ctl 选择器/属性、setXxx('id') 字面量、映射表 key、=== 比较、case。
 */
const ID_CONTEXT = [
  /\[data-ctl=["']?(ctl-[a-z0-9-]+)/g,
  /data-ctl=["'](ctl-[a-z0-9-]+)["']/g,
  /\bset(?:Checked|Value|Disabled|Text|Label|Options|Title)\(\s*["'](ctl-[a-z0-9-]+)["']/g,
  /["'](ctl-[a-z0-9-]+)["']\s*:/g,
  /[=!]==\s*["'](ctl-[a-z0-9-]+)["']/g,
  /case\s+["'](ctl-[a-z0-9-]+)["']/g,
];

/** 不是「普通可接线控件」的 kind：各自有专门处理器，或根本不是控件 */
const NON_CONTROL_KINDS = new Set(['actions', 'dynamic-list', 'note']);

/** 剥注释（行注释 + 块注释）。不剥会把注释里的示例 id 误报成接线/漏接线。 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function listJsFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listJsFiles(p, out);
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 声明侧：从 schema.js 取控件 id（含 kind）与白名单 */
async function loadDeclarations() {
  const mod = await import(`file://${SCHEMA_FILE}`);
  const controls = new Map(); // id -> { kind, file, line, disabled, pending }
  const rawLines = fs.readFileSync(SCHEMA_FILE, 'utf8').split('\n');
  const lineOf = (id) => {
    for (let i = 0; i < rawLines.length; i += 1) {
      if (rawLines[i].includes(`'${id}'`)) return i + 1;
    }
    return 0;
  };
  const add = (c) => {
    if (!c || !c.id) return;
    controls.set(c.id, {
      kind: c.kind || '',
      file: 'src/web/panel/schema.js',
      line: lineOf(c.id),
      disabled: c.disabled === true,
      pending: c.pending === true,
    });
  };
  for (const g of mod.PANEL_GROUPS) for (const c of g.controls) add(c);
  for (const c of mod.TRANSPORT_CONTROLS) add(c);
  return {
    controls,
    whitelist: mod.RENDERER_INDEPENDENT.slice(),
    inferCapabilityKey: mod.inferCapabilityKey,
  };
}

/** 接线侧：外壳自己处理的控件 id（SHELL_APPLIERS 的 key，纯数据对象，正则读安全） */
function loadShellAppliers() {
  const text = stripComments(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  const ids = new Set();
  for (const m of text.matchAll(/'(ctl-[a-z0-9-]+)':\s*\(/g)) ids.add(m[1]);
  return ids;
}

/** 接线侧：代码里「作为控件 id 引用」的全部 id（排除声明文件自身） */
function scanWiredIds() {
  const wired = new Map(); // id -> ['file:line', ...]
  for (const file of listJsFiles(WEB_DIR)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (rel.endsWith('panel/schema.js')) continue; // 声明文件里出现的 id 不算接线
    const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      for (const re of ID_CONTEXT) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) {
          const id = m[1];
          if (!id) continue;
          if (!wired.has(id)) wired.set(id, []);
          const where = `${rel}:${i + 1}`;
          if (!wired.get(id).includes(where)) wired.get(id).push(where);
        }
      }
    });
  }
  return wired;
}

/** 代码里被显式标成 pending 的 id（dataset.pending 赋值指向某个具体 id 时才算） */
function scanExplicitPending() {
  const ids = new Set();
  for (const file of listJsFiles(WEB_DIR)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (rel.endsWith('panel/schema.js')) continue;
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of text.matchAll(/(ctl-[a-z0-9-]+)["'\]\s\S]{0,80}?\.dataset\.pending\s*=/g)) ids.add(m[1]);
  }
  return ids;
}

/**
 * 跑一次检查（库形态：**不退出进程**）。
 * @returns {Promise<{ok:boolean, fails:Array, warns:Array, problems:Array, declared:number, wired:number, shell:number}>}
 */
export async function checkWiring() {
  const decl = await loadDeclarations();
  const shell = loadShellAppliers();
  const wired = scanWiredIds();
  const explicitPending = scanExplicitPending();
  const problems = [];
  const add = (code, id, detail) => problems.push({ code, level: RULES[code].level, id, detail });

  // ---- W1：声明了但没有任何接线路径
  // 本项目的接线有三条路径，只要命中一条就算接了：
  //   a) 在 SHELL_APPLIERS（外壳专用处理）
  //   b) inferCapabilityKey(id) 能推导出能力键 ⇒ 走通用 setRendererSetting
  //   c) kind 属 actions/dynamic-list/note ⇒ 各自处理器或非控件
  //   d) transport-* ⇒ 底栏由 transport 系列统一处理
  for (const [id, meta] of decl.controls) {
    if (id.startsWith('transport-')) continue;
    if (shell.has(id)) continue;
    if (NON_CONTROL_KINDS.has(meta.kind)) continue;
    if (decl.inferCapabilityKey(id)) continue;
    add('W1', id, `${meta.file}:${meta.line} 声明；三条接线路径都没命中（不在 SHELL_APPLIERS、能力键推导不出、kind=${meta.kind || '未声明'}）`);
  }

  // ---- W2：代码里引用了但声明里没有
  for (const [id, wheres] of wired) {
    if (decl.controls.has(id)) continue;
    add('W2', id, `代码引用 ${wheres.slice(0, 3).join(', ')}${wheres.length > 3 ? ` 等 ${wheres.length} 处` : ''}；schema.js 里没有该 id`);
  }

  // ---- W3：声明 disabled 但代码里仍有它的处理（warn：可能是刻意统一挂 handler 再早退）
  for (const [id, meta] of decl.controls) {
    if (!meta.disabled) continue;
    const handled = shell.has(id) || !!decl.inferCapabilityKey(id) || wired.has(id);
    if (handled) add('W3', id, `${meta.file}:${meta.line} 声明 disabled，但代码里仍有它的处理（若确属刻意的统一 handler + 早退，可忽略）`);
  }

  // ---- W4：data-pending 标记与声明不符（warn）
  for (const [id, meta] of decl.controls) {
    const marked = explicitPending.has(id);
    if (meta.pending && !marked) add('W4', id, `${meta.file}:${meta.line} 声明 pending，但代码里没有对应的 data-pending 标记`);
    if (!meta.pending && marked) add('W4', id, `${meta.file}:${meta.line} 未声明 pending，但代码里给它打了 data-pending`);
  }

  // ---- W5：白名单与声明不一致
  for (const id of decl.whitelist) {
    if (!decl.controls.has(id)) add('W5', id, `RENDERER_INDEPENDENT 里有，但 PANEL_GROUPS/TRANSPORT_CONTROLS 里没有该 id（死条目）`);
  }

  const fails = problems.filter((p) => p.level === 'fail');
  const warns = problems.filter((p) => p.level === 'warn');
  return { ok: fails.length === 0, fails, warns, problems, declared: decl.controls.size, wired: wired.size, shell: shell.size };
}

/** 把违规格式化成可直接复制成待办的多行文本 */
export function formatWiringProblems(problems) {
  const out = [];
  for (const code of Object.keys(RULES)) {
    const list = problems.filter((p) => p.code === code);
    if (!list.length) continue;
    const mark = RULES[code].level === 'fail' ? '❌' : '⚠️';
    out.push(`${mark} ${code} ${RULES[code].title}（${list.length}）`);
    for (const p of list) out.push(`   - ${p.id}  ${p.detail}`);
  }
  return out.join('\n');
}

/** CLI 形态：打印 + 按 fails 决定退出码 */
async function main() {
  const json = process.argv.includes('--json');
  const res = await checkWiring();
  if (json) {
    console.log(JSON.stringify({
      ok: res.ok, fails: res.fails, warns: res.warns,
      declared: res.declared, wired: res.wired, shell: res.shell,
    }, null, 2));
  } else {
    console.log(`控件声明 ↔ 接线 静态门禁（声明 ${res.declared} 个 / 代码引用 ${res.wired} 个 / SHELL_APPLIERS ${res.shell} 个）`);
    if (!res.problems.length) {
      console.log('✅ 无违规（W1~W5 全部通过）');
    } else {
      console.log(formatWiringProblems(res.problems));
      console.log(`\n合计：❌ ${res.fails.length} 条 fail / ⚠️ ${res.warns.length} 条 warn`);
    }
  }
  process.exit(res.ok ? 0 : 1);
}

// 只有「直接执行这个文件」时才跑 main；被 import 时（test-all 预检）保持纯库，不退出进程
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error('check-wiring 执行失败：', (e && e.message) || e);
    process.exit(2);
  });
}
