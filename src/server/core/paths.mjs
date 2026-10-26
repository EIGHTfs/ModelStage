// paths.mjs —— 项目内各配置/数据位置的集中推导（不写死绝对路径）
//
// 所有路径都从调用方传入的项目根推导：换目录部署、多实例共用一套代码时只换 root。
import path from 'node:path';

/**
 * @param {{root: string, avatarRoot?: string}} options
 *   root = 项目根（含 config/、plugins/、tool/、data/）
 *   avatarRoot = 头像根（可选）。**可配置**而不是写死 `<root>/avatars`：
 *     头像仓是独立私有仓，而项目根可能位于不允许 chmod 的挂载（CIFS/SMB）上，
 *     `git clone` 在那种地方写 `.git/config.lock` 会直接失败 ⇒ 头像仓必须能放到任意可写位置。
 *     优先级（--avatar-root > MODELSTAGE_AVATAR_ROOT > 默认）由调用方决定，本层只接收结果。
 */
export function createPaths({ root, avatarRoot }) {
  return {
    root,
    configDir: path.join(root, 'config'),
    configFile: path.join(root, 'config', 'resources.json'),
    pluginSwitchFile: path.join(root, 'config', 'plugins.json'),
    namesDir: path.join(root, 'config', 'names'),
    // 名表 v2：index 优先、v1 兜底（见 docs/设计/名表.md §九）
    indexDir: path.join(root, 'config', 'index'),
    avatarRoot: avatarRoot ? path.resolve(avatarRoot) : path.join(root, 'avatars'),
    pluginsDir: path.join(root, 'plugins'),
    dotenvFile: path.join(root, '.env'),
    dataDir: path.join(root, 'data'),
    diagFile: path.join(root, 'data', 'diag.jsonl'),
    motionRulesFile: path.join(root, 'tool', 'spine-motion-rules.json'),
  };
}


