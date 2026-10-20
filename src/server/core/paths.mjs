// paths.mjs —— 项目内各配置/数据位置的集中推导（不写死绝对路径）
//
// 所有路径都从调用方传入的项目根推导：换目录部署、多实例共用一套代码时只换 root。
import path from 'node:path';

/** @param {{root: string}} options root = 项目根（含 config/、plugins/、tool/、data/） */
export function createPaths({ root }) {
  return {
    root,
    configDir: path.join(root, 'config'),
    configFile: path.join(root, 'config', 'resources.json'),
    pluginSwitchFile: path.join(root, 'config', 'plugins.json'),
    namesDir: path.join(root, 'config', 'names'),
    pluginsDir: path.join(root, 'plugins'),
    dotenvFile: path.join(root, '.env'),
    dataDir: path.join(root, 'data'),
    diagFile: path.join(root, 'data', 'diag.jsonl'),
    motionRulesFile: path.join(root, 'tool', 'spine-motion-rules.json'),
  };
}


