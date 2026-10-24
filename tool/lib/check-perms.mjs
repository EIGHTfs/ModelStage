// tool/lib/check-perms.mjs —— 源码文件/目录权限预检（门禁）
//
// 为什么要这条门禁：本项目由多人/多 AI 会话并行改文件，各自 umask 不同。
//   一旦某个 .js/.mjs/.css/.json 被写成 600，**Node 服务端（跑在另一个用户下）读不到它**
//   ⇒ 该模块 import 失败 ⇒ 整个 app 在初始化早期崩溃（window.__WEB__ 为空、页面只构建少数元素）
//   ⇒ 所有 e2e 套件拿不到结果、超时被杀 ⇒ 报一堆"未捕获异常"的红。
//   这种红**全是假红**，比不跑更贵：会让人去查业务代码。已经反复发生三次，所以做成硬门禁。
//
// 判据：
//   · 代码文件（js/mjs/css/json/html）必须 644（可读）
//   · 目录必须 755（可进入、可列）
//   · 不检查 node_modules/.git（SCAN_DIRS 已限定在源码目录内）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 需要检查权限的文件类型（只看我们自己的源码/配置） */
const CODE_EXT = /\.(js|mjs|css|json|html)$/;
/** 相对于项目根的扫描目录 */
const SCAN_DIRS = ['src', 'test', 'tool', 'config', 'public'];
/**
 * 判据不是"必须是 644"，而是「**其他用户可读**」——服务端跑在另一个用户下，只要 go+r 就够。
 *   · 文件：需要 0o004（other read）。600/640 不行；644/664/755 都行。
 *   · 目录：需要 0o005（other read+execute）。700/750 不行；755/775 都行。
 * 为什么不用精确相等：真实环境 umask 常见 002 ⇒ 664/775 是正常态，卡死它们只会制造假红。
 */
const FILE_NEED = 0o004;
const DIR_NEED = 0o005;
/** 跳过的大目录（不属于源码，权限由各自包管理器管） */
const SKIP_NAMES = new Set(['node_modules', '.git', 'dist', 'runtime']);

/**
 * 找出权限不对的文件与目录。
 * @param {string} root 项目根绝对路径
 * @returns {{files: Array<{path: string, mode: string}>, dirs: Array<{path: string, mode: string}>}}
 */
export function findBadPerms(root) {
  const files = [];
  const dirs = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;   // 目录读不到（本身就可能是权限问题）：由上层目录检查覆盖
    }
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const mode = modeOf(full);
        if (mode !== null && (mode & DIR_NEED) !== DIR_NEED) dirs.push({ path: path.relative(root, full), mode: toOctal(mode) });
        walk(full);
        continue;
      }
      if (!CODE_EXT.test(entry.name)) continue;
      const mode = modeOf(full);
      if (mode !== null && (mode & FILE_NEED) !== FILE_NEED) files.push({ path: path.relative(root, full), mode: toOctal(mode) });
    }
  };
  for (const name of SCAN_DIRS) {
    const dir = path.join(root, name);
    if (!fs.existsSync(dir)) continue;
    const mode = modeOf(dir);
    if (mode !== null && (mode & DIR_NEED) !== DIR_NEED) dirs.push({ path: name, mode: toOctal(mode) });
    walk(dir);
  }
  return { files, dirs };
}

/** 取权限位（只有低 9 位有意义）；拿不到返回 null */
function modeOf(target) {
  try {
    return fs.statSync(target).mode & 0o777;
  } catch {
    return null;
  }
}

/** 转成可读八进制（644 / 755） */
function toOctal(mode) {
  return mode.toString(8);
}

/**
 * 一行话总结（供 test-all / web.sh 直接打印）。
 * @returns {string} 没问题返回空串
 */
export function summarizeBadPerms({ files, dirs }) {
  if (!files.length && !dirs.length) return '';
  const lines = [
    `源码权限不对：文件 ${files.length} 个、目录 ${dirs.length} 个`,
    '（Node 服务端跑在另一个用户下，读不到这些文件 ⇒ 模块 import 失败 ⇒ 整个 app 崩、e2e 全部超时假红）',
  ];
  for (const item of files.slice(0, 12)) lines.push(`  ${item.mode}  ${item.path}`);
  if (files.length > 12) lines.push(`  …另有 ${files.length - 12} 个文件`);
  for (const item of dirs.slice(0, 6)) lines.push(`  ${item.mode}  ${item.path}/（目录须 755）`);
  lines.push('修复：chmod 644 <文件…>；chmod 755 <目录…>（或 chmod -R u+rwX,go+rX src test tool config public）');
  return lines.join('\n');
}

/** CLI 入口：node tool/lib/check-perms.mjs [项目根] —— 有问题的退出码 1 */
if (process.argv[1] && process.argv[1].endsWith('check-perms.mjs')) {
  // 必须用 fileURLToPath：项目路径含中文，URL.pathname 是百分号编码，直接当路径会扫空
  const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const bad = findBadPerms(root);
  const msg = summarizeBadPerms(bad);
  if (msg) {
    console.error(msg);
    process.exit(1);
  }
  console.log('源码权限检查通过（其他用户可读：文件 go+r / 目录 go+rx）');
}
