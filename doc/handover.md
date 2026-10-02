# 项目交接文档

> 本文档面向接手本项目（人类或 AI）的读者，目标是**不依赖会话历史**即可理解并继续开发。
> 项目目录即 git 仓库根。文档随代码演进，改动后与代码同批提交。

## 1. 项目概述

**spine-multi-viewer**：多游戏通用的 Spine / Live2D 立绘查看器。

- 基于 **原版**（Spine 浏览器查看器）改造，Live2D 查看能力由本项目自建覆盖层接入。
- 一个页面管理**多个游戏、多类资源根**：左侧角色树（游戏 → 角色 → 皮肤/资源），中间舞台渲染 Spine 或 Live2D 模型，右栏参数控制。
- 角色按**名字表聚合**：同一角色的 Spine 立绘与 Live2D 模型归到同一节点，支持中文译名与头像。
- 浏览器 localStorage 记录**每个游戏各自的上次浏览**（切游戏不互相覆盖）。
- 服务监听 8803 端口（经 `server.sh` 启停），局域网访问地址以 `hostname -I` 实测为准（当前宿主 `10.10.10.193`，即 http://10.10.10.193:8803/ ）。

### 快速上手

```bash
cd spine-multi-viewer
bash server.sh status      # 看服务在不在
bash server.sh restart     # 重启（改 server.mjs / config/resources.json 后必须重启）
bash server.sh stop        # 停
```

- 前端纯静态 + 服务端动态扫描，**无 npm 依赖、无 package.json、无构建产物提交**（`dist/`、`baseline/` 是参考快照，不参与运行）。
- 改 `public/*.js`、`config/resources.json`、`tool/*.mjs` 前先看第 4、5、6 节，坑都写在里面了。

## 2. 目录地图

```
spine-multi-viewer/
├── server.mjs                 # 单文件服务端：静态托管 + 资源扫描 + 路由（1400+ 行，未拆分，见第 7 节）
├── server.sh                  # 启停脚本（start|stop|restart|status，PID 在 spine-multi-viewer.pid）
├── README.md                  # 面向使用者的功能文档（踩坑记录、资源形态对照、运行时优选都在这里）
├── doc/handover.md            # 本文档
├── public/                    # 前端（全部为服务端 index 页内联加载的裸 JS，无构建）
│   ├── char-tree.js           # 左侧角色树：游戏/角色/皮肤三级聚合、展开态、上次浏览、Live2D 早期恢复
│   ├── live2d-stage.js        # Live2D 渲染覆盖层：运行时探测、show() 序号守卫、几何避侧栏
│   ├── local-roots.js         # 根选择、默认模型预选、Spine/Live2D 切换互斥
│   ├── roots-ui.js            # 「选择资源根」UI（增删根、启用/停用）
│   └── settings-io.js         # localStorage 持久化（每游戏 lastByGame + activeGame + 展开态）
├── tool/                      # Node 维护工具（直接 node 运行，无构建）
│   ├── name-table-spec.mjs    # 名表统一规范 v1：buildNameTable / readKeepZh（中文名防冲掉）
│   ├── import-name-table.mjs  # 棕色尘埃2 名表生成（bd2.json）
│   ├── import-name-table-dcg.mjs      # 天命之子名表生成（dcg.json，源 childs.json）
│   ├── import-name-table-azurlane.mjs # 碧蓝航线名表生成（azurlane.json，源见 data/upstream/）
│   ├── resolve-runtimes.mjs   # Spine 运行时解析（按根找 spine-core/runtime 组合）
│   ├── resolve-live2d-runtimes.mjs    # Live2D 运行时解析（Cubism Core + PIXI 组合，PIXI6 优先）
│   ├── parse-jsonc.mjs        # 剥 // 注释的 jsonc 解析器（resources.json 是 jsonc）
│   ├── build.mjs / split-app.mjs / verify.mjs / compare-with-原版.mjs
├── config/
│   ├── resources.json         # 资源根配置（jsonc，含注释；5 个根，见第 3 节）
│   ├── names/                 # 名表（统一规范 v1）：bd2.json / dcg.json / azurlane.json
│   ├── models.<rootId>.json   # 服务端扫描后落盘的 Spine 索引（可重建，.gitignore 忽略）
│   └── live2d.<rootId>.json   # 同上，Live2D 索引（gitignore 忽略）
├── data/upstream/             # 上游数据留档（17MB，名表转换器的离线输入）
│   ├── README.md              # 来源与用途说明
│   ├── azurlane/              # AzurLaneTools/AzurLaneData 的 6 个 CN 配置 JSON
│   └── destinychild/          # Live2D-DCG 的 childs.json
├── baseline/index.html        # 早期参考快照（不运行）
├── dist/index.html            # 同上
├── src/app-shell.html         # 同上（参考用）
└── .trash/                    # 项目内删除回收站（约定：删除一律移这里，不 rm）
```

## 3. 资源根（5 个）

`config/resources.json` 是 **jsonc**（带 `//` 注释行），直接 `JSON.parse` 会失败，用 `tool/parse-jsonc.mjs` 或先剥注释。

| id | 游戏 | 类型 | 数量 | 名表 | 头像目录 |
|---|---|---|---|---|---|
| `bd2` | 棕色尘埃2 | Spine 4.x | 425 模型 | `bd2` | 根内 `assets/char_icons` |
| `spine_mod` | 棕色尘埃2 | Spine（Mod 包） | 56 | `bd2`（共用） | 根内 `assets/char_icons` |
| `live2d` | 天命之子 | Live2D **Cubism 2** | 2185 | `dcg` | 模型目录自带 `icon.png`（名表 icon 留空） |
| `azurlane` | 碧蓝航线 | Live2D **Cubism 4** | 178 | `azurlane` | 外置 `shipmodels/`（与 painting 同名 png） |
| `azurlane_spine` | 碧蓝航线 | Spine 3.8 立绘 | 202 模型 / 141 目录 | `azurlane`（与上一行共用） | 同 `azurlane` 的 `shipmodels/` |

- 两根同属「碧蓝航线」→ 共用同一份名表，**同一角色自动跨格式聚合**（Live2D 与 Spine 归到同一节点）。
- 资源根 path 是**本机绝对路径**，迁移机器后要改。碧蓝两根分处两个挂载点（`/volume1/@appdata/…` 与 `/volume1/VirtualDSM/…`），改路径时两边都要核。
- 路径含 CIFS/NFS 时注意：扫描慢、`file://` 直读可能偶发 ENOTDIR，服务端扫描已做容错。

## 4. 名表系统（统一规范 v1）

规范与构造器：`tool/name-table-spec.mjs`。

- 输出结构：`{_meta, characters: { <资源名>: {name, nameZh, costume, npc, assets[], icon} }, byAsset: { <资源名小写>: <资源名> }}`。
- `name`=角色名（英文或中文，取决于游戏），`nameZh`=中文译名（可为空），`costume`=皮肤/服装名（可与角色名相同则留空），`icon`=头像文件名（相对 `icons.dir`，可为空）。
- `readKeepZh(outFile)`：**重跑转换器时保留已有表里人工补的 nameZh**，不冲掉。
- 前端 `char-tree.js` 用 `byAsset` 反查：资源名 → 角色条目 → 聚合进「游戏 → 角色 → 皮肤」三级树。

### 三份名表再生成命令

```bash
# 棕色尘埃2（bd2.json）
node tool/import-name-table.mjs <棕尘资源内自带名源> config/names/bd2.json --game=棕色尘埃2
# 天命之子（dcg.json）：源 data/upstream/destinychild/childs.json
node tool/import-name-table-dcg.mjs data/upstream/destinychild/childs.json config/names/dcg.json --game=天命之子
# 碧蓝航线（azurlane.json）：源 data/upstream/azurlane/ 两个 JSON
node tool/import-name-table-azurlane.mjs \
  data/upstream/azurlane/ship_skin_template.json \
  data/upstream/azurlane/name_code.json \
  config/names/azurlane.json --game=碧蓝航线 \
  --icons-dir=<本机>/spine-viewers/AzurLane-Live2D-Viewer/shipmodels
```

碧蓝航线名表逻辑（`import-name-table-azurlane.mjs`，务必先读）：

- `ship_skin_template.json`：键=皮肤 id，`painting`=资源目录名（与 Live2D `live2d/<painting>/`、Spine `docs/<base>/<painting>/` 一致），`skin_type===-1` 是**基础皮肤**（其 `name`=角色名），其余 `name`=皮肤名；`ship_group` 是角色归组号。
- `name_code.json`：上游 `name` 字段可能是占位符 `{namecode:NN}`（如 67→爱宕），转换器内置 `resolveName()` 解析。
- 聚合键 = `ship_group`，角色名 = 该组基础皮肤名；Live2D 与 Spine 因资源名都等于 `painting`，自动归到同一角色。
- 实测：`aerbien_3`→阿尔比恩/香气来朱阁、`aerbien_4`→阿尔比恩/晨光里的事故，跨格式聚合正确。
- 覆盖率：名表 2558 条；碧蓝 Live2D 171/178 命中，Spine 132/141 命中。未命中目录（如 `aimierbeierding_2`、`z46_2`、`i404_3`、`dahuangfengii_2`、`suweiaitongmengnew` 等，约 7+9 个）多为 `_ii`/`_new`/罗马数字后缀变体，上游 painting 表没这些键 → 界面回退显示拼音目录名，**功能不受影响**。

> ⚠️ **规划中**：角色名映射与角色头像映射**后续会重新设计**（现方案是「每游戏一份 JSON + 手工关联 icons.dir」，属过渡形态，已知不足：中文名依赖上游、头像来源分散、新游戏要手工配）。重设计时以 `data/upstream/README.md` 的「待重设计」节与 `config/names/` 现状为起点。

## 5. Live2D 双代支持（Cubism 2 与 Cubism 4）

扫描器（`server.mjs` 的 `buildLive2DModel` / `scanLive2DRootServer`）同时支持两代，改这里务必两代都测：

- **Cubism 2**（天命之子）：目录内 `model.json`，字段**小写**（`moc`、`textures`、`expressions`、`motions`），资源名多为裸文件名，头像 `icon.png` 在目录内。
- **Cubism 4**（碧蓝航线）：`*.model3.json`，字段**大写**且常收在 `FileReferences` 下（`Moc`、`Textures`、`Expressions`、`Motions`），路径常带**子目录**（`textures/…`、`motions/…`）。
- 扫描器统一取法：`fr = cubism===4 && def.FileReferences ? def.FileReferences : def`；每个资源名先按「相对资源根+相对目录」拼绝对路径，**用 `fs` 判断磁盘存在**再入表（子目录引用必须这样，不能信 def 里的逻辑名）。
- 表情/动作字段两代兼容：`e.File || e.file`、`e.Name || e.name`、`FadeIn ?? fade_in` 等。
- 选 def 文件：`scanLive2DRootServer` 优先 `*.model3.json`，没有再 `model.json`。

### 运行时探测（live2d-stage.js + resolve-live2d-runtimes.mjs）

- 页面加载多套 Live2D 运行时（Cubism Core + PIXI + Live2DFramework），按 Cubism 版本选。
- **关键坑**：spive2d 自带的 **PIXI 8.19 组合加载 Cubism 4 模型会挂起**（moc3 能解析但贴图永远不请求、`Live2DModel.from()` 不 resolve）；AzurLane 自带的 **PIXI 6.5.3 组合同时支持 Cubism 2 与 4**。
- 探测顺序已改为：**PIXI major=6 的组合优先**（`pixiMajor()` 从 `pixi.min.js` 读版本号），其后才是 Cubism 版本匹配、路径长度等。
- 若换 Core 后报 "Failed to start up Cubism framework"，就是 Core 与 mocs 版本不配对，回到「按 cubism 字段选同代 Core」。

## 6. 覆盖层与舞台几何（live2d-stage.js）

- Live2D 用**覆盖层**盖在 原版 舞台区，不是替换 DOM。
- **几何避侧栏**：覆盖层 z-index 盖不过侧栏（侧栏父级有自己的 stacking context），所以覆盖层被**几何裁剪**到「左侧面板右缘 ↔ 右侧栏左缘」之间的舞台区，用 MutationObserver 跟两侧栏宽同步。
- **`showSeq` 序号守卫**：每次 `show(m)` 取一个递增序号，`Live2DModel.from()` resolve 后若序号已被后来的调用超过，就 destroy 结果并丢弃——防止**刷新时同一模型被 show() 两次、孤儿模型留在背景**（历史 bug `8e0a849` 修的）。
- **早期恢复**：`char-tree.js` 在首帧前就恢复上次浏览的 Live2D 模型（`earlyRestoredId`），常规恢复路径跳过它；早期恢复失败则重置标志并 `stage.hide()`。

## 7. 已知技术债

1. **`server.mjs` 1418 行**未拆分（扫描/路由/静态/名表全在一个文件）。改服务端时先用函数索引定位，别盲改；要拆时按 `tool/split-app.mjs` 的思路做，拆完必须过 `tool/verify.mjs`。
2. 双指 pinch 缩放**未实现**（Live2D 覆盖层只做了滚轮/单点拖拽，触摸双指缩放留 TODO）。
3. 右栏动作控制区与 原版 自带的控件**重复**（留待重构）。
4. 碧蓝 9+7 个未命名字目录（见第 4 节覆盖率），暂不影响功能。

## 8. 验证方式

- **服务起来了吗**：`bash server.sh status` + `curl -s http://127.0.0.1:8803/` 返回 index html。
- **名表对不对**：`curl -s 'http://127.0.0.1:8803/api/names?root=azurlane'` 看返回的 characters 是否带中文名。
- **前端渲染**：用无头 chromium 打开 `http://<本机IP>:8803/?selftest=live2dstage&root=azurlane` 走 Live2D 自检；Spine 用对应 selftest 参数（以 `server.mjs` 实际支持为准）。
- **聚合对不对**：切到碧蓝航线，看左侧树里「阿尔比恩」节点下是否**同时**挂着 Live2D 与 Spine 两条资源（跨格式聚合成功）。

## 9. Git 与提交纪律

- 本仓库首次交接时**无 remote**（本提交起有：GitHub 私有库）。凭据（GitHub token / SSH 公钥）由宿主 DSH 的 dsh-git-push 插件托管，**不要**把 token 写进任何文件或命令；需要判断登录态/推送用插件工具（`git_account_check` / `git_commit_push` / `git_remote_create`），不要手敲 `git push` 绕门禁。
- 提交信息用中文、写清「做了什么」（feat:/fix:/docs:/chore: 前缀 + 具体说明），需求原话只进 commit message，**不进代码注释**（审计会拦对话残留措辞）。
- 删除文件/目录一律移 `.trash/`，不 `rm -rf`。
- 文档（README/本文件）只写「做了什么」，不写会话引用、AI 许可、商量转述等沟通措辞。

## 10. 近期提交脉络（交接点之前）

```
8e0a849 fix: 刷新时同一 Live2D 模型被 show() 两次，孤儿留在背景   ← 交接前最新
bea6ed3 feat: 接入碧蓝航线 Spine 立绘（202 模型）
d1adeb7 feat: 接入碧蓝航线 Live2D（Cubism 4）+ 扫描器两代 + 运行时优选
0239e35 feat: 每游戏各记「上次」默认（lastByGame + activeGame）
f4f8dde fix: Live2D 覆盖层挡右栏 → 几何裁剪到舞台区
f37a64c feat: 中文名与英文同级同文件 + 刷新上次优先
8e1419d feat: Live2D 右栏控制区块 + 中文译名叠加层
```

接手后第一个自然任务：第 7 节的 pinch 缩放与右栏控件去重（已挂起，非紧急）；以及第 4 节标注的「角色名/头像映射重新设计」。
