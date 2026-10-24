#!/usr/bin/env node
// resolve-live2d-runtimes.mjs — 自动定位 Live2D 运行时库（供 server.mjs 在运行时供给浏览器）
//
// 设计目的：
//   运行时库**不纳入本仓库**（Live2D Cubism Core 受 Live2D Inc. 专有许可约束，见 README 合规说明），
//   因此需从仓库外部获取。为让「换机器 / 新克隆」也能用，这里做**多候选自动探测**，
//   与 tool/resolve-runtimes.mjs（Spine 运行时）保持同一套思路与优先级。
//
// 需要的文件：
//   live2d.min.js             Cubism 2 核心（.moc 模型必需，DestinyChild 资源即此格式）
//   pixi.min.js               PIXI 渲染器
//   index.min.js              pixi-live2d-display（同时支持 Cubism 2 与 4，Cubism 2 路径必需）
//   live2dcubismcore.min.js   Cubism 4 核心（.moc3 模型可选，没有也能跑 Cubism 2）
//
// 探测优先级（路径不写死，可由环境变量覆盖 —— 见 no-hardcode-config）：
//   1. 环境变量 LIVE2D_RUNTIME_DIR   显式指定，最高优先
//   2. 项目内 src/live2d-runtimes/   本地存在但已 gitignore（不入库）
//   3. 工作区级共享 ../live2d-runtimes/
//   4. 在「搜索根」下的各项目里按候选相对路径找——
//      同工作区的其它 Live2D 项目（spive2d / AzurLane-Live2D-Viewer / DestinyChildLive2D）
//      各自打包了这些库，直接复用即可，无需下载。
//      搜索根可用环境变量 LIVE2D_SEARCH_ROOTS（路径分隔符分隔）覆盖。
//
// 用法：
//   import { resolveLive2DRuntimes } from './resolve-live2d-runtimes.mjs';
//   const r = resolveLive2DRuntimes();   // { dir, files: { 文件名: 绝对路径 }, origin, missingOptional }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// 必需文件：前三个是渲染链本身；live2dcubismcore 虽然只有 Cubism 4 模型才真正用到，
//   但 pixi-live2d-display **初始化时就会检查它**，缺失则直接抛
//   「Could not find Cubism runtime. This plugin requires live2dcubismcore.js to be loaded.」
//   （实测踩过：只加载 live2d.min.js + pixi + index 会导致整页渲染不可用），故列为必需。
const REQUIRED = ['live2d.min.js', 'pixi.min.js', 'index.min.js', 'live2dcubismcore.min.js'];
// 可选：Cubism 4 的框架层，缺了不影响 Cubism 2（天命之子即此格式）
const OPTIONAL = ['live2dcubismframework.min.js'];

// 候选相对路径：库通常放在这些位置（本工作区三个 Live2D 项目实测覆盖了前三种）
const CANDIDATE_SUBPATHS = [
  'lib',
  'static/lib',
  'js/lib',
  'src/lib',
  'legacy/patches/lib',
  'dist/lib',
  '.',            // 库直接放在项目根
];

// 读 pixi.min.js 的主版本号。
//
// 为什么要看它来优选运行时组合（**实测依据**）：
//   pixi-live2d-display 上游面向 PIXI 6；实测「PIXI 6 组合」能同时渲染 Cubism 2 与 Cubism 4，
//   而本工作区 spive2d 打包的「PIXI 8 组合」在 **Cubism 4 上会卡住**
//   （model3.json 与 moc3 都能取到、moc 也能解析，但贴图永不请求，加载 Promise 永不 resolve；
//    同一模型换 PIXI 6 组合即正常）。另外该 PIXI 8 组合的库要求 Cubism Core 6.x，
//   配旧 core 会直接报 Failed to start up Cubism framework。
//   故按 PIXI 主版本优选，PIXI 6 优先。
function pixiMajor(dir) {
  try {
    const s = fs.readFileSync(path.join(dir, 'pixi.min.js'), 'utf8');
    const m = s.match(/VERSION="(\d+)\./) || s.match(/VERSION:"(\d+)\./);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

/** 目录里是否具备必需文件（且非空）。 */
function hasRequired(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  return REQUIRED.every((n) => {
    const f = path.join(dir, n);
    try { return fs.statSync(f).isFile() && fs.statSync(f).size > 1024; } catch { return false; }
  });
}

/** 在某个目录的候选子路径里找出具备必需文件的目录，返回其绝对路径或 null。 */
function findIn(dir) {
  for (const sub of CANDIDATE_SUBPATHS) {
    const d = sub === '.' ? dir : path.join(dir, sub);
    if (hasRequired(d)) return d;
  }
  return null;
}

/** 收集搜索根：环境变量优先，否则默认「工作区根」与「工作区/spine-viewers」。 */
function searchRoots() {
  const env = process.env.LIVE2D_SEARCH_ROOTS;
  if (env) return env.split(path.delimiter).filter(Boolean);
  return [
    path.resolve(ROOT, '..'),
    path.resolve(ROOT, '..', 'spine-viewers'),
  ];
}

/**
 * 未注入 log 时的兜底实现（CLI 直接运行时用）：
 * 保留**多行**可读输出——CLI 是开发者主动在终端看的，可读性优先；
 * 服务端则注入 createLogger 的实例，得到"单行 + 时间戳 + LEVEL + tag + 结构化 detail"。
 * 两类消费者不共用一种格式，这是设计选择，不是妥协。
 */
const cliLog = {
  info: (msg, detail) => {
    if (detail && Array.isArray(detail.candidates)) {
      const list = detail.candidates
        .map((c) => `  PIXI ${c.pixi || '?'}  ${c.req}+${c.opt} 个文件  ${c.dir}`)
        .join('\n');
      console.log(`[live2d-runtimes] ${msg}:\n${list}`);
      return;
    }
    console.log(`[live2d-runtimes] ${msg}${detail ? ' ' + JSON.stringify(detail) : ''}`);
  },
  warn: (msg, detail) => console.warn(`[live2d-runtimes] ${msg}`, detail || ''),
};

/**
 * 主入口：按优先级探测 Live2D 运行时库。
 *
 * 选择策略：把**所有候选都收集起来**再按「完整度」择优，而不是"第一个命中就用"。
 *   为什么：本工作区里多个项目各自打包了这些库，且版本并不一致——
 *   实测 AzurLane-Live2D-Viewer 与 spive2d 的 live2d.min.js **不是同一份**（MD5 不同），
 *   而 spive2d 的那份与 DestinyChildLive2D 自用的完全相同（即目标资源的同源核心）。
 *   按「文件更全」择优能自然选中 spive2d 那套（它额外含 Cubism 4 框架，共 5 个文件，
 *   而 AzurLane 只有 4 个）。显式指定的路径（环境变量 / 项目内 / 共享目录）依然最高优先。
 *
 * @returns {{dir: string, files: Object, origin: string, missingOptional: string[], candidates: Array}}
 */
export function resolveLive2DRuntimes(options = {}) {
  // 依赖反转：日志由调用方注入（tool 层不 import server 层的 logger）
  const log = (options && options.log) || cliLog;
  const tried = [];

  // 1~3) 显式位置：命中即用（用户主动指定的优先，不做完整度比较）
  const explicit = [
    process.env.LIVE2D_RUNTIME_DIR
      ? { dir: process.env.LIVE2D_RUNTIME_DIR, tag: '环境变量 LIVE2D_RUNTIME_DIR' } : null,
    { dir: path.join(ROOT, 'src', 'live2d-runtimes'), tag: '项目内 src/live2d-runtimes/' },
    { dir: path.resolve(ROOT, '..', 'live2d-runtimes'), tag: '工作区共享 ../live2d-runtimes/' },
  ].filter(Boolean);
  for (const c of explicit) {
    if (hasRequired(c.dir)) return { ...pack(c.dir, c.tag), candidates: [] };
    tried.push(c.tag);
  }

  // 4) 搜索根：收集全部候选
  const candidates = [];
  for (const base of searchRoots()) {
    if (!fs.existsSync(base)) continue;
    const self = findIn(base);
    if (self) candidates.push({ dir: self, tag: `搜索根 ${base}` });
    let subs = [];
    try {
      subs = fs.readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => path.join(base, e.name));
    } catch { /* 读不到就跳过 */ }
    for (const sub of subs) {
      const hit = findIn(sub);
      if (hit) candidates.push({ dir: hit, tag: `搜索根 ${base} 下的 ${path.basename(sub)}/` });
    }
    tried.push(`搜索根 ${base}`);
  }

  if (candidates.length) {
    // 优选顺序（**实测依据**，见下方注释）：
    //   ① PIXI 6 组合优先
    //   ② 文件更全（必需 → 可选）
    //   ③ 路径更短（稳定排序）
    const scored = candidates.map((c) => {
      const files = collectFiles(c.dir);
      const req = REQUIRED.filter((n) => files[n]).length;
      const opt = OPTIONAL.filter((n) => files[n]).length;
      const pm = pixiMajor(c.dir);
      // pixi6 = 1 表示是 PIXI 6 组合（优先）
      return { ...c, files, req, opt, pixi: pm, pixi6: pm === 6 ? 1 : 0 };
    }).sort((a, b) => (b.pixi6 - a.pixi6) || (b.req - a.req) || (b.opt - a.opt)
      || a.dir.length - b.dir.length);

    const best = scored[0];
    // 候选清单结构化成一个数组塞进 detail：服务端得到单行可解析日志，
    //   CLI 兜底实现（cliLog）会把它还原成多行人类可读格式。
    log.info('候选（按优选顺序）', {
      candidates: scored.map((s) => ({ pixi: s.pixi, req: s.req, opt: s.opt, dir: s.dir })),
    });
    return {
      ...pack(best.dir, best.tag),
      candidates: scored.map((s) => ({ dir: s.dir, req: s.req, opt: s.opt, pixi: s.pixi })),
    };
  }

  throw new Error(
    '未找到 Live2D 运行时库（需要 live2d.min.js / pixi.min.js / index.min.js）。\n'
    + '请设置环境变量 LIVE2D_RUNTIME_DIR 指向含这三个文件的目录，\n'
    + '或用 LIVE2D_SEARCH_ROOTS 指定搜索根（多个用路径分隔符隔开）。\n'
    + `已尝试：${tried.join('、')}`
  );
}

/** 收集目录下存在（且非空）的必需 + 可选文件。 */
function collectFiles(dir) {
  const files = {};
  for (const n of [...REQUIRED, ...OPTIONAL]) {
    const f = path.join(dir, n);
    try {
      if (fs.statSync(f).isFile() && fs.statSync(f).size > 1024) files[n] = f;
    } catch { /* 不存在则跳过 */ }
  }
  return files;
}

/** 组装返回值：必需 + 可选文件的绝对路径。 */
function pack(dir, origin) {
  const files = collectFiles(dir);
  const missingOptional = OPTIONAL.filter((n) => !files[n]);
  return { dir, files, origin, missingOptional };
}

// 直接运行时打印探测结果，便于排查
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = resolveLive2DRuntimes();
    console.log('探测到 Live2D 运行时来源:', r.origin);
    console.log('目录:', r.dir);
    for (const [n, f] of Object.entries(r.files)) {
      console.log(`  ${n}: ${(fs.statSync(f).size / 1024).toFixed(0)} KB`);
    }
    if (r.missingOptional.length) {
      console.log('缺少可选文件（仅影响 Cubism 4 .moc3 模型）:', r.missingOptional.join(', '));
    }
  } catch (e) {
    console.error('探测失败:', e.message);
    process.exit(1);
  }
}
