// index.mjs —— 共用服务端数据层的装配入口
//
// 用法（8803 / 8804 / 测试脚本一致）：
//   import { createServerData } from './src/server/index.mjs';
//   const data = createServerData({ root: <项目根绝对路径> });
//   data.config.readConfig() / data.tree.listTree(id, rel) / ...
//
// 设计约束：
//   · 不读 process.argv / 不读端口 / 不依赖 http —— 端口与响应由调用方决定；
//   · 项目根由调用方注入，模块内不写死绝对路径；
//   · 只读接口返回 { status, body }，写接口（roots/import/diag）暂不在此层（保持单写者）。
import { createPaths } from './core/paths.mjs';
import { createEnv } from './core/env.mjs';
import { createConfig } from './core/config.mjs';
import { createPlugins } from './plugins.mjs';
import { createModels } from './models.mjs';
import { createLive2d } from './live2d.mjs';
import { createNames } from './names.mjs';
import { createTree } from './tree.mjs';
import { createModelMeta } from './model-meta.mjs';
import { createBundleProbe } from './bundle-probe.mjs';
import { createCatalog } from './catalog.mjs';
import * as probe from './probe.mjs';

/**
 * 装配数据层。
 * @param {{root: string}} options root = 项目根（含 config/、plugins/、tool/、data/）
 */
export function createServerData({ root }) {
  if (!root) throw new Error('createServerData: 需要 root');
  const paths = createPaths({ root });
  const env = createEnv(paths);
  const config = createConfig(paths);
  const plugins = createPlugins(paths);
  const names = createNames(paths);
  // 探测/名表函数显式注入给扫描层：避免各模块反向依赖彼此
  const modelDeps = {
    getNameTable: names.getNameTable,
    detectSkelVersion: probe.detectSkelVersion,
    detectJsonVersion: probe.detectJsonVersion,
    detectAtlasKey: probe.detectAtlasKey,
    detectAtlasPma: probe.detectAtlasPma,
  };
  const models = createModels(paths, modelDeps);
  const live2d = createLive2d(paths);
  const tree = createTree({ config, plugins, probe });
  const modelMeta = createModelMeta({ config, probe, motionRulesFile: paths.motionRulesFile });
  const bundleProbe = createBundleProbe({ config, probe });
  const catalog = createCatalog({ config, models, live2d, tree, plugins });
  return { paths, env, config, plugins, probe, models, live2d, names, tree, modelMeta, bundleProbe, catalog };
}
