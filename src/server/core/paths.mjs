// paths.mjs —— 项目内各配置/数据位置的集中推导（不写死绝对路径）
//
// 所有路径都从调用方传入的项目根推导：换目录部署、多实例共用一套代码时只换 root。
import path from 'node:path';

/**
 * @param {{root: string, dataRoot?: string, avatarRoot?: string}} options
 *   root = 项目根（代码：plugins/ tool/ src/）
 *   dataRoot = 数据根（可选）。决定 config/ data/ runtime/ 三处落在哪；
 *     缺省 = root ⇒ **默认行为与历史完全一致**。
 *     为什么必须同时挪这三处：测试实例会写 config（增删资源根）与 data（解包缓存、日志），
 *     只挪 data/ 会让两个实例同时改同一份 config/resources.json，互相覆盖。
 *     plugins/ 等代码目录**始终跟随 root**：换数据根不能换掉代码，否则测试跑的不是同一份实现。
 *   avatarRoot = 头像根（可选）。**可配置**而不是写死 `<root>/avatars`：
 *     头像仓是独立私有仓，而项目根可能位于不允许 chmod 的挂载（CIFS/SMB）上，
 *     `git clone` 在那种地方写 `.git/config.lock` 会直接失败 ⇒ 头像仓必须能放到任意可写位置。
 *     优先级（--avatar-root > MODELSTAGE_AVATAR_ROOT > 默认）由调用方决定，本层只接收结果。
 */
export function createPaths({ root, dataRoot, avatarRoot }) {
  // 数据根：缺省就是项目根（历史行为）；只有显式给了才分离，避免"忘了传"变成静默用错位置
  const data = dataRoot ? path.resolve(dataRoot) : root;
  return {
    root,
    /** 数据根（config/ data/ runtime/ 都在这下面）；与 root 相同时表示单实例常规布局 */
    dataRoot: data,
    configDir: path.join(data, 'config'),
    configFile: path.join(data, 'config', 'resources.json'),
    pluginSwitchFile: path.join(data, 'config', 'plugins.json'),
    namesDir: path.join(data, 'config', 'names'),
    // 名表 v2：index 优先、v1 兜底（见 docs/设计/名表.md §九）
    indexDir: path.join(data, 'config', 'index'),
    avatarRoot: avatarRoot ? path.resolve(avatarRoot) : path.join(data, 'avatars'),
    // 代码目录始终跟随 root：换数据根不该换掉实现
    pluginsDir: path.join(root, 'plugins'),
    dotenvFile: path.join(data, '.env'),
    dataDir: path.join(data, 'data'),
    diagFile: path.join(data, 'data', 'diag.jsonl'),
    /** 运行期杂项（PID/日志/测试结果/测试锁）：跟着数据根走，两个实例才不会互相抢锁 */
    runtimeDir: path.join(data, 'runtime'),
    motionRulesFile: path.join(root, 'tool', 'spine-motion-rules.json'),
  };
}


