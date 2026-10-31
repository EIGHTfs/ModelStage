// data/manifest-stamp.mjs —— 落盘清单「还跟不跟得上」的两套判据都在这里：
//   ① dirSignature / signatureMatches —— 目录签名：资源目录增删（只 stat 目录，不扫文件）
//   ② generatorFingerprint           —— 生成者指纹：解析代码变化（文件内容哈希）
// 背景：清单一旦落盘就无条件复用，加/删模型目录后不带 ?refresh=1 会一直读旧清单；
//   而"只改解析代码"连目录 mtime 都不动 ⇒ 必须另有一条"代码变了"的判据，否则改完代码界面还是旧数据。
// 边界：目录 mtime 只反映**直接子项**增删/改名；记录根 + 一级子目录，
//   可覆盖"模型目录内增删"这一类最常见的变动。**模型文件内容**变了仍不触发重建（那要 ?refresh=1），
//   而**解析代码**变了由②兜住 —— 两条判据各管一段，别互相替代。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** mtime 取整毫秒（不同文件系统精度不同，浮点尾差会造成假失效） */
function msOf(p) {
  try {
    return Math.round(fs.statSync(p).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * 计算一个资源根的目录签名。
 * @param {string} rootPath 资源根本机路径
 * @returns {{root: number|null, dirs: Record<string, number>}} 根目录 mtime + 一级子目录 mtime 表
 */
export function dirSignature(rootPath) {
  const sig = { root: msOf(rootPath), dirs: {} };
  if (sig.root === null) return sig;
  try {
    for (const e of fs.readdirSync(rootPath, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const m = msOf(path.join(rootPath, e.name));
      if (m !== null) sig.dirs[e.name] = m;
    }
  } catch {
    /* 目录读不了：签名只保留根，比对时自然判为不一致 */
  }
  return sig;
}

/**
 * 清单里的签名是否仍与磁盘一致。
 * @param {{root: number|null, dirs: Record<string, number>}|undefined} sig 清单里存的 dirStamps
 * @param {string} rootPath 资源根本机路径
 * @returns {boolean} true = 可用缓存；false = 需重建
 */
export function signatureMatches(sig, rootPath) {
  if (!sig || typeof sig !== 'object' || !sig.dirs || typeof sig.dirs !== 'object') return false;
  const now = dirSignature(rootPath);
  // 「根目录不存在」也是**稳定状态**，不是"变了"：
  //   配置里可能存在一个路径写错/尚未创建的根（实例：live2d 根指向 …/DestinyChildLive2D/assets/live2d，
  //   该目录不存在）。若把 null 一律判为不一致，就会**每次请求都重建清单**（日志刷
  //   「目录已变化，清单失效重建」），白白消耗 CPU 与磁盘写。
  //   正确语义：上次也不存在（sig.root === null）⇒ 没变化 ⇒ 命中缓存。
  if (now.root === null) return sig.root === null;
  if (now.root !== sig.root) return false;
  const before = Object.keys(sig.dirs);
  const after = Object.keys(now.dirs);
  if (before.length !== after.length) return false; // 出现新目录 / 目录被删
  for (const name of after) {
    if (sig.dirs[name] !== now.dirs[name]) return false; // 目录内增删（mtime 变了）
  }
  return true;
}

// ============================================================================
// 生成者指纹（generator）
//
// 为什么需要它：dirStamps 只感知**目录增删**，改解析代码它一点都察觉不到 ⇒
//   修好「atlas 首行 BOM 丢第一页」后，界面仍读旧清单（textureCount 还是 1），
//   必须手工删 config/models/spine.<root>.json 才生效 —— 白验证一轮。
// 做法：清单里存一份「解析器文件内容哈希」，读清单时比对；不等就重建。
//   用内容哈希而不是人工版本号：人工号一定会忘（本项目已多次踩"改了判据忘升版本"）。
//   写法照 src/server/plugins/registry.mjs 的 builtinVersionHash：缓存键用 (mtime, size)，
//   文件没变不重算哈希。
// ============================================================================

/** 项目根（本文件在 src/server/data/ ⇒ 往上三层） */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * 参与「生成者指纹」的文件。
 * 选它们的理由：这三处共同决定清单里的元数据长什么样 ——
 *   · spine.mjs  —— spine 扫描与清单字段
 *   · live2d.mjs —— live2d 扫描与清单字段
 *   · probe.mjs  —— 两者共用的资产探测（atlas 页名、纹理尺寸、版本解析都在这里，BOM 那个 bug 就在此）
 * 缺文件就跳过（不炸）：某个模块被挪走，也不该让清单读不出来。
 */
const GENERATOR_FILES = [
  'src/server/data/spine.mjs',
  'src/server/data/live2d.mjs',
  'src/server/assets/probe.mjs',
];

/** 生成者指纹的进程内缓存（签名 = 参与文件的 mtime/size 串） */
let generatorCache = { sig: null, value: '0' };

/**
 * 生成者指纹：解析器文件内容哈希的前 8 位。
 * @param {string} [root] 项目根（缺省按本文件位置推，不写死绝对路径）
 * @returns {string} 8 位十六进制（一个文件都读不到时为 '0'）
 */
export function generatorFingerprint(root = PROJECT_ROOT) {
  // 缓存键用 (mtime, size)：文件内容一变就重算；没变则直接返回（probe.mjs 有几百行，别每次读盘+sha256）
  let sig = '';
  const stats = [];
  for (const rel of GENERATOR_FILES) {
    try {
      const st = fs.statSync(path.join(root, rel));
      stats.push({ rel, ok: true });
      sig += `${rel}:${st.mtimeMs}:${st.size};`;
    } catch {
      stats.push({ rel, ok: false });
      sig += `${rel}:-;`;
    }
  }
  if (generatorCache.sig === sig) return generatorCache.value;

  const h = crypto.createHash('sha256');
  let used = 0;
  for (const { rel, ok } of stats) {
    if (!ok) continue;
    try {
      h.update(rel);
      h.update(fs.readFileSync(path.join(root, rel)));
      used += 1;
    } catch { /* 单个文件读不了不影响其它文件 */ }
  }
  const value = used ? h.digest('hex').slice(0, 8) : '0';
  generatorCache = { sig, value };
  return value;
}
