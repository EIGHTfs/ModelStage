// ============================================================================
// tool/lib/bundle-probe-node.mjs —— 在 Node 里跑插件的「装载前预检」
//
// 为什么要这一层：预检实现只有插件里的 lib/bundle-probe.js 一份。
//   浏览器由插件 index.js 用，服务端由本文件把同一份 js 读进 vm 沙箱执行。
//   这样 /api/bundle/probe 与页面里的 probe 结论必然一致，不存在两份解析逻辑。
//
// **按能力找提供者，不认插件名**：
//   谁声明了 plugin.json 的 provides 含 `bundle-analyzer`，就用谁的 lib。
//   一个都没有时**降级**为按文件头判定种类（UnityFS / CAB- / MOC3 / ZIP / JSON），
//   而不是报错 —— "没装插件"应当表现为信息更少，不是功能坏掉。
//
// 只加载**数据层**需要的库（不加载 index.js / 渲染相关），首次调用时建沙箱并缓存。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
// 依赖包判据与文案（与前端 plugin-host 共用一份，见 src/shared/bundle-shape.mjs）
import { histogramFromObjects, isAssetDependencyHistogram, dependencyReason } from '../../src/shared/bundle-shape.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/** 分析能力在契约里的角色名（插件契约 §一） */
const ANALYZER_ROLE = 'bundle-analyzer';

/**
 * 按 `provides` 找能分析容器字节流的插件。
 *
 * 排序规则：`matchPriority` 小的优先（与资产提供者的选择顺序同口径），
 *   同优先级时按 id 字典序 —— 保证**同一台机器上每次选到同一个**，
 *   不依赖 readdir 的返回顺序（那个顺序在换文件系统后会变）。
 *
 * @param {string} [pluginsDir] 插件根目录；缺省为项目的 plugins/。测试可传一个空目录验降级路径。
 * @returns {{pluginId: string, libDir: string, libFiles: string[]}|null}
 */
export function findAnalyzerProvider(pluginsDir = path.join(ROOT, 'plugins')) {
  let entries;
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return null;   // 没有 plugins 目录 = 一个提供者都没有，走降级
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 与 src/server/plugins/registry.mjs 同一判据：`.` 开头的目录不是插件。
    //   `.trash`（回收站）与 `.bak-*` 里常有完整的历史插件副本，若参与分派，
    //   分析结论可能来自已被删除的旧版本。
    if (entry.name.startsWith('.')) continue;
    const manifestPath = path.join(pluginsDir, entry.name, 'plugin.json');
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;   // 没有清单或清单坏了：跳过（不是本角色的提供者）
    }
    const provides = Array.isArray(manifest.provides) ? manifest.provides : [];
    if (!provides.includes(ANALYZER_ROLE)) continue;

    const files = Array.isArray(manifest.files) ? manifest.files : [];
    const libFiles = files
      .filter((f) => typeof f === 'string' && f.startsWith('lib/'))
      .map((f) => f.slice('lib/'.length));
    if (!libFiles.length) continue;   // 声明了角色却没有 lib：无法执行，跳过

    candidates.push({
      pluginId: manifest.id || entry.name,
      libDir: path.join(pluginsDir, entry.name, 'lib'),
      libFiles,
      priority: Number.isFinite(manifest.matchPriority) ? manifest.matchPriority : Number.MAX_SAFE_INTEGER,
    });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.priority - b.priority) || a.pluginId.localeCompare(b.pluginId));
  const { pluginId, libDir, libFiles } = candidates[0];
  return { pluginId, libDir, libFiles };
}

/**
 * 取某提供者的 lib 目录。
 * @param {{libDir: string}} provider
 * @returns {string}
 */
export function libDirFor(provider) {
  return provider.libDir;
}

/**
 * 取某提供者「预检要加载的 lib 文件清单」——**唯一真相是 manifest**。
 *
 * 为什么必须派生：这份清单曾经是手写的，与 plugin.json 的 files[] 构成"同一事实的两处表达"。
 *   漏一边的表现极难定位：**浏览器能跑（按 files[] 加载）、服务端预检报缺依赖（按手写清单加载）**。
 *   所以这里不再保留任何文件名常量，只做一件事：按 files[] 顺序取出 `lib/` 前缀项并去掉前缀。
 *
 * 顺序也来自 manifest：files[] 本身就是依赖顺序（errors 最先、bundle-probe 在后），
 *   派生时**原样保留**，不重排（重排就等于又引入一处人工判断）。
 *
 * @param {{libFiles: string[]}} provider
 * @returns {string[]} 形如 ['errors.js', 'bytes.js', ...]
 */
export function libOrderFor(provider) {
  return provider.libFiles;
}

/**
 * 一个提供者的沙箱（按 pluginId 缓存）。
 *
 * 为什么按提供者缓存而不是全局一个：两个插件各自有一份 lib/bundle-probe.js，
 *   缓存键必须能区分它们，否则"先扫到谁就用谁的实现"会变成隐式约定。
 * @type {Map<string, object>}
 */
const sandboxes = new Map();

/** 建（或取缓存的）库沙箱。首次用到某提供者时才读文件 + 执行。 */
function getSandbox(provider) {
  const cached = sandboxes.get(provider.pluginId);
  if (cached) return cached;

  const ctx = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);

  const libDir = libDirFor(provider);
  for (const rel of libOrderFor(provider)) {
    const abs = path.join(libDir, rel);
    // 报错要能自己说清"该看哪两个地方"：manifest 声明了但磁盘上没有
    if (!fs.existsSync(abs)) {
      throw new Error(`预检依赖缺失：plugins/${provider.pluginId}/lib/${rel}（plugin.json 的 files[] 里有它，但磁盘上没有）`);
    }
    // 用 vm 执行而非 import：这些库是浏览器风格的脚本（挂 globalThis.__ULB__），不是 ESM
    vm.runInContext(fs.readFileSync(abs, 'utf8'), ctx, { filename: `${provider.pluginId}-lib/${rel}` });
  }
  sandboxes.set(provider.pluginId, ctx);
  return ctx;
}

/**
 * 一个都认不出来时的按文件头判定。
 *
 * 只看前几个字节，不下任何"能不能用"的结论 —— 那需要真解析。
 * 这段存在的意义是：没装插件时，调用方仍然知道**手里这个文件大概是什么**。
 * @param {Uint8Array} bytes
 * @returns {{kind: string, note: string}}
 */
function detectByMagic(bytes) {
  const len = bytes.length;
  const ascii = (n) => {
    let s = '';
    for (let i = 0; i < Math.min(n, len); i += 1) s += String.fromCharCode(bytes[i]);
    return s;
  };
  if (ascii(7) === 'UnityFS') return { kind: 'UnityFS', note: 'Unity 资源包（装 unity-*-bundle 插件可细看内容）' };
  if (ascii(4) === 'CAB-') return { kind: 'CAB-', note: 'Unity serialized file（裸 CAB，通常是资源包解出来的节点）' };
  if (ascii(4) === 'MOC3') return { kind: 'MOC3', note: 'Cubism 4 模型二进制' };
  if (len >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return { kind: 'ZIP', note: 'ZIP 容器' };
  if (len >= 1 && (bytes[0] === 0x7b || bytes[0] === 0x5b)) return { kind: 'JSON', note: 'JSON 文本' };
  return { kind: 'unknown', note: '无法从文件头识别' };
}

/** 没有提供者时的降级结论：形状与正常结论兼容，只是字段更少。 */
export function analyzeByMagicOnly(bytes) {
  const magic = detectByMagic(bytes);
  return {
    ok: false,
    code: 'ULB_ERR_NO_ANALYZER',
    error: `未安装能分析资源包的插件；仅按文件头判定为 ${magic.kind}（${magic.note}）`,
    container: null,
    objects: null,
    textures: null,
    magic: magic.kind,
    warnings: [
      `按文件头判定为 ${magic.kind}：${magic.note}`,
      `安装声明 ${ANALYZER_ROLE} 角色的插件后，可得到容器头 / 对象表 / 纹理格式等完整分析`,
    ],
  };
}

/**
 * 预检一个资源包字节流。
 *
 * 提供者按 plugin.json 的 provides 找（不认插件名）；一个都没有时降级为魔数判定。
 * @param {Uint8Array} bytes
 * @returns {object} 与插件内 probe 同源的结论 + 包内类型构成（依赖包判定用）
 */
export function probeBundleBytes(bytes) {
  const provider = findAnalyzerProvider();
  if (!provider) return analyzeByMagicOnly(bytes);

  const ctx = getSandbox(provider);
  const NS = ctx.__ULB__;
  const bp = NS && NS.bundleProbe;
  const res = (bp && typeof bp.run === 'function') ? bp.run(bytes) : null;

  // 附加：包内 className 构成 + 是否"美术依赖包"。
  //   判据与文案来自 src/shared/bundle-shape.mjs —— 与前端 plugin-host 用的是同一份，
  //   保证"页面点开"与"直接调 /api/unpack"对同一个包给同一个答案。
  //   这里再解析一次（诊断路径、不进热路径），因为 run() 不暴露对象表。
  let shape = null;
  try {
    const parsed = NS.unityfs.parse(bytes);
    const cab = (parsed.nodes || []).find((n) => /^CAB-/.test(n.path));
    if (cab) {
      const sf = NS.serialized.parse(NS.unityfs.nodeBytes(parsed, cab.path));
      const histogram = histogramFromObjects(sf);
      shape = {
        objectCount: (sf.objects || []).length,
        histogram,
        assetDependency: isAssetDependencyHistogram(histogram),
      };
      if (shape.assetDependency) shape.dependencyReason = dependencyReason(histogram);
    }
  } catch { /* 形态探测失败不影响主结论（探不到就不下依赖包结论） */ }

  return Object.assign({}, res || {}, shape || {});
}

// 路径与清单都**不再导出成常量**（常量会诱使别人继续手写第二份）；
//   需要自查清单时调 libOrderFor(provider) 现取。
export { ROOT, ANALYZER_ROLE };
export const PROBE_PATHS = { ROOT, findAnalyzerProvider, libDirFor, libOrderFor };
