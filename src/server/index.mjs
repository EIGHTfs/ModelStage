// index.mjs —— 共用服务端数据层的装配入口
//
// 用法（服务进程与测试脚本一致）：
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
import { createPlugins } from './plugins/registry.mjs';
import { createSpineModels } from './data/spine.mjs';
import { createLive2d } from './data/live2d.mjs';
import { createNames } from './data/names.mjs';
import { createTree } from './data/tree.mjs';
import { createModelMeta } from './data/model-meta.mjs';
import { getSharedEntryStates } from './data/entry-states.mjs';
import { createShapeProbe } from './data/shape-probe.mjs';
import { createBundleProbe } from './assets/bundle-probe.mjs';
import { createCatalog } from './data/catalog.mjs';
import * as probe from './assets/probe.mjs';

/**
 * 装配数据层。
 * @param {{root: string, avatarRoot?: string}} options
 *   root = 项目根（含 config/、plugins/、tool/、data/）
 *   avatarRoot = 头像根（可选，缺省 <root>/avatars）。由调用方解析 CLI/env 后传入 ——
 *     本层保持"不读 process.argv"的约束（见文件头设计约束）。
 */
export function createServerData({ root, dataRoot, avatarRoot, log }) {
  if (!root) throw new Error('createServerData: 需要 root');
  // dataRoot 缺省 = root（历史行为）；测试实例传自己的数据根，代码目录仍跟随 root
  const paths = createPaths({ root, dataRoot, avatarRoot });
  const env = createEnv(paths);
  const config = createConfig(paths);
  const plugins = createPlugins(paths);
  const names = createNames(paths);
  // 探测/名表函数显式注入给扫描层：避免各模块反向依赖彼此
  const modelDeps = {
    getNameTable: names.getNameTable,
    // 头像根：扫描层要拿它拼头像 URL（buildModelServer 是模块级函数，拿不到 paths 闭包）
    avatarRoot: paths.avatarRoot,
    detectSkelVersion: probe.detectSkelVersion,
    detectJsonVersion: probe.detectJsonVersion,
    detectAtlasKey: probe.detectAtlasKey,
    detectAtlasPma: probe.detectAtlasPma,
  };
  const spine = createSpineModels(paths, modelDeps);
  const live2d = createLive2d(paths);
  const tree = createTree({ config, plugins, probe });
  const modelMeta = createModelMeta({ config, probe, motionRulesFile: paths.motionRulesFile });
  const bundleProbe = createBundleProbe({ config, probe });
  // 条目状态存储：**进程内共享单例**（catalog 读、/api/entries/result 写必须是同一份实例，
  //   否则"写完读不到"是必然的）。路径按 MODELSTAGE_DATA_ROOT 定位 ⇒ 测试实例自带一份。
  // 日志形态归一：本项目 logger 是**对象**（log.info(msg, detail)），而部分数据层模块
  //   历史上按函数式写（log('info', msg, detail)）。两边都收在这里适配一次，
  //   否则传进去的 logger 会被 `typeof === 'function'` 判成"没给"，日志静默消失（实测踩过）。
  const logFn = (level, msg, detail) => {
    if (typeof log === 'function') { try { log(level, msg, detail); } catch { /* 日志失败不影响数据层 */ } return; }
    const fn = log && typeof log === 'object' ? (log[level] || log.info) : null;
    if (typeof fn === 'function') { try { fn.call(log, msg, detail); } catch { /* 同上 */ } }
  };
  const entryStates = getSharedEntryStates({ root, log: logFn });
  const catalog = createCatalog({ config, spine, live2d, tree, plugins, entryStates });
  // 后台形态探测（契约 §八）：**事件驱动**，由 catalog 在"这一根清单重建完"时喊一声。
  //   · 没有待探测项时内部立刻返回（指纹没变 ⇒ 零读包、零计数，S10）
  //   · 单轮串行 + 包间限速 + 跑完即停，不留常驻定时器（INV-D7）
  //   · 只在装配层把两边接起来（依赖方向单向：catalog 不认识探测器）
  const shapeProbe = createShapeProbe({
    catalog,
    entryStates,
    providers: () => plugins.readPlugins(),
    readConfig: () => config.readConfig(),
    log: logFn,
  });
  catalog.setProbeNotifier((rootId) => { shapeProbe.kick(rootId); });
  return {
    paths, env, config, plugins, probe, spine, live2d, names, tree, modelMeta, bundleProbe,
    catalog, entryStates, shapeProbe,
  };
}
