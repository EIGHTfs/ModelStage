// tree.mjs —— 目录树列举（/api/tree 的数据层）
//
// 响应对象结构与键序与旧实现保持一致（便于逐字节比对）。
//   · spine 根：按扩展名识别 Spine 三件套，附加 .skel 版本与 .atlas 的 assetKey；
//   · bundle 根：按容器魔数识别（无扩展名也能列），可见性由「是否有启用的 bundle 插件」决定。
import fs from 'node:fs';
import path from 'node:path';
import { SPINE_EXT } from '../assets/probe.mjs';

/** 读目录条目；失败返回 null（由调用方转 500） */
function readEntries(abs) {
  try {
    return fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    return { error: e };
  }
}

/** spine 根：识别三件套并探测版本/assetKey */
function collectSpineEntries(abs, relPosix, entries, probe) {
  const dirs = [];
  const files = [];
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
    files.push({
      name: e.name,
      type: 'file',
      ext,
      size: st.size,
      isSpine: SPINE_EXT.has(ext),
      // 只读前 64 字节探测版本：避免前端为探版本而下载整份大文件
      spineVersion: ext === '.skel' ? probe.detectSkelVersion(full) : null,
      // assetKey 取自 atlas 内容首行的贴图名（去扩展名 + 小写），用于跨根归并
      assetKey: ext === '.atlas' ? probe.detectAtlasKey(full) : null,
    });
  }
  return { dirs, files, hidden: 0 };
}

/** bundle 根：按容器魔数识别；无可用插件时整类隐藏并计数 */
function collectBundleEntries(abs, relPosix, entries, available, plugins) {
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
    if (!available) {
      hidden += 1;
      continue;
    }
    const container = plugins.detectBundleContainer(full);
    if (!container) continue;
    files.push({
      name: e.name,
      type: 'file',
      ext: path.extname(e.name).toLowerCase(),
      size: st.size,
      kind: 'bundle',
      container,
      rel: relPosix ? `${relPosix}/${e.name}` : e.name,
    });
  }
  return { dirs, files, hidden };
}

/**
 * 列某个资源根下的目录。
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

  const rootKind = cfg.kind || 'spine';
  // 资源包条目的可见性由「有没有启用的插件能读它」决定（插件被禁用则整体不显示）
  const available = rootKind === 'bundle' ? plugins.enabledPluginKinds().has('bundle') : true;
  // rel 用 POSIX 分隔（前端拼 /api/file?path= 时统一用 '/'）
  const relPosix = rel.split(path.sep).join('/').replace(/^\/+|\/+$/g, '');
  const collected = rootKind === 'bundle'
    ? collectBundleEntries(abs, relPosix, entries, available, plugins)
    : collectSpineEntries(abs, relPosix, entries, probe);

  const dirs = collected.dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const files = collected.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  // 条目被插件可用性挡掉时把原因带回（可探测，不静默）
  if (collected.hidden) {
    return {
      status: 200,
      body: {
        root: rootId,
        path: rel,
        kind: rootKind,
        dirs,
        files,
        hiddenByPlugin: collected.hidden,
        note: `本根有 ${collected.hidden} 个资源包条目被隐藏：没有启用的展示类型插件声明 fileKind 'bundle'（见 config/plugins.json）`,
      },
    };
  }
  return { status: 200, body: { root: rootId, path: rel, kind: rootKind, dirs, files } };
}

/** 绑定型适配器 */
export function createTree(deps) {
  return { listTree: (rootId, rel) => listTree(deps, rootId, rel) };
}
