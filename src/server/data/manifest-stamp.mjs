// data/manifest-stamp.mjs —— 资源清单的「目录签名」：判断落盘清单是否还跟得上磁盘。
// 背景：清单一旦落盘就无条件复用，加/删模型目录后不带 ?refresh=1 会一直读旧清单。
// 做法：清单里存一份目录 mtime 快照，读之前比对；只 stat 目录、不扫文件（扫文件才是重建成本）。
// 边界：目录 mtime 只反映**直接子项**增删/改名；改文件内容不会更新父目录 mtime ⇒ 不触发重建
//   （仍需 ?refresh=1）。记录根 + 一级子目录，可覆盖"模型目录内增删"这一类最常见的变动。

import fs from 'node:fs';
import path from 'node:path';

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
  if (now.root === null || now.root !== sig.root) return false;
  const before = Object.keys(sig.dirs);
  const after = Object.keys(now.dirs);
  if (before.length !== after.length) return false; // 出现新目录 / 目录被删
  for (const name of after) {
    if (sig.dirs[name] !== now.dirs[name]) return false; // 目录内增删（mtime 变了）
  }
  return true;
}
