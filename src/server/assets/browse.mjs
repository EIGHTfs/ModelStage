// browse.mjs —— 浏览服务端本机目录（/api/browse 的数据层）
//
// 用途：网页里选择「部署设备上的资源根目录」。浏览器 File System Access API 只能选
// 用户本机文件且拿不到绝对路径，而资源在 NAS 上，所以必须由服务端列目录。
// 只列目录与名称，不返回文件内容。
import fs from 'node:fs';
import path from 'node:path';

/**
 * @returns {{status: number, body: object}}
 */
export function browseDir(dirParam) {
  const dir = dirParam || '/';
  let abs;
  try {
    abs = path.resolve(dir);
  } catch {
    return { status: 400, body: { error: '路径无效' } };
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return { status: 404, body: { error: '目录不存在', path: dir } };
  }
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    return { status: 500, body: { error: e.message } };
  }

  const dirs = [];
  let skelCount = 0;
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (!e.isDirectory()) {
      if (path.extname(e.name).toLowerCase() === '.skel') skelCount++;
      continue;
    }
    dirs.push({ name: e.name, path: path.join(abs, e.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  return {
    status: 200,
    body: {
      path: abs,
      parent: path.dirname(abs) === abs ? null : path.dirname(abs),
      dirs,
      // 供界面提示：该目录看起来是否像 Spine 资源根
      hint: {
        subDirCount: dirs.length,
        skelHere: skelCount,
        looksLikeResourceRoot: dirs.length > 0,
      },
    },
  };
}
