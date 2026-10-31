# ModelStage

**多游戏通用的 Spine / Live2D 动画预览器。** 把不同游戏导出的骨骼动画与 Live2D 模型放在同一个界面里浏览：
左栏按「游戏 → 角色 → 变体」组织，右侧面板调渲染参数，底栏控制播放。

![ModelStage 界面](https://raw.githubusercontent.com/EIGHTfs/ModelStage/main/docs/assets/ui-main.png)

支持两类内容、两种资源形态：

| 维度 | 支持 |
|---|---|
| 内容类型 | **Spine**（3.6 / 3.7 / 3.8 / 4.1 运行时）· **Live2D**（Cubism 2 / 4） |
| 资源形态 | **目录型**（散装 skel/atlas/贴图 或 model3.json）· **容器型**（Unity 资源包，由插件解包） |

---

## 主要能力

| 能力 | 说明 |
|---|---|
| 三级名册 | 游戏 → 角色 → 变体；支持搜索、懒加载、展开态与上次选择记忆 |
| 两套渲染面 | Spine 与 Live2D 共用同一套相机语义与面板；切换只有唯一入口，不会叠加 |
| 面板按能力生成 | 面板只问「当前渲染器支持什么」，不支持的项**不构建**（而非灰化占位） |
| 动作与循环 | 动作列表带时长、当前项高亮；「混合模式」与「循环播放」两个开关正交 |
| 资源包解包 | UnityFS 单文件容器（Spine / Live2D 两种）由插件解包：服务端命中缓存直接取产物，未命中则由**浏览器本地解包**（不受服务端内存预算限制）；产物带指纹缓存，插件或版本一变即失效 |
| 插件运行时 | **node（vm 沙盒）与 exec（子进程）两种**：`exec` 支持非 JS 插件（如 Python），按行 JSON 帧协议通信、双向超时必杀、崩溃时在途请求全部判失败；门禁默认关闭（`config/plugin-runtime.json`）。首个 exec 插件 `unitypy-bundle` 用 UnityPy 解容器包，可覆盖 JS 插件暂不支持的纹理格式（如 ASTC） |
| 资源包自动判型 | 容器先解包、再按**产物**确定内容类型（`entry.json` 含 `skeletonFile` ⇒ Spine；含 `*.model3.json` ⇒ Live2D），不按扩展名猜 |
| 背景 | 棋盘格 / 纯色 / 透明 / 自定义图；纯色预设可增删改名（服务端存储） |
| 调试与诊断 | 浮层日志（四档多选）、就绪信号（给机器读的阶段状态机）、诊断探针落盘 |
| 依赖形态 | **主项目不把零依赖当硬约束**：现状仍是"无 `node_modules`、无锁文件，全部用 Node 内置能力"，但不以此为红线 —— 为功能需要可引入必要依赖；`package.json` 目前只提供 `bin` / `engines` 等元数据。**插件另算**：按独立项目对待，可有自己的 `package.json` 与依赖，唯一硬要求是依赖必须以「vm 沙盒能加载的形态」落地（IIFE / UMD 或构建产物），不能靠运行时 `import` |

### 资源包（UnityFS 容器）直接打开

游戏客户端的**单个加密/打包文件**不用手工解包也能看：登记资源根后，容器条目会被识别成
「资源包」，点开时由插件解出骨架 + 图集 + 贴图，再交给渲染层。

能力细节与当前限制见 **[docs/架构/能力层.md](https://github.com/EIGHTfs/ModelStage/blob/main/docs/架构/能力层.md)**。

---

## 快速开始

### 方式一：本地启停脚本（推荐日常使用）

```bash
bash web.sh start      # 启动（默认端口 8804）
bash web.sh status     # 查看状态
bash web.sh restart    # 重启
bash web.sh stop       # 停止
```

启动后打开 `http://<本机IP>:8804/`。

### 方式二：npx（不 clone 也能跑）

```bash
npx . --port 8804 --data-root ~/modelstage-data          # 在项目根直接跑
npx github:EIGHTfs/ModelStage --port 8804 --data-root ~/modelstage-data   # 从 GitHub 直跑，不用 clone
npx modelstage --port 8804 --data-root ~/modelstage-data # 发布到 registry 后可用（**当前未发布**）
```

参数与环境变量等价，两条路都通：

| 参数 | 环境变量 | 作用 |
|---|---|---|
| `--port <n>` | `PORT` | 监听端口（默认 8804） |
| `--data-root <path>` | `MODELSTAGE_DATA_ROOT` | 数据根：日志、解包缓存、配置的持久化位置；缺省 = 项目根 |
| `-h` / `--help`、`-v` / `--version` | — | 用法与版本号 |

### 调参（内存准入 / 后台探测，全部可 env 覆盖）

这些系数决定"要不要解包""要不要后台探测"。**非法值（NaN / 越界）一律回落缺省并打一条 warn**，
不会静默用错值；进程内改 env 立即生效，进程外改 env 需重启（`process.env` 是启动快照）。

| 环境变量 | 缺省 | 作用 |
|---|---|---|
| `MODELSTAGE_ADMIT_HEAP_RATIO` | `0.85` | 前端 JS 堆占用上限比例（超过就拒绝装载）。前端读不到 env，由服务端经 `GET /api/web-config` 的 `admitHeapRatio` 下发 |
| `MODELSTAGE_ADMIT_CAPACITY_RATIO` | `0.5` | 服务端解包容量系数：预算 = 可用内存 × 该比例（给系统与渲染留余量） |
| `MODELSTAGE_PROBE_MEM_BASELINE_MB` | `256` | 后台形态探测前要留的可用内存余量（MB） |
| `MODELSTAGE_PROBE_MEM_FACTOR` | `3` | 探测时"包体积 → 预估占用"的倍数（解包产物通常比包大，不要按 1 估） |
| `MODELSTAGE_PROBE_MAX_BYTES` | `25165824`（24MB） | 超过该体积的包不做后台探测（保持 unknown，留待点击验证） |
| `MODELSTAGE_PROBE_IDLE_GAP_MS` | `2000` | 探测批次开始前要求的静默时长（有请求在飞时探测主动让路） |
| `MODELSTAGE_PROBE_MAX_WAIT_MS` | `20000` | 一批最多等空闲多久；超时把剩余条目放回队列 |
| `MODELSTAGE_PROBE_WORKER` | `1` | `0` = 关掉探测的解析线程，回落主线程同步解析（受限环境用） |
| `MODELSTAGE_CGROUP_MEMORY_MAX_PATH` | `/sys/fs/cgroup/memory.max` | cgroup v2 限额文件路径（同时读同目录 `memory.current`）。用于非标准挂载或测试注入；读不到或为 `max` ⇒ 回落 `/proc/meminfo` |

`--data-root` 必须指向一个**可写且持久**的目录：npx 运行时"项目根"是 npm 的临时缓存目录（会被清理），
把日志与解包缓存写在里面会丢。数据根下的 `runtime/`、`config/` 由服务自行创建与维护。

> **首次运行**：数据根里还没有 `config/resources.json`（它是本地配置，不进包），
> 服务会打一条 ERROR 并已空资源根启动 —— 页面能开，但名册是空的。
> 照 `config/resources.example.json` 复制一份、把 `path` 指向你的模型目录即可（也可以在页面里
> 「浏览服务端目录，登记为资源根」直接点选）。

**前置**：Node.js ≥ 20（代码用到 `AbortSignal.timeout`、顶层 `await`、原生 ESM —— Node 17.3+ 才有前者）。

运行时源码**不入库、也不在 npm 包内**（授权与体积原因），需自备 —— 缺失时会显式报错并给出修复指引：

| 运行时 | 放哪里 | 说明 |
|---|---|---|
| Spine | `src/spine-runtimes/` | 或用 `SPINE_RUNTIME_DIR`，或工作区共享目录 `../spine-runtimes/` |
| Live2D | `src/live2d-runtimes/<版本>/` | 与 `src/spine-runtimes/` 并列；**多版本共存**（如 `v6-6.5.3`、`v8-8.19.0`），由 pixi 主版本优选；或用 `LIVE2D_SEARCH_ROOTS` 指定搜索根 |

> **用 npx 直跑时**：包里没有运行时目录，必须自行准备，并用 `SPINE_RUNTIME_DIR` /
> `LIVE2D_SEARCH_ROOTS` 指到你放运行时的位置（多个搜索根用路径分隔符隔开）。
> 否则页面能起来，但装载模型时会明确报"找不到运行时"。
>
> **已知限制（npx）**：`npx` 在安装阶段会对 bin 做 `chmod`，而 **CIFS/SMB 挂载目录不支持 chmod**
> （报 `EPERM`）。所以把项目放在网络挂载盘上时 `npx .` 会失败 —— 这与包内容无关，
> 换到本地磁盘即可；在挂载盘上仍可直接 `node bin/modelstage.mjs`（跳过 npm 安装环节）。

Live2D 的版本差异（`Cubism4ModelSettings` ↔ `CubismModelSettings` 之类的命名变化、PIXI 6/8 的构造差异）
统一收在 `src/web/live2d/runtime-adapter.js` 一处，业务代码不直接触碰 PIXI/Live2D 的 API 形状 ——
新增一个版本只需拷一个子目录 + 在兼容表里加一行。详见 **[docs/设计/Live2D运行时统一入口.md](https://github.com/EIGHTfs/ModelStage/blob/main/docs/设计/Live2D运行时统一入口.md)**。

---

## 配置资源根

资源根指「本机某个游戏资源目录」。在 `config/resources.json` 里登记，界面即可看到。
每个根可配 `profile`（游戏差异适配，如动作分组与循环规则）。

新增资源根的完整步骤见 **[docs/参考/接口清单.md](https://github.com/EIGHTfs/ModelStage/blob/main/docs/参考/接口清单.md)** §三。

**仓库内不含任何游戏提取资源** —— 模型文件均不入库，需自备。

---

## 目录结构

```
src/
  web/        前端：main.js + app / engine / render / spine / live2d / roster / panel / debug / infra
  server/     服务端：serve.mjs + routes / http / data / unpack
plugins/      插件（容器解析）：unity-live2d-bundle
tool/         工具与门禁脚本（含回归入口 test-all.mjs）
test/         回归套件
config/       资源根与插件配置
data/         运行时数据（不入库）
docs/         文档
web.sh        启停脚本
```

模块划分与职责边界见 **[docs/架构/总览.md](https://github.com/EIGHTfs/ModelStage/blob/main/docs/架构/总览.md)**。

---

## 文档

完整索引：**[docs/README.md](https://github.com/EIGHTfs/ModelStage/blob/main/docs/README.md)**

| 想了解 | 看这里 |
|---|---|
| 能做什么、有什么限制 | [docs/架构/能力层.md](https://github.com/EIGHTfs/ModelStage/blob/main/docs/架构/能力层.md) |
| 架构分层与模块职责 | [docs/架构/总览.md](https://github.com/EIGHTfs/ModelStage/blob/main/docs/架构/总览.md) |
| 改代码不能碰的红线 | [docs/契约/](https://github.com/EIGHTfs/ModelStage/blob/main/docs/契约/README.md)（13 条不变量 + 各层契约） |
| 相机、界面、状态的设计 | [docs/设计/](https://github.com/EIGHTfs/ModelStage/blob/main/docs/设计/) |
| 渲染接入与 API 参考 | [docs/参考/](https://github.com/EIGHTfs/ModelStage/blob/main/docs/参考/) |
| 还没解决的问题 | [docs/架构/能力层.md](https://github.com/EIGHTfs/ModelStage/blob/main/docs/架构/能力层.md) §四「已知限制」 |

---

## 常用工具

```bash
node tool/test-all.mjs                    # 全量回归（含前置静态门禁）
node tool/check-single-source.mjs         # 单一数据源门禁
node tool/check-plugin.mjs                # 插件契约检查
node tool/export-bundle.mjs --root=<id> --path=<资源>   # 资源包 → 标准模型目录
node tool/resolve-live2d-runtimes.mjs     # 查看 Live2D 运行时探测结果（排查用）
```

导出与工具细节见 **[docs/参考/接口清单.md](https://github.com/EIGHTfs/ModelStage/blob/main/docs/参考/接口清单.md)** §五。

---

## 版本记录

> **版本号唯一权威 = `package.json` 的 `version`**。`bin/modelstage.mjs --version` 直接读它，
> 这里只是变更留痕。升版时改 `package.json` + 在本表追加一行，不需要再找第三个地方。

| 版本 | 日期 | 要点 |
|---|---|---|
| 0.5.10 | 2026-10-31 | 修 `document.files` 就绪后的重绘事件派发目标（`document` → `window`，监听器挂在 window 上，原写法重绘静默不生效）；files 缓存键加 prefix 段（容器 `vfs:<prefix>` / 容器未就绪 `vfs:` / 非容器 `none`） |
| 0.5.9 | 2026-10-31 | 替换型控件强制自带设置键（`missing-setting` 校验）：替换后值存插件自己的键、内置键只读且全程不被写；卸载无需"恢复"（从未被改）；插件改值域时用清单 default 兜底 |
| 0.5.8 | 2026-10-31 | `document.files` 补齐：容器条目走 VFS 前缀列举（同步）、目录条目走 catalog 异步补全；未就绪返回 **null**（与"空目录返回 []"可区分），就绪后自动重建一次；缓存按文档键、重复渲染不重复列举 |
| 0.5.7 | 2026-10-31 | 键值插槽 `panel.control.<key>` 与单值插槽 `panel.brand`：替换内置控件（保留其 id/能力键/设置键）、按目标判抢占、卸载原样恢复；品牌按全局注册序生效、卸载三级回退（上一个注册者 → 内置）、textContent 写入不解析标记 |
| 0.5.6 | 2026-10-31 | 阶段抬到 S5：`panel.brand` 与 `panel.control.<key>` 开放；`stage.overlay` 改为 **S6 占位档**（尚未排期，不是第六阶段），判定逻辑零改动；阶段相关测试全部改为动态取样 |
| 0.5.5 | 2026-10-31 | 顶栏声明式化 + `toolbar.actions` 插槽：内置 5 个按钮迁成声明表（id/aria/title 与旧 HTML 逐字一致）、插件按钮排在内置之后按 order 升序、图标仅收白名单图标名（拿不到则纯文本）、封顶 3 个 |
| 0.5.4 | 2026-10-31 | 插槽阶段抬到 S3：`toolbar.actions` 开放（`panel.group` 已开放；`panel.brand` / `panel.control.<key>` 仍 S5、`stage.overlay` 仍 S4）；顺序用例改为动态挑未开放样本 |
| 0.5.3 | 2026-10-31 | 补设置键→控件反向映射：一个设置键可被多个控件绑定（值为控件 id 数组），外部改设置键会触发所有绑定控件重绘；tick 级合并去重（`__PANEL_REPAINT__` 可核对）；卸载后惰性跳过 |
| 0.5.2 | 2026-10-31 | 清理老链：删除 `controlSections` / `mergePluginControls` / `normalizePluginSection` 等死路径（schema 179 行 + plugin-host 6 处），注册通路收敛为 `slots.register` 一条（`registerControls` 仅作兼容层）；顺带修 `mergeSlotControls` 的 onReject 默认值取值 bug |
| 0.5.1 | 2026-10-31 | 插槽 owner props 补齐并改为 getter（settings / geometry / activeSurface / document）；新增 `spec.setting` 统一控件存值键（值直接落在清单声明键上，未声明则注册期拒绝）；`rebuildPanelFor` 拆成 5 个函数（111 行 → 全部 ≤50）；老链标 deprecated |
| 0.5.0 | 2026-10-31 | 老接口 `registerControls` 迁移到插槽注册（一条通路）：标题→id 派生映射、老控件 id 不强制前缀、`implicitDeclare` 隐式声明（只跳过 undeclared，阶段/前缀/重名/风险仍全查）；`via` 标注控件来源；老控件与 `slots.register` 的控件共用同一合并/渲染/回收链路 |
| 0.4.9 | 2026-10-31 | 补提交 S3-a 遗漏的接线：`plugin-host.js` 从 schema 取内置分组 id 传给插槽注册表（据此区分"引用内置组"与"插件新建组"，新建组必须带 `plugin.<pluginId>.` 前缀） |
| 0.4.8 | 2026-10-31 | 修插件控件 kind 两套词汇缺映射（`toggle`/`button` 曾落进 `ctl-note` 空行，表现为"控件消失"，连正常态都不渲染）；新增唯一映射表 `PLUGIN_KIND_TO_VIEW` 并补 kind 映射完备性单测；孤儿能力键检查改合并口径（三源 declared + 跳过 disabled + DOM 漂移护栏 + 判据自检） |
| 0.4.7 | 2026-10-31 | 插件插槽 S3-a：允许插件新建分组（id 强制 `plugin.<pluginId>.` 前缀、order 缺省 1000、排在内置组之后、与内置组同名允许并提示）；分组存在性判定由标题集合改为 id 优先/title 兜底；分组 id 规则前移到注册期（`bad-group-id`） |
| 0.4.6 | 2026-10-31 | 插件插槽 S2-b2：阶段改读服务端 `currentStage`（删前端常量与两个自测开关）、`onAction` 派发（异常隔离）、`props.settings` 传当前值或声明默认值 |
| 0.4.5 | 2026-10-31 | `/api/plugins` 下发 `currentStage`（与 `slotCatalog[i].stage` 是两个概念，不合并），消灭阶段的两处表达；补路由层用例（含"目录里必须仍有未开放插槽"这条防扁平化断言） |
| 0.4.4 | 2026-10-31 | 插件插槽 S2-a：插件控件真正渲染进右栏（装配期聚合，不写回静态表）、按 groupId 匹配与 order 排序、id 冲突拒绝、设置键并入能力白名单、`panelWired` 与合并结果同源；卸载后 DOM 节点消失 |
| 0.4.3 | 2026-10-31 | 插槽阶段抬到 S2：`panel.group.<groupId>` 开放（其余四类仍按各自阶段拒绝）；阶段文档补 S2 参考清单（验证用插件的 plugin.json 与脚本全文） |
| 0.4.2 | 2026-10-31 | 插件插槽 S1-b2：`slot-registry.js`（DOM-free，四类校验固定顺序）+ `slots.register` 只登记不渲染+ disposer 接入 effect 容器（`unloadPlugin` 一并回收）+ `window.__SLOT_STATS__`；修服务端 `matchSlot` 模板串双重转义缺陷（含字母 s 的插槽被误判 unknown-slot） |
| 0.4.1 | 2026-10-31 | 插件设置键强制 `plugin.<pluginId>.<key>` 前缀（能力键白名单全局合并，同名键会撞车；别的插件 id 同样不合法）+ 修 registry 里校验块早于 `const pid` 的 TDZ 缺陷 |
| 0.4.0 | 2026-10-31 | 插件插槽 S1-b1（前端）：插件级 effect 容器与 `unloadPlugin`（逆序回收 + 兜底清理 + `effectsReport`）；窗口外注册由静默丢弃改为显式拒绝（带可读原因与 likelyOwner）；面板重建保留手风琴展开态（累积表，覆盖换渲染面路径）；渲染写 `data-group-id` |
| 0.3.9 | 2026-10-31 | 插件插槽 S1-a（服务端）：插槽目录常量表 + 清单校验（unknown-slot / slot-not-open / undeclared-slot / risk-mismatch 四类，逐项降级不整体拒绝）+ `/api/plugins` 下发 `slotCatalog` 与每插件 `slots`/`slotErrors`/`settings`/`settingsErrors`；老插件零改动可用 |
| 0.3.8 | 2026-10-31 | SSE 补发档名改由 `PROGRESS_PHASES` 派生（消除第三处档名字面量，缺 msField 测试期即失败）；准入系数与 cgroup 限额全部 env 可覆盖（`MODELSTAGE_ADMIT_HEAP_RATIO` / `_CAPACITY_RATIO` / `MODELSTAGE_CGROUP_MEMORY_MAX_PATH`），cgroup v2 优先、缺失回落 `/proc/meminfo`，非法值回落缺省并告警一次 |
| 0.3.7 | 2026-10-31 | 大包首帧优化第一步：容器包改由解包 worker **自己按 URL 拉取**，主线程不再整包读取与结构化拷贝（实测读包 152/172ms → 0、投喂 13ms → 0）；新增 `?workerFetch=0` 同机 A/B 开关与 `unpack.main-read`/`unpack.worker-post` 打点 |
| 0.3.6 | 2026-10-31 | exec 进度档名收敛为单一来源（`PROGRESS_PHASES` 表，档名与语义同处）；修 exec 默认 logger 未接线（未知档的 debug 原本在生产里根本不输出）；两份设计稿改为指向该表、不复述名单 |
| 0.3.5 | 2026-10-31 | exec 插件解包进度变成**真实时**：帧协议新增进度帧（read/resolve/write），插件在三个自然边界上报、宿主即时 fire `phase` 事件、收尾只补未发档；node 插件事件顺序与时刻不变 |
| 0.3.4 | 2026-10-31 | 探测增加可用内存判据：`可用 ≥ 基线 + 包体积 × 系数` 才探，不满足则保持 unknown 并单独计数 `skippedMemory`（与"包太大"分开）；MemAvailable 优先、`os.freemem()` 回落、取不到则放行；阈值走 env 且逐次重读 |
| 0.3.3 | 2026-10-31 | catalog 的 `warnings` 收敛为空数组：能力说明只在 `capabilityNotes`、根级问题只在 `rootIssues`/`rootWarning`（兼容期结束，消除同一事实两份表达） |
| 0.3.2 | 2026-10-31 | 修复 exec 插件的假告警：前端不再把 `runtime:"exec"` 的插件当 JS 插件注入脚本（其 `files[]` 为空 ⇒ 必然误报「已加载但没有调用 register()」），改为只登记声明、不计入"需装载"分母 |
| 0.3.1 | 2026-10-31 | 探测不再阻塞事件循环：两级空闲门控（有请求在飞不解析）+ 单包 24MB 上限 + 解析移入 worker 线程；新增显式生命周期 `close()` 与 SIGINT/SIGTERM 收尾（修复 worker 悬挂导致测试进程不退出）；实测事件循环 max 683→104ms、吞吐 28.5→63.9/min |
| 0.3.0 | 2026-10-31 | 插件运行时双形态落地：`exec`（子进程 + 行 JSON 帧协议 + 双向超时必杀 + 崩溃传播）与首个 Python 插件 `unitypy-bundle`（UnityPy 解包，覆盖 ASTC 等 JS 侧缺口）；前端本地解包失败时兜底走服务端解包；补 spine 3.8 skel 版本探测（原按 4.x 解析导致装载报错） |
| 0.2.3 | 2026-10-31 | 清单缓存加「生成者指纹」：由解析器文件内容哈希派生（spine/live2d/probe），改解析代码后落盘清单自动失效重建，不再需要手工删 config/models/*.json；live2d 清单写盘改原子写（与 spine 同口径） |
| 0.2.2 | 2026-10-31 | 后台探测可观测：启动/完成/暂停三条日志与触发来源（catalog/fingerprint/manual）可辨；`GET /api/entries/probe` 新增 lastTrigger/lastBatchMs/lastQueueAfter，catalog 响应附加 `probeRemaining`（只增不改）；前端 `state.probe` 数据面就绪（UI 未实现） |
| 0.2.1 | 2026-10-31 | 条目状态落地：`entry-states` 存储与 `/api/entries/result` 写读一体、catalog 三字段（display/support/loadResult）收口、前端只渲染字段并删除 localStorage 失败缓存；新增后台形态探测（事件驱动、按根串行限速、`POST /api/entries/probe`）与 S6 指纹接线三处补齐；`listCatalog` 拆分为 12 个函数（原 123 行） |
| 0.2.0 | 2026-10-31 | 条目状态契约定稿：展示归属/可装载预判/最近装载结果三项收归服务端唯一权威，内置 spine/live2d 装载器与插件同表登记（builtin-*）；ETC2_RGBA1 纹理解码补齐、美术依赖包可读判定、徽标配色改由插件自声明；名册加载计时与 `/api/catalog/stats` |
| 0.1.0 | 2026-10-28 | 首个可用版本：三级名册、Spine / Live2D 双渲染面、UnityFS 资源包解包、插件能力过滤面板 |

---

## 合规状态

| 项目 | 许可证 | 说明 |
|---|---|---|
| **本项目自有代码** | **MIT**（见 [LICENSE](LICENSE)） | — |
| **Boneview**（[仓库](https://github.com/souling01/spine-viewer-webgl)） | **无 LICENSE**（默认保留全部权利） | 仅**前端布局**参考；本项目代码 90% 以上自研，不含其代码 |
| **Spine Runtimes** | 自定义协议 | 运行时源码**不入库**、需自备；**不受本项目 MIT 覆盖** |

> 本项目使用官方 Spine Runtimes（[Esoteric Software](https://esotericsoftware.com)），受 [Spine Runtimes License Agreement](https://esotericsoftware.com/spine-runtimes-license) 约束。集成预览可以，但每个使用 Spine 数据的终端用户仍需拥有 Spine 编辑器授权。

**仓库内不含任何游戏提取资源** —— 模型、纹理等素材均不入库，需自备。

---

## 免责

许可证说明基于开源许可一般原理，**不构成法律意见**。对外分发前建议咨询专业 IP 律师。

## 导出物版权

`tool/export-bundle.mjs` 导出的 `moc3`、`physics3`、贴图 PNG 等均为**游戏原始素材**，
仅供本地研究与个人使用，请勿再分发。导出产物默认写入 `data/export/`（该目录已在 `.gitignore`）。
