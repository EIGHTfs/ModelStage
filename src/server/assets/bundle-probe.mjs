// bundle-probe.mjs —— UnityFS 资源包预检（/api/bundle/probe 的数据层）
//
// 只做容器级预检（不解码纹理像素），实现与插件共用 tool/lib/bundle-probe-node.mjs（同一份真相）。
// path 支持目录或文件：给目录时按稳定顺序挑资源包文件，并用 resolvedFile 回报实际用的那个。
import fs from 'node:fs';
import path from 'node:path';

/**
 * 定位要预检的资源包文件（目录时按稳定顺序挑一个；挑不出就要求给文件路径，不猜）。
 * @returns {{ok: true, resolvedFile: string, absFile: string} | {ok: false, status: number, body: object}}
 */
export function resolveProbeTarget(abs, rel) {
  let resolvedFile = path.basename(abs);
  let absFile = abs;
  if (fs.statSync(abs).isDirectory()) {
    const files = fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!files.length) {
      return { ok: false, status: 404, body: { ok: false, error: '目录里没有文件', path: rel, code: 'ULB_ERR_NO_FILE' } };
    }
    const pick = files.length === 1 ? files[0] : files.find((n) => /\.(unity3d|bundle|assetbundle|bytes|ab)$/i.test(n));
    if (!pick) {
      return {
        ok: false,
        status: 400,
        body: {
          ok: false,
          error: `目录里有 ${files.length} 个文件且无法判定哪个是资源包，请直接给文件路径`,
          path: rel,
          candidates: files.slice(0, 20),
          code: 'ULB_ERR_BAD_ARGS',
        },
      };
    }
    resolvedFile = pick;
    absFile = path.join(abs, pick);
  }
  if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
    return { ok: false, status: 404, body: { ok: false, error: '资源包文件不存在', path: rel, code: 'ULB_ERR_NO_FILE' } };
  }
  return { ok: true, resolvedFile, absFile };
}

/**
 * @param {{config: object, probe: object}} deps
 */
export function createBundleProbe({ config, probe }) {
  const { readConfig } = config;
  const { resolveSafe } = probe;

  /**
   * @returns {Promise<{status: number, body: object}>}
   */
  async function probeBundle(rootId, rel) {
    const t0 = Date.now();
    const cfg = readConfig().find((r) => r.id === rootId);
    if (!cfg) {
      return { status: 400, body: { ok: false, error: `未找到资源根: ${rootId}`, code: 'ULB_ERR_BAD_ARGS' } };
    }
    const abs = resolveSafe(cfg.path, rel);
    if (!abs) return { status: 403, body: { ok: false, error: '路径越界', code: 'ULB_ERR_BAD_ARGS' } };
    if (!fs.existsSync(abs)) {
      return { status: 404, body: { ok: false, error: '路径不存在', path: rel, code: 'ULB_ERR_NO_FILE' } };
    }

    const target = resolveProbeTarget(abs, rel);
    if (!target.ok) return { status: target.status, body: target.body };

    let probeBundleBytes;
    try {
      ({ probeBundleBytes } = await import('../../tool/lib/bundle-probe-node.mjs'));
    } catch (e) {
      return {
        status: 500,
        body: { ok: false, error: `加载预检模块失败: ${e.message}`, code: 'ULB_ERR_CONTAINER_PARSE', ms: Date.now() - t0 },
      };
    }

    let body;
    try {
      const bytes = new Uint8Array(fs.readFileSync(target.absFile));
      body = probeBundleBytes(bytes);
    } catch (e) {
      body = { ok: false, error: e.message, code: 'ULB_ERR_CONTAINER_PARSE' };
    }
    return { status: 200, body: Object.assign({ resolvedFile: target.resolvedFile }, body, { ms: Date.now() - t0 }) };
  }

  return { probeBundle };
}
