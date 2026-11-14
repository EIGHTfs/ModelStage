# 变更记录

> **版本号唯一权威 = `package.json` 的 `version`**；`bin/modelstage.mjs --version` 直接读它。
> 这里只记录"每个版本改了什么"，不重复维护第二份版本号来源。
>
> **排序规则**：版本号严格降序；同一个版本号出现多次时，新日期在前。
> `0.5.24` / `0.5.25` / `0.5.26` 三个号各被两批独立工作用过一次（2026-11-01 与 2026-11-05，见 `git log -S'"version": "0.5.25"' -- package.json`），
> 属历史遗留的重号，**不是重复行**，不要合并或删除。

| 版本 | 日期 | 要点 |
|---|---|---|
| 0.8.2 | 2026-11-14 | **文档：displayName 定为条目工厂的第四字段，且插件侧可缺省**（本轮只改文档）<br>· 契约 §1.3：`displayName?` 改为**可缺省**；缺省时核心产出 `null`、前端回落 `costume > 目录名 > 文件名`（**旧行为完全不变**）；空串视为未给<br>· 契约 §1.3 明确产出位置：与 `display` / `support` / `loadResult` **同源**由 `entry-states.recompute()` → `catalog` 挂到条目，前端只读不重算<br>· 设计稿 `列表显示名-displayName.md` 按工厂口径重写：数据流（插件 → 缓存 → 工厂四字段 → 前端）、插件可缺省的理由（`builtin-*` 是纯声明无代码，永远走缺省）、角色节点标题就地更新而非重建 chars、失败降级矩阵、验收判据 |
| 0.8.1 | 2026-11-14 | **文档：条目显示名归插件 + 纠正 exec 过时描述**（本轮只改文档）<br>· 契约新增 §1.3 `displayName`：`analyze()` 返回 `displayName: string \| null`，插件决定名字怎么取，核心**只渲染不解析**；只对"被选中/装载的条目"取一次（复用既有单条目回写 `setEntryState`）；缓存归核心（`config/bundle-display-names.json`，键 `rootId+rel`，按 `mtimeMs+size` 失效）；未给则回落 `costume > 目录名 > 文件名`<br>· 契约 §1.1 更新：`textAssets` 已实现（从对象表 `dataOffset` 处取名字与骨架版本），并补 `memory` 字段<br>· 契约 §2.4 纠正：`exec` 运行时**已实现**（`src/server/unpack/runtime/exec.mjs`），原文"spawn 尚未实现／固定抛 `EXEC_RUNTIME_NOT_IMPLEMENTED`"已过时；实际默认**关闭**，需 `MODELSTAGE_ALLOW_EXEC_PLUGINS=1` 或 `config/plugin-runtime.json` 的 `allowExecRuntime`<br>· 新增 `docs/设计/列表显示名-displayName.md`：现状实查、设计、181 个包的真实成本（中位 22MB/0.6s、p95 97MB/1.8s、1297MB 全量解压 4862MB 必 OOM）、内存准入按契约 §2.2（禁止核心侧 `>100MB` 这类阈值）、失败降级、验收判据<br>· 历史设计稿 `2026-10-29插件运行时抽象与exec帧协议.md` 顶部加"后续状态"指针（正文不回改，保留当时决策） |
| 0.8.0 | 2026-11-13 | **只读分析 API + 容器解包修复**：<br>· 新增 `GET /api/analyze?path=<绝对路径>`：返回 `verdict`（spine / live2d / unity-3d / archive / encrypted / unknown）、`analyzedBy`（哪个插件给的结论，降级时标 `fallback`）、`container`、`nodes`、`objects`、`textAssets`（名字 + 类型 + 骨架版本）、`textures`（含 `supported` 标记）、`summary`；不限路径、只读<br>· 新增 `GET /api/analyze?dir=<绝对路径>`：递归找候选（扩展名 + 魔数）、并发 1、`maxFiles` 500、深度 12，超限写 warnings 不静默截断<br>· `textAssets` 真解析：TextAsset 体前 4 字节名字长度 + 名字，正文里读出骨架版本（实测 4.1.11 / 4.1.24）<br>· **修 `hostApi is not defined`**：`createUnpack` 增加 `getHost` 参数，两处 `host: hostApi` 改为延迟取值（`plugin-host.js` 里 unpack 先建、hostApi 后定义，创建时捕获必然是 undefined）<br>· 目录候选只认 `.model3.json`，不再把普通 `config.json` 当模型描述<br>· 文档：`支持边界.md` 增「只读分析」一节；`契约/插件.md` §1.1 补 `analyze` 返回形状（含 `textAssets`）<br>· 测试：`analyze-api` 新增 14 条；相关 8 套 60/60 通过 |
| 0.7.0 | 2026-11-13 | **分析能力与插件解耦**（只读分析 API 第 1 步）：<br>· 契约新增第六角色 `bundle-analyzer`（接口 `analyze(bytes)`，返回值形状与降级规则见 `docs/契约/插件.md` §1.1/§1.2）<br>· 两个 bundle 插件声明该角色并暴露 `analyze()`，各自复用已有解析实现（两份 `bundle-probe.js` 逐字节相同，用 parity 用例钉住）<br>· 本体改为按 `provides` 分派：`findAnalyzerProvider()` 找第一个提供者；一个都没有时按文件头魔数降级（UnityFS / CAB- / MOC3 / ZIP / JSON）并提示装机；**删掉 `PROBE_PLUGIN_ID` 硬编码**<br>· 分派器的目录判据与 `registry.mjs` 对齐（跳过 `.` 开头目录）：回收站与 `.bak-*` 里的历史插件副本不再参与分派<br>· 顺带修 `createWriteApi` 的缓存失效调用：形参名与调用方不一致导致 `models` 恒为 undefined、`invalidateCaches` 又只收到一个参数 ⇒ 资源根增删改名后旧清单一直不失效（错误被 try/catch 吞掉，只体现在 `invalidated.error`）<br>· 测试：新增 `bundle-analyzer-registry` 10 条（含红绿双证），相关 8 套 53/53 通过 |
| 0.6.2 | 2026-11-13 | **文档补全**：<br>· 新增 `docs/参考/支持边界.md`（一处索引：运行时版本 / 资源容器 / 清单格式 / 插件角色，逐项标明支持与不支持）<br>· 新增 `docs/设计/格式适配器规则.md`（新增格式只加适配器，不在扫描器里加编码分支）<br>· **调研：Live2DViewerEX `.lpk` 不支持**（`docs/设计/live2dviewex-LPK调研.md`）：ZIP 容器 + 哈希名 `.bin` + 明文元数据 `{"type":"STM_1_0","encrypt":"true"}`；14/14 目录全加密、838 entry 全 STORED、密文满熵 ⇒ 容器层解包解决不了内容加密，不做解密 |
| 0.6.1 | 2026-11-08 | **文档补全实际支持的运行时版本**（此前文档只写旧范围）：<br>· Spine：自带 `3.6 / 3.7 / 3.8 / 4.0 / 4.1 / 4.2 / 4.3`，**4.3 受支持**；`4.4+` 不支持（无运行时且版本识别区间止于 4.0–4.3）<br>· Live2D：两套组合实测为——v6（默认）`PIXI 6.5.3 + pixi-live2d-display 0.4.0 + Cubism Core 4.2.2`；v8 `PIXI 8.19.0 + display 1.3.5 + **Cubism Core 6.0.1**`（具 Cubism 5 能力，未用真实 v5 模型验证）<br>· 补「怎么加新版本」（Spine 放数据根 `runtimes/spine/`；Live2D 用 `LIVE2D_RUNTIME_DIR` 或 `runtimes/live2d/`）<br>· 顺带清掉源码里残留的"20s 超时/兜底超时"过时注释（超时已整体移除） |
| 0.6.0 | 2026-11-08 | **加载行为改为"事件驱动 + 串行队列"**：<br>· 去掉全站请求时限（`api.js` 与 8 处裸 fetch）：慢不再被判成失败，只保留调用方的取消信号；`TimeoutError` 不再参与重试判定<br>· 名册加载改为**队列串行**：上次所用模型所在根优先，其余分组按显示顺序逐个自动加载，同时只有一个根在扫描；行上显示「排队中（第 N 位）/ 加载中 / 已加载」<br>· **取消「未加载 · 点击加载」按钮**（加载由队列推进，不再需要用户点）<br>· 就绪阶段轮询不再判 `failed`：只记录"观测到多少"，慢不等于坏<br>· 测试：原「超时生效」用例改为「慢响应也必须拿到结果」；`api-retry` 12/12、名册相关 28/28<br>· 文档：README 不再写版本号，版本记录独立到 `CHANGELOG.md`（本文件） |
| 0.5.41 | 2026-11-08 | `view.js` 按职责拆成 4 个模块（`view` 只留装配 / `load` 加载编排 / `render` 渲染 / `events` 事件），全仓 `game` 口径改名 `group`（613 处；存储字段不兼容旧格式，旧数据静默忽略）；修两个加载 bug：① `setRootModels` 内部统一重算角色树（原先漏归并 ⇒ 加载完显示 0 角色、收起再展开才出现）② `entry` 字段写入改走 store 动作（原 `setRootStatus` 复制对象 ⇒ 根状态永远停在 loading）；删 3 处死代码 |
| 0.5.40 | 2026-11-08 | 名册剩余 4 个字段也收进 store：`activeGame` → `activeGroup`（分组语义，不再假设"一定是游戏"）+ `scannedRoots` / `probe` / `lastReveal`，`view.js` 的 12 处直写改为动作调用；`persist.js` 读 `activeGroup` 但**存储字段名保持 `activeGame`**（旧数据不失效） |
| 0.5.39 | 2026-11-08 | 名册状态收口到 `roster/store.js`（唯一状态持有者 + 27 个动作 + 变更即触发渲染），`view.js` 里不再直接写状态容器；测试工具修正：浏览器套件专用超时 360s、node 套件默认 300s，roster/panel 套件改为按"展开态"而非"角色行"断言（懒加载后未加载的游戏展开本就 0 行），并在动作脚本开头显式等待 `__WEB__` 就绪 |
| 0.5.38 | 2026-11-08 | 扫描改为「一次遍历把目录树读进内存，walk 阶段零 readdir」：`readTreeIntoMemory` 只碰一趟磁盘；流式扫描总耗时 39.6s → 28.3s，首模型 6.95s → 5.4s |
| 0.5.37 | 2026-11-08 | 类型筛选**不再持久化**（刷新回到不筛选，避免旧筛选把「上次所用模型」挡住）；恢复上次模型时改为走与点击变体相同的加载路径（原来只高亮不装载）；行状态改为单一判定 `resolveGamePhase`（**扫描中不会再同时显示「加载失败」**），catalog 失败且扫描仍在进行时保持 loading 并在 done 帧后自动补取一次 |
| 0.5.36 | 2026-11-08 | 清单索引不再逐文件 `stat`（实测 1781 文件 stat 11.5s）：索引只留 `{name, full, ext, relPath}`，目录判定改用 `Dirent`；删除无人读取的 `model.fileSize`。`indexRootFiles` 15.6s → 6.2s，流式扫描总耗时 75.6s → 39.6s，首模型 8.5s → 7.0s |
| 0.5.35 | 2026-11-08 | 名册冷启动只加载「上次所用模型」所在的那一个根（其余展开才加载）；扫描期间流式吐出模型（首模型从 24~30s 降到 8.5s）；扫描并发上限=1 + FIFO 排队；清单 schema 统一为 `{rootId, ts, count, generator, dirStamps, models}`（**去掉 kind / version / rootName / rootPath**，渲染器类型改由 catalog 读取时盖章） |
| 0.5.34 | 2026-11-07 | 清单存储支持 JSONL（**默认仍为 JSON，原行为不变**，`MODELSTAGE_MANIFEST_FORMAT=jsonl` 可选启用），两种格式都能读、切换不需迁移；修掉两条并发竞态：写入用唯一 tmp 名（避免被失效清理误删导致 rename ENOENT）、单飞下沉到清单扫描本体（先占位再启动，4 并发只扫一次） |
| 0.5.33 | 2026-11-07 | 名册扫描进度可见（P0 前端）：展开游戏时订阅 `?stream=1` 的 NDJSON 帧，状态位实时显示「已读取 N 条 / M 个目录」；无进展超 `SCAN_STALL_MS`（10s，单一来源）显示「疑似卡住 + 当前路径」并可重试；多根游戏用基线累加保证计数**单调不减** |
| 0.5.32 | 2026-11-07 | 清掉全量审计的 13 条 `paths/hardcoded-absolute-path` blocker（**全量审计 blocker 归零**）：解释器/node 探测改为「命令名 + PATH 查找」、测试夹具路径改为 `os.tmpdir()` 派生、Windows 路径用 `path.win32.join` 拼出；`exec.mjs` 增加 spawn 前的解释器日志（排障用） |
| 0.5.31 | 2026-11-07 | 清单扫描进度可见化（P0）：扫描器产出 start/progress/done 帧，`?stream=1` 返回 NDJSON；**扫描改 async 分片让出**（否则帧全压在缓冲里，首帧从 24.7s 降到 0s）；扫描单飞真正生效；不带 stream 的响应保持不变 |
| 0.5.30 | 2026-11-07 | 文件清单失败可见化：右栏内联浮层「清单获取失败（超时）· 点击重试」（绝对定位、不挤动控件）+ `__DOC_FILES__.failures` 计数，**不做自动重试**；`props.document` 增 `filesError` / `retryFiles` 供插件复用 |
| 0.5.29 | 2026-11-07 | 两处「静默放弃」型超时兜底改为开口说话：就绪阶段超时区分 `no-observation` / `not-interactive` / `cancelled`（仅全程无观测才判 failed，已有画面绝不改阶段）；解包 worker 就绪超时补六种结局与诊断事件（对外仍 resolve 布尔）；新增 `ready-track` 套件守「漏标 interactive」回归 |
| 0.5.28 | 2026-11-05 | 名册类型筛选：左栏搜索框下方「类型胶囊」按内容类型过滤（动态派生、多选并集、与关键词交集、计数按当前搜索、`unknown` 归「待解包」、自动换行不折叠、选中态持久化）；类型显示名单一来源 `src/shared/type-labels.mjs` |
| 0.5.27 | 2026-11-05 | 测试分级迁移 P4：底栏「单动循环」断言判为已覆盖**整条删除**（缺口改由 schema 表断言补）、顶栏按钮集合 → `test/toolbar-contract.test.mjs`（断言 import 的 TOOLBAR_ACTIONS / 图标白名单 / 插件上限）；两个浏览器脚本共删 41 行，套件 33 → 34 |
| 0.5.26 | 2026-11-05 | 浏览器测试分级迁移（批次 3/5）：panel-actions 的 6 条契约断言迁为静态测试 `test/panel-contract.test.mjs`（断言对象是 schema 导出表与 CSS 规则，不起浏览器）；分组标题由写死 9 个改为 schema 推导；套件 32 → 33 |
| 0.5.26 | 2026-11-01 | 对齐成熟包的四项：`bin` 加 realpath 直接执行判据（import 不再起服务）、`serve.mjs` 加 EADDRINUSE 人话提示（退出码 2）、新增 `/api/health`（`web.sh status` 优先用它、旧实例回落首页码）、`web.sh` 日志 5MB 轮转（先 stop 再轮转、只留 1 份）；顺带修 health 的 `plugins` 恒为 0（引用了不存在的 ctx） |
| 0.5.25 | 2026-11-05 | 测试分级迁移批次 2：新增 `test/roster-filter.test.mjs`（搜索/合并语义 unit + 键名静态断言），`roster-actions.js` 删 3 条搜索断言合并为 1 条接线冒烟；顺带修一条既有必红断言（写死渲染上限）与 4 处过时 skip 名；套件 31 → 32 |
| 0.5.25 | 2026-11-01 | 包体积收窄：`tool/lib/` 整目录放行改为 **6 个运行时文件**（其余 7 个是测试/校验/开发件，`check-perms` / `test-lock` / `test-report` / `contract-checks` / `export-bundle` / `cubism-core` / `spine-runtime`）；发布守卫新增四类禁止项（`test/`、`*.test.*`、`*.map`、开发工具、缓存/上传/日志）；包内 286 → 279 文件 |
| 0.5.24 | 2026-11-05 | 浏览器测试迁移第 1 批：资源根 CRUD 的 7 条 HTTP 契约断言迁到 `test/roots-api.test.mjs`（浏览器侧只留 3 条交互断言 + 4 条冒烟）；顺带修 `409` 响应丢 `path`/`existing` 的透传缺陷（已补回归断言） |
| 0.5.24 | 2026-11-01 | 发布准备：补 `THIRD_PARTY_NOTICES.md`、README「合规状态」扩到 Live2D Cubism 与 pixi.js 并注明「服务端把运行时报给浏览器 = 分发行为」；补 author/keywords/bugs、清理 `files` 无效条目；去掉 `private` 以便发布；README 标注项目进入维护为主阶段 |
| 0.5.23 | 2026-11-01 | 解包节点判据由「名字前缀」改为「结构形式」（`/^CAB-[0-9a-f]{32}$/i`，四处统一 + 防漂移单测）：`.resS` / `.resource`（FSB5 音频银行）不再被误当 serialized file；顺带修好两个包的不完整提取（假节点抛错曾中断循环，真节点没被处理）；测试套件 29 → 30 |
| 0.5.22 | 2026-11-01 | `tool/lib/runtime-package.mjs` 的 `writeAtomic` 写前自建父目录（原子写函数不依赖调用方建目录）；`src/server/http/atomic-json.mjs` 核实后本就有 `ensureDir`，未改动 |
| 0.5.21 | 2026-11-01 | 修 `document.files` 的 catalog 请求无超时：加 `DOC_FILES_TIMEOUT_MS = 6000` + `AbortSignal.timeout`，`pending` 清理移入 `finally`（挂起后可重试，不再永久占位），失败记 warn 含 rootId/url/reason |
| 0.5.20 | 2026-10-31 | 全量审计后清理真实硬编码：插件清单 `depsDir` 改 `${MODELSTAGE_DEPS_DIR}` 占位符（换机只改 env）、删 `interpreter` 交给探测链、MIME 字面量各文件提常量、6 个脚本统一 `here(import.meta.url)`、清 5 处注释日期 |
| 0.5.19 | 2026-10-31 | 分区编号 R1~R6 改为职责名（基础工具与统计发布 / 注册入口组装 / 装载与卸载回收 / 资源取用与解包 / 装载编排），六个文件 R 编号清零；分隔线按显示宽度 96 列对齐。拆分工作到此收口 |
| 0.5.18 | 2026-10-31 | 去掉函数索引（43 条带行号条目，−113 行注释），换成 7 行模块地图 + 6 个分区概述（+46 行）；`plugin-host.js` 694 → 628 行，全部为注释改动；其余 5 个模块头部本无索引，未改动 |
| 0.5.17 | 2026-10-31 | 拆分 B4：解包区整体搬出为 `plugin-host-unpack.mjs`（20 函数 / 487 代码行，3 个窄参数），`plugin-host.js` **1538 → 694 行**；workerPool 归属明确（unpack 创建持有、unload 清理）；B3（装载与窗口区）评估后不动，依据记入调研文档 |
| 0.5.16 | 2026-10-31 | 拆分 B2：抽出「注册与校验」区为 `plugin-host-registration.mjs`（5 个窄参数、不塞整块 ctx），plugin-host 净减 215 行；7 类错误码文案与校验顺序原样随迁、对外 API 形状不变 |
| 0.5.15 | 2026-10-31 | 事件名收敛为常量 `EVENTS`（3 个 spineviewer 事件 / 7 处字面量清零），并新增「src/web 下不许再出现事件名字面量」的扫描单测（已自证会红）；防的是批量改名再次静默改坏协议字符串 |
| 0.5.14 | 2026-10-31 | 拆分 B1：抽出 report / unloadPlugin 链 / warmup 链三个独立模块（plugin-host 净减 201 行）；**修 0.5.13 的静默回归**——批量重命名把事件名 `spineviewer:plugins-loaded` 改成了 `plugins-ctx.loaded`（2 处），导致卸载后面板不重建、document.files 就绪后不重绘 |
| 0.5.13 | 2026-10-31 | 拆分 B0：9 个高频共享状态收敛为单一 `ctx` 对象（145 处访问点改写、行为零变化），为后续模块化铺路；文件头状态表改为 ctx 形态并列出「留在闭包」的 17 个低频状态与理由 |
| 0.5.12 | 2026-10-31 | `plugin-host.js` 加分区注释与函数索引（126 行纯注释、0 行代码变动）：6 个分区 / 43 条索引（函数名·行号·代码行·职责）+ 9 个高频共享状态读写表；`fetchFile`（133 行、三职责）列为下一轮最该拆的内部函数 |
| 0.5.11 | 2026-10-31 | 插件按钮支持按下态（`spec.pressed` getter，与内置按钮同一套 aria 与样式）；顶栏插件按钮改入**横向可滚动区**（不再"封顶丢弃"，`PLUGIN_TOOLBAR_MAX` 3→20 降级为安全阀），内置 5 个保持固定、顶栏高度不变、键盘可达 |
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
