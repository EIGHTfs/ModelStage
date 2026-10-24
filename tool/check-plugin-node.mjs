#!/usr/bin/env node
// ============================================================================
// tool/check-plugin-node.mjs —— 在 node 侧跑 unity-live2d-bundle 的 resolve()（不经过浏览器）
//
// 用途：
//   ① 验收「插件可在 node 侧运行」（DOM 依赖必须可降级）——服务端解包的前置条件；
//   ② 17b（服务端解包 → 落盘 data/unpacked/）的基础：它本质上就是"在 node 里跑插件"，
//      本文件的沙盒装载方式（vm 注入 lib + 无 window/document）正是那条路的起点。
//   ③ 静态自检：不依赖浏览器、不依赖 HTTP 服务，可重复、可无人值守。
//
// 与 tool/check-plugin.mjs 的分工：
//   · check-plugin.mjs   —— 契约层静态检查（plugin.json / descriptor / PL1–PL8），不真解包；
//   · 本文件             —— 在 node 里真跑一遍：canHandle + resolve → {prefix,files,entry}。
//   （插件自带的 self-test.mjs 已于 40a9d21 删除，lib 逐层校验与 oracle 比对随之不在本仓提供。）
//
// 用法：
//   node tool/check-plugin-node.mjs [选项]
//     --file <路径>     只解某一个 UnityFS 文件（不给则扫全部资源根）
//     --root <rootId>   限定只扫某一个资源根（不给则扫全部已启用根）
//     --json            只输出 JSON 报告
//
// 资源根路径不写死：从 config/resources.json 读（JSONC，用 tool/parse-jsonc.mjs 剥离注释）。
// 哪些文件算"容器"也不写死：读文件头 8 字节判 UnityFS 魔数（与发现阶段同口径，不靠扩展名）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './parse-jsonc.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(REPO, 'plugins', 'unity-live2d-bundle');
const RESOURCES_JSON = path.join(REPO, 'config', 'resources.json');

// ---------------------------------------------------------------- 参数解析
const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ONLY_FILE = argOf('file', null);
const ONLY_ROOT = argOf('root', null);
const JSON_ONLY = argv.includes('--json');
const say = (...a) => { if (!JSON_ONLY) console.log(...a); };

// ---------------------------------------------------------------- 资源根（从配置读，不写死）
// 注意一：resources.json 是 **JSONC（带 // 注释）**，不能 JSON.parse 裸读。
//   用项目现成的 tool/parse-jsonc.mjs 剥离注释后再解析（resources.json 头部注释即如此声明）。
// 注意二：资源配置里**没有 kind 字段**——某个根装不装 UnityFS 容器由发现阶段按魔数判定
//   （见 resources.json 头部对 azurlane_bundle 的说明）。所以这里不按 kind 预设"哪个是 bundle 根"，
//   改为：默认扫**全部已启用且目录存在**的根，逐个按 UnityFS 魔数挑文件；
//   `--root <id>` 可限定只扫某一个根。
function pickRoots() {
  const cfg = parseJsonc(fs.readFileSync(RESOURCES_JSON, 'utf8'), 'config/resources.json');
  const roots = Array.isArray(cfg.roots) ? cfg.roots : [];
  const usable = roots.filter((r) => r && r.path && r.enabled !== false && fs.existsSync(r.path));
  const chosen = ONLY_ROOT ? usable.filter((r) => r.id === ONLY_ROOT) : usable;
  if (!chosen.length) {
    throw new Error(`config/resources.json 里没有可用的资源根${ONLY_ROOT ? `（id=${ONLY_ROOT}）` : ''}`
      + `（已启用且目录存在的共 ${usable.length} 个：${usable.map((r) => r.id).join(', ') || '无'}）`);
  }
  return chosen;
}

// ---------------------------------------------------------------- node 侧沙盒装载插件
// 关键点：插件是「注入式经典脚本」（顶层 install() + 可选宿主注册），不能当 ESM import。
//   这里用 vm 在**没有 window/document** 的沙盒里执行全部 lib + index.js，
//   从 globalThis.__ULB_NODE__ 取 resolve/canHandle —— 这正是 node 侧的真实运行形态。
function loadPluginInNode() {
  const sandbox = {
    globalThis: {},
    console,
    TextEncoder, TextDecoder,
    Blob,                                        // node 18+ 全局
    URL: { createObjectURL: () => { throw new Error('node 侧不应调用 createObjectURL'); } },
    AbortController,
    fetch: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }),  // loadProfile 拿不到就走默认规则
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const libs = [
    'lib/errors.js', 'lib/bytes.js', 'lib/common-strings.js', 'lib/unityfs.js', 'lib/serialized.js',
    'lib/typetree.js', 'lib/extract.js', 'lib/etc2.js', 'lib/dxt.js', 'lib/texdecode.js',
    'lib/bundle-probe.js', 'lib/png.js', 'lib/anim-to-motion.js', 'lib/model3.js',
  ];
  for (const rel of libs) {
    vm.runInContext(fs.readFileSync(path.join(PLUGIN, rel), 'utf8'), sandbox, { filename: rel });
  }
  const NS = sandbox.__ULB__;
  if (!NS || !NS.bytes) throw new Error('lib/bytes.js 未能挂载 __ULB__');
  // Node 侧注入浏览器侧由 DecompressionStream / 原生 API 提供的两块能力
  NS.bytes.setSha256((u8) => crypto.createHash('sha256').update(u8).digest('hex'));
  NS.png.setInflate((u8) => new Uint8Array(zlib.inflateSync(Buffer.from(u8))));
  NS.png.setDeflate((u8) => new Uint8Array(zlib.deflateSync(Buffer.from(u8), { level: 6 })));

  vm.runInContext(fs.readFileSync(path.join(PLUGIN, 'index.js'), 'utf8'), sandbox, { filename: 'index.js' });
  const api = sandbox.__ULB_NODE__;
  if (!api || typeof api.resolve !== 'function') {
    throw new Error('插件未挂载 __ULB_NODE__（node 侧导出失败；index.js 末尾的条件挂载是否被改坏？）');
  }
  return { resolve: api.resolve, canHandle: api.canHandle };
}

// ---------------------------------------------------------------- 主流程
const roots = pickRoots();
const { resolve, canHandle } = loadPluginInNode();

say('环境：node（无 window/document，走降级路径）');
say(`扫描资源根 ${roots.length} 个：${roots.map((r) => r.id).join(', ')}\n`);

// 挑哪些文件交给插件：与发现阶段同口径——**读文件头 8 字节判 UnityFS 魔数**，
//   不靠扩展名（碧蓝的包就是无扩展名单文件），也不预设"哪些算包"。
function isUnityFsFile(full) {
  let fd;
  try {
    fd = fs.openSync(full, 'r');
    const head = Buffer.alloc(8);
    const n = fs.readSync(fd, head, 0, 8, 0);
    return n === 8 && head.toString('latin1', 0, 7) === 'UnityFS' && head[7] === 0;
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

const targets = ONLY_FILE
  ? [{ root: roots[0], rel: path.basename(ONLY_FILE), full: ONLY_FILE }]
  : roots.flatMap((r) => fs.readdirSync(r.path)
    .filter((f) => fs.statSync(path.join(r.path, f)).isFile() && isUnityFsFile(path.join(r.path, f)))
    .map((f) => ({ root: r, rel: f, full: path.join(r.path, f) })));

say(`按 UnityFS 魔数挑出 ${targets.length} 个容器文件\n`);

const rows = [];
let pass = 0;
for (const t of targets) {
  const { root, rel, full } = t;
  const bytes = new Uint8Array(fs.readFileSync(full));
  const row = { root: root.id, file: rel, size: bytes.length };
  try {
    row.canHandle = canHandle({ rootId: root.id, rel, name: rel, size: bytes.length, bytes });
    const r = await resolve({
      rootId: root.id, rel, name: rel, size: bytes.length, bytes,
      host: { fetchFile: async () => bytes },      // 宿主持字节通道（§3.6）
    });
    // ⚠️ 跨 vm 上下文：插件在沙盒内构造的 Map，拿到沙盒外 `instanceof Map` 为 false
    //   （两个上下文各有一套 Map 构造器）。所以不能靠 instanceof 判断，改用鸭子类型：
    //   有 size + keys()/values() 方法就当 Map 用，否则按普通对象取键值。
    const isMapLike = (v) => v && typeof v.size === 'number' && typeof v.keys === 'function' && typeof v.values === 'function';
    const keys = isMapLike(r.files) ? [...r.files.keys()] : Object.keys(r.files || {});
    const vals = isMapLike(r.files) ? [...r.files.values()] : Object.values(r.files || {});
    row.ok = true;
    row.prefix = r.prefix;
    row.entry = r.entry;
    row.files = keys.length;
    row.entryInFiles = isMapLike(r.files) ? r.files.has(r.entry) : Object.prototype.hasOwnProperty.call(r.files || {}, r.entry);
    row.valueTypes = [...new Set(vals.map((v) => v && v.constructor && v.constructor.name))];
    row.extraKeys = Object.keys(r).filter((k) => !['prefix', 'files', 'entry'].includes(k));
    pass++;
    say(`✅ ${(root.id + '/' + rel).padEnd(34)} files=${String(row.files).padStart(3)} entry=${row.entry} `
      + `entryInFiles=${row.entryInFiles} 值类型=${row.valueTypes.join('/')}`);
  } catch (e) {
    row.ok = false;
    row.error = e && e.code ? e.code : String(e);
    row.message = String((e && e.message) || e).slice(0, 100);
    say(`❌ ${(root.id + '/' + rel).padEnd(34)} ${row.error} ${row.message}`);
  }
  rows.push(row);
}

const summary = { total: rows.length, pass, fail: rows.length - pass };
if (JSON_ONLY) console.log(JSON.stringify({ roots: roots.map((r) => r.id), summary, rows }, null, 2));
else say(`\nnode 侧解包：${pass}/${summary.total} 成功${summary.fail ? `（失败 ${summary.fail}）` : ''}`);
process.exit(summary.fail ? 1 : 0);
