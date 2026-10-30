// live2d/vfs-settings.js —— 让 Live2D 的内部文件（moc3 / 贴图 / physics / 动作）也走 VirtualFS
//
// 背景：pixi-live2d-display 加载模型时，model3.json 里的相对引用最终都经
//   `ModelSettings.resolveURL(ref)` 变成实际地址 —— 这是那套库里**唯一**的"相对引用 → 地址"入口
//   （moc3 走 `_live2d_load(settings.resolveURL(moc))`、贴图与 physics 在 setup 阶段、
//    动作/表情/音声经 FileLoader 的 `settings.resolveURL(url)`）。
//   库自己"把文件夹拖进页面"的功能就是靠覆盖这个方法把引用映射到 blob URL 的。
//
// 所以这里不改库、也不 patch fetch（契约禁止）：构造 ModelSettings 实例、覆盖 resolveURL，
//   让它先去问 VirtualFS，命中就用虚拟地址（blob），未命中才回落到网络地址。
//
// 为什么不会踩到"blob 不能当基址"：
//   settings.url 只用于给库做占位/校验，真实解析全由我们的 resolveURL 完成；
//   返回的 blob URL 直接进 XHR/Image，不再经过库里的 url.resolve。
//
// ⚠️ 本文件**只对容器模型**生效（entryUrl 是 vfs://）：VFS 只登记容器产物，
//   散目录模型的每个内部文件来查都必然 miss（白跑查找 + 每文件一条 warn），
//   所以 model.js 的 buildVfsSettingsOrNull 对散目录直接返回 null、走原生 URL 路径。
//   ⇒ 能走到下面 resolveURL 的都是"本该命中 VFS"的模型；这里 miss 意味着
//     **容器产物真缺该文件**，那条 warn 值得看（不是噪音）。
import { isDirectUrl } from './stage-ctx.js';
// 版本差异（settings 类名）只在 runtime-adapter 里收敛：本文件不再出现具体类名
import { getSettingsCtor } from './runtime-adapter.js';

/** 单模型解析统计（验收/排查：命中了哪些文件、哪些回落网络） */
function createStats() {
  return { calls: 0, hits: [], missing: [], source: null };
}

/** 引用归一：去掉 './' 前缀（model3.json 里两种写法都常见） */
function normalizeRef(ref) {
  return String(ref == null ? '' : ref).replace(/^\.\//, '');
}

/** 目录地址（保留末尾斜杠）；不可解析返回 null */
function dirOf(url) {
  const text = String(url == null ? '' : url);
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text.replace(/[^/]*$/, '');
  try {
    const base = typeof location !== 'undefined' ? location.href : 'http://localhost/';
    return new URL(text, base).href.replace(/[^/]*$/, '');
  } catch {
    return null;
  }
}

/** 入口若是 vfs:// 就返回其目录（作为虚拟前缀），否则 null */
function vfsPrefixOf(entryUrl) {
  return /^vfs:\/\//i.test(String(entryUrl || '')) ? dirOf(entryUrl) : null;
}

/** 判定 Cubism 2（.moc）/ 4（.moc3）：按 moc 扩展名，其次看 Version */
function isCubism2(json) {
  const moc = String((json && json.FileReferences && json.FileReferences.Moc) || '');
  if (/\.moc$/i.test(moc)) return true;
  const ver = Number(json && json.Version);
  return Number.isFinite(ver) && ver < 3;
}

/** 取实例构造器（类名兼容在 adapter 里，这里只判 Cubism 世代） */
function pickSettingsCtor(cubism2) {
  try {
    return getSettingsCtor(cubism2 ? 'cubism2' : 'cubism4');
  } catch (e) {
    // 把 adapter 的明确原因（version-unsupported + 库实际导出的类名）带出去，
    //   而不是笼统的 null —— 排障时要看的就是"库到底导出了哪些 Settings 类"
    return { error: (e && e.message) || 'version-unsupported' };
  }
}

/** 入参校验：可用返回 null，否则返回原因（供调用方 warn） */
function inputReason(json, vfs) {
  if (!json || !json.FileReferences) return 'no-json';
  if (!vfs || typeof vfs.resolve !== 'function') return 'no-vfs';
  return null;
}

/**
 * 实例化 settings。
 * 库升级可能改名/改语义：没有 resolveURL 就当作不支持（调用方回落旧路径，绝不白屏）。
 * @returns {{settings: object|null, reason: string|null}}
 */
function instantiateSettings(json, entryUrl) {
  const picked = pickSettingsCtor(isCubism2(json));
  // 取不到构造器时把 adapter 给的**具体原因**（试过哪些类名、库实际导出了什么）带出去
  if (!picked || typeof picked !== 'function') {
    return { settings: null, reason: (picked && picked.error) || 'version-unsupported: 没有可用的 settings 构造器' };
  }
  const Ctor = picked;
  try {
    const settings = new Ctor({ ...json, url: vfsPrefixOf(entryUrl) || dirOf(entryUrl) || '' });
    if (!settings || typeof settings.resolveURL !== 'function') return { settings: null, reason: 'no-resolve-url' };
    return { settings, reason: null };
  } catch (e) {
    return { settings: null, reason: `ctor-throw:${(e && e.message) || e}` };
  }
}

/**
 * 候选虚拟地址（**按引用形状选**，不做暴力试探）。
 * 为什么不三个候选都试：VFS 的 stats.misses 按「每次未命中的 resolve 调用」累计，
 *   盲目试探会让 misses 虚高（曾出现"明明全部命中却报 6 次 miss"的假象）。
 * · 绝对路径引用（/dir/x）：直接按该路径问 VFS —— 对应"插件按服务端路径注册"的做法
 * · 相对引用（motions/x）：以 vfs 前缀（入口是 vfs:// 时）或入口网络目录为基准
 */
function candidatesFor(key, vfsPrefix, entryDir) {
  if (key.startsWith('/')) return [key];
  const out = [];
  if (vfsPrefix) out.push(vfsPrefix + key);
  if (entryDir) out.push(entryDir + key);
  return out.length ? out : [key];
}

/** 单个候选去问 VFS（异常一律当未命中） */
function tryResolve(vfs, cand) {
  try {
    return vfs.resolve(cand);
  } catch {
    return null;
  }
}

/** 把 resolveURL 换成"先问 VFS、未命中回落网络"（统计供验收/排查） */
function installResolver(settings, ctx) {
  const { vfs, vfsPrefix, entryDir, stats, note } = ctx;
  settings.resolveURL = function resolveUrlViaVfs(ref) {
    const key = normalizeRef(ref);
    stats.calls += 1;
    if (isDirectUrl(key)) return key;              // data:/blob:/http(s) 已是最终地址
    for (const cand of candidatesFor(key, vfsPrefix, entryDir)) {
      const hit = tryResolve(vfs, cand);
      if (hit) { stats.hits.push(key); return hit; }
    }
    stats.missing.push(key);
    note(`Live2D 资源未在 VFS 中命中，回落网络：${key}`, 'warn');
    return entryDir ? entryDir + key.replace(/^\/+/, '') : key;
  };
}

/**
 * 构造"内部文件走 VirtualFS"的 settings 实例。
 * @param {{json:object, entryUrl:string, vfs:object, log?:Function}} options
 * @returns {{settings:object|null, stats:object, reason?:string}}
 */
export function createVfsSettings({ json, entryUrl, vfs, log } = {}) {
  const stats = createStats();
  const note = typeof log === 'function' ? log : () => {};
  const bad = inputReason(json, vfs);
  if (bad) return { settings: null, stats, reason: bad };
  const { settings, reason } = instantiateSettings(json, entryUrl);
  if (!settings) return { settings: null, stats, reason };
  stats.source = isCubism2(json) ? 'cubism2' : 'cubism4';
  installResolver(settings, {
    vfs, vfsPrefix: vfsPrefixOf(entryUrl), entryDir: dirOf(entryUrl), stats, note,
  });
  return { settings, stats };
}
