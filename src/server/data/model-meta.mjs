// model-meta.mjs —— Spine 模型元数据（/api/model-meta 的数据层）

const log = createLogger('model-meta');
//
// 产出字段与 Cubism 的 modelMeta 同名：kind / designSize / bbox / bones / slots / animations / skins / version
// 解析器按需 import（首次请求才加载几 MB 源码，不在启动时加载）；
// 动作分组规则来自 tool/spine-motion-rules.json，读一次缓存（改规则后重启生效）。
import fs from 'node:fs';
import { createLogger } from '../core/log.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本文件位于 <root>/src/server/） */
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 动作规则缓存：null = 尚未加载（改规则后重启生效） */
let motionRules = null;

/** 懒加载动作分组/循环规则；失败只告警（按"未知名"处理） */
async function loadMotionRules(rulesPath) {
  if (motionRules !== null) return motionRules;
  try {
    const { loadRules } = await import('../../tool/lib/spine-motions.mjs');
    motionRules = loadRules(rulesPath);
  } catch (e) {
    log.warn('动作规则加载失败，按"未知名"处理', { err: e.message });
    motionRules = null;
  }
  return motionRules;
}

/**
 * 定位骨架文件：path 允许给模型目录，此时按稳定顺序取第一个 .skel/.json。
 * @returns {{ok: true, resolvedFile: string, absFile: string} | {ok: false, status: number, body: object}}
 */
export function resolveSkeletonTarget(abs, rel) {
  let resolvedFile = null;
  const isDir = fs.statSync(abs).isDirectory();
  const baseDir = isDir ? abs : path.dirname(abs);
  if (isDir) {
    const cands = fs.readdirSync(abs)
      .filter((n) => /\.(skel|json)$/i.test(n) && !n.startsWith('.'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!cands.length) {
      return { ok: false, status: 404, body: { ok: false, error: '目录里没有 .skel/.json 骨架', path: rel, code: 'SPINE_ERR_NO_FILE' } };
    }
    resolvedFile = cands[0];
  } else {
    resolvedFile = path.basename(abs);
  }
  const absFile = path.join(baseDir, resolvedFile);
  if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
    return { ok: false, status: 404, body: { ok: false, error: '骨架文件不存在', path: rel, code: 'SPINE_ERR_NO_FILE' } };
  }
  return { ok: true, resolvedFile, absFile };
}

/** 读同名 .atlas 文本（读不到只影响 bbox，不影响计数） */
export function readAtlasText(absFile) {
  try {
    const atlasPath = path.join(path.dirname(absFile), `${path.basename(absFile, path.extname(absFile))}.atlas`);
    if (fs.existsSync(atlasPath) && fs.statSync(atlasPath).isFile()) return fs.readFileSync(atlasPath, 'utf8');
  } catch {
    /* 忽略 */
  }
  return null;
}

/**
 * @param {{config: object, probe: object, motionRulesFile?: string}} deps
 */
export function createModelMeta({ config, probe, motionRulesFile }) {
  const { readConfig } = config;
  const { resolveSafe } = probe;
  const rulesPath = motionRulesFile || path.join(MODULE_ROOT, 'tool', 'spine-motion-rules.json');

  /**
   * 读模型元数据。
   * @returns {Promise<{status: number, body: object}>}
   */
  async function readModelMeta(rootId, rel) {
    const cfg = readConfig().find((r) => r.id === rootId);
    if (!cfg) {
      return { status: 400, body: { ok: false, error: `未找到资源根: ${rootId}`, code: 'SPINE_ERR_BAD_ARGS' } };
    }
    const abs = resolveSafe(cfg.path, rel);
    if (!abs) return { status: 403, body: { ok: false, error: '路径越界', code: 'SPINE_ERR_BAD_ARGS' } };
    if (!fs.existsSync(abs)) {
      return { status: 404, body: { ok: false, error: '路径不存在', path: rel, code: 'SPINE_ERR_NO_FILE' } };
    }

    const target = resolveSkeletonTarget(abs, rel);
    if (!target.ok) return { status: target.status, body: target.body };
    const atlasText = readAtlasText(target.absFile);

    let readSpineMeta;
    try {
      ({ readSpineMeta } = await import('../../tool/lib/spine-meta.mjs'));
    } catch (e) {
      return { status: 500, body: { ok: false, error: `加载元数据模块失败: ${e.message}`, code: 'SPINE_ERR_NO_RUNTIME' } };
    }

    try {
      const bytes = new Uint8Array(fs.readFileSync(target.absFile));
      const rules = await loadMotionRules(rulesPath);
      const meta = readSpineMeta({ bytes, fileName: target.resolvedFile, atlasText, rules });
      return { status: 200, body: Object.assign({ ok: true, resolvedFile: target.resolvedFile }, meta) };
    } catch (e) {
      return { status: 200, body: { ok: false, resolvedFile: target.resolvedFile, error: e.message, code: e.code || 'SPINE_ERR_PARSE' } };
    }
  }

  return { readModelMeta };
}
