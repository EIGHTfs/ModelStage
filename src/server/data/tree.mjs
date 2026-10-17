// tree.mjs —— 目录树列举（/api/tree 的数据层）
//
// 响应对象结构与键序与旧实现保持一致（便于逐字节比对）。
//   · **不再按资源根类型分流**：同一个根里可以既有普通模型目录、也有容器单文件；
//   · 普通文件按扩展名识别（Spine 三件套附版本/assetKey）；
//   · 无扩展名或未知扩展名的文件才读 8 字节头判断是不是容器（UnityFS），命中挂 `container` 标记，
//     由发现层（roster）决定它是不是一个可装载条目。
import fs from 'node:fs';
import path from 'node:path';
import { SPINE_EXT } from '../assets/probe.mjs';

/** 已知的“普通文件”扩展名：命中这些就不必探容器魔数（省掉打开文件的代价） */
const KNOWN_FILE_EXT = new Set([
  '.json', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.txt', '.md', '.bin', '.skel', '.atlas', '.ogg', '.mp3', '.wav',
]);

/** 读目录条目；失败返回 null（由调用方转 500） */
function readEntries(abs) {
  try {
    return fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    return { error: e };
  }
}

/**
 * 通用列举：目录项 + 文件项（**不假设根的内容类型**）。
 *
 * 为什么无扩展名/未知扩展名的文件才探魔数：读头是有代价的（打开文件），
 *   而绝大多数“普通模型文件”靠扩展名就能判定；只对剩下的少数做 8 字节探测，
 *   既有“混合根”能力，也不会把每个文件都打开一遍。
 *
 * @param {object} opts
 * @param {boolean} opts.containersAvailable 是否有启用的插件能读容器（没有则只计数不列出）
 */
function collectEntries(abs, relPosix, entries, probe, plugins, containersAvailable) {
  const dirs = [];
  const files = [];
  let hidden = 0;
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(abs, e.name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (e.isDirectory()) {
      dirs.push({ name: e.name, type: 'dir' });
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    const item = { name: e.name, type: 'file', ext, size: st.size };

    if (SPINE_EXT.has(ext)) {
      // Spine 三件套：只读必要的少量头部信息
      item.isSpine = true;
      item.spineVersion = ext === '.skel' ? probe.detectSkelVersion(full) : null;
      item.assetKey = ext === '.atlas' ? probe.detectAtlasKey(full) : null;
    } else if (!KNOWN_FILE_EXT.has(ext)) {
      // 未知/无扩展名：可能是容器单文件（资源包本质就是打包来的模型）
      const container = plugins.detectBundleContainer(full);
      if (container) {
        if (!containersAvailable) { hidden += 1; continue; }
        item.container = container;
        item.rel = relPosix ? `${relPosix}/${e.name}` : e.name;
      }
    }
    files.push(item);
  }
  return { dirs, files, hidden };
}

/**
 * 列某个资源根下的目录（单一列举路径：不再按根类型分流）。
 * @returns {{status: number, body: object}}
 */
export function listTree(deps, rootId, rel) {
  const { config, plugins, probe } = deps;
  const cfg = config.readConfig().find((r) => r.id === rootId);
  if (!cfg) return { status: 400, body: { error: `未找到资源根: ${rootId}` } };
  const abs = probe.resolveSafe(cfg.path, rel);
  if (!abs) return { status: 403, body: { error: '路径越界' } };
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return { status: 404, body: { error: '目录不存在', path: rel } };
  }

  const entries = readEntries(abs);
  if (entries && entries.error) return { status: 500, body: { error: entries.error.message } };

  // 有没有启用的插件能读容器：决定"容器单文件"要不要列出来（没有插件就列了也没用）
  const containersAvailable = plugins.enabledPluginKinds().has('bundle');
  const relPosix = rel.split(path.sep).join('/').replace(/^\/+|\/+$/g, '');
  const collected = collectEntries(abs, relPosix, entries, probe, plugins, containersAvailable);

  const dirs = collected.dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const files = collected.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  // 容器单文件被插件可用性挡掉时把原因带回（可探测，不静默）
  if (collected.hidden) {
    return {
      status: 200,
      body: {
        root: rootId,
        path: rel,
        dirs,
        files,
        hiddenByPlugin: collected.hidden,
        note: `本根有 ${collected.hidden} 个容器单文件被隐藏：没有启用的插件声明 fileKind 'bundle'（见 config/plugins.json）`,
      },
    };
  }
  return { status: 200, body: { root: rootId, path: rel, dirs, files } };
}

/** 绑定型适配器 */
export function createTree(deps) {
  return { listTree: (rootId, rel) => listTree(deps, rootId, rel) };
}
